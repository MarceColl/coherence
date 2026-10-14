/**
 * The parts of the seam that need no instrument: how a spec value reads,
 * and which paths are tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isTestPath, parseName, rangeContains } from "./adapter.ts";
import { PYTHON_LADDER, PythonAdapter, ruleCovers, rulesNaming, type CheckerFacts } from "./python.ts";
import { GO_LADDER } from "./go.ts";
import { RUST_LADDER } from "./rust.ts";
import { TYPESCRIPT_LADDER } from "./typescript.ts";

test("a spec value reads as a bare symbol, a symbol in a file, a module path, or prose", () => {
  assert.deepEqual(parseName("writeClass"), { form: "symbol", name: "writeClass", fileHint: undefined });
  assert.deepEqual(parseName("KERNEL_WRITE_POLICY in policy.ts"), { form: "symbol", name: "KERNEL_WRITE_POLICY", fileHint: "policy.ts" });
  assert.deepEqual(parseName("seal in entities/Hive/policy.ts"), { form: "symbol", name: "seal", fileHint: "entities/Hive/policy.ts" });
  assert.deepEqual(parseName("entities/Hive/policy.ts"), { form: "module", path: "entities/Hive/policy.ts" });
  assert.equal(parseName("the kernel tables (KERNEL_TABLES) reached through data.ts").form, "prose");
  assert.equal(parseName("IMMUTABLE and IMMUTABLE_AFTER_CREATE in kernel.ts").form, "prose");
  // A spec name can never resolve outside the project root: agent-authored text is never trusted about itself.
  assert.equal(parseName("../../../etc/passwd.txt").form, "prose");
  assert.equal(parseName("src/../../secrets/keys.ts").form, "prose");
  assert.equal(parseName("/etc/hosts.conf").form, "prose");
  assert.equal(parseName("src//double.ts").form, "prose");
  assert.deepEqual(parseName("src/store/..secrets.ts"), { form: "module", path: "src/store/..secrets.ts" }, "a leading pair of dots in a name is not a parent segment");
});

test("a path is a test when a configured folder is a segment or the file is named .test or .spec", () => {
  const folders = ["__tests__", "tests"];
  assert.equal(isTestPath("src/__tests__/policy.test.ts", folders), true);
  assert.equal(isTestPath("src/policy.test.ts", folders), true);
  assert.equal(isTestPath("src/policy.spec.ts", folders), true);
  assert.equal(isTestPath("src/tests/helper.ts", folders), true, "a configured folder marks a path whatever the file is called");
  assert.equal(isTestPath("src/policy.ts", folders), false);
  assert.equal(isTestPath("store/store_test.go", folders), true, "a Go test file ends with _test.go");
  assert.equal(isTestPath("store/latest.go", folders), false);
  assert.equal(isTestPath("tests-helpers/policy.ts", folders), false, "a folder name matches whole, not as a prefix");
});

test("rangeContains is inclusive at both ends", () => {
  const range = { start: { line: 2, character: 4 }, end: { line: 5, character: 1 } };
  assert.equal(rangeContains(range, { line: 2, character: 4 }), true);
  assert.equal(rangeContains(range, { line: 5, character: 1 }), true);
  assert.equal(rangeContains(range, { line: 5, character: 2 }), false);
  assert.equal(rangeContains(range, { line: 1, character: 40 }), false);
});

test("the grade ladder's top rung is adapter-defined: TypeScript, Rust and Go enforce visibility, Python does not", () => {
  assert.equal(TYPESCRIPT_LADDER.top, "visibility-choked");
  assert.equal(RUST_LADDER.top, "visibility-choked");
  assert.deepEqual(RUST_LADDER.rungs.map((r) => r.grade), ["visibility-choked", "reference-choked"]);
  assert.equal(RUST_LADDER.rungs.find((r) => r.grade === "visibility-choked")!.enforcer, "the compiler (rustc)");
  assert.equal(RUST_LADDER.whenVacuous, undefined);
  assert.equal(GO_LADDER.top, "visibility-choked");
  assert.deepEqual(GO_LADDER.rungs.map((r) => r.grade), ["visibility-choked", "reference-choked"]);
  assert.equal(GO_LADDER.rungs.find((r) => r.grade === "visibility-choked")!.enforcer, "the compiler (go build)");
  assert.equal(GO_LADDER.whenVacuous, undefined);
  assert.equal(PYTHON_LADDER.top, "reference-choked");
  assert.match(PYTHON_LADDER.because, /convention/);
  assert.deepEqual(TYPESCRIPT_LADDER.rungs.map((r) => r.grade), ["visibility-choked", "reference-choked"]);
  assert.deepEqual(PYTHON_LADDER.rungs.map((r) => r.grade), ["closure-choked", "checker-choked", "reference-choked", "convention"]);
  assert.equal(PYTHON_LADDER.rungs.find((r) => r.grade === "closure-choked")!.enforcer, "the interpreter");
  assert.equal(PYTHON_LADDER.rungs.find((r) => r.grade === "convention")!.enforcer, "nobody");
  assert.equal(PYTHON_LADDER.whenVacuous, "convention", "a Python chokepoint whose refutation is vacuous stands on the convention alone");
  assert.equal(TYPESCRIPT_LADDER.whenVacuous, undefined);
  assert.ok(new PythonAdapter("/nowhere").ladder === PYTHON_LADDER);
});

test("a spec value with a trailing slash reads as a package module, and pytest file names are test paths", () => {
  assert.deepEqual(parseName("posthog/query_cache/"), { form: "module", path: "posthog/query_cache" });
  assert.equal(parseName("../x/").form, "prose");
  assert.equal(isTestPath("posthog/query_cache/test_storage.py", []), true);
  assert.equal(isTestPath("posthog/query_cache/storage_test.py", []), true);
  assert.equal(isTestPath("posthog/query_cache/storage.py", []), false);
  assert.equal(isTestPath("posthog/query_cache/test/test_storage.py", ["test"]), true);
});

test("the project's checkers are read from its configuration: Pyright's private-usage rule, mypy's presence, import-linter rules", () => {
  assert.equal(ruleCovers("products.*.backend", "products.alerts.backend.presentation.views"), true);
  assert.equal(ruleCovers("products.**", "products.alerts.backend"), true);
  assert.equal(ruleCovers("posthog.query_cache", "posthog.query_cache.storage"), true);
  assert.equal(ruleCovers("posthog.query_cache", "posthog.caching.storage"), false);
  const facts: CheckerFacts = { pyrightConfig: undefined, privateUsageIsError: false, mypyConfig: undefined, importLinterConfig: "pyproject.toml [tool.importlinter]", importRules: [{ name: "presentation must use facade", text: 'source_modules = ["products.*.backend.presentation"]\nforbidden_modules = [\n    "products.*.backend",\n]' }] };
  assert.deepEqual(rulesNaming(facts, "products.alerts.backend.models"), ["presentation must use facade"]);
  assert.deepEqual(rulesNaming(facts, "posthog.query_cache.storage"), []);
});
