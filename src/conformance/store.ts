/**
 * What conformance replay keeps, in two places:
 *
 *   captures   .coherence/cache/conformance/<captureHash>/{meta.json,traces.jsonl}:
 *              the traces one run of the tests produced, with what produced
 *              them. Large and reproducible from the code, so cache: never
 *              committed, written whole (aside, then renamed) or not at all.
 *   verdicts   .coherence/conformance/<session>.jsonl, a record store: one line
 *              per model per conform, appended, never rewritten, committed with
 *              the other records. A quint prop reads its model's latest one
 *              whose capture and replay hashes are the current ones
 *              (standing.ts); a verdict of other hashes is stale, never
 *              current, however recently it agreed.
 *
 * Only this module writes either.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendWhole, storeLines } from "../journal/append.ts";
import { storeDir } from "../journal/stores.ts";
import type { CapturedTrace, CollectorStats } from "./collector.ts";
import type { TraceCounters } from "./coherence-trace.ts";

/** Where captures are kept, under the project root. */
const CAPTURE_DIR = join(".coherence", "cache", "conformance");
/** The conformance verdict store's folder. */
const CONFORMANCE_DIR = storeDir("conformance");

/** What produced one capture: the hash it is kept under, the commands, and what the collector and the clients counted. */
export interface CaptureMeta {
  captureHash: string;
  at: string;
  commit: string | null;
  dirty: boolean;
  buildCommand: string | string[] | null;
  testCommand: string | string[];
  /** The test command's own exit code: reported, never used to choose traces (each test declared its own outcome). */
  exit: number | null;
  traces: number;
  collector: CollectorStats;
  /** The clients' counters, summed over every process that wrote them. */
  clients: TraceCounters & { processes: number };
  /** Whether the test command was killed for running past its time. */
  unfinished?: boolean;
}

/** One model's verdict from one conform: agreement, coverage, and every failure with the side that can fix it. */
export interface ConformanceVerdict {
  at: string;
  session: string;
  agent: string;
  commit: string | null;
  dirty: boolean;
  /** The component folder whose spec names the model. */
  model: string;
  /** The model file, project-relative. */
  file: string;
  captureHash: string;
  replayHash: string;
  verdict: "agrees" | "disagrees";
  matched: number;
  total: number;
  /** Logged arguments that pin a parameter of the action they reached, over all logged arguments. */
  pinned: number;
  logged: number;
  /** action.argument for each logged argument no parameter took. */
  unpinned: string[];
  /** Why the verdict is not agrees: each failing condition, with what fixes it. */
  failures: { test?: string; side: "replay-side" | "capture-side"; step?: number; cause: string }[];
  /** Landmarks no test reached, and guard scenarios never seen false that can be. */
  unreached: string[];
  gaps: string[];
}

function captureFolder(root: string, hash: string): string {
  return join(root, CAPTURE_DIR, hash);
}

/** Keep one capture whole: written aside, then renamed into place, so a reader finds all of it or none. */
export function writeCapture(root: string, meta: CaptureMeta, traces: readonly CapturedTrace[]): string {
  const folder = captureFolder(root, meta.captureHash);
  const aside = `${folder}.${process.pid}.tmp`;
  rmSync(aside, { recursive: true, force: true });
  mkdirSync(aside, { recursive: true });
  writeFileSync(join(aside, "traces.jsonl"), traces.map((t) => JSON.stringify(t)).join("\n") + (traces.length === 0 ? "" : "\n"));
  writeFileSync(join(aside, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  rmSync(folder, { recursive: true, force: true });
  renameSync(aside, folder);
  return join(CAPTURE_DIR, meta.captureHash);
}

/** The capture kept under a hash, or undefined when there is none or it does not read whole. */
export function readCapture(root: string, hash: string): { meta: CaptureMeta; traces: CapturedTrace[] } | undefined {
  const folder = captureFolder(root, hash);
  try {
    const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8")) as CaptureMeta;
    const traces = readFileSync(join(folder, "traces.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as CapturedTrace);
    return meta.captureHash === hash ? { meta, traces } : undefined;
  } catch {
    return undefined;
  }
}

/** A folder for files that belong to one capture (the generated replay modules), inside its cache folder. */
export function captureScratch(root: string, hash: string): string {
  const folder = join(captureFolder(root, hash), "replay");
  mkdirSync(folder, { recursive: true });
  return folder;
}

/** Append one verdict to the session's file in the conformance store. */
export function appendVerdict(root: string, verdict: ConformanceVerdict): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(verdict.session)) throw new Error(`session "${verdict.session}" cannot name a file; use letters, digits, dot, dash, or underscore`);
  const dir = join(root, CONFORMANCE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${verdict.session}.jsonl`);
  appendWhole(file, `${JSON.stringify(verdict)}\n`);
  return join(CONFORMANCE_DIR, `${verdict.session}.jsonl`);
}

/** Every verdict in the store, oldest first; a line that does not read as one is skipped. */
export function loadVerdicts(root: string): ConformanceVerdict[] {
  const dir = join(root, CONFORMANCE_DIR);
  if (!existsSync(dir)) return [];
  const seen = new Set<string>();
  const verdicts: ConformanceVerdict[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    for (const { line } of storeLines(readFileSync(join(dir, name), "utf8"), seen)) {
      try {
        const value = JSON.parse(line) as ConformanceVerdict;
        if (typeof value.at === "string" && typeof value.model === "string" && (value.verdict === "agrees" || value.verdict === "disagrees")) verdicts.push(value);
      } catch {
        // A torn line is skipped: the next conform appends a whole one.
      }
    }
  }
  return verdicts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
