// structural.test.ts — the temporal ledger that powers `coherence log [--strict]`. Its
// whole job is to make a LOSS loud: a dropped invariant, removed anchor, or policy-marked
// fact change is exactly the diff a prose review misses. diffGraphs is the pure core;
// renderDiff returns the loss count that --strict turns into a nonzero exit.
import test from "node:test";
import assert from "node:assert/strict";
import { diffGraphs, renderDiff, allBoundaries, affectedComponents } from "../src/structural.ts";
import { graph, comp, tmpProject, cleanup, cfg } from "./_helpers.ts";
import { runCaptured } from "./_helpers.ts";

const losses = async (before: ReturnType<typeof graph>, after: ReturnType<typeof graph>) =>
  (await runCaptured(async () => renderDiff(diffGraphs(before, after), "A", "B"))).code;

const word = (name: string, intent: string, commitments: string[]) =>
  [`# ${name}`, intent, "", "## commitments", ...commitments.map((c) => `- ${c}`)].join("\n");
const withProject = async (files: Record<string, string>, fn: (root: string) => Promise<void>) => {
  const root = await tmpProject(files);
  try { await fn(root); } finally { await cleanup(root); }
};

test("diffGraphs — a removed boundary anchor is recorded as a loss", () => {
  const before = graph([comp(".", { label: "Hive", claims: ['boundary "egress" at seal via test "egress totality"'], invariants: ["egress"], why: "r" })]);
  const after = graph([comp(".", { label: "Hive", claims: [], invariants: ["egress"], why: "r" })]);
  const d = diffGraphs(before, after);
  assert.equal(d.boundaryRemoved.length, 1);
  assert.equal(d.boundaryRemoved[0].b.inv, "egress");
});

test("diffGraphs — a removed invariant is a loss", () => {
  const before = graph([comp(".", { label: "Hive", invariants: ["egress", "writes"], why: "r" })]);
  const after = graph([comp(".", { label: "Hive", invariants: ["writes"], why: "r" })]);
  const d = diffGraphs(before, after);
  assert.deepEqual(d.invRemoved, [{ comp: "Hive", inv: "egress" }]);
});

test("diffGraphs — a rewired chokepoint is flagged (not silently accepted)", () => {
  const before = graph([comp(".", { label: "Hive", claims: ['boundary "egress" at oldSeal via test "egress totality"'], invariants: ["egress"], why: "r" })]);
  const after = graph([comp(".", { label: "Hive", claims: ['boundary "egress" at newSeal via test "egress totality"'], invariants: ["egress"], why: "r" })]);
  const d = diffGraphs(before, after);
  assert.equal(d.boundaryRewired.length, 1);
  assert.equal(d.boundaryRewired[0].before.chokepoint, "oldSeal");
  assert.equal(d.boundaryRewired[0].after.chokepoint, "newSeal");
});

test("diffGraphs — additions are tracked but are not losses", () => {
  const before = graph([comp(".", { label: "Hive", invariants: ["egress"], why: "r" })]);
  const after = graph([
    comp(".", { label: "Hive", claims: ['boundary "egress" at seal via guard "g"'], invariants: ["egress", "writes"], why: "r" }),
    comp("new", { label: "New", why: "r" }),
  ]);
  const d = diffGraphs(before, after);
  assert.deepEqual(d.componentsAdded, ["New"]);
  assert.deepEqual(d.invAdded, [{ comp: "Hive", inv: "writes" }]);
  assert.equal(d.boundaryAdded.length, 1);
  assert.equal(d.invRemoved.length + d.boundaryRemoved.length + d.componentsRemoved.length, 0);
});

test("renderDiff — counts losses (the number --strict gates on)", async () => {
  const before = graph([comp(".", { label: "Hive", claims: ['boundary "egress" at seal via guard "g"'], invariants: ["egress"], why: "r" })]);
  const dropped = graph([comp(".", { label: "Hive", claims: [], invariants: [], why: "r" })]);
  assert.equal(await losses(before, dropped), 1 + 1); // invariant removed + boundary removed
  // a no-op diff has zero losses
  assert.equal(await losses(before, before), 0);
});

test("affectedComponents — a changed dictionary word file scopes to its CONFORMERS (both), not the word's container", async () => {
  await withProject(
    { "dictionary/Owned.md": word("Owned", "owner scope", ["typechecks"]) },
    async (root) => {
      const g = graph([
        comp("meter", { label: "Meter", claims: ["conforms to Owned"], why: "r" }),
        comp("consumer", { label: "Consumer", claims: ["conforms to Owned"], why: "r" }),
        comp("other", { label: "Other", claims: ["typechecks"], why: "r" }),
      ]);
      const scope = await affectedComponents(cfg(root), g, new Set(["dictionary/Owned.md"]));
      assert.deepEqual([...scope].sort(), ["consumer", "meter"]);
    },
  );
});

test("affectedComponents — a non-dictionary change still scopes by owning component (unchanged)", async () => {
  await withProject({}, async (root) => {
    const g = graph([
      comp("meter", { label: "Meter", claims: ["conforms to Owned"], why: "r" }),
      comp("other", { label: "Other", claims: ["typechecks"], why: "r" }),
    ]);
    const scope = await affectedComponents(cfg(root), g, new Set(["other/thing.ts"]));
    assert.deepEqual([...scope], ["other"]);
  });
});

