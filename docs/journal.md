# The journal

The journal is compression. A session may burn millions of tokens; what it
leaves behind is a handful of durable outcomes: what was decided and rejected,
what surprised the agent, what failed, what a plan predicted, where the agent
hit a wall, what a human must see. It is also how subagents compare notes
(the peer feed) and how an agent reaches the human.

## Verbs

Every writing verb takes `--session <id>` and `--agent <name>`, refused when
absent. A single-value flag given twice is refused.

- `decide "<chose>" [--over "<rejected>"]... --because "<why>" [--human "<what the human said>"] [--cite <id>]...`
- `retract <id> --because "<what refuted it>"`: points at a record; nothing is edited.
- `conjecture "<observation>" [--could-be "<candidate>"]... --discriminated-by "<test>" [--cite <id>]...`: "the instrument is wrong" is always a candidate.
- `resolved <id> --because "<what the test showed>" [--as "<candidate>"]`: resolves a conjecture.
- `resolved <defect-id> --because "<what fixed it>" [--guard <component folder>/<invariant>] [--decision <id>]`: closes a defect (see Defects below).
- `dismiss <id> --because "<why nobody will chase it>"`
- `defect "<what failed>" --evidence "<reproducer or report>" [--file <path>]... [--class <name>] [--introduced <commit|PR #n|pre-existing|unknown>] [--caught <review|ci|probe|adopter|self|test>] [--cite <id>]...`
- `classify <defect-id> [--class <name>] [--introduced <...>] [--caught <...>] --because "<the evidence>"`: a decision citing the defect that gives the fields it lacked.
- `experiment create "<expectation>" [--context <file>]... --action "<step>"... --success "<criterion>"... [--cite <id>]...`: prints step ids.
- `experiment close <id> --result <stepId>=<pass|fail|unknown>...`: every step needs a result; the outcome is derived.
- `unable "<what you could not do>" --because "<the wall>" [--cite <id>]...`
- `escalate "<what a human must see>" --because "<why a human>" [--human "<what the human said>"] [--cite <id>]...`: heads every read until acknowledged; orient names each record it cites.
- `acknowledge <id> --because "<what the human decided>" [--human "<what the human said>"]`

**Citations.** `--cite <id>`, repeatable, names an earlier record this one
rests on or is about: a decision it builds on, the decision or work order an
escalation is about, a defect a conjecture explains. Any kind, in either store
(journal or work). Every id must name a record that exists when the citation is
written; an unknown id, or one given twice, refuses the whole write. Citations
are untyped: the record's own text says how it relates. A record that cites
nothing carries no `cites` field, so records written before citations read
unchanged. A verb that already answers one record by `of` (retract, resolved,
dismiss, experiment close, acknowledge) takes no citation.

**Human words.** `--human` on decide, escalate and acknowledge stores words the
agent attributes to a human in a `human` field, apart from the agent's own
`because`, and every reader labels them as the agent's attribution. It records
that the agent says a human said them; it does not prove a human wrote them.
Proof of authorship is out of scope.

## Defects

A defect should buy a guard for its whole class. It carries three optional
fields, which the practice close a defect asks for:

- `class`: a short kebab-case name for the shape of the failure (path-identity,
  silent-skip, cost). Each class is declared once, as the property
  `class <name>` of the defect concept in Coherence's lexicon or the project's
  own; the verb refuses a class declared nowhere. A class too broad for one
  guard, such as audience (a reader told the wrong thing), is declared as a
  family instead (`family <name>`): each of its defects closes with its own
  guard or a decision, and a later defect in it is never a guard failure.
- `introduced`: a commit, `PR #<n>`, `pre-existing` or `unknown`. A commit or
  pull request makes the defect fix-induced.
- `caught`: review, ci, probe, adopter, self or test.

A defect recorded without them stays valid. The journal is append-only, so
`classify` gives them later as a decision citing the defect; every reader
folds the defect's own fields, then each classification not retracted, then
its close, the later field winning. A field nobody gave reads as unknown.

`resolved <defect-id>` closes a defect. The close names a guard, an invariant
whose enforcement covers the class and whose refutation is witnessed, or a
decision saying why fixing the instance suffices. `spec --check` names a close
with neither, and a defect recorded in a class a close had already guarded
is a guard failure: the guard was weaker than claimed. Both are advisory,
and orient lists each guard failure. A retracted close no longer closes, so a
defect can be closed again with its guard.

`query convergence [--days <n>] [--json]` reads whether discoveries repay over
a window (14 days by default): defects arriving by origin and catch, escapes
per release, the share closed with a guard, repeats per class, bullets at each
day and release tag, the files most often changed, and hook latency p50 and
p95 per event and Coherence version.

