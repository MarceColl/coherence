/**
 * The reading of every component interface: the set of resolved references
 * from one component to another, taken through the language adapter.
 *
 * The reading is bounded to the declared components. The code it reads is
 * the component code: every non-test source file the config's bounds keep
 * (its ignore list, and the folders no walk enters) whose nearest spec
 * folder is a component, each file belonging to that nearest component only,
 * so the root component holds the bounded files no deeper component claims
 * and never the whole tree below it. Only a declaration in component code is
 * ever asked about. A reference site counts toward an interface when it
 * sits in component code of another component. A site inside the bounds in
 * code no component owns is outside: counted per callee component and said,
 * never drawn and never silently dropped. Code past the config's bounds is
 * not the project's by the adopter's own word, so a site there is never
 * counted, and the server the reading starts for itself (a Python one) is
 * bounded the same way, which is what makes a monorepo readable: a
 * references query scans every workspace file that spells the name, and on
 * a whole monorepo one common name costs gigabytes.
 *
 * Before the server is asked, one word index is built over the component
 * code, once per reading: every identifier token of every file, with the
 * components whose files spell it. An exported declaration is asked for its
 * references only when a file of another component spells its name, or a
 * name it is aliased to, or a whole-module import or re-export there names
 * its file, or it is a default export. That is sound, not a heuristic: the
 * server reports a reference only where the text names the thing, so a name
 * no other component's text spells cannot have a site there. The escape
 * hatches are handled, not assumed away: a star import (`from x import *`)
 * or a wildcard re-export (`export * from`) spells no name and the adapters
 * report a site at it for every declaration of the module, so every
 * declaration of a module another component star-imports is asked; an alias
 * (`import a as b`, `export { a as b }`) extends the name to its aliases,
 * wherever the alias is written, so a caller that spells only the alias is
 * still found; a default export is imported under any name, so it is always
 * asked; `__all__` lists and `getattr` strings are tokens like any other,
 * since the index reads strings and comments too. Aliases are read over the
 * component code, where every site that counts sits.
 *
 * Each entrance's handler is resolved the same way, with its static reach:
 * the declarations its code references and every one those reference,
 * through value references only, and the component interfaces that reach
 * uses. The reach needs a component's own references too, which the word
 * index cannot rule out, so it is read to a fixed point: a declaration is
 * asked for the reach when a file the reach has already entered spells it
 * (its name or an alias), since a reference enclosed by a reached
 * declaration sits in that declaration's file. A private declaration is
 * resolved only for the reach: it is referenced from its own file and is
 * never an interface. A handler named as a module file starts from the
 * module's top-level script: every declaration of the file, and every
 * reference its top-level statements make (an import is not a use).
 *
 * Each entrance's reach is then read for the chokepoints it passes
 * (d-127ab8e4): one whose protected thing the reach reaches, marked a wrapper
 * when the handler's own declaration references the chokepoint, and one its
 * guard: line declares, confirmed when a reference to the handler at its
 * registration spells the guard. The Structure map counts only verified ones.
 *
 * The reading is bounded in time and in the language server's memory. When
 * either budget is spent it stops asking, keeps what it read, and says it is
 * partial, which budget stopped it, and whose declarations were not all
 * read; a partial map is never presented as complete.
 *
 * The reading itself is not stored here: the builder passes it into the
 * page state, and every list is sorted, so one tree reads the same every
 * time. What is kept is each answer the language server gave (kept-answers.ts),
 * which depends on source text and never on a spec: a later reading reuses
 * every answer no changed file could have changed, starts the server only
 * for a question none answers, and works out every component interface,
 * handler, reach, guard and chokepoint again from the specs as they stand.
 * The adapter is started in this process and never writes into the tree it
 * reads, so a read-only project can be read.
 *
 * This is Node-only; the browser bundle never imports it.
 */

import { execFile } from "../../lifecycle/work-meter.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { statementStartLine, type Definition, type LanguageAdapter, type ReferenceSite, type ResolveHint, type Resolved } from "../../adapters/adapter.ts";
import { detectEntranceCandidates, type EntranceCandidate } from "../../adapters/entrance-candidates.ts";
import { configIgnore, exclusionOf, projectFiles, projectListing, projectSites, walkBounds, type Bounds } from "../../adapters/project-files.ts";
import { configRecord } from "../../adapters/project-config.ts";
import { adapterFor, type Language } from "../../adapters/index.ts";
import { componentOf, declarationsOf, isSourceFile, isTest } from "../../economy/source.ts";
import { languageOfFile, readEnforcementConfig } from "../../enforcement/config.ts";
import { KeptAnswers } from "./kept-answers.ts";
import { languagesRead, notScannedYet } from "./languages-read.ts";
import { isModuleHandler } from "../../spec/grammar.ts";
import { declaresAtTop, loadSpecModel, type SpecModel } from "../../spec/model.ts";
import type { EntranceGuard, EntranceResolution, InterfaceReading, InterfaceSymbol, KeptReport, ReachReference, ScopedReading } from "./model.ts";
import { PYTHON_INTERFACES } from "./python-scope.ts";
import { RUST_INTERFACES } from "./rust-scope.ts";
import { TYPESCRIPT_INTERFACES } from "./typescript-scope.ts";

/**
 * What the reading knows of one language's syntax without its server, each
 * language's in its own module (typescript-scope.ts, python-scope.ts, rust-scope.ts): a
 * language INTERFACE_SYNTAX lacks fails to compile, never reads as another
 * language.
 */
export interface InterfaceSyntax {
  /** Whether a declaration line declares a type only (an interface or a type alias). */
  isTypeDeclaration(line: string): boolean;
  /** Whether a declaration line is its module's default export. */
  isDefaultExport(line: string): boolean;
  /** Whether the language's server narrows to bounds, so a reader that keeps one warm starts a bounded one of its own. */
  serverBounds: boolean;
  /** The import and export lists a file's text holds, each the text its `original as alias` renames are read from. */
  importLists(text: string): string[];
  /** The names a file's text exports as a default by name. */
  defaultNames(text: string): string[];
  /** The module files a file star-imports or wildcard re-exports, in every spelling the word index keys them by. */
  wildcardModules(file: string, text: string): string[];
}

/** Each language's syntax for the reading: one key per language, so a new one is one module and one key here. */
const INTERFACE_SYNTAX: Record<Language, InterfaceSyntax> = {
  typescript: TYPESCRIPT_INTERFACES,
  python: PYTHON_INTERFACES,
  rust: RUST_INTERFACES,
};

/** Whether a declaration line declares a type only (an interface or a type alias): a route never follows one. */
export function isTypeDeclaration(line: string, language: Language): boolean {
  return INTERFACE_SYNTAX[language].isTypeDeclaration(line);
}

interface ReachNode {
  component: string;
  name: string;
  file: string;
  type: boolean;
}

