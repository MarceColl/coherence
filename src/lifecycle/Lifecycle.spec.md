# Lifecycle

The gyroscope delivered through harness events: orient at start, regulate at stop, the lexicon injected and checked.

## entrances
- SessionStart: the agent host starts a session; orient injects the vocabulary, the project's standing, and the session's work order
  handler: runHook in hook.ts
  trust: harness
- SubagentStart: the agent host starts a subagent; it is oriented as a session is
  handler: runHook in hook.ts
  trust: harness
- UserPromptSubmit: a human sends a prompt; the peer feed injects what peers recorded since the last look
  handler: runHook in hook.ts
  trust: harness
- PostToolUse: a tool finished; the edit is checked, the read trace recorded, and the peer feed and vocabulary changes injected
  handler: runHook in hook.ts
  trust: harness
- Stop: the session is about to stop; regulate reports what it owes
  handler: runHook in hook.ts
  trust: harness
- SubagentStop: a subagent is about to stop; regulate refuses the stop while it owes what the tool can prove
  handler: runHook in hook.ts
  trust: harness

## mirrors
- STATUS_TOOL_HOOKS in statusline.ts: the tool hooks the status line holds to the latency budget, kept apart because the status line imports nothing of Coherence's
  mirrors: TOOL_HOOKS in hook-events.ts

## invariants
- a subagent is told its own session: A subagent's start names its own session for every journal write and names its coordinator's session as one it never writes under; the main thread's start names no coordinator.
  over: a subagent start carrying the host's agent id beside its coordinator's session, and a main-thread start
  via: a subagent's start names its own session and its coordinator's, and says never to write under the coordinator's
  because: coordinators passed their own session id into subagent prompts, and subagents wrote under it: their decisions then read as the coordinator's own
  crossing: harness -> reading
  kinds: none
- a proposal prints as a reader needs it: lexicon propose prints the proposal's id first, what it changes, the entry as it would stand and the apply command; the whole lexicon after the change is printed only with --json.
  over: a define proposal printed plainly and with --json
  via: lexicon propose prints the proposal as a reader needs it, id first, and the whole lexicon only with --json
  because: every proposal printed the whole lexicon after the change, 87 KB, into the agent's context, and agents scraped the id out of it
  crossing: record -> reading
  kinds: none
- a dropped lexicon key stays on record: A define keeps every property and detail key it does not name; a key leaves only by an explicit --drop of properties.<key> or detail.<key>, and the decision that applies the drop carries the removed key and its text.
  over: a define that adds a property, a define that drops a property and a detail key, a drop of another field, and a drop on another action
  via: a define keeps every property and detail key unless one is dropped by name, and the applying decision carries the dropped text
  because: define could only merge, so a retired key could never leave and was rewritten in place as a note that it was former (d-e5a064e3); a drop that deleted the text with the key would lose the meaning a later reader of the journal needs to see what the lexicon once said
  crossing: harness -> project-source
  refuted: deleted the line in propose's define branch that records a dropped key's text, so the drop still removed the key but the decision no longer carried its text -> "a define keeps every property and detail key unless one is dropped by name, and the applying decision carries the dropped text" went red in lexicon-work.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: revision
  checklist: revision-preservation declared as a dropped lexicon key stays on record
- a property drop counts its findings before apply: The preview of a define that drops a property key prints, before anything is applied, how many current uses of that key in the corpus would become unknown-noun findings, from the lexicon check run over the lexicon as it stands and as the drop leaves it.
  over: a dropped property key the prose writes as a name on three lines, and one it never writes
  via: a property drop's preview counts the current uses that would become unknown-noun findings, before apply
  because: a property key counts as accepted vocabulary (d-3283157b), so dropping one can turn every use of it into a finding, as a bare rejection once turned 227 uses of a keyword into findings (rt-cdcf2a29); the count belongs in the preview, where the drop can still be withdrawn
  crossing: harness -> project-source
  refuted: made dropFindings run the after-check over the project lexicon as it stands, so the preview counted no new finding -> "a property drop's preview counts the current uses that would become unknown-noun findings, before apply" went red in lexicon-work.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: none
- lexicon provenance is append-only: A define adds a provenance key and never rewrites one the concept already records, and a drop of provenance.<key> is refused.
  over: a drop of a provenance key, a define rewriting an existing provenance key, and a define adding a new one
  via: provenance is append-only: a drop of a provenance key and a define that rewrites one are refused, a new key is added
  because: provenance is who defined a concept and in whose words; a merge that let a later define overwrite it would erase the owner's ruling under an agent's, with nothing in the lexicon to show it happened
  crossing: harness -> project-source
  refuted: made define's provenance guard test a key no field has, so a define rewrote an existing provenance key -> "provenance is append-only: a drop of a provenance key and a define that rewrites one are refused, a new key is added" went red in lexicon-work.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: revision
  checklist: revision-preservation declared as lexicon provenance is append-only
- a lifted rejection cites the decision that made it: A rejected name leaves a concept's rejected list only by lift, never by define; applying a lift needs a human acknowledgement and a cite of the applied decision that rejected the name when the journal holds one, and the lift's decision carries the lifted entry with its reason.
  over: a define carrying an empty rejected list, a lift applied without a human, with a human and no cite, and with both
  via: a rejection is lifted only with a human acknowledgement and a cite of the decision that rejected it
  because: a rejection is a ruling a human or an agent made with a reason; taking it back without citing it would let a later session undo the ruling without reading why it was made, and the name would drift back in
  crossing: harness -> project-source
  refuted: made rejectingDecisions find no decision for any rejection, so a lift applied with a human and no cite -> "a rejection is lifted only with a human acknowledgement and a cite of the decision that rejected it" went red in lexicon-work.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: revision
  checklist: revision-preservation declared as a lifted rejection cites the decision that made it
- no project lexicon before a project makes one: Before a project has its own lexicon, lexicon coverage names no project lexicon even when Coherence's lexicon is installed under the project root, and lexicon review prints every live use of a term too rare to be a candidate yet; only Coherence's own checkout reads Coherence's lexicon as its project lexicon.
  over: an adopter with Coherence's lexicon installed under its root and no lexicon.json, reviewing a term written in its code and prose below the candidate threshold
  via: before a project lexicon exists, coverage names no project lexicon even with Coherence installed inside the project, and review reads a term's live uses
  because: at adoption coverage named node_modules/@posthog/coherence/docs/lexicon.json as the project's, and review showed no live use of the project's domain terms, so the first step of settle a domain term could not be done and the agent read the schema directly (df-0d4e5065)
  crossing: project-source -> reading
  refuted: restored the old fallback in lexiconCoverage, naming Coherence's lexicon as the project's whenever it lies under the root -> the totality oracle went red in lexicon-work.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: none
- an outside entry file is named as outside: lexicon propose --entry with a file outside the project is refused with a message that names that entry file, never the lexicon.
  over: an entry file in another folder outside the project root
  via: an entry file outside the project is refused naming that entry file, not the lexicon
  because: the refusal said the lexicon path was outside the project, naming the wrong thing, and the adopting agent copied its entries into a folder inside the project to get past a wall it could not read (df-292f9083)
  crossing: harness -> reading
  refuted: dropped the entry-file label from the confinement call in lexicon propose, so the refusal again named the lexicon path -> "an entry file outside the project is refused naming that entry file, not the lexicon" went red in lexicon-work.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: none
- compact injection: The injection at session start carries the vocabulary only: nothing from detail, provenance, or metaphors.
  over: every concept of both lexicon layers
  via: renderCompact: header, one line per concept, rejected in brackets, nothing from detail, provenance or metaphors
  because: the injection rides in a context budget shared with the session's work; detail and provenance are for a human in Scope, and a metaphor in the injection would be read as a definition
  crossing: project-source -> reading
  refuted: made renderCompact print each concept's whole entry beside its line -> "renderCompact: header, one line per concept, rejected in brackets, nothing from detail, provenance or metaphors" went red in lexicon.test.ts; restored, green (2026-09-17)
  kinds: output
  checklist: destination-confinement dismissed: the injection goes to one destination, the host's additionalContext, and follows no redirect
  checklist: redaction declared as compact injection
  checklist: commit-ordered-effects dismissed: nothing is committed before the injection and it has no external effect
  checklist: circuit-breaker-policy dismissed: no dependency is sampled
  checklist: declared-target-coverage dismissed: one host reads the injection, not a registry of targets
- injection within budget: The start injection stays under the host budget: the project layer steps down in detail until the whole fits; when what must be shown whole (escalations are never shortened) leaves no room, Coherence's layer steps down to names and then to one line that points at the lexicon command.
  over: every start injection, with both lexicon layers at every level and any number of open escalations ahead of them
  via: the start injection stays under the budget with escalations present: the vocabulary steps down to names and then to a pointer, and no escalation is shortened
  because: a host replaces an over-long injection with a file preview or spills it, so an injection that overran the budget would be read by nobody, and the one record that exists for a human would be the thing that hid itself; the vocabulary can shrink because its full entries are one command away, the escalations cannot
  crossing: project-source -> reading
  refuted: returned the full vocabulary unchecked whenever no project layer could step down, so eight open escalations put the start injection at 11,614 characters against 9,500 -> "the start injection stays under the budget with escalations present: the vocabulary steps down to names and then to a pointer, and no escalation is shortened" went red in hook.test.ts; restored, green (2026-09-17)
  kinds: budget
  checklist: bounded-admission dismissed: no concurrent work is admitted; the bound is a character count on one document
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on the injected text, not on allocation
  checklist: execution-budget dismissed: no steps are counted
  checklist: circuit-breaker-policy dismissed: no dependency failures are observed
- rejected names refused: A rejected name is a finding as a whole word or phrase in prose and as an identifier token in code, each with its concept and because.
  over: every rejected name of both lexicon layers, across every prose and code file in the corpus
  via: rejected names are found as whole words in prose, with concept and because
  because: a rejected name is drift the lexicon already refused once; finding it as a whole word with its concept and the reason turns the second refusal into one edit instead of a discussion
  crossing: project-source -> reading
  refuted: removed the prose pass from rejectedInProse -> "rejected names are found as whole words in prose, with concept and because" went red in check.test.ts; restored, green (2026-09-17)
  kinds: none
- both layers reach identifiers: Wherever a lexicon layer's rejected names bind, they are matched in identifiers as well as in prose; only a name the project declares as its own concept or alias is silent there.
  over: every rejected name of both layers against every identifier token in the corpus, in a project with its own lexicon and in one without
  via: in code, both layers' rejected names match identifier tokens where both bind, unless the project declares the name as its own; language globals and module specifiers never match
  because: where a name binds is decided once, by whose text it is (Coherence's rejected names bind only in Coherence's own text), never by where the word sits: a project that has not declared a word its lexicon refuses is drifting whether the word is in a sentence or in a symbol, and a symbol is where naming drift actually lives
  crossing: project-source -> reading
  refuted: held rejected names against prose only, so the names in identifiers went unreported -> "in code, both layers' rejected names match identifier tokens where both bind, unless the project declares the name as its own; language globals and module specifiers never match" went red in check.test.ts, the identifier hits missing from the expected list; restored, green (2026-09-25)
  kinds: none
- the corpus is every text kind: The check reads every text file kind the project holds, the journal's and work's own records included, and leaves out what is written in another vocabulary on purpose, what no rename can repair, and what is not text.
  over: every file under the project root, by kind: prose, code, data, dotfiles, records, lockfiles, binaries, the retired inventories, the reference docs and the reviews
  via: the corpus reads every text kind the project holds, the journal's records included, and leaves out lockfiles, binaries, runs, and the reviews
  because: a check that reads two extensions reports zero over a project whose drift is in its configuration, its scripts and its records, and a zero that means "not looked at" is worse than no check; the exclusions are the files that must name what they refuse (the lexicons and the retired inventories), the files a rename cannot reach (a dependency lockfile), and the files that are not the project's own words (the reference docs and the adversarial reviews, which quote the names they report)
  crossing: project-source -> reading
  refuted: read only .md and .ts, so eleven files of nine other kinds went unread and only the review the check should skip was read -> "the corpus reads every text kind the project holds, the journal's records included, and leaves out lockfiles, binaries, runs, and the reviews" went red in check.test.ts with every expected file missing; restored, green (2026-09-18)
  kinds: read
  checklist: scoped-reads declared as the corpus is every text kind
  checklist: redaction dismissed: every finding is shown with its file, line, and the text as written
- the corpus stays inside the root: Every path the check is given is confined to the project root; a path that reaches above it is refused rather than read.
  over: every path given to the check: relative, absolute, and reaching upward
  via: collectFiles confines every given path to the project root
  because: the paths reach the check from a spec, a hook's stdin, and a command line, none of which is trusted to stay inside the tree it names; a walk that followed one upward would read, and report, a neighbouring project's files
  crossing: project-source -> reading
  refuted: resolved each given path and walked it, so ".." and "/etc" were read -> "collectFiles confines every given path to the project root" went red in check.test.ts, the walk failing above the root instead of refusing; restored, green (2026-09-18)
  kinds: none
- an unreadable path never aborts the check: A path the process cannot read is reported as unreadable and skipped; the rest of the corpus is still checked, and the report says what it did not see.
  over: every folder and file the walk reaches, readable and not
  via: an unreadable folder is reported and skipped; the check never aborts on it
  because: one locked folder cost the whole check, so a project with a single unreadable path got no verdict at all; and a check that quietly skipped it would report a clean corpus it never read, which is the same lie a failed listing read as an empty one would be
  crossing: project-source -> reading
  refuted: let the walk's readdir throw -> "an unreadable folder is reported and skipped; the check never aborts on it" went red in check.test.ts with EACCES out of scandir aborting the run; restored, green (2026-09-18)
  kinds: none
- project sense wins: Inside a project, an accepted project name silences a Coherence rejection, and an accepted phrase guards the words inside it.
  over: every accepted project name and alias against every Coherence rejected name
  via: a project's own sense wins: an accepted project name silences a Coherence rejection, and an accepted phrase guards the words inside it
  because: Coherence's names describe the tool and a project's names describe its domain; a domain that legitimately uses a word the tool refuses must not be made to rename its own things
  crossing: project-source -> reading
  refuted: dropped the project's own accepted phrases from the guard, so a Coherence rejection spoke over the project's sense -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: none
- Coherence's rejected names bind only in Coherence's own text: In Coherence's own repository its rejected names bind in every text; in an adopter they are never matched in the project's code or domain prose, and a hit in the text written to Coherence (records, spec grammar, coherence.config.json) is advisory, counted and never failing.
  over: every Coherence rejected name against an adopter's prose, code, spec grammar and sentences, records and config, and against the same text read as Coherence's own repository, detected by its package name
  via: Coherence's rejected names bind only in Coherence's own text: in an adopter its code and domain prose are the project's words, and the text written to Coherence is advisory
  because: Coherence's names describe the tool and a project's names describe its domain; two adoptions arrived with 289 and 918 failing hits of words the tool refused for its own concepts, used in the project's own sense, so a fresh adoption could not pass and the check taught agents to rename the domain. Coherence's concepts are named only where the project writes to Coherence, and even there a word can be the domain's, so there it is reported and never refused
  crossing: project-source -> reading
  refuted: matched Coherence's rejected names in every text of an adopter, as if it were Coherence's own repository -> the via went red in check.test.ts, the adopter's prose and identifier hits enforced; restored, green (2026-09-25)
  kinds: none
- a project's claim wins inside it: A Coherence rejected name the project declares in its own lexicon, as a concept, alias, or instance, is no finding anywhere in that project, advisory or enforced.
  over: every Coherence rejected name the project's lexicon declares, against the adopter's records, where Coherence's names are still read
  via: a project's claim wins inside it: a Coherence rejected name the project declares is no finding, advisory or enforced
  because: a project claims a word through the lexicon workflow it already has, and the claim must reach every text the check still reads Coherence's names in; the claim is the existing declaration, not a parallel list, so a word is claimed exactly when the project has defined it
  crossing: project-source -> reading
  refuted: kept every Coherence rejected name in force, ignoring the names the project's lexicon declares -> the via went red in check.test.ts, the claimed word reported in the record; restored, green (2026-09-25)
  kinds: none
- the baseline only shrinks: A project's lexicon check fails only on findings outside its baseline, the findings recorded when it adopted Coherence and counted on one line; a later baseline record is intersected with the earlier ones so it can drop findings and never add one, a fixed finding stops matching at once, and Coherence's own repository keeps none.
  over: every rejected-name finding and unknown noun of an adopter's whole-project check, across a first baseline, an edit, a fix, a second baseline, and a hand-written record with more in it, and the same record in Coherence's own repository
  via: the baseline only shrinks: a fresh adoption passes once baselined, a new finding fails, a fixed one drops out, a later record never adds, and Coherence's own repository keeps none
  because: an adoption inherits findings it did not write, and a check red on arrival is skipped from then on; but an excuse that can grow is a way to stop checking. The retired growth-failure mechanisms fell because growth was not the danger; here the danger is a new finding, so the known residual is excluded from the check's named set and can only get smaller
  crossing: project-source -> reading
  refuted: let the newest baseline record replace the earlier ones instead of being intersected with them -> the via went red in check.test.ts, a hand-written record widening the baseline; restored, green (2026-09-25)
  kinds: none
- the check's unknown nouns are coverage's names: An unknown noun is a proper noun coverage's nomination reads in prose, never the tail of an acronym, a word English always capitalizes, a well-known name in its well-known spelling, a backticked identifier, or a component folder's name, and it stands only by coverage's recurrence: three prose lines, or two across two components.
  over: every prose line of the corpus, with component folder names, acronym tails, well-known names, backticked words and single-line repeats
  via: unknown nouns: Title Case away from a sentence start, on three lines or two across two components, with three closed options; a component folder's name is its spec's
  because: the check and coverage disagreed about what a name is, so two adoptions got 89 and 103 unknown nouns, the most frequent being component folders (core, scripts) counted wherever the word appeared and the tail of the project's own name; one nomination for both keeps the failing check a subset of the reading that explains it
  crossing: project-source -> reading
  refuted: dropped the acronym-tail rule from the shared nomination, so the capitalized tail of a product name was nominated -> the via went red in check.test.ts; restored, green (2026-09-25)
  kinds: none
- regulate refuses only what it can prove: A subagent stop is refused for a rejected name in a changed file, a spec problem, or a structural defect, and never for an open requirement.
  protects: REFUSE_EXIT
  chokepoint: runHook
  over: every stop event a host sends
  via: orient lists open requirements and regulate reports them; only spec problems refuse a subagent stop
  because: a refusal holds a subagent in its loop, so it is spent only on what the tool can prove is owed: a rejected name in a changed file, a spec that will not parse, a chokepoint that no longer chokes; an open requirement can legitimately outlive a session, and refusing on it would train agents to fabricate enforcement lines
  crossing: harness -> reading
  refuted: widened the refusal to any spec text, so an open requirement refused the subagent stop -> its totality oracle went red at "an open requirement never refuses a subagent stop", exit 2 where 0 was asserted (2026-09-17)
  kinds: none
- an unknown noun never refuses: An unknown noun in a changed file is reported at the stop with its three answers and never refuses a subagent stop.
  over: every stop event whose changed files carry an unknown noun and no rejected name
  via: an unknown noun in a changed file is advisory: Stop reports it and SubagentStop never refuses on it
  because: the nomination is a heuristic, precision over recall, and the lexicon allows a refusal only for what the tool can prove: a rejected name, a spec problem, a structural defect; holding a subagent on a guess would teach it to strip capitalized phrases rather than declare names
  crossing: harness -> reading
  refuted: refused the subagent stop on any lexicon finding, unknown nouns included -> "an unknown noun in a changed file is advisory: Stop reports it and SubagentStop never refuses on it" went red in hook.test.ts, exit 2 where 0 was asserted; restored, green (2026-09-17)
  kinds: none
- a recorded wall makes the debt advisory: A debt the session has recorded as unable, naming the file, the rejected name, or the invariant, is reported with that record's id and does not refuse the subagent stop; another session's unable clears nothing.
  over: every rejected name, spec problem, and structural defect a subagent stop would refuse on, against every unable record of the stopping session
  via: an unable record from the session turns the debt it names advisory: SubagentStop reports it and exits 0, and another session is still refused
  because: the subagent stop is refused until the debt is paid or recorded as unable; a wall the agent cannot pass must not hold it in its loop forever, and the record names the wall for the reader who decides, which is why it counts only for the session that wrote it
  crossing: record -> reading
  refuted: refused the subagent stop with the unable record on file, reading no wall -> "an unable record from the session turns the debt it names advisory: SubagentStop reports it and exits 0, and another session is still refused" went red in hook.test.ts, exit 2 where 0 was asserted; restored, green (2026-09-17)
  kinds: none
- a git failure is not a clean tree: When git cannot list the changed files, the stop says so and that the lexicon check ran over nothing; outside a repository the answer is no files, and a failure never refuses.
  over: every stop event, in a repository git can read, one it cannot, and no repository at all
  via: changedFiles reports a git failure instead of answering a clean tree; outside git the answer is no files
  because: a listing that failed reads exactly like a tree with nothing changed unless the failure is carried; regulate would then report clean over files it never saw, which is the one lie the stop exists to prevent
  crossing: harness -> reading
  refuted: caught every git failure and answered no files -> "changedFiles reports a git failure instead of answering a clean tree; outside git the answer is no files" went red in hook.test.ts on the unreadable repository; restored, green (2026-09-17)
  kinds: none
