/**
 * The conform command: each model held against the code's own tests.
 *
 *   node src/cli.ts conform [--model <folder>]... [--capture | --replay-only] [--json] [--verbose] [--session <id>] [--agent <name>]
 *   node src/cli.ts conform --collect   the collector alone, in the foreground, for a runner conform does not spawn
 *
 * With no flag, the hashes decide (hashes.ts): a capture missing for the code
 * as it is runs the tests; one present is replayed without them; a verdict
 * already kept for the same replay is read back. --capture runs the tests
 * whatever is kept; --replay-only refuses to run them. Each model's verdict
 * is appended to the conformance store, and the command exits 1 when any
 * model disagrees.
 */

import { randomUUID } from "node:crypto";
import { JournalError, parseFlags } from "../journal/args.ts";
import type { Io } from "../journal/cli.ts";
import { gitState } from "../journal/store.ts";
import { startCollector } from "./collector.ts";
import { readConformanceConfig, readQuintConfig } from "./config.ts";
import { coverage } from "./coverage.ts";
import { captureHash, replayHash } from "./hashes.ts";
import { modelFiles } from "./standing.ts";
import { readModel } from "./model-ir.ts";
import { quintVersion } from "./quint.ts";
import { replay } from "./replay.ts";
import { reportModel } from "./report.ts";
import { capture, scoped } from "./runner.ts";
import { appendVerdict, captureScratch, loadVerdicts, readCapture, writeCapture, type ConformanceVerdict } from "./store.ts";

export const CONFORM_USAGE = [
  "  conform [--model <folder>]... [--capture | --replay-only] [--json] [--verbose] [--session <id>] [--agent <name>]   each model held against the code's own tests: capture the tests under a collector when the code changed, replay every trace through the model, report agreement, the pinning ratio and coverage, and append a verdict",
  "  conform --collect   the collector alone, in the foreground: prints its URL for a runner conform does not spawn, and keeps the traces when stopped",
].join("\n");

