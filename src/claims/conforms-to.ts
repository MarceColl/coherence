// claims/conforms-to.ts — `conforms to <Word>`: the dictionary macro, plus the word-file
// machinery it is defined by. A `<Word>.md` in the dictionary is a pattern — an intent
// plus a commitment list — grown from the project's own code; `conforms to <Word>` expands
// those commitments against the DECLARING component's context and aggregates.
//
// The form is a FACTORY (`conformsTo(evalLine)`): expansion re-enters the registry's one
// evaluation path, and taking it as a parameter keeps this module from importing the
// registry that imports it — the recursion is explicit instead of a module cycle.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../types.ts";
import { unescapeMd } from "../walk.ts";
import { claimOf, type ClaimCtx, type ClaimForm, type ClaimResult } from "./shared.ts";

// ── the dictionary word file ──────────────────────────────────────────────────────────
// `<coherence root>/<dictionary>/<Word>.md`: a `# <Word>` heading, first non-blank line =
// intent, a `## commitments` bullet list where each bullet is a claim line in the registry
// grammar (including `boundary …` and nested `conforms to <OtherWord>`). Parsed with
// walk.ts's regex-heading style + markdown-unescape so a prettified word file still parses.
export interface Word { name: string; intent: string; commitments: string[] }

/** Parse a dictionary word file, or null if it is not a well-formed word (a broken
 *  reference must go RED, not skip — a word is a contract). */
export function parseWord(text: string): Word | null {
  const lines = text.split("\n");
  let name = "", i = 0;
  for (; i < lines.length; i++) { const m = /^#\s+(.+?)\s*$/.exec(lines[i]); if (m) { name = m[1]; i++; break; } }
  if (!name) return null;
  let intent = "";
  for (; i < lines.length; i++) { const l = lines[i].trim(); if (!l) continue; if (l.startsWith("#")) break; intent = l; break; }
  const cs = lines.findIndex((l) => /^##\s+commitments\s*$/i.test(l));
  if (cs < 0) return null; // a word with no commitments section is not a contract
  const commitments: string[] = [];
  for (let j = cs + 1; j < lines.length; j++) {
    if (/^##\s+/.test(lines[j])) break;
    const c = /^-\s+(.+?)\s*$/.exec(lines[j]);
    if (c) commitments.push(unescapeMd(c[1]));
  }
  return { name, intent, commitments };
}

/** Where a word file resolves, relative to the coherence root. */
export const dictionaryDir = (cfg: Config) => cfg.dictionary ?? "dictionary";
const wordPath = (cfg: Config, word: string) => join(dictionaryDir(cfg), `${word}.md`);

// Defensive cap on `conforms to` nesting (cycle detection already handles loops; this
// bounds a pathological deep-but-acyclic chain).
const MAX_CONFORMS_DEPTH = 16;

/** The `conforms to <Word>` grammar — SINGLE HOME, private: every consumer reads the word
 *  through the registry's normalized reading (`conformsWord`), never the regex. */
const CONFORMS_RE = /^conforms to\s+([A-Za-z][A-Za-z0-9_-]*)$/;

/** Build the `conforms to` form around the registry's one evaluation path. A word is a
 *  CONTRACT, so — unlike a free-form spec claim — a commitment that matches no claim form
 *  goes RED rather than skipping, and a missing/unparseable word file goes RED (the verb
 *  was recognized; a broken reference is not a dialect gap). */
export const conformsTo = (evalLine: (ctx: ClaimCtx, line: string) => Promise<ClaimResult> | null): ClaimForm => ({
  name: "conforms to",
  grammar: "conforms to <Word>",
  example: "conforms to OwnedScope",
  tier: "hybrid",
  parse: (l) => {
    const m = CONFORMS_RE.exec(l);
    return m ? claimOf("conforms to", l, { detail: { word: m[1] } }) : null;
  },
  evaluate: async (ctx, { detail: { word } }) => {
    if (ctx.wordStack.includes(word))
      return { kind: "fail", detail: `conforms-to cycle: ${[...ctx.wordStack, word].join(" → ")}` };
    if (ctx.wordStack.length >= MAX_CONFORMS_DEPTH)
      return { kind: "fail", detail: `conforms-to nesting exceeds depth ${MAX_CONFORMS_DEPTH}: ${[...ctx.wordStack, word].join(" → ")}` };
    const rel = wordPath(ctx.cfg, word);
    let text: string;
    try { text = await readFile(join(ctx.root, rel), "utf8"); }
    catch { return { kind: "fail", detail: `word "${word}" not found at ${rel}` }; }
    const w = parseWord(text);
    if (!w) return { kind: "fail", detail: `word "${word}" at ${rel} is unparseable (needs a "# ${word}" heading and a "## commitments" list)` };
    // The file basename is what `conforms to` resolves against; its `# heading` must agree,
    // or the contract references a word that isn't the one on disk (a silent aliasing bug).
    if (w.name !== word) return { kind: "fail", detail: `word "${word}" at ${rel} is headed "# ${w.name}" — the heading must match the file basename "${word}"` };
    const child: ClaimCtx = { ...ctx, wordStack: [...ctx.wordStack, word] };
    let green = 0, skipped = 0;
    for (const commitment of w.commitments) {
      const pending = evalLine(child, commitment);
      if (!pending)
        return { kind: "fail", detail: `word "${word}": commitment "${commitment}" matches no claim form (a word is a contract — no silent skips)` };
      const r = await pending;
      if (r.kind === "fail") return { kind: "fail", detail: `word "${word}": commitment "${commitment}" failed${r.detail ? ` — ${r.detail}` : ""}` };
      if (r.kind === "skip") skipped++; else green++;
    }
    // A word verifies NOTHING it skipped: if any commitment was skipped (unrunnable in this
    // tier — `--fast`, or no test runner) the claim is a SKIP, not a green pass. It lands in
    // verify's skipped tally and skip list exactly like an inline skipped claim, so a word
    // can't launder to coherent having run none of its commitments. A FAIL still wins above.
    if (skipped) return { kind: "skip", detail: `${word}: ${green} green · ${skipped} skipped (not runnable in this tier)` };
    return { kind: "pass", detail: `${word}: ${green} commitment${green === 1 ? "" : "s"} green` };
  },
});
