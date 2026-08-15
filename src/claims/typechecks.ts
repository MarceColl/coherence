// claims/typechecks.ts — `typechecks`: the whole-project compile gate as a claim.
import { claimOf, type ClaimForm } from "./shared.ts";

export const typechecksForm: ClaimForm = {
  name: "typechecks",
  grammar: "typechecks",
  example: "typechecks",
  tier: "deterministic",
  parse: (l) => /^typechecks$/.test(l) ? claimOf("typechecks", l) : null,
  evaluate: (ctx) => { const t = ctx.typecheck(); return { kind: t.pass ? "pass" : "fail", detail: t.detail }; },
};
