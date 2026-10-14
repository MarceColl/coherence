/**
 * Replay, gated against a real capture before it is trusted: the counter
 * fixture's own tests run under a collector once, and the correct model must
 * replay every trace while each deliberately wrong model fails. Then the
 * search bounds and the search over the choices a step leaves open, which
 * equalities are conformance facts, the report's pinning ratio and failure
 * sides, coverage's guard scenario outcomes with the model check behind an
 * unfalsifiable one, and the order a blind family's cause is ruled in. Needs
 * quint, as CI installs it.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { CapturedTrace } from "./collector.ts";
import { DEFAULT_SEARCH, readConformanceConfig, readQuintConfig, type ModelConformance } from "./config.ts";
import { blindCause, coverage, testScope } from "./coverage.ts";
import { readModel, type ReadModel } from "./model-ir.ts";
import { COUNTER_MODEL, WRONG_MODELS, counterProject } from "./replay-fixture.ts";
import { planTrace, replay } from "./replay.ts";
import { reportModel } from "./report.ts";
import { capture, scoped } from "./runner.ts";
import type { CaptureMeta } from "./store.ts";

let root = "";
let traces: CapturedTrace[] = [];
let meta: CaptureMeta;
let counter: ModelConformance;

before(async () => {
  root = counterProject();
  const config = readConformanceConfig(root);
  counter = config.models[0]!;
  const taken = await capture(root, config);
  assert.equal(taken.failure, undefined, taken.failure);
  meta = taken.meta;
  traces = scoped(taken.traces, counter.scopes).traces;
});

after(() => rmSync(root, { recursive: true, force: true }));

async function modelOf(text: string, name: string): Promise<ReadModel> {
  const file = join(root, "src/counter", `${name}.qnt`);
  writeFileSync(file, text.replace("module Counter {", `module ${name} {`));
  return readModel(file, readQuintConfig(root), root);
}

async function replayWith(text: string, name: string) {
  const model = await modelOf(text, name);
  return { model, replayed: await replay(traces, model, counter, readQuintConfig(root), join(root, ".scratch", name)) };
}

test("wrong model: the correct counter model replays every trace, and each deliberately wrong model fails replay", async () => {
  assert.equal(traces.length, 3, "three passing tests logged counter events");
  const { replayed } = await replayWith(COUNTER_MODEL, "Correct");
  assert.equal(replayed.failure, undefined);
  assert.deepEqual(replayed.traces.map((t) => [t.test, t.matched, t.cause]), traces.map((t) => [t.test, true, undefined]));
  const steps = replayed.traces[0]!.steps;
  assert.deepEqual(steps.map((s) => `${s.logged}:${s.outcome}`), ["bump:fired", "bump:fired", "reset:fired"]);
  assert.deepEqual(steps[1]!.pinned, [{ param: "by", value: "2" }, { param: "count_after", value: "3" }], "parameters pinned by name to the logged values");
  assert.deepEqual(steps[1]!.writes, ["count"]);
  assert.deepEqual(replayed.traces[1]!.steps.map((s) => s.outcome), ["fired", "rejected-stutter"], "a refusal the model makes too is a stutter");
  assert.deepEqual(replayed.traces[1]!.steps[1]!.falseGuards, [2], "and it names the guard that refused it");
  for (const [i, [wrong, text]] of Object.entries(WRONG_MODELS).entries()) {
    const { replayed: broken } = await replayWith(text, `Wrong${i}`);
    assert.ok(broken.traces.some((t) => !t.matched), `${wrong}: a wrong model replayed every trace`);
  }
});

test("a failing guard is an unmatched trace: an update off by one fails its conformance fact at the first bump, named with the pinned values", async () => {
  const { replayed } = await replayWith(WRONG_MODELS["an update off by one"]!, "OffByOne");
  const first = replayed.traces[0]!;
  assert.equal(first.matched, false);
  assert.equal(first.failedAt, 1);
  assert.match(first.cause ?? "", /bump\(by=1, count_after=1\) refused: #3 count_after == bumped\(count, by\) \(the conformance fact count_after\)/);
  assert.equal(first.steps[0]!.outcome, "refused", "the refusal is recorded, never skipped as a stutter");
});

test("a rejected attempt must be refused by the model: a model whose reset accepts an empty counter fails the test that refused it", async () => {
  const { replayed } = await replayWith(WRONG_MODELS["a rejection the model accepts"]!, "Accepting");
  const refused = replayed.traces.find((t) => t.test.endsWith("refuses a reset of nothing"))!;
  assert.equal(refused.matched, false);
  assert.match(refused.cause ?? "", /the code refused reset, and reset allows it/);
});

test("an exceeded search cap fails: a parameter with more alternatives than perPick, or a step past perStep, fails its trace before quint runs", async () => {
  const model = await modelOf(COUNTER_MODEL, "Search");
  const unpinned: CapturedTrace = { test: "t", events: [{ action: "bump", scopes: ["counter"], arguments: [{ name: "count_after", value: 1 }], seq: 1, pid: 1 }] };
  const wide = new Map([["by", Array.from({ length: 12 }, (_, i) => String(i))]]);
  const tight = { ...counter, search: { ...DEFAULT_SEARCH, perPick: 10 } };
  assert.match(planTrace(unpinned, model, tight, wide)[0]!.failure ?? "", /search bound: bump\.by has 12 alternatives, over perPick 10/);
  assert.match(planTrace(unpinned, model, { ...counter, search: { perPick: 20, perStep: 5, perRun: 100 } }, wide)[0]!.failure ?? "", /search bound: step 1 needs 12 alternatives for bump, over perStep 5/);
  assert.match(planTrace(unpinned, model, counter, new Map())[0]!.failure ?? "", /parameter by of bump is pinned by no logged argument and has no finite domain/);
  const searched = planTrace(unpinned, model, counter, new Map([["by", ["1", "2", "3"]]]));
  assert.equal(searched[0]!.failure, undefined);
  assert.equal(searched[0]!.candidates.length, 3, "within the bounds, every alternative is a candidate");
  // The model's domain_by is read from the model and searched: one value makes the logged count_after hold, and the resolution says which.
  const run = await replay([unpinned], model, counter, readQuintConfig(root), join(root, ".scratch", "search"));
  assert.equal(run.traces[0]!.matched, true, run.traces[0]!.cause);
  assert.deepEqual(run.traces[0]!.steps[0]!.searched, [{ param: "by", tried: 5, chose: "1" }]);
  const pinnedWrong: CapturedTrace = { test: "t", events: [{ action: "bump", scopes: ["counter"], arguments: [{ name: "count_after", value: 9 }], seq: 1, pid: 1 }] };
  const none = await replay([pinnedWrong], model, counter, readQuintConfig(root), join(root, ".scratch", "search-none"));
  assert.equal(none.traces[0]!.matched, false, "no value of the domain makes the fact hold: the search fails the trace, never passes on a guess");
});

test("the report says N/M logged args pin a step choice, names each argument that pins nothing, and classifies a refusal by the side that moved", async () => {
  const { replayed } = await replayWith(WRONG_MODELS["a renamed parameter"]!, "Renamed");
  const base = { at: "2026-10-14T00:00:00.000Z", session: "s", agent: "a", commit: null, dirty: false, model: "src/counter", file: "src/counter/Counter.qnt", captureHash: "c", replayHash: "r" };
  const report = reportModel({ base, meta, traces: replayed.traces, coverage: undefined, excluded: { audit: 1 }, moved: { prior: true, capture: false, model: true }, lastRatio: { pinned: 8, logged: 8 }, replayOnly: true });
  assert.ok(report.lines.includes("  4/8 logged args pin a step choice"), report.lines.join("\n"));
  assert.match(report.lines.join("\n"), /warning: these logged arguments pin nothing, .*: bump\.by/);
  assert.match(report.lines.join("\n"), /excluded by scope: 1 audit/);
  assert.equal(report.verdict.verdict, "disagrees");
  assert.ok(report.verdict.failures.some((f) => f.side === "replay-side" && /pinning ratio dropped from 8\/8 to 4\/8/.test(f.cause)));
  const { replayed: offByOne } = await replayWith(WRONG_MODELS["an update off by one"]!, "OffByOneReport");
  const codeMoved = reportModel({ base, meta, traces: offByOne.traces, coverage: undefined, excluded: {}, moved: { prior: true, capture: true, model: false }, replayOnly: false });
  assert.ok(codeMoved.verdict.failures.filter((f) => f.test !== undefined).every((f) => f.side === "capture-side"), "the code moved: the guard failure is the code's");
  assert.match(codeMoved.lines.join("\n"), /a failing guard is a finding: assume the code is wrong before the model/);
  const modelMoved = reportModel({ base, meta, traces: offByOne.traces, coverage: undefined, excluded: {}, moved: { prior: true, capture: false, model: true }, replayOnly: true });
  assert.ok(modelMoved.verdict.failures.filter((f) => f.test !== undefined).every((f) => f.side === "replay-side"), "only the model moved: the stored traces replay again");
});

test("guard scenario: a guard found true and false is tested, one never false that can be is a gap, and one no input can falsify fails until acknowledged with why", async () => {
  const { model, replayed } = await replayWith(COUNTER_MODEL, "Covered");
  const scratch = join(root, ".scratch", "coverage");
  const found = await coverage(traces, replayed.traces, model, counter, readQuintConfig(root), scratch);
  const outcome = (id: string): string | undefined => found.scenarios.find((s) => s.id === id)?.outcome;
  assert.equal(found.probeFailure, undefined, found.probeFailure);
  assert.equal(outcome("bump#2"), "tested", "a bump over three was refused by a test, and bumps under it fired");
  assert.equal(outcome("reset#1"), "tested");
  assert.equal(outcome("bump#1"), "unfalsifiable", "domain_by starts at one, so by > 0 cannot be made false");
  assert.deepEqual(found.landmarks.map((l) => [l.name, l.reached]), [["landmark_counted", true], ["landmark_high", true]]);
  const acknowledged = await coverage(traces, replayed.traces, model, { ...counter, acknowledged: [{ guard: "bump#1", because: "the code takes by from a literal 1 to 3" }] }, readQuintConfig(root), `${scratch}-ack`);
  assert.equal(acknowledged.scenarios.find((s) => s.id === "bump#1")?.outcome, "acknowledged");
  // Without the test that refuses a bump over three, the refusal path of by <= 3 is reachable and exercised by none.
  const withoutRefusal = traces.filter((t) => !t.test.endsWith("refuses a bump over three"));
  const narrowed = await replay(withoutRefusal, model, counter, readQuintConfig(root), join(root, ".scratch", "narrowed"));
  const gap = await coverage(withoutRefusal, narrowed.traces, model, counter, readQuintConfig(root), `${scratch}-gap`);
  assert.equal(gap.scenarios.find((s) => s.id === "bump#2")?.outcome, "gap");
  assert.equal(gap.landmarks.find((l) => l.name === "landmark_high")?.reached, true);
  const report = reportModel({ base: { at: "x", session: "s", agent: "a", commit: null, dirty: false, model: "src/counter", file: "f", captureHash: "c", replayHash: "r" }, meta, traces: narrowed.traces, coverage: gap, excluded: {}, moved: { prior: false, capture: false, model: false }, replayOnly: true });
  assert.ok(report.verdict.failures.some((f) => f.side === "capture-side" && /gap: bump#2 \(by <= 3\) is falsifiable but no test exercises its refusal path/.test(f.cause)));
});

test("an equality on a parameter the action reads elsewhere is a guard scenario; only a parameter held to a computed value and read nowhere else is a conformance fact", async () => {
  const model = await modelOf(COUNTER_MODEL.replace("    by <= 3,\n", "    by == 2,\n"), "EqualityGuard");
  const facts = (name: string): (string | undefined)[] => model.actions.find((a) => a.name === name)!.guards.map((g) => g.fact);
  assert.deepEqual(facts("bump"), [undefined, undefined, "count_after"], "by == 2 guards an input the update reads: it is a guard, never a fact");
  assert.deepEqual(facts("reset"), [undefined, "count_after"]);
});

/** A model where the first enabled choice of a searched parameter fails a later step and another choice replays it. */
const PICK_MODEL = `module Counter {
  var x: int

  pure val domain_by = 1.to(3)

  action init = x' = 0

  action bump(by: int): bool = all {
    by > 0,
    x' = x + by,
  }

  action check(x_now: int): bool = all {
    x_now == x,
    x' = x,
  }

  action step = any {
    nondet by = domain_by.oneOf()
    bump(by),
    check(x),
  }
}
`;

