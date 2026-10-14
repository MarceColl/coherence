# The record stores' layout

A design spike: how the record stores under `.coherence` (the journal, the
runs, the work orders) can be laid out so that GitHub's merge never conflicts
on them, and so they barely register in a pull request's line counts. Nothing
here changes the live stores; the measurements come from
`bench/records/layouts.ts` and `bench/records/github-counts.ts`, whose output
is in `bench/records/results.json` and `bench/records/github-counts.json`.

## Recommendation

**Sealed shards.** Each writer appends to `.coherence/<store>/<session>.<token>.jsonl`
and mints a new random token whenever HEAD, the branch or the shard's size is
not what it was at its last append. A commit moves HEAD, so it seals every
shard written before it: a committed shard is never appended again, and no
file is ever written from two branches. Records stay one JSON object per line,
append only, and attributed by their `session` and `agent` fields; a session's
records are the union of its shard files, as they are the union of its lines
today.

- **Problem 1 (merge conflicts) is solved.** Across 12 merges (parallel and
  stacked branches of one session, each landed by GitHub's merge, squash and
  rebase), sealed shards conflicted in none and every record landed. Today's
  layout conflicted in all 12, in every store.
- **Old releases need no change.** Every reader already reads each `*.jsonl`
  in a store's folder, whatever its name. The bench ran 1.7.2's own
  `loadJournal`, `loadRuns` and `loadWork` over the sharded stores: 1,130,
  2,173 and 116 records, none damaged.
