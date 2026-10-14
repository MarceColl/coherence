# Conformance

Quint models held against the code: quint run through one door, the code's own tests captured under a collector, and every trace replayed through the model with agreement and coverage reported.
model: none — the conformance machinery checks models against code; a model of the checker would be checked by the checker it models

## entrances
- trace collector: a test process conform spawned posts the events its instrumented sites logged, and declares each test's outcome, over loopback HTTP
  handler: startCollector in collector.ts
  trust: local-caller

## invariants
- quint runs only through quint.ts: Every quint command Coherence runs is spawned by runQuint, bounded by a timeout that kills its process tree, and read into one outcome where only ok passes.
  protects: quintBin
  chokepoint: runQuint
  because: a quint prop or a replay that spawned quint itself could read a timeout, a missing binary or a model checker that never started as a pass; one door reads every outcome the same way, and a step that did not answer is never ok
  crossing: instrument -> record
  kinds: none
- captures are written only by store.ts: A capture is written whole under its capture hash, aside and then renamed, and read back only by the module that writes it; nothing else names the folder captures live in.
  protects: CAPTURE_DIR
  chokepoint: src/conformance/store.ts
  because: a replay that read a capture half written, or one kept under a hash other than the code's, would replay traces the code never produced; one module names the folder, writes whole, and checks the hash on read
  crossing: instrument -> record
  kinds: none
- conformance verdicts are only appended: The conformance store is written only by appendVerdict in store.ts, one line per model per conform, never rewritten.
  protects: CONFORMANCE_DIR
  chokepoint: src/conformance/store.ts
  because: a quint prop reads its model's latest verdict as the model's standing against the code; a verdict another path could rewrite would let a disagreement read as agreement
  crossing: instrument -> record
  kinds: none
