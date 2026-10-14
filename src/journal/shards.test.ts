/**
 * Sealed shards (shards.ts): when a writer starts a new shard, that a
 * committed shard is never appended again whatever the writer's state says,
 * that every reader reads a packed shard, that packed writing is off by
 * default, and that two checkouts of one session land on GitHub's terms, with
 * no merge driver, without a conflict.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { appendRun, loadRuns, type RunRecord } from "../enforcement/record.ts";
import { latestSeeing } from "../enforcement/run-index.ts";
import { parseLine as parseRunLine } from "../enforcement/record.ts";
import { recordsOnOtherBranches } from "./branches.ts";
import type { Decision, WorkOrderRecord } from "./record.ts";
import { PACKED_BY_DEFAULT, SHARD_LIMIT_BYTES, packedWriting } from "./shards.ts";
import { appendRecord, journalFileKeys, loadJournal } from "./store.ts";
import { PACKED_EXTENSION, STORE_NAMES, isPacked, sessionOfStoreFile, storeDir, type RecordStore } from "./stores.ts";
import { appendWork, loadWork } from "./work.ts";
import { keepIgnore } from "../lifecycle/state-files.ts";
import { readStatus } from "../lifecycle/statusline.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures: string[] = [];

after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `coherence-shards-${name}-`)));
  fixtures.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): { status: number; out: string } {
  const run = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" });
  return { status: run.status ?? 1, out: `${run.stdout}${run.stderr}` };
}

function ok(root: string, ...args: string[]): string {
  const run = git(root, ...args);
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.out}`);
  return run.out;
}

function repo(name: string): string {
  const root = folder(name);
  ok(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "code.txt"), "base\n");
  // As install leaves a project: Coherence's regenerated state, the writers' shard state among it, ignored.
  keepIgnore(root, true);
  ok(root, "add", "-A");
  ok(root, "commit", "-q", "-m", "base");
  return root;
}

let serial = 0;
function decision(session: string, tag: string): Decision {
  serial += 1;
  const at = new Date(Date.UTC(2026, 9, 14, 12, 0, 0) + serial * 1000).toISOString();
  return { id: `d-${serial.toString(16).padStart(8, "0")}`, kind: "decision", at, session, agent: "tester", commit: null, dirty: false, chose: `choice ${tag}`, over: [`not ${tag}`], because: `reason ${tag}` } as Decision;
}

function order(session: string, tag: string): WorkOrderRecord {
  serial += 1;
  const at = new Date(Date.UTC(2026, 9, 14, 12, 0, 0) + serial * 1000).toISOString();
  return { id: `wo-${serial.toString(16).padStart(8, "0")}`, kind: "order", at, session, agent: "tester", commit: null, dirty: false, objective: `objective ${tag}`, success: "done", boundary: "here", owner: session };
}

function run(session: string, tag: string): RunRecord {
  serial += 1;
  const at = new Date(Date.UTC(2026, 9, 14, 12, 0, 0) + serial * 1000).toISOString();
  return {
    at,
    session,
    agent: "tester",
    commit: null,
    dirty: false,
    instrument: { language: "typescript", server: "none" },
    latency: 1,
    invariants: [{ component: "src/a", name: `invariant ${tag}`, form: "chokepoint", verdict: "pass", refutation: "automatic", bypasses: [], testReferences: 0, files: [`src/${tag}.ts`], latency: 1, reason: "passed" }],
  };
}

/** One record in every store, through each store's own writer. */
function appendAll(root: string, session: string, tag: string): void {
  appendRecord(root, decision(session, tag));
  appendWork(root, order(session, tag));
  appendRun(root, run(session, tag));
}

/** The store's files, by name, with their bytes. */
function files(root: string, store: RecordStore): Map<string, string> {
  const dir = join(root, storeDir(store));
  const out = new Map<string, string>();
  try {
    for (const name of readdirSync(dir).sort()) out.set(name, readFileSync(join(dir, name), "utf8"));
  } catch {
    // No folder: no files.
  }
  return out;
}

/** Every file a commit holds under the stores, with its bytes there. */
function committed(root: string, rev = "HEAD"): Map<string, string> {
  const out = new Map<string, string>();
  const listing = ok(root, "ls-tree", "-r", "--name-only", rev, "--", ...STORE_NAMES.map(storeDir)).split("\n").filter((p) => p !== "");
  for (const path of listing) out.set(path, ok(root, "show", `${rev}:${path}`));
  return out;
}

/** That every committed store file stands in the worktree with exactly the bytes the commit holds. */
function assertUntouched(root: string, held: Map<string, string>, how: string): void {
  for (const [path, bytes] of held) assert.equal(readFileSync(join(root, path), "utf8"), bytes, `${how}: ${path}, which a commit holds, was appended to`);
}

