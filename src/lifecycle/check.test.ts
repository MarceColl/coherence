import assert from "node:assert/strict";
import { sessionText } from "../journal/shard-fixture.ts";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { failingRejected, formatReport, hasFindings, identifierWords, normalizeTerm, runCheck, type CheckReport } from "./check.ts";
import { findingDigest, readBaseline, recordBaseline } from "./lexicon-baseline.ts";
import { loadLexicon, parseLexicon, rejectedNames, type Lexicon } from "./lexicon.ts";
import { COHERENCE_LEXICON, PACKAGE_NAME } from "./project.ts";

let root: string;
let coherence: Lexicon;
let project: Lexicon;
let report: CheckReport;
/** A single-word name Coherence rejects for "invariant", read from the lexicon so this file never spells it. */
let REJ: string;
let Rej: string;
/** Another single-word name Coherence rejects, used here as a project concept name the project's sense wins for. */
let ALT: string;

function projectLexiconWith(rej: string, alt: string): unknown {
  return {
    ...projectLexicon,
    concepts: [
      ...projectLexicon.concepts.map((c) => (c.name === "widget" ? { ...c, not_to_be_confused_with: [`sprocket ${rej}: a toothed wheel`] } : c)),
      { name: alt, definition: "The widget catalogue.", aliases: [] },
    ],
  };
}

const projectLexicon = {
  project: "widgetry",
  version: 0,
  concepts: [
    {
      name: "widget",
      definition: "A thing with a knob.",
      aliases: ["gadget (code term)"],
    },
  ],
  rejected: [
    { concept: "doohickey", because: "retired surface" },
    { concept: "convention / add_convention (change type)", because: "vestigial" },
  ],
};

async function write(rel: string, text: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), text);
}

// Node 22 runs the after hook without waiting for an async before when a name filter selects none of this file's tests, so the after waits for it.
let setup: Promise<void> | undefined;

before(() => (setup = (async () => {
  coherence = await loadLexicon(COHERENCE_LEXICON);
  coherence.project = "coherence";
  REJ = rejectedNames(coherence).find((n) => n.concept === "invariant" && !n.name.includes(" "))!.name;
  Rej = REJ[0]!.toUpperCase() + REJ.slice(1);
  ALT = rejectedNames(coherence).find((n) => !n.name.includes(" ") && !n.identifierOnly && n.concept !== "invariant")!.name;
  root = await mkdtemp(join(tmpdir(), "coherence-check-"));
  await write("lexicon.json", JSON.stringify(projectLexiconWith(REJ, ALT)));
  await write("docs/retired.md", `The ${REJ} and the doohickey both retired here, and this file is never read.\n`);
  await write(
    "notes.md",
    [
      `# Notes on the ${Rej}`,
      `The doohickey turns the widget; the old ${REJ} is gone. A sprocket ${REJ} is fine.`,
      "Every Durable Object holds one widget. The Durable Object is the unit.",
      `The ${ALT} lists widgets; a convention is only English here but \`add_convention\` is a name.`,
      "Cloudflare hosts it, and Cloudflare bills for it.",
      "```",
      "Title Case In Fences Is Ignored",
      "```",
      "The Flux Capacitor appears once only.",
      "It ships on **STL Quest** and on Kubernetes, `valkey` beside it.",
      "It reads STL Quest, runs on Kubernetes, and caches in `valkey`.",
      "It writes STL Quest, scales on Kubernetes, and flushes `valkey`.",
      "",
    ].join("\n"),
  );
  await write("flux/flux.spec.md", "The flux component. flux is named in prose here too, and the Durable Object once more.\n");
  await write(
    "src/a.ts",
    [
      'import { readFile } from "node:fs/promises";',
      "const doohickeyCount = 1; // a rejected project name inside an identifier",
      `const sprocket${Rej} = 2; // guarded by the project's not-to-be-confused-with lead`,
      `const ${REJ}Keeper = 3; // Coherence's name in an identifier: a finding in Coherence's own text, never in an adopter's`,
      "const p: Promise<void> = Promise.resolve();",
      "const conventions = 4; // identifier-only project name",
    ].join("\n") + "\n",
  );
  project = await loadLexicon(join(root, "lexicon.json"));
  // The fixture is read as Coherence's own repository, where both layers bind everywhere; the adopter's reading is tested below.
  report = await runCheck({ root, coherence, project, coherenceItself: true });
})()));

