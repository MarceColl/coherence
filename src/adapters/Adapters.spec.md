# Adapters

The language adapter seam: how to ask a language's server for definitions, references, visibility, a test filter, and a synthetic refutation.

## invariants
- name forms: A spec value reads as a bare symbol, a symbol in its file, or a module path that stays under the project root, and prose never resolves; one function decides the form.
  protects: IDENTIFIER in adapter.ts
  chokepoint: parseName
  over: every value a spec writes under protects, chokepoint, or as a module path
  via: a spec value reads as a bare symbol, a symbol in a file, a module path, or prose
  because: fourteen of the reference's sixteen chokepoint claims had prose where the protected thing belongs and stood green for months; a value that does not read as a symbol or a module must be refused as prose by one function before any instrument is asked, so a claim about nothing cannot pass. Spec text is agent-authored and never trusted about itself, so a path with a parent segment or a leading slash is prose too: the module form accepted "..", and a spec could name a file above the project root for the tool to read
  crossing: project-source -> instrument
  refuted: made parseName read prose as a bare symbol -> "a spec value reads as a bare symbol, a symbol in a file, a module path, or prose" went red in adapter.test.ts; restored, green (2026-09-17)
  kinds: none
- current text before any question: Before any references query, the adapter makes the language server see the current disk text of every document it may have open and of every file the caller names, and waits for the server to acknowledge it.
  over: every document either adapter has open and every file a forget names
  via: the check reads the current disk text after a forget, with the instrument's watcher blind to the file: a loop of edit-then-check yields zero wrong verdicts
  because: tsserver reloads a closed document from disk only when it does not own the text, and a didOpen carrying the text it already loaded leaves it owning that text, so closing the document leaves the edit to a file watcher that is late under load and blind to an excluded file; both reviewers saw the check answer from pre-edit text and a pass recorded with a bypass on disk, the one answer revelation at the edit must never give
  crossing: project-source -> instrument
  refuted: left an open document to the file watcher on forget, as the adapter did before -> "the check reads the current disk text after a forget, with the instrument's watcher blind to the file: a loop of edit-then-check yields zero wrong verdicts" went red in enforcement.test.ts with two of six verdicts answered from pre-edit text; restored, green (2026-09-18)
  kinds: none
- every site is a reference: Every site the language server reports for the protected thing is a reference, an import or re-export specifier included; the adapter reports the syntactic form it read at the site and never exempts one, and the check alone decides what the form means.
  over: every reference site either adapter reports, import and export specifiers included
  via: every site the language server reports is a reference: a bypass beneath a semicolon-less bare import is a bypass, and an import outside the chokepoint is one too
  because: an import of the protected thing outside the chokepoint reaches it and a re-export widens its reach with no call at all, so neither is exempt; the heuristic that told an import from a use called every site beneath a semicolon-less bare import an import, and a real bypass graded clean (decision d-0da89a08 dissolved the exemption rather than patch the parser). Ruling d-7abd1ba8 gives one form one meaning at one location, and the adapter still exempts nothing: it reads the form forward from the top-level statement the site sits in, which is the reading the dissolved heuristic could not make, and hands it to the check
  crossing: instrument -> reading
  refuted: exempted import specifiers from the classification, as the adapter did before -> "every site the language server reports is a reference: a bypass beneath a semicolon-less bare import is a bypass, and an import outside the chokepoint is one too" went red in enforcement.test.ts with the bypass graded pass; restored, green (2026-09-18)
  kinds: none
- test paths: A path is a test when a configured folder is one of its segments or the file is named .test or .spec, or is a Go test file, whose name ends with _test.go.
  over: every configured test folder, every file named .test or .spec, and every Go file whose name ends with _test.go
  via: a path is a test when a configured folder is a segment or the file is named .test or .spec
  because: a test may reference a protected thing to check it and is reported rather than counted as a bypass; the rule is the config's folders plus the file naming both runners use, so a test in an unexpected folder is still a test
  crossing: project-source -> reading
  refuted: made a configured test folder no longer mark a path as a test -> "a path is a test when a configured folder is a segment or the file is named .test or .spec" went red in adapter.test.ts; restored, green (2026-09-17); dropped Go's _test.go from isTestPath -> the same test went red in adapter.test.ts on its _test.go assertion; restored byte for byte, green (2026-10-14)
  kinds: none
- ladder is adapter-defined: The grade ladder is the adapter's to name, rung by rung, each rung a fact the adapter verifies and the name of who enforces it: TypeScript's, Rust's and Go's compilers reach visibility-choked; Python's interpreter reaches closure-choked, a checker the project runs checker-choked, Coherence's own check reference-choked, and a convention alone is enforced by nobody.
  protects: TYPESCRIPT_LADDER
  chokepoint: TypeScriptAdapter
  over: every adapter
  via: the grade ladder's top rung is adapter-defined: TypeScript, Rust and Go enforce visibility, Python does not
  because: visibility-choked means the language itself refuses a reference from outside the module; a language that enforces no visibility cannot earn it, and a ladder with one top for every language would grade a convention as a structural fact; naming the enforcer on every rung is what lets a human read how much the structure is doing and who would stop a bypass
  crossing: instrument -> reading
  refuted: raised the second adapter's top rung to visibility-choked -> the adapter-defined ladder test went red in adapter.test.ts; restored, green (2026-09-17); left whenVacuous unset on the Python ladder -> the same test went red; restored, green (2026-09-17); lowered the Rust ladder's top rung to reference-choked, dropping the compiler's rung -> "the grade ladder's top rung is adapter-defined: TypeScript and Rust enforce visibility, Python does not" went red in adapter.test.ts; restored byte for byte, green (2026-10-13); lowered the Go ladder's top rung to reference-choked, dropping the compiler's rung -> "the grade ladder's top rung is adapter-defined: TypeScript, Rust and Go enforce visibility, Python does not" went red in adapter.test.ts; restored byte for byte, green (2026-10-14)
  kinds: none
