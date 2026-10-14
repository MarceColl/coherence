# Enforcement

Enforcement by detection: the chokepoint check with its grade ladder and automatic refutation, the totality oracle pass, the run as the primary record, and the warm server, with its authenticated socket and its guarded HTTP for the live Scope reading.
model: planned — refutation witnessing (recorded, then witnessed by a later pass) and the warm server's lock and idle lifecycle

## invariants
- run appended never rewritten: A run is appended as one line and never rewritten; the latest verdict per enforcement is a view derived from every run, and a skipped enforcement keeps its prior dated verdict.
  protects: appendRun
  chokepoint: performRun
  over: every run file under .coherence/runs and every enforcement in the spec
  via: a run appends one record, never rewrites; spec --check reads the run; the status view derives the latest verdict and keeps a skipped one dated
  because: the run is the primary record of a verification pass; a stored latest verdict would be a second truth that could disagree with the runs it summarizes, so the view is derived when asked, and an enforcement the latest run skipped shows its prior verdict with its date rather than a fresh-looking one; the one function that performs a pass is the only one that appends
  crossing: instrument -> record
  refuted: replaced the append in appendRun with a whole-file write -> "a run appends one record, never rewrites; spec --check reads the run; the status view derives the latest verdict and keeps a skipped one dated" went red in enforcement.test.ts; restored, green (2026-09-17)
  kinds: storage, revision
  checklist: scoped-reads dismissed: every reader sees every run; there is no scope
  checklist: encrypted-storage dismissed: a run is plain text a human reads
  checklist: key-rotation-compatibility dismissed: no key exists
  checklist: input-validation declared as session names the run file
  checklist: revision-preservation declared as run appended never rewritten
  checklist: commit-ordered-effects dismissed: the run's only effect is the file
  checklist: durable-dispatch-intent dismissed: nothing is dispatched after the append
  checklist: declared-target-coverage dismissed: one folder, one file per session
  checklist: completion-evidence dismissed: the append is complete when the call returns
- session names the run file: A run is refused when its session cannot name a file.
  over: every session a run is written under
  via: appendRun refuses a session that cannot name a file
  because: the session names the file, so a session with a path separator or a leading dot would write outside the runs folder or hide the file; the token rule is the journal's
  crossing: harness -> record
  refuted: disabled the session token check in appendRun -> "appendRun refuses a session that cannot name a file" went red in enforcement.test.ts; restored, green (2026-09-17)
  kinds: identity
  checklist: capability-authorization dismissed: the session token names a file and grants nothing
  checklist: canonical-encoding declared as session names the run file
  checklist: identity-continuity dismissed: a session's id never changes
- sites classified: Every reference to the protected thing and chokepoint is persisted with its file, line, symbol, class, and target: protected references are inside, test, or bypass, while an external reference to the chokepoint is a chokepoint-reference, never overloaded as inside, bypass, or a semantic runtime call.
  over: every reference the language server reports for a protected thing and its chokepoint, every form an adapter reads at one, and every old or unavailable run record
  via: a plain import specifier in the chokepoint's own module is inside; the same import elsewhere, a re-export anywhere, a wildcard re-export, and a use outside the chokepoint's range are bypasses
  because: a chokepoint holds while every reference to the protected thing is inside it, so those classes must partition every protected site. The import at the top of the chokepoint's module is how the chokepoint reaches the thing, not a place the thing is used, so ruling d-7abd1ba8 makes that one location inside; an export-from specifier or a wildcard re-export widens the protected thing's reach with no call at all, so it is a bypass even there. A test may reference either target to check it and is reported rather than counted as a bypass. References to the public door answer a different question: who relies on it. The chokepoint-reference class and of: chokepoint target preserve that distinction without changing the grade or bypass count; test location and adapter-observed import or re-export form are separate fields, and a type use or unused import need not execute a call. Sites are written only after both reference queries complete; absence on an unavailable or legacy entry means incomplete evidence, not a confirmed empty set, and old append-only records remain readable
  crossing: instrument -> reading
  refuted: dropped the rule that a plain import specifier in the chokepoint's own module is inside, so classifySite read that site by range like any other -> the totality oracle went red, then green once restored (2026-09-18); stopped querying references to the chokepoint, so the real TypeScript fixture's runtime and import-only chokepoint references disappeared from the classified sites -> the focused enforcement test went red, then green once restored (2026-09-18)
  kinds: none
- both endpoint sites recorded honestly: A completed chokepoint run persists protected references and chokepoint references, and an import-only chokepoint reference is reliance evidence without being called a runtime call.
  over: every completed protected-thing and chokepoint reference query, every persisted site, and every import-only reference to a public chokepoint
  via: run sites persist protected references and chokepoint references without turning an unused import into a call
  because: the producer is the durable fact boundary for reliance. Omitting the chokepoint query hides legal reliance; calling every reference a caller invents execution the adapter did not observe. The explicit chokepoint-reference class, of target, test bit, and optional import or re-export form retain exactly the evidence available while protected-reference grades, bypasses, and counts remain unchanged
  crossing: instrument -> record
  refuted: stopped querying references to the chokepoint, removing runtime and import-only reliance sites from run records -> the named producer test failed through `refute` and was recorded under session 01a0b5b0-4fe2-7592-987a-5711fbcb3596; restored, then a bound run for w-1a54ec05 passed and witnessed it (2026-09-18)
  kinds: none
