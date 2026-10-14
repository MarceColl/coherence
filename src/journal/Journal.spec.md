# Journal

Compression: one append-only file per session of attributed, durable outcomes, read back as one timeline.
model: Journal.qnt

## invariants
- a citation reaches another branch: A --cite of a record another branch has committed is accepted and printed with that branch, journal <id> shows such a record as it stands there and says where, and a citation of it names its branch; an id found neither in the stores nor on any branch is still refused.
  over: a record committed on a side branch, cited and read from the main branch, and a citation of an id no branch holds
  via: a record committed on another branch may be cited and read, and says where it is; an id found nowhere is still refused
  because: subagents on their own branches cited each other's records before those branches merged, the check refused every one, and the ids went into prose where nothing checks or links them
  crossing: record -> reading
  kinds: none
- a flag's value from a file: Every journal and lexicon flag that takes a value also takes it from a file named by its -file form, or from standard input for -, whole but for one trailing newline; a file that cannot be read is named, and only a flag the verb takes has a -file form.
  over: a because with an apostrophe, double quotes and a dollar sign read from a file, a missing file, and a -file form of a flag the verb does not take
  via: a flag's value may come from a file or standard input, so long text never meets the shell
  because: agents writing long becauses through the shell kept losing text to apostrophes, quotes and dollar signs, and rewriting the record to route around the quoting
  crossing: project-source -> record
  kinds: none
- a record is vetted before it is written: A journal or work record whose own words use a name the lexicon rejects where it binds is refused before anything reaches the store, naming each name and what it was rejected for; a name a decision's over turns away is the record doing its job and passes.
  protects: appendWork
  chokepoint: writeWork
  over: a decision and a work order carrying a rejected name, and a decision naming the same name in its over, through the verb table and through the command line
  via: a record the vet stands against is refused before anything is written
  because: the store is append-only, so a rejected name found after a write costs a retraction and a second record; one session paid that twice, for a word the lexicon had refused all along; a work record reaches its store only through writeWork, which vets first, as a journal record reaches it only through write
  crossing: project-source -> record
  kinds: none
- append-only store: A journal file is only appended: a second write never changes the first line, and no path rewrites or deletes a record.
  protects: journalDir
  chokepoint: src/journal/store.ts
  over: every session file under .coherence/journal
  via: append only: a second write never changes the first line
  because: a record a later session reads back is worth reading only if no earlier record could have been edited; the verbs that answer a record point at it instead, and the one module that knows where the journal lives exposes an append and a read, nothing that rewrites
  crossing: project-source -> record
  refuted: replaced the append in appendRecord with a whole-file write -> "append only: a second write never changes the first line" went red in journal.test.ts; restored, green (2026-09-17)
  kinds: storage, revision
  checklist: scoped-reads dismissed: every reader sees every session; filters narrow the view, not the population
  checklist: encrypted-storage dismissed: the journal is plain text by design; a human reads it with cat
  checklist: key-rotation-compatibility dismissed: no key exists
  checklist: input-validation declared as attributed writes
  checklist: revision-preservation declared as append-only store
  checklist: commit-ordered-effects dismissed: a write has no external effect; the file is the effect
  checklist: durable-dispatch-intent dismissed: nothing is dispatched after the append
  checklist: declared-target-coverage dismissed: one folder, one file per session; no fan-out
  checklist: completion-evidence dismissed: the append is complete when the call returns; there is no later observer
- attributed writes: Every journal write carries a session and an agent, refused when either is absent, and a flag that takes one value is refused when given twice.
  protects: appendRecord
  chokepoint: write in verbs.ts
  over: every writing verb: decide, retract, conjecture, resolved, dismiss, defect, experiment, unable, escalate, acknowledge
  via: repeated singleton flags and missing attribution are refused
  because: the session is the key everything binds through and the agent is the readable name; a record without them cannot be placed in a timeline or bound to a work order, so the one function that appends takes a head built from an attribution that refuses when either is missing
  crossing: project-source -> record
  refuted: made a missing --agent default to "unknown" in attribution -> "repeated singleton flags and missing attribution are refused" went red in journal.test.ts; restored, green (2026-09-17)
  kinds: identity
  checklist: capability-authorization dismissed: attribution names the writer; it grants nothing and no permission is checked
  checklist: canonical-encoding dismissed: a session id is stored as given, and it must already be a file-safe token
  checklist: identity-continuity dismissed: a record is written once and its session never changes