- a failed test leaves no trace: The collector queues a test's run only when the test declares ok, discards it when failed, counts a run never declared as unfinished, and opens a fresh run for a name that posts after its outcome.
  over: every run the collector holds: declared ok, declared failed, never declared, and opened again after its outcome
  via: a failed test leaves no trace: ok queues the run, failed discards it, and a name posting after its outcome opens a fresh run
  because: a failing test's events may describe work that never completed; a green run built on them would replay events that never happened in a passing execution
  crossing: local-caller -> record
  entrances: trace collector
  refuted: made the collector queue a run whose test declared failed, as it queues one declared ok -> "a failed test leaves no trace: ok queues the run, failed discards it, and a name posting after its outcome opens a fresh run" went red in src/conformance/collector.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- a scopeless event is refused: An event that names no scope is refused with 422, and nothing of the batch it came in is taken.
  over: every event a client posts, alone or in a batch
  via: a scopeless event is refused with 422, and nothing of its batch is taken
  because: in a repository of several components, an event with no scope would be replayed through every model, and traces would mix components no model describes together
  crossing: local-caller -> record
  entrances: trace collector
  refuted: let eventProblem take an event whose scopes list is empty -> "a scopeless event is refused with 422, and nothing of its batch is taken" went red in src/conformance/collector.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- a stale client is told so: A request without the protocol header, or with another version, is refused with 426 naming the client's version and the collector's; only /health answers without one.
  over: every route but /health, with the header missing, at another version, and at the collector's
  via: a stale client is told so: a missing or other protocol version is refused with 426 naming both, and /health answers without one
  because: a vendored client drifts from the collector it talks to; refused by name, the drift is one edit, where a client silently dropped would leave a capture empty with no error
  crossing: local-caller -> record
  entrances: trace collector
  refuted: let a request with no protocol header past the version check -> "a stale client is told so: a missing or other protocol version is refused with 426 naming both, and /health answers without one" went red in src/conformance/collector.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- the collector answers no web page: The collector answers only at 127.0.0.1 under its own token, to a host header that names it, and refuses any request that carries an origin header or is marked cross-site.
  over: a wrong token, an origin header, a cross-site fetch, a rebound host header, and an unknown route
  via: the collector answers only its own token, on its own host, and never a web page
  because: any page the user visits can aim a request at loopback while conform runs; a page that could post events would forge the evidence the model is held against
  crossing: local-caller -> record
  entrances: trace collector
  refuted: dropped the origin header check from admitTrace, so a web page's request reached the routes -> "the collector answers only its own token, on its own host, and never a web page" went red in src/conformance/collector.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- the client is inert without the collector URL: Without COHERENCE_TRACE_URL the client sends nothing and opens no socket and no timer, and its absence is kept for the process's life.
  over: a process that logs with no collector URL set
  via: the client is inert without the collector URL: tracing is false, and logging opens no socket and no timer
  because: the client is called at real sites in the code; outside a capture it must cost nothing and change nothing, or instrumenting the code would change the behavior it records
  crossing: project-source -> record
  refuted: made the client fall back to a loopback address when COHERENCE_TRACE_URL is absent -> "the client is inert without the collector URL: tracing is false, and logging opens no socket and no timer" went red in src/conformance/coherence-trace.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- a value is encoded without calling into it: The client copies a logged value without reading a getter or calling toJSON, records an accessor as such, and tags Map and Set.
  over: plain values, a getter that throws, a toJSON, a bigint, a Map of Sets, and a class instance
  via: a value is encoded without calling into it: no getter is read, no toJSON is called, Map and Set are tagged
  because: observing must not change what is observed: a getter or a toJSON run by the logger could mutate the state the next step reads, or throw where the code would not
  crossing: project-source -> record
  refuted: made the encoder read each property through the object, calling its getters -> "a value is encoded without calling into it: no getter is read, no toJSON is called, Map and Set are tagged" went red in src/conformance/coherence-trace.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- the vendored client is the shipped client: scaffold client writes the shipped client and its hooks byte for byte, never overwrites a file that exists, and --check names one absent or edited.
  over: an empty folder, a folder holding the shipped files, and one holding an edited client
  via: the vendored client is the shipped client: --write writes it once and never overwrites, and --check names an absent or edited file
  because: a client edited in place may log under another protocol or encode differently; overwriting it would lose the adopter's edit, and --check is how the drift is found
  crossing: project-source -> record
  refuted: let scaffold client --write overwrite a vendored file that differs from the shipped one -> "the vendored client is the shipped client: --write writes it once and never overwrites, and --check names an absent or edited file" went red in src/conformance/coherence-trace.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- the runner spawns the tests, never the reverse: The test command is spawned only after the collector listens, with its URL and the vendored hooks in the environment, and no test name inherited from whoever ran conform.
  over: the environment conform hands the test command, with NODE_OPTIONS, a test name and a node:test context already set
  via: the runner spawns the tests, never the reverse: the URL and the hooks are in the test command's environment, and an inherited test name is not
  because: a process that starts before the URL exists caches its absence and the collector hears nothing, with no error: the most common silent failure of a capture
  crossing: project-source -> instrument
  refuted: left COHERENCE_TRACE_URL out of the environment the runner hands the test command -> "the runner spawns the tests, never the reverse: the URL and the hooks are in the test command's environment, and an inherited test name is not" went red in src/conformance/runner.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- a capture with no trace fails: A capture that queued no trace fails with its cause and is never kept, even when every test passed.
  over: a project with no hooks vendored, and one whose sites log nothing while its tests pass
  via: a capture with no trace fails, naming why: no hooks vendored, or sites that log nothing
  because: an empty capture replays green against any model; zero traces is the symptom of the client being inert, never evidence of agreement
  crossing: instrument -> record
  refuted: dropped the empty-capture failure from capture, so a capture with no trace was kept -> "a capture with no trace fails, naming why: no hooks vendored, or sites that log nothing" went red in src/conformance/runner.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- the capture hash moves with the code, never with the model: The capture hash changes with a source or test file, the vendored client and the capture-side config, and never with a model, a spec or a record; the replay hash changes with the model.
  over: an edit to the model, a test file, the vendored client, and the test command
  via: the capture hash moves with a test or source file and the client, never with the model; the replay hash moves with the model
  because: the hashes decide between running the suite again and replaying what is kept; a model edit that forced a capture would make iterating on the model as slow as the suite, and a code edit that did not would replay traces the code no longer produces
  crossing: project-source -> record
  refuted: counted the .qnt models among the files the capture hash is taken over -> "the capture hash moves with a test or source file and the client, never with the model; the replay hash moves with the model" went red in src/conformance/runner.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- conform replays a kept capture without the tests: conform runs the tests only when no capture is kept for the code as it is, replays a kept one after a model edit without spawning them, reads back a verdict it already holds, and refuses --replay-only once the code moved.
  over: a first conform, one after a model edit, one with nothing changed, and --replay-only after a code edit
  via: conform captures once, replays a kept capture without running the tests, reads back a verdict it holds, and refuses --replay-only once the code moved
  because: the agent is never asked to reason about staleness: the hashes decide, and a replay-side fix costs a replay, not the suite
  crossing: instrument -> record
  refuted: made conform capture again whatever was kept -> "conform captures once, replays a kept capture without running the tests, reads back a verdict it holds, and refuses --replay-only once the code moved" went red in src/conformance/runner.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- a deliberately wrong model fails replay: Against a real capture of a fixture program's own tests, the correct model replays every trace and each deliberately wrong model (a guard weakened, an update off by one, a parameter renamed, an action dropped, a rejection accepted) fails replay.
  over: the counter fixture's captured traces against its correct model and five wrong ones
  via: wrong model: the correct counter model replays every trace, and each deliberately wrong model fails replay
  because: if a deliberately wrong model replays green, nothing downstream of replay means anything; the house rule for a new instrument reader is to hold it against a real corpus before trusting it
  crossing: instrument -> record
  refuted: made replay report every trace matched whatever its steps found -> "wrong model: the correct counter model replays every trace, and each deliberately wrong model fails replay" went red in src/conformance/replay.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- a failing guard is an unmatched trace: A step whose guards do not all hold on the pinned arguments fails its trace at that step, recorded as refused with the false guards and the pinned values, never skipped as a stutter.
  over: every step of every trace, against a model whose update is off by one
  via: a failing guard is an unmatched trace: an update off by one fails its conformance fact at the first bump, named with the pinned values
  because: a guard relaxed or a step skipped to make a trace pass edits a real divergence away; a failing guard is a finding, and the code is assumed wrong before the model
  crossing: instrument -> record
  refuted: made replay pass over a step whose guards refused it, as a stutter -> "a failing guard is an unmatched trace: an update off by one fails its conformance fact at the first bump, named with the pinned values" went red in src/conformance/replay.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- a rejected attempt must be refused by the model: An event logged rejected replays as a stutter only when some guard of its action, conformance facts aside, is false on the pinned arguments; a model that allows it fails the trace.
  over: every rejected event, against a model whose reset accepts an empty counter
  via: a rejected attempt must be refused by the model: a model whose reset accepts an empty counter fails the test that refused it
  because: dropping refused attempts loses the adversarial evidence replay most needs; a stutter with no check would let a model accept what the code refuses
  crossing: instrument -> record
  refuted: made replay take a rejected attempt as a stutter even when the model allows it -> "a rejected attempt must be refused by the model: a model whose reset accepts an empty counter fails the test that refused it" went red in src/conformance/replay.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- an exceeded search cap fails: A parameter no argument pins is searched only over a finite domain within perPick, perStep and perRun; exceeding a bound, or a parameter with no domain, fails the trace before quint runs.
  over: a parameter with more alternatives than perPick, a step past perStep, one with no domain, and one within the bounds
  via: an exceeded search cap fails: a parameter with more alternatives than perPick, or a step past perStep, fails its trace before quint runs
  because: an unbounded search finds some value that makes almost any trace pass; the bound is part of the check, and running past it proves nothing
  crossing: instrument -> record
  refuted: dropped the perPick bound from planTrace -> "an exceeded search cap fails: a parameter with more alternatives than perPick, or a step past perStep, fails its trace before quint runs" went red in src/conformance/replay.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- the report counts the arguments that pin: Every report says N/M logged args pin a step choice, names each argument that pins nothing, fails a drop in that ratio against the model's last verdict, and gives each failure the side that can fix it.
  over: a model whose parameter was renamed, and a refusal under a code move and under a model move
  via: the report says N/M logged args pin a step choice, names each argument that pins nothing, and classifies a refusal by the side that moved
  because: an argument whose name no parameter takes checks nothing while the run stays green; without the ratio a real check and a decorative one look the same
  crossing: instrument -> reading
  refuted: made the report count every logged argument as pinning -> "the report says N/M logged args pin a step choice, names each argument that pins nothing, and classifies a refusal by the side that moved" went red in src/conformance/replay.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
- every guard scenario is exercised or acknowledged: A guard found true and false is tested; one never false that the probe can falsify is a gap; one the probe cannot falsify fails until the config acknowledges it with a reason.
  over: the counter's guards with every test, without the test that refuses a bump over three, and with an acknowledgement
  via: guard scenario: a guard found true and false is tested, one never false that can be is a gap, and one no input can falsify fails until acknowledged with why
  because: agreement is satisfiable by a permissive model; coverage of each guard's refusal path is what makes the model's guards count
  crossing: instrument -> reading
  refuted: made coverage read a guard the probe falsifies and no test refused as tested -> "guard scenario: a guard found true and false is tested, one never false that can be is a gap, and one no input can falsify fails until acknowledged with why" went red in src/conformance/replay.test.ts; restored (cmp), green batched and alone (2026-10-14)
  kinds: none