- grade ladder: A chokepoint grades broken with a bypass or a missing chokepoint, reference-choked when clean and visible, visibility-choked when clean and not visible, and not chokeable when the protected thing is prose.
  over: every combination of bypass count, chokepoint resolution, visibility, and name form
  via: grades: broken with a bypass, reference-choked when clean and exported, visibility-choked when not exported, broken when the chokepoint is missing, not chokeable for prose
  because: the grade is what a human reads to know how much the structure is doing; a broken chokepoint graded clean would hide a structural defect, and prose graded as a chokepoint is the defect the reference's checks carried for months
  crossing: instrument -> reading
  refuted: made every clean chokepoint grade reference-choked whatever its visibility -> "grades: broken with a bypass, reference-choked when clean and exported, visibility-choked when not exported, broken when the chokepoint is missing, not chokeable for prose" went red in enforcement.test.ts; restored, green (2026-09-17)
  kinds: none
- automatic refutation: A chokepoint verdict is never recorded without its refutation: the adapter stages every synthetic site the classification could swallow, the instrument must report each one, nothing touches disk, and an unseen site makes the check vacuous, never a pass.
  protects: checkChokepoint
  chokepoint: performRun
  over: every chokepoint-form enforcement the run checks
  via: the automatic refutation stages a re-export in an unsaved document; a thing the module does not export is refused by the compiler; nothing is written to disk
  because: a check that would report nothing if the chokepoint were broken is vacuous; staging a synthetic reference and confirming the instrument sees it proves the instrument would report a real bypass, doing it in an unsaved document leaves the tree untouched, and every chokepoint verdict reaches the record through the one function that always attempts it. Since ruling d-7abd1ba8 makes one import location inside, the staging must cover both sites that ruling could otherwise swallow: a use in the chokepoint's own module past its range, and a re-export
  crossing: instrument -> record
  refuted: made the refutation open an empty synthetic document, so the re-export it stages was never there for the instrument to report -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: none
- refutation proves this check would fire: Every synthetic site the adapter stages is classified by the same function every other site goes through, and the refutation fires only when the check calls each one a bypass; where the graded rung's enforcer is the language, the compiler's or interpreter's refusal of the synthetic outside reference is the refutation instead, recorded as refused by the language with its diagnostic.
  over: every chokepoint-form enforcement whose synthetic sites the instrument reported, and every rung whose enforcer is the language
  via: the automatic refutation is vacuous unless the check's own classification calls the synthetic site a bypass
  because: the adapter decided outsideness itself and got it wrong in two ways the reviewers reproduced: a synthetic sibling document beside a protected thing under a test folder is a test reference, so nothing could ever be a bypass and the bullet read as a verified invariant; and a synthetic line appended to a module that is its own chokepoint fell past a range computed before the line was added, so the check called an inside site outside. Running the check's own classifier on every staged site is the only way the refutation proves the thing it claims: that this check, not the instrument, would go red. Ruling rs-e93ecdd6 adds the neighbouring case: where the language itself refuses every reference the check would call a bypass, Coherence's check can never be made to fire, and demanding it would leave a stronger rung weaker than the one below it, so the refusal is the proof
  crossing: instrument -> reading
  refuted: let every staged synthetic site count whatever the check's own classification called it, so a site classified inside or a test reference still fired the refutation -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: none
- not configured never passes: The totality oracle pass reports a missing test command as not run, never as passing, and a command whose output does not match is a fail.
  over: every totality oracle the run checks
  via: the totality oracle pass: configured command with a filter and a match; not configured is reported, never passing
  because: a project with no test command has no detector, and a pass would say the opposite; a runner that exits 0 when no test matched the name needs its output matched, or a renamed test would pass forever
  crossing: instrument -> record
  refuted: made a missing test command report pass -> "the totality oracle pass: configured command with a filter and a match; not configured is reported, never passing" went red in enforcement.test.ts; restored, green (2026-09-17)
  kinds: none
- one invocation for every test: When the config names a testJson command, every test the bullets name runs in one invocation, the results map back by name, and the record says which mode ran.
  protects: runTotalityBatch
  chokepoint: performRun
  over: every totality oracle the run checks
  via: the batched totality oracle pass: every test the bullets name in one invocation, mapped back by name; the record says which mode ran
  because: a runner whose setup is costly must not start once per test named; one invocation with a combined name pattern and a per-test report keeps the pass affordable, results map back by the same name the pattern selected, and the record says which mode ran so a one-at-a-time fallback is never mistaken for the batch
  crossing: instrument -> record
  refuted: made every totality entry record the one-at-a-time mode whatever ran -> "the batched totality oracle pass: every test the bullets name in one invocation, mapped back by name; the record says which mode ran" went red in enforcement.test.ts; restored, green (2026-09-17)
  kinds: none
