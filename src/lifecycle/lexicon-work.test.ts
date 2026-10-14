import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lexiconCoverage } from "./lexicon-coverage.ts";
import {
  applyProposal,
  propose,
  recoverLexicon,
  reviewLexicon,
} from "./lexicon-maintain.ts";
import {
  coverageChanges,
  lexiconWorkCommand,
  priorBaseline,
  saveBaseline,
} from "./lexicon-cli.ts";
import { loadJournal } from "../journal/store.ts";
import { COHERENCE_LEXICON, PACKAGE_NAME } from "./project.ts";
import { loadLexicon } from "./lexicon.ts";
import { parseLexicon as parseScopeLexicon } from "../readings/scope/model.ts";

const who = { session: "lexicon-test", agent: "test" };
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coherence-lexicon-work-"));
  writeFileSync(
    join(root, "lexicon.json"),
    JSON.stringify({
      version: 1,
      project: "risk",
      purpose: "keep me",
      concepts: [
        {
          name: "exposure",
          definition: "Money at risk, measured in USD.",
          aliases: ["amount at risk"],
          properties: { unit: "USD" },
          not_to_be_confused_with: ["duration: time exposed"],
          detail: { explanation: "retained" },
          provenance: { owner: "human" },
        },
      ],
    }),
  );
  mkdirSync(join(root, "money"));
  mkdirSync(join(root, "time"));
  writeFileSync(
    join(root, "money/Money.spec.md"),
    "# Money\n\n## invariants\n",
  );
  writeFileSync(join(root, "time/Time.spec.md"), "# Time\n\n## invariants\n");
  writeFileSync(
    join(root, "money/model.ts"),
    "export const exposure = 12; // USD\nexport const premiumAmount = 3;\n",
  );
  writeFileSync(
    join(root, "time/model.ts"),
    "export const exposure = 7; // calendar days, not money\n",
  );
  writeFileSync(
    join(root, "notes.md"),
    "The `premium` is new. `exposure` is used twice.\nEvery `premium` is charged per policy.\nA `premium` is billed monthly.\n",
  );
  return root;
}
async function run(
  root: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await lexiconWorkCommand(args, {
    cwd: root,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
test("lexicon coverage states its observed population and leaves known words in new contexts open to sense review", async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "opaque.ipynb"), "{}");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(
      join(root, "node_modules/stranger.md"),
      "The `badCandidate` is not ours.",
    );
    writeFileSync(join(root, ".env"), "API_SECRET=never-print-this-value\n");
    const a = await lexiconCoverage(root);
    const b = await lexiconCoverage(root);
    assert.deepEqual(a, b);
    assert.ok(a.population.excluded.some((x) => x.file === "opaque.ipynb"));
    assert.ok(a.population.excluded.some((x) => x.file === "node_modules"));
    assert.ok(!JSON.stringify(a).includes("never-print-this-value"));
    const exposure = a.terms.find((t) => t.term === "exposure")!;
    assert.equal(exposure.state, "concept");
    assert.equal(exposure.layer, "project");
    assert.ok(
      exposure.contexts.some(
        (c) => c.component === "money" && c.disposition === "unreviewed",
      ),
    );
    assert.ok(
      exposure.contexts.some(
        (c) => c.component === "time" && c.disposition === "unreviewed",
      ),
    );
    assert.ok(
      a.terms.some((t) => t.term === "premium" && t.state === "unresolved"),
    );
    assert.ok(a.population.limits.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("lexicon maintenance preserves full entries, records actual effects, and refuses stale previews and unacknowledged retirement", async () => {
  const root = fixture();
  try {
    const preview = await propose(root, {
      action: "alias",
      name: "exposure",
      value: "financial exposure",
      because: "same monetary sense",
    });
    assert.ok(
      !readFileSync(join(root, "lexicon.json"), "utf8").includes(
        "financial exposure",
      ),
    );
    const appliedDecision = applyProposal(
      root,
      preview.id,
      who,
      "same monetary sense",
      ["new concept"],
    );
    assert.match(appliedDecision, /^d-/);
    const changed = JSON.parse(
      readFileSync(join(root, "lexicon.json"), "utf8"),
    );
    assert.deepEqual(changed.concepts[0].detail, { explanation: "retained" });
    assert.deepEqual(changed.concepts[0].properties, { unit: "USD" });
    assert.equal(changed.purpose, "keep me");
    assert.ok(changed.concepts[0].aliases.includes("financial exposure"));
    assert.equal(loadJournal(root).records.length, 1);
    assert.throws(
      () => applyProposal(root, preview.id, who, "again", ["none"]),
      /already applied/,
    );
    const rename = await propose(root, {
      action: "rename",
      name: "exposure",
      value: "monetary exposure",
      because: "disambiguation",
    });
    assert.throws(
      () => applyProposal(root, rename.id, who, "disambiguation", ["overload"]),
      /human/,
    );
    assert.ok(!existsSync(join(root, ".coherence/lexicon/pending.json")));
    writeFileSync(
      join(root, "lexicon.json"),
      JSON.stringify({ ...changed, extra: "concurrent change" }),
    );
    assert.throws(
      () =>
        applyProposal(
          root,
          rename.id,
          who,
          "disambiguation",
          ["overload"],
          "owner approved",
        ),
      /changed since preview/,
    );
    assert.equal(loadJournal(root).records.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("an acknowledged retirement writes a lexicon Scope reads: the name is refused at the top level as a concept", async () => {
  const root = fixture();
  try {
    const retire = await propose(root, {
      action: "retire",
      name: "exposure",
      because: "moved out of the vocabulary",
    });
    applyProposal(root, retire.id, who, "moved out", ["keeping it"], "owner approved");
    const raw = readFileSync(join(root, "lexicon.json"), "utf8");
    const lexicon = parseScopeLexicon(JSON.parse(raw), "lexicon.json");
    assert.deepEqual(lexicon.rejected_names, [
      { concept: "exposure", because: "moved out of the vocabulary" },
    ]);
    assert.equal(lexicon.concepts.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("lexicon application recovers a journal failure without lying about an unapplied change or duplicating its decision", async () => {
  const root = fixture();
  try {
    const preview = await propose(root, {
      action: "declare",
      name: "premium",
      definition: "Price paid for risk cover.",
      because: "a distinct meaning",
    });
    const unwritablePath = join(root, ".coherence/journal/lexicon-test.jsonl");
    mkdirSync(unwritablePath, { recursive: true });
    assert.throws(() =>
      applyProposal(root, preview.id, who, "distinct meaning", ["alias"]),
    );
    assert.ok(
      !existsSync(join(root, ".coherence/lexicon/pending.json")),
      "unreadable journal fails before writing",
    );
    assert.ok(
      !readFileSync(join(root, "lexicon.json"), "utf8").includes("Price paid"),
    );
    rmSync(unwritablePath, { recursive: true });
    // Simulate interruption at the durable boundary between the lexicon replacement and its decision.
    writeFileSync(
      join(root, ".coherence/lexicon/pending.json"),
      JSON.stringify({
        proposal: preview,
        who,
        because: "distinct meaning",
        over: ["alias"],
      }),
    );
    writeFileSync(join(root, "lexicon.json"), preview.after);
    assert.match(recoverLexicon(root), /^d-/);
    assert.equal(loadJournal(root).records.length, 1);
    assert.equal(recoverLexicon(root), "no pending lexicon application");
    assert.equal(loadJournal(root).records.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("lexicon maintenance refuses an outside target and preserves the original on invalid proposals", async () => {
  const root = fixture();
  const outside = fixture();
  try {
    const before = readFileSync(join(root, "lexicon.json"), "utf8");
    await assert.rejects(
      propose(root, { action: "declare", name: "broken", because: "test" }),
      /definition/,
    );
    assert.equal(readFileSync(join(root, "lexicon.json"), "utf8"), before);
    writeFileSync(
      join(root, "coherence.config.json"),
      JSON.stringify({ lexicon: join(outside, "lexicon.json") }),
    );
    await assert.rejects(
      propose(root, {
        action: "alias",
        name: "exposure",
        value: "x",
        because: "test",
      }),
      /outside/,
    );
    symlinkSync(outside, join(root, "link"));
    writeFileSync(
      join(root, "coherence.config.json"),
      JSON.stringify({ lexicon: "link/lexicon.json" }),
    );
    await assert.rejects(
      propose(root, {
        action: "alias",
        name: "exposure",
        value: "x",
        because: "test",
      }),
      /outside/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
test("sense rulings require current evidence and reopen after source or definition changes; baselines never settle meaning", async () => {
  const root = fixture();
  try {
    // A name refused for exposure, written beside a use of it, puts that context at risk, so review is asked.
    const g = JSON.parse(readFileSync(join(root, "lexicon.json"), "utf8"));
    g.concepts[0].rejected = [{ alternative: "hazard", because: "a hazard is a cause, not money at risk" }];
    writeFileSync(join(root, "lexicon.json"), JSON.stringify(g));
    writeFileSync(join(root, "money/notes.md"), "The exposure is counted in USD.\nIt is not the hazard.\n");
    const a = await lexiconCoverage(root);
    const term = a.terms.find((t) => t.term === "exposure")!;
    const context = term.contexts.find((c) => c.component === "money")!;
    saveBaseline(root, who.session, a);
    assert.equal(
      coverageChanges(a, priorBaseline(root, who.session)).length,
      0,
    );
    assert.ok(a.totals.unreviewedContexts > 0);
    await assert.rejects(
      reviewLexicon(
        root,
        "exposure",
        "money",
        context.fingerprint,
        "confirmed",
        who,
        "correct unit",
        ["time"],
      ),
      /human/,
    );
    await reviewLexicon(
      root,
      "exposure",
      "money",
      context.fingerprint,
      "confirmed",
      who,
      "correct unit",
      ["time"],
      "owner: USD is correct",
    );
    const b = await lexiconCoverage(root);
    assert.equal(
      b.terms
        .find((t) => t.term === "exposure")!
        .contexts.find((c) => c.component === "money")!.disposition,
      "confirmed",
    );
    writeFileSync(
      join(root, "money/model.ts"),
      "export const exposure = 100; // percent, not USD\n",
    );
    const c = await lexiconCoverage(root);
    assert.equal(
      c.terms
        .find((t) => t.term === "exposure")!
        .contexts.find((c) => c.component === "money")!.disposition,
      "unreviewed",
    );
    assert.ok(
      coverageChanges(c, priorBaseline(root, who.session)).some(
        (t) => t.term === "exposure",
      ),
    );
    await assert.rejects(
      reviewLexicon(
        root,
        "exposure",
        "money",
        context.fingerprint,
        "confirmed",
        who,
        "stale",
        ["none"],
        "owner",
      ),
      /stale/,
    );
    const change = await propose(root, {
      action: "define",
      name: "exposure",
      definition: "Risk on a percent basis.",
      because: "clarified unit",
    });
    applyProposal(root, change.id, who, "clarified unit", ["USD"]);
    assert.notEqual(
      (await lexiconCoverage(root)).terms.find((t) => t.term === "exposure")!
        .fingerprint,
      term.fingerprint,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("lexicon draft and fixed queries work without specs or an existing domain lexicon and never overwrite a draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "coherence-lexicon-new-"));
  try {
    writeFileSync(
      join(root, "notes.md"),
      "The `premium` has an unsettled meaning.\nA `premium` is charged per policy.\nEvery `premium` is billed monthly.\n",
    );
    const coverage = await run(root, ["coverage", "--json"]);
    assert.equal(coverage.code, 0, coverage.err);
    assert.equal(JSON.parse(coverage.out).projectLexicon, null);
    const draft = await run(root, ["draft", "--out", "draft.json"]);
    assert.equal(draft.code, 0, draft.err);
    assert.equal((await run(root, ["draft", "--out", "draft.json"])).code, 1);
    const proposed = JSON.parse(readFileSync(join(root, "draft.json"), "utf8"));
    assert.ok(
      proposed.candidates.some(
        (c: { name: string; definition: unknown }) =>
          c.name === "premium" && c.definition === null,
      ),
    );
    assert.equal((await run(root, ["ready", "--terms", "premium"])).code, 1);
    assert.equal((await run(root, ["nonsense"])).code, 1);
    assert.equal((await run(root, ["coverage", "--typo"])).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lexicon lifecycle uses child identities and installed roots, and advances changed contexts only after delivery", async () => {
  const { runHook, writtenFiles } = await import("./hook.ts");
  const root = fixture();
  try {
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex/hooks.json"), "{}");
    const input = {
      session_id: "parent",
      agent_id: "child",
      agent_type: "reviewer",
      hook_event_name: "SubagentStart",
      cwd: join(root, "money"),
    };
    const start = await runHook("SubagentStart", input, join(root, "money"));
    const context = JSON.parse(start.stdout).hookSpecificOutput
      .additionalContext as string;
    assert.match(context, /Session: child/);
    assert.match(context, /Risk vocabulary/);
    assert.match(context, /A recurring term lacks a definition: premium\./);
    assert.ok(
      !existsSync(join(root, ".coherence/lexicon/sessions/child.json")),
    );
    start.commit?.();
    assert.ok(
      existsSync(join(root, ".coherence/lexicon/sessions/child.json")),
    );
    assert.ok(!existsSync(join(root, "money/.coherence")));
    assert.ok(
      !existsSync(join(root, ".coherence/lexicon/sessions/parent.json")),
    );
    writeFileSync(
      join(root, "money/model.ts"),
      "export const riskcharge = 12;\n",
    );
    // The edit makes a new name recur in prose: held for the stop, never said at the edit.
    writeFileSync(
      join(root, "money/charges.md"),
      "The `riskcharge` is new.\nEach `riskcharge` is billed.\nA `riskcharge` is refunded on cancel.\n",
    );
    const patch = {
      ...input,
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: {
        command:
          "*** Begin Patch\n*** Update File: money/model.ts\n@@\n+export const riskcharge = 12;\n*** Delete File: time/old.ts\n*** Move to: time/new.ts\n*** End Patch",
      },
    };
    assert.deepEqual(writtenFiles(root, patch), [
      "money/model.ts",
      "time/old.ts",
      "time/new.ts",
    ]);
    const event = await runHook("PostToolUse", patch, root);
    assert.doesNotMatch(event.stdout, /riskcharge/, "the edit holds the term for the stop");
    event.commit?.();
    // No stop came between: the next prompt names what the edit held, until its line reaches the host.
    const prompt = { ...input, hook_event_name: "UserPromptSubmit", prompt: "next" };
    const told = await runHook("UserPromptSubmit", prompt, root);
    assert.match(told.stdout, /riskcharge/);
    assert.equal(
      (await runHook("UserPromptSubmit", prompt, root)).stdout,
      told.stdout,
      "unprinted context is still pending",
    );
    told.commit?.();
    assert.doesNotMatch(
      (await runHook("UserPromptSubmit", prompt, root)).stdout,
      /riskcharge/,
      "no repeated notification",
    );
    const sibling = await runHook(
      "SubagentStart",
      { ...input, agent_id: "sibling" },
      root,
    );
    assert.match(sibling.stdout, /Session: sibling/);
    const unknown = await runHook(
      "SubagentStart",
      { cwd: root, hook_event_name: "SubagentStart", session_id: "parent" },
      root,
    );
    assert.match(unknown.stdout, /Session: unknown/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Scope and the fixed lexicon query expose the same live sense evidence and escape source text", async () => {
  const { loadState } = await import("../readings/scope/build.ts");
  const { renderLexiconView } = await import(
    "../readings/scope/lexicon-view.ts"
  );
  const { answer } = await import("../readings/query/query.ts");
  const { COHERENCE_LEXICON } = await import("./project.ts");
  const root = fixture();
  try {
    writeFileSync(
      join(root, "notes.md"),
      'The `exposure` has <script>alert("unsafe")</script> in a quoted example.',
    );
    const state = await loadState({
      root,
      lexiconPath: COHERENCE_LEXICON,
      project: "risk",
    });
    state.lexicon.query = "exposure";
    const html = renderLexiconView(state.lexicon).text;
    assert.match(html, /Vocabulary coverage and sense review/);
    assert.match(html, /money\/model.ts/);
    assert.match(html, /time\/model.ts/);
    assert.ok(!html.includes('<script>alert("unsafe")</script>'));
    const read = answer(state, "lexicon", ["exposure"]);
    assert.equal(read.code, 0);
    assert.match(read.text, /Money at risk/);
    assert.match(read.text, /USD/);
    assert.match(read.text, /calendar days/);
    assert.ok(
      state.lexicon
        .coverage!.terms.find((t) => t.term === "exposure")!
        .contexts.every(
          (c) =>
            html.includes(c.fingerprint) && read.text.includes(c.fingerprint),
        ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an installed hook command locates its project from a non-git subdirectory for both hosts", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { cli } = await import("./cli-fixture.ts");
  const root = fixture();
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME }),
    );
    symlinkSync(
      fileURLToPath(new URL("..", import.meta.url)),
      join(root, "src"),
    );
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    for (const host of ["claude", "codex"]) {
      const installed = await cli(["hooks", "install", "--host", host], {
        cwd: root,
        env,
      });
      assert.equal(installed.status, 0, installed.stderr);
      const settings = JSON.parse(
        readFileSync(
          join(
            root,
            host === "claude" ? ".claude/settings.json" : ".codex/hooks.json",
          ),
          "utf8",
        ),
      );
      const command = settings.hooks.SessionStart[0].hooks[0].command;
      const result = spawnSync("sh", ["-c", command], {
        cwd: join(root, "money"),
        env,
        input: JSON.stringify({
          cwd: join(root, "money"),
          session_id: "native-fixture",
        }),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
        /lacks a definition: premium/,
      );
      assert.ok(
        existsSync(
          join(root, ".coherence/lexicon/sessions/native-fixture.json"),
        ),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local similarity is optional, validates vectors and never changes exact coverage when unavailable", async () => {
  const { cosine, normalized, similarTerms } = await import(
    "./lexicon-similarity.ts"
  );
  const root = fixture();
  try {
    const before = await lexiconCoverage(root);
    const suggestions = await similarTerms(root, "financial risk");
    assert.equal(suggestions["available"], false);
    assert.deepEqual(await lexiconCoverage(root), before);
    assert.equal(cosine(normalized([3, 4]), normalized([3, 4])), 1);
    assert.throws(() => normalized([0, 0]), /zero/);
    assert.throws(() => normalized([Number.NaN]), /invalid/);
    assert.throws(() => cosine([1], [1, 0]), /different models/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("named instances are distinct from aliases and become known without pretending a product is its category", async () => {
  const root = fixture();
  try {
    const preview = await propose(root, {
      action: "declare",
      name: "agent host",
      definition:
        "The application running an agent session and delivering lifecycle events.",
      entry: { instances: ["Example Host"] },
      because: "a product is an instance, not a synonym of the category",
    });
    applyProposal(root, preview.id, who, "distinct category and instances", [
      "alias of hook",
    ]);
    writeFileSync(join(root, "host.md"), "Example Host runs the session.\n");
    const report = await lexiconCoverage(root);
    const term = report.terms.find((t) => t.term === "example host")!;
    assert.equal(term.state, "instance");
    assert.equal(term.concept, "agent host");
    const { runCheck } = await import("./check.ts");
    const { loadProjectLexicons } = await import("./project.ts");
    const lexicon = await loadProjectLexicons(root);
    assert.ok(
      !(
        await runCheck({
          root,
          coherence: lexicon.coherence,
          project: lexicon.project,
        })
      ).unknown.some((n) => n.term === "example host"),
    );
    const change = await propose(root, {
      action: "define",
      name: "agent host",
      entry: { instances: [], detail: { note: "kept" } },
      because: "add context without losing names",
    });
    applyProposal(root, change.id, who, "preserve prior instances", [
      "losing names",
    ]);
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(root, "lexicon.json"), "utf8"),
      ).concepts.find((c: { name: string }) => c.name === "agent host")
        .instances,
      ["Example Host"],
    );
    await assert.rejects(
      propose(root, {
        action: "define",
        name: "agent host",
        entry: { name: "secret rename" },
        because: "test",
      }),
      /explicit rename/,
    );
    await assert.rejects(
      propose(root, {
        action: "declare",
        name: "located",
        definition: "No stored addresses",
        entry: { uses: [{ file: "x.ts" }] },
        because: "test",
      }),
      /addresses/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rename --qualify gives the concept a qualified name and leaves the old name free for its other senses", async () => {
  const { mkdtempSync, writeFileSync: write, readFileSync: read } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { propose } = await import("./lexicon-maintain.ts");
  const root = mkdtempSync(join(tmpdir(), "coherence-qualify-"));
  try {
    write(join(root, "lexicon.json"), JSON.stringify({ version: 1, project: "p", concepts: [{ name: "interface", definition: "d", rejected: [] }] }));
    const plain = await propose(root, { action: "rename", name: "interface", value: "component interface", because: "b" });
    assert.match(plain.after, /"alternative": "interface"/, "a plain rename rejects the old name");
    const qualified = await propose(root, { action: "rename", name: "interface", value: "component interface", qualify: true, because: "b" });
    assert.doesNotMatch(qualified.after, /"alternative": "interface"/, "a qualifying rename leaves the old name free");
    assert.match(qualified.after, /"name": "component interface"/);
    void read;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a project carrying its lexicon under the retired name is refused with the one-line migration, and the old name is never read", async () => {
  const { renameSync } = await import("node:fs");
  const { loadProjectLexicons, retiredLexiconNames } = await import("./project.ts");
  const [old] = await retiredLexiconNames();
  assert.ok(old !== undefined, "Coherence's lexicon records the name the concept was renamed from");
  const root = fixture();
  try {
    renameSync(join(root, "lexicon.json"), join(root, `${old}.json`));
    const migration = new RegExp(`git mv ${old}\\.json lexicon\\.json`);
    await assert.rejects(loadProjectLexicons(root), migration);
    const coverage = await run(root, ["coverage"]);
    assert.equal(coverage.code, 1, "the command fails rather than reading nothing");
    assert.match(coverage.err, migration);
    renameSync(join(root, `${old}.json`), join(root, "lexicon.json"));
    writeFileSync(join(root, "coherence.config.json"), JSON.stringify({ [old]: "lexicon.json" }));
    await assert.rejects(loadProjectLexicons(root), /rename the key to "lexicon"/);
    writeFileSync(join(root, "coherence.config.json"), JSON.stringify({ lexicon: "lexicon.json" }));
    assert.equal((await loadProjectLexicons(root)).project?.project, "risk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rulings recorded under the retired verb still count: the journal is read as written", async () => {
  const { sessionFiles, sessionText } = await import("../journal/shard-fixture.ts");
  const { retiredLexiconNames } = await import("./project.ts");
  const [old] = await retiredLexiconNames();
  assert.ok(old !== undefined);
  const root = fixture();
  const rewrite = (verb: string): void => {
    for (const name of sessionFiles(join(root, ".coherence", "journal"), who.session)) {
      const path = join(root, ".coherence", "journal", name);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll(`"chose":"lexicon ${verb} `, `"chose":"${old} ${verb} `));
    }
  };
  try {
    const g = JSON.parse(readFileSync(join(root, "lexicon.json"), "utf8"));
    g.concepts[0].rejected = [{ alternative: "hazard", because: "a hazard is a cause, not money at risk" }];
    writeFileSync(join(root, "lexicon.json"), JSON.stringify(g));
    writeFileSync(join(root, "money/notes.md"), "The exposure is counted in USD.\nIt is not the hazard.\n");
    const context = (await lexiconCoverage(root)).terms.find((t) => t.term === "exposure")!.contexts.find((c) => c.component === "money")!;
    await reviewLexicon(root, "exposure", "money", context.fingerprint, "confirmed", who, "correct unit", ["time"], "owner: USD is correct");
    rewrite("review");
    assert.match(sessionText(join(root, ".coherence", "journal"), who.session), new RegExp(`"chose":"${old} review `), "the fixture holds a review under the retired verb");
    const after = (await lexiconCoverage(root)).terms.find((t) => t.term === "exposure")!.contexts.find((c) => c.component === "money")!;
    assert.equal(after.disposition, "confirmed", "a review recorded before the rename keeps its ruling");
    const change = await propose(root, { action: "define", name: "exposure", definition: "Money at risk, in USD.", because: "clarified" });
    applyProposal(root, change.id, who, "clarified", ["none"]);
    rewrite("apply");
    assert.match(sessionText(join(root, ".coherence", "journal"), who.session), new RegExp(`"chose":"${old} apply `));
    assert.throws(() => applyProposal(root, change.id, who, "clarified", ["none"]), /already applied/, "an application recorded before the rename still counts as applied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lexicon propose prints the proposal as a reader needs it, id first, and the whole lexicon only with --json", async () => {
  const root = fixture();
  try {
    const summary = await run(root, ["propose", "define", "exposure", "--definition", "Money at risk, in USD.", "--because", "tighter"]);
    assert.equal(summary.code, 0, summary.err);
    const lines = summary.out.split("\n");
    assert.match(lines[0]!, /^lp-[0-9a-f]+ {2}proposes define "exposure" in lexicon\.json$/, "the id leads the first line");
    assert.match(summary.out, /entry after: \{"name":"exposure".*"definition":"Money at risk, in USD\."/);
    assert.match(summary.out, /apply: lexicon apply lp-[0-9a-f]+ --because "<why>"/);
    assert.ok(!summary.out.includes('"after"') && summary.out.length < 2000, "the lexicon after the change is not printed");
    const whole = await run(root, ["propose", "define", "exposure", "--definition", "Money at risk.", "--because", "tighter", "--json"]);
    const parsed = JSON.parse(whole.out) as { id: string; after: string };
    assert.match(parsed.id, /^lp-/);
    assert.ok(parsed.after.includes("Money at risk."), "--json keeps the whole proposal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a define keeps every property and detail key unless one is dropped by name, and the applying decision carries the dropped text", async () => {
  const root = fixture();
  try {
    const merge = await propose(root, {
      action: "define",
      name: "exposure",
      entry: { properties: { currency: "the ISO code" } },
      because: "a second property",
    });
    applyProposal(root, merge.id, who, "a second property", ["none"]);
    let entry = JSON.parse(readFileSync(join(root, "lexicon.json"), "utf8")).concepts[0];
    assert.deepEqual(entry.properties, { unit: "USD", currency: "the ISO code" }, "a define merges; it never drops a key it does not name");
    const drop = await propose(root, {
      action: "define",
      name: "exposure",
      drop: ["properties.unit", "detail.explanation"],
      because: "the unit moved into the definition",
    });
    const id = applyProposal(root, drop.id, who, "the unit moved into the definition", ["keeping a stale key"]);
    entry = JSON.parse(readFileSync(join(root, "lexicon.json"), "utf8")).concepts[0];
    assert.deepEqual(entry.properties, { currency: "the ISO code" });
    assert.equal(entry.detail, undefined, "an emptied detail leaves the entry");
    const decision = loadJournal(root).records.find((r) => r.id === id) as { chose: string };
    assert.ok(decision.chose.includes('"properties.unit":"USD"'), decision.chose);
    assert.ok(decision.chose.includes('"detail.explanation":"retained"'), decision.chose);
    await assert.rejects(
      propose(root, { action: "define", name: "exposure", drop: ["aliases.amount at risk"], because: "x" }),
      /properties\.<key> or detail\.<key>/,
    );
    await assert.rejects(
      propose(root, { action: "alias", name: "exposure", value: "y", drop: ["properties.currency"], because: "x" }),
      /only to define/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a property drop's preview counts the current uses that would become unknown-noun findings, before apply", async () => {
  const root = fixture();
  try {
    const lexicon = JSON.parse(readFileSync(join(root, "lexicon.json"), "utf8"));
    lexicon.concepts[0].properties.tranche = "the slice of a book the exposure sits in";
    writeFileSync(join(root, "lexicon.json"), JSON.stringify(lexicon));
    writeFileSync(
      join(root, "money/book.md"),
      "Each charge names its Tranche here.\nA desk reports per Tranche daily.\nThe report sums every Tranche monthly.\n",
    );
    const counted = await run(root, ["propose", "define", "exposure", "--drop", "properties.tranche", "--because", "not a property"]);
    assert.equal(counted.code, 0, counted.err);
    assert.match(counted.out, /dropping properties\.tranche: 3 current uses would become unknown-noun findings \(tranche\)/);
    assert.match(counted.out, /removes properties\.tranche: "the slice of a book the exposure sits in"/);
    const quiet = await propose(root, { action: "define", name: "exposure", drop: ["properties.unit"], because: "x" });
    assert.deepEqual(quiet.findings, [{ drop: "properties.unit", uses: 0, terms: [] }]);
    assert.ok(readFileSync(join(root, "lexicon.json"), "utf8").includes("tranche"), "a preview writes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provenance is append-only: a drop of a provenance key and a define that rewrites one are refused, a new key is added", async () => {
  const root = fixture();
  try {
    await assert.rejects(
      propose(root, { action: "define", name: "exposure", drop: ["provenance.owner"], because: "x" }),
      /provenance is append-only/,
    );
    await assert.rejects(
      propose(root, { action: "define", name: "exposure", entry: { provenance: { owner: "agent" } }, because: "x" }),
      /provenance is append-only/,
    );
    const added = await propose(root, { action: "define", name: "exposure", entry: { provenance: { source: "the 2026 audit" } }, because: "x" });
    const entry = (JSON.parse(added.after) as { concepts: { provenance: unknown }[] }).concepts[0]!;
    assert.deepEqual(entry.provenance, { owner: "human", source: "the 2026 audit" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejection is lifted only with a human acknowledgement and a cite of the decision that rejected it", async () => {
  const root = fixture();
  try {
    const reject = await propose(root, { action: "reject", name: "exposure", value: "risk sum", because: "vague" });
    const original = applyProposal(root, reject.id, who, "vague", ["keeping it"]);
    const define = await propose(root, { action: "define", name: "exposure", entry: { rejected: [] }, because: "x" });
    assert.ok(define.after.includes("risk sum"), "a define never removes a rejection");
    const lift = await propose(root, { action: "lift", name: "exposure", value: "risk sum", because: "the desk's own word" });
    assert.equal(lift.humanRequired, true);
    assert.throws(() => applyProposal(root, lift.id, who, "the desk's own word", ["keeping it rejected"]), /human/);
    assert.throws(
      () => applyProposal(root, lift.id, who, "the desk's own word", ["keeping it rejected"], "owner said so"),
      new RegExp(`cites the decision that made it: --cite ${original}`),
    );
    assert.ok(readFileSync(join(root, "lexicon.json"), "utf8").includes("risk sum"), "a refused lift changes nothing");
    const id = applyProposal(root, lift.id, { ...who, cite: [original] }, "the desk's own word", ["keeping it rejected"], "owner said so");
    assert.ok(!readFileSync(join(root, "lexicon.json"), "utf8").includes("risk sum"));
    const decision = loadJournal(root).records.find((r) => r.id === id) as { chose: string };
    assert.ok(decision.chose.includes('"rejected.risk sum":{"alternative":"risk sum","because":"vague"}'), decision.chose);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("before a project lexicon exists, coverage names no project lexicon even with Coherence installed inside the project, and review reads a term's live uses", async () => {
  const root = mkdtempSync(join(tmpdir(), "coherence-lexicon-adopt-"));
  try {
    // Coherence installed inside the adopter, as npm puts it: its lexicon lies under the root but is not the project's.
    mkdirSync(join(root, "vendor/coherence/docs"), { recursive: true });
    const installed = join(root, "vendor/coherence/docs/lexicon.json");
    copyFileSync(COHERENCE_LEXICON, installed);
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app/schema.ts"), "export interface Chat { id: string }\nexport function saveChat(chat: Chat) { return chat; }\n");
    writeFileSync(join(root, "notes.md"), "Each chat belongs to a user.\n");
    const coherence = await loadLexicon(installed);
    const report = await lexiconCoverage(root, { coherence, project: undefined });
    assert.equal(report.projectLexicon, null);
    const review = await run(root, ["review", "chat"]);
    assert.equal(review.code, 0, review.err);
    assert.match(review.out, /"chat" is written on 3 lines, below the recurrence a candidate needs/);
    assert.match(review.out, /app\/schema\.ts:2 export function saveChat/);
    assert.match(review.out, /notes\.md:1 Each chat belongs to a user\./);
    const json = JSON.parse((await run(root, ["review", "chat", "--json"])).out) as { liveUseCount: number };
    assert.equal(json.liveUseCount, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an entry file outside the project is refused naming that entry file, not the lexicon", async () => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), "coherence-lexicon-entry-"));
  try {
    const entry = join(outside, "x.json");
    writeFileSync(entry, JSON.stringify({ properties: { currency: "ISO" } }));
    const refused = await run(root, ["propose", "define", "exposure", "--entry", entry, "--because", "x"]);
    assert.equal(refused.code, 1);
    assert.equal(refused.err, `lexicon: entry file ${entry} is outside the project root`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
