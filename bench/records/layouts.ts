/**
 * The record-layout benchmark behind docs/records-layout.md: each candidate
 * layout of the record stores, built from this repository's own records and
 * measured for what a session pays to read and write it, what git pays to
 * carry it, and what a pull request shows of it, and run through the merges
 * GitHub makes, which honour no merge driver.
 *
 * Layouts (paths under .coherence/<store>/):
 *   session   today: <session>.jsonl, appended by every branch of the session
 *   record    (a) one file per record: <session>.<content hash>.jsonl, created once, never appended
 *   shard     (c) one file per writer and head: <session>.<token>.jsonl, appended only while
 *             HEAD, the branch and the file's size are what they were at the last append;
 *             any other state mints a new token, so a committed shard is never appended again
 *   packed    (d) a shard whose records are each led by a record separator (0x1e), with no
 *             newline: one line per shard file, which today's readers cannot split
 *   ref       (b) records off the branch, in a tree on refs/coherence/records
 *
 * Nothing here touches this checkout's stores: it reads them, and builds
 * every layout and repository in a temporary folder it removes.
 *
 *   node bench/records/layouts.ts [--keep] [--scale N]   (N: journal multiple, default 10)
 *
 * Writes bench/records/results.json and prints the tables in Markdown.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuns, entryKey, sitesHash, type RunRecord } from "../../src/enforcement/record.ts";
import { recordsOnOtherBranches } from "../../src/journal/branches.ts";
import { appendWhole } from "../../src/journal/append.ts";
import { STORE_NAMES, storeDir, type RecordStore } from "../../src/journal/stores.ts";
import { journalFileKeys, loadJournal } from "../../src/journal/store.ts";
import { loadWork } from "../../src/journal/work.ts";
import { ATTRIBUTES_TEXT } from "../../src/lifecycle/state-files.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const SCALE = Number(args[args.indexOf("--scale") + 1] ?? 10) || 10;
const WORK = mkdtempSync(join(tmpdir(), "coherence-records-layout-"));
const REF = "refs/coherence/records";
const LAYOUTS = ["session", "record", "shard", "packed"] as const;
type Layout = (typeof LAYOUTS)[number];

// ---------------------------------------------------------------- helpers

function git(cwd: string, gitArgs: string[], input?: string, env?: NodeJS.ProcessEnv): { status: number; out: string; err: string } {
  const run = spawnSync("git", gitArgs, { cwd, input, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 * 1024, env: { ...process.env, GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.com", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.com", ...env } });
  return { status: run.status ?? -1, out: run.stdout ?? "", err: run.stderr ?? "" };
}

function must(cwd: string, gitArgs: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  const run = git(cwd, gitArgs, input, env);
  if (run.status !== 0) throw new Error(`git ${gitArgs.join(" ")} failed in ${cwd}: ${run.err}`);
  return run.out;
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  must(dir, ["init", "-q", "-b", "main"]);
  must(dir, ["config", "commit.gpgsign", "false"]);
  must(dir, ["config", "core.autocrlf", "false"]);
}

function commitAll(dir: string, message: string): void {
  must(dir, ["add", "-A"]);
  must(dir, ["commit", "-q", "--allow-empty", "-m", message]);
}

/** Milliseconds of `fn`, median of `n` runs. */
function timed<T>(n: number, fn: () => T): { ms: number; value: T } {
  const times: number[] = [];
  let value!: T;
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    value = fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { ms: Math.round(times[Math.floor(n / 2)]! * 10) / 10, value };
}

const hash = (text: string, n = 16): string => createHash("sha256").update(text).digest("hex").slice(0, n);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Count, bytes and lines of every store file under a project root. */
function footprint(root: string): { files: number; bytes: number; lines: number } {
  let files = 0, bytes = 0, lines = 0;
  for (const store of STORE_NAMES)
    for (const file of filesUnder(join(root, storeDir(store)))) {
      const text = readFileSync(file, "utf8");
      files++;
      bytes += Buffer.byteLength(text);
      lines += text.split("\n").filter((l) => l.trim() !== "").length;
    }
  return { files, bytes, lines };
}

// ---------------------------------------------------------------- the real records, and the commit that added each line

interface Line { store: RecordStore; file: string; text: string; session: string; commit: string }

