/**
 * Enforcement over a small TypeScript project written into a temporary
 * folder: a protected symbol, a chokepoint, one clean reference inside it,
 * one bypass outside it, one test reference. The classification, each
 * grade, the automatic refutation, the run record being append-only, the
 * status view deriving the latest verdict, the state derivation with and
 * without a run, and the PostToolUse alarm. The TypeScript adapter runs
 * in-process here; the warm server has its own test.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import type { Definition, ReferenceSite } from "../adapters/adapter.ts";
import { TypeScriptAdapter, locateServer } from "../adapters/typescript.ts";
import { runHook, specStopText } from "../lifecycle/hook.ts";
import { loadSpecModel } from "../spec/model.ts";
import { deriveState } from "../spec/state.ts";
import { checkChokepoint, classifySite } from "./check.ts";
import { formatRun, formatStatus, refuteCommand } from "./cli.ts";
import { readEnforcementConfig } from "./config.ts";
import { appendRun, entryKey, latestByEnforcement, latestFor, loadRuns, witnessedRefutations, type RunRecord } from "./record.ts";
import { mayTouch, performRun } from "./run.ts";
import { runTotalityOracle } from "./totality.ts";

const TSCONFIG = `{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "noEmit": true, "allowImportingTsExtensions": true }, "include": ["src/**/*.ts"] }\n`;

const SECRETS = `/** The protected thing. */
export const SECRET_COLUMNS: Record<string, string[]> = { tokens: ["token"] };

const HIDDEN = new Set(["x"]);

export function seal(pattern: string, row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const column of SECRET_COLUMNS[pattern] ?? []) delete out[column];
  return out;
}

export function peek(pattern: string): number {
  return HIDDEN.size + pattern.length;
}
`;

const RENDER_CLEAN = `import { seal } from "../store/secrets.ts";

export function render(pattern: string, row: Record<string, unknown>): string {
  return JSON.stringify(seal(pattern, row));
}
`;

const RENDER_BYPASS = `import { SECRET_COLUMNS, seal } from "../store/secrets.ts";

export function render(pattern: string, row: Record<string, unknown>): string {
  const sealed = seal(pattern, row);
  const leaked = SECRET_COLUMNS[pattern];
  return JSON.stringify({ sealed, leaked });
}
`;

const TEST_FILE = `import { SECRET_COLUMNS } from "../store/secrets.ts";
export const t = SECRET_COLUMNS;
`;

const PEEK_REFERENCES = `import { peek } from "../store/secrets.ts";

export function inspect(pattern: string): number {
  return peek(pattern);
}
`;

// Deliberately never invokes or otherwise uses peek: the import reference alone is reliance evidence.
const PEEK_IMPORT_ONLY = `import { peek } from "../store/secrets.ts";
`;

const SPEC = `# Fixture

A store with one door out.

## trust levels
- storage: the rows beneath everything
- public-egress: what leaves in the clear

## invariants
- digest-only egress: A secret leaves storage only as its digest.
  protects: SECRET_COLUMNS
  chokepoint: seal
  because: a read of a leaked row must disclose no usable bearer
  crossing: storage -> public-egress
  kinds: none
- hidden set: The hidden set is read only through peek.
  protects: HIDDEN
  chokepoint: peek
  because: the set is an implementation detail
  kinds: none
- prose thing: Something described in prose.
  protects: the rows every pattern keeps
  chokepoint: seal
  because: prose does not resolve
  kinds: none
- missing door: A thing whose chokepoint does not exist.
  protects: SECRET_COLUMNS
  chokepoint: noSuchFunction
  because: the chokepoint is gone
  kinds: none
- egress totality: Every secret column is stripped.
  over: every column in SECRET_COLUMNS
  via: egress totality
  because: a spot check is not enforcement
  refuted: removed the seal call -> egress totality went red (2026-09-17)
  kinds: none
`;

const CONFIG = JSON.stringify({ language: "typescript", testDir: "__tests__", test: "sh -c 'echo ran {filter}; exit 0'", testMatch: "ran egress" });

let root: string;
let adapter: TypeScriptAdapter;
const hint = { component: ".", testFolders: readEnforcementConfig("/nowhere").testFolders };
const serverPresent = locateServer(process.cwd()).found;

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "coherence-enforcement-"));
  write("tsconfig.json", TSCONFIG);
  write("coherence.config.json", CONFIG);
  write("Fixture.spec.md", SPEC);
  write("src/store/secrets.ts", SECRETS);
  write("src/api/render.ts", RENDER_BYPASS);
  write("src/api/inspect.ts", PEEK_REFERENCES);
  write("src/api/peek-import-only.ts", PEEK_IMPORT_ONLY);
  write("src/__tests__/secrets.test.ts", TEST_FILE);
  adapter = new TypeScriptAdapter(root);
});

after(async () => {
  await adapter.close();
  rmSync(root, { recursive: true, force: true });
});

test("the language server binary is found (the adapter's precondition)", () => {
  assert.ok(serverPresent, "typescript-language-server must be installed: npm install");
});

test("classification: inside the chokepoint, a test reference, a bypass; an import outside the chokepoint is a bypass", async () => {
  const protectedThing = (await adapter.resolve("SECRET_COLUMNS", hint)) as { ok: true; definition: import("../adapters/adapter.ts").Definition };
  const chokepoint = (await adapter.resolve("seal", hint)) as { ok: true; definition: import("../adapters/adapter.ts").Definition };
  assert.ok(protectedThing.ok && chokepoint.ok);
  const sites = await adapter.references(protectedThing.definition);
  const classes = sites.map((s) => `${s.file}:${s.line} ${classifySite(s, protectedThing.definition, chokepoint.definition, hint.testFolders)}`);
  assert.deepEqual(classes, [
    "src/__tests__/secrets.test.ts:1 test",
    "src/__tests__/secrets.test.ts:2 test",
    "src/api/render.ts:1 bypass",
    "src/api/render.ts:5 bypass",
    "src/store/secrets.ts:8 inside",
  ]);
  const bypass = sites.find((s) => s.file === "src/api/render.ts" && s.line === 5)!;
  assert.equal(bypass.symbol, "render.leaked", "a bypass names its referencing symbol");
});

