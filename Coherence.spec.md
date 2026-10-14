# Coherence

A prosthetic for proprioception: specs, invariants, and the readings that keep an agent session balanced.
model: none — the entry spec declares trust levels and the crossings between them; it owns no state that changes

## trust levels
- project-source: Agent-authored text: the adopter's code, specs, docs, and what an agent passes the command line. Never trusted about itself; every claim in it is checked against the code, never taken from it.
- harness: What a host sends the hook on stdin: the event, its session id, and its agent type. The caller Coherence answers, never a writer of the record.
- record: The durable files under .coherence a later session reads back: journal records and runs. Attributed and append-only, or worthless.
- reading: What leaves Coherence for an agent or a human: the injected context, a check's report, a run's printed form, the Scope page. Derived from the model and never stored as truth.
- instrument: The far side of a process boundary: the language server the adapter drives, the warm server that holds it open, and the test runner the totality oracle pass spawns. Only replies cross, and a reply the instrument cannot confirm is a vacuous check, never a pass.
- local-caller (outside): What a browser page or another local process sends the warm server's HTTP port. Any page the user visits can aim a request at loopback, so nothing about the caller is known until the guard admits it.

## entrances
- journal verbs: an agent records a decision, conjecture, defect, experiment, unable, or escalation, or reads the journal
  handler: journalVerbs in src/journal/cli.ts
  trust: project-source
- work: an agent creates, moves, owns, closes, or inspects a work order, through the journal's verb table
  handler: journalVerbs in src/journal/cli.ts
  trust: project-source
- spec: an agent reads the components, invariants with their state, and every spec problem
  handler: specCommand in src/spec/cli.ts
  trust: project-source
- scaffold: an agent writes a component or an invariant bullet in the complete shape
  handler: scaffoldCommand in src/scaffold/cli.ts
  trust: project-source
- run: an agent verifies the invariants and appends the run record
  handler: runCommand in src/enforcement/cli.ts
  trust: project-source
- refute: an agent stages a break and records the totality oracle going red
  handler: refuteCommand in src/enforcement/cli.ts
  trust: project-source
- serve: the warm language server for this project starts and holds the instrument open
  handler: serveCommand in src/enforcement/cli.ts
  trust: project-source
- economy: an agent asks what must be loaded to change these files safely
  handler: economyCommand in src/economy/cli.ts
  trust: project-source
- calibrate: an agent compares the economy prediction with what sessions actually read
  handler: calibrateCommand in src/economy/cli.ts
  trust: project-source
- mass: an agent reads total and unreached mass per component
  handler: massCommand in src/economy/cli.ts
  trust: project-source
- query: an agent asks one of the fixed questions Scope answers for a human
  handler: queryCommand in src/readings/query/cli.ts
  trust: project-source
- lexicon: an agent reads, reviews, or maintains the settled vocabulary, or checks text against it
  handler: lexiconCommand in src/cli.ts
  trust: project-source
- hooks install: a human installs, removes, checks, or inspects Coherence's hooks for an agent host
  handler: hooksCommand in src/cli.ts
  trust: project-source
- ci install: a human or an agent prints or writes the workflow that runs Coherence on every pull request
  handler: ciInstallCommand in src/lifecycle/ci.ts
  trust: project-source
- ci report: the CI host's job builds the pull request report from the CI session's run
  handler: ciReportCommand in src/lifecycle/ci-report.ts
  trust: project-source
- build: a maintainer, or npm as prepare, compiles the published package from src into dist
  handler: src/build.ts
  trust: project-source

## invariants
- commands act on the project root: A command run from any folder inside a project acts on that project: the nearest folder up to the top of its git checkout that holds coherence.config.json, else the nearest that holds .coherence, else the folder it ran in; a write from a subfolder never makes a second store there.
  over: a journal write run from a folder two levels below a project's root, in a git checkout
  via: the command line acts on the project from any subfolder, and vets a record against the project's rejected names
  because: a subagent ran a journal verb from src/ and its records landed in src/.coherence, where no reader looks (df-30b500ca)
  crossing: project-source -> record
  kinds: none
- grammar carries no rejected name: A spec written in Coherence's grammar with every shape name carries no rejected name.
  over: every key of the grammar, every shape of the checklist seed, and every rejected name of Coherence's lexicon
  via: a spec written in the grammar with every shape name carries no rejected name
  because: the grammar, the seed, and the lexicon are three files that can drift apart; if a key or a shape were spelled with a name the lexicon refuses, every honest spec would fail the vocabulary check and the agent would learn to route around the check instead of fixing the spec
  crossing: project-source -> reading
  refuted: renamed a checklist shape to a name the lexicon rejects for invariant -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: none
- a structural defect was an invariant: A failing verdict in the latest run makes a bullet a structural defect only when the bullet was otherwise complete; a requirement with a failing check stays a requirement and is reported with its failing check, never promoted, and an automatic refutation satisfies a chokepoint enforcement's refutation.
  over: every bullet with an entry in the latest run that checked it
  via: a structural defect is an invariant whose satisfaction has been removed; a requirement with a failing check stays a requirement
  because: the lexicon defines a structural defect as an invariant whose satisfaction has been removed, and a bullet that never reached invariant has no satisfaction to remove; calling it one both overstates what the tree had and hides the ordinary case, a requirement whose detector is red because the work is not done. A bullet still shown as an invariant after its chokepoint broke is the other half of the same failure, and an automatic refutation counts because the check itself proved it would report the break
  crossing: record -> reading
  refuted: let a failing verdict force the structural defect state whatever else the bullet lacked -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: none
