// structural.ts — the temporal affordance. A coherence graph is a *snapshot*
// ledger; this adds the transaction view: what one ref → another did to the
// STRUCTURE an agent cares about — components, the invariants they uphold, the
// claims that anchor them, and generic facts contributed by repository plugins.
//
// The point is the question "did my change alter the structural contract?" — answerable
// without re-reading the world, and a review gate: a dropped boundary or a
// silently-rewired chokepoint is the diff a prose review misses. `--strict` turns
// a core loss or a plugin-policy loss into a nonzero exit.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { boundaryFromMatch, type Boundary } from "./boundary.ts";
import { parityFromMatch, type Parity } from "./parity.ts";
import { buildGraph } from "./derive.ts";
import { loadProject } from "./plugins.ts";
import { ownerOf } from "./walk.ts";
import { CONFORMS_RE, dictionaryDir, parseWord, resolvedClaimsFor } from "./phrasebook.ts";
import { noveltyVerdict, renderNovelty, scanSurface, surfaceSignals } from "./novelty.ts";
import type { Config, Graph, GraphNode, StructuralFact } from "./types.ts";

/** Files changed vs `since` (a ref), or — when null — the working tree vs HEAD
 *  PLUS untracked files. Paths are relative to cfg.root (`--relative`). This is the
 *  domain `verify --staged` / `--since` scopes to. */
export function changedFiles(cfg: Config, since: string | null): Set<string> {
  const lines = (args: string[]) =>
    (git(args, cfg.root).stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (since) return new Set(lines(["diff", "--name-only", "--relative", since]));
  return new Set([
    ...lines(["diff", "--name-only", "--relative", "HEAD"]),
    ...lines(["ls-files", "--others", "--exclude-standard"]),
  ]);
}

/** The word a changed path names, if it is a `<dictionary>/<Word>.md` file (else null).
 *  Word files are flat basenames directly under the dictionary dir. */
function wordOfPath(f: string, dictDir: string): string | null {
  const norm = f.replace(/\\/g, "/");
  const prefix = dictDir.replace(/\/+$/, "") + "/";
  if (!norm.startsWith(prefix)) return null;
  const m = /^([A-Za-z][A-Za-z0-9_-]*)\.md$/.exec(norm.slice(prefix.length));
  return m ? m[1] : null;
}

/** Given a set of directly-changed words, the transitive closure of words affected by the
 *  edit: a word whose commitments `conforms to` an affected word is itself affected (a nested
 *  reference means an edit to the inner word propagates through the outer word to its
 *  conformers). Reads the CURRENT dictionary — the same tree the graph and verify see. */
async function affectedWords(cfg: Config, changed: Set<string>): Promise<Set<string>> {
  const dir = join(cfg.root, dictionaryDir(cfg));
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith(".md")); } catch { /* no dictionary */ }
  const refs = new Map<string, Set<string>>(); // word → words it conforms-to (its commitments)
  for (const f of files) {
    const base = f.replace(/\.md$/, "");
    const w = parseWord(await readFile(join(dir, f), "utf8").catch(() => ""));
    const set = new Set<string>();
    for (const c of w?.commitments ?? []) { const m = CONFORMS_RE.exec(c); if (m) set.add(m[1]); }
    refs.set(base, set);
  }
  const out = new Set(changed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [word, set] of refs) {
      if (out.has(word)) continue;
      for (const r of set) if (out.has(r)) { out.add(word); grew = true; break; }
    }
  }
  return out;
}

/** Map changed files to the component dirs that own them (the deepest spec'd
 *  ancestor — same ownership rule the graph uses). A changed dictionary word file does NOT
 *  map to its owning dir (the root, spuriously) — it maps to every component that `conforms
 *  to` that word (transitively through nested word references), so a word edit re-verifies
 *  the CONFORMERS it actually propagates to, not the dictionary's accidental container. */
