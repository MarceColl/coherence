// phrasebook.ts — built-in claim forms plus the graph-local runtime registry.
//
// Two payoffs of moving the grammar out of the engine and into a registry:
//   1. `coherence phrasebook` renders the project runtime's composed form table, so
//      configured plugin syntax is visible beside the built-ins.
//   2. The dictionary (`conforms to <Word>`) is just one more form — a macro that
//      expands a word file's commitment list back through that same runtime registry.
//
// The boundary form imports BOUNDARY_RE from boundary.ts (its single home); it is NOT
// duplicated here.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Config, Graph } from "./types.ts";
import { assertJsonValue, deepFreeze } from "./json.ts";
import type {
  ClaimContext,
  ClaimForm,
  ClaimMatch,
  ClaimResult,
  ProjectCheck,
} from "./plugin.ts";
import { BOUNDARY_RE } from "./boundary.ts";
import { PARITY_RE } from "./parity.ts";
import { analyzeOracle, analyzeParityOracle } from "./oracle-domain.ts";
import { unescapeMd } from "./walk.ts";

const fileExists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };

/**
 * Everything a claim form needs to evaluate, threaded from runVerify. `nodeDir`/`node`
 * are the DECLARING component's disk dir + label; `anchor` records a boundary-anchored
 * invariant for that component (so the coverage gate sees it — even when the boundary is
 * reached through a `conforms to` word). `typecheck` is memoized upstream (one run/verify).
 * `wordStack` is the `conforms to` expansion stack for cycle/depth safety.
 */
export interface ClaimCtx extends ClaimContext {
  cfg: Config;
  graph: ClaimContext["graph"];
  root: string;
  nodeDir: string;
  node: string;
  fast: boolean;
  typecheck: () => { pass: boolean; detail: string };
  anchor: (inv: string) => void;
  wordStack: string[];
  forms: readonly ClaimForm[];
}

export type { ClaimForm, ClaimMatch, ClaimResult } from "./plugin.ts";

export interface ResolvedClaim {
  readonly line: string;
  readonly form: ClaimForm;
  readonly match: ClaimMatch;
}

export interface RuntimeProjectCheck {
  readonly plugin: string;
  readonly check: ProjectCheck;
}

type Resolution =
  | { kind: "none" }
  | { kind: "ambiguous"; forms: string[] }
  | { kind: "match"; claim: ResolvedClaim };

const graphForms = new WeakMap<Graph, readonly ClaimForm[]>();
const graphClaims = new WeakMap<Graph, ReadonlyMap<string, readonly (ResolvedClaim | null)[]>>();
const graphChecks = new WeakMap<Graph, readonly RuntimeProjectCheck[]>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validateMatch(value: unknown, form: ClaimForm, line: string): asserts value is ClaimMatch {
  const subject = `Claim form "${form.name}" parse result for "${line}"`;
  if (!isRecord(value)) throw new Error(`${subject} must be an object or null`);
  const allowed = new Set(["family", "key", "anchors", "target", "oracle", "data"]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${subject} has unsupported field "${key}"`);
  if (typeof value.family !== "string" || !value.family)
    throw new Error(`${subject}.family must be a non-empty string`);
  if (typeof value.key !== "string" || !value.key)
    throw new Error(`${subject}.key must be a non-empty string`);
  if (value.anchors !== undefined
      && (!Array.isArray(value.anchors)
        || !value.anchors.every((anchor) => typeof anchor === "string" && anchor)))
    throw new Error(`${subject}.anchors must be an array of non-empty strings`);
  if (value.target !== undefined && (typeof value.target !== "string" || !value.target))
    throw new Error(`${subject}.target must be a non-empty string`);
  if (value.oracle !== undefined) {
    if (!isRecord(value.oracle) || typeof value.oracle.kind !== "string" || !value.oracle.kind)
      throw new Error(`${subject}.oracle.kind must be a non-empty string`);
    for (const key of Object.keys(value.oracle))
      if (key !== "kind" && key !== "name")
        throw new Error(`${subject}.oracle has unsupported field "${key}"`);
    if (value.oracle.name !== undefined
        && (typeof value.oracle.name !== "string" || !value.oracle.name))
      throw new Error(`${subject}.oracle.name must be a non-empty string`);
  }
  if (Object.hasOwn(value, "data")) assertJsonValue(value.data, `${subject}.data`);
}

/** Resolve a line against every form. Zero matches is a dialect gap; many is fatal. */
export function resolveClaim(forms: readonly ClaimForm[], line: string): Resolution {
  const matches: ResolvedClaim[] = [];
  for (const form of forms) {
    let match: unknown;
    try {
      match = form.parse(line);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Claim form "${form.name}" parse failed for "${line}": ${detail}`, { cause });
    }
    if (match === null) continue;
    validateMatch(match, form, line);
    matches.push({ line, form, match: deepFreeze(structuredClone(match)) });
  }
  if (!matches.length) return { kind: "none" };
  if (matches.length > 1)
    return { kind: "ambiguous", forms: matches.map(({ form }) => form.name) };
  return { kind: "match", claim: matches[0] };
}