- a report entry maps by exact title: A reported test belongs to the via it names by exact title, its own or one above it, with a stated fallback only for a runner that truncates titles in its report.
  over: every entry of every report the batched pass reads and every via a bullet names
  via: a report entry maps to a via by exact title, with the one stated fallback for a runner that truncates
  because: the batched pass selects by pattern and maps results back by name, so the mapping is the whole basis of a totality oracle's verdict; a substring mapping let a bullet's verdict come from a different test whose title merely contained its name, which means a neighbour's failure can fail this bullet and a neighbour's pass can carry it
  crossing: instrument -> record
  refuted: mapped a report entry to a via by substring again -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: none
- each alone after the batch: run --each runs every totality oracle's test the batched invocation ran again in its own invocation through the config's test command, appends those verdicts as a second run, names any that passed batched but fail alone, and exits non-zero when one does not pass alone.
  over: every totality oracle the batched invocation of a run --each ran
  via: run --each runs each batched totality oracle's test in its own invocation and catches one that passes only on an earlier test's leftovers
  because: one invocation for every test can hide a test that passes only on what an earlier test left behind (df-9e673484), and witness a refutation asks that the bullet's test pass alone; without a per-test mode, every enactment deviated on that step (en-182851e5, en-bc89997b), and a batched green could not tell a test that holds from one that leans on its neighbors
  crossing: instrument -> record
  refuted: made run --each reuse each test's batched result instead of running it in its own invocation -> the totality oracle went red on "alone, the reader fails", then green batched and alone once restored (2026-10-05)
  kinds: none
- the instrument outlives the test pass: A run keeps the instrument alive across the totality pass and asks it again afterwards; a run whose instrument did not survive records the reason on every entry it could not check and exits non-zero, never 0 with not run.
  over: every run that needs the instrument and runs the totality pass first
  via: the run keeps the instrument alive across the test pass, and a run whose instrument died exits non-zero with the reason
  because: the totality pass runs the project's whole suite before the first question, and the warm server's idle timer only resets on a request line, so a suite longer than the idle killed the instrument mid-run, recorded not run for every chokepoint, and exited 0: a run that proved nothing read exactly like a clean one, which is the one thing a verification pass must never do
  crossing: harness -> instrument
  refuted: removed the heartbeat that holds the warm server's idle timer open across the test pass -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: none
