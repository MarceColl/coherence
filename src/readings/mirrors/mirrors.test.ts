import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mirrorsCommand } from "./cli.ts";
import { readMirrors } from "./mirrors.ts";
import type { Finding, Group, MirrorReading, SetRef } from "./model.ts";
import { alarmsOf, isAlarm, proposalsOf, readingText, surfaced } from "./policy.ts";
import { lastMirrors, MIRRORS_DIR, ORIENT_LINE_LIMIT, orientMirrorText, recordMirrors } from "./recorded.ts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ------------------------------------------------------------ fixtures */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "coherence-mirrors-"));
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function gitIn(root: string): (...args: string[]) => string {
  return (...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
}

/**
 * A project whose list of files (SOURCES in src/app/build.ts) equals the
 * import closure of its own files in the first commit; the second commit
 * makes a.ts import a new c.ts and leaves the list alone.
 */
function driftedRepository(): { root: string; first: string; second: string } {
  const root = scratch();
  const git = gitIn(root);
  git("init", "-q", "-b", "main");
  write(root, "src/app/build.ts", 'export const SOURCES = ["a.ts", "b.ts"];\n');
  write(root, "src/app/a.ts", 'import { b } from "./b.ts";\nexport const a = b + 1;\n');
  write(root, "src/app/b.ts", "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "the list and its files");
  const first = git("rev-parse", "HEAD").trim();
  write(root, "src/app/c.ts", "export const c = 2;\n");
  write(root, "src/app/a.ts", 'import { b } from "./b.ts";\nimport { c } from "./c.ts";\nexport const a = b + c;\n');
  git("add", "-A");
  git("commit", "-q", "-m", "a reads c");
  const second = git("rev-parse", "HEAD").trim();
  return { root, first, second };
}

function closureFinding(reading: MirrorReading): Finding | undefined {
  return reading.groups.flatMap((g) => g.findings).find((f) => f.a.name === "SOURCES" && f.b.form === "closure");
}

const ref = (file: string, name: string, members: string[], extra: Partial<SetRef> = {}): SetRef => ({ file, line: 1, name, form: "array", checked: false, members, ...extra });

function finding(a: SetRef, b: SetRef, extra: Partial<Finding> = {}): Finding {
  const sb = new Set(b.members);
  const sa = new Set(a.members);
  return {
    a,
    b,
    verdict: "duplicate",
    shared: a.members.filter((m) => sb.has(m)),
    onlyA: a.members.filter((m) => !sb.has(m)),
    onlyB: b.members.filter((m) => !sa.has(m)),
    jaccard: 1,
    containment: 1,
    score: 30,
    overlapScore: 30,
    historyScore: 0,
    copies: [],
    ...extra,
  };
}

const group = (rank: number, score: number, findings: Finding[]): Group => ({ rank, score, overlapScore: score, historyScore: 0, findings });

function readingOf(groups: Group[]): MirrorReading {
  return { rev: "HEAD", commit: "0123456789abcdef0123456789abcdef01234567", ms: 1, phases: {}, sets: 10, read: 10, unread: {}, groups };
}

/* ---------------------------------------------------- the invariants */

test("the mirror reading reads git objects at its revision: an uncommitted edit leaves it unchanged, and the commit before reads as it was", async () => {
  const { root, first } = driftedRepository();
  try {
    const before = await readMirrors(root);
    const drifted = closureFinding(before);
    assert.ok(drifted !== undefined, "the list meets the closure of its own files");
    assert.equal(drifted.verdict, "drifted");
    assert.deepEqual(drifted.onlyB, ["c.ts"]);

    // Repair the list in the working tree, and stage it, without committing: the reading at HEAD is unchanged.
    write(root, "src/app/build.ts", 'export const SOURCES = ["a.ts", "b.ts", "c.ts"];\n');
    gitIn(root)("add", "src/app/build.ts");
    const during = await readMirrors(root);
    assert.deepEqual(closureFinding(during), drifted, "an edit not yet committed changes nothing the reading says");
    assert.equal(during.commit, before.commit);

    const earlier = await readMirrors(root, { rev: first });
    assert.equal(earlier.commit, first);
    const latent = closureFinding(earlier);
    assert.ok(latent !== undefined);
    assert.equal(latent.verdict, "latent", "the commit before reads as it was committed: the list equal to its closure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The relative modules a source imports at run time, statically: type-only imports erased, dynamic imports left out. */
function staticImports(file: string): string[] {
  const stripped = stripTypeScriptTypes(readFileSync(file, "utf8"));
  const out: string[] = [];
  for (const m of stripped.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|^import\s+["']([^"']+)["']/gm)) out.push((m[1] ?? m[2])!);
  return out;
}

function runtimeClosure(entries: readonly string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of staticImports(file)) {
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  };
  for (const entry of entries) visit(join(SRC, entry));
  return { files, packages };
}

test("no hook loads the mirror reading: the hooks' import closure never reaches it or the compiler, and orient reads only the kept reading, labeled with its commit", async () => {
  const { files, packages } = runtimeClosure(["cli.ts", "lifecycle/hook.ts"]);
  const reached = [...files].map((f) => relative(SRC, f));
  assert.ok(reached.includes("readings/mirrors/recorded.ts"), "the hooks do load the kept reading's module, so the closure is the real one");
  assert.ok(!reached.includes("readings/mirrors/mirrors.ts"), "the reading itself is never among the modules a hook loads");
  assert.ok(!reached.includes("readings/mirrors/cli.ts"), "query mirrors is loaded on demand");
  assert.ok(!packages.has("typescript"), "nor is the compiler's parser");

  const root = scratch();
  try {
    assert.equal(orientMirrorText(lastMirrors(root), "coherence"), "", "with no reading kept, orient says nothing and takes none");
    assert.equal(existsSync(join(root, MIRRORS_DIR)), false);
    const strong = group(1, 40, [finding(ref("src/a.ts", "KINDS", ["x", "y", "z"]), ref("src/b.ts", "COPY", ["x", "y", "z"]))]);
    recordMirrors(root, readingOf([strong]), () => new Date("2026-10-12T09:30:00Z"));
    const text = orientMirrorText(lastMirrors(root), "coherence");
    assert.match(text, /the mirror reading at 0123456, 2026-10-12 09:30 UTC/, "labeled with the commit and the time it read");
    assert.match(text, /KINDS \(src\/a\.ts:1\)/);
    assert.match(text, /coherence query mirrors/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only cross-file groups sharing three or more names and scoring 20 or more are surfaced, and the rest are listed only on request", () => {
  const three = ["alpha", "beta", "gamma"];
  const sameFile = group(1, 50, [finding(ref("src/a.ts", "ONE", three), ref("src/a.ts", "TWO", three))]);
  const twoNames = group(2, 50, [finding(ref("src/a.ts", "PAIR", ["alpha", "beta"]), ref("src/b.ts", "PAIR", ["alpha", "beta"]))]);
  const weak = group(3, 19.9, [finding(ref("src/a.ts", "WEAK", three), ref("src/b.ts", "WEAK", three))]);
  const strong = group(4, 20, [finding(ref("src/a.ts", "STRONG", three), ref("src/b.ts", "STRONG", three))]);
  assert.deepEqual([sameFile, twoNames, weak, strong].map(surfaced), [false, false, false, true]);

  const reading = readingOf([sameFile, twoNames, weak, strong]);
  const shown = readingText(reading);
  assert.match(shown, /STRONG/);
  assert.doesNotMatch(shown, /ONE|PAIR|WEAK/, "by default only the surfaced groups");
  assert.match(shown, /never a spec problem and never block/);
  const all = readingText(reading, { all: true });
  for (const name of ["ONE", "PAIR", "WEAK", "STRONG"]) assert.match(all, new RegExp(name), "every group on request");

  const root = scratch();
  try {
    const kept = recordMirrors(root, reading);
    assert.deepEqual(kept.surfaced.map((g) => g.rank), [4], "the kept reading, which orient reads, holds the surfaced groups alone");
    assert.equal(kept.groups, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a list of files drifted from its own import closure is an alarm naming the missing file and the commit that grew the closure alone", async () => {
  const { root, first, second } = driftedRepository();
  try {
    const latent = closureFinding(await readMirrors(root, { rev: first }));
    assert.ok(latent !== undefined);
    assert.equal(isAlarm(latent), false, "a list equal to its closure is latent, no alarm");

    const reading = await readMirrors(root);
    const alarms = alarmsOf(reading.groups);
    assert.equal(alarms.length, 1);
    const alarm = alarms[0]!;
    assert.equal(alarm.a.name, "SOURCES");
    assert.equal(alarm.b.list, "src/app/build.ts:1");
    assert.deepEqual(alarm.history?.missed.map((m) => [m.commit, m.member, m.side]), [[second.slice(0, 7), "c.ts", "b"]]);

    const recorded = recordMirrors(root, reading);
    const text = orientMirrorText(recorded, "coherence");
    assert.match(text, /SOURCES \(src\/app\/build\.ts:1\) has drifted from the import closure of its own files: it lacks c\.ts/);
    assert.match(text, new RegExp(`${second.slice(0, 7)} added c\\.ts to the closure alone`));
    assert.deepEqual(proposalsOf(reading.groups).map((p) => [p.list.name, p.universe]), [["SOURCES", "closure of files"]], "the alarm is proposed for declaration");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("latent and duplicate findings of surfaced groups and alarms become proposed pairs with one universe recipe each, and a folder proposes none", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  const names = ["red", "green", "blue"];
  const closure = finding(ref("src/app/build.ts", "SOURCES", files), ref("src/app", "import closure of SOURCES (src/app/build.ts:1)", files, { form: "closure", line: 0, list: "src/app/build.ts:1", of: files }), { verdict: "latent" });
  const keys = finding(ref("src/a.ts", "COLORS", names), ref("src/b.ts", "PAINT keys", names, { form: "keys", line: 7 }), { verdict: "duplicate" });
  const literal = finding(ref("src/a.ts", "HUES", names, { line: 3 }), ref("docs/colors.md", "table under \"Colors\"", names, { form: "doc-table", line: 12 }), { verdict: "duplicate" });
  const drifted = finding(ref("src/c.ts", "SOME", ["red", "green"]), ref("src/d.ts", "MORE", names, { line: 9 }), { verdict: "drifted" });
  const folder = finding(ref("src/e.ts", "FILES", files), ref("src/e", "files in src/e/", files, { form: "folder", line: 0 }), { verdict: "latent" });
  const quiet = finding(ref("src/f.ts", "QUIET", names), ref("src/g.ts", "QUIET", names), { verdict: "duplicate" });
  const groups = [group(1, 40, [closure]), group(2, 40, [keys]), group(3, 40, [literal, drifted]), group(4, 40, [folder]), group(5, 5, [quiet])];

  const proposed = proposalsOf(groups);
  assert.deepEqual(
    proposed.map((p) => [p.list.file, p.list.name, p.universe]),
    [
      ["src/app/build.ts", "SOURCES", "closure of files"],
      ["src/a.ts", "COLORS", "keys of src/b.ts:PAINT"],
      ["src/a.ts", "HUES", "literal at docs/colors.md:12"],
    ],
    "a drifted pair, a pair no group surfaces, and a folder propose nothing",
  );
  assert.deepEqual(proposed[0]!.members, files);
  assert.equal(proposed[0]!.list.line, 1);
});

test("files in a language the reading does not parse are counted by extension, said by query mirrors, and named at orient only when they outnumber the code it read", async () => {
  const root = scratch();
  try {
    const git = gitIn(root);
    git("init", "-q", "-b", "main");
    write(root, "app/models.py", 'KINDS = ["alpha", "beta", "gamma"]\n');
    write(root, "app/views.py", "from app.models import KINDS\n");
    write(root, "app/__init__.py", "");
    write(root, "app/models.pyi", "KINDS: list[str]\n");
    write(root, "web/index.ts", "export const one = 1;\n");
    write(root, "pyproject.toml", '[project]\nname = "app"\n');
    git("add", "-A");
    git("commit", "-q", "-m", "a Python project with one TypeScript file");
    const head = git("rev-parse", "HEAD").trim();

    const reading = await readMirrors(root, { history: false });
    assert.equal(reading.read, 1, "the one TypeScript file is parsed");
    assert.deepEqual(reading.unread, { ".py": 3, ".pyi": 1 }, "the Python files are counted by extension, and a file in no language is not");

    let out = "";
    const io = { out: (text: string): void => { out += text; }, err: (text: string): void => { out += text; } };
    assert.equal(await mirrorsCommand(root, [], io), 0);
    assert.match(out, /in \d+ ms; not read: 3 \.py files, 1 \.pyi file \(the reading parses TypeScript, JavaScript and Markdown\)/);
    out = "";
    assert.equal(await mirrorsCommand(root, ["--json"], io), 0);
    assert.deepEqual(JSON.parse(out).unread, { ".py": 3, ".pyi": 1 });

    // query mirrors kept the reading of HEAD; orient names the unread code, labeled with its commit.
    const kept = lastMirrors(root);
    assert.ok(kept !== undefined);
    assert.deepEqual(kept.unread, { ".py": 3, ".pyi": 1 });
    const text = orientMirrorText(kept, "coherence");
    assert.match(text, new RegExp(`^Hand lists \\(the mirror reading at ${head.slice(0, 7)}, \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC; advisory\\): not read for 3 \\.py files, 1 \\.pyi file; the reading parses TypeScript, JavaScript and Markdown\\.$`));
    assert.ok(text.length <= ORIENT_LINE_LIMIT);

    // A project mostly TypeScript with a few stray Python files: orient adds nothing, and query mirrors still says them.
    const mostlyTypeScript = { ...readingOf([]), read: 10, unread: { ".py": 2 } };
    assert.equal(orientMirrorText(recordMirrors(root, mostlyTypeScript), "coherence"), "", "a few files unread beside the code read is no line at the session start");
    assert.match(readingText(mostlyTypeScript), /not read: 2 \.py files/);

    // A reading kept before the counts existed is treated as absent, never a crash.
    write(root, join(MIRRORS_DIR, "reading.json"), JSON.stringify({ version: 1, commit: head, at: "2026-10-12T09:30:00Z", ms: 1, sets: 0, groups: 0, surfaced: [], alarms: [] }));
    assert.equal(lastMirrors(root), undefined);
    assert.equal(orientMirrorText(lastMirrors(root), "coherence"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