/** Attach non-serializable runtime claim/check state to a completed graph. */
export function bindClaimRuntime(
  graph: Graph,
  forms: readonly ClaimForm[],
  checks: readonly RuntimeProjectCheck[] = [],
): Graph {
  const parsed = new Map<string, readonly (ResolvedClaim | null)[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "component") continue;
    const claims: Array<ResolvedClaim | null> = [];
    for (const line of node.claims ?? []) {
      const resolution = resolveClaim(forms, line);
      if (resolution.kind === "ambiguous")
        throw new Error(`Claim "${line}" matches multiple forms: ${resolution.forms.join(", ")}`);
      claims.push(resolution.kind === "match" ? resolution.claim : null);
    }
    parsed.set(node.id, Object.freeze(claims));
  }
  graphForms.set(graph, forms);
  graphClaims.set(graph, parsed);
  graphChecks.set(graph, checks);
  return graph;
}

export const claimFormsFor = (graph: Graph): readonly ClaimForm[] =>
  graphForms.get(graph) ?? CLAIM_FORMS;

export const projectChecksFor = (graph: Graph): readonly RuntimeProjectCheck[] =>
  graphChecks.get(graph) ?? [];

export function claimResolutionsFor(
  graph: Graph,
  node: { id: string; claims?: string[] },
): readonly (ResolvedClaim | null)[] {
  const bound = graphClaims.get(graph)?.get(node.id);
  if (bound) return bound;
  return (node.claims ?? []).map((line) => {
    const resolution = resolveClaim(claimFormsFor(graph), line);
    if (resolution.kind === "ambiguous")
      throw new Error(`Claim "${line}" matches multiple forms: ${resolution.forms.join(", ")}`);
    return resolution.kind === "match" ? resolution.claim : null;
  });
}

export function resolvedClaimsFor(
  graph: Graph,
  node: { id: string; claims?: string[] },
): readonly ResolvedClaim[] {
  return claimResolutionsFor(graph, node)
    .filter((claim): claim is ResolvedClaim => claim !== null);
}

export async function evaluateResolvedClaim(
  ctx: ClaimCtx,
  claim: ResolvedClaim,
): Promise<ClaimResult> {
  for (const anchor of claim.match.anchors ?? []) ctx.anchor(anchor);
  const result: unknown = await claim.form.evaluate(ctx, claim.match);
  const subject = `Claim form "${claim.form.name}" evaluation result`;
  if (!isRecord(result) || !["pass", "fail", "skip"].includes(String(result.kind)))
    throw new Error(`${subject}.kind must be pass, fail, or skip`);
  if (result.detail !== undefined && typeof result.detail !== "string")
    throw new Error(`${subject}.detail must be a string`);
  if (result.diagnosticIds !== undefined
      && (!Array.isArray(result.diagnosticIds)
        || !result.diagnosticIds.every((id) => typeof id === "string" && /^[^:]+:.+/.test(id))))
    throw new Error(`${subject}.diagnosticIds must contain namespaced strings`);
  return Object.freeze({
    kind: result.kind,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    ...(result.diagnosticIds === undefined
      ? {}
      : { diagnosticIds: Object.freeze([...(result.diagnosticIds as string[])]) }),
  }) as ClaimResult;
}

