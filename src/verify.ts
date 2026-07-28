// verify.ts — the coherence engine: deterministic claim verifiers + the narrative
// evidence chain (emits inference jobs for a subagent) + coverage meta-claims
// (what auto-generates, why is human-authored). Config-driven; consumes the Graph.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Config, Graph } from "./types.ts";
import type { Diagnostic } from "./plugin.ts";
import { deepFreeze } from "./json.ts";
import {
  claimResolutionsFor,
  claimFormsFor,
  evaluateResolvedClaim,
  projectChecksFor,
  type ClaimCtx,
  type ResolvedClaim,
} from "./phrasebook.ts";
import { ownerOf } from "./walk.ts";

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const jobsPath = (cfg: Config) => join(cfg.root, ".coherence", "verify-jobs.json");
const narrPath = (cfg: Config) => join(cfg.root, "narrative.json");

async function evidence(root: string, addrs: string[]) {
  const parts: string[] = [], missing: string[] = [];
  for (const a of addrs) if (a.startsWith("file:")) { const p = a.slice(5); try { parts.push(`--- ${p} ---\n${(await readFile(join(root, p), "utf8")).slice(0, 6000)}`); } catch { missing.push(a); } }
  return { text: parts.join("\n\n"), missing };
}

/** record subagent verdicts (the mechanical notary; judge ≠ notary, axiom #5). */
export async function applyVerdicts(cfg: Config, verdictsPath: string): Promise<number> {
  const verdicts = JSON.parse(await readFile(verdictsPath, "utf8")) as Array<{ id: string; supported: boolean; reason: string; corrected?: string | null }>;
  const jobs = JSON.parse(await readFile(jobsPath(cfg), "utf8")) as Array<{ id: string; currentHash: string }>;
  const narr = JSON.parse(await readFile(narrPath(cfg), "utf8")) as { statements: any[] };
  let ok = 0, drift = 0;
  for (const v of verdicts) {
    const st = narr.statements.find((s) => s.id === v.id); const job = jobs.find((j) => j.id === v.id);
    if (!st || !job) continue;
    if (v.supported) { st.verifiedHash = job.currentHash; st.status = "ok"; delete st.drift; delete st.suggested; ok++; }
    else { st.status = "drifted"; st.drift = v.reason; if (v.corrected) st.suggested = v.corrected; drift++; }
  }
  await writeFile(narrPath(cfg), JSON.stringify(narr, null, 2) + "\n");
  console.log(`applied ${verdicts.length} verdict(s): ${ok} confirmed · ${drift} drifted`);
  for (const s of narr.statements) if (s.status === "drifted") console.log(`  ✗ [${s.id}] DRIFT — ${s.drift}`);
  return drift === 0 ? 0 : 1;
}