- the hook answers one project: Every event is answered for the project root the hook was installed for; a cwd from the harness that is not inside that root is refused, and nothing is read or written.
  protects: OUTSIDE_ROOT_EXIT
  chokepoint: runHook
  over: every event, with a cwd inside the installed root, one outside it, and no installation to point at
  via: the hook refuses a cwd from stdin that is not inside the project root it was installed for
  because: the working directory arrives on stdin from the harness, which is the one input the tool does not author; a hook that answered any cwd would read a neighbouring project's journal and append its own records there, and the tree it was installed for is the one it can point at, by the settings file that carries it or by the name the harness gives
  crossing: harness -> project-source
  refuted: took the cwd from stdin as given, so a stranger's tree was answered for -> "the hook refuses a cwd from stdin that is not inside the project root it was installed for" went red in hook.test.ts, exit 0 where 78 was asserted; restored, green (2026-09-18)
  kinds: none
- the stop snapshot has an instrument: The read-trace snapshot at a stop reaches the language server through enforcement's one door, in production as in a test, and records the instrument it was handed.
  over: every stop event that snapshots a trace, with a door that answers and a door that cannot
  via: the Stop snapshot reaches the instrument through enforcement's one door, in production as in a test
  because: the snapshot exists to be calibrate's input, and a closure predicted with no adapter skips the hops, so every production sample was measuring a prediction the tool would never make at the command line; the door is enforcement's because a second way to the warm server is a second lifecycle to get wrong
  crossing: harness -> reading
  refuted: passed only the adapter a test hands in, so a production stop recorded server "none" and reason "no adapter" -> "the Stop snapshot reaches the instrument through enforcement's one door, in production as in a test" went red in hook.test.ts, "none" where "warm" was asserted; restored, green (2026-09-18)
  kinds: none
- escalation heads the start: An unacknowledged escalation heads the start injection, never shortened; an acknowledged one does not.
  over: every start event, SessionStart and SubagentStart, against every escalation in the journal
  via: an unacknowledged escalation heads the start output; an acknowledged one does not
  because: a session that starts without seeing the question a human has not answered will act past it; the block is never shortened to fit the budget because a human must see it whole
  crossing: record -> reading
  refuted: made escalationBlock read an empty journal -> "an unacknowledged escalation heads the start output; an acknowledged one does not" went red in hook.test.ts; restored, green (2026-09-17)
  kinds: read
  checklist: scoped-reads dismissed: every session sees every open escalation
  checklist: redaction dismissed: the block is never shortened
- escalation names what it cites: An open escalation in the start injection names each record it cites, a decision or a work order or any record, by id, kind and subject beneath it.
  over: the start injection over a journal with an escalation that cites a decision and a work order
  via: an open escalation that cites a decision and a work order names each by id, kind and subject in the start output
  because: an escalation is the one record that exists for a human; a question that arrives without what it is about sends the human to the journal to reconstruct it, and a cited decision's subject is the shortest faithful statement of that context
  crossing: record -> reading
  refuted: stopped escalationBlock from naming the records an escalation cites -> the totality oracle went red in hook.test.ts; restored, green (2026-09-23)
  kinds: none
- revelation at the edit: After a file-writing tool, the chokepoint invariants the file may involve are re-checked and a bypass is shown in the same turn with the two honest options; the stop carries the defects.
  over: every chokepoint invariant whose latest run touched the written file or whose protected or chokepoint name appears in it
  via: PostToolUse on a file-writing tool re-checks the invariants that may involve the file and prints the bypass with the two options; Stop carries the defects
  because: the moment a second referencing site appears is the moment to reveal it; a defect shown at the next stop is already buried under the work that followed, so the re-check runs in the same turn and names the two honest options, route through the chokepoint or escalate a retirement
  crossing: harness -> reading
  refuted: made editContext return nothing whether or not the re-check failed -> "PostToolUse on a file-writing tool re-checks the invariants that may involve the file and prints the bypass with the two options; Stop carries the defects" went red in enforcement.test.ts; restored, green (2026-09-17)
  kinds: output
  checklist: destination-confinement dismissed: one destination, the host's additionalContext, and no redirect
  checklist: redaction dismissed: a bypass is shown whole with its file, line, and symbol
  checklist: commit-ordered-effects dismissed: the run is appended before the text is printed, and printing is not irreversible
  checklist: circuit-breaker-policy dismissed: an unavailable instrument is reported as such, never routed around
  checklist: declared-target-coverage dismissed: one file per event, not a registry of targets
- install keeps other hooks: Installing the hook merges one Coherence entry per event into the host's settings, keeps every hook that is not ours, owns only a command that names this tool's binary or its own cli path, and replaces that command on a second pass.
  protects: mergeHooks
  chokepoint: install
  over: every host and every event Coherence installs, against every hook command another tool could have written there
  via: mergeHooks adds one Coherence entry per event, keeps everything else, and replaces its own entry on a second pass
  because: the host's settings file belongs to the adopter and may already carry other hooks; an install that clobbered them would cost the adopter its own automation, a second install that duplicated its entry would run every hook twice, and ownership decided by a loose match would delete a stranger's hook that merely ends the way ours does. What must be choked is the object that gets written: only the merge produces it, and only install reaches the merge. It was written as the settings path inside this module, which stopped being true the moment the hook needed to know which tree it was installed for and read the same two paths to find it; the path is a fact about a host, the merge is the thing that must have one door
  crossing: project-source -> harness
  refuted: claimed any command ending in "cli.ts hook <Event>" as Coherence's, so a stranger's cli.ts hook was deleted on install -> "mergeHooks adds one Coherence entry per event, keeps everything else, and replaces its own entry on a second pass" went red in install.test.ts naming the three foreign hooks that vanished; restored, green (2026-09-17)
  refuted: made mergeHooks drop every other host's entry instead of keeping it -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: deploy
  checklist: graceful-drain dismissed: nothing is shut down by an install
  checklist: readiness-evidence dismissed: status reports what is written in the settings file and claims nothing about a running process
  checklist: declared-target-coverage declared as install keeps other hooks
- uninstall keeps other hooks: Uninstalling the hook removes every command of Coherence's from the agent host's settings and nothing else: another tool's hook stays in its entry with its matcher, an entry, event list, or hooks object goes only when this removal emptied it, the file keeps its layout, and a second uninstall changes nothing.
  over: both agent hosts, settings in every layout (two spaces with a final newline, a tab without one, no hooks object), and every hook command another tool could have written beside ours or in the same entry
  via: uninstall removes only Coherence's commands and returns the settings to what they were before install
  because: the settings file belongs to the adopter; an uninstall that took a neighbouring hook, reformatted the file, or left an empty husk would make removing Coherence cost the adopter its own automation or a diff to review, and an adopter who cannot leave cleanly will not try it. Ownership is the same command rule install uses, so what uninstall removes is exactly what install could have written
  crossing: project-source -> harness
  refuted: made stripHooks drop an entry of ours whole, so another tool's hook sharing that entry left with it -> "uninstall removes only Coherence's commands and returns the settings to what they were before install" went red in install.test.ts; restored, green (2026-09-23)
  kinds: deploy
  checklist: graceful-drain dismissed: nothing is shut down by an uninstall; a session already running keeps the hooks its agent host loaded
  checklist: readiness-evidence dismissed: uninstall reports what it removed from the settings file and claims nothing about a running process
  checklist: declared-target-coverage dismissed: one host's one settings file per call, not a registry of targets
- install keeps regenerated state out of git: Installing the hook writes .coherence/.gitignore once, so the project's git sees only the durable folders (journal, runs, work) and the project's hook voice under .coherence, never the state Coherence regenerates, and the project's own .gitignore is never edited; a .coherence/.gitignore with any other text is the adopter's and is kept, and uninstall removes the file only when it is exactly what install wrote and no agent host keeps a hook of ours.
  over: every folder Coherence writes under .coherence (journal, runs, work, hooks, feed, lexicon, models, observations, practices, run, structure, traces), in a fresh git project, across both agent hosts installed and uninstalled in turn, a fresh tree, and an ignore file of the adopter's
  via: install keeps Coherence's regenerated state out of the project's git, and uninstall removes only the ignore file it wrote
  because: a fresh adoption saw feed cursors, read traces, readings and a language model's weights as untracked files and had to guess what to ignore (df-35f4975d); Coherence's own .gitignore kept them out, but an adopter never receives that. The file sits in Coherence's own folder, so install never edits a file the adopter wrote and uninstall can remove it whole; while another host still runs our hooks the state keeps being written, so the file stays (d-e2cff03c)
  crossing: project-source -> harness
  refuted: made removeIgnore stop asking whether another agent host keeps our hooks, so uninstalling Claude Code took the ignore file while Codex still ran ours -> "install keeps Coherence's regenerated state out of the project's git, and uninstall removes only the ignore file it wrote" went red in install.test.ts on "codex still holds our hooks"; restored, green (2026-10-05)
  kinds: deploy
  checklist: graceful-drain dismissed: nothing is shut down by an install or an uninstall
  checklist: readiness-evidence dismissed: install and uninstall report what they wrote or removed and claim nothing about a running process
  checklist: declared-target-coverage dismissed: one ignore file in one folder per project, not a registry of targets
- record stores merge by union: Two branches that append different records to the same session's file in every record store (journal, runs, work) merge and rebase with no conflict, and every record of both branches loads afterwards, in time order, with nothing damaged; the attributes Coherence writes cover every record store.
  over: the journal, the runs and the work orders, each written through its own appender under one session on a base and two branches from it, merged one way and rebased the other, against the same stack with no attributes file, which conflicts in every store
  via: two branches that append different records to one session's file in every record store merge and rebase with no conflict, and every record of both loads
  because: every restack of an adopter's stacked branches conflicted on the journal's and the runs' session files, which both branches append to, and Coherence's own pull requests hit the same conflict (df-f5c1983d); the stores are append-only and their readers order records by content, so the union of both sides' lines is the right merge, and git applies it only when an attributes file says so
  refuted: made the attributes Coherence writes set each record store's session files to text instead of merge=union -> "two branches that append different records to one session's file in every record store merge and rebase with no conflict, and every record of both loads" went red in state-files.test.ts on a conflict in the journal's, the runs' and the work orders' session files; restored, green (2026-10-09)
  kinds: none
- record readers tolerate what a union merge keeps: A record store's last line left without its newline (a crashed write, or one side's unterminated line that a union merge kept) is ended before the next record is appended, so it stays one damaged line and the record after it reads whole; and a line a union merge kept twice is read once, by the journal's, the work orders' and the runs' readers alike.
  over: the journal, the work orders and the runs, each with a line doubled and a torn last line, then a record appended through its own appender
  via: a torn last line a union merge keeps stays one damaged line, the record appended after it reads whole, and a line kept twice is read once
  because: a union merge keeps both sides' lines as they are, so a torn last line can end the merged file and the next append ran on into it, losing a whole record to a damaged line; and lines identical on both sides can be kept twice, which a reader that counted lines would read as two records
  refuted: made appendWhole append after a torn last line without ending it first -> "a torn last line a union merge keeps stays one damaged line, the record appended after it reads whole, and a line kept twice is read once" went red in state-files.test.ts; restored, green; reading every doubled line again also turned it red (2026-10-09)
  kinds: none
- every session start keeps the attributes file: Install and every session start write .coherence/.gitattributes where it is absent and add to one the adopter wrote only the attributes it does not set for that pattern, keeping every line of theirs; a .coherence/.gitignore holding exactly an earlier release's text, which ignored the attributes file, is brought up to this release's, so git commits the attributes file; a session start creates no ignore file install did not write and never rewrites the adopter's.
  over: a fresh git project, an adopter's attributes file setting one attribute of Coherence's for the same pattern and another for a different one, an earlier release's ignore file, a project with no ignore file, and an ignore file of the adopter's
  via: install and every session start keep .coherence/.gitattributes: written where absent, an adopter's lines kept with only missing attributes added, and an earlier release's ignore file brought up so git commits it
  because: an adopter must get the merge rule with no step of its own, and one that adopted an earlier release runs no install on upgrade, only its next session; the attributes file sits in Coherence's own folder beside the ignore file, so writing it edits nothing the adopter wrote, and an attribute the adopter set for the same pattern is the adopter's choice
  refuted: made keepIgnore leave an earlier release's ignore file as it was, so it still ignored the attributes file -> "install and every session start keep .coherence/.gitattributes: written where absent, an adopter's lines kept with only missing attributes added, and an earlier release's ignore file brought up so git commits it" went red in state-files.test.ts; restored, green (2026-10-09)
  kinds: none
- an upgraded adopter's first session start writes the attributes: The session start hook, in a project an earlier release adopted (its ignore file in that release's text, no attributes file), leaves .coherence/.gitattributes in Coherence's text and the ignore file in this release's, once the start is committed.
  over: a project holding exactly what an earlier release's install left, started once
  via: a session start in a project that adopted an earlier release writes the attributes file its records merge by and brings the earlier ignore file up so git commits it
  because: an upgrade is the adopter's next npm install and nothing more; the session start is the first thing of Coherence's that runs after it, so it is where an adopter that never reinstalls the hooks receives the merge rule
  refuted: made the session start's commit skip keepStateFiles -> "a session start in a project that adopted an earlier release writes the attributes file its records merge by and brings the earlier ignore file up so git commits it" went red in hook.test.ts; restored, green (2026-10-09)
  kinds: none
- check fails on any drift: The hook check exits non-zero, naming the event and the kind, whenever an agent host's installed hooks differ from what install would write: an event missing, an entry of ours stale in any field or shape, or an extra entry of ours; another tool's hook is never drift.
  over: every event install wires, every field and the shape of the entry install writes, and every entry of ours under any event, for both agent hosts
  via: the check names every drift from what install would write: missing, stale, and extra
  because: the check is what CI and a person run to know the gyroscope is actually delivered; one that passed a stale launcher, a dropped Codex context limit, or a duplicate entry would report delivery that is not happening, which is the reference's failure of a mechanism described rather than automatic. It compares against the one entry install writes, so the two cannot disagree
  crossing: project-source -> harness
  refuted: made the check compare only the command, so a changed timeout, a dropped Codex context limit, a shared entry, or a matcher passed as clean -> "the check names every drift from what install would write: missing, stale, and extra" went red in install.test.ts; restored, green (2026-09-23)
  kinds: none
- a hook without Coherence tells the agent how to supply it: A hook installed for an adopter, run where Coherence cannot be found or node is not on the PATH, exits 0 with no shell error on every event; at the session start it shows the user one line, and when Coherence is missing it tells the agent to run the project's install when package.json lists the package and otherwise to add it as a dev dependency, never to clone or point at a checkout, and that changing the project's dependencies is the user's decision, so the agent makes the call; every other event is silent.
  over: every event install wires, for both agent hosts, with nothing installed and with a checkout named by COHERENCE_HOME but no node; and uninstall still owns the command
  via: a hook without Coherence installed tells the user once and the agent how to supply it, and is otherwise silent
  because: a teammate who opens the project without Coherence, or a session in a fresh clone, would otherwise see a stack of shell errors on every event and a SubagentStop that fails for a reason that has nothing to do with the work; a line only the user sees leaves the agent unaware, and a hook that installed Coherence itself would change the project's dependencies and lockfile mid-session without anyone deciding to; the agent knows whether the user asked for Coherence and which package manager the project uses, so it is told and decides; the text once told it to clone Coherence beside the project, which is likely how an adopter's stale clone came to shadow the installed release
  crossing: project-source -> harness
  refuted: added cloning beside the project to the ways the missing context offers -> "a hook without Coherence installed tells the user once and the agent how to supply it, and is otherwise silent" went red in install.test.ts on its own assertion (the installed package is the one way offered); restored byte for byte, green batched and alone (2026-10-08)
  kinds: deploy
  checklist: graceful-drain dismissed: nothing is shut down; the hook exits at once without having accepted any work
  checklist: readiness-evidence dismissed: the line and the context claim only that Coherence was not found, which is what the command just observed
  checklist: declared-target-coverage declared as a hook without Coherence tells the agent how to supply it
- a located Coherence answers as a direct command does: An adopter's hook finds Coherence (the checkout $COHERENCE_HOME names, else the installed package, else the project's own bin) and, once found, answers and refuses exactly as a direct command would; the committed command names no path on one machine and never touches the project's node_modules or lockfile.
  over: both agent hosts, the start injection and a refused subagent stop, a checkout COHERENCE_HOME names reached from the project and from a git worktree of it, and a checkout beside either that is never run
  via: a located Coherence answers, and refuses, as a direct command does
  because: an npm link into a pnpm project installed a second dependency tree over the locked one and broke its production build, and a command naming one person's absolute path breaks for every teammate; locating the installed package, or a checkout only through the variable a developer sets, keeps the project's packages its own, and answering as the direct command does keeps the refusal at SubagentStop, the one refusal the lifecycle has
  crossing: project-source -> harness
  refuted: ran the located Coherence under an EXIT trap that exits 0, so its exit status was swallowed -> "a located Coherence answers, and refuses, as a direct command does" went red in install.test.ts on its own assertion (the located command refuses as the direct one does); restored byte for byte, green batched and alone (2026-10-08)
  kinds: deploy
  checklist: graceful-drain dismissed: the located command runs the same process a direct one would, with nothing of its own to drain
  checklist: readiness-evidence dismissed: the command runs what it found; it makes no claim about a running process
  checklist: declared-target-coverage declared as a located Coherence answers as a direct command does
