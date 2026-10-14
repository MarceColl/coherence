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
 * when it ends. While two tests that do not nest run at once in one process
 * (a concurrency option), the name is empty: what is logged then could
 * belong to either, so the client counts it unattributed and the capture
 * fails, rather than giving it to whichever test started last.
 *
 * Inert anywhere else: without the collector's URL, outside a node:test
 * child (no NODE_TEST_CONTEXT), and inside a process a traced test spawned
 * (COHERENCE_TRACE_TEST already set, empty or not), whose events belong to
 * that test.
 *
 * Vendored verbatim beside coherence-trace.ts by coherence scaffold client.
 */

import { relative } from "node:path";
import { finish, flush } from "./coherence-trace.ts";

const url = process.env["COHERENCE_TRACE_URL"];
if (url !== undefined && url !== "" && process.env["NODE_TEST_CONTEXT"] !== undefined && process.env["COHERENCE_TRACE_TEST"] === undefined) {
  const { beforeEach, afterEach } = await import("node:test");
  /** The names of the tests running now: nested, each inside the one before, or side by side when the runner runs them concurrently. */
  const running: string[] = [];
  const nameOf = (t: unknown): string => {
    const context = t as { name: string; fullName?: string; filePath?: string };
    const file = context.filePath === undefined ? "" : relative(process.cwd(), context.filePath).split("\\").join("/");
    return `${file}::${context.fullName ?? context.name}`;
  };
  /** The innermost test names what is logged while the running tests nest; while two run side by side, nothing does (empty: counted unattributed), since the variable is one per process and an event could belong to either. */
  const attribute = (): void => {
    const nested = [...running].sort((a, b) => a.length - b.length);
    const innermost = nested[nested.length - 1];
    if (innermost === undefined) delete process.env["COHERENCE_TRACE_TEST"];
    else process.env["COHERENCE_TRACE_TEST"] = nested.every((name, i) => i === 0 || name.startsWith(`${nested[i - 1]} > `)) ? innermost : "";
  };
  beforeEach((t) => {
    running.push(nameOf(t));
    attribute();
  });
  afterEach(async (t) => {
    // The test that ended is the hook's own, never the last one started: concurrent tests end in any order.
    const name = nameOf(t);
    const at = running.lastIndexOf(name);
    if (at === -1) return;
    running.splice(at, 1);
    attribute();
    await flush();
    // Only a test node:test says passed queues its trace; one whose outcome cannot be read is discarded, never kept.
    await finish(name, (t as unknown as { passed?: boolean }).passed === true ? "ok" : "failed");
  });
}
