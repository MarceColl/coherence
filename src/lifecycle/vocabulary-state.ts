/**
 * The vocabulary kept between readings, so an edit pays for the files it
 * names and never for the corpus.
 *
 * A full coverage reading (a session's start, a prompt over a moved tree, a
 * stop) keeps each file's contribution (lexicon-coverage.ts: the names it
 * nominates and where, the declared names it writes as words, the known
 * names it uses) and the totals they add up to, under
 * .coherence/cache/vocabulary, in a fixed number of buckets by file and by
 * term. An edit reads the files it wrote, and only those, scans them as the
 * reading would, and compares each with its kept contribution: a name whose
 * totals cross the threshold a candidate needs with this edit is named, and
 * a known name newly written where its sense is at risk is named. Then the
 * kept contributions and totals take the edit in, under a lock, once what
 * the edit named reached the host.
 *
 * What an edit reads is bounded: the files it wrote, one bucket per file,
 * and at most every term bucket, a fixed number. What it judges is the
 * totals as the last full reading left them plus every edit since; a file
 * changed without a hook seeing it counts as it was until the next full
 * reading, and so does a name whose recurrence rests on code the edit
 * newly declared and prose it never touched. A line that names both a term
 * and its plural counts twice here and once in a full reading. The kept
 * state is keyed by Coherence's code identity and by the lexicons and the
 * config's names: any change to either, and the edit takes a full reading,
 * which keeps the state again.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "./work-meter.ts";
import { basename, join } from "node:path";
import { cacheDir, storeVersion, withLock, writeKept } from "./kept-parse.ts";
import { digest, lexiconReading, singularForms, type Contribution, type Coverage } from "./lexicon-coverage.ts";
import type { Lexicon } from "./lexicon.ts";
import { vocabularyFacts } from "./project.ts";
import { journalFileKeys } from "../journal/store.ts";
import { isStoreFile, storeDir } from "../journal/stores.ts";

const SHAPE = "vocabulary-1";
/** Buckets per kind: an edit reads at most this many term buckets, whatever the project's size. */
export const BUCKETS = 64;

interface PoolTotal {
  named: number;
  sites: Record<string, number>;
  code: Record<string, number>;
  declared: number;
  declaredIn: Record<string, number>;
}

interface WordTotal {
  words: number;
  byComponent: Record<string, number>;
}

interface TermBucket {
  pool: Record<string, PoolTotal>;
  words: Record<string, WordTotal>;
}

type FileBucket = Record<string, Contribution>;

function stateDir(root: string): string {
  return join(cacheDir(root), "vocabulary");
}