- escalation heads every read: An escalation nobody has acknowledged heads every read of the journal until a human acknowledges it.
  over: every reader of the journal: the timeline, the subjects feed, and the JSON envelope
  via: an escalation heads every read until it is acknowledged
  because: an escalation is the one record that exists for a human; a read that could bury it under later records would let a session act past a question a human has not answered
  crossing: record -> reading
  refuted: dropped the escalation heading from renderTimeline -> "an escalation heads every read until it is acknowledged" went red in journal.test.ts; restored, green (2026-09-17)
  kinds: read
  checklist: scoped-reads dismissed: every reader sees every open escalation; there is no scope to narrow
  checklist: redaction dismissed: an escalation is shown whole and never shortened, since a human must see it
- damaged lines reported: A line that will not parse is reported with its file and line number and skipped, never silently dropped.
  over: every line of every session file under .coherence/journal
  via: a damaged line is reported with its file and line number, skipped, and counted
  because: a crashed write leaves a partial last line; a reader that dropped it silently would present a record as whole when it is not, and the count printed last is how a reader knows the timeline is complete
  crossing: record -> reading
  refuted: removed the damaged push in loadJournal so a bad line was skipped silently -> "a damaged line is reported with its file and line number, skipped, and counted" went red in journal.test.ts; restored, green (2026-09-17)
  kinds: read
  checklist: scoped-reads dismissed: the report covers every file; there is no scope
  checklist: redaction dismissed: the damaged line's file and number are shown, not hidden
- pointing never edits: A record that answers an earlier one points at it by id; nothing on disk is edited, and a second answer is refused.
  over: every verb that answers an earlier record: retract, resolved, dismiss, experiment close, acknowledge
  via: retract points at the record and never edits it
  because: an edit would make the record lie about what a session knew at the time; a pointer keeps both the claim and its answer, and the timeline folds the answer onto the record at read time
  crossing: project-source -> record
  refuted: removed the refusal of a second retraction of the same record -> "retract points at the record and never edits it" went red in journal.test.ts; restored, green (2026-09-17)
  kinds: revision
  checklist: revision-preservation declared as append-only store
- one id minter: A record id is minted in one place from session, time, and text, so two writers never collide.
  protects: recordId
  chokepoint: head in verbs.ts
  over: every kind of record, across sessions and across times
  via: ids are unique across sessions and across times for the same text
  because: an answer points at a record by id, so two writers minting the same id would let a retraction land on the wrong record; hashing session, time, and text in one place makes a collision the same record written twice in one millisecond
  crossing: project-source -> record
  refuted: hashed the text alone in recordId, dropping session and time -> "ids are unique across sessions and across times for the same text" went red in journal.test.ts; restored, green (2026-09-17)
  kinds: identity
  checklist: capability-authorization dismissed: an id names a record; it authorizes nothing
  checklist: canonical-encoding declared as one id minter
  checklist: identity-continuity dismissed: a record's id never changes after the write
- binding inferred from sole ownership: A journal write binds to the one active work order its session owns; --work names another order, which must exist; a session owning none or several binds nothing, and the record says why.
  over: every writing verb, every session, every state of the work store
  via: a write binds to the one active order its session owns; none or several bind nothing and say so; --work names another
  because: the reference bound 6 of 361 decisions from owning sessions, since binding was a flag no template printed; a default settled at the one append site forms the picture the owner wants without anyone remembering a flag, and a record that binds nothing says so rather than looking bound
  crossing: project-source -> record
  refuted: made workBinding answer none for a session owning one active order -> "a write binds to the one active order its session owns; none or several bind nothing and say so; --work names another" went red in journal.test.ts; restored, green (2026-09-17)
  kinds: identity
  checklist: capability-authorization dismissed: a binding names the order a record belongs to; it grants nothing and no permission is checked
  checklist: canonical-encoding dismissed: the order id is stored as minted; there is no second spelling
  checklist: identity-continuity dismissed: a binding is settled once at the append and never changes; an order that changes owner later leaves earlier records bound as they were
