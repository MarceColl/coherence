/**
 * One project in two languages: a Python backend/ and a TypeScript
 * frontend/ under one component, a chokepoint invariant in each, and a
 * totality oracle in each, its test run by pytest (from backend/) or by
 * node:test. Each chokepoint resolves and grades through its own language's
 * warm server, each server is reached only when a check needs it, each
 * totality oracle's test runs through the setup whose test files hold it,
 * and the run's record says which language answered each entry. A
 * single-language config reads exactly as it always did.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { editContext } from "../lifecycle/hook.ts";
import { isSourceFile } from "../economy/source.ts";
import { DEFAULT_TEST_FOLDERS, languageOfFile, readEnforcementConfig, setupClaims } from "./config.ts";
import { loadRuns } from "./record.ts";
import { performRun } from "./run.ts";
import { languageSlot, serve, serverPaths, type Serving } from "./server.ts";

const PYTHON = process.env["COHERENCE_PYTHON"] || fileURLToPath(new URL("../../.venv/bin/python", import.meta.url));
const REPORTER = fileURLToPath(new URL("./node-test-reporter.ts", import.meta.url));

const SPEC = `# Mixed

A product with a Python backend and a TypeScript frontend, one component.

## trust levels
- storage: the rows beneath everything
- public-egress: what leaves in the clear

## invariants
- python egress: A secret column leaves the store only through seal.
  protects: SECRET_COLUMNS
  chokepoint: seal
  because: a leaked row must disclose no usable bearer
  kinds: none
- typescript egress: A raw token leaves the client only through redact.
  protects: RAW_TOKENS
  chokepoint: redact
  because: a rendered page must disclose no usable bearer
  kinds: none
- python totality: Every secret column is stripped.
  over: every column in SECRET_COLUMNS
  via: test_seal_strips
  because: a spot check is not enforcement
  kinds: none
- typescript totality: Every raw token is redacted.
  over: every token in RAW_TOKENS
  via: redact strips every token
  because: a spot check is not enforcement
  kinds: none
`;

const FILES: Record<string, string> = {
  "Mixed.spec.md": SPEC,
  "tsconfig.json": `{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "noEmit": true, "allowImportingTsExtensions": true }, "include": ["frontend/**/*.ts"] }\n`,
  "backend/store.py": `SECRET_COLUMNS = {"tokens": ["token"]}


def seal(pattern: str, row: dict) -> dict:
    out = dict(row)
    for column in SECRET_COLUMNS.get(pattern, []):
        out.pop(column, None)
    return out
`,
  "backend/render.py": `from store import seal


def render(row: dict) -> str:
    return str(seal("tokens", row))
`,
  "backend/test_store.py": `from store import seal


def test_seal_strips():
    assert "token" not in seal("tokens", {"token": 1})
`,
  "frontend/tokens.ts": `export const RAW_TOKENS: string[] = ["a", "b"];

export function redact(text: string): string {
  let out = text;
  for (const token of RAW_TOKENS) out = out.split(token).join("*");
  return out;
}
`,
  "frontend/view.ts": `import { redact } from "./tokens.ts";

export const shown = redact("abc");
`,
  "frontend/tokens.test.ts": `import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "./tokens.ts";

test("redact strips every token", () => {
  assert.equal(redact("abc"), "**c");
});
`,
};

/** Python first: the primary language, whose server keeps the plain names. */
const CONFIG = {
  name: "mixed",
  language: ["python", "typescript"],
  tests: [
    {
      language: "python",
      cwd: "backend",
      test: [PYTHON, "-m", "pytest", "-q", "-p", "no:cacheprovider", "test_store.py", "-k"],
      testJson: [PYTHON, "-m", "pytest", "-q", "-p", "no:cacheprovider", "test_store.py", "-k", "{filter}", "--junitxml={out}"],
      testFilterForm: "pytest",
    },
    {
      language: "typescript",
      test: "node --disable-warning=ExperimentalWarning --test --test-name-pattern={filter} frontend/tokens.test.ts",
      testMatch: "# pass [1-9][0-9]*",
      testJson: ["node", "--disable-warning=ExperimentalWarning", "--test", `--test-reporter=${REPORTER}`, "--test-reporter-destination={out}", "--test-name-pattern={filter}", "frontend/tokens.test.ts"],
    },
  ],
};

let root: string;
const servings: Serving[] = [];

function project(files: Record<string, string>, config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "coherence-languages-"));
  for (const [path, text] of Object.entries({ ...files, "coherence.config.json": JSON.stringify(config, null, 2) })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text, "utf8");
  }
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
}

before(() => {
  root = project(FILES, CONFIG);
});

