/**
 * The mirror reading as the hooks see it: never computed in a hook. A reading
 * takes about a second on Coherence and grows with the project and its
 * history, and a hook has a 3 s latency budget, so a hook only reads the last
 * reading kept here, under .coherence/mirrors (transient, like the Structure
 * reading's record), and starts a new one detached, never waiting on it.
 *
 * What is kept is what orient needs: the commit the reading read, when, the
 * groups the threshold policy surfaces, and the alarms. query mirrors keeps
 * it whenever it reads HEAD with the default options; the session start and
 * the stop start `query mirrors --refresh` in the background, which reads
 * only when the kept reading is of another commit than HEAD.
 *
 * Node-only, and it never imports the reading (mirrors.ts) or the compiler:
 * a hook that loads this module loads neither.
 */

import { spawn } from "../../lifecycle/work-meter.ts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Finding, Group, MirrorReading } from "./model.ts";
import { alarmsOf, alarmText, PARSED_LANGUAGES, surfaced, unreadText } from "./policy.ts";

/** Where the kept reading and the refresh mark live: transient, never committed. */
export const MIRRORS_DIR = join(".coherence", "mirrors");

/** 2: the reading counts the code files it read and the files it left unread for their language. */
const RECORD_VERSION = 2;

export interface RecordedMirrors {
  version: number;
  /** The commit the reading read. */
  commit: string;
  /** When it was kept (ISO). */
  at: string;
  ms: number;
  sets: number;
  /** The code files the reading parsed. */
  read: number;
  /** The tracked files in a language it does not parse, by extension. */
  unread: Record<string, number>;
  /** How many groups the reading had in all. */
  groups: number;
  /** The groups the threshold policy puts in front of the agent, in rank order. */
  surfaced: Group[];
  /** Every finding of the alarm-worthy shape, wherever it ranked. */
  alarms: Finding[];
}

function readingPath(root: string): string {
  return join(root, MIRRORS_DIR, "reading.json");
}

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, path);
}

/** Keep a reading for the hooks. Only a reading of HEAD with the default options should be kept; the caller decides. */
export function recordMirrors(root: string, reading: MirrorReading, now: () => Date = () => new Date()): RecordedMirrors {
  const recorded: RecordedMirrors = {
    version: RECORD_VERSION,
    commit: reading.commit,
    at: now().toISOString(),
    ms: reading.ms,
    sets: reading.sets,
    read: reading.read,
    unread: reading.unread,
    groups: reading.groups.length,
    surfaced: reading.groups.filter(surfaced),
    alarms: alarmsOf(reading.groups),
  };
  writeAtomically(readingPath(root), JSON.stringify(recorded));
  return recorded;
}

/** The last reading kept, or undefined when none was or it cannot be read. */
export function lastMirrors(root: string): RecordedMirrors | undefined {
  try {
    const parsed = JSON.parse(readFileSync(readingPath(root), "utf8")) as RecordedMirrors;
    return parsed.version === RECORD_VERSION && typeof parsed.commit === "string" && Array.isArray(parsed.surfaced) && Array.isArray(parsed.alarms) && typeof parsed.read === "number" && typeof parsed.unread === "object" && parsed.unread !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------ background refresh */

interface RefreshMark {
  pid: number;
  at: string;
}

/** How long a refresh may run before another may start in its place. */
const REFRESH_STALE_MS = 10 * 60 * 1000;

function refreshPath(root: string): string {
  return join(root, MIRRORS_DIR, "refresh.json");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The refresh under way, when one is alive and young enough to still count. */
export function mirrorRefreshUnderWay(root: string, now: () => number = Date.now): RefreshMark | undefined {
  try {
    const mark = JSON.parse(readFileSync(refreshPath(root), "utf8")) as RefreshMark;
    return alive(mark.pid) && now() - Date.parse(mark.at) < REFRESH_STALE_MS ? mark : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start one reading in the background: detached, its output discarded, never
 * waited on, and not while another is alive. `command` is the argv that
 * refreshes (the CLI's query mirrors --refresh), which reads only when the
 * kept reading is of another commit. Returns whether one started.
 */
export function refreshMirrorsInBackground(root: string, command: readonly string[], now: () => number = Date.now): boolean {
  try {
    if (mirrorRefreshUnderWay(root, now) !== undefined) return false;
    const [program, ...args] = command;
    if (program === undefined) return false;
    const child = spawn(program, args, { cwd: root, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) return false;
    writeAtomically(refreshPath(root), JSON.stringify({ pid: child.pid, at: new Date(now()).toISOString() } satisfies RefreshMark));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- orient */

/** How long one orient line may be, so the start injection's budget does not grow with the project. */
export const ORIENT_LINE_LIMIT = 320;
/** How many alarms orient names before it counts the rest. */
const ORIENT_ALARMS = 2;

/**
 * Whether the kept reading left the project's code unread: it parsed no code
 * file while some were in another language, or the files it left unread
 * outnumber the ones it parsed. A TypeScript project with a few stray Python
 * fixtures is read, and orient says nothing of them (query mirrors still does).
 */
export function codeUnread(recorded: RecordedMirrors): boolean {
  const unread = Object.values(recorded.unread).reduce((sum, n) => sum + n, 0);
  return unread > 0 && unread > recorded.read;
}

function cut(line: string): string {
  return line.length <= ORIENT_LINE_LIMIT ? line : `${line.slice(0, ORIENT_LINE_LIMIT - 1)}…`;
}

/**
 * Orient's hand-list lines, from the kept reading alone: one line counting
 * the surfaced groups and naming the strongest, and one per alarm (at most
 * two, the rest counted), and one when it left the project's code unread.
 * Nothing when no reading was kept or it surfaces nothing. Advisory, labeled with the commit and time it read.
 */
export function orientMirrorText(recorded: RecordedMirrors | undefined, cli: string): string {
  if (recorded === undefined) return "";
  const lines: string[] = [];
  const asOf = `the mirror reading at ${recorded.commit.slice(0, 7)}, ${recorded.at.slice(0, 16).replace("T", " ")} UTC`;
  if (codeUnread(recorded)) lines.push(cut(`Hand lists (${asOf}; advisory): not read for ${unreadText(recorded.unread)}; the reading parses ${PARSED_LANGUAGES}.`));
  const top = recorded.surfaced[0]?.findings[0];
  if (top !== undefined) {
    const n = recorded.surfaced.length;
    lines.push(cut(`Hand lists (${asOf}; advisory, never blocking): ${n} group${n === 1 ? "" : "s"} of lists kept by hand that mirror each other across files; the strongest, ${top.a.name} (${top.a.file}:${top.a.line}), is ${top.verdict} against ${top.b.name} (${top.b.file}${top.b.line > 0 ? `:${top.b.line}` : ""}). ${cli} query mirrors lists them.`));
  }
  for (const f of recorded.alarms.slice(0, ORIENT_ALARMS)) lines.push(cut(`Hand list drifted (${asOf}): ${alarmText(f)}.`));
  if (recorded.alarms.length > ORIENT_ALARMS) lines.push(`and ${recorded.alarms.length - ORIENT_ALARMS} more drifted lists of files: ${cli} query mirrors`);
  return lines.join("\n");
}

/** Orient's block: the lines above from the last kept reading, followed by a blank line, or nothing. */
export function mirrorBlock(root: string, cli: string): string {
  const text = orientMirrorText(lastMirrors(root), cli);
  return text === "" ? "" : `${text}\n\n`;
}
