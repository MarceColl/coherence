/**
 * A quint prop passes only when every quint step answered: a scripted quint
 * stands in for each outcome (a step that cannot start, a model checker with
 * no Java, a violation, a refusal), and the real quint checks the Journal's
 * work-order model end to end through a run.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_QUINT, type QuintConfig } from "../conformance/config.ts";
import { checkQuintProp, type ConformanceStanding } from "./quint-prop.ts";
import { performRun } from "./run.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SETTINGS: QuintConfig = { ...DEFAULT_QUINT, maxSamples: 300, maxSteps: 12, seed: "0x7", timeoutSeconds: 60 };

/** A quint that answers each command as the script says: typecheck, run and verify each ok, violation, error or nojava. */
function scriptedQuint(dir: string, answers: { typecheck?: string; run?: string; verify?: string }): string {
  const say = (step: string, answer = "ok"): string => {
    switch (answer) {
      case "violation":
        return `${step}) echo "[State 0] { x: 0 }"; echo "[violation] Found an issue (1ms)."; echo "error: Invariant violated" >&2; exit 1;;`;
      case "error":
        return `${step}) echo "error: [QNT404] Name 'nope' not found" >&2; exit 1;;`;
      case "nojava":
        return `${step}) echo "apalache-mc: line 83: exec: java: not found" >&2; exit 1;;`;
      default:
        return `${step}) echo "[ok] No violation found (1ms)."; exit 0;;`;
    }
  };
  const path = join(dir, "quint");
  writeFileSync(path, `#!/bin/sh\ncase "$1" in\n${say("typecheck", answers.typecheck)}\n${say("run", answers.run)}\n${say("verify", answers.verify)}\n*) exit 2;;\nesac\n`);
  chmodSync(path, 0o755);
  return path;
}

function withQuint<T>(answers: Parameters<typeof scriptedQuint>[1], body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "coherence-quint-prop-"));
  const before = process.env["COHERENCE_QUINT"];
  process.env["COHERENCE_QUINT"] = scriptedQuint(root, answers);
  writeFileSync(join(root, "M.qnt"), "module M {}\n");
  return body(root).finally(() => {
    if (before === undefined) delete process.env["COHERENCE_QUINT"];
    else process.env["COHERENCE_QUINT"] = before;
    rmSync(root, { recursive: true, force: true });
  });
}

test("a quint prop passes only when every quint step answered: verify unavailable or quint absent is not run, a violation or a refusal fails, and only verify off grades simulated", async () => {
  await withQuint({}, async (root) => {
    const proved = await checkQuintProp(root, ".", "M.qnt", "safe", undefined, SETTINGS);
    assert.equal(proved.verdict, "pass", proved.reason);
    assert.equal(proved.grade, "verified");
    assert.deepEqual(Object.fromEntries(Object.entries(proved.steps).map(([k, v]) => [k, v.outcome])), { typecheck: "ok", simulate: "ok", verify: "ok" });
    const sampled = await checkQuintProp(root, ".", "M.qnt", "safe", undefined, { ...SETTINGS, verify: "off" });
    assert.equal(sampled.verdict, "pass");
    assert.equal(sampled.grade, "simulated", "simulation alone grades simulated, and only when the config turns verify off");
    assert.equal(sampled.steps.verify?.outcome, "skipped");
    const unmodelled = await checkQuintProp(root, ".", undefined, "safe", undefined, SETTINGS);
    assert.equal(unmodelled.verdict, "not run");
  });
  await withQuint({ verify: "nojava" }, async (root) => {
    const result = await checkQuintProp(root, ".", "M.qnt", "safe", undefined, SETTINGS);
    assert.equal(result.verdict, "not run", "a model checker that could not start proved nothing");
    assert.match(result.reason, /quint verify unavailable: .*set quint\.verify off to accept simulation only/);
    assert.equal(result.grade, undefined);
  });
  await withQuint({ run: "violation" }, async (root) => {
    const result = await checkQuintProp(root, ".", "M.qnt", "safe", undefined, SETTINGS);
    assert.equal(result.verdict, "fail");
    assert.match(result.reason, /quint run found a state of M\.qnt that breaks safe/);
    assert.match(result.counterexample ?? "", /\[State 0\]/);
    assert.equal(result.steps.verify, undefined, "a violation settles the verdict before verify");
  });
  await withQuint({ typecheck: "error" }, async (root) => {
    const result = await checkQuintProp(root, ".", "M.qnt", "safe", undefined, SETTINGS);
    assert.equal(result.verdict, "fail");
    assert.match(result.reason, /quint typecheck refused M\.qnt/);
  });
  await withQuint({}, async (root) => {
    process.env["COHERENCE_QUINT"] = join(root, "no-such-quint");
    const result = await checkQuintProp(root, ".", "M.qnt", "safe", undefined, SETTINGS);
    assert.equal(result.verdict, "not run");
    assert.match(result.reason, /quint typecheck unavailable/);
  });
});