- the installed package wins over a checkout beside the project: An adopter's hook runs exactly one of two things: the checkout $COHERENCE_HOME names when it is set, and otherwise the project's installed package; a checkout beside the project, or beside a worktree's main checkout, is never run, so a package not installed, declared or not, is reported missing rather than replaced by a checkout.
  over: a stale checkout at ../coherence beside an installed package, the same with the package declared but not installed, with nothing declared, and with $COHERENCE_HOME set over the installed package
  via: a checkout beside the project never runs, installed package or not; only COHERENCE_HOME names a checkout
  because: an adopter with an old 0.0.0 clone at ../coherence had every session open with 49 spec problems while the installed 1.2.0 said none, since the hook looked beside the project first and only checked that a file was there; a checkout is for someone who chose it, which $COHERENCE_HOME says and a folder that happens to be there does not, and the owner removed the fallback for a project with nothing declared too (d-19de68bd)
  refuted: added ../coherence back as a fallback after the installed package and its bin -> "a checkout beside the project never runs, installed package or not; only COHERENCE_HOME names a checkout" went red in install.test.ts on its own assertion (a declared but missing package is missing, never replaced by a checkout); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- hooks an earlier release wrote are named for reinstall: A hook command of the earlier form, which looked at a checkout beside the project before the installed package, is named at every session start, one line per settings file with the exact reinstall command, and the hook check says why it drifted and to reinstall; what install writes now is never named so.
  over: no settings, current hooks, every event's command in the earlier form in .claude/settings.json, the check over it, and the reinstall
  via: hooks an earlier Coherence wrote, which look beside the project first, are named by the check and at the session start with the reinstall
  because: the search order lives in the command written into the adopter's settings, so upgrading the package leaves the old order in place until the hooks are reinstalled; an adopter left on it would keep running whatever clone sits beside the project, and a bare "stale" in the check does not say that this drift is the one that runs the wrong Coherence
  refuted: made searchesCheckoutFirst answer false for every command -> "hooks an earlier Coherence wrote, which look beside the project first, are named by the check and at the session start with the reinstall" went red in install.test.ts on its own assertion (no line for the earlier hooks); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- Coherence's own repository runs its own source: In Coherence's own repository, hooks install writes a command that runs the tree's own src/cli.ts, which in its main checkout and in each of its git worktrees is that tree's own; never an installed package or the checkout $COHERENCE_HOME names.
  over: a repository whose package.json names the package, its main checkout and a worktree of it at ../coherence-practice, each running its committed SessionStart hook
  via: Coherence's own repository runs its own source, in its main checkout and in each of its worktrees
  because: work on Coherence is tried in worktrees beside its main checkout, and a hook that reached the main checkout's code, or an installed release, from a worktree would check the change against code it does not contain
  refuted: made hooks install write the adopter's located command in Coherence's own repository -> "Coherence's own repository runs its own source, in its main checkout and in each of its worktrees" went red in install.test.ts on its own assertion (its own source, never a package or another checkout); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- a developer points an adopter at a local checkout: The hooks a project commits run the checkout $COHERENCE_HOME names when that variable is in the agent host's environment, and the session start says so; a project with no shared hook of ours can instead install a personal hook with --local and --command naming the checkout's cli, which runs it and which hooks --check with the same flags accepts.
  over: an adopter that declares the package, its shared hooks run with COHERENCE_HOME set, and, uninstalled, a personal hook naming this checkout's cli, run and checked
  via: a developer points an adopter at a local checkout through COHERENCE_HOME, or through install --local --command where no shared hook of ours is installed
  because: with the fallback beside the project gone, a developer of Coherence who runs another project against a checkout (the owner runs posthog beside his coherence checkout) needs a way the hooks honor and the README documents; a way that worked only by accident would be the next shadowing
  refuted: dropped COHERENCE_HOME from the located search -> "a developer points an adopter at a local checkout through COHERENCE_HOME, or through install --local --command where no shared hook of ours is installed" went red in install.test.ts on its own assertion (the session start did not name the COHERENCE_HOME checkout); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- hooks install names the copy the hooks reach: After an adopter's hooks install, the line naming the Coherence the hooks will reach, and the note when that is not the Coherence running the install, name each copy in the session start's own words (the installed package, the checkout $COHERENCE_HOME names, a checkout, or Coherence's own source), from the one description both use; an installed package is never called a checkout.
  over: an installed package in pnpm's layout reached by itself, the checkout COHERENCE_HOME names reached by itself, an installed package reached from a checkout's install, nothing reached, and the command line with COHERENCE_HOME set
  via: hooks install names the Coherence the hooks reach as the session start names it, never an installed package as a checkout
  because: PostHog's hooks install under 1.6.0 printed "the hooks reach this checkout (/…/node_modules/.pnpm/@posthog+coherence@1.6.0/node_modules/@posthog/coherence)", calling the installed package a checkout; words kept in two places drift, so the install note takes its words from the session start's description
  refuted: made the reached line say "this checkout" with the folder again -> "hooks install names the Coherence the hooks reach as the session start names it, never an installed package as a checkout" went red in version.test.ts on its own assertion (strictly equal: the installed package expected); restored byte for byte, green batched and alone (2026-10-09)
  kinds: none
- the session start names the Coherence that runs: Every session start names the Coherence answering it in one line, its version and where it is (the installed package, the checkout $COHERENCE_HOME names, a checkout a hook command names itself, or Coherence's own source), and adds a line when the other of the installed package and the $COHERENCE_HOME checkout differs in version, with the command that would run it; a folder beside the project, which no hook runs, is never named.
  over: an installed 1.5.2 beside a 0.0.0 clone at ../coherence, the same with $COHERENCE_HOME naming the clone while the installed package runs, the clone run through $COHERENCE_HOME, a checkout named by the hook command at the installed version, and a session start through the hook
  via: the session start names the Coherence that runs and where it is, and warns when another copy the project reaches differs in version
  because: the adopter whose clone shadowed the installed release had no way to see which Coherence spoke; a version and a place in the session's own context let the agent notice the mismatch the first time instead of chasing problems the installed release does not have
  refuted: skipped every other copy whatever its version -> "the session start names the Coherence that runs and where it is, and warns when another copy the project reaches differs in version" went red in version.test.ts on its own assertion (the COHERENCE_HOME checkout at another version went unnamed); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- a newer release is named with its update command: When the newest published version Coherence last read from the npm registry is later than the version running, the session start says so in one line with the update command for the project's package manager, by its lockfile (npm, pnpm, Yarn, bun), and the release-age setting that may hold the newest back with the setting that exempts Coherence; nothing is said when the running version is current, or while the check is off.
  over: no kept answer, a kept 1.6.0 over a running 1.5.2 with no lockfile, a pnpm, Yarn and bun lockfile, a kept answer equal to the running version, and COHERENCE_NO_UPDATE_CHECK, CI and DO_NOT_TRACK
  via: a newer release in the kept answer is named at the session start with the update command for the project's package manager and its release-age setting
  because: pnpm's minimumReleaseAge quietly installed 1.1.1 for an adopter who needed 1.2.0, and nothing told the agent a newer Coherence existed; a line the agent reads, with the command its package manager takes and the exclude setting, lets it update itself instead of working around a missing feature
  refuted: answered every project with npm's command whatever its lockfile -> "a newer release in the kept answer is named at the session start with the update command for the project's package manager and its release-age setting" went red in version.test.ts on its own assertion (pnpm-lock.yaml); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- the update check adds no wait to a hook: A session start asks the npm registry for the newest version only by spawning version --refresh detached, its output ignored and unreferenced, after its answer is made, and only when the last attempt is a day old or there was none, or the kept answer is older than the running release, which asks once; the attempt's time is kept before the child runs, no other event starts one, and COHERENCE_NO_UPDATE_CHECK, CI and DO_NOT_TRACK each start none.
  protects: refreshLatest
  chokepoint: versionCommand
  over: every hook event, each of the three refusals, a first session start, another within the day, and one a day later
  via: the check of the newest version starts detached at a session start at most once a day, and never under COHERENCE_NO_UPDATE_CHECK, CI or DO_NOT_TRACK
  because: the network never runs in a hook's own time: the tool hooks hold a 3 s budget and a session start the user waits on; a request a day is what the answer is worth, and an adopter or CI that wants none says so with one variable; the registry is asked only by refreshLatest, which only the version verb reaches, so no hook can call it in its own time
  refuted: left the spawned check referenced, so the hook's process waits for it -> "the check of the newest version starts detached at a session start at most once a day, and never under COHERENCE_NO_UPDATE_CHECK, CI or DO_NOT_TRACK" went red in version.test.ts on its own assertion (the hook never holds the child); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- a failed update check keeps the last answer: A registry request that fails or answers no version is dropped: the last answer and when it came stay, only the attempt's time moves, and coherence version names the newest published version with when the registry said so, the attempt that got no answer, and whether the check is on.
  over: no answer yet, an answer of 1.6.0, a later failed request, and the check off under CI
  via: a failed fetch keeps the last answer, and version says when the registry last answered and when a check got none
  because: a laptop offline at a session start would otherwise forget a newer release it already knew of, and a check that fails in silence leaves no one able to tell an up-to-date install from a check that never reaches the registry
  refuted: kept only the attempt's time after a failed request, dropping the last answer -> "a failed fetch keeps the last answer, and version says when the registry last answered and when a check got none" went red in version.test.ts on its own assertion (the failure is dropped; only its time is kept); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- an answer older than the running release is not the latest: When the registry's kept answer is older than the version running (the day's check answered before this release was published), coherence version says the running version is newer than the registry's last answer, names that answer and when it was given, and says the next session start asks again while the check is on; it never presents that answer as the latest or the running version as current by it, the session start names no update from it, and the next session start asks the registry again once for that release, its day not yet out.
  over: a running 1.6.0 with a kept 1.5.2 from before its release, the same with CI set, a kept answer equal to the running version, and session starts within the day over a kept answer as new as the running release, one older, and one older already asked by this release
  via: a release newer than the registry's last answer is never told that answer is the latest, and the next session start asks again once
  because: PostHog upgraded to 1.6.0 and coherence --version printed "latest published: 1.5.2, as the registry said 2026-10-08T10:09:19.268Z; this is current": the day's check had kept its answer from before 1.6.0 was published, and the line called a stale answer the latest; an answer older than the release asking can only be stale or a checkout ahead of the registry, so it is asked again once per release, never every session
  refuted: skipped the branch for an answer older than the running version, so it fell through to "this is current" -> "a release newer than the registry's last answer is never told that answer is the latest, and the next session start asks again once" went red in version.test.ts on its own assertion (the stale answer is not presented as the latest); restored byte for byte, green batched and alone; and dropped the older-than-running clause from updateCheckDue, so only the day's interval asks again -> the same test went red on its own assertion (an answer older than the running release is asked again); restored byte for byte, green batched and alone (2026-10-09)
  kinds: none
- the version and help flags answer at the top level: --version, -v and the version verb print the running version and where it is, and --help, -h and the help verb print the usage on stdout, each exiting 0.
  over: each of the six spellings, run as a command
  via: --version, -v, version, --help, -h and help answer at the top level
  because: --help printed "unknown verb" and there was no --version, so an adopter had no way to ask which Coherence they had; the usage names npx --no -- coherence, since npx takes a --version given before -- as its own
  refuted: dropped -v from the version spellings -> "--version, -v, version, --help, -h and help answer at the top level" went red in version.test.ts on its own assertion (-v: unknown verb "-v"); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- the README's setup installs the latest release: Every install of @posthog/coherence the README's setup prompts carry asks for @latest, never a version or a range, no example in the README shows a version of Coherence, the prompts invoke Coherence as npx --no -- coherence and never as npx --no coherence, and they name pnpm's minimumReleaseAgeExclude.
  over: the README's quick, full and monorepo setup prompts and its examples
  via: the README's setup installs Coherence's latest release and names no version, invoked through npx --no --
  because: a version written into the README goes stale at the next release unless someone bumps it by hand, and the floor it held (a release-age setting once installed 1.1.1, which lacks practices, with nothing failing) is kept another way: @latest names the newest release, the prompt has pnpm's release-age setting exempt Coherence, and a session start says when a newer release is published than the one running
  kinds: none
- feed injects subjects only: At prompt and tool boundaries the peer feed injects the subjects of records other sessions wrote since this session's cursor, twelve at most with a count of the rest and the command that shows them whole; a full record is never injected.
  over: every record another session wrote after the cursor, at every UserPromptSubmit and PostToolUse
  via: the peer feed injects subjects of other sessions' records since the cursor, capped, never full records
  because: subjects carry the signal and the journal carries the text; a boundary that injected whole records would spend the session's context on other sessions' reasoning at every tool use, which is what the reference's boundary hooks did and why they were retired
  crossing: record -> reading
  refuted: made the feed inject each record's timeline lines instead of its subject -> "the peer feed injects subjects of other sessions' records since the cursor, capped, never full records" went red in hook.test.ts; restored, green (2026-09-17)
  kinds: output
  checklist: destination-confinement dismissed: one destination, the host's additionalContext, and no redirect
  checklist: redaction declared as feed injects subjects only
  checklist: commit-ordered-effects declared as cursor advances after the print
  checklist: circuit-breaker-policy dismissed: the feed reads local files; no dependency is sampled
  checklist: declared-target-coverage dismissed: one host reads the injection, not a registry of targets
- feed carries two kinds: The feed's peer lines inject a peer's decisions and a peer's escalations, and no other verb; a stopped subagent's return is the one block that lists every kind its subagent recorded.
  over: every record kind a peer can write, at every boundary event
  via: the peer feed injects a peer's decisions and escalations and no other kind
  because: the lexicon names decision subjects, and an escalation heads every read: a question standing before a human changes what a peer should do next, so a session that met one only at its own start would act past it for a whole cycle. Every other verb is the journal, one command away, and injecting all eleven at every tool use spends the session's budget on what nobody asked for
  crossing: record -> reading
  refuted: injected the subject of every record kind, so a peer's conjecture, defect, unable, retraction and resolution rode into the context too -> "the peer feed injects a peer's decisions and escalations and no other kind" went red in hook.test.ts, seven records where two were asserted; restored, green (2026-09-18)
  kinds: output
  checklist: destination-confinement dismissed: one destination, the host's additionalContext, and no redirect
  checklist: redaction declared as feed injects subjects only
  checklist: commit-ordered-effects declared as cursor advances after the print
  checklist: circuit-breaker-policy dismissed: the feed reads local files; no dependency is sampled
  checklist: declared-target-coverage dismissed: one host reads the injection, not a registry of targets
- another agent under the session is a peer: For the main thread, a record of its own session written under another agent's name is a peer's, so a subagent that wrote under its coordinator's session id still reaches the coordinator's feed; the main thread's own records never do, and a subagent's reader keeps the session rule.
  over: the coordinator's feed with records of its own session under its own name and under another agent's name
  via: the main thread's feed counts a record of its own session under another agent's name as a peer's
  because: subagents in one coordinated session wrote their decisions under the coordinator's session id, as the prompt that spawned them said to, and the feed filtered every one out as the coordinator's own; the coordinator saw them only because each subagent's report happened to list them
  crossing: record -> reading
  kinds: none
- a stopped subagent returns what it recorded: When a subagent's stop goes through, every record it made (under its own session, or under its coordinator's session and another agent's name since it began) is listed, whole list, uncapped, at the coordinator's next prompt or tool boundary, once: the block leaves only after it reached the host, and the peer lines that follow never repeat a record it showed.
  over: a subagent that recorded more decisions than the feed's cap, a conjecture, and a record under its coordinator's session, stopping, then the coordinator's boundaries before and after a print
  via: a subagent that stops returns every record it made to its coordinator's next boundary, once, uncapped
  because: a coordinator that spawns subagents answers for what they decided, and a subagent's report is prose that can leave a decision out; the return is the journal's own account of what the subagent recorded, put before the coordinator whether or not the report named it
  crossing: record -> reading
  kinds: output
  checklist: destination-confinement dismissed: one destination, the coordinator's additionalContext, and no redirect
  checklist: redaction dismissed: subjects only, as the feed, never a full record
  checklist: commit-ordered-effects declared as a stopped subagent returns what it recorded
  checklist: circuit-breaker-policy dismissed: the return reads local files; no dependency is sampled
  checklist: declared-target-coverage dismissed: one host reads the injection, not a registry of targets
- cursor advances after the print: The feed cursor moves past the records a feed covered only after that feed was handed to the host: rendering alone moves nothing, the hook hands the advance back to the command line, which commits it only once its stdout write succeeded, and an unprinted feed is shown again.
  protects: writeCursor
  chokepoint: src/journal/feed.ts
  over: every feed rendered for a session, at every boundary event, through the library and through the command line that prints it
  via: the feed cursor advances only after the feed is printed: rendering moves nothing, and the CLI commits only once its stdout write succeeded
  because: a cursor moved before the print would let a hook that failed between render and output swallow what peers recorded; the advance is the commit, and it follows the effect it records, so it belongs to the one place that knows the write succeeded; the cursor is written only inside the feed module, whose commit the command line calls, so no hook can move it before the print
  crossing: harness -> record
  refuted: committed the cursor inside runHook, before the command line had written stdout -> "the feed cursor advances only after the feed is printed: rendering moves nothing, and the CLI commits only once its stdout write succeeded" went red in hook.test.ts: with the host's end of the pipe closed the cursor had moved and the host had nothing; restored, green (2026-09-17)
  kinds: state
  checklist: revalidated-permission dismissed: no permission is involved in moving a cursor
  checklist: separation-of-duties dismissed: one session moves its own cursor and nobody else's
  checklist: legal-state-succession declared as cursor advances after the print
  checklist: supersession-safety dismissed: the cursor is one value per session, replaced only by a later one
  checklist: worker-fencing dismissed: no two workers share a cursor; it is keyed by session
  checklist: commit-ordered-effects declared as cursor advances after the print
  checklist: resumption-coverage dismissed: a session that restarts keeps its cursor and resumes where it looked last; a session that never had one starts at the latest record by design
- the order rides with orient and regulate: The start prints the active order the session owns with its objective, success, boundary, and the rule that maintenance outside the boundary is not this session's to do, nudges an open one toward activation; the stop reminds that an active order is closed with work close; neither ever refuses.
  over: every start and stop event, against every work order the session owns
  via: orient prints the active order a session owns with the boundary rule, nudges an open one, and regulate reminds that work close ends it
  because: an order nobody reads back is the reference's failure again; the moments a session reads its heading and its debt are the moments the order must be in view, and the boundary rule is what keeps 14 of 33 reference records about a wall from recurring as nags about maintenance outside the assignment
  crossing: record -> reading
  refuted: made workBlock print nothing whatever the session owned -> "orient prints the active order a session owns with the boundary rule, nudges an open one, and regulate reminds that work close ends it" went red in hook.test.ts; restored, green (2026-09-17)
  kinds: read
  checklist: scoped-reads declared as the order rides with orient and regulate
  checklist: redaction dismissed: the order is shown whole; objective, success, and boundary are the point
- candidates come from names: A vocabulary candidate comes only from a name: from code, a declared or exported name, and only when prose writes it as words or it spans components; from prose, a name written as a name that recurs. A local identifier, the words and n-grams of a split identifier, a string, a regular-expression fragment, a path, an id, and a punctuation-bearing token are never candidates.
  over: every code and prose line of the corpus, with declared names, locals, split identifiers, fragments, paths, work-order and decision ids, hashes and UUIDs
  via: a code identifier is never a candidate unless it is declared and prose recurs it; ids, paths and fragments never are
  because: the old reading split every identifier into words and n-grams and offered 4,807 candidates, most of them the language's words (root, sync, map, deep equal) and fragments (a z, .venv/bin/python); a count that size is skipped, so the few real undefined concepts were never read. Code and prose are different populations: code names things for the machine, prose names them for the reader, and only a name both share is vocabulary
  crossing: project-source -> reading
  refuted: counted any identifier assigned on a code line as declared, so the local tallyMarks became a candidate from its split words -> "a code identifier is never a candidate unless it is declared and prose recurs it; ids, paths and fragments never are" went red in vocabulary-signal.test.ts; restored, green (2026-09-23)
  kinds: none
- well-known names need no definition: A well-known name (the curated list, the config's wellKnown, the project's own name) and a name the lexicon already declares or lists under not: is never a candidate, while a common word written as a project's proper noun, or a capitalized-only well-known word used lowercase in a project sense, still is.
  over: every candidate the corpus nominates, against the shipped list, the config, the project's name, every concept, alias, instance, property and not: entry of both layers
  via: well-known names, the project's own name and the lexicon's not: names are never candidates, while a common word written as a project's proper noun still is
  because: Python, Pyright, Chrome and the project's own name carried the old list's top and no definition could make them less ambiguous; but the fear of ambiguity lives exactly where a common word takes a project sense (Mnemion's hive; Coherence's scope, core, run, session), so the skip must never reach those
  crossing: project-source -> reading
  refuted: dropped the well-known check from nomination, so Kubernetes, Postgres, the config's Zanzibar and the project's own name were offered as candidates -> "well-known names, the project's own name and the lexicon's not: names are never candidates, while a common word written as a project's proper noun still is" went red in vocabulary-signal.test.ts; restored, green (2026-09-23)
  kinds: none
- the retired lexicon file is refused with its migration: A project whose lexicon file or config key still carries the concept's retired name fails every command that loads it, with the one-line migration; the retired name is never read as a fallback, and Coherence's lexicon supplies the retired name as data.
  over: every retired single-word name Coherence's lexicon records for the lexicon concept, as a root file with no lexicon.json and as a coherence.config.json key
  via: a project carrying its lexicon under the retired name is refused with the one-line migration, and the old name is never read
  because: the owner ruled the rename once, everywhere (d-cb376a86); an adopter left on the old file name would otherwise read no domain lexicon at all and pass every check silently, and a fallback that kept reading the old name would leave two names for one file standing forever
  crossing: project-source -> reading
  refuted: dropped the retired-file refusal from projectLexiconPath, so a project on the old file name read no domain lexicon -> the totality oracle went red; restored, green (2026-09-23)
  kinds: none
- rulings recorded under the retired verb still count: A sense review or an applied proposal recorded before the rename, under the retired verb, keeps its ruling and still counts as applied; the verb is matched by the ruling's shape, not by name.
  over: every structured review and apply decision in the journal, whichever verb it was written under
  via: rulings recorded under the retired verb still count: the journal is read as written
  because: the journal is append-only, so the records written before the rename cannot be edited to the new verb; a reader that matched only the new verb would silently reopen every settled sense and let an applied proposal be applied twice
  crossing: record -> reading
  refuted: matched sense reviews by the new verb's name only in lexicon-coverage.ts, so a review recorded under the retired verb lost its ruling -> the totality oracle went red; restored, green (2026-09-23)
  kinds: none
- sense review only where meaning is at risk: A known word's use asks a sense review only when its meaning is at risk: the name has more than one recorded sense, a name rejected for that concept sits on or beside the line, or a Coherence concept an adopter's code declares is written where Coherence's grammar speaks (a record, a spec's or practice's grammar); an ordinary use of a defined word asks nothing.
  over: every context of every known term, across prose, code and records, in a project with its own lexicon and in Coherence itself
  via: sense review is asked only where meaning is at risk: more than one recorded sense, a rejected name beside the use, or a Coherence concept an adopter's code declares written where Coherence's grammar speaks
  because: the old reading asked a review of every new or changed line that used a known word, 8,330 contexts on this repository, so every edit mentioning run or work order grew a pile nobody could settle; a review is worth asking only where two meanings can meet
  crossing: project-source -> reading
  refuted: put a Coherence concept at risk wherever the adopter's code declares it, whatever text the use is in, so staff's own notes on its scope() awaited review -> "sense review is asked only where meaning is at risk: more than one recorded sense, a rejected name beside the use, or a Coherence concept an adopter's code declares written where Coherence's grammar speaks" went red in vocabulary-signal.test.ts; restored, green (2026-10-08)
  kinds: none
- an adopter's code names its own sense: In an adopter, a Coherence concept's name its code declares (a Python class Config, run(), a TypeScript type Spec, Scope or Step) is the project's sense in its code, its domain prose and its specs' and practices' sentences, and asks no review there; only text Coherence reads as its own, a journal or work record and a spec's or practice's grammar (its headings, property keys and checklist shapes, as the lexicon check reads them), puts that sense at risk, since there Coherence's sense is written too. In Coherence's own repository its names are the domain and nothing here applies.
  over: every Coherence concept an adopter's code declares, Python and TypeScript, used in that code, in prose, in a spec bullet's statement and property values, in a spec heading, and in a journal record
  via: a Coherence name an adopter's code declares is the project's own sense: its code, its domain prose and its specs' sentences ask nothing, its specs' grammar does
  because: Coherence tells every session that its names describe the tool and the project's names describe its domain, and that inside the project the project's sense wins, while coverage flagged every Coherence name an adopter's code declared as a sense at risk that only a person could settle; one adopter renamed seven of his own identifiers to escape it. The same boundary the lexicon check already draws for Coherence's rejected names (text written to Coherence: records and spec grammar, advisory there) is where a domain name and Coherence's can meet: a record's prose may mean either, and a spec heading such as ## structure is Coherence's section beside the project's Structure type. The config file is left out, since its values are the project's commands and paths (a test command's run)
  crossing: project-source -> reading
  refuted: put a declared Coherence name at risk in any use of its component instead of only a use in a record or a spec's grammar (atRisk took here[0] for the written use) -> "a Coherence name an adopter's code declares is the project's own sense: its code, its domain prose and its specs' sentences ask nothing, its specs' grammar does" went red in vocabulary-signal.test.ts; restored, green (2026-10-08)
  kinds: none
- a declared name's ruling outlives new uses: A sense review of a Coherence name an adopter's code declares is keyed to the term, its lexicon entry and the component, not to the content of its uses, so a later record or spec heading using the same name keeps the ruling; a change to the concept's definition still reopens it, and settling it as confirmed or not-domain still takes a person's --human acknowledgement.
  over: a declared-name context ruled not-domain, then a new journal record using the same name in the same component; the same ruling attempted without --human
  via: a ruling on a Coherence name an adopter's code declares holds for its component: a new use of the same name does not reopen it, and settling it still needs a person
  because: the evidence key digested every use's file content, so each new record or edited spec reopened a question a person had already answered, and the adopter met the same ruling again with every use; the question a declared name raises is whether this project's word is Coherence's, which new uses do not change. The ruling keeps its --human acknowledgement because, keyed this way, it now silences the name in that component for good, and whether the project's word is the tool's is the domain owner's call, not the call of the agent that wrote the ambiguous record; an agent may still record deferred or defect, or reword prose it can edit
  crossing: record -> reading
  refuted: keyed a declared-name context's evidence to its uses' content again, as for every other context -> "a ruling on a Coherence name an adopter's code declares holds for its component: a new use of the same name does not reopen it, and settling it still needs a person" went red in vocabulary-signal.test.ts (the evidence moved with the second record); restored, green; and let not-domain settle without --human in lexicon-maintain.ts -> the same test went red (missing expected rejection); restored, green (2026-10-08)
  kinds: none
- no totals are injected: No hook injection carries a total: orient names the ranked recurring terms that lack a definition and the senses at risk, a handful at most, or says nothing; regulate names only what this session introduced.
  over: every SessionStart, SubagentStart, PostToolUse and Stop injection, with nothing owed, something owed at the start, and something introduced during the session
  via: no hook injection carries a total: orient names the ranked terms or says nothing
  because: a number nobody can act on trains an agent to skip the line it sits in, and the vocabulary line had become the one every session skipped; a short named list is something to do, and silence when nothing is owed keeps the line worth reading
  crossing: project-source -> reading
  refuted: put the old Lexicon coverage totals line back at the head of orient's vocabulary signal -> "no hook injection carries a total: orient names the ranked terms or says nothing" went red in vocabulary-signal.test.ts; restored, green (2026-09-23)
  kinds: output
  checklist: destination-confinement dismissed: one destination, the host's additionalContext or systemMessage, and no redirect
  checklist: redaction dismissed: only terms and component names are printed, never a use's text
  checklist: commit-ordered-effects declared as cursor advances after the print
  checklist: circuit-breaker-policy dismissed: the reading is local files; no dependency is sampled
  checklist: declared-target-coverage dismissed: one host reads the injection, not a registry of targets
- regulate names the terms the session made recur: The per-tool vocabulary line names only a use whose sense an edit put at risk; a term an edit makes recur without a definition is held, unsaid, and regulate names the session's held terms together at the stop, in one line with the declare-or-alias command; the stop marks them delivered once the line reached the host, so the next prompt carries the stop's line and names none of them again, and an ordinary edit that uses a known word says nothing.
  over: every PostToolUse after a session's baseline: an ordinary edit, an edit using a defined word, two edits that each make a new undefined term recur, the stop after them, and the prompt after the stop
  via: an edit is silent on the terms it makes recur: regulate names the session's together at the stop, once, with the declare-or-alias command
  because: during adoption the per-edit line fired on almost every spec edit, one term at a time as each crossed the threshold (browser, account, page on PostHog's praetorium adoption), so the line was noise at the tool use and the terms were never settled together; the stop is where the session looks back over its work, and one line there names them all once
  crossing: project-source -> reading
  refuted: let the full-reading edit path keep the unresolved changes it found, so the edit said its terms again -> "an edit is silent on the terms it makes recur: regulate names the session's together at the stop, once, with the declare-or-alias command" went red in vocabulary-signal.test.ts on its own assertion (the edit that made rebate recur is silent); restored byte for byte, green; and made the stop's delivery mark nothing, so the next prompt named the terms again -> the same test went red (what the stop named is not named again); restored byte for byte, green batched and alone (2026-10-08)
  kinds: output
  checklist: destination-confinement dismissed: one destination, the host's additionalContext, and no redirect
  checklist: redaction dismissed: only terms and component names are printed, never a use's text
  checklist: commit-ordered-effects declared as cursor advances after the print
  checklist: circuit-breaker-policy dismissed: the reading is local files; no dependency is sampled
  checklist: declared-target-coverage dismissed: one host reads the injection, not a registry of targets
- a held term reaches the next prompt: A term an edit held for the stop that no stop named, because the session never stopped cleanly, is named at the session's next prompt with the declare-or-alias command, once; the held terms are kept apart from the baseline, so a prompt over an unchanged tree reads a few names, never the session's whole reading, and a held list that cannot be read is said.
  over: an edit that makes a term recur, a prompt with no stop between, and the prompt after it
  via: a term an edit held reaches the next prompt when no stop named it, once
  because: a host interrupted mid-turn runs no stop hook, so a finding held for regulate alone would be lost to the session that made it; the next prompt is the next boundary the agent reads, as it is for what a stop carries
  crossing: project-source -> reading
  refuted: made the prompt read no held terms -> "a term an edit held reaches the next prompt when no stop named it, once" went red in vocabulary-signal.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-08)
  kinds: output
  checklist: destination-confinement dismissed: one destination, the host's additionalContext, and no redirect
  checklist: redaction dismissed: only terms are printed, never a use's text
  checklist: commit-ordered-effects declared as cursor advances after the print
  checklist: circuit-breaker-policy dismissed: the held list is a local file; no dependency is sampled
  checklist: declared-target-coverage dismissed: one host reads the injection, not a registry of targets
- coverage honors the config's bounds: The vocabulary corpus never enters a folder the config's ignore list names, by name or by path, through the same rule every other walk applies (underIgnored in project-files.ts); the journal's and work's records are read even when the config ignores .coherence.
  over: every file and folder the corpus walk meets, in a project whose config ignores a large folder by name, a nested folder by path, and .coherence
  via: coverage reads only inside the config's bounds: a folder the ignore list names is never entered, and the journal's records still are
  because: on a PostHog subsystem adoption whose config bounds the reading to one subsystem, coverage read 6,004 files of the whole monorepo in about 32 seconds and once crashed there on an over-long string, while the spec walker, mass and the interface readings all stayed inside the bounds; a vocabulary reading of code the adoption excluded offers the monorepo's names as the subsystem's. The records stay in because they are the project's own words about its work, whatever the code walks skip
  crossing: project-source -> reading
  refuted: made outsideBounds in check.ts answer false for every path, so the corpus walk entered every folder the config's ignore list names -> "coverage reads only inside the config's bounds: a folder the ignore list names is never entered, and the journal's records still are" went red in vocabulary-signal.test.ts; restored, green (2026-09-23)
  kinds: read
  checklist: scoped-reads dismissed: this invariant is the scope of the read itself; the corpus is the project's files inside the config's bounds, plus the records
  checklist: redaction dismissed: an ignored folder is reported by its path alone, and nothing under it is read
- the project's name is the config's: The project's name has one source (projectName in project-config.ts): the config's name, else a name a lexicon stored before any config named one, else the folder's; lexicon apply writes no project field into a lexicon it creates, and every reader of the project lexicon (its accepted and well-known names, the owner of its rejected names, its vocabulary heading) and Scope's masthead take that one name.
  over: a lexicon apply in a folder named otherwise than the config's name, a lexicon storing the folder's name under a config that names the project, one storing a name under a config that names none, and one storing none
  via: the project's name is the config's: lexicon apply stores no copy, readers of the lexicon take the config's name, and a stored one only where the config names none
  because: lexicon apply stored the folder's name as the lexicon's project, and the readers took that copy over the config's name, so an adopter whose checkout folder differed from his config's praetorium had the folder's name accepted and his own added to wellKnown by hand (praetorium.gg). A stored copy is still read where the config names nothing, so no existing lexicon is renamed under its owner
  crossing: project-source -> reading
  refuted: made loadProjectLexicons in project.ts take the lexicon's stored project over the config's name, so a stored copy of the folder's name outvoted the config's -> "the project's name is the config's: lexicon apply stores no copy, readers of the lexicon take the config's name, and a stored one only where the config names none" went red in src/lifecycle/project-name.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- lexicon setup reads only the paths it is given: lexicon coverage and lexicon draft given folders or files, each relative to the project root or absolute inside it, observe uses and nominate candidates only from the project's files under those paths, with the config's ignore list and the project-file rules still applied, and say which paths they read; a path outside the root or one that does not exist is refused, and with no paths the whole project is read as before.
  over: a coverage and a draft with no paths, with a relative folder, with an absolute folder inside the root, with a folder holding an ignored subfolder, and with a path outside the root, a parent path and a missing path
  via: coverage and draft read only under the paths they are given: candidates come from those files alone, the ignore list still holds, and a path outside the root or one that does not exist is refused
  because: onboarding's lexicon step read the whole tree, so an adopter who wanted the vocabulary of one subsystem (src/billing, docs) got every other folder's names as candidates beside it; a path the reading cannot honor is refused rather than read as nothing, so an empty draft never stands for a folder that was never read
  crossing: project-source -> reading
  refuted: made lexiconCoverage read every corpus file whatever paths it is given, dropping the underPaths filter on the files it reads -> "coverage and draft read only under the paths they are given: candidates come from those files alone, the ignore list still holds, and a path outside the root or one that does not exist is refused" went red in vocabulary-signal.test.ts on its own assertion; restored byte for byte, green (2026-10-07)
  kinds: read
  checklist: scoped-reads declared as lexicon setup reads only the paths it is given
  checklist: redaction dismissed: narrowing the paths prints nothing the whole-tree reading would not, and a use's secret value is redacted as it is there
- function words are never candidates: A preposition, conjunction, determiner, pronoun, auxiliary, particle or contraction fragment of English is never a vocabulary candidate, however prose writes it (backticked, as a heading word, or capitalized mid-sentence), and the stoplist holds every one of those closed classes.
  over: every word of every closed class in FUNCTION_WORDS and an independently written core of each, each written three ways on lines in every component
  via: function words are never candidates: every preposition, conjunction, determiner, pronoun and auxiliary is refused however prose writes it
  because: "via" surfaced as the third recurring undefined term on this repository, from every spec's via: line; a word that carries grammar has no sense a project could define, so offering it spends the reader's attention on a list it learns to skip
  crossing: project-source -> reading
  refuted: dropped the function-word refusal from nominate in lexicon-coverage.ts, so a function word written capitalized mid-sentence was nominated as a proper noun -> "function words are never candidates: every preposition, conjunction, determiner, pronoun and auxiliary is refused however prose writes it" went red in vocabulary-signal.test.ts; restored, green (2026-09-23)
  kinds: none
- orient names spec gaps: Orient names the spec gaps, entrances carrying outside or unknown trust in with no traced control, in one line under the spec block, from the recorded Structure reading while it still describes the tree; when it is stale or absent, a session start starts one reading in the background; when no reading was ever kept, orient says only that the gaps are not read yet and which command reads them, never a count; it counts the gaps the adoption baseline holds as still open, without naming them.
  over: no reading, a fresh reading, a stale one, and a baselined one, at SessionStart
  via: orient names the spec gaps in one bounded line from a recorded reading that still describes the tree, starts one background reading when it is stale or absent, says only that the gaps are not read yet when no reading was ever kept, and counts, without naming, the gaps the adoption baseline holds
  because: both outside adoptions left their route gaps open because nothing in the session's loop showed them (d-a1095ef2); with no reading nothing was traced, so a count would be a guess, but silence hid the gaps from every session that started before one was kept (df-84db9e4f); the owner ruled on 2026-09-28 that gaps baselined at adoption stay counted as open, because an A/B adoption baselined both its gaps on day one and orient then never mentioned them again
  crossing: project-source -> reading
  refuted: made orient silent again when every gap is held by the adoption baseline, in orientGapText -> the totality oracle went red; restored, green (2026-09-28)
  kinds: none
- orient names the last reading's gaps when it is stale: When the recorded Structure reading no longer describes the tree, orient names the gaps as that reading had them, derived with the current spec and runs, labeled as the reading before the latest changes with when it was taken, and never a gap the current spec visibly closes: an entrance that now declares guard: or control: none, carries trusted work in, or is no longer declared; the injection holds its budget.
  over: a reading made stale by a source edit, then a control: none, a guard:, a trusted trust: and a removed entrance in the current spec, and all of them closed, at SessionStart
  via: orient names the gaps as the last reading had them when it no longer describes the tree, labeled as the reading before the latest changes, with the current trust, and never one the current spec visibly closes by guard:, control: none or removing the entrance, within the start budget
  because: an adopting session ends by committing spec changes, so the next session always started on a stale reading and orient said nothing; the line never reached an agent in the A/B test (df-84db9e4f). The reading's component interfaces change slowly and the spec is read now, so the last reading with the current spec names what is still open, and a gap the spec answers is never named
  crossing: project-source -> reading
  kinds: none
- a session's stop refreshes the structure reading: At a session's Stop, when the recorded Structure reading no longer describes the tree, one reading of the tree the session leaves is started in the background and never waited on, even when nothing is left uncommitted; a SubagentStop starts none.
  over: a fresh reading at Stop, a committed spec change at SubagentStop, then at Stop
  via: the session's stop starts one background reading of the tree it leaves when the recorded one no longer describes it, and returns without waiting; a subagent stop starts none
  because: the tree a session leaves is the tree the next one starts on, so reading it at the stop gives the next session a fresh reading whenever it starts a reading's length later (df-84db9e4f); a subagent stops while its session still edits, and each of its stops would supersede the last one's reading
  crossing: project-source -> reading
  kinds: none
- a spec gap never refuses a stop: Regulate names the spec gaps a session touched, the handler files it changed and the untrusted entrances it declared with neither guard: nor control: none, and never refuses a stop for them.
  over: a session that changed nothing, one that changed a handler file of two gaps and declared an untrusted entrance, at Stop and at SubagentStop
  via: regulate names the gaps a session touched, a changed handler file and an untrusted entrance it declared, and never refuses a subagent stop for them
  because: a refusal is spent only on what the tool can prove is owed; no traced control is not a demonstrated bypass (d-127ab8e4), so a gap is named for the session that touched it and left to it and to the human
  crossing: project-source -> reading
  refuted: counted a touched spec gap as owed, so SubagentStop refused with exit 2 -> the totality oracle went red; restored, green (2026-09-25)
  kinds: none
- orient names undeclared entrances: Orient names the detected entrances no spec declares in one line beneath the spec gaps, detected now from the tree and the current spec, with no Structure reading and whether or not any entrance could be a gap: the count against what is detected, the folder holding the most with their rules, and the scaffold entrances command that proposes their bullets; never a list, and nothing when every detected entrance is declared.
  over: a project whose declared entrance carries an inside level and that never kept a reading, the same after one more entrance is declared, one with 400 undeclared server functions in one folder, and one with none undeclared
  via: orient names the undeclared entrances in one bounded line: the count against what is detected now, the folder holding the most, and the scaffold command that proposes their bullets, with no reading and no gap needed
  because: c-9941b95e: the replicated A/B adoption test (12 adoptions) showed the gap treatment closing gaps, while entrance coverage on praetorium.gg stayed at 11 to 14 percent in both arms, about 100 server functions and routes never declared, and no session transcript mentions an undeclared entrance; the only nudge was a passive count that named the first three by file order and rode on the recorded reading. No adoption baseline: the line is one bounded line whatever the count, and a baseline taken on day one would silence exactly the surface that stayed undeclared (as the owner ruled for baselined gaps on 2026-09-28)
  crossing: project-source -> reading
  refuted: made orient's entrance coverage line ride on the spec gaps again, silent when no entrance could be a gap, in gapBlock -> the totality oracle went red; restored, green (2026-09-28)
  kinds: none
- an undeclared entrance never refuses a stop: Regulate names the detected entrances no spec declares in the files the session changed, by file with three names at most and the scaffold entrances command for them, and never refuses a stop for them.
  over: a session that changed nothing, and one that added a server function to a file holding four undeclared, at Stop and at SubagentStop
  via: regulate names the undeclared entrances in the files a session changed, by file, and never refuses a subagent stop for them
  because: the session that writes an entrance holds what it means and who calls it, so its stop is when declaring it is cheapest, the in-loop nudge the gaps got (d-a1095ef2); detection is a scan and some of what it finds is no entrance, so an undeclared one is not proven owed and is left advisory
  crossing: project-source -> reading
  refuted: counted an undeclared entrance in a changed file as owed, so SubagentStop refused with exit 2 -> the totality oracle went red; restored, green (2026-09-28)
  kinds: none
- the project's hook voice composes over what each event says: A project's .coherence/hooks/<Event>.override.md replaces what that event would say and an empty one silences it, its <Event>.append.md follows the canonical text or the override, and an event with nothing of its own to say still speaks a declared file; no override reaches a refusal's reason, which an append only follows.
  over: every hook event, with nothing declared, an append, an override, both, an empty override, an override in place of the peer feed, and an override and an append on a refused subagent stop
  via: a project's hook voice composes over what each event says: an override replaces it, an empty one silences it, an append follows it, an event with nothing to say speaks a declared file, and a refusal keeps its reason
  because: text only one project can say (a house rule, a build hazard, how that project wants a session to start) belongs in the project's own files, not in the canonical text every adopter receives (d-d884e343, in the reference); the reference let a project shape each event this way and the rebuild dropped it without a record. A refusal is enforcement, so a project may speak after it but never replace or silence it, and a feed the override replaced never reached the host, so its cursor stays
  crossing: project-source -> reading
  refuted: made composeVoice ignore the override, so the canonical text was always the base -> the totality oracle went red in hook.test.ts; restored, green (2026-09-28)
  kinds: output
  checklist: destination-confinement dismissed: the text goes to one destination, the host's additionalContext, systemMessage or stderr, and follows no redirect
  checklist: redaction dismissed: the project's own text is shown as the project wrote it; nothing in it is designated sensitive
  checklist: commit-ordered-effects declared as cursor advances after the print
  checklist: circuit-breaker-policy dismissed: two local files are read; no dependency is sampled
  checklist: declared-target-coverage dismissed: one file of each kind per event, not a registry of targets
- a hook voice file stays inside the root: A hook voice file is read only where its real path lies inside the project root; a file, or a folder above it, that links outside is named as not read and never followed, an unreadable one is named, and in both cases the event's canonical text stands.
  protects: HOOK_VOICE_DIR
  chokepoint: voiceFile
  over: a file linked outside the root, the hooks folder linked outside it, a link that stays inside it, and a folder where the file should be, at SessionStart
  via: a hook voice file whose real path leaves the project root is named as not read and never followed
  because: the hook reads these files inside every session from the tree it was installed for, and a link can point anywhere; a hook that followed one would inject a neighbouring tree's text, or a secret, as the project's own words. A torn file costs the project its text for that event, never the session, and the line saying so keeps the loss from being silent; the voice folder is reached only by voiceFile, which follows a link only to see where it leads, so no other reader can follow one out
  crossing: project-source -> reading
  refuted: dropped the within check in voiceFile, so a file whose real path left the project root was read -> the totality oracle went red in hook.test.ts; restored, green (2026-09-28)
  kinds: read
  checklist: scoped-reads declared as a hook voice file stays inside the root
  checklist: redaction dismissed: a file that is not read is named by its path under the root alone, never its target or contents
- a fired practice is delivered before the act: When the tool use about to run fires a practice's trigger, PreToolUse delivers the practice whole on its first firing at that version in the session and one line after, and never blocks the tool.
  over: a command that fires a practice, the same command again, another session, and a command that fires nothing
  via: PreToolUse delivers a fired practice whole once per version per session, then one line, and never blocks
  because: the steps that slip come first (count the stores before a merge, measure the budget before applying), so delivery after the act is too late; whole once and one line after keeps the injection affordable; a refusal would train a session to route around the practice
  crossing: project-source -> reading
  refuted: made practiceContext forget earlier firings, so every firing delivered the practice whole -> "PreToolUse delivers a fired practice whole once per version per session, then one line, and never blocks" went red in practice.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: output
  checklist: destination-confinement dismissed: the practice goes to one destination, the host's additionalContext
  checklist: redaction dismissed: a practice is the project's own method, shown whole by design
  checklist: commit-ordered-effects declared as cursor advances after the print
  checklist: circuit-breaker-policy dismissed: practice files are read locally; no dependency is sampled
  checklist: declared-target-coverage dismissed: one host reads the delivery, not a registry of targets
- a fired practice not enacted is owed: Regulate names each practice that fired in the session with no enactment since, with the command that records it, and never refuses a stop for it.
  over: a subagent stop after a firing, and a stop after the enactment
  via: regulate names a practice that fired with no enactment since, advisory, and never refuses a subagent stop for it
  because: advisory for the reason d-f780c7b9 gives for open requirements: refusing the stop would train a session to fabricate an enactment; naming it at the stop with the shape filled in makes the honest record the cheapest one
  refuted: made practiceStopText treat every firing as enacted, so regulate named nothing owed -> "regulate names a practice that fired with no enactment since, advisory, and never refuses a subagent stop for it" went red in practice.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: none
- a shell command's writes are read from its words: The files a shell command writes are read from its text before it runs: output redirects, heredoc targets, tee, sed -i and perl -i, the destinations of cp, mv, install and ln (under -t or --target-directory, each source's name inside that folder), the sources mv removes, and touch, truncate and rm, through a cd or pushd earlier in the line, a popd back, and a subshell whose cd stays inside it, with CRLF lines read as LF; quoting is kept per word, so a quoted path with brackets or parens is a path while an unquoted glob, variable or substitution is not; a quoted > or <<, a here-string, a heredoc's body, a variable, a substitution, a glob and a device name none.
  over: redirects of every form, heredocs with a redirect inside their body, a heredoc onto a quoted route path with brackets and parens, a here-string before a later write, a quoted <<, CRLF lines with a heredoc, tee, sed -i in GNU and BSD form, perl -pi, cp and mv, mv sources, cp -t, mv --target-directory= and install -m -t, touch and rm, a cd to a folder and to a variable and a cd after that, a cd inside a subshell, pushd and popd, a quoted >, a variable inside double quotes, a program writing from its own code, and a Codex shell argv
  via: a shell command's written files are read from its words: redirects, heredocs, tee, sed -i, perl -i, cp and mv destinations and mv sources, -t target folders, touch and rm, through cd, pushd and subshells, quoted brackets and CRLF, and never a quoted > or <<, a here-string, a heredoc body, a variable or a device
  because: agents write files through the shell as often as through edit tools, and the ai-chatbot adoption wrote its entry spec with cat > ... <<EOF; a reading that missed it would leave an edit-triggered practice silent and the chokepoint check at the edit unrun, while a guessed path would fire them on files nobody wrote
  refuted: dropped the folder restore at a subshell's ), so a cd inside ( ... ) leaked out of it -> "a shell command's written files are read from its words: redirects, heredocs, tee, sed -i, perl -i, cp and mv destinations and mv sources, -t target folders, touch and rm, through cd, pushd and subshells, quoted brackets and CRLF, and never a quoted > or <<, a here-string, a heredoc body, a variable or a device" went red in shell-writes.test.ts on its own assertion (sub/b.txt for b.txt); restored byte for byte, green batched and alone (2026-10-06)
  kinds: none
- a shell write is an edit: writtenFiles counts the files a shell command writes beside an edit tool's, resolved against the folder the command runs in and confined to the project root, so edit triggers and the chokepoint check at the edit see them.
  over: a heredoc onto a spec, a write from a subfolder, a write above the root, a command that writes nothing, and a reading tool
  via: writtenFiles counts a shell command's writes beside an edit tool's, resolved against the folder the command runs in and confined to the project
  because: one reader of written files serves both the practice triggers and revelation at the edit; resolving against the root instead of the command's folder would name the wrong file, and a path above the root is another project's
  crossing: harness -> reading
  refuted: resolved shell-written paths against the root instead of the folder the command runs in -> "writtenFiles counts a shell command's writes beside an edit tool's, resolved against the folder the command runs in and confined to the project" went red in shell-writes.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-06)
  kinds: none
- a tool that only reads is never a write: A tool host-tools.ts does not declare as writing files writes nothing, whatever path its input names, and routes by its cwd; only a shell command in its input is read for what it writes.
  over: Read, NotebookRead, Glob, Grep, LS, Codex's view_image and read_file, an MCP server's read_file, Artifact, memory_read, a tool no release has yet naming file_path, path and notebook_path, and an undeclared tool running a command that writes and one that writes nothing
  via: a tool not declared to write files writes nothing, whatever path its input names, unless a command in its input writes one
  because: the hook once kept a list of reading tools and counted every other tool as a write, so each new reading tool (view_image, an MCP read_file, Artifact publishing a file) fired edit checks and edit-triggered practices and put files it only read into the session's write trace, silently; an allow list of writers fails toward missing a write a new tool makes, which the test beside it names for every declared tool, never toward inventing one
  refuted: made writtenNames read file_path, notebook_path and path from any tool host-tools.ts does not declare, as the deny list did -> "a tool not declared to write files writes nothing, whatever path its input names, unless a command in its input writes one" went red in host-tools.test.ts on its own assertion (Read reads; it writes nothing); restored (cmp), green batched and alone (2026-10-11)
  kinds: none
- every tool that writes is matched and read: Every tool host-tools.ts declares as writing files, for each agent host, is one the PreToolUse hook install writes runs for (Claude Code's matcher is derived from the declaration; Codex runs every tool), and the file it writes is read from its input the way the declaration says it names it: a field, a patch body, or a shell command, under its own name or a namespaced one.
  over: every declared tool of Claude Code and of Codex, each spelling the file it writes its own way, and each under a namespace
  via: every tool that writes files is matched by the hook install writes for its host and has the file it writes read from its input
  because: the matcher, the tools that route by the files they name, and the hook's reading of a write were three hand lists that each had to name every writing tool, so a tool added to one and not another (PowerShell, Monitor) got no practice delivered before it ran and was routed by its cwd; one declaration they all derive from leaves nothing to keep in step
  refuted: wrote the Claude Code matcher by hand again as Bash|Edit|Write|MultiEdit|NotebookEdit -> "every tool that writes files is matched by the hook install writes for its host and has the file it writes read from its input" went red in host-tools.test.ts on its own assertion (PowerShell and Monitor unmatched); restored (cmp), green batched and alone (2026-10-11)
  kinds: none
- the read trace records only declared reading tools: The read trace records a file only for a tool host-tools.ts declares as reading, from the field the declaration names, and never for a tool that writes.
  over: every declared reading tool of both agent hosts, a write of the same file, and a reading tool naming its file in another field
  via: the read trace records a declared reading tool's file and no other tool's
  because: trace.ts kept its own copy of the hook's reading tools, three names against the hook's eight, while saying it was the hook's set; reading the one declaration leaves no copy to fall behind
  refuted: made readFileOf read file_path from any tool not declared as reading -> "the read trace records a declared reading tool's file and no other tool's" went red in host-tools.test.ts on its own assertion (a write is no read); restored (cmp), green batched and alone (2026-10-11)
  kinds: none
- a narrow PreToolUse matcher is named for reinstall: A Claude Code PreToolUse entry of Coherence's whose matcher leaves out a tool that writes files is named at every session start, one line per settings file with the tools it leaves out and the exact reinstall command, and the hook check says which tools it leaves out and to reinstall; a matcher at least as wide as the one install writes is never named so, and the reinstall replaces the entry rather than adding one.
  over: the matcher 1.7.0 wrote, a matcher widened to every tool, and the reinstall
  via: a PreToolUse matcher that leaves out a tool that writes is named by the check and at the session start with the reinstall, and a wider one is not
  because: the matcher is written into the adopter's settings, so upgrading the package leaves the earlier one in place until the hooks are reinstalled, and a tool it leaves out gets no practice before it runs with nothing said; an adopter who widened it chose to run the hook for more tools, which loses nothing and must not be asked of them
  refuted: made the session start judge a matcher against the five writing tools 1.7.0 knew, listed by hand -> "a PreToolUse matcher that leaves out a tool that writes is named by the check and at the session start with the reinstall, and a wider one is not" went red in install.test.ts on its own assertion (no line for the narrow matcher); restored (cmp), green batched and alone (2026-10-11)
  kinds: none

- a turn's instrument is warmed before its stop: A session start and every prompt start warming the instrument in the background and never wait for it; no other event does in a project at the folder holding the hooks (a nested project's first tool use is the other, under entering a nested project warms its instrument).
  over: SessionStart, UserPromptSubmit, PreToolUse and PostToolUse
  via: a session start and every prompt warm the instrument without waiting for it, and no other event does
  because: the stop regulates with the economy prediction, which needs the warm server; it idles out after five minutes, and every turn begins with a prompt, so warming there makes the stop find it loaded without the hook ever waiting on it
  refuted: stopped warming the instrument at a prompt -> "a session start and every prompt warm the instrument without waiting for it, and no other event does" went red in hook-speed.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-06)
  kinds: none