function bucketOf(name: string): string {
  return String(createHash("sha1").update(name).digest().readUInt32BE(0) % BUCKETS).padStart(2, "0");
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** What the kept state is valid for: the code that made it, the lexicons and the config's names. */
async function stateVersion(root: string, layers: { coherence: Lexicon; project: Lexicon | undefined }): Promise<string> {
  const facts = await vocabularyFacts(root);
  const lexicons = createHash("sha256").update(JSON.stringify([layers.coherence, layers.project ?? null, facts])).digest("hex").slice(0, 16);
  return `${storeVersion(root, SHAPE, ["lifecycle/lexicon-coverage.ts", "lifecycle/vocabulary-state.ts"])}:${lexicons}`;
}

function bump(record: Record<string, number>, key: string, by: number): void {
  const next = (record[key] ?? 0) + by;
  if (next === 0) delete record[key];
  else record[key] = next;
}

/** Add (`sign` 1) or take away (-1) one contribution's part of the totals, for the terms `only` names, or all. */
function apply(buckets: Map<string, TermBucket>, c: Contribution, sign: 1 | -1, only?: ReadonlySet<string>): void {
  const bucket = (term: string): TermBucket => {
    const id = bucketOf(term);
    const found = buckets.get(id);
    if (found !== undefined) return found;
    const made: TermBucket = { pool: {}, words: {} };
    buckets.set(id, made);
    return made;
  };
  for (const [term, stats] of Object.entries(c.pool)) {
    if (only !== undefined && !only.has(term)) continue;
    const b = bucket(term);
    const total = (b.pool[term] ??= { named: 0, sites: {}, code: {}, declared: 0, declaredIn: {} });
    total.named += sign * stats.named;
    bump(total.sites, c.component, sign * stats.sites);
    bump(total.code, c.component, sign * stats.code);
    if (stats.declared) {
      total.declared += sign;
      bump(total.declaredIn, c.component, sign);
    }
    if (Object.keys(total.sites).length === 0 && total.named === 0) delete b.pool[term];
  }
  for (const [term, n] of Object.entries(c.words)) {
    if (only !== undefined && !only.has(term)) continue;
    const b = bucket(term);
    const total = (b.words[term] ??= { words: 0, byComponent: {} });
    total.words += sign * n;
    bump(total.byComponent, c.component, sign * n);
    if (total.words === 0) delete b.words[term];
  }
}

/** The canonical name each term is counted under: its singular when the pool holds that, as the reading merges plurals. */
function canonicalOf(term: string, has: (t: string) => boolean): string {
  const words = term.split(" ");
  return singularForms(words.at(-1)!).map((s) => [...words.slice(0, -1), s].join(" ")).find(has) ?? term;
}

/** The plural spellings that would be counted under `term`. */
function pluralsOf(term: string): string[] {
  const words = term.split(" ");
  const last = words.at(-1)!;
  const forms = [last + "s", last + "es", ...(last.endsWith("y") ? [last.slice(0, -1) + "ies"] : [])];
  return forms.filter((f) => singularForms(f).includes(last)).map((f) => [...words.slice(0, -1), f].join(" "));
}

/**
 * Keep the state a full reading's contributions make: written whole, aside,
 * and swapped into place under the lock.
 */
export async function keepVocabulary(root: string, layers: { coherence: Lexicon; project: Lexicon | undefined }, contributions: ReadonlyMap<string, Contribution>, tree: Record<string, string> | undefined, coverage: Coverage, records: Record<string, string> | undefined): Promise<void> {
  // A tree git cannot describe keeps no state: every edit then reads in full.
  if (tree === undefined) return;
  const version = await stateVersion(root, layers);
  const files = new Map<string, FileBucket>();
  const terms = new Map<string, TermBucket>();
  for (const [file, c] of contributions) {
    const id = bucketOf(file);
    const b = files.get(id) ?? {};
    b[file] = c;
    files.set(id, b);
    apply(terms, c, 1);
  }
  const present = (t: string): boolean => terms.get(bucketOf(t))?.pool[t] !== undefined;
  const declared = new Set<string>();
  for (const b of terms.values()) for (const [term, total] of Object.entries(b.pool)) if (total.declared > 0) declared.add(canonicalOf(term, present));
  withLock(join(cacheDir(root), "vocabulary.lock"), () => {
    const aside = `${stateDir(root)}.${process.pid}.tmp`;
    // An aside a process died before renaming is removed by the next whole write.
    for (const name of readdirSync(cacheDir(root))) if (/^vocabulary\.\d+\.tmp$/.test(name)) rmSync(join(cacheDir(root), name), { recursive: true, force: true });
    try {
      // Every part is written before the whole is swapped in, and a part that cannot be written keeps the aside from ever being used.
      for (const [id, b] of files) writeKept(join(aside, "files", `${id}.json`), b, false, true);
      for (const [id, b] of terms) writeKept(join(aside, "terms", `${id}.json`), b, false, true);
      writeKept(join(aside, "declared.json"), [...declared].sort(), false, true);
      if (records !== undefined) writeKept(join(aside, "reading.json"), { version, tree, records, coverage, digest: digest(coverage) }, false, true);
      writeKept(join(aside, "meta.json"), { version, buckets: { files: [...files.keys()].sort(), terms: [...terms.keys()].sort() }, tree } satisfies Meta, false, true);
      rmSync(stateDir(root), { recursive: true, force: true });
      renameSync(aside, stateDir(root));
    } catch {
      // No state kept: the next edit finds none and takes the full reading, which tries again.
      rmSync(aside, { recursive: true, force: true });
    }
  });
}

/**
 * What an edit introduced, and the kept state taking it in: the caller
 * keeps it once the line reached the host, or at once when there is
 * nothing to say, so a line that never reached the agent is said again.
 */
export interface EditVocabulary {
  changes: EditChange[];
  keep: () => void;
}

/** What an edit's vocabulary line names, in coverageChanges' shape. */
export interface EditChange {
  term: string;
  component: string;
  evidence: string;
  state: string;
  reason: string;
}

/** A part of the kept state that cannot be trusted: the edit reads in full instead, says so, and writes nothing back. */
class BucketUnusable extends Error {}

interface Meta {
  version: string;
  writing?: boolean;
  /** The buckets the state holds, by kind: one listed and missing or torn is a broken state, never an empty bucket. */
  buckets: { files: string[]; terms: string[] };
  /** The tree as the state last took it in: each file git lists as changed or untracked, with its size, modification and change time. */
  tree: Record<string, string>;
}

/** The key the tree's HEAD is kept under: no path git lists can be spelled so. */
export const HEAD_KEY = "\u0000HEAD";
const SPARSE_KEY = "\u0000SPARSE";

/**
 * The commit HEAD names, through the git door: one rev-parse. "unborn" for a
 * repository with no commit yet; undefined when git cannot answer.
 */
export function headCommit(root: string): string | undefined {
  const head = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root, encoding: "utf8" });
  if (head.status === 0) return head.stdout.trim();
  // --verify -q exits 1 and prints nothing when HEAD names no commit; anything else is git failing.
  return head.status === 1 && head.stdout.trim() === "" && head.stderr.trim() === "" ? "unborn" : undefined;
}

