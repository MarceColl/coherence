/**
 * Go's facts for the interface map: none yet (interfaces.ts reads them
 * through DECLARES).
 */

import type { InterfaceSymbol } from "./interfaces.ts";

/** Go is not read by this reading yet: every declaration is counted as able to execute, so never read as bodiless. */
export function goDeclares(): InterfaceSymbol["declares"] {
  return "unknown";
}
