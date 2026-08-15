// claims/shared.ts — the claim-form CONTRACT plus the shared executable arm. One claim
// form = one module exporting one `ClaimForm` (src/claims/*, boundary.ts, parity.ts);
// this file is what every one of them builds against, and it is a LEAF on purpose: it
// imports no form and no registry, so a form module can never cycle through it.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Config, Graph } from "../types.ts";
import { resolveFromBatch, type OracleAccess } from "../test-batch.ts";

/** The verdict a claim form returns — adapted into verify's `Sig` (which adds claim + node).
 *
 *  `ms` is the HOLDING COST the form can attest to from the RUNNER'S OWN report, and only
 *  the batch-resolved executable arm supplies it (see `execNamedTest`). Every other form
 *  leaves it absent, so verify falls back to its own wall clock there — deliberately, since
 *  a wall-clock reading over a batch lookup would measure a map hit, not the oracle. */
export interface ClaimResult { kind: "pass" | "fail" | "skip"; detail?: string; ms?: number }

/**
 * Everything a claim form needs to evaluate, threaded from runVerify. `nodeDir`/`node`
 * are the DECLARING component's disk dir + label; `anchor` records a boundary-anchored
 * invariant for that component (so the coverage gate sees it — even when the boundary is
 * reached through a `conforms to` word). `typecheck` is memoized upstream (one run/verify).
 * `wordStack` is the `conforms to` expansion stack for cycle/depth safety.
 *
 * `oracles` is the EXECUTABLE-TIER seam, memoized upstream exactly like `typecheck`: at
 * most one whole-suite resolution per verify, LAZILY — a `--fast` run or a project with no
 * executable claims never calls it. It answers with a batch report when one is available,
 * and otherwise says whether the SERIAL per-claim path is permitted at all. A null report
 * with `serialAllowed: false` is a refusal (no batch, no report, nobody asked for serial),
 * and the claim skips rather than quietly costing a full pool boot.
 */
export interface ClaimCtx {
  cfg: Config;
  graph: Graph;
  root: string;
  nodeDir: string;
  node: string;
  fast: boolean;
  typecheck: () => { pass: boolean; detail: string };
  anchor: (inv: string) => void;
  wordStack: string[];
  oracles?: () => OracleAccess;
}

/**
 * One immutable normalized reading of a claim line, produced by its form's `parse` — the
 * ONLY value the shared plumbing (ledger, novelty, tree, contracts, record identity) knows
 * a claim by. Boundary-family consumers (atlas, promise, panel rows, renderers) still use
 * the typed parseBoundary/parseParity: those features grade the boundary CONCEPT, and an
 * abstraction from that single example would be a guess. This value is the deliberate
 * generic half of that split.
 */
export interface ParsedClaim {
  form: string;                              // registry form name ("boundary", "exists", …)
  key: string;                               // temporal identity within a component (ledger)
  anchors: readonly string[];                // invariants this claim anchors ([] = not an anchor)
  symbols: readonly string[];                // code-graph symbols the claim names
  files: readonly string[];                  // file tokens the claim blesses (tree coverage)
  record: string;                            // record-lookup text (declarative clauses stripped)
  detail: Readonly<Record<string, string>>;  // named non-identity fields; a change = REWIRED
}

/** Build a frozen ParsedClaim. Every field defaults to the plainest reading — key/record =
 *  the verbatim line, everything else empty — so a simple form overrides nothing. */
export const claimOf = (
  form: string,
  line: string,
  over: { key?: string; anchors?: string[]; symbols?: string[]; files?: string[]; record?: string; detail?: Record<string, string> } = {},
): ParsedClaim => Object.freeze({
  form,
  key: over.key ?? line,
  anchors: Object.freeze(over.anchors ?? []),
  symbols: Object.freeze(over.symbols ?? []),
  files: Object.freeze(over.files ?? []),
  record: over.record ?? line,
  detail: Object.freeze(over.detail ?? {}),
});

export interface ClaimForm {
  name: string;
  /** human-readable grammar, for the phrasebook table / README authority. */
  grammar: string;
  example: string;
  tier: "deterministic" | "live" | "executable" | "hybrid";
  parse(line: string): ParsedClaim | null;
  evaluate(ctx: ClaimCtx, claim: ParsedClaim): ClaimResult | Promise<ClaimResult>;
}