test("grades: broken with a bypass, reference-choked when clean and exported, visibility-choked when not exported, broken when the chokepoint is missing, not chokeable for prose", async () => {
  const broken = await checkChokepoint(adapter, { protects: "SECRET_COLUMNS", chokepoint: "seal", ...hint, root });
  assert.equal(broken.grade, "broken");
  assert.equal(broken.verdict, "fail");
  assert.deepEqual(broken.bypasses, [
    { file: "src/api/render.ts", line: 1, symbol: "module top level" },
    { file: "src/api/render.ts", line: 5, symbol: "render.leaked" },
  ]);
  assert.equal(broken.counts.test, 2, "a test reference is reported, never a bypass");
  assert.equal(broken.refutation, "automatic");

  write("src/api/render.ts", RENDER_CLEAN);
  await adapter.forget();
  const clean = await checkChokepoint(adapter, { protects: "SECRET_COLUMNS", chokepoint: "seal", ...hint, root });
  assert.equal(clean.grade, "reference-choked", clean.reason);
  assert.equal(clean.verdict, "pass");
  assert.match(clean.reason, /visible outside its module/);
  assert.match(clean.reason, /2 test references/);

  const hidden = await checkChokepoint(adapter, { protects: "HIDDEN", chokepoint: "peek", ...hint, root });
  assert.equal(hidden.grade, "visibility-choked", hidden.reason);
  assert.equal(hidden.verdict, "pass");
  assert.equal(hidden.siteEvidence, "complete");
  assert.deepEqual(
    hidden.sites.map(({ file, line, symbol, class: siteClass, of, test: testSite, form }) => ({ file, line, symbol: symbol ?? "module top level", class: siteClass, of, test: testSite, ...(form === undefined ? {} : { form }) })),
    [
      { file: "src/api/inspect.ts", line: 1, symbol: "module top level", class: "chokepoint-reference", of: "chokepoint", test: false, form: "import" },
      { file: "src/api/inspect.ts", line: 4, symbol: "inspect", class: "chokepoint-reference", of: "chokepoint", test: false },
      { file: "src/api/peek-import-only.ts", line: 1, symbol: "module top level", class: "chokepoint-reference", of: "chokepoint", test: false, form: "import" },
      { file: "src/store/secrets.ts", line: 13, symbol: "peek", class: "inside", of: "protected", test: false },
    ],
    "outside chokepoint references are reliance evidence without claiming that every reference executes a call",
  );
  const importOnly = hidden.sites.find((site) => site.file === "src/api/peek-import-only.ts")!;
  assert.deepEqual({ class: importOnly.class, of: importOnly.of, form: importOnly.form, test: importOnly.test }, { class: "chokepoint-reference", of: "chokepoint", form: "import", test: false }, "an unused import is recorded only as an adapter-observed chokepoint reference");
  assert.equal(hidden.bypasses.length, 0, "chokepoint references do not alter protected-reference grading");

  const missing = await checkChokepoint(adapter, { protects: "SECRET_COLUMNS", chokepoint: "noSuchFunction", ...hint, root });
  assert.equal(missing.grade, "broken");
  assert.equal(missing.verdict, "fail");
  assert.match(missing.reason, /no symbol named noSuchFunction/);

  const prose = await checkChokepoint(adapter, { protects: "the rows every pattern keeps", chokepoint: "seal", ...hint, root });
  assert.equal(prose.grade, "not chokeable");
  assert.equal(prose.verdict, "not run");
  assert.match(prose.reason, /totality oracle form .* is the compromise/);

  write("src/api/render.ts", RENDER_BYPASS);
  await adapter.forget();
});

test("run sites persist protected references and chokepoint references without turning an unused import into a call", async () => {
  const outcome = await performRun(root, {
    session: "site-producer-focused",
    agent: "enforcement",
    adapter,
    form: "chokepoint",
    invariants: ["hidden set"],
    now: () => new Date("2019-01-01T00:00:00Z"),
  });
  const entry = outcome.record.invariants[0]!;
  assert.equal(entry.grade, "visibility-choked");
  assert.deepEqual(entry.bypasses, [], "chokepoint references do not change protected-reference grading");
  assert.ok(entry.sites?.some((site) => site.of === "protected" && site.class === "inside"));
  assert.deepEqual(entry.sites?.find((site) => site.file === "src/api/peek-import-only.ts"), {
    file: "src/api/peek-import-only.ts",
    line: 1,
    symbol: "module top level",
    class: "chokepoint-reference",
    of: "chokepoint",
    test: false,
    form: "import",
  }, "the unused import is reliance evidence, not a runtime-call claim");
  assert.deepEqual((JSON.parse(JSON.stringify(outcome.record)) as RunRecord).invariants[0]!.sites, entry.sites, "the sites survive run JSON serialization");
});

test("the automatic refutation stages a re-export in an unsaved document; a thing the module does not export is refused by the compiler; nothing is written to disk", async () => {
  const protectedThing = (await adapter.resolve("SECRET_COLUMNS", hint)) as { ok: true; definition: import("../adapters/adapter.ts").Definition };
  const before = readFileSync(join(root, "src/store/secrets.ts"), "utf8");
  const refutation = await adapter.refute(protectedThing.definition, undefined);
  assert.equal(refutation.seen, true, refutation.account);
  assert.match(refutation.account, /a re-export of SECRET_COLUMNS from the unsaved document .*coherence-refutation-/);
  assert.equal(readFileSync(join(root, "src/store/secrets.ts"), "utf8"), before);
  const { readdirSync } = await import("node:fs");
  assert.ok(readdirSync(join(root, "src/store")).every((n) => !n.includes("refutation")), "no synthetic file lands on disk");

  const hidden = (await adapter.resolve("HIDDEN", hint)) as { ok: true; definition: import("../adapters/adapter.ts").Definition };
  const refused = await adapter.refute(hidden.definition, undefined);
  assert.equal(refused.seen, true, refused.account);
  assert.match(refused.refused ?? "", /not exported/, refused.account);
  assert.deepEqual(refused.staged, [], "nothing is staged for a name the compiler will not let another module import");
  assert.equal(readFileSync(join(root, "src/store/secrets.ts"), "utf8"), before);
});

test("the totality oracle pass: configured command with a filter and a match; not configured is reported, never passing", async () => {
  const config = readEnforcementConfig(root);
  const pass = await runTotalityOracle(root, config, "egress totality");
  assert.equal(pass.verdict, "pass", pass.reason);
  const noMatch = await runTotalityOracle(root, config, "other thing");
  assert.equal(noMatch.verdict, "fail");
  assert.match(noMatch.reason, /did not match/);
  const none = await runTotalityOracle(root, { ...config, test: undefined }, "egress totality");
  assert.equal(none.verdict, "not run");
  assert.match(none.reason, /no test command configured/);
  const argv = await runTotalityOracle(root, { ...config, test: ["sh", "-c", "exit 3"], testMatch: undefined }, "x");
  assert.equal(argv.verdict, "fail");
  assert.match(argv.reason, /exited 3/);
});

