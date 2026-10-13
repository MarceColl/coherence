/**
 * The entrances a plain reading of the tree can detect, per language: the
 * surface the declared entrances are measured against (c-3760638e: a gap
 * count alone rewards declaring fewer, coarser entrances, so Structure says
 * how much of the detected surface the declared entrances cover).
 *
 * A scan, never a parse and never a guess presented as fact: each rule is a
 * shape a framework or a runner fixes, few enough to list, and each detected
 * entrance carries the rule and why it matched. Precision over recall: what
 * the rules cannot see is said in NOT_DETECTED, and a surface a project
 * builds its own way (a hand-written dispatcher, a message consumer) is left
 * to its declared entrances. The rule list (CANDIDATE_RULES and
 * NOT_DETECTED) lives in readings/scope/entrance-coverage.ts, which the
 * browser bundle carries, so the view, the query and the spec print one list.
 *
 * Detection reads the spec for one thing only: the symbols declared
 * entrances name as handlers or guards, the wrappers. An export created by
 * calling one is detected, and every detected entrance records which of them
 * its own statement calls (`through`), which is how a grouped entrance
 * ("server function mutations", handled by mutationRpc) is measured against
 * the functions registered through it. The spec's handlers and guards are
 * part of the structure reading's fingerprint, so a detection kept with a
 * reading is current exactly as long as the reading is.
 */

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Language } from "./index.ts";
import { isTestPath } from "./adapter.ts";
import { PYTHON_ENTRANCES } from "./python-entrances.ts";
import { TYPESCRIPT_ENTRANCES } from "./typescript-entrances.ts";

/** One entrance the reading detected in the tree. */
export interface EntranceCandidate {
  /** The project-relative file where it was detected. */
  file: string;
  /** One-based. */
  line: number;
  /**
   * The name a declared entrance's handler would give it: the exported
   * symbol, the registered handler's name, or "" when the file itself is the
   * entrance (a script, a package bin).
   */
  symbol: string;
  /** The rule that detected it, one of the language's CANDIDATE_RULES (entrance-coverage.ts). */
  rule: string;
  /** Why, in words a reader can check against the file. */
  why: string;
  /** Set when the symbol is registered here and declared elsewhere (a route table, a URL pattern): a handler naming it resolves to another file. */
  registered?: true;
  /** The declared entrances' handlers and guards its own statement calls or is decorated with, when any. */
  through?: string[];
}

export interface DetectOptions {
  language: Language;
  /** The bounded project files to read, project-relative. */
  files: readonly string[];
  /** The symbol names declared entrances give as handlers or guards. */
  wrappers: readonly string[];
  testFolders: readonly string[];
  /** Reads a project file; a test stubs it. */
  read?: (file: string) => string | undefined;
}

const RUNNABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs|py)$/;