export async function affectedComponents(cfg: Config, graph: Graph, files: Set<string>): Promise<Set<string>> {
  const dirs = graph.nodes.filter((n) => n.kind === "component").map((n) => n.id.slice(2));
  const dictDir = dictionaryDir(cfg);
  const hit = new Set<string>();
  const changedWords = new Set<string>();
  for (const f of files) {
    const w = wordOfPath(f, dictDir);
    if (w) changedWords.add(w);
    else hit.add(ownerOf(f, dirs));
  }
  if (changedWords.size) {
    const words = await affectedWords(cfg, changedWords);
    for (const n of graph.nodes)
      if (n.kind === "component")
        for (const cl of n.claims ?? []) {
          const m = CONFORMS_RE.exec(cl);
          if (m && words.has(m[1])) { hit.add(n.id.slice(2)); break; }
        }
  }
  return hit;
}

// Git env vars a caller (lint-staged, a rebase, another hook) may have set that
// would hijack our subcommands — most damagingly `git worktree add`, which
// resolves a relative GIT_INDEX_FILE inside the new detached worktree and dies
// with ".git/index: Not a directory". Scrub them so worktree/log ops always
// target the real repo regardless of the invoking context.
const GIT_ENV_SCRUB = [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
] as const;

const scrubbedGitEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of GIT_ENV_SCRUB) delete env[k];
  return env;
};

const git = (args: string[], cwd: string) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: scrubbedGitEnv() });

export type { Boundary } from "./boundary.ts";
interface Ledger {
  label: string;
  invariants: Set<string>;
  boundaries: Map<string, Boundary>; // keyed by invariant name
  parities: Map<string, Parity>;     // parity claims, keyed by invariant name (first-class anchors)
  claims: Map<string, string>;       // semantic identity → canonical meaning
}

function ledgerOf(graph: Graph, node: GraphNode): Ledger {
  const boundaries = new Map<string, Boundary>();
  const parities = new Map<string, Parity>();
  const claims = new Map<string, string>();
  const resolved = new Map(resolvedClaimsFor(graph, node).map((claim) => [claim.line, claim]));
  for (const c of node.claims ?? []) {
    const parsed = resolved.get(c);
    const b = parsed ? boundaryFromMatch(parsed.match) : null;
    const p = parsed && !b ? parityFromMatch(parsed.match) : null;
    if (b) boundaries.set(b.inv, b);
    else if (p) parities.set(p.inv, p);
    else if (parsed) {
      const identity = `${parsed.match.family}\u0000${parsed.match.key}`;
      claims.set(identity, canonicalJson({
        target: parsed.match.target ?? null,
        oracle: parsed.match.oracle ?? null,
        data: parsed.match.data ?? null,
        anchors: parsed.match.anchors ?? [],
      }));
    } else claims.set(`raw\u0000${c}`, c);
  }
  return {
    label: node.label,
    invariants: new Set(node.invariants ?? []),
    boundaries,
    parities,
    claims,
  };
}

function ledgersOf(graph: Graph): Map<string, Ledger> {
  const out = new Map<string, Ledger>();
  for (const n of graph.nodes) if (n.kind === "component") out.set(n.label, ledgerOf(graph, n));
  return out;
}

/** Every normalized boundary claim, preserving component and declaration order. */
export function boundaryClaims(graph: Graph): Array<Boundary & { component: string }> {
  const out: Array<Boundary & { component: string }> = [];
  for (const node of graph.nodes) {
    if (node.kind !== "component") continue;
    for (const claim of resolvedClaimsFor(graph, node)) {
      const boundary = boundaryFromMatch(claim.match);
      if (boundary) out.push({ ...boundary, component: node.label });
    }
  }
  return out;
}

/** Every boundary claim in the graph, keyed by its CHOKEPOINT symbol — the shared
 *  input the atlas (tier derivation) and conventions (anchored set) subcommands both
 *  consume, parsed ONCE from the graph the harness already built (no spec re-walk). */