`query mirrors [--all] [--rev <rev>] [--json | --proposals]` is the mirror
reading: the lists kept by hand that must mirror another list, a folder or the
import closure of a list of files (the hand-list family), read from git
objects at one revision, with history naming the commit that grew one side
alone. It is advisory and never a spec problem. By default it lists only the
groups that span files, share three or more names and score 20 or more; a
list of files drifted from the import closure of its own files, with the
commit named, is listed first wherever it ranks. `--proposals` prints the
pairs it proposes for declaration, each as the list's file, line and name and
one universe recipe: `closure of files`, `keys of <file>:<name>` or
`literal at <file>:<line>`. No hook takes the reading: the session start and
the stop start one in the background, and orient names the last one kept,
labeled with its commit.

## Work orders

A work order is content, not permission: objective, observable success
criterion, boundary (what the owner may write), owner session. It grants
nothing; its value is that a reader sees everything one assignment produced.

- `work create "<objective>" --success "<criterion>" --boundary "<files>" [--owner-session <id>] [--cite <id>]...`: open, owned by the creating session unless another is named.
- `work move <id> <open|active|waiting|cancelled> --because "<why>" [--cite <id>]...`: by anyone, recorded. Waiting is the order that cannot proceed until something outside its owner happens (a dependency, a peer, a human); nothing binds to it while it waits.
- `work close <id> --because "<what was done>" [--cite <id>]...`: the only path to completed.
- `work owner <id> --owner-session <id> --because "<why>"`
- `work inspect [<id>]`: one order with its history, what its records cite, the journal records bound to it, the records citing it or its moves, and the runs bound to it; or every order.

A completed or cancelled order accepts no further write. Records live in
`.coherence/work/<session>.<token>.jsonl`, append only, with the journal's head.

**Binding is inferred.** A write by a session that owns exactly one active
order binds to it: the record carries `work` and `binding: inferred`.
`--work <id>` names another order, which must exist. A session owning none
or several binds nothing, and the record says which. The run record uses the
same inference. Orient prints the owned active order with the rule that
maintenance outside the boundary is not this session's to do; regulate
reminds that `work close` ends it.

## The peer feed

At each prompt and tool boundary the hook injects the subjects of records
other sessions wrote since this session's cursor: glyph, id, agent, subject
cut at 120 characters; twelve lines at most, then a count of the rest and the
command that shows them whole; escalations are marked. Full records are never
injected. The cursor, `.coherence/feed/<session>.cursor` (ignored by git),
starts at the latest record when a session first meets the feed and advances
only after the feed was handed to the host.

```
Peers recorded 2 since your last look (subjects only; whole records: journal --since 2026-09-17T23:40:12.118Z~d-1a2b3c4d):
◆ d-8e0f1a2b scope: Scope reads the work store through loadOrders, never the files
▲ e-3c4d5e6f economy: retire the mass diagnostic  [escalation: a human must answer]
```

## Reading

From this checkout's root, run `node src/cli.ts journal`. In an adopter, run
`node_modules/.bin/coherence journal`. SessionStart and SubagentStart supply
the command for their project alongside the decision write template.

`journal` prints the merged timeline across every session, oldest first: date,
glyph, id, agent, text; a decision shows its rejected alternatives indented.
Filters: `--session`, `--agent`, `--kind`, `--since <cursorOrIso>`; `--json`
for the records. Beneath each record the timeline prints the words it
attributes to a human, the ids it cites, and the ids of the records (either
store) that cite it; `--json` carries each record's `cites` and a `citedBy`
map for the reverse direction, derived at the read and stored nowhere.
`journal <id>` prints one journal or work record with each record it cites and
each record citing it, by id, kind and subject. `journal --subjects --since
<cursorOrIso>` prints only each record's subject and the next cursor; it never
carries citations. An unparsable line is reported with
its file and line number and skipped; the damaged count prints last.

## Record shape

Sealed shards per session at `.coherence/journal/<session>.<token>.jsonl`,
one record per line, a new shard whenever HEAD or the branch moves; a packed
shard, `.jsonseq`, holds its records on one line, each ended by U+001E
(docs/records-layout.md). A legacy `<session>.jsonl` is read as committed.
Append only. Every record carries `id`, `kind`, `at` (ISO), `session`, `agent`,
`commit` (short sha or null), `dirty`, its binding, and its kind's fields;
`cites` (a list of ids) when it cites any, and `human` when the agent recorded
a human's words. A defect may carry `class`, `introduced` and `caught`; a
defect's resolution `guard` and `decision`; a classifying decision
`classifies`. The
id is the kind's prefix plus eight hex digits hashed from session, time, and
text; work records share the minter. The branch is never stored; a read asks
git.

## The rule

A decision records what it rejected: `--over none` means nothing was
rejected; omitting `--over` means the question was never examined. Two
facts, kept apart.
