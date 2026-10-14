/**
 * The run: the primary record of one verification pass. Sealed shards per
 * session under .coherence/runs (shards.ts), one record per run, append only. Each run
 * carries one entry per enforcement checked (component, invariant, form).
 * The latest verdict per enforcement is a view derived from every run file
 * when it is asked for; it is never stored, and an enforcement a later run
 * skipped keeps the verdict of the last run that checked it, dated.
 *
 * The same files carry the other durable event of enforcement: a refutation,
 * written by `refute` while the break is staged, carrying the bullet, what was
 * broken, and the failing verdict the detector gave. A line with
 * `kind: "refutation"` is one of those; a line without a kind is a run. A
 * refutation is witnessed only together with a run at or after it that found
 * the same enforcement passing: the break was staged, the detector went red,
 * the code was restored, and the detector went green again.
 *
 * A chokepoint entry's reference sites are most of a run's bytes and rarely
 * change, so an entry whose sites are exactly the ones its enforcement's last
 * entry in the same run file wrote is written with `sitesRef` (their
 * content's hash and the run in that file that holds them in full) in their
 * place; a reference never leaves its file, so each file resolves alone, and
 * each file's first entry for an enforcement is in full. loadRuns resolves each back
 * into `sites`, where a full write puts them; one it cannot resolve is said
 * in `sitesUnresolved` and among the damaged lines, never read as no sites.
 * Nothing already written is converted.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { basename, join } from "node:path";
import { appendWhole, storeLines } from "../journal/append.ts";
import { shardFor } from "../journal/shards.ts";
import { isStoreFile, storeDir } from "../journal/stores.ts";
import { heldSites, noteRunAppend, noteSitesAppend, runFileIdentity, type HeldSites } from "./run-index.ts";

export const RUNS_DIR = storeDir("runs");

export type Form = "chokepoint" | "totality oracle";
export type Verdict = "pass" | "fail" | "not run";
/**
 * The chokepoint grade. The choked rungs are adapter-defined and strongest
 * first: closure-choked (the interpreter: the thing is never a module
 * attribute), visibility-choked (the compiler: not exported), checker-choked
 * (a checker the project runs refuses private usage or a forbidden import),
 * reference-choked (Coherence's own check: no bypass among resolved
 * references), convention (a naming or export-list convention alone, enforced
 * by nobody). Below them: broken, and not chokeable.
 */
export type Grade = "closure-choked" | "visibility-choked" | "checker-choked" | "reference-choked" | "convention" | "broken" | "not chokeable";
/**
 * How the refutation was witnessed. `automatic`: the check's own
 * classification called every synthetic site the adapter staged a bypass.
 * `refused by the language`: the rung's enforcer is the compiler or the
 * interpreter, and it refused the synthetic outside reference; the diagnostic
 * is the proof and Coherence's own check never has to be made to fire
 * (ruling rs-e93ecdd6). `refused by the checker`: the rung's enforcer is a
 * checker that draws a module boundary (tach), and it refused a synthetic
 * outside import staged in a throwaway copy of the project; its error is the
 * proof, since the module's own code is free to use the thing and a staged
 * site there would prove nothing. `witnessed`: a refutation record for a bullet's
 * totality oracle, with a later run that found the same enforcement
 * passing. `missing`: none of these.
 */
export type RefutationState = "automatic" | "refused by the language" | "refused by the checker" | "witnessed" | "missing";

export interface Bypass {
  file: string;
  line: number;
  /** The referencing symbol, or "module top level". */
  symbol: string;
  /** The checker that refuses this import, with its error, when one does (tach). */
  checker?: string;
}

/** What a persisted reference site points at. */
export type ReferenceTarget = "protected" | "chokepoint";

/**
 * The check's classification of a persisted site. `chokepoint-reference` makes only the
 * fact the adapter established: an outside reference to the chokepoint. It
 * does not claim the site is a runtime call; `form` separately retains an
 * import or re-export form when the adapter supplied one. `exempt` is a
 * protected reference from where the bullet's from: line says the chokepoint
 * does not govern (the component's own code, or a named folder): reported,
 * never a bypass, and never dropped.
 */
export type SiteClass = "inside" | "chokepoint-reference" | "test" | "exempt" | "bypass";

