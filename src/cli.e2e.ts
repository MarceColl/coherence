/**
 * The command line end to end, spawned as a user runs it, beside the same
 * commands run in-process through cli() (lifecycle/cli-fixture.ts): for each
 * command family, two copies of one project, one driven by `node src/cli.ts`
 * per command and one by cli(), answer with the same exit codes, the same
 * stdout and stderr, and keep the same records. This is the unit suite's
 * small set of spawned tests, the one place a test launches the binary per
 * command (the leak guard's spawn budget does not apply to a *.e2e.ts file);
 * every other test of a command runs it through cli().
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { cli, type CliResult } from "./lifecycle/cli-fixture.ts";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function folder(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** A small adopter: a config, one component with an invariant, a source file, committed. */
function project(): string {
  const root = folder("coherence-cli-e2e-");
  const files: Record<string, string> = {
    "coherence.config.json": JSON.stringify({ name: "e2e", language: "typescript" }),
    "src/a.ts": "export const a = 1;\n",
    "src/A.spec.md": "# A\n\nThe a module.\n\n## invariants\n- a is one: a is always one.\n  over: a\n  via: a is one\n  because: the rest reads it\n  kinds: none\n",
    "sub/notes.md": "notes\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return root;
}

/** The environment both paths run under: a home of its own, no warm-up, telemetry or update check, and no host project naming another folder. */
function quietEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, COHERENCE_NO_WARM_UP: "1", COHERENCE_TELEMETRY: "0", COHERENCE_NO_UPDATE_CHECK: "1" };
  delete env["CLAUDE_PROJECT_DIR"];
  delete env["COHERENCE_HOME"];
  return env;
}

interface Step {
  args: string[];
  stdin?: string;
}

/** A shard's random token (journal/shards.ts), which differs between two copies. */
const SHARD_TOKEN = /\.[0-9a-f]{8}\.(jsonl|jsonseq)\b/g;

/** Every file Coherence keeps under the project's .coherence, relative, sorted; a shard's token as <token>. */
function records(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(root, path).replace(SHARD_TOKEN, ".<token>.$1"));
    }
  };
  walk(join(root, ".coherence"));
  return out.sort();
}

/** What may differ between two copies and two moments: the root's path, the home's, record ids, times and durations. */
function plain(text: string, root: string, home: string): string {
  return text
    .replaceAll(root, "<root>")
    .replaceAll(home, "<home>")
    .replace(SHARD_TOKEN, ".<token>.$1")
    .replace(/\b([a-z]{1,3})-[0-9a-f]{8}\b/g, "$1-<id>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?Z?)?/g, "<time>")
    .replace(/\b\d+(\.\d+)? ?m?s\b/g, "<ms>");
}

/** The steps through spawned processes in one copy and through cli() in another: each answer and the records, side by side. */
async function both(steps: readonly Step[]): Promise<{ spawned: CliResult[]; inProcess: CliResult[]; records: [string[], string[]] }> {
  const cold = project();
  const warm = project();
  const coldHome = folder("coherence-cli-e2e-home-");
  const warmHome = folder("coherence-cli-e2e-home-");
  const spawned = steps.map(({ args, stdin }) => {
    const ran = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { cwd: cold, input: stdin ?? "", encoding: "utf8", env: quietEnv(coldHome) });
    return { status: ran.status ?? -1, stdout: plain(ran.stdout, cold, coldHome), stderr: plain(ran.stderr, cold, coldHome) };
  });
  const inProcess: CliResult[] = [];
  for (const { args, stdin } of steps) {
    const ran = await cli(args, { cwd: warm, env: quietEnv(warmHome), ...(stdin === undefined ? {} : { stdin }) });
    inProcess.push({ status: ran.status, stdout: plain(ran.stdout, warm, warmHome), stderr: plain(ran.stderr, warm, warmHome) });
  }
  return { spawned, inProcess, records: [records(cold), records(warm)] };
}

async function same(steps: readonly Step[]): Promise<CliResult[]> {
  const { spawned, inProcess, records: [cold, warm] } = await both(steps);
  assert.deepEqual(inProcess, spawned);
  assert.deepEqual(warm, cold, "the same records");
  return spawned;
}

const SESSION = ["--session", "e2e-session", "--agent", "e2e"];

describe("cli() answers each command family as the spawned command line does: the same exit, stdout, stderr and records", () => {
  it("help, version and a usage error", async () => {
    const [help, , bad] = await same([{ args: ["help"] }, { args: ["--version"] }, { args: ["no-such-verb"] }]);
    assert.equal(help!.status, 0);
    assert.match(help!.stdout, /^usage:/);
    assert.equal(bad!.status, 64);
    assert.match(bad!.stderr, /unknown verb "no-such-verb"/);
  });

  it("the journal: a decision written, then read", async () => {
    const [decided, read] = await same([{ args: ["decide", "keep a at one", "--because", "the rest reads it", ...SESSION] }, { args: ["journal"] }]);
    assert.equal(decided!.status, 0);
    assert.match(read!.stdout, /keep a at one/);
  });

  it("spec and scaffold", async () => {
    const [check, scaffolded] = await same([{ args: ["spec", "--check"] }, { args: ["scaffold", "component", "sub", "The notes."] }]);
    assert.match(check!.stdout, /A/);
    assert.equal(scaffolded!.status, 0);
  });

  it("the lexicon check and the work orders", async () => {
    await same([{ args: ["lexicon", "--check"] }, { args: ["work", "inspect"] }]);
  });

  it("a hook event read from stdin, and an unknown event", async () => {
    const input = (root: string) => JSON.stringify({ cwd: root, session_id: "e2e-session", hook_event_name: "SessionStart", source: "startup" });
    // The event names its own copy's root, which plain() writes as <root> in both.
    const cold = project();
    const warm = project();
    const home = folder("coherence-cli-e2e-home-");
    const spawned = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "hook", "SessionStart"], { cwd: cold, input: input(cold), encoding: "utf8", env: quietEnv(home) });
    const ran = await cli(["hook", "SessionStart"], { cwd: warm, env: quietEnv(home), stdin: input(warm) });
    assert.deepEqual(
      { status: ran.status, stdout: plain(ran.stdout, warm, home), stderr: plain(ran.stderr, warm, home) },
      { status: spawned.status, stdout: plain(spawned.stdout, cold, home), stderr: plain(spawned.stderr, cold, home) },
    );
    assert.match(spawned.stdout, /additionalContext/);
    assert.deepEqual(records(warm), records(cold));
    const unknown = await same([{ args: ["hook", "Nope"], stdin: "{}" }]);
    assert.equal(unknown[0]!.status, 64);
  });

  it("hooks install and status", async () => {
    const [installed, status] = await same([{ args: ["hooks", "install", "--host", "codex", "--command", "node cli.js"] }, { args: ["hooks", "status"] }]);
    assert.equal(installed!.status, 0);
    assert.match(status!.stdout, /codex/);
  });

  it("query and the run's status", async () => {
    await same([{ args: ["query", "status"] }, { args: ["run", "--status"] }]);
  });

  it("ci, telemetry and adopt", async () => {
    await same([{ args: ["ci", "install", "--host", "github", "--mode", "fail"] }, { args: ["telemetry", "status"] }]);
    await same([{ args: ["adopt", "sub"] }]);
  });
});
