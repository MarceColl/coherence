/**
 * The edit-time alarm for declared mirrors (d-f1ff87d6): a hand list a spec
 * declares under `## mirrors` beside what it must equal, checked at the edit
 * that can break it.
 *
 * A mirror names its list (a top-level literal, by name and file) and what it
 * mirrors: the value-import closure of some files, the keys of an object
 * literal, or another literal's members (spec/grammar.ts). The index maps
 * each watched file to its mirrors: the list's own file, every file in the
 * closure or the partner literal's file, and the declaring spec. It is kept
 * under .coherence/mirrors, built at a session's start and stop from the spec
 * model, and rebuilt at an edit only when the edit wrote a spec or no index
 * is there. An edit that touches no watched file costs one small read and a
 * lookup.
 *
 * At a watched edit, each of its mirrors is read again from the files on
 * disk, without the TypeScript compiler: a regular expression finds the
 * list's declaration, a scan that skips strings and comments finds its
 * literal's top-level members, and another reads value imports, kept per
 * file by size and modification time so only the files that changed are
 * read. A disagreement is said as advice in the hook's context, never a
 * block, and once per session until it changes; a list or a partner that is
 * gone is said too, never skipped.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readProjectText } from "./work-meter.ts";
import { escapeRegExp } from "../enforcement/totality.ts";
import { mirrorRecipeText, type MirrorRecipe } from "../spec/grammar.ts";
import { declaredMirrors, SPEC_SUFFIX, type ModelMirror } from "../spec/model.ts";

/** Where the index and each session's said memory live: transient, regenerated state. */
export const MIRRORS_DIR = join(".coherence", "mirrors");
const INDEX_FILE = join(MIRRORS_DIR, "index.json");
const SHAPE = 1;

/** One declared mirror, as the index keeps it. */
export interface IndexedMirror {
  /** `<component folder>/<NAME> in <file as written>`: what the said memory is keyed by. */
  id: string;
  name: string;
  /** The file as the spec writes it. */
  written: string;
  /** The project-relative file declaring the list, or undefined when it was not found. */
  listFile: string | undefined;
  recipe: MirrorRecipe;
  /** The project-relative files the recipe names, those found. */
  sources: string[];
  spec: string;
  specLine: number;
  meaning: string;
}

export interface MirrorIndex {
  shape: number;
  mirrors: IndexedMirror[];
  /** Project-relative file to the positions in `mirrors` it is watched for. */
  watch: Record<string, number[]>;
  /** The relative value imports of each closure file read, by its size and modification time. */
  imports: Record<string, { stamp: string; imports: string[] }>;
}

// ---------------------------------------------------------------------------
// Reading a literal without the compiler

/** The index just past a string, template or comment opening at `i`, or `i` when none opens there. */
function skipNonCode(text: string, i: number): number {
  const c = text[i];
  if (c === "/" && text[i + 1] === "/") {
    const end = text.indexOf("\n", i);
    return end === -1 ? text.length : end;
  }
  if (c === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (c === '"' || c === "'" || c === "`") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j += 1;
      else if (text[j] === c) return j + 1;
      else if (c !== "`" && text[j] === "\n") return j;
    }
    return text.length;
  }
  return i;
}