- regulate reports the prediction: A stop names the files the prediction found beyond what the session wrote and which of them it never read, advisory; nothing when the prediction found none.
  over: a prediction with read and unread files beyond the session's own, one with none, and no snapshot
  via: regulate names the files the prediction found beyond what the session wrote, and which of them it never read
  because: owner: the stop must regulate behaviour, not be skipped for speed; the prediction is computed at every stop, and a session that changed a file without reading what relies on it should hear so before it ends
  refuted: counted every predicted file as unread, whatever the session read -> "regulate names the files the prediction found beyond what the session wrote, and which of them it never read" went red in hook-speed.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-06)
  kinds: none
- practice delivery reads the practices light: PreToolUse reads no practice for a tool use that runs no command and writes nothing, and otherwise reads only the practice files git lists, each beside its spec and outside every ignored folder, which are the same practices the spec model holds.
  over: a paired practice, one beside no spec, one in an ignored folder, against the spec model's practices
  via: practice delivery reads the same practices as the spec model, through git's listing of practice files alone
  because: PreToolUse runs before every command and edit (every tool under Codex), and loading the whole spec model there cost about 0.34 s on this repository and 0.7 s on a 40,000-file one (df-f1b7e11a); delivery needs triggers, steps and versions, and the spec check is what holds the pairing
  refuted: dropped the pairing check from practice delivery -> "practice delivery reads the same practices as the spec model, through git's listing of practice files alone" went red in hook-speed.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-06)
  kinds: none