test("the batched totality oracle pass: every test the bullets name in one invocation, mapped back by name; the record says which mode ran", async () => {
  const { combinedFilter, runTotalityBatch, verdictsFromReport } = await import("./totality.ts");
  assert.equal(combinedFilter(["a (b)", "c|d", "a (b)"]), "a \\(b\\)|c\\|d");
  const report = {
    testResults: [
      { assertionResults: [
        { ancestorTitles: ["egress totality"], title: "strips", status: "passed", fullName: "egress totality strips" },
        { ancestorTitles: ["egress totality"], title: "hashes", status: "passed", fullName: "egress totality hashes" },
        { ancestorTitles: ["door totality"], title: "closes", status: "failed", fullName: "door totality closes" },
        { ancestorTitles: [], title: "lone test", status: "passed", fullName: "lone test" },
      ] },
    ],
  };
  const verdicts = verdictsFromReport(report, ["egress totality", "door totality", "lone test", "absent"], "runner");
  assert.equal(verdicts.get("egress totality")!.verdict, "pass");
  assert.match(verdicts.get("egress totality")!.reason, /2 tests under "egress totality" passed in one invocation/);
  assert.equal(verdicts.get("door totality")!.verdict, "fail");
  assert.equal(verdicts.get("lone test")!.verdict, "pass", "a test's own title matches too");
  assert.equal(verdicts.get("absent")!.verdict, "fail");
  assert.match(verdicts.get("absent")!.reason, /no test ran under the name "absent"/);

  // A fake runner that writes the report it is asked for, recording the filter it received.
  const script = `const [out, filter] = process.argv.slice(1); require("node:fs").writeFileSync(out, JSON.stringify({ testResults: [{ assertionResults: [{ ancestorTitles: ["egress totality"], title: "strips " + filter, status: "passed" }] }] }));`;
  const config = { ...readEnforcementConfig(root), testJson: ["node", "-e", script, "{out}", "{filter}"] };
  const batch = await runTotalityBatch(root, config, ["egress totality"]);
  assert.ok(batch !== undefined);
  assert.equal(batch.get("egress totality")!.verdict, "pass");
  assert.equal(await runTotalityBatch(root, readEnforcementConfig(root), ["egress totality"]), undefined, "no testJson: the caller falls back to one at a time");

  write("coherence.config.json", JSON.stringify({ language: "typescript", testDir: "__tests__", testJson: ["node", "-e", script, "{out}", "{filter}"] }));
  const outcome = await performRun(root, { session: "batched", agent: "enforcement", adapter, form: "totality oracle" });
  const entry = outcome.record.invariants[0]!;
  assert.equal(entry.mode, "batched");
  assert.equal(entry.verdict, "pass");
  assert.match(formatRun(outcome), /totality oracle: pass \(.*one invocation for every test the bullets name\)/);
  write("coherence.config.json", CONFIG);
  const single = await performRun(root, { session: "batched", agent: "enforcement", adapter, form: "totality oracle" });
  assert.equal(single.record.invariants[0]!.mode, "one-at-a-time");
  rmSync(join(root, ".coherence", "runs"), { recursive: true, force: true });
});

test("the state derivation without a run: a chokepoint bullet lacks refutation; with a run: automatic refutation satisfies it, a fail is a structural defect", () => {
  const model = loadSpecModel(root, { runs: false });
  const bullet = model.components[0]!.invariants.find((i) => i.name === "hidden set")!;
  assert.deepEqual(deriveState(bullet, []).lacks, ["refutation"]);
  assert.equal(deriveState(bullet, []).state, "requirement");
  const base = { component: ".", name: "hidden set", form: "chokepoint" as const, bypasses: [], testReferences: 0, files: [], latency: 1, at: "2026-09-17T00:00:00.000Z", commit: null, session: "s" };
  const passing = deriveState(bullet, [], { chokepoint: { ...base, verdict: "pass", grade: "visibility-choked", refutation: "automatic", reason: "" }, totality: undefined });
  assert.equal(passing.state, "invariant");
  assert.deepEqual(passing.lacks, []);
  assert.equal(passing.verified.length, 1);
  const failing = deriveState(bullet, [], { chokepoint: { ...base, verdict: "fail", grade: "broken", refutation: "automatic", reason: "bypass" }, totality: undefined });
  assert.equal(failing.state, "structural defect");
  assert.equal(failing.defects.length, 1);
  const vacuous = deriveState(bullet, [], { chokepoint: { ...base, verdict: "not run", grade: "reference-choked", refutation: "missing", reason: "" }, totality: undefined });
  assert.deepEqual(vacuous.lacks, ["refutation"], "a refutation the instrument could not see does not satisfy the requirement");
});

