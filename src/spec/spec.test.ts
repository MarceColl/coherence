/**
 * The spec check: the grammar, the model, and the state derivation over
 * fixtures written into a temporary directory.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadLexicon } from "../lifecycle/lexicon.ts";
import { runCheck } from "../lifecycle/check.ts";
import { COHERENCE_LEXICON } from "../lifecycle/project.ts";
import { RETIRED_SECTIONS, isCalendarDate, isModuleHandler, parseSpec, type Invariant } from "./grammar.ts";
import { declaresAtTop, loadSpecModel, type SpecModel } from "./model.ts";
import { formatReport } from "./report.ts";
import { applicableShapes, loadSeed } from "./seed.ts";
import { deriveState } from "./state.ts";
import type { Latest } from "../enforcement/record.ts";

/** A latest chokepoint entry whose automatic refutation fired: the run's own witness. */
function automatic(): Latest {
  return {
    component: ".",
    name: "digest-only egress",
    form: "chokepoint",
    verdict: "pass",
    grade: "reference-choked",
    refutation: "automatic",
    bypasses: [],
    testReferences: 0,
    files: [],
    latency: 1,
    reason: "",
    at: "2026-09-18T10:00:00.000Z",
    commit: null,
    session: "s",
  };
}

const seed = loadSeed();

function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "coherence-spec-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
  }
  return root;
}