const ids = (root: string): string[] => loadJournal(root).records.map((r) => r.id);

test("a writer starts a new shard when HEAD, the branch or the size limit moved, and never appends to a shard a commit holds", () => {
  const root = repo("rotate");
  const S = "rotating";
  appendAll(root, S, "1");
  appendAll(root, S, "2");
  for (const store of STORE_NAMES) assert.equal(files(root, store).size, 1, `${store}: two appends at one HEAD go to one shard`);
  for (const store of STORE_NAMES) for (const name of files(root, store).keys()) assert.match(name, /^rotating\.[0-9a-f]{8}\.jsonl$/, `${store}: a shard is named <session>.<token>.jsonl`);

  // A commit moves HEAD: every shard it holds is sealed.
  ok(root, "add", "-A");
  ok(root, "commit", "-q", "-m", "records");
  const first = committed(root);
  appendAll(root, S, "3");
  assertUntouched(root, first, "after a commit");
  for (const store of STORE_NAMES) assert.equal(files(root, store).size, 2, `${store}: the record after a commit starts a new shard`);

  // A new branch at the same commit: a new shard.
  ok(root, "switch", "-q", "-c", "side");
  appendAll(root, S, "4");
  for (const store of STORE_NAMES) assert.equal(files(root, store).size, 3, `${store}: a branch change starts a new shard`);

  // Staged, not yet committed: git's index holds the shard, so it is sealed.
  ok(root, "add", "-A");
  const staged = new Map([...files(root, "journal")].map(([n, t]) => [join(storeDir("journal"), n), t]));
  appendAll(root, S, "5");
  assertUntouched(root, staged, "after a stage");
  assert.equal(files(root, "journal").size, 4, "a staged shard is not appended to");

  // HEAD moves and comes back: a commit, then a mixed reset to before it, leaves the shard in the worktree at its size,
  // untracked, at the HEAD the writer last saw; the commit that holds it may be pushed, so it is not appended to.
  ok(root, "commit", "-q", "-m", "more");
  const pushed = committed(root);
  ok(root, "reset", "-q", "HEAD~1");
  appendAll(root, S, "6");
  assertUntouched(root, pushed, "after a commit and a reset back");

  // A shard at its size limit is sealed.
  const before = files(root, "journal").size;
  appendRecord(root, { ...decision(S, "big"), because: "x".repeat(SHARD_LIMIT_BYTES) } as Decision);
  appendRecord(root, decision(S, "after big"));
  assert.equal(files(root, "journal").size, before + 1, "the record after a full shard starts one more");
  assert.equal(new Set(ids(root)).size, ids(root).length, "no record twice");
  assert.equal(loadJournal(root).damaged.length, 0);
});

test("a lost, torn or wrong shard state starts a new shard, and a state that names a committed shard at the current HEAD still never appends to it", () => {
  const root = repo("state");
  const S = "stateful";
  const state = join(root, ".coherence", "cache", "shards", `${S}.json`);
  appendRecord(root, decision(S, "1"));
  rmSync(state);
  appendRecord(root, decision(S, "2"));
  assert.equal(files(root, "journal").size, 2, "a lost state starts a new shard");
  writeFileSync(state, "{\"journal\":");
  appendRecord(root, decision(S, "3"));
  assert.equal(files(root, "journal").size, 3, "a torn state starts a new shard");
  writeFileSync(state, JSON.stringify({ journal: { name: 42 } }));
  appendRecord(root, decision(S, "4"));
  assert.equal(files(root, "journal").size, 4, "a state not in its shape starts a new shard");

  // Committed, then a state that names that shard with everything the writer sees now: HEAD, branch, reflog, the index's
  // identity, the shard's size. Only git's own index can say the shard is held, and it does.
  ok(root, "add", "-A");
  ok(root, "commit", "-q", "-m", "records");
  const held = committed(root);
  appendRecord(root, decision(S, "5"));
  const kept = JSON.parse(readFileSync(state, "utf8")) as { journal: { name: string; size: number } };
  const [name, bytes] = [...held].find(([path]) => path.startsWith(storeDir("journal")))!;
  writeFileSync(state, JSON.stringify({ journal: { ...kept.journal, name: name.slice(storeDir("journal").length + 1), size: Buffer.byteLength(bytes) } }));
  appendRecord(root, decision(S, "6"));
  assertUntouched(root, held, "a state naming a committed shard");
  assert.equal(ids(root).length, 6, "every record reads");

  // Outside git, the state is all there is: the writer appends to its last shard while its size holds.
  const plain = folder("no-git");
  appendRecord(plain, decision(S, "a"));
  appendRecord(plain, decision(S, "b"));
  assert.equal(files(plain, "journal").size, 1);
});

