/**
 * TypeScript's facts for the plain source scan: which top-level names a
 * line declares, which names a file imports, and where a relative specifier
 * resolves (source.ts reads them through SOURCE_SYNTAX).
 */

import { statSync } from "node:fs";
import { posix, resolve } from "node:path";
import { isSourceFile, toRelative, type SourceSyntax } from "./source.ts";

const TS_DECLARATION = /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const TS_NAMED = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const TS_DEFAULT = /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/g;
const TS_NAMESPACE = /import\s+(?:type\s+)?\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s*["']([^"']+)["']/g;
const TS_SIDE = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;

/** A declaration is exported when its line says `export`; only a relative specifier names a project file. */
export const TYPESCRIPT_SOURCE: SourceSyntax = {
  declarationOf(line) {
    const m = TS_DECLARATION.exec(line);
    return m === null ? undefined : { name: m[2]!, exported: m[1] !== undefined };
  },
  resolveModule(root, from, specifier, vanished) {
    if (!specifier.startsWith(".")) return undefined;
    const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
    const candidates = [joined, ...[".ts", ".tsx", ".mts", ".cts"].map((ext) => joined.replace(/\.js$/, "") + ext), ...[".ts", ".tsx"].map((ext) => posix.join(joined, "index" + ext))];
    for (const candidate of candidates) {
      const rel = toRelative(root, resolve(root, candidate));
      if (rel === undefined) continue;
      if (vanished.has(rel) && isSourceFile(rel, "typescript")) return rel;
      try {
        if (statSync(resolve(root, rel)).isFile() && isSourceFile(rel, "typescript")) return rel;
      } catch {
        // Not there; try the next.
      }
    }
    return undefined;
  },
  importsOf(text, add) {
    for (const m of text.matchAll(TS_NAMED)) {
      for (const piece of m[1]!.split(",")) {
        const cleaned = piece.replace(/^\s*type\s+/, "").trim();
        if (cleaned === "") continue;
        const original = cleaned.split(/\s+as\s+/)[0]!.trim();
        add(original, m[2]!);
      }
    }
    for (const m of text.matchAll(TS_DEFAULT)) add("default", m[2]!);
    for (const m of text.matchAll(TS_NAMESPACE)) add(undefined, m[1]!);
    for (const m of text.matchAll(TS_SIDE)) add(undefined, m[1]!);
  },
};