export async function conformCommand(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseFlags(argv, { model: "many", capture: "switch", "replay-only": "switch", collect: "switch", json: "switch", verbose: "switch", session: "one", agent: "one" });
  } catch (error) {
    if (error instanceof JournalError) {
      io.err(`conform: ${error.message}\n${CONFORM_USAGE}`);
      return 64;
    }
    throw error;
  }
  if (parsed.positionals.length > 0) {
    io.err(`conform: unexpected argument "${parsed.positionals[0]}"\n${CONFORM_USAGE}`);
    return 64;
  }
  if (parsed.switches.has("capture") && parsed.switches.has("replay-only")) {
    io.err("conform: --capture runs the tests and --replay-only refuses to; give one");
    return 64;
  }
  const root = io.cwd;
  const config = readConformanceConfig(root);
  if (parsed.switches.has("collect")) return collectInForeground(root, io);

  const wanted = parsed.many.get("model") ?? [];
  const chosen = config.models.filter((m) => wanted.length === 0 || wanted.includes(m.folder));
  for (const name of wanted) if (!config.models.some((m) => m.folder === name)) {
    io.err(`conform: no conformance.models entry for ${name}; the configured models are ${config.models.map((m) => m.folder).join(", ") || "none"}`);
    return 64;
  }
  if (chosen.length === 0) {
    io.err('conform: the config names no model: add conformance.models, e.g. { "src/journal": { "scopes": ["journal.work"] } }, beside a spec whose model: line names its .qnt file');
    return 64;
  }
  const files = modelFiles(root, chosen);
  const problem = files.find((f) => f.problem !== undefined);
  if (problem !== undefined) {
    io.err(`conform: ${problem.problem}`);
    return 1;
  }
  const version = await quintVersion();
  if (!("version" in version)) {
    io.err(`conform: ${version.reason}`);
    return 1;
  }
  const quint = readQuintConfig(root);
  const session = parsed.one.get("session") ?? randomUUID();
  const agent = parsed.one.get("agent") ?? "main";
  const json = parsed.switches.has("json");
  const say = (line: string): void => {
    if (!json) io.out(line);
  };

  // The capture: kept for the code as it is, or taken now.
  const hash = captureHash(root, config);
  let kept = parsed.switches.has("capture") ? undefined : readCapture(root, hash);
  const replayOnly = kept !== undefined;
  if (kept === undefined) {
    if (parsed.switches.has("replay-only")) {
      io.err(`conform: --replay-only, and no capture is kept for the code as it is (${hash.slice(0, 12)}): the code, the client or the test command changed since the last capture; run conform without --replay-only`);
      return 1;
    }
    const taken = await capture(root, config, (line) => say(line));
    if (taken.failure !== undefined) {
      io.err(`conform: ${taken.failure}`);
      return 1;
    }
    kept = { meta: taken.meta, traces: taken.traces };
  } else say(`replay only: capture ${hash.slice(0, 12)} is current; the tests do not run`);

  const verdicts: ConformanceVerdict[] = [];
  const earlier = loadVerdicts(root);
  const { commit, dirty } = gitState(root);
  let exit = 0;
  for (const { conformance, file } of files) {
    const replayed = replayHash(root, hash, { files: [file!] }, conformance, quint, version.version);
    const mine = earlier.filter((v) => v.model === conformance.folder);
    const stored = parsed.switches.has("capture") ? undefined : mine.find((v) => v.replayHash === replayed);
    if (stored !== undefined) {
      say(`${conformance.folder}: unchanged since ${stored.at}: ${stored.verdict} (${stored.matched}/${stored.total} traces, ${stored.pinned}/${stored.logged} logged args pin a step choice)`);
      for (const f of stored.failures) say(`    ${f.side}: ${f.test === undefined ? "" : `${f.test}: `}${f.cause}`);
      verdicts.push(stored);
      if (stored.verdict !== "agrees") exit = 1;
      continue;
    }
    const { traces, excluded } = scoped(kept.traces, conformance.scopes);
    const scratch = captureScratch(root, hash);
    const model = await readModel(`${root}/${file!}`, quint, scratch);
    const replayedTraces = traces.length === 0 ? { traces: [] } : await replay(traces, model, conformance, quint, `${scratch}/${replayed.slice(0, 12)}`);
    const covered = traces.length === 0 || replayedTraces.failure !== undefined ? undefined : await coverage(traces, replayedTraces.traces, model, conformance, quint, `${scratch}/${replayed.slice(0, 12)}-coverage`);
    const lastAgreeing = [...mine].reverse().find((v) => v.verdict === "agrees");
    const last = mine[mine.length - 1];
    const report = reportModel({
      base: { at: new Date().toISOString(), session, agent, commit, dirty, model: conformance.folder, file: file!, captureHash: hash, replayHash: replayed },
      meta: kept.meta,
      traces: replayedTraces.traces,
      coverage: covered,
      excluded,
      failure: replayedTraces.failure,
      moved: { prior: lastAgreeing !== undefined, capture: lastAgreeing !== undefined && lastAgreeing.captureHash !== hash, model: lastAgreeing !== undefined && lastAgreeing.replayHash !== replayed },
      lastRatio: last === undefined ? undefined : { pinned: last.pinned, logged: last.logged },
      replayOnly,
      verbose: parsed.switches.has("verbose"),
    });
    for (const line of report.lines) say(line);
    const where = appendVerdict(root, report.verdict);
    say(`  recorded in ${where}`);
    verdicts.push(report.verdict);
    if (report.verdict.verdict !== "agrees") exit = 1;
  }
  if (json) io.out(JSON.stringify({ captureHash: hash, replayOnly, verdicts }, null, 2));
  return exit;
}

/** conform --collect: a collector in the foreground until SIGINT or SIGTERM, then its traces kept as a capture of the code as it is. */
async function collectInForeground(root: string, io: Io): Promise<number> {
  const config = readConformanceConfig(root);
  const collector = await startCollector();
  io.out(`collector listening: export COHERENCE_TRACE_URL=${collector.url}`);
  io.out(`load the hooks with NODE_OPTIONS=--import=./${config.client}/coherence-trace-hooks.ts in the runner you start, then stop this with Ctrl-C to keep the traces`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  const traces = collector.drain();
  await collector.close();
  const { commit, dirty } = gitState(root);
  const meta = { captureHash: captureHash(root, config), at: new Date().toISOString(), commit, dirty, buildCommand: null, testCommand: "an external runner (conform --collect)", exit: null, traces: traces.length, collector: { ...collector.stats }, clients: { posted: 0, acknowledged: 0, dropped: 0, unattributed: 0, processes: 0 } };
  if (traces.length === 0) {
    io.err("conform --collect: no trace reached the collector; nothing kept");
    return 1;
  }
  io.out(`kept ${traces.length} trace(s) in ${writeCapture(root, meta, traces)}; conform replays them while the code stays as it is`);
  return 0;
}
