/**
 * Which file of a record store a writer appends to: a sealed shard
 * (docs/records-layout.md, d-3a125a06). A session's records in a store are
 * the union of its shard files, `<session>.<token>.jsonl` (or `.jsonseq`
 * when packed, stores.ts). A writer appends to the shard it last appended to
 * only while nothing git could have carried has moved since:
 *
 * - HEAD names the same commit and the same branch;
 * - HEAD's reflog is the size it was, so HEAD did not move and come back
 *   (a reset, a checkout and back, an amend reverted) in between;
 * - the shard is the size the writer left it, so no other writer, reset or
 *   stash touched it;
 * - the shard is under SHARD_LIMIT_BYTES and has the extension packed
 *   writing asks for now;
 * - git's index does not hold the shard, staged or committed, and no git
 *   command holds the index lock. The index is searched only when git has
 *   rewritten it since the shard was last seen outside it (its identity
 *   moved), so most appends pay one stat for it, never a read of a file that
 *   grows with the project.
 *
 * Anything else starts a new shard with a fresh random token. So once a
 * commit holds a shard, nothing appends to it again, and no file is ever
 * written from two branches: GitHub's merge, which honours no merge driver
 * (d-44ee2214), meets every shard on one side only (d-fe8a26f3).
 *
 * The writer's last shard per store is kept, per session, in
 * .coherence/cache/shards/<session>.json, written aside and renamed. It is
 * a hint, and the seal never rests on it alone: a lost, torn or foreign state starts a new
 * shard, and the index check is asked of git's own file, so even a state
 * that names a committed shard at the current HEAD never reuses it
 * (c-e23e2e42). Two writers racing on one state at worst start one shard
 * more than needed.
 *
 * Every check reads git's files and spawns nothing: HEAD, the branch's ref
 * (loose or packed), the reflog's size and the index, located from `.git`
 * or a worktree's `gitdir:`. Git is asked (one spawn) only where its files
 * cannot say: a reftable repository's HEAD, and an index in version 4 or
 * split, whose paths a byte search cannot find.
 */

import { spawnSync } from "../lifecycle/work-meter.ts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { LINE_EXTENSION, PACKED_EXTENSION, storeDir, type RecordStore } from "./stores.ts";

/** A shard this large is sealed: the next record starts a new one. */
export const SHARD_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Whether writers write packed shards (one line per shard) by default. Off:
 * this release ships the readers of packed shards; releases before it skip a
 * packed shard's records (stores.ts). Turn it on in the release after the
 * one that ships these readers, at the owner's call (docs/records-layout.md,
 * "Turning packed writing on").
 */
export const PACKED_BY_DEFAULT = false;

/** Whether this writer writes packed shards: COHERENCE_PACKED_RECORDS=1 or 0 overrides the default. */
export function packedWriting(env: NodeJS.ProcessEnv = process.env): boolean {
  const asked = env["COHERENCE_PACKED_RECORDS"];
  return asked === "1" ? true : asked === "0" ? false : PACKED_BY_DEFAULT;
}

/** What a writer keeps of its last shard in one store. */
interface Held {
  name: string;
  head: string;
  branch: string;
  reflog: number;
  size: number;
  /** The index's identity when it was last seen not to hold the shard: an index git has not rewritten since cannot hold it now. */
  index: string;
}

/** What a writer sees of git now: HEAD, its branch, the reflog's size and the index's identity. */
interface Seen {
  head: string;
  branch: string;
  reflog: number;
  index: string;
  /** When the index was last written. */
  indexTime: number;
}

/** Where git keeps a checkout's state: its own folder, the common one, and the checkout's top. */
interface GitPlace {
  gitDir: string;
  common: string;
  top: string;
}

