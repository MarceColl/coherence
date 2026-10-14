# Conformance replay

A quint model is worth something only while it still describes the code.
`conform` checks that, continuously, with the project's own test suite as the
source of real executions: no hand-written scenarios, no mocks. The code is
instrumented at its own sites, the tests run under a collector, and every
captured trace is replayed through the model. Two things must hold, and a run
is green only when both do:

| Axis | Question |
|---|---|
| Agreement | Does every captured trace replay through the model? |
| Coverage | Did the tests reach the model's landmarks and both sides of its guards? |

Agreement alone is cheap to satisfy with a permissive model; coverage alone
proves nothing about fidelity.

## The one idea

An event carries no state: `(action, arguments, scope)`. Replaying it proves
only that the model allows the action there, never that it computes the same
state. So each mutating site also logs a cheap **conformance fact** about the
state after it (a count, a phase, the order's state), as an extra argument
named exactly as a parameter of the model's action, and the action guards
that parameter equal to its own computed post-state:

```quint
// step supplies the fact as a singleton choice, so simulation pays nothing
nondet after = Set(stateOf(moved(orders, id, target), id)).oneOf()
move(id, target, after)

// the action: the parameter's name is the logged argument's
action move(id: str, target: str, state_after: str): bool = all {
  orders.keys().contains(id),
  isLive(orders, id),
  state_after == stateOf(moved(orders, id, target), id),   // the conformance fact
  orders' = moved(orders, id, target),
}
```

At replay the parameter is pinned to the logged value, so a divergence fails
the guard and the trace does not replay. The check is opt-in per operation, as
strong as the fact chosen, and cannot reach below the model's abstraction.

## Writing the model

An action replay can drive is a thin wrapper over pure updates: its guards,
each a top-level conjunct with no primed variable, then one assignment per
variable through a pure function. An action that assigns inside an `if` or
calls another action mixes a guard with an update, and `conform` refuses it
with the cause rather than replaying it loosely. A guard of the form
`<parameter> == <expression>` is a conformance fact and never a guard
scenario.

- **Landmarks** are `val landmark_<name>` booleans: moments of the behavior a
  test should reach. A trace's **behavior family** is the order in which its
  landmarks first hold.
- **Domains** are `pure val domain_<parameter>`: the finite set a parameter
  no argument pins is searched over, and the inputs the guard probe draws
  from. Without one, the probe draws from the values the traces logged.

## Instrumenting the code

```sh
coherence scaffold client --dir test/coherence --write
```

writes the trace client and its node:test hooks into the project, byte for
byte (`--check` reports drift; an existing file is never overwritten). Call the
client directly at each site; a wrapper of the project's own is where
instrumentation quietly stops firing:

```ts
import { log, tracing } from "../../test/coherence/coherence-trace.ts";

if (tracing()) log("work.move", { id, target, state_after: folded.state }, { scopes: ["journal.work"] });
// a refusal the model makes too: the same action, rejected, before the throw
log("work.move", { id, target }, { scopes: ["journal.work"], rejected: true });
```

- Every event names at least one **scope**, the component it belongs to; the
  collector refuses one with none.
- Name each argument exactly as the model parameter it pins. An argument no
  parameter takes pins nothing, and the report names it.
- Log a real identity (a sequential or minted id), never a constant.
- A **rejected** attempt logs its action's parameters except the conformance
  facts; replay requires the model to refuse it too.
- The client is inert without `COHERENCE_TRACE_URL`, so the suite runs as
  before outside a capture. Values are copied without calling into them: no
  getter is read and no `toJSON` called.

## Configuring it

```json
"conformance": {
  "testCommand": ["node", "--test", "src/journal/journal.test.ts"],
  "client": "src/conformance",
  "required": true,
  "models": {
    "src/journal": {
      "scopes": ["journal.work"],
      "names": { "work.move": ["move"] },
      "search": { "perPick": 10, "perStep": 50, "perRun": 5000 },
      "acknowledged": [{ "guard": "create#1", "because": "work create mints a fresh id, so no caller can ask for one that exists" }]
    }
  }
}
```

Each key under `models` is a component folder whose spec names its model on
its `model:` line. `buildCommand`, `testCommand`, `cwd` and `client` decide
what the code emits (capture-side). `scopes`, `names`, `search` and
`acknowledged` decide only how the kept traces are read and replayed
(replay-side). `required` makes every quint prop of a model wait for that
model's current, agreeing verdict (see
[enforcement.md](enforcement.md#quint-properties)). See
[config.md](config.md) for every key.

## Running it

```sh
node src/cli.ts conform [--model <folder>] [--capture | --replay-only] [--verbose] [--json] --session <id> --agent <name>
```

1. The build command runs, when there is one.
2. The collector starts on `127.0.0.1`, under a token minted for this run.
3. The test command runs from the config's folder, with the collector's URL
   exported and the vendored hooks loaded through `NODE_OPTIONS`. The runner
   spawns the tests, never the reverse: a process started before the URL
   existed would cache its absence and log nothing, with no error.
4. Each test's events are queued only when the test passed; a failed test's
   are discarded. A capture with no trace fails with its likely causes.
   While two tests that do not nest run at once in one process, an event
   could belong to either: it is counted unattributed, never given to one,
   and the capture fails.

The capture is kept under its **capture hash** (the protocol, the vendored
client, the capture-side config, and every project file a test could run;
never a model, a spec or a record). The **replay hash** adds the model, every
`.qnt` file it imports, the replay-side config, and quint's version, backend,
seed and simulation and verify bounds. The next `conform` replays the kept
capture without running the tests when only the model or the replay-side
config moved, and reads back the latest verdict it holds for the same replay
when nothing did, so a forced capture's newer verdict outweighs an older one.
`--capture` forces a capture; `--replay-only` refuses to take one. Nobody has
to reason about staleness.

## Replay

For each trace, event by event: the logged name resolves through `names`
(one name may map to several actions, and exactly one may fire); parameters
are pinned by name; a parameter nothing pins is searched over its domain
within `search`, and a bound exceeded fails the trace; every guard is
evaluated on the state the trace reached. A failing guard is an unmatched
trace, never a skipped step. Where a search left several values enabled and
the first one fails a later step, the trace is replayed again with each other
enabled value at each earlier step, within `perRun` runs; it matches when any
run of choices replays every step. A guard `<parameter> == <expression>` is a
conformance fact only when no other conjunct and not the expression reads
that parameter; an equality on an input the action also reads is a guard. Quint offers no external pinning, so replay
writes quint: a module per capture and model that imports the model, records
every guard and landmark in variables of its own, and a second module that
runs each matched trace again through the model's own actions, which must
pass. Each step's resolution is kept: the action that fired or refused, the
pinned and searched values, the false guards, the variables written.

## The report and the verdict

Per model: traces replayed out of captured, each unmatched trace with its
first failing step and false guards, the line **`N/M logged args pin a step
choice`** with every argument that pins nothing, the scopes excluded, what the
collector and the clients counted, landmarks reached, guard scenarios, and
behavior families (covered, simulated, blind).

Green needs every trace to replay, every landmark to be reached, and every
guard scenario found true and false, or acknowledged in the config as
unfalsifiable with why. A guard never found false that the probe can falsify
is a gap: no test exercises its refusal. The probe samples first (`quint run`
with witnesses); a guard no sample made false is then model-checked (`quint
verify` within `quint.verifySteps`), and only a check that finds no falsifying
state calls it unfalsifiable. A checker that cannot start leaves the guard
undecided, which fails. With `quint.verify` off the config accepts sampling
alone, and the report says so. A blind family's cause is ruled in order: a
test command that names part of the suite, then an action no trace logs, and
only then a genuine gap. A drop in the pinning ratio against the
model's last verdict fails the run.

Each failure names the side that can fix it:

- **replay-side**: the model, the name map, the search bounds, the
  acknowledgements. The kept traces replay again; no test runs.
- **capture-side**: the instrumented sites, the logged arguments, the tests,
  the test command. The traces must be captured again.

A guard that refuses a trace is replay-side only when the model moved since
its last agreeing verdict and the code did not; otherwise it is the code's. A
failing guard is a finding: assume the code is wrong before the model, and
never relax a guard to make a trace pass.

One verdict line per model is appended to `.coherence/conformance/`, a record
store committed with the others. The command exits 1 when any model
disagrees.

## Traps

| Trap | Symptom | What catches it |
|---|---|---|
| Tests started before the URL existed | no trace, no error | the runner spawns the tests; an empty capture fails |
| A build flag, feature or tag that compiles the client in, left out | the client is inert, no trace | put it in the test command; an empty capture fails |
| An argument named unlike its parameter | the check does nothing | `N/M logged args pin a step choice`, and the names that pin nothing |
| A constant identity | every operation lands on one instance | log a real id |
| One scope for several components | traces mix | scopes are required, filtered per model, and exclusions reported |
| A failed test's trace kept | a green run of events that never happened | the collector discards on failed |
| Tests run concurrently in one process | one test's events in another's trace | the hooks name no test while two run side by side; those events count unattributed and fail the capture |
| A guard relaxed to make a trace pass | a real divergence edited away | a failing guard is a finding |
