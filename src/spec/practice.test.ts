/**
 * Practices: the grammar of a practice file, its pairing with a spec, the
 * evidence it cites, the floor an enactment sets, the enact verb, and the
 * hook's delivery when a trigger fires.
 */

import assert from "node:assert/strict";
import { onlyFile } from "../journal/shard-fixture.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { commandMatches, firedBy, globMatches, parsePractices, type ToolUse } from "./practice.ts";
import { loadSpecModel, projectPractices } from "./model.ts";
import { journalVerbs, type Io } from "../journal/cli.ts";
import { appendRecord, loadJournal } from "../journal/store.ts";
import type { Enactment } from "../journal/record.ts";
import { runHook } from "../lifecycle/hook.ts";
import { installedEntry } from "../lifecycle/install.ts";
import { writersUnmatched } from "../lifecycle/host-tools.ts";
import { practiceAnswer, practiceOrientText, toolUseOf } from "../lifecycle/practice-delivery.ts";
import { scaffoldCommand } from "../scaffold/cli.ts";
import { stopWarmServers } from "../enforcement/server-fixture.ts";

const SPEC = "# Widget\n\nWidgets turn.\n\n## invariants\n- knob turns: The knob turns.\n  over: every knob\n  via: the knob turns\n  because: a stuck knob is a broken widget\n  kinds: none\n";

function practiceText(cite: string, extra = ""): string {
  return [
    "- oil the knob: A knob is oiled before it turns.",
    "  when: command turn-knob | edit src/widget/**/*.ts adding knob",
    "  step: wipe the knob",
    "  step: oil the knob",
    "    leaves: an oil record",
    "  step: turn it once",
    `  pitfall: a dry knob seized (${cite})`,
    "  invariants: knob turns",
    "  because: a dry knob seizes",
    extra,
  ].filter((l) => l !== "").join("\n") + "\n";
}

/** Every fixture project this file made: a stop hook among them starts a warm server, and each is removed after the tests. */
const projects: string[] = [];

