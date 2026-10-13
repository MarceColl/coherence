/**
 * The Rust adapter: the language server protocol over stdio to
 * rust-analyzer, found on the machine (locateRustAnalyzer in installed.ts):
 * it is no npm package, so the resolver has nothing to resolve.
 *
 * The server is asked nothing before it says it is quiescent: rust-analyzer
 * reports `experimental/serverStatus` once the client asks for it, and an
 * answer before the Cargo workspace is loaded is silently partial. Symbols
 * resolve through workspace/symbol (a bare name, with every kind of symbol
 * searched) or the hinted file's textDocument/documentSymbol (`name in
 * file.rs`); a module is its file, and a folder is the module its `mod.rs`,
 * its sibling `X.rs` or its crate root declares. References come from
 * textDocument/references, every site a reference: a `use` the adapter reads
 * as an import, a `pub use` as a re-export, and a site inside a
 * `#[cfg(test)]` or `#[test]` item, or in a file whose module is declared
 * under one, as test code.
 *
 * Visibility is the item's declared visibility narrowed by every module
 * that encloses it, walked up through `experimental/parentModule` to the
 * crate root: rustc refuses a path to an item from outside that scope, so an
 * item whose scope stops short of the crate is visibility-choked. The
 * refutation never touches disk: rust-analyzer does not see an unsaved file
 * no module declares, so each synthetic module is staged as a pair, the file
 * itself and an unsaved overlay of the crate root declaring it, and every
 * overlay is restored when the refutation ends.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  type SiteForm,
  type StagedSite,
  type Visibility,
} from "./adapter.ts";
import { locateRustAnalyzer, type ServerLocation } from "./installed.ts";
import { JsonRpcClient, RpcError } from "./jsonrpc.ts";
import { keepProjectFiles, projectListing, walkBounds, walkedProjectFiles, type ProjectListing } from "./project-files.ts";

/** The small JSON-RPC surface the adapter needs, exposed so a test can control when the server is quiescent. */
export interface RustLanguageClient {
  onNotification: ((method: string, params: unknown) => void) | undefined;
  onRequest: ((method: string, params: unknown) => unknown | Promise<unknown>) | undefined;
  readonly alive: boolean;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params: unknown): void;
  kill(): void;
}

/** How the adapter starts its client: JsonRpcClient.spawn, or a test's controlled stand-in. */
export type RustClientFactory = (command: string, args: string[], cwd: string, env?: Record<string, string>) => RustLanguageClient;

const SERVER_BIN = "rust-analyzer";
/** How long a cold workspace may take to load before an indexed question gives up, as Python's enumeration does. */
const QUIESCENCE_TIMEOUT_MS = 10 * 60 * 1000;
/** How long an overlay change is given to flip the server out of quiescence before it is taken as already applied. */
const SETTLE_MS = 750;
const COHERENCE_ENFORCER = "Coherence's check at the edit and in CI";
const COMPILER = "the compiler (rustc)";

/**
 * Rust's rungs. rustc refuses a path to an item from outside its visibility
 * scope, so an item whose effective visibility stops short of the crate root
 * is visibility-choked; `pub(crate)` and `pub` reach the whole crate, where
 * the compiler constrains nothing a single-crate project could break, and
 * Coherence's own check is the enforcer.
 */
export const RUST_LADDER: Ladder = {
  top: "visibility-choked",
  because: "rustc refuses a path to an item from outside its visibility scope (private: its module and descendants; pub(super)/pub(in …): that module's subtree), so an item whose effective visibility stops short of the crate cannot be referenced from outside that scope",
  rungs: [
    { grade: "visibility-choked", enforcer: COMPILER, fact: "the protected item's effective visibility (its own and every enclosing module's) stops short of the crate root, so rustc refuses any reference from outside that scope" },
    { grade: "reference-choked", enforcer: COHERENCE_ENFORCER, fact: "the item is pub(crate) or pub and reachable crate-wide, and every resolved reference in the workspace is inside the chokepoint" },
  ],
};

/** Where rust-analyzer is, with every place looked. */
export function locateServer(root: string): ServerLocation {
  return locateRustAnalyzer(root, SERVER_BIN);
}

interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

interface SymbolInformation {
  name: string;
  kind: number;
  location: { uri: string; range: Range };
}

interface Location {
  uri: string;
  range: Range;
}

interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

interface Diagnostic {
  message: string;
  range: Range;
  severity?: number;
  code?: number | string;
}

/** The protocol's symbol kinds the adapter reads: a module, a trait, and the kinds that name a type rather than a value. */
const MODULE_KIND = 2;
const TRAIT_KIND = 11;
const TYPE_KINDS = new Set([5, 10, 11, 23, 26]);

/** Whether a diagnostic is rust-analyzer refusing a path: E0432 unresolved import, which it gives a private item's path, or rustc's own E0603. */
export function refusesPath(diagnostic: Pick<Diagnostic, "code" | "message">): boolean {
  return ["E0432", "E0603"].includes(String(diagnostic.code)) || /unresolved import|is private/.test(diagnostic.message);
}