/** The text with every comment blanked to spaces (newlines kept), strings untouched. */
export function withoutComments(text: string): string {
  const parts: string[] = [];
  let from = 0;
  // Only a quote or a slash can open what is skipped: jump between them.
  const opener = /["'`/]/g;
  let i = 0;
  while (i < text.length) {
    opener.lastIndex = i;
    const found = opener.exec(text);
    if (found === null) break;
    const at = found.index;
    const next = skipNonCode(text, at);
    if (next === at) {
      i = at + 1;
      continue;
    }
    if (text[at] === "/") {
      parts.push(text.slice(from, at), text.slice(at, next).replace(/[^\n]/g, " "));
      from = next;
    }
    i = next;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/** The top-level segments between the bracket opening at `open` and its match, comments dropped, and the index past the match; undefined when it never closes. */
function segmentsOf(text: string, open: number): { segments: string[]; end: number } | undefined {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  let i = open;
  while (i < text.length) {
    const next = skipNonCode(text, i);
    if (next !== i) {
      if (text[i] !== "/" && depth >= 1) current += text.slice(i, next);
      i = next;
      continue;
    }
    const c = text[i]!;
    if (c === "[" || c === "{" || c === "(") {
      depth += 1;
      if (depth > 1) current += c;
    } else if (c === "]" || c === "}" || c === ")") {
      depth -= 1;
      if (depth === 0) {
        if (current.trim() !== "") segments.push(current.trim());
        return { segments, end: i + 1 };
      }
      current += c;
    } else if (c === "," && depth === 1) {
      segments.push(current.trim());
      current = "";
    } else if (depth >= 1) current += c;
    i += 1;
  }
  return undefined;
}

/** A segment that is one string literal (a template without a substitution counts), less any `as` assertion: its value. */
function stringValue(segment: string): string | undefined {
  const bare = segment.replace(/\s+as\s+[\w$.<>[\], ]+$/, "").trim();
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(bare);
  if (quoted === null) return undefined;
  const body = quoted[2]!;
  if (quoted[1] === "`" && body.includes("${")) return undefined;
  if (new RegExp(`(?<!\\\\)${quoted[1] === "`" ? "`" : quoted[1]}`).test(body)) return undefined;
  return body.replace(/\\(.)/g, "$1");
}

/** A literal's members as the alarm reads them: an array's strings (a tuple by its first), an object's keys; what it cannot read, as written. */
export interface Literal {
  /** The line of the declaration, 1-based. */
  line: number;
  kind: "array" | "object";
  members: string[];
  unread: string[];
}

function arrayMember(segment: string): string | undefined {
  const value = stringValue(segment);
  if (value !== undefined) return value;
  // A tuple counts by its first element: a Map's entries by key, a table's rows by their first column.
  if (segment.startsWith("[")) {
    const inner = segmentsOf(segment, 0);
    return inner === undefined || inner.segments.length === 0 ? undefined : stringValue(inner.segments[0]!);
  }
  return undefined;
}

function objectKey(segment: string): string | undefined {
  if (segment.startsWith("...") || segment.startsWith("[")) return undefined;
  const key = /^(?:(["'])((?:\\.|(?!\1)[^\\])*)\1|([A-Za-z_$][\w$]*)|(\d+))\s*(?::|\(|$)/.exec(segment);
  if (key === null) return undefined;
  return key[2] !== undefined ? key[2].replace(/\\(.)/g, "$1") : (key[3] ?? key[4]);
}

/**
 * The literal a top-level `const`, `let` or `var` named `name` is set to: an
 * array or object literal, reached through calls that wrap one (`new
 * Set([...])`, `Object.freeze({...})`). Undefined when no declaration of that
 * name is set to one.
 */
export function literalOf(text: string, name: string): Literal | undefined {
  const declaration = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${escapeRegExp(name)}\\b`, "m").exec(text);
  if (declaration === null) return undefined;
  const line = text.slice(0, declaration.index).split("\n").length;
  // The = that sets it: past a type annotation (whose braces may hold a ;), never an arrow or a comparison.
  let i = declaration.index + declaration[0].length;
  let braces = 0;
  for (; i < text.length; i++) {
    const next = skipNonCode(text, i);
    if (next !== i) {
      i = next - 1;
      continue;
    }
    const c = text[i];
    if (c === "{") braces += 1;
    else if (c === "}") braces -= 1;
    else if (c === ";" && braces === 0) return undefined;
    else if (c === "=" && braces === 0 && text[i + 1] !== ">" && text[i + 1] !== "=" && !"=!<>".includes(text[i - 1] ?? "")) break;
  }
  if (i >= text.length) return undefined;
  // Past any calls that wrap the literal (new Set(, Object.freeze(, a generic's <...>), comments read as spaces.
  const rest = withoutComments(text.slice(i + 1, i + 1 + 400));
  const wrapper = /^\s*(?:(?:new\s+)?[\w$.]+\s*(?:<[^()]*>)?\s*\(\s*)*/.exec(rest)![0];
  const open = i + 1 + wrapper.length;
  const bracket = rest[wrapper.length];
  if (bracket !== "[" && bracket !== "{") return undefined;
  const parts = segmentsOf(text, open);
  if (parts === undefined) return undefined;
  const kind = bracket === "[" ? "array" : "object";
  const members: string[] = [];
  const unread: string[] = [];
  for (const segment of parts.segments) {
    if (segment === "") continue;
    const member = kind === "array" ? arrayMember(segment) : objectKey(segment);
    if (member === undefined) unread.push(segment.length > 40 ? `${segment.slice(0, 37)}...` : segment);
    else members.push(member);
  }
  return { line, kind, members, unread };
}

// ---------------------------------------------------------------------------
// Value imports and the closure

const CLAUSE = String.raw`(?:[\w$]+\s*,\s*)?(?:\*\s*as\s+[\w$]+|\{[^}]*\}|[\w$]+)`;
const IMPORT_FROM = new RegExp(String.raw`\bimport\s+(type\s+)?(${CLAUSE})\s*from\s*["']([^"'\n]+)["']`, "g");
const EXPORT_FROM = new RegExp(String.raw`\bexport\s+(type\s+)?(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"'\n]+)["']`, "g");
const BARE_IMPORT = /\bimport\s*["']([^"'\n]+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

/** Whether an import clause brings in only types: `type` before it, or braces whose every name is marked type. */
function typeOnly(typeKeyword: string | undefined, clause: string): boolean {
  if (typeKeyword !== undefined) return true;
  const braces = /^\{([^}]*)\}$/.exec(clause.trim());
  if (braces === null) return false;
  const names = braces[1]!.split(",").map((n) => n.trim()).filter((n) => n !== "");
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/** The relative specifiers a module imports for its values: never a type-only import, never a package. */
export function valueImports(text: string): string[] {
  const code = withoutComments(text);
  const found = new Set<string>();
  for (const m of code.matchAll(IMPORT_FROM)) if (!typeOnly(m[1], m[2]!)) found.add(m[3]!);
  for (const m of code.matchAll(EXPORT_FROM)) if (!typeOnly(m[1], m[2]!)) found.add(m[3]!);
  for (const m of code.matchAll(BARE_IMPORT)) found.add(m[1]!);
  for (const m of code.matchAll(DYNAMIC_IMPORT)) found.add(m[1]!);
  return [...found].filter((s) => s.startsWith("./") || s.startsWith("../"));
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The project file a relative specifier names from `from`, trying the TypeScript spellings of a .js name and of none; undefined outside the root or when none exists. */
export function resolveImport(root: string, from: string, specifier: string): string | undefined {
  return existingFile(root, resolve(root, dirname(from), specifier));
}

/** The project file an absolute path names in one of its TypeScript spellings, project-relative; undefined outside the root or when none exists. */
function existingFile(root: string, base: string): string | undefined {
  const script = /\.[cm]?js$/.test(base) ? [base.replace(/\.([cm]?)js$/, ".$1ts"), base.replace(/\.js$/, ".tsx")] : [];
  for (const candidate of [base, ...script, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.js")]) {
    if (!isFile(candidate)) continue;
    const rel = posix(relative(root, candidate));
    return rel.startsWith("../") || rel === ".." ? undefined : rel;
  }
  return undefined;
}

function stampOf(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** A file's resolved value imports, from the kept ones while its size and modification time stand, else read. */
function importsOf(root: string, file: string, kept: MirrorIndex["imports"]): string[] {
  const absolute = resolve(root, file);
  const stamp = stampOf(absolute);
  if (stamp === undefined) return [];
  const held = kept[file];
  if (held !== undefined && held.stamp === stamp) return held.imports;
  const imports = [...new Set(valueImports(readProjectText(absolute, "source")).map((s) => resolveImport(root, file, s)).filter((f): f is string => f !== undefined))].sort();
  kept[file] = { stamp, imports };
  return imports;
}

/** The value-import closure of the starting files, each file with the one that first brought it in. */
export function closureOf(root: string, starts: readonly string[], kept: MirrorIndex["imports"] = {}): Map<string, string | undefined> {
  const reached = new Map<string, string | undefined>(starts.map((file) => [file, undefined]));
  const queue = [...starts];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const imported of importsOf(root, file, kept)) {
      if (reached.has(imported)) continue;
      reached.set(imported, file);
      queue.push(imported);
    }
  }
  return reached;
}

// ---------------------------------------------------------------------------
// The index

function indexPath(root: string): string {
  return join(root, INDEX_FILE);
}

/** The kept index, or undefined when there is none of this shape. */
export function readMirrorIndex(root: string): MirrorIndex | undefined {
  try {
    const index = JSON.parse(readFileSync(indexPath(root), "utf8")) as MirrorIndex;
    return index.shape === SHAPE && Array.isArray(index.mirrors) ? index : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, path);
  } catch {
    // An index that cannot be kept is built again at the next edit that needs it; nothing is lost but time.
  }
}

/** The files each mirror is watched for: the declaring spec, the list's file, and the closure or the partner literal's file. */
function watchedFiles(root: string, mirror: IndexedMirror, kept: MirrorIndex["imports"]): string[] {
  const files = new Set<string>([mirror.spec]);
  if (mirror.listFile !== undefined) files.add(mirror.listFile);
  if (mirror.recipe.kind === "closure") for (const file of closureOf(root, mirror.sources, kept).keys()) files.add(file);
  else for (const file of mirror.sources) files.add(file);
  return [...files];
}

function indexed(mirror: ModelMirror): IndexedMirror | undefined {
  if (mirror.recipe === undefined) return undefined;
  return { id: `${mirror.component}/${mirror.name} in ${mirror.file}`, name: mirror.name, written: mirror.file, listFile: mirror.listFile, recipe: mirror.recipe, sources: mirror.sources, spec: mirror.spec, specLine: mirror.line, meaning: mirror.meaning };
}

/**
 * Build the index from the mirrors the specs declare (the model's, or a light
 * reading of the specs when none is given) and keep it. The kept imports of
 * the last index carry over, so a rebuild reads only the files that changed.
 */
export function keepMirrorIndex(root: string, mirrors?: readonly ModelMirror[]): MirrorIndex {
  const declared = mirrors ?? declaredMirrors(root);
  const kept = readMirrorIndex(root)?.imports ?? {};
  const list: IndexedMirror[] = [];
  const watch: Record<string, number[]> = {};
  for (const mirror of declared) {
    const entry = indexed(mirror);
    if (entry === undefined) continue;
    const at = list.push(entry) - 1;
    for (const file of watchedFiles(root, entry, kept)) (watch[file] ??= []).push(at);
  }
  // Only the files still watched keep their imports.
  const imports: MirrorIndex["imports"] = {};
  for (const file of Object.keys(watch)) if (kept[file] !== undefined) imports[file] = kept[file]!;
  const index: MirrorIndex = { shape: SHAPE, mirrors: list, watch, imports };
  writeJson(indexPath(root), index);
  return index;
}

// ---------------------------------------------------------------------------
// The check at an edit

/** One mirror read now: agreeing (no text), or what disagrees, with a signature that changes when the disagreement does. */
interface Reading {
  id: string;
  text: string;
  signature: string;
}

function quoteList(names: readonly string[], most = 6): string {
  const shown = names.slice(0, most).map((n) => `"${n}"`).join(", ");
  return names.length > most ? `${shown} and ${names.length - most} more` : shown;
}

function declaredAt(mirror: IndexedMirror): string {
  return `declared at ${mirror.spec}:${mirror.specLine}: ${mirror.meaning}`;
}

function readLiteral(root: string, file: string, name: string): { literal: Literal } | { gone: string } {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) return { gone: `${file} is gone` };
  const literal = literalOf(readProjectText(absolute, "source"), name);
  if (literal === undefined) return { gone: `${name} is no longer set to an array or object literal at the top of ${file}` };
  return { literal };
}

/** The list's members as project files: each named relative to the list's folder, or to the root, in a TypeScript spelling; as written when neither exists. */
function memberFiles(root: string, listFile: string, members: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const member of members) {
    const found = [posix(join(dirname(listFile), member)), member].map((candidate) => existingFile(root, resolve(root, candidate))).find((f) => f !== undefined);
    files.set(member, found ?? member);
  }
  return files;
}

function readMirror(root: string, mirror: IndexedMirror, edited: ReadonlySet<string>, kept: MirrorIndex["imports"]): Reading {
  const id = mirror.id;
  const gone = (why: string): Reading => ({ id, signature: `gone:${why}`, text: `Mirror: ${mirror.name} in ${mirror.written} cannot be checked: ${why} (${declaredAt(mirror)}). Remove the mirror once the list is derived, or point it at where the list now is.` });
  if (mirror.listFile === undefined) return gone(`${mirror.name} is not declared at the top of ${mirror.written}`);
  const list = readLiteral(root, mirror.listFile, mirror.name);
  if ("gone" in list) return gone(list.gone);
  const where = `${mirror.name} (${mirror.listFile}:${list.literal.line})`;
  if (list.literal.unread.length > 0) {
    return { id, signature: `unread:${list.literal.unread.join("|")}`, text: `Mirror: ${where} holds what the alarm cannot read as a member (${list.literal.unread.slice(0, 3).join("; ")}), so it compared nothing (${declaredAt(mirror)}).` };
  }
  const recipe = mirror.recipe;
  if (recipe.kind === "closure") {
    if (mirror.sources.length < recipe.files.length) return gone(`the closure's files are not all found (${recipe.files.join(", ")})`);
    const closure = closureOf(root, mirror.sources, kept);
    const named = memberFiles(root, mirror.listFile, list.literal.members);
    const listed = new Set(named.values());
    const missing = [...closure.keys()].filter((file) => !listed.has(file)).sort();
    const extra = [...named.entries()].filter(([, file]) => !closure.has(file)).map(([member]) => member).sort();
    if (missing.length === 0 && extra.length === 0) return { id, signature: "", text: "" };
    const lines: string[] = [];
    for (const file of missing) {
      const importer = closure.get(file);
      const how = importer === undefined ? `the closure starts at ${file}` : `${importer} ${edited.has(importer) ? "now imports" : "imports"} ${file}`;
      lines.push(`Mirror: ${how}, which ${where} does not name: it mirrors the ${mirrorRecipeText(recipe)} (${declaredAt(mirror)}).`);
    }
    if (extra.length > 0) lines.push(`Mirror: ${where} names ${quoteList(extra)}, which the ${mirrorRecipeText(recipe)} no longer reaches (${declaredAt(mirror)}).`);
    return { id, signature: `closure:${missing.join(",")}|${extra.join(",")}`, text: lines.join("\n") };
  }
  const partnerFile = mirror.sources[0];
  if (partnerFile === undefined) return gone(`${recipe.name} is not declared at the top of ${recipe.file}`);
  const partner = readLiteral(root, partnerFile, recipe.name);
  if ("gone" in partner) return gone(partner.gone);
  const there = `${recipe.name} (${partnerFile}:${partner.literal.line})`;
  if (recipe.kind === "keys" && partner.literal.kind !== "object") return gone(`${recipe.name} in ${partnerFile} is not an object literal, so it has no keys to read`);
  if (partner.literal.unread.length > 0) {
    return { id, signature: `unread:${partner.literal.unread.join("|")}`, text: `Mirror: ${there} holds what the alarm cannot read as a member (${partner.literal.unread.slice(0, 3).join("; ")}), so ${where} was compared with nothing (${declaredAt(mirror)}).` };
  }
  const mine = new Set(list.literal.members);
  const theirs = new Set(partner.literal.members);
  const onlyThere = [...theirs].filter((m) => !mine.has(m)).sort();
  const onlyHere = [...mine].filter((m) => !theirs.has(m)).sort();
  if (onlyThere.length === 0 && onlyHere.length === 0) return { id, signature: "", text: "" };
  const parts = [onlyThere.length > 0 ? `${quoteList(onlyThere)} only in ${recipe.kind === "keys" ? `the keys of ${recipe.name}` : recipe.name}` : "", onlyHere.length > 0 ? `${quoteList(onlyHere)} only in ${mirror.name}` : ""].filter((p) => p !== "");
  return { id, signature: `literal:${onlyThere.join(",")}|${onlyHere.join(",")}`, text: `Mirror: ${where} and ${recipe.kind === "keys" ? "the keys of " : ""}${there} no longer agree: ${parts.join("; ")} (${declaredAt(mirror)}).` };
}

function saidPath(root: string, session: string): string {
  return join(root, MIRRORS_DIR, "said", `${session.replace(/[^\w.-]/g, "_")}.json`);
}

function readSaid(root: string, session: string | undefined): Record<string, string> {
  if (session === undefined) return {};
  try {
    return JSON.parse(readFileSync(saidPath(root, session), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** The closing line of every alarm. */
export const MIRROR_ADVICE = "A mirror alarm is advice; the edit stands. Bring the list and what it mirrors back into agreement, or derive the list from what it mirrors and remove the mirror.";

/**
 * The mirror alarm for the files an edit wrote (project-relative): the text
 * to add to the hook's context, and the advance to commit once the host has
 * it, which keeps what was said so the same disagreement is said once per
 * session. Nothing, and one lookup, for an edit no mirror watches.
 */
export function mirrorAlarm(root: string, written: readonly string[], session: string | undefined): { text: string; commit: () => void } {
  const none = { text: "", commit: () => {} };
  if (written.length === 0) return none;
  let index = readMirrorIndex(root);
  // A spec written may have declared, moved or removed a mirror: the light reading of the specs answers again.
  if (index === undefined || written.some((file) => file.endsWith(SPEC_SUFFIX))) {
    try {
      index = keepMirrorIndex(root);
    } catch (error) {
      return { text: `Mirror: the declared mirrors could not be read, so this edit was not checked against them (${error instanceof Error ? error.message : String(error)}).`, commit: () => {} };
    }
  }
  const positions = [...new Set(written.flatMap((file) => index!.watch[file] ?? []))].sort((a, b) => a - b);
  if (positions.length === 0) return none;
  const edited = new Set(written);
  const imports = index.imports;
  const readings = positions.map((at) => readMirror(root, index!.mirrors[at]!, edited, imports));
  // What a closure reaches now is what its mirror is watched for from here on, with the imports just read.
  let moved = false;
  for (const at of positions) {
    const mirror = index.mirrors[at]!;
    if (mirror.recipe.kind !== "closure") continue;
    for (const file of watchedFiles(root, mirror, imports)) {
      const watchers = (index.watch[file] ??= []);
      if (!watchers.includes(at)) {
        watchers.push(at);
        moved = true;
      }
    }
  }
  if (moved || readings.length > 0) writeJson(indexPath(root), index);
  const said = readSaid(root, session);
  const next = { ...said };
  const fresh: string[] = [];
  for (const reading of readings) {
    if (reading.signature === "") {
      delete next[reading.id];
      continue;
    }
    if (said[reading.id] !== reading.signature) fresh.push(reading.text);
    next[reading.id] = reading.signature;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(said);
  const commit = (): void => {
    if (session !== undefined && changed) writeJson(saidPath(root, session), next);
  };
  if (fresh.length === 0) return { text: "", commit };
  return { text: `${fresh.join("\n")}\n${MIRROR_ADVICE}\n`, commit };
}
