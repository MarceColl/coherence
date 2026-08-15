// parity.ts — the ONE home of the parity-claim grammar (mirrors boundary.ts).
//
// `parity "<invariant>" over <domain> between <fnA> and <fnB> via test "<oracle>"`
//
// A parity claim declares that two functions are PROJECTIONS OF ONE ENUMERATED DOMAIN
// and must AGREE over it — the generalization of the boundary totality oracle from
// COVERAGE ("the chokepoint handles every member") to AGREEMENT ("f and g read every
// member the same way"). The canonical bug class it exists to kill: a live projection
// and a settled projection of the same tool/message vocabulary drifting apart, often
// across deploy artifacts (a Worker function vs a browser table) where no single
// TypeScript compilation can see both sides.
//
// Capture groups: 1=invariant, 2=domain symbol, 3=fnA, 4=fnB, 5=oracle name.
// Unlike boundary's, the `via test` clause is REQUIRED: agreement is a semantic the
// project must state (what "equal" means between two projections is domain knowledge),
// so a parity claim without an oracle would be an empty attestation.
import { analyzeParityOracle } from "./oracle-domain.ts";
import { claimOf, execNamedTest, hasRunner, type ClaimForm } from "./claims/shared.ts";

const PARITY_RE =
  /^parity\s+"([^"]+)"\s+over\s+(\S+)\s+between\s+(\S+)\s+and\s+(\S+)\s+via test\s+"([^"]+)"$/;

/** A parsed parity claim. */
export interface Parity { inv: string; domain: string; f: string; g: string; oracle: string; }

/** Parse a parity claim, or null if the line is not one. */
export function parseParity(claim: string): Parity | null {
  const m = PARITY_RE.exec(claim);
  return m ? { inv: m[1], domain: m[2], f: m[3], g: m[4], oracle: m[5] } : null;
}

/** The parity CLAIM FORM — the AGREEMENT ratchet, the boundary totality pattern
 *  generalized from coverage to parity. Two functions are declared PROJECTIONS OF ONE
 *  ENUMERATED DOMAIN and must agree over it: the invariant is named (and anchored by
 *  evaluateClaimLine, so a parity claim satisfies the invariant-coverage gate exactly
 *  like a boundary), the domain and BOTH projection symbols must exist in the code graph,
 *  and the oracle passes. The parity META-ORACLE runs even under --fast (source analysis,
 *  like the boundary's): the named describe must ENUMERATE the declared domain and DRIVE
 *  both projections — a one-sided or sample-list oracle fails the claim rather than
 *  wearing the label. */
export const parityForm: ClaimForm = {
  name: "parity",
  grammar: 'parity "<invariant>" over <domain> between <fnA> and <fnB> via test "<oracle>"',
  example: 'parity "disclosure faithfulness" over TOOL_NAMES between toolActivity and messageProvenance via test "live equals settled"',
  tier: "hybrid",
  parse: (l) => {
    const p = parseParity(l);
    if (!p) return null;
    return claimOf("parity", l, {
      key: p.inv, anchors: [p.inv], symbols: [p.domain, p.f, p.g],
      detail: { domain: p.domain, f: p.f, g: p.g, oracle: p.oracle },
    });
  },
  evaluate: async (ctx, claim) => {
    const inv = claim.key, { domain, f, g, oracle } = claim.detail;
    for (const s of [domain, f, g])
      if (!ctx.graph.nodes.some((n) => n.kind === "symbol" && n.label === s))
        return { kind: "fail", detail: `symbol "${s}" not found in the code graph` };
    if (ctx.cfg.oracleDomain !== false) {
      const a = await analyzeParityOracle(ctx.cfg, oracle, domain, f, g);
      if (a.verdict === "not-found")
        return { kind: "fail", detail: `[parity] "${oracle}" — no describe() with this EXACT title found, so the parity meta-oracle cannot analyze it. Anchor the claim to the oracle's exact describe title.` };
      if (a.verdict !== "ok")
        return { kind: "fail", detail: `[parity] "${oracle}" ${a.detail} (${a.file}). Loop the declared domain and assert \`${f}\` ≡ \`${g}\` per member.` };
    }
    if (ctx.fast) return { kind: "skip", detail: "parity oracle (--fast)" };
    if (!hasRunner(ctx)) return { kind: "skip", detail: "no test runner configured (config.test)" };
    const r = execNamedTest(ctx, oracle);
    if (!r.ok) return { kind: "fail", detail: r.detail, ms: r.ms };
    return { kind: "pass", detail: `${inv}: ${f} ≡ ${g} over ${domain}`, ms: r.ms };
  },
};