- warm server the only path: From a hook or a reading, the language server is reached only through the warm server: one door connects over the socket, spawns the server detached when none listens, and hands the adapter to the run or to the reading that asked.
  protects: connectAdapter
  chokepoint: withWarmAdapters
  over: every hook event that re-checks a chokepoint and every reading that needs the instrument itself
  via: two clients ask the same questions; the second finds the server warm
  because: a hook is short-lived and a cold project load is too slow for a check at the edit; every run and every reading (the economy's closure) connects through one door that finds the warm server or spawns it detached, so no hook and no reading can start its own cold instrument and wait on it
  crossing: harness -> instrument
  refuted: made the second client report a cold server whether or not one was warm -> the totality oracle went red, then green once restored (2026-09-18)
  kinds: none
- one warm server per root: However many clients find nothing listening at once, exactly one server process runs for a root: only the client that creates the root's lock file exclusively spawns, and every other client waits for the winner's socket.
  over: every client that connects to a root and finds nothing listening, and every serve process started for that root
  via: ten concurrent clients for one root are served by exactly one server process
  because: a check at the edit fires from several hooks and agents at once; without an exclusive lock each client that found no listener spawned its own server, each holding a language server of hundreds of megabytes, and six were seen for the main checkout within 30 seconds of one command and sixteen for one agent worktree (defect df-f947f1d1). An O_EXCL create is atomic on the local file system, so exactly one client wins; the lock names its owner's pid, and the spawning client hands it to the server it started
  crossing: harness -> instrument
  refuted: opened the root lock with "w" instead of "wx", so every client that found nothing listening created it and spawned -> the totality oracle went red, then green once restored (2026-09-22)
  kinds: none
- a dead owner's lock is reclaimed: A lock whose owner pid is dead, or alive but not listening long after it took the lock, is reclaimed by the next client, which then spawns the server; the reclaim runs under its own exclusive guard.
  over: every lock file a client finds when nothing listens on the root's socket
  via: a lock whose owner is dead is reclaimed by the next client
  because: a server killed by a signal or a crash never removes its lock, and a lock nobody can reclaim would leave the root with no server for good, every client waiting out its deadline at every edit; two reclaimers without a guard could each remove the lock and one could remove the other's fresh lock, which is the duplicate spawn again
  crossing: harness -> instrument
  refuted: stopped counting a lock whose owner pid is dead as stale, so nobody reclaimed it -> the totality oracle went red, then green once restored (2026-09-22)
  kinds: none
- serve never takes a held root: serve refuses to start while a live server holds the root's lock, and only the lock's owner unlinks the socket, the pointer, or the lock.
  over: every serve started for a root and every shutdown of a server
  via: serve refuses a root a live server holds and never unlinks that server's socket
  because: serve used to unlink whatever socket it found and stop unlinked the socket unconditionally, so two servers coexisted and the orphan's shutdown made the live one unreachable (review item 6: A-F12, B-F4), after which every client spawned yet another
  crossing: harness -> instrument
  refuted: made serve take the root's lock whoever held it, in this process or another -> the totality oracle went red, then green once restored (2026-09-22)
  kinds: none
- a warm server never answers with stale code: A client compares the fingerprint of the Coherence code on disk with the one the server reports; a server that runs other code is asked to stop, and a fresh one answers instead.
  over: every connection a client makes to a running server
  via: a server running other code is replaced by a fresh process
  because: a warm server started 41 minutes earlier kept answering with code that had since changed, and resolved a symbol to a worktree's file after the fix that forbade it (conjecture c-7ef91910); a verdict from old code is a verdict about nothing in the tree. The fingerprint is a hash of every source file under Coherence's src and its package.json, read from disk at each connect, so it is exact and costs a few milliseconds; a server that predates the fingerprint reports none and counts as other code
  crossing: harness -> instrument
  refuted: made the client accept a server whatever code fingerprint it reported -> the totality oracle went red, then green once restored (2026-09-22)
  kinds: none
- a server ends with its root: Besides idle shutdown, a server exits when its root directory no longer exists or its lock no longer names it.
  over: every running server, at every check of its lifetime
  via: a server whose root is deleted exits
  because: a removed worktree left its servers running until they idled, and a server displaced from its lock would otherwise answer beside the new owner; checking the root and the lock every few seconds ends both
  crossing: harness -> instrument
  refuted: made the lifetime check return before looking at the root or the lock -> the totality oracle went red, then green once restored (2026-09-22)
  kinds: none
- socket clients are authenticated: Every request line on the warm server's socket carries the root's token, a random secret in .coherence/run/http.json copied into the pointer, both readable by the user alone (mode 0600) as the socket is; a line without it, or with another, is refused and its connection closed.
  over: every request line the socket reads, and the modes of the pointer, the token file, and the socket
  via: a socket client without the root's token is refused, and the token lives only in files this user can read
  because: security review item B-F12: the socket was unauthenticated, and a root whose path is too long puts it in the shared temp folder, where any local process could ask the instrument to read the tree or stop the server. A caller that can read the pointer is the user; one that cannot gets nothing
  crossing: harness -> instrument
  refuted: let a request line through serve's line handler without checking its token -> the totality oracle went red; restored, green (2026-09-23)
  kinds: credential
  checklist: capability-authorization declared as socket clients are authenticated
  checklist: message-authenticity declared as socket clients are authenticated
  checklist: revalidated-permission dismissed: every line is checked against the token, so there is no granted session to revalidate
  checklist: encrypted-storage dismissed: the token rests on the user's own disk in files only the user can read; encryption at rest would guard against no one the file mode does not
  checklist: key-rotation-compatibility dismissed: removing http.json rotates the token at the next start, and a client reads it from the pointer at each connect
  checklist: separation-of-duties dismissed: one user asks one instrument; nothing is approved
- a client request times out: Every request a client sends the warm server fails after a bounded wait (seconds for status, stop and http, which the server answers at once; minutes for an instrument question), naming the method, rather than hanging on a server that stopped answering.
  over: every request a line client sends
  via: a client request the server never answers fails after its timeout, naming the method
  because: security review item B-F12: a client had no request timeout, so a wedged server hung every hook and run that asked it; status, stop and http never wait behind the instrument's queue, so their short bound cannot fire on a busy but healthy server
  crossing: harness -> instrument
  refuted: made LineClient.request ignore the timeout it was given -> the totality oracle went red; restored, green (2026-09-23)
  kinds: budget
  checklist: execution-budget declared as a client request times out
  checklist: bounded-admission dismissed: the server's queue admits every authenticated line; the bound is on the client's wait
  checklist: fair-admission dismissed: the clients are one user's hooks and runs
  checklist: rate-budget dismissed: the socket is the user's own and authenticated
  checklist: memory-budget dismissed: a timed-out request drops its pending entry
  checklist: circuit-breaker-policy dismissed: a request that times out fails once and its run records not run; there is nothing remote to trip a breaker on
- HTTP is loopback, tokened and same-origin: The warm server answers HTTP on 127.0.0.1 alone, and its one guard admits a request only when its `Host` header names that address or localhost with the server's port, its method is GET or HEAD, any `Origin` header names the server itself and no fetch is marked cross-site, and it carries the root's token (in the query for the page itself, in the Authorization header for everything else); no answer carries a CORS header.
  over: every request shape the guard sees (no token, a wrong token, the token in an API query, a foreign `Host` header, loopback on another port, a foreign `Origin` header, a cross-site fetch, POST, PUT, DELETE and a CORS preflight), every answer's headers, and every interface of the machine but loopback
  via: HTTP answers on loopback alone and refuses a request without the token, addressed to another server or sent from another site, or not a GET, and sends no CORS header
  because: the owner ruled the Scope reading be served live (d-eef7da19), which puts the whole model behind a local port. Any page the user visits can aim requests at localhost and a rebinding name at 127.0.0.1, so the `Host` header is checked against the server's own address, the token is required on every request and sent as a header a cross-origin page cannot make the browser add, and the API is read-only with no CORS header, so no other origin can read an answer
  crossing: local-caller -> reading
  entrances: scope http
  refuted: staged broken in turn in admitHttp and the HTTP listener: the Host header unchecked, the token not required, a bind to 0.0.0.0, Access-Control-Allow-Origin: * on every answer, every method but TRACE admitted, a foreign Origin header admitted -> the totality oracle went red for each; restored, green (2026-09-23)
  kinds: credential, message
  checklist: capability-authorization declared as HTTP is loopback, tokened and same-origin
  checklist: message-authenticity declared as HTTP is loopback, tokened and same-origin
  checklist: destination-confinement declared as HTTP is loopback, tokened and same-origin
  checklist: input-validation declared as HTTP is loopback, tokened and same-origin
  checklist: revalidated-permission dismissed: the token is checked on every request; nothing is granted beyond one answer
  checklist: encrypted-storage dismissed: the token rests on the user's own disk in files only the user can read
  checklist: key-rotation-compatibility dismissed: removing http.json rotates the token at the next start; a page must then be opened again from the new address
  checklist: separation-of-duties dismissed: one user reads; nothing is approved
  checklist: retry-recognition dismissed: every admitted request is a read with no effect, so a retry is harmless
  checklist: duplicate-suppression dismissed: a read has no effect to duplicate
  checklist: keyed-ordering dismissed: requests are independent reads; the event stream's order is the reading's own invariant
  checklist: acknowledgment-barrier dismissed: nothing is acknowledged; a page resumes from cursors derived from what it holds
  checklist: retry-classification dismissed: a refused request is refused for its shape and would be refused again
- HTTP requests time out: An HTTP client has a few seconds to send its headers and its request, and the server holds a bounded number of connections, so a client that never finishes cannot hold one open.
  over: every HTTP connection, from its first byte to its last header
  via: an HTTP client that never finishes its headers is cut off
  because: a port on loopback is reachable by every local process and, through the browser, by every page the user visits; a request that never finished would hold a connection, and enough of them would starve the page the user is reading. The event stream, once admitted, is long by design and carries a keepalive
  crossing: local-caller -> reading
  entrances: scope http
  refuted: gave HTTP a ten-minute header timeout and no request timeout -> the totality oracle went red; restored, green (2026-09-23)
  kinds: budget
  checklist: bounded-admission declared as HTTP requests time out
  checklist: execution-budget declared as HTTP requests time out
  checklist: fair-admission dismissed: one user on loopback
  checklist: rate-budget dismissed: every answer needs the token, and the server is the user's own
  checklist: memory-budget dismissed: requests carry no body, and answers are the bounded first load and history pages capped at 500 records
  checklist: circuit-breaker-policy dismissed: the server depends on nothing remote
- a run keeps each test's own time: A totality oracle's entry in a batched run carries the time its tests ran as the runner measured them, read from a jest-shaped report, JUnit XML, or pytest-json-report, and the run carries the machine's load and the batched invocation's time; a test the report gave no time is left untimed, never zero.
  over: every report shape the batched pass reads, with a test timed and one untimed
  via: a run records each test's time as its runner measured it, from a jest-shaped report, JUnit XML, and pytest-json-report
  because: one test's latency inside the one invocation is the whole invocation's (every batched entry carried the same number), so timing debt was invisible per test; the runner already measures each test and the reporter threw it away. An untimed test counted as zero would read as the fastest run it ever had
  refuted: counted a test the report gave no time as zero milliseconds -> "a run records each test's time as its runner measured it, from a jest-shaped report, JUnit XML, and pytest-json-report" went red in latency.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a test is slower only against its own history: A test is named slower when its latest time is over 2 s and over twice the median of its own previous timed runs (at least three, at most ten), and the bar rises with how much busier the machine was than its median load for that test.
  over: a test that doubled, one under the floor, one steadily slow, one with too little history, and one on a machine twice as busy, with and without a session
  via: a test is slower only against its own history: over twice its median and over the floor, allowing for a busier machine
  because: an absolute threshold would page constantly (the warm-server test failed only under four parallel suites, df-a67fad63) while a test measured against other tests says nothing about what grew; a ratio with a floor and a load allowance alarms on the shape that cost two weeks (d-55040f81) and stays quiet on a busy machine
  refuted: dropped the load allowance, so a test on a machine twice as busy met the same bar -> "a test is slower only against its own history: over twice its median and over the floor, allowing for a busier machine" went red in latency.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a nested verdict names its horizon: A chokepoint verdict over a project nested below its repository's top says that its reference search covered the project folder alone and callers elsewhere in the repository were not read, and keeps that folder as the result's horizon; a project at the repository top says nothing of it.
  over: a clean chokepoint in a project nested below the repository top
  via: a chokepoint verdict over a nested project says its reference search covered that folder alone
  because: in a monorepo the callers outside the adopted folder are the bypasses a product-boundary invariant exists for, and the language server is started on the project alone, so a clean grade with no qualifier claims more than the search read (df-0d235229)
  refuted: checkChokepoint returned the verdict over a nested project with no horizon and no qualifier -> "a chokepoint verdict over a nested project says its reference search covered that folder alone" went red in monorepo.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- the reference horizon widens the search: A project's config may widen where a chokepoint check searches for references: "project" (the default) searches the project alone, "repository" the whole repository, and a list of folders, each relative to the repository top, the project and those folders; a reference found in a horizon folder is classified like any in the project, and a verdict over less than the whole repository names every folder it searched.
  over: a bypass planted in another team's folder of a TypeScript and of a Python monorepo, checked under the default, under "repository", under a list naming its folder and under a list naming another
  via: the reference horizon widens a chokepoint check past the project: a bypass in another folder is found under repository and under a list naming it, and named as not searched under project
  because: in a monorepo the callers outside the adopted folder are the bypasses a product-boundary invariant exists for, and a check that never looks there grades a vacuous pass; widening by default would start the language server on the whole repository (on PostHog, products/notebooks with posthog and ee took 15.5 s and 1.1 GB where the project alone took 4.8 s and 380 MB), so the adopter names the folders that matter
  refuted: horizonFolders named no folder whatever the config said, so the search never left the project -> "the reference horizon widens a chokepoint check past the project: a bypass in another folder is found under repository and under a list naming it, and named as not searched under project" went red in monorepo.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a single-language config reads as it always did: A config with one language and the single test keys reads as one language and one test setup run at the root, its servers keep the plain names, and a config with no language is TypeScript.
  over: every config written before languages and test setups could be listed: one language, the single test keys, and no language at all
  via: a single-language config reads as it always did: one language, one test setup from the single keys, the plain server names
  because: every adopter's config predates the lists; a reading that changed what one language or the single keys mean would break each of them silently, and a server that moved to new file names would leave the old one running beside it
  refuted: made a config naming one language also list TypeScript, so a single-language config read as multi-language -> "a single-language config reads as it always did: one language, one test setup from the single keys, the plain server names" went red in languages.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a multi-language config is read whole or refused by name: A config may list its languages, the first the primary, and its test setups, each with its own runner, test files and folder; a file's language is its extension; a setup with no command, an unknown language, or a folder outside the root is refused with the key that is wrong.
  over: every language list and test setup a config can hold, and every file extension the two languages use
  via: a multi-language config lists its languages and test setups; a file's language is its extension; a malformed setup is refused by name
  because: one product in the PostHog monorepo is a Python backend and a TypeScript frontend, so a config with one language could adopt half of it; a malformed setup read as absent would leave a totality oracle silently not run
  refuted: dropped the refusal of a test setup that names neither test nor testJson -> "a multi-language config lists its languages and test setups; a file's language is its extension; a malformed setup is refused by name" went red in languages.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- each test runs through its own setup: A totality oracle's test runs through the test setup whose test files define it, in one batched invocation per setup, started in that setup's folder, and its entry names the setup's language.
  over: every totality oracle of a project with more than one test setup, batched and each one alone
  via: each totality oracle's test runs through the setup whose test files hold it, one batched invocation per setup, from the setup's own folder
  because: a pytest test given to jest is no test at all, and a no-match exit can read as a pass; PostHog runs a product's tests from the product folder against the repository's own pytest configuration, so the folder is part of the setup
  refuted: made the setup chooser send every test to the first setup, whatever test files define it -> "each totality oracle's test runs through the setup whose test files hold it, one batched invocation per setup, from the setup's own folder" went red in languages.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- each chokepoint is graded by its own language's server: A chokepoint is resolved and graded by the warm server of the language its protected thing is written in, one server per root and language, each reached only when a check needs it; the record names the language of each entry and of the run's instrument.
  over: every chokepoint of a project that spans languages, at a run, at a run of one invariant, and at the edit check
  via: each chokepoint resolves and grades through its own language's warm server, and a run or an edit reaches only the languages its checks need
  because: Pyright cannot resolve a TypeScript name, nor the TypeScript server a Python one, so one instrument for the project could grade only half of it; starting both servers at every edit would spend the latency budget on a language the edit never touched
  refuted: made every chokepoint take the primary language alone, so a TypeScript chokepoint was asked of Pyright -> "each chokepoint resolves and grades through its own language's warm server, and a run or an edit reaches only the languages its checks need" went red in languages.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a chokepoint governs what its from line names: A chokepoint whose from: line says outside the component or outside a folder classes a protected reference from inside that folder as exempt, reported and never a bypass, still calls a reference from anywhere else a bypass, and its automatic refutation stages a use from outside the folder that the check must call a bypass; from anywhere, the default, exempts nothing.
  over: a component whose own code references its protected internal, a facade module as the chokepoint, and a reference from another component, under from anywhere, outside the component and outside the folder, broken and clean
  via: a chokepoint from outside the component exempts its own references and still catches a bypass from another component; from anywhere calls both bypasses
  because: a narrow invariant (the secret is read only through one function) must count the component's own references, while a module boundary (PostHog's tach facade rule: outside code reaches a product's internals only through its facade) lets the module use its own internals; counting those as bypasses would grade every honest boundary broken. An exempt reference is classed and counted rather than dropped, so a reader sees the own references were exempted, not absent; and since the same-module synthetic use the import ruling needs is exempt there on purpose, a use from outside the folder takes its place, so the refutation still proves the exemption cannot swallow an outside use
  crossing: instrument -> reading
  refuted: made classifySite call a reference from inside the exempted folder a bypass instead of exempt -> "a chokepoint from outside the component exempts its own references and still catches a bypass from another component; from anywhere calls both bypasses" went red in from.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a silent bullet takes the config default: A chokepoint bullet with no from: line governs what the config's chokepointFrom names, a bullet's own from: line overrides it, an unreadable chokepointFrom is refused, and every run entry records which value governed and who said it.
  over: a silent bullet, a from: anywhere bullet and a from: outside a folder bullet, with chokepointFrom set to outside the component and unset, and a chokepointFrom no form reads
  via: the config's chokepointFrom governs a silent bullet, a bullet's own from: overrides it, and the run records and prints which governed
  because: a project whose chokepoints are mostly module boundaries should say so once rather than on every bullet, and a project-wide default must never be mistaken for a bullet's own word, so the record keeps the source beside the value; a typo in the default would silently govern anywhere, so it is refused
  crossing: project-source -> record
  refuted: made performRun ignore the config's chokepointFrom for a bullet with no from: line -> "the config's chokepointFrom governs a silent bullet, a bullet's own from: overrides it, and the run records and prints which governed" went red in from.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- the test suite leaves no process or temp folder behind: Once a test file's tests and their after hooks finish, no process it started is still running and nothing it made is left in the temp folder; a file that leaves either fails, naming each process with its command line and each folder, and what it left is then killed and removed.
  over: every test file npm test runs, and every process each one starts, detached or not, whether its command line or its inherited environment names the file's temp folder
  via: the leak guard fails a test file that leaves a process or a temp folder behind, names each, and passes one that cleans up
  because: a CLI-level hook test started a detached warm server that outlived the test and raced its cleanup, with every test green, until COHERENCE_NO_WARM_UP=1 was set for the suite; the first guarded runs then found three more test files whose hooks left a warm server running, two of them only on CI's runners, and eight that left fixture folders or a socket in the temp folder, three of them only under a name filter
  refuted: made the leak guard name and remove what a test file leaves behind without failing the file -> "the leak guard fails a test file that leaves a process or a temp folder behind, names each, and passes one that cleans up" went red in leak-guard.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- unchanged sites are written once per run file: A run entry whose reference sites are exactly the ones its enforcement's last entry in the same run file wrote is written with a reference in their place, their content's hash and the run in that file that holds them in full; changed sites, and an enforcement's first entry in each run file, are written in full, so a reference never leaves its file and any one run file, alone, resolves; loadRuns resolves every reference back into the sites it names, in the place a full write puts them, so no reader sees a reference; and a reference its file cannot resolve is said on the entry, among the damaged lines, in Scope's reliance, enforcement card and flow map, and in query, never read as no sites.
  over: two runs with the same sites, a run whose sites changed, another session's file with the same sites, each file taken away in turn, and a reference its file does not hold
  via: a run whose sites did not change stores a reference within its own run file that resolves to the same sites; changed sites are stored in full; a reference no record holds is reported, never an empty list
  because: the sites lists are 64% of the run store's bytes, rewritten in full for every chokepoint at every run though they rarely change, and they were what inflated every pull request (1.2 MB of records against 127 KB of code in one release). A reference into another session's file made the store depend on files that may never be committed: removing one subagent's run file left 11 latest entries unresolved; within one file, every file stands alone, and a reader older than this release, which knows no references, loses only a file's later entries' sites, never its first, and reports them unavailable. A reference that cannot be resolved must not pass for a check that found no references, the silent skip a vacuous check is made of
  refuted: let a reference point at the sites another session's run file wrote -> "a run whose sites did not change stores a reference within its own run file that resolves to the same sites; changed sites are stored in full; a reference no record holds is reported, never an empty list" went red in run-sites.test.ts on its own assertion (another session's first entry was written by reference); restored byte for byte, green batched and alone (2026-10-08)
  kinds: revision
  checklist: revision-preservation declared as unchanged sites are written once per run file
