/**
 * The two files Coherence keeps for git inside its own folder, so a project
 * commits its records and nothing else of Coherence's, and merges them
 * without a conflict. Both sit in .coherence, so writing them never edits a
 * file the adopter wrote, and their patterns are relative to that folder.
 *
 * `.coherence/.gitignore` keeps out the state Coherence regenerates. Install
 * writes it once; a file holding exactly what an earlier release wrote is
 * Coherence's and is brought up to this one's text; any other text is the
 * adopter's and is left alone.
 *
 * `.coherence/.gitattributes` makes each record store's session files merge
 * with the union of both sides' lines (merge=union): two branches that
 * appended to one session's file, as every stacked branch does, merge and
 * rebase cleanly, and every record of both survives. The stores' readers
 * order records by their content, never by line, so the order the union
 * leaves is no one's concern. It also marks the stores generated, so GitHub
 * folds them in a pull request's diff. Install and every session start
 * write it, so a project that adopted an earlier release has it from its
 * first session after the upgrade; a file already there keeps every line
 * the adopter wrote, and only an attribute it does not set for that pattern
 * is added.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DURABLE_FOLDERS, RECORD_STORES } from "./project.ts";

/** Coherence's own folder in a project. */
export const STATE_DIR = ".coherence";

/** The ignore file inside Coherence's own folder. */
export const IGNORE_FILE = join(STATE_DIR, ".gitignore");

/** The attributes file inside Coherence's own folder. */
export const ATTRIBUTES_FILE = join(STATE_DIR, ".gitattributes");

/** The exact text install writes; only a file holding exactly this, or an earlier release's text, is Coherence's. */
export const IGNORE_TEXT = [
  "# Written by coherence hooks install; hooks uninstall removes it.",
  "# Commit this file, .gitattributes and the folders it keeps: the journal,",
  "# runs, work orders and conformance verdicts are durable records, and hooks",
  "# holds the project's own hook voice. Everything else here is regenerated",
  "# (feed cursors, read traces, practice firings, the warm server, structure",
  "# and lexicon readings, conformance captures), so git ignores it.",
  "/*",
  "!/.gitignore",
  "!/.gitattributes",
  ...DURABLE_FOLDERS.map((folder) => `!/${folder}/`),
].join("\n") + "\n";

/** What earlier releases wrote: 1.7.2's, before the conformance store, and through 1.6.0's, which ignored the attributes file; a file holding exactly one of these is brought up to IGNORE_TEXT. */
export const EARLIER_IGNORE_TEXTS: readonly string[] = [
  [
    "# Written by coherence hooks install; hooks uninstall removes it.",
    "# Commit this file, .gitattributes and the folders it keeps: the journal,",
    "# runs and work orders are durable records, and hooks holds the project's",
    "# own hook voice. Everything else here is regenerated (feed cursors, read",
    "# traces, practice firings, the warm server, structure and lexicon",
    "# readings), so git ignores it.",
    "/*",
    "!/.gitignore",
    "!/.gitattributes",
    "!/journal/",
    "!/runs/",
    "!/work/",
    "!/hooks/",
  ].join("\n") + "\n",
  [
    "# Written by coherence hooks install; hooks uninstall removes it.",
    "# Commit this file and the folders it keeps: the journal, runs and work",
    "# orders are durable records, and hooks holds the project's own hook voice.",
    "# Everything else here is regenerated (feed cursors, read traces, practice",
    "# firings, the warm server, structure and lexicon readings), so git ignores it.",
    "/*",
    "!/.gitignore",
    "!/journal/",
    "!/runs/",
    "!/work/",
    "!/hooks/",
  ].join("\n") + "\n",
];

/** Each attribute Coherence sets, one per line, relative to .coherence: every record store's session files merge by union and read as generated. */
export const ATTRIBUTE_LINES: readonly string[] = RECORD_STORES.flatMap((store) => [`${store}/*.jsonl merge=union`, `${store}/** linguist-generated=true`]);

