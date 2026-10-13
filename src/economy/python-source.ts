/**
 * Python's facts for the plain source scan: which top-level names a line
 * declares, which names a file imports, and where a dotted module resolves
 * (source.ts reads them through SOURCE_SYNTAX).
 */

import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";
import type { SourceSyntax } from "./source.ts";

const PY_DECLARATION = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)|^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/;
const PY_FROM = /^from\s+([\w.]+)\s+import\s+([^\n]+)$/gm;
const PY_IMPORT = /^import\s+([\w.]+)/gm;

/** A def, a class or a constant is declared; a leading underscore keeps it private; a module is a .py file or a package's __init__.py. */
export const PYTHON_SOURCE: SourceSyntax = {
  declarationOf(line) {
    const m = PY_DECLARATION.exec(line);
    if (m === null) return undefined;
    const name = (m[1] ?? m[2])!;
    return { name, exported: !name.startsWith("_") };
  },
  resolveModule(root, from, specifier, vanished) {
    const dots = /^(\.*)(.*)$/.exec(specifier)!;
    const up = dots[1]!.length;
    const parts = dots[2] === "" ? [] : dots[2]!.split(".");
    let base = posix.dirname(from);
    for (let i = 1; i < up; i++) base = posix.dirname(base);
    const candidates = up === 0 ? [posix.join(...parts) + ".py", posix.join(...parts, "__init__.py")] : [posix.join(base, ...parts) + ".py", posix.join(base, ...parts, "__init__.py")];
    return candidates.find((c) => vanished.has(c) || existsSync(resolve(root, c)));
  },
  importsOf(text, add) {
    for (const m of text.matchAll(PY_FROM)) {
      for (const piece of m[2]!.replace(/[()]/g, "").split(",")) {
        const name = piece.trim().split(/\s+as\s+/)[0]!.trim();
        if (name !== "" && name !== "*") add(name, m[1]!);
      }
    }
    for (const m of text.matchAll(PY_IMPORT)) add(undefined, m[1]!);
  },
};