/**
 * Which references a chokepoint check governed: the from: value as written,
 * who said it (the bullet's own from: line, the config's chokepointFrom, or
 * the default, anywhere), and the folder whose references it exempted.
 */
export interface Governed {
  value: string;
  by: "bullet" | "config" | "default";
  /** The project-relative folder whose references the chokepoint does not govern; absent for anywhere. */
  exempt?: string;
}

/** The syntactic forms the adapter can establish at a reference site. */
export type ReferenceForm = "import" | "re-export";

/** The durable, editor-facing part of one classified reference. */
export interface RecordedSite {
  file: string;
  line: number;
  /** The referencing symbol, or "module top level". */
  symbol: string;
  class: SiteClass;
  of: ReferenceTarget;
  /** Orthogonal to class: whether this site is under a configured test path. */
  test: boolean;
  /** Orthogonal syntax evidence, when the adapter can establish it. */
  form?: ReferenceForm;
}

export interface RunEntry {
  component: string;
  name: string;
  form: Form;
  verdict: Verdict;
  /** Chokepoint form only. */
  grade?: Grade;
  /** Chokepoint form only: who refuses a bypass at the graded rung (the compiler, the interpreter, a checker, Coherence's check, nobody). */
  enforcer?: string;
  /** Chokepoint form only: which references the check governed. Absent on a record from before from: lines, which governed anywhere. */
  from?: Governed;
  /** Totality oracle form only: whether the test ran in the one batched invocation or in its own. */
  mode?: "batched" | "one-at-a-time";
  refutation: RefutationState;
  bypasses: Bypass[];
  /**
   * Chokepoint form only. Present only when both reference queries completed.
   * Absence is unavailable or legacy evidence, never a confirmed empty set.
   */
  sites?: RecordedSite[];
  /**
   * Chokepoint form only, as written: in `sites`' place when they are exactly
   * the enforcement's previous recorded sites, the hash of their content and
   * the run that holds them in full. loadRuns resolves it back into `sites`,
   * so no reader ever sees it.
   */
  sitesRef?: SitesRef;
  /**
   * Set by loadRuns, in `sites`' place, when a sitesRef names sites no
   * record holds: why. The sites are unknown, never an empty list.
   */
  sitesUnresolved?: string;
  testReferences: number;
  /** Files the check touched: definitions and every reference site; the edit hook reads them. */
  files: string[];
  /** Milliseconds this entry took. */
  latency: number;
  /** Totality oracle form only: milliseconds its tests ran, as the runner measured them, apart from the invocation around them. */
  testMs?: number;
  /** One line: why the verdict is what it is. */
  reason: string;
  /**
   * A multi-language project only: the language whose server graded a chokepoint, or whose test setup ran a
   * totality oracle's test. Absent in a single-language project, where the record's instrument says it.
   */
  language?: string;
  /**
   * The bullet's lifecycle state as this run left it, with this entry's verdict and refutation read in. The
   * invariant floor (src/spec/floor.ts) reads it: a bullet graded an invariant is not demoted silently. Absent
   * on a record from before it was kept.
   */
  state?: "requirement" | "invariant" | "structural defect";
  /** What this form of the bullet enforces through: its via: test titles, or its chokepoints. The floor recognizes a rename by it. */
  enforces?: string[];
  /** Set on an edit's check, which derives no state (run.ts, grade: false): the invariant floor does not count the entry. */
  ungraded?: true;
}

export interface RunRecord {
  at: string;
  session: string;
  agent: string;
  /** The work order the run binds to, when the session owns exactly one active order or named one. */
  work?: string;
  /** How the work order was bound: by flag, inferred, or why none. */
  binding?: string;
  commit: string | null;
  dirty: boolean;
  /** Which instrument answered and whether it was already warm. */
  instrument: {
    /** The language whose server answered; several joined with `+` when a multi-language run asked more than one. */
    language: string;
    server: "cold" | "warm" | "none";
    /** When more than one language's server answered: each, with how it was reached. */
    languages?: { language: string; server: "cold" | "warm" | "none" }[];
  };
  latency: number;
  /** The machine's one-minute load average and core count as the run started, so a slower test on a busy machine is read against its load. */
  load?: { average: number; cores: number };
  /** The one batched test invocation's milliseconds. */
  batch?: { ms: number };
  /**
   * True when the run checked the whole spec: no --invariant and no --form
   * filter, from the project's own spec model; what moves the invariant
   * floor for every bullet at once. Absent on a scoped run, an edit's check,
   * a per-test confirmation, and a run recorded before this was written.
   */
  full?: true;
  invariants: RunEntry[];
}