- terminal orders never move: A completed or cancelled work order accepts no move, close, or owner change, and completed is written by close alone.
  over: every work verb that writes about an existing order: move, close, owner
  via: work orders: create, move, close, owner, inspect; terminal orders do not move and completed is close's alone
  because: an order's end is the reader's fixed point for everything bound to it; a record after the end would file work under a closed assignment, and a second path to completed would leave a reader two record kinds to search for how an order ended
  crossing: project-source -> record
  refuted: removed the terminal refusal from close -> "work orders: create, move, close, owner, inspect; terminal orders do not move and completed is close's alone" went red in journal.test.ts at "a completed order does not close again"; restored, green (2026-09-17)
  kinds: state
  checklist: revalidated-permission dismissed: no permission is held; anyone may move an order, and the record names who
  checklist: separation-of-duties dismissed: the writer and the owner may be one session by design; an order is context, not a control
  checklist: legal-state-succession declared as terminal orders never move
  checklist: supersession-safety dismissed: a later record never replaces an earlier one; the order is the fold of all of them
  checklist: worker-fencing dismissed: no lease or fence exists; ownership is a field a reader uses to find records
  checklist: commit-ordered-effects dismissed: the append is the only effect
  checklist: resumption-coverage dismissed: nothing resumes from a checkpoint; the state is recomputed from every record at each read
- citations resolve at the write: A write that cites an id no journal or work record has is refused whole and appends nothing; a citation of a record of any kind in either store is accepted; a record that cites nothing carries no cites field, so records written before citations load and read unchanged.
  over: every verb that takes --cite: decide, conjecture, defect, experiment create, unable, escalate, work create, work move, work close; and a store holding a record written before citations existed
  via: citations resolve at the write: an unknown id refuses the write, a record of any kind in either store is accepted, and records without citations still load
  because: a relationship between records is worth reading back only if its far end exists; a decision id written into a because was never resolved, so a typo or a record from another checkout read as a link to nothing. Checking at the one site that accepts a citation (citations in verbs.ts) keeps every stored citation resolvable without editing any record, and leaving the field out when empty keeps the append-only store's old lines valid as they are
  crossing: project-source -> record
  refuted: made citations in verbs.ts accept an id no record has -> "citations resolve at the write: an unknown id refuses the write, a record of any kind in either store is accepted, and records without citations still load" went red in journal.test.ts; restored, green (2026-09-23)
  kinds: identity
  checklist: capability-authorization dismissed: a citation names a record; it grants nothing and no permission is checked
  checklist: canonical-encoding dismissed: an id is stored exactly as minted; there is no second spelling to normalize
  checklist: identity-continuity dismissed: a record's id never changes, so a citation stays resolvable for as long as the store keeps the record
- citations read both ways: Every reader that shows a record shows what it cites and what cites it, from both stores: the timeline, the JSON envelope, journal <id>, and a work order's inspection; the subjects feed stays subjects only.
  over: the timeline, journal --json, journal given one id for a journal record and for a work record, work inspect, and the subjects feed, over a store where decisions, an escalation and a work order cite one another
  via: citations read both ways: the timeline, the JSON envelope, journal <id>, and work inspect show what a record cites and what cites it
  because: the work order concept rejected typed links because nobody read one back; a citation that only its writer's record carried would repeat that. The reverse direction is derived at every read and stored nowhere, so an old record gains its citers without an edit, and the feed stays subjects only so a boundary injection does not grow with the citations
  crossing: record -> reading
  refuted: dropped the cited by line from relationLines in read.ts, so the timeline showed only what a record cites -> the totality oracle went red in journal.test.ts; restored, green (2026-09-23)
  kinds: read
  checklist: scoped-reads dismissed: every reader sees every citation; filters narrow the view, not the population
  checklist: redaction dismissed: a citation shows ids and subjects already readable in the journal