test("replay searches the choices a step leaves open: when the first enabled value fails a later step, another enabled value that replays the trace matches it", async () => {
  const model = await modelOf(PICK_MODEL, "Pick");
  const trace: CapturedTrace = { test: "t", events: [{ action: "bump", scopes: ["counter"], arguments: [], seq: 1, pid: 1 }, { action: "check", scopes: ["counter"], arguments: [{ name: "x_now", value: 2 }], seq: 2, pid: 1 }] };
  const run = await replay([trace], model, counter, readQuintConfig(root), join(root, ".scratch", "pick"));
  assert.equal(run.failure, undefined, run.failure);
  assert.equal(run.traces[0]!.matched, true, run.traces[0]!.cause);
  assert.deepEqual(run.traces[0]!.steps[0]!.searched, [{ param: "by", tried: 3, chose: "2" }], "by = 1 fires first and fails the check; by = 2 replays it");
  const none: CapturedTrace = { ...trace, events: [trace.events[0]!, { ...trace.events[1]!, arguments: [{ name: "x_now", value: 7 }] }] };
  const unmatched = await replay([none], model, counter, readQuintConfig(root), join(root, ".scratch", "pick-none"));
  assert.equal(unmatched.traces[0]!.matched, false, "no choice replays it: the trace fails, never passes on a guess");
  assert.equal(unmatched.traces[0]!.failedAt, 2);
});

