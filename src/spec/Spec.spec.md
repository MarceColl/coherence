# Spec

The spec grammar and the model: one bullet shape, with each bullet's state derived from what it carries and from the latest run.
model: none — deriveState is a pure classifier of a bullet and its latest run, pinned case by case in spec.test.ts and floor.test.ts

## invariants
- retired sections refused: A section the reference used is refused by name with its replacement, and any other section is refused as unknown.
  protects: RETIRED_SECTIONS
  chokepoint: retiredSection
  over: every section in retired-sections.json
  via: every retired section is refused by name with its replacement
  because: the reference's sections are the shape agents remember; refusing each by name and saying what replaced it turns a habit into one edit, and keeping the names as data read by one function keeps them out of code and prose
  crossing: project-source -> reading
  refuted: inverted the retired-section test in the parser so a retired name passed as unknown -> "every retired section is refused by name with its replacement" went red in spec.test.ts; restored, green (2026-09-17)
  kinds: none
- requirement until complete: A bullet lacking enforcement, a witnessed refutation, kinds, or an answered checklist is a requirement, never an invariant; a missing because is reported and does not change the state.
  protects: deriveState
  chokepoint: loadSpecModel
  over: every bullet in every spec under the root
  via: the state derivation: the full bullet is an invariant, and each missing part keeps it a requirement
  because: an invariant is a claim that something detects its violation; a bullet that names no enforcement, has never been seen to fire, or skipped its checklist is a plan, and calling it an invariant would let a plan pass as detection; the derivation lives in one function that only the model loader calls, so no reading can compute a different state
  crossing: project-source -> reading
  refuted: stopped deriveState from recording a missing enforcement as a lack -> "the state derivation: the full bullet is an invariant, and each missing part keeps it a requirement" went red in spec.test.ts; restored, green (2026-09-17)
  kinds: none
- refutation is a recorded event: A totality oracle's refutation is witnessed only by a refutation record in the run store together with a later run that found the same totality oracle passing; the bullet's refuted: line is the human account and satisfies nothing on its own, and refutation is required per enforcement, so a bullet carrying both forms needs both.
  over: every bullet with a totality oracle form, and every refutation record in the run store
  via: a totality oracle's refutation is a recorded event: the refuted line never satisfies it, a record with a later passing run does, and a bullet with both forms needs both
  because: this carries no chokepoint form on purpose: witnessedRefutations is reached only by loadSpecModel, but the import specifier that brings it into model.ts is a reference outside that function, so a chokepoint naming the symbol would be a claim this tool itself grades broken on the day it is written (escalation e-1fd35e17 asks the owner to rule on the seven older bullets in that position). Both reviewers measured 32 of the 52 bullets reported as invariants resting on a parseable sentence with nothing linking it to a red result, and a chokepoint written entirely in prose with a self-asserted refuted line read as a full invariant with 0 problems from spec --check, the only check npm test runs; a refutation is the witnessed firing of an enforcement, so it must be an event the tool watched (the totality oracle red with the break staged, then green once restored), and the chokepoint's automatic refutation proves nothing about the totality oracle standing beside it
  crossing: record -> reading
  refuted: let the bullet's own refuted: line satisfy a totality oracle's refutation again, with no record behind it -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: none
- placeholders count as absent: A value still in angle brackets parses, counts as absent, and is listed as unfilled.
  over: every key of the grammar
  via: a placeholder value parses but counts as absent
  because: the scaffold writes every slot first so the shape is never wrong; a placeholder that counted as a value would make an unfilled bullet look complete
  crossing: project-source -> reading
  refuted: made isPlaceholder answer false for every value -> "a placeholder value parses but counts as absent" went red in spec.test.ts; restored, green (2026-09-17)
  kinds: none
- a refuted line parses in linear time: A refuted line's date is matched anchored at the end and its arrow by position, never by a lazy group on each side, and three digit groups that name no day are refused.
  over: every refuted: line in every spec, of any length
  via: a long refuted value parses in linear time, and three digit groups that name no day are refused
  because: loadSpecModel runs on every hook event, and the old pattern put a lazy group before the arrow, another before the date, and \s* between them: 156 KB of a value that reaches an arrow and never reaches a date took 16.5 s, and one interior run of 8 KB of spaces took 161 s, so any agent-authored spec was a stall the session could not explain; and a date of three digit groups let 2026-13-45 stand as the day a refutation was witnessed
  crossing: project-source -> reading
  refuted: made the date check accept any three digit groups again, so 2026-13-45 stood as a day -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: none
