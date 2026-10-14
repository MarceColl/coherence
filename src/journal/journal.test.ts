/**
 * The journal check.
 *
 *   npm run journal:check
 *
 * Every test runs in its own temporary directory, never in this repository's
 * .coherence, with a fixed clock so ids and cursors are reproducible.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { journalVerbs, type Io } from "./cli.ts";
import { INSTRUMENT_IS_WRONG, type JournalRecord } from "./record.ts";
import { JOURNAL_DIR, loadJournal } from "./store.ts";

interface Run {
  code: number;
  out: string[];
  err: string[];
}

/** A clock that advances one second per read, starting at a fixed instant. */
function clock(start = "2026-09-17T10:00:00.000Z"): () => Date {
  let tick = Date.parse(start);
  return () => {
    const now = new Date(tick);
    tick += 1000;
    return now;
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "coherence-journal-"));
}

function runIn(cwd: string, now: () => Date): (...argv: string[]) => Run {
  return (...argv) => {
    const [verb, ...rest] = argv;
    const command = journalVerbs[verb ?? ""];
    assert.ok(command !== undefined, `verb ${verb} exists`);
    const run: Run = { code: 0, out: [], err: [] };
    const io: Io = { cwd, now, out: (line) => run.out.push(line), err: (line) => run.err.push(line) };
    run.code = command(rest, io);
    return run;
  };
}

/** The id a successful write printed first. */
function idOf(run: Run): string {
  assert.equal(run.code, 0, `write succeeded: ${run.err.join("\n")}`);
  const id = run.out[0]?.split(/\s+/)[0];
  assert.ok(id !== undefined && id !== "", "the first printed token is the id");
  return id;
}

function lines(cwd: string, session: string): string[] {
  return readFileSync(join(cwd, JOURNAL_DIR, `${session}.jsonl`), "utf8").split("\n").filter((line) => line !== "");
}

function records(cwd: string): JournalRecord[] {
  return loadJournal(cwd).records;
}

function byId(cwd: string, id: string): JournalRecord {
  const found = records(cwd).find((record) => record.id === id);
  assert.ok(found !== undefined, `record ${id} is readable`);
  return found;
}

const WHO = ["--session", "s1", "--agent", "alpha"];

test("the work states are the five the lexicon declares for the work order, and none is a rejected name", async () => {
  const { WORK_STATES } = await import("./record.ts");
  const { loadLexicon, rejectedNames } = await import("../lifecycle/lexicon.ts");
  const { COHERENCE_LEXICON } = await import("../lifecycle/project.ts");
  const raw = JSON.parse(readFileSync(COHERENCE_LEXICON, "utf8")) as { concepts: { name: string; definition: string; detail?: { states?: { list?: string[] } } }[] };
  const order = raw.concepts.find((c) => c.name === "work order");
  assert.ok(order !== undefined, "the lexicon declares the work order");
  assert.deepEqual([...WORK_STATES], order.detail?.states?.list, "the code's states are the lexicon's, in order");
  for (const state of WORK_STATES) assert.ok(order.definition.includes(state), `the definition names ${state}`);
  const rejected = new Set(rejectedNames(await loadLexicon(COHERENCE_LEXICON)).map((n) => n.name.toLowerCase()));
  for (const state of WORK_STATES) assert.ok(!rejected.has(state), `${state} is not a rejected name`);
});