- human words kept apart: Words the agent attributes to a human are stored in their own field on a decision, an escalation or an acknowledgement, never folded into the agent's because, refused when blank, and shown labeled as the agent's attribution.
  over: decide, escalate and acknowledge with --human, a blank value, a verb that does not take it, and the timeline
  via: --human records the words an agent attributes to a human, apart from its because
  because: a because is the agent's reason; a ruling in the owner's words read as an agent's paraphrase loses its weight, and a paraphrase read as the owner's words gains weight it never had. The field records who the agent says spoke, not proof that a human wrote it; proving authorship is out of scope, and the label says so wherever the words are shown
  crossing: project-source -> record
  refuted: folded --human into the decision's because in decide instead of its own field -> the totality oracle went red in journal.test.ts; restored, green (2026-09-23)
  kinds: none
- an enactment answers every step: An enactment is refused unless every step of the practice has an outcome; a deviated or skipped step carries its because, and the record keeps the text of the steps and pitfalls it carried out.
  over: every enact write: steps missing, a skip without a because, and one complete
  via: an enactment needs an outcome for every step, a because for a deviation or a skip, and keeps the text it enacted
  because: an enactment is what a practice's integrity is read from; one that answered some steps would hide which were left out, a deviation without its reason teaches the practice nothing, and without the text enacted a later removal could not be seen
  crossing: project-source -> record
  refuted: let enact write a record with steps missing an outcome -> "an enactment needs an outcome for every step, a because for a deviation or a skip, and keeps the text it enacted" went red in practice.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: storage
  checklist: scoped-reads dismissed: every reader sees every enactment; there is no scope to narrow
  checklist: encrypted-storage dismissed: the journal is plain text by design
  checklist: key-rotation-compatibility dismissed: no key exists
  checklist: input-validation declared as an enactment answers every step
  checklist: revision-preservation declared as append-only store
  checklist: commit-ordered-effects dismissed: the append is the only effect
  checklist: durable-dispatch-intent dismissed: nothing is dispatched after the append
  checklist: declared-target-coverage dismissed: one session file, no fan-out
  checklist: completion-evidence dismissed: the append is complete when the call returns
- an enactment waits for the amendment: enact refuses a practice that has lost a step or pitfall an enactment taught until a decision amends it, naming what is gone and the decide command to record first.
  over: every enact write of a practice with an enactment: one missing a step an enactment taught, before and after the decision that amends it
  via: enact refuses a practice that has lost a step an enactment taught until a decision amends it
  because: an enactment of the edited practice used to stand in for the reason: remove a step, enact once, and the removal needed no decision (df-c2662b43); refusing the write keeps the floor from being cleared by the very record it is read from
  crossing: project-source -> record
  refuted: made the floor check in enact never true, so the edited practice was enacted with its step gone and no decision -> "enact refuses a practice that has lost a step an enactment taught until a decision amends it" went red in practice.test.ts on its own assertion; restored byte for byte, green (2026-10-06)
  kinds: storage
  checklist: scoped-reads dismissed: every reader sees every enactment; there is no scope to narrow
  checklist: encrypted-storage dismissed: the journal is plain text by design
  checklist: key-rotation-compatibility dismissed: no key exists
  checklist: input-validation declared as an enactment answers every step
  checklist: revision-preservation declared as append-only store
  checklist: commit-ordered-effects dismissed: the append is the only effect, and a refusal writes nothing
  checklist: durable-dispatch-intent dismissed: nothing is dispatched after the append
  checklist: declared-target-coverage dismissed: one session file, no fan-out
  checklist: completion-evidence dismissed: the append is complete when the call returns, or nothing is written