// ── the dictionary word file ──────────────────────────────────────────────────────────
// `<coherence root>/<dictionary>/<Word>.md`: a `# <Word>` heading, first non-blank line =
// intent, a `## commitments` bullet list where each bullet is a claim line in THIS grammar
// (including `boundary …` and nested `conforms to <OtherWord>`). Parsed with walk.ts's
// regex-heading style + markdown-unescape so a prettified word file still parses.
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
type DictionaryConfig = { readonly dictionary?: string };
type TestConfig = Pick<ClaimContext["cfg"], "test" | "testMatch">;

export const dictionaryDir = (cfg: DictionaryConfig) => cfg.dictionary ?? "dictionary";
const wordPath = (cfg: DictionaryConfig, word: string) => join(dictionaryDir(cfg), `${word}.md`);

// Defensive cap on `conforms to` nesting (cycle detection already handles loops; this
// bounds a pathological deep-but-acyclic chain).
const MAX_CONFORMS_DEPTH = 16;

/** A dictionary word plus the components that `conforms to` it — for the overview render. */
export interface DictEntry { word: string; intent: string; conformers: string[] }

/** The `conforms to <Word>` grammar — SINGLE HOME. Consumed by the claim form's `parse`,
 *  the dictionary cross-reference in `loadDictionary`, and the `--staged`/`--since` word-edit
 *  propagation scope in structural.ts. Capture group 1 is the word token. */
export const CONFORMS_RE = /^conforms to\s+([A-Za-z][A-Za-z0-9_-]*)$/;

/** Regex-escape a string so it matches literally when interpolated into a RegExp or passed
 *  to a test runner whose `-t <name>` treats the arg as a regex (vitest, jest). */
export const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Run the configured test runner scoped to ONE named test — the shared executable arm
 *  of `passes test`, `boundary … via test`, and `parity … via test`. The name is
 *  regex-escaped for the runner's `-t`; exit 0 alone is not trusted (`testMatch`
 *  requires positive evidence the named test actually ran — an exit-0 runner that
 *  matched zero tests would otherwise pass a renamed/deleted oracle). Returns
 *  `{ ok: true }` on a real pass, else the failure detail. */
function execNamedTest(cfg: TestConfig, root: string, name: string): { ok: boolean; detail: string } {
  const r = spawnSync(cfg.test[0], [...cfg.test.slice(1), reEscape(name)], { cwd: root, encoding: "utf8", timeout: 120000 });
  const out = (r.stderr || "") + (r.stdout || "");
  if (r.status !== 0) return { ok: false, detail: out.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 200) };
  if (cfg.testMatch && !new RegExp(cfg.testMatch).test(out)) return { ok: false, detail: `test "${name}" matched no run (testMatch)` };
  return { ok: true, detail: "" };
}

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
    for (const cl of c.claims ?? []) { const m = CONFORMS_RE.exec(cl); if (m) { const a = conformers.get(m[1]) ?? []; a.push(c.label); conformers.set(m[1], a); } }
  const entries: DictEntry[] = [];
  for (const f of files.sort()) {
    const base = f.replace(/\.md$/, "");
    const w = parseWord(await readFile(join(dir, f), "utf8").catch(() => ""));
    entries.push({ word: base, intent: w?.intent ?? "", conformers: conformers.get(base) ?? [] });
  }
  return entries;
}

const dataOf = <Value>(match: ClaimMatch): Value => match.data as Value;