test("each verb writes the record its kind needs", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());

    const decision = idOf(run("decide", "JSONL per session", "--over", "sqlite", "--over", "one file", "--because", "no dependencies", ...WHO));
    const d = byId(cwd, decision);
    assert.equal(d.kind, "decision");
    assert.deepEqual(d, {
      ...d,
      chose: "JSONL per session",
      over: ["sqlite", "one file"],
      because: "no dependencies",
      session: "s1",
      agent: "alpha",
      at: "2026-09-17T10:00:00.000Z",
    });
    assert.ok(d.commit === null || /^[0-9a-f]{7,}$/.test(d.commit), "commit is a short sha or null");
    assert.equal(typeof d.dirty, "boolean");
    assert.match(decision, /^d-[0-9a-f]{8}$/);
    assert.ok(!("work" in d), "work is unset when --work was not given");

    const unexamined = byId(cwd, idOf(run("decide", "no over flag", "--because", "b", ...WHO)));
    assert.equal(unexamined.kind, "decision");
    assert.deepEqual(unexamined.over, [], "never given records an empty list");
    const nothing = byId(cwd, idOf(run("decide", "over none", "--over", "none", "--because", "b", ...WHO)));
    assert.equal(nothing.kind, "decision");
    assert.equal(nothing.over, "none", "--over none records the string none");
    assert.equal(run("decide", "mixed", "--over", "none", "--over", "x", "--because", "b", ...WHO).code, 1);

    assert.equal(run("decide", "bound", "--because", "b", "--work", "w-00000000", ...WHO).code, 1, "--work must name an order that exists");
    assert.equal(d.binding, "none: this session owns no active work order", "an unbound record says why");

    const conjecture = idOf(run("conjecture", "cold reads are slow", "--could-be", "disk cache", "--discriminated-by", "time two runs", ...WHO));
    const c = byId(cwd, conjecture);
    assert.equal(c.kind, "conjecture");
    assert.deepEqual(c.couldBe, [INSTRUMENT_IS_WRONG, "disk cache"], "the instrument candidate is prepended");
    assert.equal(c.discriminatedBy, "time two runs");
    const supplied = byId(cwd, idOf(run("conjecture", "o", "--could-be", INSTRUMENT_IS_WRONG, "--could-be", "x", "--discriminated-by", "t", ...WHO)));
    assert.equal(supplied.kind, "conjecture");
    assert.deepEqual(supplied.couldBe, [INSTRUMENT_IS_WRONG, "x"], "not prepended twice");

    const resolution = byId(cwd, idOf(run("resolved", conjecture, "--because", "cache was cold", "--as", "disk cache", ...WHO)));
    assert.equal(resolution.kind, "resolution");
    assert.equal(resolution.of, conjecture);
    assert.equal(resolution.as, "disk cache");
    assert.equal(run("resolved", conjecture, "--because", "again", ...WHO).code, 1, "a second answer is refused");
    assert.equal(run("dismiss", conjecture, "--because", "again", ...WHO).code, 1);

    const second = idOf(run("conjecture", "another", "--discriminated-by", "t", ...WHO));
    const dismissal = byId(cwd, idOf(run("dismiss", second, "--because", "nobody will chase it", ...WHO)));
    assert.equal(dismissal.kind, "dismissal");
    assert.equal(dismissal.of, second);
    assert.equal(run("dismiss", decision, "--because", "wrong kind", ...WHO).code, 1, "dismiss wants a conjecture");

    const defect = byId(cwd, idOf(run("defect", "save button no-ops", "--evidence", "user report #12", "--file", "src/a.ts", "--file", "src/b.ts", ...WHO)));
    assert.equal(defect.kind, "defect");
    assert.deepEqual({ what: defect.what, evidence: defect.evidence, files: defect.files }, {
      what: "save button no-ops",
      evidence: "user report #12",
      files: ["src/a.ts", "src/b.ts"],
    });
    assert.equal(run("defect", "no evidence", ...WHO).code, 1);

    const wall = byId(cwd, idOf(run("unable", "push the branch", "--because", "no one-time password", ...WHO)));
    assert.equal(wall.kind, "unable");
    assert.deepEqual({ what: wall.what, because: wall.because }, { what: "push the branch", because: "no one-time password" });

    const escalation = idOf(run("escalate", "retire an invariant", "--because", "a human acknowledges retirement", ...WHO));
    assert.match(escalation, /^e-/);
    const acknowledgement = byId(cwd, idOf(run("acknowledge", escalation, "--because", "retire it", ...WHO)));
    assert.equal(acknowledgement.kind, "acknowledgement");
    assert.equal(acknowledgement.of, escalation);
    assert.equal(run("acknowledge", decision, "--because", "wrong kind", ...WHO).code, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("append only: a second write never changes the first line", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    idOf(run("decide", "first", "--because", "b", ...WHO));
    const [first] = lines(cwd, "s1");
    idOf(run("decide", "second", "--because", "b", ...WHO));
    idOf(run("unable", "third", "--because", "b", ...WHO));
    const after = lines(cwd, "s1");
    assert.equal(after.length, 3);
    assert.equal(after[0], first);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ids are unique across sessions and across times for the same text", () => {
  const cwd = scratch();
  try {
    const a = idOf(runIn(cwd, clock())("decide", "same text", "--because", "b", "--session", "s1", "--agent", "alpha"));
    const b = idOf(runIn(cwd, clock("2026-09-17T11:00:00.000Z"))("decide", "same text", "--because", "b", "--session", "s2", "--agent", "beta"));
    const c = idOf(runIn(cwd, clock("2026-09-17T12:00:00.000Z"))("decide", "same text", "--because", "b", "--session", "s1", "--agent", "alpha"));
    assert.equal(new Set([a, b, c]).size, 3);
    assert.equal(records(cwd).length, 3, "both session files merge into one timeline");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("retract points at the record and never edits it", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    const decision = idOf(run("decide", "use sqlite", "--because", "b", ...WHO));
    const [original] = lines(cwd, "s1");
    const retraction = idOf(run("retract", decision, "--because", "sqlite needs a native module", "--session", "s2", "--agent", "beta"));
    assert.equal(lines(cwd, "s1")[0], original, "the retracted line is byte-identical");
    const r = byId(cwd, retraction);
    assert.equal(r.kind, "retraction");
    assert.equal(r.of, decision);
    assert.equal(run("retract", "d-00000000", "--because", "x", ...WHO).code, 1, "an unknown id is refused");
    assert.equal(run("retract", decision, "--because", "twice", ...WHO).code, 1, "a second retraction is refused");
    const shown = run("journal").out.join("\n");
    assert.match(shown, /use sqlite  \[retracted by rt-[0-9a-f]{8}\]/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("experiment create prints stable step ids; close refuses a missing id and derives the outcome", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    const create = run("experiment", "create", "migration keeps ids", "--context", "src/a.ts", "--action", "run it", "--success", "ids equal", "--success", "count equal", ...WHO);
    const id = idOf(create);
    const x = byId(cwd, id);
    assert.equal(x.kind, "experiment");
    assert.deepEqual(x.actions.map((step) => step.id), [`${id}.a1`]);
    assert.deepEqual(x.criteria.map((step) => step.id), [`${id}.c1`, `${id}.c2`]);
    assert.ok(create.out.some((line) => line.startsWith(`experiment close ${id}`)), "a close template is printed");

    assert.equal(run("experiment", "close", "x-00000000", "--result", "x-00000000.a1=pass", ...WHO).code, 1, "unknown experiment");
    const missing = run("experiment", "close", id, "--result", `${id}.a1=pass`, "--result", `${id}.c1=pass`, ...WHO);
    assert.equal(missing.code, 1, "a close that omits a criterion is refused");
    assert.match(missing.err.join("\n"), new RegExp(`missing ${id}\\.c2`));
    assert.equal(run("experiment", "close", id, "--result", `${id}.a1=pass`, "--result", `${id}.c1=pass`, "--result", `${id}.c2=maybe`, ...WHO).code, 1, "a result must be pass, fail, or unknown");
    assert.equal(run("experiment", "close", id, "--result", `${id}.a1=pass`, "--result", `${id}.c1=pass`, "--result", `${id}.c2=pass`, "--result", `${id}.c9=pass`, ...WHO).code, 1, "a step the experiment never planned is refused");

    const close = run("experiment", "close", id, "--result", `${id}.a1=pass`, "--result", `${id}.c1=pass`, "--result", `${id}.c2=unknown`, ...WHO);
    const closed = byId(cwd, idOf(close));
    assert.equal(closed.kind, "close");
    assert.equal(closed.outcome, "inconclusive");
    assert.equal(run("experiment", "close", id, "--result", `${id}.a1=pass`, "--result", `${id}.c1=pass`, "--result", `${id}.c2=pass`, ...WHO).code, 1, "a second close is refused");

    const success = idOf(run("experiment", "create", "s", "--action", "a", "--success", "c", ...WHO));
    const good = byId(cwd, idOf(run("experiment", "close", success, "--result", `${success}.a1=pass`, "--result", `${success}.c1=pass`, ...WHO)));
    assert.equal(good.kind, "close");
    assert.equal(good.outcome, "success");
    const failure = idOf(run("experiment", "create", "f", "--action", "a", "--success", "c", ...WHO));
    const bad = byId(cwd, idOf(run("experiment", "close", failure, "--result", `${failure}.a1=unknown`, "--result", `${failure}.c1=fail`, ...WHO)));
    assert.equal(bad.kind, "close");
    assert.equal(bad.outcome, "failure");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an escalation heads every read until it is acknowledged", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    idOf(run("decide", "earlier", "--because", "b", ...WHO));
    const escalation = idOf(run("escalate", "retire invariant X", "--because", "removal needs a human", ...WHO));
    const before = run("journal").out;
    assert.equal(before[0], "awaiting a human (1):");
    assert.match(before[1] ?? "", new RegExp(`${escalation}  alpha  retire invariant X`));
    const subjects = run("journal", "--subjects").out;
    assert.equal(subjects[0], "awaiting a human (1):");
    const json = JSON.parse(run("journal", "--json").out.join("\n")) as { escalations: string[] };
    assert.deepEqual(json.escalations, [escalation]);

    idOf(run("acknowledge", escalation, "--because", "retire it; the reliance list was reviewed", "--session", "owner", "--agent", "danilo"));
    const after = run("journal").out;
    assert.notEqual(after[0], "awaiting a human (1):");
    assert.match(after.join("\n"), /retire invariant X  \[acknowledged by ak-[0-9a-f]{8}\]/);
    assert.deepEqual((JSON.parse(run("journal", "--json").out.join("\n")) as { escalations: string[] }).escalations, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a damaged line is reported with its file and line number, skipped, and counted", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    idOf(run("decide", "before", "--because", "b", ...WHO));
    appendFileSync(join(cwd, JOURNAL_DIR, "s1.jsonl"), '{"id":"d-truncated","kind":"decision","at":"2026-09-17T10:00:0\n');
    appendFileSync(join(cwd, JOURNAL_DIR, "s1.jsonl"), '{"id":"z-1","kind":"mystery","at":"2026-09-17T10:00:05.000Z","session":"s1","agent":"alpha"}\n');
    idOf(run("decide", "after", "--because", "b", ...WHO));
    const read = run("journal");
    assert.equal(read.code, 0);
    assert.equal(records(cwd).length, 2, "the readable records survive");
    assert.match(read.out.join("\n"), /before[\s\S]*after/);
    assert.match(read.err[0] ?? "", /^damaged: \.coherence\/journal\/s1\.jsonl:2 not JSON/);
    assert.match(read.err[1] ?? "", /^damaged: \.coherence\/journal\/s1\.jsonl:3 unknown kind "mystery"/);
    assert.equal(read.err.at(-1), "damaged lines: 2");
    const json = JSON.parse(run("journal", "--json").out.join("\n")) as { damaged: unknown[] };
    assert.equal(json.damaged.length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("repeated singleton flags and missing attribution are refused", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    const twice = run("decide", "x", "--because", "a", "--because", "b", ...WHO);
    assert.equal(twice.code, 1);
    assert.match(twice.err[0] ?? "", /--because given twice/);
    assert.equal(run("decide", "x", "--because", "a", "--session", "s1", "--session", "s2", "--agent", "alpha").code, 1);
    const noSession = run("decide", "x", "--because", "a", "--agent", "alpha");
    assert.equal(noSession.code, 1);
    assert.match(noSession.err[0] ?? "", /--session is required/);
    const noAgent = run("decide", "x", "--because", "a", "--session", "s1");
    assert.equal(noAgent.code, 1);
    assert.match(noAgent.err[0] ?? "", /--agent is required/);
    assert.equal(run("decide", "x", "--because", "a", "--session", "../escape", "--agent", "alpha").code, 1, "a session must name a file");
    assert.equal(run("decide", "x", "--because", "a", "--bogus", "y", ...WHO).code, 1, "an unknown flag is refused");
    assert.equal(records(cwd).length, 0, "nothing was written");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the timeline filters and shows a decision's rejected alternatives on an indented line", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    const decision = idOf(run("decide", "JSONL", "--over", "sqlite", "--over", "one file", "--because", "no dependencies", ...WHO));
    idOf(run("unable", "push", "--because", "no password", "--session", "s2", "--agent", "beta"));
    const all = run("journal").out;
    assert.equal(all[0], `2026-09-17 10:00 ◆ ${decision}  alpha  JSONL`);
    assert.equal(all[1], "    over: sqlite | one file");
    assert.equal(all[2], "    because: no dependencies");
    assert.match(all[3] ?? "", /^2026-09-17 10:00 ⊘ u-[0-9a-f]{8}  beta  push$/);
    assert.equal(run("journal", "--session", "s2").out.length, 2);
    assert.equal(run("journal", "--agent", "alpha").out.length, 3);
    assert.equal(run("journal", "--kind", "unable").out.length, 2);
    assert.equal(run("journal", "--kind", "bogus").code, 1);
    const json = JSON.parse(run("journal", "--json", "--kind", "decision").out.join("\n")) as { records: JournalRecord[]; branch: unknown };
    assert.equal(json.records.length, 1);
    assert.ok("branch" in json, "the branch is derived at read time, never stored");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("subjects after a cursor: truncated text and the next cursor", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    const long = "x".repeat(200);
    const first = idOf(run("decide", "first", "--because", "b", ...WHO));
    const atInstant = run("journal", "--subjects", "--since", "2026-09-17T10:00:00.000Z");
    assert.equal(atInstant.out[0], `◆ ${first} alpha: first`, "a bare ISO includes the record at that instant");
    assert.equal(atInstant.out.at(-1), `cursor: 2026-09-17T10:00:00.000Z~${first}`);
    const empty = run("journal", "--subjects", "--since", `2026-09-17T10:00:00.000Z~${first}`);
    assert.equal(empty.out[0], "nothing new", "the full cursor excludes the record already seen");
    assert.equal(empty.out.at(-1), `cursor: 2026-09-17T10:00:00.000Z~${first}`);
    const second = idOf(run("decide", long, "--because", "b", ...WHO));
    const third = idOf(run("conjecture", "odd timing", "--discriminated-by", "t", ...WHO));
    const feed = run("journal", "--subjects", "--since", "2026-09-17T10:00:00.000Z~d-zzzzzzzz");
    assert.equal(feed.out.length, 3);
    assert.equal(feed.out[0], `◆ ${second} alpha: ${"x".repeat(119)}…`);
    assert.equal(feed.out[1], `? ${third} alpha: odd timing`);
    const cursor = feed.out[2]?.replace("cursor: ", "") ?? "";
    assert.equal(cursor, `2026-09-17T10:00:02.000Z~${third}`);
    const again = run("journal", "--subjects", "--since", cursor);
    assert.deepEqual(again.out, ["nothing new", `cursor: ${cursor}`]);
    assert.equal(run("journal", "--subjects", "--since", "yesterday").code, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("work orders: create, move, close, owner, inspect; terminal orders do not move and completed is close's alone", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    const created = run("work", "create", "ship the feed", "--success", "hook.test.ts covers the feed", "--boundary", "src/journal, src/lifecycle/hook.ts", ...WHO);
    const id = idOf(created);
    assert.match(id, /^w-[0-9a-f]{8}$/);
    assert.match(created.out[0] ?? "", /owner s1; state open/);
    assert.match(created.out[1] ?? "", new RegExp(`work move ${id} active --because`), "create prints the activation command");
    const [line] = readFileSync(join(cwd, ".coherence", "work", "s1.jsonl"), "utf8").split("\n");
    const record = JSON.parse(line ?? "{}") as Record<string, unknown>;
    assert.deepEqual(
      { kind: record["kind"], objective: record["objective"], success: record["success"], boundary: record["boundary"], owner: record["owner"], session: record["session"], agent: record["agent"], at: record["at"], dirty: typeof record["dirty"] },
      { kind: "order", objective: "ship the feed", success: "hook.test.ts covers the feed", boundary: "src/journal, src/lifecycle/hook.ts", owner: "s1", session: "s1", agent: "alpha", at: "2026-09-17T10:00:00.000Z", dirty: "boolean" },
    );
    assert.deepEqual(Object.keys(record).sort(), ["agent", "at", "boundary", "commit", "dirty", "id", "kind", "objective", "owner", "session", "success"], "an order carries content and its head, nothing else");

    assert.equal(run("work", "create", "no success", "--boundary", "x", ...WHO).code, 1);
    assert.equal(run("work", "create", "no boundary", "--success", "x", ...WHO).code, 1);
    assert.equal(run("work", "create", "no attribution", "--success", "x", "--boundary", "y").code, 1);
    const delegated = idOf(run("work", "create", "for a child", "--success", "s", "--boundary", "b", "--owner-session", "child", ...WHO));
    assert.match(run("work", "inspect").out.join("\n"), new RegExp(`${delegated}  open       child  for a child`));

    assert.equal(run("work", "move", id, "active", ...WHO).code, 1, "a move needs --because");
    assert.equal(run("work", "move", id, "done", "--because", "b", ...WHO).code, 1, "an unknown state is refused");
    assert.equal(run("work", "move", id, "completed", "--because", "b", ...WHO).code, 1, "completed is what close records");
    assert.equal(run("work", "move", "w-00000000", "active", "--because", "b", ...WHO).code, 1, "an unknown order is refused");
    assert.equal(run("work", "close", "w-00000000", "--because", "b", ...WHO).code, 1, "an unknown order does not close");
    assert.equal(run("work", "owner", "w-00000000", "--owner-session", "s9", "--because", "b", ...WHO).code, 1, "an unknown order changes no owner");
    const activated = run("work", "move", id, "active", "--because", "taking it up", ...WHO);
    assert.equal(activated.code, 0, activated.err.join("\n"));
    assert.match(activated.out[0] ?? "", /^wm-[0-9a-f]{8}  w-[0-9a-f]{8} open -> active/);
    assert.equal(run("work", "move", id, "active", "--because", "again", ...WHO).code, 1, "a move to the same state is refused");
    idOf(run("work", "move", id, "waiting", "--because", "the adapter is not ready", "--session", "s2", "--agent", "beta"));
    assert.match(run("work", "inspect", id).out[0] ?? "", new RegExp(`^${id}  waiting  owner s1$`), "anyone may move an order; the record says who");

    assert.equal(run("work", "owner", id, "--owner-session", "s1", "--because", "b", ...WHO).code, 1, "the current owner is refused as the next one");
    const moved = run("work", "owner", id, "--owner-session", "s3", "--because", "s1 ended", "--session", "s2", "--agent", "beta");
    assert.equal(moved.code, 0, moved.err.join("\n"));
    assert.match(moved.out[0] ?? "", /^wo-[0-9a-f]{8}  w-[0-9a-f]{8} owner s1 -> s3/);

    const closed = run("work", "close", id, "--because", "the feed test is green", "--session", "s3", "--agent", "gamma");
    assert.equal(closed.code, 0, closed.err.join("\n"));
    assert.match(closed.out[0] ?? "", /^wc-[0-9a-f]{8}  w-[0-9a-f]{8} waiting -> completed/);
    assert.equal(run("work", "close", id, "--because", "twice", ...WHO).code, 1, "a completed order does not close again");
    assert.equal(run("work", "move", id, "open", "--because", "b", ...WHO).code, 1, "a completed order does not move");
    assert.equal(run("work", "owner", id, "--owner-session", "s9", "--because", "b", ...WHO).code, 1, "a completed order does not change owner");
    const cancelled = idOf(run("work", "move", delegated, "cancelled", "--because", "no longer wanted", ...WHO));
    assert.match(cancelled, /^wm-/);
    assert.equal(run("work", "close", delegated, "--because", "b", ...WHO).code, 1, "a cancelled order does not close");

    const shown = run("work", "inspect", id).out;
    assert.equal(shown[0], `${id}  completed  owner s3`);
    assert.equal(shown[1], "  objective: ship the feed");
    assert.equal(shown[2], "  success:   hook.test.ts covers the feed");
    assert.equal(shown[3], "  boundary:  src/journal, src/lifecycle/hook.ts");
    assert.match(shown.join("\n"), /-> active  alpha: taking it up\n.*-> waiting  beta: the adapter is not ready\n.*owner -> s3  beta: s1 ended\n.*-> completed  gamma: the feed test is green/);
    assert.equal(run("work", "inspect", "w-00000000").code, 1);
    assert.equal(run("work", "bogus").code, 1);

    const files = readFileSync(join(cwd, ".coherence", "work", "s1.jsonl"), "utf8").split("\n").filter((l) => l !== "");
    assert.equal(files[0], line, "the store is append only: the order line never changes");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a write binds to the one active order its session owns; none or several bind nothing and say so; --work names another", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    const none = byId(cwd, idOf(run("decide", "before any order", "--because", "b", ...WHO)));
    assert.ok(!("work" in none));
    assert.equal(none.binding, "none: this session owns no active work order");

    const first = idOf(run("work", "create", "first", "--success", "s", "--boundary", "b", ...WHO));
    const open = byId(cwd, idOf(run("decide", "order open, not active", "--because", "b", ...WHO)));
    assert.ok(!("work" in open), "an open order binds nothing");

    idOf(run("work", "move", first, "active", "--because", "up", ...WHO));
    const decided = run("decide", "while owning one active order", "--because", "b", ...WHO);
    const inferred = byId(cwd, idOf(decided));
    assert.equal(inferred.work, first, "inferred from sole active ownership");
    assert.equal(inferred.binding, "inferred: the one active order this session owns");
    assert.match(decided.out[1] ?? "", new RegExp(`^  bound to ${first} \\(inferred`), "the write prints its binding");
    for (const verb of [
      ["conjecture", "o", "--discriminated-by", "t"],
      ["unable", "w", "--because", "b"],
      ["defect", "d", "--evidence", "e"],
      ["escalate", "e", "--because", "b"],
      ["experiment", "create", "x", "--action", "a", "--success", "c"],
    ]) {
      assert.equal(byId(cwd, idOf(run(...verb, ...WHO))).work, first, `${verb[0]} binds by inference`);
    }
    const other = byId(cwd, idOf(run("decide", "another session", "--because", "b", "--session", "s2", "--agent", "beta")));
    assert.ok(!("work" in other), "ownership is by session, not by project");

    const second = idOf(run("work", "create", "second", "--success", "s", "--boundary", "b", ...WHO));
    const flagged = byId(cwd, idOf(run("decide", "flagged", "--because", "b", "--work", second, ...WHO)));
    assert.equal(flagged.work, second, "--work overrides the inference");
    assert.equal(flagged.binding, "flag");
    idOf(run("work", "move", second, "active", "--because", "up", ...WHO));
    const several = byId(cwd, idOf(run("decide", "owning two", "--because", "b", ...WHO)));
    assert.ok(!("work" in several), "several active orders bind nothing");
    assert.equal(several.binding, `none: this session owns 2 active work orders (${first}, ${second}); pass --work <id>`);

    idOf(run("work", "close", first, "--because", "done", ...WHO));
    assert.equal(byId(cwd, idOf(run("decide", "one left", "--because", "b", ...WHO))).work, second, "a closed order leaves the other as the sole active one");
    idOf(run("work", "owner", second, "--owner-session", "s2", "--because", "moved", ...WHO));
    assert.ok(!("work" in byId(cwd, idOf(run("decide", "moved away", "--because", "b", ...WHO)))), "an order handed to another session no longer binds");
    assert.equal(byId(cwd, idOf(run("decide", "moved here", "--because", "b", "--session", "s2", "--agent", "beta"))).work, second);

    const inspected = run("work", "inspect", second).out.join("\n");
    assert.match(inspected, /journal records bound: 3\n/);
    assert.match(inspected, /◆ d-[0-9a-f]{8}  alpha  flagged\n/);
    assert.match(inspected, /runs bound: 0/);
    assert.match(run("journal").out.join("\n"), /before any order/, "binding never hides a record from the timeline");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("citations resolve at the write: an unknown id refuses the write, a record of any kind in either store is accepted, and records without citations still load", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    // A record written before citations existed: no cites field, no binding.
    const old = { id: "d-0ld00001", kind: "decision", at: "2026-09-01T00:00:00.000Z", session: "s0", agent: "old", commit: null, dirty: false, chose: "an old choice", over: [], because: "before citations" };
    mkdirSync(join(cwd, JOURNAL_DIR), { recursive: true });
    appendFileSync(join(cwd, JOURNAL_DIR, "s0.jsonl"), `${JSON.stringify(old)}\n`);
    const conjectured = idOf(run("conjecture", "the cache misses", "--discriminated-by", "log the key", ...WHO));
    const order = idOf(run("work", "create", "ship citations", "--success", "s", "--boundary", "b", "--cite", "d-0ld00001", ...WHO));
    const move = idOf(run("work", "move", order, "active", "--because", "taking it up", "--cite", conjectured, ...WHO));

    const before = records(cwd).length;
    const unknown = run("decide", "build on a ghost", "--because", "b", "--cite", "d-00000000", ...WHO);
    assert.equal(unknown.code, 1, "an unknown id refuses the write");
    assert.match(unknown.err.join("\n"), /--cite d-00000000: no journal or work record has that id/);
    assert.equal(records(cwd).length, before, "a refused write appends nothing");
    assert.equal(run("work", "close", order, "--because", "b", "--cite", "wm-00000000", ...WHO).code, 1, "a work write refuses an unknown citation too");
    assert.equal(run("decide", "twice", "--because", "b", "--cite", conjectured, "--cite", conjectured, ...WHO).code, 1, "a citation given twice is refused");

    const decided = idOf(run("decide", "cite everything", "--because", "b", "--cite", "d-0ld00001", "--cite", conjectured, "--cite", order, "--cite", move, ...WHO));
    assert.deepEqual((byId(cwd, decided) as { cites?: string[] }).cites, ["d-0ld00001", conjectured, order, move], "a decision cites a journal record of any kind, a work order, and a work order's move");
    for (const [verb, ...args] of [
      ["escalate", "a human must see", "--because", "b"],
      ["defect", "it broke", "--evidence", "e"],
      ["conjecture", "maybe", "--discriminated-by", "t"],
      ["unable", "could not", "--because", "wall"],
      ["experiment", "create", "it works", "--action", "try", "--success", "green"],
    ] as string[][]) {
      const written = run(verb!, ...args, "--cite", decided, ...WHO);
      assert.equal(written.code, 0, `${verb} cites: ${written.err.join("\n")}`);
      assert.match(written.out.join("\n"), new RegExp(`cites ${decided}`), `${verb} prints what it cites`);
    }
    assert.equal(run("retract", decided, "--because", "b", "--cite", conjectured, ...WHO).code, 1, "a verb that answers one record by `of` takes no citation");
    const closed = run("work", "close", order, "--because", "done", "--cite", decided, ...WHO);
    assert.equal(closed.code, 0, closed.err.join("\n"));

    const plain = idOf(run("decide", "no citations", "--because", "b", ...WHO));
    assert.ok(!Object.hasOwn(byId(cwd, plain), "cites"), "a record that cites nothing carries no cites field, like one written before citations");
    assert.ok(!Object.hasOwn(byId(cwd, plain), "human"), "nor a human field");
    assert.equal(byId(cwd, "d-0ld00001").kind, "decision", "a record written before citations still loads");
    assert.equal(loadJournal(cwd).damaged.length, 0);
    assert.match(run("journal").out.join("\n"), /an old choice\n    over: \(unexamined\)\n    because: before citations\n    cited by: /, "and still renders, now with what cites it");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("citations read both ways: the timeline, the JSON envelope, journal <id>, and work inspect show what a record cites and what cites it", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    const base = idOf(run("decide", "one door for writes", "--because", "two writers disagree", ...WHO));
    const order = idOf(run("work", "create", "route writes through the door", "--success", "s", "--boundary", "b", "--cite", base, ...WHO));
    idOf(run("work", "move", order, "active", "--because", "up", ...WHO));
    const built = idOf(run("decide", "the door takes a batch", "--because", "throughput", "--cite", base, ...WHO));
    const escalated = idOf(run("escalate", "should the door take deletes", "--because", "a human decides scope", "--cite", built, "--cite", order, ...WHO));

    const timeline = run("journal").out.join("\n");
    assert.match(timeline, new RegExp(`one door for writes\\n    over: \\(unexamined\\)\\n    because: two writers disagree\\n    cited by: ${order}, ${built}`), "the cited record lists what cites it, from both stores");
    assert.match(timeline, new RegExp(`the door takes a batch\\n(?:.*\\n)*?    cites: ${base}\\n    cited by: ${escalated}`), "a record shows what it cites and what cites it");

    const envelope = JSON.parse(run("journal", "--json").out.join("\n")) as { records: { id: string; cites?: string[] }[]; citedBy: Record<string, string[]> };
    assert.deepEqual(envelope.records.find((r) => r.id === escalated)?.cites, [built, order], "--json carries each record's cites as stored");
    assert.deepEqual(envelope.citedBy[base], [order, built], "--json carries what cites each record");
    assert.deepEqual(envelope.citedBy[built], [escalated]);

    const one = run("journal", base);
    assert.equal(one.code, 0, one.err.join("\n"));
    const text = one.out.join("\n");
    assert.match(text, new RegExp(`◆ ${base}  alpha  one door for writes`));
    assert.match(text, /cites \(0\):\n  cited by \(2\):/);
    assert.match(text, new RegExp(`    ${order}  work order  alpha: route writes through the door`), "journal <id> names a citing work order by kind and subject");
    assert.match(text, new RegExp(`    ${built}  decision  alpha: the door takes a batch`));
    const ofOrder = run("journal", order).out.join("\n");
    assert.match(ofOrder, new RegExp(`${order}  work order  alpha: route writes through the door\\n  cites \\(1\\):\\n    ${base}  decision  alpha: one door for writes\\n  cited by \\(1\\):\\n    ${escalated}  escalation`), "journal <id> reads a work record both ways too");
    assert.equal(run("journal", "d-00000000").code, 1, "an unknown id is refused");
    assert.equal(run("journal", base, "--kind", "decision").code, 1, "journal <id> takes no filter");

    const inspected = run("work", "inspect", order).out.join("\n");
    assert.match(inspected, new RegExp(`  cites: 1\\n    .* ${base}  decision  alpha  one door for writes`), "an order lists what it cites");
    assert.match(inspected, new RegExp(`  journal records bound: 2\\n.*the door takes a batch\\n.*should the door take deletes`), "the records bound to it");
    assert.match(inspected, new RegExp(`  cited by: 1\\n    .* ${escalated}  escalation  alpha  should the door take deletes  \\[cites ${order}\\]`), "and the records citing it");

    const feed = run("journal", "--subjects").out.join("\n");
    assert.ok(!feed.includes("cites") && !feed.includes("cited by"), "the subjects feed stays subjects only");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--human records the words an agent attributes to a human, apart from its because", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    const decided = idOf(run("decide", "rename it lexicon later", "--because", "the owner ruled it", "--human", "call it lexicon, but not yet", ...WHO));
    const record = byId(cwd, decided) as { human?: string; because: string };
    assert.equal(record.human, "call it lexicon, but not yet");
    assert.equal(record.because, "the owner ruled it", "the because stays the agent's own");
    const escalated = idOf(run("escalate", "retire the rule?", "--because", "a human decides retirements", "--human", "I want to see this one", ...WHO));
    assert.equal((byId(cwd, escalated) as { human?: string }).human, "I want to see this one");
    const acked = idOf(run("acknowledge", escalated, "--because", "kept", "--human", "keep it", ...WHO));
    assert.equal((byId(cwd, acked) as { human?: string }).human, "keep it");
    assert.equal(run("decide", "blank", "--because", "b", "--human", " ", ...WHO).code, 1, "blank human words are refused");
    assert.equal(run("defect", "no human here", "--evidence", "e", "--human", "x", ...WHO).code, 1, "a verb that does not carry human words refuses the flag");
    const timeline = run("journal").out.join("\n");
    assert.match(timeline, /because: the owner ruled it\n    human \(as the agent attributes\): call it lexicon, but not yet/, "the timeline labels the words as the agent's attribution");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the timeline after a cursor shows whole records", () => {
  const cwd = scratch();
  try {
    const run = runIn(cwd, clock());
    const first = idOf(run("decide", "first", "--over", "x", "--because", "why first", ...WHO));
    idOf(run("decide", "second", "--because", "why second", ...WHO));
    const after = run("journal", "--since", `2026-09-17T10:00:00.000Z~${first}`).out;
    assert.equal(after.length, 3, "one record after the cursor, with its two detail lines");
    assert.match(after[0] ?? "", /second$/);
    assert.equal(after[2], "    because: why second");
    assert.equal(run("journal", "--json", "--since", "2026-09-17T10:00:00.000Z").code, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the command line dispatches to the journal verbs", () => {
  const cwd = scratch();
  try {
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const node = process.execPath;
    const write = execFileSync(node, ["--disable-warning=ExperimentalWarning", cli, "decide", "via cli", "--because", "b", ...WHO], { cwd, encoding: "utf8" });
    assert.match(write, /^d-[0-9a-f]{8}  decision recorded in \.coherence\/journal\/s1\.jsonl/);
    const read = execFileSync(node, ["--disable-warning=ExperimentalWarning", cli, "journal"], { cwd, encoding: "utf8" });
    assert.match(read, /via cli/);
    assert.throws(() => execFileSync(node, [cli, "decide", "x", "--because", "b"], { cwd, encoding: "utf8", stdio: "pipe" }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a flag's value may come from a file or standard input, so long text never meets the shell", () => {
  const root = scratch();
  try {
    const text = join(root, "because.txt");
    writeFileSync(text, `the user's words, "quoted", with $HOME left as written\n`);
    const run = runIn(root, clock());
    const id = idOf(run("decide", "keep the text whole", "--because-file", text, "--session", "s1", "--agent", "main"));
    const record = loadJournal(root).records.find((r) => r.id === id) as { because?: string } | undefined;
    assert.equal(record?.because, `the user's words, "quoted", with $HOME left as written`, "read whole, one trailing newline dropped");
    const missing = run("decide", "x", "--because-file", join(root, "nope.txt"), "--session", "s1", "--agent", "main");
    assert.equal(missing.code, 1);
    assert.match(missing.err.join("\n"), /--because-file .*nope\.txt/, "a file that cannot be read is named");
    const unknown = run("decide", "x", "--because", "b", "--nonsense-file", text, "--session", "s1", "--agent", "main");
    assert.match(unknown.err.join("\n"), /unknown flag --nonsense/, "only a flag the verb takes has a -file form");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record the vet stands against is refused before anything is written", () => {
  const root = scratch();
  try {
    const run = (...argv: string[]): Run => {
      const [verb, ...rest] = argv;
      const out: Run = { code: 0, out: [], err: [] };
      const io: Io = { cwd: root, now: clock(), out: (l) => out.out.push(l), err: (l) => out.err.push(l), vet: (record) => (JSON.stringify(record).includes("doohickey") ? [`"doohickey" is rejected for widget: retired surface`] : []) };
      out.code = journalVerbs[verb!]!(rest, io);
      return out;
    };
    const refused = run("decide", "we keep the doohickey", "--because", "b", "--session", "s1", "--agent", "main");
    assert.equal(refused.code, 1);
    assert.match(refused.err.join("\n"), /nothing was written; the store is append-only, so reword this record first:\n {2}"doohickey" is rejected for widget/);
    assert.equal(loadJournal(root).records.length, 0, "nothing reached the store");
    const work = run("work", "create", "turn the doohickey", "--success", "s", "--boundary", "b", "--session", "s1", "--agent", "main");
    assert.equal(work.code, 1, "a work record is vetted too");
    idOf(run("decide", "we keep the widget", "--because", "b", "--session", "s1", "--agent", "main"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command line acts on the project from any subfolder, and vets a record against the project's rejected names", () => {
  const root = scratch();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "coherence.config.json"), JSON.stringify({ name: "widgetry", language: "typescript" }));
    writeFileSync(join(root, "lexicon.json"), JSON.stringify({ version: 1, project: "widgetry", concepts: [{ name: "widget", definition: "A thing with a knob." }], rejected: [{ concept: "doohickey", because: "retired surface" }] }));
    const sub = join(root, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const node = (...argv: string[]) => {
      try {
        return { code: 0, out: execFileSync("node", ["--disable-warning=ExperimentalWarning", cli, ...argv], { cwd: sub, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), err: "" };
      } catch (error) {
        const e = error as { status: number; stdout: string; stderr: string };
        return { code: e.status, out: e.stdout, err: e.stderr };
      }
    };
    const written = node("decide", "from a subfolder", "--because", "b", "--session", "s1", "--agent", "main");
    assert.equal(written.code, 0, written.err);
    assert.equal(loadJournal(root).records.length, 1, "the record is the project's");
    assert.ok(!existsSync(join(sub, ".coherence")) && !existsSync(join(root, "src", ".coherence")), "no second store where the command stood");
    const refused = node("decide", "keep the doohickey", "--because", "b", "--session", "s1", "--agent", "main");
    assert.equal(refused.code, 1);
    assert.match(refused.err, /"doohickey" is rejected for widgetry: retired surface/);
    assert.equal(loadJournal(root).records.length, 1, "the refused record never reached the store");
    const quoted = node("decide", "keep the widget", "--over", "the doohickey", "--because", "b", "--session", "s1", "--agent", "main");
    assert.equal(quoted.code, 0, "a name a decision turns away, in its over, is the record doing its job");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record committed on another branch may be cited and read, and says where it is; an id found nowhere is still refused", () => {
  const root = scratch();
  try {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "start");
    git("checkout", "-q", "-b", "side");
    const run = runIn(root, clock());
    const away = idOf(run("decide", "chosen on the side branch", "--because", "a parallel session", "--session", "side-1", "--agent", "helper"));
    git("add", "-A");
    git("commit", "-q", "-m", "side record");
    git("checkout", "-q", "main");
    assert.equal(loadJournal(root).records.length, 0, "main does not hold the side branch's record");

    const citing = run("decide", "builds on the side branch", "--because", "b", "--cite", away, "--session", "main-1", "--agent", "main");
    assert.equal(citing.code, 0, citing.err.join("\n"));
    assert.match(citing.out.join("\n"), new RegExp(`cites ${away} \\(on branch side, not in this checkout\\)`));

    const read = runIn(root, clock())("journal", away);
    assert.equal(read.code, 0, read.err.join("\n"));
    assert.match(read.out.join("\n"), /chosen on the side branch/);
    assert.match(read.out.join("\n"), /on branch side \(\.coherence\/journal\/side-1\.jsonl\), not in this checkout/);
    const citer = idOf(citing);
    assert.match(runIn(root, clock())("journal", citer).out.join("\n"), new RegExp(`${away} {2}\\(on branch side, not in this checkout\\)`), "a citation of it names the branch");

    const typo = run("decide", "x", "--because", "b", "--cite", "d-00000000", "--session", "main-1", "--agent", "main");
    assert.equal(typo.code, 1);
    assert.match(typo.err.join("\n"), /--cite d-00000000: no journal or work record has that id, here or committed on another branch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
