/**
 * The capture and the command around it: the runner exports the collector's
 * URL to the tests it spawns, a capture with no trace fails with its cause,
 * the capture hash moves with the code and never with the model, and conform
 * replays a kept capture without running the tests, reads back a verdict it
 * already holds, and refuses --replay-only once the code moved.
 */

import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readConformanceConfig, readQuintConfig } from "./config.ts";
import { conformCommand } from "./cli.ts";
import { captureHash, replayHash } from "./hashes.ts";
import { counterProject } from "./replay-fixture.ts";
import { NO_TRACE_CAUSE, capture, captureEnv } from "./runner.ts";
import { conformanceStanding } from "./standing.ts";
import { appendVerdict, loadVerdicts, readCapture } from "./store.ts";

async function conform(root: string, ...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await conformCommand([...argv, "--session", "s1", "--agent", "a"], { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

test("the runner spawns the tests, never the reverse: the URL and the hooks are in the test command's environment, and an inherited test name is not", () => {
  const env = captureEnv({ NODE_OPTIONS: "--max-old-space-size=4096", COHERENCE_TRACE_TEST: "outer", NODE_TEST_CONTEXT: "child", PATH: "/bin" }, "http://127.0.0.1:1/t", "/repo/test/coherence/coherence-trace-hooks.ts", "/tmp/c");
  assert.equal(env["COHERENCE_TRACE_URL"], "http://127.0.0.1:1/t");
  assert.equal(env["NODE_OPTIONS"], "--max-old-space-size=4096 --import=file:///repo/test/coherence/coherence-trace-hooks.ts", "the hooks load after what the caller set");
  assert.equal(env["COHERENCE_TRACE_TEST"], undefined);
  assert.equal(env["NODE_TEST_CONTEXT"], undefined);
});

test("a capture with no trace fails, naming why: no hooks vendored, or sites that log nothing", async () => {
  const root = counterProject();
  try {
    rmSync(join(root, "test/coherence/coherence-trace-hooks.ts"));
    const unhooked = await capture(root, readConformanceConfig(root));
    assert.match(unhooked.failure ?? "", /no node:test hooks at test\/coherence\/coherence-trace-hooks\.ts/);
    assert.equal(unhooked.spawned, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const silent = counterProject();
  try {
    const code = join(silent, "src/counter/counter.ts");
    writeFileSync(code, readFileSync(code, "utf8").replace(/^\s*log\(.*$/gm, ""));
    const test = join(silent, "src/counter/counter.test.ts");
    writeFileSync(test, readFileSync(test, "utf8").replace(/^\s*log\(.*$/gm, ""));
    const outcome = await capture(silent, readConformanceConfig(silent));
    assert.equal(outcome.failure, NO_TRACE_CAUSE);
    assert.equal(outcome.kept, undefined, "an empty capture is never kept");
    assert.equal(outcome.meta.exit, 0, "the tests passed; the capture is still empty");
  } finally {
    rmSync(silent, { recursive: true, force: true });
  }
});

test("the capture hash moves with a test or source file and the client, never with the model; the replay hash moves with the model", () => {
  const root = counterProject();
  try {
    const config = readConformanceConfig(root);
    const first = captureHash(root, config);
    const model = { files: ["src/counter/Counter.qnt"] };
    const replay = replayHash(root, first, model, config.models[0]!, readQuintConfig(root), "0.33.0");
    appendFileSync(join(root, "src/counter/Counter.qnt"), "// a comment\n");
    assert.equal(captureHash(root, config), first, "editing the model keeps the capture");
    const edited = replayHash(root, first, model, config.models[0]!, readQuintConfig(root), "0.33.0");
    assert.notEqual(edited, replay, "and changes the replay");
    const quint = readQuintConfig(root);
    for (const bound of [{ seed: "0x7" }, { maxSamples: quint.maxSamples + 1 }, { maxSteps: quint.maxSteps + 1 }, { verifySteps: quint.verifySteps + 1 }])
      assert.notEqual(replayHash(root, first, model, config.models[0]!, { ...quint, ...bound }, "0.33.0"), edited, `the coverage probe's bounds change the replay: ${JSON.stringify(bound)}`);
    // A model the spec's model imports is part of the model: editing it changes the replay.
    writeFileSync(join(root, "src/counter/Lib.qnt"), "module Lib {\n  pure val libValue = 1\n}\n");
    writeFileSync(join(root, "src/counter/Counter.qnt"), readFileSync(join(root, "src/counter/Counter.qnt"), "utf8").replace("module Counter {", 'module Counter {\n  import Lib.* from "./Lib"'));
    const importing = replayHash(root, first, model, config.models[0]!, quint, "0.33.0");
    appendFileSync(join(root, "src/counter/Lib.qnt"), "// edited\n");
    assert.notEqual(replayHash(root, first, model, config.models[0]!, quint, "0.33.0"), importing, "editing an imported model changes the replay");
    assert.equal(captureHash(root, config), first, "and keeps the capture");
    appendFileSync(join(root, "src/counter/counter.test.ts"), "// a comment\n");
    const second = captureHash(root, config);
    assert.notEqual(second, first, "editing a test file changes the capture");
    appendFileSync(join(root, "test/coherence/coherence-trace.ts"), "// edited\n");
    assert.notEqual(captureHash(root, config), second, "editing the vendored client changes the capture");
    assert.notEqual(captureHash(root, { ...config, testCommand: ["node", "--test"] }), captureHash(root, config), "so does the test command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conform captures once, replays a kept capture without running the tests, reads back a verdict it holds, and refuses --replay-only once the code moved", async () => {
  const root = counterProject();
  try {
    const config = JSON.parse(readFileSync(join(root, "coherence.config.json"), "utf8")) as { conformance: { models: Record<string, Record<string, unknown>> } };
    config.conformance.models["src/counter"]!["acknowledged"] = [{ guard: "bump#1", because: "callers write a by of one to five" }];
    writeFileSync(join(root, "coherence.config.json"), JSON.stringify(config));
    const first = await conform(root);
    assert.equal(first.code, 0, [...first.out, ...first.err].join("\n"));
    assert.match(first.out.join("\n"), /tests: .*counter\.test\.ts/);
    assert.match(first.out.join("\n"), /8\/8 logged args pin a step choice/);
    assert.match(first.out.join("\n"), /verdict: agrees/);
    const hash = captureHash(root, readConformanceConfig(root));
    assert.ok(readCapture(root, hash) !== undefined, "the capture is kept under its hash");
    assert.equal(await conformanceStanding(root, "src/counter"), "agrees");

    // The model alone moved: the stored traces replay, and no test runs.
    appendFileSync(join(root, "src/counter/Counter.qnt"), "// edited\n");
    assert.equal(await conformanceStanding(root, "src/counter"), "stale", "a verdict for another model is no longer current");
    const replayed = await conform(root);
    assert.equal(replayed.code, 0, replayed.err.join("\n"));
    assert.match(replayed.out[0] ?? "", /^replay only: capture [0-9a-f]{12} is current; the tests do not run$/);
    assert.ok(!replayed.out.some((l) => l.startsWith("tests: ")), "the tests were not spawned");
    const again = await conform(root);
    assert.match(again.out.join("\n"), /src\/counter: unchanged since .*: agrees/);
    assert.equal(loadVerdicts(root).length, 2, "a verdict read back is not appended again");

    // A later verdict of the same replay, as conform --capture appends, is the one read back: an older agreement never masks a newer disagreement.
    const agreed = loadVerdicts(root).pop()!;
    appendVerdict(root, { ...agreed, at: new Date(Date.parse(agreed.at) + 1000).toISOString(), session: "s2", verdict: "disagrees", failures: [{ side: "capture-side", cause: "a later capture disagreed" }] });
    const masked = await conform(root);
    assert.equal(masked.code, 1);
    assert.match(masked.out.join("\n"), /src\/counter: unchanged since .*: disagrees/);
    assert.equal(await conformanceStanding(root, "src/counter"), "disagrees");

    // The code moved: an agreeing verdict of the code before is stale, never current; --replay-only refuses, and a plain conform captures again.
    appendFileSync(join(root, "src/counter/counter.ts"), "// edited\n");
    assert.equal(await conformanceStanding(root, "src/counter"), "stale", "a verdict of code since edited is not current");
    const refused = await conform(root, "--replay-only");
    assert.equal(refused.code, 1);
    assert.match(refused.err.join("\n"), /--replay-only, and no capture is kept for the code as it is/);
    const recaptured = await conform(root);
    assert.match(recaptured.out.join("\n"), /tests: /);
    assert.equal(recaptured.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
