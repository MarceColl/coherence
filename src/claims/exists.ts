// claims/exists.ts — `<file> exists at …`: presence of a named file, the simplest
// structural fact a spec can pin.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { claimOf, type ClaimForm } from "./shared.ts";

const fileExists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };

export const existsForm: ClaimForm = {
  name: "exists",
  grammar: "<file> exists at (root | this node | every node)",
  example: "wrangler.jsonc exists at root",
  tier: "deterministic",
  parse: (l) => {
    const m = /^(\S+)\s+exists at\s+(root|this node|every node)$/.exec(l);
    return m ? claimOf("exists", l, { files: [m[1]], detail: { file: m[1], where: m[2] } }) : null;
  },
  evaluate: async (ctx, { detail: { file, where } }) => {
    const base = where === "root" ? ctx.root : ctx.nodeDir;
    return { kind: (await fileExists(join(base, file))) ? "pass" : "fail", detail: `${file} @ ${where}` };
  },
};
