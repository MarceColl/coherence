/**
 * The TypeScript adapter: the language server protocol over stdio to
 * typescript-language-server, resolved from the adopter's project first,
 * then from Coherence's own module (it is an optional dependency), then on
 * PATH; never by a path built by hand (installed.ts).
 *
 * Symbols resolve through workspace/symbol (a bare name) or the hinted
 * file's textDocument/documentSymbol (`name in file.ts`); a module is its
 * file. References come from textDocument/references, and every site the
 * server reports is a reference, an import or re-export specifier
 * included: the adapter reports the syntactic form it read at the site and
 * exempts nothing, and what the form means is the check's question, not the
 * adapter's. A wildcard re-export (`export * from`) names no symbol, so the
 * server reports no site for it and the adapter scans its own source files
 * for one, once per forget. Exportedness is not in the protocol, so the
 * adapter reads the declaration text. The refutation stages a re-export
 * beside the protected thing and a use in the chokepoint's own module past
 * its range; for a thing the module does not export, it opens the synthetic
 * import instead and reads the compiler's refusal back from the published
 * diagnostics.
 *
 * TypeScript enforces visibility: a symbol not exported from its module is
 * unreachable from any other module, so the top rung is visibility-choked.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import {
  isTestPath,
  outsideOfFolder,
  parseName,
  rangeContains,
  statementStartLine,
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
  type SiteForm,
  type StagedSite,
  type Visibility,
} from "./adapter.ts";
import { locateServer as locateInstalled, locateTsserver, type ServerLocation } from "./installed.ts";
import { JsonRpcClient } from "./jsonrpc.ts";
import { horizonFolders, keepHorizonFiles, keepProjectFiles, projectListing, walkBounds, walkedProjectFiles, type ProjectListing } from "./project-files.ts";

const SERVER_BIN = "typescript-language-server";
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const SOURCE_EXTENSIONS = new Set([...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS]);

/**
 * The sources the project is written in: when any TypeScript source is in the
 * walk, only the TypeScript sources, since a JavaScript file beside them is
 * compiled output a repository tracks (`dist/`, `lib/`) or a loose script,
 * and a seed or a text search that reaches for it lands in an inferred
 * project around the compiled copy; a project with no TypeScript source is
 * written in JavaScript, and those files are its sources. A mixed project
 * that compiles with `allowJs` still has a TypeScript seed, and the project
 * that seed loads includes its JavaScript modules, so their symbols resolve
 * through the server rather than through this list.
 */
export function projectSources(files: readonly string[]): string[] {
  const sources = files.filter((rel) => SOURCE_EXTENSIONS.has(extensionOf(rel)) && !/\.d\.ts$/.test(rel));
  const typescript = sources.filter((rel) => TYPESCRIPT_EXTENSIONS.has(extensionOf(rel)));
  return typescript.length > 0 ? typescript : sources;
}

/** The LSP language id tsserver expects for a file: a JavaScript file opened as "typescript" is parsed as TypeScript, is not the file the project knows, and every later query about it fails. */
function languageIdOf(file: string): "typescript" | "typescriptreact" | "javascript" | "javascriptreact" {
  const extension = extensionOf(file);
  if (extension === ".tsx") return "typescriptreact";
  if (extension === ".jsx") return "javascriptreact";
  return JAVASCRIPT_EXTENSIONS.has(extension) ? "javascript" : "typescript";
}

/** The extension a synthetic document beside `file` takes, so the project that includes `file` includes the synthetic too: a `.ts` probe beside a `.mjs` module lands in an inferred project the references query never sees. */
function syntheticExtensionBeside(file: string): string {
  const extension = extensionOf(file);
  return JAVASCRIPT_EXTENSIONS.has(extension) ? extension : ".ts";
}

export const TYPESCRIPT_LADDER: Ladder = {
  top: "visibility-choked",
  because: "a symbol not exported from its module cannot be referenced from another module; the compiler refuses it",
  rungs: [
    { grade: "visibility-choked", enforcer: "the compiler", fact: "the protected thing is not exported from its module, so no other module can reference it" },
    { grade: "reference-choked", enforcer: "Coherence's check at the edit and in CI", fact: "the protected thing is exported, and every resolved reference in the project is inside the chokepoint" },
  ],
};

/** Where the language server binary is, with every place looked. */
export function locateServer(root: string): ServerLocation {
  return locateInstalled(SERVER_BIN, SERVER_BIN, root);
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
  containerName?: string;
}

interface Location {
  uri: string;
  range: Range;
}

interface Diagnostic {
  message: string;
  severity?: number;
  code?: number | string;
  source?: string;
}

/**
 * Whether a diagnostic is the compiler refusing a reference because the name
 * is not exported or not accessible — the refusal that stands as the
 * refutation for the rung the compiler enforces (ruling rs-e93ecdd6). TS2459
 * is "declares it locally, but it is not exported"; TS2305 "has no exported
 * member"; TS2341 and TS2445 are private and protected access.
 */