/* ------------------------------------------------------------ reading the text */

/**
 * An item's header as written before its name, read apart: the attributes on
 * it (`cfg(test)`, `test`), and its declared visibility (`pub`, `pub(crate)`,
 * `pub(super)`, `pub(self)`, `pub(in path)`), or undefined for a private item.
 * Comments are dropped first, so a doc comment never reads as code.
 */
export function readHeader(text: string): { attributes: string[]; visibility: string | undefined } {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const attributes: string[] = [];
  let rest = "";
  for (let i = 0; i < plain.length; i++) {
    if (plain[i] === "#" && /^#!?\s*\[/.test(plain.slice(i, i + 4))) {
      let depth = 0;
      let j = plain.indexOf("[", i);
      const start = j;
      for (; j < plain.length; j++) {
        if (plain[j] === "[") depth += 1;
        else if (plain[j] === "]" && --depth === 0) break;
      }
      attributes.push(plain.slice(start + 1, j).trim());
      i = j;
      continue;
    }
    rest += plain[i];
  }
  const visibility = /^\s*(pub(?:\s*\(\s*(?:crate|super|self|in\s+[\w:]+)\s*\))?)/.exec(rest)?.[1]?.replace(/\s+/g, " ").replace(/\s*\(\s*/, "(").replace(/\s*\)/, ")");
  return { attributes, visibility };
}

/** Whether an attribute marks test code: `cfg(test)` or a test function's `test` (also `tokio::test` and the like). */
export function marksTest(attribute: string): boolean {
  return /^cfg\s*\(\s*test\s*\)$/.test(attribute) || /^(?:[\w]+::)*test$/.test(attribute);
}

/**
 * The syntactic form of a reference site: the statement it sits in, read back
 * from the site to the nearest `;` at its own nesting, or to a brace that
 * opens or closes around it. A statement opening `use` is an import and one
 * opening `pub use` (or `pub(…) use`) a re-export, a `use` inside a function
 * or a module included; every other site has no form. A `use` may stand
 * anywhere and be indented, so the statement start is read, never the line's.
 */
export function useForm(text: string, offset: number): SiteForm | undefined {
  const starts: number[] = [];
  let depth = 0;
  let i = offset - 1;
  for (; i >= 0; i--) {
    const c = text[i];
    if (c === "}") {
      if (depth === 0) starts.push(i + 1);
      depth += 1;
    } else if (c === "{") {
      if (depth === 0) starts.push(i + 1);
      else depth -= 1;
    } else if (c === ";" && depth === 0) break;
  }
  starts.push(i + 1);
  for (const start of starts) {
    const head = text.slice(start, offset).replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|#!?\[[^\]]*\])*/, "");
    const match = /^(pub(?:\s*\([^)]*\))?\s+)?use\b/.exec(head);
    if (match !== null) return match[1] === undefined ? "import" : "re-export";
  }
  return undefined;
}

/** The offset of a zero-based position in a text. */
function offsetOf(lines: readonly string[], position: Position): number {
  let offset = 0;
  for (let i = 0; i < position.line && i < lines.length; i++) offset += (lines[i] ?? "").length + 1;
  return offset + position.character;
}

/** The text between two positions of a file's lines. */
function textBetween(lines: readonly string[], start: Position, end: Position): string {
  const joined = lines.join("\n");
  return joined.slice(offsetOf(lines, start), offsetOf(lines, end));
}

function flatten(symbols: DocumentSymbol[], prefix: DocumentSymbol[] = []): { path: DocumentSymbol[]; symbol: DocumentSymbol }[] {
  const out: { path: DocumentSymbol[]; symbol: DocumentSymbol }[] = [];
  for (const symbol of symbols) {
    const path = [...prefix, symbol];
    out.push({ path, symbol });
    if (symbol.children !== undefined) out.push(...flatten(symbol.children, path));
  }
  return out;
}

function samePosition(a: Position, b: Position): boolean {
  return a.line === b.line && a.character === b.character;
}

/* ------------------------------------------------------------ scopes */

/** A visibility scope: a module, by its path from the crate root, or the world outside the crate. */
type Scope = { kind: "public" } | { kind: "module"; path: string[] };

function scopeText(scope: Scope): string {
  return scope.kind === "public" ? "outside the crate" : scope.path.length === 0 ? "crate" : `crate::${scope.path.join("::")}`;
}

/** The scope a declared visibility gives an item declared in a module (`at`), or undefined for a `pub(in …)` path that leaves the module tree. */
export function scopeOf(visibility: string | undefined, at: readonly string[]): Scope | undefined {
  if (visibility === undefined || visibility === "pub(self)") return { kind: "module", path: [...at] };
  if (visibility === "pub") return { kind: "public" };
  if (visibility === "pub(crate)") return { kind: "module", path: [] };
  if (visibility === "pub(super)") return { kind: "module", path: at.slice(0, Math.max(0, at.length - 1)) };
  const inPath = /^pub\(in (.+)\)$/.exec(visibility)?.[1];
  if (inPath === undefined) return undefined;
  let path: string[] = [];
  for (const [index, segment] of inPath.split("::").entries()) {
    if (segment === "crate" && index === 0) path = [];
    else if (segment === "self" && index === 0) path = [...at];
    else if (segment === "super") path = (index === 0 ? [...at] : path).slice(0, -1);
    else path.push(segment);
  }
  return { kind: "module", path };
}

