import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { appendRun, loadRuns, type RunRecord } from "../enforcement/record.ts";
import { appendRecord, loadJournal } from "../journal/store.ts";
import { appendWork, loadWork } from "../journal/work.ts";
import type { Decision, WorkOrderRecord } from "../journal/record.ts";
import { appendVerdict, loadVerdicts, type ConformanceVerdict } from "../conformance/store.ts";
import { RECORD_STORES } from "./project.ts";
import { ATTRIBUTES_FILE, ATTRIBUTES_TEXT, ATTRIBUTE_LINES, EARLIER_IGNORE_TEXTS, IGNORE_FILE, IGNORE_TEXT, keepAttributes, keepIgnore, keepStateFiles } from "./state-files.ts";

const fixtures: string[] = [];

after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `coherence-${name}-`)));
  fixtures.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): { status: number; out: string } {
  const run = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" });
  return { status: run.status ?? 1, out: `${run.stdout}${run.stderr}` };
}

function ok(root: string, ...args: string[]): void {
  const run = git(root, ...args);
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.out}`);
}

const SESSION = "stacked-session";

function decision(n: string, at: string): Decision {
  return { id: `d-${n.padStart(8, "0")}`, kind: "decision", at, session: SESSION, agent: "tester", commit: null, dirty: false, chose: `choice ${n}`, over: [`not ${n}`], because: `reason ${n}` } as Decision;
}

function order(n: string, at: string): WorkOrderRecord {
  return { id: `wo-${n.padStart(8, "0")}`, kind: "order", at, session: SESSION, agent: "tester", commit: null, dirty: false, objective: `objective ${n}`, success: "done", boundary: "here", owner: SESSION };
}

function run(at: string, name: string): RunRecord {
  return {
    at,
    session: SESSION,
    agent: "tester",
    commit: null,
    dirty: false,
    instrument: { language: "typescript", server: "none" },
    latency: 1,
    invariants: [{ component: "src/a", name, form: "totality oracle", verdict: "pass", refutation: "missing", bypasses: [], testReferences: 0, files: [], latency: 1, reason: "passed" }],
  };
}

/** One record in every record store, all under the one session, as a branch's work appends them. */
function verdict(n: string, at: string): ConformanceVerdict {
  return { at, session: SESSION, agent: "tester", commit: null, dirty: false, model: `model ${n}`, file: "M.qnt", captureHash: n, replayHash: n, verdict: "agrees", matched: 1, total: 1, pinned: 1, logged: 1, unpinned: [], failures: [], unreached: [], gaps: [] };
}

function appendAll(root: string, n: string, at: string): void {
  appendRecord(root, decision(n, at));
  appendWork(root, order(n, at));
  appendRun(root, run(at, `invariant ${n}`));
  appendVerdict(root, verdict(n, at));
}

/**
 * The stack: a base with one record per store, then two branches from it
 * that each append different records to the same session's file in every
 * store, as two stacked branches of one session do.
 */
function stack(withAttributes: boolean): string {
  const root = fixture("stack");
  ok(root, "init", "-q", "-b", "main");
  // As install leaves a project: regenerated state ignored, and the attributes unless this is the control.
  keepIgnore(root, true);
  if (withAttributes) keepAttributes(root);
  appendAll(root, "1", "2026-10-01T10:00:00.000Z");
  ok(root, "add", "-A");
  ok(root, "commit", "-q", "-m", "base");
  ok(root, "switch", "-q", "-c", "lower");
  appendAll(root, "2", "2026-10-01T11:00:00.000Z");
  ok(root, "commit", "-q", "-am", "lower");
  ok(root, "switch", "-q", "-c", "upper", "main");
  appendAll(root, "3", "2026-10-01T12:00:00.000Z");
  appendAll(root, "4", "2026-10-01T12:30:00.000Z");
  ok(root, "commit", "-q", "-am", "upper");
  return root;
}

/** Every record of both branches loads, from every store, with nothing damaged. */
function assertAllLoad(root: string, how: string): void {
  const journal = loadJournal(root);
  assert.deepEqual(journal.damaged, [], `${how}: the journal reads whole`);
  assert.deepEqual(journal.records.map((r) => r.id), ["1", "2", "3", "4"].map((n) => `d-${n.padStart(8, "0")}`), `${how}: every decision of both branches loads, in time order`);
  const work = loadWork(root);
  assert.deepEqual(work.damaged, [], `${how}: the work orders read whole`);
  assert.deepEqual(work.records.map((r) => r.id), ["1", "2", "3", "4"].map((n) => `wo-${n.padStart(8, "0")}`), `${how}: every work order of both branches loads`);
  const runs = loadRuns(root);
  assert.deepEqual(runs.damaged, [], `${how}: the runs read whole`);
  assert.deepEqual(runs.records.map((r) => r.invariants[0]!.name), ["1", "2", "3", "4"].map((n) => `invariant ${n}`), `${how}: every run of both branches loads`);
  assert.deepEqual(loadVerdicts(root).map((v) => v.model), ["1", "2", "3", "4"].map((n) => `model ${n}`), `${how}: every conformance verdict of both branches loads`);
}

test("two branches that append different records to one session's file in every record store merge and rebase with no conflict, and every record of both loads", () => {
  // Every store the attributes name is one the stack writes, and every store it writes is named.
  assert.deepEqual([...RECORD_STORES].sort(), ["conformance", "journal", "runs", "work"]);
  const merged = stack(true);
  const merge = git(merged, "merge", "-q", "--no-edit", "lower");
  assert.equal(merge.status, 0, `the merge conflicts: ${merge.out}`);
  assertAllLoad(merged, "merged");

  const rebased = stack(true);
  const rebase = git(rebased, "rebase", "-q", "lower");
  assert.equal(rebase.status, 0, `the rebase conflicts: ${rebase.out}`);
  assertAllLoad(rebased, "rebased");

  // The control: without the attributes the same stack conflicts, so the merge above is the attributes' doing.
  const bare = stack(false);
  const conflicted = git(bare, "merge", "-q", "--no-edit", "lower");
  assert.notEqual(conflicted.status, 0, "without .coherence/.gitattributes the stack conflicts");
  for (const store of RECORD_STORES) assert.match(git(bare, "diff", "--name-only", "--diff-filter=U").out, new RegExp(`\\.coherence/${store}/${SESSION}\\.jsonl`), `${store} conflicts without the attributes`);
});

test("a torn last line a union merge keeps stays one damaged line, the record appended after it reads whole, and a line kept twice is read once", () => {
  const root = fixture("torn");
  appendAll(root, "1", "2026-10-01T10:00:00.000Z");
  const files = { journal: join(root, ".coherence", "journal", `${SESSION}.jsonl`), work: join(root, ".coherence", "work", `${SESSION}.jsonl`), runs: join(root, ".coherence", "runs", `${SESSION}.jsonl`) };
  // What a union merge can leave: one side's line twice, and a write that crashed partway with no newline after it.
  for (const file of Object.values(files)) {
    const first = readFileSync(file, "utf8");
    appendFileSync(file, `${first}{"id":"torn`);
  }
  appendAll(root, "2", "2026-10-01T11:00:00.000Z");

  const journal = loadJournal(root);
  assert.deepEqual(journal.records.map((r) => r.id), ["d-00000001", "d-00000002"], "the duplicate is read once and the record after the torn line reads whole");
  assert.deepEqual(journal.damaged.map((d) => d.line), [3], "the torn line is one damaged line, at its own place");
  const work = loadWork(root);
  assert.deepEqual(work.records.map((r) => r.id), ["wo-00000001", "wo-00000002"]);
  assert.deepEqual(work.damaged.map((d) => d.line), [3]);
  const runs = loadRuns(root);
  assert.deepEqual(runs.records.map((r) => r.invariants[0]!.name), ["invariant 1", "invariant 2"]);
  assert.deepEqual(runs.damaged.map((d) => d.line), [3]);
  for (const file of Object.values(files)) assert.ok(readFileSync(file, "utf8").endsWith("\n"), `${file} ends whole`);
});