/** The nodes a handler's static reach enters: the start and every value declaration reached from it. */
function reachedFrom(start: string, nodes: ReadonlyMap<string, ReachNode>, calls: ReadonlyMap<string, ReadonlyMap<string, number>>): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const to of (calls.get(at) ?? new Map<string, number>()).keys()) {
      const target = nodes.get(to);
      if (target === undefined || target.type || seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

/**
 * A handler's static reach: every declaration its code references, and every
 * one those reference, through value references only (a type is never
 * followed), and the component interfaces that reach uses: each reference
 * from a reached declaration into another component's value declaration.
 */
export function reachOf(start: string, nodes: ReadonlyMap<string, ReachNode>, calls: ReadonlyMap<string, ReadonlyMap<string, number>>): ReachReference[] {
  const seen = new Set([start]);
  const queue = [start];
  const used = new Map<string, ReachReference>();
  while (queue.length > 0) {
    const at = queue.shift()!;
    const from = nodes.get(at);
    for (const [to, sites] of calls.get(at) ?? []) {
      const target = nodes.get(to);
      if (target === undefined || target.type) continue;
      if (from !== undefined && target.component !== from.component) {
        const key = `${from.component}\u0000${target.component}\u0000${target.name}\u0000${target.file}`;
        const known = used.get(key);
        if (known === undefined) used.set(key, { from: from.component, to: target.component, symbol: target.name, file: target.file, sites });
        else known.sites += sites;
      }
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return [...used.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.symbol.localeCompare(b.symbol) || a.file.localeCompare(b.file));
}

/** A spec value as a symbol and an optional file, or a module file; undefined for prose. */
function namedValue(value: string): { symbol?: string; file?: string } | undefined {
  const named = /^([A-Za-z_$][\w$]*)(?:\s+in\s+(\S+))?$/.exec(value.trim());
  if (named !== null) return named[2] === undefined ? { symbol: named[1]! } : { symbol: named[1]!, file: named[2]! };
  if (isModuleHandler(value)) return { file: value.trim() };
  return undefined;
}

/** Whether a reach node is the named thing: the symbol (in the named file, relative to its component or the root), or any declaration of a named module. */
function nodeIs(node: ReachNode, named: { symbol?: string; file?: string }, folder: string): boolean {
  const inFile = named.file === undefined || node.file === named.file || node.file === `${folder}/${named.file}` || node.file.endsWith(`/${named.file}`);
  return named.symbol === undefined ? inFile && node.name !== "" : node.name === named.symbol && inFile;
}

interface ChokepointTarget {
  component: string;
  name: string;
  chokepoint: { symbol?: string; file?: string };
  protects: { symbol?: string; file?: string };
}

/** Every chokepoint an invariant declares, with its protected thing, as reach nodes can be matched against. */
function chokepointTargets(model: SpecModel): ChokepointTarget[] {
  return model.components.flatMap((component) =>
    component.invariants.flatMap((invariant) =>
      invariant.enforcements.flatMap((e): ChokepointTarget[] => {
        if (e.form !== "chokepoint") return [];
        const chokepoint = namedValue(e.chokepoint);
        const protects = namedValue(e.protects);
        return chokepoint === undefined || protects === undefined ? [] : [{ component: component.folder, name: invariant.name, chokepoint, protects }];
      }),
    ),
  );
}

/**
 * The chokepoints a handler's reach passes (see the file comment): each whose
 * protected thing the reach reaches, a wrapper when the handler's own
 * declaration references the chokepoint directly.
 */
export function guardsOf(start: string, nodes: ReadonlyMap<string, ReachNode>, calls: ReadonlyMap<string, ReadonlyMap<string, number>>, targets: readonly ChokepointTarget[]): EntranceGuard[] {
  const reached = [...reachedFrom(start, nodes, calls)].map((id) => nodes.get(id)).filter((n): n is ReachNode => n !== undefined);
  const direct = [...(calls.get(start) ?? new Map<string, number>()).keys()].map((id) => nodes.get(id)).filter((n): n is ReachNode => n !== undefined);
  const guards: EntranceGuard[] = [];
  for (const target of targets) {
    if (!reached.some((node) => nodeIs(node, target.protects, target.component))) continue;
    const wrapped = direct.some((node) => nodeIs(node, target.chokepoint, target.component));
    guards.push({ component: target.component, name: target.name, how: wrapped ? "wrapper" : "reach" });
  }
  return guards;
}

/* ------------------------------------------------------------ the bounds */

/** The extensions a language server can report a reference site in; a site in any of them is component code when it lies in a component. */
const SITE_EXTENSIONS: Record<Language, readonly string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  python: [".py", ".pyi"],
  rust: [".rs"],
};

/** Whether a project-relative file lies inside the bounds: no rule of the walk (exclusionOf) leaves it out. */
export function withinBounds(file: string, skip: Bounds): boolean {
  return exclusionOf(file, skip) === undefined;
}

/** The adapter the reading starts for itself: bounded to the config's ignore list, when it names one and the language's server can be bounded. */
function boundedAdapter(language: Language, root: string, ignore: readonly string[], memoryMB: number): LanguageAdapter {
  // The server's heap sits above the reading's memory budget, so the budget stops the reading before the heap limit ends the server.
  return ignore.length === 0 ? adapterFor(language, root) : adapterFor(language, root, { exclude: ignore, heapMB: memoryMB + HEAP_HEADROOM_MB });
}

/** How far the bounded server's heap ceiling sits above the reading's memory budget. */
export const HEAP_HEADROOM_MB = 2048;

/**
 * A server of its own for a reader that keeps one warm (the live Scope
 * server) and would otherwise read through its whole-workspace instrument:
 * a bounded adapter, with the bounds it was made for, when the language's
 * server narrows to bounds (Python) and the config names any; undefined
 * when the shared instrument reads the same (TypeScript's server reads its
 * tsconfig's project either way, and no bounds means the whole workspace).
 */
export function interfaceAdapter(root: string, language: Language): { adapter: LanguageAdapter; bounds: string } | undefined {
  const ignore = configIgnore(root);
  if (!INTERFACE_SYNTAX[language].serverBounds || ignore.length === 0) return undefined;
  return { adapter: boundedAdapter(language, root, ignore, configuredBudget(root).memoryMB), bounds: ignore.join("\n") };
}

/** The bounds interfaceAdapter would build for the root now, to tell when a kept one is stale. */
export function interfaceBounds(root: string): string {
  return configIgnore(root).join("\n");
}

/** The bounds of the reading's walk: the config's ignore list and the walk's own rules (walkBounds). */
export function boundsOf(root: string, ignore: readonly string[]): Bounds {
  return walkBounds(root, ignore);
}

/**
 * The component a file's code belongs to for this reading: its nearest
 * component, when it is a non-test file of the language inside the config's
 * bounds; otherwise undefined, and a reference site there is outside.
 */
function componentCodeOf(model: SpecModel, file: string, language: Language, skip: Bounds, testFolders: readonly string[]): string | undefined {
  if (!SITE_EXTENSIONS[language].some((ext) => file.endsWith(ext)) || isTest(file, testFolders) || !withinBounds(file, skip)) return undefined;
  return componentOf(model, file)?.folder;
}

/* ------------------------------------------------------- the word index */

const TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const ALIAS = /([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g;

/**
 * What the prefilter knows about the component code's text: which
 * components' files spell each token, which files (by index) spell it, the
 * aliases each name is given, the names exported as a default, and the
 * files some component star-imports or wildcard re-exports with the
 * components that do.
 */
export interface WordIndex {
  files: string[];
  /** token -> the components whose files spell it. */
  owners: Map<string, Set<string>>;
  /** token -> the indexes (into files) of the files that spell it, with how many times each does. */
  where: Map<string, Map<number, number>>;
  /** name -> every name it is aliased to, transitively. */
  aliases: Map<string, Set<string>>;
  /** Names exported as a default, imported under any name. */
  defaults: Set<string>;
  /** A module file -> the components whose files import or re-export it whole. */
  wildcards: Map<string, Set<string>>;
}

/** The word index over the component code, each file with the component it belongs to. */
export function wordIndex(root: string, code: ReadonlyMap<string, string>, language: Language, read: (file: string) => string = (file) => readFileSync(join(root, file), "utf8")): WordIndex {
  const files = [...code.keys()].sort();
  const syntax = INTERFACE_SYNTAX[language];
  const owners = new Map<string, Set<string>>();
  const where = new Map<string, Map<number, number>>();
  const direct = new Map<string, Set<string>>();
  const defaults = new Set<string>();
  const wildcards = new Map<string, Set<string>>();
  const add = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
    const set = map.get(key) ?? new Set<V>();
    set.add(value);
    map.set(key, set);
  };
  // An import list's renames: `original as alias`, a default import kept apart.
  const aliasesIn = (list: string): void => {
    for (const [, original, alias] of list.matchAll(ALIAS)) {
      if (alias === "default") defaults.add(original!);
      else add(direct, original!, alias!);
    }
  };
  files.forEach((file, index) => {
    const owner = code.get(file)!;
    let text: string;
    try {
      text = read(file);
    } catch {
      return;
    }
    const counts = new Map<string, number>();
    for (const token of text.match(TOKEN) ?? []) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, count] of counts) {
      add(owners, token, owner);
      const files = where.get(token) ?? new Map<number, number>();
      files.set(index, count);
      where.set(token, files);
    }
    for (const list of syntax.importLists(text)) aliasesIn(list);
    for (const name of syntax.defaultNames(text)) defaults.add(name);
    for (const module of syntax.wildcardModules(file, text)) add(wildcards, module, owner);
  });
  // Every name an alias chain reaches, so a caller that spells only the last alias still counts.
  const aliases = new Map<string, Set<string>>();
  for (const name of direct.keys()) {
    const reached = new Set<string>();
    const queue = [name];
    while (queue.length > 0) {
      for (const next of direct.get(queue.shift()!) ?? []) {
        if (next === name || reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    aliases.set(name, reached);
  }
  return { files, owners, where, aliases, defaults, wildcards };
}

/** The spellings a declaration can be referenced by: its name and every alias it is given. */
function spellings(index: WordIndex, name: string): string[] {
  return [name, ...(index.aliases.get(name) ?? [])];
}

/**
 * Whether component code of a component other than `owner` could hold a
 * reference to the declaration: it spells the name or an alias, it
 * star-imports or wildcard re-exports the declaration's file, or the
 * declaration is a default export.
 */
export function namedElsewhere(index: WordIndex, name: string, file: string, owner: string, isDefault: boolean): boolean {
  if (isDefault || index.defaults.has(name)) return true;
  for (const component of index.wildcards.get(file) ?? []) if (component !== owner) return true;
  for (const spelling of spellings(index, name)) {
    for (const component of index.owners.get(spelling) ?? []) if (component !== owner) return true;
  }
  return false;
}

/**
 * Whether a file the reach has entered spells the declaration (its name or
 * an alias) somewhere other than where it is declared, or it is a default
 * export. The declaring file always spells the name once, at the
 * declaration, which the server never reports as a reference.
 */
function namedIn(index: WordIndex, name: string, own: number | undefined, entered: ReadonlySet<number>, isDefault: boolean): boolean {
  if (isDefault || index.defaults.has(name)) return true;
  for (const spelling of spellings(index, name)) {
    for (const [at, count] of index.where.get(spelling) ?? []) if (entered.has(at) && (at !== own || spelling !== name || count > 1)) return true;
  }
  return false;
}

/* ------------------------------------------------------------- the budget */

/** How much the reading may spend: wall time, and the resident memory of the language server it asks. */
export interface InterfaceBudget {
  seconds: number;
  memoryMB: number;
}

/**
 * The default budget. Ten minutes is the totality oracle's own ceiling
 * (TOTALITY_TIMEOUT_MS) and some forty times what Coherence's own reading
 * takes warm, so a reading that has not finished by then is stuck, not slow.
 * Twelve gigabytes: on a full PostHog checkout Pyright type-checks the real
 * imports and sat pinned at its default ~4 GB Node heap, so the owner
 * ruled (2026-09-23) a bigger heap over a sparse view of the bounded files;
 * the bounded server's heap is raised to the budget plus HEAP_HEADROOM_MB so
 * the budget, not the heap limit, stops the reading. The development
 * machines are Apple Silicon with 48 GB.
 */
export const DEFAULT_INTERFACE_BUDGET: InterfaceBudget = { seconds: 600, memoryMB: 12288 };

/** The config key that overrides the budget: `"interfaceBudget": { "seconds": 600, "memoryMB": 12288 }`. */
export const BUDGET_KEY = "interfaceBudget";

/** The budget the config sets, each part falling back to the default. */
export function configuredBudget(root: string): InterfaceBudget {
  const budget = { ...DEFAULT_INTERFACE_BUDGET };
  try {
    const value = configRecord(root)[BUDGET_KEY];
    if (typeof value !== "object" || value === null) return budget;
    const { seconds, memoryMB } = value as Record<string, unknown>;
    if (typeof seconds === "number" && seconds > 0) budget.seconds = seconds;
    if (typeof memoryMB === "number" && memoryMB > 0) budget.memoryMB = memoryMB;
  } catch {
    // A malformed config is the spec walker's to refuse; the reading keeps the default.
  }
  return budget;
}

/** Each flag that overrides the budget for one reading, the budget key it sets, and its value as usage names it. */
const BUDGET_FLAG_TABLE = [
  { flag: "interface-seconds", key: "seconds", value: "<n>" },
  { flag: "interface-memory", key: "memoryMB", value: "<MB>" },
] as const satisfies readonly { flag: string; key: keyof InterfaceBudget; value: string }[];

/** The budget flags' names, as every command that takes them parses them. */
export const BUDGET_FLAG_NAMES: readonly string[] = BUDGET_FLAG_TABLE.map((f) => f.flag);

/** The flags that override the budget for one reading, as the scope, query and scaffold commands' usage writes them. */
export const BUDGET_FLAGS = BUDGET_FLAG_TABLE.map((f) => `[--${f.flag} ${f.value}]`).join(" ");

/** The budget the budget flags give, or why a value is refused. */
export function budgetFlags(values: ReadonlyMap<string, string>): Partial<InterfaceBudget> | string {
  const budget: Partial<InterfaceBudget> = {};
  for (const { flag, key } of BUDGET_FLAG_TABLE) {
    const value = values.get(flag);
    if (value === undefined) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return `--${flag} takes a positive number, not "${value}"`;
    budget[key] = n;
  }
  return budget;
}

/** A process that is a language server by its command line. */
const LANGUAGE_SERVER = /pyright|langserver|tsserver|typescript-language-server|rust-analyzer/;

/**
 * The resident memory, in megabytes, of the language server the reading
 * asks: the process `pid` and every process it started, when the adapter
 * names its server; otherwise every language server this process started,
 * found by command line among its descendants (a test runner the warm
 * server spawned is a descendant too, and is never counted). Undefined when
 * `ps` cannot answer.
 */
export function languageServerMemory(pid?: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,rss=,args="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) return resolve(undefined);
      const rows = stdout.split("\n").flatMap((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return m === null ? [] : [{ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), args: m[4]! }];
      });
      const children = new Map<number, typeof rows>();
      for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
      let kb = 0;
      const walk = (pid: number, counted: boolean): void => {
        for (const child of children.get(pid) ?? []) {
          const server = counted || LANGUAGE_SERVER.test(child.args);
          if (server) kb += child.rss;
          walk(child.pid, server);
        }
      };
      const own = pid === undefined ? undefined : rows.find((row) => row.pid === pid);
      if (own !== undefined) {
        kb += own.rss;
        walk(own.pid, true);
      } else walk(process.pid, false);
      resolve(Math.round(kb / 1024));
    });
  });
}

