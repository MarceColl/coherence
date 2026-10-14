/**
 * The latest chokepoint verdict's files, indexed so an edit never parses the
 * run history. The run store is append-only: one JSONL file per session
 * under .coherence/runs. The index is one small file,
 * .coherence/cache/run-index.json: for each run file, the identity it was
 * read at (device, inode, size, modification and change time) and the byte
 * offset read to; for each chokepoint enforcement, its latest run's files.
 *
 * It is an optimization of a check, so it fails toward the slow, correct
 * path and says so, never toward silence:
 *
 * - every read verifies it: each run file is stat'd, and an index that does
 *   not name exactly the run files there are, at the identities they have, is
 *   rebuilt from every run file before it answers;
 * - it is written whole, aside, and renamed into place, so a crash leaves the
 *   old index or the new one, never half of one, and a stale one is caught
 *   by the verification;
 * - an append folds its own line in only when the index held the file just
 *   before it; a fold that cannot be made (a lock not had, a cache that cannot
 *   be written) leaves the index stale, which the next read catches;
 * - when the index cannot be rebuilt and written, a lookup throws
 *   RunIndexUnavailable, and its caller reads the whole store and says why.
 *
 * Latest means what latestByEnforcement means: the last record in the order
 * loadRuns sorts them, by time, then by file and line.
 */

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, storeVersion, withLock, writeKept } from "../lifecycle/kept-parse.ts";
import { RECORD_SEPARATOR, isPacked, isStoreFile, storeDir } from "../journal/stores.ts";

/** The shape of the index; one of another shape, or one other code made, is rebuilt. */
const INDEX_SHAPE = "run-index-3";
/** The code the index is made by: this module and the run records' parser. */
const INDEX_CODE = ["enforcement/run-index.ts", "enforcement/record.ts"];

const RUN_FILES = storeDir("runs");

interface Latest {
  at: string;
  /** The run file and the byte offset of the line, the order loadRuns breaks a tie in. */
  file: string;
  offset: number;
  files: string[];
  /** The language whose instrument graded it, when the run recorded one: where its next check is asked first. */
  language?: string;
}

interface Held {
  /** The file's identity when the index last read it. */
  identity: string;
  /** The offset read to: the end of its last whole line. */
  offset: number;
}

interface Index {
  version: string;
  files: Record<string, Held>;
  latest: Record<string, Latest>;
}

function indexPath(root: string): string {
  return join(cacheDir(root), "run-index.json");
}

function identityOf(root: string, name: string): { identity: string; size: number } | undefined {
  try {
    const s = statSync(join(root, RUN_FILES, name));
    return { identity: `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`, size: s.size };
  } catch {
    return undefined;
  }
}

/** Each run file's name and identity now. */
function runFiles(root: string): Map<string, { identity: string; size: number }> {
  const out = new Map<string, { identity: string; size: number }>();
  let names: string[];
  try {
    names = readdirSync(join(root, RUN_FILES)).filter(isStoreFile).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const id = identityOf(root, name);
    if (id !== undefined) out.set(name, id);
  }
  return out;
}

/** Whether `a` comes after `b` in loadRuns' order. */
function later(a: Latest, b: Latest | undefined): boolean {
  if (b === undefined) return true;
  if (a.at !== b.at) return a.at > b.at;
  if (a.file !== b.file) return a.file > b.file;
  return a.offset > b.offset;
}

type Parse = (line: string) => unknown;

/** Fold one line's chokepoint entries into the latest of each enforcement. */
function fold(latest: Record<string, Latest>, file: string, offset: number, line: string, parse: Parse): void {
  const record = parse(line) as { at?: string; kind?: string; invariants?: { component: string; name: string; form: string; files?: string[]; language?: string }[] } | string;
  if (typeof record === "string" || record.kind !== undefined || !Array.isArray(record.invariants) || typeof record.at !== "string") return;
  for (const entry of record.invariants) {
    if (entry.form !== "chokepoint") continue;
    // entryKey's spelling (record.ts), which a lookup is made by.
    const key = `${entry.component}\0${entry.name}\0${entry.form}`;
    const next: Latest = { at: record.at, file, offset, files: [...new Set(entry.files ?? [])].sort(), ...(typeof entry.language === "string" ? { language: entry.language } : {}) };
    if (later(next, latest[key])) latest[key] = next;
  }
}