- Python rungs verified: A Python chokepoint is graded closure-choked only when the protected thing is a function-local inside the chokepoint's body and no module attribute exposes it, checker-choked only when the name is underscore-prefixed and the project's Pyright configuration makes reportPrivateUsage an error (or an import-linter rule names the protected module), and reference-choked otherwise, with the underscore prefix and the __all__ list reported as evidence.
  protects: PYTHON_LADDER
  chokepoint: PythonAdapter
  over: every rung of the Python ladder and every combination of definition scope, name prefix, __all__ membership, and checker configuration
  via: Python grades: broken with a bypass; reference-choked when clean, with the convention as evidence; closure-choked for a function-local; checker-choked once Pyright's private-usage rule is an error; broken without a chokepoint; not chokeable for prose
  because: each rung names an enforcer, so a rung granted without its fact would credit the interpreter or a checker with a refusal that does not happen; the adapter reads the definition's scope from Pyright's symbols and the checker's rule from the project's own configuration, never from the spec
  crossing: instrument -> reading
  refuted: made the closure rung never verified -> "Python grades: broken with a bypass; reference-choked when clean, with the convention as evidence; closure-choked for a function-local; checker-choked once Pyright's private-usage rule is an error; broken without a chokepoint; not chokeable for prose" went red in python.test.ts; restored, green (2026-09-17)
  kinds: none
- package files are inside the package: A site in one of a protected package's own files is inside the package, and every other site Pyright reports, an import line or an __all__ entry included, is a reference classified by where it sits.
  over: every reference site Pyright reports for a protected module or package
  via: a Python module or package resolves, its members are the references' start, and the package's own files are inside it
  because: a package re-exporting its own members from __init__ is the package reaching itself, so its own files are inside; an importer of a protected name outside the chokepoint reaches the thing and is a bypass, which is what the check exists to reveal
  crossing: instrument -> reading
  refuted: made a package's own files no longer inside the protected package -> "a Python module or package resolves, its members are the references' start, and the package's own files are inside it" went red in python.test.ts; restored, green (2026-09-17)
  kinds: none
- a Rust module's subtree is inside the module: A site in a file a protected or chokepoint Rust module owns is inside the module: `X/mod.rs` owns the files under `X/`, `X.rs` owns those under its sibling `X/`, and a crate root `src/lib.rs` or `src/main.rs` owns those under its `src/`; a file beside the folder, or in a folder that only shares its prefix, is not.
  over: every Rust module file a chokepoint or protected thing names as a module, the files under the folder it owns at any depth, and the files beside that folder
  via: a Rust module's subtree is inside the module: X/mod.rs owns X/, X.rs owns its sibling X/, a crate root owns src/
  because: Rust's privacy is by module tree, and a module's child modules live in the folder its file owns, so a child reaching its parent's item is the module reaching itself, as a Python package's own files are inside the package; read as the one file alone, every child module of a protected Rust module would be a bypass
  crossing: instrument -> reading
  refuted: made withinModule read only a Python package's __init__, so no Rust module owned any folder -> "a Rust module's subtree is inside the module: X/mod.rs owns X/, X.rs owns its sibling X/, a crate root owns src/" went red in enforcement.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-13)
  kinds: none
- Rust rungs verified: A Rust chokepoint is graded visibility-choked only when the protected item's effective visibility, its own narrowed by every module that encloses it up to the crate root, stops short of the crate, with the compiler (rustc) as the enforcer and rust-analyzer's refusal of a path to it from the crate root as the refutation; an item reachable crate-wide (pub(crate), pub, or private at the crate root) is reference-choked with Coherence's check as the enforcer; a site in a #[cfg(test)] or #[test] item is a test reference.
  protects: RUST_LADDER
  chokepoint: RustAdapter
  over: every effective-visibility scope (private, pub(self), pub(super), pub(in …), pub(crate), pub) under private and public module chains, a pub item of a private module, a #[cfg(test)] module in the chokepoint's own file, and a bypass through pub(crate)
  via: Rust grades: visibility-choked short of the crate, reference-choked for pub(crate) and pub, broken with a bypass, a #[cfg(test)] site is a test
  because: rustc refuses a path to an item from outside its visibility scope as hard as tsc refuses a name a module does not export, so the compiler's rung is earned there; but Rust's scope is a module subtree, not a file, so the scope must be read up the module chain: a pub fn of a private module is no more reachable than the module, and reading the item's own pub alone would grade it reference-choked and credit nobody. pub(crate) stays reference-choked: in a single-crate project the compiler's boundary is the whole project and constrains nothing a bypass needs
  crossing: instrument -> reading
  refuted: made visibility() ignore the module chain, so a pub fn of a private module read as reachable outside the crate -> "Rust grades: visibility-choked short of the crate, reference-choked for pub(crate) and pub, broken with a bypass, a #[cfg(test)] site is a test" went red in rust.test.ts; restored byte for byte, green (2026-10-13)
  kinds: none
- rust-analyzer located or a reason: rust-analyzer is found as a binary on the machine, COHERENCE_RUST_ANALYZER first, then rustup's answer from the project root, then the first rust-analyzer on PATH that answers --version, and its absence is a reason naming each place looked, rustup's proxy without the component included, never a crash.
  protects: SERVER_BIN in rust.ts
  chokepoint: src/adapters/rust.ts
  over: COHERENCE_RUST_ANALYZER, rustup which from the project root, and every rust-analyzer on PATH, a rustup proxy without the component among them
  via: rust-analyzer is found, or its absence names each place looked
  because: rust-analyzer is no npm package, so the resolver cannot find it; rustup's proxy at ~/.cargo/bin/rust-analyzer exists without the component and fails only when run, so a file that exists is not a server that starts, and an adopter must be told which of the three places was looked at and how to install it (rustup component add rust-analyzer rust-src) rather than see a run crash. The chokepoint's refutation is the compiler's own refusal of a synthetic import of SERVER_BIN, which its module does not export (ruling rs-e93ecdd6)
  crossing: instrument -> reading
  refuted: made locateRustAnalyzer answer not found before it looked anywhere -> "rust-analyzer is found, or its absence names each place looked" went red in rust.test.ts; restored byte for byte, green (2026-10-13)
  kinds: deploy
  checklist: graceful-drain dismissed: nothing is shut down by locating the binary
  checklist: readiness-evidence declared as rust-analyzer located or a reason
  checklist: declared-target-coverage dismissed: three places are looked in, in order; there is no registry of targets