test("with conformance required, a quint prop needs its model's latest conformance verdict to agree and be current", async () => {
  await withQuint({}, async (root) => {
    writeFileSync(join(root, "coherence.config.json"), JSON.stringify({ conformance: { required: true } }));
    const standing = (verdict: ConformanceStanding) => () => verdict;
    assert.equal((await checkQuintProp(root, ".", "M.qnt", "safe", standing("agrees"), SETTINGS)).verdict, "pass");
    const disagreeing = await checkQuintProp(root, ".", "M.qnt", "safe", standing("disagrees"), SETTINGS);
    assert.equal(disagreeing.verdict, "fail");
    assert.match(disagreeing.reason, /conformance replay disagrees with the code/);
    for (const verdict of ["stale", "absent"] as const) {
      const held = await checkQuintProp(root, ".", "M.qnt", "safe", standing(verdict), SETTINGS);
      assert.equal(held.verdict, "not run", verdict);
      assert.equal(held.conformance, verdict);
    }
    writeFileSync(join(root, "coherence.config.json"), JSON.stringify({}));
    const free = await checkQuintProp(root, ".", "M.qnt", "safe", standing("stale"), SETTINGS);
    assert.equal(free.verdict, "pass", "unrequired, the verdict is recorded and holds nothing back");
    assert.equal(free.conformance, "stale");
  });
});

test("run checks a via: quint prop with quint against the spec's model, never as a test title, and records the grade and each step", async () => {
  const root = mkdtempSync(join(tmpdir(), "coherence-quint-run-"));
  try {
    writeFileSync(join(root, "coherence.config.json"), JSON.stringify({ quint: { verify: "off", maxSamples: 300, maxSteps: 12, seed: "0x7" }, test: ["false"] }));
    mkdirSync(join(root, "src/journal"), { recursive: true });
    writeFileSync(join(root, "src/journal/Journal.qnt"), readFileSync(resolve(here, "../journal/Journal.qnt"), "utf8"));
    writeFileSync(
      join(root, "src/journal/Journal.spec.md"),
      "# Journal\n\nWork orders.\nmodel: Journal.qnt\n\n## invariants\n- ended orders stay: A completed or cancelled order never moves.\n  over: every state the work-order model reaches\n  via: quint prop terminalNeverMoves\n  kinds: none\n",
    );
    const outcome = await performRun(root, { session: "s1", agent: "a", quint: true, server: false });
    const [entry] = outcome.record.invariants;
    assert.equal(entry?.verdict, "pass", entry?.reason);
    assert.equal(entry?.quintProp, "terminalNeverMoves");
    assert.equal(entry?.quintGrade, "simulated");
    assert.equal(entry?.quintSteps?.simulate?.outcome, "ok");
    assert.equal(entry?.mode, undefined, "no test runner ran it");
    assert.notEqual(outcome.record.full, true, "a quint-only run is scoped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
