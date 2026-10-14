/**
 * The collector: the loopback HTTP server conform starts before it spawns the
 * tests. Each test's instrumented sites post their events here, and the test
 * declares its outcome when it ends:
 *
 *   POST  <base>/test/<name>   one event, or an array of them, into that test's open run; the first opens it
 *   PATCH <base>/test/<name>   { "outcome": "ok" | "failed" }: ok queues the run as a trace, failed discards it
 *   GET   <base>/health        liveness: 200 { "protocol": N }
 *
 * <name> is the test's name, percent-encoded as one path segment. Every route
 * but /health carries the coherence-trace-protocol header; a missing or other
 * version is refused with 426 naming both, so a stale vendored client is
 * obvious rather than silently dropped. An event names at least one scope, or
 * it is refused with 422: one repository's components would otherwise mix in
 * one trace. A PATCH closes the run, so the same name posting again opens a
 * fresh one, and a run never declared when the collector closes is counted
 * unfinished and discarded: a trace queued is a test that passed.
 *
 * The base address carries a token minted per collector, and the server
 * answers only on 127.0.0.1 to a request whose Host is its own, with no
 * Origin and no cross-site fetch mark: the URL reaches only the child
 * processes conform exports it to, and a web page aiming at loopback is
 * refused before anything is read.
 */

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

/** The version of the event protocol the client and the collector speak; a vendored client of another version is refused by name. */
export const TRACE_PROTOCOL = 1;
/** The header every route but /health carries its protocol version in. */
export const PROTOCOL_HEADER = "coherence-trace-protocol";
/** The most bytes one request body may carry. */
const MAX_BODY = 4 * 1024 * 1024;

/** One logged argument: the model parameter it pins, by name, and the values its domain allows, when the site declares them. */
export interface TraceArgument {
  name: string;
  value: unknown;
  domain?: unknown[];
}

/** One event an instrumented site logged: the action, the components it belongs to, its arguments, and its order in the process that logged it. */
export interface TraceEvent {
  action: string;
  scopes: string[];
  arguments: TraceArgument[];
  /** Optional facts about the model's state after the step, checked by path. */
  assertions?: { path: string; value: unknown }[];
  /** The order in the logging process. */
  seq: number;
  /** The process that logged it; a test's children log under their own. */
  pid: number;
  /** When it was logged, in milliseconds since the epoch with a fraction: the order across a test's processes. */
  at?: number;
}

/** One passing test's events, in the order they arrived. */
export interface CapturedTrace {
  test: string;
  events: TraceEvent[];
}

export interface CollectorStats {
  accepted: number;
  /** Requests refused, by the reason's first words. */
  refused: Record<string, number>;
  queued: number;
  discarded: number;
  /** Runs still open when the collector closed: their test never declared an outcome. */
  unfinished: number;
}

export interface Collector {
  /** The base address a client posts under: http://127.0.0.1:<port>/<token>. */
  url: string;
  /** The traces queued so far, taken: each is returned once. */
  drain(): CapturedTrace[];
  stats: CollectorStats;
  close(): Promise<void>;
}

export type TraceAdmission = { ok: true; path: string } | { ok: false; status: number; reason: string };

function sameSecret(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The one guard every request passes before a route reads it: the Host must
 * be this collector's loopback address, no Origin may be sent and no fetch
 * marked cross-site (a browser page aiming at loopback sends one or the
 * other), and the path must start with this collector's token. Returns the
 * path below the token.
 */
export function admitTrace(request: { url?: string | undefined; headers: IncomingHttpHeaders }, port: number, token: string): TraceAdmission {
  const host = request.headers.host?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { ok: false, status: 421, reason: "refused: the Host header names another server" };
  if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] === "cross-site") return { ok: false, status: 403, reason: "refused: a request from a web page" };
  const path = (request.url ?? "/").split("?")[0]!;
  const segments = path.split("/");
  if (segments.length < 2 || !sameSecret(segments[1] ?? "", token)) return { ok: false, status: 404, reason: "refused: no such collector" };
  return { ok: true, path: `/${segments.slice(2).join("/")}` };
}

