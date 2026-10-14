/**
 * The enforcement commands:
 *
 *   node src/cli.ts run [--session <id>] [--agent <name>] [--form chokepoint|totality-oracle] [--quint] [--invariant <name>]... [--no-server] [--observe] [--each] [--json]
 *   node src/cli.ts run --each                 after the batched pass, each totality oracle's test in its own invocation, appended as a second run
 *   node src/cli.ts run --status [--json]     the latest verdict per enforcement, derived from every run
 *   node src/cli.ts refute <component>/<name> --broke "<what you changed>"
 *   node src/cli.ts serve [--idle <seconds>] [--root <dir>] [--language <language>]  the warm server, in the foreground; refused while another live server holds the root and language
 *
 * A run appends one record; the status is a view over the records and is
 * never stored. Exit 1 when a run found a structural defect (a bypass, a
 * missing chokepoint, a failing totality oracle), when the instrument died
 * or never answered, and 0 otherwise.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { adapterFor } from "../adapters/index.ts";
import { registryOf, type Registry } from "../adapters/project-config.ts";
import { JournalError, parseFlags } from "../journal/args.ts";
import type { Io } from "../journal/cli.ts";
import { loadSpecModel, type SpecModel } from "../spec/model.ts";
import { verdictText } from "../spec/report.ts";
import { governedBy } from "./check.ts";
import { readEnforcementConfig } from "./config.ts";
import { latencyLines } from "./latency.ts";
import { RUNS_DIR, appendRefutation, latestByEnforcement, loadRuns, type Form, type RefutationRecord } from "./record.ts";
import { performRun, UnknownInvariants, type EachOutcome, type EntryDetail, type RunOutcome } from "./run.ts";
import { DEFAULT_IDLE_MS, serve, type ServeOptions } from "./server.ts";
import { gitState } from "../journal/store.ts";
import { formatObservationSummary } from "../observation/observed.ts";

export const REFUTE_USAGE = '  refute <component>/<name> --broke "<what you changed>" [--session <id>] [--agent <name>] [--timeout <seconds>]   run the bullet\'s totality oracle with the break staged; it must fail, and a detector that does not finish in time (default 600 s) refutes nothing';

export const ENFORCEMENT_USAGE = [
  "  run [--session <id>] [--agent <name>] [--form chokepoint|totality-oracle] [--quint] [--invariant <name>]... [--no-server] [--observe] [--each] [--json]",
  "  run --quint              only the quint props: each via: quint prop <property>, checked by quint typecheck, quint run and quint verify against the spec's model",
  "  run --status [--json]   the latest verdict per enforcement, derived from every run",
  "  run at a registry's top runs each listed project from its own folder, one after another; --json is an array of each project's",
  "  run --each               after the batched pass, run each totality oracle's test in its own invocation (the config's test command), append those verdicts as a second run, and name any that passed batched but fail alone",
  "  run --observe            also record an observation: per-test coverage from the same one batched invocation (.coherence/observations)",
  REFUTE_USAGE,
  "  serve [--idle <seconds>] [--root <dir>] [--language <language>]   the warm language server for this project (default: the current folder) and language (default: the primary one), in the foreground; one per root and language",
].join("\n");

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

/** The printed form of one run. */
export function formatRun(outcome: RunOutcome): string {
  const lines: string[] = [];
  const byInvariant = new Map<string, EntryDetail[]>();
  for (const detail of outcome.details) {
    const key = `${detail.entry.component}/${detail.entry.name}`;
    byInvariant.set(key, [...(byInvariant.get(key) ?? []), detail]);
  }
  for (const [key, details] of byInvariant) {
    lines.push(key);
    for (const detail of details) {
      const e = detail.entry;
      if (e.form === "chokepoint") {
        const c = detail.chokepoint;
        const label = c === undefined ? "chokepoint" : `chokepoint ${c.input.chokepoint} protects ${c.input.protects}`;
        lines.push(`  ${label}: ${e.grade ?? "not run"}${e.enforcer === undefined ? "" : ` (enforced by ${e.enforcer})`} — ${e.verdict} (${ms(e.latency)})`);
        lines.push(`    ${e.reason}`);
        if (c !== undefined && c.protectedThing !== undefined) {
          const counts = c.counts;
          const governed = c.governed;
          const exempt = governed?.exempt === undefined ? "" : `, ${counts.exempt} exempt (from inside ${governed.exempt}; from: ${governed.value}, by ${governedBy(governed)})`;
          lines.push(`    references: ${counts.inside} inside, ${counts.test} test${exempt}, ${counts.bypass} bypass`);
          lines.push(`    refutation ${e.refutation}: ${c.refutationAccount}`);
        }
      } else if (e.quintProp !== undefined) {
        const steps = Object.entries(e.quintSteps ?? {}).map(([step, s]) => `${step} ${s.outcome}`).join(", ");
        lines.push(`  quint prop ${e.quintProp}${e.quintGrade === undefined ? "" : ` (${e.quintGrade})`}: ${e.verdict} (${ms(e.latency)}; ${steps === "" ? "no quint step ran" : steps}); refutation ${e.refutation}${e.conformance === undefined || e.conformance === "absent" ? "" : `; conformance ${e.conformance}`}`);
        lines.push(`    ${e.reason}`);
        if (e.counterexample !== undefined) for (const line of e.counterexample.split("\n").slice(0, 20)) lines.push(`    | ${line}`);
      } else {
        const t = detail.totality;
        lines.push(`  totality oracle: ${e.verdict} (${ms(e.latency)}${e.mode === "batched" ? ", one invocation for every test the bullets name" : e.mode === "one-at-a-time" ? ", its own invocation" : ""}); refutation ${e.refutation}`);
        lines.push(`    ${e.reason}`);
        if (t !== undefined && t.tail !== "") for (const line of t.tail.split("\n")) lines.push(`    | ${line}`);
      }
    }
  }
  if (outcome.details.length === 0) lines.push("no enforcement to check: no bullet carries protects + chokepoint or over + via");
  const r = outcome.record;
  const fails = r.invariants.filter((e) => e.verdict === "fail").length;
  const passes = r.invariants.filter((e) => e.verdict === "pass").length;
  const notRun = r.invariants.length - fails - passes;
  lines.push(
    `run recorded in ${RUNS_DIR}/${r.session}.jsonl: ${r.invariants.length} enforcement${r.invariants.length === 1 ? "" : "s"}, ${passes} pass, ${fails} fail, ${notRun} not run; instrument ${r.instrument.language} (${r.instrument.server}); ${ms(r.latency)}`,
  );
  if (outcome.instrumentReason !== undefined) lines.push(`instrument unavailable: ${outcome.instrumentReason}`);
  if (outcome.observation !== undefined) lines.push(formatObservationSummary(outcome.observation.record));
  if (outcome.observationSkipped !== undefined) lines.push(`no observation recorded: ${outcome.observationSkipped}`);
  if (outcome.eachSkipped !== undefined) lines.push(`no per-test run recorded: ${outcome.eachSkipped}`);
  if (outcome.each !== undefined) lines.push(...formatEach(outcome.each));
  if (outcome.latency !== undefined) lines.push(...latencyLines(outcome.latency));
  return lines.join("\n");
}