test("a run appends one record, never rewrites; spec --check reads the run; the status view derives the latest verdict and keeps a skipped one dated", async () => {
  rmSync(join(root, ".coherence", "runs"), { recursive: true, force: true });
  const first = await performRun(root, { session: "s1", agent: "enforcement", adapter, now: () => new Date("2026-09-17T10:00:00Z") });
  assert.equal(first.record.invariants.length, 5, "four chokepoint enforcements and one totality oracle");
  assert.equal(first.record.full, true, "a run with no --invariant and no --form is a full run");
  const byName = new Map(first.record.invariants.map((e) => [`${e.name}/${e.form}`, e]));
  const digestEntry = byName.get("digest-only egress/chokepoint")!;
  assert.equal(digestEntry.verdict, "fail");
  assert.deepEqual(digestEntry.sites?.filter((site) => site.of === "protected" && site.class === "bypass").map(({ file, line, symbol }) => ({ file, line, symbol })), digestEntry.bypasses, "persisted protected bypass sites preserve the bypass count and locations");
  assert.equal(digestEntry.sites?.filter((site) => site.class === "test").length, 2, "test sites are persisted rather than promoted to bypasses");
  const hiddenEntry = byName.get("hidden set/chokepoint")!;
  assert.equal(hiddenEntry.grade, "visibility-choked");
  assert.deepEqual(hiddenEntry.sites?.filter((site) => site.class === "chokepoint-reference"), [
    { file: "src/api/inspect.ts", line: 1, symbol: "module top level", class: "chokepoint-reference", of: "chokepoint", test: false, form: "import" },
    { file: "src/api/inspect.ts", line: 4, symbol: "inspect", class: "chokepoint-reference", of: "chokepoint", test: false },
    { file: "src/api/peek-import-only.ts", line: 1, symbol: "module top level", class: "chokepoint-reference", of: "chokepoint", test: false, form: "import" },
  ], "the run serializes adapter-observed chokepoint references without calling every site a runtime caller");
  assert.equal(byName.get("prose thing/chokepoint")!.sites, undefined, "unresolved site evidence is omitted, not serialized as an empty set");
  assert.equal(byName.get("missing door/chokepoint")!.sites, undefined, "missing chokepoint evidence is omitted, not serialized as an empty set");
  assert.equal(byName.get("prose thing/chokepoint")!.grade, "not chokeable");
  assert.equal(byName.get("missing door/chokepoint")!.verdict, "fail");
  assert.equal(byName.get("egress totality/totality oracle")!.verdict, "pass");
  assert.equal(byName.get("egress totality/totality oracle")!.refutation, "missing", "the bullet's refuted: line is prose; only a refutation record witnesses a totality oracle");
  assert.ok(digestEntry.files.includes("src/api/render.ts"), "the entry lists the files it touched");
  const json = JSON.parse(JSON.stringify(first.record)) as RunRecord;
  assert.deepEqual(json.invariants.find((entry) => entry.name === "hidden set")!.sites, hiddenEntry.sites, "the JSON run record exposes the classified sites unchanged");
  const printed = formatRun(first);
  assert.match(printed, /digest-only egress\n  chokepoint seal protects SECRET_COLUMNS: broken — fail/);
  assert.match(printed, /run recorded in \.coherence\/runs\/s1\.jsonl: 5 enforcements, 2 pass, 2 fail, 1 not run/);

  const lines = () => readFileSync(join(root, ".coherence", "runs", "s1.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(lines().length, 1);
  const second = await performRun(root, { session: "s1", agent: "enforcement", adapter, form: "chokepoint", invariants: ["hidden set"], now: () => new Date("2026-09-17T11:00:00Z") });
  assert.equal(second.record.invariants.length, 1);
  assert.equal(second.record.full, undefined, "a run scoped by --invariant or --form is no full run");
  assert.equal(lines().length, 2, "append only");
  assert.deepEqual(JSON.parse(lines()[0]!) as RunRecord, first.record, "the first line is untouched");

  const model = loadSpecModel(root);
  assert.equal(model.runs?.count, 2);
  const states = Object.fromEntries(model.components[0]!.invariants.map((i) => [i.name, i.state]));
  assert.deepEqual(states, { "digest-only egress": "structural defect", "hidden set": "invariant", "prose thing": "requirement", "missing door": "requirement", "egress totality": "requirement" });
  assert.equal(model.counts.structuralDefects, 1, "the broken chokepoint was an invariant; the bullet whose chokepoint never resolved was never one");

  const status = formatStatus(root, model);
  assert.match(status, /✓ \.\/hidden set  chokepoint peek: verified 2026-09-17 visibility-choked\n/);
  assert.match(status, /✕ \.\/digest-only egress  chokepoint seal: structural defect 2026-09-17 broken: 2 references .* — kept from the run at 2026-09-17T10:00:00\.000Z; the latest run skipped it/);
  assert.match(status, /✓ \.\/egress totality  totality oracle "egress totality": verified 2026-09-17 — kept from/);
  assert.match(status, /2 runs; 2 structural defects$/);
  const latest = latestFor(latestByEnforcement(loadRuns(root).records), ".", "hidden set");
  assert.equal(latest.chokepoint?.at, "2026-09-17T11:00:00.000Z");

  const noRuns = loadSpecModel(root, { runs: false });
  assert.equal(noRuns.runs, undefined);
  assert.equal(noRuns.components[0]!.invariants.find((i) => i.name === "hidden set")!.state, "requirement");
});

test("reference-query failures and legacy records never masquerade as confirmed empty sites", async () => {
  let referenceQueries = 0;
  const failing = new Proxy(adapter, {
    get(target, property) {
      if (property === "references") {
        return async (definition: import("../adapters/adapter.ts").Definition) => {
          referenceQueries += 1;
          if (referenceQueries === 2) throw new Error("chokepoint references unavailable");
          return target.references(definition);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const failed = await performRun(root, { session: "query-failure", agent: "enforcement", adapter: failing, form: "chokepoint", invariants: ["hidden set"], now: () => new Date("2020-01-01T00:00:00Z") });
  const failedEntry = failed.record.invariants[0]!;
  assert.equal(failedEntry.verdict, "not run");
  assert.match(failedEntry.reason, /instrument failed: chokepoint references unavailable/);
  assert.equal(failedEntry.sites, undefined, "a failed second query does not persist the first query as complete evidence");
  const persistedFailure = JSON.parse(readFileSync(join(root, ".coherence", "runs", "query-failure.jsonl"), "utf8")) as { invariants: Record<string, unknown>[] };
  assert.equal(Object.hasOwn(persistedFailure.invariants[0]!, "sites"), false);

  const legacy: RunRecord = {
    at: "2020-01-01T00:00:01.000Z", session: "legacy", agent: "old-producer", commit: null, dirty: false,
    instrument: { language: "typescript", server: "none" }, latency: 1,
    invariants: [{ component: ".", name: "hidden set", form: "chokepoint", verdict: "pass", grade: "visibility-choked", refutation: "automatic", bypasses: [], testReferences: 0, files: ["src/store/secrets.ts"], latency: 1, reason: "legacy clean" }],
  };
  appendRun(root, legacy);
  const loadedLegacy = loadRuns(root).records.find((record) => record.session === "legacy")!;
  assert.equal(loadedLegacy.invariants[0]!.sites, undefined, "an old record remains readable and honestly lacks site evidence");
});

test("appendRun refuses a session that cannot name a file", () => {
  assert.throws(() => appendRun(root, { at: "2026-09-17T00:00:00Z", session: "../x", agent: "a", commit: null, dirty: false, instrument: { language: "typescript", server: "none" }, latency: 0, invariants: [] }), /cannot name a file/);
});

test("mayTouch: a run's files, or a name token in the edited file, make an invariant relevant to an edit", () => {
  const model = loadSpecModel(root);
  const egress = model.components[0]!.invariants.find((i) => i.name === "digest-only egress")!;
  const hidden = model.components[0]!.invariants.find((i) => i.name === "hidden set")!;
  assert.equal(mayTouch(egress, "src/api/render.ts", undefined), true, "the latest run touched render.ts");
  assert.equal(mayTouch(hidden, "src/api/render.ts", "nothing here"), false);
  assert.equal(mayTouch(hidden, "src/new.ts", "const y = HIDDEN;"), true, "the token is in the text");
  assert.equal(mayTouch(hidden, "src/new.ts", "const y = HIDDENx;"), false, "whole tokens only");
});

test("PostToolUse on a file-writing tool re-checks the invariants that may involve the file and prints the bypass with the two options; Stop carries the defects", async () => {
  const input = { cwd: root, session_id: "s2", tool_name: "Edit", tool_input: { file_path: join(root, "src/api/render.ts") } };
  const result = await runHook("PostToolUse", input, root, { adapter });
  assert.equal(result.exit, 0, result.stderr);
  const context = (JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
  assert.equal(context.hookEventName, "PostToolUse");
  assert.match(context.additionalContext, /^Structural defect revealed at this edit \(src\/api\/render\.ts\)/);
  assert.match(context.additionalContext, /✕ \.\/digest-only egress — chokepoint seal protects SECRET_COLUMNS: broken\n    bypass src\/api\/render\.ts:1 in module top level \(this edit\)\n    bypass src\/api\/render\.ts:5 in render\.leaked \(this edit\)/);
  assert.match(context.additionalContext, /✕ \.\/missing door/);
  assert.doesNotMatch(context.additionalContext, /hidden set/, "an invariant the file cannot involve is not re-checked");
  assert.match(context.additionalContext, /route the reference through the chokepoint, or escalate a retirement for a human/);
  assert.match(context.additionalContext, /escalate "retire <invariant>" .* --session s2 --agent main/);
  assert.ok(readFileSync(join(root, ".coherence", "runs", "s2.jsonl"), "utf8").trimEnd().split("\n").length === 1, "the edit-time pass is recorded as a run");

  const reading = await runHook("PostToolUse", { cwd: root, session_id: "s2", tool_name: "Read", tool_input: { file_path: join(root, "src/api/render.ts") } }, root);
  assert.deepEqual(reading, { stdout: "", stderr: "", exit: 0 }, "a reading tool changes nothing");
  const unrelated = await runHook("PostToolUse", { cwd: root, session_id: "s2", tool_name: "Write", tool_input: { file_path: join(root, "tsconfig.json") } }, root);
  assert.deepEqual(unrelated, { stdout: "", stderr: "", exit: 0 }, "a file no invariant can involve is not checked");

  const stop = specStopText(root);
  assert.equal(stop.defects, 1, "only the bullet that was an invariant is a structural defect; the one whose chokepoint never resolved stays a requirement");
  assert.match(stop.text, /✕ \.\/digest-only egress — structural defect \(chokepoint, run \d{4}-\d{2}-\d{2}\): 2 references to SECRET_COLUMNS outside seal: src\/api\/render\.ts:1 in module top level, src\/api\/render\.ts:5 in render\.leaked/);
  assert.match(stop.text, /stands until the reference is routed through the chokepoint or a human acknowledges a retirement/);
});

test("the check reads the current disk text after a forget, with the instrument's watcher blind to the file: a loop of edit-then-check yields zero wrong verdicts", async () => {
  // tsserver reloads a closed document from disk only when it does not own the text; a didOpen with the text it
  // already loaded leaves it owning the text, and then only its file watcher notices an edit. Excluding the file
  // from the watcher (a setting an adopter may carry) makes the stale answer deterministic instead of a race.
  const other = mkdtempSync(join(tmpdir(), "coherence-stale-"));
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(other, path)), { recursive: true });
    writeFileSync(join(other, path), text, "utf8");
  };
  put("tsconfig.json", TSCONFIG.replace('"include": ["src/**/*.ts"]', '"include": ["src/**/*.ts"], "watchOptions": { "excludeFiles": ["src/api/render.ts"] }'));
  put("src/store/secrets.ts", SECRETS);
  put("src/__tests__/secrets.test.ts", TEST_FILE);
  put("src/api/render.ts", RENDER_CLEAN);
  const fresh = new TypeScriptAdapter(other);
  const wrong: string[] = [];
  try {
    for (let i = 0; i < 6; i++) {
      const bypass = i % 2 === 1;
      put("src/api/render.ts", bypass ? RENDER_BYPASS : RENDER_CLEAN);
      await fresh.forget(["src/api/render.ts"]);
      const result = await checkChokepoint(fresh, { protects: "SECRET_COLUMNS", chokepoint: "seal", ...hint, root: other });
      const expected = bypass ? "fail" : "pass";
      if (result.verdict !== expected) wrong.push(`cycle ${i}: disk ${bypass ? "bypass" : "clean"}, verdict ${result.verdict} (${result.reason})`);
    }
  } finally {
    await fresh.close();
    rmSync(other, { recursive: true, force: true });
  }
  assert.deepEqual(wrong, [], "every verdict answers from the text on disk");
});

test("every site the language server reports is a reference: a bypass beneath a semicolon-less bare import is a bypass, and an import outside the chokepoint is one too", async () => {
  const other = mkdtempSync(join(tmpdir(), "coherence-imports-"));
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(other, path)), { recursive: true });
    writeFileSync(join(other, path), text, "utf8");
  };
  put("tsconfig.json", TSCONFIG);
  put("src/store/secrets.ts", SECRETS);
  put("src/api/polyfill.ts", "export const polyfilled = true;\n");
  // Reviewer B's case: no semicolon after the bare import, then a real use of the protected thing.
  put("src/api/leak.ts", 'import { SECRET_COLUMNS } from "../store/secrets.ts";\nimport "./polyfill.ts"\n\nexport const leaked = SECRET_COLUMNS\n');
  put("src/api/reexport.ts", 'export { SECRET_COLUMNS } from "../store/secrets.ts";\n');
  const fresh = new TypeScriptAdapter(other);
  try {
    const result = await checkChokepoint(fresh, { protects: "SECRET_COLUMNS", chokepoint: "seal", ...hint, root: other });
    assert.equal(result.verdict, "fail", result.reason);
    assert.equal(result.grade, "broken");
    assert.deepEqual(
      result.bypasses.map((b) => `${b.file}:${b.line} in ${b.symbol}`),
      ["src/api/leak.ts:1 in module top level", "src/api/leak.ts:4 in leaked", "src/api/reexport.ts:1 in module top level"],
      "the use beneath the bare import, the import specifier, and the re-export are all references outside the chokepoint",
    );
  } finally {
    await fresh.close();
    rmSync(other, { recursive: true, force: true });
  }
});

/** Ruling d-7abd1ba8's tree: the chokepoint's module imports the protected thing, uses it inside and outside the chokepoint, and re-exports it; another module imports it and a third re-exports it with a wildcard. */
const RULING_SEAL = `import { SECRET_COLUMNS } from "../store/secrets.ts";

export function seal(pattern: string): string[] {
  return SECRET_COLUMNS[pattern] ?? [];
}

export const sneak = SECRET_COLUMNS;

export { SECRET_COLUMNS } from "../store/secrets.ts";
`;

async function ruledTree(seal: string): Promise<{ dir: string; adapter: TypeScriptAdapter }> {
  const dir = mkdtempSync(join(tmpdir(), "coherence-ruling-"));
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text, "utf8");
  };
  put("tsconfig.json", TSCONFIG);
  put("src/store/secrets.ts", 'export const SECRET_COLUMNS: Record<string, string[]> = { tokens: ["token"] };\n');
  put("src/door/seal.ts", seal);
  put("src/api/leak.ts", 'import { SECRET_COLUMNS } from "../store/secrets.ts";\nexport const held = SECRET_COLUMNS;\n');
  put("src/api/star.ts", 'export * from "../store/secrets.ts";\n');
  return { dir, adapter: new TypeScriptAdapter(dir) };
}

