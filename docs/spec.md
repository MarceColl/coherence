# The spec

A component is any folder with a spec file, `<Name>.spec.md`. Folders without
one are transparent; a super folder becomes a component when a relationship
invariant about its children needs a home. The spec holds a title, a one-line
intent, `## trust levels` in the entry spec only, `## entrances`, and
`## invariants`. No other section: the parser refuses the reference's sections
by name and says what replaced each.

The header may also declare who owns the component, on one line beside the
intent:

```markdown
# Notebooks

The notebooks product: documents that mix queries and prose.
owners: team-notebooks, @ana
```

The owners are comma separated and declared, never routed on. The spec
reading (`spec --check`), Scope's component card and `query component` show
them. An empty `owners:` line or a second one is a problem.

## The model line

The header may also name the component's quint model, the executable
description of its behavior as guarded actions over pure updates, or say why
it has none:

```markdown
# Journal

The journal: decisions, defects and work orders, appended and never edited.
model: Journal.qnt
```

The line takes one of three values:

- `model: <file>.qnt`: the model, beside the spec or under its folder. A file
  that does not exist, or a path that climbs out of the component, is a
  problem. A `via: quint prop <property>` bullet checks a property of it, and
  `conform` replays the component's tests through it.
- `model: none — <why>`: a model makes no sense here, and the reason says
  why: a reading with no state, a function of its input with no state that changes.
- `model: planned — <what>`: a model makes sense and is not written yet; the
  text says what it will describe, so "not built" never reads as "makes no
  sense".

`none` or `planned` without its text, a value that is none of the three, an
empty line or a second one is a problem. A project whose config sets
`"models": true` asks every spec for the line, and a spec without one is a
problem. Without it, a project that names a model anywhere hears which specs
name none as a `COVERAGE` advisory, and a project that names none hears
nothing.

## Entrances

An entrance is where work enters the system from outside it: a command, a host
event, a route, a tool. The component that receives it declares it, one bullet
each, with a one-line meaning and the handler that receives the work:

```markdown
## entrances
- run: an agent verifies the invariants and appends the run record
  handler: runCommand in src/enforcement/cli.ts
- SessionStart: the agent host starts a session
  handler: runHook in hook.ts
```

The handler is a symbol, or a symbol in a file read relative to the
component's folder and then to the root. The model checks that some file
declares it at its top level; a handler it cannot find is a spec problem, so a
declared entrance cannot rot unseen. Structure resolves the handler again
through the language adapter and starts the entrance's flow at the component
that holds the handler; when that is not the declaring component (the root
dispatcher declares each command family, and the family's handler lives where
the work is done), the component interface from the declaring component must
carry the handler, or the entrance is shown as unreachable.

```sh
node src/cli.ts spec --check [root]   # components, invariants with state, problems; exit 1 on problems
node src/cli.ts spec --json [root]    # the model
node src/cli.ts scaffold component <folder> "<intent>"
node src/cli.ts scaffold invariant <folder> "<sentence>" --kinds a,b [--chokepoint|--totality-oracle] [--crossing "a -> b"] [--preview] [--write]
node src/cli.ts scaffold control "<entrance>" | --all [--component <folder>] [--whole] [--write]
node src/cli.ts scaffold control --baseline --session <id> --agent <name>
```

`scaffold control` proposes the closure for an entrance with no traced
control: an `entrances:` line naming it on a verified invariant that covered
it by its crossing alone (see "Which entrances an invariant covers"), a
`guard:` line, an invariant whose `entrances:` line names it, or
`control: none`. It proposes from
the recorded Structure reading while that reading still describes the tree.
When no recorded reading does, and the request names entrances (`"<entrance>"`,
or `--all --component <folder>` for every entrance that component declares),
it reads only what their routes need. It resolves those handlers and the
handlers of every entrance declared beside them, since only those can share
their route. It follows their reach as the whole reading does, and reads the
interfaces of a component only when a route enters it. A component no route
enters is never asked about. The output says the reading was scoped and names
the components it read. A scoped reading is never recorded, because orient
and Stop read their gaps from a whole one.