- half a form is a problem: Half an enforcement form, an unknown key, a bad crossing, or a bad refutation is a problem reported with its file and line.
  over: every key on every bullet: the two enforcement pairs, the crossing, the refutation, and any key the grammar does not name
  via: half an enforcement form, an unknown key, a bad crossing, and a bad refutation are problems
  because: a bullet with protects and no chokepoint claims a structure nobody can check, and a key the grammar does not name is a slot the agent invented; reported as a problem with its line, each is fixed before it can pass as a requirement
  crossing: project-source -> reading
  refuted: let a bullet carrying one key of an enforcement pair through without a problem -> "half an enforcement form, an unknown key, a bad crossing, and a bad refutation are problems" went red in spec.test.ts; restored, green (2026-09-17)
  kinds: none
- trust levels in the entry spec only: A crossing names two declared trust levels, and only the entry spec declares them.
  over: every crossing in every spec and every trust levels section
  via: the model: crossings name declared trust levels, and only the entry spec declares them
  because: a crossing is a query key, every chokepoint where agent input reaches the record; a level declared in two places or named in none would split the key, and one short list in the entry spec keeps it whole
  crossing: project-source -> reading
  refuted: disabled the problem for a trust levels section outside the entry spec -> "the model: crossings name declared trust levels, and only the entry spec declares them" went red in spec.test.ts; restored, green (2026-09-17)
  kinds: none
- one spec per folder: Names are unique within a component, a declared-as name must exist, and a folder holds one spec.
  over: every spec file under the root and every declared-as line in it
  via: the model: names are unique within a component, declared-as names must exist, and one spec per folder
  because: a checklist line declares a shape as a named invariant; if the name matched two bullets or none, the declaration would point nowhere, and a folder with two specs would be two components in one place
  crossing: project-source -> reading
  refuted: disabled the duplicate-name problem in loadSpecModel -> "the model: names are unique within a component, declared-as names must exist, and one spec per folder" went red in spec.test.ts; restored, green (2026-09-17)
  kinds: none
- entrance trust names a declared level: An entrance's trust: line names a trust level the entry spec declares, and a level's one marker is (outside); an unknown level, another marker, or an empty or second trust line is a problem, and a placeholder counts as absent.
  over: every trust: line on every entrance and every marked trust level line
  via: the model: an entrance's trust names a declared trust level, and a trust level's one marker is (outside)
  because: the ruling d-ba18b0fd: a level nobody declared is a trust nobody defined
  crossing: project-source -> reading
  refuted: dropped the unknown-level problem from entranceTrustProblems, so a trust: line naming no declared level passed -> the totality oracle went red; restored, green (2026-09-23)
  kinds: none
- declared trust agrees with the handler's crossing: A declared entrance trust that differs from the entering side of a crossing whose chokepoint is its handler, in the component holding the handler, is a problem naming both.
  over: every entrance with a trust: line against every crossing-bearing invariant whose chokepoint is its handler, bare or with its file
  via: the model: an entrance's declared trust contradicting a crossing on its handler is a problem
  because: the crossing's entering side is the trust the handler receives (d-a5e5c691): a disagreeing declaration states one fact twice, once wrongly, so it fails spec --check
  crossing: project-source -> reading
  refuted: let entranceTrustProblems skip every crossing on the handler, so a declared trust that contradicts it passed -> the totality oracle went red; restored, green (2026-09-23)
  kinds: none
- a module handler exists: An entrance's handler may name a module file, whose top-level script receives the work; it resolves under the component, then the root, and a missing file or one that is not source code is a problem.
  over: an entrance naming an existing script, a missing one, and a file that is not source
  via: the model: an entrance's handler may be a module file whose top-level script receives the work, and it must exist
  because: module-top-level scripts had no way to declare a command entrance (praetorium.gg, d-127ab8e4); a module that does not exist is a handler nobody wrote
  crossing: project-source -> reading
  refuted: returned a module handler's first candidate path in handlerFile without checking the file exists -> the totality oracle went red; restored, green (2026-09-25)
  kinds: none
