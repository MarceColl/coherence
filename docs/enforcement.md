# Enforcement

Enforcement turns a requirement into an invariant by detection. A bullet
carries it as a chokepoint (`protects:` and `chokepoint:`) or a
totality oracle (`over:` and `via:`).

```sh
node src/cli.ts run [--session <id> --agent <name>]   # both passes, one run appended
node src/cli.ts run --status                           # the latest verdict per enforcement
node src/cli.ts refute <component>/<name> --broke "…"  # the totality oracle with the break staged; it must fail
node src/cli.ts serve                                  # the warm language server, foreground
```

## The seam

The language adapter answers exactly the questions enforcement asks:
resolve a spec name to a definition; list every reference to it; say
whether the language enforces visibility and whether the thing is visible
outside its module; turn a `via` value into a test filter; and refute by
opening a synthetic reference.

A name resolves as a bare symbol (`writeClass`), a symbol in its file
(`KERNEL_WRITE_POLICY in policy.ts`), or a module path. Prose does not
resolve, and the check says so.

The first adapter drives `typescript-language-server` over the language
server protocol on stdio. Exportedness is not in the protocol, so the
adapter reads the declaration text. The second drives `pyright-langserver`
the same way; a package folder (`posthog/query_cache/`) resolves as a
module through its `__init__.py`.

## The ladder

Every reference to the protected thing is classified: inside the chokepoint
(the chokepoint symbol's range, or its module when the chokepoint is a
module), a test reference (reported, never a bypass), or a bypass. There is
no fourth class: every site the language server reports is a reference, an
import or re-export specifier included.

Two of those sites the language gives a form, and the form decides before
the range does (ruling `d-7abd1ba8`):

- A **plain import specifier** — type-only and namespace imports included —
  is **inside** when it sits in the chokepoint's own module. That one
  location is how the chokepoint reaches the thing, not a place the thing is
  used. The same import in any other module is a bypass.
- An **export-from specifier** or a **wildcard re-export** is a **bypass**
  wherever it stands, the chokepoint's own module included: it widens the
  thing's reach with no call at all.

Python's equivalents: `from x import y` or `import x` at the top of the
chokepoint's module is inside; the same import elsewhere is a bypass; an
import whose name the module's `__all__` lists is a re-export, and so is a
bare `from x import *`.

The adapter reads the form forward from the top-level statement the site
sits in, never backward for a terminator — the reading the dissolved import
heuristic could not make, which is why a bypass beneath a semicolon-less
bare import still grades broken. Neither language server reports a site for
a wildcard re-export (`export * from`, `from x import *`), so each adapter
scans its own source files for one, once per forget.

- **visibility-choked**: not visible outside its module, no bypass.
- **reference-choked**: visible, but every reference is inside the chokepoint.
- **broken**: a bypass exists, or the chokepoint cannot be resolved. A
  structural defect; each bypass names file, line, and referencing symbol.
- **not chokeable**: the protected thing is not a symbol or a module; the
  totality oracle form is the compromise.

The rungs are adapter-defined, each a fact the adapter verifies, and the
grade names who enforces it. TypeScript enforces visibility, so its top is
visibility-choked (the compiler). Python's ladder is in its own section
below.

## Refutation

Refutation is required **per enforcement**: a bullet carrying both forms
needs both.

A chokepoint refutes itself, and how it does depends on who enforces the
rung it earned.

**Coherence's own check is the enforcer.** The adapter stages the two
synthetic sites the import ruling could otherwise swallow, in one unsaved
pass: a use of the protected thing in the chokepoint's own module past the
chokepoint's range, and a re-export of it from a document beside it.
Nothing touches disk. The check then classifies each staged site with the
same function every other site goes through, and the refutation fires only
when it calls **every one** a bypass. A site the instrument could not see,
or one the check would call `inside` (the chokepoint covers everywhere the
language lets the thing be named) or `test` (the protected thing lives under
a test folder, so nothing can ever be a bypass), makes the check vacuous:
the run says which site and why, records not run, and the bullet stays a
requirement. A chokepoint named as a module has no inside that lies outside
its own range, so only the re-export is staged there, and the account says
so.

**The language is the enforcer** (`visibility-choked` in TypeScript,
`closure-choked` in Python). Coherence's check can never be made to fire
there: the compiler refuses every import of a thing the module does not
export, and the interpreter refuses every import of a name that is not a
module attribute. So the adapter stages the synthetic outside reference and
asks the language server for the diagnostic on it. A diagnostic that says
the name is not exported or not accessible **is** the refutation, recorded
as `refused by the language` with the diagnostic's own text (ruling
`rs-e93ecdd6`). Demanding Coherence's own firing there would leave the
strongest rungs weaker than the one below them.

