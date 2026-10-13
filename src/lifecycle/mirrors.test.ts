import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runHook } from "./hook.ts";
import { lastHookWork } from "./work-meter.ts";
import { keepMirrorIndex, literalOf, mirrorAlarm, readMirrorIndex, valueImports } from "./mirrors.ts";
import { loadSpecModel } from "../spec/model.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * The shape b37627e broke: a hand list of the Scope page's modules, the
 * closure of page.ts, and beside it two literals kept equal by hand.
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "coherence-mirrors-"));
  made.push(root);
  const files: Record<string, string> = {
    "coherence.config.json": JSON.stringify({ name: "mirrors" }),
    "src/scope/Scope.spec.md": [
      "# Scope",
      "",
      "The page.",
      "",
      "## mirrors",
      "- BROWSER_SOURCES in build.ts: the modules the browser bundle joins",
      "  mirrors: closure of page.ts",
      "- SUMMARY_EVENTS in summary.ts: the hook events a summary may name",
      "  mirrors: HOOK_EVENTS in events.ts",
      "- RULE_NAMES in summary.ts: the rules a plural is kept for",
      "  mirrors: keys of RULE_PLURALS in events.ts",
      "",
      "## invariants",
      "",
    ].join("\n"),
    "src/scope/build.ts": [
      "/** The browser bundle, in dependency order. */",
      "export const BROWSER_SOURCES = [",
      '  "model.ts",',
      '  "structure-flow.ts",',
      '  "page.ts",',
      "];",
      "",
    ].join("\n"),
    "src/scope/page.ts": 'import { flow } from "./structure-flow.ts";\nexport const page = flow;\n',
    "src/scope/structure-flow.ts": 'import { model } from "./model.ts";\nexport const flow = model;\n',
    "src/scope/model.ts": "export const model = 1;\n",
    "src/scope/languages-read.ts": "export const languages = [];\n",
    "src/scope/types.ts": "export type Shape = string;\n",
    "src/scope/summary.ts": [
      "// Kept apart from events.ts so the flush stays light.",
      'export const SUMMARY_EVENTS = ["SessionStart", "Stop"] as const;',
      'export const RULE_NAMES: ReadonlySet<string> = new Set(["route", "task"]);',
      "",
    ].join("\n"),
    "src/scope/events.ts": [
      'export const HOOK_EVENTS = ["SessionStart", "Stop"] as const;',
      'export const RULE_PLURALS: Record<string, string> = { route: "routes", "task": "tasks" };',
      "",
    ].join("\n"),
    "src/other.ts": "export const other = 1;\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function edit(root: string, file: string, text: string): Promise<{ context: string; exit: number; commit?: () => void }> {
  writeFileSync(join(root, file), text);
  return runHook("PostToolUse", { cwd: root, session_id: "s-mirror", tool_name: "Edit", tool_input: { file_path: join(root, file) } }, root).then((result) => {
    const context = result.stdout.trim() === "" ? "" : ((JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "");
    result.commit?.();
    return { context, exit: result.exit, ...(result.commit === undefined ? {} : { commit: result.commit }) };
  });
}

test("an edit that gives a closure file a value import its mirror omits names the file and the list's line, as advice", async () => {
  const root = project();
  keepMirrorIndex(root);
  // A type-only import adds nothing to the closure: the bundle strips it.
  const typed = await edit(root, "src/scope/structure-flow.ts", 'import { model } from "./model.ts";\nimport type { Shape } from "./types.ts";\nexport const flow = model;\n');
  assert.equal(typed.context, "", "a type-only import is no member of the closure");
  const broke = await edit(root, "src/scope/structure-flow.ts", 'import { model } from "./model.ts";\nimport { languages } from "./languages-read.ts";\nexport const flow = [model, languages];\n');
  assert.equal(broke.exit, 0, "advice, never a block");
  assert.match(broke.context, /src\/scope\/structure-flow\.ts now imports src\/scope\/languages-read\.ts, which BROWSER_SOURCES \(src\/scope\/build\.ts:2\) does not name/);
  assert.match(broke.context, /closure of page\.ts/);
  assert.match(broke.context, /src\/scope\/Scope\.spec\.md:6/);
  // The file the closure grew by is watched from now on.
  assert.ok(readMirrorIndex(root)!.watch["src/scope/languages-read.ts"] !== undefined);
});

test("an edit that makes a list and its partner literal disagree names what each side holds alone, once per session", async () => {
  const root = project();
  keepMirrorIndex(root);
  const broke = await edit(root, "src/scope/events.ts", 'export const HOOK_EVENTS = ["SessionStart", "PostToolUse", "Stop"] as const;\nexport const RULE_PLURALS: Record<string, string> = { route: "routes", "task": "tasks" };\n');
  assert.match(broke.context, /SUMMARY_EVENTS \(src\/scope\/summary\.ts:2\) and HOOK_EVENTS \(src\/scope\/events\.ts:1\) no longer agree: "PostToolUse" only in HOOK_EVENTS/);
  assert.doesNotMatch(broke.context, /RULE_NAMES/, "the keys still agree");
  const again = await edit(root, "src/scope/events.ts", 'export const HOOK_EVENTS = ["SessionStart", "PostToolUse", "Stop"] as const;\n// touched\nexport const RULE_PLURALS: Record<string, string> = { route: "routes", "task": "tasks" };\n');
  assert.equal(again.context, "", "the same disagreement is said once per session");
  const keys = await edit(root, "src/scope/summary.ts", 'export const SUMMARY_EVENTS = ["SessionStart", "PostToolUse", "Stop"] as const;\nexport const RULE_NAMES: ReadonlySet<string> = new Set(["route", "task", "page route"]);\n');
  assert.match(keys.context, /RULE_NAMES \(src\/scope\/summary\.ts:2\) and the keys of RULE_PLURALS \(src\/scope\/events\.ts:3\) no longer agree: "page route" only in RULE_NAMES/);
  assert.doesNotMatch(keys.context, /SUMMARY_EVENTS/, "agreeing again is silent");
});

test("a mirror whose list is gone is said at the edit and is a spec problem, never skipped", async () => {
  const root = project();
  keepMirrorIndex(root);
  const gone = await edit(root, "src/scope/summary.ts", 'export const RULE_NAMES: ReadonlySet<string> = new Set(["route", "task"]);\n');
  assert.match(gone.context, /SUMMARY_EVENTS in summary\.ts cannot be checked: SUMMARY_EVENTS is no longer set to an array or object literal at the top of src\/scope\/summary\.ts/);
  const problems = loadSpecModel(root, { runs: false }).problems.map((p) => `${p.file}:${p.line} ${p.message}`);
  assert.ok(problems.some((p) => /Scope\.spec\.md:8 mirror SUMMARY_EVENTS: SUMMARY_EVENTS is not declared at the top level of src\/scope\/summary\.ts/.test(p)), problems.join("\n"));
});

test("an edit no mirror watches costs the alarm one lookup and reads no source", async () => {
  const root = project();
  keepMirrorIndex(root);
  writeFileSync(join(root, "src/other.ts"), "export const other = 2;\n");
  const started = performance.now();
  const alarm = mirrorAlarm(root, ["src/other.ts"], "s-cost");
  const unwatched = performance.now() - started;
  assert.equal(alarm.text, "");
  await edit(root, "src/other.ts", "export const other = 3;\n");
  const reads = lastHookWork()!.reads.filter((r) => /^source .*src\/scope\//.test(r));
  assert.deepEqual(reads, [], "no source a mirror names is read for an edit it does not watch");
  // A watched edit reads the list, its partner or the files that changed, and stays well under the tool hooks' budget.
  const at = performance.now();
  mirrorAlarm(root, ["src/scope/structure-flow.ts"], "s-cost");
  const watched = performance.now() - at;
  assert.ok(unwatched < 25 && watched < 250, `unwatched ${unwatched.toFixed(2)} ms, watched ${watched.toFixed(2)} ms`);
});

test("a literal is read without the compiler: an array's strings, a tuple by its first, an object's keys, through a wrapping call", () => {
  const text = [
    "export const A: readonly string[] = [\"a\", 'b', `c`, /* not */ \"d\" as const];",
    "const M = new Map([[\"k1\", 1], [\"k2\", 2]]);",
    "export const O = Object.freeze({ one: 1, \"two\": 2, three() { return 3; }, ...REST });",
    "export const ALIAS = A;",
    "function local() {",
    '  const ROWS = ["inner"];',
    "}",
    'export const ROWS: readonly { id: string; at: number }[] = /* the rows */ [{ id: "x", at: 1 }, ["first", 2]];',
  ].join("\n");
  assert.deepEqual(literalOf(text, "ROWS"), { line: 8, kind: "array", members: ["first"], unread: ['{ id: "x", at: 1 }'] }, "the top-level declaration, past a typed annotation and a comment; a record element is not read");
  assert.deepEqual(literalOf(text, "A"), { line: 1, kind: "array", members: ["a", "b", "c", "d"], unread: [] });
  assert.deepEqual(literalOf(text, "M")?.members, ["k1", "k2"]);
  assert.deepEqual(literalOf(text, "O"), { line: 3, kind: "object", members: ["one", "two", "three"], unread: ["...REST"] });
  assert.equal(literalOf(text, "ALIAS"), undefined, "a name set to another name is no literal");
  assert.deepEqual(
    valueImports('import a from "./a.ts";\nimport type { T } from "./t.ts";\nimport { type U, v } from "./v.ts";\nimport { type W } from "./w.ts";\nexport * from "./x.ts";\nexport type { Y } from "./y.ts";\nimport "./side.ts";\nconst z = await import("./z.ts");\nimport fs from "node:fs";\n// import q from "./q.ts";\n').sort(),
    ["./a.ts", "./side.ts", "./v.ts", "./x.ts", "./z.ts"],
  );
});

test("a declared name is matched as itself, every regular-expression character in it taken literally", () => {
  const text = "export const AxB = [\"a\", \"b\"];\nexport const A$B = [\"c\"];\n";
  assert.equal(literalOf(text, "A.B"), undefined, "a dot in a name never matches another character");
  assert.deepEqual(literalOf(text, "A$B")?.members, ["c"], "a dollar sign is the name's own");
});
