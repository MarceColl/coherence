/**
 * The lexicon check: two questions asked of a corpus of prose, code, data,
 * and the journal's own records.
 *
 * REJECTED NAME: a name some concept refused, appearing as a whole word or
 * phrase in prose, as a whole identifier token (camelCase and snake_case
 * split) in code, or as a key or value in a data file. Each finding carries
 * the concept and its because.
 *
 * UNKNOWN NOUN: a term prose uses as a name (backticked, Title Case away from
 * a sentence start, or the name of a component folder) that no lexicon
 * declares, is not a common word, and appears at least twice. Precision over
 * recall: every finding is meant to be acted on with one of three answers,
 * declare it, map it, or fix it.
 *
 * Whose names bind where. Coherence's rejected names bind only where
 * Coherence's concepts are named. In Coherence's own repository that is
 * everywhere, prose, code, data and records alike, as strictly as ever. In
 * an adopter, the project's code and domain prose are the project's words
 * and Coherence's names are never matched there: a word the tool refused for
 * one of its own concepts is an ordinary word of someone else's domain. Only
 * the text written to Coherence (the journal's and work's records, a spec's
 * grammar, which is its section headings, property keys and checklist shapes
 * with their state words, and coherence.config.json) is matched, and there a
 * hit is advisory: reported as a count, never failing, since a record may
 * name the domain's thing in the domain's sense. The project's own lexicon's
 * rejected names bind in
 * everything the project writes, prose and identifiers alike, because a
 * rejected name in an identifier is the drift the lexicon exists to catch.
 *
 * A project CLAIMS a word by declaring it in its own lexicon (a concept,
 * alias, or instance): a Coherence rejected name it declares is not a
 * finding there in any text, and a hit inside a longer accepted phrase (a
 * project alias that happens to contain a rejected word) is not a hit.
 *
 * The findings a project held when it adopted Coherence are its BASELINE
 * (lexicon-baseline.ts): counted on one line, never failing, and never
 * allowed to grow. Coherence's own repository keeps none.
 *
 * The corpus is every text file kind a project holds, the journal's records
 * included, and never the files written in another vocabulary on purpose:
 * the lexicons themselves, the retired inventories, docs/reference, and
 * the adversarial reviews, which quote the names they report. It stays inside
 * the config's bounds: a folder the ignore list names is never entered, by
 * the same rule every other walk applies, so an adoption bounded to one
 * subsystem of a monorepo reads that subsystem and its records. A path the
 * check cannot read is reported as unreadable and skipped; it never aborts
 * the walk. Every path given is confined to the project root.
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { readProjectTextAsync } from "./work-meter.ts";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { acceptedNames, rejectedNames, type Lexicon, type RejectedName } from "./lexicon.ts";
import { STOPLIST } from "./stoplist.ts";
import { singular } from "./inflection.ts";
import { LOCKFILES } from "./lockfiles.ts";
import { configIgnore, exclusionOf, projectFiles, underIgnored, walkBounds, type Bounds } from "../adapters/project-files.ts";
import { CONFIG_FILE, isCoherenceItself, vocabularyFacts } from "./project.ts";
import { PROSE_STORE_FOLDERS, isStoreFile, recordTexts } from "../journal/stores.ts";
import { recordWords } from "../journal/record.ts";
import { isWellKnown, wellKnown, type WellKnown } from "./well-known.ts";
import { proseNominations } from "./nomination.ts";
import { applyBaseline, readBaseline, type BaselineSummary } from "./lexicon-baseline.ts";

export interface CheckOptions {
  root: string;
  /** Files or folders to check; the whole project when empty. */
  paths?: string[];
  coherence: Lexicon;
  project?: Lexicon | undefined;
  /**
   * Whether the project is Coherence itself, where Coherence's rejected names
   * bind in every text and no baseline is kept. Detected from the root, the
   * way the tool already tells (the package's name), when not given.
   */
  coherenceItself?: boolean;
}

export interface Location {
  file: string;
  line: number;
}

export interface RejectedFinding extends Location {
  name: string;
  /** The text as it appeared. */
  text: string;
  concept: string;
  because: string;
  /**
   * How this finding is repaired. "edit" for a file the project can rewrite;
   * "record" for a line in the append-only store, where no edit is possible
   * and the repair is a later record. Only an editable finding drives the
   * exit code, because only an editable finding can be settled before the
   * next command.
   */
  repair: "edit" | "record";
  /** A Coherence name in an adopter's Coherence-facing text: counted, never failing. */
  advisory?: true;
  /** Held by the project's baseline: counted, never failing. */
  baselined?: true;
}

export interface UnknownFinding {
  term: string;
  count: number;
  locations: Location[];
  options: { declare: string; map: string; fix: string };
  /** Held by the project's baseline: counted, never failing. */
  baselined?: true;
}

/** A path the walk could not read, and why. Reported, never fatal: the check says what it did not see. */
export interface UnreadablePath {
  file: string;
  reason: string;
}

export interface CheckReport {
  files: number;
  rejected: RejectedFinding[];
  unknown: UnknownFinding[];
  /** Paths the walk could not read; the corpus is that much smaller and the report says so. */
  unreadable: UnreadablePath[];
  /** What the project's baseline held in this check; absent when no baseline was taken. */
  baseline?: BaselineSummary;
}