- **Problem 2 (line counts) cannot be solved by attributes.** GitHub counts
  every line of a `linguist-generated`, `-diff` or `binary` file (probe on
  #121). Records are 2.4% of the lines added in the last 30 merged pull
  requests (396 of 16,169). The way to shrink that on the branch is a **second
  step**: *packed* sealed shards, one line per shard, which GitHub counts as 1
  (probe on #121). Over those 30 pull requests the 396 record lines would have
  been 56. It needs a reader-first release, because today's readers read a
  packed shard as one damaged line.

Records off the branch (`refs/coherence/records`) are the only design that
takes records out of a pull request entirely. Its costs in pushing, fetching,
forks and CI are high, so it is not recommended (see below).

Journal: d-3a125a06 (the layout), d-fe8a26f3 (seal when HEAD moves),
d-d5b49709 (attributes cannot do it; packing comes second), u-beb57c2a (GitHub's
merge simulated), c-e23e2e42 (an open question about lost shard state).

## What GitHub does with the record files

**Merging.** GitHub's merge ignores `merge=union` (d-44ee2214, 2026-10-14):
#119 went `CONFLICTING` after #118 and #120 landed, and CI ran none of its
jobs on it. The bench stands in for GitHub's merge with plain `git merge`,
`git merge --squash` and `git rebase` in a repository that has no
`.coherence/.gitattributes` (u-beb57c2a).

**Counting.** `gh api repos/PostHog/coherence/pulls/121/files` reports, for 20
identical record lines under each attribute:

| file | attributes | additions GitHub counts | patch returned |
| --- | --- | --- | --- |
| plain.jsonl | (none) | 20 | yes |
| generated.jsonl | `linguist-generated=true` | 20 | yes |
| nodiff.jsonl | `-diff` | 20 | yes |
| binary.jsonl | `binary` | 20 | yes |
| generated-nodiff.jsonl | `linguist-generated=true -diff` | 20 | yes |
| undriven.jsonl | `diff=coherence-records` (no such driver) | 20 | yes |
| packed.jsonl | (none); the same 20 records on one line, each led by 0x1e | **1** | yes |

Every probe file is also counted in the pull request's `changedFiles`. So
`linguist-generated` only folds the rendered diff. It changes neither the +/−
nor the files-changed count, and `-diff` doesn't either. Locally `-diff` does
make `git diff --numstat` print `-`, but it also makes `git grep` answer
"Binary file … matches" instead of the line. That would break the cross-branch
citation search (`src/journal/branches.ts`) in every release. Attributes alone
cannot solve problem 2.

**How much of a pull request the records are.** For the last 30 merged pull
requests (`github-counts.json`, `history`), GitHub's additions match the local
diff of each merge commit. Records were 396 of 16,169 added lines (2.4%) and
51 of 375 changed files. The share is large only in small pull requests: #120
was records alone (17 of 17), #93 33%, #89 25%. A run record can be hundreds of
KB yet counts as one line.

## The candidates

Measured on this repository's records at 7552e4f: 3,419 records (1,130 journal,
2,173 runs, 116 work orders) in 203 files, on darwin arm64, node 22.21.1,
git 2.50.1. The time columns are medians. The merge column counts the scenarios
(out of 6) in which GitHub's merge conflicted. The pull request columns are
for the bench's stacked parent A, which adds 18 records over two commits plus
two one-line code files.

| | (today) one file per session | (a) one file per record | (b) records on a ref | (c) sealed shards | (c') shards sealed only by a branch change | (d) packed sealed shards | (e) attributes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ends GitHub's conflicts | no: 6 of 6 | yes: 0 of 6 | yes: 0 of 6 | **yes: 0 of 6** | no: 1 of 6 (stacked, squash) | yes: 0 of 6 | no: they don't reach GitHub's merge |
| pull request A (+, files) | 20, 5 files | 20, 20 files | 2, 2 files | 20, 8 files | 20, 5 files | **8, 8 files** | unchanged: counted in full |
| last 30 pull requests' record lines, files | 396, 51 | ≈ one file per record | 0, 0 | 396, 56 | ≈ 396, 51 | **56, 56** | 396, 51 |
| files in the stores | 203 | 3,419 | 0 in the tree | 444 | ≈ today (not measured) | 444 | 203 |
| store bytes (runs compacted per file) | 18.3 MB | 23.0 MB | 18.3 MB | 19.5 MB | ≈ today (not measured) | 19.5 MB | 18.3 MB |
| `loadJournal`, as is / journal at 10x | 5.1 ms / 52 ms | 20 ms / 213 ms | 97 ms (all stores, `cat-file --batch`) | 9.6 ms / 75 ms | ≈ today (not measured) | 4.9 ms (reader splitting on 0x1e) | as today |
| `loadRuns` | 57 ms | 95 ms | (in the above) | 62 ms | ≈ today (not measured) | needs the new reader | as today |
| `journalFileKeys` (the peer feed's stat pass), as is / 10x | 0.3 / 3.0 ms | 3.6 / 37 ms | n/a | 0.6 / 7.0 ms | ≈ today (not measured) | 0.6 / 6.7 ms | as today |
| one append | 0.04 ms | 0.07 ms | 87 ms (6 git spawns; compare-and-swap) | 0.08 ms reading HEAD from `.git`; 18 ms asking git | as (c) | as (c) | as today |
| first commit of the stores, as is / 10x | 0.25 s / 0.53 s | 1.6 s / 4.9 s | n/a | 0.33 s / 1.1 s | ≈ today (not measured) | 0.36 s / 1.2 s | as today |
| cross-branch citation search (`git grep` over refs), as is / 10x | 29 / 96 ms | 107 / 477 ms | must read the ref instead | 39 / 195 ms | ≈ today (not measured) | 41 / 204 ms, needs splitting | breaks under `-diff` |
| read by 1.7.x unchanged | yes | yes, if flat (a nested `<session>/` folder would be skipped, silently) | no | **yes, every record** | yes | no: 0 records, 236 damaged journal lines | yes |

Read cost against the 3 s tool hook budget: the slowest whole-store read of any
on-branch layout at 10x the journal is 0.21 s, for one file per record. Sealed
shards add 4.5 ms to the session-start journal load today, and 23 ms at 10x.

### (a) One file per record

This layout never conflicts: a record's file is named by its content, so two
branches that hold the same record hold the same blob, and add/add with the
same contents is clean. It should be flat (`<session>.<hash>.jsonl`): a nested
`<session>/<id>.json` would be skipped by every released reader, and those
records would be gone without a word. It costs one file per record. That is
3,419 files today and 11,300 at 10x. The first commit takes 1.6 s (4.9 s at
10x), the journal loads 4x slower, the citation search is 4–5x slower, and
the peer feed's stat pass is 12x slower. Every record is also one changed file
in its pull request: A shows 20 files where sealed shards show 8. Runs grow by
26%, because a run's sites are stored once per file and referred to after
(`compactRecord` in `src/enforcement/record.ts`), and one run per file means
every run carries its sites in full. It is rejected because sealed shards end
the same conflicts at a seventh of the file count and with no reader change.

### (b) Records off the branch

Records committed to `refs/coherence/records` by the CLI with a scratch index,
never the worktree. A pull request shows none of them, and nothing on the branch
can conflict. The bench shows what that costs:

- `git push origin <branch>` does not carry the ref, and a fresh clone does not
  fetch it. Every human, agent and CI job needs an explicit
  `git fetch origin +refs/coherence/records:refs/coherence/records` and a push
  of the ref. `actions/checkout` fetches one ref (the pull request's merge ref)
  at depth 1 by default, and only branches and tags at `fetch-depth: 0`, so the
  records summary, the run index and every CI reading need a fetch step of
  their own.
- A second writer's push after the first was refused as non-fast-forward. The
  CLI would have to fetch, merge the two record trees itself, and push again,
  under contention from every parallel agent, on every append or at every stop.
- A fork cannot push to the upstream's refs. Its records reach upstream only
  if a workflow with `contents: write` fetches them from the fork after the
  merge. A contributor without that workflow loses them.
- "Merged with the pull request" would no longer mean anything git knows. A
  branch's records are on the ref whether or not the branch lands, and a reader
  sees them before the merge only after fetching the ref. Offline work is fine
  until a clone is deleted before its ref was pushed, and then the records
  are gone.
- Every append costs 6 git spawns (87 ms), and a read is one `ls-tree` and one
  `cat-file --batch` (97 ms for every store).
- No released reader would see a record.

Git notes have the same push and fetch costs. They are also tied to commits
that GitHub's squash and rebase merges replace, and GitHub no longer shows
them. Both are rejected as the default. A ref could be an opt-in later for an
adopter who wants zero record lines and runs the workflow.

### (c) Shards, and why a commit seals one

A shard sealed only when the branch changes (c') merged cleanly in every
parallel case. It conflicted in all three stores when a stacked child landed
after its parent was squash-merged: the parent kept appending to the shard the
child had copied when it forked, so main and the child each added that file
with different contents. Sealing whenever HEAD moves closes this case
(d-fe8a26f3). In the bench, sealed shards survived merge, squash and rebase in
both shapes. They cost little over (c'): over the last 30 pull requests,
sealing at each commit would have meant 56 record files changed where today's
layout changed 51 (`github-counts.json`, `shardFiles`). This is because most
pull requests commit their records once.

### (d) Packing

The task's working assumption was that packing makes conflicts worse. That
holds for a file two branches both write. A sealed shard is never written from
two branches, so packing there cannot conflict: 0 of 6 in the bench. What
packing does cost:

- **Released readers.** A packed shard is one line that is not one JSON object.
  1.7.2's readers report it as damaged and read none of its records (236
  damaged journal lines, 0 records). That is loud, never silent, but it still
  loses those records until the reader upgrades. So the reader has to ship
  first.
- **Every reader that splits lines.** `storeLines` (`src/journal/append.ts`),
  the run index's offset reads, Scope's live tail, the citation search's
  `^{"id":` match and the records summary would all split on 0x1e as well as
  the newline. A reader that does so costs what today's does: 4.9 ms for the
  journal.
- **Humans.** `cat` shows one long line, and `tr '\036' '\n'` shows the records.
  Agents read records through the CLI.

It is an append, never a rewrite: each record is written as `0x1e` and its
JSON with no newline after it. A torn write leaves one damaged segment that
the next separator ends, as a newline does today.

### (e) Attributes

The attributes have no effect on either count GitHub reports, as the probe
shows. `linguist-generated=true` stays for the rendered fold. `-diff` and
`binary` are rejected: they change nothing on GitHub and break `git grep`
locally.

## The design in detail

**Naming.** `.coherence/<store>/<session>.<token>.jsonl`, with the token 8 random
hex characters. Same folder, same extension. The session's prefix keeps a
directory listing readable by session. The record's own `session` field stays
the attribution, as it is now; no reader takes the session from a file name.

**When a shard is reused.** A writer keeps its state in an ignored cache file,
`.coherence/cache/shards/<session>.json`, holding the HEAD, branch, file name
and size after its last append for each store. It reuses that file only when
all four still hold. Otherwise it mints a new one. This covers several cases:

- a commit, an amend, a rebase, a pull or a checkout moves HEAD, and the next
  record starts a new shard;
- a reset or a stash changes the file's size, so the writer starts a new shard
  rather than recreate a name another commit already holds;
- a lost or unreadable state file only means one extra shard.

HEAD is read from the git folder's files: `.git`, a worktree's `gitdir:`, the
common folder, `packed-refs`. The bench measured 0.08 ms per append that way,
against 18 ms asking `git rev-parse`. A repository on the reftable backend
falls back to asking git. Whether lost state can ever make two branches write
one file is open (c-e23e2e42), and so is how the bench should test it.

**Writers.** `appendRecord` (journal), `appendWork` (work) and `appendRun` /
`appendRefutation` (runs) take the shard from one function beside `storeDir`
in `src/journal/stores.ts`, so the rule lives in one place. The legacy
`<session>.jsonl` files are never appended again; a session that began under
1.7 and goes on under the new release writes shards from its next record. The
verbs' "recorded in …" lines name the shard.

**Runs.** A run's sites are written in full the first time an enforcement
appears in a file, then referred to by hash. That stays true per shard: every
shard resolves alone. Its cost is the first run of each enforcement written in
full once per shard. For this repository's history that is 18.3 MB to 19.5 MB
(+7%). The run index keeps one identity per run file, 444 instead of 203, and
the stat pass over them took 1.0 ms.

**Readers.** Each one changes as follows:

- **Journal, query, the work orders and Scope's first load** read every
  `*.jsonl` in each store and order records by content. They need no change.
  The journal load is 9.6 ms (75 ms at 10x).
- **The peer feed** stats each journal file and reads the changed ones. The
  changed file is now the current shard, not the session's whole history, so
  a hook reads less than it does today.
- **Scope live** matches a path to its store by folder (`storeOfPath`), so it
  needs no change.
- **The CI records summary** parses the `+` lines of `git diff base...head`
  over the store folders. A new shard's lines are all `+` lines, so it needs no
  change.
- **The citation search** (`git grep` over every branch) finds a record in a
  shard as it does in a session file: 39 ms against 29 ms.
- **The mirror reading** leaves `.coherence` out of its tree and its history
  pass. Its `ls-tree` lists 444 store entries instead of 203 (9.6 ms against
  9.5 ms).

**Attributes.** `.coherence/.gitattributes` keeps `merge=union` for
`<store>/*.jsonl`. That covers the legacy files that old releases still append
to, and it is harmless on shards, which never meet in a merge. It keeps
`linguist-generated` for the fold.

## Migration

Nothing is rewritten at any step. The legacy files stay as they were committed,
so the history of every record stays where it is.

1. **Release N: readers first, writers sharded.** Writers mint sealed shards.
   Readers learn the 0x1e separator now (`storeLines` and the other line
   splitters) but nothing writes it yet. Old releases still read every record,
   because a shard is a `*.jsonl` of whole lines. An old release still running a
   session appends to that session's legacy file. That case is the only one in
   which the old conflict can recur, and `merge=union` keeps it clean locally.
   Since a session runs on one host, a mixed team meets it only for sessions an
   old release wrote.
2. **Release N+1, at the owner's choice: packed shards.** Writers lead each
   record with 0x1e and write no newline, so a shard is one line. Release N
   reads them already. Releases before N report each packed shard as one
   damaged line until they upgrade (d-d5b49709). If the owner would rather
   never have that window, step 2 is left out and the line counts stay where
   they are (2.4% of additions).
3. **Not done: merging main into a branch before it lands** (d-44ee2214) stops
   being necessary for records once the release is in use. Pull requests from
   forks merge on GitHub with no local step.

## What changes in the specs

- **Journal**, the compression line ("one append-only file per session")
  becomes "append-only files per session, a new one for each commit a checkout
  writes from". **append-only store** holds per file, and gains a clause with
  its own refutation: *a committed shard is never appended again; a writer
  whose HEAD, branch or shard size moved starts a new shard.* Its
  totality oracle appends, commits, appends, and checks that the committed
  file's bytes are unchanged. Breaking the reuse rule to ignore HEAD must turn it red.
- **Lifecycle**, **record stores merge by union** becomes **record stores merge
  with no driver**. Two checkouts of one session, on parallel and on stacked
  branches, landed by merge, squash and rebase in a repository with no
  attributes file, conflict nowhere, and every record of both loads. That is
  `bench/records/layouts.ts`'s merge matrix as a test, and replacing the seal
  rule with the branch-only rule must turn it red. The union bullet stays,
  scoped to the legacy session files.
- **record readers tolerate what a union merge keeps** stays as it is, and
  gains the 0x1e separator in release N: a torn packed record is one damaged
  segment, and the record after it reads whole.
- **the record stores are named once** is unchanged: the folders are the same,
  and the shard rule lives in `stores.ts` beside them.
- **a citation reaches another branch** is unchanged for shards. Release N's
  citation search splits a grep hit on 0x1e before matching an id.

## Reproducing

```
node bench/records/layouts.ts            # about a minute; writes bench/records/results.json
node bench/records/github-counts.ts --pr 121 --history 30   # needs gh; writes bench/records/github-counts.json
```

`layouts.ts` reads this checkout's stores and builds every layout and
repository in a temporary folder that it removes (`--keep` keeps it). It writes
nothing under `.coherence`. The shard and packed layouts of the existing
history are cut at the commits that first added each line, which is what
sealing at each commit would have written.
