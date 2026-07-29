// boundary.ts — the ONE home of the boundary-claim grammar.
//
// `boundary "<invariant>" at <chokepoint> [via (test|guard) "<oracle>"]`
//
// This regex used to live (identically, in intent) at three sites — structural.ts,
// verify.ts, and render-claude.ts — and the render-claude copy drifted: it matched
// `via test` only, so `via guard` boundaries silently vanished from the generated
// CLAUDE.md invariants table. One exported regex + one parser is the structural fix:
// the grammar cannot drift again because it has nowhere else to live.
//
// Capture groups: 1=invariant, 2=chokepoint symbol, 3=verb (test|guard), 4=oracle name.
// The `via …` clause is optional; groups 3/4 are undefined when absent.
import type { ClaimMatch } from "./plugin.ts";

export const BOUNDARY_RE = /^boundary\s+"([^"]+)"\s+at\s+(\S+)(?:\s+via (test|guard)\s+"([^"]+)")?$/;

/** A parsed boundary claim. `verb`/`oracle` are `""` when the claim has no `via` clause. */
export interface Boundary {
  inv: string;
  chokepoint: string;
  verb: string;
  oracle: string;
  data?: ClaimMatch["data"];
}

/** Parse a boundary claim, or null if the line is not one. */
export function parseBoundary(claim: string): Boundary | null {
  const m = BOUNDARY_RE.exec(claim);
  return m ? { inv: m[1], chokepoint: m[2], verb: m[3] ?? "", oracle: m[4] ?? "" } : null;
}

/** Adapt normalized claim semantics into the boundary view used by core consumers. */
export function boundaryFromMatch(match: ClaimMatch): Boundary | null {
  if (match.family !== "boundary" || !match.target) return null;
  return {
    inv: match.key,
    chokepoint: match.target,
    verb: match.oracle?.kind ?? "",
    oracle: match.oracle?.name ?? match.oracle?.kind ?? "",
    ...(match.data === undefined ? {} : { data: match.data }),
  };
}
