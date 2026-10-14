/**
 * The capture: the project's own tests run under a collector, in the one
 * order that works.
 *
 *   1. the build command, when there is one; a build that fails ends it
 *   2. the collector, listening before anything that will log exists
 *   3. the test command, with COHERENCE_TRACE_URL exported and the vendored
 *      node:test hooks loaded through NODE_OPTIONS, from the config's folder
 *   4. the traces drained, the collector closed, every client's counters read
 *
 * The runner spawns the tests, never the reverse: a process that starts
 * before the URL exists caches its absence for its whole life and the
 * collector hears nothing, with no error. A capture with no trace therefore
 * fails, naming the two causes that leave it empty. The test command's exit
 * code is reported and never chooses traces: each test declared its own
 * outcome, and only a passing test's trace was queued.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "../lifecycle/work-meter.ts";
import { killTree } from "../enforcement/totality.ts";
import { gitState } from "../journal/store.ts";
import { startCollector, type CapturedTrace, type CollectorStats } from "./collector.ts";
import type { TraceCounters } from "./coherence-trace.ts";
import type { ConformanceConfig } from "./config.ts";
import { captureHash } from "./hashes.ts";
import { writeCapture, type CaptureMeta } from "./store.ts";
import { VENDORED_FILES } from "./vendor.ts";

/** Why no trace reached the collector, when none did: the two causes that leave a capture empty without an error. */
export const NO_TRACE_CAUSE = "no trace reached the collector: is the client imported and called at the instrumented sites, do the tests that reach them pass, and does the test command carry the build flag, feature or tag that compiles the client in?";

export interface CaptureOutcome {
  meta: CaptureMeta;
  traces: CapturedTrace[];
  /** Where the capture was kept, project-relative; absent when it was not kept (the build failed, or no trace arrived). */
  kept?: string;
  /** Why the capture failed, when it did. */
  failure?: string;
  /** How many processes the capture spawned: the build and the test command. */
  spawned: number;
}

function commandText(command: string | readonly string[]): string {
  return typeof command === "string" ? command : command.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** Run one command to its end from `cwd` with `env`, killing its whole tree after `timeoutMs`. */
function runCommand(command: string | readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string; unfinished: boolean; error?: string }> {
  return new Promise((done) => {
    const [bin, ...args] = typeof command === "string" ? [command] : command;
    let output = "";
    let unfinished = false;
    let child;
    try {
      child = spawn(bin!, args, { cwd, env, shell: typeof command === "string", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      done({ code: null, output, unfinished, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      unfinished = true;
      killTree(child.pid);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: null, output, unfinished, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output, unfinished });
    });
  });
}

/** The environment the test command runs in: the collector's URL, the hooks loaded first, and no test name inherited from whoever ran conform. */
export function captureEnv(base: NodeJS.ProcessEnv, url: string, hooks: string, counters: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, COHERENCE_TRACE_URL: url, COHERENCE_TRACE_COUNTERS: counters, CI: base["CI"] ?? "1" };
  delete env["COHERENCE_TRACE_TEST"];
  delete env["NODE_TEST_CONTEXT"];
  env["NODE_OPTIONS"] = [base["NODE_OPTIONS"], `--import=${pathToFileURL(hooks).href}`].filter((o) => o !== undefined && o !== "").join(" ");
  return env;
}

function summed(dir: string): TraceCounters & { processes: number } {
  const total = { posted: 0, acknowledged: 0, dropped: 0, unattributed: 0, processes: 0 };
  if (!existsSync(dir)) return total;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      const counted = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<TraceCounters>;
      total.posted += counted.posted ?? 0;
      total.acknowledged += counted.acknowledged ?? 0;
      total.dropped += counted.dropped ?? 0;
      total.unattributed += counted.unattributed ?? 0;
      total.processes += 1;
    } catch {
      // A counter file torn at exit: that process's counts are lost, and the processes count says so.
    }
  }
  return total;
}