A totality oracle is refuted by hand, and the refutation is a recorded
event, never a sentence. While the break is staged:

```sh
node src/cli.ts refute src/enforcement/"run appended never rewritten" \
  --broke "replaced the append in appendRun with a whole-file write" \
  [--session <id> --agent <name>]
```

It runs that bullet's totality oracle, **requires it to fail**, and appends a
refutation record beside the runs (kind `refutation`: the bullet, what was
broken, the failing verdict and its reason, at, session, commit, dirty). A
passing totality oracle appends nothing and exits non-zero. Then restore the
code and run `run`: the refutation counts as witnessed only once a run at or
after the record finds the same totality oracle passing again — red with the break, green
without it. The bullet's `refuted:` line stays as the human account and may
name the record; the account alone never satisfies the requirement.

## Python

Python enforces no visibility, so its ladder has four rungs, each a fact
the adapter verifies, and the grade names the enforcer:

- **closure-choked** (the interpreter): the protected thing is a
  function-local inside the chokepoint's body, never a module attribute,
  so nothing outside can import or name it.
- **checker-choked** (a checker the project runs): the name is
  underscore-prefixed and `pyrightconfig.json` or pyproject
  `[tool.pyright]` makes `reportPrivateUsage` an error; or, for a
  protected module, an import-linter rule in `.importlinter` or
  `[tool.importlinter]` names it. A project on mypy has no such rule, and
  the evidence says so.