test("a plain import specifier in the chokepoint's own module is inside; the same import elsewhere, a re-export anywhere, a wildcard re-export, and a use outside the chokepoint's range are bypasses", async () => {
  const { dir, adapter: fresh } = await ruledTree(RULING_SEAL);
  try {
    const protectedThing = (await fresh.resolve("SECRET_COLUMNS in secrets.ts", hint)) as { ok: true; definition: import("../adapters/adapter.ts").Definition };
    const chokepoint = (await fresh.resolve("seal", hint)) as { ok: true; definition: import("../adapters/adapter.ts").Definition };
    assert.ok(protectedThing.ok && chokepoint.ok);
    const sites = await fresh.references(protectedThing.definition);
    const classes = sites.map((s) => `${s.file}:${s.line} ${classifySite(s, protectedThing.definition, chokepoint.definition, hint.testFolders)}`);
    assert.deepEqual(classes, [
      "src/api/leak.ts:1 bypass",
      "src/api/leak.ts:2 bypass",
      "src/api/star.ts:1 bypass",
      "src/door/seal.ts:1 inside",
      "src/door/seal.ts:4 inside",
      "src/door/seal.ts:7 bypass",
      "src/door/seal.ts:9 bypass",
    ]);
    assert.equal(sites.find((s) => s.file === "src/door/seal.ts" && s.line === 1)!.form, "import");
    assert.equal(sites.find((s) => s.file === "src/door/seal.ts" && s.line === 9)!.form, "re-export");
    assert.equal(sites.find((s) => s.file === "src/api/star.ts" && s.line === 1)!.form, "re-export");
  } finally {
    await fresh.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A definition by hand, for the classifier alone: a symbol over a line range, or a module over its whole file. */
function definitionAt(file: string, kind: "symbol" | "module", from = 0, to = 0): Definition {
  return { name: file, kind, file, range: { start: { line: from, character: 0 }, end: { line: to, character: 0 } }, selection: { line: from, character: 0 } };
}

/** A reference site by hand, one-based as the adapter reports it. */
function siteAt(file: string, line: number, test?: true): ReferenceSite {
  return { file, line, character: 4, symbol: undefined, ...(test === undefined ? {} : { test }) };
}

test("a site the adapter marks as test is a test reference even in the chokepoint's own file", () => {
  const protectedThing = definitionAt("src/store.rs", "symbol", 2, 4);
  const chokepoint = definitionAt("src/lib.rs", "symbol", 9, 19);
  const classes = [
    siteAt("src/lib.rs", 15),
    siteAt("src/lib.rs", 15, true),
    siteAt("src/lib.rs", 40),
    siteAt("src/lib.rs", 40, true),
    siteAt("src/api.rs", 3),
    siteAt("src/api.rs", 3, true),
  ].map((s) => `${s.file}:${s.line}${s.test === true ? " marked" : ""} ${classifySite(s, protectedThing, chokepoint, [])}`);
  assert.deepEqual(classes, [
    "src/lib.rs:15 inside",
    "src/lib.rs:15 marked test",
    "src/lib.rs:40 bypass",
    "src/lib.rs:40 marked test",
    "src/api.rs:3 bypass",
    "src/api.rs:3 marked test",
  ]);
});

test("a Rust module's subtree is inside the module: X/mod.rs owns X/, X.rs owns its sibling X/, a crate root owns src/", () => {
  const protectedThing = definitionAt("src/store.rs", "symbol", 2, 4);
  const classOf = (moduleFile: string, file: string): string => `${moduleFile} <- ${file}: ${classifySite(siteAt(file, 3), protectedThing, definitionAt(moduleFile, "module"), ["tests"])}`;
  assert.deepEqual(
    [
      classOf("src/kernel/mod.rs", "src/kernel/inner.rs"),
      classOf("src/kernel/mod.rs", "src/kernel/deep/leaf.rs"),
      classOf("src/kernel/mod.rs", "src/other.rs"),
      classOf("src/kernel.rs", "src/kernel/x.rs"),
      classOf("src/kernel.rs", "src/kernelish/x.rs"),
      classOf("src/kernel.rs", "src/other.rs"),
      classOf("src/lib.rs", "src/kernel/x.rs"),
      classOf("src/main.rs", "src/cli.rs"),
      classOf("crates/core/src/lib.rs", "crates/core/src/a.rs"),
      classOf("crates/core/src/lib.rs", "crates/app/src/a.rs"),
      classOf("src/lib.rs", "tests/it.rs"),
      classOf("src/lib.rs", "benches/b.rs"),
    ],
    [
      "src/kernel/mod.rs <- src/kernel/inner.rs: inside",
      "src/kernel/mod.rs <- src/kernel/deep/leaf.rs: inside",
      "src/kernel/mod.rs <- src/other.rs: bypass",
      "src/kernel.rs <- src/kernel/x.rs: inside",
      "src/kernel.rs <- src/kernelish/x.rs: bypass",
      "src/kernel.rs <- src/other.rs: bypass",
      "src/lib.rs <- src/kernel/x.rs: inside",
      "src/main.rs <- src/cli.rs: inside",
      "crates/core/src/lib.rs <- crates/core/src/a.rs: inside",
      "crates/core/src/lib.rs <- crates/app/src/a.rs: bypass",
      "src/lib.rs <- tests/it.rs: test",
      "src/lib.rs <- benches/b.rs: bypass",
    ],
  );
});

test("the automatic refutation stages both synthetic sites — a use in the chokepoint's own module outside its range and a re-export — and is vacuous unless the check calls each one a bypass", async () => {
  // The clean tree: the chokepoint's module imports the protected thing and uses it only inside seal.
  const clean = `import { SECRET_COLUMNS } from "../store/secrets.ts";

export function seal(pattern: string): string[] {
  return SECRET_COLUMNS[pattern] ?? [];
}
`;
  const { dir, adapter: fresh } = await ruledTree(clean);
  try {
    rmSync(join(dir, "src/api/leak.ts"));
    rmSync(join(dir, "src/api/star.ts"));
    const result = await checkChokepoint(fresh, { protects: "SECRET_COLUMNS in secrets.ts", chokepoint: "seal", ...hint, root: dir });
    assert.equal(result.grade, "reference-choked", result.reason);
    assert.equal(result.refutation, "automatic", result.refutationAccount);
    assert.equal(result.verdict, "pass", result.reason);
    assert.match(result.refutationAccount, /a use of SECRET_COLUMNS in src\/door\/seal\.ts outside seal/, result.refutationAccount);
    assert.match(result.refutationAccount, /a re-export of SECRET_COLUMNS/, result.refutationAccount);
    assert.match(result.refutationAccount, /the check classified each one a bypass/, result.refutationAccount);
  } finally {
    await fresh.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the one-at-a-time totality path escapes the title before the runner reads it as a regex", async () => {
  const { escapeRegExp, runTotalityOracle } = await import("./totality.ts");
  assert.equal(escapeRegExp("returns 503 (R2 absent)"), "returns 503 \\(R2 absent\\)");
  const config = { test: ["node", "-e", "console.log(process.argv[1])"], testMatch: /^returns 503 \\\(R2 absent\\\)$/m, testJson: undefined } as never;
  const result = await runTotalityOracle(process.cwd(), config, "returns 503 (R2 absent)");
  assert.equal(result.verdict, "pass", result.reason);
});

test("the automatic refutation is vacuous unless the check's own classification calls the synthetic site a bypass", async () => {
  // Reviewer B: the protected thing under a test folder. Every site, the synthetic one included, is a test
  // reference, so nothing can ever be a bypass and the bullet read as a verified invariant.
  const other = mkdtempSync(join(tmpdir(), "coherence-vacuous-"));
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(other, path)), { recursive: true });
    writeFileSync(join(other, path), text, "utf8");
  };
  put("tsconfig.json", TSCONFIG);
  put("src/__tests__/secrets.ts", 'export const SECRET_COLUMNS: Record<string, string[]> = { tokens: ["token"] };\nexport function seal(pattern: string): string[] {\n  return SECRET_COLUMNS[pattern] ?? [];\n}\n');
  put("src/__tests__/render.ts", 'import { SECRET_COLUMNS } from "./secrets.ts";\nexport const leaked = SECRET_COLUMNS;\n');
  // Reviewer A: a not-exported thing whose chokepoint is its own module. The synthetic line the adapter adds
  // is inside that module, so no reference to it can be a bypass either.
  put("src/store/hidden.ts", 'const HIDDEN = new Set(["x"]);\n\nexport function peek(pattern: string): number {\n  return HIDDEN.size + pattern.length;\n}\n');
  const fresh = new TypeScriptAdapter(other);
  try {
    const inTests = await checkChokepoint(fresh, { protects: "SECRET_COLUMNS", chokepoint: "seal", ...hint, root: other });
    assert.equal(inTests.counts.bypass, 0, "every site is under a test folder");
    assert.equal(inTests.refutation, "missing", inTests.refutationAccount);
    assert.equal(inTests.verdict, "not run", inTests.reason);
    assert.match(inTests.refutationAccount, /a test reference, not a bypass; the refutation is vacuous/);

    // Ruling rs-e93ecdd6: HIDDEN is not exported, so the compiler refuses every outside reference and
    // Coherence's own check can never be made to fire; the refusal is the refutation for that rung.
    const ownModule = await checkChokepoint(fresh, { protects: "HIDDEN", chokepoint: "src/store/hidden.ts", ...hint, root: other });
    assert.equal(ownModule.refutation, "refused by the language", ownModule.refutationAccount);
    assert.equal(ownModule.verdict, "pass", ownModule.reason);
    assert.equal(ownModule.grade, "visibility-choked", ownModule.reason);
    assert.match(ownModule.refutationAccount, /refused by the compiler: .*not exported/);
    assert.match(ownModule.refutationAccount, /the visibility-choked rung is enforced by the compiler, and its refusal is the refutation/);

    const symbolChokepoint = await checkChokepoint(fresh, { protects: "HIDDEN", chokepoint: "peek", ...hint, root: other });
    assert.equal(symbolChokepoint.refutation, "refused by the language", symbolChokepoint.refutationAccount);
    assert.equal(symbolChokepoint.verdict, "pass", symbolChokepoint.reason);
  } finally {
    await fresh.close();
    rmSync(other, { recursive: true, force: true });
  }
});

/** A bullet as the grammar parses one, for the state derivation alone. */
function bullet(over: Partial<import("../spec/grammar.ts").Invariant>): import("../spec/grammar.ts").Invariant {
  return { name: "b", sentence: "s", line: 1, enforcements: [], because: "why", crossing: undefined, refutations: [], kinds: "none", checklist: [], unfilled: [], ...over };
}

const CHOKEPOINT_FORM = { form: "chokepoint" as const, protects: "SECRET_COLUMNS", chokepoint: "seal", line: 2 };
const TOTALITY_FORM = { form: "totality oracle" as const, over: "every column", via: "egress totality", line: 3 };

function latestEntry(form: "chokepoint" | "totality oracle", over: Partial<import("./record.ts").Latest> = {}): import("./record.ts").Latest {
  return {
    component: ".", name: "b", form, verdict: "pass", refutation: form === "chokepoint" ? "automatic" : "witnessed",
    bypasses: [], testReferences: 0, files: [], latency: 1, reason: "", at: "2026-09-18T10:00:00.000Z", commit: null, session: "s", ...over,
  };
}

test("a totality oracle's refutation is a recorded event: the refuted line never satisfies it, a record with a later passing run does, and a bullet with both forms needs both", () => {
  const totality = bullet({ enforcements: [TOTALITY_FORM], refutations: [{ broke: "removed the seal call", saw: "egress totality went red", date: "2026-09-17", line: 4 }] });
  const passing = { chokepoint: undefined, totality: latestEntry("totality oracle") };
  assert.deepEqual(deriveState(totality, []).lacks, ["refutation"], "the refuted: line alone is prose");
  assert.deepEqual(deriveState(totality, [], passing).lacks, ["refutation"], "a passing run is not a refutation either");
  assert.deepEqual(deriveState(totality, [], passing, true).lacks, [], "the record plus a later passing run is");
  assert.equal(deriveState(totality, [], passing, true).state, "invariant");

  // Per enforcement (union item 20): a chokepoint's automatic refutation never covers the totality oracle beside it.
  const both = bullet({ enforcements: [CHOKEPOINT_FORM, TOTALITY_FORM] });
  const chokepointOnly = { chokepoint: latestEntry("chokepoint"), totality: latestEntry("totality oracle") };
  assert.deepEqual(deriveState(both, [], chokepointOnly).unrefuted, ["totality oracle"]);
  assert.deepEqual(deriveState(both, [], chokepointOnly).lacks, ["refutation"]);
  assert.deepEqual(deriveState(both, [], chokepointOnly, true).lacks, []);
  const totalityOnly = { chokepoint: latestEntry("chokepoint", { refutation: "missing", verdict: "not run" }), totality: latestEntry("totality oracle") };
  assert.deepEqual(deriveState(both, [], totalityOnly, true).unrefuted, ["chokepoint"]);
  assert.deepEqual(deriveState(both, [], totalityOnly, true).lacks, ["refutation"]);
});

test("witnessed only with a later passing run: the refutation record alone is a red detector, not a restored one", () => {
  const record = {
    kind: "refutation" as const, at: "2026-09-18T10:00:00.000Z", session: "s", agent: "a", component: ".", name: "b",
    form: "totality oracle" as const, broke: "removed the seal call", verdict: "fail" as const, reason: "exited 1", commit: null, dirty: true,
  };
  const run = (at: string, verdict: "pass" | "fail"): RunRecord => ({
    at, session: "s", agent: "a", commit: null, dirty: false, instrument: { language: "typescript", server: "none" }, latency: 1,
    invariants: [{ component: ".", name: "b", form: "totality oracle", verdict, refutation: "witnessed", bypasses: [], testReferences: 0, files: [], latency: 1, reason: "" }],
  });
  assert.equal(witnessedRefutations([], [record]).size, 0, "no run after the record");
  assert.equal(witnessedRefutations([run("2026-09-18T09:00:00.000Z", "pass")], [record]).size, 0, "a run before the record proves nothing");
  assert.equal(witnessedRefutations([run("2026-09-18T11:00:00.000Z", "fail")], [record]).size, 0, "the code was never restored");
  assert.deepEqual([...witnessedRefutations([run("2026-09-18T11:00:00.000Z", "pass")], [record])], [entryKey(".", "b", "totality oracle")]);
});

test("a structural defect is an invariant whose satisfaction has been removed; a requirement with a failing check stays a requirement", () => {
  const failing = latestEntry("chokepoint", { verdict: "fail", grade: "broken", reason: "1 reference outside seal" });
  const complete = bullet({ enforcements: [CHOKEPOINT_FORM] });
  const wasInvariant = deriveState(complete, [], { chokepoint: failing, totality: undefined });
  assert.equal(wasInvariant.state, "structural defect");
  assert.equal(wasInvariant.defects.length, 1);

  // The same failing check on a bullet that never reached invariant: the checklist was never run.
  const neverInvariant = bullet({ enforcements: [CHOKEPOINT_FORM], kinds: undefined });
  const stillRequirement = deriveState(neverInvariant, [], { chokepoint: failing, totality: undefined });
  assert.equal(stillRequirement.state, "requirement", "a requirement is never promoted to a structural defect by failing");
  assert.deepEqual(stillRequirement.lacks, ["kinds"]);
  assert.deepEqual(stillRequirement.defects.map((d) => d.reason), ["1 reference outside seal"], "and it is reported with its failing check");

  // A vacuous refutation is the same story: the bullet never became an invariant, so a failure leaves it a requirement.
  const vacuous = latestEntry("chokepoint", { verdict: "fail", grade: "broken", refutation: "missing", reason: "1 reference outside seal" });
  assert.equal(deriveState(complete, [], { chokepoint: vacuous, totality: undefined }).state, "requirement");

  // A run entry for a form the bullet no longer carries is history, not a verdict on what it claims now.
  const totalityOnly = bullet({ enforcements: [TOTALITY_FORM] });
  const stale = deriveState(totalityOnly, [], { chokepoint: failing, totality: latestEntry("totality oracle") }, true);
  assert.equal(stale.state, "invariant", "the chokepoint entry is from when the bullet carried a chokepoint form");
  assert.deepEqual(stale.defects, []);
  assert.deepEqual(stale.verified.map((v) => v.form), ["totality oracle"]);
});

test("refute runs the bullet's totality oracle with the break staged, requires it to fail, and appends the refutation record", async () => {
  rmSync(join(root, ".coherence", "runs"), { recursive: true, force: true });
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { cwd: root, out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) };

  // Nothing is staged, so the totality oracle passes: no record, and the command says so.
  const passing = await refuteCommand(["./egress totality", "--broke", "removed the seal call", "--session", "r1", "--agent", "enforcement"], io);
  assert.equal(passing, 1);
  assert.match(errors.join("\n"), /still passed with the break staged, so nothing was refuted and nothing was recorded/);
  assert.equal(loadRuns(root).refutations.length, 0);

  // The break staged: the configured command goes red.
  write("coherence.config.json", JSON.stringify({ language: "typescript", testDir: "__tests__", test: "sh -c 'exit 1'" }));
  const refuted = await refuteCommand(["./egress totality", "--broke", "removed the seal call from the row renderer", "--session", "r1", "--agent", "enforcement"], io);
  assert.equal(refuted, 0, errors.join("\n"));
  const recorded = loadRuns(root).refutations;
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    { component: recorded[0]!.component, name: recorded[0]!.name, form: recorded[0]!.form, verdict: recorded[0]!.verdict, broke: recorded[0]!.broke },
    { component: ".", name: "egress totality", form: "totality oracle", verdict: "fail", broke: "removed the seal call from the row renderer" },
  );
  assert.match(recorded[0]!.reason, /exited 1/);
  assert.equal(recorded[0]!.dirty, typeof recorded[0]!.dirty === "boolean" ? recorded[0]!.dirty : true);
  assert.match(lines.join("\n"), /now restore the code and run/);

  // The break restored: the bullet is an invariant only once a later run finds the totality oracle passing again.
  write("coherence.config.json", CONFIG);
  const before = loadSpecModel(root);
  assert.equal(before.components[0]!.invariants.find((i) => i.name === "egress totality")!.state, "requirement", "the record alone is a red detector");
  await performRun(root, { session: "r1", agent: "enforcement", adapter, form: "totality oracle" });
  const after = loadSpecModel(root);
  const bulletAfter = after.components[0]!.invariants.find((i) => i.name === "egress totality")!;
  assert.equal(bulletAfter.state, "invariant");
  assert.deepEqual(bulletAfter.lacks, []);

  // A bullet with no totality oracle form is refused rather than recorded.
  const chokepointOnly = await refuteCommand(["./digest-only egress", "--broke", "x", "--session", "r1", "--agent", "enforcement"], io);
  assert.equal(chokepointOnly, 64);
  assert.match(errors.join("\n"), /carries no totality oracle form/);
  rmSync(join(root, ".coherence", "runs"), { recursive: true, force: true });
});

