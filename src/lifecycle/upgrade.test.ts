/**
 * The upgrade, offline: every kernel practice as each tagged release taught
 * it, read from git history, enacted in a fixture adopter, then re-enacted and
 * checked under this tree. A release that changes a kernel practice must
 * never send an adopter back to decide for it (df-36efa8f2). The network
 * test (upgrade.e2e.ts, the Upgrade workflow) installs the published
 * release itself; this one runs in every pass, with no network.
 */

import assert from "node:assert/strict";
import { onlyFile } from "../journal/shard-fixture.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { budget } from "../enforcement/test-budgets.ts";
import { journalVerbs, type Io } from "../journal/cli.ts";
import { loadSpecModel, projectPractices } from "../spec/model.ts";
import { parsePractices, type Practice } from "../spec/practice.ts";
import { COHERENCE_ROOT, KERNEL_PREFIX } from "../spec/practices.ts";

const WHO = ["--session", "earlier", "--agent", "adopter"];
const NOW = ["--session", "later", "--agent", "adopter"];

function git(...args: string[]): { code: number; out: string } {
  const ran = spawnSync("git", args, { cwd: COHERENCE_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { code: ran.status ?? 1, out: ran.stdout ?? "" };
}

const normalize = (text: string): string => text.trim().replace(/\s+/g, " ");

/** Each blob named `<tag>:<path>`, read through one git cat-file --batch rather than one git show per file. */
function blobs(names: readonly string[]): Map<string, string> {
  const ran = spawnSync("git", ["cat-file", "--batch"], { cwd: COHERENCE_ROOT, input: names.map((n) => `${n}\n`).join(""), maxBuffer: 256 * 1024 * 1024 });
  const out = new Map<string, string>();
  const bytes = ran.stdout ?? Buffer.alloc(0);
  let at = 0;
  for (const name of names) {
    const end = bytes.indexOf(10, at);
    const header = bytes.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    if (header[1] !== "blob") continue;
    const size = Number(header[2]);
    out.set(name, bytes.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return out;
}

/**
 * Each tagged release's kernel practices, by the id an adopter knows them by,
 * as that release's tree wrote them; releases that taught the same practices
 * word for word are one entry, named by the first of them and their count,
 * since an adopter of any of them holds the same records.
 */
function releasedKernels(current: ReadonlySet<string>): { tag: string; practices: Map<string, Practice> }[] {
  const tags = git("tag", "--list", "v*").out.split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  assert.ok(tags.length > 0, "no release tags in this checkout: the upgrade test reads each release's kernel practices from its tag, so fetch the tags (git fetch --tags, or checkout with fetch-depth: 0)");
  const listed = tags.map((tag) => ({ tag, files: git("ls-tree", "-r", "--name-only", tag, "src").out.split("\n").filter((f) => /^src\/[^/]+\/[^/]+\.practice\.md$/.test(f)) }));
  const texts = blobs(listed.flatMap(({ tag, files }) => files.map((file) => `${tag}:${file}`)));
  const byContent = new Map<string, { tags: string[]; practices: Map<string, Practice> }>();
  for (const { tag, files } of listed) {
    const practices = new Map<string, Practice>();
    for (const file of files) {
      const folder = file.split("/").slice(0, 2).join("/");
      for (const p of parsePractices(texts.get(`${tag}:${file}`) ?? "", file).practices) {
        const id = `${KERNEL_PREFIX}${folder}/${p.name}`;
        // A release before reach: was written shipped every practice; the ones this tree still ships as kernel are the ones an adopter re-enacts.
        if (p.reach !== "internal" && current.has(id)) practices.set(id, p);
      }
    }
    if (practices.size === 0) continue;
    const key = JSON.stringify([...practices].sort(([a], [b]) => a.localeCompare(b)));
    const same = byContent.get(key);
    if (same === undefined) byContent.set(key, { tags: [tag], practices });
    else same.tags.push(tag);
  }
  return [...byContent.values()].map(({ tags: taught, practices }) => ({ tag: taught.length === 1 ? taught[0]! : `${taught[0]!} (and ${taught.length - 1} releases that taught the same)`, practices }));
}

function adopter(): { root: string; run: (...argv: string[]) => { code: number; out: string; err: string } } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coherence-upgrade-history-")));
  mkdirSync(join(root, "src", "widget"), { recursive: true });
  writeFileSync(join(root, "coherence.config.json"), JSON.stringify({ name: "widgets" }) + "\n");
  writeFileSync(join(root, "src", "widget", "Widget.spec.md"), "# Widget\n\nWidgets turn.\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  let tick = Date.parse("2026-10-01T10:00:00.000Z");
  const now = (): Date => new Date((tick += 1000));
  return {
    root,
    run: (...argv) => {
      const [verb, ...rest] = argv;
      const out: string[] = [];
      const err: string[] = [];
      const io: Io = { cwd: root, now, out: (l) => out.push(l), err: (l) => err.push(l) };
      const code = journalVerbs[verb!]!(rest, io);
      return { code, out: out.join("\n"), err: err.join("\n") };
    },
  };
}

/** Every step done, as an adopter that carried the practice out whole records it. */
function doneSteps(count: number): string[] {
  return Array.from({ length: count }, (_, i) => ["--step", `${i + 1}=done:carried out in the fixture`]).flat();
}

test("an adopter that enacted every kernel practice as an earlier release taught it re-enacts each and checks clean under this one", (t) => {
  budget(t, 20, "d-4d6efcf9");
  const { root: probe } = adopter();
  const current = new Map(projectPractices(probe).filter((p) => p.id.startsWith(KERNEL_PREFIX)).map((p) => [p.id, p]));
  rmSync(probe, { recursive: true, force: true });
  assert.ok(current.size > 0, "this tree ships no kernel practice");
  const releases = releasedKernels(new Set(current.keys()));
  const failures: string[] = [];
  // The pairs where the floor would read a loss: a step or pitfall the release taught that this tree no longer has.
  const lossy: string[] = [];
  for (const { tag, practices } of releases) {
    const { root, run } = adopter();
    try {
      // As the earlier release left it: an enactment of each kernel practice carrying that release's steps and pitfalls.
      for (const [id, old] of practices) {
        const now = current.get(id)!;
        const first = run("enact", id, ...doneSteps(now.steps.length), ...WHO);
        assert.equal(first.code, 0, `${tag} ${id}: the fixture's first enact was refused: ${first.err}`);
        const kept = new Set([...now.steps.map((s) => normalize(s.text)), ...now.pitfalls.map((pf) => normalize(pf.text))]);
        if ([...old.steps.map((s) => s.text), ...old.pitfalls.map((pf) => pf.text)].some((t) => !kept.has(normalize(t)))) lossy.push(`${tag} ${id}`);
      }
      const file = onlyFile(join(root, ".coherence", "journal"), "earlier");
      const rewritten = readFileSync(file, "utf8").split("\n").map((line) => {
        if (!line.includes('"kind":"enactment"')) return line;
        const record = JSON.parse(line) as { practice: string; version: string; steps: { text: string; leaves?: string }[]; pitfalls: string[]; results: Record<string, unknown> };
        const old = practices.get(record.practice)!;
        record.version = old.version;
        record.steps = old.steps.map((s) => (s.leaves === undefined ? { text: s.text } : { text: s.text, leaves: s.leaves }));
        record.pitfalls = old.pitfalls.map((pf) => pf.text);
        record.results = Object.fromEntries(old.steps.map((s) => [String(s.n), { result: "done", evidence: "carried out in the fixture" }]));
        return JSON.stringify(record);
      });
      writeFileSync(file, rewritten.join("\n"));

      // Under this tree: every kernel practice enacts again, and the check names nothing about Coherence's own.
      for (const id of practices.keys()) {
        const again = run("enact", id, ...doneSteps(current.get(id)!.steps.length), ...NOW);
        if (again.code !== 0) failures.push(`${tag} -> this tree: enact "${id}" refused:\n${again.err}`);
      }
      const problems = loadSpecModel(root, { runs: false }).problems.filter((p) => p.message.includes(KERNEL_PREFIX) || /is gone; a practice keeps what it taught/.test(p.message));
      for (const p of problems) failures.push(`${tag} -> this tree: spec --check names ${p.file}:${p.line}: ${p.message}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.ok(releases.length > 0, "no tagged release carries a kernel practice this tree still ships");
  assert.ok(lossy.length > 0, "no release taught a kernel practice step or pitfall this tree dropped, so nothing here would catch a floor read against the adopter; the history the test reads is not the one it expects");
  assert.deepEqual(failures, [], `an upgrade asks an adopter to answer for Coherence's own practices (${lossy.length} release and practice pairs where a step or pitfall left: ${lossy.join("; ")}):\n\n${failures.join("\n\n")}`);
});
