/**
 * Coherence's line in Claude Code's status line: what the session's hooks
 * cost against the latency budget, and the practices it owes, where the user
 * sees them all the time and the agent spends nothing on them.
 *
 * The host runs a status line command after events, debounced, and cancels
 * one still running when the next is due, so this reads only what the hooks
 * already kept for the session: its hook times, its firings and its journal
 * shards, in the project the status line runs in, in the repository top and in
 * each leaf a registry there lists. No git, no spec model, no project
 * listing: the cost is the session's own files, whatever the project's size.
 * It imports nothing of Coherence's beyond this file, because loading the
 * modules the hooks load would cost more than every reading here together.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the hooks keep what this reads; held equal to the hooks' own constants by a test. */
export const STATUS_SOURCES = {
  hookTimes: join(".coherence", "hook-times"),
  firings: join(".coherence", "practices"),
  journal: join(".coherence", "journal"),
  server: join(".coherence", "run", "server.json"),
} as const;
export const STATUS_DEFAULT_BUDGET = 3;
/** The tool hooks, held equal to hook-events.ts's by a test, since this module imports nothing of Coherence's. */
export const STATUS_TOOL_HOOKS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse"]);
const CONFIG = "coherence.config.json";

/** What Claude Code sends a status line command on stdin, as far as this reads it. */
export interface StatusInput {
  session_id?: unknown;
  cwd?: unknown;
  workspace?: { current_dir?: unknown; project_dir?: unknown };
}

export interface StatusReading {
  version: string | null;
  /** Tool hook calls this session, their total time, and those over the budget. */
  calls: number;
  totalMs: number;
  over: number;
  budget: number;
  /** Practices that fired this session with no enactment since, by id. */
  owed: string[];
  /** Whether any folder read holds Coherence's records: a session outside every project shows nothing. */
  inProject: boolean;
  /** The live Scope page's address, while a warm server answers it; it carries the token, so it goes only where the user alone reads it. */
  scope?: string;
}

const fileName = (session: string): string => `${session.replace(/[^\w.-]/g, "_")}.jsonl`;

function lines(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text.split(/[\n\u001e]/).flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

/**
 * The session's own journal records: its legacy `<session>.jsonl` and every
 * shard `<session>.<token>.jsonl` or packed `.jsonseq` (journal/stores.ts),
 * whose records end with U+001E instead of a newline. One listing of the
 * folder, then the session's files alone.
 */
function journalOf(dir: string, session: string): unknown[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const legacy = fileName(session);
  const shard = new RegExp(`^${session.replace(/[^\w-]/g, (c) => `\\${c}`)}\\.[0-9a-f]{8}\\.(jsonl|jsonseq)$`);
  return names.filter((n) => n === legacy || shard.test(n)).flatMap((n) => lines(join(dir, n)));
}

function config(dir: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, CONFIG), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The repository top above `start`, by the .git entry alone; undefined outside one. */
function repositoryTop(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The folders whose records may hold this session's: the nearest project up from the cwd, the repository top, and every leaf its registry lists. */
export function statusFolders(cwd: string): string[] {
  const start = resolve(cwd);
  const folders: string[] = [];
  const top = repositoryTop(start);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG)) || isDir(join(dir, ".coherence"))) {
      folders.push(dir);
      break;
    }
    if (dir === top || dirname(dir) === dir) break;
  }
  if (top !== undefined) {
    folders.push(top);
    const projects = config(top)?.["projects"];
    if (Array.isArray(projects)) for (const p of projects) if (typeof p === "string") folders.push(resolve(top, p));
  }
  return [...new Set(folders)];
}

