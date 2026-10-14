/**
 * The Go adapter: the language server protocol over stdio to gopls, found on
 * the machine (locateGopls in installed.ts): it is no npm package, so the
 * resolver has nothing to resolve, and it runs `go list`, so `go` must be on
 * PATH too.
 *
 * The server is asked nothing before it says it is quiescent: gopls reports
 * every load and every diagnosis as `$/progress` work ("Setting up
 * workspace" ends "Finished loading packages."), and an answer before the
 * packages are loaded is silently partial. Symbols resolve through
 * workspace/symbol (a bare name) or the hinted file's
 * textDocument/documentSymbol (`name in store/store.go`); a method is named
 * by its own name, without its receiver. A module is a `.go` file; a package
 * folder has no owner file, so `store/` is refused with a reason. References
 * come from textDocument/references, every site a reference: Go imports name
 * packages, never a symbol, so no site has a form, and test code lives in
 * `_test.go` files, which isTestPath reads by name.
 *
 * Visibility is Go's two rules, read from the name and the import path with
 * no server call: an unexported identifier is reachable only in its package
 * (its folder), and an exported one under an `internal/` folder only in the
 * tree rooted at that folder's parent, the last `internal` deciding. Either
 * stops short of the module, so the compiler refuses a use from outside and
 * the item is visibility-choked; an exported item importable module-wide is
 * reference-choked. The refutation never touches disk: a refusal is staged as
 * an unsaved file in an existing package outside the scope, since gopls
 * publishes no diagnostics for a package that exists only in overlays, and an
 * outside use as an unsaved file in a new folder, whose references it does
 * report. Every overlay is restored when the refutation ends.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { posix, relative, resolve, sep, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import {
  isTestPath,
  outsideOfFolder,
  parseName,
  rangeContains,
  withinFolder,
  type Definition,
  type Ladder,
  type LanguageAdapter,
  type Position,
  type Range,
  type ReferenceSite,
  type Refutation,
  type ResolveHint,
  type Resolved,
  type Rung,
  type StagedSite,
  type Visibility,
} from "./adapter.ts";
import { locateGopls, type ServerLocation } from "./installed.ts";
import { JsonRpcClient, RpcError } from "./jsonrpc.ts";
import { keepProjectFiles, projectListing, walkBounds, walkedProjectFiles, type ProjectListing } from "./project-files.ts";

/** The small JSON-RPC surface the adapter needs, exposed so a test can control when the server is quiescent. */
export interface GoLanguageClient {
  onNotification: ((method: string, params: unknown) => void) | undefined;
  onRequest: ((method: string, params: unknown) => unknown | Promise<unknown>) | undefined;
  readonly alive: boolean;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params: unknown): void;
  kill(): void;
}

/** How the adapter starts its client: JsonRpcClient.spawn, or a test's controlled stand-in. */
export type GoClientFactory = (command: string, args: string[], cwd: string, env?: Record<string, string>) => GoLanguageClient;

const SERVER_BIN = "gopls";
/** How long a cold workspace may take to load before an indexed question gives up, as Python's enumeration does. */
const QUIESCENCE_TIMEOUT_MS = 10 * 60 * 1000;
/** How long an overlay change is given to start gopls's diagnosis before it is taken as already applied. */
const SETTLE_MS = 750;
/** How long a staged file's diagnostics are waited for once the server is quiescent. */
const PUBLISH_TIMEOUT_MS = 30_000;
/** The progress title of gopls's package load: its end says whether the packages loaded. */
const LOAD_TITLE = "Setting up workspace";
const COHERENCE_ENFORCER = "Coherence's check at the edit and in CI";
const COMPILER = "the compiler (go build)";

/**
 * Go's rungs. The compiler refuses a use of an unexported identifier from
 * another package, and the go command an import of an `internal/` package
 * from outside the tree rooted at its parent, so an item whose scope stops
 * short of the module is visibility-choked; an exported item importable
 * module-wide (an `internal/` at the module root included) is constrained by
 * nothing a single-module project could break, and Coherence's own check is
 * the enforcer.
 */
export const GO_LADDER: Ladder = {
  top: "visibility-choked",
  because: "the Go compiler refuses a use of an unexported identifier from another package, and an import of an internal/ package from outside the tree rooted at its parent, so an item whose scope stops short of the module cannot be referenced from outside that scope",
  rungs: [
    { grade: "visibility-choked", enforcer: COMPILER, fact: "the protected item is unexported, or exported under an internal/ folder below the module root, so the compiler refuses any reference from outside its package or that tree" },
    { grade: "reference-choked", enforcer: COHERENCE_ENFORCER, fact: "the item is exported and importable module-wide, and every resolved reference in the workspace is inside the chokepoint" },
  ],
};

/** Where gopls is, with every place looked. */
export function locateServer(root: string): ServerLocation {
  return locateGopls(root, SERVER_BIN);
}

/** A symbol of textDocument/documentSymbol, hierarchical. */
interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

/** A symbol of workspace/symbol, or a flat documentSymbol. */
interface SymbolInformation {
  name: string;
  kind: number;
  location: { uri: string; range: Range };
}

/** A reference site as the protocol reports it. */
interface Location {
  uri: string;
  range: Range;
}

/** A diagnostic gopls publishes. */
interface Diagnostic {
  message: string;
  range: Range;
  severity?: number;
  code?: number | string;
}

/** The protocol's symbol kinds that name a value (a function, a variable, a constant); every other top-level kind gopls gives is a type. */
const VALUE_KINDS = new Set([12, 13, 14]);

/** A method's name as gopls's documentSymbol gives it, `(*Box).Put` or `(Box[T]).Put`: the receiver's type and the method's own name. */
const METHOD_NAME = /^\(\*?([\p{L}_][\p{L}\p{N}_]*)(?:\[[^\]]*\])?\)\.([\p{L}_][\p{L}\p{N}_]*)$/u;

