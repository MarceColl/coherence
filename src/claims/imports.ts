// claims/imports.ts — `<file> imports <specifier>`: a declared wiring fact, checked
// against the file's actual import statements.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { claimOf, reEscape, type ClaimForm } from "./shared.ts";

export const importsForm: ClaimForm = {
  name: "imports",
  grammar: "<file> imports <specifier>",
  example: "main.ts imports ./registry",
  tier: "deterministic",
  parse: (l) => {
    const m = /^(\S+)\s+imports\s+(\S+)$/.exec(l);
    return m ? claimOf("imports", l, { files: [m[1]], detail: { file: m[1], specifier: m[2] } }) : null;
  },
  evaluate: async (ctx, { detail: { file, specifier } }) => {
    try {
      const src = await readFile(join(ctx.nodeDir, file), "utf8");
      const re = new RegExp(`from\\s+["']${reEscape(specifier)}["']`);
      return re.test(src) ? { kind: "pass", detail: "" } : { kind: "fail", detail: `no import of ${specifier}` };
    } catch { return { kind: "fail", detail: `cannot read ${file}` }; }
  },
};