export function refusesReference(diagnostic: Diagnostic): boolean {
  if (diagnostic.severity !== undefined && diagnostic.severity !== 1) return false;
  if ([2459, 2305, 2341, 2445, 2694, 2724].includes(Number(diagnostic.code))) return true;
  return /not exported|no exported member|is private|is protected|not accessible/.test(diagnostic.message);
}

/** The project's files a walk of this adapter may read: the walk's own bounds (walkedProjectFiles), never the config's ignore list. */
function walkedFiles(root: string): string[] {
  return walkedProjectFiles(walkBounds(root, [])).files;
}

/**
 * The source file opening which makes the language server load the project:
 * the first one inside a component folder (a folder holding a spec) when
 * there is one, since a source file the tsconfig does not include (a bench
 * script, a promo build) loads only an inferred project around itself and
 * leaves the project's own symbols unsearchable; otherwise the first source
 * file of the walk.
 */
export function seedFile(files: readonly string[]): string | undefined {
  const sources = projectSources(files);
  const components = [...new Set(files.filter((rel) => rel.endsWith(".spec.md")).map((rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".")))].filter((f) => f !== ".");
  return sources.find((rel) => components.some((folder) => rel.startsWith(`${folder}/`))) ?? sources[0];
}

function firstSourceFile(root: string): string | undefined {
  const found = seedFile(walkedFiles(root));
  return found === undefined ? undefined : join(root, found);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

/** Every project file whose project-relative path is the hint or ends with `/<hint>`. */
export function filesEndingWith(root: string, hint: string): string[] {
  return endingWith(walkedFiles(root), hint);
}

function endingWith(files: readonly string[], hint: string): string[] {
  return files.filter((rel) => rel === hint || rel.endsWith("/" + hint));
}

/** A wildcard re-export of a whole module: `export * from "./x.ts"`, `export * as ns from …`, `export type * from …`. */
const WILDCARD_REEXPORT = /^export\s+(?:type\s+)?\*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s+from\s*["']([^"']+)["']/;

/**
 * The syntactic form of a reference site, read forward from the top-level
 * statement it sits in (ruling d-7abd1ba8). `import` in any shape — plain,
 * `import type`, `import * as` — is an import; `export * from`, `export * as
 * … from` and an `export { … } from` list are re-exports; a plain
 * `export { … }` with no module specifier is neither, and no other statement
 * has a form. Reading forward from a statement start is what the dissolved
 * heuristic could not do: it scanned backward for a terminator, and a
 * semicolon-less bare import gave it none.
 */
export function siteForm(lines: readonly string[], line: number): SiteForm | undefined {
  const start = statementStartLine(lines, line);
  const head = lines[start] ?? "";
  if (/^import\b(?![(.])/.test(head)) return "import";
  if (/^export\s+(?:type\s+)?\*/.test(head)) return "re-export";
  if (!/^export\s+(?:type\s+)?\{/.test(head)) return undefined;
  let joined = "";
  for (let i = start; i < Math.min(lines.length, start + 200); i++) {
    const text = lines[i] ?? "";
    joined += (i === start ? "" : "\n") + text;
    if (!text.includes("}")) continue;
    return /\}\s*from\s*["']/.test(joined) ? "re-export" : undefined;
  }
  return undefined;
}

/** Every source file of the project, project-relative, skipping the folders no adopter's code lives in. */
export function sourceFilesUnder(root: string): string[] {
  return walkedFiles(root).filter((rel) => SOURCE_EXTENSIONS.has(extensionOf(rel)));
}

/**
 * Every project-relative file a relative module specifier may name, in the
 * order a resolver tries them: the specifier as written, then the TypeScript
 * sources it rewrites to (a NodeNext project writes `./foo.js` and means
 * `foo.ts`), then the JavaScript ones, then each folder index. Empty when the
 * specifier is a package or points outside the project. A caller that can
 * test existence takes the first candidate that exists; a caller that keys a
 * site by its module keys it by every candidate, since without the file list
 * `./foo.js` is `foo.ts` in one project and `foo.js` in the next.
 */
export function specifierCandidates(from: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const dir = dirname(from);
  const base = join(dir, specifier).split(sep).join("/");
  if (base.startsWith("..")) return [];
  const stripped = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, "");
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${stripped}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx"].flatMap((extension) => [`${stripped}/index${extension}`, `${base}/index${extension}`]),
  ];
  return [...new Set(candidates.filter((candidate) => SOURCE_EXTENSIONS.has(extensionOf(candidate))))];
}

/**
 * The file a relative module specifier names, project-relative: the first
 * candidate that `exists`, or without an existence test the first candidate
 * at all; undefined when it is a package, points outside, or no candidate
 * exists.
 */
export function resolveSpecifier(from: string, specifier: string, exists?: (candidate: string) => boolean): string | undefined {
  const candidates = specifierCandidates(from, specifier);
  return exists === undefined ? candidates[0] : candidates.find(exists);
}

function flatten(symbols: DocumentSymbol[], prefix: string[] = []): { path: string[]; symbol: DocumentSymbol }[] {
  const out: { path: string[]; symbol: DocumentSymbol }[] = [];
  for (const symbol of symbols) {
    const path = [...prefix, symbol.name];
    out.push({ path, symbol });
    if (symbol.children !== undefined) out.push(...flatten(symbol.children, path));
  }
  return out;
}

export class TypeScriptAdapter implements LanguageAdapter {
  readonly language = "typescript";
  readonly ladder = TYPESCRIPT_LADDER;
  private client: JsonRpcClient | undefined;
  private starting: Promise<{ ok: true } | { ok: false; reason: string }> | undefined;
  private readonly opened = new Set<string>();
  private readonly symbolCache = new Map<string, DocumentSymbol[]>();
  private readonly lineCache = new Map<string, string[]>();
  /** The document version last sent per open file; a change carries the next one. */
  private readonly versions = new Map<string, number>();
  /** The first source file, kept open so the project stays loaded. */
  private seed: string | undefined;
  /** Files a definition or a reference site landed in since the last forget: the ones a forget re-reads from disk. */
  private readonly touched = new Set<string>();
  /** The unsaved documents a refutation has open right now: the adapter's own probe, never a file, and the one site outside the project's files it accepts. */
  private readonly probes = new Set<string>();
  /** Wildcard re-export sites by the file they re-export; the reference query never reports them. Scanned once per forget. */
  private wildcards: Map<string, ReferenceSite[]> | undefined;
  /** The project's files and git's listing, each taken once per forget: a name resolved in a file, or a site kept, asks no git between forgets. */
  private walked: string[] | undefined;
  private listing: { taken: ProjectListing | undefined } | undefined;
  /** The last diagnostics the server published, by project-relative file. */
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  serverPid(): number | undefined {
    return this.client?.pid;
  }

  ready(): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.starting ??= this.start();
    return this.starting;
  }

  private async start(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const server = locateServer(this.root);
    if (!server.found) {
      return { ok: false, reason: `${SERVER_BIN} not found; looked at ${server.looked.join("; ")}. Install it: npm install --save-dev typescript-language-server typescript` };
    }
    const tsserver = locateTsserver(this.root)?.path;
    const client = JsonRpcClient.spawn(server.command, [...server.args, "--stdio"], this.root);
    this.client = client;
    client.onNotification = (method, params) => {
      if (method !== "textDocument/publishDiagnostics") return;
      const published = params as { uri?: string; diagnostics?: Diagnostic[] };
      if (published.uri === undefined) return;
      this.diagnostics.set(this.relative(published.uri), published.diagnostics ?? []);
    };
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "project" }],
        capabilities: {
          textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, publishDiagnostics: {} },
          workspace: { symbol: {}, workspaceFolders: true },
        },
        initializationOptions: {
          // One semantic server only: the syntax server the language server pairs it with by default sees
          // open documents alone, and workspace/symbol and references routed there answer for those.
          tsserver: {
            useSyntaxServer: "never",
            ...(tsserver === undefined ? {} : { path: tsserver }),
            ...(process.env["COHERENCE_TSSERVER_LOG"] === undefined ? {} : { logDirectory: process.env["COHERENCE_TSSERVER_LOG"], logVerbosity: "verbose" }),
          },
          preferences: { includeCompletionsForModuleExports: false },
        },
      });
      client.notify("initialized", {});
      const seed = firstSourceFile(this.root);
      this.seed = seed === undefined ? undefined : relative(this.root, seed).split(sep).join("/");
      if (this.seed !== undefined) this.open(this.seed);
      return { ok: true };
    } catch (error) {
      client.kill();
      this.client = undefined;
      return { ok: false, reason: `${SERVER_BIN} at ${server.path} failed to initialize: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async live(): Promise<JsonRpcClient> {
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

  private uri(file: string): string {
    return pathToFileURL(join(this.root, file)).href;
  }

  private relative(uri: string): string {
    return relative(this.root, fileURLToPath(uri)).split(sep).join("/");
  }

  private lines(file: string): string[] {
    let lines = this.lineCache.get(file);
    if (lines === undefined) {
      lines = readFileSync(join(this.root, file), "utf8").split(/\r?\n/);
      this.lineCache.set(file, lines);
    }
    return lines;
  }

  private open(file: string, text?: string): void {
    if (this.opened.has(file)) return;
    const content = text ?? readFileSync(join(this.root, file), "utf8");
    this.client!.notify("textDocument/didOpen", { textDocument: { uri: this.uri(file), languageId: languageIdOf(file), version: 1, text: content } });
    this.opened.add(file);
    this.versions.set(file, 1);
  }

  /** Replace an open document's whole text; the version only ever climbs, so the server never discards a change as old. */
  private change(file: string, text: string): void {
    const version = (this.versions.get(file) ?? 1) + 1;
    this.versions.set(file, version);
    this.client!.notify("textDocument/didChange", { textDocument: { uri: this.uri(file), version }, contentChanges: [{ text }] });
  }

  private closeDocument(file: string): void {
    if (!this.opened.has(file)) return;
    this.client!.notify("textDocument/didClose", { textDocument: { uri: this.uri(file) } });
    this.opened.delete(file);
  }

  private async documentSymbols(file: string): Promise<DocumentSymbol[]> {
    const cached = this.symbolCache.get(file);
    if (cached !== undefined) return cached;
    // A file the instrument still has in its project but that is no longer on disk has no symbols;
    // reading it would throw and take the whole run down with an ENOENT.
    if (!existsSync(join(this.root, file))) {
      this.symbolCache.set(file, []);
      return [];
    }
    const client = await this.live();
    this.open(file);
    const result = await client.request<DocumentSymbol[] | SymbolInformation[] | null>("textDocument/documentSymbol", { textDocument: { uri: this.uri(file) } });
    const symbols: DocumentSymbol[] = (result ?? []).map((s) =>
      "location" in s ? { name: s.name, kind: s.kind, range: s.location.range, selectionRange: s.location.range } : s,
    );
    this.symbolCache.set(file, symbols);
    return symbols;
  }

  /**
   * Cached facts about files are dropped when their text may have changed (the
   * edit hook re-runs a check), and the server is made to see the current disk
   * text of every document this adapter may have open before any question is
   * asked. Closing a document is not enough: tsserver reloads a closed file
   * from disk only when it does not own the text, and a didOpen carrying the
   * text it already loaded leaves it owning the text, so a close after that
   * leaves the edit to its file watcher, which is late under load and blind to
   * an excluded file. So every open document, every file touched since the
   * last forget, and every file the caller names gets its whole current text
   * (didChange for an open document, didOpen for one not yet open, and it
   * stays open), and the forget waits for a documentSymbol answer per file,
   * which the server cannot give before the change is applied. A file that
   * no longer exists is closed.
   */
  async forget(files: readonly string[] = []): Promise<void> {
    this.symbolCache.clear();
    this.lineCache.clear();
    this.wildcards = undefined;
    this.walked = undefined;
    this.listing = undefined;
    this.diagnostics.clear();
    if (this.client === undefined) return;
    // A named file that is not the project's (a nested checkout's copy, an ignored file) is never opened:
    // opening it would load another project into the instrument, whose references would then answer as this one's.
    const named = keepProjectFiles(this.root, files);
    const refresh = new Set([...this.touched, ...files.filter((f) => named.has(f)), ...this.opened]);
    this.touched.clear();
    const synced: string[] = [];
    for (const file of refresh) {
      const path = join(this.root, file);
      if (!existsSync(path) || !statSync(path).isFile()) {
        this.closeDocument(file);
        continue;
      }
      const text = readFileSync(path, "utf8");
      if (this.opened.has(file)) this.change(file, text);
      else this.open(file, text);
      synced.push(file);
    }
    // The acknowledgment: one answer per changed document, each ordered after its change.
    for (const file of synced) await this.documentSymbols(file);
  }

  async resolve(name: string, hint: ResolveHint): Promise<Resolved> {
    const parsed = parseName(name);
    if (parsed.form === "prose") {
      return { ok: false, reason: `"${name}" is prose, not a symbol or a module; write the symbol (\`writeClass\`), the symbol in its file (\`KERNEL_WRITE_POLICY in policy.ts\`), or the module path` };
    }
    if (parsed.form === "module") {
      const path = join(this.root, parsed.path);
      if (!existsSync(path) || !statSync(path).isFile()) return { ok: false, reason: `module ${parsed.path} is not a file under the project` };
      if (!keepProjectFiles(this.root, [parsed.path]).has(parsed.path)) return { ok: false, reason: `module ${parsed.path} is not one of the project's files (ignored, or inside a nested checkout)` };
      const lines = this.lines(parsed.path);
      const symbols = await this.documentSymbols(parsed.path);
      const first = symbols.find((s) => this.exportedIn(parsed.path, s));
      return {
        ok: true,
        definition: {
          name,
          kind: "module",
          file: parsed.path,
          range: { start: { line: 0, character: 0 }, end: { line: Math.max(0, lines.length - 1), character: (lines[lines.length - 1] ?? "").length } },
          selection: first?.selectionRange.start ?? { line: 0, character: 0 },
        },
      };
    }
    const candidates = parsed.fileHint === undefined ? await this.searchWorkspace(parsed.name) : await this.searchFiles(parsed.name, parsed.fileHint);
    if (candidates.length === 0) {
      return { ok: false, reason: parsed.fileHint === undefined ? `no symbol named ${parsed.name} in the project` : `no symbol named ${parsed.name} in a file ending with ${parsed.fileHint}` };
    }
    const chosen = choose(candidates, hint);
    if (chosen === undefined) {
      const where = candidates.map((c) => `${c.file}:${c.symbol.selectionRange.start.line + 1}`);
      return { ok: false, reason: `${parsed.name} is declared in ${candidates.length} places; write \`${parsed.name} in <file>\``, candidates: where };
    }
    return {
      ok: true,
      definition: { name, kind: "symbol", file: chosen.file, range: chosen.symbol.range, selection: chosen.symbol.selectionRange.start },
    };
  }

  private async searchWorkspace(name: string): Promise<Candidate[]> {
    const client = await this.live();
    const found = await client.request<SymbolInformation[] | null>("workspace/symbol", { query: name });
    const files = new Set<string>();
    for (const info of found ?? []) {
      if (info.name !== name) continue;
      const file = this.relative(info.location.uri);
      if (file.startsWith("..") || file.startsWith("node_modules/")) continue;
      files.add(file);
    }
    const own = keepProjectFiles(this.root, [...files], this.listingNow());
    const candidates: Candidate[] = [];
    for (const file of [...files].filter((f) => own.has(f)).sort()) candidates.push(...(await this.declarationsIn(file, name)));
    if (candidates.length > 0) return candidates;
    // The server searches only the projects it has loaded: a name it does not know yet (a cold server, a second tsconfig) is
    // looked for in the files whose text spells it, and confirmed by their document symbols, never by the text alone.
    const spelled = new RegExp(`(^|[^\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`);
    for (const file of projectSources(this.walkedNow())) {
      let text: string;
      try {
        text = readFileSync(join(this.root, file), "utf8");
      } catch {
        continue;
      }
      if (spelled.test(text)) candidates.push(...(await this.declarationsIn(file, name)));
    }
    return candidates;
  }

  private async searchFiles(name: string, fileHint: string): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const file of endingWith(this.walkedNow(), fileHint)) candidates.push(...(await this.declarationsIn(file, name)));
    return candidates;
  }

  /** The project's files as the walk reads them, taken once per forget. */
  private walkedNow(): string[] {
    return (this.walked ??= walkedFiles(this.root));
  }

  /** Git's listing of the project, taken once per forget. */
  private listingNow(): ProjectListing | undefined {
    return (this.listing ??= { taken: projectListing(this.root) }).taken;
  }

  /** Top-level declarations named `name` in a file (a nested declaration is not a module member). */
  private async declarationsIn(file: string, name: string): Promise<Candidate[]> {
    const symbols = await this.documentSymbols(file);
    return symbols.filter((s) => s.name === name).map((symbol) => ({ file, symbol }));
  }

  async references(definition: Definition): Promise<ReferenceSite[]> {
    const client = await this.live();
    this.open(definition.file);
    this.touched.add(definition.file);
    this.openHorizon();
    const starts: Position[] = [];
    if (definition.kind === "module") {
      for (const symbol of await this.documentSymbols(definition.file)) {
        if (this.exportedIn(definition.file, symbol)) starts.push(symbol.selectionRange.start);
      }
    } else {
      starts.push(definition.selection);
    }
    const reported: Location[] = [];
    for (const position of starts) {
      const locations = await client.request<Location[] | null>("textDocument/references", {
        textDocument: { uri: this.uri(definition.file) },
        position,
        context: { includeDeclaration: false },
      });
      reported.push(...(locations ?? []));
    }
    // Only the project's own files and its reference horizon's are evidence, and a site outside them is dropped before it is read or
    // opened: opening a nested checkout's copy would load that checkout into the instrument as if it were this project.
    const own = keepHorizonFiles(this.root, reported.map((location) => this.relative(location.uri)), this.listingNow(), this.horizon());
    const seen = new Set<string>();
    const sites: ReferenceSite[] = [];
    for (const location of reported) {
      const file = this.relative(location.uri);
      if (!(own.has(file) || this.probes.has(file)) || file.startsWith("node_modules/")) continue;
      const start = location.range.start;
      if (file === definition.file && rangeContains({ start: definition.selection, end: definition.selection }, start)) continue;
      const key = `${file}:${start.line}:${start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.touched.add(file);
      const form = siteForm(this.linesOf(file), start.line);
      sites.push({ file, line: start.line + 1, character: start.character, symbol: await this.enclosingSymbol(file, start), ...(form === undefined ? {} : { form }) });
    }
    // A wildcard re-export names nothing, so the server reports no site for it; it still widens the thing's reach.
    if (definition.kind === "module" || (await this.visibility(definition)).visible) {
      for (const site of this.wildcardReExports(definition.file)) {
        const key = `${site.file}:${site.line - 1}:${site.character}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.touched.add(site.file);
        sites.push(site);
      }
    }
    sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character);
    return sites;
  }

  /** The folders outside the project the config's `references` adds to the search, absolute; read once. */
  private horizonAt: string[] | undefined;
  private horizon(): string[] {
    return (this.horizonAt ??= horizonFolders(this.root));
  }

  /**
   * Load each horizon folder into the server: every source file git lists
   * there outside the project is opened, so the server holds the projects
   * they belong to (a tsconfig's, or the inferred one for loose files) and a
   * references query searches them too. Once per adapter; the cost grows
   * with the folders the config names, which is why the default is none.
   */
  private horizonOpened = false;
  private openHorizon(): void {
    if (this.horizonOpened) return;
    this.horizonOpened = true;
    for (const folder of this.horizon()) {
      for (const rel of walkedFiles(folder)) {
        if (!SOURCE_EXTENSIONS.has(extensionOf(rel)) || /\.d\.ts$/.test(rel)) continue;
        const file = relative(this.root, join(folder, rel)).split(sep).join("/");
        if (file.startsWith("../")) this.open(file);
      }
    }
  }

  /** The sites where another module re-exports this file wholesale, scanned once per forget because the reference query never reports them. */
  private wildcardReExports(file: string): ReferenceSite[] {
    if (this.wildcards === undefined) {
      const walked = new Set(this.walkedNow());
      const found = new Map<string, ReferenceSite[]>();
      for (const source of sourceFilesUnder(this.root)) {
        let lines: string[];
        try {
          lines = readFileSync(join(this.root, source), "utf8").split(/\r?\n/);
        } catch {
          continue;
        }
        for (let i = 0; i < lines.length; i++) {
          const match = WILDCARD_REEXPORT.exec(lines[i] ?? "");
          if (match === null) continue;
          const target = resolveSpecifier(source, match[1]!, (candidate) => walked.has(candidate));
          if (target === undefined) continue;
          const list = found.get(target) ?? [];
          list.push({ file: source, line: i + 1, character: (lines[i] ?? "").indexOf("*"), symbol: undefined, form: "re-export" });
          found.set(target, list);
        }
      }
      this.wildcards = found;
    }
    return this.wildcards.get(file) ?? [];
  }

  private linesOf(file: string): string[] {
    try {
      return this.lines(file);
    } catch {
      return [];
    }
  }

  private async enclosingSymbol(file: string, position: Position): Promise<string | undefined> {
    let symbols: DocumentSymbol[];
    try {
      symbols = await this.documentSymbols(file);
    } catch {
      return undefined;
    }
    let best: { path: string[]; symbol: DocumentSymbol } | undefined;
    for (const entry of flatten(symbols)) {
      if (!rangeContains(entry.symbol.range, position)) continue;
      if (best === undefined || entry.path.length > best.path.length) best = entry;
    }
    return best?.path.join(".");
  }

  private exportedIn(file: string, symbol: DocumentSymbol): boolean {
    return this.visibilityOf(file, symbol.name, symbol.range.start.line).visible;
  }

  private visibilityOf(file: string, name: string, declarationLine: number): Visibility {
    const lines = this.linesOf(file);
    const declaration = (lines[declarationLine] ?? "").trim();
    if (/^export\b/.test(declaration)) return { enforced: true, visible: true, evidence: `${file}:${declarationLine + 1} reads "${declaration.slice(0, 60)}"` };
    const listed = new RegExp(`export\\s*(type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}`);
    const asDefault = new RegExp(`export\\s+default\\s+${name}\\b`);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      if (listed.test(text) || asDefault.test(text)) return { enforced: true, visible: true, evidence: `${file}:${i + 1} exports ${name}` };
    }
    return { enforced: true, visible: false, evidence: `${file}:${declarationLine + 1} declares ${name} without export and no export list names it` };
  }

  async visibility(definition: Definition, _chokepoint?: Definition): Promise<Visibility> {
    if (definition.kind === "module") {
      return { enforced: true, visible: true, evidence: `${definition.file} is a module; any file may import it` };
    }
    const name = await this.declaredName(definition);
    if (name === undefined) return { enforced: true, visible: false, evidence: `no declaration at ${definition.file}:${definition.selection.line + 1}` };
    return this.visibilityOf(definition.file, name, definition.range.start.line);
  }

  /** The name as declared at the definition's selection, which the spec may have written with a file hint. */
  private async declaredName(definition: Definition): Promise<string | undefined> {
    const symbols = await this.documentSymbols(definition.file);
    return symbols.find((s) => s.selectionRange.start.line === definition.selection.line && s.selectionRange.start.character === definition.selection.character)?.name;
  }

  testFilter(via: string): string {
    return via;
  }

  /**
   * Two rulings meet here. For a thing the compiler will not let any other
   * module name, the compiler's own refusal of a synthetic outside import is
   * the refutation (rs-e93ecdd6). For everything else, the refutation stages
   * the two sites the import ruling could otherwise swallow (d-7abd1ba8): a
   * use of the thing in the chokepoint's own module outside the chokepoint's
   * range, and a re-export of it from a document beside it. The adapter only
   * reports what the instrument said about each; the check classifies them.
   */
  async refute(protectedThing: Definition, outsideOf: Definition | undefined, exempt?: string): Promise<Refutation> {
    const client = await this.live();
    const symbols = await this.documentSymbols(protectedThing.file);
    let name: string | undefined;
    if (protectedThing.kind === "module") {
      name = symbols.find((s) => this.exportedIn(protectedThing.file, s))?.name;
      if (name === undefined) return { seen: false, staged: [], account: `${protectedThing.file} exports nothing, so no document can reference it` };
    } else {
      name = await this.declaredName(protectedThing);
      if (name === undefined) return { seen: false, staged: [], account: `no declaration at ${protectedThing.file}:${protectedThing.selection.line + 1}` };
      if (!this.visibilityOf(protectedThing.file, name, protectedThing.range.start.line).visible) return this.refusedByCompiler(client, protectedThing, name);
    }
    return this.stage(client, protectedThing, outsideOf, name, exempt);
  }

  /** The compiler refuses an import of a thing its module does not export: open the synthetic outside document and read the diagnostic back. */
  private async refusedByCompiler(client: JsonRpcClient, protectedThing: Definition, name: string): Promise<Refutation> {
    const dir = dirname(protectedThing.file);
    const base = protectedThing.file.slice(dir === "." ? 0 : dir.length + 1);
    const synthetic = `${dir === "." ? "" : dir + "/"}coherence-refutation-${randomBytes(4).toString("hex")}${syntheticExtensionBeside(protectedThing.file)}`;
    // A JavaScript document is type-checked only under checkJs or `// @ts-check`; without it the compiler publishes no
    // diagnostic, and the refusal an ES module's link would raise is never seen. The probe asks for the check itself.
    const checked = JAVASCRIPT_EXTENSIONS.has(extensionOf(synthetic)) ? "// @ts-check\n" : "";
    const text = `${checked}import { ${name} } from "./${base}";\nexport const coherenceRefutation = ${name};\n`;
    this.diagnostics.delete(synthetic);
    client.notify("textDocument/didOpen", { textDocument: { uri: this.uri(synthetic), languageId: languageIdOf(synthetic), version: 1, text } });
    this.lineCache.set(synthetic, text.split("\n"));
    this.symbolCache.set(synthetic, []);
    try {
      const refusal = await this.awaitRefusal(synthetic);
      if (refusal !== undefined) {
        return {
          seen: true,
          staged: [],
          refused: refusal,
          account: `an unsaved document ${synthetic} importing ${name} was refused by the compiler: ${refusal}`,
        };
      }
      return { seen: false, staged: [], account: `an unsaved document ${synthetic} importing ${name} drew no diagnostic from the compiler, so nothing proves the import is refused` };
    } finally {
      client.notify("textDocument/didClose", { textDocument: { uri: this.uri(synthetic) } });
      this.lineCache.delete(synthetic);
      this.symbolCache.delete(synthetic);
      this.diagnostics.delete(synthetic);
    }
  }

  /** The first published diagnostic on a file that refuses the reference, within the window; the server publishes an empty set first. */
  private async awaitRefusal(file: string, timeoutMs = 15_000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const refusal = (this.diagnostics.get(file) ?? []).find((d) => refusesReference(d));
      if (refusal !== undefined) return refusal.message;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  /** Stage the two synthetic sites the import ruling could otherwise swallow, in one references query, and restore. */
  private async stage(client: JsonRpcClient, protectedThing: Definition, chokepoint: Definition | undefined, name: string, exempt?: string): Promise<Refutation> {
    const dir = dirname(protectedThing.file);
    const base = protectedThing.file.slice(dir === "." ? 0 : dir.length + 1);
    const synthetic = `${dir === "." ? "" : dir + "/"}coherence-refutation-${randomBytes(4).toString("hex")}${syntheticExtensionBeside(protectedThing.file)}`;
    const reExport = `export { ${name} } from "./${base}";\n`;
    client.notify("textDocument/didOpen", { textDocument: { uri: this.uri(synthetic), languageId: languageIdOf(synthetic), version: 1, text: reExport } });
    this.lineCache.set(synthetic, reExport.split("\n"));
    this.symbolCache.set(synthetic, []);
    this.probes.add(synthetic);

    // A module chokepoint has no inside that is outside its own range, so there is no same-module site to stage;
    // nor is there where the exempted folder holds the chokepoint's module, which the exemption covers on purpose.
    const exempted = exempt !== undefined && chokepoint !== undefined && withinFolder(chokepoint.file, exempt);
    const sameModule = chokepoint !== undefined && chokepoint.kind === "symbol" && !exempted ? this.editChokepointModule(chokepoint, protectedThing, name) : undefined;
    const expected: { what: string; file: string; line: number }[] = [];
    if (sameModule !== undefined) expected.push({ what: `a use of ${name} in ${chokepoint!.file} outside ${chokepoint!.name}`, file: chokepoint!.file, line: sameModule.line });
    expected.push({ what: `a re-export of ${name} from the unsaved document ${synthetic}`, file: synthetic, line: 1 });
    // Where the chokepoint governs only references from outside a folder, a plain use from outside it must still be a bypass.
    const beside = exempt === undefined ? undefined : outsideOfFolder(exempt);
    const outside = beside === undefined ? undefined : `${beside}coherence-refutation-${randomBytes(4).toString("hex")}${syntheticExtensionBeside(protectedThing.file)}`;
    if (outside !== undefined) {
      const specifier = `./${relative(dirname(outside), protectedThing.file).split(sep).join("/")}`.replace(/^\.\/\.\.\//, "../");
      const use = `import { ${name} as coherenceRefutationName } from "${specifier}";\nexport const coherenceRefutationUse = coherenceRefutationName;\n`;
      client.notify("textDocument/didOpen", { textDocument: { uri: this.uri(outside), languageId: languageIdOf(outside), version: 1, text: use } });
      this.lineCache.set(outside, use.split("\n"));
      this.symbolCache.set(outside, []);
      this.probes.add(outside);
      expected.push({ what: `a use of ${name} from the unsaved document ${outside}, outside ${exempt}`, file: outside, line: 2 });
    }

    try {
      const sites = await this.references(protectedThing);
      const staged: StagedSite[] = expected.map((want) => {
        const hit = sites.find((s) => s.file === want.file && s.line === want.line);
        return { what: want.what, ...(hit === undefined ? {} : { site: hit }) };
      });
      const unseen = staged.filter((s) => s.site === undefined);
      return {
        seen: unseen.length === 0,
        staged,
        account:
          unseen.length === 0
            ? `the instrument reported ${staged.map((s) => s.what).join(" and ")}`
            : `the instrument did not report ${unseen.map((s) => s.what).join(" or ")} among ${sites.length} references; the check is vacuous`,
      };
    } finally {
      sameModule?.restore();
      for (const file of outside === undefined ? [synthetic] : [synthetic, outside]) {
        client.notify("textDocument/didClose", { textDocument: { uri: this.uri(file) } });
        this.lineCache.delete(file);
        this.symbolCache.delete(file);
        this.probes.delete(file);
      }
    }
  }

  /**
   * Append a use of the protected thing to the chokepoint's own module, past
   * the chokepoint's range, as an unsaved edit: the one place the import
   * ruling makes an import inside, so the one place a use must still be a
   * bypass. When the module reaches the thing through an import, the added
   * lines bring their own aliased import, so the use never collides with a
   * binding already there.
   */
  private editChokepointModule(chokepoint: Definition, protectedThing: Definition, name: string): { line: number; restore: () => void } | undefined {
    let original: string;
    try {
      original = readFileSync(join(this.root, chokepoint.file), "utf8");
    } catch {
      return undefined;
    }
    const body = original.endsWith("\n") ? original : `${original}\n`;
    const start = body.split("\n").length - 1;
    const here = dirname(chokepoint.file);
    const specifier = `./${relative(here, protectedThing.file).split(sep).join("/")}`.replace(/^\.\/\.\.\//, "../");
    const added =
      chokepoint.file === protectedThing.file
        ? `const coherenceRefutationUse = ${name};\n`
        : `import { ${name} as coherenceRefutationName } from "${specifier}";\nconst coherenceRefutationUse = coherenceRefutationName;\n`;
    const line = start + (chokepoint.file === protectedThing.file ? 1 : 2);
    this.open(chokepoint.file);
    this.change(chokepoint.file, body + added);
    this.symbolCache.delete(chokepoint.file);
    this.lineCache.set(chokepoint.file, (body + added).split("\n"));
    return {
      line,
      restore: () => {
        this.change(chokepoint.file, original);
        this.symbolCache.delete(chokepoint.file);
        this.lineCache.delete(chokepoint.file);
      },
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    if (client === undefined) return;
    try {
      await client.request("shutdown", null, 3_000);
      client.notify("exit", null);
    } catch {
      // The server is going down either way.
    }
    setTimeout(() => client.kill(), 500).unref();
  }
}

interface Candidate {
  file: string;
  symbol: DocumentSymbol;
}

/** One candidate: the only one, else the only one under the component, else the only one outside test folders; ambiguity is reported, never guessed. */
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