/** The printed form of `run --each`: each totality oracle alone, then the ones the batch hid. */
function formatEach(each: EachOutcome): string[] {
  const lines = ["each alone, in its own invocation:"];
  for (const detail of each.details) {
    const e = detail.entry;
    lines.push(`  ${e.component}/${e.name}: ${e.verdict} (${ms(e.latency)})`);
    if (e.verdict !== "pass") {
      lines.push(`    ${e.reason}`);
      const tail = detail.totality?.tail ?? "";
      if (tail !== "") for (const line of tail.split("\n")) lines.push(`    | ${line}`);
    }
  }
  const passes = each.details.filter((d) => d.entry.verdict === "pass").length;
  lines.push(`per-test run recorded in ${RUNS_DIR}/${each.record.session}.jsonl: ${each.details.length} alone, ${passes} pass; ${ms(each.record.latency)}`);
  if (each.hidden.length > 0) {
    lines.push(`passed batched but fail alone (${each.hidden.length}): each passed on what another test left behind`);
    for (const d of each.hidden) lines.push(`  ✕ ${d.entry.component}/${d.entry.name}`);
  }
  if (each.unconfirmed.length > 0) lines.push(`passed batched but could not run alone (${each.unconfirmed.length}): ${each.unconfirmed.map((d) => `${d.entry.component}/${d.entry.name}`).join(", ")}`);
  if (each.hidden.length === 0 && each.unconfirmed.length === 0) lines.push("every totality oracle that passed batched passes alone");
  return lines;
}