- a defect carries its class and origin: defect takes --class, --introduced and --caught: a class is a kebab-case name that Coherence's lexicon or the project's declares as the property class <name> of defect, introduced is a commit git holds, PR #<n>, pre-existing or unknown, and caught is review, ci, probe, adopter, self or test; anything else is refused before anything is written, and a defect without them is written and read as before.
  over: a defect with all three fields, one whose class only the project's own lexicon declares, one with none, and each field given a value outside its vocabulary
  via: a defect carries a declared class, where it came in and what caught it, and a value outside each vocabulary is refused before anything is written
  because: a defect that says only what failed cannot buy a guard for its class or say whether the work is converging; the fields are optional so every record written before them stays valid, and refused at the write because the store is append-only and a bad value could never be edited away
  crossing: project-source -> record
  refuted: made the class check refuse only when no class is declared anywhere, so an undeclared class was written -> "a defect carries a declared class, where it came in and what caught it, and a value outside each vocabulary is refused before anything is written" went red in defects.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: storage
  checklist: scoped-reads dismissed: every reader sees every defect; there is no scope to narrow
  checklist: encrypted-storage dismissed: the journal is plain text by design
  checklist: key-rotation-compatibility dismissed: no key exists
  checklist: input-validation declared as a defect carries its class and origin
  checklist: revision-preservation declared as append-only store
  checklist: commit-ordered-effects dismissed: the append is the only effect, and a refusal writes nothing
  checklist: durable-dispatch-intent dismissed: nothing is dispatched after the append
  checklist: declared-target-coverage dismissed: one session file, no fan-out
  checklist: completion-evidence dismissed: the append is complete when the call returns, or nothing is written