The scoped reading stands only when the facts the route rule needs beyond the
routes themselves are settled for every tree the unread interfaces allow.
Those facts are whether a component is a core dependency and which column it
stands in. When they are not settled, the command reads whole. `--all` alone,
`--baseline` and `--whole` always read every component interface and record
the reading. The interface budget flags apply to either reading.

### Drafting from declared boundaries

A repository that already declares its module boundaries by machine gets its
specs drafted from that declaration rather than transcribed:

```sh
node src/cli.ts scaffold import tach [<module>...] | --all [--write]
```

It reads the nearest `tach.toml` at or above the project root. Each
`[[modules]]` entry becomes a component, the folder its dotted path names under
a source root, and its draft carries:

- an intent line holding a placeholder for what the module is for, the `name`
  of a `product.yaml` in its folder, and where tach.toml declares it; and the
  `owners` of that `product.yaml` on the header's `owners:` line.
- for `depends_on`, a totality oracle bullet listing the declared modules.
  Reliance stays computed, never declared.
- for each `[[interfaces]]` entry whose `from` pattern matches the module, a
  totality oracle bullet listing everything it exposes, and one chokepoint bullet
  per exposed path. That path is the chokepoint when it names a package folder,
  a module file or a symbol in its file on disk. Otherwise it is a placeholder
  showing the pattern. Each carries `from: outside the component`, because
  tach checks only imports from other modules.

The protected internal, `because:`, `crossing:` and `kinds:` stay
placeholders. The totality oracle bullets name pytest functions (`via:
test_tach_dependencies_<module>`, `test_tach_interface_<module>`). The command
prints those on stderr: tach has no per-module flag, so they run `tach check
--dependencies --interfaces --output json` once and keep one module's
diagnostics.

The command cannot express everything tach does:

- One chokepoint bullet names one site, whereas tach lets a module expose
  several at once. The totality oracle bullet carries the union.
- Patterns that name no single path, `layer`, `utility` and `visibility` have
  no slot. They are printed as notes.

Drafts print by default. `--write` creates a spec only in a folder that exists
and holds none, and it reports every module it skipped. It never overwrites a
spec. A malformed `tach.toml` is refused with its line, and so is a module it
does not declare, and nothing is drafted. Each source is named for the tool
whose file it reads, so others can follow.

## The bullet

Every bullet is an invariant. Its first line is the name and the sentence,
the abstract behavioral requirement; indented `key: value` lines carry the
rest. A value still in `<angle brackets>` is a placeholder: it parses, counts
as absent, and is listed as unfilled, so a scaffolded bullet can be written
first and filled second.

`--preview` requires a declared `--crossing "<level> -> <level>"`. It builds a
self-contained Scope page in a private system temporary directory, opens on
Structure, and adds the proposed crossing as a dashed, unverified edge. The
command prints the generated page path. The proposal is not run evidence: it
has no grade, lifecycle state, verdict, or reliance sites, and it does not
change the component spec. Add `--write` explicitly to append the same
scaffolded bullet, including the crossing, after preview validation succeeds.
`--kinds` and `--chokepoint` or `--totality-oracle` keep their ordinary
scaffold meanings; when omitted, the existing placeholder/default behavior
is unchanged.

Enforcement takes one of two forms, and a bullet may carry both as separate
evidence paths. The chokepoint form names the protected thing (a symbol or a
module) and the chokepoint every reference passes through:

```markdown
## trust levels
- storage: the rows beneath everything
- public-egress: what leaves in the clear

## invariants
- digest-only egress: A secret leaves storage only as its digest.
  protects: SECRET_COLUMNS
  chokepoint: seal
  because: a read of a leaked row must disclose no usable bearer
  crossing: storage -> public-egress
  refuted: removed the seal call from the row renderer -> the check went red naming the column (2026-09-17)
  kinds: credential, output
  checklist: redaction declared as digest-only egress
  checklist: encrypted-storage dismissed: the digest is the stored form; nothing is decrypted
```