/**
 * One refutation: the detector was made to go red on purpose, and this is what
 * was broken and what it said. Appended by `refute` while the break is staged,
 * never by a run.
 */
export interface RefutationRecord {
  kind: "refutation";
  at: string;
  session: string;
  agent: string;
  /** The bullet: the component's folder and the invariant's name. */
  component: string;
  name: string;
  form: Form;
  /** What the agent changed to break the invariant, in its own words. */
  broke: string;
  /** The verdict the enforcement gave with the break staged. A refutation is only ever recorded on a fail. */
  verdict: "fail";
  /** The detector's own line: why it went red. */
  reason: string;
  commit: string | null;
  dirty: boolean;
}

export interface Latest extends RunEntry {
  at: string;
  commit: string | null;
  session: string;
}

export function runsDir(root: string): string {
  return join(root, RUNS_DIR);
}

/** The machine's one-minute load average and core count, now. */
export function machineLoad(): { average: number; cores: number } {
  return { average: Math.round(loadavg()[0]! * 100) / 100, cores: availableParallelism() };
}

const SESSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A run entry's sites, written once per run file: their content's hash and the run, in the same file, whose line holds them in full. */
export interface SitesRef {
  hash: string;
  at: string;
}

/** The hash a sites list is known by: of its exact JSON, so a resolved list is the list written. */
export function sitesHash(sites: readonly RecordedSite[]): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(sites)).digest("hex");
}

/** An entry with one key replaced in its place, so a written and a resolved entry spell their keys in the same order. */
function replacing(entry: RunEntry, key: "sites" | "sitesRef", next: Partial<Record<"sites" | "sitesRef" | "sitesUnresolved", unknown>>): RunEntry {
  return Object.fromEntries(Object.entries(entry).flatMap(([k, v]) => (k === key ? Object.entries(next) : [[k, v]]))) as unknown as RunEntry;
}

/**
 * The record as it is written to run file `name`: each chokepoint entry
 * whose sites are exactly the ones its enforcement's last entry in that same
 * file wrote in full carries a reference in their place (the sites are most
 * of a run's bytes, and they rarely change); sites that changed, and an
 * enforcement's first entry in the file, are written in full. A reference
 * never leaves its file: every run file, alone, resolves, whatever other
 * files are committed, and a reader that does not know references loses only
 * later entries' sites, never a file's first.
 *
 * What the file last wrote in full is asked of its sites shard in the run
 * index (run-index.ts), one stat and one small read, never of the file
 * itself, which grows with its session. When the shard cannot say (none, or
 * kept for the file as it no longer is), every entry is written in full:
 * larger, never wrong, and the shard starts again from that line.
 */
export function compactRecord(root: string, name: string, record: RunRecord): RunRecord {
  if (!record.invariants.some((e) => e.sites !== undefined)) return record;
  const latest = heldSites(root, name);
  if (latest === undefined) return record;
  const invariants = record.invariants.map((entry) => {
    if (entry.sites === undefined) return entry;
    const before = latest.get(entryKey(entry.component, entry.name, entry.form));
    const hash = sitesHash(entry.sites);
    if (before === undefined || before.hash !== hash) return entry;
    return replacing(entry, "sites", { sitesRef: { hash, at: before.at } satisfies SitesRef });
  });
  return { ...record, invariants };
}

/** What a written run tells its file's sites shard: each enforcement's sites written in full, or null where its entry carried neither sites nor a reference. */
function sitesUpdates(record: RunRecord): Map<string, HeldSites | null> {
  const updates = new Map<string, HeldSites | null>();
  for (const entry of record.invariants) {
    const key = entryKey(entry.component, entry.name, entry.form);
    if (entry.sites !== undefined) updates.set(key, { hash: sitesHash(entry.sites), at: record.at });
    else if (entry.sitesRef === undefined) updates.set(key, null);
  }
  return updates;
}