- an ignore entry that names nothing is a problem: An entry of the project's own config's ignore list that names no file or folder at its path from the root and, as a bare name, no folder of that name on any project file's way down, and that names nothing git ignores, is a problem at the config, so it fails spec --check; the walk the model already takes answers, and git is asked once only when some entry names nothing there.
  over: a file and a folder named by path, a folder named by its name below the root, and a folder on disk git ignores, against a typo, a path that moved, a file path that does not exist, and a file named by its bare name below the root
  via: an ignore entry that names no file or folder is a spec problem; a folder by name or path, a file by path, and a folder git ignores are not
  because: the list accepted any string and an entry that matched nothing left nothing out in silence, so an adopter's "CHANGELOG.md" did nothing and nothing said so (praetorium.gg); a typo in a bound is the same silence. A folder git ignores holds no project file but is no typo, so the disk answers first
  crossing: project-source -> reading
  refuted: made ignoreProblems in model.ts skip every entry as though it named something, so a typo, a moved path and a bare file name below the root were accepted in silence -> "an ignore entry that names no file or folder is a spec problem; a folder by name or path, a file by path, and a folder git ignores are not" went red in src/adapters/ignore-files.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- an ignore entry git ignores is no problem: An ignore entry that names nothing on disk or in the project's listing is still no problem when git ignores what it names: a path entry as a file or a folder at its path, a bare name as a folder at the root or under any folder the project holds, asked of git in one git check-ignore over every such entry, and never when every entry names something.
  over: dist and build gitignored and absent in a single-package repository, a monorepo's dist gitignored by its packages and present in one of them only, a gitignored absent path, and a typo beside each
  via: an ignore entry git ignores is no spec problem though nothing it names is there: dist and build absent in a single-package repo, and dist only in a monorepo package; a typo beside them still is
  because: "ignore": ["dist", "build"] is a common and correct config: the output is gitignored, so git's listing never holds it, and in a fresh checkout or CI it is not on disk, or sits only in a package; reported, it failed spec --check and refused subagent stops for a config that bounds the output whenever a walk outside git meets it (review of PR #67). The check stays a problem, not advisory: what remains after git is asked is an entry that leaves nothing out in any checkout, the silence the check exists to end, and an advisory line is read past as the CHANGELOG.md entry was
  crossing: project-source -> reading
  refuted: made ignoreProblems in model.ts treat no entry as gitignored, replacing git check-ignore's answer with an empty set, so dist and build absent from a fresh checkout and a dist only in a package were reported -> "an ignore entry git ignores is no spec problem though nothing it names is there: dist and build absent in a single-package repo, and dist only in a monorepo package; a typo beside them still is" went red in src/adapters/ignore-files.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- a stored project name that disagrees with the config is a note: A project lexicon whose project field names the project otherwise than the config's name, ignoring case, is a note at the lexicon's project line in spec --check, never a problem, so it fails no check and refuses no stop; a lexicon that stores none, or one that agrees, says nothing.
  over: a lexicon storing a name that differs from the config's, one storing it in another case, one storing none, and one under a config that names no project
  via: a stored project name that disagrees with the config's name is a note at the lexicon, never a spec problem; one that agrees, none stored, or no configured name says nothing
  because: lexicon apply wrote the folder's name as the lexicon's project and every reader of the lexicon took it over the config's, so an adopter whose folder differed from his config's name had the wrong name accepted and added his own to wellKnown to get by (praetorium.gg); the field still reads where the config names nothing, so an existing lexicon is never renamed, and a copy that disagrees is said rather than quietly outvoted; it is a note, not a problem, because lexicon apply wrote the field until #67, so an adopter carries a disagreeing copy into the upgrade without doing anything, and a copy no reader takes changes no answer: as a problem it refused a stop in PostHog's ee/api on the first verification after #67 merged (df-be527a7b)
  crossing: project-source -> reading
  refuted: made the stored name a problem again, pushed into the model's problems -> "a stored project name that disagrees with the config's name is a note at the lexicon, never a spec problem; one that agrees, none stored, or no configured name says nothing" went red in src/lifecycle/project-name.test.ts; restored byte for byte, green (2026-10-08)
  kinds: none
- a module handler may carry route segments: An entrance's handler naming a module file resolves as a module file when its path carries a framework's route segments ([slug], [...slug], [[...slug]], (group), (.)intercepted, @slot), and a spec in such a folder is a component; such a file that does not exist is still a problem.
  over: every route segment form in a module handler's path, a spec in a (group) folder, and a missing file under such segments, against a symbol in a file and a path without an extension, which stay no module
  via: the model: a module handler's path may carry route segments, [slug], [...slug], [[...slug]], (group), (.)intercepted and @slot, and it must still exist
  because: every Next.js App Router route lives under such segments, so handler: api/auth/[...nextauth]/route.ts was refused as neither a symbol nor a module file at a real adoption (df-0a67c462)
  crossing: project-source -> reading
  refuted: narrowed isModuleHandler's path characters back to letters, digits and _./@-, refusing [ ] ( ) -> "the model: a module handler's path may carry route segments, [slug], [...slug], [[...slug]], (group), (.)intercepted and @slot, and it must still exist" went red in src/spec/spec.test.ts; restored, green (2026-10-05)
  kinds: none