/** Whether a diagnostic is the compiler refusing a name from another package: an unexported name, read as undefined, not exported, or an unexported method or field. */
export function refusesName(diagnostic: Pick<Diagnostic, "code" | "message">): boolean {
  return ["UndeclaredImportedName", "UnexportedName", "MissingFieldOrMethod"].includes(String(diagnostic.code)) || /undefined: |not exported by package|cannot refer to unexported/.test(diagnostic.message);
}

/** Whether a diagnostic is the go command refusing an import of an internal package from outside its tree. */
export function refusesInternal(diagnostic: Pick<Diagnostic, "message">): boolean {
  return /use of internal package .* not allowed|invalid use of internal package/.test(diagnostic.message);
}

/** Whether a Go identifier is exported: its first character is an upper-case letter. */
export function isExported(name: string): boolean {
  const first = [...name][0] ?? "";
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

/** A symbol's own identifier: a method's name without its receiver, every other symbol's name as given. */
function identifierOf(symbol: DocumentSymbol): string {
  return METHOD_NAME.exec(symbol.name)?.[2] ?? symbol.name;
}

/** The package clause's name in a Go file's text, or undefined when the file has none. */
export function packageClause(text: string): string | undefined {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  return /^\s*package\s+([\p{L}_][\p{L}\p{N}_]*)/mu.exec(plain)?.[1];
}

/** GOFLAGS without `-mod=mod`, which lets `go list` rewrite go.mod and go.sum. */
export function readOnlyGoflags(goflags: string | undefined): string {
  return (goflags ?? "").split(/\s+/).filter((flag) => flag !== "" && flag !== "-mod=mod").join(" ");
}

/** Every symbol of a documentSymbol tree with the path of symbols down to it, outermost first. */
function flatten(symbols: DocumentSymbol[], prefix: DocumentSymbol[] = []): { path: DocumentSymbol[]; symbol: DocumentSymbol }[] {
  const out: { path: DocumentSymbol[]; symbol: DocumentSymbol }[] = [];
  for (const symbol of symbols) {
    const path = [...prefix, symbol];
    out.push({ path, symbol });
    if (symbol.children !== undefined) out.push(...flatten(symbol.children, path));
  }
  return out;
}

/** Whether two positions are the same line and character. */
function samePosition(a: Position, b: Position): boolean {
  return a.line === b.line && a.character === b.character;
}

/* ------------------------------------------------------------ scopes */

/** A Go module: its folder, project-relative ("." at the root), and the path its go.mod's module line declares. */
interface GoModule {
  dir: string;
  path: string;
}

/**
 * Where Go lets an item be named: its package's folder (unexported), the tree
 * under an internal/ folder's parent (exported under internal/), or
 * everywhere (exported and importable, an internal/ at the module root's
 * module included, which is every package of the module).
 */
export type GoScope = { kind: "package"; dir: string } | { kind: "subtree"; dir: string } | { kind: "module" } | { kind: "public" };

/** A folder's import path within its module. */
function importPathOf(module: GoModule, dir: string): string {
  const inside = module.dir === "." ? dir : posix.relative(module.dir, dir);
  return inside === "" || inside === "." ? module.path : `${module.path}/${inside}`;
}

/**
 * The scope Go gives a name declared in a package folder of a module: the
 * package for an unexported name; for an exported one, the tree rooted at
 * the parent of the last internal/ folder on the package's path, the whole
 * module when that parent is the module's root, and everywhere otherwise.
 */
export function goScopeOf(exported: boolean, packageDir: string, moduleDir: string): GoScope {
  if (!exported) return { kind: "package", dir: packageDir };
  const inside = moduleDir === "." ? packageDir : posix.relative(moduleDir, packageDir);
  const segments = inside === "." || inside === "" ? [] : inside.split("/");
  const last = segments.lastIndexOf("internal");
  if (last < 0) return { kind: "public" };
  if (last === 0) return { kind: "module" };
  return { kind: "subtree", dir: posix.join(moduleDir, ...segments.slice(0, last)) };
}

/** A scope in words, by import path. */
function scopeText(scope: GoScope, module: GoModule): string {
  if (scope.kind === "public") return "every importer";
  if (scope.kind === "module") return `module ${module.path}`;
  return scope.kind === "package" ? `package ${importPathOf(module, scope.dir)}` : `the tree under ${importPathOf(module, scope.dir)}`;
}

/** Whether a scope stops short of the module, so the compiler's refusal guards it. */
function chokes(scope: GoScope): scope is { kind: "package" | "subtree"; dir: string } {
  return scope.kind === "package" || scope.kind === "subtree";
}

/** Whether a package folder lies inside a scope. */
function insideScope(dir: string, scope: GoScope): boolean {
  if (scope.kind === "package") return dir === scope.dir;
  if (scope.kind === "subtree") return withinFolder(dir, scope.dir);
  return true;
}

/** What the package and the name say about a definition: its module, package, identifier, kind, and the scope Go lets it be named in. */
interface Placement {
  module: GoModule;
  /** The package's folder, project-relative. */
  dir: string;
  importPath: string;
  /** The package clause's name. */
  packageName: string;
  /** The identifier as declared; for a module definition, the file. */
  name: string;
  kind: number;
  /** The type a method or a field belongs to, when the item is one. */
  container: string | undefined;
  exported: boolean;
  scope: GoScope;
}

/* ------------------------------------------------------------ the adapter */

export class GoAdapter implements LanguageAdapter {
  readonly language = "go";
  readonly ladder = GO_LADDER;
  readonly root: string;
  private readonly clientFactory: GoClientFactory;
  private client: GoLanguageClient | undefined;
  private starting: Promise<{ ok: true } | { ok: false; reason: string }> | undefined;
  /** The text of every document the adapter has open, which the server reads instead of the disk. */
  private readonly opened = new Map<string, string>();
  /** The document version last sent per open file; a change carries the next one. */
  private readonly versions = new Map<string, number>();
  private readonly symbolCache = new Map<string, DocumentSymbol[]>();
  private readonly lineCache = new Map<string, string[]>();
  private readonly placements = new Map<string, Placement | string>();
  /** Files a definition or a reference site landed in since the last forget: the ones a forget re-reads from disk. */
  private readonly touched = new Set<string>();
  /** The unsaved documents a refutation has open right now, the one site outside the project's files it accepts. */
  private readonly probes = new Set<string>();
  /** The diagnostics gopls last published per file, with the document version they are for. */
  private readonly published = new Map<string, { version: number | undefined; diagnostics: Diagnostic[] }>();
  /** Every message gopls published since a staging began, so a staging that closed an import cycle is told apart from a refusal. */
  private publishedSince: string[] = [];
  /** The project's files and git's listing, each taken once per forget. */
  private walked: string[] | undefined;
  private listing: { taken: ProjectListing | undefined } | undefined;
  /** The load's state: whether the packages are loaded, the progress tokens still running, and the load's health. */
  private status: { loaded: boolean; health: "ok" | "error"; message: string | undefined } = { loaded: false, health: "ok", message: undefined };
  /** The progress tokens begun and not yet ended. */
  private readonly active = new Set<string>();
  /** The token of the package load's progress, whose end says whether the packages loaded. */
  private loadToken: string | undefined;
  /** Bumped at every progress report the server sends, so a wait can tell a change was taken up. */
  private generation = 0;
  private waiters: (() => void)[] = [];

  constructor(root: string, clientFactory: GoClientFactory = JsonRpcClient.spawn) {
    this.root = resolve(root);
    this.clientFactory = clientFactory;
  }

  serverPid(): number | undefined {
    return (this.client as { pid?: number } | undefined)?.pid;
  }

  ready(): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.starting ??= this.start();
    return this.starting;
  }

  /** The settings the server is started with and answers workspace/configuration with. */
  private settings(): Record<string, unknown> {
    return {
      symbolScope: "workspace",
      // Every diagnosis is reported as progress, so the end of one is the evidence a change was applied.
      verboseWorkDoneProgress: true,
      diagnosticsDelay: "0s",
      telemetryPrompt: false,
      vulncheck: "Off",
    };
  }

  /** Whether the server is quiescent: the packages are loaded and no progress is running. */
  private get quiescent(): boolean {
    return this.status.loaded && this.active.size === 0;
  }

  /** One `$/progress` report: a begin or end of the package load or of a diagnosis, waking every waiter once the server is quiescent. */
  private onProgress(params: { token?: string | number; value?: { kind?: string; title?: string; message?: string } }): void {
    const token = String(params.token);
    const value = params.value ?? {};
    if (value.kind === "begin") {
      this.active.add(token);
      if (value.title === LOAD_TITLE) {
        this.loadToken = token;
        this.status = { ...this.status, loaded: false };
      }
    } else if (value.kind === "end") {
      this.active.delete(token);
      if (token === this.loadToken) {
        const failed = /^Error loading packages/.test(value.message ?? "");
        this.status = { loaded: true, health: failed ? "error" : "ok", message: failed ? value.message : undefined };
      }
    }
    this.generation += 1;
    if (this.quiescent) for (const wake of this.waiters.splice(0)) wake();
  }

  /** Start gopls, wire its progress and diagnostics, and initialize it; a reason when it is missing or does not initialize. */
  private async start(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const server = locateServer(this.root);
    if (!server.found) {
      return { ok: false, reason: `${SERVER_BIN} not found; looked at ${server.looked.join("; ")}. Install it: go install golang.org/x/tools/gopls@latest, with go on PATH` };
    }
    const client = this.clientFactory(server.command, server.args, this.root, { GOFLAGS: readOnlyGoflags(process.env["GOFLAGS"]) });
    this.client = client;
    this.status = { loaded: false, health: "ok", message: undefined };
    this.active.clear();
    this.loadToken = undefined;
    const settings = this.settings();
    client.onNotification = (method, params) => {
      if (method === "$/progress") return this.onProgress(params as Parameters<GoAdapter["onProgress"]>[0]);
      if (method !== "textDocument/publishDiagnostics") return;
      const published = params as { uri: string; version?: number; diagnostics?: Diagnostic[] };
      const diagnostics = published.diagnostics ?? [];
      this.published.set(this.relative(published.uri), { version: published.version, diagnostics });
      this.publishedSince.push(...diagnostics.map((d) => d.message));
    };
    client.onRequest = (method, params) => {
      if (method !== "workspace/configuration") return null;
      return ((params as { items?: unknown[] }).items ?? []).map(() => settings);
    };
    try {
      await client.request(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToFileURL(this.root).href,
          workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "project" }],
          capabilities: {
            window: { workDoneProgress: true },
            textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, publishDiagnostics: { versionSupport: true } },
            workspace: { configuration: true, symbol: {}, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: false } },
          },
          initializationOptions: settings,
        },
        120_000,
      );
      client.notify("initialized", {});
      return { ok: true };
    } catch (error) {
      client.kill();
      this.client = undefined;
      return { ok: false, reason: `${SERVER_BIN} at ${server.path} failed to initialize: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** The running client, restarted when it died. */
  private async live(): Promise<GoLanguageClient> {
    const state = await this.ready();
    if (!state.ok) throw new Error(state.reason);
    if (this.client === undefined || !this.client.alive) {
      this.starting = undefined;
      this.opened.clear();
      this.versions.clear();
      const again = await this.ready();
      if (!again.ok) throw new Error(again.reason);
    }
    return this.client!;
  }

  /** Resolves once the server reports itself quiescent; capped, so a server that never settles is a reason, never a hang. */
  private quiescence(): Promise<void> {
    if (this.quiescent) return Promise.resolve();
    return new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`${SERVER_BIN} did not finish loading the packages in ${QUIESCENCE_TIMEOUT_MS / 60000} minutes`)), QUIESCENCE_TIMEOUT_MS);
      timer.unref();
      this.waiters.push(() => {
        clearTimeout(timer);
        done();
      });
    });
  }

  /** The live client once gopls has loaded the packages and finished every diagnosis; an answer before that is silently partial. */
  private async indexed(): Promise<GoLanguageClient> {
    const client = await this.live();
    await this.quiescence();
    if (this.status.health === "error") throw new Error(`${SERVER_BIN} reported ${this.status.message ?? "an error loading the packages"}`);
    return client;
  }

  /** After a change: give the server a moment to start diagnosing it, then wait until it is quiescent again. */
  private async settled(): Promise<GoLanguageClient> {
    const client = await this.indexed();
    const before = this.generation;
    const deadline = Date.now() + SETTLE_MS;
    while (this.generation === before && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 20));
    return this.indexed().then(() => client);
  }

  /** One indexed question, asked again once the server has settled whenever it cancels the answer for a newer change. */
  private async ask<T>(method: string, params: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.indexed();
      try {
        return await client.request<T>(method, params);
      } catch (error) {
        if (!(error instanceof RpcError && (error.code === -32801 || error.code === -32802)) || attempt >= 20) throw error;
        await this.settled();
      }
    }
  }

  /** A project-relative file as a file URI. */
  private uri(file: string): string {
    return pathToFileURL(join(this.root, file)).href;
  }

  /** A file URI as a project-relative path with forward slashes. */
  private relative(uri: string): string {
    return relative(this.root, fileURLToPath(uri)).split(sep).join("/");
  }

  /** A file's lines as the server sees them: the open document's text, else the disk's. */
  private lines(file: string): string[] {
    let lines = this.lineCache.get(file);
    if (lines === undefined) {
      const open = this.opened.get(file);
      try {
        lines = (open ?? readFileSync(join(this.root, file), "utf8")).split(/\r?\n/);
      } catch {
        lines = [];
      }
      this.lineCache.set(file, lines);
    }
    return lines;
  }

  /** Open a document with the given text, or change it when it is already open. */
  private open(file: string, text: string): void {
    if (this.opened.has(file)) return this.change(file, text);
    this.client!.notify("textDocument/didOpen", { textDocument: { uri: this.uri(file), languageId: "go", version: 1, text } });
    this.opened.set(file, text);
    this.versions.set(file, 1);
    this.lineCache.delete(file);
    this.symbolCache.delete(file);
  }

  /** Replace an open document's whole text; the version only ever climbs, so the server never discards a change as old. */
  private change(file: string, text: string): void {
    const version = (this.versions.get(file) ?? 1) + 1;
    this.versions.set(file, version);
    this.client!.notify("textDocument/didChange", { textDocument: { uri: this.uri(file), version }, contentChanges: [{ text }] });
    this.opened.set(file, text);
    this.lineCache.delete(file);
    this.symbolCache.delete(file);
  }

  /** Close an open document, so the server reads the disk's text again. */
  private closeDocument(file: string): void {
    if (!this.opened.has(file)) return;
    this.client!.notify("textDocument/didClose", { textDocument: { uri: this.uri(file) } });
    this.opened.delete(file);
    this.versions.delete(file);
    this.lineCache.delete(file);
    this.symbolCache.delete(file);
  }

  /** A file's document symbols as the server sees the file, cached until the next forget or change. */
  private async documentSymbols(file: string): Promise<DocumentSymbol[]> {
    const cached = this.symbolCache.get(file);
    if (cached !== undefined) return cached;
    if (!this.opened.has(file) && !existsSync(join(this.root, file))) {
      this.symbolCache.set(file, []);
      return [];
    }
    const result = await this.ask<DocumentSymbol[] | SymbolInformation[] | null>("textDocument/documentSymbol", { textDocument: { uri: this.uri(file) } });
    const symbols: DocumentSymbol[] = (result ?? []).map((s) => ("location" in s ? { name: s.name, kind: s.kind, range: s.location.range, selectionRange: s.location.range } : s));
    this.symbolCache.set(file, symbols);
    return symbols;
  }

  /**
   * Cached facts about files are dropped, and the server is made to see the
   * current disk text of every document the adapter has open, every file
   * touched since the last forget and every file the caller names: each gets
   * its whole disk text as an open document (a file gone from disk is closed
   * and reported deleted), the server is told the named files changed on
   * disk, which reloads the packages when one is a go.mod, go.sum or go.work,
   * and the forget resolves once the server is quiescent again and has
   * answered a documentSymbol for each synced file.
   */
  async forget(files: readonly string[] = []): Promise<void> {
    this.symbolCache.clear();
    this.lineCache.clear();
    this.placements.clear();
    this.walked = undefined;
    this.listing = undefined;
    if (this.client === undefined) return;
    const named = keepProjectFiles(this.root, files);
    const refresh = new Set([...this.touched, ...files.filter((f) => named.has(f)), ...this.opened.keys()]);
    this.touched.clear();
    const synced: string[] = [];
    const changes: { uri: string; type: number }[] = [];
    for (const file of refresh) {
      const path = join(this.root, file);
      if (!existsSync(path) || !statSync(path).isFile()) {
        this.closeDocument(file);
        changes.push({ uri: this.uri(file), type: 3 });
        continue;
      }
      if (!file.endsWith(".go")) continue;
      this.open(file, readFileSync(path, "utf8"));
      synced.push(file);
    }
    for (const file of files.filter((f) => named.has(f) && existsSync(join(this.root, f)))) changes.push({ uri: this.uri(file), type: 2 });
    if (changes.length > 0) this.client.notify("workspace/didChangeWatchedFiles", { changes });
    await this.settled();
    // The acknowledgment: one answer per changed document, each ordered after its change.
    for (const file of synced) await this.documentSymbols(file);
  }

  /** The project's files as the walk reads them, taken once per forget. */
  private walkedNow(): string[] {
    return (this.walked ??= walkedProjectFiles(walkBounds(this.root, [])).files);
  }

  /** Git's listing of the project, taken once per forget. */
  private listingNow(): ProjectListing | undefined {
    return (this.listing ??= { taken: projectListing(this.root) }).taken;
  }

  async resolve(name: string, hint: ResolveHint): Promise<Resolved> {
    const parsed = parseName(name);
    if (parsed.form === "prose") {
      return { ok: false, reason: `"${name}" is prose, not a symbol or a file; write the item (\`write\`), the item in its file (\`write in store/store.go\`), or the file` };
    }
    if (parsed.form === "module") return this.resolveModule(name, parsed.path);
    const candidates = parsed.fileHint === undefined ? await this.searchWorkspace(parsed.name) : await this.searchFiles(parsed.name, parsed.fileHint);
    if (candidates.length === 0) {
      return { ok: false, reason: parsed.fileHint === undefined ? `no item named ${parsed.name} in the workspace` : `no item named ${parsed.name} in a file ending with ${parsed.fileHint}` };
    }
    const chosen = choose(candidates, hint);
    if (chosen === undefined) {
      const where = candidates.map((c) => `${c.file}:${c.symbol.selectionRange.start.line + 1}`);
      return { ok: false, reason: `${parsed.name} is declared in ${candidates.length} places; write \`${parsed.name} in <file>\``, candidates: where };
    }
    this.touched.add(chosen.file);
    return { ok: true, definition: { name, kind: "symbol", file: chosen.file, range: chosen.symbol.range, selection: chosen.symbol.selectionRange.start } };
  }

  /** A module path: a `.go` file. A package folder has no owner file, and a definition has one file, so a folder is refused with a reason. */
  private async resolveModule(name: string, path: string): Promise<Resolved> {
    if (!path.endsWith(".go")) {
      return { ok: false, reason: `${path} is a Go package folder, which no one file owns; name one of its files (\`${path === "." ? "" : `${path}/`}<file>.go\`) or an item in it` };
    }
    if (!existsSync(join(this.root, path)) || !statSync(join(this.root, path)).isFile()) return { ok: false, reason: `module ${path} is not a Go file under the project` };
    if (!keepProjectFiles(this.root, [path]).has(path)) return { ok: false, reason: `module ${path} is not one of the project's files (ignored, or inside a nested checkout)` };
    const lines = this.lines(path);
    const symbols = await this.documentSymbols(path);
    const first = symbols.find((s) => isExported(identifierOf(s))) ?? symbols[0];
    this.touched.add(path);
    return {
      ok: true,
      definition: {
        name,
        kind: "module",
        file: path,
        range: { start: { line: 0, character: 0 }, end: { line: Math.max(0, lines.length - 1), character: (lines[lines.length - 1] ?? "").length } },
        selection: first?.selectionRange.start ?? { line: 0, character: 0 },
      },
    };
  }

  /** Every declaration of a bare name among the project's files, found through workspace/symbol. */
  private async searchWorkspace(name: string): Promise<Candidate[]> {
    const found = await this.ask<SymbolInformation[] | null>("workspace/symbol", { query: name });
    const files = new Set<string>();
    for (const info of found ?? []) {
      // A method is listed as Recv.Method.
      if (info.name !== name && !info.name.endsWith(`.${name}`)) continue;
      const file = this.relative(info.location.uri);
      if (file.startsWith("..") || !file.endsWith(".go")) continue;
      files.add(file);
    }
    const own = keepProjectFiles(this.root, [...files], this.listingNow());
    const candidates: Candidate[] = [];
    for (const file of [...files].filter((f) => own.has(f)).sort()) candidates.push(...(await this.declarationsIn(file, name)));
    return candidates;
  }

  /** Every declaration of a name in the project's Go files whose path ends with the hint. */
  private async searchFiles(name: string, fileHint: string): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const file of this.walkedNow().filter((rel) => rel.endsWith(".go") && (rel === fileHint || rel.endsWith(`/${fileHint}`)))) candidates.push(...(await this.declarationsIn(file, name)));
    return candidates;
  }

  /** The items named `name` in a file: a top-level declaration, a method by its own name, or a field. */
  private async declarationsIn(file: string, name: string): Promise<Candidate[]> {
    return flatten(await this.documentSymbols(file))
      .filter((entry) => identifierOf(entry.symbol) === name)
      .map((entry) => ({ file, symbol: entry.symbol }));
  }

  async references(definition: Definition): Promise<ReferenceSite[]> {
    this.touched.add(definition.file);
    const starts: Position[] = [];
    if (definition.kind === "module") {
      // A file's every name is reachable from the rest of its package, so a site outside the file reaches the module whatever the name's case.
      for (const { symbol } of flatten(await this.documentSymbols(definition.file))) starts.push(symbol.selectionRange.start);
    } else {
      starts.push(definition.selection);
    }
    const reported: Location[] = [];
    for (const position of starts) {
      const locations = await this.ask<Location[] | null>("textDocument/references", { textDocument: { uri: this.uri(definition.file) }, position, context: { includeDeclaration: false } });
      reported.push(...(locations ?? []));
    }
    // Only the project's own files are evidence: a site in the module cache, the standard library or a vendor folder is dropped before it is read.
    const own = keepProjectFiles(this.root, reported.map((location) => this.relative(location.uri)), this.listingNow());
    const seen = new Set<string>();
    const sites: ReferenceSite[] = [];
    for (const location of reported) {
      const file = this.relative(location.uri);
      if (!(own.has(file) || this.probes.has(file))) continue;
      const start = location.range.start;
      if (file === definition.file && samePosition(start, definition.selection)) continue;
      const key = `${file}:${start.line}:${start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.touched.add(file);
      sites.push({ file, line: start.line + 1, character: start.character, symbol: await this.enclosing(file, start) });
    }
    sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character);
    return sites;
  }

  /** The innermost named item enclosing a position, as `outer.inner`. */
  private async enclosing(file: string, position: Position): Promise<string | undefined> {
    let symbols: DocumentSymbol[];
    try {
      symbols = await this.documentSymbols(file);
    } catch {
      return undefined;
    }
    let best: { path: DocumentSymbol[]; symbol: DocumentSymbol } | undefined;
    for (const entry of flatten(symbols)) {
      if (!rangeContains(entry.symbol.range, position)) continue;
      if (best === undefined || entry.path.length > best.path.length) best = entry;
    }
    return best?.path.map((s) => s.name).join(".");
  }

  /** The Go module a project-relative folder belongs to: the nearest go.mod at or above it within the project, and its module line. */
  private moduleOf(dir: string): GoModule | undefined {
    for (let at = dir; ; at = posix.dirname(at)) {
      const goMod = join(this.root, at, "go.mod");
      if (existsSync(goMod)) {
        const path = /^\s*module\s+"?([^\s"]+)"?/m.exec(readFileSync(goMod, "utf8"))?.[1];
        return path === undefined ? undefined : { dir: at, path };
      }
      if (at === "." || at === "") return undefined;
    }
  }

  /** The package clause of a package folder, read from its first non-test Go file the server sees. */
  private packageNameIn(dir: string, files: readonly string[]): string | undefined {
    for (const file of files) {
      if (posix.dirname(file) !== dir || !file.endsWith(".go") || file.endsWith("_test.go")) continue;
      const name = packageClause(this.lines(file).join("\n"));
      if (name !== undefined) return name;
    }
    return undefined;
  }

  /** Where a definition sits: its module, its package, its identifier, and the scope Go lets it be named in; a reason when the package cannot be read. */
  private async placement(definition: Definition): Promise<Placement | string> {
    const key = `${definition.file}:${definition.selection.line}:${definition.selection.character}:${definition.kind}`;
    const cached = this.placements.get(key);
    if (cached !== undefined) return cached;
    const placed = await this.place(definition);
    this.placements.set(key, placed);
    return placed;
  }

  /** The placement of one definition, read from its file, its package clause and its go.mod. */
  private async place(definition: Definition): Promise<Placement | string> {
    const dir = posix.dirname(definition.file);
    const module = this.moduleOf(dir);
    if (module === undefined) return `${definition.file} is in no Go module: no go.mod with a module line at or above its folder in the project`;
    const packageName = packageClause(this.lines(definition.file).join("\n"));
    if (packageName === undefined) return `${definition.file} has no package clause`;
    const importPath = importPathOf(module, dir);
    if (definition.kind === "module") {
      // A file's exported names reach as far as its package's import path lets them, which is how far the file reaches.
      return { module, dir, importPath, packageName, name: definition.file, kind: 0, container: undefined, exported: true, scope: goScopeOf(true, dir, module.dir) };
    }
    const entry = flatten(await this.documentSymbols(definition.file)).find((e) => samePosition(e.symbol.selectionRange.start, definition.selection));
    if (entry === undefined) return `no item declared at ${definition.file}:${definition.selection.line + 1}`;
    const name = identifierOf(entry.symbol);
    const receiver = METHOD_NAME.exec(entry.symbol.name)?.[1];
    const container = receiver ?? (entry.path.length > 1 ? identifierOf(entry.path[entry.path.length - 2]!) : undefined);
    const exported = isExported(name);
    return { module, dir, importPath, packageName, name, kind: entry.symbol.kind, container, exported, scope: goScopeOf(exported, dir, module.dir) };
  }

  async visibility(definition: Definition, _chokepoint?: Definition): Promise<Visibility> {
    const placed = await this.placement(definition);
    if (typeof placed === "string") {
      return { enforced: false, visible: true, evidence: placed, rung: { grade: "reference-choked", enforcer: COHERENCE_ENFORCER, fact: `${placed}, so nothing the compiler enforces is read; every resolved reference is inside the chokepoint` } };
    }
    const what = definition.kind === "module" ? `file ${placed.name} of package ${placed.importPath}` : `${placed.exported ? "exported" : "unexported"} ${placed.container === undefined ? "" : `${placed.container}.`}${placed.name} in package ${placed.importPath}`;
    const evidence = `${what}; reachable within ${scopeText(placed.scope, placed.module)}`;
    const choked = chokes(placed.scope);
    const rung: Rung = choked
      ? { grade: "visibility-choked", enforcer: COMPILER, fact: `the compiler refuses any reference outside ${scopeText(placed.scope, placed.module)} (${evidence}), and every reference inside it is inside the chokepoint` }
      : { grade: "reference-choked", enforcer: COHERENCE_ENFORCER, fact: `importable module-wide (${evidence}); every resolved reference in the workspace is inside the chokepoint` };
    return { enforced: true, visible: !choked, evidence, rung };
  }

  testFilter(via: string): string {
    return via;
  }

  /**
   * For an item whose scope stops short of the module, the compiler's refusal
   * of a use from outside that scope is the refutation (ruling rs-e93ecdd6):
   * an unsaved file in an existing package outside the scope imports the
   * item's package and names the item, and the refusal is read back from the
   * diagnostics gopls publishes for that file, with a control use in the
   * item's own file that must not be refused, so a wrong import path is never
   * read as privacy. For everything else the refutation stages a use from an
   * unsaved package in a new folder, and a use in the chokepoint's own file
   * past its range; Go has no re-export. The adapter only reports what the
   * instrument said about each; the check classifies them.
   */
  async refute(protectedThing: Definition, outsideOf: Definition | undefined, exempt?: string): Promise<Refutation> {
    const placed = await this.placement(protectedThing);
    if (typeof placed === "string") return { seen: false, staged: [], account: placed };
    if (placed.container !== undefined) return { seen: false, staged: [], account: `${placed.name} is a method or field of ${placed.container}, which no package-level name can stage, so no synthetic reference can be staged` };
    if (chokes(placed.scope)) return this.refusedByCompiler(protectedThing, { ...placed, scope: placed.scope });
    return this.stage(protectedThing, placed, outsideOf, exempt);
  }

  /** Open an overlay of a file with new text, returning what restores it: its previous overlay, or the disk again. */
  private overlay(file: string, text: string): () => void {
    const before = this.opened.get(file);
    this.open(file, text);
    return () => (before === undefined ? this.closeDocument(file) : this.change(file, before));
  }

  /** The diagnostics gopls publishes for an open document's current version, once it has diagnosed the change; undefined when none came. */
  private async diagnosticsOf(file: string): Promise<Diagnostic[] | undefined> {
    await this.settled();
    const version = this.versions.get(file);
    const deadline = Date.now() + PUBLISH_TIMEOUT_MS;
    for (;;) {
      const published = this.published.get(file);
      if (published !== undefined && published.version === version) return published.diagnostics;
      if (Date.now() >= deadline) return undefined;
      await new Promise((wake) => setTimeout(wake, 20));
    }
  }

  /** The statement that names an item from another package's file: a value is used, a type is pointed to. */
  private useOf(placed: Placement, qualifier: string | undefined): string {
    const named = qualifier === undefined ? placed.name : `${qualifier}.${placed.name}`;
    return VALUE_KINDS.has(placed.kind) ? `var _ = ${named}` : `var _ *${named}`;
  }

  /** The package folders of the item's module that lie outside its scope, where a refusal can be staged: inside the item's importable tree first, then a package main, which nothing imports, so no import cycle closes. */
  private refusalSites(placed: Placement & { scope: { kind: "package" | "subtree"; dir: string } }): { dir: string; packageName: string }[] {
    const files = this.walkedNow();
    const dirs = [...new Set(files.filter((f) => f.endsWith(".go") && !f.endsWith("_test.go")).map((f) => posix.dirname(f)))];
    const importable = goScopeOf(true, placed.dir, placed.module.dir);
    const sites: { dir: string; packageName: string; rank: number }[] = [];
    for (const dir of dirs) {
      if (insideScope(dir, placed.scope) || this.moduleOf(dir)?.dir !== placed.module.dir) continue;
      const packageName = this.packageNameIn(dir, files);
      if (packageName === undefined) continue;
      sites.push({ dir, packageName, rank: (insideScope(dir, importable) ? 0 : 2) + (packageName === "main" ? 0 : 1) });
    }
    return sites.sort((a, b) => a.rank - b.rank || a.dir.localeCompare(b.dir));
  }

  /** Stage a use from a package outside the item's scope, read gopls's refusal of it, and check the same use is accepted in the item's own file. */
  private async refusedByCompiler(protectedThing: Definition, placed: Placement & { scope: { kind: "package" | "subtree"; dir: string } }): Promise<Refutation> {
    const isModule = protectedThing.kind === "module";
    const use = isModule ? `import _ "${placed.importPath}"` : this.useOf(placed, "coherence_target");
    const sites = this.refusalSites(placed).slice(0, 3);
    if (sites.length === 0) return { seen: false, staged: [], account: `no package of module ${placed.module.path} lies outside ${scopeText(placed.scope, placed.module)}, so no use from outside it can be staged where gopls diagnoses it` };
    await this.indexed();
    const tried: string[] = [];
    for (const site of sites) {
      const synthetic = `${site.dir === "." ? "" : `${site.dir}/`}coherence_refutation_${randomBytes(4).toString("hex")}.go`;
      const text = isModule ? `package ${site.packageName}\n\n${use}\n` : `package ${site.packageName}\n\nimport coherence_target "${placed.importPath}"\n\n${use}\n`;
      const restores: (() => void)[] = [];
      try {
        this.probes.add(synthetic);
        this.publishedSince = [];
        restores.push(this.overlay(synthetic, text));
        const diagnostics = await this.diagnosticsOf(synthetic);
        if (this.publishedSince.some((m) => /import cycle not allowed/.test(m))) {
          tried.push(`${synthetic} closed an import cycle`);
          continue;
        }
        if (diagnostics === undefined) {
          tried.push(`gopls published no diagnostics for ${synthetic}`);
          continue;
        }
        const refusal = diagnostics.find((d) => (d.range.start.line === 2 && refusesInternal(d)) || (!isModule && d.range.start.line === 4 && refusesName(d)));
        if (refusal === undefined) return { seen: false, staged: [], account: `an unsaved file ${synthetic} with ${use} drew no refusal from gopls, so nothing proves the compiler refuses it` };
        if (isModule && !refusal.message.includes(placed.importPath)) return { seen: false, staged: [], account: `gopls refused ${use} in ${synthetic} for another package (${refusal.message}), so nothing is proved` };
        if (!isModule) {
          // The control: the same name used in the item's own file, which its package lets it be named in.
          const own = this.lines(protectedThing.file);
          const body = own[own.length - 1] === "" ? own.slice(0, -1) : own;
          restores.push(this.overlay(protectedThing.file, [...body, "", this.useOf(placed, undefined), ""].join("\n")));
          const control = (await this.diagnosticsOf(protectedThing.file))?.find((d) => d.range.start.line === body.length + 1 && refusesName(d));
          if (control !== undefined) return { seen: false, staged: [], account: `gopls refused ${this.useOf(placed, undefined)} inside ${protectedThing.file} too (${control.message}), so the name is wrong rather than unexported and nothing is proved` };
        }
        const refused = `gopls refused ${use} from package ${importPathOf(placed.module, site.dir)}: ${refusal.code ?? ""} ${refusal.message}, and accepted it inside ${scopeText(placed.scope, placed.module)}`;
        return { seen: true, staged: [], refused, account: `an unsaved file ${synthetic} importing ${placed.importPath} was refused: ${refused}` };
      } finally {
        for (const restore of restores.reverse()) restore();
        this.probes.delete(synthetic);
        this.touched.delete(synthetic);
      }
    }
    return { seen: false, staged: [], account: `no staging outside ${scopeText(placed.scope, placed.module)} could be read: ${tried.join("; ")}` };
  }

  /** Stage a use from an unsaved package in a new folder and a use in the chokepoint's own file past its range, ask for references once, and restore every overlay. */
  private async stage(protectedThing: Definition, placed: Placement, chokepoint: Definition | undefined, exempt?: string): Promise<Refutation> {
    if (placed.packageName === "main") return { seen: false, staged: [], account: `${placed.importPath} is a package main, which no package can import, so no use from outside it can be staged` };
    let target = placed;
    if (protectedThing.kind === "module") {
      // A file is reached through the names it declares: the first exported one is staged.
      const first = (await this.documentSymbols(protectedThing.file)).find((s) => isExported(identifierOf(s)) && METHOD_NAME.exec(s.name) === null);
      if (first === undefined) return { seen: false, staged: [], account: `${protectedThing.file} declares no exported package-level name, so no use from another package can be staged` };
      target = { ...placed, name: identifierOf(first), kind: first.kind };
    }
    // Where the chokepoint governs only references from outside a folder, the outside package is staged beside that folder.
    const beside = exempt === undefined ? (placed.module.dir === "." ? "" : `${placed.module.dir}/`) : outsideOfFolder(exempt);
    if (beside === undefined || !withinFolder(beside === "" ? "." : beside.replace(/\/$/, ""), placed.module.dir)) {
      return { seen: false, staged: [], account: `no folder of module ${placed.module.path} lies outside ${exempt ?? "the module"}, so no use from outside it could be staged; the check is vacuous` };
    }
    const outsidePackage = `coherence_refutation_${randomBytes(4).toString("hex")}`;
    const outside = `${beside}${outsidePackage}/${outsidePackage}.go`;
    const expected: { what: string; file: string; line: number }[] = [];
    const restores: (() => void)[] = [];
    await this.indexed();
    try {
      this.probes.add(outside);
      restores.push(this.overlay(outside, `package ${outsidePackage}\n\nimport coherence_target "${placed.importPath}"\n\n${this.useOf(target, "coherence_target")}\n`));
      expected.push({ what: `a use of ${target.name} from the unsaved package ${outside}${exempt === undefined ? "" : `, outside ${exempt}`}`, file: outside, line: 5 });
      // A module chokepoint has no inside outside its own range, and an exempted folder holding the chokepoint covers it on purpose.
      const exempted = exempt !== undefined && chokepoint !== undefined && withinFolder(chokepoint.file, exempt);
      if (chokepoint !== undefined && chokepoint.kind === "symbol" && !exempted) {
        const lines = this.lines(chokepoint.file);
        const body = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
        const samePackage = posix.dirname(chokepoint.file) === placed.dir && packageClause(body.join("\n")) === placed.packageName;
        let added = body;
        if (!samePackage) {
          // An import must precede every declaration, so it is placed right after the package clause, past nothing the chokepoint's range holds.
          const clause = body.findIndex((line) => /^\s*package\s/.test(line));
          added = [...body.slice(0, clause + 1), `import coherence_refutation_target "${placed.importPath}"`, ...body.slice(clause + 1)];
        }
        added = [...added, "", this.useOf(target, samePackage ? undefined : "coherence_refutation_target"), ""];
        restores.push(this.overlay(chokepoint.file, added.join("\n")));
        expected.unshift({ what: `a use of ${target.name} in ${chokepoint.file} outside ${chokepoint.name}`, file: chokepoint.file, line: added.length - 1 });
      }
      await this.settled();
      const sites = await this.references(protectedThing);
      const staged: StagedSite[] = expected.map((want) => {
        const hit = sites.find((s) => s.file === want.file && s.line === want.line);
        return { what: want.what, ...(hit === undefined ? {} : { site: hit }) };
      });
      const unseen = staged.filter((s) => s.site === undefined);
      return {
        seen: unseen.length === 0,
        staged,
        account: unseen.length === 0 ? `the instrument reported ${staged.map((s) => s.what).join(" and ")}` : `the instrument did not report ${unseen.map((s) => s.what).join(" or ")} among ${sites.length} references; the check is vacuous`,
      };
    } finally {
      for (const restore of restores.reverse()) restore();
      this.probes.delete(outside);
      this.touched.delete(outside);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    for (const wake of this.waiters.splice(0)) wake();
    if (client === undefined) return;
    try {
      await client.request("shutdown", null, 3_000);
      client.notify("exit", null);
      const deadline = Date.now() + 3_000;
      while (client.alive && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 25));
    } catch {
      // The server is going down either way.
    }
    if (client.alive) client.kill();
  }
}

/** One declaration a name resolves to: its file and its symbol. */
interface Candidate {
  file: string;
  symbol: DocumentSymbol;
}

/** One candidate: the only one, else the only one outside test files, else the only one under the component; ambiguity is reported, never guessed. */
function choose(candidates: Candidate[], hint: ResolveHint): Candidate | undefined {
  if (candidates.length === 1) return candidates[0];
  const nonTest = candidates.filter((c) => !isTestPath(c.file, hint.testFolders));
  if (nonTest.length === 1) return nonTest[0];
  const pool = nonTest.length > 0 ? nonTest : candidates;
  const prefix = hint.component === "." ? "" : hint.component + "/";
  const under = pool.filter((c) => c.file.startsWith(prefix));
  if (under.length === 1) return under[0];
  return undefined;
}
