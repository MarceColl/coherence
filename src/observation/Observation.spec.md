# Observation

Runtime behavior recorded as a separate, labeled layer of evidence: per-test coverage captured from the batched totality pass's one runner invocation, mapped to components and component interfaces, appended as observations bound to commit, session, and source, and read back fresh or stale.
model: none — a capture of what code a test ran, with no rules of its own for how a state changes

## invariants
- stale never current: An observation whose commit is not the head, or whose tree was dirty when it was captured, is read as stale by every reader, and never as current.
  over: every observation record and every reader of one: query observed, query observed --failures, and the observed evidence the Structure overlay draws from
  via: an observation from another commit, or from a dirty tree, is stale in every reader
  refuted: made freshness ignore a commit that is not the head and a dirty tree -> "an observation from another commit, or from a dirty tree, is stale in every reader" went red in observation.test.ts through refute, after an earlier vacuous refutation that day (d-c4be0b1a); restored, green (2026-09-22)
  because: coverage describes the code that ran, and once the head moves that code may no longer exist; a stale observation read as current would tell a human a path is tested when the tested path is gone, which is worse than saying nothing. The rule has one home, freshness, and every reader labels what it prints with it
  crossing: record -> reading
  kinds: none
- one runner invocation: An observed pass is the batched totality pass's one runner invocation with coverage added to it; observation never invokes the runner a second time.
  over: every observed run and every runner observation knows: node:test, vitest, and pytest
  via: an observed pass spawns the runner once
  refuted: made an observed run invoke the runner once unobserved and again observed -> "an observed pass spawns the runner once" went red in observation.test.ts through refute; restored, green (2026-09-22)
  because: the batched pass exists because a runner's setup is costly; an observation that reran the suite would double that cost and could observe a different pass than the one whose verdicts the run records. The observer may add flags and environment to the one command, and it is handed the report the command wrote; the coverage export afterwards reads files and runs no test
  crossing: instrument -> record
  kinds: none
- co-executed never called: A component interface is recorded as crossed in a test only when a reference site of it in the using component and the referenced symbol's body in the other both executed in that test; the record and every reading say co-executed, never called.
  over: every component interface in an observation, every reference site, and every reading that prints one
  via: a component interface is crossed when both ends co-executed in one test, and the record says co-executed
  refuted: made symbolCrossed count a crossing when the symbol's body ran whether or not a using site ran -> "a component interface is crossed when both ends co-executed in one test, and the record says co-executed" went red in observation.test.ts through refute; restored, green (2026-09-22)
  because: coverage records what executed, not who called whom; two functions that both ran in one test need not have met. Saying called would claim a fact the instrument never observed. An import specifier is how a module reaches a symbol and a module's top level runs at load, which no test owns, so neither is evidence
  crossing: instrument -> reading
  kinds: none
- breakage kept apart: A failing test's observation records what broke (the invariant whose totality oracle it is), the likely site (the first stack frame outside test files, labeled likely), and the region it touched as three separate facts.
  over: every failing test in an observed pass and every reading of one
  via: a failure records what broke, the likely site, and the region apart
  refuted: made a failing test's what-broke the likely site's component instead of its invariant -> "a failure records what broke, the likely site, and the region apart" went red in observation.test.ts through refute; restored, green (2026-09-22)
  because: where a test failed is evidence about where the code broke, not proof; blending the frame into the verdict, or the region into the site, would present a guess as a finding. Kept apart, a human can weigh each, and a change set can narrow the region to suspects without renaming a suspect a cause
  crossing: record -> reading
  kinds: none
- attribution never fabricated: Coverage a runner attributes only to the whole run is recorded per run, said so, and never divided among tests.
  over: every runner observation knows and every capture it returns
  via: a runner that attributes coverage only per run is recorded per run, never per test
  refuted: gave every test the whole run's region when coverage was per run -> "a runner that attributes coverage only per run is recorded per run, never per test" went red in observation.test.ts through refute; restored, green (2026-09-22)
  because: vitest's coverage covers the run, not a test; a per-test region derived from it would be invented, and a reader would trust it as observed. A runner that gives nothing is recorded as nothing, with the reason
  crossing: instrument -> record
  kinds: none
- observation names the languages it did not read: An observation of a multi-language project, which maps the pass through the primary language's instrument alone, names every other language as not read, with why, on its record and in the line the run prints.
  over: an observation built for the two-language fixture's config
  via: an observation of a multi-language project names the languages it did not read
  because: observation rides the first test setup's one invocation through one instrument; a record silent about the other language would read as every interface observed (df-f47a5c05)
  crossing: instrument -> record
  refuted: made buildObservation state the primary language alone as declared, so the record named no language not read -> "an observation of a multi-language project names the languages it did not read" went red in multi-language.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
