/**
 * The sealed shards as shipped (src/journal/shards.ts), measured on this
 * repository: what the journal costs to read at 1x and 10x, what one append
 * costs through the real writers, line and packed, with git's index as it is
 * and rewritten before every append, and whether a branch's records land on
 * main on GitHub's terms, with no merge driver.
 *
 *   node bench/records/shipped.ts                       # reads and appends; writes bench/records/shipped.json
 *   node bench/records/shipped.ts --merge <base> <head> # lands head on base with no attributes, merge, squash and rebase
 *
 * GitHub's merge honours no merge driver (d-44ee2214). The landing stands in
 * for it as layouts.ts does (u-beb57c2a), in a scratch clone, with git told to
 * read attributes from the empty tree (attr.tree), so .coherence/.gitattributes'
 * merge=union does not apply; the same landing of two appends to one legacy
 * session file conflicts, which shows the simulation is the one GitHub makes.
 * Nothing here touches this checkout's stores.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuns, appendRun, type RunRecord } from "../../src/enforcement/record.ts";
import { appendWhole } from "../../src/journal/append.ts";
import type { Decision } from "../../src/journal/record.ts";
import { shardFor } from "../../src/journal/shards.ts";
import { appendRecord, loadJournal } from "../../src/journal/store.ts";
import { isStoreFile } from "../../src/journal/stores.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const args = process.argv.slice(2);
const WORK = mkdtempSync(join(tmpdir(), "coherence-shipped-"));

function git(cwd: string, gitArgs: string[]): { status: number; out: string } {
  const run = spawnSync("git", ["-c", "user.email=b@example.com", "-c", "user.name=bench", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...gitArgs], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { status: run.status ?? 1, out: `${run.stdout}${run.stderr}` };
}

function must(cwd: string, gitArgs: string[]): string {
  const run = git(cwd, gitArgs);
  if (run.status !== 0) throw new Error(`git ${gitArgs.join(" ")}: ${run.out}`);
  return run.out;
}

/** Milliseconds of `fn`, median of `n` runs. */
function timed(n: number, fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(n / 2)]! * 100) / 100;
}

// ---------------------------------------------------------------- reads

/** This checkout's journal, copied, and copied again `times - 1` more times under other ids and sessions, as shards. */
function journalAt(times: number): string {
  const root = join(WORK, `journal-${times}x`);
  const from = join(REPO, ".coherence", "journal");
  const to = join(root, ".coherence", "journal");
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  for (let k = 1; k < times; k++) {
    for (const name of readdirSync(from).filter(isStoreFile)) {
      const lines = readFileSync(join(from, name), "utf8").split(/[\n\u001e]/).filter((l) => l.trim() !== "").map((line) => {
        try {
          const r = JSON.parse(line) as Record<string, unknown>;
          r["id"] = `${String(r["id"])}${k.toString(16)}`;
          r["session"] = `${String(r["session"])}-x${k}`;
          return JSON.stringify(r);
        } catch {
          return line;
        }
      });
      writeFileSync(join(to, `${name.split(".")[0]}-x${k}.${k.toString(16).padStart(8, "0")}.jsonl`), `${lines.join("\n")}\n`);
    }
  }
  return root;
}

function reads(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const times of [1, 10]) {
    const root = journalAt(times);
    const records = loadJournal(root).records.length;
    out[`loadJournal ${times}x`] = { records, files: readdirSync(join(root, ".coherence", "journal")).length, ms: timed(7, () => loadJournal(root)) };
  }
  out["loadRuns 1x"] = { ms: timed(3, () => loadRuns(REPO)), records: loadRuns(REPO).records.length };
  return out;
}

// ---------------------------------------------------------------- appends

let serial = 0;
const decision = (): Decision => ({ id: `d-${(++serial).toString(16).padStart(8, "0")}`, kind: "decision", at: new Date(Date.UTC(2026, 9, 14) + serial * 1000).toISOString(), session: "bench", agent: "bench", commit: null, dirty: false, chose: "a choice of about this length", over: ["the other"], because: "a reason of about the length the journal's records carry" }) as Decision;
const run = (): RunRecord => ({ at: new Date(Date.UTC(2026, 9, 14) + ++serial * 1000).toISOString(), session: "bench", agent: "bench", commit: null, dirty: false, instrument: { language: "typescript", server: "warm" }, latency: 1, invariants: [{ component: "src/a", name: "bench", form: "totality oracle", verdict: "pass", refutation: "witnessed", bypasses: [], testReferences: 0, files: [], latency: 1, reason: "passed" }] });

/** A repository whose index lists `files` tracked files, as a project's does. */
function project(files: number): string {
  const root = join(WORK, `append-${files}`);
  mkdirSync(join(root, "src"), { recursive: true });
  must(root, ["init", "-q", "-b", "main"]);
  for (let i = 0; i < files; i++) writeFileSync(join(root, "src", `f${i}.ts`), `export const f${i} = ${i};\n`);
  writeFileSync(join(root, ".gitignore"), ".coherence/cache/\n");
  must(root, ["add", "-A"]);
  must(root, ["commit", "-q", "-m", "base"]);
  return root;
}

