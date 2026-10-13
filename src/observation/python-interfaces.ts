/**
 * Python's facts for the interface map: what a declaration line's keyword
 * says can execute (interfaces.ts reads them through DECLARES).
 */

import type { InterfaceSymbol } from "./interfaces.ts";

/** A def or a class has a body; any other top-level declaration is a value. */
export function pythonDeclares(line: string): InterfaceSymbol["declares"] {
  return /^\s*(?:async\s+)?(?:def|class)\s/.test(line) ? "body" : "value";
}