export function allBoundaries(graph: Graph): Map<string, Boundary & { component: string }> {
  const out = new Map<string, Boundary & { component: string }>();
  for (const boundary of boundaryClaims(graph))
    if (!out.has(boundary.chokepoint)) out.set(boundary.chokepoint, boundary);
  return out;
}

/** EVERY boundary claim whose chokepoint is `sym` — not the single kept claim `allBoundaries`
 *  keeps per symbol. A chokepoint can carry several claims (e.g. one `via test` and one
 *  `via guard`); `allBoundaries` collapses them order-dependently, so any caller that must ask
 *  an ∃/∀ question across a symbol's claims (the atlas: "is ANY claim here `via guard`?" when
 *  grading enshrinement) has to consult the full list, not whichever claim the map happened
 *  to keep. Returns [] when no claim anchors that symbol. */
export function boundariesAt(graph: Graph, sym: string): Array<Boundary & { component: string }> {
  return boundaryClaims(graph).filter((boundary) => boundary.chokepoint === sym);
}

/** Every normalized parity claim, preserving component and declaration order. */
export function parityClaims(graph: Graph): Array<Parity & { component: string }> {
  const out: Array<Parity & { component: string }> = [];
  for (const node of graph.nodes) {
    if (node.kind !== "component") continue;
    for (const claim of resolvedClaimsFor(graph, node)) {
      const parity = parityFromMatch(claim.match);
      if (parity) out.push({ ...parity, component: node.label });
    }
  }
  return out;
}

/** Run `fn` against the project root AS IT EXISTS at a git ref (null = the live
 *  working tree — no checkout). The temp worktree lives only for the callback, so a
 *  caller can derive anything it needs from that tree (the graph, a surface scan) in
 *  ONE checkout instead of one per artifact. */
