// claims/lives-in.ts — `lives in <zone>`: RESIDENCE, the PROMISE GRAPH's topology
// axiom 2. A component declares which trust zone it lives in, so a cross-component
// import can be graded (same-zone / covered / naked). Like a crossing, residence is a
// DECLARATION, not a runtime property, so verify asserts only that it is well-formed (a
// non-empty zone token) and passes. Its SEMANTIC validation (is the named zone declared?
// does the wall it opens have a gate?) lives in the promise layer (`coherence contract`),
// which owns zones — NOT here. Registering it is what keeps `lives in` from grading as U:
// an unregistered verb is a dialect-gap skip, which would wrongly report the topology as
// an unread claim.
import { claimOf, type ClaimForm } from "./shared.ts";

export const livesInForm: ClaimForm = {
  name: "lives in",
  grammar: "lives in <zone>",
  example: "lives in owner-trusted",
  tier: "deterministic",
  parse: (l) => {
    const m = /^lives in\s+(\S+)$/.exec(l);
    return m ? claimOf("lives in", l, { detail: { zone: m[1] } }) : null;
  },
  evaluate: (_ctx, { detail: { zone } }) => ({ kind: "pass", detail: `resides in ${zone}` }),
};
