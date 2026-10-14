/**
 * The CI check (ci.ts, ci-report.ts): the workflow ci install plans from the
 * tree for each mode and package manager, a registry's check covering every
 * listed project, an existing workflow never overwritten, the suggestion
 * hooks install prints only while no workflow runs Coherence, and the
 * report the comment mode posts. Nothing here reaches the network or GitHub.
 */

import assert from "node:assert/strict";
import { sessionFiles } from "../journal/shard-fixture.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { appendRun, type RunEntry, type RunRecord } from "../enforcement/record.ts";
import { stopWarmServers } from "../enforcement/server-fixture.ts";
import type { Io } from "../journal/cli.ts";
import { loadSpecModel } from "../spec/model.ts";
import { buildReport, ciReportCommand, renderReport, type GapReader } from "./ci-report.ts";
import { cli } from "./cli-fixture.ts";
import { ciInstallCommand, ciSuggestion, CiError, planWorkflow, REPORT_MARKER, WORKFLOW_PATH, workflowText } from "./ci.ts";


const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A repository top (a .git folder is what marks one) holding these files. */
function repository(files: Record<string, string>): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "coherence-ci-")));
  made.push(top);
  mkdirSync(join(top, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  }
  return top;
}

const ADOPTER_PACKAGE = JSON.stringify({ name: "adopter", devDependencies: { "@posthog/coherence": "^1.6.0" } });

function capture(cwd: string): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { cwd, out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

/** Structural sanity a YAML reader would also refuse: no tab, indentation in steps of two, and each step a "- " item under steps:. */
function assertWellFormed(text: string): void {
  for (const [i, line] of text.split("\n").entries()) {
    assert.ok(!line.includes("\t"), `line ${i + 1} holds a tab`);
    const indent = line.length - line.trimStart().length;
    assert.equal(indent % 2, 0, `line ${i + 1} is indented by ${indent}: ${line}`);
    assert.ok(!/\s$/.test(line), `line ${i + 1} ends in whitespace`);
  }
  assert.match(text, /^name: Coherence\n/m);
  assert.match(text, /^on:\n {2}pull_request:\n/m);
  assert.match(text, /^jobs:\n {2}coherence:\n {4}runs-on: ubuntu-latest\n/m);
}

/** The value of each `run:` line, in order; a block scalar's lines joined. */
function runs(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {8}run: (.*)$/.exec(lines[i]!);
    if (m === null) continue;
    if (m[1] !== "|") {
      out.push(m[1]!);
      continue;
    }
    const block: string[] = [];
    while (i + 1 < lines.length && /^ {10}/.test(lines[i + 1]!)) block.push(lines[++i]!.slice(10));
    out.push(block.join("\n"));
  }
  return out;
}

