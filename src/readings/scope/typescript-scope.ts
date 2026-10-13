/**
 * TypeScript's facts for the component interface reading: which declaration
 * lines are types or default exports, and what the word index and the kept
 * answers read of a file's imports (component-interfaces.ts reads them
 * through INTERFACE_SYNTAX, kept-answers.ts through KEPT_MODULES).
 */

import { resolveSpecifier } from "../../adapters/typescript.ts";
import type { InterfaceSyntax } from "./component-interfaces.ts";

/** A TypeScript import or export list: `import { a as b } from`, `export { a as b }`, `export type { … }`. */
const TS_LIST = /\b(?:import|export)\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}/g;
/** A TypeScript default export by name: `export default foo;`, `export = foo`, `export { foo as default }` is read as an alias to "default". */
const TS_DEFAULT_NAME = /^export\s+(?:default\s+|=\s*)([A-Za-z_$][\w$]*)\s*;?\s*$/gm;
const TS_WILDCARD = /^export\s+(?:type\s+)?\*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s+from\s*["']([^"']+)["']/gm;

/** Interfaces and type aliases are types; `export default` is the default export; the server reads its tsconfig's project, so it takes no bounds. */
export const TYPESCRIPT_INTERFACES: InterfaceSyntax = {
  isTypeDeclaration: (line) => /^(?:export\s+)?(?:declare\s+)?(?:interface|type)\s/.test(line.trim()),
  isDefaultExport: (line) => /^export\s+default\s/.test(line.trim()),
  serverBounds: false,
  importLists: (text) => [...text.matchAll(TS_LIST)].map((m) => m[1]!),
  defaultNames: (text) => [...text.matchAll(TS_DEFAULT_NAME)].map((m) => m[1]!),
  // No .js spelling: the word index looks a wildcard up by a declaration's file, which is always source (isSourceFile), never JavaScript.
  wildcardModules(file, text) {
    const modules: string[] = [];
    for (const [, specifier] of text.matchAll(TS_WILDCARD)) {
      const target = resolveSpecifier(file, specifier!);
      if (target === undefined) continue;
      const stripped = target.replace(/\.(ts|tsx|mts|cts)$/, "");
      modules.push(target, `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`, `${stripped}.cts`, `${stripped}/index.ts`);
    }
    return modules;
  },
};

/**
 * The module files a changed file wildcard re-exports, in every spelling a
 * kept answer can name them by. Unlike wildcardModules it adds the .js
 * spelling: a kept answer's module is its definition's file as the server
 * reports it, which can be JavaScript (KEPT_EXTENSIONS in kept-answers.ts).
 */
export function typescriptKeptModules(file: string, text: string): string[] {
  const modules: string[] = [];
  for (const [, specifier] of text.matchAll(TS_WILDCARD)) {
    const target = resolveSpecifier(file, specifier!);
    if (target === undefined) continue;
    const stripped = target.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
    modules.push(target, `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`, `${stripped}.cts`, `${stripped}.js`, `${stripped}/index.ts`);
  }
  return modules;
}