/** The git checkout `root` lies in, by its `.git` entry, or undefined outside one. */
function gitPlace(root: string): GitPlace | undefined {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    let gitDir: string | undefined;
    try {
      const s = statSync(dotGit);
      gitDir = s.isDirectory() ? dotGit : resolve(dir, readFileSync(dotGit, "utf8").replace(/^gitdir:\s*/, "").trim());
    } catch {
      gitDir = undefined;
    }
    if (gitDir !== undefined) {
      let common = gitDir;
      try {
        common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
      } catch {
        // No commondir: the checkout's own folder is the common one.
      }
      return { gitDir, common, top: dir };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function git(cwd: string, args: string[]): { status: number | null; out: string } {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: run.status, out: typeof run.stdout === "string" ? run.stdout : "" };
}

/** HEAD's commit and branch, from git's files; git is asked only in a reftable repository. An unborn branch has no commit. */
export function headOf(place: GitPlace): { head: string; branch: string } {
  const text = (readText(join(place.gitDir, "HEAD")) ?? "").trim();
  if (!text.startsWith("ref: ")) return { head: text, branch: "" };
  const ref = text.slice("ref: ".length);
  if (existsSync(join(place.common, "reftable"))) {
    return { head: git(place.top, ["rev-parse", "-q", "--verify", "HEAD"]).out.trim(), branch: git(place.top, ["symbolic-ref", "-q", "HEAD"]).out.trim() };
  }
  for (const dir of [place.gitDir, place.common]) {
    const loose = readText(join(dir, ref));
    if (loose !== undefined) return { head: loose.trim(), branch: ref };
  }
  const packed = readText(join(place.common, "packed-refs")) ?? "";
  return { head: packed.split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] ?? "", branch: ref };
}

/** The size of HEAD's reflog: it grows with every move of HEAD, even one back to where it was. */
function reflogSize(place: GitPlace): number {
  try {
    return statSync(join(place.gitDir, "logs", "HEAD")).size;
  } catch {
    return -1;
  }
}

/** The index file's identity (inode, size, modification and change time); every write of it, a stage, a commit, a reset, changes it. */
function indexIdentity(place: GitPlace): { index: string; indexTime: number } {
  try {
    const s = statSync(join(place.gitDir, "index"));
    return { index: `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`, indexTime: Math.max(s.mtimeMs, s.ctimeMs) };
  } catch {
    return { index: "none", indexTime: -Infinity };
  }
}

/**
 * Whether git's index holds `rel` (a path from the checkout's top, with /),
 * staged or committed, or might: a held index lock, an index git's files
 * cannot answer for without git, and a git that fails all count as held.
 */
export function inIndex(place: GitPlace, rel: string): boolean {
  let index: Buffer;
  try {
    index = readFileSync(join(place.gitDir, "index"));
  } catch {
    return false;
  }
  const version = index.length >= 8 && index.toString("latin1", 0, 4) === "DIRC" ? index.readUInt32BE(4) : 0;
  const split = (() => {
    try {
      return readdirSync(place.gitDir).some((name) => name.startsWith("sharedindex."));
    } catch {
      return false;
    }
  })();
  if (version !== 2 && version !== 3 || split) {
    const asked = git(place.top, ["ls-files", "-z", "--", rel]);
    return asked.status !== 0 || asked.out !== "";
  }
  // Version 2 and 3 entries end with the full path and a NUL, after the flags whose low 12 bits are its length.
  const wanted = Buffer.from(`${rel}\0`, "utf8");
  const length = Math.min(wanted.length - 1, 0xfff);
  for (let at = index.indexOf(wanted, 12); at !== -1; at = index.indexOf(wanted, at + 1)) {
    for (const flags of [at - 2, at - 4]) if (flags >= 12 && (index.readUInt16BE(flags) & 0xfff) === length) return true;
  }
  return false;
}

function statePath(root: string, session: string): string {
  return join(root, ".coherence", "cache", "shards", `${session}.json`);
}