/**
 * Append one line to a run file, then fold it into the run index the edit
 * hook reads and into the file's sites shard (run-index.ts). Each fold is
 * best effort and never throws: the line is recorded once it is appended,
 * and an index or shard the fold could not bring up to date no longer
 * matches the file, so its next reader rebuilds the index, and the next
 * append writes its sites in full.
 */
function appendLine(root: string, file: string, line: string, updates: ReadonlyMap<string, HeldSites | null>): void {
  const name = basename(file);
  const before = runFileIdentity(root, name);
  const offset = existsSync(file) ? statSync(file).size : 0;
  appendWhole(file, line);
  noteRunAppend(root, name, before, offset, parseLine);
  noteSitesAppend(root, name, before, updates);
}

/** Append one run as one line; the file and folder are created on first write. Sites its enforcement already wrote in full in this file are written as a reference. */
export function appendRun(root: string, record: RunRecord): string {
  if (!SESSION_TOKEN.test(record.session)) throw new Error(`session "${record.session}" cannot name a file; use letters, digits, dot, dash, or underscore`);
  mkdirSync(runsDir(root), { recursive: true });
  const shard = shardFor(root, "runs", record.session);
  const written = compactRecord(root, shard.name, record);
  appendLine(root, shard.file, `${JSON.stringify(written)}\n`, sitesUpdates(written));
  shard.kept();
  return shard.file;
}

/** Append one refutation as one line, beside the runs of the same session. */
export function appendRefutation(root: string, record: RefutationRecord): string {
  if (!SESSION_TOKEN.test(record.session)) throw new Error(`session "${record.session}" cannot name a file; use letters, digits, dot, dash, or underscore`);
  mkdirSync(runsDir(root), { recursive: true });
  const shard = shardFor(root, "runs", record.session);
  appendLine(root, shard.file, `${JSON.stringify(record)}\n`, new Map());
  shard.kept();
  return shard.file;
}

export interface LoadedRuns {
  records: RunRecord[];
  /** The refutation records in the same files, oldest first. */
  refutations: RefutationRecord[];
  damaged: { file: string; line: number; reason: string }[];
}

export function loadRuns(root: string): LoadedRuns {
  const dir = runsDir(root);
  const loaded: LoadedRuns = { records: [], refutations: [], damaged: [] };
  if (!existsSync(dir)) return loaded;
  const where = new Map<RunRecord, { file: string; line: number }>();
  const seen = new Set<string>();
  for (const name of readdirSync(dir).filter(isStoreFile).sort()) {
    for (const { line, number } of storeLines(readFileSync(join(dir, name), "utf8"), seen)) {
      const parsed = parseLine(line);
      if (typeof parsed === "string") loaded.damaged.push({ file: join(RUNS_DIR, name), line: number, reason: parsed });
      else if ("kind" in parsed) loaded.refutations.push(parsed);
      else {
        loaded.records.push(parsed);
        where.set(parsed, { file: join(RUNS_DIR, name), line: number });
      }
    }
  }
  loaded.records.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  loaded.refutations.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  resolveSites(loaded, where);
  return loaded;
}

/**
 * Every sites reference resolved in place into the sites it names, from an
 * entry of the same enforcement in the same run file, the run it names first,
 * whose sites hash to it. One its file does not hold is said: the entry
 * carries why in `sitesUnresolved`, and the line is reported damaged.
 */
