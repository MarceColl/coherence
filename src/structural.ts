// structural.ts — the temporal affordance. A coherence graph is a *snapshot*
// ledger; this adds the transaction view: what one ref → another did to the
// STRUCTURE an agent cares about — components, the invariants they uphold, and
// the boundary claims (chokepoint + oracle) that anchor those invariants.
//
// The point is the question "did my change alter the invariant set?" — answerable
// without re-reading the world, and a review gate: a dropped boundary or a
// silently-rewired chokepoint is the diff a prose review misses. `--strict` turns
// a LOSS (an invariant or boundary anchor removed) into a nonzero exit.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseBoundary, type Boundary } from "./boundary.ts";
import { loadConfig } from "./config.ts";
import { buildGraph } from "./derive.ts";
import { ownerOf } from "./walk.ts";
import { conformsWord, dictionaryDir, parseClaim, parseWord, type ParsedClaim } from "./phrasebook.ts";
import { noveltyVerdict, renderNovelty, scanSurface, surfaceSignals } from "./novelty.ts";
import { Unrunnable } from "./floor.ts";
import type { Config, Graph, GraphNode } from "./types.ts";

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
    for (const c of w?.commitments ?? []) { const ref = conformsWord(c); if (ref) set.add(ref); }
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
    // A file no component dir owns maps to NO component — it does not map to a fabricated
    // one. `ownerOf` used to answer `"."` here whether or not a root component existed, and
    // this line put that phantom into the scope set; verify then announced it had examined
    // a component that is not in the graph and graded zero claims under it.
    else { const o = ownerOf(f, dirs); if (o !== null) hit.add(o); }
  }
  if (changedWords.size) {
    const words = await affectedWords(cfg, changedWords);
    for (const n of graph.nodes)
      if (n.kind === "component")
        for (const cl of n.claims ?? []) {
          const w = conformsWord(cl);
          if (w && words.has(w)) { hit.add(n.id.slice(2)); break; }
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

/** An anchor as the ledger holds it: the claim line as authored, plus its normalized
 *  reading. GENERIC over claim forms — any registry form whose ParsedClaim carries
 *  anchors is a first-class ledger anchor, with no per-form fields here. */
export interface Anchor { line: string; claim: ParsedClaim }

interface Ledger {
  label: string;
  invariants: Set<string>;
  anchors: Map<string, Anchor>;  // anchor-bearing claims, keyed `${form}:${key}`
  claims: Set<string>;           // anchor-less claims (exists/imports/…)
}

function ledgerOf(node: GraphNode): Ledger {
  const anchors = new Map<string, Anchor>();
  const claims = new Set<string>();
  for (const line of node.claims ?? []) {
    const r = parseClaim(line);
    if (r && r.claim.anchors.length) anchors.set(`${r.claim.form}:${r.claim.key}`, { line, claim: r.claim });
    else claims.add(line);
  }
  return {
    label: node.label,
    invariants: new Set(node.invariants ?? []),
    anchors,
    claims,
  };
}

function ledgersOf(graph: Graph): Map<string, Ledger> {
  const out = new Map<string, Ledger>();
  for (const n of graph.nodes) if (n.kind === "component") out.set(n.label, ledgerOf(n));
  return out;
}

/** Every boundary claim in the graph, keyed by its CHOKEPOINT symbol — the shared
 *  input the atlas (tier derivation) and conventions (anchored set) subcommands both
 *  consume, parsed ONCE from the graph the harness already built (no spec re-walk).
 *  Deliberately boundary-FAMILY (typed, not ParsedClaim): its consumers grade the
 *  boundary concept — verb, chokepoint — which only this family carries. */
export function allBoundaries(graph: Graph): Map<string, Boundary & { component: string }> {
  const out = new Map<string, Boundary & { component: string }>();
  for (const n of graph.nodes)
    if (n.kind === "component")
      for (const c of n.claims ?? []) {
        const b = parseBoundary(c);
        if (b && !out.has(b.chokepoint)) out.set(b.chokepoint, { ...b, component: n.label });
      }
  return out;
}

/** EVERY boundary claim whose chokepoint is `sym` — not the single kept claim `allBoundaries`
 *  keeps per symbol. A chokepoint can carry several claims (e.g. one `via test` and one
 *  `via guard`); `allBoundaries` collapses them order-dependently, so any caller that must ask
 *  an ∃/∀ question across a symbol's claims (the atlas: "is ANY claim here `via guard`?" when
 *  grading enshrinement) has to consult the full list, not whichever claim the map happened
 *  to keep. Returns [] when no claim anchors that symbol. */
export function boundariesAt(graph: Graph, sym: string): Array<Boundary & { component: string }> {
  const out: Array<Boundary & { component: string }> = [];
  for (const n of graph.nodes)
    if (n.kind === "component")
      for (const c of n.claims ?? []) {
        const b = parseBoundary(c);
        if (b && b.chokepoint === sym) out.push({ ...b, component: n.label });
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
  // NOT a bare throw. This is the realistic case, not the exotic one — a shallow CI clone,
  // a source export, a worktree that lost its .git — and it used to reach the operator as a
  // stack trace plus a Node version banner. An instrument that cannot run must SAY SO; a
  // crash is a report that failed to state what was and was not measured, which is
  // green-by-absence with the sign flipped (see floor.ts).
  if (top.status !== 0) throw new Unrunnable([
    `✗ [floor] this instrument reads git HISTORY, and ${cfg.root} is not inside a git repository.`,
    `  git rev-parse --show-toplevel failed${(top.stderr || "").trim() ? `: ${(top.stderr || "").trim().split("\n")[0]}` : ""}.`,
    `  Nothing was measured — there is no earlier tree to compare this one against, and`,
    `  reporting "no structural change" over an absent history would be success over nothing.`,
    `  · a shallow clone or a source export?  the verbs that read history (\`log\`, \`signal\`)`,
    `    cannot run here. Everything that reads only the working tree still can:`,
    `    coherence verify · graph · decompose · mass · redundancy.`,
    `  · a worktree that lost its .git?  run \`git status\` at this path to confirm, then`,
    `    restore or re-clone the repository.`,
  ]);
  const repoRoot = top.stdout.trim();
  const relProject = relative(repoRoot, resolve(cfg.root));
  const tmp = await mkdtemp(join(tmpdir(), "coherence-wt-"));
  // A detached worktree at <ref> gives us that ref's COMMITTED files (untracked /
  // gitignored paths like node_modules are absent — buildGraph only needs source +
  // specs + config, so no install is required).
  const add = git(["worktree", "add", "--detach", tmp, ref], cfg.root);
  if (add.status !== 0) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    // Same treatment, same reason: a ref that does not resolve (a fresh repo with no
    // commits, a branch name that moved) is an operator fact, not a defect in the harness.
    throw new Unrunnable([
      `✗ [floor] cannot check out "${ref}" — this instrument reads the tree AT THAT REF and`,
      `  git could not produce it${(add.stderr || "").trim() ? `: ${(add.stderr || "").trim().split("\n")[0]}` : ""}.`,
      `  Nothing was measured. Name a ref that resolves (\`git rev-parse ${ref}\` proves it),`,
      `  or — in a repository with no commits yet — make the first commit and re-run.`,
    ]);
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
  return withTreeAt(cfg, ref, async (root) => buildGraph(await loadConfig(root)));
}

export interface StructuralDiff {
  componentsAdded: string[];
  componentsRemoved: string[];
  invAdded: Array<{ comp: string; inv: string }>;
  invRemoved: Array<{ comp: string; inv: string }>;
  // Anchors are GENERIC: any claim form whose ParsedClaim declares anchors participates,
  // identified by form:key. Rewired = same identity, different RECORD text — record is
  // each form's own statement of what is semantic (a boundary's crossing clause is pure
  // topology, stripped from record, so annotating one is a ledger non-event exactly as
  // it is a claimKey non-event).
  anchorAdded: Array<{ comp: string; a: Anchor }>;
  anchorRemoved: Array<{ comp: string; a: Anchor }>;
  anchorRewired: Array<{ comp: string; before: Anchor; after: Anchor }>;
  claimDelta: Array<{ comp: string; added: number; removed: number }>;
}

export function diffGraphs(before: Graph, after: Graph): StructuralDiff {
  const A = ledgersOf(before), B = ledgersOf(after);
  const d: StructuralDiff = {
    componentsAdded: [], componentsRemoved: [], invAdded: [], invRemoved: [],
    anchorAdded: [], anchorRemoved: [], anchorRewired: [], claimDelta: [],
  };
  for (const label of B.keys()) if (!A.has(label)) d.componentsAdded.push(label);
  for (const label of A.keys()) if (!B.has(label)) d.componentsRemoved.push(label);

  for (const [label, b] of B) {
    const a = A.get(label);
    if (!a) continue; // brand-new component — its whole ledger is "added", covered by componentsAdded
    for (const inv of b.invariants) if (!a.invariants.has(inv)) d.invAdded.push({ comp: label, inv });
    for (const inv of a.invariants) if (!b.invariants.has(inv)) d.invRemoved.push({ comp: label, inv });
    for (const [id, anchor] of b.anchors) {
      const prev = a.anchors.get(id);
      if (!prev) d.anchorAdded.push({ comp: label, a: anchor });
      else if (prev.claim.record !== anchor.claim.record)
        d.anchorRewired.push({ comp: label, before: prev, after: anchor });
    }
    for (const [id, anchor] of a.anchors) if (!b.anchors.has(id)) d.anchorRemoved.push({ comp: label, a: anchor });
    let added = 0, removed = 0;
    for (const c of b.claims) if (!a.claims.has(c)) added++;
    for (const c of a.claims) if (!b.claims.has(c)) removed++;
    if (added || removed) d.claimDelta.push({ comp: label, added, removed });
  }
  return d;
}

/** The detail fields that changed between two readings of one anchor, as render lines. */
function detailChanges(before: Anchor, after: Anchor): string[] {
  const keys = [...new Set([...Object.keys(before.claim.detail), ...Object.keys(after.claim.detail)])];
  return keys
    .filter((k) => before.claim.detail[k] !== after.claim.detail[k])
    .map((k) => `${k} ${before.claim.detail[k] ?? "—"} → ${after.claim.detail[k] ?? "—"}`);
}

/** Render the diff; return the count of LOSSES (removed invariants/anchors/components). */
export function renderDiff(d: StructuralDiff, fromLabel: string, toLabel: string): number {
  console.log(`\n  STRUCTURAL LEDGER — ${fromLabel} → ${toLabel}\n`);
  const losses = d.componentsRemoved.length + d.invRemoved.length + d.anchorRemoved.length;
  const line = (mark: string, s: string) => console.log(`  ${mark} ${s}`);

  if (d.componentsAdded.length) for (const c of d.componentsAdded) line("+", `component ${c}`);
  if (d.componentsRemoved.length) for (const c of d.componentsRemoved) line("–", `component ${c}  (REMOVED)`);

  for (const x of d.invAdded) line("+", `invariant "${x.inv}" (${x.comp})`);
  for (const x of d.invRemoved) line("–", `invariant "${x.inv}" (${x.comp})  (REMOVED — was the spec enforcing something it no longer claims?)`);

  // The claim line is its own best rendering — it already reads as prose, whatever form.
  for (const x of d.anchorAdded) line("+", `${x.a.line} (${x.comp})`);
  for (const x of d.anchorRemoved) line("–", `${x.a.line} (${x.comp})  (ANCHOR REMOVED)`);
  for (const x of d.anchorRewired) {
    line("~", `${x.after.claim.form} "${x.after.claim.key}" (${x.comp}) rewired:`);
    for (const s of detailChanges(x.before, x.after)) console.log(`      ${s}`);
  }

  if (d.claimDelta.length) {
    const tot = d.claimDelta.reduce((n, c) => n + c.added + c.removed, 0);
    console.log(`\n  (${tot} non-anchor claim change(s) across ${d.claimDelta.length} component(s): ${d.claimDelta.map((c) => `${c.comp} +${c.added}/-${c.removed}`).join(", ")})`);
  }

  const changed = losses + d.componentsAdded.length + d.invAdded.length + d.anchorAdded.length + d.anchorRewired.length;
  if (!changed && !d.claimDelta.length) console.log("  no structural change.");
  console.log(`\n  ${changed} structural change(s) · ${losses} loss(es) (removed invariant/anchor/component)`);
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
    graph: await buildGraph(await loadConfig(root)),
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
    { anchorsAdded: d.invAdded.length + d.anchorAdded.length, componentsAdded: d.componentsAdded.length },
  );
  renderNovelty(sig, noveltyVerdict(sig, cfg.novelty));

  if (strict && losses) {
    console.log(`\n  ✗ --strict: ${losses} structural loss(es) — a dropped invariant/boundary must be intentional.`);
    return 1;
  }
  return 0;
}