- a re-exported or destructured handler is declared: A handler name is declared at the top level of a file that exports it in an export list, with or without a from and under its alias when it has one, or binds it in an object destructuring on one line or across several, nested or not; a key the destructuring reads through, an imported name and the name a re-export renames are not.
  over: every export list shape (re-export from a module, renamed, local, type) and every destructuring shape (one line, several lines, nested, typed), against a destructuring key, an import, a renamed source name and braces that assign nothing
  via: the model: a handler an export list re-exports, or a destructuring across lines declares, is declared at the top level of its file
  because: a Next.js route file re-exports NextAuth's GET and POST, which a multi-line destructuring declares, so handler: GET in api/auth/[...nextauth]/route.ts was not found at a real adoption (df-a0e893af); the re-exporting file is where the framework finds the name and the source is not followed (d-7155e46f)
  crossing: project-source -> reading
  refuted: made declaresAtTop ignore export lists, so a name a route file re-exports was not declared there -> "the model: a handler an export list re-exports, or a destructuring across lines declares, is declared at the top level of its file" went red in src/spec/spec.test.ts; restored, green (2026-10-05)
  kinds: none
- an entrance guard names a chokepoint: An entrance's guard: line names a chokepoint some invariant declares, by its symbol, or a symbol declared in a chokepoint that is a module; any other name, an empty line, or a second guard line is a problem.
  over: every guard: line: a chokepoint's symbol, a symbol of a chokepoint module, a name no invariant declares, an empty and a second line
  via: the model: an entrance's guard: line names a chokepoint an invariant declares, or a symbol of a chokepoint module
  because: a guard declares a control the map will count once the reading confirms the registration (d-127ab8e4); one naming no declared chokepoint would claim an enforcement nobody declared
  crossing: project-source -> reading
  refuted: skipped the problem in entranceGuardProblems, so a guard naming no declared chokepoint passed -> the totality oracle went red; restored, green (2026-09-25)
  kinds: none
- control none carries its reason: An entrance's control: none line carries a non-empty reason, and never stands beside a guard: on the same entrance; any other control: value, an empty reason and a second line are problems, and an unfilled placeholder claims nothing.
  over: every control: line of an entrance: with a reason, bare, with an empty reason, with a placeholder, with another value, twice, and beside a guard:
  via: the grammar: an entrance's control: none carries a non-empty reason and never stands beside a guard:
  because: an entrance that needs no control is a claim a human must be able to challenge (d-a1095ef2), and only a stated reason can be challenged; an empty one is a silent waiver, and one beside a guard contradicts itself, since a guard is a control
  crossing: project-source -> reading
  refuted: made the grammar accept control: none with an empty reason, dropping the problem -> the totality oracle went red; restored, green (2026-09-25)
  kinds: none
- an invariant names the entrances it covers: An invariant's entrances: line names entrances some spec declares, each resolving in its own spec, then in the one spec that declares it, or as <name> in <folder>, and each whose declared trust its crossing enters from or enters; an unknown, ambiguous or mismatched name, none beside a name, a name twice, the line on a chokepoint form and the line on a bullet with no crossing are problems, entrances: none says it checks no entrance, and a placeholder counts as absent.
  over: the adopter's signature check naming its notification route, a route no spec declares, a route one other spec declares, a name two other specs declare bare and qualified by folder, a crossing from another trust, and the grammar's none, none beside a name, a doubled name, a chokepoint form, no crossing and a placeholder
  via: the model: an invariant's entrances: line names declared entrances whose trust its crossing checks; an unknown, ambiguous or mismatched name, none beside a name, a name twice, a chokepoint's line and one with no crossing are problems
  because: a test-backed control is credited only to the entrances an invariant names (Scope's a test-backed control is the entrance's own), so a name that resolves to nothing, or to an entrance whose trust the crossing never checks, would read as coverage while crediting nothing; a chokepoint's entrances are traced, and a line with no crossing checks no trust
  crossing: project-source -> reading
  refuted: dropped the problem for a name that resolves to no declared entrance, in coveredEntranceProblems -> the totality oracle went red; restored, green (2026-10-08)
  kinds: none
