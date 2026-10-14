/**
 * What an earlier release's readers make of the stores this release writes:
 * line shards (<session>.<token>.jsonl) and packed shards
 * (<session>.<token>.jsonseq). The earlier release is its source tree,
 * extracted from git, so nothing is installed:
 *
 *   mkdir /tmp/old && git archive <1.7.x commit> src .github | tar -x -C /tmp/old
 *   node bench/records/old-readers.ts . /tmp/old
 *
 * Writes one session's records in lines and one session's packed, commits
 * them on a branch, and prints what the earlier loaders, peer feed stat pass,
 * run index, citation search and CI records summary read of each.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [worktree, old] = process.argv.slice(2).map((p) => resolve(p)) as [string, string];
const neu = {
  store: await import(join(worktree, "src/journal/store.ts")),
  work: await import(join(worktree, "src/journal/work.ts")),
  record: await import(join(worktree, "src/enforcement/record.ts")),
};
const was = {
  store: await import(join(old, "src/journal/store.ts")),
  work: await import(join(old, "src/journal/work.ts")),
  record: await import(join(old, "src/enforcement/record.ts")),
  branches: await import(join(old, "src/journal/branches.ts")),
  statusline: await import(join(old, "src/lifecycle/statusline.ts")),
  runIndex: await import(join(old, "src/enforcement/run-index.ts")),
};

const root = mkdtempSync(join(tmpdir(), "old-readers-"));
const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8" });
git("init", "-q", "-b", "main");
writeFileSync(join(root, "x"), "x\n");
git("add", "-A");
git("commit", "-q", "-m", "base");
let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 14) + ++n * 1000).toISOString();
const all = (session: string) => {
  neu.store.appendRecord(root, { id: `d-${n.toString(16).padStart(8, "0")}`, kind: "decision", at: at(), session, agent: "probe", commit: null, dirty: false, chose: "c", over: ["o"], because: "b" });
  neu.work.appendWork(root, { id: `wo-${n.toString(16).padStart(8, "0")}`, kind: "order", at: at(), session, agent: "probe", commit: null, dirty: false, objective: "o", success: "s", boundary: "b", owner: session });
  neu.record.appendRun(root, { at: at(), session, agent: "probe", commit: null, dirty: false, instrument: { language: "typescript", server: "none" }, latency: 1, invariants: [{ component: "c", name: "i", form: "chokepoint", verdict: "pass", refutation: "automatic", bypasses: [], testReferences: 0, files: ["f.ts"], latency: 1, reason: "r" }] });
};
git("switch", "-q", "-c", "shards");
all("liner");
all("liner");
process.env["COHERENCE_PACKED_RECORDS"] = "1";
all("packer");
all("packer");
delete process.env["COHERENCE_PACKED_RECORDS"];
const out: Record<string, unknown> = { files: Object.fromEntries(["journal", "runs", "work"].map((s) => [s, readdirSync(join(root, ".coherence", s))])) };
const j = was.store.loadJournal(root);
out["1.7.2 loadJournal"] = { records: j.records.length, sessions: [...new Set(j.records.map((r: { session: string }) => r.session))], damaged: j.damaged };
const w = was.work.loadWork(root);
out["1.7.2 loadWork"] = { records: w.records.length, damaged: w.damaged };
const r = was.record.loadRuns(root);
out["1.7.2 loadRuns"] = { records: r.records.length, damaged: r.damaged };
out["1.7.2 journalFileKeys (peer feed)"] = [...was.store.journalFileKeys(root).keys()];
const seeing = was.runIndex.latestSeeing(root, ["f.ts"], was.record.parseLine);
out["1.7.2 run index: enforcements seeing f.ts"] = seeing.byFile.get("f.ts")?.size ?? 0;
git("add", "-A");
git("commit", "-q", "-m", "records");
const packedIds = neu.store.loadJournal(root).records.filter((x: { session: string }) => x.session === "packer").map((x: { id: string }) => x.id);
const lineIds = neu.store.loadJournal(root).records.filter((x: { session: string }) => x.session === "liner").map((x: { id: string }) => x.id);
git("switch", "-q", "main");
const found = was.branches.recordsOnOtherBranches(root, [...packedIds, ...lineIds]);
out["1.7.2 citation search"] = { packedFound: packedIds.filter((id: string) => found.has(id)).length, of: packedIds.length, lineFound: lineIds.filter((id: string) => found.has(id)).length, ofLine: lineIds.length };
const summary = spawnSync(process.execPath, [join(old, ".github/scripts/records-summary.mjs"), "main", "shards"], { cwd: root, encoding: "utf8" });
out["1.7.2 records summary"] = summary.stdout.split("\n").slice(0, 3).join(" | ") + (summary.stderr ? ` ERR ${summary.stderr}` : "");
console.log(JSON.stringify(out, null, 2));
rmSync(root, { recursive: true, force: true });