/** Every line of every store file in this checkout, each with the oldest non-merge commit that added it (or "uncommitted"). */
function realLines(): Line[] {
  const added = new Map<string, string>();
  const folders = STORE_NAMES.map((store) => storeDir(store));
  const log = must(REPO, ["log", "--reverse", "--no-merges", "-p", "--unified=0", "--no-renames", "--no-color", "--format=@@@%h", "--", ...folders]);
  let commit = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("@@@")) commit = line.slice(3);
    else if (line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1).trim();
      if (text !== "" && !added.has(text)) added.set(text, commit);
    }
  }
  const out: Line[] = [];
  for (const store of STORE_NAMES) {
    const dir = join(REPO, storeDir(store));
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
      const seen = new Set<string>();
      for (const raw of readFileSync(join(dir, name), "utf8").split("\n")) {
        const text = raw.trim();
        if (text === "" || seen.has(text)) continue;
        seen.add(text);
        let session = name.slice(0, -".jsonl".length);
        try { session = String((JSON.parse(text) as { session?: string }).session ?? session); } catch { /* a torn line keeps its file's session */ }
        out.push({ store, file: name, text, session, commit: added.get(text) ?? "uncommitted" });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- building each layout from the real lines

/**
 * Runs carry their sites once per file and refer to them after (record.ts),
 * so a layout that splits a session's runs must write each new file's first
 * entry of an enforcement in full again: the runs are resolved from today's
 * files, then compacted afresh per file of every layout, today's included,
 * since runs written before compaction existed hold their sites in full.
 */
function resolvedRuns(lines: Line[]): Map<string, string> {
  const byText = new Map<string, string>();
  const runLines = lines.filter((l) => l.store === "runs");
  for (const file of [...new Set(runLines.map((l) => l.file))]) {
    const dir = mkdtempSync(join(WORK, "resolve-"));
    mkdirSync(join(dir, storeDir("runs")), { recursive: true });
    writeFileSync(join(dir, storeDir("runs"), file), readFileSync(join(REPO, storeDir("runs"), file)));
    const loaded = loadRuns(dir);
    const byAt = new Map<string, unknown>();
    for (const r of [...loaded.records, ...loaded.refutations]) byAt.set(`${r.at}\0${(r as { kind?: string }).kind ?? "run"}`, r);
    for (const l of runLines.filter((x) => x.file === file)) {
      try {
        const parsed = JSON.parse(l.text) as { at: string; kind?: string };
        const resolvedRecord = byAt.get(`${parsed.at}\0${parsed.kind ?? "run"}`);
        if (resolvedRecord !== undefined) byText.set(l.text, JSON.stringify(resolvedRecord));
      } catch { /* a torn line stays as it was */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  return byText;
}

/** One file's runs written as record.ts writes them: each enforcement's sites in full the first time in the file, then by reference. */
function compactRuns(texts: string[]): string[] {
  const held = new Map<string, { hash: string; at: string }>();
  return texts.map((text) => {
    let run: RunRecord;
    try { run = JSON.parse(text) as RunRecord; } catch { return text; }
    if (!Array.isArray(run.invariants)) return text;
    run.invariants = run.invariants.map((entry) => {
      if (entry.sites === undefined) return entry;
      const key = entryKey(entry.component, entry.name, entry.form);
      const h = sitesHash(entry.sites);
      const before = held.get(key);
      if (before !== undefined && before.hash === h) {
        const { sites: _sites, ...rest } = entry;
        return { ...rest, sitesRef: { hash: h, at: before.at } } as typeof entry;
      }
      held.set(key, { hash: h, at: run.at });
      return entry;
    });
    return JSON.stringify(run);
  });
}

function writeLayout(root: string, layout: Layout, lines: Line[], resolved: Map<string, string>): void {
  const groups = new Map<string, Line[]>();
  for (const l of lines) {
    const name = layout === "session" ? l.file
      : layout === "record" ? `${l.session}.${hash(l.text)}.jsonl`
      : `${l.file.slice(0, -".jsonl".length)}.${l.commit}.jsonl`; // shard and packed: one file per session file and commit
    const key = join(storeDir(l.store), name);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [l]);
    else group.push(l);
  }
  for (const [rel, members] of groups) {
    const store = members[0]!.store;
    let texts = members.map((m) => m.text);
    if (store === "runs") texts = compactRuns(members.map((m) => resolved.get(m.text) ?? m.text));
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), layout === "packed" ? texts.map((t) => `\x1e${t}`).join("") : texts.join("\n") + "\n");
  }
}

/** The journal multiplied: each record again under another session and id, laid out as `layout` lays it. */
function scaledJournal(root: string, layout: Layout, lines: Line[], times: number): void {
  const journal = lines.filter((l) => l.store === "journal");
  const scaled: Line[] = [];
  for (let k = 0; k < times; k++)
    for (const l of journal) {
      if (k === 0) { scaled.push(l); continue; }
      let text = l.text;
      try {
        const r = JSON.parse(l.text) as Record<string, unknown>;
        r["id"] = `${String(r["id"])}${k.toString(16)}`;
        r["session"] = `${String(r["session"])}-x${k}`;
        text = JSON.stringify(r);
      } catch { /* a torn line copied as it is */ }
      const session = `${l.session}-x${k}`;
      scaled.push({ ...l, text, session, file: `${session}.jsonl` });
    }
  writeLayout(root, layout, scaled, new Map());
}

// ---------------------------------------------------------------- reading each layout

function readCosts(root: string): Record<string, number> {
  const journal = timed(5, () => loadJournal(root));
  const runs = timed(3, () => loadRuns(root));
  const work = timed(5, () => loadWork(root));
  const keys = timed(5, () => journalFileKeys(root));
  // A reader that splits on the record separator as well as the newline: what packed shards need of every reader.
  const split = timed(5, () => {
    let n = 0;
    const dir = join(root, storeDir("journal"));
    for (const name of readdirSync(dir)) for (const part of readFileSync(join(dir, name), "utf8").split(/[\n\x1e]/)) if (part.trim() !== "") { JSON.parse(part); n++; }
    return n;
  });
  const statAll = timed(5, () => {
    let n = 0;
    for (const store of STORE_NAMES) {
      const dir = join(root, storeDir(store));
      for (const name of readdirSync(dir)) { statSync(join(dir, name)); n++; }
    }
    return n;
  });
  return {
    journalRecords: journal.value.records.length, journalDamaged: journal.value.damaged.length, loadJournalMs: journal.ms,
    runRecords: runs.value.records.length + runs.value.refutations.length, runsDamaged: runs.value.damaged.length, loadRunsMs: runs.ms,
    workRecords: work.value.records.length, loadWorkMs: work.ms,
    splitReaderJournalRecords: split.value, splitReaderJournalMs: split.ms,
    journalFileKeysMs: keys.ms, statEveryStoreFileMs: statAll.ms,
  };
}

/** What git pays to carry a layout: the commit that adds it, a status, a tree listing, and the cross-branch citation search. */
function gitCosts(root: string, someId: string): Record<string, number> {
  initRepo(root);
  const add = timed(1, () => commitAll(root, "records"));
  must(root, ["branch", "other"]);
  const status = timed(3, () => must(root, ["status", "--porcelain"]));
  const tree = timed(3, () => must(root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").length - 1);
  const grep = timed(3, () => recordsOnOtherBranches(root, [someId]).size);
  return { commitMs: add.ms, statusMs: status.ms, lsTreeMs: tree.ms, treeEntries: tree.value, citationSearchMs: grep.ms, citationFound: grep.value };
}

/** Records committed to refs/coherence/records with a scratch index, never the worktree; read back with one ls-tree and one cat-file --batch. */
function refCosts(sessionRoot: string): Record<string, number> {
  const repo = join(WORK, "ref-repo");
  initRepo(repo);
  commitAll(repo, "base");
  const index = join(WORK, "ref-index");
  const env = { GIT_DIR: join(repo, ".git"), GIT_INDEX_FILE: index, GIT_WORK_TREE: sessionRoot };
  const write = timed(1, () => {
    must(sessionRoot, ["add", "-A", "--", ...STORE_NAMES.map((s) => storeDir(s))], undefined, env);
    const tree = must(sessionRoot, ["write-tree"], undefined, env).trim();
    const commit = must(repo, ["commit-tree", tree, "-m", "records"]).trim();
    must(repo, ["update-ref", REF, commit]);
  });
  const read = timed(5, () => {
    const listing = must(repo, ["ls-tree", "-r", REF]).split("\n").filter(Boolean);
    const shas = listing.map((l) => l.split(/\s+/)[2]!);
    const blobs = must(repo, ["cat-file", "--batch"], shas.join("\n") + "\n");
    let records = 0;
    for (const line of blobs.split("\n")) {
      if (!line.startsWith("{")) continue;
      try { JSON.parse(line); records++; } catch { /* a header or a torn line */ }
    }
    return records;
  });
  const diffAgainstMain = must(repo, ["diff", "--shortstat", "main"]).trim();
  return { refWriteAllMs: write.ms, refReadAllMs: read.ms, refRecordsRead: read.value, prDiffShortstatEmpty: diffAgainstMain === "" ? 1 : 0 };
}

// ---------------------------------------------------------------- writing one record

interface ShardState { head: string; branch: string; name: string; size: number }

/**
 * HEAD and its branch read from the git folder's files, with no spawn: a
 * worktree's .git file names its folder, and a branch's ref is in the common
 * folder or packed-refs. A repository on the reftable backend would need git
 * rev-parse instead (the "shard-spawn" write cost below).
 */
function headOf(root: string): { head: string; branch: string } {
  let gitDir = join(root, ".git");
  if (statSync(gitDir).isFile()) gitDir = resolve(root, readFileSync(gitDir, "utf8").replace(/^gitdir:\s*/, "").trim());
  const common = existsSync(join(gitDir, "commondir")) ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : gitDir;
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return { head, branch: "" };
  const ref = head.slice("ref: ".length);
  for (const dir of [gitDir, common]) if (existsSync(join(dir, ref))) return { head: readFileSync(join(dir, ref), "utf8").trim(), branch: ref };
  const packed = existsSync(join(common, "packed-refs")) ? readFileSync(join(common, "packed-refs"), "utf8") : "";
  return { head: packed.split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0] ?? "", branch: ref };
}

/**
 * How a writer appends. "shard" mints a new file whenever HEAD, the branch or
 * the file's size is not what it was at its last append, so a commit seals a
 * shard; "branch-shard" mints only when the branch or the size changes, the
 * variant a squash or rebase merge of stacked branches defeats; "shard-spawn"
 * is "shard" asking git for HEAD with two spawns instead of reading its files;
 * "packed-shard" is "shard" with each record led by a record separator (0x1e)
 * and no newline, so a shard is one line however many records it holds.
 */
type Mode = Layout | "branch-shard" | "shard-spawn" | "packed-shard" | "ref";

/** One writer's appends under a layout, in a repository checkout. */
class Writer {
  private readonly shards = new Map<string, ShardState>();
  private readonly root: string;
  private readonly mode: Mode;
  constructor(root: string, mode: Mode) {
    this.root = root;
    this.mode = mode;
  }

  append(store: RecordStore, session: string, line: string): void {
    const dir = join(this.root, storeDir(store));
    mkdirSync(dir, { recursive: true });
    if (this.mode === "session") appendWhole(join(dir, `${session}.jsonl`), `${line}\n`);
    else if (this.mode === "record") writeFileSync(join(dir, `${session}.${hash(line)}.jsonl`), `${line}\n`, { flag: "wx" });
    else if (this.mode !== "ref") {
      const { head, branch } = this.mode === "shard-spawn"
        ? { head: git(this.root, ["rev-parse", "HEAD"]).out.trim(), branch: git(this.root, ["symbolic-ref", "-q", "HEAD"]).out.trim() }
        : headOf(this.root);
      const key = `${store}\0${session}`;
      const held = this.shards.get(key);
      const size = held === undefined ? -1 : existsSync(join(dir, held.name)) ? statSync(join(dir, held.name)).size : -1;
      const reuse = held !== undefined && held.branch === branch && held.size === size && (this.mode === "branch-shard" || held.head === head);
      const name = reuse ? held.name : `${session}.${randomBytes(4).toString("hex")}.jsonl`;
      if (this.mode === "packed-shard") appendFileSync(join(dir, name), `\x1e${line}`);
      else appendWhole(join(dir, name), `${line}\n`);
      this.shards.set(key, { head, branch, name, size: statSync(join(dir, name)).size });
    } else {
      // ref: the session's file read from the ref, the line added, and a commit on the ref, under compare-and-swap.
      const path = `${storeDir(store)}/${session}.jsonl`;
      const old = git(this.root, ["rev-parse", "-q", "--verify", REF]).out.trim();
      const before = old === "" ? "" : git(this.root, ["cat-file", "-p", `${REF}:${path}`]).out;
      const blob = must(this.root, ["hash-object", "-w", "--stdin"], `${before}${line}\n`).trim();
      const env = { GIT_INDEX_FILE: resolve(this.root, must(this.root, ["rev-parse", "--git-path", "coherence-records-index"]).trim()) };
      if (old !== "") must(this.root, ["read-tree", REF], undefined, env);
      else must(this.root, ["read-tree", "--empty"], undefined, env);
      must(this.root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], undefined, env);
      const tree = must(this.root, ["write-tree"], undefined, env).trim();
      const commit = must(this.root, ["commit-tree", tree, ...(old === "" ? [] : ["-p", old]), "-m", "record"]).trim();
      must(this.root, ["update-ref", REF, commit, ...(old === "" ? [] : [old])]);
    }
  }
}

function recordLine(store: RecordStore, session: string, tag: string): string {
  const at = new Date(Date.UTC(2026, 9, 14, 12, 0, 0) + Math.floor(Math.random() * 1e8)).toISOString();
  const id = `d-${hash(`${tag}${at}${Math.random()}`, 8)}`;
  if (store === "runs") return JSON.stringify({ at, session, agent: "bench", commit: null, dirty: false, invariants: [{ component: "src/x", name: `bench ${tag}`, form: "test", verdict: "pass", files: [] }] });
  if (store === "work") return JSON.stringify({ id: `w-${id.slice(2)}`, kind: "order", at, session, agent: "bench", objective: tag, success: tag, owner: session });
  return JSON.stringify({ id, kind: "decision", at, session, agent: "bench", chose: tag, over: "nothing", because: "bench" });
}

function writeCosts(layout: Mode): number {
  const root = join(WORK, `write-${layout}`);
  initRepo(root);
  commitAll(root, "base");
  const writer = new Writer(root, layout);
  const n = 100;
  const start = performance.now();
  for (let i = 0; i < n; i++) writer.append("journal", "s-bench", recordLine("journal", "s-bench", `w${i}`));
  return Math.round(((performance.now() - start) / n) * 100) / 100;
}

// ---------------------------------------------------------------- merges as GitHub makes them

type Method = "merge" | "squash" | "rebase";
interface Outcome { scenario: string; layout: string; attributes: string; method: Method; prA: string; prB: string; conflicts: string[]; recordsAfter: number; recordsExpected: number }

/** Every record line on main's tree (or on the ref), read once each. */
function mainRecords(root: string, layout: Mode): number {
  const seen = new Set<string>();
  const source = layout === "ref" ? REF : "main";
  const listing = git(root, ["ls-tree", "-r", "--name-only", source]).out.split("\n").filter((p) => p.endsWith(".jsonl"));
  for (const path of listing) for (const l of git(root, ["show", `${source}:${path}`]).out.split(/[\n\x1e]/)) if (l.trim() !== "") seen.add(l.trim());
  return seen.size;
}

/** Merge `branch` into main as GitHub's button does; the conflicted paths, none when it merged. */
function land(root: string, branch: string, method: Method): string[] {
  must(root, ["checkout", "-q", "main"]);
  if (method === "rebase") {
    must(root, ["checkout", "-q", "-B", `rebased-${branch}`, branch]);
    const rebase = git(root, ["rebase", "-q", "main"]);
    if (rebase.status !== 0) {
      const conflicts = git(root, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
      git(root, ["rebase", "--abort"]);
      must(root, ["checkout", "-q", "main"]);
      return conflicts.length ? conflicts : ["(rebase failed)"];
    }
    must(root, ["checkout", "-q", "main"]);
    must(root, ["merge", "-q", "--ff-only", `rebased-${branch}`]);
    return [];
  }
  const run = git(root, method === "squash" ? ["merge", "-q", "--squash", branch] : ["merge", "-q", "--no-ff", "--no-edit", branch]);
  if (run.status !== 0) {
    const conflicts = git(root, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
    git(root, ["merge", "--abort"]);
    git(root, ["reset", "-q", "--hard", "main"]);
    return conflicts.length ? conflicts : ["(merge failed)"];
  }
  if (method === "squash") must(root, ["commit", "-q", "-m", `squash ${branch}`]);
  return [];
}

/** The pull request's numbers as GitHub counts them: what the branch adds since its merge base with main. */
function prStat(root: string, branch: string): string {
  const out = git(root, ["diff", "--shortstat", `main...${branch}`]).out.trim();
  return out === "" ? "0 files" : out.replace(/ changed|\(\+\)|\(-\)/g, "").replace(/insertions?/, "+").replace(/deletions?/, "-");
}

function scenario(name: "parallel" | "stacked", layout: Mode, attributes: "none (GitHub)" | "merge=union (local)", method: Method): Outcome {
  const root = join(WORK, `merge-${name}-${layout}-${method}-${attributes.startsWith("none") ? "gh" : "local"}`);
  initRepo(root);
  if (attributes !== "none (GitHub)") {
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(join(root, ".coherence", ".gitattributes"), ATTRIBUTES_TEXT);
  }
  writeFileSync(join(root, "code.txt"), "base\n");
  // One session, two checkouts: A in the main worktree, B in a worktree of its own, as a session and its stacked or parallel branch are.
  const wtB = `${root}-B`;
  const writerA = new Writer(root, layout);
  const writerB = new Writer(wtB, layout);
  let expected = 0;
  const appendSome = (writer: Writer, tag: string, n: number): void => {
    for (let i = 0; i < n; i++) for (const store of STORE_NAMES) { writer.append(store, "S", recordLine(store, "S", `${tag}${i}`)); expected++; }
  };
  appendSome(writerA, "main", 3);
  commitAll(root, "base with session S");
  must(root, ["checkout", "-q", "-b", "A"]);
  appendSome(writerA, "a", 4);
  appendFileSync(join(root, "code.txt"), "a1\n");
  commitAll(root, "A1");
  must(root, ["worktree", "add", "-q", "-b", "B", wtB, name === "parallel" ? "main" : "A"]);
  appendSome(writerB, "b", 4);
  writeFileSync(join(wtB, "b.txt"), "b\n");
  commitAll(wtB, name === "parallel" ? "B beside A" : "B on A");
  // A goes on writing after B forked, in the same checkout, on the same branch.
  appendSome(writerA, "a2-", 2);
  writeFileSync(join(root, "a2.txt"), "a2\n");
  commitAll(root, "A2 after B forked");
  const prA = prStat(root, "A");
  const conflictsA = land(root, "A", method);
  const prB = prStat(root, "B");
  const conflictsB = land(root, "B", method);
  return { scenario: name, layout, attributes, method, prA, prB, conflicts: [...conflictsA.map((c) => `A: ${c}`), ...conflictsB.map((c) => `B: ${c}`)], recordsAfter: mainRecords(root, layout), recordsExpected: expected };
}

// ---------------------------------------------------------------- the ref's own mechanics: clone, fetch, push

function refMechanics(): Record<string, string> {
  const origin = join(WORK, "origin.git");
  must(WORK, ["init", "-q", "--bare", "-b", "main", origin]);
  const one = join(WORK, "clone-one");
  must(WORK, ["clone", "-q", origin, one]);
  must(one, ["config", "commit.gpgsign", "false"]);
  commitAll(one, "base");
  must(one, ["push", "-q", "origin", "main"]);
  const w1 = new Writer(one, "ref");
  w1.append("journal", "S", recordLine("journal", "S", "one"));
  const plainPush = git(one, ["push", "origin", "main"]);
  const remoteAfterPlainPush = must(one, ["ls-remote", "origin", "refs/coherence/*"]).trim();
  must(one, ["push", "-q", "origin", REF]);
  const two = join(WORK, "clone-two");
  must(WORK, ["clone", "-q", origin, two]);
  const cloneHasRef = git(two, ["rev-parse", "-q", "--verify", REF]).out.trim() !== "";
  must(two, ["fetch", "-q", "origin", `+${REF}:${REF}`]);
  const w2 = new Writer(two, "ref");
  w2.append("journal", "S", recordLine("journal", "S", "two"));
  w1.append("journal", "S", recordLine("journal", "S", "one-more"));
  must(one, ["push", "-q", "origin", REF]);
  const racedPush = git(two, ["push", "origin", REF]);
  return {
    "a plain push of the branch carries the ref": remoteAfterPlainPush === "" && plainPush.status === 0 ? "no: the remote has no refs/coherence/* after git push origin main" : "yes",
    "a fresh clone has the ref": cloneHasRef ? "yes" : "no: clone fetches refs/heads and tags only; it needs git fetch origin +refs/coherence/records:refs/coherence/records",
    "a second writer's push after the first pushed": racedPush.status === 0 ? "accepted" : `rejected (non-fast-forward): it must fetch, merge the two record trees itself, and push again`,
  };
}

// ---------------------------------------------------------------- run everything

function table(rows: Record<string, unknown>[]): string {
  const cols = Object.keys(rows[0] ?? {});
  return [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`)].join("\n");
}

const onDisk = footprint(REPO);
const results: Record<string, unknown> = { onDiskToday: onDisk, at: new Date().toISOString(), node: process.version, git: must(REPO, ["--version"]).trim(), platform: `${process.platform} ${process.arch}`, scale: SCALE, head: must(REPO, ["rev-parse", "--short", "HEAD"]).trim() };
try {
  const lines = realLines();
  const resolved = resolvedRuns(lines);
  const someId = (JSON.parse(lines.find((l) => l.store === "journal")!.text) as { id: string }).id;

  const layoutRows: Record<string, unknown>[] = [];
  const scaleRows: Record<string, unknown>[] = [];
  for (const layout of LAYOUTS) {
    const root = join(WORK, `layout-${layout}`);
    writeLayout(root, layout, lines, resolved);
    const foot = footprint(root);
    const reads = readCosts(root);
    const gits = gitCosts(root, someId);
    layoutRows.push({ layout, files: foot.files, lines: foot.lines, MB: (foot.bytes / 1e6).toFixed(1), ...reads, ...gits });

    const big = join(WORK, `scale-${layout}`);
    scaledJournal(big, layout, lines, SCALE);
    const journal = timed(3, () => loadJournal(big));
    const keys = timed(3, () => journalFileKeys(big));
    const bigGit = gitCosts(big, someId);
    scaleRows.push({ layout, journalFiles: filesUnder(join(big, storeDir("journal"))).length, journalRecords: journal.value.records.length, loadJournalMs: journal.ms, journalFileKeysMs: keys.ms, commitMs: bigGit.commitMs, statusMs: bigGit.statusMs, citationSearchMs: bigGit.citationSearchMs });
  }
  const ref = refCosts(join(WORK, "layout-session"));
  results["layouts"] = layoutRows;
  results["scaledJournal"] = scaleRows;
  results["ref"] = ref;

  const writes: Record<string, number> = {};
  for (const layout of ["session", "record", "shard", "shard-spawn", "ref"] as const) writes[layout] = writeCosts(layout);
  results["appendMsPerRecord"] = writes;

  const outcomes: Outcome[] = [];
  for (const name of ["parallel", "stacked"] as const)
    for (const method of ["merge", "squash", "rebase"] as const) {
      outcomes.push(scenario(name, "session", "merge=union (local)", method));
      for (const layout of ["session", "record", "branch-shard", "shard", "packed-shard", "ref"] as const) outcomes.push(scenario(name, layout, "none (GitHub)", method));
    }
  results["merges"] = outcomes.map((o) => ({ ...o, conflicts: o.conflicts.length, conflicted: o.conflicts.join("; ") }));
  results["refMechanics"] = refMechanics();

  writeFileSync(join(REPO, "bench", "records", "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`## Layouts over this repository's records (${results["head"]}, ${results["platform"]}, node ${results["node"]}, ${results["git"]})\n`);
  console.log(table(layoutRows));
  console.log(`\n## The journal at ${SCALE}x\n`);
  console.log(table(scaleRows));
  console.log(`\n## Records on ${REF}\n`);
  console.log(table([ref]));
  console.log(`\n## One append (ms per record, mean over 100)\n`);
  console.log(table([writes]));
  console.log(`\n## Merges\n`);
  console.log(table(results["merges"] as Record<string, unknown>[]));
  console.log(`\n## The ref's mechanics\n`);
  console.log(table(Object.entries(results["refMechanics"] as Record<string, string>).map(([q, a]) => ({ question: q, answer: a }))));
} finally {
  if (KEEP) console.error(`kept ${WORK}`);
  else rmSync(WORK, { recursive: true, force: true });
}

