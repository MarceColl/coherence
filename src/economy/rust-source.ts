/**
 * Rust's facts for the plain source scan: none yet. A .rs file is source,
 * but no declaration is scanned, no use tree is read and no module path
 * resolves, so Rust is never parsed as another language (source.ts reads
 * this through SOURCE_SYNTAX; mass and undeclared name Rust as not read).
 */

import type { SourceSyntax } from "./source.ts";

/** Rust is not read by this reading yet (notScannedYet): no line declares a name, no specifier resolves, no import is handed on. */
export const RUST_SOURCE: SourceSyntax = {
  declarationOf: () => undefined,
  resolveModule: () => undefined,
  importsOf: () => {},
};