- a shallow clone refuses only an introduced commit it can tell is none: In a shallow clone, defect --introduced with a commit the clone does not hold is written, because its depth may have cut the commit off; it is refused only when the hash names some other object the clone holds, or more than one; the same check, in commits.ts, answers a practice's cited commit.
  over: a depth-1 clone given an older commit its depth cut off, and the hash of a file it holds
  via: a shallow clone refuses only an --introduced git can tell is no commit
  because: a hosted agent sandbox clones at depth 1, so a defect introduced by any older commit was refused as no commit, though the remote held it; the practice citation check had the same blind spot (review of PR #86), so both now ask git one way
  crossing: project-source -> record
  refuted: made missingCommits in commits.ts report nothing in a shallow clone, so a file's hash passed as a commit its depth cut off -> "a shallow clone refuses only an --introduced git can tell is no commit" went red in defects.test.ts on the file's hash; restored byte for byte, green batched and alone (2026-10-10)
  kinds: none
- a defect is classified by a later record, never edited: classify writes a decision citing the defect with the class, introduced and caught it gives, and every reader folds them oldest first: the defect's own fields, then each classification not retracted, then its close, a later field overriding an earlier one; a field no record gave stays absent and is read as unknown.
  over: a defect classified twice and once more by a retracted classification, a defect nobody classified, a classification with no field, and one of a record that is no defect
  via: classify folds into the defect without editing it: a later classification overrides, a retracted one gives nothing, and a field nobody gave stays unknown
  because: this week's defects were recorded before the fields existed, and the journal is append-only, so the only honest way to give them a class is a later record a reader folds in; a reader that guessed a missing field would report convergence the records do not show
  crossing: project-source -> record
  refuted: let a retracted classification still fold into its defect -> "classify folds into the defect without editing it: a later classification overrides, a retracted one gives nothing, and a field nobody gave stays unknown" went red in defects.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: storage
  checklist: scoped-reads dismissed: every reader sees every classification; there is no scope to narrow
  checklist: encrypted-storage dismissed: the journal is plain text by design
  checklist: key-rotation-compatibility dismissed: no key exists
  checklist: input-validation declared as a defect carries its class and origin
  checklist: revision-preservation declared as append-only store
  checklist: commit-ordered-effects dismissed: the append is the only effect, and a refusal writes nothing
  checklist: durable-dispatch-intent dismissed: nothing is dispatched after the append
  checklist: declared-target-coverage dismissed: one session file, no fan-out
  checklist: completion-evidence dismissed: the append is complete when the call returns, or nothing is written
- a defect's close names a guard or a decision: resolved closes a defect as well as a conjecture: --guard names an invariant a spec declares, as <component folder>/<name>, --decision names a decision, and either is refused when it names nothing; --as stays a conjecture's and the defect's flags are refused on one; a defect closes once, unless its close is retracted; a close with neither is written and says spec --check names it.
  over: a guard naming no bullet and no component, a decision id that is a conjecture, --as on a defect, a guard on a conjecture, a close with neither, a second close, and a close after the first was retracted
  via: resolved closes a defect with a guard a spec declares or a decision, refuses a guard or decision that names nothing, and a retracted close can be closed again
  because: each defect should buy a guard for its whole class or a recorded reason why the instance suffices; a close that named a bullet no spec has would count as protection that does not exist, and a close that could never be redone would leave a defect closed without its guard for good
  crossing: project-source -> record
  refuted: skipped the guard check in resolved, so a guard naming no invariant was written -> "resolved closes a defect with a guard a spec declares or a decision, refuses a guard or decision that names nothing, and a retracted close can be closed again" went red in defects.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: storage
  checklist: scoped-reads dismissed: every reader sees every close; there is no scope to narrow
  checklist: encrypted-storage dismissed: the journal is plain text by design
  checklist: key-rotation-compatibility dismissed: no key exists
  checklist: input-validation declared as a defect's close names a guard or a decision
  checklist: revision-preservation declared as append-only store
  checklist: commit-ordered-effects dismissed: the append is the only effect, and a refusal writes nothing
  checklist: durable-dispatch-intent dismissed: nothing is dispatched after the append
  checklist: declared-target-coverage dismissed: one session file, no fan-out
  checklist: completion-evidence dismissed: the append is complete when the call returns, or nothing is written
- close a defect fires on a defect's close: The kernel practice close a defect fires on resolved followed by a defect's id, on Coherence's defect verb and on classify, and never on resolved followed by a conjecture's id, on defect as another verb's argument (journal --kind defect, query defect, lexicon review defect), on a quoted argument naming a defect's close, or on a heredoc's body.
  over: the practice as Journal.practice.md writes it, against resolving a defect, resolving a conjecture, a quoted because naming a defect's close alone and beside a conjecture's close, a heredoc's body, recording a defect through the source, installed and built CLI, classifying one, and three reads naming defect as an argument
  via: close a defect fires on resolving a defect and never a conjecture, nor on a quoted argument or a heredoc's body
  because: resolved closes both, and a trigger on the verb alone delivered the whole practice when a conjecture was resolved, which the session then recorded with every step skipped (df-ebbc84e3); recording and classifying a defect keep firing it, since classifying is its first step and a defect is recorded where that step is taken; the sweep found defect firing it as a noun in reads, and the defect verb's next word is free text no pattern can narrow, so that trigger names the program before the verb
  refuted: made a glob word of a command trigger match any word, so resolved df-* fired on resolving a conjecture as the bare verb did -> "close a defect fires on resolving a defect and never a conjecture, nor on a quoted argument or a heredoc's body" went red in defects.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- the convergence reading never infers: query convergence reads the journal, the spec model, git and the kept hook times over a window, 14 days unless --days says otherwise, and reports defects arriving by origin (fix-induced, pre-existing, unknown) and by catch and class, escapes per release (introduced, by commit or by the pull request a merge subject names, inside a release's range and recorded after its tag), closes with a guard, repeats per class, bullets at each day and tag, the files most often changed, and hook latency p50 and p95 per event and Coherence version; a field a record lacks is counted as unknown.
  over: a project with two release tags, defects introduced by a commit and by a pull request after the second tag, one pre-existing, one with no fields, a guarded close, a close with neither, a repeat, and hook times with a version, without one, and outside the window
  via: query convergence counts arrivals by origin and catch, escapes per release, closes and repeats, bullets at each tag and hook latency per version, and says unknown wherever a record does not say
  because: whether discoveries repay is a trend no single record shows; a reading that guessed an old record's origin or version would report the convergence it was built to measure rather than the one the records hold
  crossing: record -> reading
  refuted: made originOf read a defect with no introduced as fix-induced instead of unknown -> "query convergence counts arrivals by origin and catch, escapes per release, closes and repeats, bullets at each tag and hook latency per version, and says unknown wherever a record does not say" went red in defects.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- the record stores are named once: Each record store and its folder under .coherence is named once, in journal/stores.ts; every module that reads or writes a store takes its folder from there, and the folders a project commits, the union merge each store's files take, the stores Scope live follows, the stores the vocabulary check reads as words, and the CI records summary all derive from that table, so no module names a store's folder again.
  over: every store in the table, against the .coherence ignore file's kept folders, the attributes lines, Scope live's store matching, the prose folders the check reads, and the records summary run on a repository holding a record in each store; and every source module and CI script, scanned for a store's folder written as a path, a pair of folders listed together, or an alternation of them
  via: every record store is committed, merged by union, followed live, read for words when it holds prose, and summarized from the one table, and no module names a store's folder again
  because: RECORD_STORES named journal, runs and work beside the folders each store module, Scope live and the records summary declared for themselves, so a store added or renamed and left out of it would never be committed, would get no union merge and no live refresh, and nothing would fail (df-7bbcdfc5)
  crossing: project-source -> record
  refuted: gave project.ts its own list of the record stores again, RECORD_STORES = ["journal", "runs", "work"] in place of the table's folders -> "every record store is committed, merged by union, followed live, read for words when it holds prose, and summarized from the one table, and no module names a store's folder again" went red in stores.test.ts on its own assertion; restored (cmp), green batched and alone (2026-10-11)
  kinds: none
- a record field's role is declared once: Whether each field of each journal and work record is the writer's prose, a quoted refusal, or bookkeeping is declared once, in RECORD_ROLES beside the record types, keyed by each type's own fields so a field without a role fails to compile; the vocabulary check reads the prose and lexicon coverage the prose and the quoted, both through recordWords, and a field no type declares is read as prose.
  over: a record of every kind in both stores holding a distinct string in every field its type declares, nested lists, maps and objects included, and one field no type declares, read by the check and by coverage; an enactment's outcomes and a close's verdicts
  via: both readers of a record's words read every field by the role its record type declares, and a field no type declares as prose
  because: the check and coverage each kept a set of bookkeeping field names, and the two disagreed on eleven of them while neither named cites, so the check never read an enactment step's evidence and coverage never read a defect's evidence (df-baa1d2fa); a set keyed by field name could not give a close's results and an enactment's results their two roles
  crossing: record -> reading
  refuted: gave lexicon coverage its own list of bookkeeping fields again, skipping evidence wherever it appears ahead of the role tables -> "both readers of a record's words read every field by the role its record type declares, and a field no type declares as prose" went red in record-roles.test.ts on its own assertion; restored (cmp), green batched and alone (2026-10-11)
  kinds: none
- a closed vocabulary is declared once: Each closed list the journal and work verbs take (what caught a defect, an experiment step's results, the states work move takes, the journal's kinds, and the id prefixes the minter gives each kind) is declared once, in the record model or the minter's tables; the verbs' checks and refusals, their help, fleet telemetry's catches and the record id pattern practices cite by derive from it, and the docs, the spec's prose and the lexicon's definitions that enumerate one are held equal to it.
  over: every closed list against the verbs' help, docs/journal.md, this spec's prose and the lexicon's definitions; telemetry's catches; an id of every journal and work kind, and one of no kind; and every source module and CI script, scanned for one of the lists written out as an array, a literal union or an alternation
  via: every closed list the journal verbs take is read from the record model, and every help line, doc and definition that enumerates one names exactly its members
  because: the catches were written out in the record model, telemetry, the help twice, the docs twice, this spec and the lexicon; the step results in the union, the verb's own list, its template and refusals, the help, the docs and Scope's model; the work states work move takes in its help and refusal; and the id prefixes in a regular expression of their own, so a value added to one place would be refused, unsent, undocumented or never cited, and nothing would fail
  refuted: wrote the states work move takes out by hand again in its help, the literal open|active|waiting|cancelled in place of MOVE_STATES -> "every closed list the journal verbs take is read from the record model, and every help line, doc and definition that enumerates one names exactly its members" went red in vocabularies.test.ts on its own assertion; restored (cmp), green batched and alone (2026-10-12)
  kinds: none