/**
 * The tree's key: the commit HEAD names, and every file git lists as changed
 * against HEAD or untracked, outside .coherence, with its size, modification
 * and change time; a rev-parse, two git listings and a stat each, never a
 * read. Undefined when git cannot answer. HEAD is in it because a checkout,
 * a pull or a branch switch onto a clean tree changes files the two listings
 * never name: they list what differs from HEAD, and HEAD moved with them.
 * The index's own stat is left out: git rewrites it whenever it refreshes,
 * which changes no file's text.
 * A write no hook saw (a code generator, a checkout, a shell command the
 * shell reader did not parse) moves it, and the next edit reads in full.
 * Coherence's own records under .coherence are left out: the commands that
 * write them run at every turn, and a full reading at the next prompt or stop
 * reads them.
 */
export function treeKeys(root: string): Record<string, string> | undefined {
  const head = headCommit(root);
  if (head === undefined) return undefined;
  const files = new Set<string>();
  for (const args of [["diff", "--name-only", "--relative", "-z", "HEAD"], ["ls-files", "--others", "--exclude-standard", "-z"]]) {
    const listed = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (listed.status !== 0) return undefined;
    for (const f of listed.stdout.split("\0")) if (f !== "" && !f.startsWith(".coherence/")) files.add(f);
  }
  const out: Record<string, string> = { [HEAD_KEY]: head };
  const sparse = spawnSync("git", ["config", "--bool", "core.sparseCheckout"], { cwd: root, encoding: "utf8" });
  if (sparse.status !== 0 && sparse.status !== 1) return undefined;
  if (sparse.stdout.trim() === "true") {
    const listed = spawnSync("git", ["ls-files", "--cached", "-t", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (listed.status !== 0) return undefined;
    const skipped = listed.stdout.split("\0").filter((line) => line.startsWith("S ")).map((line) => line.slice(2));
    out[SPARSE_KEY] = createHash("sha256").update(JSON.stringify(skipped)).digest("hex");
  }
  for (const f of [...files].sort()) {
    try {
      const st = statSync(join(root, f));
      out[f] = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      out[f] = "gone";
    }
  }
  return out;
}

/** The files whose key differs between two trees, other than `except`. */
function movedBeyond(then: Record<string, string>, now: Record<string, string>, except: readonly string[]): string[] {
  const skip = new Set(except);
  return [...new Set([...Object.keys(then), ...Object.keys(now)])].filter((f) => !skip.has(f) && then[f] !== now[f]).sort();
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCounts = (value: unknown): boolean => isRecord(value) && Object.values(value).every((n) => typeof n === "number");

function validTermBucket(value: unknown): value is TermBucket {
  if (!isRecord(value) || !isRecord(value["pool"]) || !isRecord(value["words"])) return false;
  const poolOk = Object.values(value["pool"]).every((t) => isRecord(t) && typeof t["named"] === "number" && typeof t["declared"] === "number" && isCounts(t["sites"]) && isCounts(t["code"]) && isCounts(t["declaredIn"]));
  const wordsOk = Object.values(value["words"]).every((t) => isRecord(t) && typeof t["words"] === "number" && isCounts(t["byComponent"]));
  return poolOk && wordsOk;
}

function validFileBucket(value: unknown): value is FileBucket {
  return isRecord(value) && Object.values(value).every((c) => isRecord(c) && typeof c["component"] === "string" && isRecord(c["pool"]) && isCounts(c["words"]) && Array.isArray(c["uses"]));
}

/** One bucket: validated when it is there; one the state lists and is not there, or is torn, throws; one never written is empty. */
function readBucket<T>(path: string, listed: boolean, valid: (value: unknown) => value is T, empty: () => T): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    if (listed) throw new BucketUnusable(`a kept bucket the state lists is missing (${basename(path)})`);
    return empty();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BucketUnusable(`a kept bucket is torn (${basename(path)})`);
  }
  if (!valid(value)) throw new BucketUnusable(`a kept bucket is not in the shape it is kept in (${basename(path)})`);
  return value;
}

function termBuckets(root: string, ids: Iterable<string>, meta: Meta): Map<string, TermBucket> {
  const out = new Map<string, TermBucket>();
  for (const id of new Set(ids)) out.set(id, readBucket(join(stateDir(root), "terms", `${id}.json`), meta.buckets.terms.includes(id), validTermBucket, () => ({ pool: {}, words: {} })));
  return out;
}

function fileBuckets(root: string, files: readonly string[], meta: Meta): Map<string, FileBucket> {
  const out = new Map<string, FileBucket>();
  for (const id of new Set(files.map(bucketOf))) out.set(id, readBucket(join(stateDir(root), "files", `${id}.json`), meta.buckets.files.includes(id), validFileBucket, () => ({})));
  return out;
}

/** The kept state's meta, validated; undefined when there is none. */
function readMeta(root: string): Meta | undefined {
  let text: string;
  try {
    text = readFileSync(join(stateDir(root), "meta.json"), "utf8");
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BucketUnusable("its kept state's meta is torn");
  }
  const buckets = isRecord(value) ? value["buckets"] : undefined;
  if (!isRecord(value) || typeof value["version"] !== "string" || !isRecord(buckets) || !Array.isArray(buckets["files"]) || !Array.isArray(buckets["terms"]) || !isRecord(value["tree"])) throw new BucketUnusable("its kept state's meta is not in the shape it is kept in");
  return value as unknown as Meta;
}

function recordKeys(root: string): Record<string, string> | undefined {
  try {
    const out = Object.fromEntries([...journalFileKeys(root)].map(([name, key]) => [`journal/${name}`, key]));
    const dir = join(root, storeDir("work"));
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      names = [];
    }
    for (const name of names.filter(isStoreFile).sort()) {
      const stat = statSync(join(dir, name));
      out[`work/${name}`] = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }
    return out;
  } catch {
    return undefined;
  }
}

