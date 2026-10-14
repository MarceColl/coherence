/**
 * The conformance trace client: called directly at each instrumented site,
 * never through a wrapper of the project's own, since indirection is where
 * instrumentation quietly stops firing.
 *
 *   import { log, tracing } from "./coherence-trace.ts";
 *   log("work.move", { id, target, state_after }, { scopes: ["journal.work"] });
 *   log("work.move", { id, target }, { scopes: ["journal.work"], rejected: true });   // a refusal, before it throws
 *
 * Name each argument exactly as the model action's parameter it pins: an
 * argument no parameter takes pins nothing, and the report counts it. A
 * rejected attempt logs the same action with rejected: true, so replay checks
 * that the model refuses it too. tracing() says whether a collector listens,
 * so a site can skip computing a fact nobody will read.
 *
 * Inert without COHERENCE_TRACE_URL: nothing is sent and no socket or timer
 * is opened. The URL is read once, at the first call, and its absence is kept
 * for the life of the process, so the collector must exist before the process
 * starts: conform starts it and only then spawns the tests. The test an event
 * belongs to is COHERENCE_TRACE_TEST, which the node:test hooks set per test
 * and a child process inherits; an event with none belongs to no test and is
 * counted, never sent.
 *
 * Values are copied by a fixed encoder that never calls into them: no toJSON,
 * no getter (an accessor property is recorded as such, never read), Map and
 * Set as tagged lists. Observing must not change what is observed.
 *
 * This file is vendored verbatim into a project by coherence scaffold client:
 * erasable TypeScript, node: imports only, and nothing of Coherence's own.
 */

import { request } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The event protocol this client speaks; the collector refuses another version by name. */
export const TRACE_PROTOCOL = 1;

/** One argument as it travels: the parameter it pins, and its value as the encoder copied it. */
export interface LoggedArgument {
  name: string;
  value: unknown;
}

/** What one process sent, acknowledged, lost, and could not attribute to a test. */
export interface TraceCounters {
  posted: number;
  acknowledged: number;
  dropped: number;
  unattributed: number;
}

/** The collector's base address, read once: undefined until the first call, null once known absent. */
let base: string | null | undefined;
let seq = 0;
const counters: TraceCounters = { posted: 0, acknowledged: 0, dropped: 0, unattributed: 0 };
/** Events waiting to be sent, per test name, in the order they were logged. */
const buffered = new Map<string, object[]>();
let sending: Promise<void> = Promise.resolve();
let hooked = false;

function collector(): string | null {
  if (base === undefined) {
    const url = process.env["COHERENCE_TRACE_URL"];
    base = url === undefined || url === "" ? null : url.replace(/\/+$/, "");
    if (base !== null) hookExit();
  }
  return base;
}

/** Whether a collector listens for this process: false outside a conformance capture. */
export function tracing(): boolean {
  return collector() !== null;
}

/** A value copied without calling into it: plain data as is, Map and Set tagged, an accessor named and never read. */
export function encode(value: unknown, depth = 0): unknown {
  if (depth > 32) return { "#depth": true };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { "#number": String(value) };
  if (typeof value === "bigint") return { "#bigint": value.toString() };
  if (typeof value !== "object") return { "#unsupported": typeof value };
  if (value instanceof Map) return { "#map": [...Map.prototype.entries.call(value)].map(([k, v]) => [encode(k, depth + 1), encode(v, depth + 1)]) };
  if (value instanceof Set) return { "#set": [...Set.prototype.values.call(value)].map((v) => encode(v, depth + 1)) };
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const d = descriptors[String(i)];
      out.push(d === undefined ? null : "value" in d ? encode(d.value, depth + 1) : { "#accessor": true });
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return { "#unsupported": "object" };
  const out: Record<string, unknown> = {};
  for (const [key, d] of Object.entries(descriptors)) {
    if (!d.enumerable) continue;
    out[key] = "value" in d ? encode(d.value, depth + 1) : { "#accessor": true };
  }
  return out;
}