const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".rst", ".txt"]);
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".m", ".mm",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".scala", ".lua",
  ".sh", ".bash", ".zsh", ".fish", ".sql", ".css", ".scss", ".less", ".vue", ".svelte",
]);
const DATA_EXTENSIONS = new Set([
  ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".env", ".properties", ".xml", ".csv", ".tsv", ".graphql", ".proto",
]);

/** Machine-written or foreign-vocabulary files no adopter can repair by renaming: a dependency lockfile is the author's, not the project's. Every lockfile ci and the update line recognize (lockfiles.ts) is among them. */
const EXCLUDED_NAMES = new Set([...LOCKFILES.map(([file]) => file), "npm-shrinkwrap.json", "Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock", "go.sum"]);

/** The record folders under .coherence the check reads, the stores whose records are the writer's words; every other folder there is machine-written output (runs, traces, feed cursors). */
const RECORD_FOLDERS = PROSE_STORE_FOLDERS;
const COHERENCE_DIR = ".coherence";

/**
 * Identifiers the language itself owns; a rejected name that is also one of
 * these is not a finding in code, in any case and in the plural: `Promise`,
 * `promise` and `promises` all name the language's thing, not the project's.
 */
const LANGUAGE_GLOBALS = new Set([
  "Promise", "HTMLElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLDetailsElement", "Element", "Document", "Event", "Node", "Object", "Array", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Proxy", "Reflect",
  "Error", "Date", "JSON", "Math", "Intl", "Atomics", "Buffer", "URL", "Request", "Response", "Blob", "Event",
]);

/** Whether a whole identifier is one of the language's own words, whatever its case or number. */
function isLanguageWord(identifier: string): boolean {
  const lower = identifier.toLowerCase();
  return LANGUAGE_WORDS.has(lower) || LANGUAGE_WORDS.has(singular(lower));
}

const LANGUAGE_WORDS: ReadonlySet<string> = new Set([...LANGUAGE_GLOBALS].map((g) => g.toLowerCase()));

/* --------------------------------------------------------------- corpus */

type FileKind = "prose" | "code" | "data" | "record";

export interface CorpusFile {
  path: string;
  rel: string;
  kind: FileKind;
  lines: string[];
}

/** The project-relative path, in the one spelling findings and comparisons use. */
function relPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/**
 * Whether a project-relative path lies outside the config's bounds: under a
 * folder the ignore list names, by the one rule every walk applies
 * (underIgnored). Coherence's own record store is never outside them: an
 * adopter that ignores .coherence keeps its code walks out of the tool's
 * output, and the journal's records are still the project's words.
 */
function outsideBounds(rel: string, ignore: ReadonlySet<string>): boolean {
  if (rel === COHERENCE_DIR || rel.startsWith(COHERENCE_DIR + "/")) return false;
  return underIgnored(rel, ignore);
}

/** Whether a path under .coherence lies outside its record folders: the tool's own output, never the project's words. */
function machineWritten(rel: string): boolean {
  const parts = rel.split("/");
  return parts[0] === COHERENCE_DIR && parts.length >= 2 && !RECORD_FOLDERS.includes(parts[1]!);
}

/** A file's lines as the check numbers them; a record file's are its records, a packed shard's split on the record separator. */
function linesOf(text: string, kind: FileKind): string[] {
  return kind === "record" ? recordTexts(text).map((line) => line.replace(/\r$/, "")) : text.split(/\r?\n/);
}

/** A journal or work record file: one record per line, or per segment in a packed shard, under .coherence. */
function isRecordFile(rel: string): boolean {
  const parts = rel.split("/");
  return parts.length >= 3 && parts[0] === COHERENCE_DIR && RECORD_FOLDERS.includes(parts[1]!) && isStoreFile(parts[parts.length - 1]!);
}

/**
 * What kind of text a file is, or nothing when the check does not read it.
 * A dotfile with no extension (.gitignore, .npmrc) is data: its lines are
 * the project's own words even though no extension says so.
 */
function kindOf(root: string, path: string): FileKind | undefined {
  const rel = relPath(root, path);
  if (isRecordFile(rel)) return "record";
  const base = basename(path);
  if (EXCLUDED_NAMES.has(base)) return undefined;
  const ext = extname(base);
  if (PROSE_EXTENSIONS.has(ext)) return "prose";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (DATA_EXTENSIONS.has(ext)) return "data";
  if (ext === "" && base.startsWith(".") && base.length > 1) return "data";
  return undefined;
}

const OUTSIDE_BOUNDS = "outside the config's bounds: under a folder its ignore list names";

interface Walk {
  root: string;
  /** The config's ignore list: folders outside the adoption's bounds, never entered. */
  ignore: ReadonlySet<string>;
  /** The walk's own rules (exclusionOf), reading hidden folders; the config's ignore list is applied apart, so the record store stays inside it. */
  rules: Bounds;
  found: string[];
  unreadable: UnreadablePath[];
  excluded: UnreadablePath[];
}

