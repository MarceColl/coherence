import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cli } from "./cli-fixture.ts";
import { runHook } from "./hook.ts";
import { PACKAGE_NAME } from "./project.ts";
import type { Env } from "./telemetry.ts";
import {
  CHECK_INTERVAL_MS,
  isNewer,
  latestPath,
  packageManager,
  reachNote,
  readLatest,
  refreshLatest,
  REGISTRY_LATEST,
  startUpdateCheck,
  versionBlock,
  versionText,
  type Spawner,
} from "./version.ts";

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = (JSON.parse(readFileSync(join(CHECKOUT, "package.json"), "utf8")) as { version: string }).version;

/** `text` as a regular expression that matches it literally. */
function escaped(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A Coherence folder at `folder`, of `version`, with the cli an installed package or a checkout runs. */
function coherenceAt(folder: string, version: string, cli: string): string {
  write(join(folder, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
  write(join(folder, cli), "");
  return join(folder, cli);
}

/** A user's config folder of its own, so nothing reaches the real one; the check is on unless `extra` turns it off. */
function userEnv(extra: Record<string, string> = {}): Env {
  return { XDG_CONFIG_HOME: temp("coherence-version-home-"), ...extra };
}

function keepLatest(env: Env, cache: object): void {
  write(latestPath(env), JSON.stringify(cache));
}

function spawnRecorder(): { spawner: Spawner; spawned: { command: string; args: string[]; options: object; unref: boolean }[] } {
  const spawned: { command: string; args: string[]; options: object; unref: boolean }[] = [];
  const spawner: Spawner = (command, args, options) => {
    const entry = { command, args, options, unref: false };
    spawned.push(entry);
    return { on: () => undefined, unref: () => void (entry.unref = true) };
  };
  return { spawner, spawned };
}

test("the session start names the Coherence that runs and where it is, and warns when another copy the project reaches differs in version", async () => {
  const parent = temp("coherence-copies-");
  const project = join(parent, "project");
  mkdirSync(project);
  const installed = coherenceAt(join(project, "node_modules", PACKAGE_NAME), "1.5.2", join("dist", "cli.js"));
  const checkout = join(parent, "coherence");
  const sibling = coherenceAt(checkout, "0.0.0", join("src", "cli.ts"));
  const env = userEnv({ COHERENCE_NO_UPDATE_CHECK: "1" });

  // The adopter's case: the installed release runs, and a stale clone beside the project, which no hook runs, is not a copy it reaches.
  assert.equal(versionBlock(project, false, env, installed), `Coherence 1.5.2 runs this session: the installed package (node_modules/${PACKAGE_NAME}).\n`);

  // A developer's checkout named by COHERENCE_HOME, while the installed package answers a direct npx: the checkout is named as the other copy.
  assert.equal(
    versionBlock(project, false, { ...env, COHERENCE_HOME: checkout }, installed),
    `Coherence 1.5.2 runs this session: the installed package (node_modules/${PACKAGE_NAME}).\n` +
      `Another Coherence differs: the checkout COHERENCE_HOME names (${checkout}) is 0.0.0, so node ../coherence/src/cli.ts answers as 0.0.0, not as this session's 1.5.2; keep one, or update the other.\n`,
  );

  // A checkout run through COHERENCE_HOME says so, and names the installed package it is not.
  assert.equal(
    versionBlock(project, false, { ...env, COHERENCE_HOME: checkout }, sibling),
    `Coherence 0.0.0 runs this session: the checkout COHERENCE_HOME names (${checkout}).\n` +
      `Another Coherence differs: the installed package (node_modules/${PACKAGE_NAME}) is 1.5.2, so npx --no -- coherence answers as 1.5.2, not as this session's 0.0.0; keep one, or update the other.\n`,
  );

  // A checkout a hook command names itself (hooks install --command), at the installed package's version: one Coherence, nothing to warn of.
  rmSync(join(project, "node_modules"), { recursive: true });
  coherenceAt(join(project, "node_modules", PACKAGE_NAME), "0.0.0", join("dist", "cli.js"));
  assert.equal(versionBlock(project, false, env, sibling), "Coherence 0.0.0 runs this session: a checkout at ../coherence, named by the hook command itself.\n");

  // Through the hook: the session start carries the line, beside the session block.
  const root = temp("coherence-start-");
  const result = await runHook("SessionStart", { session_id: "s1", cwd: root }, root);
  const context = (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  assert.match(context, new RegExp(`\\n\\nCoherence ${escaped(VERSION)} runs this session: a checkout at [^\\n]+\\.\\n\\nSession: s1\\n`));
});

test("a newer release in the kept answer is named at the session start with the update command for the project's package manager and its release-age setting", () => {
  const project = temp("coherence-update-");
  const installed = coherenceAt(join(project, "node_modules", PACKAGE_NAME), "1.5.2", join("dist", "cli.js"));
  const env = userEnv();
  const lines = (): string[] => versionBlock(project, false, env, installed).trimEnd().split("\n");
  assert.deepEqual(lines().slice(1), [], "no answer kept: nothing to say");

  keepLatest(env, { attempted: "2026-10-08T00:00:00.000Z", checked: "2026-10-08T00:00:01.000Z", latest: "1.6.0" });
  assert.equal(packageManager(project), "npm", "no lockfile: npm");
  assert.deepEqual(lines().slice(1), [
    `Coherence 1.6.0 is published (the registry said so 2026-10-08T00:00:01.000Z); this session runs 1.5.2. Update: npm install -D ${PACKAGE_NAME}@^1.6.0; a release-age setting may hold the newest back: npm's min-release-age holds a release back; min-release-age-exclude (npm 12) exempts ${PACKAGE_NAME}.`,
  ]);
  const expected: [string, RegExp][] = [
    ["pnpm-lock.yaml", new RegExp(`Update: pnpm add -D ${PACKAGE_NAME}@\\^1\\.6\\.0; .*minimumReleaseAge.*minimumReleaseAgeExclude in pnpm-workspace\\.yaml`)],
    ["yarn.lock", new RegExp(`Update: yarn add -D ${PACKAGE_NAME}@\\^1\\.6\\.0; .*Yarn .*npmPreapprovedPackages`)],
    ["bun.lock", new RegExp(`Update: bun add -d ${PACKAGE_NAME}@\\^1\\.6\\.0; .*install\\.minimumReleaseAge.*minimumReleaseAgeExcludes`)],
  ];
  for (const [lockfile, line] of expected) {
    write(join(project, lockfile), "");
    assert.match(lines()[1]!, line, lockfile);
    rmSync(join(project, lockfile));
  }

  // The same version, or an older one, says nothing; a refused check says nothing from a kept answer it no longer refreshes.
  keepLatest(env, { checked: "2026-10-08T00:00:01.000Z", latest: "1.5.2" });
  assert.equal(lines().length, 1);
  keepLatest(env, { checked: "2026-10-08T00:00:01.000Z", latest: "1.6.0" });
  for (const off of [{ COHERENCE_NO_UPDATE_CHECK: "1" }, { CI: "true" }, { DO_NOT_TRACK: "1" }]) {
    assert.equal(versionBlock(project, false, { ...env, ...off }, installed).trimEnd().split("\n").length, 1, JSON.stringify(off));
  }
  assert.equal(isNewer("1.10.0", "1.9.9"), true);
  assert.equal(isNewer("1.6.0", "1.6.0-rc.1"), true);
  assert.equal(isNewer("1.6.0-rc.1", "1.6.0"), false);
});

test("the check of the newest version starts detached at a session start at most once a day, and never under COHERENCE_NO_UPDATE_CHECK, CI or DO_NOT_TRACK", () => {
  const root = temp("coherence-check-");
  const env = userEnv();
  const { spawner, spawned } = spawnRecorder();
  const at = new Date("2026-10-08T12:00:00.000Z");
  for (const event of ["SubagentStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"]) assert.equal(startUpdateCheck(root, event, env, spawner, () => at), false, event);
  for (const off of [{ COHERENCE_NO_UPDATE_CHECK: "1" }, { CI: "true" }, { DO_NOT_TRACK: "1" }]) assert.equal(startUpdateCheck(root, "SessionStart", { ...env, ...off }, spawner, () => at), false, JSON.stringify(off));
  assert.equal(spawned.length, 0);

  assert.equal(startUpdateCheck(root, "SessionStart", env, spawner, () => at), true);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]!.args.slice(-2), ["version", "--refresh"]);
  assert.deepEqual(spawned[0]!.options, { cwd: root, detached: true, stdio: "ignore" }, "detached, its output ignored");
  assert.equal(spawned[0]!.unref, true, "the hook never holds the child");
  assert.equal(readLatest(env).attempted, at.toISOString(), "the attempt is kept before the child runs, so a second session does not ask again");

  assert.equal(startUpdateCheck(root, "SessionStart", env, spawner, () => new Date(at.getTime() + CHECK_INTERVAL_MS - 1)), false, "within the day: no second check");
  assert.equal(startUpdateCheck(root, "SessionStart", env, spawner, () => new Date(at.getTime() + CHECK_INTERVAL_MS)), true, "a day later: the next");
  assert.equal(spawned.length, 2);
});

test("a failed fetch keeps the last answer, and version says when the registry last answered and when a check got none", async () => {
  const project = temp("coherence-refresh-");
  const installed = coherenceAt(join(project, "node_modules", PACKAGE_NAME), "1.5.2", join("dist", "cli.js"));
  const env = userEnv();
  assert.match(versionText(project, false, env, installed), /^coherence 1\.5\.2: the installed package \(node_modules\/@posthog\/coherence\)\.\nlatest published: never read yet\nupdate check: on, /);

  const asked: string[] = [];
  const first = await refreshLatest(env, async (url) => (asked.push(url), "1.6.0"), () => new Date("2026-10-07T00:00:00.000Z"));
  assert.deepEqual(asked, [REGISTRY_LATEST]);
  assert.deepEqual(first, { attempted: "2026-10-07T00:00:00.000Z", checked: "2026-10-07T00:00:00.000Z", latest: "1.6.0" });
  const failed = await refreshLatest(env, async () => undefined, () => new Date("2026-10-08T00:00:00.000Z"));
  assert.deepEqual(failed, { attempted: "2026-10-08T00:00:00.000Z", checked: "2026-10-07T00:00:00.000Z", latest: "1.6.0" }, "the failure is dropped; only its time is kept");

  const text = versionText(project, false, env, installed);
  assert.match(text, /\nlatest published: 1\.6\.0, as the registry said 2026-10-07T00:00:00\.000Z; update: npm install -D @posthog\/coherence@\^1\.6\.0; /);
  assert.match(text, /\nlast check: 2026-10-08T00:00:00\.000Z, which got no answer from the registry\n/);
  assert.match(versionText(project, false, { ...env, CI: "1" }, installed), /\nupdate check: off, CI is set\n$/);
});

test("a release newer than the registry's last answer is never told that answer is the latest, and the next session start asks again once", () => {
  const project = temp("coherence-stale-");
  const installed = coherenceAt(join(project, "node_modules", PACKAGE_NAME), "1.6.0", join("dist", "cli.js"));
  const env = userEnv();
  // PostHog's upgrade: the day's check had answered 1.5.2 before 1.6.0 was published, and 1.6.0 now runs.
  keepLatest(env, { attempted: "2026-10-08T10:09:19.000Z", checked: "2026-10-08T10:09:19.268Z", latest: "1.5.2" });
  const text = versionText(project, false, env, installed);
  assert.doesNotMatch(text, /latest published: 1\.5\.2/, "the stale answer is not presented as the latest");
  assert.doesNotMatch(text, /this is current/);
  assert.match(text, /\nlatest published: not known since 1\.6\.0, which is newer than the registry's last answer, 1\.5\.2, given 2026-10-08T10:09:19\.268Z; the next session start asks again\n/);
  assert.match(versionText(project, false, { ...env, CI: "1" }, installed), /given 2026-10-08T10:09:19\.268Z\n/, "a check that is off promises no next one");
  assert.equal(versionBlock(project, false, env, installed).trimEnd().split("\n").length, 1, "the session start names no update from it");
  keepLatest(env, { checked: "2026-10-08T10:09:19.268Z", latest: "1.6.0" });
  assert.match(versionText(project, false, env, installed), /\nlatest published: 1\.6\.0, as the registry said 2026-10-08T10:09:19\.268Z; this is current\n/, "the same version is current");

  // The refresh: within the day, an answer older than the running release is asked again, once for that release.
  const { spawner, spawned } = spawnRecorder();
  const at = new Date("2026-10-08T12:00:00.000Z");
  keepLatest(env, { attempted: "2026-10-08T11:00:00.000Z", checked: "2026-10-08T11:00:00.000Z", latest: VERSION });
  assert.equal(startUpdateCheck(project, "SessionStart", env, spawner, () => at), false, "an answer as new as the running release waits its day");
  keepLatest(env, { attempted: "2026-10-08T11:00:00.000Z", checked: "2026-10-08T11:00:00.000Z", latest: "0.0.1" });
  assert.equal(startUpdateCheck(project, "SessionStart", env, spawner, () => at), true, "an answer older than the running release is asked again");
  assert.equal(readLatest(env).askedAs, VERSION);
  assert.equal(startUpdateCheck(project, "SessionStart", env, spawner, () => at), false, "once per release: a registry that still answers older waits its day");
  assert.equal(spawned.length, 1);
});

test("hooks install names the Coherence the hooks reach as the session start names it, never an installed package as a checkout", () => {
  const parent = temp("coherence-reach-");
  const project = join(parent, "project");
  mkdirSync(project);
  // pnpm's layout, as PostHog's install had it.
  const installed = coherenceAt(join(project, "node_modules", ".pnpm", "@posthog+coherence@1.6.0", "node_modules", PACKAGE_NAME), "1.6.0", join("dist", "cli.js"));
  const checkout = join(parent, "coherence");
  const sibling = coherenceAt(checkout, "1.6.0", join("src", "cli.ts"));
  const env = userEnv({ COHERENCE_NO_UPDATE_CHECK: "1" });
  const package_ = `the installed package (node_modules/.pnpm/@posthog+coherence@1.6.0/node_modules/${PACKAGE_NAME})`;

  assert.equal(reachNote(project, undefined, installed, env), undefined, "nothing found: the caller says how to fix it");
  assert.equal(reachNote(project, installed, installed, env), `the hooks reach ${package_}, the Coherence running this install\n`);
  assert.equal(versionBlock(project, false, env, installed), `Coherence 1.6.0 runs this session: ${package_}.\n`, "the session start says the same words");
  assert.equal(reachNote(project, sibling, sibling, { ...env, COHERENCE_HOME: checkout }), `the hooks reach the checkout COHERENCE_HOME names (${checkout}), the Coherence running this install\n`);
  assert.equal(reachNote(project, installed, sibling, env), `note: the hooks will run ${package_}, not a checkout at ../coherence, which runs this install\n`);
});

test("--version, -v, version, --help, -h and help answer at the top level", async () => {
  const env = { ...process.env, ...userEnv({ COHERENCE_NO_UPDATE_CHECK: "1" }) };
  for (const flag of ["--version", "-v", "version"]) {
    const run = await cli([flag], { cwd: CHECKOUT, env });
    assert.equal(run.status, 0, `${flag}: ${run.stderr}`);
    assert.match(run.stdout, new RegExp(`^coherence ${escaped(VERSION)}: this repository's own source\\.\\n`), flag);
  }
  for (const flag of ["--help", "-h", "help"]) {
    const run = await cli([flag], { cwd: CHECKOUT, env });
    assert.equal(run.status, 0, `${flag}: ${run.stderr}`);
    assert.match(run.stdout, /^usage:\n/, flag);
    assert.match(run.stdout, /coherence version {3}\(or --version, -v\)/, flag);
  }
});

test("the README's setup installs Coherence's latest release and names no version, invoked through npx --no --", () => {
  const readme = readFileSync(join(CHECKOUT, "README.md"), "utf8");
  const installs = [...readme.matchAll(/@posthog\/coherence@(\S+?)[`\s)]/g)].map((m) => m[1]);
  assert.ok(installs.length >= 3, "the quick, full and monorepo setups each install it");
  assert.deepEqual([...new Set(installs)], ["latest"], "every install asks for the latest release, never a version or a range that the next release leaves behind");
  assert.doesNotMatch(readme, /\bcoherence \d+\.\d+(\.\d+)?\b/, "no example shows a version that goes stale");
  assert.doesNotMatch(readme, /npx --no coherence/, "npx eats a flag such as --version unless -- ends its own");
  assert.match(readme, /npx --no -- coherence/);
  assert.match(readme, /minimumReleaseAgeExclude/);
});