The totality oracle form, the compromise where structure is not practical,
names the whole set the detector is total over and the test:

```markdown
- write-class totality: Every kernel pattern resolves to a declared write class.
  over: every pattern in KERNEL_TABLES
  via: write-policy totality
  because: an unclassified pattern must fail closed rather than become writable
  crossing: agent-mcp -> storage
  refuted: unclassified _members -> write-policy totality failed by name (2026-08-20)
  kinds: storage
  checklist: scoped-reads dismissed: reads are the capability invariant's
```

### Which references a chokepoint governs

By default a chokepoint governs every reference to the protected thing: any
reference outside the chokepoint, tests aside, is a bypass. That is right for a
narrow invariant ("the secret is read only through `seal`"). It is wrong for a
module boundary, where outside code may reach a module's internals only
through its facade but the module's own code uses them freely. A `from:` line
says which references the chokepoint governs:

```markdown
- internals only through the facade: Code outside the notebooks reaches their rows only through the facade.
  protects: NOTEBOOK_ROWS
  chokepoint: products/notebooks/backend/facade/
  from: outside the component
```

- `from: anywhere`, the default, governs every reference.
- `from: outside the component` governs only references from outside the
  folder of the component whose spec holds the bullet.
- `from: outside <folder>` governs only references from outside that
  project-relative folder.

A reference from inside the exempted folder is classed `exempt`. It is reported
and counted, never dropped and never a bypass. A re-export there is still a
bypass, because it widens the thing's reach. Without a `from:` line, the
config's `chokepointFrom` applies, and with neither, `anywhere`. The run
records which value governed and who said it: the bullet, the config, or the
default. The grade's reason, the `run` output, Scope's enforcement and sites,
and `query relies-on` all show it, so the component's own references read as
exempted rather than absent. Under a `from:` line that exempts a folder, the
automatic refutation also stages a use of the protected thing from an unsaved
document outside that folder. The check must call it a bypass. Any other value
is a problem, and so is a `from:` on a bullet with no chokepoint form.

`because` says why the invariant exists and what it protects against.
`crossing` is the security marker: two trust levels the entry spec declares.
`entrances` names the entrances whose work the invariant checks; see below.
`refuted` is the human account of a witnessed firing: what was broken, what
was seen, the date. It is an account, not the evidence. A chokepoint form is
refuted by the run itself; a totality oracle form is refuted by running
`refute <component>/<name> --broke "…"` while the break is staged, which
requires the totality oracle to fail and appends a refutation record to the
run store, and the refutation counts only once a later run finds that same
totality oracle passing again. Refutation is required per enforcement, so a bullet carrying both
forms needs both.

### Which entrances an invariant covers

A crossing says which trust an invariant checks, never where that trust
enters. An entrance carrying a level from outside the system's control needs
a control traced on its route, or Structure marks it `no traced control`.
A chokepoint is traced: it counts where the reading sees the handler pass it
(a `guard:` line on the entrance declares one the reading cannot see). A
totality oracle is a test, and nothing traces a test to a handler, so an
invariant enforced by one alone names the entrances it covers:

```markdown
- signed apple notifications: An Apple account notification changes an account only when its payload verifies against Apple's signing key for this app.
  over: the notification payloads appleNotificationResponse receives, signed by the expected key and by an unrelated one
  via: rejects unsigned notifications and acknowledges email relay changes
  because: a verified account-delete event deletes the player's account; an unsigned or foreign payload must change nothing
  crossing: visitor -> account store
  entrances: route api/apple-notifications
```

Once the invariant is verified, its test is a control on each entrance it
names, and on no other. That holds even where its crossing matches another
entrance's trust, or the invariant lives in the component that declares or
handles that entrance. The sign-in route and the crawler file beside the
notification route stay uncontrolled until something checks them. Entrances
named by different invariants never share a route, so a control named for
some of a route's entrances counts for those it names. `entrances: none` says
the invariant checks no entrance.