test("ci install writes the fail mode for npm: spec --check and the chokepoint run, failing on either, pinned, with minimal permissions", () => {
  const top = repository({ "package.json": ADOPTER_PACKAGE, "package-lock.json": "{}\n", "coherence.config.json": "{}\n" });
  const text = workflowText(planWorkflow(top, "github", "fail"));
  assertWellFormed(text);
  assert.match(text, /^permissions:\n {2}contents: read\n\n/m, "fail mode asks to read the contents and nothing more");
  assert.doesNotMatch(text, /pull-requests:/);
  for (const name of ["COHERENCE_TELEMETRY: \"0\"", "DO_NOT_TRACK: \"1\"", "COHERENCE_NO_UPDATE_CHECK: \"1\""]) assert.ok(text.includes(`\n  ${name}\n`), `env ${name}`);
  assert.match(text, /- uses: actions\/checkout@[0-9a-f]{40} # v\d/);
  assert.match(text, /persist-credentials: false\n {10}fetch-depth: 0\n/);
  assert.match(text, /- uses: actions\/setup-node@[0-9a-f]{40} # v\d/);
  for (const line of text.split("\n").filter((l) => /^\s*- uses: /.test(l))) assert.match(line, /@[0-9a-f]{40} # v\d/, `every action pinned by commit: ${line}`);
  assert.doesNotMatch(text, /pnpm/);
  assert.deepEqual(runs(text), ["npm ci", "npx --no -- coherence spec --check", 'npx --no -- coherence run --form chokepoint --no-server --session "ci-${{ github.run_id }}" --agent ci']);
  assert.match(text, /- name: Chokepoints\n {8}if: \$\{\{ !cancelled\(\) \}\}\n/, "the chokepoints are checked even when the spec check failed");
  assert.doesNotMatch(text, /working-directory/, "a project at the top runs there");
});

test("ci install writes the comment mode for pnpm: findings never fail the job, and one comment is posted or updated", () => {
  const top = repository({ "package.json": ADOPTER_PACKAGE, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
  const text = workflowText(planWorkflow(top, "github", "comment"));
  assertWellFormed(text);
  assert.match(text, /^permissions:\n {2}contents: read\n {2}pull-requests: write\n/m, "comment mode adds only what posting a comment needs");
  assert.match(text, /- uses: pnpm\/action-setup@[0-9a-f]{40} # v\d.*\n {8}with:\n {10}version: 10\n/, "no packageManager: the pnpm that writes lockfile 9.0");
  const steps = runs(text);
  assert.equal(steps[0], "pnpm install --frozen-lockfile");
  assert.equal(steps[1], "pnpm exec coherence spec --check || [ $? -eq 1 ]", "a spec problem is a finding; any other exit breaks the job");
  assert.equal(steps[2], 'pnpm exec coherence run --form chokepoint --no-server --session "ci-${{ github.run_id }}" --agent ci || [ $? -eq 1 ]');
  assert.match(steps[3]!, /pnpm exec coherence ci report --session "ci-\$\{\{ github.run_id \}\}" > "\$RUNNER_TEMP\/coherence-report.md" \|\| status=\$\?/);
  assert.match(steps[3]!, />> "\$GITHUB_STEP_SUMMARY"\nexit "\$status"$/, "the report reaches the job summary, then its exit stands");
  assert.ok(steps[4]!.includes(`startswith("${REPORT_MARKER}")`), "the comment is found by the report's marker");
  assert.match(steps[4]!, /gh api --method PATCH "repos\/\$REPO\/issues\/comments\/\$id" -F body=@"\$body"/, "an existing comment is updated in place");
  assert.match(steps[4]!, /gh api --method POST "repos\/\$REPO\/issues\/\$PR\/comments" -F body=@"\$body"/);
  assert.match(steps[4]!, /::warning::.*fork/, "a read-only token is said, never silent");
  assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);

  const declared = repository({ "package.json": JSON.stringify({ name: "x", packageManager: "pnpm@10.18.0", devDependencies: { "@posthog/coherence": "^1.6.0" } }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
  assert.doesNotMatch(workflowText(planWorkflow(declared, "github", "comment")), /version: 10/, "packageManager names the pnpm, so the workflow does not");
});

test("ci install runs a registry's check at the repository top, covering every listed project, and a nested project in its own folder", () => {
  const top = repository({
    "package.json": ADOPTER_PACKAGE,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "coherence.config.json": JSON.stringify({ projects: ["products/a", "products/b"], language: "typescript" }),
    "products/a/A.spec.md": "# a\n\nThe a product.\n",
    "products/b/B.spec.md": "# b\n\nThe b product.\n",
  });
  const fromLeaf = planWorkflow(join(top, "products/a"), "github", "fail");
  assert.equal(fromLeaf.workdir, ".", "run from a leaf, the check still runs at the top");
  assert.deepEqual(fromLeaf.projects, ["products/a", "products/b"]);
  const text = workflowText(fromLeaf);
  assert.doesNotMatch(text, /working-directory/);
  assert.match(text, /# The registry at the repository top lists 2 projects: both commands run at the top and cover each one\./);

  const nested = repository({ "package.json": ADOPTER_PACKAGE, "package-lock.json": "{}\n", ".nvmrc": "22\n", "apps/web/coherence.config.json": "{}\n" });
  const plan = planWorkflow(join(nested, "apps/web"), "github", "fail");
  assert.equal(plan.workdir, "apps/web");
  assert.equal(plan.installDir, ".");
  const nestedText = workflowText(plan);
  assert.equal(nestedText.match(/working-directory: apps\/web/g)?.length, 2, "both checks run in the project's folder");
  assert.match(nestedText, /node-version-file: \.nvmrc/, "the project's own Node.js version file is used");

  const topless = repository({ "package.json": ADOPTER_PACKAGE, "products/a/package-lock.json": "{}\n", "coherence.config.json": JSON.stringify({ projects: ["products/a"] }) });
  assert.throws(() => planWorkflow(join(topless, "products/a"), "github", "fail"), /no package-lock\.json or pnpm-lock\.yaml at the repository top, where a registry's check runs/);
});

test("ci install refuses what it cannot set up, and says what to do", () => {
  const yarn = repository({ "package.json": ADOPTER_PACKAGE, "yarn.lock": "" });
  assert.throws(() => planWorkflow(yarn, "github", "fail"), (e: unknown) => e instanceof CiError && /yarn\.lock is a lockfile the workflow does not set up; it installs with npm \(package-lock\.json\) or pnpm/.test(e.message));
  const unlisted = repository({ "package.json": JSON.stringify({ name: "x" }), "package-lock.json": "{}\n" });
  assert.throws(() => planWorkflow(unlisted, "github", "fail"), /no package\.json from \. up to \. lists @posthog\/coherence/);
  const both = repository({ "package.json": ADOPTER_PACKAGE, "package-lock.json": "{}\n", "pnpm-lock.yaml": "" });
  assert.throws(() => planWorkflow(both, "github", "fail"), /holds package-lock\.json and pnpm-lock\.yaml/);

  const top = repository({ "package.json": ADOPTER_PACKAGE, "package-lock.json": "{}\n" });
  const noMode = capture(top);
  assert.equal(ciInstallCommand(["--host", "github"], noMode.io), 64);
  assert.match(noMode.err.join("\n"), /choose a mode: --mode fail to fail the check on a spec problem or a structural defect, or --mode comment to post one report comment/, "both modes are presented, neither assumed");
});

test("ci install prints without --write, writes with it, and never overwrites a workflow already there", () => {
  const top = repository({ "package.json": ADOPTER_PACKAGE, "package-lock.json": "{}\n" });
  const path = join(top, WORKFLOW_PATH);
  const printed = capture(top);
  assert.equal(ciInstallCommand(["--host", "github", "--mode", "fail"], printed.io), 0);
  assert.match(printed.out.join("\n"), /^# Coherence on every pull request/);
  assert.ok(!existsSync(path), "printed, not written");

  const written = capture(top);
  assert.equal(ciInstallCommand(["--host=github", "--mode=comment", "--write"], written.io), 0, written.err.join("\n"));
  assert.equal(readFileSync(path, "utf8"), workflowText(planWorkflow(top, "github", "comment")));

  writeFileSync(path, "name: theirs\n");
  const again = capture(top);
  assert.equal(ciInstallCommand(["--host", "github", "--mode", "fail", "--write"], again.io), 1);
  assert.match(again.err.join("\n"), /coherence\.yml already exists and was not overwritten/);
  assert.equal(readFileSync(path, "utf8"), "name: theirs\n", "the file there is kept byte for byte");
  assert.deepEqual(readdirSync(dirname(path)), ["coherence.yml"], "and nothing is written beside it");
});

test("hooks install offers ci install and its two modes only while no workflow runs Coherence", async () => {
  const bare = repository({ "package.json": ADOPTER_PACKAGE });
  const line = await ciSuggestion(bare);
  assert.match(line, /^CI: no workflow runs Coherence on pull requests; npx --no -- coherence ci install --host github --mode fail \(.+\) or --mode comment \(.+\) prints one, and --write writes it\.\n$/);

  const installed = await cli(["hooks", "install", "--host", "claude"], { cwd: bare });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout.split("\n").filter((l) => l.startsWith("CI: ")).length, 1, "hooks install prints the offer once");

  const ours = repository({ [WORKFLOW_PATH]: "name: Coherence\n" });
  assert.equal(await ciSuggestion(ours), "", "the workflow ci install writes");
  const theirs = repository({ ".github/workflows/checks.yaml": "jobs:\n  x:\n    steps:\n      - run: pnpm exec coherence spec --check\n" });
  assert.equal(await ciSuggestion(theirs), "", "a workflow of the adopter's own that runs the check");
  const unrelated = repository({ ".github/workflows/checks.yml": "jobs:\n  x:\n    steps:\n      - run: npm test\n" });
  assert.notEqual(await ciSuggestion(unrelated), "", "a workflow that does not run Coherence is no reason to stay quiet");
  const again = await cli(["hooks", "install", "--host", "claude"], { cwd: ours });
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^CI: /m, "with a workflow there, install says nothing of CI");
});

/** A run record of one session holding these chokepoint entries. */
function record(session: string, entries: Partial<RunEntry>[]): RunRecord {
  return {
    at: new Date().toISOString(),
    session,
    agent: "ci",
    commit: null,
    dirty: false,
    instrument: { language: "typescript", server: "cold" },
    latency: 1,
    invariants: entries.map((e) => ({ component: ".", name: "door", form: "chokepoint", verdict: "pass", refutation: "automatic", bypasses: [], testReferences: 0, files: [], latency: 1, reason: "every reference is inside", ...e })),
  };
}

const SPEC = (name: string) => `# ${name}\n\nThe ${name} product.\n\n## invariants\n- ${name} door: ROWS leave only through door.\n  protects: ROWS\n  chokepoint: door\n  because: a fixture\n  kinds: none\n`;

test("ci report carries each project's problems, chokepoint verdicts, spec gaps and guard failures as Markdown, and fails only when Coherence did not finish", async () => {
  const top = repository({
    "coherence.config.json": JSON.stringify({ projects: ["products/a", "products/b"], language: "typescript" }),
    "products/a/A.spec.md": SPEC("a"),
    "products/b/B.spec.md": SPEC("b"),
    "products/b/Extra.spec.md": "# extra\n",
  });
  const a = join(top, "products/a");
  const b = join(top, "products/b");
  appendRun(a, record("ci-7", [{ name: "a door" }]));
  appendRun(b, record("ci-7", [{ name: "b door", verdict: "fail", grade: "broken", reason: "1 reference to ROWS outside door: src/leak.ts:3 in leak", bypasses: [{ file: "src/leak.ts", line: 3, symbol: "leak" }] }]));
  appendRun(b, record("someone-else", [{ name: "b door" }]));
  const gaps: GapReader = async (root) =>
    root === a
      ? { gaps: [{ component: ".", name: "webhook", specPath: "A.spec.md", handler: "hook in src/hook.ts", file: "src/hook.ts", trust: ["outside"], route: { id: "r", first: "webhook", entrances: 1, stops: [".", "store"] } }] }
      : { unread: "the language server never answered" };

  const report = await buildReport(top, "ci-7", gaps);
  const md = report.markdown;
  assert.ok(md.startsWith(`${REPORT_MARKER}\n## Coherence\n`), "the marker the workflow finds its comment by comes first");
  assert.match(md, /\*\*1 spec problem · 1 failing chokepoint · 1 spec gap · 0 guard failures\*\* across 2 projects/);
  assert.match(md, /### products\/a[\s\S]*✓ `a door` reference-choked|### products\/a[\s\S]*✓ `a door` pass/);
  assert.match(md, /### products\/b[\s\S]*\*\*Spec problems\*\* \(spec --check in products\/b\)\n\n- `Extra\.spec\.md:1` a folder holds one spec/);
  assert.match(md, /✕ `b door` broken: 1 reference to ROWS outside door: src\/leak\.ts:3 in leak\n {2}- bypass `src\/leak\.ts:3` in leak/);
  assert.match(md, /\*\*Spec gaps:\*\* 1 entrance with outside or unknown trust and no traced control\n\n- `A\.spec\.md` entrance webhook \(trust outside\): \. -\\> store/);
  assert.match(md, /\*\*Spec gaps:\*\* not read: the language server never answered\./, "a gap reading that failed is said, never shown as none");
  assert.deepEqual(report.unfinished, [], "findings alone leave the report finished");
  assert.doesNotMatch(md, /someone-else|\[!WARNING\]/, "only the CI session's run is read");

  const missing = capture(top);
  assert.equal(await ciReportCommand(["--session", "ci-8"], missing.io, gaps), 1, "no run of the session: Coherence did not finish");
  assert.match(missing.out.join("\n"), /> \[!WARNING\]\n> Coherence did not finish[\s\S]*> - no chokepoint run of session ci-8 in products\/a/);

  appendRun(a, record("ci-9", [{ name: "a door", verdict: "not run", reason: "the instrument never answered" }]));
  appendRun(b, record("ci-9", [{ name: "b door" }]));
  const notRun = await buildReport(top, "ci-9", gaps);
  assert.deepEqual(notRun.unfinished, ["chokepoint a door in products/a was not run: the instrument never answered"]);

  assert.equal(await ciReportCommand([], capture(top).io, gaps), 64, "the session is required");

  // A guard failure is the defect floor's: a defect in a class a witnessed guard already closed.
  const model = loadSpecModel(a);
  model.defects = { recorded: 2, closed: 1, guarded: 1, decided: 0, unguarded: [], undeclared: [], guardFailures: [{ id: "df-2", class: "bypass", guard: "products/a/a door", guardedBy: "df-1", resolution: "rs-1" }] };
  const guarded = renderReport([{ name: ".", model, runs: [record("ci-7", [{ name: "a door" }])], gaps: { gaps: [] }, baselined: new Set() }], "ci-7", undefined);
  assert.match(guarded.markdown, /0 spec gaps · 1 guard failure\*\*/);
  assert.match(guarded.markdown, /\*\*Guard failures:\*\* 1\n\n- df-2 in class bypass, which products\/a\/a door has guarded since rs-1 closed df-1/);
  assert.doesNotMatch(guarded.markdown, /^### /m, "one project at the root needs no heading");
});

test("run at a registry's top runs each listed project from its own folder, its records in each", async () => {
  const top = repository({
    "coherence.config.json": JSON.stringify({ projects: ["products/a", "products/b"], language: "typescript" }),
    "products/a/A.spec.md": SPEC("a"),
    "products/a/src/door.ts": "export const ROWS = [1];\nexport function door(): number[] { return ROWS; }\n",
    "products/b/B.spec.md": SPEC("b"),
    "products/b/src/door.ts": "export const ROWS = [1];\nexport function door(): number[] { return ROWS; }\nexport const leak = (): number[] => ROWS;\n",
    "products/stray/Stray.spec.md": SPEC("stray"),
  });
  try {
    const ran = await cli(["run", "--form", "chokepoint", "--no-server", "--session", "ci-1", "--agent", "ci"], { cwd: top });
    assert.equal(ran.status, 1, "b's bypass fails the run at the top");
    assert.match(ran.stdout, /^project products\/a:\n {2}\.\/a door\n[\s\S]*^project products\/b:\n {2}\.\/b door\n {4}chokepoint door protects ROWS: broken/m);
    assert.doesNotMatch(ran.stdout, /stray/, "a folder the registry does not list is not run");
    assert.ok(!existsSync(join(top, ".coherence")), "nothing is recorded at the top");
    for (const leaf of ["products/a", "products/b"]) assert.ok(sessionFiles(join(top, leaf, ".coherence", "runs"), "ci-1").length > 0, `${leaf} keeps its own run`);

    const report = await buildReport(top, "ci-1", async () => ({ gaps: [] }));
    assert.deepEqual(report.unfinished, [], "the report finds each project's run of the session");
    assert.match(report.markdown, /1 failing chokepoint/);
  } finally {
    await stopWarmServers(top);
  }
});