export async function withTreeAt<T>(cfg: Config, ref: string | null, fn: (projRoot: string) => Promise<T>): Promise<T> {
  if (!ref) return fn(cfg.root);
  const top = git(["rev-parse", "--show-toplevel"], cfg.root);
  if (top.status !== 0) throw new Error(`not a git repo at ${cfg.root}: ${(top.stderr || "").trim()}`);
  // Normalize both sides before computing the project offset: macOS temp paths
  // commonly mix /var with its /private/var realpath, which would otherwise make
  // relative() escape the detached worktree and silently read the live checkout.
  const repoRoot = await realpath(top.stdout.trim());
  const projectRoot = await realpath(resolve(cfg.root));
  const relProject = relative(repoRoot, projectRoot);
  const tmp = await mkdtemp(join(tmpdir(), "coherence-wt-"));
  // A detached worktree at <ref> gives us that ref's COMMITTED files (untracked /
  // gitignored paths like node_modules are absent — buildGraph only needs source +
  // specs + config, so no install is required).
  const add = git(["worktree", "add", "--detach", tmp, ref], cfg.root);
  if (add.status !== 0) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new Error(`cannot check out "${ref}": ${(add.stderr || "").trim()}`);
  }
  try {
    return await fn(join(tmp, relProject));
  } finally {
    git(["worktree", "remove", "--force", tmp], cfg.root);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Build the graph as it exists at a git ref (null = the live working tree). */
export async function graphAtRef(cfg: Config, ref: string | null): Promise<Graph> {
  return withTreeAt(cfg, ref, async (root) => buildGraph(await loadProject(root)));
}

export interface StructuralDiff {
  componentsAdded: string[];
  componentsRemoved: string[];
  invAdded: Array<{ comp: string; inv: string }>;
  invRemoved: Array<{ comp: string; inv: string }>;
  boundaryAdded: Array<{ comp: string; b: Boundary }>;
  boundaryRemoved: Array<{ comp: string; b: Boundary }>;
  boundaryRewired: Array<{ comp: string; inv: string; before: Boundary; after: Boundary }>;
  parityAdded: Array<{ comp: string; p: Parity }>;
  parityRemoved: Array<{ comp: string; p: Parity }>;
  parityRewired: Array<{ comp: string; inv: string; before: Parity; after: Parity }>;
  factAdded: StructuralFact[];
  factRemoved: StructuralFact[];
  factChanged: Array<{ id: string; before: StructuralFact; after: StructuralFact }>;
  claimDelta: Array<{ comp: string; added: number; removed: number }>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function factSignature(fact: StructuralFact): string {
  const hasValue = Object.hasOwn(fact, "value");
  return canonicalJson({
    label: fact.label,
    hasValue,
    value: hasValue && fact.value !== undefined ? fact.value : null,
    removal: fact.policy?.removal ?? null,
    change: fact.policy?.change ?? null,
  });
}

export function diffGraphs(before: Graph, after: Graph): StructuralDiff {
  const A = ledgersOf(before), B = ledgersOf(after);
  const d: StructuralDiff = {
    componentsAdded: [], componentsRemoved: [], invAdded: [], invRemoved: [],
    boundaryAdded: [], boundaryRemoved: [], boundaryRewired: [],
    parityAdded: [], parityRemoved: [], parityRewired: [], claimDelta: [],
    factAdded: [], factRemoved: [], factChanged: [],
  };
  for (const label of B.keys()) if (!A.has(label)) d.componentsAdded.push(label);
  for (const label of A.keys()) if (!B.has(label)) d.componentsRemoved.push(label);

  for (const [label, b] of B) {
    const a = A.get(label);
    if (!a) continue; // brand-new component — its whole ledger is "added", covered by componentsAdded
    for (const inv of b.invariants) if (!a.invariants.has(inv)) d.invAdded.push({ comp: label, inv });
    for (const inv of a.invariants) if (!b.invariants.has(inv)) d.invRemoved.push({ comp: label, inv });
    for (const [inv, bnd] of b.boundaries) {
      const prev = a.boundaries.get(inv);
      if (!prev) d.boundaryAdded.push({ comp: label, b: bnd });
      else if (prev.chokepoint !== bnd.chokepoint || prev.oracle !== bnd.oracle
          || prev.verb !== bnd.verb || canonicalJson(prev.data ?? null) !== canonicalJson(bnd.data ?? null))
        d.boundaryRewired.push({ comp: label, inv, before: prev, after: bnd });
    }
    for (const [inv, bnd] of a.boundaries) if (!b.boundaries.has(inv)) d.boundaryRemoved.push({ comp: label, b: bnd });
    // parity claims — anchors like boundaries: added/removed/rewired, a removal is a LOSS
    for (const [inv, par] of b.parities) {
      const prev = a.parities.get(inv);
      if (!prev) d.parityAdded.push({ comp: label, p: par });
      else if (prev.domain !== par.domain || prev.f !== par.f || prev.g !== par.g || prev.oracle !== par.oracle)
        d.parityRewired.push({ comp: label, inv, before: prev, after: par });
    }
    for (const [inv, par] of a.parities) if (!b.parities.has(inv)) d.parityRemoved.push({ comp: label, p: par });
    let added = 0, removed = 0;
    for (const [id, signature] of b.claims)
      if (a.claims.get(id) !== signature) added++;
    for (const [id, signature] of a.claims)
      if (b.claims.get(id) !== signature) removed++;
    if (added || removed) d.claimDelta.push({ comp: label, added, removed });
  }

  const beforeFacts = new Map((before.facts ?? []).map((fact) => [fact.id, fact]));
  const afterFacts = new Map((after.facts ?? []).map((fact) => [fact.id, fact]));
  for (const fact of after.facts ?? []) {
    const previous = beforeFacts.get(fact.id);
    if (!previous) d.factAdded.push(fact);
    else if (factSignature(previous) !== factSignature(fact))
      d.factChanged.push({ id: fact.id, before: previous, after: fact });
  }
  for (const fact of before.facts ?? [])
    if (!afterFacts.has(fact.id)) d.factRemoved.push(fact);
  return d;
}

const fmtB = (b: Boundary) =>
  `"${b.inv}" at ${b.chokepoint}${b.verb ? ` via ${b.verb}${b.oracle ? ` "${b.oracle}"` : ""}` : ""}`;
const fmtP = (p: Parity) => `"${p.inv}" over ${p.domain} between ${p.f} and ${p.g} via test "${p.oracle}"`;

/** Render the diff; return the losses that `--strict` gates on. */
export function renderDiff(d: StructuralDiff, fromLabel: string, toLabel: string): number {
  console.log(`\n  STRUCTURAL LEDGER — ${fromLabel} → ${toLabel}\n`);
  const coreLosses = d.componentsRemoved.length + d.invRemoved.length + d.boundaryRemoved.length + d.parityRemoved.length;
  const factLosses = d.factRemoved.filter((fact) => fact.policy?.removal === "loss").length
    + d.factChanged.filter(({ before }) => before.policy?.change === "loss").length;
  const losses = coreLosses + factLosses;
  const line = (mark: string, s: string) => console.log(`  ${mark} ${s}`);

  if (d.componentsAdded.length) for (const c of d.componentsAdded) line("+", `component ${c}`);
  if (d.componentsRemoved.length) for (const c of d.componentsRemoved) line("–", `component ${c}  (REMOVED)`);

  for (const x of d.invAdded) line("+", `invariant "${x.inv}" (${x.comp})`);
  for (const x of d.invRemoved) line("–", `invariant "${x.inv}" (${x.comp})  (REMOVED — was the spec enforcing something it no longer claims?)`);

  for (const x of d.boundaryAdded) line("+", `boundary ${fmtB(x.b)} (${x.comp})`);
  for (const x of d.boundaryRemoved) line("–", `boundary ${fmtB(x.b)} (${x.comp})  (ANCHOR REMOVED)`);
  for (const x of d.boundaryRewired) {
    line("~", `boundary "${x.inv}" (${x.comp}) rewired:`);
    const cp = x.before.chokepoint !== x.after.chokepoint ? `chokepoint ${x.before.chokepoint} → ${x.after.chokepoint}` : "";
    const or = x.before.oracle !== x.after.oracle || x.before.verb !== x.after.verb
      ? `oracle ${x.before.verb} "${x.before.oracle}" → ${x.after.verb} "${x.after.oracle}"` : "";
    for (const s of [cp, or].filter(Boolean)) console.log(`      ${s}`);
  }

  for (const x of d.parityAdded) line("+", `parity ${fmtP(x.p)} (${x.comp})`);
  for (const x of d.parityRemoved) line("–", `parity ${fmtP(x.p)} (${x.comp})  (AGREEMENT ANCHOR REMOVED)`);
  for (const x of d.parityRewired) {
    line("~", `parity "${x.inv}" (${x.comp}) rewired:`);
    const dm = x.before.domain !== x.after.domain ? `domain ${x.before.domain} → ${x.after.domain}` : "";
    const fg = x.before.f !== x.after.f || x.before.g !== x.after.g
      ? `projections ${x.before.f}/${x.before.g} → ${x.after.f}/${x.after.g}` : "";
    const or = x.before.oracle !== x.after.oracle ? `oracle "${x.before.oracle}" → "${x.after.oracle}"` : "";
    for (const s of [dm, fg, or].filter(Boolean)) console.log(`      ${s}`);
  }

  for (const fact of d.factAdded)
    line("+", `fact "${fact.label}" [${fact.id}]`);
  for (const fact of d.factRemoved)
    line("–", `fact "${fact.label}" [${fact.id}]  (REMOVED${fact.policy?.removal === "loss" ? " — LOSS" : ""})`);
  for (const fact of d.factChanged)
    line("~", `fact "${fact.after.label}" [${fact.id}]  (CHANGED${fact.before.policy?.change === "loss" ? " — LOSS" : ""})`);

  if (d.claimDelta.length) {
    const tot = d.claimDelta.reduce((n, c) => n + c.added + c.removed, 0);
    console.log(`\n  (${tot} non-boundary claim change(s) across ${d.claimDelta.length} component(s): ${d.claimDelta.map((c) => `${c.comp} +${c.added}/-${c.removed}`).join(", ")})`);
  }

  const changed = coreLosses + d.componentsAdded.length + d.invAdded.length + d.boundaryAdded.length + d.boundaryRewired.length
    + d.parityAdded.length + d.parityRewired.length
    + d.factAdded.length + d.factRemoved.length + d.factChanged.length;
  if (!changed && !d.claimDelta.length) console.log("  no structural change.");
  console.log(`\n  ${changed} structural change(s) · ${losses} loss(es)`);
  return losses;
}

/** Files changed refA → refB (refB null = the working tree, plus untracked). Paths
 *  relative to cfg.root. The domain the novelty surface scan is scoped to. */
export function changedBetween(cfg: Config, refA: string, refB: string | null): Set<string> {
  const lines = (args: string[]) =>
    (git(args, cfg.root).stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (refB) return new Set(lines(["diff", "--name-only", "--relative", refA, refB]));
  return new Set([
    ...lines(["diff", "--name-only", "--relative", refA]),
    ...lines(["ls-files", "--others", "--exclude-standard"]),
  ]);
}

/** LOC added/deleted refA → refB across CODE files (cfg.codeExt), with cfg.ignore dirs
 *  and binary rows excluded. Untracked files (refB = null) are not counted — the
 *  headline use is a committed ref range. */
export function locDelta(cfg: Config, refA: string, refB: string | null): { added: number; deleted: number } {
  const r = git(["diff", "--numstat", "--relative", refA, ...(refB ? [refB] : [])], cfg.root);
  const extRe = new RegExp(`\\.(${cfg.codeExt.join("|")})$`);
  const ignore = new Set(cfg.ignore);
  let added = 0, deleted = 0;
  for (const line of (r.stdout || "").split("\n")) {
    const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line.trim());
    if (!m) continue; // binary rows are "-\t-\tpath"
    const path = m[3];
    if (!extRe.test(path)) continue;
    if (path.split("/").some((seg) => ignore.has(seg))) continue;
    added += Number(m[1]); deleted += Number(m[2]);
  }
  return { added, deleted };
}

export async function structuralLog(cfg: Config, refA: string, refB: string | null, strict: boolean): Promise<number> {
  // One checkout per ref: derive the graph AND the changed-file domain scan from the
  // same tree (the novelty surface proxies need the file contents at each ref).
  const changed = changedBetween(cfg, refA, refB);
  const at = (ref: string | null) => withTreeAt(cfg, ref, async (root) => ({
    graph: await buildGraph(await loadProject(root)),
    surface: await scanSurface(root, changed),
  }));
  const before = await at(refA);
  const after = await at(refB);
  const d = diffGraphs(before.graph, after.graph);
  const losses = renderDiff(d, refA, refB ?? "working tree");

  // The novelty-vs-anchor advisory: behavioral surface added vs anchors added. Advisory
  // only — it renders after the ledger and never touches the exit code.
  const sig = surfaceSignals(
    before.surface, after.surface,
    locDelta(cfg, refA, refB),
    { anchorsAdded: d.invAdded.length + d.boundaryAdded.length + d.parityAdded.length, componentsAdded: d.componentsAdded.length },
  );
  renderNovelty(sig, noveltyVerdict(sig, cfg.novelty));

  if (strict && losses) {
    console.log(`\n  ✗ --strict: ${losses} structural loss(es) — every loss must be intentional.`);
    return 1;
  }
  return 0;
}