- a control lost to the crossing alone is named: spec --check prints, after the counts and never as a problem, each verified invariant enforced by a totality oracle alone that covered entrances carrying outside trust in by its crossing alone (owned where they are declared or handled, its crossing checking their trust) with the entrances that lost it, and the line that names them; naming any entrance on it, or entrances: none, ends it, and an unverified invariant gave no control to lose.
  over: the adopter's shape with the signature check unnamed, named and none, verified and unverified, and the server's invariant naming no entrance
  via: spec --check names each entrance a verified invariant covered by its crossing alone, never as a problem, until the invariant names the entrances it checks or says none
  because: adopters' invariants that relied on the crossing alone lose that credit, and a loss no command names is a silent change in what the map calls controlled; it is advisory, since the credit was the over-claim and naming what a test checks is the adopter's to decide
  crossing: project-source -> reading
  refuted: made creditedByCrossingAlone ignore the entrances: line, so naming no longer ended the advisory -> the totality oracle went red; restored, green (2026-10-08)
  kinds: none
- a practice is paired with its spec: A practice file stands only in a folder whose spec shares its stem; one beside no spec, under another stem, or second in its folder is a problem.
  over: every practice file under the root: beside no spec, under another stem, and paired
  via: a practice file stands only beside its folder's spec, with the spec's stem
  because: owner ruling d-861e8319: a spec and its practice file are always paired, so the component stays the unit; a practice file alone would make a folder half a component, and one under another stem would read as a second component's
  refuted: dropped the problem for a practice file beside no spec, so a loose practice file was skipped silently -> "a practice file stands only beside its folder's spec, with the spec's stem" went red in practice.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: none
- an enacted practice keeps what it taught: Once a practice is enacted, a step or pitfall that any of its enactments carried out, of any version, and the practice no longer holds is a problem until a decision recorded at or after the latest enactment that carried it out cites an enactment of the practice and names the practice's id in what it chose; enacting the edited practice clears nothing, adding is free, and a practice never enacted changes freely.
  over: every practice with an enactment, against the text every one of its enactments carried out, and every decision that cites one of them
  via: a step enacted and since removed is a problem until a decision cites an enactment of the practice
  because: this is what keeps a gain from slipping back: a method decays by losing steps silently, and its pitfalls each cost a defect to learn; a removal must say why and cite what was carried out, while additions and candidates stay cheap so that practices get written at all
  refuted: made floorGaps read only the latest enactment, and separately take any decision citing an enactment as the amendment without naming the practice -> "a step enacted and since removed is a problem until a decision cites an enactment of the practice" went red in practice.test.ts on its own assertion each time; restored byte for byte, green (2026-10-06)
  kinds: revision
  checklist: revision-preservation declared as an enacted practice keeps what it taught
- a practice rests on evidence that exists: Every record or commit a practice cites resolves, here or on another branch, every invariant it names is declared, and a practice that cites nothing is a problem.
  over: every citation in learned: and pitfall: lines and every name in invariants: lines across the project's practice files
  via: every record a practice cites must exist, and every invariant it names must be declared
  because: a practice is learned, not wished: what makes it binding is the record of the failure it prevents, and a citation of nothing would make an invented step read as witnessed
  refuted: made practiceProblems accept a cited record id that no store holds -> "every record a practice cites must exist, and every invariant it names must be declared" went red in practice.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: none
- a shallow clone leaves a cited commit unchecked: A commit a practice cites is no commit only where git can tell: a full clone that does not hold it is a problem; a shallow clone that does not hold it is a problem only when the hash names some other object the clone holds, or more than one, because its depth may have cut the commit off; git is asked whether the clone is shallow only when some cited commit is missing.
  over: a cited commit a full clone holds, one no clone holds, one a depth-1 clone cut off, and a file's hash a depth-1 clone holds
  via: a cited commit is no commit only where git can tell
  because: a hosted agent sandbox clones at depth 1, so every commit an adopter's practices cited read as no commit and Stop reported each one, though the remote held them all; a shallow clone cannot confirm a commit it lacks, so it says nothing of one, but a hash that names a file or a tree here, or several objects, is no commit at any depth (review of PR #86); a full clone, as the workflow ci install writes fetches, still catches every wrong one
  refuted: made missingCommits in commits.ts report every missing commit without asking whether the clone is shallow, as before the fix -> "a cited commit is no commit only where git can tell" went red in practice.test.ts on the shallow clone citing an older commit; restored byte for byte, green batched and alone (2026-10-10)
  kinds: none