after(async () => {
  await setup?.catch(() => undefined);
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("the corpus excludes the lexicon files and docs/retired.md", () => {
  assert.equal(report.files, 3);
  assert.ok(!report.rejected.some((f) => f.file.includes("retired")));
});

test("rejected names are found as whole words in prose, with concept and because", () => {
  const prose = report.rejected.filter((f) => f.file === "notes.md");
  assert.deepEqual(
    prose.map((f) => [f.line, f.text, f.concept]),
    [
      [1, Rej, "invariant"],
      [2, "doohickey", "widgetry"],
      [2, REJ, "invariant"],
      [4, "add_convention", "widgetry"],
    ],
  );
  assert.equal(prose[1]!.because, "retired surface");
  assert.match(prose[0]!.because, /former name/);
});

test("a project's own sense wins: an accepted project name silences a Coherence rejection, and an accepted phrase guards the words inside it", () => {
  assert.ok(!report.rejected.some((f) => f.name === ALT), `${ALT} is the project's own concept`);
  assert.equal(report.rejected.filter((f) => f.file === "notes.md" && f.line === 2 && f.text === REJ).length, 1, "the guarded phrase is not a second hit");
});

test("in code, both layers' rejected names match identifier tokens where both bind, unless the project declares the name as its own; language globals and module specifiers never match", () => {
  const code = report.rejected.filter((f) => f.file === "src/a.ts");
  assert.deepEqual(
    code.map((f) => [f.line, f.text, f.name]),
    [
      [2, "doohickey", "doohickey"],
      [4, REJ, REJ],
      [6, "conventions", "convention"],
    ],
  );
  assert.equal(code[1]!.concept, "invariant", "Coherence's name, in an identifier of Coherence's own text");
  assert.ok(!report.rejected.some((f) => f.file === "src/a.ts" && f.line === 3), `sprocket${Rej} is guarded by the project's own phrase`);
});

test("the corpus reads every text kind the project holds, the journal's records included, and leaves out lockfiles, binaries, runs, and the reviews", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coherence-corpus-"));
  const put = async (rel: string, text: string | Buffer): Promise<void> => {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  };
  try {
    await put(".gitignore", `# keep the ${REJ}\n${REJ}/\n`);
    await put("config.yaml", `${REJ}: true\n`);
    await put("settings.toml", `[${REJ}]\nname = "x"\n`);
    await put("tool.py", `${REJ}_keeper = 1\n`);
    await put("web/app.tsx", `export const ${REJ}Box = 1;\n`);
    await put("scripts/run.mjs", `const ${REJ} = 1;\n`);
    await put("scripts/run.sh", `echo ${REJ}\n`);
    await put("data/rows.jsonl", JSON.stringify({ label: REJ }) + "\n");
    await put("data/shape.json", JSON.stringify({ [REJ]: 1 }) + "\n");
    await put(".coherence/journal/s1.jsonl", [
      JSON.stringify({ id: "d-1", kind: "decision", at: "2026-09-17T00:00:00.000Z", session: "s1", agent: "a", commit: null, dirty: false, chose: `the ${REJ}`, over: [`the ${ALT}`], because: "b" }),
      JSON.stringify({ id: "d-2", kind: "decision", at: "2026-09-17T00:00:01.000Z", session: "s1", agent: "a", commit: null, dirty: false, chose: "fine", over: [`a ${REJ} by another name`], because: "an alternative is what was refused, so its name is not drift" }),
    ].join("\n") + "\n");
    await put(".coherence/work/s1.jsonl", JSON.stringify({ id: "w-1", kind: "order", at: "2026-09-17T00:00:00.000Z", session: "s1", agent: "a", commit: null, dirty: false, objective: `ship the ${REJ}`, success: "s", boundary: "b", owner: "s1" }) + "\n");
    await put(".coherence/runs/s1.jsonl", JSON.stringify({ reason: `the ${REJ} passed` }) + "\n");
    await put("package-lock.json", JSON.stringify({ name: REJ }) + "\n");
    await put("bin.dat", Buffer.from([0x00, 0x01, 0x02, 0x67, 0x61, 0x74, 0x65]));
    await put("docs/reviews/2026-09-18-review.md", `The reviewer wrote ${REJ} on purpose.\n`);
    await put("docs/reference/old.md", `The ${REJ} was the old name.\n`);
    const out = await runCheck({ root: dir, coherence, coherenceItself: true });
    const hits = [...new Set(out.rejected.map((f) => f.file))].sort(); // which kinds were read, not how many times each one said it
    assert.deepEqual(hits, [
      ".coherence/journal/s1.jsonl",
      ".coherence/work/s1.jsonl",
      ".gitignore",
      "config.yaml",
      "data/rows.jsonl",
      "data/shape.json",
      "scripts/run.mjs",
      "scripts/run.sh",
      "settings.toml",
      "tool.py",
      "web/app.tsx",
    ]);
    assert.deepEqual(out.rejected.filter((f) => f.file === ".coherence/journal/s1.jsonl").map((f) => f.line), [1], "a decision's chose is checked; what it rejected (over) is not drift");
    assert.equal(out.files, 11, "every readable text file of a kind the project holds, minus the lockfile, the binary, the run, the review, and the reference doc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collectFiles confines every given path to the project root", async () => {
  await assert.rejects(runCheck({ root, coherence, project, paths: [".."] }), /outside the project root/);
  await assert.rejects(runCheck({ root, coherence, project, paths: [join(root, "..", "elsewhere")] }), /outside the project root/);
  await assert.rejects(runCheck({ root, coherence, project, paths: ["/etc"] }), /outside the project root/);
  const inside = await runCheck({ root, coherence, project, paths: [join(root, "src")], coherenceItself: true });
  assert.equal(inside.files, 1, "an absolute path under the root is fine");
});

test("an unreadable folder is reported and skipped; the check never aborts on it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coherence-eacces-"));
  try {
    await writeFile(join(dir, "open.md"), `The ${REJ} is here.\n`);
    await mkdir(join(dir, "locked"));
    await writeFile(join(dir, "locked", "hidden.md"), `The ${REJ} is hidden.\n`);
    await chmod(join(dir, "locked"), 0o000);
    const out = await runCheck({ root: dir, coherence, coherenceItself: true });
    assert.equal(out.rejected.length, 1, "the readable file is checked");
    if (process.getuid?.() === 0) return; // root reads everything; the skip cannot be witnessed
    assert.deepEqual(out.unreadable.map((u) => u.file), ["locked"]);
    assert.match(out.unreadable[0]!.reason, /EACCES|permission/i);
    assert.match(formatReport(out), /^UNREADABLE     locked  .*permission/m);
  } finally {
    await chmod(join(dir, "locked"), 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown nouns: Title Case away from a sentence start, on three lines or two across two components, with three closed options; a component folder's name is its spec's", () => {
  const terms = report.unknown.map((f) => f.term);
  assert.ok(terms.includes("durable object"), `expected durable object in ${terms.join(", ")}`);
  assert.ok(!terms.includes("flux"), "a component folder's name is defined by its spec");
  assert.ok(!terms.includes("flux capacitor"), "seen once");
  assert.ok(!terms.includes("title case in fences is ignored"));
  assert.ok(!terms.includes("cloudflare"), "a proper noun never seen as a common word would count, but it is capitalized at a sentence start once and mid-sentence once");
  assert.ok(!terms.includes("quest"), "the capitalized tail of an acronym is that product's name, not a noun of its own");
  assert.ok(!terms.includes("kubernetes"), "a well-known name needs no definition");
  assert.ok(!terms.includes("valkey"), "a backticked word is a code reference, not a name the check asks to define");
  const durable = report.unknown.find((f) => f.term === "durable object")!;
  assert.equal(durable.count, 3);
  assert.deepEqual(durable.locations, [
    { file: "flux/flux.spec.md", line: 1 },
    { file: "notes.md", line: 3 },
    { file: "notes.md", line: 3 },
  ]);
  assert.match(durable.options.declare, /as a concept/);
  assert.match(durable.options.map, /alias of an existing concept/);
  assert.match(durable.options.fix, /rejected name or a mistake/);
});

test("the report ends with counts, and hasFindings drives the exit code", () => {
  const text = formatReport(report);
  assert.match(text, new RegExp(`^REJECTED NAME  notes\\.md:1  "${Rej}"  rejected for invariant: `, "m"));
  assert.match(text, /^UNKNOWN NOUN   "durable object" \(3\)  flux\/flux\.spec\.md:1, notes\.md:3, notes\.md:3\n {15}declare: /m);
  assert.match(text, /\n\d+ rejected names, \d+ unknown nouns? \(3 files\)\n$/);
  assert.equal(hasFindings(report), true);
  assert.equal(hasFindings({ files: 1, rejected: [], unknown: [], unreadable: [] }), false);
});

test("paths restrict the corpus", async () => {
  const only = await runCheck({ root, coherence, project, paths: ["src/a.ts"], coherenceItself: true });
  assert.equal(only.files, 1);
  assert.equal(only.rejected.length, 3, "both layers' names reach identifiers: the project's two, and Coherence's one the project did not take for its own");
  assert.equal(only.unknown.length, 0);
});

test("without a project lexicon, nothing guards the project's phrases, so Coherence's names hit every identifier they are in", async () => {
  const alone = await runCheck({ root, coherence, paths: ["src/a.ts"], coherenceItself: true });
  assert.deepEqual(alone.rejected.map((f) => f.text.toLowerCase()), [REJ, REJ]);
  assert.deepEqual(alone.rejected.map((f) => f.line), [3, 4]);
});

test("identifier and term helpers", () => {
  assert.deepEqual(identifierWords("consentFlurbKeeper"), ["consent", "flurb", "keeper"]);
  assert.deepEqual(identifierWords("AUTH_CODE_ttl"), ["auth", "code", "ttl"]);
  assert.deepEqual(identifierWords("HTMLParser"), ["html", "parser"]);
  assert.equal(normalizeTerm("Auth-Code_form"), "auth code form");
});

test("parseLexicon refuses a shape it does not understand", () => {
  assert.throws(() => parseLexicon({ concepts: [{ definition: "no name" }] }, "x.json"), /needs a name/);
  assert.throws(() => parseLexicon([], "x.json"), /must be an object/);
});

/* ------------------------------------------------------------ adopters */

/** A scratch adopter: a project lexicon, prose, code, a spec, a record, and a config, each carrying a Coherence rejected name. */
async function adopter(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "coherence-adopter-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

function decision(id: string, chose: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, kind: "decision", at: `2026-09-25T00:00:0${id.length % 10}.000Z`, session: "s1", agent: "a", commit: null, dirty: false, chose, over: "none", because: "b", ...extra });
}

test("Coherence's rejected names bind only in Coherence's own text: in an adopter its code and domain prose are the project's words, and the text written to Coherence is advisory", async () => {
  const dir = await adopter({
    "lexicon.json": JSON.stringify(projectLexicon),
    "notes.md": `The ${REJ} opens at dawn; the doohickey is gone.\n`,
    "src/a.ts": `const ${REJ}Keeper = 1;\n`,
    "src/src.spec.md": [`# Src`, "", "## invariants", "", `- ${REJ} holds: the ${REJ} opens only for members.`, `  because: members only`, `  checklist: input-validation dismissed: the ${REJ} validates`, ""].join("\n"),
    "src/grammar.spec.md": [`# Grammar`, "", `## ${REJ}s`, `  ${REJ}: a key in the tool's grammar`, ""].join("\n"),
    ".coherence/journal/s1.jsonl": decision("d-1", `the ${REJ} passed`) + "\n",
    "coherence.config.json": JSON.stringify({ name: "widgetry", note: REJ }) + "\n",
  });
  try {
    const lexicons = { coherence, project: await loadLexicon(join(dir, "lexicon.json")) };
    const out = await runCheck({ root: dir, ...lexicons });
    const enforced = out.rejected.filter((f) => f.advisory !== true);
    assert.deepEqual(enforced.map((f) => [f.file, f.name]), [["notes.md", "doohickey"]], "only the project's own rejected name binds in its prose and code");
    const advisory = out.rejected.filter((f) => f.advisory === true).map((f) => `${f.file}:${f.line}`).sort();
    assert.deepEqual(advisory, [".coherence/journal/s1.jsonl:1", "coherence.config.json:1", "src/grammar.spec.md:3", "src/grammar.spec.md:4"], "records, the config, and a spec's grammar; never a requirement's name or sentence");
    const text = formatReport(out);
    assert.match(text, /^ADVISORY +4 Coherence names in text written to Coherence/m);
    assert.ok(!/REJECTED NAME .*(src\/|spec|config|journal)/.test(text), "no advisory hit is printed as a failure");
    assert.equal(hasFindings({ ...out, rejected: out.rejected.filter((f) => f.advisory === true) }), false, "an advisory hit never fails the check");
    // Detected, not assumed: the same text in a folder whose package is Coherence binds everywhere.
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: PACKAGE_NAME }));
    const own = await runCheck({ root: dir, ...lexicons });
    assert.ok(own.rejected.some((f) => f.file === "notes.md" && f.name === REJ && f.advisory !== true), "in Coherence's own repository its names bind in prose");
    assert.ok(own.rejected.some((f) => f.file === "src/a.ts" && f.advisory !== true), "and in identifiers");
    assert.ok(!own.rejected.some((f) => f.advisory === true), "and nothing is merely advisory there");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a project's claim wins inside it: a Coherence rejected name the project declares is no finding, advisory or enforced", async () => {
  const claimed = { ...projectLexicon, concepts: [...projectLexicon.concepts, { name: REJ, definition: "The project's own sense of the word.", aliases: [] }] };
  const dir = await adopter({
    "lexicon.json": JSON.stringify(claimed),
    ".coherence/journal/s1.jsonl": decision("d-1", `the ${REJ} passed and the ${ALT} too`) + "\n",
  });
  try {
    const out = await runCheck({ root: dir, coherence, project: await loadLexicon(join(dir, "lexicon.json")) });
    assert.deepEqual(out.rejected.map((f) => f.name), [ALT], `${REJ} is the project's word; ${ALT} is not claimed and stays advisory`);
    assert.ok(out.rejected.every((f) => f.advisory === true));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the baseline only shrinks: a fresh adoption passes once baselined, a new finding fails, a fixed one drops out, a later record never adds, and Coherence's own repository keeps none", async () => {
  const dir = await adopter({
    "lexicon.json": JSON.stringify(projectLexicon),
    "a.md": "The doohickey spins. Ask the Grand Vizier.\n",
    "b.md": "Again the Grand Vizier.\n",
    "sub/sub.spec.md": "# Sub\n",
    "sub/c.md": "The Grand Vizier rules. The Tall Tower stands.\n",
    "d.md": "The Tall Tower again.\n",
  });
  const who = { session: "s1", agent: "a" };
  const project = await loadLexicon(join(dir, "lexicon.json"));
  const check = (): Promise<CheckReport> => runCheck({ root: dir, coherence, project });
  const lineOf = (file: string, line: number): string => readFileSync(join(dir, file), "utf8").split(/\r?\n/)[line - 1] ?? "";
  try {
    const fresh = await check();
    assert.equal(hasFindings(fresh), true, "a fresh adoption holds findings");
    assert.match(recordBaseline(dir, fresh, lineOf, who), /^Baseline taken \(d-[0-9a-f]+\): 1 rejected name, 2 unknown nouns/);
    const taken = await check();
    assert.equal(hasFindings(taken), false, "after the baseline the check passes");
    assert.match(formatReport(taken), /^BASELINED +1 rejected name, 2 unknown nouns held since adoption \(d-[0-9a-f]+\); not failing$/m);
    assert.match(formatReport(taken), /\n0 rejected names, 0 unknown nouns \(6 files\)\n$/);
    const recorded = sessionText(join(dir, ".coherence", "journal"), "s1");
    assert.ok(!recorded.includes("doohickey"), "the record never spells the name it excuses");

    // A new finding fails; editing the baselined line makes it new.
    await writeFile(join(dir, "a.md"), "The doohickey spins twice. Ask the Grand Vizier.\n");
    const edited = await check();
    assert.equal(hasFindings(edited), true, "an edited line is a new finding");
    assert.equal(failingRejected(edited).length, 1);

    // Fixing drops out: the count falls at once, and the next baseline records the smaller set.
    await writeFile(join(dir, "a.md"), "Ask the Grand Vizier.\n");
    const fixed = await check();
    assert.equal(hasFindings(fixed), false);
    assert.equal(fixed.baseline?.rejected, 0);
    assert.equal(fixed.baseline?.gone, 1, "the fixed finding is counted as gone");
    assert.match(recordBaseline(dir, fixed, lineOf, who), /^Baseline shrunk \(d-[0-9a-f]+\): 0 rejected names, 2 unknown nouns/);
    await writeFile(join(dir, "a.md"), "The doohickey spins. Ask the Grand Vizier.\n");
    assert.equal(hasFindings(await check()), true, "once shrunk, the old finding restored is new");

    // Taking the baseline again never adds, and neither does a hand-written record with more in it.
    assert.match(recordBaseline(dir, await check(), lineOf, who), /^Baseline unchanged/);
    const bigger = JSON.stringify({ rejected: { [findingDigest("a.md", "doohickey", lineOf("a.md", 1))]: 1 }, unknown: ["grand vizier", "tall tower", "doohickey"] });
    await writeFile(join(dir, ".coherence", "journal", "s2.jsonl"), decision("d-ffffffff", `lexicon baseline ${bigger}`, { at: "2099-01-01T00:00:00.000Z", session: "s2" }) + "\n");
    const after = await check();
    assert.equal(hasFindings(after), true, "a later record is intersected with the earlier ones, so it cannot widen the baseline");
    assert.equal(readBaseline(dir)?.rejected.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await ownRepositoryKeepsNoBaseline();
});

/** In Coherence's own repository a baseline record excuses nothing: its text is enforced whole. */
async function ownRepositoryKeepsNoBaseline(): Promise<void> {
  const dir = await adopter({ "package.json": JSON.stringify({ name: PACKAGE_NAME }), "notes.md": `The ${REJ} is here.\n` });
  try {
    const key = findingDigest("notes.md", REJ, `The ${REJ} is here.`);
    await mkdir(join(dir, ".coherence", "journal"), { recursive: true });
    await writeFile(join(dir, ".coherence", "journal", "s1.jsonl"), decision("d-1", `lexicon baseline ${JSON.stringify({ rejected: { [key]: 1 }, unknown: [] })}`) + "\n");
    const out = await runCheck({ root: dir, coherence });
    assert.equal(out.baseline, undefined);
    assert.equal(failingRejected(out).length, 1, "the name still fails in Coherence's own text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