function withModel(files: Record<string, string>, run: (model: SpecModel) => void): void {
  const root = scratch(files);
  try {
    run(loadSpecModel(root, { seed }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ENTRY = `# Widgetry

A store of widgets with one door in.

## trust levels
- owner-trusted: the owner's own calls
- storage: the rows beneath everything
- public-egress: what leaves in the clear

## invariants
`;

const FULL_BULLET = `- digest-only egress: A secret leaves storage only as its digest.
  protects: SECRET_COLUMNS
  chokepoint: seal
  over: every column declared secret in SECRET_COLUMNS
  via: egress digest totality
  because: a read of a leaked row must disclose no usable bearer
  crossing: storage -> public-egress
  refuted: removed the seal call from the row renderer -> egress digest totality went red naming the column (2026-09-17)
  kinds: credential, output
`;

function checklistFor(kinds: string[], declaredAs: string): string {
  return applicableShapes(seed, kinds)
    .map((shape, index) => (index === 0 ? `  checklist: ${shape.shape} declared as ${declaredAs}\n` : `  checklist: ${shape.shape} dismissed: not this shape\n`))
    .join("");
}

const OTHER = `- door count: Every write enters through one door.
  protects: rows
  chokepoint: write
  because: one door is one place to look
  kinds: none
`;

function firstInvariant(text: string): Invariant {
  const parsed = parseSpec(text, "X.spec.md", { seed });
  assert.deepEqual(parsed.problems, []);
  const invariant = parsed.invariants[0];
  assert.ok(invariant !== undefined);
  return invariant;
}

test("the grammar parses a full bullet with both enforcement forms", () => {
  const invariant = firstInvariant(`${ENTRY}${FULL_BULLET}${checklistFor(["credential", "output"], "door count")}${OTHER}`);
  assert.equal(invariant.name, "digest-only egress");
  assert.equal(invariant.sentence, "A secret leaves storage only as its digest.");
  assert.deepEqual(
    invariant.enforcements.map((e) => e.form),
    ["chokepoint", "totality oracle"],
  );
  const chokepoint = invariant.enforcements[0];
  assert.ok(chokepoint !== undefined && chokepoint.form === "chokepoint");
  assert.equal(chokepoint.protects, "SECRET_COLUMNS");
  assert.equal(chokepoint.chokepoint, "seal");
  const totality = invariant.enforcements[1];
  assert.ok(totality !== undefined && totality.form === "totality oracle");
  assert.equal(totality.via, "egress digest totality");
  assert.equal(invariant.because, "a read of a leaked row must disclose no usable bearer");
  assert.deepEqual({ from: invariant.crossing?.from, to: invariant.crossing?.to }, { from: "storage", to: "public-egress" });
  assert.equal(invariant.refutations.length, 1);
  assert.equal(invariant.refutations[0]?.date, "2026-09-17");
  assert.equal(invariant.refutations[0]?.broke, "removed the seal call from the row renderer");
  assert.deepEqual(invariant.kinds, ["credential", "output"]);
  assert.equal(invariant.checklist.length, applicableShapes(seed, ["credential", "output"]).length);
  assert.equal(invariant.checklist[0]?.outcome, "declared");
  assert.equal(invariant.checklist[1]?.outcome, "dismissed");
  assert.deepEqual(invariant.unfilled, []);
});

test("a wrapped value continues the line above it", () => {
  const invariant = firstInvariant(`${ENTRY}- wrapped: A sentence that
    keeps going.
  because: a reason that
    also wraps
`);
  assert.equal(invariant.sentence, "A sentence that keeps going.");
  assert.equal(invariant.because, "a reason that also wraps");
});

test("the state derivation: the full bullet is an invariant, and each missing part keeps it a requirement", () => {
  const full = firstInvariant(`${ENTRY}${FULL_BULLET}${checklistFor(["credential", "output"], "door count")}${OTHER}`);
  const applicable = applicableShapes(seed, ["credential", "output"]).map((s) => s.shape);
  // The bullet carries a refuted: line and both forms; with no run and no refutation record it refutes nothing.
  assert.deepEqual(deriveState(full, applicable), {
    state: "requirement",
    lacks: ["refutation"],
    missingShapes: [],
    verified: [],
    defects: [],
    unrefuted: ["chokepoint", "totality oracle"],
  });
  const witnessedBoth = { chokepoint: automatic(), totality: undefined };
  assert.deepEqual(deriveState(full, applicable, witnessedBoth, true).lacks, [], "the automatic refutation and the record together");
  assert.equal(deriveState(full, applicable, witnessedBoth, true).state, "invariant");

  const without = (...keys: string[]): Invariant => {
    const lines = `${FULL_BULLET}${checklistFor(["credential", "output"], "door count")}`
      .split("\n")
      .filter((line) => !keys.some((key) => line.trimStart().startsWith(`${key}:`)));
    return firstInvariant(`${ENTRY}${lines.join("\n")}\n${OTHER}`);
  };
  const oneForm = without("protects", "chokepoint");
  assert.equal(oneForm.enforcements.length, 1, "the totality oracle form alone still enforces");
  assert.equal(deriveState(oneForm, applicable, undefined, true).state, "invariant");
  assert.equal(deriveState(oneForm, applicable).state, "requirement", "and it still needs its own refutation record");
  const noEnforcement = without("protects", "chokepoint", "over", "via");
  assert.deepEqual(deriveState(noEnforcement, applicable).lacks, ["enforcement", "refutation"]);
  assert.equal(deriveState(noEnforcement, applicable).state, "requirement");

  const noRefutation = without("refuted");
  assert.deepEqual(deriveState(noRefutation, applicable).lacks, ["refutation"]);
  assert.deepEqual(deriveState(noRefutation, applicable, witnessedBoth, true).lacks, [], "the refuted: line is the human account, not the evidence");

  const noBecause = without("because");
  assert.deepEqual(deriveState(noBecause, applicable, witnessedBoth, true).lacks, ["because"]);
  assert.equal(deriveState(noBecause, applicable, witnessedBoth, true).state, "invariant", "because is reported but does not change the state");

  const noKinds = without("kinds");
  assert.deepEqual(deriveState(noKinds, [], witnessedBoth, true).lacks, ["kinds"]);
  assert.equal(deriveState(noKinds, [], witnessedBoth, true).state, "requirement");

  const noChecklist = without("checklist");
  const derived = deriveState(noChecklist, applicable, witnessedBoth, true);
  assert.deepEqual(derived.lacks, ["checklist"]);
  assert.deepEqual(derived.missingShapes, applicable);
  assert.equal(derived.state, "requirement");

  const bare = firstInvariant(`${ENTRY}- bare: Nothing but a sentence.\n`);
  assert.deepEqual(deriveState(bare, []).lacks, ["enforcement", "refutation", "kinds", "because"]);
});

test("a placeholder value parses but counts as absent", () => {
  const invariant = firstInvariant(`${ENTRY}- <name>: A sentence.
  protects: <the protected thing>
  chokepoint: seal
  because: <why>
  refuted: <what was broken> -> <what was seen> (<date>)
  kinds: credential
  checklist: capability-authorization declared as <invariant name> | dismissed: <reason>
`);
  assert.deepEqual(invariant.enforcements, []);
  assert.equal(invariant.because, undefined);
  assert.deepEqual(invariant.refutations, []);
  assert.deepEqual(invariant.checklist, []);
  assert.deepEqual(invariant.unfilled, ["name", "protects", "because", "refuted", "checklist capability-authorization"]);
});

test("half an enforcement form, an unknown key, a bad crossing, and a bad refutation are problems", () => {
  const parsed = parseSpec(
    `${ENTRY}- half: A sentence.
  chokepoint: seal
  via: a test
  colour: blue
  crossing: storage
  refuted: broke it and nothing happened
  kinds: credential, sprocket
  checklist: no-such-shape dismissed: never
  checklist: capability-authorization is fine
`,
    "X.spec.md",
    { seed },
  );
  const messages = parsed.problems.map((p) => p.message);
  assert.ok(messages.some((m) => m.includes("the chokepoint form on half names both protects: and chokepoint:; protects: is missing")), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("the totality oracle form on half names both over: and via:; over: is missing")));
  assert.ok(messages.some((m) => m.includes('unknown key "colour"')));
  assert.ok(messages.some((m) => m.includes("crossing on half reads <trust level> -> <trust level>")));
  assert.ok(messages.some((m) => m.includes("refuted on half reads <what was broken> -> <what was seen> (YYYY-MM-DD)")));
  assert.ok(messages.some((m) => m.includes("unknown kind sprocket")));
  assert.ok(messages.some((m) => m.includes("no shape named no-such-shape")));
  assert.ok(messages.some((m) => m.includes("checklist on half reads <shape> declared as <invariant name> or <shape> dismissed: <reason>")));
});

test("every retired section is refused by name with its replacement", () => {
  assert.ok(RETIRED_SECTIONS.length >= 7);
  for (const retired of RETIRED_SECTIONS) {
    const parsed = parseSpec(`# X\n\nIntent.\n\n## ${retired.section}\n- something\n\n## invariants\n`, "X.spec.md", { seed });
    const found = parsed.problems.find((p) => p.message.includes(`## ${retired.section} is retired`));
    assert.ok(found !== undefined, `${retired.section} is refused`);
    assert.ok(found.message.includes(retired.replacement), `${retired.section} names its replacement`);
    assert.equal(found.line, 5);
  }
  const unknown = parseSpec(`# X\n\nIntent.\n\n## notes\n`, "X.spec.md", { seed });
  assert.ok(unknown.problems.some((p) => p.message.includes('unknown section "notes"')));
});

test("a spec needs a title and an intent, and holds no prose beyond the intent", () => {
  const bare = parseSpec("", "X.spec.md", { seed });
  assert.ok(bare.problems.some((p) => p.message.includes("a spec starts with # <Name>")));
  assert.ok(bare.problems.some((p) => p.message.includes("a spec needs its intent")));
  const chatty = parseSpec("# X\n\nIntent.\n\nMore prose here.\n\n## invariants\n", "X.spec.md", { seed });
  assert.equal(chatty.intent, "Intent.");
  assert.ok(chatty.problems.some((p) => p.message.includes("prose after the intent")));
});

test("the model: components nest by folder, transparent folders are skipped, and counts add up", () => {
  withModel(
    {
      "Widgetry.spec.md": `${ENTRY}${FULL_BULLET}${checklistFor(["credential", "output"], "door count")}${OTHER}`,
      "src/store/Store.spec.md": "# Store\n\nThe rows.\n\n## invariants\n- one: A sentence.\n  because: reasons\n",
      "src/store/deep/inner/Inner.spec.md": "# Inner\n\nDeep.\n\n## invariants\n",
      "node_modules/x/X.spec.md": "# Skipped\n\nNever read.\n",
    },
    (model) => {
      assert.deepEqual(model.problems, []);
      assert.deepEqual(
        model.components.map((c) => [c.folder, c.parent, c.children]),
        [
          [".", undefined, ["src/store"]],
          ["src/store", ".", ["src/store/deep/inner"]],
          ["src/store/deep/inner", "src/store", []],
        ],
      );
      assert.equal(model.entry, ".");
      assert.deepEqual(
        model.trustLevels.map((t) => t.name),
        ["owner-trusted", "storage", "public-egress"],
      );
      assert.equal(model.components[1]?.intent, "The rows.");
      assert.deepEqual(
        model.components[0]?.invariants.map((i) => [i.name, i.state]),
        [
          ["digest-only egress", "requirement"],
          ["door count", "requirement"],
        ],
      );
      // No run and no refutation record: nothing in this tree has been seen to fire.
      assert.deepEqual(model.counts, {
        components: 3,
        bullets: 3,
        invariants: 0,
        requirements: 3,
        structuralDefects: 0,
        lacking: { enforcement: 1, refutation: 3, kinds: 1, checklist: 0, because: 0 },
        unfilled: 0,
        problems: 0,
      });
      const report = formatReport(model);
      assert.match(report, /digest-only egress {2}requirement {2}lacks refutation\n/);
      assert.match(report, /chokepoint seal protects SECRET_COLUMNS: declared, unverified/);
      assert.match(report, /totality oracle "egress digest totality" over every column declared secret in SECRET_COLUMNS: declared, unverified/);
      assert.match(report, /door count {2}requirement {2}lacks refutation/);
      assert.match(report, /3 components, 3 bullets: 0 invariants, 3 requirements/);
    },
  );
});

test("the model: crossings name declared trust levels, and only the entry spec declares them", () => {
  withModel(
    {
      "Widgetry.spec.md": `${ENTRY}- x: A sentence.\n  crossing: storage -> nowhere\n`,
      "sub/Sub.spec.md": "# Sub\n\nA sub.\n\n## trust levels\n- extra: not here\n\n## invariants\n- y: A sentence.\n  crossing: owner-trusted -> storage\n",
    },
    (model) => {
      const messages = model.problems.map((p) => `${p.file}:${p.line} ${p.message}`);
      assert.ok(messages.some((m) => m.startsWith("Widgetry.spec.md:") && m.includes("crossing on x names trust level nowhere; declared: owner-trusted, storage, public-egress")), messages.join("\n"));
      assert.ok(messages.some((m) => m.startsWith("sub/Sub.spec.md:5") && m.includes("trust levels are declared in the entry spec only (Widgetry.spec.md)")));
      assert.equal(messages.length, 2);
    },
  );
  withModel({ "sub/Sub.spec.md": "# Sub\n\nA sub.\n\n## invariants\n- y: A sentence.\n  crossing: a -> b\n" }, (model) => {
    assert.ok(model.problems.some((p) => p.message.includes("no entry spec declares trust levels")));
  });
});

/** An entry spec whose public level comes from outside the system's control, with two entrances into a handler in src/door. */
function trustedDoor(trust: { take?: string; peek?: string }, crossing = "public -> storage"): Record<string, string> {
  const line = (value: string | undefined): string => (value === undefined ? "" : `  trust: ${value}\n`);
  return {
    "Widgetry.spec.md": `# Widgetry\n\nA store of widgets with one door in.\n\n## trust levels\n- public (outside): what anyone on the network sends\n- owner-trusted: the owner's own calls\n- storage: the rows beneath everything\n\n## entrances\n- take: a caller takes a widget\n  handler: take in src/door/door.ts\n${line(trust.take)}- peek: a caller looks at a widget\n  handler: peek in src/door/door.ts\n${line(trust.peek)}\n## invariants\n`,
    "src/door/Door.spec.md": `# Door\n\nThe one door.\n\n## invariants\n- one door: Every take enters through take.\n  protects: widgets\n  chokepoint: take\n  crossing: ${crossing}\n`,
    "src/door/door.ts": "export function take(): void {}\nexport function peek(): void {}\n",
  };
}

test("the model: an entrance's trust names a declared trust level, and a trust level's one marker is (outside)", () => {
  withModel(trustedDoor({ take: "public", peek: "owner-trusted" }), (model) => {
    assert.deepEqual(model.problems, []);
    assert.deepEqual(model.trustLevels.map((level) => [level.name, level.outside]), [["public", true], ["owner-trusted", false], ["storage", false]]);
    const entrances = model.components.find((c) => c.folder === ".")!.entrances;
    assert.deepEqual(entrances.map((e) => [e.name, e.trust]), [["take", "public"], ["peek", "owner-trusted"]]);
    assert.ok(formatReport(model).length > 0);
  });
  withModel(trustedDoor({ take: "public", peek: "nowhere" }), (model) => {
    const messages = model.problems.map((p) => `${p.file}:${p.line} ${p.message}`);
    assert.deepEqual(messages, ["Widgetry.spec.md:16 entrance peek declares trust nowhere, which is no trust level; declared: public, owner-trusted, storage"]);
  });
  // No declaration is no problem: the trust is derived. A placeholder counts as absent, and an empty line is refused.
  withModel(trustedDoor({ peek: "<trust level>" }), (model) => {
    assert.deepEqual(model.problems, []);
    assert.equal(model.components.find((c) => c.folder === ".")!.entrances[1]!.trust, undefined);
  });
  const empty = parseSpec("# A\n\nAn a.\n\n## entrances\n- in: work enters\n  handler: x\n  trust:\n  trust: public\n", "A.spec.md");
  assert.ok(empty.problems.some((p) => p.line === 8 && p.message === "trust: on entrance in names no trust level"));
  assert.ok(empty.problems.some((p) => p.line === 9 && p.message === "entrance in names its trust twice"));
  // Any marker but (outside) is refused, and the level keeps its bare name.
  const marked = parseSpec("# A\n\nAn a.\n\n## trust levels\n- public (untrusted): anyone\n- owner (outside): the owner\n", "A.spec.md");
  assert.deepEqual(marked.trustLevels?.map((level) => [level.name, level.outside]), [["public", false], ["owner", true]]);
  assert.deepEqual(marked.problems.map((p) => p.message), ["trust level public is marked (untrusted); the one marker is (outside), for a level from outside the system's control"]);
});

test("the model: an entrance's declared trust contradicting a crossing on its handler is a problem", () => {
  withModel(trustedDoor({ take: "public" }), (model) => assert.deepEqual(model.problems, [], "agreeing with the crossing's entering side"));
  withModel(trustedDoor({ take: "owner-trusted", peek: "owner-trusted" }), (model) => {
    const messages = model.problems.map((p) => `${p.file}:${p.line} ${p.message}`);
    assert.deepEqual(messages, ["Widgetry.spec.md:13 entrance take declares trust owner-trusted, but its handler take is the chokepoint of one door in src/door/Door.spec.md, whose crossing enters from public"], "only the entrance whose handler is the chokepoint");
  });
  // The chokepoint named with its file is the same handler.
  withModel({ ...trustedDoor({ take: "storage" }), "src/door/Door.spec.md": "# Door\n\nThe one door.\n\n## invariants\n- one door: Every take enters through take.\n  protects: widgets\n  chokepoint: take in door.ts\n  crossing: public -> storage\n" }, (model) => {
    assert.equal(model.problems.length, 1);
    assert.match(model.problems[0]!.message, /entrance take declares trust storage, but its handler take is the chokepoint of one door/);
  });
});

test("the model: names are unique within a component, declared-as names must exist, and one spec per folder", () => {
  withModel(
    {
      "Widgetry.spec.md": `${ENTRY}- twin: A sentence.\n- twin: Another.\n- lonely: A sentence.\n  kinds: credential\n  checklist: capability-authorization declared as nobody\n  checklist: revalidated-permission declared as lonely\n`,
      "Zecond.spec.md": "# Zecond\n\nA second spec in the root, sorted after the first.\n",
    },
    (model) => {
      const messages = model.problems.map((p) => p.message);
      assert.ok(messages.some((m) => m === "invariant twin declared twice in this component"));
      assert.ok(messages.some((m) => m.includes('capability-authorization declared as "nobody", which names no invariant')));
      assert.ok(!messages.some((m) => m.includes("revalidated-permission")), "a shape declared as the bullet itself is fine: the requirement often is the shape");
      assert.ok(messages.some((m) => m.includes("a folder holds one spec")));
    },
  );
});

test("the model honors the config's entryDir and ignore list", () => {
  withModel(
    {
      "coherence.config.json": JSON.stringify({ entryDir: "app", ignore: ["vendor"] }),
      "app/App.spec.md": "# App\n\nThe app.\n\n## trust levels\n- a: one\n- b: two\n\n## invariants\n- x: A sentence.\n  crossing: a -> b\n",
      "vendor/lib/Lib.spec.md": "# Lib\n\nIgnored.\n",
    },
    (model) => {
      assert.deepEqual(model.problems, []);
      assert.equal(model.entry, "app");
      assert.deepEqual(
        model.components.map((c) => c.folder),
        ["app"],
      );
    },
  );
});

test("a spec written in the grammar with every shape name carries no rejected name", async () => {
  const lines = [ENTRY, "- every shape: A sentence.\n  kinds: none\n"];
  for (const shape of seed.shapes) lines.push(`  checklist: ${shape.shape} dismissed: not this one\n`);
  for (const kind of Object.keys(seed.kinds)) lines.push(`- kind ${kind}: A sentence.\n  kinds: ${kind}\n`);
  const root = scratch({ "Widgetry.spec.md": lines.join("") });
  try {
    const coherence = await loadLexicon(COHERENCE_LEXICON);
    const report = await runCheck({ root, coherence });
    assert.deepEqual(report.rejected, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a long refuted value parses in linear time, and three digit groups that name no day are refused", () => {
  // Reviewer A: the old pattern put a lazy group on each side of the arrow and a third before the date,
  // so a long value with no closing date backtracked quadratically: 156 KB took 16 s, on every hook event.
  // The shape that blows up is a value that reaches the arrow and never reaches a date: 156 KB of "a -> "
  // took 16.5 s here against the old pattern, and one interior run of 8 KB of spaces took 161 s.
  const long = "a -> ".repeat((156 * 1024) / 5);
  const started = Date.now();
  const slow = parseSpec(`${ENTRY}- long: A sentence.\n  refuted: ${long}\n  because: reasons\n  kinds: none\n`, "X.spec.md", { seed });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `a ${long.length} character refuted value took ${elapsed} ms to refuse`);
  assert.ok(slow.problems.some((p) => p.message.includes("refuted on long reads")));
  const spaced = "broke it ->" + " ".repeat(8 * 1024) + "x";
  const spacedStarted = Date.now();
  parseSpec(`${ENTRY}- spaced: A sentence.\n  refuted: ${spaced}\n  because: reasons\n  kinds: none\n`, "X.spec.md", { seed });
  assert.ok(Date.now() - spacedStarted < 1000, "an interior run of spaces is linear too");

  // Reviewer B: the date was three digit groups, so a day the calendar does not have parsed.
  const noSuchDay = parseSpec(`${ENTRY}- bad date: A sentence.\n  refuted: broke it -> it went red (2026-13-45)\n  because: reasons\n  kinds: none\n`, "X.spec.md", { seed });
  assert.deepEqual(noSuchDay.invariants[0]?.refutations, []);
  assert.ok(
    noSuchDay.problems.some((p) => p.message === "refuted on bad date ends with (2026-13-45), which is not a day that exists"),
    JSON.stringify(noSuchDay.problems),
  );
  assert.equal(isCalendarDate("2026", "02", "29"), false, "2026 is not a leap year");
  assert.equal(isCalendarDate("2024", "02", "29"), true);

  const good = parseSpec(`${ENTRY}- fine: A sentence.\n  refuted: broke it -> it went red (2026-09-18)\n  because: reasons\n  kinds: none\n`, "X.spec.md", { seed });
  assert.deepEqual(good.problems, []);
  assert.deepEqual({ broke: good.invariants[0]?.refutations[0]?.broke, date: good.invariants[0]?.refutations[0]?.date }, { broke: "broke it", date: "2026-09-18" });
});

test("the model: an entrance's handler may be a module file whose top-level script receives the work, and it must exist", () => {
  const door = trustedDoor({});
  const withJob = (handler: string): Record<string, string> => ({
    ...door,
    "Widgetry.spec.md": door["Widgetry.spec.md"]!.replace("\n## invariants\n", `- job: an operator runs the nightly job\n  handler: ${handler}\n\n## invariants\n`),
    "scripts/nightly.ts": "import { take } from \"../src/door/door.ts\";\ntake();\n",
  });
  withModel(withJob("scripts/nightly.ts"), (model) => {
    assert.deepEqual(model.problems, []);
    assert.deepEqual(model.components.find((c) => c.folder === ".")!.entrances.find((e) => e.name === "job")!.file, "scripts/nightly.ts", "resolved to the module itself");
  });
  withModel(withJob("scripts/missing.ts"), (model) => {
    assert.deepEqual(model.problems.map((p) => p.message), ["entrance job: handler module scripts/missing.ts does not exist (read under . and under the root)"]);
  });
  withModel(withJob("scripts/notes.md"), (model) => {
    assert.deepEqual(model.problems.map((p) => p.message), ["entrance job: handler scripts/notes.md names a file that is not source code"]);
  });
});

/** A Next.js App Router project shaped like ai-chatbot: a component in a (group) folder, its NextAuth route re-exporting handlers a multi-line destructuring declares. */
function nextApp(entrances: string, files: Record<string, string> = {}): Record<string, string> {
  return {
    "Chatbot.spec.md": "# Chatbot\n\nA chat app.\n\n## trust levels\n- public (outside): anyone on the network\n\n## invariants\n",
    "app/(auth)/(auth).spec.md": `# Auth\n\nSigning in.\n\n## entrances\n${entrances}\n## invariants\n`,
    "app/(auth)/api/auth/[...nextauth]/route.ts": 'export { GET, POST } from "@/app/(auth)/auth";\n',
    "app/(auth)/auth.ts": 'import NextAuth from "next-auth";\n\nexport const {\n  handlers: { GET, POST },\n  auth,\n  signIn,\n  signOut,\n} = NextAuth({\n  providers: [],\n});\n',
    ...files,
  };
}

test("the model: a module handler's path may carry route segments, [slug], [...slug], [[...slug]], (group), (.)intercepted and @slot, and it must still exist", () => {
  for (const path of ["api/auth/[...nextauth]/route.ts", "app/(chat)/chat/[id]/page.tsx", "app/[[...rest]]/page.tsx", "app/@modal/(.)photo/[id]/page.tsx", "app/(auth)/(auth).spec.ts"]) assert.equal(isModuleHandler(path), true, path);
  for (const value of ["GET in api/auth/[...nextauth]/route.ts", "views.detail(x)", "api/auth/[...nextauth]/route"]) assert.equal(isModuleHandler(value), false, value);
  const entrances = "- NextAuth handlers: the sign-in callbacks\n  handler: api/auth/[...nextauth]/route.ts\n- chat page: a visitor opens a chat\n  handler: app/(chat)/chat/[id]/page.tsx\n";
  withModel(nextApp(entrances, { "app/(chat)/chat/[id]/page.tsx": "export default function Page() { return null; }\n" }), (model) => {
    assert.deepEqual(model.problems, []);
    const auth = model.components.find((c) => c.folder === "app/(auth)")!;
    assert.equal(auth.specPath, "app/(auth)/(auth).spec.md", "a spec in a (group) folder is a component");
    assert.deepEqual(auth.entrances.map((e) => [e.name, e.file]), [["NextAuth handlers", "app/(auth)/api/auth/[...nextauth]/route.ts"], ["chat page", "app/(chat)/chat/[id]/page.tsx"]]);
  });
  withModel(nextApp(entrances), (model) => {
    assert.deepEqual(model.problems.map((p) => p.message), ["entrance chat page: handler module app/(chat)/chat/[id]/page.tsx does not exist (read under app/(auth) and under the root)"]);
  });
});

test("the model: a handler an export list re-exports, or a destructuring across lines declares, is declared at the top level of its file", () => {
  const entrances = "- NextAuth GET: the sign-in callbacks\n  handler: GET in api/auth/[...nextauth]/route.ts\n- NextAuth POST: the sign-in form posts\n  handler: POST in api/auth/[...nextauth]/route.ts\n- sign out: a visitor signs out\n  handler: signOut in auth.ts\n";
  withModel(nextApp(entrances), (model) => {
    assert.deepEqual(model.problems, []);
    assert.deepEqual(model.components.find((c) => c.folder === "app/(auth)")!.entrances.map((e) => e.file), ["app/(auth)/api/auth/[...nextauth]/route.ts", "app/(auth)/api/auth/[...nextauth]/route.ts", "app/(auth)/auth.ts"]);
  });
  withModel(nextApp("- NextAuth handlers object: never bound\n  handler: handlers in auth.ts\n"), (model) => {
    assert.deepEqual(model.problems.map((p) => p.message), ["entrance NextAuth handlers object: handler handlers is not declared at the top level of auth.ts (read under app/(auth) and under the root)"], "a key the destructuring reads through binds nothing");
  });
  const listed = "const handle = () => null;\nexport { handle as GET, type Shape, other };\n";
  assert.deepEqual(["GET", "Shape", "other", "handle"].map((n) => declaresAtTop(listed, n)), [true, true, true, true], "an export list exports a name, under its alias when it has one; handle is declared by its const");
  assert.equal(declaresAtTop('export { handle as GET } from "./h";\n', "handle"), false, "a name a re-export renames is not exported under its own name");
  assert.equal(declaresAtTop('import { GET } from "./auth";\n', "GET"), false, "an import declares nothing");
  assert.equal(declaresAtTop("export const {\n  a,\n  b: { c },\n}: Things = make();\n", "c"), true, "a typed destructuring across lines");
  assert.equal(declaresAtTop("const {\n  a,\n  b,\n};\n", "a"), false, "braces that assign nothing are no destructuring");
});

test("the model: an entrance's guard: line names a chokepoint an invariant declares, or a symbol of a chokepoint module", () => {
  const door = trustedDoor({});
  const guarded = (guard: string, chokepoint = "take"): Record<string, string> => ({
    ...door,
    "Widgetry.spec.md": door["Widgetry.spec.md"]!.replace("  handler: peek in src/door/door.ts\n", `  handler: peek in src/door/door.ts\n  guard: ${guard}\n`),
    "src/door/Door.spec.md": door["src/door/Door.spec.md"]!.replace("chokepoint: take", `chokepoint: ${chokepoint}`),
  });
  withModel(guarded("take"), (model) => {
    assert.deepEqual(model.problems, []);
    assert.equal(model.components.find((c) => c.folder === ".")!.entrances.find((e) => e.name === "peek")!.guard, "take");
  });
  withModel(guarded("peek", "src/door/door.ts"), (model) => assert.deepEqual(model.problems, [], "a symbol declared in a chokepoint module"));
  withModel({ ...guarded("mutate", "src/door/door.ts"), "src/door/door.ts": "export function take(): void {}\nexport function peek(): void {}\nexport const { read, mutate } = makeRpc();\n" }, (model) => assert.deepEqual(model.problems, [], "a factory's destructured product in a chokepoint module"));
  withModel(guarded("nobody"), (model) => {
    assert.deepEqual(model.problems.map((p) => `${p.file}:${p.line} ${p.message}`), ["Widgetry.spec.md:15 entrance peek: guard nobody is no chokepoint an invariant declares, nor a symbol of a chokepoint module; declared chokepoints: take"]);
  });
  const twice = parseSpec("# A\n\nAn a.\n\n## entrances\n- in: work enters\n  handler: x\n  guard:\n  guard: y\n", "A.spec.md");
  assert.ok(twice.problems.some((p) => p.line === 8 && p.message === "guard: on entrance in names no chokepoint"));
  assert.ok(twice.problems.some((p) => p.line === 9 && p.message === "entrance in names its guard twice"));
});

test("the grammar: an entrance's control: none carries a non-empty reason and never stands beside a guard:", () => {
  const entrance = (lines: string): ReturnType<typeof parseSpec> => parseSpec(`# A\n\nAn a.\n\n## entrances\n- in: work enters\n  handler: x\n${lines}`, "A.spec.md");
  const waived = entrance("  control: none — static files, the same bytes for every caller\n");
  assert.deepEqual(waived.problems, []);
  assert.equal(waived.entrances[0]!.noControl, "static files, the same bytes for every caller");
  assert.equal(waived.entrances[0]!.controlLine, 8);
  assert.equal(entrance("  control: none - a health check\n").entrances[0]!.noControl, "a health check", "a plain hyphen separates the reason too");
  const unfilled = entrance("  control: none — <why this entrance needs no control>\n");
  assert.deepEqual([unfilled.problems, unfilled.entrances[0]!.noControl], [[], undefined], "a scaffolded placeholder parses and claims nothing, as an unfilled slot does");
  for (const bare of ["  control: none\n", "  control: none —\n"]) {
    const parsed = entrance(bare);
    assert.equal(parsed.entrances[0]!.noControl, undefined, `${bare.trim()}: no reason, no claim`);
    assert.deepEqual(parsed.problems.map((p) => `${p.line} ${p.message}`), ["8 control: none on entrance in needs a reason: control: none — <why this entrance needs no control>"], bare.trim());
  }
  assert.match(entrance("  control: auth\n").problems[0]!.message, /control: on entrance in takes only none and a reason/, "any other value is refused: a control is traced, never declared");
  const both = entrance("  guard: door\n  control: none — public\n");
  assert.deepEqual(both.problems.map((p) => `${p.line} ${p.message}`), ["9 entrance in names a guard: and control: none; a guard is a control, so keep one of them"]);
  assert.ok(entrance("  control: none — a\n  control: none — b\n").problems.some((p) => p.line === 9 && p.message === "entrance in names its control twice"));
});

/** A component declaring hand lists as mirrors: a closure, another literal, and an object's keys, each file named from the component or from the root. */
function mirrored(mirrors: string, files: Record<string, string> = {}): Record<string, string> {
  return {
    "Widgetry.spec.md": "# Widgetry\n\nA store of widgets.\n\n## invariants\n",
    "src/page/Page.spec.md": `# Page\n\nThe page.\n\n## mirrors\n${mirrors}\n## invariants\n`,
    "src/page/build.ts": 'export const SOURCES = ["page.ts", "view.ts"];\nexport const EVENTS = ["start", "stop"] as const;\nconst PLURALS = new Set(["route"]);\n',
    "src/page/page.ts": 'import { view } from "./view.ts";\nexport const page = view;\n',
    "src/page/view.ts": "export const view = 1;\n",
    "src/hooks/events.ts": 'export const HOOK_EVENTS = ["start", "stop"];\nexport const RULES = { route: "routes" };\n',
    ...files,
  };
}

test("the model: a mirror names a list and what it mirrors that are both declared, and one whose name or file is gone is a problem", () => {
  const valid = [
    "- SOURCES in build.ts: the modules the bundle joins\n  mirrors: closure of page.ts, src/page/view.ts\n",
    "- EVENTS in src/page/build.ts: the events a summary names\n  mirrors: HOOK_EVENTS in src/hooks/events.ts\n",
    "- PLURALS in build.ts: the rules a plural is kept for\n  mirrors: keys of RULES in src/hooks/events.ts\n",
  ];
  // What adopters write correctly: a file from the component or from the root, a closure of one file or several, a list not exported, keys of an object.
  withModel(mirrored(valid.join("")), (model) => {
    assert.deepEqual(model.problems, []);
    const mirrors = model.components.find((c) => c.folder === "src/page")!.mirrors;
    assert.deepEqual(mirrors.map((m) => [m.name, m.listFile, m.recipe?.kind, m.sources]), [
      ["SOURCES", "src/page/build.ts", "closure", ["src/page/page.ts", "src/page/view.ts"]],
      ["EVENTS", "src/page/build.ts", "literal", ["src/hooks/events.ts"]],
      ["PLURALS", "src/page/build.ts", "keys", ["src/hooks/events.ts"]],
    ]);
  });
  withModel(mirrored(""), (model) => assert.deepEqual(model.problems, [], "an empty mirrors section is no problem"));
  const problems = (mirrors: string): string[] => {
    let found: string[] = [];
    withModel(mirrored(mirrors), (model) => (found = model.problems.map((p) => `${p.line} ${p.message}`)));
    return found;
  };
  assert.deepEqual(problems("- GONE in build.ts: a list since derived\n  mirrors: closure of page.ts\n"), ["6 mirror GONE: GONE is not declared at the top level of src/page/build.ts; derive what was hand-kept, or remove the mirror"]);
  assert.deepEqual(problems("- SOURCES in moved.ts: the modules\n  mirrors: closure of page.ts\n"), ["6 mirror SOURCES: moved.ts does not exist (read under src/page and under the root)"]);
  assert.deepEqual(problems("- EVENTS in build.ts: the events\n  mirrors: HOOK_EVENTS in src/hooks/gone.ts\n"), ["7 mirror EVENTS: src/hooks/gone.ts does not exist (read under src/page and under the root)"]);
  assert.deepEqual(problems("- EVENTS in build.ts: the events\n  mirrors: closure of page.ts, old.ts\n"), ["7 mirror EVENTS: closure of old.ts, which does not exist (read under src/page and under the root)"]);
  assert.deepEqual(problems("- EVENTS in build.ts: the events\n"), ["6 mirror EVENTS names nothing it mirrors: add mirrors: closure of <file>, keys of <NAME> in <file>, or <NAME> in <file>"]);
  assert.deepEqual(problems("- EVENTS in build.ts: the events\n  mirrors: whatever events.ts says\n"), ["7 mirrors: on EVENTS reads closure of <file>, <file>, keys of <NAME> in <file>, or <NAME> in <file>"]);
  assert.deepEqual(problems("- EVENTS in build.ts: the events\n  mirrors: HOOK_EVENTS in src/hooks/events.ts\n  because: why\n"), ['8 unknown key "because": a mirror carries mirrors']);
  assert.deepEqual(problems("- EVENTS: the events\n  mirrors: HOOK_EVENTS in src/hooks/events.ts\n"), ["6 a mirror is one bullet: - <NAME> in <file>: <meaning>, with an indented mirrors: closure of <file>, <file> | keys of <NAME> in <file> | <NAME> in <file> line"]);
});
