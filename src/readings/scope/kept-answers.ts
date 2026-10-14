/**
 * The kept answers: what the language server said to each question a
 * component interface reading asked it (a name resolved to its definition,
 * a definition's reference sites), kept under .coherence/structure beside
 * the recorded reading, so the next reading asks the server only what the
 * tree's changes could have changed.
 *
 * An answer depends on source text and nothing a spec says: which
 * declarations are asked, which component a site belongs to, every
 * entrance's handler, reach, guards and chokepoints are worked out by the
 * reading over the answers, from the specs as they stand. So a spec edit
 * (an entrance declared, a guard: line, a chokepoint) leaves every answer
 * standing, and the reading that follows asks the server only for a
 * question no earlier reading asked, such as a new handler's name.
 *
 * Each language's answers are kept with the content hash of every project
 * file in that language's extensions, as the reading that asked them
 * started. A later reading compares the tree with those hashes, and every
 * file that changed, appeared or went (the changed files) drops each answer
 * that could depend on it: one whose definition, candidates or reference
 * sites sit in a changed file; one whose name (or an alias it is given) a
 * changed file now spells, since a server reports a declaration or a
 * reference only where the text names it; one a changed file star-imports
 * or wildcard re-exports, where no name is spelled; and a default export,
 * imported under any name, on any change at all. What survives is reused
 * without starting the server; what was dropped is asked again. One source
 * edit rereads only what that file touches.
 *
 * What the server's answers rest on beyond the project's source (the
 * project's language configuration, manifests and lockfiles, the config's
 * bounds and test folders, and the adapter's own code and Coherence's
 * version) is the answers' basis: when it differs, nothing kept is used and
 * the reading says why it asks everything again. Kept answers are never
 * used silently: the reading carries how many it reused and asked, and how
 * many files had changed.
 *
 * Node-only; the browser bundle never imports it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Definition, ReferenceSite, ResolveHint, Resolved } from "../../adapters/adapter.ts";
import type { Language } from "../../adapters/index.ts";
import { closureOf } from "../../enforcement/code-fingerprint.ts";
import type { KeptReport } from "./model.ts";
import { goKeptModules } from "./go-scope.ts";
import { pythonKeptModules } from "./python-scope.ts";
import { rustKeptModules } from "./rust-scope.ts";
import { typescriptKeptModules } from "./typescript-scope.ts";

/** Where each language's kept answers live: transient, beside the recorded reading. */
const KEPT_DIR = join(".coherence", "structure");

const KEPT_VERSION = 1;

/** The extensions a server can report a site in or resolve a name to, per language: the files whose change an answer can depend on. */
const KEPT_EXTENSIONS: Record<Language, readonly string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  python: [".py", ".pyi"],
  rust: [".rs"],
  go: [".go"],
};

/** The project files besides source that a server's answers rest on: language configuration, manifests and lockfiles, by base name. */
const BASIS_FILE = /^(?:tsconfig(?:\.[\w-]+)*\.json|jsconfig\.json|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|pyproject\.toml|pyrightconfig\.json|setup\.cfg|uv\.lock|poetry\.lock|requirements[\w.-]*\.txt|go\.mod|go\.sum|go\.work|coherence\.config\.json)$/;

/** Where the language adapters are entered: every module it reaches is code an answer comes from. */
const ADAPTER_ENTRY = "adapters/index.ts";

/**
 * The adapter code an answer comes from, a change to any of which may change
 * any answer: every module the adapters' entry imports, followed to the end,
 * as this installation holds them (the sources in a checkout, the compiled
 * modules in the published package, which ships no sources).
 */
export function adapterCode(): string[] {
  return closureOf([ADAPTER_ENTRY]);
}

const here = dirname(fileURLToPath(import.meta.url));
const COHERENCE_ROOT = resolve(here, "..", "..", "..");

const TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;
/** The module files a changed file star-imports or wildcard re-exports, per language, each language's in its own module: a language with none fails to compile. */
const KEPT_MODULES: Record<Language, (file: string, text: string) => string[]> = {
  typescript: typescriptKeptModules,
  python: pythonKeptModules,
  rust: rustKeptModules,
  go: goKeptModules,
};

/** One kept answer and what it depends on: the files it names and the names that, spelled in a changed file, could change it. */
interface Kept<T> {
  answer: T;
  files: string[];
  spellings: string[];
  /** A default export: imported under any name, so any changed file may reference it. */
  broad?: boolean;
  /** The file whose declarations a star import or wildcard re-export reaches. */
  module?: string;
}

interface KeptFile {
  version: number;
  language: Language;
  basis: Record<string, string>;
  hashes: Record<string, string>;
  resolves: Record<string, Kept<Resolved>>;
  references: Record<string, Kept<ReferenceSite[]>>;
}

function keptPath(root: string, language: Language): string {
  return join(root, KEPT_DIR, `answers-${language}.json`);
}