/** The exact text written where no attributes file was; only a file holding exactly this is Coherence's to remove. */
export const ATTRIBUTES_TEXT = [
  "# Written by Coherence; hooks uninstall removes it while it holds only this.",
  "# Each record store is one append-only JSONL file per session, and its",
  "# readers order records by content: two branches that appended to one",
  "# session's file merge with both sides' lines (merge=union), never a",
  "# conflict. GitHub folds the records in a pull request's diff.",
  ...ATTRIBUTE_LINES,
].join("\n") + "\n";

/** The line above what Coherence adds to an attributes file the adopter already had. */
const ADDED_HEAD = "# Added by Coherence: its record stores merge with both sides' lines.";

/** What was done with .coherence/.gitignore: written, already Coherence's text, an earlier release's text brought up to it, the adopter's kept, or absent and left so. */
export type IgnoreAction = "wrote" | "unchanged" | "upgraded" | "kept" | "absent";

/** What was done with .coherence/.gitattributes: written, already exactly Coherence's, the adopter's with Coherence's missing lines added, or the adopter's already setting them all. */
export type AttributesAction = "wrote" | "unchanged" | "added" | "kept";

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Bring .coherence/.gitignore to this release's text when it is Coherence's; write it when absent only with `create` (install does, a session start does not). */
export function keepIgnore(root: string, create: boolean): IgnoreAction {
  const path = resolve(root, IGNORE_FILE);
  const found = readText(path);
  if (found === IGNORE_TEXT) return "unchanged";
  if (found !== undefined && EARLIER_IGNORE_TEXTS.includes(found)) {
    write(path, IGNORE_TEXT);
    return "upgraded";
  }
  if (found !== undefined) return "kept";
  if (!create) return "absent";
  write(path, IGNORE_TEXT);
  return "wrote";
}

/** Whether an attributes file already sets the attribute of `line` (in any state: set, unset, or a value) for the same pattern. */
function sets(text: string, line: string): boolean {
  const [pattern, attribute] = line.split(" ") as [string, string];
  const name = attribute.split("=")[0];
  return text.split("\n").some((l) => {
    const [first, ...attributes] = l.trim().split(/\s+/);
    return first === pattern && attributes.some((a) => a.replace(/^[-!]/, "").split("=")[0] === name);
  });
}

/** Write .coherence/.gitattributes when absent; to one already there, add only the attributes it does not set, after every line it holds. */
export function keepAttributes(root: string): AttributesAction {
  const path = resolve(root, ATTRIBUTES_FILE);
  const found = readText(path);
  if (found === ATTRIBUTES_TEXT) return "unchanged";
  if (found === undefined) {
    write(path, ATTRIBUTES_TEXT);
    return "wrote";
  }
  const missing = ATTRIBUTE_LINES.filter((line) => !sets(found, line));
  if (missing.length === 0) return "kept";
  write(path, `${found}${found === "" || found.endsWith("\n") ? "" : "\n"}${[ADDED_HEAD, ...missing].join("\n")}\n`);
  return "added";
}

/** What a session start does: the attributes file kept, and an ignore file an earlier release wrote brought up to this one's; nothing created that install did not. Never throws. */
export function keepStateFiles(root: string): void {
  try {
    keepIgnore(root, false);
    keepAttributes(root);
  } catch {
    // An unwritable folder: the next session start tries again, and hooks install writes both.
  }
}

/** Remove each file that holds exactly what Coherence writes (the ignore file in this or an earlier release's text); whether the ignore file went. */
export function removeStateFiles(root: string): boolean {
  if (readText(resolve(root, ATTRIBUTES_FILE)) === ATTRIBUTES_TEXT) rmSync(resolve(root, ATTRIBUTES_FILE));
  const ignore = readText(resolve(root, IGNORE_FILE));
  if (ignore === undefined || (ignore !== IGNORE_TEXT && !EARLIER_IGNORE_TEXTS.includes(ignore))) return false;
  rmSync(resolve(root, IGNORE_FILE));
  return true;
}