test("refute reports a detector that does not finish in its time as refuting nothing, and kills every process it started", { timeout: 60_000 }, async () => {
  rmSync(join(root, ".coherence", "runs"), { recursive: true, force: true });
  const errors: string[] = [];
  const io = { cwd: root, out: () => {}, err: (line: string) => errors.push(line) };
  // A staged break that makes the detector loop forever: the command never exits, and the child it starts neither.
  write("coherence.config.json", JSON.stringify({ language: "typescript", testDir: "__tests__", test: "sh -c 'sleep 47.25; exit 1'" }));
  try {
    const started = Date.now();
    const code = await refuteCommand(["./egress totality", "--broke", "made the detector loop forever", "--session", "r1", "--agent", "enforcement", "--timeout", "1"], io);
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 20_000, "refute returns once its timeout passes");
    assert.match(errors.join("\n"), /the detector did not finish in 1 s; its test process and every process it started were killed, so nothing was refuted and nothing was recorded/);
    assert.equal(loadRuns(root).refutations.length, 0, "a detector that never answered is not a red one");
    const left = spawnSync("ps", ["-A", "-o", "args="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes("sleep 47.25") && !line.includes("ps -A"));
    assert.deepEqual(left, [], "no process of the detector is left running");
    const refused = await refuteCommand(["./egress totality", "--broke", "x", "--timeout", "soon"], io);
    assert.equal(refused, 64);
  } finally {
    write("coherence.config.json", CONFIG);
    rmSync(join(root, ".coherence", "runs"), { recursive: true, force: true });
  }
});