function digest(text: Buffer | string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The answers' basis: every fact beyond the project's source that a server's answer rests on, each by its content. */
function basisOf(root: string, language: Language, files: readonly string[], ignore: readonly string[], testFolders: readonly string[]): Record<string, string> {
  const basis: Record<string, string> = {};
  basis["kept answers"] = String(KEPT_VERSION);
  basis["language"] = language;
  basis["the config's ignore list"] = digest(JSON.stringify([...ignore]));
  basis["the config's test folders"] = digest(JSON.stringify([...testFolders]));
  let version = "unknown";
  try {
    version = String((JSON.parse(readFileSync(join(COHERENCE_ROOT, "package.json"), "utf8")) as { version?: unknown }).version);
  } catch {
    // An unreadable package.json is one more basis value, never a reason to reuse answers it might have changed.
  }
  basis["Coherence's version"] = version;
  const code = adapterCode();
  // No module found is never an empty basis that holds: the key says so, and differs from any reading that found its code.
  basis["the language adapter's code"] =
    code.length === 0
      ? `unread: no module found from ${ADAPTER_ENTRY}`
      : digest(
          code
            .map((file) => {
              const name = relative(COHERENCE_ROOT, file);
              try {
                return `${name}\u0000${readFileSync(file, "utf8")}`;
              } catch {
                return `${name}: unreadable`;
              }
            })
            .join("\u0000"),
        );
  for (const file of files) {
    if (!BASIS_FILE.test(basename(file))) continue;
    try {
      basis[file] = digest(readFileSync(join(root, file)));
    } catch {
      basis[file] = "unreadable";
    }
  }
  return basis;
}

/** What the basis changed in, in words, or undefined when it holds. */
function basisChange(was: Record<string, string>, now: Record<string, string>): string | undefined {
  const changed = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((key) => was[key] !== now[key]).sort();
  if (changed.length === 0) return undefined;
  const shown = changed.slice(0, 3).join(", ") + (changed.length > 3 ? ` and ${changed.length - 3} more` : "");
  return `what the server's answers rest on changed (${shown})`;
}

/** The files a resolve answer names: its definition's, and each candidate's when it was ambiguous. */
function resolvedFiles(answer: Resolved): string[] {
  if (answer.ok) return [answer.definition.file];
  return (answer.candidates ?? []).map((c) => c.replace(/:\d+(?:\s.*)?$/, ""));
}

/** The key of a resolve question: the name as asked, and the hint that chooses among candidates. */
function resolveKey(query: string, hint: ResolveHint): string {
  return JSON.stringify([query, hint.component, [...hint.testFolders]]);
}

/** The key of a references question: the definition exactly as the server was asked about it. */
function referencesKey(definition: Definition): string {
  return JSON.stringify([definition.file, definition.kind, definition.name, definition.selection.line, definition.selection.character, definition.range.start.line, definition.range.end.line]);
}

/** What the changed files say about the answers: every token they spell now, and every module they star-import or wildcard re-export. */
interface Changes {
  files: Set<string>;
  tokens: Set<string>;
  modules: Set<string>;
}

function changesOf(root: string, language: Language, was: Record<string, string>, now: Record<string, string>): Changes {
  const files = new Set<string>();
  for (const file of new Set([...Object.keys(was), ...Object.keys(now)])) if (was[file] !== now[file]) files.add(file);
  const tokens = new Set<string>();
  const modules = new Set<string>();
  for (const file of files) {
    if (now[file] === undefined) continue;
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const token of text.match(TOKEN) ?? []) tokens.add(token);
    for (const module of KEPT_MODULES[language](file, text)) modules.add(module);
  }
  return { files, tokens, modules };
}

/** Whether a kept answer still holds over the changes: nothing it names changed, no changed file spells it, star-imports its module, or (a default) changed at all. */
function holds(kept: Kept<unknown>, changes: Changes): boolean {
  if (changes.files.size === 0) return true;
  if (kept.broad === true) return false;
  if (kept.files.some((file) => changes.files.has(file))) return false;
  if (kept.spellings.some((name) => changes.tokens.has(name))) return false;
  if (kept.module !== undefined && changes.modules.has(kept.module)) return false;
  return true;
}

/**
 * One language's kept answers for one reading: opened as the reading starts
 * (the tree hashed, the changes since the answers were kept worked out, every
 * answer they could have changed dropped), consulted before each question,
 * and saved, with what the reading asked, when it ends.
 */
export class KeptAnswers {
  private readonly hashes: Record<string, string>;
  private readonly basis: Record<string, string>;
  private readonly resolves = new Map<string, Kept<Resolved>>();
  private readonly references = new Map<string, Kept<ReferenceSite[]>>();
  private reused = 0;
  private asked = 0;
  private readonly changed: number;
  private readonly dropped: number;
  private readonly whole: string | undefined;
  private readonly root: string;
  private readonly language: Language;

