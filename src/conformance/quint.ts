/**
 * The one door to quint: every quint command Coherence runs (a quint prop's
 * typecheck, simulation and model check; conformance replay's parse and
 * generated test runs) is spawned here, bounded by a timeout that kills the
 * whole process tree, and read into one outcome:
 *
 *   ok           the command exited 0
 *   violation    quint found a state that breaks the invariant, or a run that failed
 *   error        quint refused the input: a parse or type error, an unknown name
 *   unavailable  quint, or the model checker behind verify (Java), could not start
 *   timeout      it did not finish in its time; nothing it said counts
 *
 * Only ok passes. A step that is unavailable or timed out is never read as a
 * pass, so a machine without quint or Java grades a quint prop not run.
 *
 * Quint is pinned at QUINT_PIN (major and minor): its JSON shapes (the parse
 * IR, the test report) are what replay reads, and a different minor may move
 * them. It is installed globally beside the language servers, never as a
 * package dependency; COHERENCE_QUINT names another binary.
 */

import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../lifecycle/work-meter.ts";
import { killTree } from "../enforcement/totality.ts";
import type { QuintConfig } from "./config.ts";

/** The quint release Coherence reads, major and minor. */
export const QUINT_PIN = "0.33";

export type QuintOutcome = "ok" | "violation" | "error" | "unavailable" | "timeout";

export interface QuintResult {
  outcome: QuintOutcome;
  /** The command as run, for the report. */
  command: string;
  stdout: string;
  stderr: string;
  ms: number;
  /** One line: why the outcome is what it is. */
  reason: string;
  /** The JSON quint wrote with --out, when it was asked to and wrote one that parses. */
  json?: unknown;
}

export interface QuintRunOptions {
  cwd: string;
  timeoutMs: number;
  /** Ask quint for --out <file> and read it back as json. */
  out?: boolean;
}

/** The quint binary: COHERENCE_QUINT when set, else quint on the PATH. Read only by runQuint. */
function quintBin(): string {
  const named = process.env["COHERENCE_QUINT"];
  return named === undefined || named.trim() === "" ? "quint" : named;
}

/** A model checker that could not start (no Java, no Apalache server) said so in its output, and verify proved nothing. */
const CHECKER_UNAVAILABLE = /java: (?:command )?not found|Unable to locate a Java Runtime|JAVA_HOME|could not (?:connect|reach) .*Apalache|Failed to (?:start|connect to) Apalache|No Java runtime/i;

function tail(text: string, lines = 12): string {
  return text.split("\n").filter((l) => l.trim() !== "").slice(-lines).join("\n");
}

/** Read one finished quint command into its outcome. */
export function quintOutcome(code: number | null, stdout: string, stderr: string): { outcome: QuintOutcome; reason: string } {
  const both = `${stdout}\n${stderr}`;
  if (code === 0) return { outcome: "ok", reason: "exited 0" };
  if (CHECKER_UNAVAILABLE.test(both)) return { outcome: "unavailable", reason: `the model checker could not start: ${tail(stderr || stdout, 2).replace(/\n/g, " ")}` };
  if (/\[violation\]|Invariant violated|error: Tests failed|\[(?:failed|fail)\]/i.test(both)) return { outcome: "violation", reason: tail(stdout, 3).replace(/\n/g, " ") || "quint reported a violation" };
  return { outcome: "error", reason: tail(stderr || stdout, 3).replace(/\n/g, " ") || `exited ${code}` };
}

/**
 * Run one quint command: argv after the binary, from `cwd`, killed with its
 * whole tree after `timeoutMs`. With `out`, --out <file> is added and its JSON
 * read back. Never throws: a binary that cannot start is unavailable.
 */
