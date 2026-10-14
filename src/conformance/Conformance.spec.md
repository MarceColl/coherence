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
