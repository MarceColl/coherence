/**
 * Go's entrance detection: none yet. CANDIDATE_RULES lists no Go rule and
 * NOT_DETECTED says so, so detection answers none for Go before any file or
 * manifest is read (entrance-candidates.ts reads this through
 * ENTRANCE_SYNTAX).
 */

import type { EntranceSyntax } from "./entrance-candidates.ts";

const NONE: ReadonlySet<string> = new Set();

/** Go is not read by this reading yet: no code file, rule, manifest or script is read, and `undetected` stops detection before package.json is. */
export const GO_ENTRANCES: EntranceSyntax = {
  undetected: true,
  isCode: () => false,
  definitionAt: (_lines, start) => start,
  continues: () => false,
  binds: () => false,
  decorates: false,
  candidates: () => [],
  manifestCandidates: () => [],
  script: () => undefined,
  importedAmong: () => NONE,
};