- a leaves line belongs to the step above it: A leaves: line in a practice belongs to the step written above it whatever its indentation: four spaces, two or a tab parse to the same steps and the same version.
  over: one practice with leaves: under its second step at four spaces, two spaces and a tab
  via: a leaves: line belongs to the step above it whatever its indentation: four spaces, two, or a tab parse alike
  because: the docs show leaves: four spaces in, and a formatter such as oxfmt flattens it to two, which made an adopter think the practice broke; the parser reads key lines in order and never measures their indent, and this keeps it so
  refuted: made a leaves: line indented fewer than four spaces a problem -> "a leaves: line belongs to the step above it whatever its indentation: four spaces, two, or a tab parse alike" went red in practice.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- a command trigger matches its words in place: A when: command trigger fires when its words are adjacent words of one simple command, in order; a word with * or ? is a glob over one word (* any run of non-blank characters, ? one), so command resolved df-* fires on resolved followed at once by an argument starting df- and on no other; a word without them must equal the command's word, as before; quoted text and a heredoc's body never fire a trigger, and the words, patterns included, are part of the practice's version.
  over: a pattern trigger on its next argument, on another argument, on a later argument, with no argument, on a quoted argument with blanks, inside a quoted argument, inside a heredoc and after a separator, a ? pattern, the text fallback, and a trigger without a pattern on its words, on a longer word, on a quoted argument and on any argument
  via: a command trigger's words match whole words of one simple command in place, a glob word one word, and never quoted text or a heredoc's body
  because: a trigger that names only the verb fires on every use of it, and resolved closes conjectures as well as defects, so resolving a conjecture delivered the whole of close a defect, and the session recorded it with every step skipped (df-ebbc84e3); the next word, not any later one, keeps the form one reading: the trigger's words are a phrase of the command, and a flag's unquoted value is never read as the thing the command acts on
  refuted: dropped the ^ and $ from a glob word's pattern, so df-* matched anywhere inside a word, a quoted argument with blanks included -> "a command trigger's words match whole words of one simple command in place, a glob word one word, and never quoted text or a heredoc's body" went red in practice.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- a trigger that names no file is a problem: An edit trigger of an adopter's practice whose path matches no file of its project is a spec problem at the practice's when: line, naming the path, that paths in a when: line are relative to the project's folder, and what to write instead: the path less the leaf's folder when that matches a file of the leaf, the files it names outside the project when it names another leaf's, or to correct or remove it; adopt names each when a folder becomes a project; a kernel practice's triggers are not read, and a glob used twice in one practice is named once.
  over: a leaf's trigger written from the repository top, another leaf's file, a path that is nowhere, a pattern that matches, a whole-repository project's path, a mistyped one, and adopt with and without one
  via: a practice's edit trigger that names no file of its project is a spec problem saying what to write instead
  because: the PostHog adoption moved from one whole-repository project to registry leaves and its practices kept triggers written from the repository top, so edit posthog/auth.py inside the posthog leaf named posthog/posthog/auth.py and never fired, and nothing said so (df-b277ba29); a trigger that cannot fire is a silent skip, and the project's own file list is the one reading that decides it
  refuted: made deadTriggers pass every trigger as matching a file -> "a practice's edit trigger that names no file of its project is a spec problem saying what to write instead" went red in dead-triggers.test.ts with its two siblings; restored byte for byte, green (2026-10-08)
  kinds: none
- the dead-trigger check pays for its triggers: The check that an edit trigger names a file of its project asks git only for the literal paths its triggers name, in one listing, and for a pattern only the folder before its first wildcard; its listings are the same size however many other files the project holds.
  over: one project beside 20 and beside 2000 unrelated files, a literal trigger and a pattern trigger
  via: the dead-trigger check lists only what its triggers name, so a project ten times larger costs it nothing more
  because: the spec model loads several times in one hook, and each load runs the check; listing the whole project at each load added half a second to PostHog's first leaf entry (4.2 s against 3.6 s, interleaved, one power state), past the 3 s latency budget it was already over
  refuted: put back the whole-project listing the check first shipped with -> "the dead-trigger check lists only what its triggers name, so a project ten times larger costs it nothing more" went red in dead-triggers.test.ts; restored, green (2026-10-08)
  kinds: none
- a dead trigger is looked for outside its leaf as narrowly: When a leaf's trigger names no file of the leaf, the check looks for what it names elsewhere in the repository as it looked inside: a literal path in one pathspec listing, a pattern only under the folder before its first wildcard; never a listing of the whole repository.
  over: a leaf whose literal and pattern triggers name a file in another folder, beside 20 and beside 2000 unrelated files
  via: a dead trigger in a leaf is looked for outside it as narrowly, so the repository's size costs the check nothing
  because: while a trigger stays dead, every one of a hook's model loads looks for it outside the leaf, and a listing of PostHog's whole repository at each would cost far more than the half second the narrow check saved (df-4be1892a)
  refuted: put back the whole-repository listing for the outside lookup -> "a dead trigger in a leaf is looked for outside it as narrowly, so the repository's size costs the check nothing" went red in dead-triggers.test.ts on the listing size; restored, green (2026-10-08)
  kinds: none
