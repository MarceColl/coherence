# Conformance

Quint models held against the code: quint run through one door, the code's own tests captured under a collector, and every trace replayed through the model with agreement and coverage reported.
model: none — the conformance machinery checks models against code; a model of the checker would be checked by the checker it models

## invariants
- quint runs only through quint.ts: Every quint command Coherence runs is spawned by runQuint, bounded by a timeout that kills its process tree, and read into one outcome where only ok passes.
  protects: quintBin
  chokepoint: runQuint
  because: a quint prop or a replay that spawned quint itself could read a timeout, a missing binary or a model checker that never started as a pass; one door reads every outcome the same way, and a step that did not answer is never ok
  crossing: instrument -> record
  kinds: none