after(async () => {
  for (const serving of servings) await serving.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a single-language config reads as it always did: one language, one test setup from the single keys, the plain server names", () => {
  const dir = mkdtempSync(join(tmpdir(), "coherence-languages-one-"));
  try {
    writeFileSync(join(dir, "coherence.config.json"), JSON.stringify({ language: "python", test: "pytest -k {filter}", testMatch: "passed", testFilterForm: "pytest", testDir: "checks" }));
    const config = readEnforcementConfig(dir);
    assert.equal(config.language, "python");
    assert.deepEqual(config.languages, ["python"]);
    assert.equal(config.tests.length, 1, "the single keys are one setup");
    assert.equal(config.tests[0]!.test, config.test);
    assert.equal(config.tests[0]!.testFilterForm, "pytest");
    assert.equal(config.tests[0]!.cwd, undefined, "a single setup runs at the root");
    assert.deepEqual(config.testFolders, [...DEFAULT_TEST_FOLDERS, "checks"]);
    assert.equal(languageSlot(dir, "python"), undefined, "the one language's server keeps the plain names");
    assert.ok(serverPaths(dir).pointer.endsWith("/server.json") && serverPaths(dir).lock.endsWith("/server.lock"));
    writeFileSync(join(dir, "coherence.config.json"), JSON.stringify({}));
    assert.deepEqual(readEnforcementConfig(dir).languages, ["typescript"], "no language is TypeScript, as before");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a multi-language config lists its languages and test setups; a file's language is its extension; a malformed setup is refused by name", () => {
  const config = readEnforcementConfig(root);
  assert.deepEqual(config.languages, ["python", "typescript"]);
  assert.equal(config.language, "python", "the first listed is the primary");
  assert.equal(config.tests.length, 2);
  assert.equal(config.tests[0]!.cwd, "backend");
  assert.equal(config.test, config.tests[0]!.test, "the single keys read as the first setup");
  assert.equal(languageOfFile("backend/store.py", config.languages), "python");
  assert.equal(languageOfFile("frontend/view.tsx", config.languages), "typescript");
  assert.equal(languageOfFile("frontend/types.d.ts", config.languages), undefined);
  assert.equal(languageOfFile("frontend/view.ts", ["python"]), undefined, "a language the project does not list is no file's");
  assert.equal(languageOfFile("backend/store.pyi"), "python", "a stub is Python's");
  // A reader that reads fewer of a language's files narrows languageOfFile, never answers on its own.
  assert.ok(isSourceFile("backend/store.py", "python") && !isSourceFile("backend/store.pyi", "python") && !isSourceFile("frontend/view.tsx", "python"));
  assert.ok(isSourceFile("frontend/view.tsx", "typescript") && !isSourceFile("frontend/view.js", "typescript") && !isSourceFile("frontend/types.d.ts", "typescript"));
  assert.equal(languageOfFile("crates/kernel/src/lib.rs", ["python", "typescript", "rust"]), "rust");
  assert.equal(languageOfFile("crates/kernel/src/lib.rs", config.languages), undefined, "a Rust file is no language's in a project that does not list Rust");
  assert.equal(languageOfFile("services/store/store.go", ["python", "typescript", "go"]), "go");
  assert.equal(languageOfFile("services/store/store.go", config.languages), undefined, "a Go file is no language's in a project that does not list Go");
  assert.ok(setupClaims(config.tests[0]!, "backend/test_store.py") && !setupClaims(config.tests[0]!, "frontend/tokens.test.ts"));
  assert.ok(setupClaims({ ...config.tests[1]!, files: ["frontend/**/*.test.ts"] }, "frontend/a/b.test.ts"));
  assert.equal(languageSlot(root, "typescript"), "typescript");
  assert.ok(serverPaths(root, "typescript").pointer.endsWith("/server-typescript.json"));

  const bad = mkdtempSync(join(tmpdir(), "coherence-languages-bad-"));
  try {
    const refused = (config: unknown, pattern: RegExp): void => {
      writeFileSync(join(bad, "coherence.config.json"), JSON.stringify(config));
      assert.throws(() => readEnforcementConfig(bad), pattern);
    };
    refused({ language: ["python", "java"] }, /language lists "java"; each is one of typescript, python, rust, go/);
    refused({ tests: [{ language: "python" }] }, /tests\[0\] names neither test nor testJson/);
    refused({ tests: [{ test: "pytest", cwd: "/abs" }] }, /tests\[0\]\.cwd is a folder relative to the project root/);
    refused({ tests: [{ test: "pytest", language: "java" }] }, /tests\[0\]\.language is one of/);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});

test("each totality oracle's test runs through the setup whose test files hold it, one batched invocation per setup, from the setup's own folder", { timeout: 120_000 }, async () => {
  // The runner under test is node:test itself: its child must not report to this test's parent.
  const context = process.env["NODE_TEST_CONTEXT"];
  delete process.env["NODE_TEST_CONTEXT"];
  try {
    const outcome = await performRun(root, { session: "totality", agent: "languages", form: "totality oracle" });
    const byName = Object.fromEntries(outcome.record.invariants.map((e) => [e.name, e]));
    assert.equal(byName["python totality"]?.verdict, "pass", byName["python totality"]?.reason);
    assert.equal(byName["python totality"]?.mode, "batched");
    assert.equal(byName["python totality"]?.language, "python");
    assert.match(byName["python totality"]!.reason, /pytest/, "the pytest setup ran it");
    assert.equal(byName["typescript totality"]?.verdict, "pass", byName["typescript totality"]?.reason);
    assert.equal(byName["typescript totality"]?.mode, "batched");
    assert.equal(byName["typescript totality"]?.language, "typescript");
    assert.match(byName["typescript totality"]!.reason, /node .*--test/, "the node:test setup ran it");
    assert.ok(outcome.record.batch !== undefined, "the batched invocations are timed");
    assert.deepEqual(outcome.record.instrument, { language: "python", server: "none" }, "a totality pass reaches no instrument");

    // Each one alone, through the same setup.
    const each = await performRun(root, { session: "totality-each", agent: "languages", form: "totality oracle", each: true });
    assert.deepEqual(each.each?.details.map((d) => `${d.entry.name} ${d.entry.verdict} ${d.entry.language}`).sort(), ["python totality pass python", "typescript totality pass typescript"]);
  } finally {
    if (context !== undefined) process.env["NODE_TEST_CONTEXT"] = context;
  }
});

test("each chokepoint resolves and grades through its own language's warm server, and a run or an edit reaches only the languages its checks need", { timeout: 180_000 }, async () => {
  // The servers run in this process (spawned ones would outlive the test); the run connects to them as it would to detached ones.
  servings.push(await serve(root, { language: "python", idleMs: 120_000 }));
  servings.push(await serve(root, { language: "typescript", idleMs: 120_000 }));
  const pointer = (file: string): { language: string } => JSON.parse(readFileSync(file, "utf8")) as { language: string };
  assert.equal(pointer(serverPaths(root).pointer).language, "python", "the primary language's server keeps the plain pointer");
  assert.equal(pointer(serverPaths(root, "typescript").pointer).language, "typescript", "the other language's server has its own");

  const outcome = await performRun(root, { session: "chokepoints", agent: "languages", form: "chokepoint" });
  assert.equal(outcome.instrumentReason, undefined, outcome.instrumentReason);
  const byName = Object.fromEntries(outcome.record.invariants.map((e) => [e.name, e]));
  const python = byName["python egress"]!;
  const typescript = byName["typescript egress"]!;
  assert.equal(python.language, "python");
  assert.equal(python.verdict, "pass", python.reason);
  assert.ok(python.files.includes("backend/store.py"), `graded on the Python files: ${python.files.join(", ")}`);
  assert.equal(typescript.language, "typescript", "the component holds both languages: Python could not find RAW_TOKENS, TypeScript could");
  assert.equal(typescript.verdict, "pass", typescript.reason);
  assert.ok(typescript.files.includes("frontend/tokens.ts"), `graded on the TypeScript files: ${typescript.files.join(", ")}`);
  assert.ok(python.grade !== undefined && typescript.grade !== undefined, "each is graded on its language's ladder");
  assert.equal(outcome.record.instrument.language, "python+typescript");
  assert.deepEqual(outcome.record.instrument.languages?.map((l) => l.language), ["python", "typescript"]);

  // One invariant, one language: the latest run names its language, and only that server is asked.
  const one = await performRun(root, { session: "one", agent: "languages", form: "chokepoint", invariants: ["typescript egress"] });
  assert.deepEqual(one.record.instrument, { language: "typescript", server: "warm" }, "the run asked the TypeScript server alone");
  assert.equal(one.record.invariants[0]!.verdict, "pass");

  // An edit to a frontend file re-checks the invariant it may involve through the TypeScript server alone.
  const said = await editContext(root, { cwd: root, session_id: "edit", tool_name: "Edit", tool_input: { file_path: join(root, "frontend/view.ts") } });
  assert.equal(said, "", "a clean edit says nothing");
  const edit = loadRuns(root).records.filter((r) => r.session === "edit");
  assert.equal(edit.length, 1, "the edit-time check was recorded");
  assert.deepEqual(edit[0]!.instrument, { language: "typescript", server: "warm" });
  assert.deepEqual(edit[0]!.invariants.map((e) => `${e.name} ${e.language}`), ["typescript egress typescript"]);
  assert.ok(!existsSync(join(root, ".coherence", "run", "server-python.json")), "no second Python server under another name: Python is the primary");
});