- kernel practices reach adopters: In an adopter, the practices whose reach is kernel are delivered beside the project's own with their ids led by coherence:, and an internal practice never leaves Coherence's tree.
  over: Coherence's practice files as an adopter reads them: kernel and internal
  via: in an adopter, the kernel practices are delivered beside the project's own, their ids led by coherence:, and an internal practice is not
  because: a practice for using Coherence's own commands (witnessing a refutation) applies in every adopter from the first session, so adoption starts with the method already learned; a practice about Coherence's own tree (its lexicon budget) would be noise anywhere else
  refuted: made kernelPractices take every practice with a reach, so an internal one reached adopters -> "in an adopter, the kernel practices are delivered beside the project's own, their ids led by coherence:, and an internal practice is not" went red in practice.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: none
- every Coherence practice declares its reach: In Coherence's own tree each practice declares reach: kernel or reach: internal, an unknown value is a problem, and a reach line in any other project is a problem.
  over: a practice in Coherence's tree with no reach, with each value, with an unknown value, and an adopter's practice with one
  via: in Coherence's own tree every practice declares its reach, kernel or internal; anywhere else a reach line is a problem
  because: a practice whose reach was never decided either fails silently to reach adopters or puts Coherence's own steps into every adopter's sessions; never examined and examined are different facts (d-8ed21083), so the reach is said, and as a value set so a later reach is one more value (owner, 2026-10-05)
  refuted: dropped the problem for a practice in Coherence's tree with no reach line -> "in Coherence's own tree every practice declares its reach, kernel or internal; anywhere else a reach line is a problem" went red in practice.test.ts on its own assertion; restored byte for byte, green (2026-10-05)
  kinds: none
- a config the registry does not list is a problem: spec --check at a registry's top reads each listed leaf, never the rest of the repository, and names every coherence.config.json below the top that no listed leaf holds as adopted there but not opted in; a check in a leaf names it too.
  over: a registry listing two leaves beside a folder holding a config and a spec it does not list, checked at the top and in a leaf
  via: spec --check names a nested config the registry does not list as adopted there but not opted in, at the top and in a leaf
  because: with a registry the list decides adoption, so a config outside it is ignored by every hook; said nowhere, that folder would look adopted to whoever wrote it and be half adopted in fact
  refuted: registryProblems named the listed leaves' configs instead of the unlisted one -> "spec --check names a nested config the registry does not list as adopted there but not opted in, at the top and in a leaf" went red in registry.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- from and owners lines are declared and checked: A chokepoint bullet's from: line reads anywhere, outside the component or outside a folder under the root, anything else or a from: on a bullet with no chokepoint form is a problem, and a header's owners: line lists the component's owners without joining its intent.
  over: every from: form, a value no form reads, a folder that climbs above the root, a from: on a totality oracle bullet, and a header with an owners: line
  via: from: reads anywhere, outside the component, or outside a folder on a chokepoint bullet, and refuses anything else
  because: which references a chokepoint governs decides its grade, so a misspelt value must be a problem rather than silently governing anywhere; owners are a declared fact a human reads beside the intent, and folding them into the intent made them prose no reading could list
  crossing: project-source -> reading
  refuted: made buildInvariant attach a parsed from: value only to a totality oracle form, so no chokepoint carried one -> "from: reads anywhere, outside the component, or outside a folder on a chokepoint bullet, and refuses anything else" went red in from.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a kernel practice's floor is Coherence's: In an adopter, a kernel practice (its id led by coherence:) has no floor: a step or pitfall a Coherence release removed asks the adopter for no amendment, at enact or at spec --check, and the adopter's earlier enactments stand as its history; a project's own practices keep their floor, and in Coherence's own tree the kernel practices keep theirs.
  over: an adopter's enactment of a kernel practice whose recorded steps include one the current release dropped, re-enacted and checked
  via: in an adopter, a kernel practice a Coherence release changed asks no amendment: enact goes through and spec --check names no floor gap
  because: Coherence amended witness a refutation in its own tree with decisions recorded there (d-33275b1c, d-8f2cbc3b), and every adopter that had enacted the earlier version was then refused at enact until it recorded an amend decision of its own; that decision is not the adopter's to make, so an agent in the PostHog adoption left its enactment unrecorded rather than attribute Coherence's amendment to the adopter
  refuted: read a kernel practice's floor in an adopter like the project's own -> "in an adopter, a kernel practice a Coherence release changed asks no amendment: enact goes through and spec --check names no floor gap" went red in practice.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- an invariant is not demoted silently: A bullet the run store graded an invariant (each run entry records the state it left its bullet in, and an entry from before that counts when it passed with a witnessed refutation) that is now missing, a requirement, or without an enforcement form it was graded with is a problem naming what it lost, until a decision recorded at or after that grading names the bullet as component/name in what it chose or what it turned away; a run of the demoted bullet grades it a requirement and moves nothing, a rename carrying the same via: or chokepoint is recognized, and a bullet never graded an invariant is free.
  over: every bullet any run entry graded an invariant, against the bullet the specs now hold under its name or its recorded enforcement, and every unretracted decision
  via: an invariant the run store graded is not demoted, removed, or renamed away without a decision naming it; a requirement never graded is free
  because: df-f3826eaa: a pull request inserted a bullet between an invariant and its checklist lines, the invariant fell back to a requirement, and spec --check reported 0 problems because a requirement is lacking, never a problem; the run store is the reference (not git HEAD, which in CI is the commit under review and so compares the change with itself) because it already loads for every check and remembers what was witnessed
  crossing: record -> reading
  refuted: made the floor skip a bullet that kept its enforcement and fell back to a requirement, as df-f3826eaa's did -> "an invariant the run store graded is not demoted, removed, or renamed away without a decision naming it; a requirement never graded is free" went red in floor.test.ts on its own assertion (one problem for the lost checklist); restored byte for byte, green batched and alone (2026-10-07)
  kinds: revision
  checklist: revision-preservation declared as an invariant is not demoted silently