- a tool call's hooks spawn git a fixed number of times: PreToolUse and PostToolUse spawn git as often over a project of many components and practices as over a project of one.
  over: a command that fires a practice in each of one component and of six, at PreToolUse and at PostToolUse
  via: a tool call's hooks spawn git a fixed number of times, whatever the number of components and practices
  because: these two hooks run around every tool call, thousands a day, so a spawn per component or per practice there is paid on every one of them (df-f1b7e11a); a count of spawns holds under any load, where a timing alarm would flake
  refuted: asked git whether each practice's spec is tracked, one spawn per practice file -> "a tool call's hooks spawn git a fixed number of times, whatever the number of components and practices" went red in hook-speed.test.ts on its own assertion (PreToolUse 2 spawns against 7); restored byte for byte, green batched and alone (2026-10-07)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is a count of child processes per hook
  checklist: execution-budget declared as a tool call's hooks spawn git a fixed number of times
  checklist: memory-budget dismissed: the bound is on spawned processes, not on allocation
  checklist: circuit-breaker-policy dismissed: no dependency failures are observed
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
- an edit never stays silent about a check it could not make: When a chokepoint invariant an edit may touch could not be checked, the edit names it with the reason; only a value the spec writes as prose, which spec --check already reports, goes unnamed there.
  over: a touched invariant whose protected thing resolves to nothing, and one whose value is prose
  via: an edit says which chokepoint invariants it could not check, and stays silent only for a value the spec writes as prose
  because: a not-run verdict read as a clean edit: on a fresh server every check at the edit came back not run and nothing was said, so the alarm that should have fired on a bypass was quiet; a silent alarm is a vacuous check
  refuted: said nothing for a check the edit could not make -> "an edit says which chokepoint invariants it could not check, and stays silent only for a value the spec writes as prose" went red in hook-speed.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-06)
  kinds: none
- a tool hook over the latency budget says so: Every hook call's time is kept, counted from its process's start; a PreToolUse or PostToolUse over the latency budget (3 s unless the config declares one) names its own time in its own answer, regulate names the session's calls over it with what the tool hooks cost in all, and orient the last week's.
  over: a tool hook within the budget, one over it, a session and a week of recorded calls, and a config's own budget
  via: a tool hook over the latency budget says so in its own answer, and regulate and orient name the calls over it
  because: the tool hooks run around every tool call, so their time is paid over and over, and a call cycle that feels sluggish gets Coherence switched off, which loses every check at once; a count of git spawns guards the known shape, and the measured time catches what no count names
  refuted: counted a hook call's time from the call's own start, leaving out its process's start -> "a tool hook over the latency budget says so in its own answer, and regulate and orient name the calls over it" went red in stop-delivery.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: budget
  checklist: execution-budget declared as a tool call's hooks spawn git a fixed number of times
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on one hook call's time
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on time, not on allocation
  checklist: circuit-breaker-policy dismissed: a hook over the budget still answers; the alarm is the response
- a stop reaches the agent: A main-thread stop says each line once per session; a line naming a practice owed blocks the stop once, so the agent reads the reason, and anything else is shown to the user and carried into the next prompt's context.
  over: a stop with a practice owed, the stop the block causes, a stop with only advisory lines, the prompt after it, and a stop with nothing new
  via: a stop says each line once, blocks once for a practice owed, and carries the rest into the next prompt
  because: the host shows a stop hook's systemMessage to the user and never to the model, so regulate at a main-thread stop reached the one reader who could not act on it in the moment; repeating every line at every stop made it 2.6 KB of what had been said before
  refuted: held back only a stop the block itself caused, so a practice owed never reached the agent -> "a stop says each line once, blocks once for a practice owed, and carries the rest into the next prompt" went red in stop-delivery.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a practice fires where its command runs: A command trigger matches whole words of one simple command, never text inside a quoted argument or a heredoc's body; a command a cd took into another project is read against that project's practices, and its enactment is looked for in that project's journal; a command a cd took out of every project fires nothing, and no folder that is not a project is read for practices.
  over: a trigger word as a command, inside a quoted argument, inside a heredoc, after a cd into another checkout with its enactment recorded there, and after a cd into a folder that is no Coherence project
  via: a practice fires on a command's own words, in the project the command runs in, and its enactment counts there
  because: a practice fired on enact --trigger "command refute" and on the words of a heredoc, and a session whose commands ran in a second worktree was told at every stop that practices it had enacted there were owed, because the firing was kept by the session's root and the enactment by the worktree's journal
  refuted: read every command against the session's own root, wherever a cd took it -> "a practice fires on a command's own words, in the project the command runs in, and its enactment counts there" went red in stop-delivery.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  refuted: read a folder a cd landed in for practices whether or not it is a Coherence project -> "a practice fires on a command's own words, in the project the command runs in, and its enactment counts there" went red in stop-delivery.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- the coverage reading runs only when the text can have moved: A tool hook reads the vocabulary's coverage only after a tool use that wrote a project file, and a prompt only when git's changed and untracked files, with their sizes and times, differ from the session's last reading; the stop always reads in full.
  over: a read, a command that writes nothing, a write, two prompts over one tree, and a prompt after a file was added
  via: the vocabulary coverage reading runs at a tool hook only after a write, and at a prompt only when the tree moved
  because: the reading walks the whole corpus, 2.2 to 2.4 s on this repository, and it ran at every PostToolUse and every prompt, so each tool call cost about 3 s in hooks against a 3 s latency budget, the sluggishness that gets Coherence switched off; the hook latency alarm found it on its first day
  refuted: read the whole corpus at every PostToolUse again, write or none -> "the vocabulary coverage reading runs at a tool hook only after a write, and at a prompt only when the tree moved" went red in hook-speed.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: budget
  checklist: execution-budget declared as the coverage reading runs only when the text can have moved
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on how often one reading runs
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on time, not on allocation
  checklist: circuit-breaker-policy dismissed: a skipped reading is caught by the stop's full one
- a hook at the repository top answers for the nested project: With the host's settings at a repository's top and the only coherence.config.json in a folder below it, every hook event belongs to the project folder nearest to what it is about, the files a tool writes or else the event's cwd, and an event whose cwd is above exactly one project belongs to that one once the session has entered it; orient, practices, the checks and every record are that project's, and nothing is written at the top.
  over: a session start, an edit and a command, each with the session at the repository top of a repository holding one nested project and another team's spec and practice
  via: a hook at the repository top answers for the one project nested below it, from the event's cwd or the file it writes
  because: a monorepo adopts Coherence one folder at a time, and the host runs at the repository root, where its settings live; the hook took the folder holding the settings as the project, so orient counted another team's specs, their practices fired, the language server started on the whole repository (19.8 s for one edit on a fixture, past 180 s for a session start on PostHog), and .coherence was written at the top (df-0b68c987, df-7dd85e50, df-7fba7918)
  refuted: hookProject answered an event whose cwd is above the one nested project with the installation's own folder instead of that project -> "a hook at the repository top answers for the one project nested below it, from the event's cwd or the file it writes" went red in monorepo.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- an event outside every project is ignored: A tool event whose files, or whose cwd, lie outside every project nested below the hook's installation, and any event whose cwd does, answers nothing and writes nothing, before any spec model, corpus walk or language server; with a project at the installation's own root, every event is that project's as before.
  over: an edit and a write to another team's file with the session at the top, and a command, a shell write, a prompt and a stop with the cwd in another team's folder
  via: an event outside every project is ignored: no answer, nothing written, wherever the session started
  because: the rest of the repository is not the project's, and the hooks run around every tool call of every session in it; an event that is not the project's must cost one listing of where the projects are and nothing more, or adopting one folder slows every other team's work
  refuted: hookProject answered a tool event whose files lie outside every nested project with the installation's own folder instead of ignoring it -> "an event outside every project is ignored: no answer, nothing written, wherever the session started" went red in monorepo.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: budget
  checklist: execution-budget declared as an event outside every project is ignored
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on one hook call's work
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on what is read, not on allocation
  checklist: circuit-breaker-policy dismissed: an ignored event has no dependency to fail
- git paths are relative to the project root: Every file list Coherence asks git for in a project nested below the repository top, the stop's changed files, the economy's patch and query observed's changes, names the project's files relative to the project root and none of another folder's.
  over: a changed and an untracked file in the nested project, and a changed and an untracked file in another folder of the repository
  via: git paths in a nested project are relative to its root and never another folder's
  because: git diff --name-only names paths from the repository top while git ls-files names them from the cwd, so a nested project's stop read the whole repository's changes under the wrong prefix (df-f14bc626)
  refuted: changedFiles asked for the diff without --relative, so its paths were named from the repository top -> "git paths in a nested project are relative to its root and never another folder's" went red in monorepo.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a command at the repository top acts on the nested project: A command run at a repository's top, where no project encloses the cwd, acts on the one project nested below it, so the enact, decide and defect lines the hooks print are recorded in that project's journal; with no project below, or more than one, it acts where it stands, as before.
  over: the repository top with one nested project, a folder holding none, and a folder above two
  via: a command run at the repository top acts on the one project nested below it, and on the top when two are
  because: the hooks print commands the agent runs from the session's cwd, which in a monorepo is the repository top, and the walk up from there found no project and wrote a second .coherence at the top (df-4539bb14)
  refuted: projectRoot acted where the command stood when no project enclosed it, never on the one project below -> "a command run at the repository top acts on the one project nested below it, and on the top when two are" went red in monorepo.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- install from a nested project reaches where the host reads: hooks install run in a project nested below its repository's top writes the host's settings at the top, where a host launched at the repository root reads them, and in the project, where a session started there reads them, with the adopter's other settings kept in both and .coherence/.gitignore in the project alone; hooks --check and uninstall cover both.
  over: an install, a check and an uninstall run in a nested project whose repository top already holds the adopter's own settings
  via: hooks install from a nested project writes the host settings at the repository top and in the project, and its ignore file in the project alone
  because: install wrote the settings in the nested folder, where Claude Code launched at the repository root never reads them (it reads only the session's primary working directory's .claude/settings.json), so the hooks never fired in the usual monorepo session (df-7e5a7645)
  refuted: settingsRoots named the project folder alone, so install wrote no settings at the repository top -> "hooks install from a nested project writes the host settings at the repository top and in the project, and its ignore file in the project alone" went red in monorepo.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- orient waits for the project: A session whose hooks sit at a repository's top above a nested project hears one line at its start naming the project and nothing at a prompt, a stop, or a tool use outside it; the first tool use inside the project carries the project's orient, once per session, and every event after it is the project's; with the project at the folder holding the settings, orient arrives at the start as before.
  over: a start, a prompt, an edit and a command in another team's folder, and a stop, then two edits and a command at the top once inside, with the session at the repository top
  via: a session at the repository top gets orient once, at its first tool use inside the project, and nothing for work elsewhere
  because: hooks at a repository's top reach every engineer's sessions, and orient costs about 2k tokens and a second or more at every start; a session that only works on another product must hear nothing and pay one listing per event, and one that enters the project must get its vocabulary and standing at that moment (on PostHog the first in-project tool hook carrying orient took 1.4 s against the 3 s latency budget, d-6cdf018d)
  refuted: an event above the nested project answered as the project's whether or not the session had entered it -> "a session at the repository top gets orient once, at its first tool use inside the project, and nothing for work elsewhere" went red in monorepo.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: budget
  checklist: execution-budget declared as orient waits for the project
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on what one hook call reads and says
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on time and words, not on allocation
  checklist: circuit-breaker-policy dismissed: an unoriented event has no dependency to fail
- a personal install stays out of the committed settings: hooks install --local writes the host's personal settings at the repository top (Claude Code's .claude/settings.local.json, which it reads launched there or in any folder below), never the committed ones and never the project folder's, with .coherence/.gitignore in the project as before; hooks --check --local compares it, uninstall removes ours from it as from the shared settings, and a host with no personal settings file is refused.
  over: an install, a check and an uninstall with --local from a nested project, and an install with --local for a host that has none
  via: hooks install --local writes the host's personal settings at the repository top alone, and uninstall removes them
  because: in a monorepo the committed settings at the top reach every team's sessions, so one engineer adopting a folder must be able to wire the hooks for themselves without committing hook configuration for everyone
  refuted: settingsFile named the shared settings for --local, so the personal install wrote the committed file -> "hooks install --local writes the host's personal settings at the repository top alone, and uninstall removes them" went red in monorepo.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a registry routes events by its list: With a registry at the repository top, an event belongs to the listed leaf holding the file it writes, or else its cwd, the longest listed prefix winning, with no walk up; a cwd above two leaves belongs to the one the session last entered, and before it entered any a start there is answered by one line naming them; a leaf with no config of its own is a project with its records in its folder, and an event in no leaf, a folder holding a config the registry does not list among them, answers nothing and writes nothing.
  over: a start at the top, an edit in each of two leaves, a stop at the top after both, an edit in a stray configured folder and one in a folder outside both, and commands run in a leaf with no config
  via: with a registry, events from the repository top route to the leaf with the longest listed prefix, and anything in no leaf is ignored
  because: a repository that opts in leaves explicitly must not let a config someone left in another folder, or the registry's own file at the top, make that folder a project; the list is the one place adoption is decided
  refuted: hookProject skipped the registry and routed by the nearest config as without one -> "with a registry, events from the repository top route to the leaf with the longest listed prefix, and anything in no leaf is ignored" went red in registry.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  refuted: an event above several leaves stayed with the several answer, never the leaf the session last entered -> "with a registry, events from the repository top route to the leaf with the longest listed prefix, and anything in no leaf is ignored" went red in registry.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- an event outside every leaf costs no git: With a registry, a tool event whose files or cwd lie in no listed leaf spawns no git and writes nothing: the registry's list decides from one small read.
  over: an edit and a command in a folder outside every leaf, at PreToolUse and PostToolUse
  via: an event outside every leaf of a registry spawns no git and writes nothing
  because: the hooks at the repository top run around every tool call of every team; without a registry the outside answer costs a listing of the repository's configs, and with one the list is already known
  refuted: hookProject listed the repository's configs with git before routing by the registry -> "an event outside every leaf of a registry spawns no git and writes nothing" went red in registry.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: budget
  checklist: execution-budget declared as an event outside every leaf costs no git
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on one hook call's work
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on spawned processes, not on allocation
  checklist: circuit-breaker-policy dismissed: an ignored event has no dependency to fail