/** The status view: the latest verdict per enforcement in the spec, with the run it came from; a skipped enforcement keeps its prior dated verdict. */
export function formatStatus(root: string, model: SpecModel): string {
  const loaded = loadRuns(root);
  if (loaded.records.length === 0) return "no run yet: every enforcement is declared, unverified; run: run";
  const latestRun = loaded.records[loaded.records.length - 1]!;
  const latest = latestByEnforcement(loaded.records);
  const inLatest = new Set(latestRun.invariants.map((e) => `${e.component} ${e.name} ${e.form}`));
  const lines: string[] = [];
  let defects = 0;
  for (const component of model.components) {
    for (const invariant of component.invariants) {
      for (const enforcement of invariant.enforcements) {
        const form: Form = enforcement.form;
        const key = `${component.folder} ${invariant.name} ${form}`;
        const entry = latest.get(key);
        const what = enforcement.form === "chokepoint" ? `chokepoint ${enforcement.chokepoint}` : enforcement.quintProp !== undefined ? `quint prop ${enforcement.quintProp}` : `totality oracle "${enforcement.via}"`;
        let text = verdictText(entry);
        if (entry !== undefined && !inLatest.has(key)) text += ` — kept from the run at ${entry.at}; the latest run skipped it`;
        if (entry?.verdict === "fail") defects += 1;
        lines.push(`${entry?.verdict === "fail" ? "✕" : entry?.verdict === "pass" ? "✓" : "○"} ${component.folder}/${invariant.name}  ${what}: ${text}`);
      }
    }
  }
  lines.push(`latest run ${latestRun.at} by ${latestRun.agent} (${latestRun.session}) at ${latestRun.commit ?? "no commit"}${latestRun.dirty ? ", dirty" : ""}; ${loaded.records.length} run${loaded.records.length === 1 ? "" : "s"}; ${defects} structural defect${defects === 1 ? "" : "s"}`);
  if (loaded.damaged.length > 0) for (const d of loaded.damaged) lines.push(`damaged ${d.file}:${d.line}: ${d.reason}`);
  return lines.join("\n");
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The run at a registry's top: each listed project from its own folder, with
 * its own config, records and verdicts, one after another; never the whole
 * repository read as one project with the top's keys, which took specs no
 * registry lists and wrote its records at the top (df-0b68c987). The printed
 * form heads each project's with its folder; --json is one array of each
 * project's object. Exit 1 when any project's would, and a usage error ends it.
 */
async function registryRun(registry: Registry, argv: string[], io: Io, json: boolean): Promise<number> {
  let exit = 0;
  const objects: unknown[] = [];
  for (const leaf of registry.leaves) {
    const name = relative(registry.top, leaf).split(sep).join("/");
    const lines: string[] = [];
    const code = await runCommand(argv, { ...io, cwd: leaf, out: (line) => lines.push(line) });
    if (code === 64) return code;
    if (code !== 0) exit = 1;
    if (json) {
      for (const line of lines) objects.push({ project: name, ...(JSON.parse(line) as object) });
    } else {
      io.out(`project ${name}:`);
      for (const line of lines) io.out(line.replace(/^/gm, "  "));
    }
  }
  if (json) io.out(JSON.stringify(objects, null, 2));
  else io.out(`registry ${registry.path}: ${registry.leaves.length} project${registry.leaves.length === 1 ? "" : "s"} run, each from its own folder`);
  return exit;
}

export async function runCommand(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseFlags(argv, { session: "one", agent: "one", form: "one", invariant: "many", "no-server": "switch", json: "switch", status: "switch", observe: "switch", each: "switch", quint: "switch" });
  } catch (error) {
    if (error instanceof JournalError) {
      io.err(`run: ${error.message}\n${ENFORCEMENT_USAGE}`);
      return 64;
    }
    throw error;
  }
  if (parsed.positionals.length > 0) {
    io.err(`run: unexpected argument "${parsed.positionals[0]}"\n${ENFORCEMENT_USAGE}`);
    return 64;
  }
  const root = io.cwd;
  // A registry's top is no project: the run goes to each listed project in turn, as spec --check reads each there.
  const registry = registryOf(root);
  if (registry !== undefined && registry.top === realOr(root) && !registry.leaves.includes(registry.top)) return registryRun(registry, argv, io, parsed.switches.has("json"));
  if (parsed.switches.has("status")) {
    const model = loadSpecModel(root);
    if (parsed.switches.has("json")) {
      const loaded = loadRuns(root);
      io.out(JSON.stringify({ latest: Object.fromEntries([...latestByEnforcement(loaded.records)].map(([k, v]) => [k.split(" ").join(" / "), v])), runs: loaded.records.length, damaged: loaded.damaged }, null, 2));
    } else {
      io.out(formatStatus(root, model));
    }
    return 0;
  }
  const formText = parsed.one.get("form");
  let form: Form | undefined;
  if (formText !== undefined) {
    if (formText === "chokepoint") form = "chokepoint";
    else if (formText === "totality-oracle" || formText === "totality oracle") form = "totality oracle";
    else {
      io.err(`run: --form is chokepoint or totality-oracle, not "${formText}"`);
      return 64;
    }
  }
  const session = parsed.one.get("session") ?? randomUUID();
  const agent = parsed.one.get("agent") ?? "main";
  const invariants = parsed.many.get("invariant");
  const languages = readEnforcementConfig(root).languages;
  // In process, one adapter per language: each starts its server only when a check first asks it.
  const directs = parsed.switches.has("no-server") ? languages.map((language) => adapterFor(language, root)) : [];
  const direct = languages.length === 1 ? directs[0] : undefined;
  const adapters = languages.length > 1 && directs.length > 0 ? Object.fromEntries(directs.map((a) => [a.language, a])) : undefined;
  try {
    const observe = parsed.switches.has("observe");
    const each = parsed.switches.has("each");
    const quint = parsed.switches.has("quint");
    if (quint && form === "chokepoint") {
      io.err("run: --quint checks quint props, which are totality oracles; --form chokepoint runs none");
      return 64;
    }
    if (each && form === "chokepoint") {
      io.err("run: --each confirms totality oracles one at a time; --form chokepoint runs none");
      return 64;
    }
    let outcome: Awaited<ReturnType<typeof performRun>>;
    try {
      outcome = await performRun(root, { session, agent, form, invariants, adapter: direct, adapters, server: directs.length === 0, observe, each, quint });
    } catch (error) {
      if (!(error instanceof UnknownInvariants)) throw error;
      io.err(error.message);
      return 64;
    }
    if (parsed.switches.has("json")) {
      io.out(
        JSON.stringify(
          {
            ...outcome.record,
            file: outcome.file,
            instrumentReason: outcome.instrumentReason ?? null,
            instrumentDied: outcome.instrumentDied,
            latency: outcome.latency ?? null,
            ...(each
              ? {
                  each: outcome.each === undefined ? null : { ...outcome.each.record, file: outcome.each.file, hidden: outcome.each.hidden.map((d) => `${d.entry.component}/${d.entry.name}`), unconfirmed: outcome.each.unconfirmed.map((d) => `${d.entry.component}/${d.entry.name}`) },
                  eachSkipped: outcome.eachSkipped ?? null,
                }
              : {}),
            ...(observe ? { observation: outcome.observation === undefined ? null : { file: outcome.observation.file, totals: outcome.observation.record.totals, source: outcome.observation.record.source }, observationSkipped: outcome.observationSkipped ?? null } : {}),
          },
          null,
          2,
        ),
      );
    }
    else io.out(formatRun(outcome));
    // A run whose instrument never answered proved nothing; it must never read as a clean pass.
    // With --each, a test that cannot pass alone (or cannot run alone) is not confirmed either.
    const eachFailed = outcome.each !== undefined && outcome.each.details.some((d) => d.entry.verdict !== "pass");
    return outcome.record.invariants.some((e) => e.verdict === "fail") || outcome.instrumentDied || eachFailed ? 1 : 0;
  } finally {
    for (const a of directs) await a.close();
  }
}