/** The writer's kept shards by store; empty when the state is lost, torn or not in its shape. */
function readState(root: string, session: string): Partial<Record<RecordStore, Held>> {
  try {
    const value = JSON.parse(readFileSync(statePath(root, session), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: Partial<Record<RecordStore, Held>> = {};
    for (const [store, held] of Object.entries(value as Record<string, unknown>)) {
      const h = held as Partial<Held> | null;
      if (h !== null && typeof h === "object" && typeof h.name === "string" && typeof h.head === "string" && typeof h.branch === "string" && typeof h.reflog === "number" && typeof h.size === "number" && typeof h.index === "string") out[store as RecordStore] = h as Held;
    }
    return out;
  } catch {
    return {};
  }
}

function writeState(root: string, session: string, state: Partial<Record<RecordStore, Held>>): void {
  const path = statePath(root, session);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const aside = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    writeFileSync(aside, JSON.stringify(state));
    renameSync(aside, path);
  } catch {
    // The state is a hint: unkept, the next record starts a new shard.
  }
}

/** A file's size, or -1 when it is not there. */
function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}

/** The shard a writer appends to, and what it keeps once the record is appended. */
export interface Shard {
  /** The shard's file name in its store folder. */
  name: string;
  /** Its path under `root`. */
  file: string;
  /** Whether this append starts it. */
  fresh: boolean;
  /** Keep the shard as this writer's last, at its size now; called after the append. */
  kept: () => void;
}

/** Why a writer's last shard cannot be appended to again, or undefined when it can. */
function sealedBecause(root: string, store: RecordStore, held: Held | undefined, packed: boolean, now: Seen, place: GitPlace | undefined): string | undefined {
  if (held === undefined) return "no shard kept";
  if (held.name.endsWith(packed ? PACKED_EXTENSION : LINE_EXTENSION) === false) return "the format changed";
  if (held.head !== now.head || held.branch !== now.branch || held.reflog !== now.reflog) return "HEAD moved";
  const file = join(root, storeDir(store), held.name);
  let shard: { size: number; mtimeMs: number };
  try {
    shard = statSync(file);
  } catch {
    return "the shard is gone";
  }
  if (shard.size !== held.size) return "the shard changed size";
  if (shard.size >= SHARD_LIMIT_BYTES) return "the shard is full";
  if (place === undefined) return undefined;
  if (existsSync(join(place.gitDir, "index.lock"))) return "git holds the index";
  // The index is searched when git rewrote it since the shard was last seen outside it, and whenever it was written
  // at or after the shard's last write, as a stage of the shard writes it: so the search is skipped on the state's
  // word only for an index older than the shard's last byte, which no stage of the shard as it is can have written.
  const unchanged = held.index === now.index && now.indexTime < shard.mtimeMs;
  if (!unchanged && inIndex(place, relative(place.top, file).split(sep).join("/"))) return "git holds the shard";
  return undefined;
}

/**
 * The shard `session` appends its next `store` record to: its last one when
 * nothing has sealed it, else a new one. The caller appends, then calls
 * `kept()`. The session must already be a valid file-name token.
 */
export function shardFor(root: string, store: RecordStore, session: string, env: NodeJS.ProcessEnv = process.env): Shard {
  const place = gitPlace(root);
  // The index's identity is taken before anything is searched, so a stage that lands after it is seen by the next append.
  const seen: Seen = place === undefined ? { head: "", branch: "", reflog: -1, index: "none", indexTime: -Infinity } : { ...indexIdentity(place), ...headOf(place), reflog: reflogSize(place) };
  const packed = packedWriting(env);
  const state = readState(root, session);
  const held = state[store];
  const reuse = sealedBecause(root, store, held, packed, seen, place) === undefined;
  let name = held?.name ?? "";
  if (!reuse) {
    // A token any file already has is drawn again: a new shard is always a new file.
    do name = `${session}.${randomBytes(4).toString("hex")}${packed ? PACKED_EXTENSION : LINE_EXTENSION}`;
    while (existsSync(join(root, storeDir(store), name)));
  }
  const file = join(root, storeDir(store), name);
  return {
    name,
    file,
    fresh: !reuse,
    kept: () => {
      const latest = readState(root, session);
      latest[store] = { name, head: seen.head, branch: seen.branch, reflog: seen.reflog, index: seen.index, size: sizeOf(file) };
      writeState(root, session, latest);
    },
  };
}