test("a blind family's cause is ruled in order: a test command that names part of the suite first, then an action no trace logs, and only then a genuine gap", () => {
  assert.equal(testScope(["node", "--test", "--test-concurrency=1"]), undefined);
  assert.equal(testScope(["node", "--test", "src/journal/journal.test.ts"]), "src/journal/journal.test.ts");
  assert.equal(testScope("npm test -- --test-name-pattern=journal"), "--test-name-pattern=journal");
  assert.match(blindCause(["node", "--test", "src/journal/journal.test.ts"], ["owner"]), /^the test command may run part of the suite \(it names src\/journal\/journal\.test\.ts\): .*then check that owner is instrumented/);
  assert.match(blindCause(undefined, []), /^the test command may run part of the suite \(it names nothing conform can see/);
  assert.match(blindCause(["node", "--test"], ["owner"]), /^not instrumented: no trace logs an event that resolves to owner/);
  assert.match(blindCause(["node", "--test"], []), /^a genuine gap: the whole suite ran/);
});

test("a guard no sample makes false is model-checked before it reads unfalsifiable: a falsifying state makes it a gap, a checker that cannot start leaves it undecided, and only a check that finds none calls it unfalsifiable", async () => {
  const { model, replayed } = await replayWith(COUNTER_MODEL, "Checked");
  const real = process.env["COHERENCE_QUINT"] ?? "quint";
  const answers = {
    violation: `echo "[violation] Found an issue (1ms)."; echo "error: Invariant violated" >&2; exit 1`,
    nojava: `echo "apalache-mc: line 83: exec: java: not found" >&2; exit 1`,
    ok: `echo "[ok] No violation found (1ms)."; exit 0`,
  };
  const before = process.env["COHERENCE_QUINT"];
  try {
    for (const [answer, outcome] of [["violation", "gap"], ["nojava", "unexercised"], ["ok", "unfalsifiable"]] as const) {
      const bin = join(root, ".scratch", `quint-${answer}`);
      mkdirSync(join(root, ".scratch"), { recursive: true });
      writeFileSync(bin, `#!/bin/sh\ncase "$1" in\nverify) ${answers[answer]};;\n*) exec ${JSON.stringify(real)} "$@";;\nesac\n`);
      chmodSync(bin, 0o755);
      process.env["COHERENCE_QUINT"] = bin;
      const found = await coverage(traces, replayed.traces, model, counter, { ...readQuintConfig(root), verify: "apalache" }, join(root, ".scratch", `checked-${answer}`));
      const bump = found.scenarios.find((s) => s.id === "bump#1")!;
      assert.equal(bump.outcome, outcome, `verify answered ${answer}`);
      if (answer === "nojava") assert.match(bump.unproven ?? "", /quint verify unavailable/);
    }
  } finally {
    if (before === undefined) delete process.env["COHERENCE_QUINT"];
    else process.env["COHERENCE_QUINT"] = before;
  }
});