/** A name as a regular expression that matches it literally, whatever characters it holds. */
export function escape(name: string): string {
  return name.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * What entrance detection knows of one language, each language's in its own
 * module (typescript-entrances.ts, python-entrances.ts): its rules, and the
 * syntax the shared scans below read by. A language ENTRANCE_SYNTAX lacks
 * fails to compile, never reads as another language.
 */
export interface EntranceSyntax {
  /** Whether a project file is code the language's rules read. */
  isCode(file: string): boolean;
  /** Where a definition that starts at `start` reaches its own line: past a Python definition's decorators, the start itself elsewhere. */
  definitionAt(lines: readonly string[], start: number): number;
  /** Whether a line at or left of a statement's indentation still goes on with it: a TypeScript line that closes a bracket or continues a chain. */
  continues(text: string): boolean;
  /** Whether the file imports or declares the name, so a call to it is a call to that symbol and not a namesake. */
  binds(text: string, name: string): boolean;
  /** Whether a decorator naming a wrapper passes through it, as a call does. */
  decorates: boolean;
  /** The entrances the language's rules detect in one code file. */
  candidates(file: string, text: string, wrappers: readonly string[]): EntranceCandidate[];
  /** The entrances the language's own manifest names (pyproject's console scripts), besides package.json's. */
  manifestCandidates(read: (file: string) => string | undefined, exists: (file: string) => boolean): EntranceCandidate[];
  /** The entrance a code file (one isCode accepts) directly under scripts/ or bin/ (`folder`) is, or undefined when the language does not run it as a script. */
  script(file: string, folder: string, read: (file: string) => string | undefined, imported: ReadonlySet<string>): EntranceCandidate | undefined;
  /** Which code files some other one imports: only TypeScript's scripts are told apart by it. */
  importedAmong(code: readonly string[], read: (file: string) => string | undefined): ReadonlySet<string>;
}

/**
 * Each language's entrance detection: one key per language, so a new one is
 * one module and one key here. Read at call time: the language modules import
 * this one's scans, so a table filled at load would read a module that has
 * not run yet whenever a language module is loaded first.
 */
const ENTRANCE_SYNTAX: Record<Language, () => EntranceSyntax> = {
  typescript: () => TYPESCRIPT_ENTRANCES,
  python: () => PYTHON_ENTRANCES,
};

/** The lines of the statement or definition that starts at `start` (zero-based): until the next line at or left of its indentation that begins something new. */
export function spanOf(lines: readonly string[], start: number, syntax: EntranceSyntax): string {
  const indent = /^\s*/.exec(lines[start] ?? "")![0].length;
  // A Python definition begins at its decorators; its body is indented past the def.
  let end = Math.max(start + 1, syntax.definitionAt(lines, start) + 1);
  for (; end < lines.length; end++) {
    const text = lines[end] ?? "";
    if (text.trim() === "") continue;
    const at = /^\s*/.exec(text)![0].length;
    if (at > indent) continue;
    if (syntax.continues(text)) continue;
    break;
  }
  return lines.slice(start, end).join("\n");
}

/** The wrappers a span calls (or, in Python, is decorated with), each bound in its file. */
export function throughOf(span: string, text: string, wrappers: readonly string[], syntax: EntranceSyntax): string[] | undefined {
  const found = wrappers.filter((w) => {
    const n = escape(w);
    const called = new RegExp(`(?<![\\w$])${n}\\s*(?:<[^()<>]*>)?\\s*\\(`).test(span) || (syntax.decorates && new RegExp(`^\\s*@(?:[\\w.]*\\.)?${n}\\b`, "m").test(span));
    return called && syntax.binds(text, w);
  });
  return found.length === 0 ? undefined : found;
}

/** The one-based line of a character offset in the text. */
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** The last identifier of a handler expression: cached(serveOutput) is serveOutput, views.detail is detail, Thing.as_view() is Thing. */
export function handlerName(expression: string): string {
  const inner = /([A-Za-z_$][\w$]*)\s*\)*\s*$/.exec(expression.replace(/\.as_view(?:\s*\([^)]*\))?\s*$/, "").trim());
  return inner?.[1] ?? "";
}

/** The exports a Next.js route file answers requests by, one per HTTP method. */
export const NEXT_ROUTE_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** The exports a Remix route file runs on the server by. */
export const REMIX_ROUTE_EXPORTS: ReadonlySet<string> = new Set(["loader", "action"]);

/* ------------------------------------------------------ runners and scripts */

interface PackageJson {
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
}

const RUNNERS = /^(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+|bunx\s+)?(node|tsx|ts-node|ts-node-esm|bun|deno|vite-node|python3?|uv\s+run)\b/;

/** The project files a script command runs: each segment whose program is a runner, every argument that names a runnable project file. */
function scriptTargets(command: string, exists: (file: string) => boolean): string[] {
  const found: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const trimmed = segment.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
    if (!RUNNERS.test(trimmed)) continue;
    for (const token of trimmed.split(/\s+/).slice(1)) {
      const path = token.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
      if (path.startsWith("-") || !RUNNABLE.test(path) || !exists(path)) continue;
      found.push(path);
    }
  }
  return found;
}