/** The narrower of two scopes: every scope on an item's chain encloses its module, so the deeper module is the narrower. */
function narrower(a: Scope, b: Scope): Scope {
  if (a.kind === "public") return b;
  if (b.kind === "public") return a;
  return b.path.length > a.path.length ? b : a;
}

/** One module on the way from an item to its crate root: its name, the file declaring it, and how it is declared. */
interface ModuleStep {
  name: string;
  /** The file holding the `mod` declaration, project-relative. */
  declaredIn: string;
  visibility: string | undefined;
  attributes: string[];
}

/** What the module chain says about a definition: its module's path, its crate root, its effective scope, and how that was read. */
interface Placement {
  /** The module the item is declared in (for a module: the module itself), by its path from the crate root. */
  module: string[];
  /** The crate root file, project-relative. */
  crateRoot: string;
  /** The item's own declared visibility, or "the module" for a module definition. */
  declared: string;
  scope: Scope;
  /** The enclosing symbols that are not modules (an impl, a trait, a function), outermost first. */
  containers: string[];
  /** The item's name as declared. */
  name: string;
  kind: number;
}

/* ------------------------------------------------------------ the adapter */

export class RustAdapter implements LanguageAdapter {
  readonly language = "rust";
  readonly ladder = RUST_LADDER;
  readonly root: string;
  private readonly clientFactory: RustClientFactory;
  private client: RustLanguageClient | undefined;
  private starting: Promise<{ ok: true } | { ok: false; reason: string }> | undefined;
  /** The text of every document the adapter has open, which the server reads instead of the disk. */
  private readonly opened = new Map<string, string>();
  /** The document version last sent per open file; a change carries the next one. */
  private readonly versions = new Map<string, number>();
  private readonly symbolCache = new Map<string, DocumentSymbol[]>();
  private readonly lineCache = new Map<string, string[]>();
  private readonly placements = new Map<string, Placement | string>();
  /** Per file, whether its module is declared under a test attribute, read once per forget. */
  private readonly testModules = new Map<string, boolean>();
  /** Files a definition or a reference site landed in since the last forget: the ones a forget re-reads from disk. */
  private readonly touched = new Set<string>();
  /** The unsaved documents a refutation has open right now, the one site outside the project's files it accepts. */
  private readonly probes = new Set<string>();
  /** The project's files and git's listing, each taken once per forget. */
  private walked: string[] | undefined;
  private listing: { taken: ProjectListing | undefined } | undefined;
  /** The server's last status: quiescent once the workspace is loaded and every change applied, with its health. */
  private status: { quiescent: boolean; health: string; message: string | undefined } = { quiescent: false, health: "ok", message: undefined };
  /** Bumped at every status the server sends, so a wait can tell a change was taken up. */
  private generation = 0;
  private waiters: (() => void)[] = [];
  /** The scratch temp folder the server runs with, removed at close: its proc-macro server leaves empty folders in TMPDIR even when it exits cleanly. */
  private scratch: string | undefined;

  constructor(root: string, clientFactory: RustClientFactory = JsonRpcClient.spawn) {
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
    // Build scripts and proc macros cost readiness time (about 14 s against 6 s on a 14k-line crate) and buy references inside expanded code.
    const lean = process.env["COHERENCE_RUST_LEAN"] === "1";
    return {
      // Flycheck would run cargo and write target/: the check asks the server, never the build.
      checkOnSave: false,
      cargo: { features: "all", buildScripts: { enable: !lean } },
      procMacro: { enable: !lean },
      workspace: { symbol: { search: { kind: "all_symbols", scope: "workspace" } } },
      // An unresolved import is an experimental diagnostic, and it is the refusal the refutation reads.
      diagnostics: { enable: true, experimental: { enable: true } },
      files: { watcher: "server" },
    };
  }

  private async start(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const server = locateServer(this.root);
    if (!server.found) {
      return { ok: false, reason: `${SERVER_BIN} not found; looked at ${server.looked.join("; ")}. Install it: rustup component add rust-analyzer rust-src` };
    }
    this.scratch ??= mkdtempSync(join(tmpdir(), "coherence-rust-analyzer-"));
    const client = this.clientFactory(server.command, server.args, this.root, { TMPDIR: this.scratch });
    this.client = client;
    this.status = { quiescent: false, health: "ok", message: undefined };
    const settings = this.settings();
    client.onNotification = (method, params) => {
      if (method !== "experimental/serverStatus") return;
      const status = params as { quiescent?: boolean; health?: string; message?: string | null };
      this.status = { quiescent: status.quiescent === true, health: status.health ?? "ok", message: status.message ?? undefined };
      this.generation += 1;
      if (this.status.quiescent) for (const wake of this.waiters.splice(0)) wake();
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
            textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, diagnostic: {}, publishDiagnostics: {} },
            workspace: { configuration: true, symbol: {}, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: false } },
            experimental: { serverStatusNotification: true },
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

