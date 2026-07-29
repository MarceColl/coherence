# In-Repository Plugin Architecture RFC

**Date:** 2026-07-28  
**Slug:** `in-repository-plugin-architecture`  
**Status:** Ready for fresh-session execution  
**Owners:** Human + Agent

---

## Handoff Summary

Make the original, top-level Coherence system extensible through explicitly configured, repository-local plugins. Do not change or depend on `core/`; it is a separate experiment.

The plugin API must make the dbt work in [PR #8](https://github.com/daniloc/coherence/pull/8) possible without adding any dbt-specific code to Coherence core. PR #8 is the behavioral acceptance catalogue, not the architecture to merge unchanged.

The key distinction is:

- Adapters interpret a primary source language or platform.
- Graph contributors add nodes, edges, metadata, and structural facts.
- Claim forms parse and evaluate repository-authored claims such as `via dbt schema` and `via shadow`.
- Project checks report whole-graph violations even when no claim names them.
- Commands perform explicit maintenance operations such as rebuilding a snapshot.

Current working-copy warning:

- At the time this RFC was written, `@` was `codex/core-compiler-01-manual-testbed` and contained unrelated `core/` and `ikkan/` changes.
- Preserve those changes. Do not include, rewrite, rebase, or clean them as part of this work.
- Start implementation in a separate clean `jj` workspace/change rooted at `main`, after reading this RFC.

Theory-of-record note:

- Tashikame/Genchi was not connected while this RFC was created.
- Assumptions and proof obligations are therefore recorded directly in this document.

---

## 1) Decision Intake (Top-Level First)

The current conversation established the following as the working decisions. Reopen any decision by adding an `[H]:` comment in section 4 before implementing the affected slice.

### D1) Scope the work to original Coherence

Status: `accepted`

Question:

- Should the plugin architecture modify the original top-level system or the separate `core/` experiment?

Why this matters now:

- Mixing the two systems would obscure the real extension boundaries and risk coupling an experiment into the production architecture.

Options:

1. Change only the original top-level system

- Pros: Directly addresses the hard-coded adapters and PR #8; bounded blast radius.
- Cons: Does not reuse any experimental `core/` machinery.

2. Unify the original system and `core/` first

- Pros: Could theoretically share concepts.
- Cons: Multiplies scope and makes the plugin work depend on an unrelated experiment.

Recommendation:

- Choose: Option 1.
- Reasoning: The user explicitly said to ignore `core/`.

Human response:

- [x] Accept recommendation
- [ ] Choose option: 2
- [ ] Alternative proposal:

### D2) Load plugins explicitly from committed repository paths

Status: `accepted`

Question:

- How should Coherence discover repository-local executable plugins?

Why this matters now:

- Loading a plugin executes repository code with the user's permissions and must also work in detached worktrees used by `coherence log`.

Options:

1. Explicit `plugins` entries in `coherence.config.json`

- Pros: Intentional execution, deterministic ordering, options remain committed, historical refs carry their own declaration.
- Cons: One small configuration entry per plugin.

2. Automatically import every file under `.coherence/plugins`

- Pros: Zero configuration.
- Cons: Surprising code execution, unclear ordering, accidental activation, harder failure diagnosis.

Recommendation:

- Choose: Option 1.
- Reasoning: Executable extensions are a trust boundary; explicit opt-in is worth the small configuration cost.

Human response:

- [x] Accept recommendation
- [ ] Choose option: 2
- [ ] Alternative proposal:

### D3) Make claims a first-class plugin capability

Status: `accepted`

Question:

- Should syntax such as `via dbt schema` and `via shadow` be generic project checks or first-class claim forms?

Why this matters now:

- Claims are consumed by verification, the phrasebook, invariant anchoring, structural logging, CLAUDE rendering, atlas, and dictionary expansion.

Options:

1. Plugins provide parsed claim forms with normalized semantics

- Pros: One parser/evaluator feeds every existing consumer; dbt syntax remains entirely outside core.
- Cons: Requires replacing a few consumers of the global `CLAIM_FORMS` registry.

2. Plugins only provide arbitrary verification callbacks

- Pros: Smaller initial API.
- Cons: Claims disappear from `log`, `phrasebook`, `atlas`, `claude`, and `conforms to`; downstream special cases return immediately.

Recommendation:

- Choose: Option 1.
- Reasoning: `dbt schema` and `shadow` are claim/oracle syntax, not merely background checks.

Human response:

- [x] Accept recommendation
- [ ] Choose option: 2
- [ ] Alternative proposal:

### D4) Extend the graph through immutable fragments and structural facts

Status: `accepted`

Question:

- How should a plugin contribute system structure and temporal-ledger meaning?

Why this matters now:

- PR #8 currently adds `dbt` fields to core graph types and dbt-specific arrays and renderers to `structural.ts`.

Options:

1. Plugins return immutable graph fragments plus generic structural facts

- Pros: Atomic validation, deterministic composition, generic `coherence log`, no plugin-specific fields in core.
- Cons: Requires one generic fact diff/render path.

2. Give plugins mutable access to the live graph and custom structural-diff callbacks

- Pros: Maximum freedom.
- Cons: Ordering-dependent mutation, partial graphs, bespoke log output, difficult historical comparison.

Recommendation:

- Choose: Option 1.
- Reasoning: Coherence already derives one immutable graph consumed everywhere; extensions should preserve that property.

Human response:

- [x] Accept recommendation
- [ ] Choose option: 2
- [ ] Alternative proposal:

### D5) Keep adapter contracts specialized

Status: `accepted`

Question:

- Should language adapters, platform adapters, and additive graph contributors be collapsed into one universal hook?

Why this matters now:

- These capabilities have different contracts: a language adapter parses every source file, a platform adapter derives bindings, and dbt contributes an additional graph.

Options:

1. Keep the contracts distinct and let plugins register each capability explicitly

- Pros: Preserves clear semantics and existing adapter code; no fake common abstraction.
- Cons: The plugin capability object has several optional fields.

2. Represent every extension as one generic callback

- Pros: Superficially smaller interface.
- Cons: Callbacks need flags and branching to recover the lost distinctions.

Recommendation:

- Choose: Option 1.
- Reasoning: Similar extension mechanics do not imply identical behavioral contracts.

Human response:

- [x] Accept recommendation
- [ ] Choose option: 2
- [ ] Alternative proposal:

### D6) Deliver the framework as a stacked `jj` series

Status: `accepted`

Question:

- Should the plugin framework land as one large change or as dependency-ordered slices?

Why this matters now:

- The work touches configuration, runtime ownership, graph construction, claims, verification, structural logging, CLI routing, packaging, and documentation.

Options:

1. One plan PR followed by small stacked implementation PRs

- Pros: Each invariant is independently reviewable and green; lower slices can be corrected and automatically restacked.
- Cons: Requires stacked branch/PR management.

2. One implementation PR

- Pros: Less branch administration.
- Cons: Harder to review, bisect, and validate architectural boundaries.

Recommendation:

- Choose: Option 1.
- Reasoning: The feature naturally decomposes into foundation → graph → claims/checks → commands/documentation.

Human response:

- [x] Accept recommendation
- [ ] Choose option: 2
- [ ] Alternative proposal:

---

## 2) Proposed Plan

### Goal

After this work, a consuming repository can commit a plugin module, configure it explicitly, and have that plugin:

- register language or platform adapters;
- contribute graph nodes, edges, namespaced data, and structural facts;
- add claim grammars and evaluators;
- add whole-project verification checks;
- add namespaced CLI commands;
- work during ordinary graph/verify commands and in detached historical worktrees used by `coherence log`.

The original Coherence core must remain unaware of dbt.

### Non-goals

- Do not modify or depend on `core/`.
- Do not build a general package manager or plugin registry.
- Do not auto-discover executable files.
- Do not sandbox plugins; configured plugins are trusted repository code.
- Do not support plugin-to-plugin graph dependencies in v1.
- Do not let plugins mutate an already published graph.
- Do not merge PR #8's dbt-specific core fields and branches unchanged.
- Do not add runtime dependencies merely to load plugins; use Node's ESM facilities.

### Current Architecture

The plan relies on these existing seams:

- `src/types.ts`: `LanguageAdapter`, `PlatformAdapter`, `GraphNode`, `GraphEdge`, and `Graph`.
- `src/config.ts`: data-only configuration loading.
- `src/walk.ts`: language-independent spec and file discovery.
- `src/derive.ts`: the single graph construction path.
- `src/phrasebook.ts`: the declarative claim registry.
- `src/verify.ts`: claim evaluation and failure aggregation.
- `src/structural.ts`: historical worktree graph rebuilding and structural ledger.
- `src/cli.ts`: one command dispatcher.

Known gaps to address:

- `src/derive.ts` hard-codes language and platform maps.
- Unknown languages silently fall back to TypeScript; unknown platforms silently become `null`.
- `src/config.ts` catches missing files and malformed JSON identically.
- `CLAIM_FORMS` is a global array, and `conforms to` recursively references that global.
- Graph types have no namespaced extension-data field or generic structural facts.
- `structural.ts` understands only built-in claim shapes unless domain-specific code is added.
- CLI commands are hard-coded branches.

### Target Architecture

#### 2.1 Repository configuration

Use an explicit committed declaration:

```json
{
  "plugins": [
    {
      "path": ".coherence/plugins/dbt.ts",
      "options": {
        "manifest": "target/manifest.json",
        "snapshot": ".coherence/dbt-manifest.json",
        "semantics": "coherence.dbt.json"
      }
    }
  ]
}
```

Rules:

- `path` is relative to `cfg.root`.
- Resolve through `realpath`; reject files outside the repository, including escaping symlinks.
- Missing files, invalid exports, duplicate plugin names, API-version mismatches, and initialization failures are fatal.
- A missing `coherence.config.json` may still use defaults; malformed JSON must be fatal.
- No plugin declaration means current behavior remains unchanged.

#### 2.2 Project runtime ownership

Introduce one runtime owner, tentatively:

```ts
interface ProjectRuntime {
  config: Config
  plugins: LoadedPlugin[]
  languages: ReadonlyMap<string, LanguageAdapter>
  platforms: ReadonlyMap<string, PlatformAdapter>
  claimForms: readonly ClaimForm[]
}
```

`loadProject(root)` should:

1. Load and validate data configuration.
2. Resolve and import every declared plugin into a temporary collection.
3. Validate plugin metadata and reject duplicate capability keys.
4. Initialize plugin capabilities with `{ root, options }`.
5. Publish a `ProjectRuntime` only after every plugin is valid.

No global mutable registration. Each historical worktree gets its own runtime and its own plugin module from that ref.

#### 2.3 Versioned plugin module

Prefer one default-exported module descriptor:

```ts
interface CoherencePluginModule {
  apiVersion: 1
  name: string
  create(context: PluginInitContext): PluginCapabilities | Promise<PluginCapabilities>
}

interface PluginCapabilities {
  adapters?: {
    languages?: Record<string, LanguageAdapter>
    platforms?: Record<string, PlatformAdapter>
  }
  contributeGraph?: GraphContributor
  claimForms?: readonly ClaimForm[]
  projectChecks?: readonly ProjectCheck[]
  commands?: Readonly<Record<string, PluginCommand>>
}
```

Expose the public type contract from a documented package subpath. A repository plugin should be able to use a type-only import; it must not require a runtime helper import to load.

#### 2.4 Graph composition

Keep the existing language/platform graph as the base graph:

1. Compose built-in adapter registries with plugin-provided adapters.
2. Resolve the configured language/platform and fail on unknown names.
3. Build the base component/file/symbol/import/binding graph exactly as today.
4. Give every graph contributor a read-only view of that complete base graph.
5. Collect fragments without publishing partial results.
6. Validate and merge all fragments atomically.

Tentative fragment shape:

```ts
interface GraphFragment {
  nodes?: GraphNode[]
  edges?: GraphEdge[]
  facts?: StructuralFact[]
}
```

Add generic JSON extension data rather than domain fields:

```ts
interface GraphNode {
  // existing fields
  data?: Record<string, JsonValue>
}

interface GraphEdge {
  // existing fields
  data?: Record<string, JsonValue>
}
```

Validation:

- Node and edge IDs must be stable strings.
- Plugin IDs must be namespaced by plugin name.
- Duplicate node/edge/fact IDs are fatal.
- Edge endpoints must exist in the union of the base graph and all fragments.
- Self-edges and non-serializable data are rejected.
- Contributors cannot replace or mutate base nodes.
- Contributors see the same base graph in v1; they cannot depend on another plugin's fragment.

#### 2.5 Structural facts

Use one atomic fact per semantic property:

```ts
interface StructuralFact {
  id: string
  label: string
  value?: JsonValue
  policy?: {
    removal?: "loss"
    change?: "loss"
  }
}
```

Examples:

```text
dbt:model:ledger
dbt:model:ledger:constraint:unique(entry_id)
dbt:model:ledger:materialization
dbt:parity:allocation-becomes-revenue
```

Core responsibilities:

- Canonically compare JSON values.
- Report fact additions, removals, and changes through the standard ledger output.
- Count losses according to fact policy.
- Keep plugin facts in the ordinary `--strict` result rather than a side channel.

Plugin responsibilities:

- Choose stable, namespaced fact IDs.
- Emit already-normalized atomic values.
- Declare which removals or changes constitute losses.

#### 2.6 Claim forms and normalized semantics

Claims need both evaluation behavior and a core-readable semantic description:

```ts
interface ClaimMatch {
  family: string
  key: string
  anchors?: string[]
  target?: string
  oracle?: {
    kind: string
    name?: string
  }
  data?: JsonValue
}

interface ClaimForm {
  name: string
  grammar: string
  example: string
  tier: "deterministic" | "live" | "executable" | "hybrid"
  parse(line: string): ClaimMatch | null
  evaluate(context: ClaimContext, match: ClaimMatch): ClaimResult | Promise<ClaimResult>
}
```

Exact names may change, but preserve these invariants:

- `parse` is pure and does not need a graph.
- `family + key` is the stable identity used by structural logging.
- `anchors` tells invariant coverage what the claim proves.
- `target` and `oracle` let atlas/CLAUDE/renderers understand boundary-like claims without knowing dbt.
- `data` carries family-specific normalized semantics for rewire detection.
- Zero matching forms remains the current top-level dialect-gap skip.
- More than one matching form is a fatal ambiguous-grammar result.
- `conforms to` must recurse through the runtime registry, not the global built-in array.

dbt examples:

```text
boundary unique(event_id) at unified_events via dbt schema
```

normalizes to:

```json
{
  "family": "boundary",
  "key": "unique(event_id)",
  "anchors": ["unique(event_id)"],
  "target": "unified_events",
  "oracle": { "kind": "dbt/schema" }
}
```

```text
boundary "canonical ledger access" at ledger via shadow
```

normalizes to:

```json
{
  "family": "boundary",
  "key": "canonical ledger access",
  "anchors": ["canonical ledger access"],
  "target": "ledger",
  "oracle": { "kind": "dbt/shadow" }
}
```

Core knows these are boundary claims. Only the plugin knows how dbt schema evidence or shadow closure works.

#### 2.7 Project checks and diagnostics

Some constraints apply globally. A declared dbt chokepoint must report every bypass even when no spec claim mentions `via shadow`.

Use generic diagnostics:

```ts
interface Diagnostic {
  id: string
  status: "pass" | "fail" | "skip"
  category: string
  message: string
}
```

Requirements:

- IDs are stable and namespaced.
- Core aggregates and renders diagnostics through the standard verification output.
- Claim results may reference diagnostic IDs.
- Failure counting deduplicates identical IDs across a claim and a project check.
- A `via shadow` claim can therefore fail visibly while its individual bypasses remain the only counted failures.

#### 2.8 Plugin commands

Route plugin operations through one core namespace:

```text
coherence plugin <plugin-name> <command> [...args]
```

For dbt:

```text
coherence plugin dbt sync
coherence plugin dbt sync --check
```

Rules:

- Unknown plugin or command is a nonzero error.
- Duplicate command names inside one plugin are invalid.
- Commands receive the initialized plugin context and raw command arguments.
- Plugin commands do not run during graph construction.
- Core owns exit-code normalization and output flushing.

#### 2.9 Historical `coherence log`

`structural.ts` creates detached worktrees without `node_modules`. Preserve historical correctness:

- `graphAtRef` must call `loadProject(refRoot)`.
- Resolve the plugin module from that ref's configuration and filesystem.
- Never reuse the live working tree's plugin implementation for an old ref.
- V1 repository-local plugins must be committed and self-contained, using Node built-ins and committed project modules only.
- Generated external state should continue to use committed normalized snapshots, as PR #8 does for dbt.

### Implementation Stack

Use bookmark prefix `codex/`, matching the repository convention. The stack should be:

```text
codex/plugins-04-commands-docs
codex/plugins-03-claims-checks
codex/plugins-02-graph-facts
codex/plugins-01-runtime
codex/plugins-00-plan
main
```

Every slice includes its own tests and must be green independently.

#### PR 00 — Plan

Bookmark: `codex/plugins-00-plan`

Contents:

- This RFC only.
- No production code.

Verification:

- Confirm every decision has a recorded status.
- Confirm `core/` and `ikkan/` are absent from the diff.

#### PR 01 — Plugin runtime and adapter registration

Bookmark: `codex/plugins-01-runtime`

Goal:

- Load and atomically initialize explicitly configured in-repo plugin modules.

Likely files:

- `src/types.ts`
- `src/config.ts`
- new `src/plugins.ts` or equivalently small runtime owner
- `src/derive.ts`
- `src/structural.ts`
- `package.json`
- `tsconfig.json`
- `test/plugins.test.ts`

Behavior:

- Add `plugins` declarations to config.
- Distinguish absent config from malformed config.
- Resolve and validate in-repo paths.
- Introduce API versioning and duplicate-name checks.
- Compose built-in and plugin adapter maps.
- Reject unknown language/platform names instead of silently falling back.
- Load ref-local runtimes inside historical worktrees.
- Expose type declarations for plugin authors without requiring runtime imports.

Tests:

- No-plugin config preserves current graph behavior.
- Missing plugin path fails.
- Escaping `..` path fails.
- Symlink escaping the root fails.
- Invalid default export fails.
- Unsupported API version fails.
- Duplicate plugin name fails.
- Plugin initialization failure leaves no usable partial runtime.
- Plugin options reach initialization.
- Plugin-provided language/platform adapters resolve.
- Duplicate adapter keys fail.
- Unknown configured language/platform fails.
- Malformed `coherence.config.json` fails.
- Historical worktree loads the plugin module from that ref.

Checks:

```sh
npm test
npm run build
npm pack --dry-run
```

#### PR 02 — Graph fragments and structural facts

Bookmark: `codex/plugins-02-graph-facts`

Goal:

- Allow plugins to enrich the base graph without mutation or domain-specific core fields.

Likely files:

- `src/types.ts`
- `src/plugins.ts`
- `src/derive.ts`
- `src/structural.ts`
- `test/plugins.test.ts`
- `test/structural.test.ts`

Behavior:

- Add namespaced JSON data to nodes and edges.
- Add immutable graph contributors and fragments.
- Validate and merge fragments atomically.
- Add generic structural facts and ledger rendering.
- Ensure `--strict` respects plugin-declared fact losses.
- Omit empty extension/fact fields so repositories without plugins do not get artifact churn.

Tests:

- Contributor receives a read-only complete base graph.
- Plugin node/edge/fact IDs must be namespaced.
- Duplicate IDs fail.
- Dangling endpoints fail.
- Base-node replacement fails.
- Non-serializable data fails.
- Multiple independent fragments merge deterministically.
- Fact addition, removal, change, and loss policy render correctly.
- `log` compares facts generated by each ref's plugin.
- A repository without plugins produces the pre-change graph shape.

Checks:

```sh
npm test
npm run build
```

#### PR 03 — Extensible claims and project checks

Bookmark: `codex/plugins-03-claims-checks`

Goal:

- Make plugin claims first-class across verification, phrasebook, anchoring, structural logging, atlas, CLAUDE rendering, and dictionary expansion.

Likely files:

- `src/phrasebook.ts`
- `src/boundary.ts`
- `src/parity.ts`
- `src/verify.ts`
- `src/structural.ts`
- `src/render-claude.ts`
- `src/atlas.ts`
- `src/conventions.ts`
- `src/plugins.ts`
- relevant existing tests
- `test/plugins.test.ts`

Behavior:

- Replace regex-match-only forms with pure parsed claim semantics.
- Compose built-in and plugin claim registries per runtime.
- Preserve built-in claim behavior and output.
- Make `conforms to` recurse through the runtime registry.
- Reject ambiguous claim matches.
- Derive anchors, structural identity, target, and oracle from normalized semantics.
- Run project checks after the final graph is available.
- Aggregate diagnostics and deduplicate stable failure IDs.

Tests:

- Every existing built-in claim test remains green.
- Plugin claim appears in `coherence phrasebook`.
- Plugin claim evaluates through `verify`.
- Plugin boundary anchors an invariant.
- Plugin boundary is visible to structural log and rewiring detection.
- Plugin boundary is visible to CLAUDE rendering and atlas/conventions consumers.
- Plugin claims work inside dictionary commitments.
- Two matching forms produce an ambiguity failure.
- Project-check diagnostics are counted once when referenced by a claim.
- No-plugin output and exit behavior remain unchanged.

Checks:

```sh
npm test
npm run build
```

#### PR 04 — Namespaced commands, documentation, and end-to-end fixture

Bookmark: `codex/plugins-04-commands-docs`

Goal:

- Complete the public plugin workflow and prove it from a consuming-project fixture.

Likely files:

- `src/cli.ts`
- `src/plugins.ts`
- `README.md`
- `test/plugins.test.ts`
- a small committed fixture project under the repository's existing test conventions

Behavior:

- Add `coherence plugin <name> <command>`.
- Route arguments and normalize exit codes through the core CLI.
- Document plugin trust, lifecycle, API version, historical-worktree restriction, and all capability types.
- Provide one small fixture plugin exercising adapters, graph contribution, a structural fact, a claim, a project check, and a command.
- Keep the fixture generic; production core and production tests must not require dbt-specific branches.

Tests:

- Known command receives exact arguments.
- Unknown plugin/command fails clearly.
- Plugin commands do not execute during graph or verify.
- Fixture works through actual CLI entry points.
- Packed package includes public plugin declarations.
- A temporary consuming repository can author a type-checked plugin.

Checks:

```sh
npm test
npm run build
npm pack --dry-run
```

### dbt Migration Follow-up

The dbt implementation belongs in the consuming dbt repository, not in Coherence core.

Use PR #8 as the source and acceptance catalogue:

- manifest normalization and versioned committed snapshot;
- semantic sidecar validation;
- model/source/test graph contribution;
- dependencies, columns, constraints, materialization, roles, grain, relationships, and parity facts;
- `via dbt schema` claim form;
- `via shadow` claim form;
- `via dbt test` claim form;
- global shadow bypass project checks;
- parity project checks;
- `sync` and `sync --check` commands;
- fail-closed negative cases.

Expected consuming-repository shape:

```text
.coherence/plugins/dbt/
├── index.ts
├── graph.ts
├── claims.ts
├── shadows.ts
└── snapshot.ts
```

Migration acceptance:

- Coherence `src/` contains no dbt identifiers.
- The consuming repository config explicitly loads the plugin.
- PR #8's observable dbt behavior and negative tests survive.
- `coherence graph`, `verify`, `log`, and `plugin dbt sync --check` work.
- Historical `log` uses committed snapshots and ref-local plugin code.

### Test and Verification Strategy

For every code slice:

1. Write the narrow failing test for the slice's public behavior.
2. Implement the smallest API that makes it pass.
3. Run the narrow test.
4. Run `npm test`.
5. Run `npm run build`.
6. Review the final file regions, not only the diff.
7. Confirm `jj diff --stat` contains no `core/` or `ikkan/` paths.

Final framework verification:

```sh
npm test
npm run build
npm pack --dry-run
rg -n '\bdbt\b' src
jj diff --from main --stat
```

Expected `rg` result:

- No dbt-specific production-core implementation.

### Rollout

1. Merge the plan and framework stack bottom-up.
2. Retarget and rebase each next PR onto `main` as lower slices land.
3. Add the dbt plugin in its consuming repository.
4. Run old and new behavior against the same committed dbt snapshot.
5. Close or replace PR #8 once the plugin implementation covers its acceptance catalogue.
6. Do not add package-plugin discovery until repository-local plugins have proved the API.

### Risks and Mitigations

- **Executable repository code:** Require explicit config; document that plugins are trusted.
- **Historical nondeterminism:** Load ref-local committed modules and snapshots; no live-tree reuse.
- **Missing dependencies in detached worktrees:** Require self-contained plugins in v1.
- **Claim grammar collisions:** Fail on multiple matching forms.
- **Partial graph publication:** Collect, validate, then merge fragments atomically.
- **Plugin-specific structural branches:** Require atomic generic facts.
- **Core consumer drift:** Normalize claims once and make every consumer use the same semantics.
- **Artifact churn for non-plugin users:** Omit empty extension fields and prove pre-change graph shape.
- **Public API instability:** Require `apiVersion: 1` and a documented type-only contract.
- **Current dirty working copy:** Implement in a separate clean workspace/change and never touch unrelated paths.

---

## 3) Open Questions

These are deliberately non-blocking and should be resolved in the named slice:

- PR 01: choose the final public type subpath, likely `coherence-harness/plugin`, after verifying the packed package.
- PR 01: choose the smallest safe clean-workspace procedure for the current dirty `jj` state before creating the plan commit.
- PR 03: finalize names for `ClaimMatch` fields while preserving the semantic requirements above.
- dbt follow-up: identify the consuming repository and its preferred plugin directory.

---

## 4) Comment Thread

Append human comments using:

```text
[H]: <comment>
[A]: <response immediately below it>
```

Do not rewrite or delete earlier comments.

---

## 5) Final Agreement

### Accepted decisions

- Work only in original top-level Coherence.
- Load explicitly configured, committed, repository-local plugins.
- Use one versioned plugin module with distinct capabilities.
- Preserve specialized language/platform adapter contracts.
- Extend graphs through immutable validated fragments.
- Make claims first-class through normalized parsed semantics.
- Feed project checks into standard diagnostics.
- Feed plugin structure into the standard ledger through atomic facts.
- Route explicit operations through namespaced plugin commands.
- Deliver the framework as a bottom-up `jj` stack.
- Keep dbt implementation outside Coherence core.

### Deferred decisions

- Final public type export name.
- Exact consuming repository for the dbt migration.
- Package-based plugins beyond v1.
- Plugin-to-plugin graph dependencies.

### Next action

Create a clean `jj` workspace/change from updated `main`, preserve the current unrelated work, and commit this RFC as `codex/plugins-00-plan`. Obtain plan approval before starting PR 01.

---

## Fresh-Session Prompt

Copy this into a fresh session:

```text
Implement the in-repository plugin architecture described in:

/Users/marcecoll/proj/coherence/docs/plans/2026-07-28-in-repository-plugin-architecture-rfc.md

Read the entire RFC before acting.

Hard scope:
- Work only in the original top-level Coherence system.
- Ignore and do not modify core/ or ikkan/.
- Preserve all unrelated working-copy changes.
- PR #8 is the dbt behavioral acceptance catalogue, not code to merge unchanged.
- Production Coherence core must remain dbt-agnostic.

Before coding:
1. Inspect `jj status`, bookmarks, remotes, and main.
2. The existing working copy may contain unrelated core compiler work. Do not rewrite it.
3. Create/use a separate clean workspace or change rooted at updated main.
4. Run `jj git fetch`, then base the new stack on main.
5. Use the repository's `codex/` bookmark prefix.

Build bottom-up as:
- codex/plugins-00-plan
- codex/plugins-01-runtime
- codex/plugins-02-graph-facts
- codex/plugins-03-claims-checks
- codex/plugins-04-commands-docs

Use red/green tests for every slice. Each slice must include its own tests and pass:
- npm test
- npm run build

Start with PR 00 only: put the RFC in the clean plan commit and verify its diff contains no core/ or ikkan/ paths. Then implement PR 01 exactly as scoped in the RFC.
```