- **reference-choked** (Coherence's check at the edit and in CI): the top
  rung when neither holds.
- **convention** (nobody): the underscore prefix or `__all__` exclusion
  alone; evidence, and the rung a vacuous refutation drops to.

Pyright indexes the whole workspace and the adapter never narrows it: a
Python reference can sit in any file, so a narrower root or include list
only proves the absence of a bypass inside what it sees, and Pyright
ignores a settings-level include under a project config anyway. On
PostHog (19,693 files) enumeration takes 2 s and 350 MB, the first
references query 3 s, later ones 0.5 s. `workspace/symbol` is never used
(30 s, 3.5 GB there); a bare name resolves by a text scan, then
`documentSymbol`.

The totality oracle pass runs pytest with `--junitxml={out}` and
`testFilterForm: "pytest"`: names go to `-k` joined with `or`, and the
JUnit report (or pytest-json-report's JSON) maps back by test name.

## Rust

`"language": "rust"` grades through rust-analyzer. It is no npm package, so
it is found on the machine: `COHERENCE_RUST_ANALYZER` first, then `rustup
which rust-analyzer` from the project root (a `rust-toolchain.toml` is
honoured), then the first `rust-analyzer` on PATH that answers `--version`.
rustup's proxy at `~/.cargo/bin` exists without the component and fails only
when run; a missing server is a reason naming each place looked. Install it
with `rustup component add rust-analyzer rust-src` (`rust-src` lets it index
`std`).

Rust's ladder has two rungs:

- **visibility-choked** (the compiler, rustc): the protected item's
  effective visibility stops short of the crate root. That is its own
  visibility (private, `pub(self)`, `pub(super)`, `pub(in …)`) narrowed by
  every module that encloses it, read up the module chain through
  rust-analyzer's `experimental/parentModule`, so a `pub fn` of a private
  module is no more reachable than the module. rustc refuses a path to it
  from outside that scope; inside it, every reference is classified as
  usual.
- **reference-choked** (Coherence's check at the edit and in CI): the item
  is reachable crate-wide (`pub(crate)`, `pub`, or private at the crate
  root). In a single-crate project the compiler's boundary is the whole
  project, so it is not credited.

The adapter asks nothing indexed until rust-analyzer reports itself
quiescent (`experimental/serverStatus`): about 5 s on a small crate, 6 to
14 s on a 14k-line one. Build scripts and proc macros are on, for
references inside expanded code; `COHERENCE_RUST_LEAN=1` turns both off for
a faster start. `checkOnSave` is off, so no check runs cargo.

A site inside a `#[cfg(test)]` or `#[test]` item, or in a file whose module
is declared under `#[cfg(test)]`, is a test reference, so a unit test module
beside the chokepoint is not a bypass. A `use` site is an import; a `pub
use` (or `pub(…) use`) is a re-export, a bypass wherever it stands. A
module is its file: `src/kernel/mod.rs`, `src/kernel.rs`, or a folder
(`src/kernel/`, which is its `mod.rs` or sibling `.rs`; a crate folder, which
is its `src/lib.rs` or `src/main.rs`). A site in a file the module's subtree
owns is inside the module.

The refutation never touches disk. rust-analyzer does not see an unsaved
file no module declares, so each synthetic module is staged as a pair: the
file, and an unsaved overlay of the crate root that declares it. For a
visibility-choked item the synthetic module `use`s it, and rust-analyzer's
refusal (E0432 "unresolved import"; rustc says E0603 "is private") is the
refutation, with a control `use` inside the item's own module that must not
be refused. Otherwise the synthetic module re-exports it and the
chokepoint's file gains a use past its range, and both must come back as
bypasses.

Named limits. rust-analyzer is not rustc: code behind a `cfg` it has not
enabled, and references inside unexpanded macro input, are unseen, and its
refusal is E0432 on a `use` only. An item of an `impl` or a trait has no
`use` path, so its refutation is not run. References from crates outside
the workspace are unseen. Totality oracles run through `cargo test` one at a
time (`"test": "cargo test -q -- --exact {filter}"`, `"testMatch": "test
result: ok\\. [1-9]"`); doctests are not run as `via`s.

## The run and its view

A run appends one line to `.coherence/runs/<session>.jsonl`: time, session,
agent, commit, and one entry per enforcement: form, verdict, grade,
refutation, bypasses, test references, files, latency, reason. The
refutation field takes one of four values: `automatic` (the check called
every staged synthetic site a bypass), `refused by the language` (the
compiler or the interpreter refused the synthetic outside reference),
`witnessed` (a refutation record for a totality oracle, with a later passing
run), and `missing`. A run with no `--invariant` and no `--form` filter
also carries `full: true`. Orient's note on the invariant floor counts only
those, and none dated after now. Nothing is
rewritten. `refute` appends its refutation records to the same files, marked
with `kind: "refutation"`.

A chokepoint entry also carries its reference `sites`, which are most of a
run's bytes and rarely change. Each run file writes an enforcement's sites
in full at its first entry for that enforcement, and again whenever they
change. A later entry whose sites are the same as that enforcement's last
entry in the same file carries `sitesRef` instead: the hash of their
content, and the time of the run in that file that holds them in full.

A reference never points outside its own file, so any one run file
resolves on its own, whether or not other sessions' files were committed.
Every reader goes through `loadRuns`, which turns each reference back into
the `sites` it names, in the same key position a full write uses. A
reference its file cannot resolve is marked on the entry as
`sitesUnresolved`, listed among the damaged lines, and shown as unknown
wherever sites are read: Scope's reliance, enforcement card and flow map,
and `query`. It is never read as an empty list.

Writing a run never reads its session's run file to find what it last
wrote in full. The run index keeps one small sites shard per run file, under
`.coherence/cache/run-sites/`, with each enforcement's last full sites hash
and the file's identity and size when the shard was written. An append asks
the shard. When the shard is missing, or was kept for the file as it no
longer is, the append writes its sites in full, which costs one larger line
and never a reference that does not resolve, and the shard starts again from
that line.

A reader older than this release knows no references. It sees no `sites`
on those later entries and reports their sites as unavailable, which is the
rule for an entry without sites. It still sees every file's first entry in
full.

A run exits non-zero when an enforcement failed and also when the instrument
was needed and could not answer: the totality pass runs the whole suite
before the first question, so the run holds the warm server's idle timer open
with a heartbeat and asks the instrument again afterwards. A run that proved
nothing must never read like a clean one.

`run --status` is a view: the latest entry per enforcement across every run;
one the latest run skipped keeps its prior dated verdict, and the line says
so. `spec --check` reads the same view: an automatic refutation or one
refused by the language satisfies a
chokepoint enforcement's refutation requirement, a refutation record with a
later passing run satisfies a totality oracle's, a passing verdict shows as
verified, and a failing one on a bullet that was otherwise complete makes it
a structural defect — an invariant whose satisfaction has been removed. A
requirement whose check is failing stays a requirement, reported with its
failing check. With no run, every enforcement is declared, unverified.

The totality oracle pass runs every test the bullets name in one invocation of the
config's `testJson` command (a combined name pattern, a per-test JSON
report) and maps results back by name; the record says so. One test per
invocation of `test` is the fallback when a runner cannot report per test.
Not configured is reported, never assumed passing. node:test ships no JSON
reporter, so `src/enforcement/node-test-reporter.ts` writes the jest-shaped
report from its events; Coherence's own config names it.

## Revelation at the edit

The warm server holds the language server open across hook invocations:
`serve` runs it in the foreground; a client connects over a unix socket
under `.coherence/run/` and spawns it detached when none listens; it shuts
down after a few idle minutes.

On PostToolUse for a file-writing tool, the hook re-checks only the
chokepoint invariants the file may involve (a prior run touched the file, or
a protected or chokepoint name appears in it) and appends the pass as a run. A bypass is printed as additionalContext in the same turn: the
invariant, the bypass site, and the two honest options, route the reference
through the chokepoint or escalate a retirement for a human. At Stop the
regulation message carries the structural defects the latest run left; at
SubagentStop one refuses the stop.