- a run's sites read the same by reference: Over this repository's own run store, two runs of one new session file, the second's sites written by reference, yield every view the store feeds (the loaded records, the latest verdict per enforcement) byte for byte as the same two written in full, in fewer bytes, and no line already in the store changes.
  over: this repository's run store, with its latest run carrying sites appended twice to one new session file, once in full and once by reference
  via: over this repository's run store, a run written with its unchanged sites by reference reads exactly as one written in full, in fewer bytes, and no line already written changes
  because: every reader of sites (the latest-entry views, the edit-time check, Scope's enforcement card and reliance, query) reads through loadRuns, so the resolution there must give back exactly what a full write gives; and the store is append-only, so nothing already written may be converted, which only a comparison of the raw lines can show, since loadRuns resolves every reference before anyone sees it
  refuted: put resolved sites after every other key instead of where a full write puts them -> "over this repository's run store, a run written with its unchanged sites by reference reads exactly as one written in full, in fewer bytes, and no line already written changes" went red in run-sites.test.ts on its own assertion (the views differed byte for byte); restored byte for byte, green batched and alone (2026-10-08)
  kinds: revision
  checklist: revision-preservation declared as a run's sites read the same by reference
- an append asks the sites shard, never its run file: Writing a run asks what its session's run file last wrote in full of its sites shard in the run index, kept per run file with the file's identity and size, and never reads the run file itself; beside a session file ten times as long, every read, stat and listing the append makes weighs the same, each read by its bytes, and the file is read back for the appended line alone, by the index's fold; a shard that cannot say (none, or kept for the file as it no longer is) writes the sites in full and starts again from that line, and every reference written resolves.
  over: a session file of 30 runs and one of 300, each carrying forty sites that change at every run, with the edit hook's index current, then the shard taken away, and the file appended to by another writer
  via: an append asks its run file's sites shard, never the file: beside ten times the session's runs it reads the same bytes, and a shard that cannot say writes the sites in full
  because: writing a reference read and parsed the session's whole run file at every append, so a run grew slower with every run the session had made before it; the shard is a few hundred bytes whatever the file's length, and it is kept for one exact state of the file, so a file it no longer matches costs one larger line, never a reference that does not resolve
  refuted: read the session's whole run file at every append again, as compactRecord did before the shard -> "an append asks its run file's sites shard, never the file: beside ten times the session's runs it reads the same bytes, and a shard that cannot say writes the sites in full" went red in run-sites.test.ts on its own assertion (the session's run file is read for the appended line alone); restored byte for byte, green batched and alone (2026-10-08)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is on one append's work
  checklist: execution-budget declared as an append asks the sites shard, never its run file
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: no quota over time; the bound is on one append's work, whatever the rate
  checklist: memory-budget dismissed: the shard is a few hundred bytes per run file; the bound stated is on reads, not allocation
  checklist: circuit-breaker-policy dismissed: no dependency is called; a shard that cannot say is the fallback, a full write