  private async live(): Promise<RustLanguageClient> {
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
    if (this.status.quiescent) return Promise.resolve();
    return new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`${SERVER_BIN} did not finish loading the workspace in ${QUIESCENCE_TIMEOUT_MS / 60000} minutes`)), QUIESCENCE_TIMEOUT_MS);
      timer.unref();
      this.waiters.push(() => {
        clearTimeout(timer);
        done();
      });
    });
  }

  /** The live client once rust-analyzer has loaded the workspace and applied every change; an answer before that is silently partial. */
  private async indexed(): Promise<RustLanguageClient> {
    const client = await this.live();
    await this.quiescence();
    if (this.status.health === "error") throw new Error(`${SERVER_BIN} reported ${this.status.message ?? "an error loading the workspace"}`);
    return client;
  }

  /** After a change: give the server a moment to leave quiescence, then wait until it is back. */
  private async settled(): Promise<RustLanguageClient> {
    const client = await this.indexed();
    const before = this.generation;
    const deadline = Date.now() + SETTLE_MS;
    while (this.generation === before && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 20));
    return this.indexed().then(() => client);
  }

  /**
   * One indexed question, asked again once the server has settled whenever it
   * cancels the answer for a newer change (content modified, server
   * cancelled), as it does while an overlay is applied or restored.
   */
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

  private uri(file: string): string {
    return pathToFileURL(join(this.root, file)).href;
  }

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

  private open(file: string, text: string): void {
    if (this.opened.has(file)) return this.change(file, text);
    this.client!.notify("textDocument/didOpen", { textDocument: { uri: this.uri(file), languageId: "rust", version: 1, text } });
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

  private closeDocument(file: string): void {
    if (!this.opened.has(file)) return;
    this.client!.notify("textDocument/didClose", { textDocument: { uri: this.uri(file) } });
    this.opened.delete(file);
    this.versions.delete(file);
    this.lineCache.delete(file);
    this.symbolCache.delete(file);
  }

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

  /** The header of a symbol: its attributes and declared visibility, read from the text before its name. */
  private headerOf(file: string, symbol: DocumentSymbol): { attributes: string[]; visibility: string | undefined } {
    return readHeader(textBetween(this.lines(file), symbol.range.start, symbol.selectionRange.start));
  }

  /**
   * Cached facts about files are dropped, and the server is made to see the
   * current disk text of every document the adapter has open, every file
   * touched since the last forget and every file the caller names: each gets
   * its whole disk text as an open document (a file gone from disk is closed
   * and reported deleted), the server is told the named files changed on
   * disk, a changed Cargo.toml or Cargo.lock reloads the workspace, and the
   * forget resolves once the server is quiescent again and has answered a
   * documentSymbol for each synced file, which it cannot give before the
   * change is applied.
   */
  async forget(files: readonly string[] = []): Promise<void> {
    this.symbolCache.clear();
    this.lineCache.clear();
    this.placements.clear();
    this.testModules.clear();
    this.walked = undefined;
    this.listing = undefined;
    if (this.client === undefined) return;
    // A named file that is not the project's (a nested checkout's copy, an ignored file) is never opened.
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
      if (!file.endsWith(".rs")) continue;
      this.open(file, readFileSync(path, "utf8"));
      synced.push(file);
    }
    for (const file of files.filter((f) => named.has(f) && existsSync(join(this.root, f)))) changes.push({ uri: this.uri(file), type: 2 });
    if (changes.length > 0) this.client.notify("workspace/didChangeWatchedFiles", { changes });
    if (files.some((f) => /(^|\/)Cargo\.(toml|lock)$/.test(f))) {
      this.status = { ...this.status, quiescent: false };
      await this.client.request("rust-analyzer/reloadWorkspace", null).catch(() => undefined);
    }
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
      return { ok: false, reason: `"${name}" is prose, not a symbol or a module; write the item (\`write_class\`), the item in its file (\`write_class in src/kernel/mod.rs\`), or the module path` };
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

  /** A module path: a `.rs` file; a folder is its `mod.rs`, else its sibling `X.rs`, and a crate folder (one holding Cargo.toml) its library root, else its binary root. */
  private async resolveModule(name: string, path: string): Promise<Resolved> {
    const isFile = (rel: string): boolean => existsSync(join(this.root, rel)) && statSync(join(this.root, rel)).isFile();
    const base = path === "." ? "" : `${path}/`;
    const file = path.endsWith(".rs")
      ? path
      : isFile(`${base}Cargo.toml`)
        ? [`${base}src/lib.rs`, `${base}src/main.rs`].find(isFile)
        : [`${base}mod.rs`, `${path}.rs`].find(isFile);
    if (file === undefined || !isFile(file)) return { ok: false, reason: `module ${path} is not a Rust module file under the project (a .rs file, a folder with mod.rs or a sibling .rs, or a crate folder)` };
    if (!keepProjectFiles(this.root, [file]).has(file)) return { ok: false, reason: `module ${file} is not one of the project's files (ignored, or inside a nested checkout)` };
    const lines = this.lines(file);
    const symbols = await this.documentSymbols(file);
    const first = symbols.find((s) => this.headerOf(file, s).visibility !== undefined);
    this.touched.add(file);
    return {
      ok: true,
      definition: {
        name,
        kind: "module",
        file,
        range: { start: { line: 0, character: 0 }, end: { line: Math.max(0, lines.length - 1), character: (lines[lines.length - 1] ?? "").length } },
        selection: first?.selectionRange.start ?? { line: 0, character: 0 },
      },
    };
  }

  private async searchWorkspace(name: string): Promise<Candidate[]> {
    const found = await this.ask<SymbolInformation[] | null>("workspace/symbol", { query: name });
    const files = new Set<string>();
    for (const info of found ?? []) {
      if (info.name !== name) continue;
      const file = this.relative(info.location.uri);
      if (file.startsWith("..") || !file.endsWith(".rs")) continue;
      files.add(file);
    }
    const own = keepProjectFiles(this.root, [...files], this.listingNow());
    const candidates: Candidate[] = [];
    for (const file of [...files].filter((f) => own.has(f)).sort()) candidates.push(...(await this.declarationsIn(file, name)));
    return candidates;
  }

  private async searchFiles(name: string, fileHint: string): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const file of this.walkedNow().filter((rel) => rel.endsWith(".rs") && (rel === fileHint || rel.endsWith(`/${fileHint}`)))) candidates.push(...(await this.declarationsIn(file, name)));
    return candidates;
  }

  /** The items named `name` in a file, at any depth: an item of an inline module is a module member too. */
  private async declarationsIn(file: string, name: string): Promise<Candidate[]> {
    return flatten(await this.documentSymbols(file))
      .filter((entry) => entry.symbol.name === name)
      .map((entry) => ({ file, symbol: entry.symbol }));
  }

  async references(definition: Definition): Promise<ReferenceSite[]> {
    this.touched.add(definition.file);
    const starts: Position[] = [];
    if (definition.kind === "module") {
      for (const symbol of await this.documentSymbols(definition.file)) if (this.headerOf(definition.file, symbol).visibility !== undefined) starts.push(symbol.selectionRange.start);
    } else {
      starts.push(definition.selection);
    }
    const reported: Location[] = [];
    for (const position of starts) {
      const locations = await this.ask<Location[] | null>("textDocument/references", { textDocument: { uri: this.uri(definition.file) }, position, context: { includeDeclaration: false } });
      reported.push(...(locations ?? []));
    }
    // Only the project's own files are evidence: a site in a dependency, the registry or an ignored target/ is dropped before it is read.
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
      const lines = this.lines(file);
      const form = useForm(lines.join("\n"), offsetOf(lines, start));
      const { symbol, test } = await this.enclosing(file, start);
      sites.push({ file, line: start.line + 1, character: start.character, symbol, ...(form === undefined ? {} : { form }), ...(test ? { test: true as const } : {}) });
    }
    sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character);
    return sites;
  }

  /** The innermost named item enclosing a position, as `outer.inner`, and whether the site is test code: under a test attribute, or in a file whose module is. */
  private async enclosing(file: string, position: Position): Promise<{ symbol: string | undefined; test: boolean }> {
    let symbols: DocumentSymbol[];
    try {
      symbols = await this.documentSymbols(file);
    } catch {
      return { symbol: undefined, test: false };
    }
    let best: { path: DocumentSymbol[]; symbol: DocumentSymbol } | undefined;
    for (const entry of flatten(symbols)) {
      if (!rangeContains(entry.symbol.range, position)) continue;
      if (best === undefined || entry.path.length > best.path.length) best = entry;
    }
    const marked = (best?.path ?? []).some((s) => this.headerOf(file, s).attributes.some(marksTest));
    return { symbol: best?.path.map((s) => s.name).join("."), test: marked || (await this.inTestModule(file)) };
  }

  /** Whether a file's module, or a module above it, is declared under `#[cfg(test)]`: `#[cfg(test)] mod tests;` keeps a whole file of tests. */
  private async inTestModule(file: string): Promise<boolean> {
    const known = this.testModules.get(file);
    if (known !== undefined) return known;
    let test = false;
    try {
      const chain = await this.moduleChain(file, { line: 0, character: 0 });
      test = chain.steps.some((step) => step.attributes.some(marksTest));
    } catch {
      test = false;
    }
    this.testModules.set(file, test);
    return test;
  }

  /**
   * The modules from a position up to its crate root, innermost first, each
   * read at its `mod` declaration: `experimental/parentModule` answers the
   * declaration of the module holding a position (asked at a declaration, the
   * module above it), and at a crate root it answers the Cargo.toml.
   */
  private async moduleChain(file: string, position: Position): Promise<{ steps: ModuleStep[]; crateRoot: string | undefined }> {
    const steps: ModuleStep[] = [];
    let at = { file, position };
    for (let guard = 0; guard < 64; guard++) {
      const answer = await this.ask<(Location | LocationLink)[] | Location | null>("experimental/parentModule", { textDocument: { uri: this.uri(at.file) }, position: at.position });
      const first = Array.isArray(answer) ? answer[0] : (answer ?? undefined);
      if (first === undefined) return { steps, crateRoot: undefined };
      const uri = "targetUri" in first ? first.targetUri : first.uri;
      const range = "targetUri" in first ? first.targetSelectionRange : first.range;
      const declaredIn = this.relative(uri);
      if (!declaredIn.endsWith(".rs")) return { steps, crateRoot: at.file };
      const declaration = flatten(await this.documentSymbols(declaredIn)).find((e) => e.symbol.kind === MODULE_KIND && samePosition(e.symbol.selectionRange.start, range.start));
      const header = declaration === undefined ? { attributes: [], visibility: undefined } : this.headerOf(declaredIn, declaration.symbol);
      steps.push({ name: textBetween(this.lines(declaredIn), range.start, range.end), declaredIn, ...header });
      at = { file: declaredIn, position: range.start };
    }
    return { steps, crateRoot: undefined };
  }

  /** Where a definition sits in its crate's module tree, and the scope rustc lets it be named in; a reason when the tree cannot be read. */
  private async placement(definition: Definition): Promise<Placement | string> {
    const key = `${definition.file}:${definition.selection.line}:${definition.selection.character}:${definition.kind}`;
    const cached = this.placements.get(key);
    if (cached !== undefined) return cached;
    const placed = await this.place(definition);
    this.placements.set(key, placed);
    return placed;
  }

  private async place(definition: Definition): Promise<Placement | string> {
    const isModule = definition.kind === "module";
    let entry: { path: DocumentSymbol[]; symbol: DocumentSymbol } | undefined;
    if (!isModule) {
      entry = flatten(await this.documentSymbols(definition.file)).find((e) => samePosition(e.symbol.selectionRange.start, definition.selection));
      if (entry === undefined) return `no item declared at ${definition.file}:${definition.selection.line + 1}`;
    }
    const chain = await this.moduleChain(definition.file, isModule ? { line: 0, character: 0 } : definition.selection);
    if (chain.crateRoot === undefined) return `${definition.file} is in no module tree rust-analyzer knows: no mod declaration reaches it from a crate root`;
    const module = chain.steps.map((s) => s.name).reverse();
    let scope: Scope = { kind: "public" };
    // Each module on the chain is declared in the one above it; its declared visibility is relative to that one.
    chain.steps.forEach((step, index) => {
      const parent = module.slice(0, module.length - index - 1);
      scope = narrower(scope, scopeOf(step.visibility, parent) ?? { kind: "module", path: parent });
    });
    let declared = "the module";
    if (entry !== undefined) {
      const own = this.headerOf(definition.file, entry.symbol).visibility;
      declared = own ?? "private";
      scope = narrower(scope, scopeOf(own, module) ?? { kind: "module", path: module });
    }
    const containers = (entry?.path.slice(0, -1) ?? []).filter((s) => s.kind !== MODULE_KIND).map((s) => s.name);
    return { module, crateRoot: chain.crateRoot, declared, scope, containers, name: entry?.symbol.name ?? module[module.length - 1] ?? "crate", kind: entry?.symbol.kind ?? MODULE_KIND };
  }

  async visibility(definition: Definition, _chokepoint?: Definition): Promise<Visibility> {
    const placed = await this.placement(definition);
    if (typeof placed === "string") {
      return { enforced: false, visible: true, evidence: placed, rung: { grade: "reference-choked", enforcer: COHERENCE_ENFORCER, fact: `${placed}, so nothing the compiler enforces is read; every resolved reference is inside the chokepoint` } };
    }
    const where = placed.module.length === 0 ? "the crate root" : `crate::${placed.module.join("::")}`;
    const evidence = `${definition.kind === "module" ? `module ${where}` : `${placed.declared} ${placed.name} in ${where}`}; reachable within ${scopeText(placed.scope)}`;
    const choked = placed.scope.kind === "module" && placed.scope.path.length > 0;
    const rung: Rung = choked
      ? { grade: "visibility-choked", enforcer: COMPILER, fact: `rustc refuses any reference outside ${scopeText(placed.scope)} (${evidence}), and every reference inside it is inside the chokepoint` }
      : { grade: "reference-choked", enforcer: COHERENCE_ENFORCER, fact: `reachable crate-wide (${evidence}); every resolved reference in the workspace is inside the chokepoint` };
    return { enforced: true, visible: !choked, evidence, rung };
  }

  testFilter(via: string): string {
    return via;
  }

  /**
   * For an item whose scope stops short of the crate, rustc's refusal of a
   * path to it from outside that scope is the refutation (ruling
   * rs-e93ecdd6): a synthetic module declared from the crate root uses it,
   * and the refusal is read back from the pulled diagnostics, with a control
   * use inside the item's own module that must not be refused, so a wrong
   * path is never read as privacy. For everything else the refutation stages
   * the sites the import ruling could otherwise swallow (d-7abd1ba8): a
   * re-export from a synthetic module, and a use in the chokepoint's own file
   * past its range. The adapter only reports what the instrument said about
   * each; the check classifies them.
   */
  async refute(protectedThing: Definition, outsideOf: Definition | undefined, exempt?: string): Promise<Refutation> {
    const placed = await this.placement(protectedThing);
    if (typeof placed === "string") return { seen: false, staged: [], account: placed };
    if (placed.containers.length > 0) return { seen: false, staged: [], account: `${placed.name} is an item of ${placed.containers.join("::")}, which no use path can name, so no synthetic reference can be staged` };
    const path = `crate::${[...placed.module, ...(protectedThing.kind === "module" ? [] : [placed.name])].join("::")}`;
    if (placed.scope.kind === "module" && placed.scope.path.length > 0) return this.refusedByCompiler(protectedThing, placed, path);
    return this.stage(protectedThing, placed, path, outsideOf, exempt);
  }

  /** The crate root's text with synthetic modules declared at its end. */
  private declaring(crateRoot: string, modules: readonly string[]): string {
    const original = this.lines(crateRoot).join("\n");
    return `${original.endsWith("\n") ? original : `${original}\n`}${modules.map((m) => `mod ${m};\n`).join("")}`;
  }

  /** Open an overlay of a file with new text, returning what restores it: its previous overlay, or the disk again. */
  private overlay(file: string, text: string): () => void {
    const before = this.opened.get(file);
    this.open(file, text);
    return () => (before === undefined ? this.closeDocument(file) : this.change(file, before));
  }

  /** Every diagnostic on a document, pulled once the server has applied the change. */
  private async pullDiagnostics(file: string): Promise<Diagnostic[]> {
    await this.settled();
    return (await this.ask<{ items?: Diagnostic[] } | null>("textDocument/diagnostic", { textDocument: { uri: this.uri(file) } }))?.items ?? [];
  }

  private async refusedByCompiler(protectedThing: Definition, placed: Placement, path: string): Promise<Refutation> {
    const module = `coherence_refutation_${randomBytes(4).toString("hex")}`;
    const synthetic = `${dirname(placed.crateRoot) === "." ? "" : `${dirname(placed.crateRoot)}/`}${module}.rs`;
    const use = `use ${path} as coherence_refutation_use;`;
    const text = `#[allow(unused_imports)]\n${use}\n`;
    // The control: the same path used inside the item's own module, which rustc lets name it.
    const own = this.lines(protectedThing.file);
    const after = protectedThing.kind === "module" ? own.length : protectedThing.range.end.line + 1;
    const controlled = [...own.slice(0, after), "#[allow(unused_imports)]", `use ${path} as coherence_refutation_control;`, ...own.slice(after)].join("\n");
    await this.indexed();
    const restores: (() => void)[] = [];
    try {
      this.probes.add(synthetic);
      restores.push(this.overlay(synthetic, text));
      restores.push(this.overlay(placed.crateRoot, this.declaring(placed.crateRoot, [module])));
      const refusal = (await this.pullDiagnostics(synthetic)).find((d) => d.range.start.line === 1 && refusesPath(d));
      restores.push(this.overlay(protectedThing.file, controlled));
      const control = (await this.pullDiagnostics(protectedThing.file)).find((d) => d.range.start.line === after + 1 && refusesPath(d));
      if (refusal === undefined) return { seen: false, staged: [], account: `an unsaved module ${synthetic} declared from ${placed.crateRoot} with ${use} drew no refusal from rust-analyzer, so nothing proves rustc refuses the path` };
      if (control !== undefined) return { seen: false, staged: [], account: `rust-analyzer refused ${use} inside ${protectedThing.file} too (${refusal.code ?? ""} ${control.message}), so the path is wrong rather than private and nothing is proved` };
      const refused = `rust-analyzer refused use ${path} from the crate root: ${refusal.code ?? ""} ${refusal.message} (rustc refuses it as E0603), and accepted it inside ${scopeText(placed.scope)}`;
      return { seen: true, staged: [], refused, account: `an unsaved module ${synthetic} declared from ${placed.crateRoot} with ${use} was refused: ${refused}` };
    } finally {
      for (const restore of restores.reverse()) restore();
      this.probes.delete(synthetic);
      this.touched.delete(synthetic);
    }
  }

  /** The line a use of the item takes in a function body: a value is named, a type or a trait is used as one. */
  private useOf(placed: Placement, path: string): string {
    if (placed.kind === TRAIT_KIND) return `let _: Option<&dyn ${path}> = None;`;
    if (TYPE_KINDS.has(placed.kind)) return `let _: Option<${path}> = None;`;
    return `let _ = ${path};`;
  }

  /** The file that declares the modules of a folder: the crate root for its own folder, else the folder's mod.rs or its sibling .rs. */
  private ownerOf(folder: string, crateRoot: string): string | undefined {
    const dir = folder.replace(/\/$/, "") || ".";
    if (dir === dirname(crateRoot)) return crateRoot;
    return [`${dir}/mod.rs`, `${dir}.rs`].find((f) => this.opened.has(f) || existsSync(join(this.root, f)));
  }

  /** Stage the synthetic sites the import ruling could otherwise swallow, ask for references once, and restore every overlay. */
  private async stage(protectedThing: Definition, placed: Placement, path: string, chokepoint: Definition | undefined, exempt?: string): Promise<Refutation> {
    const module = `coherence_refutation_${randomBytes(4).toString("hex")}`;
    const rootDir = dirname(placed.crateRoot) === "." ? "" : `${dirname(placed.crateRoot)}/`;
    const synthetic = `${rootDir}${module}.rs`;
    const expected: { what: string; file: string; line: number }[] = [];
    const restores: (() => void)[] = [];
    await this.indexed();
    try {
      // A re-export widens the item's reach wherever it stands.
      this.probes.add(synthetic);
      restores.push(this.overlay(synthetic, `#[allow(unused_imports)]\npub(crate) use ${path} as coherence_refutation_reexport;\n`));
      expected.push({ what: `a re-export of ${placed.name} from the unsaved module ${synthetic}`, file: synthetic, line: 2 });
      const declared = [module];
      // Where the chokepoint governs only references from outside a folder, a plain use from outside it must still be a bypass.
      const beside = exempt === undefined ? undefined : outsideOfFolder(exempt);
      const owner = beside === undefined ? undefined : this.ownerOf(beside, placed.crateRoot);
      const outsideModule = `coherence_refutation_${randomBytes(4).toString("hex")}`;
      const outside = beside === undefined || owner === undefined ? undefined : `${beside}${outsideModule}.rs`;
      if (outside !== undefined) {
        this.probes.add(outside);
        restores.push(this.overlay(outside, `#[allow(dead_code)]\nfn coherence_refutation_use() {\n    ${this.useOf(placed, path)}\n}\n`));
        expected.push({ what: `a use of ${placed.name} from the unsaved module ${outside}, outside ${exempt}`, file: outside, line: 3 });
        if (owner === placed.crateRoot) declared.push(outsideModule);
        else restores.push(this.overlay(owner!, this.declaring(owner!, [outsideModule])));
      }
      restores.push(this.overlay(placed.crateRoot, this.declaring(placed.crateRoot, declared)));
      // A module chokepoint has no inside outside its own range, and an exempted folder holding the chokepoint covers it on purpose.
      const exempted = exempt !== undefined && chokepoint !== undefined && withinFolder(chokepoint.file, exempt);
      if (chokepoint !== undefined && chokepoint.kind === "symbol" && !exempted) {
        const lines = this.lines(chokepoint.file);
        const body = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
        const added = ["#[allow(dead_code)]", "fn coherence_refutation_same_module() {", `    ${this.useOf(placed, path)}`, "}", ""];
        restores.push(this.overlay(chokepoint.file, [...body, ...added].join("\n")));
        expected.unshift({ what: `a use of ${placed.name} in ${chokepoint.file} outside ${chokepoint.name}`, file: chokepoint.file, line: body.length + 3 });
      }
      await this.settled();
      const sites = await this.references(protectedThing);
      const staged: StagedSite[] = expected.map((want) => {
        const hit = sites.find((s) => s.file === want.file && s.line === want.line);
        return { what: want.what, ...(hit === undefined ? {} : { site: hit }) };
      });
      const unseen = staged.filter((s) => s.site === undefined);
      if (exempt !== undefined && beside !== undefined && outside === undefined) {
        return { seen: false, staged, account: `no module file declares the modules of ${beside === "" ? "the root" : beside}, so no use from outside ${exempt} could be staged; the check is vacuous` };
      }
      return {
        seen: unseen.length === 0,
        staged,
        account: unseen.length === 0 ? `the instrument reported ${staged.map((s) => s.what).join(" and ")}` : `the instrument did not report ${unseen.map((s) => s.what).join(" or ")} among ${sites.length} references; the check is vacuous`,
      };
    } finally {
      for (const restore of restores.reverse()) restore();
      for (const file of [synthetic, ...expected.map((e) => e.file).filter((f) => this.probes.has(f))]) {
        this.probes.delete(file);
        this.touched.delete(file);
      }
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    for (const wake of this.waiters.splice(0)) wake();
    const scratch = this.scratch;
    this.scratch = undefined;
    if (client === undefined) {
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
      return;
    }
    try {
      await client.request("shutdown", null, 3_000);
      client.notify("exit", null);
      // Left to exit, rust-analyzer stops its proc-macro server, which removes its own temp folder; a kill would leave it behind.
      const deadline = Date.now() + 3_000;
      while (client.alive && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 25));
    } catch {
      // The server is going down either way.
    }
    if (client.alive) client.kill();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

interface Candidate {
  file: string;
  symbol: DocumentSymbol;
}

/** One candidate: the only one, else the only one outside test folders, else the only one under the component; ambiguity is reported, never guessed. */
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