function budgetOf(folders: readonly string[]): number {
  for (const dir of folders) {
    const value = config(dir)?.["latencyBudget"];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return STATUS_DEFAULT_BUDGET;
}

let ownVersion: string | null | undefined;
/** This installation's version, from the package.json two folders up, as the hooks read it. */
export function statusVersion(): string | null {
  if (ownVersion !== undefined) return ownVersion;
  try {
    const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")) as { version?: unknown };
    ownVersion = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    ownVersion = null;
  }
  return ownVersion;
}

/**
 * The address of the live Scope page a warm server answers for one folder,
 * from the pointer the server keeps (mode 0600): only while its process is
 * alive and it serves HTTP. A status line cannot start a server, so a folder
 * with none shows no link, and `coherence scope` starts one.
 */
export function scopeAddress(folder: string): string | undefined {
  let pointer: { pid?: unknown; token?: unknown; http?: { port?: unknown } };
  try {
    pointer = JSON.parse(readFileSync(join(folder, STATUS_SOURCES.server), "utf8")) as typeof pointer;
  } catch {
    return undefined;
  }
  const port = pointer.http?.port;
  if (typeof pointer.pid !== "number" || typeof pointer.token !== "string" || !/^[0-9a-f]{64}$/.test(pointer.token) || typeof port !== "number") return undefined;
  try {
    process.kill(pointer.pid, 0);
  } catch {
    // Gone, or (EPERM) another user's process under a reused pid: no server of this user's answers there.
    return undefined;
  }
  return `http://127.0.0.1:${port}/?token=${pointer.token}`;
}

/** What the session's kept records say now. */
export function readStatus(input: StatusInput): StatusReading | undefined {
  const session = typeof input.session_id === "string" && input.session_id !== "" ? input.session_id : undefined;
  const cwd = [input.workspace?.current_dir, input.cwd, input.workspace?.project_dir].find((c): c is string => typeof c === "string" && c !== "");
  if (session === undefined || cwd === undefined) return undefined;
  const folders = statusFolders(cwd);
  const inProject = folders.some((dir) => isDir(join(dir, ".coherence")) || existsSync(join(dir, CONFIG)));
  const budget = budgetOf(folders);
  let calls = 0;
  let totalMs = 0;
  let over = 0;
  const fired = new Map<string, string>();
  const enacted: { practice: string; at: string }[] = [];
  const name = fileName(session);
  for (const dir of folders) {
    for (const t of lines(join(dir, STATUS_SOURCES.hookTimes, name))) {
      const time = t as { event?: unknown; ms?: unknown };
      if (typeof time.event !== "string" || typeof time.ms !== "number" || !STATUS_TOOL_HOOKS.has(time.event)) continue;
      calls += 1;
      totalMs += time.ms;
      if (time.ms > budget * 1000) over += 1;
    }
    for (const f of lines(join(dir, STATUS_SOURCES.firings, name))) {
      const firing = f as { practice?: unknown; at?: unknown };
      if (typeof firing.practice === "string" && typeof firing.at === "string" && !fired.has(firing.practice)) fired.set(firing.practice, firing.at);
    }
    for (const r of journalOf(join(dir, STATUS_SOURCES.journal), session)) {
      const record = r as { kind?: unknown; practice?: unknown; at?: unknown; session?: unknown };
      if (record.kind === "enactment" && typeof record.practice === "string" && typeof record.at === "string" && record.session === session) enacted.push({ practice: record.practice, at: record.at });
    }
  }
  // As regulate reads it: owed when no enactment of the practice came at or after its first firing.
  const owed = [...fired].filter(([practice, at]) => !enacted.some((e) => e.practice === practice && e.at >= at)).map(([practice]) => practice);
  const scope = folders.map(scopeAddress).find((address) => address !== undefined);
  return { version: statusVersion(), calls, totalMs, over, budget, owed, inProject, ...(scope === undefined ? {} : { scope }) };
}

const DIM = "\u001b[2m";
const YELLOW = "\u001b[33m";
const RESET = "\u001b[0m";

/** A terminal hyperlink (OSC 8): the label shows, the address does not; a terminal without them shows the label alone. */
const link = (url: string, label: string): string => `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\`;

/**
 * The one line, or "" for a session no project of Coherence's holds. Colour
 * only where something wants the user's eye; the Scope link only where a
 * terminal can draw it, never as a bare address, since the address carries
 * the token.
 */
export function statusText(reading: StatusReading | undefined, colour = true, links = colour): string {
  if (reading === undefined || !reading.inProject) return "";
  const paint = (text: string, code: string): string => (colour ? `${code}${text}${RESET}` : text);
  const parts = [paint(`coherence ${reading.version ?? "(version unknown)"}`, DIM)];
  if (reading.calls > 0) {
    const average = `hooks ${(reading.totalMs / reading.calls / 1000).toFixed(1)} s avg`;
    parts.push(reading.over === 0 ? paint(average, DIM) : paint(`${average}, ${reading.over} over ${reading.budget} s`, YELLOW));
  }
  if (reading.owed.length > 0) {
    const short = reading.owed.map((id) => id.split("/").at(-1) ?? id);
    parts.push(paint(`${reading.owed.length} practice${reading.owed.length === 1 ? "" : "s"} owed: ${short.join(", ")}`, YELLOW));
  }
  if (links && reading.scope !== undefined) parts.push(link(reading.scope, "scope ↗"));
  return parts.join(paint(" · ", DIM));
}