The names are comma separated. Each one resolves in the invariant's own spec,
then in the one spec that declares it; when several do, write
`<name> in <folder>`. A name no spec declares is a problem. So is a named
entrance whose declared trust the crossing neither enters from nor enters,
`none` beside a name, a name given twice, an `entrances:` line on a chokepoint
form (its entrances are traced), and one on a bullet with no `crossing:`.

Before this line existed, such an invariant counted on every entrance its
component declared or handled whose trust its crossing matched, so one
signature check stood for every public route in its folder. That credit is
gone. For each entrance carrying outside trust in that a verified invariant
covered this way, `spec --check` prints a `COVERAGE` line after the counts
(advisory, never a problem), orient's spec gap line counts the gaps it
opened, and `scaffold control "<entrance>"` proposes the `entrances:` line
first and writes it with `--write`. Name the entrances the test really
checks, or write `entrances: none`, and the advisory ends.

A chokepoint's grade names who refuses a bypass. In a Python project, a
checker the project runs earns `checker-choked`: Pyright's reportPrivateUsage
as an error over an underscore-prefixed name, an import-linter rule naming the
protected module, or tach. tach governs when the nearest `tach.toml` at or
above the project root declares a module holding both the protected thing and
the chokepoint, and an `[[interfaces]]` table from that module, carrying no
`visibility` list, whose `expose` patterns cover the chokepoint and cover
neither the protected thing nor a package above it. tach matches `from` and
`expose` as whole regular expressions; an interface with a `visibility` list
constrains only the modules it lists, `utility` never widens an interface,
and a module carrying the deprecated `strict` alone is not read as governed.
The enforcer is `tach (tach.toml)` and the interface is the fact. Where tach
governs, the module's own code is free to use its internals, so a reference
there is inside; every import tach refused that reaches the protected thing
is a bypass, with tach's error beside it; a re-export stays a bypass by its
form. The refutation stages an outside import in another module of a
throwaway copy of the tree, runs tach over it and reads its refusal back,
recorded as `refused by the checker`, and the copy is removed. tach runs
whole at `run` and whenever a chokepoint is checked; at an edit it runs only
over the Python files the edit wrote that lie in a tach module, in a throwaway
copy, and an edit outside every tach module spawns nothing. Without tach
installed the rung is not available and the grade says why; without a
`tach.toml` nothing changes. Pyright's references still run for what tach
cannot see: an import under `TYPE_CHECKING`, a `# tach-ignore` line, a file in
no module, a name reached as an attribute of a package another file imported.

## Lifecycle states

The check derives each bullet's state from what it carries:

- **requirement**: enforcement is absent, or an enforcement's refutation has
  not been witnessed, or the decomposition checklist has an applicable shape
  neither declared nor dismissed. A missing `kinds` line means the checklist
  was never run. A requirement whose check is failing stays a requirement and
  is reported with its failing check, never promoted.
- **invariant**: enforcement is declared, every enforcement's refutation is
  witnessed, and every applicable shape is answered.
- **structural defect**: an invariant whose satisfaction has been removed —
  the bullet is otherwise complete and the latest run found a bypass, an
  unresolvable chokepoint, or a failing totality oracle.

With no run and no refutation record, every enforcement reports as declared,
unverified and every bullet is a requirement: nothing in the tree has been
seen to fire. A missing `because` is reported as a lack but does not change
the state.

### The invariant floor

An invariant is not demoted silently (df-f3826eaa: a bullet inserted between
an invariant and its `checklist:` lines took them, and the check stayed
clean). Each run entry records the state the run left its bullet in, and
what its form enforces through (its `via:` test titles or its chokepoints).
The latest entry that graded a bullet an invariant is its floor; an entry
from before the state was recorded counts when it passed with a witnessed
refutation. A bullet with a floor is a problem when it is now:

- missing: it lost the bullet itself;
- a requirement: it lost its enforcement, refutation, kinds or checklist;
- without an enforcement form it was graded with.

The problem names the bullet, what it lost, and the command that clears it:

```sh
node src/cli.ts decide "demote <component>/<name>: <retired, the code changed, or moved to where>" --because "<why>"
```