/** Why an event cannot be taken, or undefined when it can. */
export function eventProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "an event is a JSON object";
  const event = value as Record<string, unknown>;
  if (typeof event["action"] !== "string" || event["action"] === "") return "an event names its action";
  const scopes = event["scopes"];
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string" && s !== "")) return "a scopeless event is refused: every event names at least one scope, the component it belongs to";
  const args = event["arguments"];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "object" && a !== null && typeof (a as Record<string, unknown>)["name"] === "string" && "value" in a)) return "an event's arguments are a list of { name, value }";
  if (event["assertions"] !== undefined && !Array.isArray(event["assertions"])) return "an event's assertions are a list of { path, value }";
  if (typeof event["seq"] !== "number" || typeof event["pid"] !== "number") return "an event carries its seq and pid";
  if (event["at"] !== undefined && typeof event["at"] !== "number") return "an event's at is a number of milliseconds";
  return undefined;
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? `${body}\n` : `${JSON.stringify(body)}\n`;
  response.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "cache-control": "no-store", connection: "close" });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve(undefined);
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(size > MAX_BODY ? undefined : Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * A run's events in the order they were logged: by time across processes (a
 * child's events reach the collector before its parent's buffered ones), and
 * by each process's own sequence within it. A run whose events carry no time
 * keeps its arrival order.
 */
export function inLoggedOrder(events: readonly TraceEvent[]): TraceEvent[] {
  if (!events.every((e) => typeof e.at === "number")) return [...events];
  return [...events].sort((a, b) => (a.pid === b.pid ? a.seq - b.seq : a.at! - b.at!));
}

/** Start a collector on 127.0.0.1 at a port the system assigns. */
export async function startCollector(options: { protocol?: number } = {}): Promise<Collector> {
  const protocol = options.protocol ?? TRACE_PROTOCOL;
  const token = randomBytes(16).toString("hex");
  const open = new Map<string, TraceEvent[]>();
  const queue: CapturedTrace[] = [];
  const stats: CollectorStats = { accepted: 0, refused: {}, queued: 0, discarded: 0, unfinished: 0 };
  let port = 0;
  const refuse = (response: ServerResponse, status: number, reason: string): void => {
    const key = reason.split(":")[0]!.replace(/^refused$/, reason).slice(0, 60);
    stats.refused[key] = (stats.refused[key] ?? 0) + 1;
    answer(response, status, reason);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const admitted = admitTrace(request, port, token);
    if (!admitted.ok) return refuse(response, admitted.status, admitted.reason);
    if (admitted.path === "/health") {
      if (request.method !== "GET") return refuse(response, 405, "refused: /health answers GET");
      return answer(response, 200, { protocol });
    }
    const route = /^\/test\/([^/]+)$/.exec(admitted.path);
    if (route === null) return refuse(response, 404, "refused: no such route; the routes are POST and PATCH /test/<name> and GET /health");
    const sent = request.headers[PROTOCOL_HEADER];
    if (sent !== String(protocol)) return refuse(response, 426, `stale client: client protocol ${sent === undefined ? "none" : String(sent)}, collector protocol ${protocol}; vendor the client again (coherence scaffold client --write)`);
    let name: string;
    try {
      name = decodeURIComponent(route[1]!);
    } catch {
      return refuse(response, 400, "refused: the test name is not percent-encoded");
    }
    const body = await readBody(request);
    if (body === undefined) return refuse(response, 413, `refused: a body over ${MAX_BODY} bytes`);
    let value: unknown;
    try {
      value = body === "" ? undefined : JSON.parse(body);
    } catch {
      return refuse(response, 400, "refused: the body is not JSON");
    }
    if (request.method === "POST") {
      const events = Array.isArray(value) ? value : [value];
      for (const event of events) {
        const problem = eventProblem(event);
        if (problem !== undefined) return refuse(response, 422, problem);
      }
      const run = open.get(name) ?? [];
      run.push(...(events as TraceEvent[]));
      open.set(name, run);
      stats.accepted += events.length;
      return answer(response, 200, { accepted: events.length });
    }
    if (request.method === "PATCH") {
      const outcome = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["outcome"] : undefined;
      if (outcome !== "ok" && outcome !== "failed") return refuse(response, 422, 'an outcome is { "outcome": "ok" } or { "outcome": "failed" }');
      const run = open.get(name);
      open.delete(name);
      if (run === undefined) return answer(response, 200, { events: 0 });
      // A failed test's events never happened in a passing run: they are discarded, never queued.
      if (outcome === "failed") stats.discarded += 1;
      else {
        queue.push({ test: name, events: inLoggedOrder(run) });
        stats.queued += 1;
      }
      return answer(response, 200, { events: run.length, outcome });
    }
    return refuse(response, 405, "refused: /test/<name> answers POST and PATCH");
  };

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 1_000 }, (request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) answer(response, 500, `the collector failed: ${error instanceof Error ? error.message : String(error)}`);
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback alone: never 0.0.0.0 or ::.
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}/${token}`,
    stats,
    drain: () => queue.splice(0, queue.length),
    close: () =>
      (closed ??= new Promise<void>((resolve) => {
        stats.unfinished += open.size;
        open.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      })),
  };
}
