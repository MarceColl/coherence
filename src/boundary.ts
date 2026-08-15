// boundary.ts — the ONE home of the boundary-claim grammar.
//
// `boundary "<invariant>" at <chokepoint> [crossing <zone> -> <zone>] [via (test|guard) "<oracle>"]`
//
// This regex used to live (identically, in intent) at three sites — structural.ts,
// verify.ts, and render-claude.ts — and the render-claude copy drifted: it matched
// `via test` only, so `via guard` boundaries silently vanished from the generated
// CLAUDE.md invariants table. One exported regex + one parser is the structural fix:
// the grammar cannot drift again because it has nowhere else to live.
//
// The OPTIONAL `crossing <from> -> <to>` clause states what wall (which pair of declared
// trust zones) this gate sits on — the PROMISE GRAPH's topology axiom (a gate declares
// what it separates). It is purely declarative: verify ignores it (a crossing is not a
// runtime check), scene/atlas/structural read only the fields they already read, and every
// pre-crossing spec parses UNCHANGED because both the crossing clause and the via clause
// are optional and independently absent. The clause sits BETWEEN chokepoint and via, so a
// gate may declare a crossing with or without an oracle, in any combination.
//
// Capture groups: 1=invariant, 2=chokepoint symbol, 3=crossing-from, 4=crossing-to,
// 5=verb (test|guard), 6=oracle name. Groups 3/4 are undefined when the crossing clause is
// absent; groups 5/6 are undefined when the via clause is absent.
import { analyzeOracle } from "./oracle-domain.ts";
import { claimOf, execNamedTest, hasRunner, type ClaimForm } from "./claims/shared.ts";

