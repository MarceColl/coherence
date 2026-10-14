/**
 * Where the journal lives and how it is read back.
 *
 * Sealed shards per session under .coherence/journal (shards.ts), beside the
 * legacy one-file-per-session files. A write appends one record and never
 * rewrites; a read merges every store file into one timeline ordered by
 * time. A line that will not parse is reported with its file and
 * line number and skipped, never silently dropped: a crashed write leaves a
 * partial last line, and the reader must say so rather than hide it.
 */

import { execFileSync } from "../lifecycle/work-meter.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendWhole, storeLines } from "./append.ts";
import { JournalError } from "./args.ts";
import { isKind, type JournalRecord } from "./record.ts";
import { shardFor } from "./shards.ts";
import { isStoreFile, storeDir } from "./stores.ts";
import { SESSION_TOKEN, workBinding } from "./work.ts";

export const JOURNAL_DIR = storeDir("journal");

export function journalDir(cwd: string): string {
  return join(cwd, JOURNAL_DIR);
}

export function sessionFile(cwd: string, session: string): string {
  if (!SESSION_TOKEN.test(session)) {
    throw new JournalError(
      `session "${session}" cannot name a file; use letters, digits, dot, dash, or underscore`,
    );
  }
  return join(journalDir(cwd), `${session}.jsonl`);
}

/**
 * Append one record as one line, and settle its work order binding here,
 * where every write passes: a --work flag names the order, otherwise the one
 * active order the session owns binds, otherwise the record says why nothing
 * does. The file and directory are created on first write. Returns the
 * record as written.
 */
export function appendRecord(cwd: string, record: JournalRecord): JournalRecord {
  return appendRecordTo(cwd, record).record;
}

/** appendRecord, with the shard the record went to, relative to the project root. */
export function appendRecordTo(cwd: string, record: JournalRecord): { record: JournalRecord; file: string } {
  sessionFile(cwd, record.session);
  const bound: JournalRecord = { ...record, ...workBinding(cwd, record.session, record.work) };
  mkdirSync(journalDir(cwd), { recursive: true });
  const shard = shardFor(cwd, "journal", record.session);
  appendWhole(shard.file, `${JSON.stringify(bound)}\n`);
  shard.kept();
  return { record: bound, file: join(JOURNAL_DIR, shard.name) };
}

export interface Damaged {
  file: string;
  line: number;
  reason: string;
}

export interface Loaded {
  /** Every readable record across every session, oldest first. */
  records: JournalRecord[];
  damaged: Damaged[];
}

/** Records order by time, then id, so two writers in the same millisecond still have one order. */
export function compareRecords(a: JournalRecord, b: JournalRecord): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function loadJournal(cwd: string): Loaded {
  return loadJournalFiles(cwd);
}

/**
 * Each session file of the journal with its identity: device, inode, size,
 * modification and change time. An append changes it, and so does any other
 * write, which can set back a modification time but never a change time.
 */
export function journalFileKeys(cwd: string): Map<string, string> {
  const dir = journalDir(cwd);
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter(isStoreFile).sort()) {
    try {
      const s = statSync(join(dir, name));
      out.set(name, `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`);
    } catch {
      // Gone since the listing: no records to read.
    }
  }
  return out;
}

/** The journal's records, from every session file or only the ones `names` lists, in one timeline. */
export function loadJournalFiles(cwd: string, names?: readonly string[]): Loaded {
  const dir = journalDir(cwd);
  const loaded: Loaded = { records: [], damaged: [] };
  if (!existsSync(dir)) return loaded;
  const files = (names ?? readdirSync(dir))
    .filter(isStoreFile)
    .sort();
  const seen = new Set<string>();
  for (const name of files) {
    const file = join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      // A file listed and gone, or unreadable: said, never read as a file with no records.
      if (names === undefined) throw error;
      loaded.damaged.push({ file: join(JOURNAL_DIR, name), line: 0, reason: `not read: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    for (const { line, number } of storeLines(text, seen)) {
      const verdict = parseLine(line);
      if (typeof verdict === "string") {
        loaded.damaged.push({ file: join(JOURNAL_DIR, name), line: number, reason: verdict });
      } else {
        loaded.records.push(verdict);
      }
    }
  }
  loaded.records.sort(compareRecords);
  return loaded;
}

/** A record, or the reason the line is not one. */
function parseLine(line: string): JournalRecord | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return `not JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not a record object";
  const record = value as Record<string, unknown>;
  for (const field of ["id", "kind", "at", "session", "agent"]) {
    if (typeof record[field] !== "string" || record[field] === "") return `missing ${field}`;
  }
  const kind = record["kind"] as string;
  if (!isKind(kind)) return `unknown kind "${kind}"`;
  if (Number.isNaN(Date.parse(record["at"] as string))) return `unreadable time "${String(record["at"])}"`;
  return value as JournalRecord;
}

/** What git says about the tree at the moment of a write; null commit when there is no git to ask. */
export function gitState(cwd: string): { commit: string | null; dirty: boolean } {
  const commit = git(cwd, ["rev-parse", "--short", "HEAD"]);
  if (commit === null) return { commit: null, dirty: false };
  const status = git(cwd, ["status", "--porcelain"]);
  return { commit, dirty: status !== null && status !== "" };
}

/** The branch is never stored; it is asked of git when a read wants it. */
export function gitBranch(cwd: string): string | null {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === "" ? null : branch;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