- adopt opts a folder in: adopt <folder> lists the folder in the registry at the repository top, creating it when there is none, keeping the file's indentation, key order and final newline, and prints the adopt practice as the next step; it refuses a path outside the repository or the top itself, a path that is no folder, one already listed, one inside a listed leaf or holding one, and a top whose config is a whole-repository project.
  over: a folder added to a registry, a registry created, and each refused path
  via: adopt lists a folder in the registry, keeping its layout, creates one when there is none, and refuses every bad case
  because: opting a leaf in is one edit to a shared file that people also edit by hand, so it must not reformat it, and every refusal names a state the routing could not answer for: nested leaves, a folder that is not there, or a whole-repository project silently turned into a registry
  refuted: adopt stopped refusing a folder inside a listed leaf -> "adopt lists a folder in the registry, keeping its layout, creates one when there is none, and refuses every bad case" went red in registry.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- install with a registry writes once at the top: hooks install in a repository with a registry writes the host's settings at the repository top alone, never a leaf's, and .coherence/.gitignore in each listed leaf, never at the top.
  over: an install run from a leaf with no config of its own
  via: hooks install with a registry writes the host settings once, at the repository top, and an ignore file in each leaf
  because: the registry's top is the one place a host launched at the repository root reads, every leaf is routed from there, and the top is no project, so a .coherence there would be a second store
  refuted: settingsRoots named the leaf beside the repository top under a registry -> "hooks install with a registry writes the host settings once, at the repository top, and an ignore file in each leaf" went red in registry.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- entering a nested project warms its instrument: The first tool use of a session inside a project nested below the folder holding the hooks starts warming that project's instrument in the background, beside the orient it delivers, and never waits for it; later tool uses there do not.
  over: the first and second tool use of a session at a registry's top inside one leaf
  via: the first tool use inside a nested project warms its instrument, once
  because: a session at a registry's top above several leaves has no start or prompt that belongs to a project, so nothing warmed the language server before the first edit's check; on PostHog that edit took 3.1 s cold against the 3 s latency budget, and 2.4 s once the entry had warmed it
  refuted: the first tool use inside a nested project delivered orient without warming its instrument -> "the first tool use inside a nested project warms its instrument, once" went red in registry.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a tool use that writes nothing pays only for its own budget at any size: Around a tool use that writes no file, a Read or an ls, PreToolUse and PostToolUse take no corpus read, no coverage reading and no spec model, read no project file but the config and, for a command, the practice files, and beside ten times the components, practices and history grow only in what each must name one by one: a command its practice files and the specs they pair with, PostToolUse the journal's file list and the feed's memo of it; every other count, through the work meter and at the file system, a read weighed by its bytes, a listing by its entries and a spawn by its output's bytes, does not grow at all, and a spawn whose work is the project's (git listing, searching or comparing the tree) is budgeted by count at both sizes: one practice listing for a command, none for the rest. The history grows inside its files as well as in their number, and its bytes are in no budget.
  over: a Read and an ls, at PreToolUse and at PostToolUse, over the sized fixture at 1× and at 10× (the same folder depth), after the session's start and its first command
  via: a tool use that writes nothing pays only for its practice files and the journal's file list, at 1× and 10×, and reads no corpus and no coverage
  because: these two hooks run around every tool call, and each of the three slowdowns that reached users was work that grew with the project on that path. A count holds under any load and at any size, where a timing flakes and misses scale; the meter counts what passes Coherence's doors, and the file system count, with listings weighed by what they return and spawns by what they print, catches what slips past them (a recursive walk or a glob is one call and the whole tree). A practice is delivered from its own text, so a command reads every practice file, small and few; the peer feed lists the journal's files and reads only those whose identity moved since its last look, so it never reads the history
  refuted: the reviewer's break, deliveryPractices walking the whole project with readdirSync recursive and globSync('**/*') at every command -> "a tool use that writes nothing pays only for its practice files and the journal's file list, at 1× and 10×, and reads no corpus and no coverage" went red in work-meter.test.ts on its own assertion (PreToolUse ls went over its budget by the walk's entries; the edit test went red on the same break); restored byte for byte, green batched and alone (2026-10-08)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on one hook call's work
  checklist: execution-budget declared as a tool use that writes nothing pays only for its own budget at any size
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on reads, spawns and readings, not on allocation
  checklist: circuit-breaker-policy dismissed: no dependency failures are observed
- an edit pays for the files it names and its budget at any size: An edit reads the files it wrote, the config, and the specs it must check against, through a listing of the specs alone, and no other project file, takes one coverage reading of the files it wrote and no spec model, and beside ten times the components, files and history grows only in the specs, the run files' list, the run index and the sites shard of the run file its check appends to, and the journal's list and the feed's memo, every read weighed by its bytes and the history grown inside its files as well as in their number; a spawn whose work is the project's is budgeted by count at both sizes, one practice listing before the edit and at most six after it (the written file asked of the project's files by the trace and by the check, the specs' listing by the check and by the reading, and the tree key's two listings), and one more when it names a protected thing, whose run asks whether the tree is dirty: wherever the file lies (a small component, a large one, the root, a file in no sub-component) and when it names a protected thing, whose chokepoint check runs over the touched invariant alone and records its entries ungraded, which the invariant floor never counts.
  over: an edit to a small component's source, a large component's note, the root README, a note in the root component, and a source edit that names a protected thing, at PreToolUse and at PostToolUse, over the sized fixture at 1× and at 10× with ten times the run and journal history, the session's own run file among it, and the lexicon
  via: an edit pays for the files it names, the specs and the history's file lists, at 1× and 10×, wherever the file lies and when it names a protected thing
  because: the edit hooks ran the coverage reading over the whole corpus, and then over the edited file's whole component (42 reads and 2,665 comparisons at 10× against 6 and 265 at 1× for a file in no sub-component), loaded the spec model and every run file at every write, and the check of a touched invariant loaded the whole model again. An edit now scans only the files it wrote against the vocabulary the last full reading kept, reads every spec (specs are small, and none of them is kept between calls, so none can be stale), and asks the run index for the files it wrote; a touched invariant is run from a model of that invariant alone. The vocabulary is judged on what the last full reading saw plus every edit since, so a name whose recurrence rests on files no hook saw change is named at the next prompt or stop, which read in full
  refuted: the reviewer's breaks, each at the top of editContext and each alone: loadRuns(root), loadJournal(root), twenty git grep -q spawns, every run file read with readSync, the session's own run file read whole with readSync, every run and journal file read whole through a FileHandle's readFile() (the asynchronous open's), and twenty sh -c "git grep -q; git ls-files | wc -c" with one grep -rq over the root -> "an edit pays for the files it names, the specs and the history's file lists, at 1× and 10×, wherever the file lies and when it names a protected thing" went red in work-meter.test.ts on its own assertion each time (the small component's edit went over its budget: the history's bytes for the reads, the project-sized spawns over the six allowed for the greps and the shells); restored byte for byte, green batched and alone (2026-10-08)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on one hook call's work
  checklist: execution-budget declared as an edit pays for the files it names and its budget at any size
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on reads, spawns and readings, not on allocation
  checklist: circuit-breaker-policy dismissed: no dependency failures are observed
- an event outside every project costs a constant: A command or an edit in a folder that is no project, at PreToolUse, PostToolUse or a prompt, reads no project file and takes no reading, and does not grow, counted by the meter and at the file system with reads weighed by their bytes, whatever the size of the project beside it, and makes at most one project-sized spawn, the listing of where the projects are; a command a cd took out of the project pays only for the project's own practices, as any command does, and one listing more.
  over: a command, an edit and a prompt in a folder beside the project with the host's settings above both, and a command that cds out of the project, over the sized fixture at 1× and at 10×
  via: an event outside every project does the same work at 1× and 10×, and reads nothing
  because: a cd into a folder that is no project once loaded a spec model of the whole folder above it, 5.7 s for one command in a folder of checkouts; an event outside every project is none of the hook's business, so its cost must not depend on what lies around it
  refuted: hookProject answered a command in a folder that holds no project, beside the nested one, as the repository top's own project -> "an event outside every project does the same work at 1× and 10×, and reads nothing" went red in work-meter.test.ts on its own assertion (a command in another folder grew with the project); restored byte for byte, green batched and alone (2026-10-08)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on one hook call's work
  checklist: execution-budget declared as an event outside every project costs a constant
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on reads, spawns and readings, not on allocation
  checklist: circuit-breaker-policy dismissed: an ignored event has no dependency to fail
- a prompt over an unchanged tree reads no corpus: A prompt over a tree that has not moved since the session's last prompt reads no project file and takes no coverage reading, and beside ten times the components and history, grown inside its files as well as in their number and every read weighed by its bytes, grows only in the journal's file list and the feed's memo, with two project-sized spawns at most, the tree key's two git listings.
  over: the second of two prompts over the sized fixture at 1× and at 10×
  via: a prompt over an unchanged tree reads no corpus, and pays only for the journal's file list, at 1× and 10×
  because: the coverage reading walks the whole corpus, and it ran at every prompt; its tree key is the commit HEAD names, two git listings and a stat per changed file, which a count holds where the reading's own seconds would only show as time
  refuted: took the full coverage reading at every prompt again, moved tree or not -> "a prompt over an unchanged tree reads no corpus, and pays only for the journal's file list, at 1× and 10×" went red in work-meter.test.ts on its own assertion (the second prompt went over its budget); restored byte for byte, green batched and alone (2026-10-08)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on one hook call's work
  checklist: execution-budget declared as a prompt over an unchanged tree reads no corpus
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on reads, spawns and readings, not on allocation
  checklist: circuit-breaker-policy dismissed: a skipped reading is caught by the stop's full one
- the coverage scan compares a line with its own words' phrases: The coverage scan tests each line only against the lexicon phrases one of the line's own words starts, so its phrase comparisons grow with the lines and with a line's words, and a lexicon a hundred times larger of names no line's words start adds none.
  over: the coverage reading of 200 and 400 lines, with a lexicon of 10 and of 1000 unwritten names, and with a word on every line that starts two names
  via: the coverage scan compares a line only with the phrases its own words start, never with the whole lexicon
  because: the scan once tested every line against every phrase, about 100 million substring searches on a 434,000-line project; the per-line cost must be the line's own, and every test of a line against a phrase passes one counted function, added to the work meter once per reading so the count costs the scan nothing
  refuted: tested every prose line against every multi-word phrase of the lexicon again for the words inside a known name -> "the coverage scan compares a line only with the phrases its own words start, never with the whole lexicon" went red in work-meter.test.ts on its own assertion (the larger lexicon added comparisons); restored byte for byte, green batched and alone (2026-10-07)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on the comparisons per line
  checklist: execution-budget declared as the coverage scan compares a line with its own words' phrases
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on comparisons, not on allocation
  checklist: circuit-breaker-policy dismissed: the scan has no dependency to fail
- every spawn is counted at runtime: Every child process and worker thread the process starts is counted where every route to a spawn arrives, node's child_process module itself, whose spawning functions (spawn, spawnSync, execFile, execFileSync, exec, execSync, fork) and worker_threads' Worker are replaced with counted ones when the meter loads: a spawn through a static import, process.getBuiltinModule, createRequire, code vm runs, a dynamic import of a computed name, or a worker is counted once, and a call one counted function makes of another (exec running execFile) is not counted twice.
  over: a spawn by each of seven routes, inside a work scope
  via: every spawn is counted at runtime, whatever route reached child_process
  because: a spawn in a hook is tens of milliseconds paid around every tool call, and a spawn the meter cannot see is one no count can hold; a scan of the source was evaded again and again (getBuiltinModule, createRequire with a joined name, a template import, a comment opening the line, require?.(, Function without new, a Worker of code, then a computed member, Reflect.get, aliases, vm, a spread Worker option, a third-party spawner), and no scan of source can be complete, while every one of those reaches the one module object. The CLI loads the meter before any other module, so nothing it loads takes the functions first; what stays uncounted, and no test here can reach, is a CommonJS module that destructured a spawning function before the meter ran (only code loaded ahead of the CLI can), process.binding('spawn_sync') and node's other internal bindings, and a native addon that starts a process itself
  refuted: left node's child_process module unmetered, so only calls through the meter's own exports were counted -> "every spawn is counted at runtime, whatever route reached child_process" went red in work-meter.test.ts on its own assertion (a static import's spawn went uncounted); restored byte for byte, green batched and alone (2026-10-08)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on what a spawn is counted by
  checklist: execution-budget declared as a tool call's hooks spawn git a fixed number of times
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on spawned processes, not on allocation
  checklist: circuit-breaker-policy dismissed: no dependency failures are observed
- the work meter sees every git a hook spawns: At PreToolUse, PostToolUse and a prompt, the git spawns the work meter counts are the git invocations a shim first on the PATH logs, one for one, at 1× and at 10×.
  over: a command at PreToolUse and PostToolUse and a prompt over the sized fixture at both sizes, against the counting git shim
  via: the hooks' git spawns all pass the work meter
  because: the meter's counts stand in for the shim's in every other size invariant, so they must agree where both can see; the shim proves the meter misses no git, and the meter adds the reads and readings the shim cannot see
  refuted: project-files.ts took spawnSync from node:child_process again -> "the hooks' git spawns all pass the work meter" went red in work-meter.test.ts on its own assertion (at PostToolUse the meter counted fewer git spawns than the shim logged); restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- the corpus is read only through readCorpus: The corpus listing is reached only by readCorpus, which reads each file through the work meter's door, so every corpus read a reading makes is counted.
  protects: collectFiles
  chokepoint: readCorpus
  because: the coverage reading's corpus reads were the slowdown at every PostToolUse; a reading that listed the corpus and read it on its own would read where no count sees it. The protection is of Coherence's own listing: a module that reads a project file with fs directly is not caught here, and the size invariants' file system count is what catches that
  kinds: none
- only runHook opens a work scope: A work scope is opened only by runHook, which closes it as the call returns, so the counts a test reads are exactly one hook call's; tests aside.
  protects: openWork
  chokepoint: runHook
  because: a scope opened elsewhere would split a hook call's work between two counts or swallow another's, and a size invariant would then compare the wrong numbers
  kinds: none
- an edit is checked against the spec as it is: The chokepoint invariants an edit is checked against are read from the specs on disk at that edit, never from a parse kept between calls, so a spec rewritten to the same size with its modification time set back is checked as it now reads.
  over: an uncommitted spec rewritten to the same size with its modification time restored by touch -r, and an edit naming the protected name it now declares
  via: an edit is checked against a spec changed at the same size with its modification time set back
  because: the first kept parses were keyed by size and modification time, then by git's stat cache, and a spec changed at the same size with its time restored kept its old chokepoint names, so an edit naming the new one was never checked where main always checks it; specs are small, so the parse kept was a small gain with a real way to go silent, and it was removed
  refuted: read each spec as git holds it rather than as it is on disk, the view a kept blob id gives -> "an edit is checked against a spec changed at the same size with its modification time set back" went red in work-meter.test.ts on its own assertion (the uncommitted spec's new protected name went unseen); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- an edit's chokepoint check never goes silent because a cache cannot be used: When the run index an edit's check reads cannot be read, rebuilt or written (a file where the cache folder should be, a read-only or root-owned folder, a lock another process holds), the check runs as it ran before the index, over the whole spec model and run store, and the edit's answer says it ran without its index and why; it never answers with nothing.
  over: a bypass edit with a file where .coherence/cache should be, checked through a real TypeScript instrument
  via: an edit's chokepoint check never goes silent because a cache cannot be used
  because: the edit's check wrapped its index in a catch that answered nothing, so with a cache that could not be created a bypass edit got no warning where main said it was broken; in a checker, every cache, index or log is an optimization that must fail toward the slow, correct path and say so, never toward silence
  refuted: restored the return of nothing when the light index could not be used, the reviewer's case -> "an edit's chokepoint check never goes silent because a cache cannot be used" went red in work-meter.test.ts on its own assertion (the bypass edit's answer was empty; a first red from parsing that empty answer was recorded as not counting, d-93f96520, and the break staged again); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- the run index answers as the run history does: For each file an edit wrote, the chokepoint enforcements whose latest run saw it are the ones latestByEnforcement finds in the whole run history: after appends in and out of time order, a torn index, a run line appended without the index, a run file a checkout replaced, a lock another writer holds and a cache that cannot be written; it answers from an index only when the index names every run file at its identity now, rebuilds it otherwise, and says it cannot answer, never answers from a stale one; an append never throws once it has appended.
  over: runs appended later and earlier than the latest, a truncated index, a line appended past the index, a run file removed and written again, a lock held past the wait, and a file where the cache folder should be
  via: the run index answers as the run history does after appends, a replaced file, a torn or stale index, a held lock and a cache that cannot be written, and an append never throws
  because: the first index kept its parts in shards written one by one, so a crash between two writes left it permanently wrong (0 enforcements where the history says 1), and an append that could not fold left it stale and said nothing; the index is now one small file written whole and renamed, checked against one stat per run file on every read, which a crash, a skipped fold or a file from outside can only make stale, and a stale index is rebuilt before it answers
  refuted: answered from any index that parses, whatever the run files are now -> "the run index answers as the run history does after appends, a replaced file, a torn or stale index, a held lock and a cache that cannot be written, and an append never throws" went red in work-meter.test.ts on its own assertion (a run line appended without the index went unseen); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- the peer feed reads only what changed since its last look: The peer feed shows every record a peer appended after the session's cursor, by record time and id, reading only the journal files whose identity (inode, size, modification and change time) moved since its last look and every file when it has no memo: through a cleared cache, a cleared memo, a file that arrived from outside, and two readers who look between appends.
  over: two readers, a look by one, the cache and its memo cleared, an append, a look by each, and a journal file written outside appendRecord
  via: the peer feed shows every record a peer appended, through a cleared cache and memo, a file that arrived from outside, and a peer who reads between appends
  because: a tail log of the journal kept byte offsets into a log that clearing the cache rebuilt, so a reader dropped records; the log is gone, the cursor is by record time and id as before it, and a file whose identity stands holds no record the last look did not see, so the memo can make a look slower, never lose one (the whole journal here reads in 2.2 ms, 62 files and 900 KB)
  refuted: took a journal file as unchanged since the last look whenever the memo named it, whatever its identity now -> "the peer feed shows every record a peer appended, through a cleared cache and memo, a file that arrived from outside, and a peer who reads between appends" went red in work-meter.test.ts on its own assertion (reader b never saw a record appended to a file its memo named); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- an edit whose kept vocabulary cannot be used reads in full and says so: An edit whose kept vocabulary state was left half-written, or cannot be read, takes the full coverage reading instead, and its answer says so; a state an edit could not take in is dropped, so the next edit reads in full and keeps it again.
  over: an edit after the kept state was marked as being written, as a stop half way through leaves it
  via: an edit whose kept vocabulary was left half-written reads in full and says so
  because: the edit's vocabulary is judged against state kept between calls, written in parts; a stop between two writes would leave totals that no longer match the files' kept contributions, so the state is marked while it is written and refused while the mark stands
  refuted: used a kept vocabulary marked as half-written -> "an edit whose kept vocabulary was left half-written reads in full and says so" went red in work-meter.test.ts on its own assertion (the edit read against it and never said it read in full); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- the kept vocabulary holds what the full reading holds: An edit read through the kept vocabulary holds the term it makes recur without a definition for the stop, unsaid, as an edit read in full does.
  over: an edit through a kept vocabulary state that makes a backticked term recur in one note
  via: an edit read through the kept vocabulary holds the term it makes recur for the stop, unsaid, as the full reading does
  because: the kept state answers most edits, and a path that still said the term at the edit, or held nothing, would bring back the per-edit noise or lose the term the stop is meant to name
  refuted: let the kept path keep the unresolved changes it found, so the edit said its term -> "an edit read through the kept vocabulary holds the term it makes recur for the stop, unsaid, as the full reading does" went red in work-meter.test.ts on its own assertion (the term is not said at the edit); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- nested work scopes add up: The work a scope opened inside another counts is the outer scope's too, so nesting never hides work from the scope a test reads.
  over: work counted before, inside and after an inner scope
  via: a work scope opened inside another adds its counts to the outer one
  because: closing an inner scope restored the outer without adding to it, so a scope opened inside a hook call would hide its work from the call's count; runHook alone opens a scope today, and this keeps that safe if another ever does
  refuted: closed an inner scope without adding its counts to the outer one -> "a work scope opened inside another adds its counts to the outer one" went red in work-meter.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- an upgrade turns no kernel practice against an adopter: An adopter that enacted a kernel practice as an earlier release taught it enacts it again under this release, and spec --check names no problem about it, for every kernel practice of every tagged release; the network upgrade test (npm run test:upgrade, the Upgrade workflow) installs the previous published release under the adopter's own records and checks the rest of the upgrade.
  over: every kernel practice this tree ships, as each release tag in git history wrote it, enacted with every step done in a fixture adopter and then enacted and checked under this tree
  via: an adopter that enacted every kernel practice as an earlier release taught it re-enacts each and checks clean under this one
  because: 1.5.0 amended a kernel practice in Coherence's own tree, and every adopter that had enacted the earlier version was refused at enact until it recorded an amend decision for a change it never made (df-36efa8f2); no test had put one release's records under the next, so the release went out with every test green
  crossing: record -> reading
  refuted: restored the 1.5.0 bug, the kernel skip in floorGaps removed -> "an adopter that enacted every kernel practice as an earlier release taught it re-enacts each and checks clean under this one" went red in upgrade.test.ts on its own assertion, enact refused for each of the six release and practice pairs that lost a step or pitfall (witness a refutation and adopt Coherence from v1.2.0, v1.3.0 and v1.4.0); restored byte for byte, green batched and alone (2026-10-07)
  kinds: revision
  checklist: revision-preservation declared as an upgrade turns no kernel practice against an adopter
- a project behind a symbolic link hears its hooks: A tool hook names the files an event writes relative to the project whichever spelling of the project and of the file the host, the event's cwd and the tool use, comparing real paths, so a project reached through a symbolic link gets its edit checks and practice deliveries.
  over: an edit of a project file with the project and the file each spelled through a symbolic link or its target, in every mix
  via: a project behind a symbolic link hears its hooks whichever spelling the host, the cwd and the edited file use
  because: the hook made the edited file relative to the root's own spelling, so on macOS, where every temporary folder sits behind /var -> /private/var, a file under /var read as outside the project rooted at /private/var and every tool hook went silent (df-ccfd4309); an adopter whose home or checkout sits behind a link would hear nothing
  crossing: harness -> reading
  refuted: made writtenFiles relative to the root's own spelling again, the file's path unresolved -> "a project behind a symbolic link hears its hooks whichever spelling the host, the cwd and the edited file use" went red in symlink.test.ts on its own assertion, and with the writtenFiles assertions set aside the hook still delivered no practice; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- orient names each guard failure: orient's spec block names every defect recorded in a class a guard already covered, with the guard and the close that set it, and says nothing when there is none.
  over: a project before any guard, after the guarded close, and after a later defect in the guarded class
  via: orient names each guard failure under the spec block
  because: a repeat in a guarded class means the protection was weaker than claimed, and the session that starts next is the one that should strengthen it; spec --check alone is read only when someone runs it
  crossing: record -> reading
  refuted: made orient name guard failures only when there are two or more -> "orient names each guard failure under the spec block" went red in defect-orient.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- orient names Coherence's own TypeScript: When the project reads TypeScript and its own TypeScript is 7 or later, which ships no tsserver, orient says once that Coherence is using its own TypeScript, with both versions; a project on a TypeScript with a tsserver, or one that reads no TypeScript, is told nothing.
  over: a project on typescript 7.0.2 declaring typescript, the same project declaring python, and a project on its own typescript 5.8.2
  via: orient says once that Coherence reads with its own TypeScript when the project's is 7 or later
  because: every reading a TypeScript 7 project gets is made by another compiler than the one it builds with, and an agent that is not told will take a difference between them for its own mistake (df-aa4a8606)
  crossing: project-source -> reading
  refuted: left the TypeScript line out of orient's head -> "orient says once that Coherence reads with its own TypeScript when the project's is 7 or later" went red in installed.test.ts; restored byte for byte, green (2026-10-08)
  kinds: none
- a hook time carries its version: every hook call's kept time carries the Coherence version that answered it, read once from the installed package; a time kept before versions were written still reads, with no version.
  over: a kept time written now and one written before versions existed
  via: a hook call's kept time carries the Coherence version that answered it
  because: hook latency is read per Coherence version to see whether a release made the hooks slower; times without the version could only be grouped by guess
  crossing: harness -> record
  refuted: dropped the installed version from recordHookTime, so a kept time carried none -> "a hook call's kept time carries the Coherence version that answered it" went red in defect-orient.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- orient names a floor no full run moved: When the run store holds runs and no full run (every bullet, both forms, no --invariant or --form filter, from the project's own spec model, graded) dated no later than now graded in the last fourteen days, orient names how long ago the last full run was, or that none ever was, and the run that moves it: an edit's check records its entries ungraded and a scoped run moves only its own bullets, so neither moves the whole floor, and a run dated in the future says nothing of now. A full run within fourteen days says nothing.
  over: no run, edit checks alone, a scoped run, a full run fourteen days ago, edit checks, a scoped run and a full run dated in the future since a full run twenty days ago, and a full run after them
  via: orient names an invariant floor no full run has graded in fourteen days; a scoped run and a run dated in the future move nothing
  because: an edit's check runs one invariant from a model of that invariant alone, which derives no state, so it records its entries ungraded and the floor never counts them; a project whose agents only edit would keep a floor as old as its last full run with no one told, and the session that starts is the one that can run it. Counting any graded run overstated it: a run of one --invariant grades one bullet, and a run dated past now (a skewed clock, a hand-written line) would hold the note off for as long as its date is ahead
  crossing: record -> reading
  refuted: counted a run scoped by --invariant as a full run, and apart, counted a full run dated in the future -> "orient names an invariant floor no full run has graded in fourteen days; a scoped run and a run dated in the future move nothing" went red in defect-orient.test.ts on its own assertion each time (a scoped run held the note off; a run dated 2099 held it off); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- telemetry is sent only on opt-in: Fleet telemetry queues and sends nothing until the user runs telemetry on, which keeps the choice and a random installation id under the user's config directory, never in the project; DO_NOT_TRACK, COHERENCE_TELEMETRY=0, a build with no PostHog key, and a project's or its registry's "telemetry": false each refuse whatever the user chose, and off forgets the id and drops the queue.
  protects: FETCH_SENDER
  chokepoint: flushQueue
  over: a user who never opted in, one who did, each environment override, a build with no key, a project that refuses, and an opt-out with events queued
  via: nothing is queued or sent unless the user opted in, and a project's refusal or the environment always wins
  because: Coherence runs in other people's code, so the widest self-correction loop may learn from an installation only when its user chose it, and a project or a machine that says no must be heard over any one user's yes (d-c00e7997); the one function that reaches the network is used only by the flush, which sends nothing unless telemetry is on
  refuted: telemetryState ignored a project's "telemetry": false -> "nothing is queued or sent unless the user opted in, and a project's refusal or the environment always wins" went red in telemetry.test.ts on its own assertion (a project's "telemetry": false refuses); restored byte for byte, green batched and alone (2026-10-07)
  kinds: output
  checklist: destination-confinement dismissed: events go to one destination, the batch endpoint of the host in telemetry-config.ts, and a redirect is refused
  checklist: redaction declared as a telemetry event carries only its schema's fields
  checklist: commit-ordered-effects dismissed: the queue is taken before the send and dropped after it whatever the answer; at most once is the design, and nothing else waits on the send
  checklist: circuit-breaker-policy dismissed: one attempt per flush with a 5 s timeout and no retry, so a failing PostHog costs one request per session start or stop
  checklist: declared-target-coverage dismissed: one target, PostHog's batch endpoint, not a registry of targets
- a telemetry event carries only its schema's fields: Every telemetry event is checked against the schema of the keys and values its kind may carry before it is queued and again before it is sent; a key the schema does not list, or a value outside it, keeps the event out of the queue and out of the batch.
  over: a session summary and a defect event as built, one with a field added, one with prose in a slug, and one with an extra top-level key, queued and written straight into the queue
  via: every telemetry event carries only the fields its schema allows, and a field outside it is refused
  because: the README names each field, and a field added in passing (a path, a project name) would leave every installation that opted in; checking the keys against a list makes the new field fail the day it is written, where a review would have to notice it
  refuted: schemaProblems let a property its schema does not list through -> "every telemetry event carries only the fields its schema allows, and a field outside it is refused" went red in telemetry.test.ts on its own assertion (the event with a field added had no problems); restored byte for byte, green batched and alone (2026-10-07)
  kinds: output
  checklist: destination-confinement dismissed: events go to one destination, the batch endpoint of the host in telemetry-config.ts, and a redirect is refused
  checklist: redaction declared as a telemetry event carries only its schema's fields
  checklist: commit-ordered-effects dismissed: the queue is taken before the send and dropped after it whatever the answer; at most once is the design, and nothing else waits on the send
  checklist: circuit-breaker-policy dismissed: one attempt per flush with a 5 s timeout and no retry, so a failing PostHog costs one request per session start or stop
  checklist: declared-target-coverage dismissed: one target, PostHog's batch endpoint, not a registry of targets
- a defect's telemetry carries no defect text: The defect event carries the defect's class as a slug, the kind of its origin (fix, pre-existing or unknown) and how it was caught, from fixed lists, and never its text, evidence, files, the commit or pull request it names, or prose put where a class belongs.
  over: defects whose text, evidence and files name a path and a project, one whose class is prose, one whose origin names a commit and a pull request, and one with no class, origin or catch
  via: a defect's telemetry event carries its class, origin and catch, never its text
  because: a defect's text is the most specific thing Coherence records about a project's code, and the fleet needs only its shape to learn which classes recur (d-c00e7997)
  refuted: defectClass turned prose put where a class belongs into a slug of its words -> "a defect's telemetry event carries its class, origin and catch, never its text" went red in telemetry.test.ts on its own assertion (a name from the defect's prose reached the queue); restored byte for byte, green batched and alone (2026-10-07)
  kinds: output
  checklist: destination-confinement dismissed: events go to one destination, the batch endpoint of the host in telemetry-config.ts, and a redirect is refused
  checklist: redaction declared as a telemetry event carries only its schema's fields
  checklist: commit-ordered-effects dismissed: the queue is taken before the send and dropped after it whatever the answer; at most once is the design, and nothing else waits on the send
  checklist: circuit-breaker-policy dismissed: one attempt per flush with a 5 s timeout and no retry, so a failing PostHog costs one request per session start or stop
  checklist: declared-target-coverage dismissed: one target, PostHog's batch endpoint, not a registry of targets
- telemetry adds no wait to a hook: A hook starts telemetry only at a session start or a stop, after its answer is made, and only by spawning the flush detached with its output ignored and unreferenced, when something is queued or a session that is over awaits its summary; queuing an event appends one line and reads nothing back; the send happens in the detached flush, one request with a timeout, dropped after one attempt.
  protects: flushQueue
  chokepoint: telemetryCommand
  over: every hook event with telemetry on, an empty queue, a queued event, a session that is over, and a queue of 500 events taking one more
  via: telemetry adds no wait to a hook: the flush starts detached at a session start or a stop, and queuing is one appended line
  because: the tool hooks hold a 3 s latency budget and run around every tool call; a send inside a hook would make the network's latency the user's, and a non-writing PostToolUse on this repository measured 191 ms with telemetry on against 192 ms with it off; the send is reached only through the telemetry verb's flush, which the hook starts detached, so no hook can call it in its own time
  refuted: startTelemetry left the flush referenced, so the hook's process waits for it -> "telemetry adds no wait to a hook: the flush starts detached at a session start or a stop, and queuing is one appended line" went red in telemetry.test.ts on its own assertion (the hook never holds the child); restored byte for byte, green batched and alone (2026-10-07)
  kinds: budget
  checklist: execution-budget declared as telemetry adds no wait to a hook
  checklist: bounded-admission dismissed: a flush starts only at a session start or a stop, and only with something to send
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: at most one flush per session start or stop, and one collection summarizes at most 20 sessions
  checklist: memory-budget dismissed: the queue holds one line per event and is drained at each flush
  checklist: circuit-breaker-policy dismissed: a send that fails is dropped after one attempt with a 5 s timeout, in the detached flush
- git calls ignore how the environment reads pathspecs: Every git call Coherence makes runs without GIT_LITERAL_PATHSPECS, GIT_GLOB_PATHSPECS, GIT_NOGLOB_PATHSPECS and GIT_ICASE_PATHSPECS, at the one door every spawn passes, so an edit is checked the same, by the light way, with any of them set.
  over: an edit naming a protected thing with GIT_LITERAL_PATHSPECS and GIT_ICASE_PATHSPECS set in the hook's environment
  via: an edit is checked with GIT_LITERAL_PATHSPECS set as without it
  because: with GIT_LITERAL_PATHSPECS set, the light listing of the specs (a glob pathspec) matched nothing, nothing threw, and the edit's check went silent where main checked; the variables are a user's to set for their own git, never a reason for a checker to read its own listing another way
  refuted: passed git calls the environment as given, GIT_LITERAL_PATHSPECS and all -> "an edit is checked with GIT_LITERAL_PATHSPECS set as without it" went red in work-meter.test.ts on its own assertion (the light listing of the specs came back empty); a first red, from git refusing a second variable the test also set, was recorded as not counting (d-962eb2f7) and the break staged again; restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- an empty spec listing is a failure, not an answer: When the light listing of the specs comes back empty while the walk the spec model reads finds specs, the edit's check falls back to the whole model, says so, and still checks.
  over: a git that answers every glob pathspec with nothing, over a project that holds a spec, and an edit naming its protected thing
  via: a spec listing that comes back empty where the project holds specs falls back to the whole model and says so
  because: an index that comes back empty where the project has specs fails silently, the one way a checker must never fail; the walk is paid only when the light listing found nothing, so a project with specs pays it never, and one without pays what main paid at every edit
  refuted: took an empty spec listing as the answer -> "a spec listing that comes back empty where the project holds specs falls back to the whole model and says so" went red in work-meter.test.ts on its own assertion (the empty listing was no failure); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- a damaged kept vocabulary is never read as empty: Every part of the kept vocabulary an edit reads is validated: a bucket the state lists that is missing, torn or not in its kept shape, a torn meta or declared list, makes the edit take the full reading and say so, names nothing the full reading would not, and writes back nothing derived from the damaged part; the full reading then keeps the state again whole.
  over: every term bucket torn, every term bucket in another shape, and every file bucket missing, each under an ordinary edit
  via: an edit over torn or missing vocabulary buckets reads in full, says so, names nothing false and writes nothing derived from them
  because: an unreadable bucket was read as an empty one, with no warning: the edit then named a term as newly recurring that a whole reading would not, and its keep wrote totals computed from the empty part back into the state, so the error outlived the edit
  refuted: read a torn kept bucket as an empty one, the reviewer's case -> "an edit over torn or missing vocabulary buckets reads in full, says so, names nothing false and writes nothing derived from them" went red in work-meter.test.ts on its own assertion (the torn buckets' edit said nothing of a fallback); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- a write no hook saw is read in full at the next edit: Before an edit judges its vocabulary against the kept state, it compares the tree's key (each file git lists as changed or untracked, with its size, modification and change time) with the key the state was kept at; when any file other than the ones this edit wrote moved, the edit takes the full reading, as main does, and says which.
  over: a note changed with no hook to hear it, then an edit to another note that makes a term recur across both
  via: a write no hook saw is caught at the next edit, which reads in full as main does
  because: a code generator, a checkout, or a shell command the shell reader does not parse left later edits judging against old totals, so a term the unseen write made recur went unnamed where main named it; a lexicon-work test had been changed to list the unseen file in the patch, which hid this, and is back to main's form. Coherence's own records under .coherence are left out of the key, since its commands write them at every turn; the next prompt or stop reads them in full
  refuted: judged an edit against the kept totals whatever the tree did since -> "a write no hook saw is caught at the next edit, which reads in full as main does" went red in work-meter.test.ts on its own assertion (the unseen write went unsaid); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- counting a spawn changes nothing it returns: Each spawning function the work meter replaces carries every property its original does, and its promisified form hands back the very object the original's own promisified form returns, so promisify(exec) and promisify(execFile) resolve and carry their child process exactly as in node without the meter.
  over: promisified exec and execFile, and the own properties, name, length and promisified form of spawn, spawnSync, execFile, execFileSync, exec, execSync and fork, against a node process that never loads the meter
  via: the patched spawning functions keep node's shape: a promisified exec or execFile carries its child, and every property stays
  because: the meter wraps node's own module for every caller in the process, Coherence's and any library's, so a wrapper that changes a shape breaks code that has nothing to do with counting; the first wrapper's promisified form was async, so promisify(exec)(...).child came back undefined
  refuted: returned a new pending result from the promisified form instead of the original's own, as the first wrapper's async form did -> "the patched spawning functions keep node's shape: a promisified exec or execFile carries its child, and every property stays" went red in work-meter.test.ts on its own assertion (the shapes differed from unpatched node: no child on what came back); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- the size counts weigh every read and class every spawn: The file-system count the size tests hold the hooks to weighs every way of reading a file's bytes by the bytes it returned (readFile in each form; read and readv by descriptor, sync and callback; a FileHandle's readFile, read and readv; a read stream from a path or a FileHandle), and the work meter counts as project-sized any spawn through a shell (sh -c, bash -c, exec with a string, an option shell) and any recursive tool (grep -r, find, rg, ls -R), beside git's listing, searching and comparing.
  over: a 5000-byte file read each of twelve ways, and command lines of git, a shell, grep, find, rg and ls, recursive and not, and an exec and a spawn with shell: true
  via: every way of reading a file's bytes is weighed by them, and a spawn through a shell or a recursive tool is project-sized
  because: reading the run and journal files whole through a FileHandle's readFile() (the asynchronous open's) passed the edit's size test, since a FileHandle's reads were weighed by nothing, and twenty sh -c "git grep; git ls-files | wc -c" with a grep -rq over the root passed it too, since only a line that began with git was project-sized; a budget that cannot see a form of the work holds nothing against it
  refuted: weighed a FileHandle's reads by nothing, and apart, counted a spawn through a shell by its first word only -> "every way of reading a file's bytes is weighed by them, and a spawn through a shell or a recursive tool is project-sized" went red in work-meter.test.ts on its own assertion each time (a FileHandle's readFile weighed once; a spawn through a shell was not project-sized); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- a moved HEAD is a moved tree: The tree's key, the one an edit judges its kept vocabulary against and the one a prompt decides on its reading by, carries the commit HEAD names, read through the git door; a checkout, a pull or a branch switch onto a clean tree moves it, so the next edit and the next prompt read in full, as main does, and the edit says HEAD names another commit.
  over: a checkout of a branch that changes one file and adds another, a pull made as a commit in a shell, and a switch to a branch with the same tree and another HEAD, each followed by an edit and, apart, by a prompt
  via: a checkout, a pull or a branch switch onto a clean tree moves the tree: the next edit and the next prompt read in full
  because: both keys listed only what differs from HEAD, so a checkout or a pull onto a clean tree, which moves HEAD with the files, left the key unchanged and the next edit judged against totals of another tree; the index's own stat is left out, since git rewrites it whenever it refreshes and that changes no file's text
  refuted: left HEAD out of the vocabulary state's tree key, and apart, out of the prompt's -> "a checkout, a pull or a branch switch onto a clean tree moves the tree: the next edit and the next prompt read in full" went red in work-meter.test.ts on its own assertion each time (the checkout's next edit said nothing; its next prompt took no reading); restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- an edit's check asks the language the last run graded in: In a project of more than one language, the light path an edit's check runs on carries each touched invariant's last run language and that run's whole file list from the run index, so the check asks the language main would ask first and records it so.
  over: a project of TypeScript and Python whose last run graded a Python chokepoint, and a TypeScript edit that spells the protected symbol's name
  via: in a project of two languages, an edit's check asks the language the last run graded the invariant in, with that run's whole file list
  because: the light path built each invariant's latest run without its language and with only the files the edit wrote, so a TypeScript edit spelling a protected Python symbol's name was checked in TypeScript first, grading the wrong symbol, and the wrong language then persisted in the run it recorded
  refuted: built the touched invariant's latest run without its language, the reviewer's case -> "in a project of two languages, an edit's check asks the language the last run graded the invariant in, with that run's whole file list" went red in work-meter.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- the status line reads the session's own records: Coherence's status line names the session's tool hook calls, their average time and how many passed the latency budget, and the practices that fired with no enactment since, read from the session's hook times, firings and journal file in the project the status line runs in, the repository top and every leaf its registry lists, by the names and budget the hooks keep them under; outside every project it prints nothing.
  over: a registry of two leaves holding the session's times, firings and an enactment, another session's times beside them, a config's latency budget, a folder no project holds, and input with no session
  via: the status line names the session's tool hook time against the budget and the practices it owes, from every leaf of a registry
  because: hook output reaches the agent, and the one line that reached the user, regulate at a stop, came after the work and all at once; a status line is where the user sees the hooks' cost and what the session owes while it works, without the agent spending context on it
  refuted: dropped the registry's leaves from the folders the status line reads -> "the status line names the session's tool hook time against the budget and the practices it owes, from every leaf of a registry" went red in statusline.test.ts on the call count; restored, green (2026-10-08)
  kinds: none
- a status line render loads no hook module: The status line command and the module it reads with import only node's built-ins, so a render, which the host runs after events and cancels when the next is due, costs node's start and the session's few files, never the modules the hooks load or a reading of the project.
  over: the status line module and its command's entry
  via: the status line module imports nothing but node's own, so a render never loads the hooks' modules
  because: starting Coherence's CLI from source took 1.1 to 1.5 s against about 0.1 s for the status line alone, measured on this repository; a status line slower than the host's debounce would be cancelled before it printed
  refuted: imported the hook latency module into the status line module -> "the status line module imports nothing but node's own, so a render never loads the hooks' modules" went red in statusline.test.ts; restored, green (2026-10-08)
  kinds: none
- the status line keeps the user's own: Given another status line command after --, Coherence's status line command runs it with the same session input and prints its lines first, then Coherence's, so adding Coherence's line never takes away the one a user had.
  over: a command that reads its input and prints one line
  via: the status line command prints the user's own status line first, from the same session input, then Coherence's
  because: Claude Code runs one status line command, and a user who already has one would otherwise have to choose between it and Coherence's
  refuted: skipped running the command after -- -> "the status line command prints the user's own status line first, from the same session input, then Coherence's" went red in statusline.test.ts; restored, green (2026-10-08)
  kinds: none
- the status line links Scope while it is served: While the project's warm server is alive and answers HTTP, Coherence's status line ends with a terminal hyperlink labelled scope that opens the live Scope page; the address, which carries the project's token, is the link's hidden target and never printed bare, and a server that is gone or serves no page yet shows no link.
  over: a pointer whose process is alive and serves HTTP, one whose process has ended, one with no HTTP port, and the line with links off
  via: the status line links the live Scope page while its warm server answers, never as a bare address and never for a server that is gone
  because: opening Scope meant running coherence scope, and an agent that ran it put the tokened address into its own context and the transcript; the status line is read by the user alone and not kept in the transcript, and a link to a server that is gone would open nothing
  refuted: dropped the check that the server's process is alive -> "the status line links the live Scope page while its warm server answers, never as a bare address and never for a server that is gone" went red in statusline.test.ts on the ended process; restored, green (2026-10-08)
  kinds: none
- the CI check's fail mode fails on problems and defects: ci install --mode fail writes a workflow that runs spec --check and the chokepoint run with the installed Coherence, fails the check on either one's findings, checks the chokepoints even after the spec check failed, pins every action by commit, asks only to read the contents, fetches the whole history, and keeps telemetry and the update check off.
  over: the workflow planned for a project installed with npm at its repository top
  via: ci install writes the fail mode for npm: spec --check and the chokepoint run, failing on either, pinned, with minimal permissions
  because: an adopter wired Coherence into his pull requests by hand (df-7b885044); a hand-written workflow drifts from what Coherence's own CI learned, a tag an action's owner can move, a shallow clone the spec check cannot confirm a practice's cited commit in, a runner that sends telemetry, so the workflow is written from the same choices
  refuted: dropped if: !cancelled() from the fail mode's Chokepoints step, so a failed spec check skips the chokepoints -> "ci install writes the fail mode for npm: spec --check and the chokepoint run, failing on either, pinned, with minimal permissions" went red in ci.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-09)
  kinds: none
- the CI check's comment mode fails only when Coherence breaks: ci install --mode comment writes a workflow whose spec check and chokepoint run never fail the job on findings, whose report reaches the job summary and one pull request comment found by its marker and updated in place, which asks for pull-requests: write and nothing more, and which says in a warning when a read-only token keeps the comment from posting; with pnpm it installs pnpm, the version package.json names or the one that writes lockfile 9.0.
  over: the workflow planned for a project installed with pnpm, with and without a packageManager in package.json
  via: ci install writes the comment mode for pnpm: findings never fail the job, and one comment is posted or updated
  because: the adopter wanted a report comment, not a failed check (df-7b885044); a comment posted anew on every push buries the conversation, an exit that cannot tell findings from a crash would either fail on findings or pass a broken run, and a fork's read-only token failing quietly would read as a clean pull request
  refuted: the comment mode's spec check step swallowed every exit (|| true), so a crash of Coherence passed as findings -> "ci install writes the comment mode for pnpm: findings never fail the job, and one comment is posted or updated" went red in ci.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-09)
  kinds: none
- a registry's CI check covers every listed project: ci install in a repository with a registry runs the check at the repository top, from whichever listed project it was run in, where spec --check and the chokepoint run each cover every listed project; without a registry, a project nested below the top runs the check in its own folder; a registry whose lockfile is not at the top is refused.
  over: a registry of two projects run from one of them, a project nested below a top that holds the lockfile and a Node.js version file, and a registry whose only lockfile is in a project
  via: ci install runs a registry's check at the repository top, covering every listed project, and a nested project in its own folder
  because: a check run in the one project ci install happened to be called from would leave every other listed project unchecked while the pull request reads green
  refuted: planWorkflow ran the check in the project ci install was called from even under a registry -> "ci install runs a registry's check at the repository top, covering every listed project, and a nested project in its own folder" went red in ci.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-09)
  kinds: none
- ci install refuses what it cannot set up: ci install refuses, naming what to do, a lockfile of a package manager its workflow does not set up, two lockfiles in one folder, and a project whose package.json does not list Coherence; and with no mode it presents both modes and assumes neither.
  over: yarn.lock, package-lock.json beside pnpm-lock.yaml, a package.json without @posthog/coherence, and no --mode
  via: ci install refuses what it cannot set up, and says what to do
  because: a workflow guessed for a lockfile it does not understand would fail on its first pull request for a reason nobody chose, and the mode is the user's choice to make (df-7b885044)
  refuted: yarn.lock was read as an npm lockfile, so a yarn project got a workflow running npm ci -> "ci install refuses what it cannot set up, and says what to do" went red in ci.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-09)
  kinds: none
- ci install never overwrites a workflow: ci install prints the workflow without --write and writes it with --write only where no file is at .github/workflows/coherence.yml; a file already there is kept byte for byte, nothing is written beside it, and the command says so and exits 1.
  over: no file, then a file ci install wrote, then a file of the adopter's own at that path
  via: ci install prints without --write, writes with it, and never overwrites a workflow already there
  because: the workflow file is the adopter's once written: they tune its setup (secrets, a Python toolchain, another runner), and an install run again would throw that away
  refuted: writeWorkflow wrote over a file already at .github/workflows/coherence.yml instead of keeping it -> "ci install prints without --write, writes with it, and never overwrites a workflow already there" went red in ci.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-09)
  kinds: none
- hooks install offers the CI check while none runs: When hooks install finishes and no workflow under .github/workflows runs Coherence (ours by its path, or any whose text runs spec --check or run --form through Coherence), it prints one line offering ci install with its two modes; with one there it says nothing of CI.
  over: a repository with no workflow, with the workflow ci install writes, with an adopter's own workflow that runs the check, and with an unrelated workflow
  via: hooks install offers ci install and its two modes only while no workflow runs Coherence
  because: an adopter found running Coherence on pull requests on his own and said installing should suggest it (df-7b885044); offered where a workflow already runs it, the line would be noise every install
  refuted: hasCoherenceWorkflow recognized only a file named coherence.yml, so an adopter's own workflow that runs the check still got the offer -> "hooks install offers ci install and its two modes only while no workflow runs Coherence" went red in ci.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-09)
  kinds: none
- the CI report carries every finding and fails only on an unfinished run: ci report --session <id> prints one Markdown document headed by the marker the workflow finds its comment by, with each project's spec problems, the chokepoint verdicts of that session's run with their bypass sites, its spec gaps (or why they were not read), and its guard failures; it exits 1 only when Coherence did not finish (a project with no run of the session, or a chokepoint not run), and says so at the top.
  over: a registry of two projects, one with a spec problem and a failing chokepoint, a run of another session beside it, a gap reading that answers and one that fails, a session with no run, a chokepoint not run, and a guard failure
  via: ci report carries each project's problems, chokepoint verdicts, spec gaps and guard failures as Markdown, and fails only when Coherence did not finish
  because: in the comment mode, findings are reported and never fail the job, while a run that never happened is never mistaken for a clean one; a report read from the latest verdicts instead of the session's run would show a pass from another branch
  refuted: buildReport read every run in each project instead of the CI session's, so another session's later pass hid the failing verdict -> "ci report carries each project's problems, chokepoint verdicts, spec gaps and guard failures as Markdown, and fails only when Coherence did not finish" went red in ci.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-09)
  kinds: none
- a closure mirror is named at the edit that breaks it: At PostToolUse, a write to a file in the value-import closure a declared mirror names is read again, and each file the closure now reaches that the list does not name is added to the edit's context as advice, never a block, naming the file that imports it and the list's file and line; a type-only import adds nothing, and the file the closure grew by is watched from then on.
  over: a fixture of the b37627e shape: a list of the page's modules, the closure of page.ts, a type-only import added to a closure file, then a value import of a file the list omits
  via: an edit that gives a closure file a value import its mirror omits names the file and the list's line, as advice
  because: BROWSER_SOURCES was a hand list of the Scope page's modules; b37627e made structure-flow.ts import languages-read.ts without adding it, and releases 1.6.0 to 1.7.1 shipped a page stuck on Connecting; the edit that broke it was the one moment the mismatch was cheap to see (d-f1ff87d6)
  crossing: project-source -> reading
  refuted: made the closure check count only the closure's starting files as missing -> "an edit that gives a closure file a value import its mirror omits names the file and the list's line, as advice" went red in mirrors.test.ts on its own assertion (the import of languages-read.ts went unnamed); restored byte for byte, green (2026-10-12)
  kinds: none
- a literal mirror is named at the edit that breaks it: At PostToolUse, a write to a declared mirror's list or to its partner literal reads both again, and when their members differ (another literal's members, or an object's keys) the edit's context names what each side holds alone and both files and lines, as advice; the same disagreement is said once per session, and agreeing again is silent and forgets it.
  over: a list and its partner literal, and a set and an object's keys, changed on either side, an unrelated change to a file that still disagrees, and a fix
  via: an edit that makes a list and its partner literal disagree names what each side holds alone, once per session
  because: two literals kept equal by hand drift without failing anything (defect family hand-list); naming the drift at the edit that made it is the cheap moment, and saying a standing drift at every later edit of a busy file would train a reader to skip the line
  crossing: project-source -> reading
  refuted: said every disagreement at every watched edit, ignoring what the session was told -> "an edit that makes a list and its partner literal disagree names what each side holds alone, once per session" went red in mirrors.test.ts on its own assertion; restored byte for byte, green (2026-10-12)
  kinds: none
- a gone mirror is said at the edit: A write to a file a declared mirror spans, after which its list or partner literal is no longer declared as a literal there, adds a line to the edit's context saying the mirror cannot be checked and why, and the spec model names the same mirror as a problem; a mirror is never skipped in silence.
  over: a mirror whose list is removed from its file by an edit
  via: a mirror whose list is gone is said at the edit and is a spec problem, never skipped
  because: a check that skips what it cannot find reads as a clean edit; a hand list derived away leaves a declaration that names nothing, and both the edit and spec --check must say so
  crossing: project-source -> reading
  refuted: read a list no longer declared as a literal as agreeing -> "a mirror whose list is gone is said at the edit and is a spec problem, never skipped" went red in mirrors.test.ts on its own assertion (the edit said nothing); restored byte for byte, green (2026-10-12)
  kinds: none
- the mirror alarm costs an unwatched edit one lookup: At PostToolUse, an edit to no file a declared mirror spans costs the alarm one read of the kept index and a lookup, and reads no source file; a watched edit reads the list, its partner, and only the closure files whose size or modification time changed, never loading the TypeScript compiler.
  over: an edit to a file no mirror spans and an edit to a closure file, timed and counted by the work meter
  via: an edit no mirror watches costs the alarm one lookup and reads no source
  because: the tool hooks share a 3 s budget around every tool call; the spike measured 155 ms to load TypeScript and 29 ms to parse one file, where a regex over the literal and the imports takes under a millisecond (d-164b52ef)
  crossing: project-source -> reading
  refuted: read every declared mirror again at every edit, whatever file it wrote -> "an edit no mirror watches costs the alarm one lookup and reads no source" went red in mirrors.test.ts on its own assertion (an unwatched edit read the fixture's sources); restored byte for byte, green (2026-10-12)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on what one edit reads
  checklist: execution-budget declared as the mirror alarm costs an unwatched edit one lookup
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
  checklist: memory-budget dismissed: the bound is on reads, not on allocation
  checklist: circuit-breaker-policy dismissed: the alarm has no dependency to fail
- the warm hook process answers as the hook does: coherence hook-serve answers each event with the stdout, stderr and exit code coherence hook <event> prints for it, in arrival order, one event at a time, and keeps the same records, committed once its answer was written.
  over: a session's start, prompt, edit (before and after), read and stop, through one hook-serve process and through one hook process per event, in two copies of one project
  via: the warm process answers a session's events with the per-event hook's output and keeps the same records
  because: the Claude Code mod (mods/coherence, docs/mods-spike.md) reaches Coherence through this process to spare each event Node's start; an answer or a record that differed would make the fast path a different tool from the one Codex and the settings hooks run
  refuted: dropped the commit after hook-serve writes its answer -> "the warm process answers a session's events with the per-event hook's output and keeps the same records" went red in hook-serve.test.ts: the warm copy lacked .coherence/.gitattributes and the session's lexicon, regulate and structure records; restored byte for byte, green (2026-10-09)
  kinds: none
- the warm hook process never answers from stale code: hook-serve compares Coherence's code on disk with what it loaded before every request; once they differ it answers stale, runs nothing, and exits, so its client runs the event through the command line and starts a fresh process.
  over: a ping, then an event after the code identity changed
  via: a warm process whose code changed on disk answers stale and runs nothing, so its client runs the event through the command line
  because: a long-lived process outlives an edit to Coherence itself (its own repository dogfoods it) or an upgrade; the per-event hook always runs the code on disk, and the warm one must not answer differently
  refuted: compared the code identity with itself instead of with what was loaded -> "a warm process whose code changed on disk answers stale and runs nothing, so its client runs the event through the command line" went red in hook-serve.test.ts; restored byte for byte, green (2026-10-09)
  kinds: none
- the warm hook process leaves with its socket: hook-serve --socket listens in a private folder of its own, prints the socket's path first, and when its host ends it with a signal it exits 0 and removes the folder, so a client's next request fails at once and the client falls back.
  over: a ping over the socket, the host's SIGTERM, and a request after it
  via: over its socket the warm process answers until its host ends it, and is then gone with its folder, which a client reads as a process to replace
  because: a socket left behind would make a dead process look alive to the mod, and a folder left in the temporary directory is litter per session
  refuted: removed the signal handlers -> "over its socket the warm process answers until its host ends it, and is then gone with its folder, which a client reads as a process to replace" went red in hook-serve.test.ts: the process ended by the signal without exiting 0; restored byte for byte, green (2026-10-09)
  kinds: none
- a command run in-process answers as the binary does: cli(args, { cwd, env, stdin }) runs a command through cli.ts's own main in the test file's process, over buffers for its output, the given stdin, folder and environment, and answers with the exit code, stdout and stderr the spawned node src/cli.ts prints for the same command, keeping the same records; a usage error or a throw ends the call with the binary's code and message, and the binary itself exits as it always did.
  over: help, version and an unknown verb; a decision written and the journal read; spec --check and scaffold component; lexicon --check and work inspect; a SessionStart hook event from stdin and an unknown event; hooks install and status; query status and run --status; ci install, telemetry status and adopt, each through a spawned process in one copy of a project and through cli() in another
  via: cli() answers each command family as the spawned command line does: the same exit, stdout, stderr and records
  because: tests spawned node src/cli.ts once per call, so each call paid Node's start and Coherence's load, about a second, and 23 test files did it (df-608d319a); a test that runs the command in its own process pays the load once per file, and only a comparison with the binary itself shows the cheap path is the same command
  refuted: made cli() drop the message a call that ends at once (a usage error, a throw) writes to stderr, keeping only its exit code -> "cli() answers each command family as the spawned command line does: the same exit, stdout, stderr and records" went red in cli.e2e.ts on its own assertion (3 of its 9 tests: the usage error, the unknown hook event, and the suite); restored byte for byte (cmp), green batched and alone (2026-10-13)
  kinds: none
- a call in-process never inherits the last call's answers: Before each cli() call every per-process cache a module keeps about a project (whether a folder is a repository, its registry, the projects below it, the files a root owns, the code identity under a salt) is forgotten, so each call answers as a fresh process would however the project changed since the last.
  over: spec --check in a folder outside git and again after git init and an ignore file, beside a fresh spawned process
  via: cli() answers a second call as a fresh process would after the project changed under it: a folder made a repository that ignores a component
  because: a process that runs many commands holds what modules cached in the first (c-5bebbd18 names two), so a test that runs git init or ignores a file between two calls would read the first call's answer
  refuted: made cli() no longer forget the per-process caches before each call -> "cli() answers a second call as a fresh process would after the project changed under it: a folder made a repository that ignores a component" went red in cli-fixture.test.ts on its own assertion (the second call still listed the ignored component); restored byte for byte (cmp), green batched and alone (2026-10-13)
  kinds: none
- the mod is Coherence's own: Coherence's repository is the marketplace for its Claude Code mod and lists it at the package's version, and the tools whose PreToolUse the mod answers are generated from host-tools.ts's writers, never kept by hand.
  over: package.json's version, the mod's manifest, the marketplace file, and the mod's writers file against host-tools.ts
  via: the repository's marketplace lists the mod at the package's version, and the mod's writer tools are host-tools.ts's
  because: a second list of the writing tools is a hand list, which drifted once already (the mod had five of host-tools.ts's seven); and Claude Code updates a plugin by its version, so a mod whose version stood still would never reach anyone
  kinds: none
- the mod installs for one person from Coherence's repository: coherence hooks install --host claude --mod registers Coherence's repository as a marketplace and installs the mod, both at Claude Code's personal scope, then removes Coherence's personal settings hooks, keeps the committed ones and names each event they still hold back; uninstall takes the mod out first and drops only the marketplace declaration install wrote, never the marketplace itself. In a git worktree the personal settings it reads and edits are the main checkout's, where Claude Code's personal scope keeps them.
  over: a project with committed and personal hooks, a claude on the PATH that writes the personal settings as Claude Code's plugin commands do, a step that fails, and a worktree of the project
  via: hooks install --mod installs the mod at the personal scope from Coherence's repository, hands it the personal hooks, keeps the team's and names them, and uninstall takes out the mod and its declaration alone
  because: Claude Code knows a marketplace by its name on the whole machine, so registering a project's node_modules folder repointed every other project's mod at it, and removing the marketplace uninstalled the mod from every project (both seen on 2.1.295), and in a worktree its personal scope wrote the main checkout's file; the repository is one source for every project, and the mod runs each project's own Coherence; the fast path is opt-in, so it is personal, and the committed hooks are the team's to remove; the mod stands aside for any event a settings hook of Coherence's covers, so a personal hook left in place would leave it nothing to answer
  kinds: none
- the mod can be the team's: coherence hooks install --host claude --mod --shared registers Coherence's repository as a marketplace and installs the mod in the committed settings, then removes Coherence's committed Claude Code hooks and keeps every other host's; hooks --check and status read the mod there as answering every event, and uninstall takes it out and drops only the declaration install wrote.
  over: a project with committed Claude Code and Codex hooks, a claude on the PATH that writes each scope's settings as Claude Code's plugin commands do, --shared without --mod, the check and status, and the uninstall
  via: hooks install --mod --shared enables the mod in the committed settings in place of the committed Claude Code hooks, keeps the other host's, and uninstall takes it out
  because: a team that wants every member on the warm path, Coherence's own repository first, would otherwise hand-edit the committed settings, and the check would then call the missing hooks drift; the mod stands aside for every event a settings hook of Coherence's covers, so committed hooks left beside it would hold it back for everyone
  kinds: none
- Coherence's own repository runs its own mod: In Claude Code, Coherence's own repository runs each tree's own mods/coherence, linked from the project's skills folder, so the main checkout and every worktree run their own mod and Claude Code reloads it when a file of it is saved; its committed settings carry no Coherence hook and no installed copy, hooks --check says which mod runs and names an installed copy that would take the mod's name first, and hooks install --mod is refused there.
  over: the repository's own checkout: its skills-folder link, its committed settings, the check, and an install of the mod
  via: Coherence's own repository runs each tree's own mod from its skills folder, never an installed copy, and Codex through its start hooks
  because: developing the mod needs the tree's own code reloaded on save, which a copy installed from the marketplace never is; Claude Code loads a plugin from the project's skills folder and watches it, but refuses it when an installed plugin already has the name (seen on 2.1.295), so a copy installed for this repository would silently run in its place
  kinds: none
- the mod keeps Coherence's own files: While Coherence's mod is enabled, uninstalling the last settings hook of Coherence's keeps .coherence/.gitignore and .coherence/.gitattributes, because a host still runs Coherence.
  over: a project whose committed hooks are removed while its personal settings enable the mod
  via: while the mod is the only thing running Coherence, removing the last settings hook keeps .coherence's own files
  because: those files keep git from seeing Coherence's regenerated state and let two branches' records merge; the mod writes the same records the hooks do, so removing them while it runs would put the state in front of git again
  kinds: none
- a shared list is declared once: The hook events, the tool hooks, the agent hosts, the lockfiles and the package manager each names, the lexicon proposal actions, the sense review dispositions, the plural rules the vocabulary readers undo, and the interface budget flags are each declared in one module; telemetry's events and hosts, the latency budget, the benchmarks, ci install, the update line, the vocabulary check's excluded files, the lexicon verbs and their usage, lexicon coverage and every command that takes the budget flags read them from there, and the lexicon operations doc's lists are held equal to them.
  over: telemetry's summary events and hosts, a lockfile of each manager in a repository, the lexicon verbs' usage and docs/lexicon-operations.md, plural words read by both vocabulary readers, the usage of every command taking the budget flags and the partial map's advice; and every source module, CI script and benchmark, scanned for one of the lists written out as an array, a literal union or an alternation, a lockfile named by hand, or a plural rule of its own
  via: every list the hooks, telemetry, ci, the update line and the lexicon verbs share is read from the one module that declares it, and its usage and docs name exactly its members
  because: telemetry kept the hook events and hosts beside the hook's own, the latency budget, the status line and the scale benchmark each kept the tool hooks, ci and the update line each kept a lockfile table, lexicon-cli checked proposals against a copy of the Change type's actions and the dispositions were written out in the verb, the reviewer and the usage, the check and coverage each kept the plural rules, and three commands each spelled the budget flags; a value added to one would be summarized as nothing, refused, read as a different word or not parsed, and nothing would fail
  refuted: gave telemetry its own literal list of the hook events again, SUMMARY_EVENTS written out in place of HOOK_EVENTS -> "every list the hooks, telemetry, ci, the update line and the lexicon verbs share is read from the one module that declares it, and its usage and docs name exactly its members" went red in declared-once.test.ts on its own assertion; restored (cmp), green batched and alone (2026-10-12)
  kinds: none