/** Fold every whole line of one run file from `from` to `size`; the offset read to. */
function readFrom(root: string, latest: Record<string, Latest>, name: string, from: number, size: number, parse: Parse): number {
  if (size <= from) return from;
  const fd = openSync(join(root, RUN_FILES, name), "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    closeSync(fd);
  }
  // Only whole lines: a line still being written is read at the next look.
  const end = buffer.lastIndexOf(isPacked(name) ? 0x1e : 0x0a);
  if (end < 0) return from;
  let offset = from;
  for (const line of buffer.subarray(0, end + 1).toString("utf8").split(isPacked(name) ? RECORD_SEPARATOR : "\n")) {
    if (line.trim() !== "") fold(latest, name, offset, line, parse);
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return from + end + 1;
}

/** The index made from every run file as they are now. */
function build(root: string, version: string, parse: Parse): Index {
  const index: Index = { version, files: {}, latest: {} };
  for (const [name, id] of runFiles(root)) index.files[name] = { identity: id.identity, offset: readFrom(root, index.latest, name, 0, id.size, parse) };
  return index;
}

function readIndex(root: string): Index | undefined {
  try {
    const index = JSON.parse(readFileSync(indexPath(root), "utf8")) as Index;
    return typeof index.files === "object" && typeof index.latest === "object" ? index : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the index names exactly the run files there are, at the identities they have. */
function holds(index: Index | undefined, version: string, files: ReadonlyMap<string, { identity: string }>): index is Index {
  if (index === undefined || index.version !== version) return false;
  if (Object.keys(index.files).length !== files.size) return false;
  for (const [name, id] of files) if (index.files[name]?.identity !== id.identity) return false;
  return true;
}

/** Write the index whole, aside, and rename it into place; throws when it cannot. */
function writeIndex(root: string, index: Index): void {
  mkdirSync(cacheDir(root), { recursive: true });
  writeKept(indexPath(root), index, true, true);
}

function lockPath(root: string): string {
  return join(cacheDir(root), "run-index.lock");
}

/**
 * After an append of `length` bytes at `offset` to run file `name`: fold
 * that line in when the index held the file, at the identity it had, just
 * before the append. Best effort and never throws: an index it cannot bring
 * up to date is left stale, and the next read rebuilds it.
 */
export function noteRunAppend(root: string, name: string, before: string | undefined, offset: number, parse: Parse): void {
  try {
    withLock(lockPath(root), () => {
      const index = readIndex(root);
      const version = storeVersion(root, INDEX_SHAPE, INDEX_CODE);
      const held = index?.files[name];
      const heldBefore = before === undefined ? held === undefined : held?.identity === before && held.offset === offset;
      if (index === undefined || index.version !== version || !heldBefore) return;
      const now = identityOf(root, name);
      if (now === undefined) return;
      index.files[name] = { identity: now.identity, offset: readFrom(root, index.latest, name, offset, now.size, parse) };
      writeIndex(root, index);
    });
  } catch {
    // The index stays as it was; its file no longer matches it, so the next read rebuilds it.
  }
}

/* ---------------------------------------------------------- sites shards */

/**
 * A run file's sites shard: for each enforcement, the hash of the sites its
 * last entry in that file wrote in full and that run's time, which is what a
 * sites reference names. It is kept per run file, in
 * .coherence/cache/run-sites/<file>.json, with the file's identity and size
 * when it was written, so an append asks it instead of reading its session's
 * whole run file. It answers only for the file exactly as it is (the same
 * identity, every byte of it); otherwise it cannot say, and the appender
 * writes its sites in full. Every hash it names was written in full in its
 * file, which is append-only, so a shard that missed a line knows less,
 * never something false: one started at any line holds from there.
 */
const SITES_SHAPE = "run-sites-1";
const SITES_CODE = ["enforcement/run-index.ts", "enforcement/record.ts"];

export interface HeldSites {
  hash: string;
  at: string;
}

interface SitesShard {
  version: string;
  identity: string;
  size: number;
  latest: Record<string, HeldSites>;
}

function shardPath(root: string, name: string): string {
  return join(cacheDir(root), "run-sites", `${name}.json`);
}

function readShard(root: string, name: string, version: string): SitesShard | undefined {
  try {
    const shard = JSON.parse(readFileSync(shardPath(root, name), "utf8")) as SitesShard;
    if (shard.version !== version || typeof shard.identity !== "string" || typeof shard.size !== "number") return undefined;
    if (typeof shard.latest !== "object" || shard.latest === null || Array.isArray(shard.latest)) return undefined;
    for (const held of Object.values(shard.latest)) if (typeof held?.hash !== "string" || typeof held.at !== "string") return undefined;
    return shard;
  } catch {
    return undefined;
  }
}

/**
 * The sites each enforcement last wrote in full in run file `name`, by
 * entryKey, as its shard holds them: an empty map for a file not yet
 * written, undefined when the shard cannot say (none, torn, of other code,
 * or kept for the file as it no longer is). One stat and one small read.
 */
export function heldSites(root: string, name: string): Map<string, HeldSites> | undefined {
  const now = identityOf(root, name);
  if (now === undefined) return new Map();
  const shard = readShard(root, name, storeVersion(root, SITES_SHAPE, SITES_CODE));
  if (shard === undefined || shard.identity !== now.identity || shard.size !== now.size) return undefined;
  return new Map(Object.entries(shard.latest));
}

/**
 * After an append to run file `name`, whose identity was `before` (undefined
 * for a new file): the shard carried forward with `updates` (an
 * enforcement's sites written in full, or null where its entry carried
 * neither sites nor a reference) when it held the file just before, or
 * started from `updates` alone when it did not. Best effort and never
 * throws: a shard not written cannot say, and the next append writes its
 * sites in full.
 */
export function noteSitesAppend(root: string, name: string, before: string | undefined, updates: ReadonlyMap<string, HeldSites | null>): void {
  try {
    const version = storeVersion(root, SITES_SHAPE, SITES_CODE);
    const old = before === undefined ? undefined : readShard(root, name, version);
    const latest: Record<string, HeldSites> = old !== undefined && old.identity === before ? { ...old.latest } : {};
    for (const [key, held] of updates) {
      if (held === null) delete latest[key];
      else latest[key] = held;
    }
    const now = identityOf(root, name);
    if (now === undefined) return;
    mkdirSync(join(cacheDir(root), "run-sites"), { recursive: true });
    writeKept(shardPath(root, name), { version, identity: now.identity, size: now.size, latest } satisfies SitesShard, false, true);
  } catch {
    // No shard, or the old one: either cannot say for the file as it is now, so the next append writes in full.
  }
}

/** A run file's identity, for an appender to hand noteRunAppend. */
export function runFileIdentity(root: string, name: string): string | undefined {
  return identityOf(root, name)?.identity;
}

/** Why the run index could not answer: the caller falls back to the whole run store and says so. */
export class RunIndexUnavailable extends Error {}

/**
 * The chokepoint enforcements whose latest run saw each of `files`, by
 * entryKey: one stat per run file and one small read, a rebuild first when
 * the index does not hold the store. Throws RunIndexUnavailable when the
 * index cannot be read and rebuilt and written: its caller then reads the
 * whole run store instead and says why.
 */
/** What a lookup answers: per written file, the enforcements whose latest run saw it; and each enforcement's latest files and language. */
export interface Seeing {
  byFile: Map<string, Set<string>>;
  latest: Map<string, { files: string[]; language?: string }>;
}

export function latestSeeing(root: string, files: readonly string[], parse: Parse): Seeing {
  const now = runFiles(root);
  let index = readIndex(root);
  const version = storeVersion(root, INDEX_SHAPE, INDEX_CODE);
  if (!holds(index, version, now)) {
    const rebuilt = build(root, version, parse);
    try {
      const written = withLock(lockPath(root), () => {
        writeIndex(root, rebuilt);
        return true;
      });
      if (written !== true) throw new RunIndexUnavailable("the run index's lock was held by another process past the wait");
    } catch (error) {
      if (error instanceof RunIndexUnavailable) throw error;
      throw new RunIndexUnavailable(`the run index could not be written (${error instanceof Error ? error.message : String(error)})`);
    }
    index = rebuilt;
  }
  const latest = index!.latest;
  const byFile = new Map<string, Set<string>>();
  for (const file of files) byFile.set(file, new Set(Object.entries(latest).filter(([, l]) => l.files.includes(file)).map(([key]) => key)));
  return { byFile, latest: new Map(Object.entries(latest).map(([key, l]) => [key, { files: l.files, ...(l.language === undefined ? {} : { language: l.language }) }])) };
}