function appends(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const n = 200;
  for (const files of [100, 20_000]) {
    const root = project(files);
    const index = join(root, ".git", "index");
    const indexBytes = readFileSync(index).length;
    const row: Record<string, unknown> = { trackedFiles: files, indexBytes };
    // 1.7.x's append: one session file, no shard chosen; what choosing a shard adds is the difference.
    const legacy = join(root, "legacy.jsonl");
    row["bare appendWhole to one file (1.7.x's append)"] = timed(n, () => appendWhole(legacy, `${JSON.stringify(decision())}\n`));
    for (const packed of [false, true]) {
      if (packed) process.env["COHERENCE_PACKED_RECORDS"] = "1";
      else delete process.env["COHERENCE_PACKED_RECORDS"];
      const label = packed ? "packed" : "line";
      appendRecord(root, decision());
      row[`choosing the shard and keeping its state, ${label}`] = timed(n, () => shardFor(root, "journal", "bench").kept());
      row[`journal append, ${label}`] = timed(n, () => appendRecord(root, decision()));
      row[`run append, ${label}`] = timed(n, () => appendRun(root, run()));
      // Git rewrote its index before every append (a stage, a status that refreshed it): the index is searched each time.
      row[`journal append, ${label}, index rewritten each time`] = timed(n, () => {
        const now = new Date();
        utimesSync(index, now, now);
        appendRecord(root, decision());
      });
    }
    delete process.env["COHERENCE_PACKED_RECORDS"];
    row["shards written"] = readdirSync(join(root, ".coherence", "journal")).length;
    out[`${files} tracked files`] = row;
  }
  return out;
}

// ---------------------------------------------------------------- landing on GitHub's terms

/** Land `head` on `base` in a scratch clone with no attributes in force; the conflicted paths per method. */
function landings(base: string, head: string): Record<string, string[]> {
  const clone = join(WORK, "clone");
  must(WORK, ["clone", "-q", "--no-checkout", REPO, clone]);
  const noAttributes = ["-c", `attr.tree=${EMPTY_TREE}`];
  const out: Record<string, string[]> = {};
  for (const method of ["merge", "squash", "rebase"] as const) {
    must(clone, ["checkout", "-q", "-f", "-B", `land-${method}`, base]);
    const ran = method === "rebase"
      ? (must(clone, ["checkout", "-q", "-f", "-B", `head-${method}`, head]), git(clone, [...noAttributes, "rebase", "-q", `land-${method}`]))
      : git(clone, [...noAttributes, "merge", "-q", ...(method === "squash" ? ["--squash"] : ["--no-ff", "--no-edit"]), head]);
    const conflicts = ran.status === 0 ? [] : must(clone, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter((p) => p !== "");
    out[method] = ran.status === 0 ? [] : conflicts.length > 0 ? conflicts : [`(failed: ${ran.out.trim().split("\n").at(-1)})`];
    git(clone, [method === "rebase" ? "rebase" : "merge", "--abort"]);
    git(clone, ["reset", "-q", "--hard"]);
  }
  return out;
}

/** The control: two branches that each append to one legacy session file conflict on GitHub's terms, and merge by union with the attributes. */
function control(): Record<string, string> {
  const root = join(WORK, "control");
  mkdirSync(join(root, ".coherence", "journal"), { recursive: true });
  must(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, ".coherence", ".gitattributes"), "journal/*.jsonl merge=union\n");
  writeFileSync(join(root, ".coherence", "journal", "s.jsonl"), "{\"id\":\"d-1\"}\n");
  must(root, ["add", "-A"]);
  must(root, ["commit", "-q", "-m", "base"]);
  must(root, ["switch", "-q", "-c", "side"]);
  writeFileSync(join(root, ".coherence", "journal", "s.jsonl"), "{\"id\":\"d-1\"}\n{\"id\":\"d-side\"}\n");
  must(root, ["commit", "-q", "-am", "side"]);
  must(root, ["switch", "-q", "main"]);
  writeFileSync(join(root, ".coherence", "journal", "s.jsonl"), "{\"id\":\"d-1\"}\n{\"id\":\"d-main\"}\n");
  must(root, ["commit", "-q", "-am", "main"]);
  const github = git(root, ["-c", `attr.tree=${EMPTY_TREE}`, "merge", "-q", "--no-edit", "side"]);
  git(root, ["merge", "--abort"]);
  const local = git(root, ["merge", "-q", "--no-edit", "side"]);
  return { "no attributes (GitHub)": github.status === 0 ? "clean" : "conflict", "merge=union (local)": local.status === 0 ? "clean" : "conflict" };
}

try {
  if (args[0] === "--merge") {
    const [base, head] = [args[1] ?? "origin/main", args[2] ?? "HEAD"];
    console.log(JSON.stringify({ base, head, control: control(), conflicts: landings(base, head) }, null, 2));
  } else {
    const results = { at: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, head: must(REPO, ["rev-parse", "--short", "HEAD"]).trim(), reads: reads(), appends: appends() };
    writeFileSync(join(REPO, "bench", "records", "shipped.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify(results, null, 2));
  }
} finally {
  rmSync(WORK, { recursive: true, force: true });
}
