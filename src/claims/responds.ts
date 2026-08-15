// claims/responds.ts — `<url> responds <status> [with "<text>"]`: the live tier — a
// running service answering, skipped (never failed) when unreachable or under --fast.
import { claimOf, type ClaimForm } from "./shared.ts";

export const respondsForm: ClaimForm = {
  name: "responds",
  grammar: '<url> responds <status> [with "<text>"]',
  example: 'http://localhost:8787/health responds 200 with "ok"',
  tier: "live",
  parse: (l) => {
    const m = /^(\S+)\s+responds\s+(\d+)(?:\s+with\s+"(.*)")?$/.exec(l);
    if (!m) return null;
    const detail: Record<string, string> = { url: m[1], status: m[2] };
    if (m[3] !== undefined) detail.text = m[3];
    return claimOf("responds", l, { detail });
  },
  evaluate: async (ctx, { detail: { url, status, text } }) => {
    if (ctx.fast) return { kind: "skip", detail: "live tier (--fast)" };
    try {
      const res = await fetch(url);
      if (res.status !== Number(status)) return { kind: "fail", detail: `got ${res.status}` };
      if (text) { const bdy = await res.text(); if (!bdy.includes(text)) return { kind: "fail", detail: `body missing "${text}"` }; }
      return { kind: "pass" };
    } catch { return { kind: "skip", detail: "unreachable" }; }
  },
};