/** Why a path could not be read, in the operating system's own words, without the absolute path it already names. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/,?\s*'[^']*'\s*$/, "");
}

/**
 * Descend one folder. A folder the process cannot read is recorded as
 * unreadable and skipped, so one locked path never costs the whole check.
 */
async function walk(dir: string, walker: Walk): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    walker.unreadable.push({ file: relPath(walker.root, dir), reason: reasonOf(error) });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    // Coherence's own machine-written output (runs, traces, a warm server's files) is neither read nor reported: it churns on every run, and a reading whose population moved with it would never build the same page twice.
    if (machineWritten(relPath(walker.root, path))) continue;
    if (entry.isDirectory()) {
      const rule = exclusionOf(relPath(walker.root, path) + "/", walker.rules);
      if (rule !== undefined) { walker.excluded.push({ file: relPath(walker.root, path), reason: rule }); continue; }
      if (outsideBounds(relPath(walker.root, path) + "/", walker.ignore)) { walker.excluded.push({ file: relPath(walker.root, path), reason: OUTSIDE_BOUNDS }); continue; }
      if (existsSync(resolve(path, ".git"))) { walker.excluded.push({ file: relPath(walker.root, path), reason: "a nested checkout: another repository or worktree, not the project's files" }); continue; }
      await walk(path, walker);
    } else if (entry.isFile() && kindOf(walker.root, path) !== undefined) {
      walker.found.push(path);
    } else {
      walker.excluded.push({ file: relPath(walker.root, path), reason: entry.isSymbolicLink() ? "symbolic link not followed" : "unsupported file kind or dependency lockfile" });
    }
  }
}

/** A path outside the project root is never read: an authored path must not reach above the tree it names. */
function confine(root: string, given: string): string {
  const path = resolve(root, given);
  const rel = relative(resolve(root), path);
  if (rel !== "" && (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))) {
    throw new Error(`lexicon check: "${given}" is outside the project root`);
  }
  return path;
}

/**
 * Every file the check reads, with the paths it could not. Excluded: the
 * lexicon files themselves, the two retired inventories, docs/reference
 * and docs/reviews (all written in another vocabulary on purpose),
 * dependency lockfiles, and everything under .coherence that is not a record.
 */
export async function collectFiles(options: CheckOptions): Promise<{ files: string[]; unreadable: UnreadablePath[]; excluded: UnreadablePath[] }> {
  const root = resolve(options.root);
  // The inventories of what the project retired must name what they refuse, exactly as the lexicon does; reading them would report the refusal as the drift.
  const excluded = new Set<string>([resolve(options.coherence.path), resolve(root, "docs", "retired.md"), resolve(root, "src", "spec", "retired-sections.json")]);
  const foreignDocs = [resolve(root, "docs", "reference"), resolve(root, "docs", "reviews")];
  if (options.project !== undefined) excluded.add(resolve(options.project.path));
  const walker: Walk = { root, ignore: new Set(configIgnore(root)), rules: walkBounds(root, [], { readHidden: true }), found: [], unreadable: [], excluded: [] };
  const roots = options.paths === undefined || options.paths.length === 0 ? [root] : options.paths.map((given) => confine(root, given));
  for (const path of roots) {
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      walker.unreadable.push({ file: relPath(root, path), reason: reasonOf(error) });
      continue;
    }
    if (info.isDirectory()) await walk(path, walker);
    else if (info.isFile() && kindOf(root, path) !== undefined) walker.found.push(path);
  }
  // Only the project's own files are vocabulary: tracked or untracked and not ignored, never inside a nested checkout.
  const own = new Set(projectFiles(root));
  const files = [...new Set(walker.found)].filter((p) => {
    if (excluded.has(p)) return false;
    if (!own.has(relPath(root, p))) return false;
    if (outsideBounds(relPath(root, p), walker.ignore)) return false;
    if (foreignDocs.some((d) => p === d || p.startsWith(d + sep))) return false;
    const rel = relPath(root, p);
    if (rel.split("/")[0] === COHERENCE_DIR && !isRecordFile(rel)) return false;
    return exclusionOf(rel, walker.rules) === undefined;
  });
  const kept = new Set(files);
  for (const path of walker.found) {
    if (kept.has(path)) continue;
    const rel = relPath(root, path);
    walker.excluded.push({ file: rel, reason: outsideBounds(rel, walker.ignore) ? OUTSIDE_BOUNDS : own.has(rel) ? "lexicon, reference vocabulary, generated state, or excluded folder" : "not one of the project's files: ignored, or inside a nested checkout" });
  }
  return { files, unreadable: walker.unreadable, excluded: walker.excluded };
}

/** A file whose first bytes carry a NUL byte is binary whatever its name says; the check reads text. */
function isBinary(text: string): boolean {
  return text.slice(0, 8000).includes(NUL);
}

const NUL = String.fromCharCode(0);

/**
 * The corpus, read: every file collectFiles lists, each read through the work
 * meter's door, or only those `only` keeps (a reading scoped to the
 * components an edit wrote in). `listed` is every corpus file's relative
 * path, read or not, so a scoped reading still knows every component.
 */
