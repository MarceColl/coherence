/**
 * Every walk of the project leaves a folder out only by a named rule
 * (exclusionOf), never by its name alone. A git fixture carries code in
 * folders a name list once skipped (api/public, dist, build, public) beside
 * the folders a rule does leave out: the config's ignore list, a hidden
 * folder, a host's folder, a dependency install, an interpreter's cache and
 * a virtual environment, Cargo's build folder (a target beside a
 * Cargo.toml; a folder named target elsewhere is code), and the folders the
 * go command never builds (a vendor beside a go.mod, a testdata or
 * `_`-prefixed folder inside a Go module; outside one they are code). Every walker must read exactly what the one rule
 * leaves in, narrowed only by kind, and the rule must account for every
 * project file it leaves out.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, test } from "node:test";
import { goSkipped, projectFiles, walkBounds, walkedProjectFiles } from "./project-files.ts";
import { pythonFiles } from "./python.ts";
import { readEnforcementConfig } from "../enforcement/config.ts";
import { sourceFiles } from "../economy/source.ts";
import { collectFiles } from "../lifecycle/check.ts";
import { loadLexicon } from "../lifecycle/lexicon.ts";
import { COHERENCE_LEXICON } from "../lifecycle/project.ts";
import { findSpecs } from "../spec/model.ts";
import { detectedEntrances } from "../readings/scope/component-interfaces.ts";

const IGNORE = ["vendor"];

/** Code a folder-name list once skipped: every walk must read it. */
const NAMED_FOLDER_CODE = ["api/public/urls.py", "api/public/views.py", "dist/tool.py", "build/steps.py", "public/page.ts", "target/plan.py", "testdata/case.py", "_build/step.py"];

/** Files a rule leaves out, with the rule that must name it. */
const LEFT_OUT: Record<string, string> = {
  "vendor/lib.py": "config ignore: vendor",
  ".github/scripts/release.py": "hidden folder: .github",
  ".claude/hooks/hook.py": "host folder: .claude",
  "node_modules/pkg/index.ts": "environment folder: node_modules",
  "pkg/__pycache__/cached.py": "environment folder: pkg/__pycache__",
  "env/lib/site.py": "virtual environment: env",
  "crate/target/debug/generated.py": "Cargo build folder: crate/target",
  "gomod/testdata/fixture.py": "Go test data folder: gomod/testdata",
  "gomod/pkg/_scratch/tool.py": "Go-ignored folder: gomod/pkg/_scratch",
};

let root: string;

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "coherence-walks-"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0, "git init");
  write("coherence.config.json", JSON.stringify({ language: "python", ignore: IGNORE }));
  write("api/public/Public.spec.md", "# Public\n\nThe routes anyone on the network may call.\n");
  write("api/public/urls.py", 'from django.urls import path\nfrom . import views\n\nurlpatterns = [\n    path("healthcheck/", views.healthcheck),\n]\n');
  write("api/public/views.py", "def healthcheck(request):\n    return None\n");
  write("dist/tool.py", "def tool():\n    return None\n");
  write("build/steps.py", "def steps():\n    return None\n");
  write("public/page.ts", "export const page = 1;\n");
  write("target/plan.py", "def plan():\n    return None\n");
  write("crate/Cargo.toml", '[package]\nname = "crate"\nversion = "0.1.0"\n');
  write("testdata/case.py", "def case():\n    return None\n");
  write("_build/step.py", "def step():\n    return None\n");
  write("gomod/go.mod", "module example.com/gomod\n\ngo 1.22\n");
  write("env/pyvenv.cfg", "home = /usr/bin\n");
  for (const file of Object.keys(LEFT_OUT)) write(file, file.endsWith(".ts") ? "export const x = 1;\n" : "def x():\n    return None\n");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("every walk reads what the one rule leaves in: a folder is left out only by a named rule, never by its name alone", async () => {
  // The rule accounts for every project file: what it reads and what it leaves out, with the rule, are exactly projectFiles.
  const walked = walkedProjectFiles(walkBounds(root, IGNORE));
  const all = projectFiles(root);
  assert.deepEqual([...walked.files, ...walked.excluded.map((e) => e.file)].sort(), all);
  for (const file of NAMED_FOLDER_CODE) assert.ok(walked.files.includes(file), `${file} is read: ${walked.files.join(", ")}`);
  for (const [file, reason] of Object.entries(LEFT_OUT)) {
    assert.deepEqual(walked.excluded.find((e) => e.file === file), { file, reason }, `${file} is left out by its rule`);
  }
  // The config's ignore list names vendor, so Go's vendor rule is read on its own: by its place beside a go.mod, never by its name.
  assert.equal(goSkipped(root, "gomod/vendor"), "Go vendor folder");
  assert.equal(goSkipped(root, "vendor"), undefined, "a vendor folder beside no go.mod is no Go vendor folder");

  // Every code walk reads the rule's files, narrowed by kind alone.
  assert.deepEqual(sourceFiles(root, "python", IGNORE), walked.files.filter((f) => f.endsWith(".py")));
  assert.deepEqual(sourceFiles(root, "typescript", IGNORE), walked.files.filter((f) => f.endsWith(".ts")));
  const unbounded = walkedProjectFiles(walkBounds(root, []));
  assert.deepEqual(pythonFiles(root), unbounded.files.filter((f) => f.endsWith(".py")));
  assert.deepEqual(findSpecs(root, IGNORE).map((p) => relative(root, p)), ["api/public/Public.spec.md"]);

  // Entrance detection reads the bounded files too: the route in api/public is found.
  const testFolders = readEnforcementConfig(root).testFolders;
  const entrances = detectedEntrances(root, { components: [] }, "python", testFolders, IGNORE);
  assert.ok(entrances.some((e) => e.file === "api/public/urls.py"), `the api/public route is detected: ${JSON.stringify(entrances.map((e) => e.file))}`);

  // The vocabulary check reads hidden folders other than the hosts', and leaves out the rest by the same rules.
  const corpus = await collectFiles({ root, coherence: await loadLexicon(COHERENCE_LEXICON) });
  const read = new Set(corpus.files.map((p) => relative(root, p)));
  for (const file of [...NAMED_FOLDER_CODE.filter((f) => f.endsWith(".py") || f.endsWith(".ts")), ".github/scripts/release.py"]) assert.ok(read.has(file), `the vocabulary check reads ${file}`);
  for (const file of Object.keys(LEFT_OUT).filter((f) => !f.startsWith(".github/"))) assert.ok(!read.has(file), `the vocabulary check leaves out ${file}`);
});