export interface ReadOptions {
  /** The budget; each part given overrides the config's, which overrides the default. */
  budget?: Partial<InterfaceBudget>;
  /** Ask every declaration, as before the word index: the reading the prefilter is checked against. */
  exhaustive?: boolean;
  /** The language server's memory in megabytes (default: languageServerMemory); a test stubs it. */
  memory?: () => Promise<number | undefined>;
  /** How often memory is sampled, in milliseconds (default 2000). */
  sampleMs?: number;
  /**
   * Read only what these entrances' routes need (see readComponentInterfaces):
   * the reading carries `scoped` and is never the tree's reading. Absent: whole.
   */
  scope?: { entrances: readonly { component: string; name: string }[] };
  /** Reuse and keep the language server's answers (kept-answers.ts); false asks the server every question and keeps nothing. Default true. */
  keep?: boolean;
}

const STOPPED = Symbol("stopped");

/* ------------------------------------------------------------ the reading */

interface Declared extends ReachNode {
  id: string;
  exported: boolean;
  isDefault: boolean;
}

/** The symbol names declared entrances give as their handlers and guards: what an entrance may be created or registered through. */
export function entranceWrappers(model: Pick<SpecModel, "components">): string[] {
  const names = model.components.flatMap((c) => c.entrances.flatMap((e) => [e.handler, e.guard]));
  return [...new Set(names.flatMap((v) => (v === undefined || isModuleHandler(v) ? [] : [/^([A-Za-z_$][\w$]*)/.exec(v.trim())?.[1] ?? ""]).filter((n) => n !== "")))].sort();
}

