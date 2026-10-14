/**
 * A run entry's reference sites are written once per run file: an entry
 * whose sites are its enforcement's last sites in the same file carries a
 * reference, every reader, through loadRuns, sees the sites as if they had
 * been written in full, and each run file resolves alone.
 */

import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendRun, entryKey, latestByEnforcement, loadRuns, parseLine, sitesHash, type RecordedSite, type RunRecord } from "./record.ts";
import { latestSeeing } from "./run-index.ts";
import { onlyFile, sessionFiles, sessionText } from "../journal/shard-fixture.ts";
import { countingFs } from "../lifecycle/fs-count-fixture.ts";

const site = (file: string, line: number): RecordedSite => ({ file, line, symbol: "seal", class: "inside", of: "protected", test: false });

function run(at: string, sites: RecordedSite[] | undefined, session = "sites"): RunRecord {
  return {
    at,
    session,
    agent: "t",
    binding: "none",
    commit: null,
    dirty: false,
    instrument: { language: "typescript", server: "warm" },
    latency: 1,
    invariants: [{ component: "src/a", name: "sealed", form: "chokepoint", verdict: "pass", grade: "reference-choked", refutation: "automatic", bypasses: [], ...(sites === undefined ? {} : { sites }), testReferences: 0, files: ["src/a/x.ts"], latency: 1, reason: "t" }],
  } as RunRecord;
}

function written(root: string, session = "sites"): Record<string, unknown>[] {
  return sessionText(join(root, ".coherence", "runs"), session).trim().split("\n").map((l) => (JSON.parse(l) as { invariants: Record<string, unknown>[] }).invariants[0]!);
}

/** Every run file's raw lines, by name. */
function rawLines(root: string): Record<string, string> {
  const dir = join(root, ".coherence", "runs");
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]));
}