export const CLAIM_FORMS: ClaimForm[] = [
  {
    name: "typechecks",
    grammar: "typechecks",
    example: "typechecks",
    tier: "deterministic",
    parse: (line) => line === "typechecks"
      ? { family: "typechecks", key: "typechecks" }
      : null,
    evaluate: (ctx) => { const t = ctx.typecheck(); return { kind: t.pass ? "pass" : "fail", detail: t.detail }; },
  },
  {
    name: "exists",
    grammar: "<file> exists at (root | this node | every node)",
    example: "wrangler.jsonc exists at root",
    tier: "deterministic",
    parse: (line) => {
      const match = /^(\S+)\s+exists at\s+(root|this node|every node)$/.exec(line);
      return match
        ? { family: "exists", key: line, data: { file: match[1], location: match[2] } }
        : null;
    },
    evaluate: async (ctx, match) => {
      const { file, location } = dataOf<{ file: string; location: string }>(match);
      const base = location === "root" ? ctx.root : ctx.nodeDir;
      return { kind: (await fileExists(join(base, file))) ? "pass" : "fail", detail: `${file} @ ${location}` };
    },
  },
  {
    name: "imports",
    grammar: "<file> imports <specifier>",
    example: "main.ts imports ./registry",
    tier: "deterministic",
    parse: (line) => {
      const match = /^(\S+)\s+imports\s+(\S+)$/.exec(line);
      return match
        ? { family: "imports", key: line, data: { file: match[1], specifier: match[2] } }
        : null;
    },
    evaluate: async (ctx, match) => {
      const { file, specifier } = dataOf<{ file: string; specifier: string }>(match);
      try {
        const src = await readFile(join(ctx.nodeDir, file), "utf8");
        const re = new RegExp(`from\\s+["']${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
        return re.test(src) ? { kind: "pass", detail: "" } : { kind: "fail", detail: `no import of ${specifier}` };
      } catch { return { kind: "fail", detail: `cannot read ${file}` }; }
    },
  },
  {
    name: "responds",
    grammar: '<url> responds <status> [with "<text>"]',
    example: 'http://localhost:8787/health responds 200 with "ok"',
    tier: "live",
    parse: (line) => {
      const match = /^(\S+)\s+responds\s+(\d+)(?:\s+with\s+"(.*)")?$/.exec(line);
      return match
        ? {
            family: "responds",
            key: line,
            data: {
              url: match[1],
              status: Number(match[2]),
              ...(match[3] === undefined ? {} : { text: match[3] }),
            },
          }
        : null;
    },
    evaluate: async (ctx, match) => {
      const { url, status, text } = dataOf<{ url: string; status: number; text?: string }>(match);
      if (ctx.fast) return { kind: "skip", detail: "live tier (--fast)" };
      try {
        const res = await fetch(url);
        if (res.status !== status) return { kind: "fail", detail: `got ${res.status}` };
        if (text) { const body = await res.text(); if (!body.includes(text)) return { kind: "fail", detail: `body missing "${text}"` }; }
        return { kind: "pass" };
      } catch { return { kind: "skip", detail: "unreachable" }; }
    },
  },
  {
    name: "passes test",
    grammar: 'passes test "<name>"',
    example: 'passes test "write policy totality"',
    tier: "executable",
    parse: (line) => {
      const match = /^passes test\s+"(.+)"$/.exec(line);
      return match
        ? { family: "passes-test", key: match[1], oracle: { kind: "test", name: match[1] } }
        : null;
    },
    evaluate: (ctx, match) => {
      const name = match.oracle!.name!;
      if (ctx.fast) return { kind: "skip", detail: "executable tier (--fast)" };
      if (!ctx.cfg.test || !ctx.cfg.test.length) return { kind: "skip", detail: "no test runner configured (config.test)" };
      const r = execNamedTest(ctx.cfg, ctx.root, name);
      return r.ok ? { kind: "pass" } : { kind: "fail", detail: r.detail };
    },
  },
  {
    name: "boundary",
    grammar: 'boundary "<invariant>" at <chokepoint> [via (test|guard) "<oracle>"]',
    example: 'boundary "fail-closed writes" at applyWritePolicy via test "write policy totality"',
    tier: "hybrid",
    parse: (line) => {
      const match = BOUNDARY_RE.exec(line);
      if (!match) return null;
      return {
        family: "boundary",
        key: match[1],
        anchors: [match[1]],
        target: match[2],
        ...(match[3] ? { oracle: { kind: match[3], name: match[4] } } : {}),
      };
    },
    // The anti-entropy ratchet. Asserts the four-part anatomy of a self-enforcing boundary:
    // the invariant is named (and ANCHORED for the coverage gate), the chokepoint SYMBOL
    // exists, and (if given) the oracle passes. `via test` additionally runs the META-ORACLE
    // (live-domain analysis, even under --fast); `via guard` is exempt (source-property oracle).
    evaluate: async (ctx, match) => {
      const inv = match.key, sym = match.target!;
      const verb = match.oracle?.kind, test = match.oracle?.name;
      if (!ctx.graph.nodes.some((n) => n.kind === "symbol" && n.label === sym)) return { kind: "fail", detail: `chokepoint symbol "${sym}" not found in the code graph` };
      if (!test) return { kind: "pass", detail: `${inv} @ ${sym} (no oracle)` };
      if (verb === "test" && ctx.cfg.oracleDomain !== false) {
        const a = await analyzeOracle(ctx.cfg, test);
        if (a.verdict === "literal")
          return { kind: "fail", detail: `[oracle] "${test}" iterates a LITERAL domain (${a.detail}) — a sampling oracle, not totality. Derive its domain from the live SSOT behind \`${sym}\` (or, if it is a source-property guard, declare it \`via guard\` not \`via test\`).` };
        if (a.verdict === "no-iteration")
          return { kind: "fail", detail: `[oracle] "${test}" performs NO domain iteration (${a.detail}) — a source-grep / hand-enumerated cases, not totality. Loop the live domain behind \`${sym}\`, or — if it is a genuine source-property guard — declare it \`via guard "${test}"\` instead of \`via test\`.` };
        if (a.verdict === "not-found")
          return { kind: "fail", detail: `[oracle] "${test}" — no describe() with this EXACT title found, so the meta-oracle cannot analyze its domain (the runner alone would still pass on an it()-name match, silently skipping analysis). Anchor the claim to the oracle's exact describe title, or declare it \`passes test\`/\`via guard\` if it is not a domain totality.` };
      }
      if (ctx.fast) return { kind: "skip", detail: "boundary oracle (--fast)" };
      if (!ctx.cfg.test || !ctx.cfg.test.length) return { kind: "skip", detail: "no test runner configured (config.test)" };
      const r = execNamedTest(ctx.cfg, ctx.root, test);
      if (!r.ok) return { kind: "fail", detail: r.detail };
      return { kind: "pass", detail: `${inv} @ ${sym}${verb === "guard" ? " (source-property guard)" : ""}` };
    },
  },
  {
    name: "parity",
    grammar: 'parity "<invariant>" over <domain> between <fnA> and <fnB> via test "<oracle>"',
    example: 'parity "disclosure faithfulness" over TOOL_NAMES between toolActivity and messageProvenance via test "live equals settled"',
    tier: "hybrid",
    // The AGREEMENT ratchet — the boundary totality pattern generalized from coverage to
    // parity. Two functions are declared PROJECTIONS OF ONE ENUMERATED DOMAIN and must
    // agree over it: the invariant is named (and anchored, so a parity claim satisfies
    // the invariant-coverage gate exactly like a boundary), the domain and BOTH
    // projection symbols must exist in the code graph, and the oracle passes. The parity
    // META-ORACLE runs even under --fast (source analysis, like the boundary's): the
    // named describe must ENUMERATE the declared domain and DRIVE both projections —
    // a one-sided or sample-list oracle fails the claim rather than wearing the label.
    parse: (line) => {
      const match = PARITY_RE.exec(line);
      return match
        ? {
            family: "parity",
            key: match[1],
            anchors: [match[1]],
            oracle: { kind: "test", name: match[5] },
            data: { domain: match[2], f: match[3], g: match[4] },
          }
        : null;
    },
    evaluate: async (ctx, match) => {
      const inv = match.key;
      const { domain, f, g } = dataOf<{ domain: string; f: string; g: string }>(match);
      const oracle = match.oracle!.name!;
      for (const s of [domain, f, g])
        if (!ctx.graph.nodes.some((n) => n.kind === "symbol" && n.label === s))
          return { kind: "fail", detail: `symbol "${s}" not found in the code graph` };
      if (ctx.cfg.oracleDomain !== false) {
        const a = await analyzeParityOracle(ctx.cfg, oracle, domain, f, g);
        if (a.verdict === "not-found")
          return { kind: "fail", detail: `[parity] "${oracle}" — no describe() with this EXACT title found, so the parity meta-oracle cannot analyze it. Anchor the claim to the oracle's exact describe title.` };
        if (a.verdict !== "ok")
          return { kind: "fail", detail: `[parity] "${oracle}" ${a.detail} (${a.file}). Loop the declared domain and assert \`${f}\` ≡ \`${g}\` per member.` };
      }
      if (ctx.fast) return { kind: "skip", detail: "parity oracle (--fast)" };
      if (!ctx.cfg.test || !ctx.cfg.test.length) return { kind: "skip", detail: "no test runner configured (config.test)" };
      const r = execNamedTest(ctx.cfg, ctx.root, oracle);
      if (!r.ok) return { kind: "fail", detail: r.detail };
      return { kind: "pass", detail: `${inv}: ${f} ≡ ${g} over ${domain}` };
    },
  },
  {
    name: "conforms to",
    grammar: "conforms to <Word>",
    example: "conforms to OwnedScope",
    tier: "hybrid",
    // The dictionary macro. A `<Word>.md` in the dictionary is a pattern — an intent plus a
    // commitment list — grown from the project's own code. `conforms to <Word>` expands those
    // commitments against the DECLARING component's context (same node dir, same anchoring:
    // a `boundary` commitment anchors its invariant on THIS component, exactly as if inline)
    // and aggregates. A word is a CONTRACT, so — unlike a free-form spec claim — a commitment
    // that matches no claim form goes RED rather than skipping, and a missing/unparseable word
    // file goes RED (the verb was recognized; a broken reference is not a dialect gap).
    parse: (line) => {
      const match = CONFORMS_RE.exec(line);
      return match
        ? { family: "conforms", key: match[1], data: { word: match[1] } }
        : null;
    },
    evaluate: async (ctx, match) => {
      const internal = ctx as ClaimCtx;
      const { word } = dataOf<{ word: string }>(match);
      if (internal.wordStack.includes(word))
        return { kind: "fail", detail: `conforms-to cycle: ${[...internal.wordStack, word].join(" → ")}` };
      if (internal.wordStack.length >= MAX_CONFORMS_DEPTH)
        return { kind: "fail", detail: `conforms-to nesting exceeds depth ${MAX_CONFORMS_DEPTH}: ${[...internal.wordStack, word].join(" → ")}` };
      const rel = wordPath(ctx.cfg, word);
      let text: string;
      try { text = await readFile(join(ctx.root, rel), "utf8"); }
      catch { return { kind: "fail", detail: `word "${word}" not found at ${rel}` }; }
      const w = parseWord(text);
      if (!w) return { kind: "fail", detail: `word "${word}" at ${rel} is unparseable (needs a "# ${word}" heading and a "## commitments" list)` };
      // The file basename is what `conforms to` resolves against; its `# heading` must agree,
      // or the contract references a word that isn't the one on disk (a silent aliasing bug).
      if (w.name !== word) return { kind: "fail", detail: `word "${word}" at ${rel} is headed "# ${w.name}" — the heading must match the file basename "${word}"` };
      const child: ClaimCtx = { ...internal, wordStack: [...internal.wordStack, word] };
      let green = 0, skipped = 0;
      for (const commitment of w.commitments) {
        const resolution = resolveClaim(internal.forms, commitment);
        if (resolution.kind === "none")
          return { kind: "fail", detail: `word "${word}": commitment "${commitment}" matches no claim form (a word is a contract — no silent skips)` };
        if (resolution.kind === "ambiguous")
          return { kind: "fail", detail: `word "${word}": commitment "${commitment}" matches multiple claim forms: ${resolution.forms.join(", ")}` };
        const r = await evaluateResolvedClaim(child, resolution.claim);
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
  },
];