/**
 * The entrances the language's rules detect inside the config's bounds, test
 * files excepted, kept with the reading so Structure, the query and orient
 * measure the declared entrances against the same set (c-3760638e). A plain
 * scan: it asks the language server nothing and costs a read of the tree.
 */
export function detectedEntrances(root: string, model: Pick<SpecModel, "components">, languages: Language | readonly Language[], testFolders: readonly string[], ignore: readonly string[] = configIgnore(root)): EntranceCandidate[] {
  const skip = boundsOf(root, ignore);
  const files = projectFiles(root).filter((file) => withinBounds(file, skip));
  const wrappers = entranceWrappers(model);
  const each = typeof languages === "string" ? [languages] : languages;
  // Every declared language's rules, each over its own files and manifests: a backend's views and a frontend's routes alike.
  if (each.length === 1) return detectEntranceCandidates(root, { language: each[0]!, files, wrappers, testFolders });
  const seen = new Set<string>();
  return each
    .flatMap((language) => detectEntranceCandidates(root, { language, files, wrappers, testFolders }))
    .filter((c) => {
      const key = `${c.file}\u0000${c.line}\u0000${c.symbol}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.symbol.localeCompare(b.symbol));
}

/** The budget a reading spends: each part the options give over the config's, over the default. */
function budgetOf(root: string, given: Partial<InterfaceBudget> = {}): InterfaceBudget {
  return { ...configuredBudget(root), ...Object.fromEntries(Object.entries(given).filter(([, v]) => typeof v === "number" && v > 0)) };
}

/**
 * The adapters readComponentInterfaces starts for itself when given none, for
 * a caller that reads more than once through the same servers (a scoped
 * reading, then the whole one when it cannot settle): each language's is
 * started the first time a reading asks for it, never before, and the caller
 * closes them all.
 */
export function readingAdapters(root: string, budget: Partial<InterfaceBudget> = {}): { of: ReadingAdapters; close: () => Promise<void> } {
  const started = new Map<Language, LanguageAdapter>();
  return {
    of: (language) => {
      let adapter = started.get(language);
      if (adapter === undefined) {
        adapter = boundedAdapter(language, root, configIgnore(root), budgetOf(root, budget).memoryMB);
        started.set(language, adapter);
      }
      return adapter;
    },
    close: async () => {
      for (const adapter of started.values()) await adapter.close();
      started.clear();
    },
  };
}

/**
 * The entrances a scoped reading starts from: the named ones, and every
 * entrance declared in a component that stands, at the map's opening zoom,
 * for the same one as a named entrance's. A route starts where its entrance
 * is declared, so only those can share a named entrance's route, and a
 * route's traced controls and the closures proposed on it depend on every
 * entrance it carries.
 */
export function scopeStarts(model: Pick<SpecModel, "components">, named: readonly { component: string; name: string }[]): { component: string; name: string }[] {
  const parent = new Map(model.components.map((c) => [c.folder, c.parent]));
  const open = new Set(model.components.filter((c) => c.parent === undefined).map((c) => c.folder));
  const represent = (folder: string): string => {
    const chain: string[] = [];
    for (let at: string | undefined = folder; at !== undefined; at = parent.get(at)) chain.unshift(at);
    for (let i = 0; i < chain.length - 1; i++) if (!open.has(chain[i]!)) return chain[i]!;
    return folder;
  };
  const declaredAt = new Set(named.map((e) => represent(e.component)));
  return model.components.flatMap((c) => (declaredAt.has(represent(c.folder)) ? c.entrances.map((e) => ({ component: c.folder, name: e.name })) : []));
}

/**
 * Read every component interface of the project at `root` through `adapter`
 * (started here when not given), or, with `options.scope`, only what those
 * entrances' routes need.
 *
 * A scoped reading resolves the handlers of the entrances scopeStarts names
 * and no other, follows their reach to its fixed point exactly as the whole
 * reading does, and reads whole the interfaces of every component where they
 * are declared or handled or their reach enters, then follows the reach
 * again, until neither asks anything new. A component no such route enters
 * is never asked about. What it did not read it says (`scoped`): each
 * component it read, and, into every other, each caller the word index says
 * could reference it, so what a route depends on and the reading did not read
 * can be settled (scopedUnsettled) before the reading stands for a whole one.
 */
export async function readComponentInterfaces(root: string, given?: LanguageAdapter | ReadingAdapters, options: ReadOptions = {}): Promise<InterfaceReading> {
  const config = readEnforcementConfig(root);
  const model = loadSpecModel(root, { runs: false });
  const budget = budgetOf(root, options.budget);
  const started = Date.now();
  const ignore = configIgnore(root);
  const languages = config.languages;
  const adapterOf = (language: Language): LanguageAdapter | undefined => (typeof given === "function" ? given(language) : language === languages[0] ? given : undefined);
  const candidates = (): EntranceCandidate[] => detectedEntrances(root, model, languages, config.testFolders, ignore);
  if (languages.length === 1) {
    // One language: the reading it always was, with the one language read.
    const reading = await readLanguage(root, languages[0]!, adapterOf(languages[0]!), options, { model, budget, started, owns: () => true });
    return reading.kind === "read" ? { ...reading, languages: languagesRead(languages), candidates: candidates() } : reading;
  }
  // Several languages: each one's component code is read through its own adapter, started only when the language has
  // component code or an entrance handled in its files. Each language's references are its own (no language server reports a
  // reference across languages), so the readings merge side by side over the components they share.
  const owner = (entrance: { file?: string | undefined }): Language => (entrance.file === undefined ? undefined : languageOfFile(entrance.file, languages)) ?? languages[0]!;
  const skip = boundsOf(root, ignore);
  const held = new Set<Language>();
  for (const file of projectFiles(root)) {
    const language = languageOfFile(file, languages);
    if (language === undefined || held.has(language) || !withinBounds(file, skip) || !isSourceFile(file, language) || isTest(file, config.testFolders)) continue;
    if (componentOf(model, file) !== undefined) held.add(language);
  }
  for (const component of model.components) for (const entrance of component.entrances) if (entrance.handler !== undefined) held.add(owner(entrance));
  const parts: { language: Language; reading: InterfaceReading }[] = [];
  for (const language of languages) {
    if (!held.has(language)) continue;
    const reading = await readLanguage(root, language, adapterOf(language), options, { model, budget, started, owns: (_component, entrance) => owner(entrance) === language });
    parts.push({ language, reading });
  }
  return mergeLanguages(languages, parts, model, candidates());
}

/** An adapter for each language a multi-language reading asks, started by the caller (who closes it); undefined lets the reading start its own. */
export type ReadingAdapters = (language: Language) => LanguageAdapter | undefined;

/** What one language's reading shares with the reading of the whole project. */
interface LanguagePart {
  model: SpecModel;
  budget: InterfaceBudget;
  /** When the whole reading started: every language spends from the one time budget. */
  started: number;
  /** Whether this language resolves the entrance: its handler is in one of this language's files. */
  owns: (component: string, entrance: { file?: string | undefined }) => boolean;
}

/** Why a language's reading left an entrance to another; never kept past the merge. */
const OTHER_LANGUAGE = "\u0000handled in another language";

/**
 * One reading of every language a multi-language project declares: a
 * language no component code is written in was read and held nothing; one
 * whose instrument did not answer is named, with why, as not read.
 * Declarations, interfaces, unowned and outside code, and bounds add up; each
 * entrance takes the resolution of the language its handler is written in.
 * No edge is drawn across languages: each language's references are its own.
 */
function mergeLanguages(languages: readonly Language[], parts: readonly { language: Language; reading: InterfaceReading }[], model: SpecModel, candidates: EntranceCandidate[]): InterfaceReading {
  const read = parts.flatMap((p) => (p.reading.kind === "read" ? [{ language: p.language, reading: p.reading }] : []));
  const unread = new Map(parts.flatMap((p) => (p.reading.kind === "unread" ? [[p.language, p.reading.because] as const] : [])));
  if (read.length === 0 && unread.size > 0) return { kind: "unread", because: [...unread.values()].join("; ") };
  const symbols = read.flatMap((r) => r.reading.symbols).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.symbol.localeCompare(b.symbol) || a.file.localeCompare(b.file));
  const entrances: EntranceResolution[] = [];
  for (const component of model.components) {
    for (const entrance of component.entrances) {
      const each = read.map((r) => r.reading.entrances.find((e) => e.component === component.folder && e.name === entrance.name)).filter((e): e is EntranceResolution => e !== undefined && e.reason !== OTHER_LANGUAGE);
      entrances.push(each[0] ?? { component: component.folder, name: entrance.name, reason: unread.size > 0 ? `not read: its language's instrument did not answer (${[...unread.values()].join("; ")})` : "no language's reading resolved it" });
    }
  }
  const outsideInto = new Map<string, number>();
  for (const r of read) for (const i of r.reading.outside?.into ?? []) outsideInto.set(i.component, (outsideInto.get(i.component) ?? 0) + i.sites);
  const partials = read.flatMap((r) => (r.reading.partial === undefined ? [] : [r.reading.partial]));
  const scopes = read.flatMap((r) => (r.reading.scoped === undefined ? [] : [r.reading.scoped]));
  const maybe = new Map(scopes.flatMap((sc) => sc.maybe.map((m) => [`${m.from}\u0000${m.to}`, m] as const)));
  const sum = (of: (r: Extract<InterfaceReading, { kind: "read" }>) => number): number => read.reduce((n, r) => n + of(r.reading), 0);
  // What each language did with its kept answers, added up; a language that used none says why, before the rest.
  const kepts = read.flatMap((r) => (r.reading.kept === undefined ? [] : [{ language: r.language, kept: r.reading.kept }]));
  const whole = kepts.filter((k) => k.kept.whole !== undefined).map((k) => `${k.language}: ${k.kept.whole}`);
  const kept: KeptReport | undefined =
    kepts.length === 0
      ? undefined
      : {
          reused: kepts.reduce((n, k) => n + k.kept.reused, 0),
          asked: kepts.reduce((n, k) => n + k.kept.asked, 0),
          changed: kepts.reduce((n, k) => n + k.kept.changed, 0),
          dropped: kepts.reduce((n, k) => n + k.kept.dropped, 0),
          ...(whole.length === 0 ? {} : whole.length === kepts.length ? { whole: whole.join("; ") } : { unused: whole }),
        };
  return {
    kind: "read",
    language: languages[0]!,
    languages: languagesRead(languages, unread),
    declarations: sum((r) => r.declarations),
    symbols,
    entrances,
    unowned: { files: sum((r) => r.unowned.files), lines: sum((r) => r.unowned.lines) },
    bounds: { components: model.components.length, files: sum((r) => r.bounds?.files ?? 0), candidates: sum((r) => r.bounds?.candidates ?? 0), asked: sum((r) => r.bounds?.asked ?? 0) },
    outside: {
      sites: sum((r) => r.outside?.sites ?? 0),
      files: sum((r) => r.outside?.files ?? 0),
      into: [...outsideInto].map(([component, sites]) => ({ component, sites })).sort((a, b) => a.component.localeCompare(b.component)),
    },
    candidates,
    ...(kept === undefined ? {} : { kept }),
    ...(partials.length === 0 ? {} : { partial: { ...partials[0]!, seconds: Math.max(...partials.map((p) => p.seconds)), unread: [...new Set(partials.flatMap((p) => p.unread))].sort() } }),
    ...(scopes.length === 0
      ? {}
      : {
          scoped: {
            entrances: scopes[0]!.entrances,
            components: [...new Set(scopes.flatMap((sc) => sc.components))].sort(),
            maybe: [...maybe.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
          },
        }),
  };
}

/** One language's reading (see readComponentInterfaces): its component code, through its adapter (started here when not given). */
async function readLanguage(root: string, language: Language, given: LanguageAdapter | undefined, options: ReadOptions, part: LanguagePart): Promise<InterfaceReading> {
  // A language whose declarations and imports no scan reads yet is named as not read, never parsed as another language.
  const notScanned = notScannedYet(language);
  if (notScanned !== undefined) return { kind: "unread", because: notScanned };
  const config = readEnforcementConfig(root);
  const { model, budget, started } = part;
  const deadline = started + budget.seconds * 1000;
  // Started here, the server reads only the config's bounds: nothing past them is ever counted, and a monorepo's
  // server that scans every file spelling a name would spend its memory on code the reading never draws.
  const ignore = configIgnore(root);
  const adapter = given ?? boundedAdapter(language, root, ignore, budget.memoryMB);
  const starting = options.scope === undefined ? undefined : scopeStarts(model, options.scope.entrances);
  const inScope = (component: string, name: string): boolean => starting === undefined || starting.some((e) => e.component === component && e.name === name);
  let stop: { limit: "time" | "memory"; observed?: number } | undefined;
  let memory: number | undefined;
  const measure = options.memory ?? (() => languageServerMemory(adapter.serverPid?.()));
  let sampling = false;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void measure()
      .then((mb) => {
        memory = mb;
      })
      .finally(() => {
        sampling = false;
      });
  }, options.sampleMs ?? 2000);
  sampler.unref();
  /** An adapter answer, or STOPPED once a budget is spent: a stalled server never holds the reading past its deadline. */
  const within = async <T>(question: () => Promise<T>): Promise<T | typeof STOPPED> => {
    if (stop === undefined && memory !== undefined && memory > budget.memoryMB) stop = { limit: "memory", observed: memory };
    if (stop === undefined && Date.now() >= deadline) stop = { limit: "time" };
    if (stop !== undefined) return STOPPED;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<typeof STOPPED>((resolve) => {
      timer = setTimeout(() => {
        stop ??= { limit: "time" };
        resolve(STOPPED);
      }, Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([question(), expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  // The answers an earlier reading kept, less every one a file changed since could have changed: what is reused is never asked.
  let keep: KeptAnswers | undefined;
  /**
   * The server, started the first time a question has no kept answer, never before: a reading every answer of which
   * is kept never starts it. STOPPED when the time budget ran out first and something kept was already reused.
   */
  let up: Promise<true | typeof STOPPED> | undefined;
  const live = (): Promise<true | typeof STOPPED> =>
    (up ??= (async () => {
      const ready = await within(() => adapter.ready());
      // One sample once the server is up, so a reading shorter than the sampling interval is still measured.
      if (ready !== STOPPED) memory = await measure();
      if (ready === STOPPED) {
        if ((keep?.report().reused ?? 0) > 0) return STOPPED;
        throw new NotUp(`the ${language} instrument did not start within the interface reading's time budget (${budget.seconds} s)`);
      }
      if (!ready.ok) throw new NotUp(`the ${language} instrument did not answer: ${ready.reason}`);
      return true as const;
    })());
  /** A name resolved: kept, or asked of the server and kept. */
  const resolveOf = async (query: string, hint: ResolveHint, name: string): Promise<Resolved | typeof STOPPED> => {
    const kept = keep?.resolved(query, hint);
    if (kept !== undefined) return kept;
    if ((await live()) === STOPPED) return STOPPED;
    const answer = await within(() => adapter.resolve(query, hint));
    if (answer !== STOPPED) keep?.keepResolved(query, hint, answer, name);
    return answer;
  };
  /** A definition's reference sites: kept, or asked of the server and kept with the spellings that could change them. */
  const referencesOf = async (definition: Definition, spelled: readonly string[], broad: boolean): Promise<ReferenceSite[] | typeof STOPPED> => {
    const kept = keep?.referenced(definition);
    if (kept !== undefined) return kept;
    if ((await live()) === STOPPED) return STOPPED;
    const answer = await within(() => adapter.references(definition));
    if (answer !== STOPPED) keep?.keepReferenced(definition, answer, spelled, broad);
    return answer;
  };
  const keptOf = (): { kept?: KeptReport } => (keep === undefined ? {} : { kept: keep.report() });
  try {
    const listed = projectFiles(root);
    if (options.keep !== false) keep = KeptAnswers.open(root, language, listed, ignore, config.testFolders);
    const testFolders = config.testFolders;
    const skip = boundsOf(root, ignore);
    // The component code: every bounded non-test file of the language whose nearest spec folder is a component.
    const code = new Map<string, string>();
    const unowned = { files: 0, lines: 0 };
    const declared: Declared[] = [];
    const nodes = new Map<string, ReachNode>();
    let declarations = 0;
    for (const file of listed) {
      if (!withinBounds(file, skip)) continue;
      const owner = componentCodeOf(model, file, language, skip, testFolders);
      const source = isSourceFile(file, language) && !isTest(file, testFolders);
      if (owner === undefined) {
        if (source) {
          unowned.files += 1;
          unowned.lines += readFileSync(join(root, file), "utf8").split("\n").length;
        }
        continue;
      }
      code.set(file, owner);
      if (!source) continue;
      const text = readFileSync(join(root, file), "utf8");
      const lines = text.split("\n");
      for (const declaration of declarationsOf(text, language)) {
        const line = lines[declaration.line - 1] ?? "";
        const type = isTypeDeclaration(line, language);
        const id = `${file}#${declaration.name}`;
        const isDefault = INTERFACE_SYNTAX[language].isDefaultExport(line);
        declared.push({ id, component: owner, name: declaration.name, file, type, exported: declaration.exported, isDefault });
        nodes.set(id, { component: owner, name: declaration.name, file, type });
        if (declaration.exported) declarations += 1;
      }
    }
    // A module handler's top-level script: a node of its own that enters every declaration of its file.
    const moduleFiles = new Set(
      model.components.flatMap((component) => component.entrances.filter((e) => e.handler !== undefined && isModuleHandler(e.handler) && e.file !== undefined && code.has(e.file)).map((e) => e.file!)),
    );
    const index = wordIndex(root, code, language);
    const fileIndex = new Map(index.files.map((file, i) => [file, i]));

    const tally = new Map<string, InterfaceSymbol>();
    const outsideInto = new Map<string, number>();
    const outsideFiles = new Set<string>();
    let outsideSites = 0;
    // The static reach: every resolved declaration, and each reference site's enclosing top-level declaration to it.
    const calls = new Map<string, Map<string, number>>();
    const call = (from: string, to: string): void => {
      const out = calls.get(from) ?? new Map<string, number>();
      calls.set(from, out);
      out.set(to, (out.get(to) ?? 0) + 1);
    };
    for (const file of moduleFiles) {
      nodes.set(`${file}#`, { component: code.get(file)!, name: "", file, type: false });
      for (const d of declared) if (d.file === file && !d.type) call(`${file}#`, d.id);
    }
    /**
     * The top-level declaration whose statement holds a line the server named no symbol for: a multi-line initializer (a
     * registry dict, a destructured factory call) is the declaration's own code, so what it references is what the
     * declaration uses. Undefined when the statement declares nothing (an import, a bare call).
     */
    const statements = new Map<string, { lines: string[]; at: Map<number, string> }>();
    const declarationAt = (file: string, line: number): string | undefined => {
      let known = statements.get(file);
      if (known === undefined) {
        const text = code.has(file) && existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "";
        known = { lines: text.split("\n"), at: new Map(declarationsOf(text, language).map((d) => [d.line, d.name])) };
        statements.set(file, known);
      }
      return known.at.get(statementStartLine(known.lines, line - 1) + 1);
    };
    const asked = new Set<string>();
    const answered = new Set<string>();
    // The tree holds still for one reading: git's listing is taken once and every reported site is kept against it.
    const listing = projectListing(root);
    /** Ask one declaration for its references and account for every site; false once a budget stops the reading. */
    const ask = async (d: Declared): Promise<boolean> => {
      asked.add(d.id);
      const resolved = await resolveOf(`${d.name} in ${d.file}`, { component: d.component, testFolders }, d.name);
      if (resolved === STOPPED) return false;
      if (!resolved.ok || resolved.definition.file !== d.file) {
        answered.add(d.id);
        return true;
      }
      const definition: Definition = resolved.definition;
      const reported = await referencesOf(definition, spellings(index, d.name), d.isDefault || index.defaults.has(d.name));
      if (reported === STOPPED) return false;
      for (const site of projectSites(root, reported, listing) as ReferenceSite[]) {
        if (isTest(site.file, testFolders)) continue;
        // A private declaration is reached only from its own file: it widens a handler's reach, never an interface.
        if (!d.exported && site.file !== d.file) continue;
        // Past the config's bounds is not the project's code: a whole-workspace server reports such sites, a bounded one never does, and neither counts.
        if (!withinBounds(site.file, skip)) continue;
        const from = componentCodeOf(model, site.file, language, skip, testFolders);
        if (from === undefined) {
          // Inside the bounds, in code no declared component owns: counted into its callee, never drawn, never dropped.
          if (!d.exported) continue;
          outsideSites += 1;
          outsideFiles.add(site.file);
          outsideInto.set(d.component, (outsideInto.get(d.component) ?? 0) + 1);
          continue;
        }
        // A symbol the server names that no top-level declaration is (a variable inside a top-level block) is read as the
        // statement it sits in, like a site the server names nothing for.
        const named = site.symbol?.split(".")[0];
        const enclosing = named !== undefined && named !== "" && (nodes.has(`${site.file}#${named}`) || !code.has(site.file)) ? named : site.form === undefined ? declarationAt(site.file, site.line) : undefined;
        if (enclosing !== undefined && enclosing !== "" && !(site.file === d.file && enclosing === d.name)) call(`${site.file}#${enclosing}`, d.id);
        // A top-level statement of a module handler's script uses what it references; an import names it and uses nothing.
        else if ((enclosing === undefined || enclosing === "") && moduleFiles.has(site.file) && site.form === undefined) call(`${site.file}#`, d.id);
        if (from === d.component || !d.exported) continue;
        const key = `${from}\u0000${d.component}\u0000${d.name}\u0000${d.file}`;
        const known = tally.get(key);
        if (known === undefined) tally.set(key, { from, to: d.component, symbol: d.name, file: d.file, sites: 1, ...(d.type ? { kind: "type" as const } : {}) });
        else known.sites += 1;
      }
      answered.add(d.id);
      return true;
    };

    // The interface pass: an exported declaration another component's text could reference. Scoped, it is taken
    // component by component with the reach pass, as the reach enters each.
    const exhaustive = options.exhaustive === true && starting === undefined;
    const candidate = (d: Declared): boolean => exhaustive || (d.exported && namedElsewhere(index, d.name, d.file, d.component, d.isDefault));
    const interfacePass = starting === undefined ? declared.filter(candidate) : [];
    let reading = true;
    for (const d of interfacePass) {
      if (!(await ask(d))) {
        reading = false;
        break;
      }
    }

    /**
     * Whether an entrance's declared guard is where its handler is registered: the chokepoints it names (by symbol, or a
     * declaration of a chokepoint module), confirmed when the handler's own declaration references one of them or a
     * reference to the handler sits in a statement that spells the guard. A reason when it is not confirmed.
     */
    const confirmGuard = async (guard: string, start: string, definition: Definition | undefined): Promise<ChokepointTarget[] | string | typeof STOPPED> => {
      const symbol = namedValue(guard)?.symbol;
      if (symbol === undefined) return `guard ${guard} names no symbol`;
      // A chokepoint module's symbol may be a binding no declaration line names (a factory's destructured products), so its text is read too.
      const moduleDeclares = (t: ChokepointTarget): boolean =>
        [...code.keys()].some((file) => nodeIs({ component: t.component, name: "x", file, type: false }, t.chokepoint, t.component) && declaresAtTop(readFileSync(join(root, file), "utf8"), symbol));
      const named = targets.filter((t) => (t.chokepoint.symbol !== undefined ? t.chokepoint.symbol === symbol : [...nodes.values()].some((n) => n.name === symbol && nodeIs(n, t.chokepoint, t.component)) || moduleDeclares(t)));
      if (named.length === 0) return `guard ${symbol} is no chokepoint an invariant declares`;
      const wraps = [...(calls.get(start) ?? new Map<string, number>()).keys()].some((id) => nodes.get(id)?.name === symbol);
      if (wraps) return named;
      const spelled = new RegExp(`(^|[^\\w$])${symbol.replace(/\$/g, "\\$")}([^\\w$]|$)`);
      // The handler's own declaration, whole: a handler written as guard(async () => ...) is registered through it where it is declared.
      const startFile = start.slice(0, start.lastIndexOf("#"));
      const own = readFileSync(join(root, startFile), "utf8").split("\n");
      if (definition === undefined) return spelled.test(own.join("\n")) ? named : `the handler's top-level script does not reference ${symbol}`;
      if (spelled.test(own.slice(definition.range.start.line, definition.range.end.line + 1).join("\n"))) return named;
      const handlerName = namedValue(definition.name)?.symbol ?? definition.name;
      const sites = await referencesOf(definition, spellings(index, handlerName), index.defaults.has(handlerName) || declared.some((d) => d.id === start && d.isDefault));
      if (sites === STOPPED) return STOPPED;
      for (const site of projectSites(root, sites, listing) as ReferenceSite[]) {
        if (isTest(site.file, testFolders) || !existsSync(join(root, site.file))) continue;
        const lines = readFileSync(join(root, site.file), "utf8").split("\n");
        const from = statementStartLine(lines, site.line - 1);
        if (spelled.test(lines.slice(from, site.line).join("\n"))) return named;
      }
      return `no registration of the handler spells ${symbol}: no statement referencing it calls the guard`;
    };
    const entrances: EntranceResolution[] = [];
    const starts: { at: number; start: string; definition?: Definition }[] = [];
    for (const component of model.components) {
      for (const entrance of component.entrances) {
        if (!part.owns(component.folder, entrance)) {
          // Another language's handler: that language's reading resolves it.
          entrances.push({ component: component.folder, name: entrance.name, reason: OTHER_LANGUAGE });
          continue;
        }
        if (!inScope(component.folder, entrance.name)) {
          entrances.push({ component: component.folder, name: entrance.name, reason: "scoped out: the reading followed only other entrances' routes" });
          continue;
        }
        if (entrance.handler === undefined) {
          entrances.push({ component: component.folder, name: entrance.name, reason: "no handler is named" });
          continue;
        }
        if (!reading) {
          entrances.push({ component: component.folder, name: entrance.name, reason: stoppedBefore(stop, budget, "this handler was resolved") });
          continue;
        }
        if (isModuleHandler(entrance.handler)) {
          // A module handler: the spec model found the file; it must be component code for its script to be read.
          if (entrance.file === undefined || !moduleFiles.has(entrance.file)) {
            entrances.push({ component: component.folder, name: entrance.name, reason: entrance.file === undefined ? `the module ${entrance.handler} was not found` : `the module ${entrance.file} is not component code the reading reads` });
            continue;
          }
          starts.push({ at: entrances.length, start: `${entrance.file}#` });
          entrances.push({ component: component.folder, name: entrance.name, file: entrance.file });
          continue;
        }
        const name = entrance.handler.split(/\s+in\s+/)[0]!;
        const handler = entrance.file === undefined ? entrance.handler : `${name} in ${entrance.file}`;
        const resolved = await resolveOf(handler, { component: component.folder, testFolders }, name);
        if (resolved === STOPPED) {
          reading = false;
          entrances.push({ component: component.folder, name: entrance.name, reason: stoppedBefore(stop, budget, "this handler was resolved") });
          continue;
        }
        if (!resolved.ok) {
          entrances.push({ component: component.folder, name: entrance.name, reason: resolved.reason });
          continue;
        }
        starts.push({ at: entrances.length, start: `${resolved.definition.file}#${name}`, definition: resolved.definition });
        entrances.push({ component: component.folder, name: entrance.name, file: resolved.definition.file });
      }
    }

    // The reach pass, to a fixed point: ask what a file the reach has entered spells, until nothing new is spelled.
    // Scoped, it alternates with the interface pass: once the reach is at its fixed point, the interfaces of every
    // component where a start is declared or handled, or the reach enters, are read whole, and the reach followed again.
    let reachRead = reading;
    const scopeComponents = new Set<string>();
    if (starting !== undefined) {
      for (const { at } of starts) {
        scopeComponents.add(entrances[at]!.component);
        const holder = code.get(entrances[at]!.file ?? "");
        if (holder !== undefined) scopeComponents.add(holder);
      }
    }
    const askAll = async (next: readonly Declared[]): Promise<boolean> => {
      for (const d of next) if (!(await ask(d))) return false;
      return true;
    };
    if (reading && starts.length > 0 && !exhaustive) {
      for (;;) {
        const entered = new Set<number>();
        for (const { start } of starts) {
          for (const id of reachedFrom(start, nodes, calls)) {
            const node = nodes.get(id);
            if (node !== undefined && starting !== undefined) scopeComponents.add(node.component);
            const file = node?.file ?? id.slice(0, id.lastIndexOf("#"));
            const at = fileIndex.get(file);
            if (at !== undefined) entered.add(at);
          }
        }
        let next = declared.filter((d) => !asked.has(d.id) && namedIn(index, d.name, fileIndex.get(d.file), entered, d.isDefault));
        if (next.length === 0 && starting !== undefined) {
          next = declared.filter((d) => !asked.has(d.id) && scopeComponents.has(d.component) && candidate(d));
          interfacePass.push(...next);
        }
        if (next.length === 0) break;
        if (!(await askAll(next))) {
          reading = false;
          break;
        }
      }
      reachRead = reading;
    }
    for (const { at, start } of starts) entrances[at]!.reach = reachOf(start, nodes, calls);

    // The chokepoints each handler passes, traced; then each declared guard, confirmed at the handler's registration.
    const targets = chokepointTargets(model);
    const declaredEntrances = model.components.flatMap((component) => component.entrances.map((entrance) => ({ component: component.folder, entrance })));
    for (const { at, start, definition } of starts) {
      const resolution = entrances[at]!;
      const guards = guardsOf(start, nodes, calls, targets);
      const guard = declaredEntrances.find((d) => d.component === resolution.component && d.entrance.name === resolution.name)?.entrance.guard;
      if (guard !== undefined && reading) {
        const confirmed = await confirmGuard(guard, start, definition);
        if (confirmed === STOPPED) reading = false;
        else if (typeof confirmed === "string") resolution.guardUnconfirmed = confirmed;
        else for (const target of confirmed) if (!guards.some((g) => g.component === target.component && g.name === target.name && g.how === "wrapper")) guards.push({ component: target.component, name: target.name, how: "declared" });
      }
      if (guards.length > 0) resolution.guards = guards;
    }

    const symbols = [...tally.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.symbol.localeCompare(b.symbol) || a.file.localeCompare(b.file),
    );
    const outside = {
      sites: outsideSites,
      files: outsideFiles.size,
      into: [...outsideInto].map(([component, sites]) => ({ component, sites })).sort((a, b) => a.component.localeCompare(b.component)),
    };
    // Scoped, the candidates are those of the components it read whole, the reach having asked some of them first.
    const candidateCount = starting === undefined ? interfacePass.length : declared.filter((d) => scopeComponents.has(d.component) && candidate(d)).length;
    const bounds = { components: model.components.length, files: code.size, candidates: candidateCount, asked: asked.size };
    const scoped = starting === undefined ? undefined : { scoped: scopedFacts(model, starting, scopeComponents, declared, asked, index) };
    if (stop !== undefined) {
      // Whose declarations were not all read: a component with a declaration the reading meant to ask and never
      // had answered, and, when the reach was cut short, every component an entrance with a handler is declared in.
      const unread = new Set<string>();
      for (const d of interfacePass) if (!answered.has(d.id)) unread.add(d.component);
      if (!reachRead) for (const e of entrances) if (e.reason === undefined || e.reason.startsWith("not read")) unread.add(e.component);
      return {
        kind: "read",
        language,
        declarations,
        symbols,
        entrances,
        unowned,
        bounds,
        outside,
        partial: {
          limit: stop.limit,
          budget: stop.limit === "time" ? `${budget.seconds} s` : `${budget.memoryMB} MB`,
          ...(stop.observed === undefined ? {} : { observed: `${stop.observed} MB` }),
          seconds: Math.round((Date.now() - started) / 1000),
          unread: [...unread].sort(),
        },
        ...scoped,
        ...keptOf(),
      };
    }
    return { kind: "read", language, declarations, symbols, entrances, unowned, bounds, outside, ...scoped, ...keptOf() };
  } catch (error) {
    if (error instanceof NotUp) return { kind: "unread", because: error.message };
    return { kind: "unread", because: `the ${language} instrument failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearInterval(sampler);
    keep?.save();
    if (given === undefined) await adapter.close();
  }
}

/** The server would not start, or did not answer: the reading is unread, as it was before any answer was kept. */
class NotUp extends Error {}

/**
 * What a scoped reading says of itself: its starts, the components it read
 * whole, and every interface into another component that may exist: each
 * caller whose code could reference a declaration there the reading never
 * asked, by the word index's own test (namedElsewhere), so a default export
 * may be called from anywhere.
 */
function scopedFacts(model: SpecModel, starting: readonly { component: string; name: string }[], read: ReadonlySet<string>, declared: readonly Declared[], asked: ReadonlySet<string>, index: WordIndex): ScopedReading {
  const maybe = new Set<string>();
  const folders = model.components.map((c) => c.folder);
  for (const d of declared) {
    if (read.has(d.component) || asked.has(d.id) || !d.exported) continue;
    const callers = new Set<string>();
    if (d.isDefault || index.defaults.has(d.name)) for (const f of folders) callers.add(f);
    for (const c of index.wildcards.get(d.file) ?? []) callers.add(c);
    for (const spelling of spellings(index, d.name)) for (const c of index.owners.get(spelling) ?? []) callers.add(c);
    for (const from of callers) if (from !== d.component) maybe.add(`${from}\u0000${d.component}`);
  }
  return {
    entrances: [...starting],
    components: [...read].sort(),
    maybe: [...maybe].sort().map((key) => {
      const [from, to] = key.split("\u0000") as [string, string];
      return { from, to };
    }),
  };
}

/** Why an entrance has no resolution when a budget stopped the reading first. */
function stoppedBefore(stop: { limit: "time" | "memory" } | undefined, budget: InterfaceBudget, what: string): string {
  return `not read: the interface reading stopped at its ${stop?.limit === "memory" ? `memory budget (${budget.memoryMB} MB)` : `time budget (${budget.seconds} s)`} before ${what}`;
}
