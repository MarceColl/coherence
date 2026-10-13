/**
 * Undeclared entrances at hook time: the detected entrances no declared
 * entrance covers (entrance-coverage.ts, c-3760638e), as orient and regulate
 * name them, and what `scaffold entrances` proposes for them.
 *
 * Detection is a plain scan of the tree that asks the language server
 * nothing, so unlike the spec gaps it needs no recorded Structure reading:
 * orient and regulate detect now, against the spec as it stands, and a
 * session that just declared an entrance sees it counted at once.
 *
 * No adoption baseline (the gap baseline's convention is not reused): the
 * line is one bounded line whatever the count, naming a folder rather than a
 * list, so there is nothing to silence; and in the replicated A/B adoption
 * test coverage stayed at 11 to 14 percent in both arms, so a baseline taken
 * on day one would hide exactly the surface that was never declared.
 *
 * Node-only; the browser bundle never imports it.
 */

import { posix } from "node:path";
import type { EntranceCandidate } from "../../adapters/entrance-candidates.ts";
import { scannedLanguagesRead, type LanguagesRead } from "./languages-read.ts";
import { readEnforcementConfig } from "../../enforcement/config.ts";
import { loadSpecModel, type SpecModel } from "../../spec/model.ts";
import { detectedEntrances } from "./component-interfaces.ts";
import { coverageOf, ruleCount } from "./entrance-coverage.ts";

/** The declared entrances against what the rules detect now, and the detected entrances none covers. */
export interface Undeclared {
  declared: number;
  detected: number;
  covered: number;
  /** In file order. */
  undeclared: EntranceCandidate[];
  /** Which of the project's languages detection read, each by its own rules, and each with no rules yet named as not read. */
  languages: LanguagesRead;
}

/** Detect now and measure against a spec model: undefined when nothing is detected. Throws what detection throws. */
export function undeclaredOf(root: string, model: Pick<SpecModel, "components">): Undeclared | undefined {
  const config = readEnforcementConfig(root);
  const languages = scannedLanguagesRead(config);
  const candidates = detectedEntrances(root, model, languages.read, config.testFolders);
  const coverage = coverageOf(model.components, candidates);
  if (coverage === undefined || coverage.detected === 0) return undefined;
  return { declared: coverage.declared, detected: coverage.detected, covered: coverage.individually + coverage.grouped, undeclared: coverage.uncovered, languages };
}

/**
 * Detect now and measure against the current spec, for a hook. Undefined when
 * the spec is unreadable or declares no component yet (setup has not reached
 * specs), or when nothing is detected.
 */
export function undeclaredNow(root: string): Undeclared | undefined {
  try {
    const model = loadSpecModel(root, { runs: false });
    return model.components.length === 0 ? undefined : undeclaredOf(root, model);
  } catch {
    return undefined;
  }
}

/** The folder a detected entrance sits in, "." for the root. */
export function folderOf(candidate: Pick<EntranceCandidate, "file">): string {
  const dir = posix.dirname(candidate.file);
  return dir === "" ? "." : dir;
}

/** "86 server functions", "28 package scripts, 3 scripts": the rules of some detected entrances, most frequent first, two named at most. */
export function rulesText(candidates: readonly Pick<EntranceCandidate, "rule">[]): string {
  const tally = new Map<string, number>();
  for (const c of candidates) tally.set(c.rule, (tally.get(c.rule) ?? 0) + 1);
  const ranked = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const named = ranked.slice(0, 2).map(([rule, n]) => ruleCount(n, rule));
  const rest = ranked.slice(2).reduce((sum, [, n]) => sum + n, 0);
  return named.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}

/** The folder holding the most undeclared entrances, ties broken by name. */
export function busiestFolder(undeclared: readonly EntranceCandidate[]): { folder: string; candidates: EntranceCandidate[] } | undefined {
  const byFolder = new Map<string, EntranceCandidate[]>();
  for (const c of undeclared) byFolder.set(folderOf(c), [...(byFolder.get(folderOf(c)) ?? []), c]);
  const [folder, candidates] = [...byFolder].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0] ?? [];
  return folder === undefined ? undefined : { folder, candidates: candidates! };
}

/** The most characters a folder takes in orient's one line. */
const FOLDER_CHARS = 60;

function shortPath(path: string): string {
  return path.length <= FOLDER_CHARS ? path : `…${path.slice(path.length - FOLDER_CHARS + 1)}`;
}

function quotedPath(path: string): string {
  return /[\s$*?[\]'"`()]/.test(path) ? `'${path.replace(/'/g, "'\\''")}'` : path;
}

/**
 * Orient's coverage line: how many detected entrances the declared ones
 * cover, how many are undeclared, the folder holding the most with their
 * rules, and the command that proposes their bullets. Nothing when every
 * detected entrance is covered. Bounded: one line, one folder, never a list.
 */
export function orientUndeclaredText(state: Omit<Undeclared, "languages"> | undefined, cli: string): string {
  if (state === undefined || state.undeclared.length === 0) return "";
  const busiest = busiestFolder(state.undeclared)!;
  const n = state.undeclared.length;
  const scope = busiest.candidates.length === n ? "all" : "most";
  return `Entrance coverage: ${state.declared} declared ${state.declared === 1 ? "entrance covers" : "entrances cover"} ${state.covered} of ${state.detected} detected; ${n} undeclared, which the gap count says nothing of; ${scope} in ${shortPath(busiest.folder)} (${rulesText(busiest.candidates)}). ${cli} scaffold entrances ${quotedPath(busiest.folder)} proposes their ## entrances bullets; declare each in the spec that owns it.`;
}

/** The most files regulate names; the rest are counted. */
const REGULATE_FILES = 8;

/**
 * Regulate's lines: the undeclared entrances in the files this session
 * changed, by file, three names each at most. Advisory: an undeclared
 * entrance is never owed, so the caller never counts it toward a refusal.
 * Empty when the session changed no file holding one.
 */
export function regulateUndeclaredText(changed: readonly string[], state: Omit<Undeclared, "languages"> | undefined, cli: string): string {
  if (state === undefined) return "";
  const files = new Set(changed);
  const byFile = new Map<string, EntranceCandidate[]>();
  for (const c of state.undeclared) if (files.has(c.file)) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  if (byFile.size === 0) return "";
  const lines = ["Undeclared entrances in files this session changed; advisory, never a reason to refuse the stop:"];
  const entries = [...byFile.entries()];
  for (const [file, found] of entries.slice(0, REGULATE_FILES)) {
    const names = found.map((c) => (c.symbol === "" ? "the file itself" : c.symbol));
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
    lines.push(`  ${file} (${rulesText(found)}): ${shown}`);
  }
  if (entries.length > REGULATE_FILES) lines.push(`  and ${entries.length - REGULATE_FILES} more files`);
  const target = entries.length === 1 ? entries[0]![0] : commonFolder(entries.map(([f]) => f));
  lines.push(`  ${cli} scaffold entrances ${quotedPath(target)} proposes their ## entrances bullets; declare each in the spec that owns it, or record why one is not an entrance.`);
  return lines.join("\n");
}

/** The deepest folder holding every one of the files, "." when they share none. */
function commonFolder(files: readonly string[]): string {
  const parts = files.map((f) => f.split("/").slice(0, -1));
  const first = parts[0] ?? [];
  let depth = 0;
  while (depth < first.length && parts.every((p) => p[depth] === first[depth])) depth += 1;
  return depth === 0 ? "." : first.slice(0, depth).join("/");
}
