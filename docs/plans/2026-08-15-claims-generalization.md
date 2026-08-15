# Claims Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every consumer of claim semantics reads one normalized `ParsedClaim` value obtained from the claim registry, so a claim form is a self-contained unit — the precondition for plugin-provided claim forms later. Zero observable behavior change (one blessed latent-bug fix, noted in Task 6).

**Architecture:** `ClaimForm.match` (regex groups) becomes `parse(line) → ParsedClaim | null` (an immutable normalized value). Generic consumers (verify loop, temporal ledger, novelty anchors, record identity, file blessing, contract anchoring, dictionary cross-refs) read `ParsedClaim` fields via the registry. Boundary-family consumers (atlas, promise graph, panel boundary rows, render-claude, why-lint, conventions, context obligations) are **explicitly blessed** to keep importing the typed `parseBoundary`/`parseParity` — boundary stays a core family; its pluggable axis later is evidence verbs, not new gate concepts.

**Tech Stack:** TypeScript run directly under Node ≥22 (type stripping), `node --test`. No new dependencies.

**Spec:** This plan carries its own design (section "Design" below); agreed in conversation 2026-08-15.

## Global Constraints

- **Zero behavior change** except the blessed fix in Task 6. Existing tests may be *restructured* where an internal API changes (`StructuralDiff`), never weakened.
- **The repo dogfoods itself.** `src/harness.spec.md` boundary claims name symbols by label (`execNamedTest`, `runVerify`, `analyzeOracle`, `resolveFromBatch`, …). Symbols may move between files (graph resolution is global by label) but must **not be renamed**. After every slice, the repo's own `coherence verify` must be green.
- **Working discipline:** `jj git fetch && jj new main` before coding; implement as a 3-change stacked series via the `stacking-prs-with-jj` flow (one PR per section below); every change independently green.
- **Green =** `npm test` + `npm run typecheck` + `node src/cli.ts verify` + `node src/cli.ts docs --check` (regenerate with `node src/cli.ts docs` if the registry-rendered docs moved).

---

## Design

### The problem being fixed

`CLAIM_FORMS` (src/phrasebook.ts) already makes *verification* pluggable, but claims play eight more roles, and 13 modules bypass the registry by importing `parseBoundary`/`parseParity`/`CONFORMS_RE` directly (structural, signal, panel, index-model, tree, contracts, context, promise, atlas, conventions, why-lint, render-claude, walk). A new form added to the registry today verifies but is invisible to the ledger, novelty, contracts, tree, and record identity — a second-class claim.

### The normalized value

```ts
/** One immutable normalized reading of a claim line, produced by its form's `parse`.
 *  Everything the SHARED plumbing knows about a claim; family-specific consumers
 *  (atlas, promise, …) still use the typed parseBoundary/parseParity. */
export interface ParsedClaim {
  form: string;                              // registry form name ("boundary", "exists", …)
  key: string;                               // temporal identity within a component (see ledger)
  anchors: readonly string[];                // invariants this claim anchors ([] = not an anchor)
  symbols: readonly string[];                // code-graph symbols the claim names
  files: readonly string[];                  // file tokens the claim blesses (tree.ts role)
  record: string;                            // record-lookup text: claim minus declarative-only
                                             //   clauses (boundary strips `crossing a -> b`)
  detail: Readonly<Record<string, string>>;  // named non-identity fields; a change = REWIRED
}
```

Per-form normalization (exact — regexes are the current ones, unchanged):

| form | key | anchors | symbols | files | record | detail |
|---|---|---|---|---|---|---|
| typechecks | line | [] | [] | [] | line | {} |
| exists | line | [] | [] | [file] | line | {file, where} |
| imports | line | [] | [] | [file] | line | {file, specifier} |
| responds | line | [] | [] | [] | line | {url, status, text?} |
| passes test | line | [] | [] | [] | line | {test} |
| boundary | inv | [inv] | [chokepoint] | [] | crossing-stripped | {chokepoint, verb?, oracle?, crossingFrom?, crossingTo?} |
| lives in | line | [] | [] | [] | line | {zone} |
| parity | inv | [inv] | [domain, f, g] | [] | line | {domain, f, g, oracle} |
| conforms to | line | [] | [] | [] | line | {word} |