/** Packed writing on, for one call. */
function packed<T>(fn: () => T): T {
  const was = process.env["COHERENCE_PACKED_RECORDS"];
  process.env["COHERENCE_PACKED_RECORDS"] = "1";
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env["COHERENCE_PACKED_RECORDS"];
    else process.env["COHERENCE_PACKED_RECORDS"] = was;
  }
}

test("writers write line shards unless packed writing is turned on, and a packed shard holds one line", () => {
  assert.equal(PACKED_BY_DEFAULT, false, "packed writing ships off: the release after the one with packed readers turns it on (docs/records-layout.md)");
  assert.equal(packedWriting({}), false);
  assert.equal(packedWriting({ COHERENCE_PACKED_RECORDS: "1" }), true);
  const root = repo("default");
  const was = process.env["COHERENCE_PACKED_RECORDS"];
  delete process.env["COHERENCE_PACKED_RECORDS"];
  try {
    appendAll(root, "plain", "1");
  } finally {
    if (was !== undefined) process.env["COHERENCE_PACKED_RECORDS"] = was;
  }
  for (const store of STORE_NAMES) for (const name of files(root, store).keys()) assert.ok(name.endsWith(".jsonl") && !isPacked(name), `${store}: ${name} is a line shard by default`);
  packed(() => {
    appendAll(root, "packed", "1");
    appendAll(root, "packed", "2");
    appendAll(root, "packed", "3");
  });
  for (const store of STORE_NAMES) {
    const shards = [...files(root, store)].filter(([name]) => sessionOfStoreFile(name) === "packed");
    assert.equal(shards.length, 1, `${store}: packed appends at one HEAD go to one shard`);
    const [name, text] = shards[0]!;
    assert.ok(name.endsWith(PACKED_EXTENSION), `${store}: ${name} is a packed shard`);
    assert.ok(!text.includes("\n"), `${store}: a packed shard is one line`);
    assert.ok(text.startsWith("\u001e"), `${store}: led by the separator, so its line never begins as a record does`);
    assert.equal(text.split("\u001e").filter((t) => t !== "").length, 3, `${store}: three records, each ended by the record separator`);
  }
});

test("every reader reads a packed shard's records as a line shard's: the journal, the runs, the work orders, the run index, the citation search, the records summary and the status line", () => {
  const root = repo("readers");
  packed(() => {
    appendAll(root, "packer", "1");
    appendAll(root, "packer", "2");
    appendRecord(root, { ...decision("packer", "enacted"), kind: "enactment", practice: "src/a/oil the knob" } as unknown as Decision);
  });
  appendAll(root, "liner", "3");
  // A torn packed record: a write that crashed partway, then the next append ends it first.
  const journalDir = join(root, storeDir("journal"));
  const packedJournal = readdirSync(journalDir).find((n) => isPacked(n))!;
  appendFileSync(join(journalDir, packedJournal), "{\"id\":\"d-torn");
  const journal = loadJournal(root);
  assert.equal(journal.records.length, 4, "the journal reads every record of both shards, the torn segment aside");
  assert.equal(journal.damaged.length, 1, "the torn segment is one damaged record");
  assert.ok(journalFileKeys(root).has(packedJournal), "the peer feed's stat pass sees the packed shard");
  assert.deepEqual(loadWork(root).records.length, 3);
  assert.deepEqual(loadRuns(root).records.map((r) => r.invariants[0]!.name).sort(), ["invariant 1", "invariant 2", "invariant 3"]);
  assert.deepEqual(loadRuns(root).damaged, []);
  const seeing = latestSeeing(root, ["src/2.ts"], parseRunLine);
  assert.equal(seeing.byFile.get("src/2.ts")?.size, 1, "the run index folds a packed shard's runs");

  // The status line reads the session's own enactments from its packed shard: the practice that fired is not owed.
  mkdirSync(join(root, ".coherence", "practices"), { recursive: true });
  writeFileSync(join(root, ".coherence", "practices", "packer.jsonl"), `${JSON.stringify({ practice: "src/a/oil the knob", at: "2026-01-01T00:00:00.000Z" })}\n`);
  writeFileSync(join(root, ".coherence", "practices", "liner.jsonl"), `${JSON.stringify({ practice: "src/a/oil the knob", at: "2026-01-01T00:00:00.000Z" })}\n`);
  assert.deepEqual(readStatus({ session_id: "packer", cwd: root })?.owed, [], "the enactment in the packed shard is read");
  assert.deepEqual(readStatus({ session_id: "liner", cwd: root })?.owed, ["src/a/oil the knob"], "a session that enacted nothing owes it");

  // Committed on a branch: the citation search finds a record inside a packed shard's one line.
  ok(root, "switch", "-q", "-c", "packed-branch");
  ok(root, "add", "-A");
  ok(root, "commit", "-q", "-m", "packed records");
  const wanted = journal.records.find((r) => r.session === "packer")!.id;
  ok(root, "switch", "-q", "main");
  const found = recordsOnOtherBranches(root, [wanted]);
  assert.equal(found.get(wanted)?.branch, "packed-branch", "a citation reaches a record in a packed shard on another branch");
  assert.equal((JSON.parse(found.get(wanted)!.line) as { id: string }).id, wanted, "and reads that one record");

  // The CI records summary counts each record of a packed shard.
  const summary = spawnSync(process.execPath, [join(REPO, ".github", "scripts", "records-summary.mjs"), "main", "packed-branch"], { cwd: root, encoding: "utf8" });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /\b10 records\b/, summary.stdout);
});