function resolveSites(loaded: LoadedRuns, where: ReadonlyMap<RunRecord, { file: string; line: number }>): void {
  if (!loaded.records.some((run) => run.invariants.some((e) => e.sitesRef !== undefined))) return;
  // Only an entry in the same run file can hold the sites a reference names: a file resolves alone.
  const full = new Map<string, { at: string; entry: RunEntry }[]>();
  for (const run of loaded.records)
    for (const entry of run.invariants) {
      if (entry.sites === undefined) continue;
      const key = `${where.get(run)?.file ?? ""}\0${entryKey(entry.component, entry.name, entry.form)}`;
      const list = full.get(key) ?? [];
      list.push({ at: run.at, entry });
      full.set(key, list);
    }
  const hashes = new WeakMap<RunEntry, string>();
  const hashOf = (entry: RunEntry): string => {
    const known = hashes.get(entry);
    if (known !== undefined) return known;
    const made = sitesHash(entry.sites!);
    hashes.set(entry, made);
    return made;
  };
  for (const run of loaded.records) {
    run.invariants = run.invariants.map((entry) => {
      const ref = entry.sitesRef;
      if (ref === undefined) return entry;
      const candidates = full.get(`${where.get(run)?.file ?? ""}\0${entryKey(entry.component, entry.name, entry.form)}`) ?? [];
      const held = candidates.find((c) => c.at === ref.at && hashOf(c.entry) === ref.hash) ?? candidates.find((c) => hashOf(c.entry) === ref.hash);
      if (held === undefined) {
        const reason = `the sites this entry refers to (${ref.hash.slice(0, 15)}, written in full by the run of ${ref.at}) are in no record of its run file`;
        const at = where.get(run);
        loaded.damaged.push({ file: at?.file ?? RUNS_DIR, line: at?.line ?? 0, reason: `${entry.component}/${entry.name}: ${reason}` });
        return replacing(entry, "sitesRef", { sitesUnresolved: reason });
      }
      return replacing(entry, "sitesRef", { sites: held.entry.sites });
    });
  }
}

/** One run-file line: a run, a refutation, or why it is neither. */
export function parseLine(line: string): RunRecord | RefutationRecord | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return `not JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not a run object";
  const record = value as Record<string, unknown>;
  for (const field of ["at", "session", "agent"]) if (typeof record[field] !== "string") return `missing ${field}`;
  if (Number.isNaN(Date.parse(record["at"] as string))) return `unreadable time "${String(record["at"])}"`;
  if (record["kind"] === "refutation") {
    for (const field of ["component", "name", "form", "broke", "reason"]) if (typeof record[field] !== "string") return `refutation missing ${field}`;
    if (record["verdict"] !== "fail") return "a refutation is only ever recorded on a failing verdict";
    return value as RefutationRecord;
  }
  if (record["kind"] !== undefined) return `unknown record kind "${String(record["kind"])}"`;
  if (!Array.isArray(record["invariants"])) return "missing invariants";
  return value as RunRecord;
}

/**
 * The enforcements whose refutation is witnessed by the record: a refutation
 * exists for the bullet and some run at or after it found the same enforcement
 * passing. The record alone says the detector went red; the later pass says the
 * code was restored, and together they are the firing the lexicon names.
 */
export function witnessedRefutations(runs: readonly RunRecord[], refutations: readonly RefutationRecord[]): Set<string> {
  const witnessed = new Set<string>();
  for (const refutation of refutations) {
    const key = entryKey(refutation.component, refutation.name, refutation.form);
    if (witnessed.has(key)) continue;
    const restored = runs.some(
      (run) =>
        run.at >= refutation.at &&
        run.invariants.some((e) => e.component === refutation.component && e.name === refutation.name && e.form === refutation.form && e.verdict === "pass"),
    );
    if (restored) witnessed.add(key);
  }
  return witnessed;
}

export function entryKey(component: string, name: string, form: Form): string {
  return `${component} ${name} ${form}`;
}

/** The latest entry per enforcement across every run, keyed by component, name, and form. */
export function latestByEnforcement(runs: readonly RunRecord[]): Map<string, Latest> {
  const latest = new Map<string, Latest>();
  for (const run of runs) {
    for (const entry of run.invariants) {
      latest.set(entryKey(entry.component, entry.name, entry.form), { ...entry, at: run.at, commit: run.commit, session: run.session });
    }
  }
  return latest;
}

/** The latest entries for one invariant: its chokepoint pass and its totality oracle pass, either absent. */
export interface LatestFor {
  chokepoint: Latest | undefined;
  totality: Latest | undefined;
}

export function latestFor(latest: ReadonlyMap<string, Latest>, component: string, name: string): LatestFor {
  return {
    chokepoint: latest.get(entryKey(component, name, "chokepoint")),
    totality: latest.get(entryKey(component, name, "totality oracle")),
  };
}
