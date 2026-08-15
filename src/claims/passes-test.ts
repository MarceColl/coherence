// claims/passes-test.ts — `passes test "<name>"`: one named oracle must run and pass,
// through the single executable front door (execNamedTest — batch or proven serial).
import { claimOf, execNamedTest, hasRunner, type ClaimForm } from "./shared.ts";

export const passesTestForm: ClaimForm = {
  name: "passes test",
  grammar: 'passes test "<name>"',
  example: 'passes test "write policy totality"',
  tier: "executable",
  parse: (l) => {
    const m = /^passes test\s+"(.+)"$/.exec(l);
    return m ? claimOf("passes test", l, { detail: { test: m[1] } }) : null;
  },
  evaluate: (ctx, { detail: { test } }) => {
    if (ctx.fast) return { kind: "skip", detail: "executable tier (--fast)" };
    if (!hasRunner(ctx)) return { kind: "skip", detail: "no test runner configured (config.test)" };
    const r = execNamedTest(ctx, test);
    return r.ok ? { kind: "pass", ms: r.ms } : { kind: "fail", detail: r.detail, ms: r.ms };
  },
};