test("a report entry maps to a via by exact title, with the one stated fallback for a runner that truncates", async () => {
  const { verdictsFromReport } = await import("./totality.ts");
  // Reviewer A and B: the mapping was by substring, so a different test whose title contains the via
  // answered for it. Here the bullet's own test passes and a neighbour with a longer name fails.
  const report = {
    testResults: [
      { assertionResults: [
        { ancestorTitles: [], title: "egress totality", status: "passed", fullName: "egress totality" },
        { ancestorTitles: [], title: "egress totality under load", status: "failed", fullName: "egress totality under load" },
        { ancestorTitles: ["door totality"], title: "closes", status: "passed", fullName: "door totality closes" },
      ] },
    ],
  };
  const verdicts = verdictsFromReport(report, ["egress totality", "door totality"], "runner");
  assert.equal(verdicts.get("egress totality")!.verdict, "pass", "the neighbour's failure is not this bullet's");
  assert.match(verdicts.get("egress totality")!.reason, /1 test under "egress totality" passed/);
  assert.equal(verdicts.get("door totality")!.verdict, "pass", "a title above the test still names it");

  // The other direction: a via that is a prefix of nothing reported is not run, never borrowed.
  const orphan = verdictsFromReport(report, ["egress"], "runner");
  assert.equal(orphan.get("egress")!.verdict, "fail");
  assert.match(orphan.get("egress")!.reason, /no test ran under the name "egress"/);

  // The stated fallback: a runner that cuts the title short.
  const cut = { testResults: [{ assertionResults: [{ ancestorTitles: [], title: "egress totality strips ever…", status: "passed", fullName: "egress totality strips ever…" }] }] };
  assert.equal(verdictsFromReport(cut, ["egress totality strips every secret column"], "runner").get("egress totality strips every secret column")!.verdict, "pass");
  assert.equal(verdictsFromReport(cut, ["door totality"], "runner").get("door totality")!.verdict, "fail", "a truncated title matches only the via it is a prefix of");
});
