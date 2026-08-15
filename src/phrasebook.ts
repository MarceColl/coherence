// phrasebook.ts — the claim REGISTRY. One claim form = one module exporting one
// `ClaimForm` (src/claims/*, plus boundary.ts and parity.ts, whose forms live beside
// their grammars); this file assembles them in precedence order and owns everything that
// is a property of the SET rather than of any one form: parsing a line against the
// registry (`parseClaim`), the one evaluation path (`evaluateClaimLine`), record-lookup
// identity (`claimKey`), and the dictionary listing. A future plugin-provided claim form
// is exactly one more module in the CLAIM_FORMS array.
//
// Two payoffs of the grammar living here as DATA:
//   1. `coherence phrasebook` renders the form table straight from this array, so the
//      README's hand-kept table gains a generated authority (it can't silently drift).
//   2. The dictionary (`conforms to <Word>`) is just one more form — a macro that
//      expands a word file's commitment list back through this same registry.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Graph } from "./types.ts";
import { boundaryForm } from "./boundary.ts";
import { parityForm } from "./parity.ts";
import { typechecksForm } from "./claims/typechecks.ts";
import { existsForm } from "./claims/exists.ts";
import { importsForm } from "./claims/imports.ts";
import { respondsForm } from "./claims/responds.ts";
import { passesTestForm } from "./claims/passes-test.ts";
import { livesInForm } from "./claims/lives-in.ts";
import { conformsTo, dictionaryDir, parseWord } from "./claims/conforms-to.ts";
import type { ClaimCtx, ClaimForm, ClaimResult } from "./claims/shared.ts";

// The claim layer's public face: existing consumers import the contract and the shared
// executable arm from here, wherever the pieces live.
export { execNamedTest, runSerialNamedTest, proveSerialRunnerCanFail, reEscape } from "./claims/shared.ts";
export type { ClaimCtx, ClaimForm, ClaimResult, ParsedClaim } from "./claims/shared.ts";
export { dictionaryDir, parseWord } from "./claims/conforms-to.ts";
export type { Word } from "./claims/conforms-to.ts";

/** The registry, in precedence order — first match wins, and this order IS the historical
 *  precedence (identical to the pre-registry if-chain in evalClaim). */
export const CLAIM_FORMS: ClaimForm[] = [
  typechecksForm,
  existsForm,
  importsForm,
  respondsForm,
  passesTestForm,
  boundaryForm,
  livesInForm,
  parityForm,
  conformsTo(evaluateClaimLine),
];

/** First matching form wins. Null = no form reads the line (verify's dialect-gap skip;
 *  a word commitment's RED). */
export function parseClaim(line: string): { form: ClaimForm; claim: import("./claims/shared.ts").ParsedClaim } | null {
  for (const form of CLAIM_FORMS) { const claim = form.parse(line); if (claim) return { form, claim }; }
  return null;
}

/** THE ONE evaluation path — parse, anchor every claim.anchors (BEFORE evaluating, so an
 *  invariant stays anchored even while its claim is red, exactly the historical behavior),
 *  then evaluate. Used by verify's evalClaim AND the `conforms to` expansion loop; null =
 *  no form matched, and each caller owns what that means (skip vs RED). */
export function evaluateClaimLine(ctx: ClaimCtx, line: string): Promise<ClaimResult> | null {
  const r = parseClaim(line);
  if (!r) return null;
  for (const inv of r.claim.anchors) ctx.anchor(inv);
  return Promise.resolve(r.form.evaluate(ctx, r.claim));
}

/** The word a `conforms to <Word>` claim references, else null — the ONE cross-reference
 *  reading shared by the dictionary listing (`loadDictionary`) and the `--staged`/`--since`
 *  word-edit propagation scope (structural.ts). */
export const conformsWord = (line: string): string | null => {
  const r = parseClaim(line);
  return r && r.claim.form === "conforms to" ? r.claim.detail.word : null;
};

/** The BRAND that makes raw-string record lookup a compile error. Only `claimKey` can mint
 *  one, so a `Map<ClaimKey, …>` cannot be probed with `` `${node} ${claim}` `` — the exact
 *  bypass that let mergeClaimRecords/panel/verify forget a claim's failure history on pure
 *  crossing annotation while scene/promise remembered it. */
declare const CLAIM_KEY_BRAND: unique symbol;
export type ClaimKey = string & { readonly [CLAIM_KEY_BRAND]: true };

/** The ONE record-lookup key EVERY consumer of `status.verify.claims` uses (store AND
 *  read) — the promise graph, the panel, the merge, and verify's decoration filter. Keyed
 *  on each form's RECORD identity (ParsedClaim.record — the claim minus declarative-only
 *  clauses, e.g. a boundary's crossing), so a pre-annotation record matches a
 *  post-annotation claim and vice versa. Returns the branded `ClaimKey`: there is no
 *  other way to mint one. */
export const claimKey = (node: string, claim: string): ClaimKey =>
  `${node} ${parseClaim(claim)?.claim.record ?? claim}` as ClaimKey;

/** A dictionary word plus the components that `conforms to` it — for the overview render. */
export interface DictEntry { word: string; intent: string; conformers: string[] }

/** Scan the dictionary dir + cross-reference the graph's `conforms to` claims. Empty when
 *  the project has no dictionary dir (so the overview's Dictionary section is omitted). */
export async function loadDictionary(cfg: Config, graph: Graph): Promise<DictEntry[]> {
  const dir = join(cfg.root, dictionaryDir(cfg));
  let files: string[];
  try { files = (await readdir(dir)).filter((f) => f.endsWith(".md")); } catch { return []; }
  // Key conformers by the WORD TOKEN in the claim (= the file basename `conforms to` resolves
  // against), not the file's `# ` heading — those can differ; the token is what references it.
  const conformers = new Map<string, string[]>();
  for (const c of graph.nodes.filter((n) => n.kind === "component"))
    for (const cl of c.claims ?? []) { const w = conformsWord(cl); if (w) { const a = conformers.get(w) ?? []; a.push(c.label); conformers.set(w, a); } }
  const entries: DictEntry[] = [];
  for (const f of files.sort()) {
    const base = f.replace(/\.md$/, "");
    const w = parseWord(await readFile(join(dir, f), "utf8").catch(() => ""));
    entries.push({ word: base, intent: w?.intent ?? "", conformers: conformers.get(base) ?? [] });
  }
  return entries;
}