- Rust waits for quiescence: The Rust adapter asks rust-analyzer nothing indexed (a bare-name resolution, a references query, a refutation's staging) until the server reports itself quiescent, and after every overlay it applies or restores it waits for the server to settle before asking again.
  over: every bare-name resolution, references query and refutation the Rust adapter answers
  via: Rust waits for rust-analyzer's quiescent status before resolution, references and refutation
  because: rust-analyzer loads the Cargo workspace after it has answered initialize, and an answer before that is silently partial: a reference set missing a bypass reads as clean. Its serverStatus notification is the only evidence the load is done, as Pyright's enumeration line is for Python, so every indexed question waits for it, capped so a server that never settles is a reason rather than a hang
  crossing: instrument -> reading
  refuted: bypassed the quiescence barrier before every indexed query -> "Rust waits for rust-analyzer's quiescent status before resolution, references and refutation" went red in rust.test.ts; restored byte for byte, green (2026-10-13)
  kinds: none
- Rust refutation never touches disk: A Rust refutation stages every synthetic site as an unsaved overlay, the synthetic module and an overlay of the crate root declaring it, is either refused by rust-analyzer or seen among the references, and restores every overlay, so the disk and the reference set are as they were.
  over: every refutation the Rust adapter stages, refused and seen
  via: a Rust refutation stages an overlay pair, is seen or refused, and leaves the disk and the reference set unchanged
  because: rust-analyzer does not see an unsaved file that no module declares, so a lone synthetic file would make every refutation vacuous; the pair is the least that makes the server see it, and an overlay left behind would answer every later question from text that is on no disk
  crossing: instrument -> reading
  refuted: left the staged overlays in place after the references query -> "a Rust refutation stages an overlay pair, is seen or refused, and leaves the disk and the reference set unchanged" went red in rust.test.ts; restored byte for byte, green (2026-10-13)
  kinds: none
- Go rungs verified: A Go chokepoint is graded visibility-choked only when the protected item's scope stops short of the module: an unexported name, reachable only in its package, or an exported name under an internal/ folder below the module root, reachable only in the tree under that folder's parent (the last internal deciding), with the compiler (go build) as the enforcer and gopls's refusal of a use from a package outside that scope as the refutation; an exported name importable module-wide (an internal/ at the module root included) is reference-choked with Coherence's check as the enforcer; a site in a _test.go file is a test reference; a method or a field is graded by its name, and its refutation is not run.
  protects: GO_LADDER
  chokepoint: GoAdapter
  over: an unexported function, an exported constant of an internal package below the module root, an exported variable with a bypass from another package, an exported function nothing outside the chokepoint uses, an unexported method, an in-package _test.go and an external _test package
  via: Go grades: visibility-choked for an unexported name and an internal package, reference-choked for an exported name, broken with a bypass, a _test.go site is a test
  because: the Go compiler refuses a use of an unexported name from another package, and the go command an import of an internal package from outside its parent's tree, as hard as tsc refuses a name a module does not export, so the compiler's rung is earned there; but the scope is a package folder or a tree of them, never one file, so a file chokepoint inside the package is still a boundary only Coherence's check enforces, and an internal/ at the module root reaches every package of a single-module project and constrains nothing a bypass needs. gopls reports no reference to an unexported name from another package, only the compiler's refusal, so the refusal is the evidence (ruling rs-e93ecdd6)
  crossing: instrument -> reading
  refuted: made goScopeOf read every name as exported, so an unexported function read as importable everywhere -> "Go grades: visibility-choked for an unexported name and an internal package, reference-choked for an exported name, broken with a bypass, a _test.go site is a test" went red in go.test.ts; restored byte for byte, green (2026-10-14)
  kinds: none
- gopls located or a reason: gopls is found as a binary on the machine, COHERENCE_GOPLS first, then where go install puts it (GOBIN, then each GOPATH's bin), then the first gopls on PATH that answers version, and its absence, or a gopls with no go on PATH to run go list, is a reason naming each place looked, never a crash.
  protects: SERVER_BIN in go.ts
  chokepoint: src/adapters/go.ts
  over: COHERENCE_GOPLS, go env GOBIN and GOPATH, and every gopls on PATH, a broken gopls and a machine with no go among them
  via: gopls is found, or its absence names each place looked
  because: gopls is no npm package, so the resolver cannot find it; go install puts it in GOPATH's bin, which is often not on PATH, and gopls loads packages by running go list, so a gopls found with no go beside it is not a server that works; an adopter must be told which places were looked at and how to install it (go install golang.org/x/tools/gopls@latest) rather than see a run crash. The chokepoint's refutation is the compiler's own refusal of a synthetic import of SERVER_BIN, which its module does not export (ruling rs-e93ecdd6)
  crossing: instrument -> reading
  refuted: made locateGopls answer not found before it looked anywhere -> "gopls is found, or its absence names each place looked" went red in go.test.ts; restored byte for byte, green (2026-10-14)
  kinds: deploy
  checklist: graceful-drain dismissed: nothing is shut down by locating the binary
  checklist: readiness-evidence declared as gopls located or a reason
  checklist: declared-target-coverage dismissed: three places are looked in, in order; there is no registry of targets
- Go waits for quiescence: The Go adapter asks gopls nothing indexed (a bare-name resolution, a references query, a refutation's staging) until gopls has ended its package load and every progress it began, a load that ended in an error being a reason, and after every overlay it applies or restores it waits for the server to settle before asking again.
  over: every bare-name resolution, references query and refutation the Go adapter answers, and a package load that fails
  via: Go waits for gopls's package load before resolution, references and refutation
  because: gopls loads the module's packages after it has answered initialize, and an answer before that is silently partial: a reference set missing a bypass reads as clean. The end of its "Setting up workspace" progress is the only evidence the load is done, and with verboseWorkDoneProgress every diagnosis is a progress too, so a refusal is read only once the diagnosis that publishes it has ended; a load that ended "Error loading packages" answers nothing worth reading, so it is a reason, as is a server that never settles, capped rather than a hang
  crossing: instrument -> reading
  refuted: bypassed the quiescence barrier before every indexed query -> "Go waits for gopls's package load before resolution, references and refutation" went red in go.test.ts; restored byte for byte, green (2026-10-14)
  kinds: none
- Go refutation never touches disk: A Go refutation stages every synthetic site as an unsaved overlay, a refusal as a new file in an existing package outside the item's scope, an outside use as a new file in a new folder and a same-file use as an overlay of the chokepoint's file, is either refused by gopls or seen among the references, and restores every overlay, so the disk and the reference set are as they were.
  over: every refutation the Go adapter stages, refused and seen
  via: a Go refutation stages unsaved files, is seen or refused, and leaves the disk and the reference set unchanged
  because: gopls publishes no diagnostics for a package that exists only in overlays, so a refusal staged in a new folder would never be read and every visibility-choked refutation would be vacuous; an existing package outside the scope is the least that makes gopls diagnose it, a package main first since nothing imports one and no import cycle closes. gopls does report references from a new folder, so an outside use is staged there, and an overlay left behind would answer every later question from text that is on no disk
  crossing: instrument -> reading
  refuted: left the staged overlays in place after the references query -> "a Go refutation stages unsaved files, is seen or refused, and leaves the disk and the reference set unchanged" went red in go.test.ts; restored byte for byte, green (2026-10-14)
  kinds: none
- whole workspace indexed: The Python adapter waits for Pyright's enumeration of the whole workspace before answering, and never narrows the workspace to a component.
  over: every references query and every bare-name resolution the Python adapter answers
  via: Python waits for whole-workspace enumeration before bare-name resolution and references, and finds references outside the component
  because: a Python reference can sit in any project file, so a partial index cannot prove that no bypass exists; both references queries and bare-name resolutions wait for Pyright's source-file enumeration, and Pyright receives the project root as its root and workspace folder, so a component hint orders the text scan without narrowing the workspace
  crossing: instrument -> reading
  refuted: bypassed the enumeration barrier before every indexed query -> "Python waits for whole-workspace enumeration before bare-name resolution and references, and finds references outside the component" went red; restored, green (2026-09-18); narrowed Pyright initialization from the project root to one component -> the same test went red; restored, green (2026-09-18)
  kinds: none
- pytest report mapped by name: The batched totality pass reads pytest's JUnit XML or pytest-json-report's JSON as the one report shape, and writes pytest's name filter as a -k expression joined with or.
  protects: reportFromJunit
  chokepoint: parseReport
  over: every report the configured testJson command writes and every via a Python bullet names
  via: pytest's JUnit report reads as the jest shape, and -k names join with or
  because: pytest ships no jest-shaped reporter but writes JUnit XML itself; a name joined as a regex would be one -k expression pytest cannot parse, so no test would run and every Python totality oracle would fail for the wrong reason
  crossing: instrument -> record
  refuted: joined pytest names as a regex -> "pytest's JUnit report reads as the jest shape, and -k names join with or" went red in python.test.ts; restored, green (2026-09-17)
  kinds: none
- server located or a reason: The language server binary is resolved by the package resolver from the adopter's project first, then from Coherence's own module, then found on PATH, and its absence is a reason naming each place looked, never a crash.
  protects: SERVER_BIN in typescript.ts
  chokepoint: src/adapters/typescript.ts
  over: the adopter's project, Coherence's own module, and every folder on PATH
  via: the language server binary is found (the adapter's precondition)
  because: the language server is an optional dependency; an adopter without it must get a reason naming where the tool looked and how to install it, and a run must record not run rather than crash, since not run is a verdict the status view can show. The chokepoint's refutation is the compiler's own refusal of a synthetic import of SERVER_BIN, which its module does not export (ruling rs-e93ecdd6); the totality oracle was refuted by making locateServer answer before it looked anywhere, which is the absence branch staged inside the function rather than by taking the binary off the machine
  crossing: instrument -> reading
  refuted: made locateServer return undefined before it looked anywhere, so the adapter's precondition found no binary -> the totality oracle went red, then green once restored (2026-09-18); made the TypeScript adapter's locateServer answer not found, with nothing looked, before it asked the resolver -> "the language server binary is found (the adapter's precondition)" went red in enforcement.test.ts and economy.test.ts; restored byte for byte, green (2026-10-08)
  kinds: deploy
  checklist: graceful-drain dismissed: nothing is shut down by locating the binary
  checklist: readiness-evidence declared as server located or a reason
  checklist: declared-target-coverage dismissed: three places are looked in, in order; there is no registry of targets
- packages found by the resolver: Every installed package Coherence starts, drives or detects (both npm language servers, the tsserver, a vitest coverage provider, its own compiler at build) is found by Node's package resolver through installed.ts, never by a path into node_modules built by hand; the hook command install.ts writes is the one exception, being shell the agent host runs before any Node exists. rust-analyzer and gopls are no packages: each is found as a binary on the machine, through installed.ts too.
  over: every non-test TypeScript source under src, and the shapes a hand-built path takes: a join or resolve given node_modules, and a string spelling a path inside it
  via: no source file builds a path into node_modules by hand: every package Coherence starts, drives or detects is found by the resolver
  because: under pnpm Coherence's own dependencies sit beside its package in the store, not inside it, and TypeScript 7 ships no lib/tsserver.js, so <Coherence>/node_modules/typescript/lib/tsserver.js and <root>/node_modules/.bin/... named nothing, initialize failed, and run, the edit-time checks, scaffold control and the Scope map all failed for an adopter on 1.5.2 (df-aa4a8606); the sweep found the same shape in the vitest coverage provider's detection and the build's compiler, so the class is refused over the whole source, not the two adapters. A pnpm project on TypeScript 7 installed from this checkout is the network half (pnpm.e2e.ts, which CI runs where the registry is reachable)
  crossing: project-source -> instrument
  refuted: put a hand-built join(root, "node_modules", ".bin", SERVER_BIN) back in front of the Python adapter's locateServer -> "no source file builds a path into node_modules by hand: every package Coherence starts, drives or detects is found by the resolver" went red in installed.test.ts; restored byte for byte, green (2026-10-08)
  kinds: none
- a pnpm project on TypeScript 7 reads with Coherence's own: Under pnpm, where Coherence's dependencies sit beside its package rather than inside it, and with a project TypeScript of 7 or later, which ships no tsserver, the TypeScript adapter drives Coherence's own tsserver and both language servers resolve from Coherence's own module, the project's TypeScript named as passed over.
  over: a fake pnpm store holding Coherence with typescript 5.9.3, typescript-language-server and pyright beside it, under a project whose typescript 7.0.2 exports no lib/tsserver.js
  via: under pnpm with TypeScript 7, the tsserver and both language servers are Coherence's own, resolved beside its package, and the project's TypeScript is named as passed over
  because: the adopter's run failed at initialize with "Could not find a valid TypeScript installation" while createRequire from Coherence's own module found its typescript 5.9.3 (df-aa4a8606); the project's own resolver cannot reach a tsserver past TypeScript 7's exports, and there is none to reach
  crossing: project-source -> instrument
  refuted: looked for Coherence's dependencies only in the node_modules inside its own package, as the hand-built path did -> "under pnpm with TypeScript 7, the tsserver and both language servers are Coherence's own, resolved beside its package, and the project's TypeScript is named as passed over" went red in installed.test.ts; restored byte for byte, green; took the project's typescript whatever its version and whether or not it held lib/tsserver.js -> the same test went red; restored byte for byte, green (2026-10-08)
  kinds: none
- the project's own install comes first: When the project has its own language server and a TypeScript below 7 holding lib/tsserver.js, those are what the adapters start and drive, and Coherence's own are not looked for; a TypeScript whose tsserver.js is missing is passed over for Coherence's.
  over: a project with its own typescript 5.8.2 and typescript-language-server beside a pnpm store holding Coherence's, before and after its tsserver.js is removed
  via: the project's own tsserver and language server come first when it has them; a TypeScript whose tsserver.js is missing is passed over
  because: a project's checks must read with the compiler the project builds with whenever it has one Coherence can drive; Coherence's own is the fallback, never a preference
  crossing: project-source -> instrument
  refuted: asked Coherence's module before the project's in locateServer -> "the project's own tsserver and language server come first when it has them; a TypeScript whose tsserver.js is missing is passed over" went red in installed.test.ts; restored byte for byte, green (2026-10-08)
  kinds: none
- only the project's files: Only the project's own files are ever evidence: a file is the project's when git tracks it or lists it untracked and not ignored, and it lies inside no nested checkout; one function set decides it (projectFiles, keepProjectFiles, projectSites in project-files.ts), and every walk of the project and every reference an instrument reports passes through it.
  over: every walk of the project (the adapters' source scans, the spec walker, economy and mass, the vocabulary check's corpus, observation's path mapping, the changed-file listings) and every reference site accepted from an instrument (the adapters, the chokepoint check, the edit hook's re-check, the economy closure, the observed and Scope component interfaces)
  via: only the project's own files are ever evidence: a nested checkout and an ignored path are no bypass, no vocabulary, and no mass
  because: agents work in git worktrees under .claude/worktrees, inside the main checkout, and each worktree's copy of a file reads to a language server as more of the project; a reference in an agent's copy of verbs.ts graded attributed writes broken in the main checkout, the edit hook reported the same false bypasses to several agents, and the Structure map shown to reviewers carried the false broken (conjecture c-16d2f394, resolution rs-b4cf50f6). Git's own ignore rules already say what is not the project's, and a folder holding a .git is another checkout even when git cannot follow its gitdir, so both halves are one rule
  crossing: instrument -> reading
  kinds: none
- a folder is left out only by a named rule: Every walk of the project reads the project's files that one rule (exclusionOf in project-files.ts) leaves in, narrowed only by kind, and that rule leaves a folder out only for a reason it names: the config's ignore list, a host's folder, a hidden folder, a dependency install, an interpreter's cache, a virtual environment, Cargo's build folder (a target beside a Cargo.toml), or a folder the go command never builds (a vendor beside a go.mod, a testdata or _-prefixed folder inside a Go module); never for its name alone, and what it leaves out plus what it reads is exactly the project's files.
  over: every walker of the project (the spec walker, the economy's source files, both adapters' file walks, the Scope reading's bounds and entrance detection, the vocabulary check's corpus) over a project holding code in folders named public, dist, build, target, testdata and _build beside a folder of each rule
  via: every walk reads what the one rule leaves in: a folder is left out only by a named rule, never by its name alone
  because: four walkers each kept a list of folder names never read, and the lists drifted; one held public, so an adoption's billing/api/public, five routes and a spec of its own, was read by no walk and nothing said so (df-c35c025e). A file a name list drops is silent: no bypass, no entrance, no mass, no vocabulary, and no reading names the gap. One rule with a reason for each file it leaves out makes the gap a printed line instead of an absence
  crossing: project-source -> reading
  refuted: left out every folder named public by its name alone, in folderReason -> "every walk reads what the one rule leaves in: a folder is left out only by a named rule, never by its name alone" went red in src/adapters/walks.test.ts; restored, green (2026-10-06); made isCargoTarget leave out every folder named target by its name alone -> the same test went red in src/adapters/walks.test.ts with target/plan.py left out; restored byte for byte, green (2026-10-13); made goSkipped leave out every folder named testdata by its name alone -> the same test went red in src/adapters/walks.test.ts with testdata/case.py left out; restored byte for byte, green (2026-10-14)
  kinds: none
- the ignore list names a file by its path: An entry of the config's ignore list that is a file's path from the root leaves that file out of every reader of the list, by the same two rules (underIgnored and exclusionOf in project-files.ts): the walks name it as config ignore, the bounded listing, the code walks, the vocabulary corpus, an edit's reading and lexicon coverage leave it out, and a file elsewhere with the same name is still read; a file is named by its path alone, never by its name anywhere.
  over: a file at the root and a file in a folder named by path, beside a file of the same name in another folder, through underIgnored, walkedProjectFiles, boundedProjectFiles, sourceFiles, collectFiles, corpusFiles and lexiconCoverage
  via: the ignore list names a file by its path: every walk, the vocabulary corpus, an edit's reading and coverage leave it out, and a file elsewhere by the same name is read
  because: the list matched folders only, and accepted any string, so an adopter's "ignore": ["CHANGELOG.md"] was taken and left nothing out: the generated changelog's changeset words topped his lexicon coverage and nothing said the entry did nothing (praetorium.gg). A file named by its bare name anywhere would leave out every package's file of that name in a monorepo, so a file is named by its path, as a folder is by its path
  crossing: project-source -> reading
  refuted: dropped the exact-path match from underIgnored in project-files.ts, so an ignore entry naming a file by its path left it in the bounded listing, the vocabulary corpus and an edit's reading -> "the ignore list names a file by its path: every walk, the vocabulary corpus, an edit's reading and coverage leave it out, and a file elsewhere by the same name is read" went red in src/adapters/ignore-files.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-08)
  kinds: none
- entrance detection follows listed rules: The entrances the reading detects come only from the rules its language lists (CANDIDATE_RULES: for TypeScript, server functions, wrapped exports, server routes, route handlers, request proxies, page routes, server actions, route tables, route methods, package bins, package scripts and top-level scripts; for Python, URL patterns, viewsets, route decorators, management commands, tasks, console scripts and scripts), each carrying its rule and why it matched, never from a test file, a path inside a string, an include(), a TanStack Start file route without server handlers or a script another file imports; a detected entrance records the declared handlers and guards its own statement calls, bound in its file, one level into the file's own helpers.
  over: every rule both languages list over a TypeScript and a Python project holding each shape and each near miss, and a wrapper a file neither imports nor declares
  via: entrance detection
  because: c-3760638e: the coverage of the declared entrances is only as honest as what they are measured against, so detection is a short list of shapes a framework or runner fixes, each explained where it is shown, and precision wins over recall; what the rules cannot see is said beside the counts. A wrapper's namesake counted as a registration would group entrances that are not registered through it. A URL pattern or a registration is read across lines: a per-line scan missed every path( call whose route sat on the next line, and three of billing's routes were declared by hand (df-8f004647)
  crossing: project-source -> reading
  refuted: counted a wrapper call as a registration without checking the file imports or declares it, in throughOf -> the totality oracle went red; restored, green (2026-09-28); matched a URL pattern only when its route sat on the line of path(, as the per-line scan did -> the Python rules test went red; restored, green (2026-10-06)
  kinds: none
- the request proxy is an entrance: The proxy a Next.js proxy.ts exports, or the middleware a middleware.ts exports, at the project root or under src/, is detected as a request proxy, whether declared, named in an export list or re-export, or the file's default export; a helper beside it, a namesake in another folder and a test file are not.
  over: a declared proxy with a helper and a config beside it, a middleware re-exported under an alias, a default-exported middleware, a proxy under lib/ and one in a test file
  via: the request proxy rule detects the proxy a Next.js proxy.ts exports, or the middleware a middleware.ts exports, at the root or under src/: declared, re-exported, or the default export
  because: Next.js 16 renamed middleware to proxy, and the proxy runs before every request it matches, yet a real adoption's detection missed it (df-6cdc0504)
  crossing: project-source -> reading
  refuted: narrowed the request proxy file pattern to proxy.ts alone, so middleware.ts was no proxy -> "the request proxy rule detects the proxy a Next.js proxy.ts exports, or the middleware a middleware.ts exports, at the root or under src/: declared, re-exported, or the default export" went red in src/adapters/entrance-candidates.test.ts; restored, green (2026-10-05)
  kinds: none
- a route file's export list names its methods: Every HTTP method a Next.js app/**/route file exports by name without declaring it is detected as a route handler: re-exported from another module, listed under an alias, or destructured; a non-method in the list and a destructuring in a file that is no route file are not.
  over: a NextAuth route re-exporting GET and POST, a multi-line export list of aliases with a non-method, a one-line destructuring of handlers, and the multi-line destructuring in the module that declares them
  via: a Next.js route file's methods are read from its export lists too: re-exported, listed under an alias, or destructured
  because: a NextAuth route file only re-exports the GET and POST its auth module destructures, so a real adoption detected neither (df-6cdc0504)
  crossing: project-source -> reading
  refuted: read export lists only in proxy files, never in a Next.js route file -> "a Next.js route file's methods are read from its export lists too: re-exported, listed under an alias, or destructured" went red in src/adapters/entrance-candidates.test.ts; restored, green (2026-10-05)
  kinds: none
- a page route is an entrance: The default export of a Next.js app/**/page file is detected as a page route, the file as a whole; a layout, a page under app/routes and a page file with no default export are not.
  over: a page in a (group) folder, a page under a [slug] segment, a layout, a page.tsx under app/routes and a page file exporting only a config
  via: the page route rule detects the default export of a Next.js app/**/page file as the page as a whole, and no layout, app/routes file or page without a default export
  because: a page renders on the server for every visitor and is where a chat app's work enters from the browser, yet page routes were listed as not detected and a real adoption declared its chat page by hand (df-6cdc0504)
  crossing: project-source -> reading
  refuted: never looked for a page file's default export, so no page route was detected -> "the page route rule detects the default export of a Next.js app/**/page file as the page as a whole, and no layout, app/routes file or page without a default export" went red in src/adapters/entrance-candidates.test.ts; restored, green (2026-10-05)
  kinds: none
- a listing answers as git does: keepProjectFiles and projectSites given a listing taken once keep exactly the paths they keep asking git: tracked, untracked and unignored, a tracked file just deleted, and never an ignored, nested, folder or outside path.
  over: tracked, untracked, ignored, deleted, nested, folder, outside and absolute paths in one repository
  via: keepProjectFiles with a listing taken once answers exactly as it does asking git: tracked, untracked, ignored, deleted, nested, folder and outside paths
  because: a git listing per question cost three git processes per declaration a reading asks about, about 85 percent of reading Coherence's own tree (129 s to 11 s once removed, the reading byte for byte the same); the listing is only worth taking if it can never keep a file git would not, or drop one it would
  refuted: made keepProjectFiles keep every candidate when given a listing -> "keepProjectFiles with a listing taken once answers exactly as it does asking git: tracked, untracked, ignored, deleted, nested, folder and outside paths" went red in listing.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-06)
  kinds: none
- the adapter's listing lasts until forget: The TypeScript adapter takes the project's files and git's listing once per forget, so a name resolved in a file and a reference site kept ask no git between forgets, and a file created after the listing is found after the next forget.
  over: a file present at the first question, and a file created after it, before and after a forget
  via: the TypeScript adapter reads the project's files once per forget: a file created after the listing is found only after a forget
  because: the warm instrument answers many questions between edits, and every path that changes the tree (a run, the check at an edit, a live reading's refresh) calls forget first, so a listing kept past a forget would hide a new file from the chokepoint check, and one taken per question costs a git process each time
  refuted: kept the walked file list across a forget -> "the TypeScript adapter reads the project's files once per forget: a file created after the listing is found only after a forget" went red in listing.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-06)
  kinds: none
- the Python adapter's listing lasts until forget: The Python adapter takes the project's files and git's listing once per forget, so a name resolved in a module, a star import scanned, and a reference site kept ask no git between forgets, and a module created after the listing is found after the next forget.
  over: a module present at the first question, and a module created after it, before and after a forget
  via: the Python adapter reads the project's files once per forget: a module created after the listing is found only after a forget
  because: the same per-question git cost the TypeScript adapter carried (d-55040f81) sat in the Python adapter's resolve and reference filter, which is what reads a Python adopter such as PostHog; a listing kept past a forget would hide a new module from the chokepoint check
  refuted: kept the Python adapter's walked file list across a forget -> "the Python adapter reads the project's files once per forget: a module created after the listing is found only after a forget" went red in listing.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-06)
  kinds: none
- a cold server resolves what the project declares: The TypeScript adapter loads the project through a source file inside a component folder, and a name the server does not know yet is looked for in the files whose text spells it and confirmed by their document symbols, so a fresh server never answers no symbol for a name the project declares.
  over: a project whose first source file lies outside the tsconfig, on a fresh server, at the first question
  via: a cold server resolves a name the project declares even when the first source file of the walk lies outside the TypeScript project
  because: a bench script outside the tsconfig became the first source file the walk met, so a fresh server loaded only an inferred project around it and answered no symbol for every bare name; the check at an edit then recorded not run and printed nothing, which let a bypass of run appended never rewritten reach main unseen
  refuted: chose the first source file of the walk as the seed again, inside a component or not -> "a cold server resolves a name the project declares even when the first source file of the walk lies outside the TypeScript project" went red in listing.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-06)
  kinds: none
- the adapter's git spawns do not grow with the names asked: Between forgets, the TypeScript adapter spawns git a fixed number of times however many names are resolved and asked for their references.
  over: a project of two declarations and one of eight, every name resolved and asked for its references after one forget
  via: the TypeScript adapter spawns git a fixed number of times between forgets, whatever the number of names asked
  because: one git listing per references question made the Structure reading and npm test about five times slower for two weeks (d-55040f81) before anyone looked; a count of spawns is the same under any load, so the shape that cost the time alarms the day it returns, where a timing would flake
  refuted: took git's listing afresh at every references question instead of once per forget -> "the TypeScript adapter spawns git a fixed number of times between forgets, whatever the number of names asked" went red in listing.test.ts on its own assertion (4 spawns against 10); restored byte for byte, green batched and alone (2026-10-07)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is a count of child processes per forget
  checklist: execution-budget declared as the adapter's git spawns do not grow with the names asked
  checklist: memory-budget dismissed: the bound is on spawned processes, not on allocation
  checklist: circuit-breaker-policy dismissed: no dependency failures are observed
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
- a nested Python project resolves imports from the repository top: The Python adapter for a project nested below its repository's top adds the top to Pyright's import search, never to its workspace, so a reference in the project written through an import from the top resolves and is classified like any other.
  over: a bypass in a nested Python project reached through an import written from the repository top
  via: a nested Python project's imports written from the repository top resolve, so a bypass inside the project through one is found
  because: PostHog's code imports its own modules from the repository top (products.notebooks.backend.query_validation); Pyright started on the nested folder could not resolve them, so a bypass inside the project went unreported and the chokepoint graded reference-choked (df-0d235229)
  refuted: the Python adapter left the repository top out of Pyright's import search -> "a nested Python project's imports written from the repository top resolve, so a bypass inside the project through one is found" went red in monorepo.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a registry leaf inherits key by key: A project a repository's registry lists reads the registry's config keys under its own: its own file overrides a key at a time, ignore and wellKnown concatenate, the test keys are inherited or replaced as one group, name, entryDir, lexicon and projects are never inherited, and a relative path an inherited key holds resolves against the file that declared it, so a registry test setup's cwd "." is the repository top and a registry ignore path inside the leaf is rebased to it.
  over: a leaf with its own config overriding latencyBudget, wellKnown and the test group, and a leaf with none, under a registry declaring language, ignore names and paths, wellKnown, latencyBudget, references and a test setup with a cwd
  via: a registry leaf inherits the registry's keys, its own config overriding key by key, and inherited paths resolve against the file that declared them
  because: a monorepo opting in many leaves states its test runner, ignore list and budgets once; a leaf that read only its own file would run its tests from the wrong folder or not at all, and an inherited relative path read against the leaf would name a folder that does not exist
  refuted: effectiveConfig inherited the registry's test setups without rebasing their cwd to the leaf -> "a registry leaf inherits the registry's keys, its own config overriding key by key, and inherited paths resolve against the file that declared them" went red in registry.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- Python stages a use from outside an exempted folder: Under a from: line that exempts a folder, the Python adapter's refutation stages an unsaved use of the protected thing from outside that folder, and the check classes the package's own references exempt and another package's a bypass.
  over: a Python package whose own module references its protected internal, a facade module chokepoint, and a reference from a sibling package, under from anywhere and outside the component
  via: Python: a chokepoint from outside the component exempts its own references and still catches a bypass from another component; from anywhere calls both bypasses
  because: the exemption is classified in the check, but what the refutation can stage is the adapter's: a use beside the protected thing lies inside the exempted folder, so without a document outside it the refutation would prove only that a re-export is caught, never that the exemption stops at the folder
  crossing: instrument -> reading
  refuted: stopped the Python adapter expecting its staged use from outside the exempted folder -> "Python: a chokepoint from outside the component exempts its own references and still catches a bypass from another component; from anywhere calls both bypasses" went red in python-from.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- tach configuration read as tach reads it: The nearest tach.toml at or above the project root governs a Python chokepoint only when one tach module holds both the protected thing and the chokepoint, and an interface from that module without a visibility list exposes the chokepoint while no interface exposes the protected thing or a package above it; from and expose match as whole regular expressions, and a module carrying the deprecated strict alone is not governed.
  over: every tach.toml at or above the root and every combination of from pattern, expose pattern, interface visibility, strict, nested modules and the module's own path
  via: tach reads tach.toml as tach 0.34 does: the nearest file at or above the root, regex from and expose matched whole, a visibility list constraining only its modules, an exposed package above the internal
  because: the rung credits tach with a refusal, so it must stand exactly where tach refuses; read from tach 0.35 itself, "store" in expose covers an import of the module store but not of a name in it, an interface with a visibility list leaves every unlisted module free, and an exposed package above the internal lets any module reach the internal as an attribute
  crossing: project-source -> reading
  refuted: matched tach patterns as prefixes instead of whole, in fullMatch -> "tach reads tach.toml as tach 0.34 does: the nearest file at or above the root, regex from and expose matched whole, a visibility list constraining only its modules, an exposed package above the internal" went red in src/adapters/tach.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- tach draws the module boundary: Where tach governs, the chokepoint grades checker-choked with tach (tach.toml) as the enforcer and the interface as the fact, a reference in the module's own code is inside, and every import tach refused that reaches the protected thing is a bypass carrying tach's error; without a tach.toml the grading is Coherence's own.
  over: every Python chokepoint whose protected thing lies in a module a tach.toml declares, a clean tree, a tree with an outside import planted, and the same tree without tach.toml
  via: a chokepoint tach governs grades checker-choked by tach with the interface as the fact, the module's own use inside; a planted outside import grades broken with tach's interface error as the bypass; without tach.toml the grading is Coherence's own
  because: PostHog declares 101 tach modules and 42 interfaces and runs tach check --dependencies --interfaces in CI, so tach, not Coherence's reading of Pyright's references, is what refuses an import of a product's internals; tach lets a module use its own internals, and re-deriving the boundary from references called every such use a bypass of the facade
  crossing: instrument -> reading
  refuted: classified a reference in the tach module's own code by Coherence's rule alone, ignoring the boundary, in checkChokepoint -> "a chokepoint tach governs grades checker-choked by tach with the interface as the fact, the module's own use inside; a planted outside import grades broken with tach's interface error as the bypass; without tach.toml the grading is Coherence's own" went red in src/adapters/tach.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- tach's refusal is the refutation: The refutation of a chokepoint tach governs stages an import of the protected thing in another tach module of a throwaway copy of the tree, runs tach over it, and records refused by the checker only when tach refuses that import; the copy is removed and nothing is written into the project.
  over: every chokepoint tach governs, its staged outside import, and the project tree and temporary folder after the refutation
  via: tach's refusal of an outside import staged in a throwaway copy is the refutation, and the copy is gone with nothing written into the project
  because: a module's own code is free to use its internals, so a synthetic site staged beside the protected thing proves nothing where tach governs; only tach refusing an outside import shows the rung's enforcer would fire, and tach reads files from disk, so the import is staged in a copy whose other entries link to the project's, which tach does not walk
  crossing: instrument -> record
  refuted: read tach's refusal back from the line after the staged import, in witnessTach -> "tach's refusal of an outside import staged in a throwaway copy is the refutation, and the copy is gone with nothing written into the project" went red in src/adapters/tach.test.ts with the refutation missing; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- tach absent is a reason: A tach.toml that would govern a chokepoint with no tach installed, or with a tach that does not answer, earns no tach rung, and the grade's reason says where tach was looked for.
  over: a governed chokepoint with tach missing, with COHERENCE_TACH naming a binary that does not exist
  via: without tach installed the tach rung is not available and the grade says why
  because: tach is the adopter's dependency, not Coherence's; a rung granted without the checker on the machine would credit a refusal nobody can make, and a silent fallback would hide why the grade dropped
  crossing: instrument -> reading
  refuted: fell back silently when tach is not installed, dropping the note, in tachVerdict -> "without tach installed the tach rung is not available and the grade says why" went red in src/adapters/tach.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- tach at an edit spawns only for a tach module's file: At an edit, tach runs only over the Python files the edit wrote that lie in a tach module, in a throwaway copy, and an edit that wrote none spawns no tach.
  over: an edit to a file in no tach module, an edit to a file inside one, a clean and a leaking edit, and a repeat edit outside after the refusal was witnessed
  via: an edit spawns tach only when a file it wrote is a Python file inside a tach module, and checks only those files
  because: the tool hooks hold a 3 s latency budget, and tach over the whole of PostHog takes about two seconds where over one edited file in a throwaway copy it takes about 190 ms; a count of spawns is the same under any load, so a hook that starts running tach for a file tach cannot judge alarms the day it does
  crossing: instrument -> reading
  refuted: ran tach over the whole tree at an edit too, in tachRun -> "an edit spawns tach only when a file it wrote is a Python file inside a tach module, and checks only those files" went red in src/adapters/tach.test.ts on its own assertion (tach spawned for an edit outside every tach module); restored byte for byte, green batched and alone (2026-10-07)
  kinds: budget
  checklist: bounded-admission dismissed: nothing is admitted; the bound is a count of child processes per edit
  checklist: execution-budget declared as tach at an edit spawns only for a tach module's file
  checklist: memory-budget dismissed: the bound is on spawned processes, not on allocation
  checklist: circuit-breaker-policy dismissed: no dependency failures are observed
  checklist: fair-admission dismissed: there are no contenders for the budget
  checklist: rate-budget dismissed: nothing is counted against a time window
- a config key group is declared once: The keys one test setup reads, the keys a leaf never inherits, the keys it combines, the agent hosts' folders the walk leaves out, and the route exports entrance detection reads are each declared once; the registry merge groups the test keys from the setup keys, a test setup is read through those keys alone, the walk's host folders come from the hosts' declaration, the scaffold names a route entrance by the exports detection reads, and docs/config.md's inheritance and tests tables are held equal to the groups.
  over: docs/config.md's inheritance rules and tests table against OWN_KEYS, CONCATENATED, TEST_KEYS and SETUP_KEYS, the keys testSetupOf reads, a file in each host's folder, a scaffolded entrance for every route method and loader export; and every source module, scanned for the route methods or a host folder named by hand
  via: the config's key groups, the hosts' folders and the route exports are each declared once, and docs/config.md's tables name exactly the keys the code reads
  because: TEST_KEYS listed the test keys apart from the setup reader that reads them, and docs/config.md's tests table listed latencyBudget, which is no test key, so a key added to the reader and not the group would be inherited past a leaf's own tests; the walk named the hosts' folders apart from the hosts, and the scaffold kept its own copy of the methods detection reads (df-473bfbb3)
  refuted: wrote TEST_KEYS out by hand again apart from SETUP_KEYS, leaving testDirs out of the group a leaf replaces -> "the config's key groups, the hosts' folders and the route exports are each declared once, and docs/config.md's tables name exactly the keys the code reads" went red in declared-once.test.ts on its own assertion; restored (cmp), green batched and alone (2026-10-12)
  kinds: none