Optional detail keys are **omitted when absent** (never empty-string) so rewire detection is field-presence-clean.

### The form interface

```ts
export interface ClaimForm {
  name: string;
  grammar: string;
  example: string;
  tier: "deterministic" | "live" | "executable" | "hybrid";
  parse(line: string): ParsedClaim | null;                       // replaces match()
  evaluate(ctx: ClaimCtx, claim: ParsedClaim): ClaimResult | Promise<ClaimResult>;
}
```

Registry-level API (single entrypoints for all shared consumers):

```ts
/** First matching form wins — the order of CLAIM_FORMS IS the precedence. */
export function parseClaim(line: string): { form: ClaimForm; claim: ParsedClaim } | null;

/** Parse → anchor every claim.anchors via ctx.anchor → evaluate. Null = no form matched
 *  (verify maps to dialect-gap SKIP; conforms-to maps to RED). The ONE evaluation path,
 *  used by verify's evalClaim AND the conforms-to expansion loop. */
export function evaluateClaimLine(ctx: ClaimCtx, line: string): Promise<ClaimResult> | null;
```

Anchoring moves out of the boundary/parity `evaluate` bodies into `evaluateClaimLine` (anchor **before** evaluate, preserving today's anchors-even-when-red semantics).

`claimKey(node, claim)` (boundary.ts) becomes `` `${node} ${parseClaim(claim)?.claim.record ?? claim}` `` — the crossing-stripping generalizes from a boundary special case to "each form declares its record identity". The `ClaimKey` brand is unchanged.

### The generic ledger

`structural.ts` `Ledger` replaces its `boundaries`/`parities` maps with one:

```ts
interface AnchorEntry { form: string; claim: string; detail: Readonly<Record<string, string>> }
interface Ledger {
  label: string;
  invariants: Set<string>;
  anchors: Map<string, AnchorEntry>;   // keyed `${form}:${key}`; anchors.length > 0 claims
  claims: Set<string>;                 // anchor-less claims (claimDelta, unchanged)
}
```

`StructuralDiff` replaces the six per-kind arrays with three generic ones (plus unchanged `componentsAdded/Removed`, `invAdded/Removed`, `claimDelta`):

```ts
anchorAdded:   Array<{ comp: string; form: string; claim: string }>;
anchorRemoved: Array<{ comp: string; form: string; claim: string }>;   // a LOSS
anchorRewired: Array<{ comp: string; key: string; form: string; before: AnchorEntry; after: AnchorEntry }>;
```

Rewired = same `${form}:${key}`, different `detail`. `renderDiff` prints `+ boundary "…" at …` from the claim text itself (the canonical line already reads well) and, for rewired, the changed detail fields as `field before → after`. Losses = componentsRemoved + invRemoved + anchorRemoved — same count as today.

### Blessed family-aware consumers (NOT ported)

`atlas.ts`, `promise.ts`, `panel.ts` boundary rows, `render-claude.ts`, `why-lint.ts`, `conventions.ts`, `context.ts` `obligation()`, `structural.ts` `allBoundaries`/`boundariesAt` keep importing `parseBoundary`/`parseParity`. Rationale (decided): these render/grade the boundary *concept*; abstracting them from a sample of one is premature. `BOUNDARY_RE`/`PARITY_RE`/`CONFORMS_RE` stop being exported once their last non-form consumer is ported; `parseBoundary`/`parseParity` remain public.

---

## PR 1 — `parse()` + `ParsedClaim` (behavior identical)

### Task 1: Normalization tests for every form

**Files:**
- Test: `test/phrasebook.test.ts` (extend)

**Interfaces:**
- Produces: expectations for `parseClaim` (exported from `src/phrasebook.ts` in Task 2).

- [ ] **Step 1: Write the failing tests** — one table-driven test asserting the full `ParsedClaim` for one canonical line per form (use the registry `example` lines), plus:

```ts
import { parseClaim } from "../src/phrasebook.ts";

test("parseClaim — boundary normalizes with crossing stripped from record", () => {
  const line = 'boundary "fail-closed writes" at applyWritePolicy crossing agent-mcp -> storage via test "write policy totality"';
  const r = parseClaim(line);
  assert.equal(r!.form.name, "boundary");
  assert.deepEqual(r!.claim, {
    form: "boundary", key: "fail-closed writes",
    anchors: ["fail-closed writes"], symbols: ["applyWritePolicy"], files: [],
    record: 'boundary "fail-closed writes" at applyWritePolicy via test "write policy totality"',
    detail: { chokepoint: "applyWritePolicy", verb: "test", oracle: "write policy totality",
              crossingFrom: "agent-mcp", crossingTo: "storage" },
  });
});

test("parseClaim — parity names all three symbols and anchors its invariant", () => {
  const r = parseClaim('parity "disclosure faithfulness" over TOOL_NAMES between toolActivity and messageProvenance via test "live equals settled"');
  assert.deepEqual([...r!.claim.symbols], ["TOOL_NAMES", "toolActivity", "messageProvenance"]);
  assert.deepEqual([...r!.claim.anchors], ["disclosure faithfulness"]);
  assert.equal(r!.claim.key, "disclosure faithfulness");
});

test("parseClaim — exists/imports bless their file token", () => {
  assert.deepEqual([...parseClaim("wrangler.jsonc exists at root")!.claim.files], ["wrangler.jsonc"]);
  assert.deepEqual([...parseClaim("main.ts imports ./registry")!.claim.files], ["main.ts"]);
});

test("parseClaim — an unmatched line is null (dialect gap stays a gap)", () => {
  assert.equal(parseClaim("wibbles the frobnicator"), null);
});

test("parseClaim — boundary without via/crossing omits those detail keys", () => {
  const r = parseClaim('boundary "x" at applyWritePolicy');
  assert.deepEqual(r!.claim.detail, { chokepoint: "applyWritePolicy" });
  assert.equal(r!.claim.record, 'boundary "x" at applyWritePolicy');
});
```

- [ ] **Step 2: Run to verify they fail** — `node --test test/phrasebook.test.ts` → FAIL (`parseClaim` not exported).

### Task 2: `ParsedClaim`, per-form `parse`, `parseClaim`, `evaluateClaimLine`

**Files:**
- Modify: `src/phrasebook.ts` (interface + all 9 forms + registry API)
- Modify: `src/boundary.ts` (record building stays here; `claimKey` re-based on `parseClaim`)
- Modify: `src/verify.ts` (evalClaim loop → `evaluateClaimLine`)

**Interfaces:**
- Produces: `ParsedClaim`, `parseClaim(line)`, `evaluateClaimLine(ctx, line)` as in Design; `ClaimForm.parse`/`evaluate(ctx, claim)`.
- Consumes: existing `BOUNDARY_RE`, `PARITY_RE`, `CONFORMS_RE` (unchanged regexes).

- [ ] **Step 1: Add `ParsedClaim` + change `ClaimForm`** exactly as in Design. Each form's `parse` wraps its existing regex and builds the normalized value per the table (frozen: `Object.freeze` the value, `detail`, and the arrays — append-only doctrine). Each `evaluate` body reads named fields from `claim.detail` instead of match groups (e.g. boundary: `const { chokepoint, verb, oracle } = claim.detail` — note `verb`/`oracle` may be `undefined` now, adjust the `if (!test)` guard to `if (!oracle)`).
- [ ] **Step 2: Remove `ctx.anchor(...)` calls from the boundary and parity `evaluate` bodies**; add `evaluateClaimLine` which anchors from `claim.anchors` then evaluates. Rewire `verify.ts` `evalClaim` and the `conforms to` commitment loop through it (verify maps `null` → skip "no verifier (dialect gap)"; conforms-to maps `null` → RED, exactly today's messages).
- [ ] **Step 3: Re-base `claimKey`** — `normalizeBoundaryClaim` becomes the boundary form's private record builder; `claimKey(node, claim)` uses `parseClaim(...).claim.record ?? claim`. **Watch the import cycle:** `boundary.ts` must not import `phrasebook.ts` at module top-level — move `claimKey` into `phrasebook.ts` and re-export it from `boundary.ts` (`export { claimKey } from "./phrasebook.ts"` is fine; consumers keep compiling; real import migration happens in PR 3).
- [ ] **Step 4: Green** — `npm test`, `npm run typecheck`, `node src/cli.ts verify`, `node src/cli.ts docs --check`.
- [ ] **Step 5: Commit** — `feat(claims): normalize every claim form into one ParsedClaim value`.

---

## PR 2 — port the generic consumers

Each task: port, run the suite, commit. One commit per task keeps the factoring loop reviewable.

### Task 3: Generic temporal ledger

**Files:**
- Modify: `src/structural.ts` (`Ledger`, `ledgerOf`, `StructuralDiff`, `diffGraphs`, `renderDiff`)
- Modify: `src/signal.ts` (`anchorsAddedByChange` reads the new fields)
- Test: `test/structural.test.ts`, `test/signal.test.ts` (restructure to the new `StructuralDiff` shape — same *scenarios*, e.g. "a rewired chokepoint is flagged" now asserts `anchorRewired[0].after.detail.chokepoint`)

**Interfaces:**
- Consumes: `parseClaim` (Task 2).
- Produces: `StructuralDiff` with `anchorAdded/anchorRemoved/anchorRewired` as in Design (also consumed by Task 4's signal changes and anything reading `diffGraphs`).

- [ ] **Step 1: Restructure the ledger tests first** to the generic shape; run → FAIL.
- [ ] **Step 2: Implement** `ledgerOf` via `parseClaim` (anchors-bearing → `anchors` map keyed `${form}:${key}`; else `claims` set), generic `diffGraphs`, `renderDiff` printing claim text + per-field rewire transitions. Loss count unchanged: componentsRemoved + invRemoved + anchorRemoved.
- [ ] **Step 3: Green** — full suite + self-verify. Confirm `node src/cli.ts log HEAD~5` output reads well by eye.
- [ ] **Step 4: Commit** — `refactor(structural): diff anchors generically by form+key`.

### Task 4: Novelty anchor counting

**Files:**
- Modify: `src/signal.ts:75-85` (`anchorsAddedByChange`: `parseBoundary(claim) || parseParity(claim)` → `(parseClaim(claim)?.claim.anchors.length ?? 0) > 0`; the structural-diff term uses `anchorAdded.length`)

- [ ] **Step 1: Port, run suite, self-verify.**
- [ ] **Step 2: Commit** — `refactor(signal): count anchors via the claim registry`.

### Task 5: File blessing in tree

**Files:**
- Modify: `src/tree.ts:70-90` (`claimedFilePaths`: drop the private `exists at|imports` regex and the `parseBoundary` skip; iterate `parseClaim(claim)?.claim.files ?? []` as the token source, same single-candidate blessing rule)
- Test: existing tree tests must stay green unchanged.

- [ ] **Step 1: Port, run suite.**
- [ ] **Step 2: Commit** — `refactor(tree): bless claimed files from ParsedClaim.files`.

### Task 6: Anchored-invariant fallbacks in panel + index-model (blessed fix)

**Files:**
- Modify: `src/panel.ts:116`, `src/index-model.ts:663` (`(c.claims ?? []).map(parseBoundary)…` → `flatMap((cl) => parseClaim(cl)?.claim.anchors ?? [])`)

**Note:** this is the one intended behavior change: the fallback previously counted only *boundary*-anchored invariants, while verify's real coverage gate also counts parity anchors (`ctx.anchor` in the parity form). The fallback now agrees with the gate. Add one test pinning it:

```ts
test("panel fallback — a parity-anchored invariant is not a gap", () => { /* component with
  invariants: ["x"] and a parity claim anchoring "x"; assert no gap row for it */ });
```

- [ ] **Step 1: Write the pinning test, watch it fail, port, green, self-verify.**
- [ ] **Step 2: Commit** — `fix(panel): count parity anchors in the unverified-tree fallback (align with verify's gate)`.

### Task 7: Contract anchoring evidence

**Files:**
- Modify: `src/contracts.ts:55-75` (`anchorsOf`: build the evidence index once from every component claim via `parseClaim` — any claim with `anchors.length > 0` whose `symbols` include the label counts, described as `` `${form} "${anchors[0]}" (${component})` ``; drop the `parseParity` import; `allBoundaries` may stay for the chokepoint-specific wording if the render keeps it)

- [ ] **Step 1: Port, keep the rendered wording recognizably equivalent (boundary/parity flavor comes from `form`), run suite + self-verify.**
- [ ] **Step 2: Commit** — `refactor(contracts): anchor evidence from any anchor-bearing claim`.

### Task 8: Dictionary cross-references

**Files:**
- Modify: `src/phrasebook.ts` (`loadDictionary` uses `parseClaim` → `form.name === "conforms to"` → `detail.word`), `src/structural.ts` word-propagation sites (same change), `src/walk.ts` if it consumes `CONFORMS_RE`
- Then: stop exporting `CONFORMS_RE`, `BOUNDARY_RE`, `PARITY_RE` (forms are their only remaining consumers); `npm run typecheck` proves nothing else needed them.

- [ ] **Step 1: Port all three sites, unexport the regexes, green, self-verify.**
- [ ] **Step 2: Commit** — `refactor(claims): route dictionary cross-refs through the registry; regexes go private`.

---

## PR 3 — one module per form

### Task 9: Split forms into `src/claims/`

**Files:**
- Create: `src/claims/shared.ts` (`ClaimCtx`, `ClaimResult`, `ClaimForm`, `ParsedClaim`, `execNamedTest`, `runSerialNamedTest`, `proveSerialRunnerCanFail`, `hasRunner`, `reEscape` — **labels unchanged**, spec claims name `execNamedTest`)
- Create: `src/claims/typechecks.ts`, `exists.ts`, `imports.ts`, `responds.ts`, `passes-test.ts`, `lives-in.ts` (each exports its one `ClaimForm`)
- Create: `src/claims/conforms-to.ts` exporting `conformsTo(forms: () => readonly ClaimForm[]): ClaimForm` — a factory taking a registry thunk, so no module cycle; the word-file machinery (`Word`, `parseWord`, `dictionaryDir`) moves here with it
- Modify: `src/boundary.ts`, `src/parity.ts` (each absorbs and exports its `ClaimForm` beside its grammar — one home per family)
- Modify: `src/phrasebook.ts` → the assembly point only: `CLAIM_FORMS` (ordered, `conformsTo(() => CLAIM_FORMS)` last), `parseClaim`, `evaluateClaimLine`, `claimKey`, `loadDictionary`; re-export the shared types so existing importers (`verify.ts`, `commands.ts`, `cli.ts`, tests) keep one import site.

**Interfaces:**
- Produces: the final layout where "a claim form" = one module exporting one `ClaimForm` — the exact unit a future plugin provides.

- [ ] **Step 1: Move without renaming any exported symbol label; imports updated mechanically.**
- [ ] **Step 2: Green** — full suite, `node src/cli.ts verify` (the moved symbols must still resolve in the repo's own graph), `node src/cli.ts docs --check` / regenerate.
- [ ] **Step 3: Commit** — `refactor(claims): one module per claim form; phrasebook is the registry`.

---

## Self-review checklist (run after implementation)

- [ ] `grep -rn "parseBoundary\|parseParity" src/` lists ONLY the blessed family-aware consumers named in Design.
- [ ] `grep -rn "BOUNDARY_RE\|PARITY_RE\|CONFORMS_RE" src/` lists only their defining modules.
- [ ] `node src/cli.ts log <pre-branch-ref>` renders a sensible ledger against history (generic diff reads old graphs fine — it re-parses claims from each ref's tree).
- [ ] Repo's own `verify`, `docs --check` green; `harness.spec.md` untouched (no symbol renames were needed).
