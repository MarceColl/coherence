/**
 * TypeScript's facts for the interface map: what a declaration line's
 * keyword says can execute (interfaces.ts reads them through DECLARES).
 */

import type { InterfaceSymbol } from "./interfaces.ts";

/** An interface or type alias is a type, an enum or namespace a value; a binding is read by what it is bound to. */
export function typescriptDeclares(line: string): InterfaceSymbol["declares"] {
  const m = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|const|let|var|class|interface|type|enum|namespace)\s/.exec(line);
  const keyword = m?.[1];
  if (keyword === "interface" || keyword === "type") return "type";
  if (keyword === "enum" || keyword === "namespace") return "value";
  if (keyword === "const" || keyword === "let" || keyword === "var") {
    const value = /=\s*(.*)$/.exec(line)?.[1]?.trim() ?? "";
    if (/^(async\s+)?(function\b|class\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(value)) return "body";
    if (/^([{["'`\d-]|new\s|true\b|false\b|null\b|undefined\b|Symbol\()/.test(value) || value === "") return "value";
    // Anything else (a call's result, an identifier) may hold a function: counted as able to execute, so never read as bodiless.
    return "unknown";
  }
  return "body";
}