  private constructor(root: string, language: Language, files: readonly string[], ignore: readonly string[], testFolders: readonly string[]) {
    this.root = root;
    this.language = language;
    const extensions = KEPT_EXTENSIONS[language];
    this.hashes = {};
    for (const file of files) {
      if (!extensions.some((ext) => file.endsWith(ext))) continue;
      try {
        this.hashes[file] = digest(readFileSync(join(root, file)));
      } catch {
        // A file that cannot be read now is one the tree no longer holds: absent from the hashes, so a kept answer naming it is dropped.
      }
    }
    this.basis = basisOf(root, language, files, ignore, testFolders);
    const loaded = this.load();
    if (typeof loaded === "string") {
      this.whole = loaded;
      this.changed = 0;
      this.dropped = 0;
      return;
    }
    this.whole = undefined;
    const changes = changesOf(root, language, loaded.hashes, this.hashes);
    this.changed = changes.files.size;
    let dropped = 0;
    for (const [key, kept] of Object.entries(loaded.resolves)) {
      if (holds(kept, changes)) this.resolves.set(key, kept);
      else dropped += 1;
    }
    for (const [key, kept] of Object.entries(loaded.references)) {
      if (holds(kept, changes)) this.references.set(key, kept);
      else dropped += 1;
    }
    this.dropped = dropped;
  }

  /** The answers kept for this language, the tree as it is now hashed: `files` is the project's listing the reading walks. */
  static open(root: string, language: Language, files: readonly string[], ignore: readonly string[], testFolders: readonly string[]): KeptAnswers {
    return new KeptAnswers(root, language, files, ignore, testFolders);
  }

  /** The kept file, or why nothing kept is used. */
  private load(): KeptFile | string {
    const path = keptPath(this.root, this.language);
    if (!existsSync(path)) return "no answers were kept for this tree yet";
    let kept: KeptFile;
    try {
      kept = JSON.parse(readFileSync(path, "utf8")) as KeptFile;
    } catch {
      return "the kept answers are unreadable";
    }
    if (kept.version !== KEPT_VERSION || kept.language !== this.language || typeof kept.hashes !== "object" || typeof kept.basis !== "object") return "the kept answers are of another version";
    return basisChange(kept.basis, this.basis) ?? kept;
  }

  /** A kept answer to resolving `query`, or undefined: the reading asks the server. */
  resolved(query: string, hint: ResolveHint): Resolved | undefined {
    const kept = this.resolves.get(resolveKey(query, hint));
    if (kept === undefined) return undefined;
    this.reused += 1;
    return kept.answer;
  }

  /** Keep the server's answer to resolving `query`, which only a declaration spelled `name` can answer. */
  keepResolved(query: string, hint: ResolveHint, answer: Resolved, name: string): void {
    this.asked += 1;
    this.resolves.set(resolveKey(query, hint), { answer, files: resolvedFiles(answer), spellings: [name] });
  }

  /** The kept reference sites of `definition`, or undefined: the reading asks the server. */
  referenced(definition: Definition): ReferenceSite[] | undefined {
    const kept = this.references.get(referencesKey(definition));
    if (kept === undefined) return undefined;
    this.reused += 1;
    return kept.answer;
  }

  /** Keep the server's reference sites of `definition`, spelled as `spellings`; `broad` for a default export. */
  keepReferenced(definition: Definition, sites: ReferenceSite[], spellings: readonly string[], broad: boolean): void {
    this.asked += 1;
    const files = [...new Set([definition.file, ...sites.map((s) => s.file)])].sort();
    this.references.set(referencesKey(definition), { answer: sites, files, spellings: [...new Set(spellings)], module: definition.file, ...(broad ? { broad: true } : {}) });
  }

  /** What this reading did with the kept answers. */
  report(): KeptReport {
    return { reused: this.reused, asked: this.asked, changed: this.changed, dropped: this.dropped, ...(this.whole === undefined ? {} : { whole: this.whole }) };
  }

  /** Keep every answer that still holds and every one this reading asked, against the tree as the reading started. */
  save(): void {
    const kept: KeptFile = {
      version: KEPT_VERSION,
      language: this.language,
      basis: this.basis,
      hashes: this.hashes,
      resolves: Object.fromEntries([...this.resolves].sort(([a], [b]) => a.localeCompare(b))),
      references: Object.fromEntries([...this.references].sort(([a], [b]) => a.localeCompare(b))),
    };
    const path = keptPath(this.root, this.language);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(kept), "utf8");
      renameSync(temporary, path);
    } catch {
      // Answers that cannot be kept only mean the next reading asks the server again.
    }
  }
}

/** The kept answers' report in one line, for the reader who asked for the reading. */
export function keptLine(kept: KeptReport | undefined): string | undefined {
  if (kept === undefined) return undefined;
  if (kept.whole !== undefined) return `kept language-server answers: none from an earlier reading used (${kept.whole}); every question was asked of the server (${kept.asked})`;
  const changed = kept.changed === 0 ? "no source file changed since they were kept" : `${kept.changed} file${kept.changed === 1 ? "" : "s"} changed since they were kept, which dropped ${kept.dropped} answer${kept.dropped === 1 ? "" : "s"}`;
  const unused = kept.unused === undefined ? "" : `; none from an earlier reading used for ${kept.unused.join("; ")}`;
  return `kept language-server answers: ${kept.reused} reused, ${kept.asked} asked anew; ${changed}${unused}`;
}