/** Run the tests under a collector and keep what they logged, stamped with the capture hash. */
export async function capture(root: string, config: ConformanceConfig, log: (line: string) => void = () => {}): Promise<CaptureOutcome> {
  const hash = captureHash(root, config);
  const at = new Date().toISOString();
  const { commit, dirty } = gitState(root);
  const emptyStats: CollectorStats = { accepted: 0, refused: {}, queued: 0, discarded: 0, unfinished: 0 };
  const base = { captureHash: hash, at, commit, dirty, buildCommand: config.buildCommand ?? null, testCommand: config.testCommand ?? "", exit: null, traces: 0, collector: emptyStats, clients: { posted: 0, acknowledged: 0, dropped: 0, unattributed: 0, processes: 0 } } satisfies CaptureMeta;
  if (config.testCommand === undefined) return { meta: base, traces: [], failure: "no conformance.testCommand in the config: name the command that runs the tests reaching the instrumented sites", spawned: 0 };
  const hooks = resolve(root, config.client, VENDORED_FILES[1]);
  if (!existsSync(hooks)) return { meta: base, traces: [], failure: `no node:test hooks at ${config.client}/${VENDORED_FILES[1]}: vendor the client with scaffold client --dir ${config.client} --write, or set conformance.client to its folder`, spawned: 0 };
  const cwd = resolve(root, config.cwd);
  const timeoutMs = config.timeoutSeconds * 1000;
  let spawned = 0;

  if (config.buildCommand !== undefined) {
    log(`build: ${commandText(config.buildCommand)}`);
    spawned += 1;
    const built = await runCommand(config.buildCommand, cwd, { ...process.env }, timeoutMs);
    if (built.code !== 0) {
      const why = built.error ?? (built.unfinished ? `did not finish in ${config.timeoutSeconds} s` : `exited ${built.code}`);
      return { meta: base, traces: [], failure: `the build command ${why}: ${built.output.split("\n").filter((l) => l.trim() !== "").slice(-5).join(" | ")}`, spawned };
    }
  }

  // The collector listens before the tests exist, so every process the tests start finds its URL.
  const collector = await startCollector();
  const counters = mkdtempSync(join(tmpdir(), "coherence-trace-counters-"));
  let traces: CapturedTrace[] = [];
  let tested: Awaited<ReturnType<typeof runCommand>>;
  try {
    log(`tests: ${commandText(config.testCommand)} (collector ${new URL(collector.url).host})`);
    spawned += 1;
    tested = await runCommand(config.testCommand, cwd, captureEnv(process.env, collector.url, hooks, counters), timeoutMs);
    traces = collector.drain();
  } finally {
    await collector.close();
  }
  const clients = summed(counters);
  rmSync(counters, { recursive: true, force: true });
  const meta: CaptureMeta = { ...base, exit: tested.code, traces: traces.length, collector: { ...collector.stats }, clients, ...(tested.unfinished ? { unfinished: true } : {}) };
  if (tested.error !== undefined) return { meta, traces, failure: `the test command could not start: ${tested.error}`, spawned };
  if (tested.unfinished) return { meta, traces, failure: `the test command did not finish in ${config.timeoutSeconds} s; its process tree was killed and nothing it logged is kept`, spawned };
  if (traces.length === 0) return { meta, traces, failure: NO_TRACE_CAUSE, spawned };
  return { meta, traces, kept: writeCapture(root, meta, traces), spawned };
}

/** A trace's events that belong to a model, by scope, and how many of each other scope were left out. */
export function scoped(traces: readonly CapturedTrace[], scopes: readonly string[]): { traces: CapturedTrace[]; excluded: Record<string, number> } {
  const wanted = new Set(scopes);
  const excluded: Record<string, number> = {};
  const kept: CapturedTrace[] = [];
  for (const trace of traces) {
    const events = trace.events.filter((event) => {
      if (event.scopes.some((s) => wanted.has(s))) return true;
      for (const s of event.scopes) excluded[s] = (excluded[s] ?? 0) + 1;
      return false;
    });
    if (events.length > 0) kept.push({ test: trace.test, events });
  }
  return { traces: kept, excluded };
}