The decision must be recorded at or after the floor, and name the bullet as
`<component>/<name>` in what it chose or what it turned away (`--over`, where
a name the lexicon has since rejected may still be quoted). A run of the
demoted bullet grades it a requirement and leaves the floor where it was, so
the decision keeps clearing it. If the bullet is promoted again and then
demoted, the floor moves and a new decision is needed.

A rename or a move needs no decision when the bullet it became carries an
enforcement the floor recorded: the same `via:` test title, or the same
chokepoint, in the same form. That bullet must lack nothing but its
refutation, which the run store keys by name, so a rename costs it until the
next run or `refute`. A floor recorded before enforcements were recorded
names none, so its rename needs the decision. A bullet that no run graded an
invariant is free to change.

The reference point is the run store, never git: it is already read by every
check, it is committed, and in CI `HEAD` is the commit under review, so a
comparison with it would compare a change with itself.

## Coherence's own spec

Coherence carries its own spec in this grammar. `Coherence.spec.md` at the root
is the entry spec: it declares the five trust levels (project-source, harness,
record, reading, instrument) and the project-wide invariants. One component
spec sits in each real unit under `src/`: journal, lifecycle, spec, scaffold,
enforcement, adapters, and readings/scope. Every bullet is a rule the tests
already settle: its totality oracle is a real test title, and where the
structure holds, its chokepoint names a real protected symbol and the one site
that reaches it, so `run` grades it and refutes it. `npm test` runs the
typecheck, the tests, the vocabulary check, and `spec --check`, so the tree
cannot go green with a spec problem.

## The checklist rule

`kinds` names what the requirement protects (read, credential, storage,
message, output, state, queue, budget, deploy, identity, encoding, revision;
or `none` for an examined empty set). Each shape in `docs/checklist-seed.json`
carries its kinds; the shapes whose kinds intersect are applicable, and each
needs one line: `<shape> declared as <invariant name>` (the bullet itself may
be that invariant) or `<shape> dismissed: <reason>`. The scaffold prints one
placeholder line per applicable shape with the shapes' sentences beside it.

## Practices

A spec may have a sister: the practice file beside it, with the spec's stem
(`Enforcement.practice.md` beside `Enforcement.spec.md`). It holds the
component's methods, one bullet each, in the same grammar, with no headings:

```markdown
- oil the knob: A knob is oiled before it turns.
  when: command turn-knob | edit src/widget/**/*.ts adding knob | explicit
  step: wipe the knob
  step: oil the knob
    leaves: an oil record
  pitfall: a dry knob seized (d-1a2b3c4d)
  learned: d-1a2b3c4d, 3f2e1d0
  invariants: knob turns
  because: a dry knob seizes
```

`when:` names what fires the practice: a command's words, an edited path's
glob with the text the edit adds, or `explicit`. A command's words are
adjacent whole words of one simple command, never text inside a quoted
argument or a heredoc's body; a word with `*` or `?` is a glob over one word,
so `command resolved df-*` fires when `resolved` is followed at once by an
argument starting `df-`, and not when a conjecture is resolved. A shell command that writes a file
(a redirect, a heredoc, `tee`, `sed -i`, `cp`) counts as an edit of that file, and
its own text as the text added. Steps are numbered in the
order written; `leaves:` under a step names the evidence it leaves. A
`leaves:` line belongs to the step above it whatever its indentation: the
four spaces shown here, the two a formatter such as oxfmt writes back, or a
tab all parse alike, since the parser reads key lines in order and never
measures their indent. Every
pitfall cites the record or commit that witnessed it, and a practice that
cites nothing is a problem. `invariants:` names invariants of the sister spec,
or `<folder>/<name>` elsewhere. A practice file never stands without its spec.

The hook delivers a practice whole when a tool use is about to fire it; a
session records it carried out with `coherence enact "<practice>" --step
<n>=done[:<evidence>]|deviated:<why>|skipped:<why>` for every step. Once
enacted, a step or pitfall leaves the practice only with a decision citing an
enactment. `coherence scaffold practice <folder> "<name>" "<sentence>"`
prints the shape; `coherence query practice` lists every practice.