type Method = "merge" | "squash" | "rebase";

/** Land `branch` on main as GitHub's button does, honouring no merge driver; the conflicted paths, none when it landed. */
function land(root: string, branch: string, method: Method): string[] {
  ok(root, "checkout", "-q", "main");
  const conflicts = (): string[] => git(root, "diff", "--name-only", "--diff-filter=U").out.split("\n").filter((p) => p !== "");
  if (method === "rebase") {
    ok(root, "checkout", "-q", "-B", `rebased-${branch}`, branch);
    if (git(root, "rebase", "-q", "main").status !== 0) {
      const found = conflicts();
      git(root, "rebase", "--abort");
      ok(root, "checkout", "-q", "main");
      return found.length > 0 ? found : ["(the rebase failed)"];
    }
    ok(root, "checkout", "-q", "main");
    ok(root, "merge", "-q", "--ff-only", `rebased-${branch}`);
    return [];
  }
  if (git(root, ...(method === "squash" ? ["merge", "-q", "--squash", branch] : ["merge", "-q", "--no-ff", "--no-edit", branch])).status !== 0) {
    const found = conflicts();
    git(root, "merge", "--abort");
    git(root, "reset", "-q", "--hard", "main");
    return found.length > 0 ? found : ["(the merge failed)"];
  }
  if (method === "squash") ok(root, "commit", "-q", "-m", `squash ${branch}`);
  return [];
}

test("two checkouts of one session on parallel and stacked branches, landed by merge, squash and rebase with no attributes file, conflict nowhere, and every record of both loads", () => {
  const outcomes: string[] = [];
  for (const shape of ["parallel", "stacked"] as const) {
    for (const method of ["merge", "squash", "rebase"] as const) {
      const how = `${shape}, ${method}`;
      // No .coherence/.gitattributes: GitHub's merge honours no merge driver (d-44ee2214).
      const root = repo(`land-${shape}-${method}`);
      const other = `${root}-B`;
      fixtures.push(other);
      const S = "one-session";
      let expected = 0;
      const some = (where: string, tag: string, n: number): void => {
        for (let i = 0; i < n; i++) {
          appendAll(where, S, `${tag}${i}`);
          expected += 3;
        }
      };
      some(root, "base", 2);
      ok(root, "add", "-A");
      ok(root, "commit", "-q", "-m", "base with the session's records");
      ok(root, "switch", "-q", "-c", "A");
      some(root, "a", 3);
      appendFileSync(join(root, "code.txt"), "a1\n");
      ok(root, "add", "-A");
      ok(root, "commit", "-q", "-m", "A1");
      // The same session in a second checkout, its branch beside A or on it.
      ok(root, "worktree", "add", "-q", "-b", "B", other, shape === "parallel" ? "main" : "A");
      some(other, "b", 3);
      writeFileSync(join(other, "b.txt"), "b\n");
      ok(other, "add", "-A");
      ok(other, "commit", "-q", "-m", "B");
      // A goes on writing after B forked, in its own checkout, on the same branch.
      some(root, "a2-", 2);
      writeFileSync(join(root, "a2.txt"), "a2\n");
      ok(root, "add", "-A");
      ok(root, "commit", "-q", "-m", "A2");
      const conflicts = [...land(root, "A", method).map((p) => `A: ${p}`), ...land(root, "B", method).map((p) => `B: ${p}`)];
      if (conflicts.length > 0) outcomes.push(`${how}: conflicts in ${conflicts.join(", ")}`);
      const loaded = loadJournal(root).records.length + loadWork(root).records.length + loadRuns(root).records.length;
      if (loaded !== expected) outcomes.push(`${how}: main loads ${loaded} of the ${expected} records`);
      for (const store of STORE_NAMES) if (git(root, "status", "--porcelain", "--", storeDir(store)).out.trim() !== "") outcomes.push(`${how}: ${store} is not clean on main`);
      git(root, "worktree", "remove", "--force", other);
    }
  }
  assert.deepEqual(outcomes, [], "every landing is clean and keeps every record");
});