const BOUNDARY_RE =
  /^boundary\s+"([^"]+)"\s+at\s+(\S+)(?:\s+crossing\s+(\S+)\s+->\s+(\S+))?(?:\s+via (test|guard)\s+"([^"]+)")?$/;

/** A parsed boundary claim. `verb`/`oracle` are `""` when the claim has no `via` clause;
 *  `crossing` is null when it declares no `crossing <from> -> <to>` wall. */
export interface Boundary {
  inv: string;
  chokepoint: string;
  verb: string;
  oracle: string;
  crossing: { from: string; to: string } | null;
}

/** Parse a boundary claim, or null if the line is not one. */
export function parseBoundary(claim: string): Boundary | null {
  const m = BOUNDARY_RE.exec(claim);
  if (!m) return null;
  return {
    inv: m[1],
    chokepoint: m[2],
    verb: m[5] ?? "",
    oracle: m[6] ?? "",
    crossing: m[3] && m[4] ? { from: m[3], to: m[4] } : null,
  };
}

/** The crossing clause is PURELY DECLARATIVE (topology, never a runtime check) — so it must
 *  not leak into verify-record identity. Records are keyed on the verbatim claim string, and
 *  without this normalization, ANNOTATING an existing boundary with a crossing orphans its
 *  prior verdict (the post-crossing claim no longer matches the pre-crossing record key —
 *  every such gate silently drops from its earned grade on pure annotation). This
 *  reconstructs the canonical claim WITHOUT the crossing clause; non-boundary claims pass
 *  through verbatim. Two claims that collide after stripping share inv+chokepoint+verb+oracle
 *  — genuinely the same gate. Applied on BOTH sides of every record lookup (store + read);
 *  verify still WRITES the raw claim — normalization is strictly a lookup concern. */
export function normalizeBoundaryClaim(claim: string): string {
  const m = BOUNDARY_RE.exec(claim);
  if (!m || !(m[3] && m[4])) return claim;   // not a boundary, or no crossing → verbatim
  return `boundary "${m[1]}" at ${m[2]}${m[5] ? ` via ${m[5]} "${m[6]}"` : ""}`;
}

// The record-lookup key (`claimKey`) that rode on normalizeBoundaryClaim lives in
// phrasebook.ts now, generalized: every form states its own record identity through
// ParsedClaim.record, and the boundary's crossing-strip is just this form's statement.

/** The boundary CLAIM FORM — the anti-entropy ratchet. Asserts the four-part anatomy of a
 *  self-enforcing boundary: the invariant is named (and ANCHORED for the coverage gate —
 *  by evaluateClaimLine, from claim.anchors), the chokepoint SYMBOL exists, and (if given)
 *  the oracle passes. `via test` additionally runs the META-ORACLE (live-domain analysis,
 *  even under --fast); `via guard` is exempt (source-property oracle). The optional
 *  `crossing` clause is PROMISE-GRAPH topology, not a runtime check — verify never
 *  evaluates it. */
export const boundaryForm: ClaimForm = {
  name: "boundary",
  grammar: 'boundary "<invariant>" at <chokepoint> [crossing <zone> -> <zone>] [via (test|guard) "<oracle>"]',
  example: 'boundary "fail-closed writes" at applyWritePolicy crossing agent-mcp -> storage via test "write policy totality"',
  tier: "hybrid",
  parse: (l) => {
    const b = parseBoundary(l);
    if (!b) return null;
    const detail: Record<string, string> = { chokepoint: b.chokepoint };
    if (b.verb) { detail.verb = b.verb; detail.oracle = b.oracle; }
    if (b.crossing) { detail.crossingFrom = b.crossing.from; detail.crossingTo = b.crossing.to; }
    // record strips the crossing clause: pure topology must not fork record identity
    // (annotating a gate with a crossing must never orphan its verdict — see above).
    return claimOf("boundary", l, { key: b.inv, anchors: [b.inv], symbols: [b.chokepoint], record: normalizeBoundaryClaim(l), detail });
  },
  evaluate: async (ctx, claim) => {
    const inv = claim.key, sym = claim.detail.chokepoint, verb = claim.detail.verb, test = claim.detail.oracle;
    if (!ctx.graph.nodes.some((n) => n.kind === "symbol" && n.label === sym)) return { kind: "fail", detail: `chokepoint symbol "${sym}" not found in the code graph` };
    if (!test) return { kind: "pass", detail: `${inv} @ ${sym} (no oracle)` };
    if (verb === "test" && ctx.cfg.oracleDomain !== false) {
      const a = await analyzeOracle(ctx.cfg, test);
      if (a.verdict === "literal")
        return { kind: "fail", detail: `[oracle] "${test}" iterates a LITERAL domain (${a.detail}) — a sampling oracle, not totality. Derive its domain from the live SSOT behind \`${sym}\` (or, if it is a source-property guard, declare it \`via guard\` not \`via test\`).` };
      if (a.verdict === "no-iteration")
        return { kind: "fail", detail: `[oracle] "${test}" performs NO domain iteration (${a.detail}) — a source-grep / hand-enumerated cases, not totality. Loop the live domain behind \`${sym}\`, or — if it is a genuine source-property guard — declare it \`via guard "${test}"\` instead of \`via test\`.` };
      if (a.verdict === "not-found")
        return { kind: "fail", detail: `[oracle] "${test}" — no describe() with this EXACT title found, so the meta-oracle cannot analyze its domain (the runner alone would still pass on an it()-name match, silently skipping analysis). Anchor the claim to the oracle's exact describe title, or declare it \`passes test\`/\`via guard\` if it is not a domain totality.` };
    }
    if (ctx.fast) return { kind: "skip", detail: "boundary oracle (--fast)" };
    if (!hasRunner(ctx)) return { kind: "skip", detail: "no test runner configured (config.test)" };
    const r = execNamedTest(ctx, test);
    if (!r.ok) return { kind: "fail", detail: r.detail, ms: r.ms };
    return { kind: "pass", detail: `${inv} @ ${sym}${verb === "guard" ? " (source-property guard)" : ""}`, ms: r.ms };
  },
};