- the defect floor names closes and repeats: spec --check names each defect closed with neither a guard whose refutation is witnessed nor a decision, saying whether its guard names no bullet or an unwitnessed one, and names each defect recorded in a class after a close guarded that class as a guard failure, the protection weaker than claimed; both are advisory, counted on one defects line and never a problem.
  over: a guarded close, a later defect classified into its class, a close with neither, a close whose guard is unwitnessed, and a close with a decision
  via: spec --check names a defect closed with neither a guard nor a decision and a defect in an already guarded class as a guard failure, without counting either as a problem
  because: the practice floor keeps what an enactment taught; the defect floor keeps what a defect should have bought, a guard for its class or a reason, and a repeat in a guarded class is the one signal that a guard was weaker than its refutation claimed; advisory because a close cannot be unwritten, and a problem would refuse every later stop for a record nobody can repair
  crossing: record -> reading
  refuted: made the floor count a defect as a guard failure only when recorded before the guard, so a later repeat went unnamed -> "spec --check names a defect closed with neither a guard nor a decision and a defect in an already guarded class as a guard failure, without counting either as a problem" went red in defects.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a family's guard answers only for its own defect: A defect class declared as a family (the property family <name> of the defect concept, as audience is) is accepted wherever a class is, and its guards never stand for the family: a later defect in a family is no guard failure, while a later defect in a class a resolution already guarded still is.
  over: a family defect closed with a witnessed guard and a later one in the family, beside the same sequence in a class
  via: a family's guard answers only for its own defect, so a later defect in the family is no guard failure, while a class keeps the rule
  because: audience covers every message and every piece of guidance, so the guard of its first guarded defect (the CI offer) stood for the whole class and turned two unrelated wording defects into guard failures (c-5c824314); the owner chose broad classes over splitting audience into single-member classes (d-a02fd009)
  refuted: let a family's witnessed guard stand for the family, as a class's does -> "a family's guard answers only for its own defect, so a later defect in the family is no guard failure, while a class keeps the rule" went red in src/journal/defects.test.ts; restored (cmp), green (2026-10-09)
  kinds: none
- a spec names its model or says why not: A spec's model: line names a .qnt file that exists beside it, or says none or planned with its reason; a malformed, empty or doubled line is a problem, and where the config sets models a spec with no line is a problem, while a project that never sets it hears at most an advisory.
  over: every spec in a project with models set, the three values of the line, each malformed form, a file that is missing or climbs out of the component, and the valid adopter inputs: a project that names no model, and one that names some without requiring the line
  via: a spec names its quint model or says why not: a .qnt file, or none or planned with its reason; a missing line is a problem only where the config requires it
  because: a spec with no model and no reason leaves "a model makes no sense here" and "nobody wrote one" indistinguishable; the line makes the choice explicit and checkable, and a project that never opted in is never failed for a line it was never asked for
  crossing: project-source -> reading
  kinds: none
