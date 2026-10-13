/**
 * The vocabulary signal: which names coverage offers as candidates, which
 * uses it asks a sense review of, and what the hook says about either. Each
 * test below is the totality oracle of one Lifecycle invariant.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attention, attentionText, lexiconCoverage, type Coverage } from "./lexicon-coverage.ts";
import { runHook } from "./hook.ts";
import { stopWarmServers } from "../enforcement/server-fixture.ts";
import { lexiconWorkCommand } from "./lexicon-cli.ts";
import { FUNCTION_WORDS, STOPLIST } from "./stoplist.ts";
import { reviewLexicon } from "./lexicon-maintain.ts";

const COMPONENTS = ["books", "sales", "stock", "staff"];

/** A project whose lexicon knows "exposure" (with a rejected name) and "unit basis" as a property of two concepts. */
function project(config: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "coherence-vocabulary-"));
  writeFileSync(
    join(root, "lexicon.json"),
    JSON.stringify({
      version: 1,
      project: "ledgerly",
      concepts: [
        {
          name: "exposure",
          definition: "Money at risk, in USD.",
          aliases: [],
          rejected: [{ alternative: "hazard", because: "a hazard is a cause, not money at risk" }],
          properties: { unit_basis: "USD" },
          not_to_be_confused_with: ["Quuxdb: the store the exposure is kept in, not the exposure"],
        },
        { name: "allocation", definition: "A distributed share.", aliases: [], properties: { unit_basis: "percent" } },
        { name: "agent host", definition: "The application running a session.", aliases: [], instances: ["Claude Code"] },
      ],
    }),
  );
  writeFileSync(join(root, "coherence.config.json"), JSON.stringify({ name: "Ledgerly", ...config }));
  writeFileSync(join(root, "Ledgerly.spec.md"), "# Ledgerly\n\n## invariants\n");
  for (const c of COMPONENTS) {
    mkdirSync(join(root, c));
    writeFileSync(join(root, c, `${c[0]!.toUpperCase()}${c.slice(1)}.spec.md`), `# ${c}\n\n## invariants\n`);
  }
  return root;
}

function terms(report: Coverage): string[] {
  return report.terms.map((t) => t.term);
}

function candidates(report: Coverage): string[] {
  return attention(report).undefinedTerms.map((t) => t.term);
}