after(async () => {
  for (const root of projects) {
    await stopWarmServers(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "coherence-practice-"));
  projects.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function clock(start = "2026-10-05T10:00:00.000Z"): () => Date {
  let tick = Date.parse(start);
  return () => new Date((tick += 1000));
}

function journal(root: string, now = clock()): (...argv: string[]) => { code: number; out: string[]; err: string[] } {
  return (...argv) => {
    const [verb, ...rest] = argv;
    const run = { code: 0, out: [] as string[], err: [] as string[] };
    const io: Io = { cwd: root, now, out: (l) => run.out.push(l), err: (l) => run.err.push(l) };
    run.code = journalVerbs[verb!]!(rest, io);
    return run;
  };
}

const WHO = ["--session", "s1", "--agent", "main"];

/** A project with one component, its practice file, and the decision its pitfall cites. */
function widget(extra = ""): { root: string; cite: string; run: ReturnType<typeof journal> } {
  const root = project({ "src/widget/Widget.spec.md": SPEC, "src/widget/knob.ts": "export const knob = 1;\n" });
  const run = journal(root);
  const decided = run("decide", "keep knobs oiled", "--because", "one seized", ...WHO);
  assert.equal(decided.code, 0, decided.err.join("\n"));
  const cite = decided.out[0]!.split(/\s+/)[0]!;
  writeFileSync(join(root, "src/widget/Widget.practice.md"), practiceText(cite, extra));
  return { root, cite, run };
}

test("a practice bullet parses into triggers, numbered steps with what each leaves, cited pitfalls, and a version that moves when a step does", () => {
  const parsed = parsePractices(practiceText("d-0000abcd"), "W.practice.md");
  assert.deepEqual(parsed.problems, []);
  const [p] = parsed.practices;
  assert.equal(p!.name, "oil the knob");
  assert.deepEqual(p!.triggers, [{ kind: "command", words: "turn-knob" }, { kind: "edit", glob: "src/widget/**/*.ts", adding: "knob" }]);
  assert.deepEqual(p!.steps.map((s) => [s.n, s.text, s.leaves]), [[1, "wipe the knob", undefined], [2, "oil the knob", "an oil record"], [3, "turn it once", undefined]]);
  assert.deepEqual(p!.pitfalls.map((pf) => pf.cites), [["d-0000abcd"]]);
  const moved = parsePractices(practiceText("d-0000abcd").replace("turn it once", "turn it twice"), "W.practice.md").practices[0]!;
  assert.notEqual(moved.version, p!.version, "a changed step is a new version");
  const reworded = parsePractices(practiceText("d-0000abcd").replace("a dry knob seizes", "dry knobs seize"), "W.practice.md").practices[0]!;
  assert.equal(reworded.version, p!.version, "the because is not part of the version");
});

test("a leaves: line belongs to the step above it whatever its indentation: four spaces, two, or a tab parse alike", () => {
  // Four spaces as the docs show it; two as a formatter such as oxfmt writes it back; a tab as an editor might.
  const parsed = ["    leaves:", "  leaves:", "\tleaves:"].map((indent) => parsePractices(practiceText("d-0000abcd").replace("    leaves:", indent), "W.practice.md"));
  for (const p of parsed) assert.deepEqual(p.problems, []);
  for (const p of parsed) assert.deepEqual(p.practices[0]!.steps.map((s) => [s.n, s.text, s.leaves]), [[1, "wipe the knob", undefined], [2, "oil the knob", "an oil record"], [3, "turn it once", undefined]]);
  assert.equal(new Set(parsed.map((p) => p.practices[0]!.version)).size, 1, "one practice, one version, however leaves: is indented");
});

test("a practice with no evidence, a pitfall without a citation, an unknown key, a heading, and leaves before any step are problems", () => {
  const text = ["# Widget practices", "- guess: A practice nobody learned.", "  when: explicit", "    leaves: nothing yet", "  step: hope", "  pitfall: it went wrong once", "  colour: blue", "  because: it seemed right"].join("\n");
  const messages = parsePractices(text, "W.practice.md").problems.map((p) => p.message);
  for (const expected of [/bare bullet list/, /leaves: on practice guess comes before any step/, /cites no record or commit/, /unknown key colour/, /cites no evidence/]) {
    assert.ok(messages.some((m) => expected.test(m)), `${expected} among ${JSON.stringify(messages)}`);
  }
});

test("triggers: a command fires on its words, an edit on its glob and the text it adds", () => {
  assert.ok(commandMatches("lexicon apply", "node src/cli.ts lexicon apply lp-1 --because x"));
  assert.ok(!commandMatches("lexicon apply", "node src/cli.ts lexicon applyall"));
  assert.ok(globMatches("**/*.spec.md", "src/a/A.spec.md") && globMatches("**/*.spec.md", "Top.spec.md"));
  assert.ok(!globMatches("src/*.ts", "src/a/b.ts"));
  const p = parsePractices(practiceText("d-0000abcd"), "W.practice.md").practices[0]!;
  const use = (u: Partial<ToolUse>): ToolUse => ({ command: undefined, writes: [], added: "", ...u });
  assert.equal(firedBy(p, use({ command: "./bin/turn-knob --hard" })), "command turn-knob");
  assert.equal(firedBy(p, use({ writes: ["src/widget/a/b.ts"], added: "const knob = 1" })), "edit src/widget/a/b.ts adding knob");
  assert.equal(firedBy(p, use({ writes: ["src/widget/a/b.ts"], added: "const dial = 1" })), undefined, "the edit adds no knob");
  assert.equal(firedBy(p, use({ command: "ls" })), undefined);
});

test("a command trigger's words match whole words of one simple command in place, a glob word one word, and never quoted text or a heredoc's body", () => {
  const practice = (when: string) => parsePractices(practiceText("d-0000abcd").replace("command turn-knob | edit src/widget/**/*.ts adding knob", when), "W.practice.md").practices[0]!;
  const fires = (p: ReturnType<typeof practice>, command: string) => firedBy(p, toolUseOf({ tool_input: { command } }, []));
  const pattern = practice("command turn-knob k-*");
  assert.equal(fires(pattern, "turn-knob k-1a2b --hard"), "command turn-knob k-*", "the argument after the command matches the glob");
  assert.equal(fires(pattern, "./bin/turn-knob k-1"), "command turn-knob k-*", "the program may be named by its path");
  assert.equal(fires(pattern, "turn-knob c-1a2b --hard"), undefined, "another argument is no match");
  assert.equal(fires(pattern, "turn-knob --hard k-1"), undefined, "the pattern is the next word, not any later one");
  assert.equal(fires(pattern, "turn-knob"), undefined, "a pattern word needs a word to match");
  assert.equal(fires(pattern, `turn-knob "k-1 and more"`), undefined, "a glob never matches blanks inside one quoted argument");
  assert.equal(fires(pattern, `oil --note "turn-knob k-1"`), undefined, "the words inside a quoted argument are no command");
  assert.equal(fires(pattern, "cat > notes.md <<'EOF'\nturn-knob k-1\nEOF"), undefined, "a heredoc's body is text, not a command");
  assert.equal(fires(pattern, "ls && turn-knob k-9"), "command turn-knob k-*", "any simple command of the line may fire it");
  assert.equal(fires(practice("command turn-knob k-?"), "turn-knob k-12"), undefined, "? is one character");
  assert.ok(commandMatches("turn-knob k-*", "turn-knob k-1") && !commandMatches("turn-knob k-*", "turn-knob c-1"), "the text fallback reads a glob word as one word");
  // A trigger without a pattern behaves as before: whole words anywhere in one simple command.
  const plain = practice("command lexicon apply");
  assert.equal(fires(plain, "node src/cli.ts lexicon apply lp-1 --because x"), "command lexicon apply");
  assert.equal(fires(plain, "node src/cli.ts lexicon applyall"), undefined);
  assert.equal(fires(plain, `node src/cli.ts decide "x" --because "lexicon apply"`), undefined);
  assert.equal(fires(practice("command turn-knob"), "turn-knob c-1"), "command turn-knob", "a bare command fires whatever follows");
  assert.notEqual(pattern.version, practice("command turn-knob").version, "the pattern is part of the version");
});

test("a practice file stands only beside its folder's spec, with the spec's stem", () => {
  const root = project({ "src/widget/Widget.spec.md": SPEC, "src/widget/Gadget.practice.md": practiceText("d-0000abcd"), "src/loose/Loose.practice.md": practiceText("d-0000abcd") });
  const messages = loadSpecModel(root, { runs: false }).problems.map((p) => `${p.file}: ${p.message}`);
  assert.ok(messages.some((m) => m.startsWith("src/loose/Loose.practice.md: a practice file is paired with a spec; src/loose has none")), messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("src/widget/Gadget.practice.md: a practice file takes its spec's stem: Widget.practice.md")), messages.join("\n"));
  const { root: paired } = widget();
  const model = loadSpecModel(paired, { runs: false });
  assert.deepEqual(model.problems, []);
  assert.deepEqual(model.components[0]!.practices.map((p) => [p.id, p.state]), [["src/widget/oil the knob", "candidate"]]);
});

test("every record a practice cites must exist, and every invariant it names must be declared", () => {
  const { root } = widget();
  writeFileSync(join(root, "src/widget/Widget.practice.md"), practiceText("d-deadbeef").replace("invariants: knob turns", "invariants: knob turns, dial clicks"));
  const messages = loadSpecModel(root, { runs: false }).problems.map((p) => p.message);
  assert.ok(messages.some((m) => /cites d-deadbeef, which no journal or work record has/.test(m)), messages.join("\n"));
  assert.ok(messages.some((m) => /names invariant dial clicks, which its sister spec does not declare/.test(m)), messages.join("\n"));
});

describe("a cited commit is no commit only where git can tell", () => {
  for (const { clone, cited, cites, problem } of [
    { clone: "full", cited: "an older commit", cites: (old: string) => old, problem: false },
    { clone: "full", cited: "a hash nothing has", cites: () => "0123abc", problem: true },
    { clone: "shallow", cited: "an older commit its depth cut off", cites: (old: string) => old, problem: false },
    { clone: "shallow", cited: "a file it holds", cites: (_old: string, blob: string) => blob, problem: true },
  ] as const) {
    test(`a ${clone} clone citing ${cited}: ${problem ? "a problem" : "no problem"}`, () => {
      const origin = project({ "src/widget/Widget.spec.md": SPEC, "src/widget/knob.ts": "export const knob = 1;\n" });
      const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", "the knob seized");
      const old = git(origin, "rev-parse", "--short", "HEAD");
      const blob = git(origin, "rev-parse", "HEAD:src/widget/knob.ts");
      writeFileSync(join(origin, "src/widget/Widget.practice.md"), practiceText(cites(old, blob)));
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", "oil the knob");
      let root = origin;
      if (clone === "shallow") {
        root = mkdtempSync(join(tmpdir(), "coherence-practice-shallow-"));
        projects.push(root);
        git(tmpdir(), "clone", "-q", "--depth", "1", `file://${origin}`, root);
      }
      const messages = loadSpecModel(root, { runs: false }).problems.map((p) => p.message);
      assert.equal(messages.some((m) => /which is no commit in this repository/.test(m)), problem, messages.join("\n"));
    });
  }
});

test("an enactment needs an outcome for every step, a because for a deviation or a skip, and keeps the text it enacted", () => {
  const { root, run } = widget();
  const missing = run("enact", "oil the knob", "--step", "1=done", ...WHO);
  assert.equal(missing.code, 1);
  assert.match(missing.err.join("\n"), /every step needs an outcome; missing 2, 3/);
  const bare = run("enact", "oil the knob", "--step", "1=done", "--step", "2=done", "--step", "3=skipped", ...WHO);
  assert.equal(bare.code, 1);
  assert.match(bare.err.join("\n"), /3=skipped needs a because/);
  const written = run("enact", "oil the knob", "--step", "1=done", "--step", "2=done", "--step", "3=deviated:turned it by hand", "--trigger", "command turn-knob", ...WHO);
  assert.equal(written.code, 0, written.err.join("\n"));
  assert.match(written.out.join("\n"), /step 2 names its evidence \(an oil record\) and none was given: claimed, not shown/);
  const e = loadJournal(root).records.find((r): r is Enactment => r.kind === "enactment")!;
  assert.equal(e.practice, "src/widget/oil the knob");
  assert.deepEqual(e.steps.map((s) => s.text), ["wipe the knob", "oil the knob", "turn it once"]);
  assert.deepEqual(e.pitfalls, [`a dry knob seized (${readFileSync(join(root, "src/widget/Widget.practice.md"), "utf8").match(/d-[0-9a-f]{8}/)![0]})`]);
  assert.deepEqual(e.results["3"], { result: "deviated", because: "turned it by hand" });
  assert.equal(loadSpecModel(root, { runs: false }).components[0]!.practices[0]!.state, "candidate", "no evidence for step 2, so not yet established");
  run("enact", "oil the knob", "--step", "1=done", "--step", "2=done:oil record 7", "--step", "3=done", ...WHO);
  assert.equal(loadSpecModel(root, { runs: false }).components[0]!.practices[0]!.state, "established");
});

test("a step enacted and since removed is a problem until a decision cites an enactment of the practice", () => {
  const { root, cite, run } = widget();
  // A candidate changes freely.
  writeFileSync(join(root, "src/widget/Widget.practice.md"), practiceText(cite).replace("  step: wipe the knob\n", ""));
  assert.deepEqual(loadSpecModel(root, { runs: false }).problems, []);
  writeFileSync(join(root, "src/widget/Widget.practice.md"), practiceText(cite));
  const enacted = run("enact", "oil the knob", "--step", "1=done", "--step", "2=done:oil record 7", "--step", "3=done", ...WHO);
  const id = enacted.out[0]!.split(/\s+/)[0]!;
  writeFileSync(join(root, "src/widget/Widget.practice.md"), practiceText(cite).replace("  step: wipe the knob\n", ""));
  const messages = loadSpecModel(root, { runs: false }).problems.map((p) => p.message);
  assert.equal(messages.length, 1, messages.join("\n"));
  assert.match(messages[0]!, new RegExp(`step "wipe the knob" was enacted in ${id} and is gone`));
  // Adding a step is free; it is the removal that needs a reason.
  writeFileSync(join(root, "src/widget/Widget.practice.md"), practiceText(cite).replace("  step: turn it once\n", "  step: turn it once\n  step: listen for a squeak\n"));
  assert.deepEqual(loadSpecModel(root, { runs: false }).problems, []);
  writeFileSync(join(root, "src/widget/Widget.practice.md"), practiceText(cite).replace("  step: wipe the knob\n", ""));
  // Re-enacting the edited version does not clear it: what an older enactment taught still counts.
  const first = loadJournal(root).records.find((r): r is Enactment => r.id === id)!;
  const edited = projectPractices(root).find((p) => p.name === "oil the knob")!;
  appendRecord(root, { ...first, id: "e-0000beef", at: new Date(Date.parse(first.at) + 500).toISOString(), version: edited.version, steps: edited.steps.map((s) => ({ text: s.text })), results: { "1": { result: "done" }, "2": { result: "done" } } });
  const again = loadSpecModel(root, { runs: false }).problems.map((p) => p.message);
  assert.equal(again.length, 1, again.join("\n"));
  assert.match(again[0]!, new RegExp(`step "wipe the knob" was enacted in ${id} and is gone.*decide "amend src/widget/oil the knob: <what changed>" .*--cite ${id}`));
  // A decision citing an enactment but not naming the practice amends nothing.
  run("decide", "rename the oil can", "--because", "unrelated", "--cite", "e-0000beef", ...WHO);
  assert.equal(loadSpecModel(root, { runs: false }).problems.length, 1);
  run("decide", "amend src/widget/oil the knob: the oil cloth wipes as it oils", "--because", "wiping first was redundant", "--cite", id, ...WHO);
  assert.deepEqual(loadSpecModel(root, { runs: false }).problems, []);
});

test("enact refuses a practice that has lost a step an enactment taught until a decision amends it", () => {
  const { root, cite, run } = widget();
  const steps = ["--step", "1=done", "--step", "2=done:oil record 7", "--step", "3=done"];
  const id = run("enact", "oil the knob", ...steps, ...WHO).out[0]!.split(/\s+/)[0]!;
  writeFileSync(join(root, "src/widget/Widget.practice.md"), practiceText(cite).replace("  step: wipe the knob\n", ""));
  const before = loadJournal(root).records.length;
  const refused = run("enact", "oil the knob", "--step", "1=done:oil record 8", "--step", "2=done", ...WHO);
  assert.notEqual(refused.code, 0);
  const said = refused.err.join("\n");
  assert.match(said, new RegExp(`step "wipe the knob", enacted in ${id}`));
  assert.match(said, new RegExp(`decide "amend src/widget/oil the knob: <what changed>" --because "<why>" --cite ${id}`));
  assert.equal(loadJournal(root).records.length, before, "nothing is written while the floor is open");
  run("decide", "amend src/widget/oil the knob: the oil cloth wipes as it oils", "--because", "wiping first was redundant", "--cite", id, ...WHO);
  const enacted = run("enact", "oil the knob", "--step", "1=done:oil record 8", "--step", "2=done", ...WHO);
  assert.equal(enacted.code, 0, enacted.err.join("\n"));
  assert.equal(loadJournal(root).records.filter((r) => r.kind === "enactment").length, 2);
});

test("PreToolUse delivers a fired practice whole once per version per session, then one line, and never blocks", async () => {
  const { root } = widget();
  const fire = async (session: string, command: string) => {
    const result = await runHook("PreToolUse", { cwd: root, session_id: session, tool_name: "Bash", tool_input: { command } }, root);
    result.commit?.();
    return result;
  };
  const first = await fire("s2", "./bin/turn-knob");
  assert.equal(first.exit, 0);
  const context = JSON.parse(first.stdout).hookSpecificOutput.additionalContext as string;
  assert.match(context, /Practice src\/widget\/oil the knob \(version [0-9a-f]{8}\)/);
  assert.match(context, /1\. wipe the knob[\s\S]*leaves: an oil record[\s\S]*! a dry knob seized/);
  assert.match(context, /enact "src\/widget\/oil the knob" --trigger "command turn-knob" --session s2/);
  assert.match(context, /--step 2=done:"<the evidence: an oil record>"/, "the evidence a step names is filled into the command");
  assert.doesNotMatch(context, /\$\{/, "no template text reaches the session");
  const again = JSON.parse((await fire("s2", "./bin/turn-knob")).stdout).hookSpecificOutput.additionalContext as string;
  assert.match(again, /applies here \(command turn-knob\); delivered whole earlier this session/);
  assert.doesNotMatch(again, /wipe the knob/);
  assert.match(JSON.parse((await fire("s3", "./bin/turn-knob")).stdout).hookSpecificOutput.additionalContext, /1\. wipe the knob/, "another session gets it whole");
  const quiet = await fire("s2", "ls -la");
  assert.equal(quiet.stdout, "");
  assert.equal(quiet.exit, 0);
  assert.deepEqual(writersUnmatched(installedEntry({ command: "coherence", host: "claude" }, "PreToolUse").matcher), [], "Claude Code runs the hook for every tool that writes");
});

test("regulate names a practice that fired with no enactment since, advisory, and never refuses a subagent stop for it", async () => {
  const { root } = widget();
  // The enactment comes after the firing, by the wall clock the hook keeps.
  const run = journal(root, () => new Date());
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "seed"], { cwd: root });
  const fired = await runHook("PreToolUse", { cwd: root, session_id: "s4", tool_name: "Bash", tool_input: { command: "./bin/turn-knob" } }, root);
  fired.commit?.();
  const stop = await runHook("SubagentStop", { cwd: root, session_id: "parent", agent_id: "s4", hook_event_name: "SubagentStop" }, root);
  assert.equal(stop.exit, 0, stop.stderr);
  const message = JSON.parse(stop.stdout).systemMessage as string;
  assert.match(message, /Practice src\/widget\/oil the knob fired \(command turn-knob\) and has no enactment since/);
  run("enact", "oil the knob", "--step", "1=done", "--step", "2=done:oil record 7", "--step", "3=done", "--session", "s4", "--agent", "main");
  const settled = await runHook("Stop", { cwd: root, session_id: "s4" }, root);
  assert.doesNotMatch(settled.stdout, /has no enactment since/);
});