export async function readCorpus(options: CheckOptions, only?: (rel: string, listed: readonly string[]) => boolean): Promise<{ files: CorpusFile[]; listed: string[]; unreadable: UnreadablePath[]; excluded: UnreadablePath[] }> {
  const root = resolve(options.root);
  const { files, unreadable, excluded } = await collectFiles(options);
  const out: CorpusFile[] = [];
  const listed = files.map((path) => relPath(root, path));
  for (const path of files) {
    if (only !== undefined && !only(relPath(root, path), listed)) continue;
    let text;
    try {
      text = await readProjectTextAsync(path, "corpus");
    } catch (error) {
      unreadable.push({ file: relPath(root, path), reason: reasonOf(error) });
      continue;
    }
    if (isBinary(text)) { excluded.push({ file: relPath(root, path), reason: "binary content" }); continue; }
    out.push({ path, rel: relPath(root, path), kind: kindOf(root, path)!, lines: linesOf(text, kindOf(root, path)!) });
  }
  return { files: out, listed, unreadable, excluded };
}

/**
 * The named files of the corpus, read, without walking it: each kept only
 * when the walk would keep it (its kind, the lexicons, the retired
 * inventories, foreign vocabulary, generated state, an excluded or ignored
 * folder), and read through the work meter's door. The caller has already
 * kept only the project's own files. What an edit's reading reads.
 */
export async function corpusFiles(options: CheckOptions, rels: readonly string[]): Promise<CorpusFile[]> {
  const root = resolve(options.root);
  const excluded = new Set<string>([resolve(options.coherence.path), resolve(root, "docs", "retired.md"), resolve(root, "src", "spec", "retired-sections.json")]);
  if (options.project !== undefined) excluded.add(resolve(options.project.path));
  const foreignDocs = [resolve(root, "docs", "reference"), resolve(root, "docs", "reviews")];
  const ignore = new Set(configIgnore(root));
  const rules = walkBounds(root, [], { readHidden: true });
  const out: CorpusFile[] = [];
  for (const given of rels) {
    const path = resolve(root, given);
    const rel = relPath(root, path);
    if (excluded.has(path) || foreignDocs.some((d) => path === d || path.startsWith(d + sep))) continue;
    if (machineWritten(rel) || (rel.split("/")[0] === COHERENCE_DIR && !isRecordFile(rel))) continue;
    if (outsideBounds(rel, ignore) || exclusionOf(rel, rules) !== undefined) continue;
    const kind = kindOf(root, path);
    if (kind === undefined) continue;
    let text;
    try {
      text = await readProjectTextAsync(path, "corpus");
    } catch {
      continue;
    }
    if (isBinary(text)) continue;
    out.push({ path, rel, kind, lines: linesOf(text, kind) });
  }
  return out;
}

/* ---------------------------------------------------------------- words */

const WORD = "[A-Za-z0-9_]";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** "Auth-Code" and "auth_code" and "auth  code" all normalize to "auth code". */
export function normalizeTerm(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

/** A phrase matcher: whole words, separators of space, underscore or hyphen, an optional English plural. */
function phraseRegex(phrases: string[]): RegExp | undefined {
  if (phrases.length === 0) return undefined;
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  const alternatives = sorted.map((phrase) => {
    const words = phrase.split(/[\s_-]+/).map(escapeRegex);
    const body = words.join("[\\s_-]+");
    const plural = /[a-z]$/i.test(phrase) ? "(?:e?s)?" : "";
    return body + plural;
  });
  return new RegExp(`(?<!${WORD})(?:${alternatives.join("|")})(?!${WORD})`, "gi");
}

/** Find which known phrase a matched text is, allowing for a plural. */
function lookup<T>(text: string, byPhrase: Map<string, T>): T | undefined {
  const key = normalizeTerm(text);
  return byPhrase.get(key) ?? byPhrase.get(singular(key)) ?? byPhrase.get(key.replace(/e?s$/, ""));
}

/** Split an identifier into its words: camelCase, PascalCase, snake_case, SCREAMING_CASE; digits stay with their word. */
export function identifierWords(identifier: string): string[] {
  return identifier
    .split("_")
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase());
}

interface Token {
  word: string;
  start: number;
  end: number;
  /** The whole identifier this word came from, as written. */
  identifier: string;
  /** True when the identifier is a member access (`match.index`): a name the object's API owns, not this project. */
  member: boolean;
}

/** The word tokens of a line of code, in order, with their spans: identifiers split at camelCase and snake_case seams. */
function codeTokens(line: string): Token[] {
  const tokens: Token[] = [];
  for (const match of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const identifier = match[0];
    const member = /\.\s*$/.test(line.slice(0, match.index)) && !/\.\.\.\s*$/.test(line.slice(0, match.index));
    let offset = match.index;
    for (const part of identifier.split("_")) {
      for (const w of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
        if (w !== "") tokens.push({ word: w.toLowerCase(), start: offset, end: offset + w.length, identifier, member });
        offset += w.length;
      }
      offset += 1;
    }
  }
  return tokens;
}

/** The spans of module specifiers on a line of code: `from "node:fs/x"`, `import("x")`, `require("x")`. A module's name is its author's, not this project's. */
function moduleSpecifierSpans(line: string): Span[] {
  const out: Span[] = [];
  for (const match of line.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])([^"'\n]*)\1/g)) {
    const start = match.index + match[0].length - match[2]!.length - 1;
    out.push({ start, end: start + match[2]!.length });
  }
  return out;
}