- run at a registry's top runs each listed project: run at the top of a repository whose config lists projects runs each listed project from its own folder, with its own config and its own run records, heads each project's printed verdicts with its folder, runs no folder the registry does not list, records nothing at the top, and exits 1 when any project's run would.
  over: a registry of two projects, one with a bypass, beside an unlisted folder holding a spec
  via: run at a registry's top runs each listed project from its own folder, its records in each
  because: run at the top read the whole repository as one project with the top's keys, so it ran specs no registry lists and wrote its records at the top (df-3c6a666d); the CI check runs there for a registry, and spec --check already read each listed project there
  refuted: runCommand never took the registry branch, so run at the top read the whole repository as one project again -> "run at a registry's top runs each listed project from its own folder, its records in each" went red in ci.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-09)
  kinds: none
- a run's named invariants all name bullets: A run given --invariant names runs only if each one names a bullet, by its own name or as its component folder and name the way refute takes it; otherwise it runs nothing, records nothing, names each unmatched name and exits 64.
  over: a real name beside a misspelled one, and a bullet given as its component folder and name
  via: run refuses an --invariant that names no bullet, running nothing, and takes a bullet by its component folder and name too
  because: a name that matched no bullet was dropped without a word, so a run of nine names whose fifth was mistyped ran eight, reported them passing and exited 0, and a refutation confirmed through it would read as witnessed for a bullet it never ran (df-5c88f106)
  refuted: let run go on without the names that match no bullet, as before -> "run refuses an --invariant that names no bullet, running nothing, and takes a bullet by its component folder and name too" went red in each.test.ts; restored (cmp), green batched and alone (2026-10-12)
  kinds: none
