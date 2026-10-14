/**
 * The record stores under .coherence, named once: each store and the folder
 * its JSONL files live in, one file per session, append only.
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
  /** Conformance verdicts: each model held against the code's own tests, machine-written. */
  conformance: { folder: "conformance", prose: false },
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