/**
 * Log one event at an instrumented site: the action, its arguments by the
 * model parameter each pins, and the scopes (components) it belongs to. With
 * rejected, the site refused the attempt, and replay requires the model to
 * refuse it as well. Inert, and cheap, without a collector.
 */
export function log(action: string, args: Record<string, unknown>, opts: { scopes: string[]; rejected?: boolean }): void {
  if (collector() === null) return;
  const test = process.env["COHERENCE_TRACE_TEST"];
  if (test === undefined || test === "") {
    counters.unattributed += 1;
    return;
  }
  const argumentsOf: LoggedArgument[] = Object.keys(args).map((name) => ({ name, value: encode(Object.getOwnPropertyDescriptor(args, name)?.value) }));
  if (opts.rejected === true) argumentsOf.push({ name: "rejected", value: true });
  seq += 1;
  // at orders events across processes: a child's event logged between two of its parent's arrives first, since the parent's wait in its buffer.
  const event = { action, scopes: [...opts.scopes], arguments: argumentsOf, seq, pid: process.pid, at: performance.timeOrigin + performance.now() };
  const list = buffered.get(test) ?? [];
  list.push(event);
  buffered.set(test, list);
  if (list.length >= 500) void flush();
}

function post(method: "POST" | "PATCH", path: string, body: unknown): Promise<number> {
  const url = new URL(`${base}${path}`);
  const text = JSON.stringify(body);
  return new Promise((resolve) => {
    const sent = request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text), "coherence-trace-protocol": String(TRACE_PROTOCOL), connection: "close" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    sent.on("error", () => resolve(0));
    sent.end(text);
  });
}

/** Send every buffered event, each test's in order; resolves once the collector has answered. */
export function flush(): Promise<void> {
  if (collector() === null || buffered.size === 0) return sending;
  const batches = [...buffered.entries()];
  buffered.clear();
  sending = sending.then(async () => {
    for (const [test, events] of batches) {
      counters.posted += events.length;
      const status = await post("POST", `/test/${encodeURIComponent(test)}`, events);
      if (status === 200) counters.acknowledged += events.length;
      else counters.dropped += events.length;
    }
  });
  return sending;
}

/** Declare how a test ended, after its events: ok queues its trace, failed discards it. */
export async function finish(test: string, outcome: "ok" | "failed"): Promise<void> {
  if (collector() === null) return;
  await flush();
  const status = await post("PATCH", `/test/${encodeURIComponent(test)}`, { outcome });
  if (status !== 200) counters.dropped += 1;
}

/** What this process sent, acknowledged, lost and could not attribute, so far. */
export function traceCounters(): TraceCounters {
  return { ...counters };
}

/** Events still buffered when the process exits are sent synchronously through a short-lived node, so a CLI's last event is not lost. */
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("beforeExit", () => {
    if (buffered.size > 0) void flush();
  });
  process.on("exit", () => {
    for (const [test, events] of buffered) {
      counters.posted += events.length;
      const script = `const h=require("node:http");const u=new URL(process.argv[1]);let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const r=h.request({method:"POST",hostname:u.hostname,port:u.port,path:u.pathname,headers:{"content-type":"application/json","coherence-trace-protocol":"${TRACE_PROTOCOL}"}},s=>{s.resume();s.on("end",()=>process.exit(s.statusCode===200?0:1))});r.on("error",()=>process.exit(1));r.end(b)});`;
      try {
        execFileSync(process.execPath, ["-e", script, `${base}/test/${encodeURIComponent(test)}`], { input: JSON.stringify(events), stdio: ["pipe", "ignore", "ignore"], timeout: 10_000, env: { PATH: process.env["PATH"] ?? "" } });
        counters.acknowledged += events.length;
      } catch {
        counters.dropped += events.length;
      }
    }
    buffered.clear();
    const dir = process.env["COHERENCE_TRACE_COUNTERS"];
    if (dir !== undefined && dir !== "") {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(counters));
      } catch {
        // The counters are a report; a process that cannot write them still exits.
      }
    }
  });
}