export async function runQuint(argv: readonly string[], options: QuintRunOptions): Promise<QuintResult> {
  const bin = quintBin();
  const dir = options.out === true ? mkdtempSync(join(tmpdir(), "coherence-quint-")) : undefined;
  const outFile = dir === undefined ? undefined : join(dir, "out.json");
  const args = outFile === undefined ? [...argv] : [...argv, "--out", outFile];
  const command = [bin, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
  const started = Date.now();
  try {
    return await new Promise<QuintResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: Omit<QuintResult, "command" | "ms">): void => {
        if (settled) return;
        settled = true;
        resolve({ ...result, command, ms: Date.now() - started });
      };
      let child;
      try {
        child = spawn(bin, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
      } catch (error) {
        finish({ outcome: "unavailable", stdout, stderr, reason: `quint could not start: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      const timer = setTimeout(() => {
        killTree(child.pid);
        finish({ outcome: "timeout", stdout, stderr, reason: `quint did not finish in ${Math.round(options.timeoutMs / 1000)} s; it and every process it started were killed` });
      }, options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (error) => {
        clearTimeout(timer);
        finish({ outcome: "unavailable", stdout, stderr, reason: `quint could not start (${bin}): ${error.message}; install @informalsystems/quint@${QUINT_PIN} globally or set COHERENCE_QUINT` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const read = quintOutcome(code, stdout, stderr);
        let json: unknown;
        if (outFile !== undefined) {
          try {
            json = JSON.parse(readFileSync(outFile, "utf8"));
          } catch {
            json = undefined;
          }
        }
        finish({ ...read, stdout, stderr, ...(json === undefined ? {} : { json }) });
      });
    });
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

/** The installed quint's version, or why there is none; checked against QUINT_PIN by its major and minor. */
export async function quintVersion(): Promise<{ version: string; pinned: boolean } | { reason: string }> {
  const result = await runQuint(["--version"], { cwd: process.cwd(), timeoutMs: 60_000 });
  if (result.outcome !== "ok") return { reason: `quint is not installed or does not answer: ${result.reason}` };
  const version = result.stdout.trim();
  return { version, pinned: version === QUINT_PIN || version.startsWith(`${QUINT_PIN}.`) };
}

/** The argv a model file is named by, with its main module when one is given. */
function target(file: string, main: string | undefined): string[] {
  return main === undefined ? [file] : [file, "--main", main];
}

/** Parse and type-check a model. */
export function typecheck(file: string, options: QuintRunOptions & { main?: string }): Promise<QuintResult> {
  return runQuint(["typecheck", file], options);
}

/** Simulate a model and check an invariant on every state reached, within the configured samples and steps. */
export function simulate(file: string, invariant: string, quint: QuintConfig, options: QuintRunOptions & { main?: string }): Promise<QuintResult> {
  const argv = ["run", ...target(file, options.main), "--invariant", invariant, "--max-samples", String(quint.maxSamples), "--max-steps", String(quint.maxSteps), "--backend", quint.backend];
  if (quint.seed !== undefined) argv.push("--seed", quint.seed);
  return runQuint(argv, options);
}

/** Model-check an invariant within the configured verify bound, with the configured checker. */
export function verify(file: string, invariant: string, quint: QuintConfig, options: QuintRunOptions & { main?: string }): Promise<QuintResult> {
  const argv = ["verify", ...target(file, options.main), "--invariant", invariant, "--max-steps", String(quint.verifySteps)];
  if (quint.verify === "tlc") argv.push("--backend", "tlc");
  return runQuint(argv, options);
}

/** Run a module's run definitions whose names match, reporting each passed or failed; with an ITF pattern, each run's states are written. */
export async function test(file: string, match: string, quint: QuintConfig, options: QuintRunOptions & { main?: string; itf?: string }): Promise<QuintResult> {
  const argv = ["test", ...target(file, options.main), "--match", match, "--backend", quint.backend, "--max-samples", "1"];
  if (options.itf !== undefined) argv.push("--out-itf", options.itf);
  const result = await runQuint(argv, { ...options, out: true });
  // --out silences the console: the report says which runs failed, and a report with errors is quint refusing the module.
  const report = testReport(result.json);
  if (report === undefined || result.outcome === "unavailable" || result.outcome === "timeout") return result;
  if (report.errors.length > 0) return { ...result, outcome: "error", reason: report.errors.slice(0, 3).join("; ") };
  return { ...result, outcome: report.failed.length > 0 ? "violation" : "ok", reason: `${report.passed.length} passed, ${report.failed.length} failed` };
}

/** What quint test --out reports: the runs that passed and failed, and why the module was refused, when it was. */
export interface TestReport {
  passed: string[];
  failed: string[];
  errors: string[];
}

/** A quint test report read from its JSON, or undefined when the JSON is not one. */
export function testReport(json: unknown): TestReport | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const record = json as Record<string, unknown>;
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const errors = (Array.isArray(record["errors"]) ? record["errors"] : []).map((e) => {
    const item = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
    return typeof item["explanation"] === "string" ? item["explanation"] : JSON.stringify(e);
  });
  if (!Array.isArray(record["passed"]) && !Array.isArray(record["failed"]) && errors.length === 0) return undefined;
  return { passed: names(record["passed"]), failed: names(record["failed"]), errors };
}

/** A model's parsed IR and source map: the names, parameters and conjuncts replay reads, with where each sits in the file. */
export async function parseIr(file: string, options: QuintRunOptions): Promise<{ result: QuintResult; ir?: unknown; sourceMap?: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), "coherence-quint-ir-"));
  try {
    const map = join(dir, "map.json");
    const result = await runQuint(["parse", file, "--source-map", map], { ...options, out: true });
    let sourceMap: unknown;
    try {
      sourceMap = JSON.parse(readFileSync(map, "utf8"));
    } catch {
      sourceMap = undefined;
    }
    return { result, ...(result.json === undefined ? {} : { ir: result.json }), ...(sourceMap === undefined ? {} : { sourceMap }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