test("a run whose sites did not change stores a reference within its own run file that resolves to the same sites; changed sites are stored in full; a reference no record holds is reported, never an empty list", () => {
  const root = mkdtempSync(join(tmpdir(), "coherence-sites-"));
  try {
    const first = [site("src/a/x.ts", 3), site("src/a/y.ts", 9)];
    appendRun(root, run("2026-05-01T00:00:00.000Z", first));
    appendRun(root, run("2026-05-02T00:00:00.000Z", first));
    const changed = [site("src/a/x.ts", 4)];
    appendRun(root, run("2026-05-03T00:00:00.000Z", changed));
    appendRun(root, run("2026-05-04T00:00:00.000Z", changed));
    const lines = written(root);
    assert.deepEqual(lines[0]!["sites"], first, "the first run writes its sites in full");
    assert.equal(lines[1]!["sites"], undefined, "the unchanged run writes none");
    assert.deepEqual(lines[1]!["sitesRef"], { hash: sitesHash(first), at: "2026-05-01T00:00:00.000Z" }, "but a reference to the run in its file that holds them");
    assert.deepEqual(lines[2]!["sites"], changed, "changed sites are written in full");
    assert.deepEqual(lines[3]!["sitesRef"], { hash: sitesHash(changed), at: "2026-05-03T00:00:00.000Z" });
    const loaded = loadRuns(root);
    assert.deepEqual(loaded.damaged, []);
    assert.deepEqual(loaded.records.map((r) => r.invariants[0]!.sites), [first, first, changed, changed], "every reader sees every run's sites");
    assert.ok(loaded.records.every((r) => r.invariants[0]!.sitesRef === undefined), "and never a reference");
    assert.deepEqual(Object.keys(loaded.records[1]!.invariants[0]!), Object.keys(loaded.records[0]!.invariants[0]!), "the sites stand where a full write puts them");
    assert.deepEqual(latestByEnforcement(loaded.records).get(entryKey("src/a", "sealed", "chokepoint"))?.sites, changed);
    // Another session's file, with the very same sites: its first entry is in full, so it never depends on this file.
    appendRun(root, run("2026-05-05T00:00:00.000Z", changed, "other"));
    appendRun(root, run("2026-05-06T00:00:00.000Z", changed, "other"));
    assert.deepEqual(written(root, "other")[0]!["sites"], changed, "a file's first entry for an enforcement is in full");
    assert.deepEqual(written(root, "other")[1]!["sitesRef"], { hash: sitesHash(changed), at: "2026-05-05T00:00:00.000Z" }, "and a reference stays in its file");
    // Each run file resolves alone: take away any one, and every entry of the others still has its sites.
    for (const gone of ["sites", "other"].map((s) => basename(onlyFile(join(root, ".coherence", "runs"), s)))) {
      const alone = mkdtempSync(join(tmpdir(), "coherence-sites-alone-"));
      try {
        cpSync(join(root, ".coherence"), join(alone, ".coherence"), { recursive: true });
        rmSync(join(alone, ".coherence", "runs", gone));
        const rest = loadRuns(alone);
        assert.deepEqual(rest.damaged, [], `without ${gone}, nothing is unresolved`);
        assert.ok(rest.records.every((r) => r.invariants[0]!.sites !== undefined), `without ${gone}, every entry has its sites`);
      } finally {
        rmSync(alone, { recursive: true, force: true });
      }
    }
    // A reference its file cannot resolve (a line edited by hand, a file truncated): said, in the damaged lines and on the entry, never read as no sites.
    const lost = run("2026-05-07T00:00:00.000Z", undefined, "lost");
    (lost.invariants[0] as unknown as Record<string, unknown>)["sitesRef"] = { hash: sitesHash([site("src/a/z.ts", 1)]), at: "2026-01-01T00:00:00.000Z" };
    appendFileSync(join(root, ".coherence", "runs", "lost.jsonl"), JSON.stringify(lost) + "\n");
    const again = loadRuns(root);
    const unresolved = again.records.find((r) => r.session === "lost")!.invariants[0]!;
    assert.equal(unresolved.sites, undefined, "no sites are invented");
    assert.match(unresolved.sitesUnresolved ?? "", /are in no record of its run file/, "the entry says its sites are unknown");
    assert.ok(again.damaged.some((d) => d.file.endsWith("lost.jsonl") && /src\/a\/sealed: the sites this entry refers to/.test(d.reason)), "and the line is reported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("over this repository's run store, a run written with its unchanged sites by reference reads exactly as one written in full, in fewer bytes, and no line already written changes", () => {
  const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
  const store = join(repo, ".coherence", "runs");
  if (!existsSync(store)) return;
  const real = loadRuns(repo);
  assert.deepEqual(real.damaged.filter((d) => /refers to/.test(d.reason)), [], "every reference already in the store resolves");
  // The latest run that carries sites, run twice more in one new session file: the second time its sites are its first's.
  const last = [...real.records].reverse().find((r) => r.invariants.some((e) => e.sites !== undefined));
  if (last === undefined) return;
  const at = Date.parse(real.records.at(-1)!.at);
  const again = (n: number): RunRecord => ({ ...JSON.parse(JSON.stringify(last)), at: new Date(at + 1000 * n).toISOString(), session: "sites-reference-test" });
  const roots = ["full", "reference"].map((name) => {
    const root = mkdtempSync(join(tmpdir(), `coherence-sites-${name}-`));
    mkdirSync(join(root, ".coherence"), { recursive: true });
    cpSync(store, join(root, ".coherence", "runs"), { recursive: true });
    return root;
  });
  const [full, reference] = roots as [string, string];
  try {
    const before = rawLines(reference);
    writeFileSync(join(full, ".coherence", "runs", "sites-reference-test.jsonl"), JSON.stringify(again(1)) + "\n" + JSON.stringify(again(2)) + "\n");
    appendRun(reference, again(1));
    appendRun(reference, again(2));
    const after = rawLines(reference);
    for (const [name, text] of Object.entries(before)) assert.equal(after[name], text, `${name}: no line already written is changed`);
    const views = (root: string): string => {
      const loaded = loadRuns(root);
      return JSON.stringify({ loaded, latest: [...latestByEnforcement(loaded.records)] });
    };
    assert.equal(views(reference), views(full), "every view the run store feeds is byte-identical");
    const bytes = (root: string): number => statSync(onlyFile(join(root, ".coherence", "runs"), "sites-reference-test")).size;
    assert.ok(bytes(reference) < bytes(full), `the reference run is smaller: ${bytes(reference)} bytes against ${bytes(full)}`);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

/** A session file of `runs` lines, each a chokepoint entry with forty sites that differ from the line before, so each is written in full. */
function longSession(runs: number): string {
  const root = mkdtempSync(join(tmpdir(), `coherence-sites-long-${String(runs).padStart(4, "0")}-`));
  for (let i = 0; i < runs; i++) {
    const sites = Array.from({ length: 40 }, (_, n) => site(`src/a/f${n}.ts`, i + n));
    appendRun(root, run(new Date(Date.parse("2026-05-01T00:00:00.000Z") + i * 1000).toISOString(), sites, "long"));
  }
  return root;
}

test("an append asks its run file's sites shard, never the file: beside ten times the session's runs it reads the same bytes, and a shard that cannot say writes the sites in full", async () => {
  const roots = [longSession(30), longSession(300)];
  try {
    const counted = [];
    for (const root of roots) {
      // The edit hook's index, current, as it is after any edit: the append folds its own line into it.
      latestSeeing(root, [], parseLine);
      const lastSites = loadRuns(root).records.at(-1)!.invariants[0]!.sites!;
      const { fs } = await countingFs(async () => appendRun(root, run("2026-06-01T00:00:00.000Z", lastSites, "long")));
      const lines = written(root, "long");
      assert.equal(lines.at(-1)!["sites"], undefined, "the unchanged sites are not written again");
      assert.deepEqual(lines.at(-1)!["sitesRef"], { hash: sitesHash(lastSites), at: loadRuns(root).records.at(-2)!.at }, "but referred to, from the shard");
      const session = Object.entries(fs.paths).filter(([key]) => /^(readFileSync|readSync|promises\.readFile|readFile) .*\/runs\/long\.[0-9a-f]{8}\.jsonl$/.test(key));
      // The index's fold reads the appended line back, and only it: its bytes are the line's, at any length of the file,
      // and the one last byte the append reads first to see whether a torn line needs ending (append.ts).
      const appended = Buffer.byteLength(readFileSync(onlyFile(join(root, ".coherence", "runs"), "long"), "utf8").trim().split("\n").at(-1)! + "\n") + 1;
      assert.deepEqual(session.map(([, bytes]) => bytes), session.length === 0 ? [] : [appended], "the session's run file is read for the appended line alone");
      counted.push(fs.calls);
    }
    // The same work, but for a few bytes the index and shard spell longer (an offset with one more digit) and the cache folder's own entries.
    const [small, large] = counted as [Record<string, number>, Record<string, number>];
    const grown = Object.keys({ ...small, ...large }).filter((label) => (large[label] ?? 0) > (small[label] ?? 0) + 32);
    assert.deepEqual(grown, [], `every read, stat and listing the append makes weighs the same beside 300 runs as beside 30, a file ten times the bytes (${JSON.stringify(small)} against ${JSON.stringify(large)})`);
    // A shard that cannot say: gone, or kept for the file as it no longer is (a line appended by another writer).
    const [root] = roots as [string];
    const lastSites = loadRuns(root).records.at(-1)!.invariants[0]!.sites!;
    rmSync(join(root, ".coherence", "cache", "run-sites"), { recursive: true, force: true });
    appendRun(root, run("2026-06-02T00:00:00.000Z", lastSites, "long"));
    assert.deepEqual(written(root, "long").at(-1)!["sites"], lastSites, "with no shard, the sites are written in full");
    appendRun(root, run("2026-06-03T00:00:00.000Z", lastSites, "long"));
    assert.ok(written(root, "long").at(-1)!["sitesRef"] !== undefined, "and the shard starts again from that line");
    appendFileSync(sessionFiles(join(root, ".coherence", "runs"), "long").map((n) => join(root, ".coherence", "runs", n)).at(-1)!, JSON.stringify(run("2026-06-04T00:00:00.000Z", undefined, "long")) + "\n");
    appendRun(root, run("2026-06-05T00:00:00.000Z", lastSites, "long"));
    assert.deepEqual(written(root, "long").at(-1)!["sites"], lastSites, "a file the shard was not kept for is written in full");
    assert.deepEqual(loadRuns(root).damaged, [], "and every reference written resolves");
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