export async function runVerify(cfg: Config, graph: Graph, opts: { fast?: boolean; only?: Set<string> }): Promise<number> {
  const root = cfg.root;
  const extensionGraph = deepFreeze(structuredClone(graph));
  const extensionConfig = deepFreeze(structuredClone(cfg));
  // Invariants ANCHORED by a `boundary "<name>" ...` claim, per component label. The
  // coverage gate fails any `## invariants` entry that nothing anchors (the ratchet).
  const anchored = new Map<string, Set<string>>();
  let tc: { pass: boolean; detail: string } | null = null;
  const typecheck = () => {
    if (tc) return tc;
    const r = spawnSync(cfg.typecheck[0], cfg.typecheck.slice(1), { cwd: root, encoding: "utf8", timeout: 120000 });
    const tail = ((r.stderr || "") + (r.stdout || "")).split("\n").filter(Boolean).slice(-3).join(" | ");
    tc = r.status === 0 ? { pass: true, detail: "" } : { pass: false, detail: tail.slice(0, 200) };
    return tc;
  };
  type Sig = {
    kind: "pass" | "fail" | "skip";
    claim: string;
    node: string;
    detail?: string;
    diagnosticIds?: readonly string[];
  };
  // The graph carries its project-local composed ClaimForm registry and normalized matches.
  // evalClaim builds the per-claim context and adapts the graph-bound ClaimResult into a Sig.
  // A line matching NO form still skips as a dialect gap; ambiguity already failed closed
  // while the graph was bound. The
  // boundary + `conforms to` forms anchor invariants via ctx.anchor so the coverage gate
  // sees them (including boundaries reached transitively through a dictionary word).
  const evalClaim = async (
    claim: string,
    resolved: ResolvedClaim | null,
    nodeDir: string,
    node: string,
  ): Promise<Sig> => {
    const ctx: ClaimCtx = {
      cfg: extensionConfig, graph: extensionGraph, root, nodeDir, node, fast: !!opts.fast, typecheck, wordStack: [],
      forms: claimFormsFor(graph),
      anchor: (inv) => { let set = anchored.get(node); if (!set) { set = new Set(); anchored.set(node, set); } set.add(inv); },
    };
    if (!resolved)
      return { kind: "skip", claim, node, detail: "no verifier (dialect gap)" };
    const result = await evaluateResolvedClaim(ctx, resolved);
    return {
      kind: result.kind,
      claim,
      node,
      detail: result.detail,
      diagnosticIds: result.diagnosticIds,
    };
  };

  // `only` (verify --staged/--since) scopes the run to the components whose dirs
  // changed — the edit-loop affordance. The boundary-anchoring + coverage gates below
  // then cover exactly the touched components, so a fast scoped check still fails on a
  // touched-but-broken invariant. Symbol resolution for boundary claims stays GLOBAL
  // (a touched chokepoint's oracle may name a symbol defined elsewhere).
  const comps = graph.nodes.filter((n) => n.kind === "component" && (!opts.only || opts.only.has(n.id.slice(2))));
  const compDirs = graph.nodes.filter((n) => n.kind === "component").map((n) => n.id.slice(2));
  // Scope the (advisory) symbol-doc coverage to the touched components too, so a
  // staged run doesn't dump every undocumented symbol in the repo as a job.
  const symbols = graph.nodes.filter((n) => n.kind === "symbol" && (!opts.only || (n.path != null && opts.only.has(ownerOf(n.path, compDirs)))));
  const sigs: Sig[] = [];
  for (const c of comps) {
    const dir = c.id.slice(2);
    const diskDir = dir === "." ? root : join(root, dir);
    const claims = c.claims ?? [];
    const resolved = claimResolutionsFor(graph, c);
    for (const [index, claim] of claims.entries())
      sigs.push(await evalClaim(claim, resolved[index], diskDir, c.label));
  }
  const red = sigs.filter((s) => s.kind === "fail").length;
  console.log(`claims: ${sigs.length} · ${sigs.filter((s) => s.kind === "pass").length} green · ${red} red · ${sigs.filter((s) => s.kind === "skip").length} skipped`);
  for (const s of sigs) if (s.kind !== "pass") console.log(`  ${s.kind === "fail" ? "✗" : "·"} [${s.node}] ${s.claim}${s.detail ? ` — ${s.detail}` : ""}`);

  const diagnostics = new Map<string, Diagnostic>();
  for (const [checkIndex, { plugin, check }] of projectChecksFor(graph).entries()) {
    let emitted: readonly Diagnostic[];
    try {
      const value = await check({ root, graph: extensionGraph });
      if (!Array.isArray(value))
        throw new Error("project check must return an array of diagnostics");
      emitted = value;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      emitted = [{
        id: `${plugin}:project-check:${checkIndex}:exception`,
        status: "fail",
        category: "plugin",
        message: `Project check failed: ${detail}`,
      }];
    }
    for (const [diagnosticIndex, diagnostic] of emitted.entries()) {
      const subject = `Plugin "${plugin}" diagnostic at index ${diagnosticIndex}`;
      if (!diagnostic || typeof diagnostic !== "object")
        throw new Error(`${subject} must be an object`);
      if (typeof diagnostic.id !== "string" || !diagnostic.id.startsWith(`${plugin}:`))
        throw new Error(`${subject}.id must start with "${plugin}:"`);
      if (!["pass", "fail", "skip"].includes(diagnostic.status))
        throw new Error(`${subject}.status must be pass, fail, or skip`);
      if (typeof diagnostic.category !== "string" || !diagnostic.category
          || typeof diagnostic.message !== "string" || !diagnostic.message)
        throw new Error(`${subject} category and message must be non-empty strings`);
      const stable = Object.freeze({
        id: diagnostic.id,
        status: diagnostic.status,
        category: diagnostic.category,
        message: diagnostic.message,
      });
      const previous = diagnostics.get(stable.id);
      if (previous
          && (previous.status !== stable.status
            || previous.category !== stable.category
            || previous.message !== stable.message))
        throw new Error(`Conflicting diagnostics share id "${stable.id}"`);
      diagnostics.set(stable.id, stable);
    }
  }
  if (diagnostics.size) {
    const values = [...diagnostics.values()];
    console.log(`diagnostics: ${values.length} · ${values.filter((d) => d.status === "pass").length} green · ${values.filter((d) => d.status === "fail").length} red · ${values.filter((d) => d.status === "skip").length} skipped`);
    for (const diagnostic of values)
      if (diagnostic.status !== "pass")
        console.log(`  ${diagnostic.status === "fail" ? "✗" : "·"} [${diagnostic.id}] ${diagnostic.category} — ${diagnostic.message}`);
  }

  const jobs: Array<Record<string, any>> = [];
  let narr: { statements: any[] } | null = null;
  try { narr = JSON.parse(await readFile(narrPath(cfg), "utf8")); } catch { /* none */ }
  let broken = 0;
  if (narr?.statements) {
    let unchanged = 0, pending = 0;
    for (const st of narr.statements) {
      const { text, missing } = await evidence(root, st.evidence);
      if (missing.length) { broken++; st.status = "broken"; console.log(`  ✗ [narrative ${st.id}] broken evidence: ${missing.join(", ")}`); continue; }
      const h = hashOf(text);
      if (h === st.verifiedHash) { unchanged++; st.status = "ok"; continue; }
      st.status = "pending"; pending++;
      jobs.push({ kind: "verify-statement", id: st.id, statement: st.statement, evidenceFiles: st.evidence.filter((e: string) => e.startsWith("file:")).map((e: string) => e.slice(5)), currentHash: h });
    }
    await writeFile(narrPath(cfg), JSON.stringify(narr, null, 2) + "\n");
    console.log(`narrative: ${narr.statements.length} statements · ${unchanged} unchanged · ${pending} need verification · ${broken} broken`);
  }

  // Coverage gates NODE-CONTRACT completeness (does each node carry claims + a why),
  // NOT symbol-doc exhaustiveness. Per-symbol prose is advisory: forcing a docblock on
  // every export produces stale busywork and a perpetually-red baseline that trains
  // contributors to ignore the gate. Undocumented symbols still surface as jobs.
  const compGaps = comps.filter((c) => !(c.claims && c.claims.length));
  const docGaps = symbols.filter((s) => !s.prose || !String(s.prose).trim());
  const whyGaps = comps.filter((c) => !c.why || !String(c.why).trim());
  console.log(`coverage: components ${comps.length - compGaps.length}/${comps.length} claimed, ${comps.length - whyGaps.length}/${comps.length} with why · symbols ${symbols.length - docGaps.length}/${symbols.length} documented (advisory)`);
  for (const c of compGaps) { console.log(`  ✗ [coverage] component "${c.label}" has no claims`); jobs.push({ kind: "generate-claims", id: c.id, name: c.label }); }
  for (const c of whyGaps) { console.log(`  ✗ [coverage] component "${c.label}" states no rationale (why)`); jobs.push({ kind: "author-why", id: c.id, name: c.label }); }
  // advisory only — emitted as jobs, never gated
  for (const s of docGaps) jobs.push({ kind: "generate-doc", id: s.id, file: s.path, line: s.line, name: s.label });
  if (docGaps.length) console.log(`  · [advisory] ${docGaps.length} symbol(s) undocumented (not gated)`);
  // RATCHET coverage: a named invariant with no `boundary` claim is a property the spec
  // asserts but nothing enforces/anchors — fail it, the way a boundary shipped without
  // its totality oracle should fail loud rather than rot silently.
  const invGaps: { comp: string; inv: string }[] = [];
  for (const c of comps) for (const inv of c.invariants ?? []) if (!anchored.get(c.label)?.has(inv)) invGaps.push({ comp: c.label, inv });
  for (const g of invGaps) { console.log(`  ✗ [coverage] invariant "${g.inv}" (${g.comp}) is not anchored by a boundary claim`); jobs.push({ kind: "anchor-invariant", comp: g.comp, inv: g.inv }); }
  const totalInv = comps.reduce((n, c) => n + (c.invariants?.length ?? 0), 0);
  if (totalInv) console.log(`invariants: ${totalInv - invGaps.length}/${totalInv} anchored by a boundary claim`);
  const covGaps = compGaps.length + whyGaps.length + invGaps.length;

  const verifyJobs = jobs.filter((j) => j.kind === "verify-statement");
  const genJobs = jobs.filter((j) => j.kind === "generate-doc" || j.kind === "generate-claims");
  const authorJobs = jobs.filter((j) => j.kind === "author-why");
  if (jobs.length) {
    await mkdir(join(root, ".coherence"), { recursive: true });
    await writeFile(jobsPath(cfg), JSON.stringify(jobs, null, 2) + "\n");
    console.log(`\n=== JOBS — ${jobs.length} (dispatch a subagent) · .coherence/verify-jobs.json ===`);
    if (verifyJobs.length) { console.log(`\n VERIFY (evidence changed — judge if the statement still holds):`); console.log(`   → write .coherence/verify-verdicts.json, then re-run with --apply .coherence/verify-verdicts.json`); for (const j of verifyJobs) console.log(`   [${j.id}] "${j.statement}"`); }
    if (genJobs.length) { console.log(`\n GENERATE — the WHAT (derivable; write into source, re-run):`); for (const j of genJobs) console.log(j.kind === "generate-doc" ? `   [doc] ${j.name} at ${j.file}:${j.line}` : `   [claims] component "${j.name}" — add a ## works when block`); }
    if (authorJobs.length) { console.log(`\n AUTHOR — the WHY (NOT derivable — do not fabricate; needs a human/attested author):`); for (const j of authorJobs) console.log(`   [why] component "${j.name}" — states no rationale`); }
  }

  const failedDiagnosticIds = new Set(
    [...diagnostics.values()].filter((diagnostic) => diagnostic.status === "fail")
      .map((diagnostic) => diagnostic.id),
  );
  const standaloneClaimFailures = sigs.filter((sig) =>
    sig.kind === "fail"
    && !(sig.diagnosticIds ?? []).some((id) => failedDiagnosticIds.has(id))).length;
  const failures = standaloneClaimFailures + failedDiagnosticIds.size + broken + covGaps;
  const failureDetail = diagnostics.size
    ? `${standaloneClaimFailures} claim · ${failedDiagnosticIds.size} diagnostic · ${broken} broken · ${covGaps} coverage`
    : `${standaloneClaimFailures} claim · ${broken} broken · ${covGaps} coverage`;
  console.log(failures === 0 ? (verifyJobs.length ? `\n• ${verifyJobs.length} verification job(s) pending` : "\n✓ coherent") : `\n✗ ${failures} coherence failure(s) — ${failureDetail}`);
  return failures === 0 ? 0 : 1;
}
