/**
 * The door to quint and the Journal's work-order model: every outcome is read
 * as the command meant it, only ok passes, and the model's properties hold
 * while a mutant that lets an ended order move breaks one (so they are not
 * vacuous). The quint tests need quint installed at QUINT_PIN, as CI installs
 * it; absent, they fail naming the cause.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_QUINT } from "./config.ts";
import { QUINT_PIN, quintOutcome, quintVersion, runQuint, simulate, testReport, typecheck } from "./quint.ts";

const here = dirname(fileURLToPath(import.meta.url));
const JOURNAL_MODEL = resolve(here, "../journal/Journal.qnt");
const QUICK = { ...DEFAULT_QUINT, maxSamples: 500, maxSteps: 15, seed: "0x1" };
const options = { cwd: here, timeoutMs: 120_000 };

async function requireQuint(): Promise<void> {
  const found = await quintVersion();
  assert.ok("version" in found, "reason" in found ? found.reason : "quint");
  assert.ok(found.pinned, `quint ${found.version} is installed; Coherence reads ${QUINT_PIN}.x`);
}

test("a quint outcome is ok only on exit 0; a violation, a refusal and a checker that could not start are each named", () => {
  assert.equal(quintOutcome(0, "[ok] No violation found", "").outcome, "ok");
  assert.equal(quintOutcome(1, "[violation] Found an issue (16ms).", "error: Invariant violated").outcome, "violation");
  assert.equal(quintOutcome(1, "", "error: [QNT404] Name 'nosuch' not found\nerror: Argument error").outcome, "error");
  assert.equal(quintOutcome(1, "", "/home/u/.quint/apalache-dist/apalache/bin/apalache-mc: line 83: exec: java: not found").outcome, "unavailable");
  assert.equal(quintOutcome(null, "", "").outcome, "error", "a signal is no pass");
  assert.deepEqual(testReport({ passed: ["a"], failed: ["b"], errors: [] }), { passed: ["a"], failed: ["b"], errors: [] });
  assert.deepEqual(testReport({ errors: [{ explanation: "[QNT404] Name 'x' not found" }] }), { passed: [], failed: [], errors: ["[QNT404] Name 'x' not found"] });
  assert.equal(testReport({ stage: "parsing" }), undefined);
});

test("quint that cannot start is unavailable, never a pass", async () => {
  const before = process.env["COHERENCE_QUINT"];
  process.env["COHERENCE_QUINT"] = join(tmpdir(), "no-such-quint-binary");
  try {
    const result = await runQuint(["--version"], options);
    assert.equal(result.outcome, "unavailable", result.reason);
    assert.match(result.reason, /quint could not start/);
    assert.ok("reason" in (await quintVersion()));
  } finally {
    if (before === undefined) delete process.env["COHERENCE_QUINT"];
    else process.env["COHERENCE_QUINT"] = before;
  }
});

test("the work-order model typechecks and each of its properties holds in simulation", async () => {
  await requireQuint();
  const checked = await typecheck(JOURNAL_MODEL, options);
  assert.equal(checked.outcome, "ok", checked.stderr);
  for (const property of ["terminalNeverMoves", "statesKnown", "ownerNamed", "endedKnown"]) {
    const run = await simulate(JOURNAL_MODEL, property, QUICK, options);
    assert.equal(run.outcome, "ok", `${property}: ${run.reason}\n${run.stderr}`);
  }
});

test("a work-order model whose move lets an ended order move breaks terminalNeverMoves", async () => {
  await requireQuint();
  const text = readFileSync(JOURNAL_MODEL, "utf8");
  const guard = "    MOVE_STATES.contains(target),\n    isLive(orders, id),\n";
  assert.ok(text.includes(guard), "the move action carries the live guard the mutant drops");
  const dir = mkdtempSync(join(tmpdir(), "coherence-quint-mutant-"));
  try {
    const mutant = join(dir, "Journal.qnt");
    writeFileSync(mutant, text.replace(guard, "    MOVE_STATES.contains(target),\n    orders.keys().contains(id),\n"));
    const run = await simulate(mutant, "terminalNeverMoves", { ...QUICK, maxSamples: 2000 }, { ...options, cwd: dir });
    assert.equal(run.outcome, "violation", run.reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