test("in an adopter, the kernel practices are delivered beside the project's own, their ids led by coherence:, and an internal practice is not", () => {
  const { root } = widget();
  const ids = projectPractices(root).map((p) => p.id);
  assert.ok(ids.includes("src/widget/oil the knob"));
  assert.ok(ids.includes("coherence:src/enforcement/witness a refutation"), ids.join("; "));
  assert.ok(ids.includes("coherence:src/lifecycle/harvest practices"), "the onboarding practice reaches every adopter");
  assert.ok(!ids.includes("coherence:src/lifecycle/carry a lexicon change through"), "an internal practice never leaves Coherence's tree");
});

test("orient lists the practices with what fires each, and a project with none of its own is pointed at harvesting them", () => {
  const bare = project({ "src/widget/Widget.spec.md": SPEC });
  const ownless = practiceOrientText(bare, "coherence");
  assert.match(ownless, /^Practices: \d+ of Coherence's kernel, delivered when they fire; none of this project's own yet\. To find the ones it already has: coherence query practice "harvest practices"/);
  const unadopted = project({ "README.md": "nothing declared yet\n" });
  assert.match(practiceOrientText(unadopted, "coherence"), /this project has no spec yet\. To adopt Coherence here, step by step: coherence query practice "adopt Coherence"/);
  const { root } = widget();
  const owned = practiceOrientText(root, "coherence");
  assert.match(owned, /src\/widget\/oil the knob \[turn-knob, edit src\/widget\/\*\*\/\*\.ts adding knob\] \(candidate\)/);
  assert.match(owned, /; and \d+ of Coherence's kernel\n/);
  assert.doesNotMatch(owned, /none of this project's own/);
  assert.match(practiceAnswer(root, "oil the knob").text, /^Practice src\/widget\/oil the knob \(version [0-9a-f]{8}\)[\s\S]*candidate; enacted 0 times/);
});

test("scaffold practice prints every slot, refuses a folder without a spec, and writes the practice file beside the spec", () => {
  const root = project({ "src/widget/Widget.spec.md": SPEC, "src/loose/readme.md": "x\n" });
  const run = (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = scaffoldCommand(argv, { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l) }) as number;
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const refused = run("practice", "src/loose", "tidy", "Tidy up.");
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /holds no spec, and a practice file stands only beside one/);
  const written = run("practice", "src/widget", "oil the knob", "A knob is oiled before it turns.", "--when", "command turn-knob", "--write");
  assert.equal(written.code, 0, written.err);
  assert.match(written.out, /when: command turn-knob[\s\S]*pitfall: <a way this has gone wrong> \(<the record id or commit that witnessed it>\)/);
  const messages = loadSpecModel(root, { runs: false }).problems.map((p) => `${p.file}: ${p.message}`);
  assert.ok(messages.every((m) => m.startsWith("src/widget/Widget.practice.md")), messages.join("\n"));
  assert.ok(messages.some((m) => /cites no evidence/.test(m)), "an unfilled practice is refused until it cites what it rests on");
});

test("in Coherence's own tree every practice declares its reach, kernel or internal; anywhere else a reach line is a problem", () => {
  const tree = (reach: string) =>
    project({
      "package.json": JSON.stringify({ name: "@posthog/coherence" }),
      "src/widget/Widget.spec.md": SPEC,
      "src/widget/Widget.practice.md": practiceText("d-0000abcd", reach),
    });
  const unsaid = loadSpecModel(tree(""), { runs: false }).problems.map((p) => p.message);
  assert.ok(unsaid.some((m) => /practice oil the knob declares no reach: in Coherence's own tree every practice says how far it goes/.test(m)), unsaid.join("\n"));
  const unknown = parsePractices(practiceText("d-0000abcd", "  reach: everywhere"), "W.practice.md").problems.map((p) => p.message);
  assert.ok(unknown.some((m) => /reach: on oil the knob is "everywhere"; it takes one of kernel, internal/.test(m)), unknown.join("\n"));
  for (const reach of ["kernel", "internal"]) {
    const messages = loadSpecModel(tree(`  reach: ${reach}`), { runs: false }).problems.map((p) => p.message);
    assert.ok(!messages.some((m) => /reach/.test(m)), `${reach}: ${messages.join("\n")}`);
  }
  const { root } = widget("  reach: kernel");
  const adopter = loadSpecModel(root, { runs: false }).problems.map((p) => p.message);
  assert.ok(adopter.some((m) => /reach: is for Coherence's own practices; a project's practices are its own/.test(m)), adopter.join("\n"));
});

test("a shell command that writes a file fires an edit trigger the way an edit tool does, and the text it writes counts as added", async () => {
  const { root } = widget();
  const fire = async (command: string) => {
    const result = await runHook("PreToolUse", { cwd: root, session_id: "s-shell", tool_name: "Bash", tool_input: { command } }, root);
    result.commit?.();
    return result.stdout === "" ? "" : (JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string);
  };
  assert.match(await fire("cat > src/widget/a/b.ts <<'EOF'\nconst knob = 1\nEOF"), /This edit src\/widget\/a\/b\.ts adding knob fires a practice/);
  assert.equal(await fire("cat > src/widget/a/c.ts <<'EOF'\nconst dial = 1\nEOF"), "", "the edit adds no knob");
  assert.equal(await fire("cat src/widget/a/b.ts"), "", "reading the file writes nothing");
});

test("in an adopter, a kernel practice a Coherence release changed asks no amendment: enact goes through and spec --check names no floor gap", () => {
  const { root, run } = widget();
  const kernel = "coherence:src/enforcement/witness a refutation";
  const steps = projectPractices(root).find((p) => p.id === kernel)!.steps.map((s) => ["--step", `${s.n}=skipped:a fixture`]).flat();
  const first = run("enact", kernel, ...steps, ...WHO);
  assert.equal(first.code, 0, first.err.join("\n"));
  // As an earlier release left it: the recorded enactment carried a step the kernel practice no longer has.
  const file = onlyFile(join(root, ".coherence", "journal"), "s1");
  const lines = readFileSync(file, "utf8").split("\n").map((line) => {
    if (!line.includes('"kind":"enactment"')) return line;
    const record = JSON.parse(line) as { steps: { text: string }[] };
    record.steps.push({ text: "a step an earlier Coherence release taught" });
    return JSON.stringify(record);
  });
  writeFileSync(file, lines.join("\n"));
  const again = run("enact", kernel, ...steps, ...WHO);
  assert.equal(again.code, 0, `the adopter is not asked to decide for a change it did not make: ${again.err.join("\n")}`);
  const floor = loadSpecModel(root, { runs: false }).problems.filter((p) => /is gone; a practice keeps what it taught/.test(p.message));
  assert.deepEqual(floor.map((p) => p.message), [], "no floor gap is named for a kernel practice");
});