test("affectedComponents — a word edit propagates TRANSITIVELY through a nested `conforms to`", async () => {
  await withProject(
    {
      "dictionary/Base.md": word("Base", "base pattern", ["typechecks"]),
      "dictionary/Owned.md": word("Owned", "wraps base", ["conforms to Base"]),
    },
    async (root) => {
      // Consumer conforms only to Owned; Owned conforms to Base. Editing Base must still reach
      // Consumer (the inner word propagates through the outer word to its conformers).
      const g = graph([
        comp("consumer", { label: "Consumer", claims: ["conforms to Owned"], why: "r" }),
        comp("other", { label: "Other", claims: ["typechecks"], why: "r" }),
      ]);
      const scope = await affectedComponents(cfg(root), g, new Set(["dictionary/Base.md"]));
      assert.deepEqual([...scope], ["consumer"]);
    },
  );
});

test("allBoundaries — keyed by chokepoint symbol, first declaration wins", () => {
  const g = graph([
    comp("a", { label: "A", claims: ['boundary "x" at seal via test "t1"'] }),
    comp("b", { label: "B", claims: ['boundary "y" at seal via test "t2"'] }), // same chokepoint, ignored
    comp("c", { label: "C", claims: ['boundary "z" at mint via guard "g"'] }),
  ]);
  const all = allBoundaries(g);
  assert.equal(all.size, 2);
  assert.equal(all.get("seal")!.inv, "x");
  assert.equal(all.get("seal")!.component, "A");
  assert.equal(all.get("mint")!.verb, "guard");
});

// ── parity claims in the ledger — agreement anchors are first-class ──────────────────

const PARITY = 'parity "disclosure faithfulness" over TOOL_NAMES between toolActivity and messageProvenance via test "live == settled"';

test("diffGraphs — an added parity claim is a structural addition, not a generic claim", () => {
  const before = graph([comp(".", { label: "Patient", why: "r" })]);
  const after = graph([comp(".", { label: "Patient", claims: [PARITY], invariants: ["disclosure faithfulness"], why: "r" })]);
  const d = diffGraphs(before, after);
  assert.equal(d.parityAdded.length, 1);
  assert.equal(d.parityAdded[0].p.domain, "TOOL_NAMES");
  assert.equal(d.claimDelta.length, 0); // not double-counted as a plain claim
});

test("diffGraphs + renderDiff — a removed parity claim is a LOSS (what --strict gates on)", async () => {
  const before = graph([comp(".", { label: "Patient", claims: [PARITY], why: "r" })]);
  const after = graph([comp(".", { label: "Patient", claims: [], why: "r" })]);
  const d = diffGraphs(before, after);
  assert.equal(d.parityRemoved.length, 1);
  assert.equal(await losses(before, after), 1);
});

test("diffGraphs — a reprojected parity (different f/g or domain) is rewired, not silent", () => {
  const before = graph([comp(".", { label: "Patient", claims: [PARITY], why: "r" })]);
  const after = graph([comp(".", { label: "Patient", claims: [PARITY.replace("messageProvenance", "history")], why: "r" })]);
  const d = diffGraphs(before, after);
  assert.equal(d.parityRewired.length, 1);
  assert.equal(d.parityRewired[0].before.g, "messageProvenance");
  assert.equal(d.parityRewired[0].after.g, "history");
});

test("diffGraphs — plugin facts are added, removed, and changed by stable id", () => {
  const before = graph([], [], [
    { id: "warehouse:kept", label: "Kept", value: { mode: "view" } },
    { id: "warehouse:removed", label: "Removed", value: 1 },
    { id: "warehouse:changed", label: "Changed", value: { mode: "view" } },
  ]);
  const after = graph([], [], [
    { id: "warehouse:kept", label: "Kept", value: { mode: "view" } },
    { id: "warehouse:changed", label: "Changed", value: { mode: "table" } },
    { id: "warehouse:added", label: "Added", value: true },
  ]);

  const d = diffGraphs(before, after);
  assert.deepEqual(d.factAdded.map((fact) => fact.id), ["warehouse:added"]);
  assert.deepEqual(d.factRemoved.map((fact) => fact.id), ["warehouse:removed"]);
  assert.deepEqual(d.factChanged.map((change) => change.id), ["warehouse:changed"]);
});

test("diffGraphs — fact object key order is not a structural change", () => {
  const before = graph([], [], [{
    id: "warehouse:shape",
    label: "Shape",
    value: { alpha: 1, nested: { beta: 2, gamma: 3 } },
  }]);
  const after = graph([], [], [{
    id: "warehouse:shape",
    label: "Shape",
    value: { nested: { gamma: 3, beta: 2 }, alpha: 1 },
  }]);
  const d = diffGraphs(before, after);
  assert.equal(d.factChanged.length, 0);
});

test("renderDiff — fact loss policy controls strict loss counting", async () => {
  const guarded = graph([], [], [
    { id: "warehouse:removed", label: "Removed", policy: { removal: "loss" } },
    { id: "warehouse:changed", label: "Changed", value: "old", policy: { change: "loss" } },
    { id: "warehouse:informational", label: "Informational" },
  ]);
  const after = graph([], [], [
    { id: "warehouse:changed", label: "Changed", value: "new", policy: { change: "loss" } },
  ]);
  const rendered = await runCaptured(async () => renderDiff(diffGraphs(guarded, after), "A", "B"));
  assert.equal(rendered.code, 2);
  assert.match(rendered.out, /fact "Removed".*REMOVED — LOSS/);
  assert.match(rendered.out, /fact "Changed".*CHANGED — LOSS/);
  assert.match(rendered.out, /fact "Informational".*REMOVED/);
});
