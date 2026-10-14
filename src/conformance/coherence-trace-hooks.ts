/**
 * The node:test half of a conformance capture: loaded into every test
 * process through NODE_OPTIONS (--import=<this file>), it names the test each
 * event belongs to and tells the collector how the test ended.
 *
 * A root beforeEach sets COHERENCE_TRACE_TEST to <file>::<full name>, so the
 * client attributes what the test logs, and a process the test spawns
 * inherits the name with the collector's URL. A root afterEach sends the
 * test's events and declares its outcome: ok queues its trace, failed
 * discards it. A subtest names its own run and restores its parent's name
 * when it ends.
 *
 * Inert anywhere else: without the collector's URL, outside a node:test
 * child (no NODE_TEST_CONTEXT), and inside a process a traced test spawned
 * (COHERENCE_TRACE_TEST already set), whose events belong to that test.
 *
 * Vendored verbatim beside coherence-trace.ts by coherence scaffold client.
 */

import { relative } from "node:path";
import { finish, flush } from "./coherence-trace.ts";

const url = process.env["COHERENCE_TRACE_URL"];
const inherited = process.env["COHERENCE_TRACE_TEST"];
if (url !== undefined && url !== "" && process.env["NODE_TEST_CONTEXT"] !== undefined && (inherited === undefined || inherited === "")) {
  const { beforeEach, afterEach } = await import("node:test");
  /** The names of the tests running now, innermost last: a subtest's name stands while it runs. */
  const running: string[] = [];
  beforeEach((t) => {
    const context = t as unknown as { name: string; fullName?: string; filePath?: string };
    const file = context.filePath === undefined ? "" : relative(process.cwd(), context.filePath).split("\\").join("/");
    const name = `${file}::${context.fullName ?? context.name}`;
    running.push(name);
    process.env["COHERENCE_TRACE_TEST"] = name;
  });
  afterEach(async (t) => {
    const name = running.pop();
    const outer = running[running.length - 1];
    if (outer === undefined) delete process.env["COHERENCE_TRACE_TEST"];
    else process.env["COHERENCE_TRACE_TEST"] = outer;
    if (name === undefined) return;
    await flush();
    // Only a test node:test says passed queues its trace; one whose outcome cannot be read is discarded, never kept.
    await finish(name, (t as unknown as { passed?: boolean }).passed === true ? "ok" : "failed");
  });
}
