/**
 * The collector against a fake client: every route, the protocol header, the
 * scope rule, a failed test's trace, a name that needs encoding, a run opened
 * again after its outcome, two tests at once, and a close with runs open.
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { PROTOCOL_HEADER, TRACE_PROTOCOL, startCollector, type Collector } from "./collector.ts";

/** One request to the collector, as a client or a page would send it. */
function send(url: string, method: string, body?: unknown, headers: Record<string, string> = { [PROTOCOL_HEADER]: String(TRACE_PROTOCOL) }): Promise<{ status: number; text: string }> {
  const target = new URL(url);
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const sent = request({ method, hostname: target.hostname, port: target.port, path: target.pathname, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers } }, (response) => {
      let answer = "";
      response.on("data", (chunk: Buffer) => (answer += chunk.toString("utf8")));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: answer }));
    });
    sent.on("error", reject);
    sent.end(text);
  });
}

let seq = 0;
function event(action: string, args: Record<string, unknown> = {}, scopes = ["orders"]): object {
  seq += 1;
  return { action, scopes, arguments: Object.entries(args).map(([name, value]) => ({ name, value })), seq, pid: 1 };
}

async function withCollector(body: (collector: Collector) => Promise<void>): Promise<void> {
  const collector = await startCollector();
  try {
    await body(collector);
  } finally {
    await collector.close();
  }
}

test("a failed test leaves no trace: ok queues the run, failed discards it, and a name posting after its outcome opens a fresh run", async () => {
  await withCollector(async (c) => {
    const name = `${c.url}/test/${encodeURIComponent("src/a.test.ts::orders > move one")}`;
    assert.equal((await send(name, "POST", event("move", { id: "w1" }))).status, 200);
    assert.equal((await send(name, "POST", [event("close", { id: "w1" }), event("move", { id: "w2" })])).status, 200, "a batch is taken whole");
    assert.equal((await send(name, "PATCH", { outcome: "ok" })).status, 200);
    const failing = `${c.url}/test/${encodeURIComponent("src/a.test.ts::orders > breaks")}`;
    await send(failing, "POST", event("move", { id: "w9" }));
    assert.equal((await send(failing, "PATCH", { outcome: "failed" })).status, 200);
    await send(name, "POST", event("move", { id: "w3" }));
    await send(name, "PATCH", { outcome: "ok" });
    const traces = c.drain();
    assert.deepEqual(traces.map((t) => [t.test, t.events.map((e) => e.action)]), [
      ["src/a.test.ts::orders > move one", ["move", "close", "move"]],
      ["src/a.test.ts::orders > move one", ["move"]],
    ]);
    assert.deepEqual(c.drain(), [], "each trace is taken once");
    assert.equal(c.stats.queued, 2);
    assert.equal(c.stats.discarded, 1);
    assert.equal(c.stats.accepted, 5);
  });
});

test("a scopeless event is refused with 422, and nothing of its batch is taken", async () => {
  await withCollector(async (c) => {
    const name = `${c.url}/test/x`;
    const refused = await send(name, "POST", event("move", {}, []));
    assert.equal(refused.status, 422);
    assert.match(refused.text, /a scopeless event is refused/);
    assert.equal((await send(name, "POST", [event("move"), { action: "close", arguments: [], seq: 9, pid: 1 }])).status, 422);
    await send(name, "PATCH", { outcome: "ok" });
    assert.deepEqual(c.drain(), [], "a run with no event taken queues nothing");
    assert.equal((await send(name, "POST", { action: "", scopes: ["a"], arguments: [], seq: 1, pid: 1 })).status, 422, "an event names its action");
  });
});

test("a stale client is told so: a missing or other protocol version is refused with 426 naming both, and /health answers without one", async () => {
  await withCollector(async (c) => {
    const missing = await send(`${c.url}/test/x`, "POST", event("move"), {});
    assert.equal(missing.status, 426);
    assert.match(missing.text, new RegExp(`client protocol none, collector protocol ${TRACE_PROTOCOL}`));
    const other = await send(`${c.url}/test/x`, "PATCH", { outcome: "ok" }, { [PROTOCOL_HEADER]: "0" });
    assert.equal(other.status, 426);
    assert.match(other.text, new RegExp(`client protocol 0, collector protocol ${TRACE_PROTOCOL}`));
    const health = await send(`${c.url}/health`, "GET", undefined, {});
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.text), { protocol: TRACE_PROTOCOL });
    assert.equal(c.stats.refused["stale client"], 2);
  });
});

test("the collector answers only its own token, on its own host, and never a web page", async () => {
  await withCollector(async (c) => {
    const base = new URL(c.url);
    assert.equal((await send(`http://127.0.0.1:${base.port}/wrongtoken/health`, "GET", undefined, {})).status, 404);
    assert.equal((await send(`${c.url}/health`, "GET", undefined, { origin: "http://evil.example" })).status, 403);
    assert.equal((await send(`${c.url}/health`, "GET", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await send(`${c.url}/health`, "GET", undefined, { host: `rebound.example:${base.port}` })).status, 421);
    assert.equal((await send(`${c.url}/nowhere`, "GET", undefined, {})).status, 404);
    assert.equal(base.hostname, "127.0.0.1");
  });
});

test("names are one percent-encoded segment, two tests interleave without mixing, and a close counts the runs still open", async () => {
  const c = await startCollector();
  const names = ["src/b.test.ts::a / b > with spaces", "src/b.test.ts::second"];
  const at = names.map((n) => `${c.url}/test/${encodeURIComponent(n)}`);
  await Promise.all([send(at[0]!, "POST", event("a1")), send(at[1]!, "POST", event("b1"))]);
  await Promise.all([send(at[1]!, "POST", event("b2")), send(at[0]!, "POST", event("a2"))]);
  await send(at[1]!, "PATCH", { outcome: "ok" });
  await send(`${c.url}/test/${encodeURIComponent("never ends")}`, "POST", event("z"));
  assert.equal((await send(`${c.url}/test/%E0%A4%A`, "POST", event("z"))).status, 400, "a malformed encoding is refused");
  await c.close();
  const traces = c.drain();
  assert.deepEqual(traces.map((t) => [t.test, t.events.map((e) => e.action)]), [[names[1], ["b1", "b2"]]]);
  assert.equal(c.stats.unfinished, 2, "the open run of the first name and the one that never ended");
});
