/**
 * The live Scope reading, as the warm server answers it over HTTP.
 *
 * The server's guard (admitHttp in the warm server) has already checked the
 * Host, the method, the origin and the token before a request reaches here;
 * this file answers only GET and HEAD, and only these paths:
 *
 *   /                the fixed shell: its bytes depend on no project content
 *   /api/state       the first load: the windowed state, its version, and where history starts
 *   /api/events      the event stream: catch-up from the page's cursors, then every update
 *   /api/journal     older journal records by cursor (before=<at>~<id>), or matching a search (q=)
 *   /api/runs        older run records by cursor (before=<at>~<session>)
 *   /api/record      one journal record by id, for a citation the page has not loaded
 *   /api/sites       every reference site of one chokepoint entry (run=<at>~<session>, component, name), where the first load counted some
 *
 * The state is loaded once through scopeState, whole, and kept current: the
 * journal, runs and work folders are watched, and an append is read back
 * from its store and sent as the records that are new (by id, or a run's time
 * and session); a spec, a practice file, a lexicon or the config changing
 * (whatever the spec model reads by name) reloads the state and sends it as
 * a snapshot with a new version. The component interfaces
 * are read through the server's own instrument (or, for a Python adoption
 * the config bounds, a bounded server the reading keeps for itself) when the
 * reading is first asked for and again when a run lands, never on every file
 * save, within the same budget as a snapshot's.
 *
 * A page resumes from cursors derived from what it holds. The catch-up sends
 * every record at or after a little before each cursor, since a writer whose
 * clock read earlier can append after a later record; the page merges by
 * key, so the overlap is held once and nothing is lost.
 *
 * Node-only; the browser bundle never imports it.
 */

import { watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { HttpApp, HttpAppFactory, HttpContext } from "../../enforcement/server.ts";
import { loadRuns } from "../../enforcement/record.ts";
import { loadJournal } from "../../journal/store.ts";
import { foldOrders, loadWork as loadWorkRecords } from "../../journal/work.ts";
import { storeOfPath, type RecordStore } from "../../journal/stores.ts";
import { buildShell, rootOptions, scopeState, windowState, type BuildOptions, type Shell } from "./build.ts";
import { interfaceAdapter, interfaceBounds, readComponentInterfaces } from "./component-interfaces.ts";
import { readAndRecord } from "./gaps.ts";
import type { LanguageAdapter } from "../../adapters/adapter.ts";
import { isLanguage } from "../../adapters/index.ts";
import { readByModel } from "../../spec/model.ts";
import { DEFAULT_PROJECT_LEXICON, projectLexiconPath } from "../../lifecycle/project.ts";
import { JOURNAL_WINDOW, RUN_WINDOW } from "./derive.ts";
import type { InterfaceReading, JournalRecord, RunRecord, ShellState, WorkOrder } from "./model.ts";
import { runKeyOf } from "./updates.ts";

/** How far before a page's cursor the catch-up reaches, for a writer whose clock read earlier but appended later. */
export const CATCH_UP_SLACK_MS = 60_000;
/** How often an open stream carries a keepalive, which also keeps the warm server from idling out under a watched page. */
const KEEPALIVE_MS = 15_000;
/** The most records one history answer carries. */
const HISTORY_LIMIT = 500;

export interface LiveOptions {
  /** Read the component interfaces through the instrument (default true); a test turns it off. */
  interfaces?: boolean;
  /** How long a burst of changes to one store settles before it is read (default 100 ms). */
  debounceMs?: number;
  /** Build options beyond the root's defaults (Coherence's lexicon, the project's name). */
  build?: Partial<BuildOptions>;
}

/** A record store, or the model: the specs, the config and the lexicons. */
type Store = RecordStore | "model";

interface Cursor {
  at: string;
  key: string;
}

function parseCursor(text: string | null): Cursor | undefined {
  if (text === null) return undefined;
  if (text === "") return { at: "", key: "" };
  const tilde = text.indexOf("~");
  return tilde === -1 ? { at: text, key: "" } : { at: text.slice(0, tilde), key: text.slice(tilde + 1) };
}

/** The cursor moved back by the slack, so the catch-up also carries what a slower writer appended late. */
function withSlack(cursor: Cursor): string {
  if (cursor.at === "") return "";
  const time = Date.parse(cursor.at);
  return Number.isNaN(time) ? "" : new Date(time - CATCH_UP_SLACK_MS).toISOString();
}

function before(at: string, key: string, cursor: Cursor): boolean {
  return at < cursor.at || (at === cursor.at && key < cursor.key);
}

function json(response: ServerResponse, request: IncomingMessage, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(request.method === "HEAD" ? undefined : body);
}

/** Which store a changed path belongs to, or undefined when it is nothing the reading shows. */
export function storeOf(path: string, lexicons: readonly string[]): Store | undefined {
  const name = path.split(sep).join("/");
  const store = storeOfPath(name);
  if (store !== undefined) return store;
  if (name.startsWith(".git/") || name.startsWith(".coherence/") || name.startsWith("node_modules/") || name.includes("/node_modules/")) return undefined;
  // The spec model's own test of what it reads, so a kind of file it begins to read refreshes the reading with it.
  if (readByModel(name) || lexicons.includes(name)) return "model";
  return undefined;
}

/**
 * The lexicons a reading of `root` loads, as paths inside it: Coherence's own
 * when it lies there, the domain lexicon given or located as the state's load
 * locates it (the config's lexicon key, else the default name), and the
 * default name, so one written later is noticed. A config that will not parse
 * locates nothing here; the config itself is watched, and its reload says why.
 */
export async function watchedLexicons(root: string, build: Pick<BuildOptions, "lexiconPath" | "domainPath">): Promise<string[]> {
  let located: string | undefined;
  try {
    located = build.domainPath ?? (await projectLexiconPath(root));
  } catch {
    located = undefined;
  }
  const inside = [build.lexiconPath, located, DEFAULT_PROJECT_LEXICON].filter((p): p is string => p !== undefined).map((p) => relative(root, resolve(root, p)).split(sep).join("/"));
  return [...new Set(inside.filter((p) => !p.startsWith("..")))];
}

class LiveReading implements HttpApp {
  private readonly root: string;
  private readonly options: LiveOptions;
  private readonly context: HttpContext;
  private readonly build: BuildOptions;
  private shell: Promise<Shell> | undefined;
  private loading: Promise<ShellState> | undefined;
  private base: ShellState | undefined;
  private version = 0;
  private readonly epoch = `${Date.now().toString(36)}-${process.pid}`;
  private journalIds = new Set<string>();
  private runKeys = new Set<string>();
  private workIds = new Set<string>();
  private interfaces: InterfaceReading;
  private reading: Promise<void> | undefined;
  private readAgain = false;
  /** The reading's own bounded server, when the shared instrument reads a whole workspace the reading never draws. */
  private readingServer: { adapter: LanguageAdapter; bounds: string } | undefined;
  private readonly clients = new Set<ServerResponse>();
  private readonly watchers: FSWatcher[] = [];
  /** The lexicons the state loaded, located again with every reload, so a config that names another is followed. */
  private lexicons: string[] = [];
  private readonly timers = new Map<Store, NodeJS.Timeout>();
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(context: HttpContext, options: LiveOptions) {
    this.context = context;
    this.root = context.root;
    this.options = options;
    this.build = { ...rootOptions(context.root), ...options.build, root: context.root };
    this.interfaces =
      options.interfaces === false
        ? { kind: "unread", because: "this live reading was started without the instrument" }
        : { kind: "unread", because: "the warm server is reading the component interfaces; the map redraws when it is done" };
  }

  private get versionId(): string {
    return `${this.epoch}.${this.version}`;
  }

  /** The state, loaded once and kept current by the watchers from then on. */
  private ensure(): Promise<ShellState> {
    this.loading ??= (async () => {
      const state = await scopeState({ ...this.build, window: false, componentInterfaces: this.interfaces });
      this.base = state;
      this.remember(state);
      this.lexicons = await watchedLexicons(this.root, this.build);
      this.watch();
      this.readInterfaces();
      return state;
    })();
    return this.loading;
  }

  private remember(state: ShellState): void {
    this.journalIds = new Set(state.journal.records.map((record) => record.id));
    this.runKeys = new Set(state.runs.records.map(runKeyOf));
    this.workIds = new Set(state.journal.work.kind === "present" ? state.journal.work.orders.flatMap((order) => [order.id, ...order.history.map((h) => h.id)]) : []);
  }

  private watch(): void {
    try {
      const watcher = watch(this.root, { recursive: true }, (_event, name) => {
        if (name === null) return;
        const store = storeOf(String(name), this.lexicons);
        if (store !== undefined) this.changed(store);
      });
      watcher.on("error", (error) => this.context.log(`scope: the watch on ${this.root} failed: ${error.message}`));
      this.watchers.push(watcher);
    } catch (error) {
      this.context.log(`scope: could not watch ${this.root}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Coherence's own lexicon lives outside a root that is another project.
    const own = resolve(this.build.lexiconPath);
    if (relative(this.root, own).startsWith("..")) {
      try {
        const watcher = watch(dirname(own), (_event, name) => {
          if (name !== null && String(name) === basename(own)) this.changed("model");
        });
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch {
        // Unwatchable: the lexicon still loads with every model change in the root.
      }
    }
  }

  /** A burst of changes to one store settles, then the store is read once. */
  private changed(store: Store): void {
    if (this.closed) return;
    const pending = this.timers.get(store);
    if (pending !== undefined) clearTimeout(pending);
    this.timers.set(
      store,
      setTimeout(() => {
        this.timers.delete(store);
        this.chain = this.chain.then(() => this.refresh(store)).catch((error: unknown) => this.context.log(`scope: ${store} refresh failed: ${error instanceof Error ? error.message : String(error)}`));
      }, store === "model" ? Math.max(300, this.options.debounceMs ?? 100) : (this.options.debounceMs ?? 100)),
    );
  }

  /** Read one store again and send what is new. Serialized, so two refreshes never interleave. */
  private async refresh(store: Store): Promise<void> {
    const base = this.base;
    if (base === undefined || this.closed) return;
    if (store === "journal") {
      const loaded = loadJournal(this.root);
      const fresh = loaded.records.filter((record) => !this.journalIds.has(record.id));
      for (const record of fresh) this.journalIds.add(record.id);
      const damagedChanged = JSON.stringify(loaded.damaged) !== JSON.stringify(base.journal.damaged);
      base.journal = { ...base.journal, records: loaded.records, damaged: loaded.damaged };
      if (fresh.length > 0 || damagedChanged) this.send("journal", { records: fresh, damaged: loaded.damaged });
    } else if (store === "runs") {
      const loaded = loadRuns(this.root);
      const fresh = loaded.records.filter((run) => !this.runKeys.has(runKeyOf(run)));
      for (const run of fresh) this.runKeys.add(runKeyOf(run));
      const damagedChanged = JSON.stringify(loaded.damaged) !== JSON.stringify(base.runs.damaged);
      base.runs = { ...base.runs, records: loaded.records, damaged: loaded.damaged };
      if (fresh.length > 0 || damagedChanged) this.send("runs", { records: fresh, damaged: loaded.damaged });
      // Structure refreshes when a run lands, not on every save.
      if (fresh.length > 0) this.readInterfaces();
    } else if (store === "work") {
      const loaded = loadWorkRecords(this.root);
      const fresh = new Set(loaded.records.filter((record) => !this.workIds.has(record.id)).map((record) => record.id));
      for (const id of fresh) this.workIds.add(id);
      const orders = foldOrders(loaded);
      base.journal = { ...base.journal, work: { kind: "present", orders, damaged: loaded.damaged } };
      const changed = orders.filter((order) => fresh.has(order.id) || order.history.some((h) => fresh.has(h.id)));
      if (changed.length > 0) this.send("work", { orders: changed, damaged: loaded.damaged });
    } else if (store === "conformance") {
      // Scope shows no conformance verdict yet: a verdict appended changes nothing it renders. A quint prop's run carries the verdict it read.
    } else if (store === "model") {
      const state = await scopeState({ ...this.build, window: false, componentInterfaces: this.interfaces });
      this.base = state;
      this.remember(state);
      this.lexicons = await watchedLexicons(this.root, this.build);
      this.version += 1;
      this.send("snapshot", { state: windowState(state), version: this.versionId });
    } else {
      // A store the table names and no branch above reads fails to compile here, never refreshes silently.
      const unread: never = store;
      throw new Error(`no refresh reads the ${String(unread)} store`);
    }
  }

  /** Read the component interfaces through the server's instrument; one reading at a time, once more if a run landed meanwhile. */
  private readInterfaces(): void {
    if (this.options.interfaces === false || this.closed) return;
    if (this.reading !== undefined) {
      this.readAgain = true;
      return;
    }
    this.reading = (async () => {
      do {
        this.readAgain = false;
        try {
          const adapter = await this.interfaceServer();
          await adapter.forget([]);
          // The same reading, bounds and budget (the config's) as a snapshot's: the refresh on a run is never a second rule.
          const reading = await readAndRecord(this.root, () => readComponentInterfaces(this.root, adapter));
          if (this.closed) return;
          this.interfaces = reading;
          if (this.base !== undefined) this.base.componentInterfaces = reading;
          this.send("interfaces", reading);
        } catch (error) {
          this.context.log(`scope: reading the component interfaces failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } while (this.readAgain && !this.closed);
    })().finally(() => {
      this.reading = undefined;
    });
  }

  /**
   * The server the interface reading asks: a bounded one of its own, kept warm
   * across refreshes and rebuilt when the config's bounds change, when the
   * shared instrument would read a whole workspace the reading never draws;
   * otherwise the shared instrument.
   */
  private async interfaceServer(): Promise<LanguageAdapter> {
    if (this.readingServer !== undefined && this.readingServer.bounds !== interfaceBounds(this.root)) {
      await this.readingServer.adapter.close();
      this.readingServer = undefined;
    }
    const language = this.context.adapter.language;
    this.readingServer ??= isLanguage(language) ? interfaceAdapter(this.root, language) : undefined;
    return this.readingServer?.adapter ?? this.context.adapter;
  }

  private send(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) client.write(frame);
  }

  /** Where paging back starts: the oldest record of the latest window, when the first load leaves older records out. */
  private historyHint(state: ShellState): { journal?: string; runs?: string } {
    const journal = state.journal.records;
    const runs = state.runs.records;
    const hint: { journal?: string; runs?: string } = {};
    const j = journal[journal.length - JOURNAL_WINDOW];
    if (journal.length > JOURNAL_WINDOW && j !== undefined) hint.journal = `${j.at}~${j.id}`;
    const r = runs[runs.length - RUN_WINDOW];
    if (runs.length > RUN_WINDOW && r !== undefined) hint.runs = `${r.at}~${r.session}`;
    return hint;
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    switch (url.pathname) {
      case "/": {
        this.shell ??= buildShell();
        const shell = await this.shell;
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(shell.html),
          // The one inline script by its hash, styles inline, the font as data, and requests to this server alone.
          "content-security-policy": `default-src 'none'; script-src '${shell.scriptHash}'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
        response.end(request.method === "HEAD" ? undefined : shell.html);
        return;
      }
      case "/api/state": {
        const state = await this.ensure();
        await this.chain;
        json(response, request, 200, { state: windowState(this.base ?? state), version: this.versionId, history: this.historyHint(this.base ?? state) });
        return;
      }
      case "/api/events":
        return this.events(request, response, url);
      case "/api/journal": {
        await this.ensure();
        await this.chain;
        const cursor = parseCursor(url.searchParams.get("before"));
        const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const limit = Math.min(HISTORY_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
        const matching = this.base!.journal.records.filter(
          (record) => (cursor === undefined || cursor.at === "" || before(record.at, record.id, cursor)) && (query === "" || JSON.stringify(record).toLowerCase().includes(query)),
        );
        const page = matching.slice(-limit);
        json(response, request, 200, { records: page, more: matching.length > page.length });
        return;
      }
      case "/api/runs": {
        await this.ensure();
        await this.chain;
        const cursor = parseCursor(url.searchParams.get("before"));
        const limit = Math.min(HISTORY_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
        const matching = this.base!.runs.records.filter((run) => cursor === undefined || cursor.at === "" || before(run.at, run.session, cursor));
        const page = matching.slice(-limit);
        json(response, request, 200, { records: page, more: matching.length > page.length });
        return;
      }
      case "/api/sites": {
        // Every reference site of one chokepoint entry, by its run (at~session) and enforcement: what the first load counted and did not list.
        await this.ensure();
        await this.chain;
        const run = url.searchParams.get("run") ?? "";
        const component = url.searchParams.get("component") ?? "";
        const name = url.searchParams.get("name") ?? "";
        const entry = this.base!.runs.records.find((r) => runKeyOf(r) === run)?.invariants.find((e) => e.component === component && e.name === name && e.form === "chokepoint");
        if (entry?.sites === undefined) json(response, request, 404, { reason: `no chokepoint entry ${component}/${name} with sites in the run ${run}` });
        else json(response, request, 200, { sites: entry.sites });
        return;
      }
      case "/api/record": {
        await this.ensure();
        await this.chain;
        const id = url.searchParams.get("id") ?? "";
        const record = this.base!.journal.records.find((r) => r.id === id);
        if (record === undefined) json(response, request, 404, { records: [], more: false, reason: `no journal record ${id}` });
        else json(response, request, 200, { records: [record], more: false });
        return;
      }
      default:
        json(response, request, 404, { reason: "no such path" });
    }
  }

  /**
   * The event stream: a snapshot first when the page's version is not the
   * current one, then every journal record, run and work record at or after
   * a little before each cursor the page sent, then `ready`, then every
   * update as it happens. Registered in the same turn as the catch-up is
   * read, so no update falls between them.
   */
  private async events(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    await this.ensure();
    await this.chain;
    const base = this.base!;
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const write = (event: string, data: unknown): void => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    if (url.searchParams.get("version") !== this.versionId) write("snapshot", { state: windowState(base), version: this.versionId });
    const journal = parseCursor(url.searchParams.get("journal"));
    if (journal !== undefined) {
      const from = withSlack(journal);
      const records: JournalRecord[] = base.journal.records.filter((record) => record.at >= from);
      if (records.length > 0) write("journal", { records, damaged: base.journal.damaged });
    }
    const runs = parseCursor(url.searchParams.get("runs"));
    if (runs !== undefined) {
      const from = withSlack(runs);
      const records: RunRecord[] = base.runs.records.filter((run) => run.at >= from);
      if (records.length > 0) write("runs", { records, damaged: base.runs.damaged });
    }
    const work = parseCursor(url.searchParams.get("work"));
    if (work !== undefined && base.journal.work.kind === "present") {
      const from = withSlack(work);
      const orders: WorkOrder[] = base.journal.work.orders.filter((order) => order.at >= from || order.history.some((h) => h.at >= from));
      if (orders.length > 0) write("work", { orders, damaged: base.journal.work.damaged });
    }
    write("ready", { version: this.versionId });
    this.clients.add(response);
    this.context.keepAlive();
    const beat = setInterval(() => {
      response.write(": keepalive\n\n");
      this.context.keepAlive();
    }, KEEPALIVE_MS);
    const end = (): void => {
      clearInterval(beat);
      this.clients.delete(response);
    };
    request.on("close", end);
    response.on("close", end);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const watcher of this.watchers) watcher.close();
    for (const client of this.clients) client.end();
    this.clients.clear();
    void this.readingServer?.adapter.close();
    this.readingServer = undefined;
  }
}

/** The live Scope reading as an app the warm server answers over HTTP. */
export function scopeApp(options: LiveOptions = {}): HttpAppFactory {
  return (context) => new LiveReading(context, options);
}