/** Whether the text between two tokens is nothing but separators, so a phrase may span them. */
function joined(line: string, a: Token, b: Token): boolean {
  return /^[\s_-]*$/.test(line.slice(a.end, b.start));
}

interface Span {
  start: number;
  end: number;
}

function inside(span: Span, spans: Span[]): boolean {
  return spans.some((s) => span.start >= s.start && span.end <= s.end);
}

/** The spans of inline code on a prose line. */
function backtickSpans(line: string): Span[] {
  return [...line.matchAll(/`([^`\n]+)`/g)].map((m) => ({ start: m.index + 1, end: m.index + 1 + m[1]!.length }));
}

/* ---------------------------------------------------------- rejected */

interface NameTable {
  byPhrase: Map<string, RejectedName>;
  /** Names matched anywhere in prose. */
  prose: RegExp | undefined;
  /** Names matched only where prose names an identifier (inside backticks). */
  identifierOnly: RegExp | undefined;
  /** Every name as a word list, for code, longest first. */
  wordLists: { words: string[]; entry: RejectedName }[];
}

function nameTable(names: RejectedName[]): NameTable {
  const byPhrase = new Map<string, RejectedName>();
  for (const entry of names) byPhrase.set(normalizeTerm(entry.name), entry);
  const entries = [...byPhrase.entries()];
  return {
    byPhrase,
    prose: phraseRegex(entries.filter(([, e]) => !e.identifierOnly).map(([p]) => p)),
    identifierOnly: phraseRegex(entries.filter(([, e]) => e.identifierOnly).map(([p]) => p)),
    wordLists: entries.map(([phrase, entry]) => ({ words: phrase.split(" "), entry })).sort((a, b) => b.words.length - a.words.length),
  };
}

interface Guard {
  regex: RegExp | undefined;
  wordLists: { words: string[]; entry: undefined }[];
}

/** Accepted phrases of two or more words: a rejected word inside one is not a finding. */
function guardTable(accepted: Set<string>): Guard {
  const phrases = [...accepted].map(normalizeTerm).filter((p) => p.includes(" "));
  return {
    regex: phraseRegex(phrases),
    wordLists: phrases.map((p) => ({ words: p.split(" "), entry: undefined })).sort((a, b) => b.words.length - a.words.length),
  };
}

/** Match word lists against a token stream; returns the spans of every match. */
function matchWordLists<T>(
  line: string,
  tokens: Token[],
  lists: { words: string[]; entry: T }[],
): { span: Span; entry: T; text: string; identifier: string; member: boolean }[] {
  const out: { span: Span; entry: T; text: string; identifier: string; member: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const { words, entry } of lists) {
      if (i + words.length > tokens.length) continue;
      let ok = true;
      for (let j = 0; j < words.length; j++) {
        const token = tokens[i + j]!;
        const expected = words[j]!;
        const last = j === words.length - 1;
        const wordOk = token.word === expected || (last && singular(token.word) === expected);
        if (!wordOk || (j > 0 && !joined(line, tokens[i + j - 1]!, token))) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const span = { start: tokens[i]!.start, end: tokens[i + words.length - 1]!.end };
        out.push({ span, entry, text: line.slice(span.start, span.end), identifier: tokens[i]!.identifier, member: tokens[i]!.member });
        break;
      }
    }
  }
  return out;
}

/**
 * Rejected names in one line of prose. A name declared for identifiers only
 * counts where the prose names an identifier, which in a .md file means
 * inside backticks; a data file or a record has no such convention, so
 * `identifiersAnywhere` lets its keys and values count as written.
 */
function rejectedInLine(rel: string, line: string, lineNumber: number, names: NameTable, guard: Guard, identifiersAnywhere = false, repair: "edit" | "record" = "edit"): RejectedFinding[] {
  const out: RejectedFinding[] = [];
  const guarded = guard.regex === undefined ? [] : [...line.matchAll(guard.regex)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const code = backtickSpans(line);
  const consider = (regex: RegExp | undefined, onlyInCode: boolean): void => {
    if (regex === undefined) return;
    for (const match of line.matchAll(regex)) {
      const span = { start: match.index, end: match.index + match[0].length };
      if (inside(span, guarded)) continue;
      if (onlyInCode && !inside(span, code)) continue;
      const entry = lookup(match[0], names.byPhrase);
      if (entry === undefined) continue;
      out.push({ file: rel, line: lineNumber, name: entry.name, text: match[0], concept: entry.concept, because: entry.because, repair });
    }
  };
  consider(names.prose, false);
  consider(names.identifierOnly, !identifiersAnywhere);
  return out;
}

function rejectedInProse(file: CorpusFile, names: NameTable, guard: Guard): RejectedFinding[] {
  return file.lines.flatMap((line, i) => rejectedInLine(file.rel, line, i + 1, names, guard));
}

/** A data file is read as the project's own words: keys and values alike, with no backtick convention to hide behind. */
function rejectedInData(file: CorpusFile, names: NameTable, guard: Guard): RejectedFinding[] {
  return file.lines.flatMap((line, i) => rejectedInLine(file.rel, line, i + 1, names, guard, true));
}

/**
 * The fields of a record the writer authored as its own words: those its
 * role table (journal/record.ts) calls prose. A decision's `over` is the name
 * it refused, quoted so the reader can see what drift was turned away: naming
 * it there is the record doing its job, not drift. The bookkeeping a record
 * carries (its id, session, agent, commit, the paths it points at, the state
 * it moved to) is the tool's spelling, not the agent's.
 */
export function recordStrings(value: unknown, out: string[]): void {
  out.push(...recordWords(value, (role) => role === "prose"));
}

/**
 * Rejected names in the journal's own records: one JSONL line per record,
 * checked in the words the writing agent chose. A line that will not parse
 * is left to the journal's own reader to report.
 */
function rejectedInRecord(file: CorpusFile, names: NameTable, guard: Guard): RejectedFinding[] {
  const out: RejectedFinding[] = [];
  file.lines.forEach((line, i) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const texts: string[] = [];
    recordStrings(parsed, texts);
    for (const text of texts) out.push(...rejectedInLine(file.rel, text, i + 1, names, guard, true, "record"));
  });
  return out;
}

function rejectedInCode(file: CorpusFile, names: NameTable, guard: Guard): RejectedFinding[] {
  const out: RejectedFinding[] = [];
  if (names.wordLists.length === 0) return out;
  file.lines.forEach((line, i) => {
    const tokens = codeTokens(line);
    if (tokens.length === 0) return;
    const guarded = [...matchWordLists(line, tokens, guard.wordLists).map((m) => m.span), ...moduleSpecifierSpans(line)];
    for (const hit of matchWordLists(line, tokens, names.wordLists)) {
      if (inside(hit.span, guarded)) continue;
      if (isLanguageWord(hit.identifier) || hit.member) continue;
      out.push({ file: file.rel, line: i + 1, name: hit.entry.name, text: hit.text, concept: hit.entry.concept, because: hit.entry.because, repair: "edit" });
    }
  });
  return out;
}

/**
 * The words of a spec line written in Coherence's grammar rather than the
 * project's: a section heading ("## invariants"), a property key ("because:",
 * "crossing:"), and a checklist's shape with the state word after it
 * ("checklist: input-validation dismissed"). The component's title, a
 * requirement's name, and every sentence are the project's own words.
 */
export function specGrammar(line: string): string {
  const heading = /^#{2,6}\s+(.*)$/.exec(line);
  if (heading !== null) return heading[1]!;
  const key = /^\s+([A-Za-z][A-Za-z -]*):/.exec(line);
  if (key === null) return "";
  const checklist = /^\s+checklist:\s+(\S+)\s+([A-Za-z]+)/.exec(line);
  return checklist === null ? key[1]! : `${key[1]} ${checklist[1]} ${checklist[2]}`;
}

/** Coherence's names in an adopter's spec grammar: advisory, and read only where the spec speaks Coherence's language. */
function rejectedInSpecGrammar(file: CorpusFile, names: NameTable, guard: Guard): RejectedFinding[] {
  return file.lines.flatMap((line, i) => rejectedInLine(file.rel, specGrammar(line), i + 1, names, guard, true));
}

/* ----------------------------------------------------------- unknown */

interface Candidate {
  term: string;
  /** Every place prose used the term as a name. */
  locations: Location[];
}

function nominate(term: string, accepted: Set<string>, rejected: Set<string>): string | undefined {
  const key = normalizeTerm(term);
  if (key.length < 3 || !/[a-z]/.test(key)) return undefined;
  const words = key.split(" ");
  if (words.length > 3) return undefined;
  if (words.some((w) => w.length < 2)) return undefined;
  // A common word is not a name on its own; inside a longer phrase ("durable object") it may be part of one.
  if (words.every((w) => STOPLIST.has(w) || STOPLIST.has(singular(w)))) return undefined;
  const singularForm = [...words.slice(0, -1), singular(words[words.length - 1]!)].join(" ");
  if ([key, singularForm].some((f) => accepted.has(f) || rejected.has(f))) return undefined;
  return key;
}

/**
 * Candidates from one prose line: the proper nouns coverage reads there
 * (nomination.ts), Title Case away from a sentence start, less the tail of an
 * acronym or a model number, words English always capitalizes, and a
 * well-known name in the spelling it is well known in. A backticked word is
 * a code reference or a field, not a name the check asks to define.
 */
function candidatesOnLine(line: string, accepted: Set<string>, rejected: Set<string>, famous: WellKnown): string[] {
  const out: string[] = [];
  for (const n of proseNominations(line, false)) {
    if (!n.proper || isWellKnown(famous, n.term, n.spelling)) continue;
    const term = nominate(n.term, accepted, rejected);
    if (term !== undefined) out.push(term);
  }
  return out;
}

/** The component a file belongs to: the deepest folder holding a spec above it, as coverage assigns one. */
function componentsOf(files: CorpusFile[]): (rel: string) => string {
  const folders = files
    .filter((f) => f.rel.endsWith(".spec.md"))
    .map((f) => dirname(f.rel))
    .sort((a, b) => b.length - a.length);
  return (rel) => folders.find((c) => c === "." || rel.startsWith(c + "/")) ?? "(no declared component)";
}

function acceptedTerms(options: CheckOptions): Set<string> {
  const accepted = new Set<string>();
  for (const g of [options.coherence, options.project]) {
    if (g === undefined) continue;
    for (const name of acceptedNames(g)) accepted.add(normalizeTerm(name));
    for (const concept of g.concepts) {
      for (const entry of concept.notToBeConfusedWith) {
        const lead = normalizeTerm(entry.split(":")[0] ?? "");
        if (lead !== "" && lead.split(" ").length <= 3) accepted.add(lead);
      }
    }
  }
  return accepted;
}

/**
 * A term is counted where prose uses it as a name, not wherever the word
 * occurs: "the Structure view" twice is a name, "evidence" sixty times in
 * ordinary sentences is English. It stands by coverage's recurrence: written
 * as a name on three prose lines, or on two across two components. A
 * component folder's name is not a candidate: its spec defines it.
 */
function unknownNouns(files: CorpusFile[], accepted: Set<string>, rejected: Set<string>, famous: WellKnown): UnknownFinding[] {
  const prose = files.filter((f) => f.kind === "prose");
  const componentOf = componentsOf(files);
  const candidates = new Map<string, Candidate>();
  const add = (term: string, location: Location): void => {
    const existing = candidates.get(term);
    if (existing === undefined) candidates.set(term, { term, locations: [location] });
    else existing.locations.push(location);
  };
  for (const file of prose) {
    let fenced = false;
    let frontMatter = file.lines[0] === "---";
    file.lines.forEach((line, i) => {
      if (frontMatter) {
        if (i > 0 && line === "---") frontMatter = false;
        return;
      }
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced || /^\s*#/.test(line)) return;
      for (const term of candidatesOnLine(line, accepted, rejected, famous)) add(term, { file: file.rel, line: i + 1 });
    });
  }

  const findings: UnknownFinding[] = [];
  for (const candidate of candidates.values()) {
    const lines = new Set(candidate.locations.map((l) => `${l.file}:${l.line}`)).size;
    const spread = new Set(candidate.locations.map((l) => componentOf(l.file))).size;
    if (!(lines >= 3 || (lines >= 2 && spread >= 2))) continue;
    findings.push({
      term: candidate.term,
      count: candidate.locations.length,
      locations: candidate.locations.slice(0, 3),
      options: {
        declare: `add "${candidate.term}" to the lexicon as a concept`,
        map: `add "${candidate.term}" as an alias of an existing concept`,
        fix: `it is a rejected name or a mistake; replace it`,
      },
    });
  }
  findings.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  return findings;
}

/* ------------------------------------------------------------- report */

/** The rejected names in force for a project: both layers, minus Coherence names the project accepts. */
export function rejectedNamesInForce(coherence: Lexicon, project: Lexicon | undefined): { coherence: RejectedName[]; project: RejectedName[] } {
  const names = rejectedNames(coherence);
  if (project === undefined) return { coherence: names, project: [] };
  const projectAccepts = new Set([...acceptedNames(project)].map(normalizeTerm));
  const kept = names.filter((n) => !projectAccepts.has(normalizeTerm(n.name)) && !projectAccepts.has(singular(normalizeTerm(n.name))));
  return { coherence: kept, project: rejectedNames(project) };
}

export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const root = resolve(options.root);
  const { files, unreadable } = await readCorpus(options);
  const own = options.coherenceItself ?? (await isCoherenceItself(root));
  const inForce = rejectedNamesInForce(options.coherence, options.project);
  // In Coherence's own repository its names bind everywhere; in an adopter only the project's names do, and Coherence's are read in the text written to Coherence, advisory there.
  const projectNames = new Set(inForce.project.map((n) => normalizeTerm(n.name)));
  const names = nameTable(own ? [...inForce.coherence, ...inForce.project] : inForce.project);
  const tool = own ? undefined : nameTable(inForce.coherence.filter((n) => !projectNames.has(normalizeTerm(n.name))));
  const accepted = acceptedTerms(options);
  const guard = guardTable(accepted);
  const rejected: RejectedFinding[] = [];
  const advisory = (found: RejectedFinding[]): RejectedFinding[] => found.map((f) => ({ ...f, advisory: true as const }));
  for (const file of files) {
    if (file.kind === "prose") rejected.push(...rejectedInProse(file, names, guard));
    else if (file.kind === "code") rejected.push(...rejectedInCode(file, names, guard));
    else if (file.kind === "data") rejected.push(...rejectedInData(file, names, guard));
    else rejected.push(...rejectedInRecord(file, names, guard));
    if (tool === undefined) continue;
    if (file.kind === "record") rejected.push(...advisory(rejectedInRecord(file, tool, guard)));
    else if (file.rel === CONFIG_FILE) rejected.push(...advisory(rejectedInData(file, tool, guard)));
    else if (file.kind === "prose" && file.rel.endsWith(".spec.md")) rejected.push(...advisory(rejectedInSpecGrammar(file, tool, guard)));
  }
  // A well-known name (Python, Pyright, the project's own name) needs no definition, so it is never an unknown noun.
  const famous = wellKnown(await vocabularyFacts(root), [options.coherence.project, options.project?.project].filter((n): n is string => n !== undefined));
  const everyRejected = new Set([...names.byPhrase.keys(), ...(tool?.byPhrase.keys() ?? [])]);
  const unknown = unknownNouns(files, new Set([...accepted, ...famous.any]), everyRejected, famous);
  const report: CheckReport = { files: files.length, rejected, unknown, unreadable };
  const baseline = own ? undefined : readBaseline(root);
  if (baseline !== undefined) {
    const byFile = new Map(files.map((f) => [f.rel, f.lines]));
    const whole = options.paths === undefined || options.paths.length === 0;
    report.baseline = applyBaseline(report, baseline, (file, line) => byFile.get(file)?.[line - 1] ?? "", whole);
  }
  return report;
}

/**
 * The check a record gets before it is written: the rejected names that bind
 * in the words a record carries, read as the check reads the store (its
 * bookkeeping and the names its over turns away are left alone). The store is
 * append-only, so a name caught here costs a rewording; caught after, it
 * costs a retraction and a second record.
 */
export async function recordVetter(root: string, coherence: Lexicon, project: Lexicon | undefined): Promise<(record: object) => RejectedFinding[]> {
  const own = await isCoherenceItself(root);
  const inForce = rejectedNamesInForce(coherence, project);
  const names = nameTable(own ? [...inForce.coherence, ...inForce.project] : inForce.project);
  const guard = guardTable(acceptedTerms({ root, coherence, project }));
  return (record) => {
    const texts: string[] = [];
    recordStrings(record, texts);
    return texts.flatMap((text) => rejectedInLine("(the new record)", text, 1, names, guard, true, "record"));
  };
}

/** The rejected-name findings that fail the check: editable, binding here, and not in the baseline. */
export function failingRejected(report: CheckReport): RejectedFinding[] {
  return report.rejected.filter((f) => f.repair === "edit" && f.advisory !== true && f.baselined !== true);
}

/** The rejected-name findings in the append-only store that bind here: printed, never failing, since no edit can repair a record. */
function recordedRejected(report: CheckReport): RejectedFinding[] {
  return report.rejected.filter((f) => f.repair === "record" && f.advisory !== true);
}

export function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  for (const f of failingRejected(report)) {
    lines.push(`REJECTED NAME  ${f.file}:${f.line}  "${f.text}"  rejected for ${f.concept}${f.because ? `: ${f.because}` : ""}`);
  }
  for (const f of recordedRejected(report)) {
    lines.push(`RECORDED NAME  ${f.file}:${f.line}  "${f.text}"  rejected for ${f.concept}; the store is append-only, so the repair is a later record, never an edit`);
  }
  const unknown = report.unknown.filter((f) => f.baselined !== true);
  for (const f of unknown) {
    const where = f.locations.map((l) => `${l.file}:${l.line}`).join(", ");
    lines.push(`UNKNOWN NOUN   "${f.term}" (${f.count})  ${where}`);
    lines.push(`               declare: ${f.options.declare} | map: ${f.options.map} | fix: ${f.options.fix}`);
  }
  for (const u of report.unreadable) lines.push(`UNREADABLE     ${u.file}  ${u.reason}`);
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const advisory = report.rejected.filter((f) => f.advisory === true);
  if (advisory.length > 0) {
    const byName = new Map<string, number>();
    for (const f of advisory) byName.set(f.name.toLowerCase(), (byName.get(f.name.toLowerCase()) ?? 0) + 1);
    const top = [...byName].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([n, c]) => `${n} ${c}`).join(", ");
    lines.push(`ADVISORY       ${plural(advisory.length, "Coherence name")} in text written to Coherence (records, spec grammar, ${CONFIG_FILE}): ${top}; reported, never failing, since inside the project its sense wins (--json lists each)`);
  }
  const b = report.baseline;
  if (b !== undefined) {
    const gone = b.gone ? `; ${b.gone} no longer in the text, dropped at the next lexicon baseline` : "";
    lines.push(`BASELINED      ${plural(b.rejected, "rejected name")}, ${plural(b.unknown, "unknown noun")} held since adoption (${b.id}); not failing${gone}`);
  }
  const missed = report.unreadable.length === 0 ? "" : `, ${plural(report.unreadable.length, "unreadable path")}`;
  const inRecords = recordedRejected(report).length;
  const recorded = inRecords === 0 ? "" : `, ${inRecords} in records`;
  lines.push(`${plural(failingRejected(report).length, "rejected name")}, ${plural(unknown.length, "unknown noun")} (${plural(report.files, "file")})${recorded}${missed}`);
  return lines.join("\n") + "\n";
}

/**
 * Whether the check found anything the project can still settle. A path it
 * could not read counts: a corpus it did not see is a verdict it cannot
 * honestly give. A name in the append-only store does not, because no edit
 * can repair a record; nor does an advisory name or a baselined finding.
 */
export function hasFindings(report: CheckReport): boolean {
  return failingRejected(report).length > 0 || report.unknown.some((f) => f.baselined !== true) || report.unreadable.length > 0;
}
