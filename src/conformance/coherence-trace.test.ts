/**
 * The trace client and its node:test hooks: inert without the collector's
 * URL, a value copied without calling into it, and a real node:test run under
 * a collector, where a passing test's events (its own and a child process's)
 * arrive in order and a failing test's are discarded.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "../lifecycle/work-meter.ts";
import { TRACE_PROTOCOL as COLLECTOR_PROTOCOL, startCollector } from "./collector.ts";
import { TRACE_PROTOCOL, encode } from "./coherence-trace.ts";
import { VENDORED_FILES, vendorClient } from "./vendor.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = pathToFileURL(resolve(here, "coherence-trace.ts")).href;
const HOOKS = pathToFileURL(resolve(here, "coherence-trace-hooks.ts")).href;

/** Run node with the given argv and environment, from `cwd`; resolves with its exit code and output. */
function node(args: string[], env: Record<string, string | undefined>, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const environment: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) environment[k] = v;
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...args], { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const CLEAN = { COHERENCE_TRACE_URL: undefined, COHERENCE_TRACE_TEST: undefined, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: undefined };

test("the client is inert without the collector URL: tracing is false, and logging opens no socket and no timer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coherence-trace-inert-"));
  try {
    const script = `import { log, tracing, flush } from ${JSON.stringify(CLIENT)};
process.env.COHERENCE_TRACE_TEST = "t";
for (let i = 0; i < 5; i++) log("move", { id: "w" + i }, { scopes: ["orders"] });
await flush();
console.log(JSON.stringify({ tracing: tracing(), resources: process.getActiveResourcesInfo() }));`;
    writeFileSync(join(dir, "inert.ts"), script);
    const { code, out } = await node([join(dir, "inert.ts")], CLEAN, dir);
    assert.equal(code, 0, out);
    const reported = JSON.parse(out.trim().split("\n").pop()!) as { tracing: boolean; resources: string[] };
    assert.equal(reported.tracing, false);
    assert.deepEqual(reported.resources.filter((r) => /TCP|Timeout|Immediate/.test(r)), [], "no socket, no timer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a value is encoded without calling into it: no getter is read, no toJSON is called, Map and Set are tagged", () => {
  let called = 0;
  const value = {
    plain: [1, "two", true, null],
    get trap(): number {
      called += 1;
      throw new Error("a getter was called");
    },
    nested: { toJSON: () => { called += 1; return "replaced"; }, n: 3n },
    map: new Map([["k", new Set([1, 2])]]),
    instance: new (class Widget {})(),
  };
  const copied = encode(value) as Record<string, unknown>;
  assert.equal(called, 0, "observing must not call into what it observes");
  assert.deepEqual(copied["trap"], { "#accessor": true });
  assert.deepEqual(copied["plain"], [1, "two", true, null]);
  assert.deepEqual((copied["nested"] as Record<string, unknown>)["n"], { "#bigint": "3" });
  assert.deepEqual(copied["map"], { "#map": [["k", { "#set": [1, 2] }]] });
  assert.deepEqual(copied["instance"], { "#unsupported": "object" });
  assert.equal(TRACE_PROTOCOL, COLLECTOR_PROTOCOL, "the vendored client speaks the collector's protocol");
});

test("under a collector, a passing test's events arrive in order with its child's, a failing test's are discarded, and without the URL the suite runs as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coherence-trace-hooks-"));
  const collector = await startCollector();
  try {
    writeFileSync(join(dir, "child.ts"), `import { log } from ${JSON.stringify(CLIENT)};\nlog("child.step", { n: 3 }, { scopes: ["orders"] });\n`);
    writeFileSync(
      join(dir, "orders.test.ts"),
      `import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { log } from ${JSON.stringify(CLIENT)};
test("creates and moves", () => {
  log("create", { id: "w1" }, { scopes: ["orders"] });
  log("move", { id: "w1", target: "active" }, { scopes: ["orders"] });
  execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", ${JSON.stringify(join(dir, "child.ts"))}]);
  log("move", { id: "w1", target: "done" }, { scopes: ["orders"], rejected: true });
});
test("fails after logging", () => {
  log("create", { id: "w2" }, { scopes: ["orders"] });
  if (process.env.COHERENCE_TRACE_URL) throw new Error("fails under the collector only");
});
`,
    );
    const traced = await node(["--test", "orders.test.ts"], { ...CLEAN, COHERENCE_TRACE_URL: collector.url, NODE_OPTIONS: `--import=${HOOKS}` }, dir);
    assert.notEqual(traced.code, 0, "the failing test fails");
    const traces = collector.drain();
    assert.deepEqual(traces.map((t) => t.test), ["orders.test.ts::creates and moves"], "only the passing test's trace is queued");
    assert.deepEqual(traces[0]!.events.map((e) => e.action), ["create", "move", "child.step", "move"]);
    assert.deepEqual(traces[0]!.events[3]!.arguments, [{ name: "id", value: "w1" }, { name: "target", value: "done" }, { name: "rejected", value: true }]);
    assert.equal(collector.stats.discarded, 1);
    const plain = await node(["--test", "--test-name-pattern=creates", "orders.test.ts"], { ...CLEAN, NODE_OPTIONS: `--import=${HOOKS}` }, dir);
    assert.equal(plain.code, 0, plain.out);
    assert.deepEqual(collector.drain(), [], "nothing reaches the collector without the URL");
  } finally {
    await collector.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the vendored client is the shipped client: --write writes it once and never overwrites, and --check names an absent or edited file", () => {
  const root = mkdtempSync(join(tmpdir(), "coherence-vendor-"));
  try {
    assert.equal(vendorClient(root, "test/trace", "check").exit, 1, "absent is drift");
    assert.match(vendorClient(root, "test/trace", "print").lines.join("\n"), /would write test\/trace\/coherence-trace\.ts/);
    assert.deepEqual(vendorClient(root, "test/trace", "write").lines.slice(0, 2), VENDORED_FILES.map((f) => `wrote test/trace/${f}`));
    for (const name of VENDORED_FILES) assert.equal(readFileSync(join(root, "test/trace", name), "utf8"), readFileSync(join(here, name), "utf8"), name);
    assert.deepEqual(vendorClient(root, "test/trace", "check"), { lines: VENDORED_FILES.map((f) => `same test/trace/${f}`), exit: 0 });
    assert.match(vendorClient(root, "test/trace", "write").lines[0]!, /^unchanged /);
    appendFileSync(join(root, "test/trace", VENDORED_FILES[0]), "// edited\n");
    assert.match(vendorClient(root, "test/trace", "write").lines[0]!, /^kept .*never overwritten/);
    const drift = vendorClient(root, "test/trace", "check");
    assert.equal(drift.exit, 1);
    assert.match(drift.lines[0]!, /^drift test\/trace\/coherence-trace\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