/** Regex-escape a string so it matches literally when interpolated into a RegExp or passed
 *  to a test runner whose `-t <name>` treats the arg as a regex (vitest, jest). */
export const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Resolve ONE named test — the shared executable arm of `passes test`,
 * `boundary … via test`, and `parity … via test`. THE SINGLE FRONT DOOR: every runner
 * invocation coherence makes on a project's behalf goes through here, which is why
 * batching is a change to this one function rather than to three claim forms.
 *
 * Two arms, one contract:
 *   BATCH — a whole-suite report is available, so the answer is a lookup (`resolveFromBatch`).
 *   PER-CLAIM — shell `config.test` with the name appended, regex-escaped for the runner's
 *     `-t`; exit 0 alone is not trusted (`testMatch` requires positive evidence the named
 *     test actually ran — an exit-0 runner that matched zero tests would otherwise pass a
 *     renamed/deleted oracle).
 *
 * Both arms require positive evidence and both go red on zero matches, so which one
 * answered is an operational detail, never a difference in what green means.
 *
 * `ms` — the claim's HOLDING COST, and ONLY the batch arm can report it. The report carries
 * the runner's own per-test durations, so a batched claim's cost is measured by the thing
 * that ran it. The serial arm returns none: what a wall clock sees there is a whole test-pool
 * boot charged to whichever claim happened to trigger it, which is a fact about the profile,
 * not about the claim. Verify's own wall clock takes over when this is absent.
 */
export function execNamedTest(ctx: ClaimCtx, name: string): { ok: boolean; detail: string; ms?: number } {
  const o = ctx.oracles?.();
  if (o?.report) return resolveFromBatch(o.report, name);
  return runSerialNamedTest(ctx.cfg, ctx.root, name);
}

/** The SERIAL arm of `execNamedTest`, factored so the canary below probes the EXACT code
 *  path a claim's verdict rides on — same spawn, same exit-code reading, same `testMatch`
 *  evidence rule. Exit 0 alone is not trusted: `testMatch` requires positive evidence the
 *  named test actually ran (a zero-match runner that exits 0 would otherwise pass a
 *  renamed/deleted oracle). */
export function runSerialNamedTest(cfg: Config, root: string, name: string): { ok: boolean; detail: string } {
  const r = spawnSync(cfg.test[0], [...cfg.test.slice(1), reEscape(name)], { cwd: root, encoding: "utf8", timeout: 120000 });
  const out = (r.stderr || "") + (r.stdout || "");
  if (r.status !== 0) return { ok: false, detail: out.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 200) };
  if (cfg.testMatch && !new RegExp(cfg.testMatch).test(out)) return { ok: false, detail: `test "${name}" matched no run (testMatch)` };
  return { ok: true, detail: "" };
}

/**
 * THE SERIAL CANARY — the repo's own doctrine applied to the instrument: a checker never
 * observed to fail has not been shown to be a checker. The batch path proves a vanished
 * oracle structurally (zero matches in the report is its own red); the serial path had to
 * TRUST `config.test` + `testMatch`, on a runner class this repo has itself documented as
 * un-guardable by testMatch (node:test multi-file: a real name and a name existing nowhere
 * produce byte-identical passing output — measured, test-batch.ts:110, types.ts).
 *
 * So, once per serial verify, run the runner with a name that provably exists nowhere and
 * require it to FAIL (nonzero exit, or a `testMatch` miss — the same reading a claim gets).
 * A runner that PASSES the canary cannot filter by name: every green it would produce is
 * green-by-absence, and verify must refuse it exactly as the batch path refuses. Cost is
 * one extra runner boot per serial run.
 */
export function proveSerialRunnerCanFail(cfg: Config, root: string): { proven: boolean; canary: string } {
  const canary = `coherence-canary-${randomBytes(6).toString("hex")}`;
  return { proven: !runSerialNamedTest(cfg, root, canary).ok, canary };
}

/** Whether SOME runner is allowed to answer an executable claim: a batch report, or — only
 *  when the run permits it — a configured per-claim command. A REFUSAL (`serialAllowed:
 *  false` with no report) reports false, so the claim skips instead of silently buying one
 *  full test-pool boot; verify fails the run separately, with instructions. */
export function hasRunner(ctx: ClaimCtx): boolean {
  const o = ctx.oracles?.();
  if (o?.report) return true;
  if (o && !o.serialAllowed) return false;
  return !!(ctx.cfg.test && ctx.cfg.test.length);
}