/** Candidates the manifests name: package.json's bin and scripts, pyproject's console scripts. */
function manifestCandidates(files: ReadonlySet<string>, syntax: EntranceSyntax, read: (file: string) => string | undefined, isTest: (file: string) => boolean): EntranceCandidate[] {
  const out: EntranceCandidate[] = [];
  // Only the project's own files inside the bounds: a manifest naming anything else names no entrance here.
  const exists = (file: string): boolean => files.has(posix.normalize(file));
  const pkgText = read("package.json");
  if (pkgText !== undefined) {
    let pkg: PackageJson = {};
    try {
      pkg = JSON.parse(pkgText) as PackageJson;
    } catch {
      pkg = {};
    }
    const bins = typeof pkg.bin === "string" ? { [posix.basename(pkg.bin)]: pkg.bin } : (pkg.bin ?? {});
    for (const [name, target] of Object.entries(bins)) {
      const file = target.replace(/^\.\//, "");
      if (exists(file)) out.push({ file, line: 1, symbol: "", rule: "package bin", why: `package.json's bin "${name}" runs it` });
    }
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      for (const file of scriptTargets(command, exists)) {
        if (isTest(file)) continue;
        out.push({ file, line: 1, symbol: "", rule: "package script", why: `the package script "${name}" runs it` });
      }
    }
  }
  out.push(...syntax.manifestCandidates(read, exists));
  return out;
}

/** Top-level scripts: directly under scripts/ (or bin/, for TypeScript), run rather than imported. */
function scriptCandidates(files: readonly string[], syntax: EntranceSyntax, read: (file: string) => string | undefined, imported: ReadonlySet<string>): EntranceCandidate[] {
  const out: EntranceCandidate[] = [];
  for (const file of files) {
    const match = /^(scripts|bin)\/[^/]+$/.exec(file);
    if (match === null) continue;
    const script = syntax.script(file, match[1]!, read, imported);
    if (script !== undefined) out.push(script);
  }
  return out;
}

/**
 * Every entrance the rules detect in the given files and manifests, sorted by
 * file and line, one per file for file-grain entrances (a script a bin and a
 * package script both run is one entrance, its reasons joined).
 */
export function detectEntranceCandidates(root: string, options: DetectOptions): EntranceCandidate[] {
  const { language, files, testFolders } = options;
  const wrappers = [...new Set(options.wrappers.filter((w) => /^[A-Za-z_$][\w$]*$/.test(w)))].sort();
  const cache = new Map<string, string | undefined>();
  const read = (file: string): string | undefined => {
    if (cache.has(file)) return cache.get(file);
    let text: string | undefined;
    try {
      text = options.read !== undefined ? options.read(file) : readFileSync(join(root, file), "utf8");
    } catch {
      text = undefined;
    }
    cache.set(file, text);
    return text;
  };
  const isTest = (file: string): boolean => isTestPath(file, testFolders);
  const syntax = ENTRANCE_SYNTAX[language]();
  const code = files.filter((f) => !isTest(f) && syntax.isCode(f));
  const found: EntranceCandidate[] = [];
  for (const file of code) {
    const text = read(file);
    if (text === undefined) continue;
    found.push(...syntax.candidates(file, text, wrappers));
  }
  const fileGrain = [...manifestCandidates(new Set(files), syntax, read, isTest), ...scriptCandidates(code, syntax, read, syntax.importedAmong(code, read))];
  const byFile = new Map<string, EntranceCandidate>();
  for (const c of fileGrain) {
    if (c.symbol !== "") {
      found.push(c);
      continue;
    }
    const known = byFile.get(c.file);
    if (known === undefined) byFile.set(c.file, c);
    else if (!known.why.includes(c.why)) known.why = `${known.why}; ${c.why}`;
  }
  for (const c of byFile.values()) {
    const text = read(c.file);
    const through = text === undefined ? undefined : throughOf(text, text, wrappers, syntax);
    found.push(through === undefined ? c : { ...c, through });
  }
  // A symbol a rule detects in a file is one entrance, whichever rules saw it.
  const seen = new Set<string>();
  return found
    .filter((c) => {
      const key = `${c.file}\u0000${c.symbol}\u0000${c.symbol === "" || c.registered ? c.line : ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.symbol.localeCompare(b.symbol));
}
