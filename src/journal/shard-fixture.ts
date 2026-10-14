/**
 * For tests: a session's files in a store folder, now that a session's
 * records are the union of its shards (shards.ts) and its legacy file.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPacked, sessionOfStoreFile } from "./stores.ts";

/** The session's store files in `dir`, oldest first (by modification time, then name). */
export function sessionFiles(dir: string, session: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => sessionOfStoreFile(name) === session)
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1))
    .map((f) => f.name);
}

/** The session's one store file in `dir`; throws when it has none or several. */
export function onlyFile(dir: string, session: string): string {
  const files = sessionFiles(dir, session);
  if (files.length !== 1) throw new Error(`session ${session} has ${files.length} files in ${dir}: ${files.join(", ")}`);
  return join(dir, files[0]!);
}

/** The session's records in `dir` as lines, every file oldest first, a packed shard's records one per line. */
export function sessionText(dir: string, session: string): string {
  return sessionFiles(dir, session)
    .map((name) => {
      const text = readFileSync(join(dir, name), "utf8");
      return isPacked(name) ? text.split("\u001e").filter((t) => t !== "").map((t) => `${t}\n`).join("") : text;
    })
    .join("");
}