/** `extra` carries what the command line wires in beside the instrument: the reading the server answers over HTTP. */
export async function serveCommand(argv: string[], io: Io, extra: Pick<ServeOptions, "http"> = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseFlags(argv, { idle: "one", root: "one", language: "one" });
  } catch (error) {
    if (error instanceof JournalError) {
      io.err(`serve: ${error.message}\n${ENFORCEMENT_USAGE}`);
      return 64;
    }
    throw error;
  }
  const idleText = parsed.one.get("idle");
  const idleMs = idleText === undefined ? DEFAULT_IDLE_MS : Number(idleText) * 1000;
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    io.err("serve: --idle takes a number of seconds");
    return 64;
  }
  // --root names the root on the command line, so the process table says which root each server holds.
  const root = resolve(io.cwd, parsed.one.get("root") ?? ".");
  let serving;
  try {
    serving = await serve(root, {
      ...extra,
      idleMs,
      language: parsed.one.get("language"),
      log: (line) => io.err(`serve: ${line}`),
      onListen: (paths) => io.err(`serve: listening on ${paths.socket}; idle shutdown after ${Math.round(idleMs / 1000)} s`),
    });
  } catch (error) {
    io.err(`serve: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  await serving.done;
  return 0;
}

/**
 * The refutation command: run one bullet's totality oracle while the break is
 * staged, require it to go red, and append the refutation to the run store.
 *
 *   node src/cli.ts refute <component>/<name> --broke "<what you changed>" [--session <id>] [--agent <name>]
 *
 * The agent stages the break, runs this, restores the code, and runs `run`;
 * the refutation counts as witnessed only once a later run finds the same
 * totality oracle passing again. A passing totality oracle appends nothing and exits non-zero:
 * a refutation is never recorded on a verdict that is not a fail.
 */
export async function refuteCommand(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseFlags(argv, { broke: "one", session: "one", agent: "one", form: "one", json: "switch", timeout: "one" });
  } catch (error) {
    if (error instanceof JournalError) {
      io.err(`refute: ${error.message}\n${REFUTE_USAGE}`);
      return 64;
    }
    throw error;
  }
  const target = parsed.positionals[0];
  if (target === undefined || parsed.positionals.length > 1) {
    io.err(`refute: name one bullet as <component>/<name>\n${REFUTE_USAGE}`);
    return 64;
  }
  const broke = parsed.one.get("broke");
  if (broke === undefined || broke.trim() === "") {
    io.err(`refute: --broke says what you changed to break the invariant\n${REFUTE_USAGE}`);
    return 64;
  }
  const root = io.cwd;
  const model = loadSpecModel(root, { runs: false });
  const cut = target.lastIndexOf("/");
  if (cut <= 0) {
    io.err(`refute: "${target}" is not <component>/<name>; the entry component is "." (./<name>)`);
    return 64;
  }
  const folder = target.slice(0, cut);
  const name = target.slice(cut + 1);
  const component = model.components.find((c) => c.folder === folder);
  if (component === undefined) {
    io.err(`refute: no component at ${folder}; the components are ${model.components.map((c) => c.folder).join(", ")}`);
    return 64;
  }
  const invariant = component.invariants.find((i) => i.name === name);
  if (invariant === undefined) {
    io.err(`refute: ${folder} has no invariant named "${name}"`);
    return 64;
  }
  const vias = invariant.enforcements.flatMap((e) => (e.form === "totality oracle" ? [e.via] : []));
  if (vias.length === 0) {
    io.err(`refute: ${target} carries no totality oracle form (over + via); a chokepoint form is refuted automatically by every run`);
    return 64;
  }

  const timeout = parsed.one.get("timeout");
  const timeoutMs = timeout === undefined ? undefined : Number(timeout) * 1000;
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    io.err(`refute: --timeout takes a positive number of seconds, not "${timeout}"\n${REFUTE_USAGE}`);
    return 64;
  }
  const session = parsed.one.get("session") ?? randomUUID();
  const agent = parsed.one.get("agent") ?? "main";
  const { commit, dirty } = gitState(root);
  const written: RefutationRecord[] = [];
  // The verdict comes from the pass itself, so refute asks the same question a run asks, through the same
  // door: performRun stays the only site that reaches the batched runner, and the runner that can report per
  // test is the one consulted, so a suite exiting non-zero for a reason that is not this test cannot record a
  // refutation for a break nobody staged.
  const outcome = await performRun(root, { session, agent, form: "totality oracle", invariants: [name], ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  for (const via of vias) {
    const detail = outcome.details.find((d) => d.entry.component === folder && d.entry.name === name && d.entry.form === "totality oracle");
    const result = detail?.totality ?? { verdict: "not run" as const, reason: `the run checked no totality oracle for ${target}`, command: undefined, tail: "" };
    // A detector that never answered refuted nothing: a break that loops forever is not a red detector.
    if (result.unfinished === true) {
      io.err(
        `refute: ${result.reason}, so nothing was refuted and nothing was recorded.\n` +
          `  A detector that never answers is not a red one: stage a break the detector reports, or give it longer with --timeout <seconds>.`,
      );
      return 1;
    }
    if (result.matched === 0) {
      io.err(
        `refute: no test ran under the name "${via}", so nothing was refuted and nothing was recorded.\n` +
          `  ${result.reason}\n` +
          `  A detector that cannot be selected by name is not a detector; fix the via, or make the bullet a requirement and say why.`,
      );
      return 1;
    }
    if (result.verdict !== "fail") {
      io.err(
        `refute: the totality oracle "${via}" ${result.verdict === "pass" ? "still passed" : "did not run"} with the break staged, so nothing was refuted and nothing was recorded.\n` +
          `  ${result.reason}\n` +
          `  Stage a break that this totality oracle detects, or, if the break it describes cannot be staged, make the bullet a requirement and say why.`,
      );
      return 1;
    }
    const record: RefutationRecord = {
      kind: "refutation",
      at: new Date().toISOString(),
      session,
      agent,
      component: folder,
      name,
      form: "totality oracle",
      broke: broke.trim(),
      verdict: "fail",
      reason: result.reason,
      commit,
      dirty,
    };
    appendRefutation(root, record);
    written.push(record);
  }
  if (parsed.switches.has("json")) {
    io.out(JSON.stringify(written, null, 2));
    return 0;
  }
  for (const record of written) {
    io.out(`refuted ${folder}/${name} (${record.form}): ${record.broke}`);
    io.out(`  the detector went red: ${record.reason}`);
    io.out(`  recorded in ${RUNS_DIR}/${session}.jsonl at ${record.at}`);
  }
  io.out("now restore the code and run: run — the refutation counts as witnessed once a later run finds the same totality oracle passing");
  return 0;
}
