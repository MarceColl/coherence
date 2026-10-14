/**
 * Records this checkout does not hold but another branch does. Subagents and
 * parallel sessions work on branches of their own, and a record one of them
 * wrote is real before its branch merges: a citation of it is not a typo.
 * The committed journal and work files of every local and remote-tracking
 * branch are searched, by id, in one git grep; a record only in another
 * worktree's uncommitted files is not seen. Outside a git checkout, or when
 * git fails, nothing is found elsewhere.
 */

import { spawnSync } from "../lifecycle/work-meter.ts";
import { JOURNAL_DIR } from "./store.ts";
import { recordTexts } from "./stores.ts";
import { WORK_DIR } from "./work.ts";

/** Where a record was found: the branch, the file, and the record's JSON line. */
export interface Elsewhere {
  branch: string;
  file: string;
  line: string;
}

function git(cwd: string, args: string[]): string | undefined {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 || (run.status === 1 && args[0] === "grep") ? run.stdout : undefined;
}

/** The ids found on other branches, each at the first branch that holds it, local branches before remote ones. */
export function recordsOnOtherBranches(cwd: string, ids: readonly string[]): Map<string, Elsewhere> {
  const found = new Map<string, Elsewhere>();
  const wanted = [...new Set(ids)].filter((id) => /^[a-z]+-[0-9a-f]+$/.test(id));
  if (wanted.length === 0) return found;
  const refs = (git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]) ?? "")
    .split("\n")
    .filter((ref) => ref !== "" && !ref.endsWith("/HEAD"));
  if (refs.length === 0) return found;
  const patterns = wanted.flatMap((id) => ["-e", `"id":"${id}",`]);
  const out = git(cwd, ["grep", "-F", "--no-color", ...patterns, ...refs, "--", JOURNAL_DIR, WORK_DIR]) ?? "";
  for (const hit of out.split("\n")) {
    const refEnd = hit.indexOf(":");
    const fileEnd = hit.indexOf(":", refEnd + 1);
    if (refEnd === -1 || fileEnd === -1) continue;
    // A packed shard is one line of records each ended by the separator: each is matched alone.
    for (const line of recordTexts(hit.slice(fileEnd + 1))) {
      const id = /^\{"id":"([^"]+)"/.exec(line)?.[1];
      if (id === undefined || found.has(id) || !wanted.includes(id)) continue;
      const ref = hit.slice(0, refEnd);
      found.set(id, { branch: ref.replace(/^refs\/(heads|remotes)\//, ""), file: hit.slice(refEnd + 1, fileEnd), line });
    }
  }
  return found;
}
