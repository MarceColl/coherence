/**
 * The record stores under .coherence, named once: each store and the folder
 * its record files live in, and how those files are named and split.
 *
 * A store's files are sealed shards (src/journal/shards.ts says when a
 * writer starts one): `<session>.<token>.jsonl`, one record per line, or
 * `<session>.<token>.jsonseq`, a packed shard, led and every record ended by U+001E
 * and no newline, so the shard is one line. A legacy `<session>.jsonl`, one
 * file per session, is read as it was committed. The session is the name
 * before its first dot for every session id with no dot in it; no reader
 * takes the attribution from a name, only from each record's own fields.
 *
 * Every module that reads or writes a store takes its folder from here, and
 * everything that must name every store derives from this table: the folders
 * a project commits (.coherence/.gitignore), the union merge each store's
 * files take (.coherence/.gitattributes), the stores Scope live follows, the
 * stores the vocabulary check reads as the writer's words, and the CI records
 * summary. A store is added by adding it here; there is no second list to
 * leave it out of.
 *
 * Kept light (node:path alone) and in erasable TypeScript, so the CI records
 * summary imports it with plain node.
 */

import { join } from "node:path";

export const STORES = {
  /** Decisions, defects, conjectures and the rest of the journal's kinds. */
  journal: { folder: "journal", prose: true },
  /** Enforcement runs and witnessed refutations: machine-written verdicts. */
  runs: { folder: "runs", prose: false },
  /** Work orders and their moves. */
  work: { folder: "work", prose: true },
} as const;

export type RecordStore = keyof typeof STORES;

/** Every store, in the table's order. */
export const STORE_NAMES: readonly RecordStore[] = Object.keys(STORES) as RecordStore[];

/** Every store's folder under .coherence. */
export const STORE_FOLDERS: readonly string[] = STORE_NAMES.map((store) => STORES[store].folder);

/** The folders under .coherence whose records hold the writer's own words; a run's are the tool's. */
export const PROSE_STORE_FOLDERS: readonly string[] = STORE_NAMES.filter((store) => STORES[store].prose).map((store) => STORES[store].folder);

/** A store's folder, relative to the project root. */
export function storeDir(store: RecordStore): string {
  return join(".coherence", STORES[store].folder);
}

/** The store a project-relative path (with / or the platform's separator) lies in, or undefined when it lies in none. */
export function storeOfPath(rel: string): RecordStore | undefined {
  const name = rel.split("\\").join("/");
  return STORE_NAMES.find((store) => name.startsWith(`.coherence/${STORES[store].folder}/`));
}

/** A shard of one record per line, and the legacy one-file-per-session name. */
export const LINE_EXTENSION = ".jsonl";

/**
 * A packed shard: it starts with RECORD_SEPARATOR, each record is ended by
 * one, and it holds no newline, so git counts it as one line. Not
 * ".jsonl", so a release that reads only "*.jsonl" (1.7.x) skips it instead
 * of reading it as one damaged line.
 */
export const PACKED_EXTENSION = ".jsonseq";

/** What ends a record in a packed shard, as the newline does in a line shard: U+001E, RFC 7464's separator. */
export const RECORD_SEPARATOR = "\u001e";

/** Whether a file in a store folder holds records: a line shard, a legacy session file, or a packed shard. */
export function isStoreFile(name: string): boolean {
  return name.endsWith(LINE_EXTENSION) || name.endsWith(PACKED_EXTENSION);
}

/** Whether a store file is packed. */
export function isPacked(name: string): boolean {
  return name.endsWith(PACKED_EXTENSION);
}

/** The record texts a store file holds, in file order, split on the newline and the record separator alike; blank ones included. */
export function recordTexts(text: string): string[] {
  return text.split(/[\n\u001e]/);
}

/**
 * The session a store file's name is for: `<session>.<token>.<extension>`,
 * the token 8 lowercase hex characters, or the legacy `<session>.jsonl`;
 * undefined for a name that is no store file.
 */
export function sessionOfStoreFile(name: string): string | undefined {
  if (!isStoreFile(name)) return undefined;
  const stem = name.slice(0, name.lastIndexOf("."));
  const shard = /^(.+)\.[0-9a-f]{8}$/.exec(stem);
  if (shard !== null) return shard[1];
  return isPacked(name) ? undefined : stem;
}