export async function currentReading(root: string, layers: { coherence: Lexicon; project: Lexicon | undefined }): Promise<Coverage> {
  const version = await stateVersion(root, layers);
  const tree = treeKeys(root);
  const records = recordKeys(root);
  if (tree !== undefined && records !== undefined) {
    let meta: Meta | undefined;
    try {
      meta = readMeta(root);
    } catch (error) {
      if (!(error instanceof BucketUnusable)) throw error;
    }
    if (meta !== undefined && meta.writing !== true && meta.version === version) {
      const saved = readJson<unknown>(join(stateDir(root), "reading.json"));
      if (isRecord(saved) && saved["version"] === meta.version && JSON.stringify(saved["tree"]) === JSON.stringify(tree) && JSON.stringify(saved["records"]) === JSON.stringify(records)) {
        const coverage = saved["coverage"];
        if (isRecord(coverage) && coverage["version"] === 1 && typeof saved["digest"] === "string" && saved["digest"] === digest(coverage)) return coverage as unknown as Coverage;
      }
    }
  }
  return keptReading(root, layers);
}

/** Whether the group counted under `canonical` is a candidate by these totals: the reading's rule, by name or by word. */
function candidacy(canonical: string, terms: Map<string, TermBucket>): { candidate: boolean; prose: number; components: number } {
  const total = (t: string): PoolTotal | undefined => terms.get(bucketOf(t))?.pool[t];
  const members = [canonical, ...pluralsOf(canonical)].map(total).filter((t): t is PoolTotal => t !== undefined);
  if (members.length === 0) return { candidate: false, prose: 0, components: 0 };
  const named = members.reduce((n, m) => n + m.named, 0);
  const sites = new Set(members.flatMap((m) => Object.keys(m.sites)));
  const code = new Set(members.flatMap((m) => Object.keys(m.code)));
  const declared = members.some((m) => m.declared > 0);
  const words = terms.get(bucketOf(canonical))?.words[canonical];
  const wordComponents = new Set([...Object.keys(words?.byComponent ?? {}), ...code]);
  const byName = named >= 3 || (named >= 2 && sites.size >= 2);
  const byWord = declared && (words?.words ?? 0) >= 10 && wordComponents.size >= 4;
  return { candidate: byName || byWord, prose: named + (words?.words ?? 0), components: new Set([...sites, ...Object.keys(words?.byComponent ?? {})]).size };
}