test("a code identifier is never a candidate unless it is declared and prose recurs it; ids, paths and fragments never are", async () => {
  const root = project();
  try {
    // Code: one declared name, locals, a split identifier, strings and a regular expression.
    writeFileSync(
      join(root, "books/roster.ts"),
      [
        "export interface Roster {",
        "  owner: string;",
        "}",
        "export function rosterBalanceSync(): number {",
        "  const tallyMarks = readFileSync('a.txt');",
        "  const deepEqual = /[a-z]+/.test('tally marks');",
        "  return tallyMarks.length;",
        "}",
        "",
      ].join("\n"),
    );
    // A type body in code no adapter language claims is not read as TypeScript's: its field is no declared name.
    writeFileSync(join(root, "books/legacy.go"), ["export interface Legacy {", "  auditor: string;", "}", ""].join("\n"));
    // Prose writes "roster", "owner" and "tally marks" as words on many lines in every component; only declared names may surface.
    for (const c of COMPONENTS)
      writeFileSync(
        join(root, c, "notes.md"),
        [
          "The roster keeps every line the owner signed.",
          "A roster is closed monthly; tally marks count the rows.",
          "Nobody edits a roster once the owner closes it; tally marks stay.",
          "The owner reconciles it weekly, and tally marks are erased.",
          "Work order w-947cd2be and decision d-4a122d41 touched `.venv/bin/python` and `[a-z]` in src/books/roster.ts.",
          "Session 0e4a21bf-165b-4cef-8131-e66f7d90d073 read `a-z` and `readFileSync` again.",
          "The auditor reads the roster.",
          "An auditor signs each closed roster.",
          "No auditor edits the roster.",
          "",
        ].join("\n"),
      );
    const report = await lexiconCoverage(root);
    const found = candidates(report);
    assert.ok(found.includes("roster"), `a declared name recurring in prose is a candidate: ${found.join(", ")}`);
    assert.ok(found.includes("owner"), `a declared field recurring in prose is a candidate: ${found.join(", ")}`);
    assert.ok(!found.includes("auditor"), `a field in a file no adapter language claims is never read as declared: ${found.join(", ")}`);
    for (const never of ["tally marks", "tally", "marks", "read file sync", "deep equal", "roster balance sync", "balance", "sync", "a z", "venv", "bin python", "readfilesync"])
      assert.ok(!terms(report).includes(never), `"${never}" is a local, a split identifier, or a fragment, never a term`);
    for (const t of terms(report)) {
      assert.doesNotMatch(t, /\d/, `an id or hash is never a term: ${t}`);
      assert.match(t, /^[a-z]+(?: [a-z]+)*$/, `a punctuation-bearing token is never a term: ${t}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("well-known names, the project's own name and the lexicon's not: names are never candidates, while a common word written as a project's proper noun still is", async () => {
  const root = project({ wellKnown: ["Zanzibar"] });
  try {
    for (const c of COMPONENTS)
      writeFileSync(
        join(root, c, "notes.md"),
        [
          "We check it with Python and Pyright, then open Chrome on macOS.",
          "It deploys through Kubernetes to Postgres, typed in TypeScript.",
          "Each report lands in the Hive before it reaches Ledgerly and Zanzibar.",
          "The copy in Quuxdb waits while Claude Code and GitHub finish; the Hive keeps it.",
          "Around every window the `chrome` is drawn; the `chrome` never scrolls.",
          "",
        ].join("\n"),
      );
    const found = candidates(await lexiconCoverage(root));
    for (const never of ["python", "pyright", "chrome on", "macos", "github", "kubernetes", "postgres", "type script", "ledgerly", "zanzibar", "quuxdb", "claude code", "claude"])
      assert.ok(!found.includes(never), `"${never}" needs no definition, yet it was offered: ${found.join(", ")}`);
    assert.ok(found.includes("hive"), `a common word written as the project's proper noun still surfaces: ${found.join(", ")}`);
    assert.ok(found.includes("chrome"), `a well-known name skipped only when capitalized leaves the lowercase project sense a candidate: ${found.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** One journal record in the adopter's own journal, as a decision written to Coherence. */
function record(root: string, id: string, chose: string): void {
  mkdirSync(join(root, ".coherence/journal"), { recursive: true });
  appendFileSync(
    join(root, ".coherence/journal/payroll.jsonl"),
    JSON.stringify({ id, kind: "decision", at: "2026-10-08T00:00:00.000Z", session: "payroll", agent: "main", chose, over: ["a week"], because: "payroll closes daily" }) + "\n",
  );
}

test("sense review is asked only where meaning is at risk: more than one recorded sense, a rejected name beside the use, or a Coherence concept an adopter's code declares written where Coherence's grammar speaks", async () => {
  const root = project();
  try {
    writeFileSync(join(root, "books/notes.md"), "The exposure is counted in USD.\nNothing else here.\n\n\nThe exposure is settled nightly.\n");
    writeFileSync(join(root, "sales/notes.md"), "The exposure is counted in USD.\nIt is not the hazard.\n");
    writeFileSync(join(root, "stock/notes.md"), "Each row states its unit basis.\n");
    writeFileSync(join(root, "staff/model.ts"), "export function scope(): string {\n  return 'staff';\n}\n");
    writeFileSync(join(root, "staff/notes.md"), "The scope of a shift is one day.\n");
    record(root, "d-1", "narrow the scope to one shift");
    const report = await lexiconCoverage(root);
    const risk = (term: string, component: string): string | undefined =>
      report.terms.find((t) => t.term === term)?.contexts.find((c) => c.component === component)?.risk;
    assert.equal(risk("exposure", "books"), undefined, "an ordinary use of a defined word asks no review");
    assert.match(risk("exposure", "sales") ?? "", /hazard/, "a name rejected for the concept beside its use puts the sense at risk");
    assert.match(risk("unit basis", "stock") ?? "", /more than one recorded sense/, "a name with two recorded senses is at risk");
    assert.equal(risk("scope", "staff"), undefined, "a Coherence concept the adopter's code declares is the project's sense in its code and its domain prose");
    assert.match(risk("scope", ".") ?? "", /declared in this project's code \(staff\/model\.ts:1\).*text Coherence reads as its own \(\.coherence\/journal\/payroll\.jsonl:1\)/, "the same name in a record, text written to Coherence, is where the two senses meet");
    const at = attention(report).senses.map((s) => `${s.term}@${s.component}`).sort();
    assert.deepEqual(at, ["exposure@sales", "scope@.", "unit basis@stock"]);
    assert.equal(report.totals.unreviewedContexts, 3, "only at-risk contexts await review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Coherence name an adopter's code declares is the project's own sense: its code, its domain prose and its specs' sentences ask nothing, its specs' grammar does", async () => {
  const root = project();
  try {
    writeFileSync(
      join(root, "books/model.ts"),
      "export class Config {}\nexport function run(): void {}\nexport type Spec = string;\nexport interface Scope { book: string }\nexport interface Structure { depth: number }\n",
    );
    writeFileSync(join(root, "books/settings.py"), "class Config:\n    pass\n");
    writeFileSync(join(root, "books/notes.md"), "Each config is loaded once.\nThe run starts at dawn.\nA spec names its book.\nThe scope is one book.\nThe structure is a tree.\n");
    writeFileSync(
      join(root, "books/Books.spec.md"),
      "# books\n\n## invariants\n- books balance: Each run of the books balances within one scope, under one config and spec.\n  because: the structure of a book is its run\n\n## structure\n",
    );
    const report = await lexiconCoverage(root);
    const risk = (term: string): string | undefined =>
      report.terms.find((t) => t.term === term)?.contexts.find((c) => c.component === "books")?.risk;
    for (const name of ["config", "run", "spec", "scope"]) {
      assert.ok(report.terms.find((t) => t.term === name)?.contexts.some((c) => c.component === "books"), `${name} is observed in books`);
      assert.equal(risk(name), undefined, `${name}, declared in the adopter's code, written in its code, prose and spec sentences, is the project's sense`);
    }
    assert.match(risk("structure") ?? "", /Books\.spec\.md:7/, "a declared name in a spec's grammar (its ## structure heading) is where Coherence's sense speaks too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ruling on a Coherence name an adopter's code declares holds for its component: a new use of the same name does not reopen it, and settling it still needs a person", async () => {
  const root = project();
  try {
    writeFileSync(join(root, "staff/model.ts"), "export function scope(): string {\n  return 'staff';\n}\n");
    record(root, "d-1", "narrow the scope to one shift");
    const context = async () => (await lexiconCoverage(root)).terms.find((t) => t.term === "scope")!.contexts.find((c) => c.component === ".")!;
    const first = await context();
    assert.ok(first.risk !== undefined, "the record puts the declared name's sense at risk");
    const who = { session: "ruling-test", agent: "test" };
    await assert.rejects(reviewLexicon(root, "scope", ".", first.fingerprint, "not-domain", who, "the payroll scope", ["Coherence's scope"]), /human/);
    await reviewLexicon(root, "scope", ".", first.fingerprint, "not-domain", who, "the payroll scope is a shift's span", ["Coherence's scope"], "owner: a shift's span");
    record(root, "d-2", "widen the scope to a fortnight");
    const later = await context();
    assert.equal(later.fingerprint, first.fingerprint, "the evidence is the term and component, not the uses");
    assert.equal(later.disposition, "not-domain", "a new use of the same name keeps the ruling");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Whether a text carries a count of the population rather than names. */
function carriesTotal(text: string): boolean {
  return /\b\d+ (?:unresolved|unsettled|new\/changed|observed|contexts?|candidate)/i.test(text) || /Lexicon coverage:/.test(text);
}

function injected(stdout: string): string {
  if (stdout === "") return "";
  const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string }; systemMessage?: string };
  return parsed.hookSpecificOutput?.additionalContext ?? parsed.systemMessage ?? "";
}

test("no hook injection carries a total: orient names the ranked terms or says nothing", async () => {
  const root = project();
  try {
    const input = { session_id: "orient-test", cwd: root };
    const quiet = await runHook("SessionStart", input, root);
    assert.ok(!carriesTotal(injected(quiet.stdout)), injected(quiet.stdout));
    assert.doesNotMatch(injected(quiet.stdout), /lack(?:s)? a definition|Sense at risk/, "nothing owed, nothing said");
    for (const c of COMPONENTS) writeFileSync(join(root, c, "notes.md"), "The `premium` is new.\nEvery `premium` is billed.\nA `premium` is refunded.\n");
    const start = await runHook("SessionStart", input, root);
    const context = injected(start.stdout);
    assert.match(context, /A recurring term lacks a definition: premium\./);
    assert.ok(!carriesTotal(context), context);
    start.commit?.();
    writeFileSync(join(root, "books/charges.md"), "The `surcharge` is new.\nEach `surcharge` is billed.\nA `surcharge` is refunded.\n");
    const edit = await runHook("PostToolUse", { ...input, tool_name: "Write", tool_input: { file_path: join(root, "books/charges.md") } }, root);
    assert.ok(!carriesTotal(injected(edit.stdout)), injected(edit.stdout));
    const stop = await runHook("Stop", input, root);
    assert.ok(!carriesTotal(injected(stop.stdout)), injected(stop.stdout));
    assert.match(injected(stop.stdout), /this session left "surcharge" recurring without a definition/);
    assert.ok(!carriesTotal(attentionText(await lexiconCoverage(root))), "the shared signal never counts");
  } finally {
    // The stop reaches the instrument through a warm server, which outlives the test unless it is stopped.
    await stopWarmServers(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an edit is silent on the terms it makes recur: regulate names the session's together at the stop, once, with the declare-or-alias command", async () => {
  const root = project();
  try {
    writeFileSync(join(root, "books/notes.md"), "The exposure is counted in USD.\n");
    const input = { session_id: "edit-test", cwd: root };
    const start = await runHook("SessionStart", input, root);
    start.commit?.();
    const tool = { ...input, tool_name: "Write", tool_input: { file_path: join(root, "books/notes.md") } };
    // An ordinary edit: a new line that uses a defined word, and a new line of plain prose.
    appendFileSync(join(root, "books/notes.md"), "The exposure is settled nightly.\nRows are appended at the end of the day.\n");
    const ordinary = await runHook("PostToolUse", tool, root);
    assert.doesNotMatch(injected(ordinary.stdout), /Lexicon/, "an ordinary edit says nothing about vocabulary");
    ordinary.commit?.();
    // Two edits that each make a new name recur: neither says a word of it.
    appendFileSync(join(root, "books/notes.md"), "The `rebate` is new.\nEach `rebate` is paid.\nA `rebate` is clawed back.\n");
    const first = await runHook("PostToolUse", tool, root);
    assert.doesNotMatch(injected(first.stdout), /Lexicon/, "the edit that made rebate recur is silent");
    first.commit?.();
    appendFileSync(join(root, "books/notes.md"), "The `levy` is new.\nEach `levy` is paid.\nA `levy` is waived.\n");
    const second = await runHook("PostToolUse", tool, root);
    assert.doesNotMatch(injected(second.stdout), /Lexicon/, "the edit that made levy recur is silent");
    second.commit?.();
    // The stop names both in one line, with what settles them.
    const stop = await runHook("Stop", input, root);
    const said = injected(stop.stdout);
    const line = said.split("\n").filter((l) => /recurring without a definition/.test(l));
    assert.equal(line.length, 1, `one line names them: ${said}`);
    assert.match(line[0]!, /"rebate"/);
    assert.match(line[0]!, /"levy"/);
    assert.match(line[0]!, /lexicon propose declare <term> --definition "<text>" --because "<why>"\) or map it as an alias of an existing concept/);
    stop.commit?.();
    // The next prompt carries what the stop said, and names neither term again on its own.
    const prompt = await runHook("UserPromptSubmit", { ...input, prompt: "next" }, root);
    assert.match(injected(prompt.stdout), /At your last stop[\s\S]*this session left/, "the stop's line reaches the agent at the prompt");
    assert.doesNotMatch(injected(prompt.stdout), /no stop has named/, "what the stop named is not named again");
  } finally {
    await stopWarmServers(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a term an edit held reaches the next prompt when no stop named it, once", async () => {
  const root = project();
  try {
    writeFileSync(join(root, "books/notes.md"), "The exposure is counted in USD.\n");
    const input = { session_id: "held-test", cwd: root };
    const start = await runHook("SessionStart", input, root);
    start.commit?.();
    const tool = { ...input, tool_name: "Write", tool_input: { file_path: join(root, "books/notes.md") } };
    appendFileSync(join(root, "books/notes.md"), "The `rebate` is new.\nEach `rebate` is paid.\nA `rebate` is clawed back.\n");
    const edit = await runHook("PostToolUse", tool, root);
    assert.doesNotMatch(injected(edit.stdout), /Lexicon/, "the edit is silent");
    edit.commit?.();
    // The session never stopped cleanly: the host was interrupted, and the next thing it runs is a prompt.
    const prompt = await runHook("UserPromptSubmit", { ...input, prompt: "after an interrupt" }, root);
    assert.match(injected(prompt.stdout), /no stop has named "rebate", which this session made recur without a definition; declare each .* or map it as an alias of an existing concept/);
    prompt.commit?.();
    const again = await runHook("UserPromptSubmit", { ...input, prompt: "and again" }, root);
    assert.doesNotMatch(injected(again.stdout), /no stop has named/, "named once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The closed classes' core, written here independently of the stoplist, so a word dropped from it is caught. */
const CLOSED_CLASS_CORE = `
about above across after against along among around as at before behind below beneath beside between beyond by
despite down during except for from in inside into like near of off on onto out outside over past per since
through throughout till to toward towards under underneath unlike until up upon via with within without
and but or nor so yet although because if unless whereas whether while though once than
a an the this that these those my your his her its our their each every either neither some any no all both
i me you he him she it we us they them myself yourself itself ourselves themselves who whom whose which what
anyone everyone someone nobody nothing everything something
am is are was were be been being have has had do does did can could may might must shall should will would ought
`.split(/\s+/).filter((w) => w !== "");

test("function words are never candidates: every preposition, conjunction, determiner, pronoun and auxiliary is refused however prose writes it", async () => {
  const closed = [...new Set(Object.values(FUNCTION_WORDS).flat())].sort();
  for (const w of CLOSED_CLASS_CORE) assert.ok(closed.includes(w), `the closed-class list lacks "${w}"`);
  for (const w of closed) assert.ok(STOPLIST.has(w), `"${w}" is a function word the stoplist does not hold`);
  const root = project();
  try {
    // Every function word written as a name three ways, on a line in every component: backticked, Title Case mid-sentence, and as a heading word.
    const cap = (w: string): string => w[0]!.toUpperCase() + w.slice(1);
    for (const c of COMPONENTS)
      writeFileSync(
        join(root, c, "notes.md"),
        [
          ...closed.flatMap((w) => [`## ${cap(w)}`, `We wrote \`${w}\` there, and then ${cap(w)} again.`, `Later \`${w}\` came back.`]),
          "The `premium` is new.",
          "Every `premium` is billed.",
          "",
        ].join("\n"),
      );
    const found = candidates(await lexiconCoverage(root));
    const offered = found.filter((t) => t.split(" ").every((w) => closed.includes(w)));
    assert.deepEqual(offered, [], `function words were offered as candidates: ${offered.join(", ")}`);
    assert.ok(found.includes("premium"), `a name written the same way still surfaces: ${found.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Coherence's machine-written output never moves the reading: a new run record or a warm server's file leaves the fingerprint unchanged", async () => {
  const root = project();
  try {
    writeFileSync(join(root, "books/notes.md"), "The `premium` is new.\nEvery `premium` is billed.\n");
    mkdirSync(join(root, ".coherence", "runs"), { recursive: true });
    const before = await lexiconCoverage(root);
    writeFileSync(join(root, ".coherence", "runs", "s.jsonl"), JSON.stringify({ at: "2026-09-23T00:00:00.000Z", invariants: [] }) + "\n");
    mkdirSync(join(root, ".coherence", "run"), { recursive: true });
    writeFileSync(join(root, ".coherence", "run", "server.json"), JSON.stringify({ pid: 1 }) + "\n");
    const after = await lexiconCoverage(root);
    assert.equal(after.fingerprint, before.fingerprint, "a run or a server file changed the reading's fingerprint");
    assert.ok(!after.population.excluded.some((e) => e.file.startsWith(".coherence/")), "machine-written output is not the project's and is not reported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage reads only inside the config's bounds: a folder the ignore list names is never entered, and the journal's records still are", async () => {
  // The adoption is bounded away from stock (by name), staff/archive (by path), and .coherence.
  const root = project({ ignore: ["stock", "staff/archive", ".coherence"] });
  try {
    for (const c of ["books", "sales"]) writeFileSync(join(root, c, "notes.md"), "The `premium` is new.\nEvery `premium` is billed.\n");
    // A large ignored folder: hundreds of files that would nominate their own term if read.
    mkdirSync(join(root, "stock", "vendor"), { recursive: true });
    for (let i = 0; i < 300; i++) writeFileSync(join(root, "stock", "vendor", `page${i}.md`), "The `Frobnicator` runs.\nEach `Frobnicator` stops.\nA `Frobnicator` waits.\n");
    mkdirSync(join(root, "staff", "archive"), { recursive: true });
    writeFileSync(join(root, "staff", "archive", "old.md"), "The `Gizmotron` runs.\nEach `Gizmotron` stops.\nA `Gizmotron` waits.\n");
    writeFileSync(join(root, "staff", "notes.md"), "Staff notes: the `premium` is paid.\n");
    mkdirSync(join(root, ".coherence", "journal"), { recursive: true });
    const record = { id: "d-00000001", kind: "decision", at: "2026-09-23T00:00:00.000Z", session: "s", agent: "a", chose: "bill the `premium` monthly", over: [], because: "the `premium` is monthly" };
    writeFileSync(join(root, ".coherence", "journal", "s.jsonl"), JSON.stringify(record) + "\n");
    const report = await lexiconCoverage(root);
    const read = report.population.files.map((f) => f.file);
    assert.ok(!read.some((f) => f.startsWith("stock/")), `an ignored folder was read: ${read.filter((f) => f.startsWith("stock/")).length} files`);
    assert.ok(!read.some((f) => f.startsWith("staff/archive/")), "a folder ignored by its path was read");
    assert.ok(read.includes("staff/notes.md"), "a sibling of an ignored path is still inside the bounds");
    assert.ok(read.includes(".coherence/journal/s.jsonl"), "the journal's records are read even when the config ignores .coherence");
    assert.ok(report.population.excluded.some((e) => e.file === "stock" && /bounds/.test(e.reason)), "the ignored folder is reported as outside the bounds, never entered");
    const found = terms(report);
    assert.ok(!found.includes("frobnicator") && !found.includes("gizmotron"), `a term only an ignored folder uses was observed: ${found.join(", ")}`);
    assert.ok(found.includes("premium"), `a term inside the bounds is still observed: ${found.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage and draft read only under the paths they are given: candidates come from those files alone, the ignore list still holds, and a path outside the root or one that does not exist is refused", async () => {
  const root = project({ ignore: ["books/vendor"] });
  const outside = mkdtempSync(join(tmpdir(), "coherence-vocabulary-outside-"));
  const out: string[] = [];
  const err: string[] = [];
  const io = { cwd: root, out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  try {
    writeFileSync(join(root, "books", "notes.md"), "The `Folio` is new.\nEvery `Folio` is billed.\nA `Folio` closes.\n");
    writeFileSync(join(root, "sales", "notes.md"), "The `Tender` is new.\nEvery `Tender` is billed.\nA `Tender` closes.\n");
    mkdirSync(join(root, "books", "vendor"));
    writeFileSync(join(root, "books", "vendor", "lib.md"), "The `Gizmotron` runs.\nEach `Gizmotron` stops.\nA `Gizmotron` waits.\n");
    // With no paths the whole project is read, as before.
    const whole = await lexiconCoverage(root);
    assert.equal(whole.population.paths, undefined, "a reading with no paths names none");
    assert.ok(candidates(whole).includes("folio") && candidates(whole).includes("tender"), `the whole project: ${candidates(whole).join(", ")}`);
    // A relative path and an absolute one inside the root read the same files.
    assert.equal(await lexiconWorkCommand(["coverage", "books", "--json"], io), 0, err.join("\n"));
    const narrowed = JSON.parse(out.join("\n")) as Coverage;
    assert.deepEqual(narrowed.population.paths, ["books"]);
    assert.ok(narrowed.population.files.every((f) => f.file.startsWith("books/")), `a file outside the path was read: ${narrowed.population.files.map((f) => f.file).join(", ")}`);
    assert.ok(candidates(narrowed).includes("folio"), `a term under the path is a candidate: ${candidates(narrowed).join(", ")}`);
    assert.ok(!terms(narrowed).includes("tender"), "a term only another folder writes is not observed");
    assert.ok(!terms(narrowed).includes("gizmotron"), "the ignore list still holds inside the given path");
    out.length = 0;
    assert.equal(await lexiconWorkCommand(["coverage", join(root, "books")], io), 0, err.join("\n"));
    assert.match(out.join("\n").split("\n")[0] ?? "", /^Read only under books: \d+ files?\.$/,"the text names the paths it read");
    out.length = 0;
    assert.equal(await lexiconWorkCommand(["draft", "sales"], io), 0, err.join("\n"));
    const draft = JSON.parse(out.join("\n")) as { read: { paths: string[] }; candidates: { name: string }[] };
    assert.deepEqual(draft.read.paths, ["sales"], "the draft names the paths it read");
    assert.deepEqual(draft.candidates.map((c) => c.name), ["tender"]);
    // Outside the root, or missing: refused, never read as nothing.
    for (const [given, reason] of [[outside, /outside the project root/], ["..", /outside the project root/], ["orders-missing", /does not exist/]] as const) {
      err.length = 0;
      assert.equal(await lexiconWorkCommand(["draft", given], io), 1, `${given} was not refused`);
      assert.match(err.join("\n"), reason);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