test("install and every session start keep .coherence/.gitattributes: written where absent, an adopter's lines kept with only missing attributes added, and an earlier release's ignore file brought up so git commits it", () => {
  // Absent: written whole, and git applies it to every store's session files.
  const fresh = fixture("attributes");
  ok(fresh, "init", "-q");
  assert.equal(keepIgnore(fresh, true), "wrote");
  assert.equal(keepAttributes(fresh), "wrote");
  assert.equal(readFileSync(join(fresh, ATTRIBUTES_FILE), "utf8"), ATTRIBUTES_TEXT);
  assert.equal(keepAttributes(fresh), "unchanged", "a second keep writes nothing");
  for (const store of RECORD_STORES) {
    const attrs = git(fresh, "check-attr", "merge", "linguist-generated", "--", `.coherence/${store}/s.jsonl`).out;
    assert.match(attrs, /merge: union/, `${store} merges by union`);
    assert.match(attrs, /linguist-generated: true/, `${store} reads as generated`);
  }
  mkdirSync(join(fresh, ".coherence", "feed"), { recursive: true });
  writeFileSync(join(fresh, ".coherence", "feed", "cursor"), "x");
  assert.deepEqual(git(fresh, "status", "--porcelain", "--untracked-files=all").out.split("\n").filter(Boolean).map((l) => l.slice(3)).sort(), [".coherence/.gitattributes", ".coherence/.gitignore"], "git commits both files and still ignores regenerated state");

  // The adopter's own file: every line kept, and only an attribute it does not set for that pattern added.
  const theirs = fixture("their-attributes");
  const own = "# ours\n*.png binary\njournal/*.jsonl merge=binary\nruns/** -linguist-generated";
  mkdirSync(join(theirs, ".coherence"), { recursive: true });
  writeFileSync(join(theirs, ATTRIBUTES_FILE), own);
  assert.equal(keepAttributes(theirs), "added");
  const kept = readFileSync(join(theirs, ATTRIBUTES_FILE), "utf8");
  assert.ok(kept.startsWith(`${own}\n`), "every line the adopter wrote stays, in place");
  const added = kept.slice(own.length + 1).split("\n").filter((l) => l !== "" && !l.startsWith("#"));
  assert.deepEqual(added, ATTRIBUTE_LINES.filter((l) => l !== "journal/*.jsonl merge=union" && l !== "runs/** linguist-generated=true"), "only what the adopter does not set is added");
  assert.equal(keepAttributes(theirs), "kept", "a second keep adds nothing");

  // An adopter of an earlier release: its ignore file, which ignored the attributes file, is brought up at the session start.
  const earlier = fixture("earlier");
  ok(earlier, "init", "-q");
  mkdirSync(join(earlier, ".coherence"), { recursive: true });
  writeFileSync(join(earlier, IGNORE_FILE), EARLIER_IGNORE_TEXTS[0]!);
  keepStateFiles(earlier);
  assert.equal(readFileSync(join(earlier, IGNORE_FILE), "utf8"), IGNORE_TEXT);
  assert.equal(readFileSync(join(earlier, ATTRIBUTES_FILE), "utf8"), ATTRIBUTES_TEXT);
  assert.equal(git(earlier, "check-ignore", "-q", ATTRIBUTES_FILE).status, 1, "git no longer ignores the attributes file");

  // A session start never creates an ignore file install did not write, and never rewrites the adopter's.
  const none = fixture("no-ignore");
  keepStateFiles(none);
  assert.equal(existsSync(join(none, IGNORE_FILE)), false);
  assert.equal(readFileSync(join(none, ATTRIBUTES_FILE), "utf8"), ATTRIBUTES_TEXT);
  writeFileSync(join(none, IGNORE_FILE), "*.log\n");
  assert.equal(keepIgnore(none, true), "kept");
  assert.equal(readFileSync(join(none, IGNORE_FILE), "utf8"), "*.log\n");
});