/**
 * The vocabulary changes an edit to `written` introduced, judged against the
 * kept state, and the kept state taking the edit in; undefined when no kept
 * state is valid for this code, lexicon and config, and the caller takes a
 * full reading instead. `candidates` names the terms the baseline already
 * holds as candidates, never named again.
 */
export async function editVocabulary(root: string, layers: { coherence: Lexicon; project: Lexicon | undefined }, written: readonly string[], candidates: ReadonlySet<string>): Promise<EditVocabulary | { unavailable: string | undefined }> {
  try {
    return await judgeEdit(root, layers, written, candidates);
  } catch (error) {
    // Any part of the state that cannot be trusted: the edit reads in full and says why, and nothing derived from the part is written back.
    if (error instanceof BucketUnusable) return { unavailable: error.message };
    throw error;
  }
}

async function judgeEdit(root: string, layers: { coherence: Lexicon; project: Lexicon | undefined }, written: readonly string[], candidates: ReadonlySet<string>): Promise<EditVocabulary | { unavailable: string | undefined }> {
  const meta = readMeta(root);
  // None kept yet, or kept by other code or lexicons: the full reading is the ordinary way, and keeps the state again.
  if (meta === undefined || meta.version !== (await stateVersion(root, layers))) return { unavailable: undefined };
  if (meta.writing === true) return { unavailable: "its kept vocabulary was left half-written by an edit that stopped while writing it" };
  // A write no hook saw since the state was kept (a generator, a checkout, an unparsed shell command): the totals would be stale.
  const tree = treeKeys(root);
  if (tree === undefined) return { unavailable: "git could not list the tree's changes, so writes no hook saw cannot be ruled out" };
  const unseen = movedBeyond(meta.tree, tree, written);
  if (unseen.length > 0) return { unavailable: `the tree moved since its vocabulary was kept, beyond what this edit wrote (${unseen.slice(0, 3).map((f) => (f === HEAD_KEY ? "HEAD names another commit" : f)).join(", ")}${unseen.length > 3 ? `, and ${unseen.length - 3} more` : ""})` };
  const declaredRaw = readJson<unknown>(join(stateDir(root), "declared.json"));
  if (!Array.isArray(declaredRaw) || !declaredRaw.every((d) => typeof d === "string")) throw new BucketUnusable("its kept declared names are missing or torn");
  const declared = new Set(declaredRaw as string[]);
  const reading = await lexiconReading(root, layers, undefined, { files: written, declared, rulings: false, contributions: true });
  const fresh = new Map([...reading.contributions].filter(([file]) => written.includes(file)));
  if (fresh.size === 0) return { changes: [], keep: () => {} };
  const files = fileBuckets(root, [...fresh.keys()], meta);
  const old = new Map([...fresh.keys()].map((file) => [file, files.get(bucketOf(file))?.[file]]));
  // The terms whose totals this edit can move, their singulars and plurals: what its candidacy is judged on.
  const moved = new Set<string>();
  for (const c of [...fresh.values(), ...old.values()]) {
    if (c === undefined) continue;
    for (const term of [...Object.keys(c.pool), ...Object.keys(c.words), ...c.uses.map((u) => u.split("\t")[0]!)]) moved.add(term);
  }
  const related = new Set<string>();
  for (const term of moved) {
    related.add(term);
    const words = term.split(" ");
    for (const s of singularForms(words.at(-1)!)) related.add([...words.slice(0, -1), s].join(" "));
    for (const p of pluralsOf(term)) related.add(p);
  }
  const before = termBuckets(root, [...related].map(bucketOf), meta);
  const after = new Map([...before].map(([id, b]) => [id, JSON.parse(JSON.stringify(b)) as TermBucket]));
  for (const [file, c] of fresh) {
    const was = old.get(file);
    if (was !== undefined) apply(after, was, -1);
    apply(after, c, 1);
  }
  const has = (terms: Map<string, TermBucket>) => (t: string): boolean => terms.get(bucketOf(t))?.pool[t] !== undefined;
  const changes: EditChange[] = [];
  const named = new Set<string>();
  for (const term of moved) {
    const canonical = canonicalOf(term, has(after));
    if (named.has(canonical) || candidates.has(canonical)) continue;
    const then = candidacy(canonicalOf(term, has(before)), before);
    const now = candidacy(canonical, after);
    if (!now.candidate || then.candidate) continue;
    named.add(canonical);
    const file = [...fresh.keys()].find((f) => fresh.get(f)!.pool[term] !== undefined || fresh.get(f)!.words[term] !== undefined) ?? [...fresh.keys()][0]!;
    changes.push({ term: canonical, component: file, evidence: "", state: "unresolved", reason: `recurs without a definition (${now.prose} prose lines, ${now.components} components)` });
  }
  // A known name newly written where its sense is at risk, as the reading of the written files judges it; a Coherence name declared only in code the edit did not write is named by the next full reading.
  const terms = new Map(reading.coverage.terms.map((t) => [t.term, t]));
  for (const [file, c] of fresh) {
    const was = new Map<string, number>();
    for (const u of old.get(file)?.uses ?? []) was.set(u, (was.get(u) ?? 0) + 1);
    const risked = new Set<string>();
    for (const u of c.uses) {
      const left = was.get(u) ?? 0;
      if (left > 0) {
        was.set(u, left - 1);
        continue;
      }
      const term = u.split("\t")[0]!;
      if (risked.has(term)) continue;
      const found = terms.get(term);
      const context = found?.contexts.find((x) => x.component === c.component);
      const risk = context?.risk;
      if (risk === undefined) continue;
      risked.add(term);
      changes.push({ term, component: c.component, evidence: context?.fingerprint ?? "", state: found?.state ?? "declared", reason: `sense at risk: ${risk}` });
    }
  }
  // The kept state takes the edit in, against the contributions as they are now under the lock, so two edits at once both count.
  // It is marked as being written first, so a stop half way leaves a state the next edit refuses and reads past in full;
  // one the edit cannot take in at all (no lock, no write) is dropped, so the next edit reads in full and keeps it again.
  const meta_ = join(stateDir(root), "meta.json");
  const keep = (): void => {
    let kept: boolean | undefined;
    try {
      kept = withLock(join(cacheDir(root), "vocabulary.lock"), () => {
        // Read again under the lock: a part another edit tore since is refused here too, and the state is dropped below.
        const now = readMeta(root);
        if (now === undefined || now.version !== meta.version || now.writing === true) return false;
        writeKept(meta_, { ...now, writing: true }, false, true);
        const ids = takeIn(now);
        const buckets = { files: [...new Set([...now.buckets.files, ...ids.files])].sort(), terms: [...new Set([...now.buckets.terms, ...ids.terms])].sort() };
        writeKept(meta_, { version: now.version, buckets, tree } satisfies Meta, false, true);
        return true;
      });
    } catch {
      kept = undefined;
    }
    if (kept !== true) rmSync(meta_, { force: true });
  };
  const takeIn = (now: Meta): { files: string[]; terms: string[] } => {
    const locked = fileBuckets(root, [...fresh.keys()], now);
    const lockedOld = new Map([...fresh.keys()].map((file) => [file, locked.get(bucketOf(file))?.[file]]));
    const touched = new Set<string>();
    for (const c of [...fresh.values(), ...lockedOld.values()]) if (c !== undefined) for (const t of [...Object.keys(c.pool), ...Object.keys(c.words)]) touched.add(t);
    const buckets = termBuckets(root, [...touched].map(bucketOf), now);
    for (const [file, c] of fresh) {
      const was = lockedOld.get(file);
      if (was !== undefined) apply(buckets, was, -1);
      apply(buckets, c, 1);
      locked.get(bucketOf(file))![file] = c;
    }
    for (const [id, b] of locked) writeKept(join(stateDir(root), "files", `${id}.json`), b, false, true);
    for (const [id, b] of buckets) writeKept(join(stateDir(root), "terms", `${id}.json`), b, false, true);
    // The declared names change only when the edit declared or undeclared one.
    const present = has(buckets);
    let changed = false;
    for (const t of touched) {
      const total = buckets.get(bucketOf(t))?.pool[t];
      const canonical = canonicalOf(t, present);
      const is = total !== undefined && total.declared > 0;
      if (is && !declared.has(canonical)) {
        declared.add(canonical);
        changed = true;
      }
    }
    if (changed) writeKept(join(stateDir(root), "declared.json"), [...declared].sort(), false, true);
    return { files: [...locked.keys()], terms: [...buckets.keys()] };
  };
  return { changes, keep };
}

/** A full reading that also keeps the state an edit reads. */
export async function keptReading(root: string, layers: { coherence: Lexicon; project: Lexicon | undefined }): Promise<Coverage> {
  // The tree is keyed before the corpus is read: a write during the reading moves it, and the next edit reads in full.
  const tree = treeKeys(root);
  const records = recordKeys(root);
  const { coverage, contributions } = await lexiconReading(root, layers, undefined, { contributions: true });
  try {
    await keepVocabulary(root, layers, contributions, tree, coverage, records);
  } catch {
    // A state that cannot be kept costs the next edit a full reading of its own, never this reading.
  }
  return coverage;
}
