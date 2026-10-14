/**
 * Go's facts for the plain source scan: none yet. A .go file is source, but
 * no declaration is scanned, no import is read and no import path resolves,
 * so Go is never parsed as another language (source.ts reads this through
 * SOURCE_SYNTAX; mass and undeclared name Go as not read).
 */

import type { SourceSyntax } from "./source.ts";

/** Go is not read by this reading yet (notScannedYet): no line declares a name, no specifier resolves, no import is handed on. */
export const GO_SOURCE: SourceSyntax = {
  declarationOf: () => undefined,
  resolveModule: () => undefined,
  importsOf: () => {},
};
