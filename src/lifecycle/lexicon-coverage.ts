/**
 * Vocabulary coverage: a reproducible reading of observed uses, not a claim
 * about every word's meaning, and never a count to act on. What it hands a
 * reader is a short ranked signal: the recurring terms that lack a definition
 * and the uses whose sense is at risk.
 *
 * Code and prose are different populations. From code, only declared and
 * exported names (and the fields of exported types) are candidate sources;
 * local identifiers, the words and
 * n-grams of split identifiers, strings, regular-expression fragments, paths,
 * ids, and punctuation-bearing tokens never are. From prose (docs, specs, and
 * the journal's and work's records), a candidate is a name written as a name:
 * Title Case away from a sentence start, a heading word, a single backticked
 * word. A candidate stands only when it recurs: a prose name on three lines,
 * or two across two components; a declared name where prose writes it as
 * words (never inside an identifier's spelling) on ten lines across four
 * components.
 * Well-known names (well-known.json, the config's wellKnown, the project's
 * own name), names the lexicon declares (concepts, aliases, instances,
 * properties, and its "not:" confusables), and general English and
 * programming words are never candidates. A common word written as a
 * project's proper noun still is; a function word (a preposition,
 * conjunction, determiner, pronoun, or auxiliary) never is, however written.
 *
 * Sense review is asked only where meaning is at risk: a name with more than
 * one recorded sense, a use on or beside a prose line carrying a name
 * rejected for that same concept, or a Coherence concept an adopter's code
 * declares, written in text Coherence reads as its own: the journal's and
 * work's records, and a spec's or practice's grammar (its headings, property
 * keys and checklist shapes, check.ts's specGrammar). An adopter's code and
 * its domain prose are the project's words, so a Coherence name declared
 * there is the project's sense and asks nothing; only where Coherence's
 * grammar also speaks can the two senses meet. Such a context's ruling is
 * keyed to the term and the component, not the content, so a new use of the
 * same name does not reopen it.
 */
import { existsSync, realpathSync } from "node:fs";
import { exclusionOf, projectFilesEnding, walkBounds } from "../adapters/project-files.ts";
import type { Language } from "../adapters/index.ts";
import { languageOfFile } from "../adapters/language-files.ts";
import { readFile } from "node:fs/promises";
import { createHash, type Hash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadJournal } from "../journal/store.ts";
import { recordWords } from "../journal/record.ts";
import { countWork } from "./work-meter.ts";
import {
  corpusFiles,
  readCorpus,
  specGrammar,
  type UnreadablePath,
} from "./check.ts";
import {
  acceptedNames,
  aliasNames,
  rejectedNames,
  type Concept,
  type Lexicon,
} from "./lexicon.ts";
import { isCoherenceItself, loadProjectLexicons, vocabularyFacts, within } from "./project.ts";
import { BASELINE_CHOSE } from "./lexicon-baseline.ts";
import { FUNCTION_WORD_SET, STOPLIST } from "./stoplist.ts";
import { singularForms } from "./inflection.ts";
import { clean, proseNominations, type Nomination } from "./nomination.ts";

export { proseNominations };
import { isWellKnown, wellKnown, type WellKnown } from "./well-known.ts";

export interface VocabularyUse {
  file: string;
  line: number;
  component: string;
  text: string;
  kind: string;
  fingerprint: string;
}
export interface VocabularyContext {
  component: string;
  fingerprint: string;
  disposition: string;
  because: string | null;
  /** Why this context's sense is at risk; absent when nothing puts it at risk, and then no review is asked. */
  risk?: string;
}
export interface VocabularyTerm {
  term: string;
  state:
    | "concept"
    | "alias"
    | "instance"
    | "declared"
    | "rejected"
    | "unresolved";
  concept: string | null;
  layer: "coherence" | "project" | null;
  definition: string | null;
  properties: Record<string, unknown>;
  confusables: string[];
  /** Present when one observed spelling names properties owned by multiple concepts. */
  meaningAlternatives?: {
    concept: string;
    layer: "coherence" | "project";
    definition: string;
    properties: Record<string, unknown>;
    confusables: string[];
  }[];
  /** For a candidate (state unresolved): the prose lines it recurs on and the components it spans. */
  recurrence?: { prose: number; components: number };
  fingerprint: string;
  count: number;
  uses: VocabularyUse[];
  contexts: VocabularyContext[];
}
export interface Coverage {
  version: 1;
  projectLexicon: string | null;
  fingerprint: string;
  population: {
    files: { file: string; kind: string; lines: number }[];
    /** The project-relative paths the reading was narrowed to; absent when it read the whole project. */
    paths?: string[];
    /** The files an edit's reading read, without walking the corpus; absent when it read the whole project or its paths. */
    named?: string[];
    excluded: UnreadablePath[];
    unreadable: UnreadablePath[];
    extraction: string;
    limits: string[];
  };
  terms: VocabularyTerm[];
  /** Population facts about the observed reading, for tools; never a to-do count, and never injected. */
  totals: {
    terms: number;
    uses: number;
    known: number;
    rejected: number;
    unresolved: number;
    /** Contexts whose sense is at risk and not yet settled by a review. */
    unreviewedContexts: number;
  };
}
export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A digest over many parts without building one string of them all: a large corpus must not exceed a string's length. */
function digestAll(parts: Iterable<unknown>): string {
  const hash: Hash = createHash("sha256");
  for (const part of parts) hash.update(JSON.stringify(part) ?? "null").update("\n");
  return hash.digest("hex");
}

/**
 * A structured sense review as a decision's text: the vocabulary verb,
 * "review", then its JSON. The verb is matched by shape, not by name, so a
 * review recorded before the concept was renamed (under the name it now
 * rejects) keeps its ruling: the journal is append-only and is read as written.
 */
const REVIEW = /^[a-z]+ review (\{.*\})$/s;
/** The same for an applied proposal: the verb, "apply", the proposal id. */
const APPLY = /^[a-z]+ apply [a-z]p-[a-f0-9]{24} /;

/** Recover only lexicon review decisions with a matching current evidence key. Old answers are history. */
function rulings(
  root: string,
): Map<string, { disposition: string; because: string }> {
  const result = new Map<string, { disposition: string; because: string }>();
  for (const r of loadJournal(root).records) {
    if (r.kind !== "decision") continue;
    const review = REVIEW.exec(r.chose);
    if (!review) continue;
    try {
      const data = JSON.parse(review[1]!) as Record<string, unknown>;
      if (
        typeof data["evidence"] === "string" &&
        typeof data["disposition"] === "string"
      )
        result.set(data["evidence"], {
          disposition: data["disposition"],
          because: r.because,
        });
    } catch {
      /* A prose decision that is not a structured review remains prose. */
    }
  }
  return result;
}
interface KnownMeaning {
  state: VocabularyTerm["state"];
  concept: Concept | null;
  layer: "coherence" | "project";
  propertyOwners?: { concept: Concept; layer: "coherence" | "project" }[];
}

function table(
  lexicon: Lexicon,
  layer: "coherence" | "project",
  into: Map<string, KnownMeaning>,
  properties: Map<string, { concept: Concept; layer: "coherence" | "project" }[]>,
  senses: Map<string, Set<string>>,
): void {
  const sense = (name: string, c: Concept): void => {
    const set = senses.get(name) ?? new Set<string>();
    // The same concept name in both layers is the project restating the tool's concept, one sense; a different concept is another.
    set.add(c.name);
    senses.set(name, set);
  };
  // Project/trust-level declarations have no owning concept; property declarations are attached below.
  for (const name of acceptedNames(lexicon))
    if (!into.has(clean(name))) into.set(clean(name), { state: "declared", concept: null, layer });
  for (const c of lexicon.concepts) {
    into.set(clean(c.name), { state: "concept", concept: c, layer });
    sense(clean(c.name), c);
    for (const name of c.instances ?? []) {
      into.set(clean(name), { state: "instance", concept: c, layer });
      sense(clean(name), c);
    }
    for (const alias of c.aliases)
      for (const name of aliasNames(alias)) {
        into.set(clean(name), { state: "alias", concept: c, layer });
        sense(clean(name), c);
      }
    for (const key of Object.keys(c.properties))
      for (const name of aliasNames(key)) {
        const normalized = clean(name);
        const owners = properties.get(normalized) ?? [];
        owners.push({ concept: c, layer });
        properties.set(normalized, owners);
      }
  }
}

/** The singulars a word may be the plural of, as the reading merges a plural into its singular: the check's own rules (inflection.ts). */
export { singularForms };
const singular = singularForms;

/** Inflection is accepted only when its conservative singular is an already-known complete name. */
function knownMeaning(term: string, known: Map<string, KnownMeaning>): KnownMeaning | undefined {
  const exact = known.get(term);
  if (exact) return exact;
  const words = term.split(" ");
  for (const one of singular(words.at(-1)!)) {
    const meaning = known.get([...words.slice(0, -1), one].join(" "));
    if (meaning) return { ...meaning, state: "declared" };
  }
  return undefined;
}

function isLexiconDecision(line: string): boolean {
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    return (
      record["kind"] === "decision" &&
      typeof record["chose"] === "string" &&
      (REVIEW.test(record["chose"]) || APPLY.test(record["chose"]) || BASELINE_CHOSE.test(record["chose"]))
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ candidates */

/**
 * A spelling that could name a concept at all: one to three words of letters,
 * each at least two long. Anything carrying a digit (a hash, a work-order or
 * decision id, a UUID, a version), a path, a dot, or other punctuation never
 * reaches here as a candidate.
 */
const ELIGIBLE = /^[a-z]{2,}(?: [a-z]{2,}){0,2}$/;

function allCommon(term: string): boolean {
  return term.split(" ").every((w) => STOPLIST.has(w) || singular(w).some((s) => STOPLIST.has(s)));
}

/** The names a code line declares or exports: the only code a candidate may come from. */
const DECLARATIONS: RegExp[] = [
  // TypeScript and JavaScript exports.
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z$][\w$]*)/,
  // Python top-level definitions; a leading underscore is private by convention and never matches.
  /^(?:async\s+)?def\s+([A-Za-z]\w*)/,
  /^class\s+([A-Za-z]\w*)/,
  // Go exports are capitalized.
  /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/,
  /^type\s+([A-Z]\w*)/,
  // Rust, Swift, Kotlin, Java public declarations.
  /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod)\s+([A-Za-z]\w*)/,
  /^\s*(?:public|open)\s+(?:final\s+)?(?:static\s+)?(?:class|struct|enum|protocol|interface|func|fun)\s+([A-Za-z]\w*)/,
];

function declaredName(line: string): string | undefined {
  for (const pattern of DECLARATIONS) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** How a code file's exported type bodies read, per adapter language (languageOfFile): the line that opens a body, the line that closes it, and a field inside. A file no language claims has no type bodies read. */
interface MemberScan {
  opens: RegExp;
  closes: RegExp;
  field: RegExp;
}

/** Keyed by language, so a language an adapter adds must say how its type bodies read. */
const MEMBER_SCANS: Record<Language, MemberScan> = {
  typescript: { opens: /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class)\s.*\{\s*$/, closes: /^[}\]]/, field: /^\s+(?:readonly\s+)?([a-z][A-Za-z0-9]*)\??:\s*[^=]/ },
  python: { opens: /^class\s/, closes: /^\S/, field: /^ {4}([a-z][A-Za-z0-9_]*)\s*:\s*[A-Za-z"'[]/ },
  // Rust is not read by this reading yet: no line opens a body, so a .rs file's struct fields are not read as TypeScript's.
  rust: { opens: /(?!)/, closes: /^[}\]]/, field: /(?!)/ },
};

/**
 * A field an exported type declares: a member of an exported TypeScript
 * interface, type or class, or an annotated field of a top-level Python
 * class. The file's own locals never match.
 */
function memberName(line: string, inside: boolean, scan: MemberScan | undefined): string | undefined {
  if (!inside || scan === undefined) return undefined;
  return scan.field.exec(line)?.[1];
}

interface Word {
  lower: string;
  original: string;
}

/**
 * The runs of plain words in a prose text: an identifier's spelling
 * (camelCase, snake_case), a path, a dotted name, a token with a digit or
 * other punctuation breaks the run, and so does sentence punctuation. A
 * declared name recurs in prose only where prose writes it as words.
 */
function wordRuns(text: string): Word[][] {
  const runs: Word[][] = [];
  let run: Word[] = [];
  const cut = (): void => {
    if (run.length) runs.push(run);
    run = [];
  };
  for (const raw of text.split(/\s+/)) {
    const core = raw.replace(/^[("'`*_[{<]+/, "").replace(/[)"'`*_\]}>,.;:!?]+$/, "").replace(/'s$/, "");
    const breakAfter = /[,.;:!?)\]]$/.test(raw.replace(/["'`*_]+$/, ""));
    const plain = /^[A-Za-z]+(?:-[A-Za-z]+)*$/.test(core) && !/[a-z][A-Z]/.test(core);
    if (!plain) {
      cut();
      continue;
    }
    for (const part of core.split("-")) run.push({ lower: part.toLowerCase(), original: part });
    if (breakAfter) cut();
  }
  cut();
  return runs;
}

/**
 * The written prose of a journal or work record line: every field its role
 * table (journal/record.ts) calls prose, and a decision's over, whose refused
 * name is still a use of the words; ids, sessions, commits, paths and states
 * are not words. A line that will not parse is read whole.
 */
export function recordProse(line: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [line];
  }
  return recordWords(value, (role) => role !== "meta");
}

interface Pool {
  proper: boolean;
  /** Declared or exported in code: its recurrence is counted wherever prose writes it as words. */
  declared: boolean;
  spellings: Set<string>;
  sites: VocabularyUse[];
  /** Each site's file and line, so a site is added once without a scan. */
  siteKeys: Set<string>;
  words: VocabularyUse[];
}

interface ProseLine {
  use: VocabularyUse;
  runs: Word[][];
}

/**
 * Every line of the project's own files that writes the term, as a word or
 * inside an identifier, whether or not it recurs enough to be a candidate. A
 * term a project has not declared yet is read here before it is named (step
 * one of settle a domain term); coverage's terms hold only what recurs.
 */
export async function liveUses(
  root: string,
  term: string,
  limit = 40,
): Promise<{ uses: VocabularyUse[]; total: number }> {
  const { coherence, project } = await loadProjectLexicons(root);
  const corpus = await readCorpus({ root, coherence, project });
  const wanted = " " + clean(term).replace(/[^a-z0-9 ]/g, " ").trim() + " ";
  if (wanted.trim() === "") return { uses: [], total: 0 };
  const components = corpus.files
    .filter((f) => f.rel.endsWith(".spec.md"))
    .map((f) => dirname(f.rel))
    .sort((a, b) => b.length - a.length);
  const found: VocabularyUse[] = [];
  for (const f of corpus.files) {
    const secret = /(^|\/)\.env(?:$|\.)/.test(f.rel);
    f.lines.forEach((source, n) => {
      if (f.kind === "record" && isLexiconDecision(source)) return;
      const observed = secret ? source.replace(/=.*/, "") : source;
      const normalized = " " + clean(observed).replace(/[^a-z0-9 ]/g, " ") + " ";
      if (!normalized.replace(/\s+/g, " ").includes(wanted)) return;
      found.push({
        file: f.rel,
        line: n + 1,
        component:
          components.find((c) => c === "." || f.rel.startsWith(c + "/")) ??
          "(no declared component)",
        text: (secret ? source.replace(/=.*/, "=<redacted>") : source).trim().slice(0, 360),
        kind: f.kind,
        fingerprint: digest(source),
      });
    });
  }
  return { uses: found.slice(0, limit), total: found.length };
}

/**
 * The paths a reading is narrowed to, each as the project-relative path its
 * corpus files are named under: relative to the root or absolute inside it,
 * and existing. A path outside the root, or one that does not exist, is
 * refused rather than read as nothing. The root itself is "".
 */
export function readingPaths(root: string, given: readonly string[]): string[] {
  const base = realpathSync(resolve(root));
  const outside = (path: string): Error =>
    new Error(`${path} is outside the project root ${resolve(root)}; name a folder or file inside it`);
  return [...new Set(given.map((path) => {
    const full = resolve(root, path);
    if (!within(root, full)) throw outside(path);
    if (!existsSync(full)) throw new Error(`${path} does not exist under the project root ${resolve(root)}`);
    const rel = relative(base, realpathSync(full));
    if (rel.startsWith("..") || isAbsolute(rel)) throw outside(path);
    return rel.split(sep).join("/");
  }))].sort();
}

/** Whether a corpus file lies under one of the reading's paths; every file does when the reading is not narrowed. */
function underPaths(file: string, paths: readonly string[] | undefined): boolean {
  return paths === undefined || paths.some((p) => p === "" || file === p || file.startsWith(p + "/"));
}

/** The component folders the corpus's specs declare, deepest first. */
function componentFolders(listed: readonly string[]): string[] {
  return listed
    .filter((rel) => rel.endsWith(".spec.md"))
    .map((rel) => dirname(rel))
    .sort((a, b) => b.length - a.length);
}

/** The component a file belongs to: the deepest declared folder holding it. */
function componentOf(file: string, components: readonly string[]): string {
  return components.find((c) => c === "." || file.startsWith(c + "/")) ?? "(no declared component)";
}

export interface CoverageScope {
  /**
   * Read only these project-relative files, without walking the corpus: an
   * edit's reading. Each file's component is the deepest folder above it
   * holding a spec, found by listing only the folders above it.
   */
  files?: readonly string[] | undefined;
  /** Terms code declares elsewhere in the project, so this reading counts their recurrence as words in its own files. */
  declared?: ReadonlySet<string> | undefined;
  /** False skips the journal's review rulings: an edit's reading names only what it introduced, whose evidence no ruling has seen. */
  rulings?: boolean | undefined;
  /** Also hand back each file's contribution, the kept vocabulary state's unit (vocabulary-state.ts). */
  contributions?: boolean | undefined;
}

/**
 * What one file adds to the vocabulary: the names it nominates (sites it
 * writes them at, as a name in prose or records, in code, and whether code
 * declares them), the declared names it writes as words, and the known
 * names it uses, each as the term and its line's digest.
 */
export interface Contribution {
  component: string;
  pool: Record<string, { named: number; code: number; sites: number; declared: boolean }>;
  words: Record<string, number>;
  uses: string[];
}

/** The component folders, from a listing of the specs alone: what a reading of a few files needs to know whose they are. */
function specFolders(root: string): string[] {
  const bounds = walkBounds(root);
  return componentFolders(projectFilesEnding(root, ".spec.md").filter((rel) => exclusionOf(rel, bounds) === undefined));
}

export async function lexiconCoverage(
  root: string,
  layers?: { coherence: Lexicon; project: Lexicon | undefined },
  paths?: readonly string[],
  scope: CoverageScope = {},
): Promise<Coverage> {
  return (await lexiconReading(root, layers, paths, scope)).coverage;
}

/** The coverage reading, and, when asked, each file's contribution to it. */
export async function lexiconReading(
  root: string,
  layers?: { coherence: Lexicon; project: Lexicon | undefined },
  paths?: readonly string[],
  scope: CoverageScope = {},
): Promise<{ coverage: Coverage; contributions: Map<string, Contribution> }> {
  countWork("coverage reading");
  const { coherence, project } = layers ?? (await loadProjectLexicons(root));
  // Coherence's own lexicon is the project's only in Coherence's own checkout; an adopter without lexicon.json has none yet.
  const own = await isCoherenceItself(root);
  const rawEntries = new Map<string, Record<string, unknown>>();
  for (const g of [coherence, ...(project ? [project] : [])]) {
    const raw = JSON.parse(await readFile(g.path, "utf8")) as {
      concepts: Record<string, unknown>[];
    };
    for (const c of raw.concepts)
      rawEntries.set(
        (g === project ? "project" : "coherence") + ":" + String(c["name"]),
        c,
      );
  }
  // A reading narrowed to paths reads only the files under them, and the listing still names every component; an edit's reading names its files and walks nothing.
  const select = paths !== undefined ? (rel: string) => underPaths(rel, paths) : undefined;
  const corpus =
    scope.files !== undefined
      ? { files: await corpusFiles({ root, coherence, project }, scope.files), listed: [] as string[], unreadable: [] as UnreadablePath[], excluded: [] as UnreadablePath[] }
      : await readCorpus({ root, coherence, project }, select);
  const known = new Map<string, KnownMeaning>();
  const senses = new Map<string, Set<string>>();
  const propertyOwners = new Map<string, { concept: Concept; layer: "coherence" | "project" }[]>();
  table(coherence, "coherence", known, propertyOwners, senses);
  const rejected = new Map(
    rejectedNames(coherence).map((r) => [clean(r.name), r]),
  );
  if (project) {
    table(project, "project", known, propertyOwners, senses);
    for (const r of rejectedNames(project)) rejected.set(clean(r.name), r);
  }
  for (const [name, owners] of propertyOwners) {
    const current = known.get(name);
    // An exact concept/alias/instance remains the primary meaning, but every property owner is still exposed.
    if (current?.concept) current.propertyOwners = owners;
    else if (owners.length === 1) known.set(name, { state: "declared", concept: owners[0]!.concept, layer: owners[0]!.layer, propertyOwners: owners });
    else if (owners.length > 1) known.set(name, { state: "declared", concept: null, layer: owners[0]!.layer, propertyOwners: owners });
  }
  // A project's explicit vocabulary owns its own sense, even where the tool refused the spelling.
  const projectNames = project
    ? new Set([...acceptedNames(project)].map(clean))
    : new Set<string>();
  for (const name of projectNames) rejected.delete(name);
  // Only a name that binds here marks a sense at risk beside it: Coherence's rejected names bind in an adopter's prose never, the project's own always (check.ts).
  const binding = new Set(
    own ? rejected.keys() : (project ? rejectedNames(project) : []).map((r) => clean(r.name)).filter((n) => rejected.has(n)),
  );
  // The lexicon's "not:" entries name things it already knows are something else (Pyright, Python): never candidates.
  const confusables = new Set<string>();
  for (const g of [coherence, project])
    for (const c of g?.concepts ?? [])
      for (const entry of c.notToBeConfusedWith) {
        const lead = clean(entry.split(":")[0] ?? "");
        if (lead !== "") confusables.add(lead);
      }
  const facts = await vocabularyFacts(root);
  const famous: WellKnown = wellKnown(facts, [coherence.project, project?.project].filter((n): n is string => n !== undefined));
  const phrases = [...new Set([...known.keys(), ...rejected.keys()])].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  // Each phrase indexed by its first word: a line is tested only against the phrases its own words can start, in the phrases' order.
  const byFirstWord = new Map<string, number[]>();
  phrases.forEach((phrase, n) => {
    const first = phrase.split(" ")[0]!;
    byFirstWord.set(first, [...(byFirstWord.get(first) ?? []), n]);
  });
  const components = scope.files !== undefined ? specFolders(root) : componentFolders(corpus.listed);
  const uses = new Map<string, VocabularyUse[]>();
  const componentFor = (file: string): string => componentOf(file, components);
  // Each term's uses by file and line, so adding one is a lookup, never a scan of the uses so far.
  const useKeys = new Map<string, Set<string>>();
  const add = (term: string, use: VocabularyUse): void => {
    if (!term) return;
    const list = uses.get(term) ?? [];
    const keys = useKeys.get(term) ?? new Set<string>();
    const key = `${use.file}\n${use.line}`;
    if (!keys.has(key)) {
      keys.add(key);
      list.push(use);
    }
    useKeys.set(term, keys);
    uses.set(term, list);
  };
  /** Rejected names on each line, keyed by file then line: sense is at risk beside them. */
  const rejectedLines = new Map<string, Map<number, string[]>>();
  /** Names code declares, by their words: a Coherence concept an adopter declares carries the adopter's sense there. */
  const declarations = new Map<string, VocabularyUse[]>();
  /** Each use's words in text Coherence reads as its own (a record's prose, a spec's or practice's grammar), normalized: where an adopter's declared sense can meet Coherence's. */
  const grammarOf = new Map<VocabularyUse, string>();
  const pool = new Map<string, Pool>();
  /** The files whose code declares each nominated name. */
  const declaredBy = new Map<string, Set<string>>();
  const proseLines: ProseLine[] = [];
  const nominate = (n: Nomination, site: VocabularyUse | undefined, declared = false): void => {
    const term = n.term;
    if (!ELIGIBLE.test(term) || term.length > 40) return;
    if (knownMeaning(term, known) || rejected.has(term)) {
      // An inflection of a known name is observed under its own spelling; an exact name already has its uses.
      if (site && !known.has(term) && !rejected.has(term)) add(term, site);
      return;
    }
    if (confusables.has(term) || isWellKnown(famous, term, n.spelling)) return;
    // Grammar, never a name: a phrase made only of function words is refused even capitalized ("Via", "And Or").
    if (term.split(" ").every((w) => FUNCTION_WORD_SET.has(w))) return;
    // A proper noun is a name even when the word is common; any other source must not be common words alone.
    if (!n.proper && allCommon(term)) return;
    // A participle is a state, not a thing: a declared "missing" or "resolved" is never a candidate.
    if (declared && /^[a-z]+[^e]ed$/.test(term)) return;
    const entry = pool.get(term) ?? { proper: false, declared: false, spellings: new Set<string>(), sites: [], siteKeys: new Set<string>(), words: [] };
    entry.proper ||= n.proper;
    entry.declared ||= declared;
    entry.spellings.add(n.spelling);
    if (site && !entry.siteKeys.has(`${site.file}\n${site.line}`)) {
      entry.siteKeys.add(`${site.file}\n${site.line}`);
      entry.sites.push(site);
    }
    if (declared && site) declaredBy.set(term, (declaredBy.get(term) ?? new Set<string>()).add(site.file));
    pool.set(term, entry);
  };
  // Components come from every spec in the corpus; only the files the reading was narrowed to were read for uses.
  const read = corpus.files;
  // Each test of a line against one phrase, counted here and handed to the work meter once: the scan's per-line cost.
  let comparisons = 0;
  for (const f of read) {
    const fileFingerprint = digest(
      f.lines.filter(
        (line) => !(f.kind === "record" && isLexiconDecision(line)),
      ),
    );
    let fenced = false;
    let exported = false;
    const language = languageOfFile(f.rel);
    const scan = language === undefined ? undefined : MEMBER_SCANS[language];
    for (let n = 0; n < f.lines.length; n++) {
      const source = f.lines[n]!;
      // Review/maintenance decisions are outcomes, not fresh source-language observations of themselves.
      if (f.kind === "record" && isLexiconDecision(source)) continue;
      const secret = /(^|\/)\.env(?:$|\.)/.test(f.rel);
      const observed = secret ? source.replace(/=.*/, "") : source;
      const normalized =
        " " + clean(observed).replace(/[^a-z0-9 ]/g, " ") + " ";
      const use: VocabularyUse = {
        file: f.rel,
        line: n + 1,
        component: componentFor(f.rel),
        text: (secret ? source.replace(/=.*/, "=<redacted>") : source)
          .trim()
          .slice(0, 360),
        kind: f.kind,
        fingerprint: f.kind === "record" ? digest(source) : fileFingerprint,
      };
      // Every test of this line against a phrase goes through here, so the work meter counts the scan's real per-line cost.
      const writes = (phrase: string, plural = false): boolean => {
        comparisons += 1;
        if (normalized.includes(" " + phrase + " ")) return true;
        return plural && (normalized.includes(" " + phrase + "s ") || normalized.includes(" " + phrase + "es "));
      };
      const spans: string[] = [];
      const candidates: number[] = [];
      for (const word of new Set(normalized.split(" "))) {
        const starting = byFirstWord.get(word);
        if (starting !== undefined) candidates.push(...starting);
      }
      candidates.sort((a, b) => a - b);
      for (const i of candidates) {
        const phrase = phrases[i]!;
        if (writes(phrase)) {
          add(phrase, use);
          spans.push(phrase);
        }
      }
      // A record's prose is written to Coherence whole; a spec or practice only in its grammar, while its sentences are the project's.
      if (!own && project) {
        const grammar =
          f.kind === "record"
            ? recordProse(observed).join(" ")
            : f.kind === "prose" && /\.(spec|practice)\.md$/.test(f.rel)
              ? specGrammar(observed)
              : "";
        if (grammar.trim() !== "") grammarOf.set(use, " " + clean(grammar).replace(/[^a-z0-9 ]/g, " ") + " ");
      }
      const refused = spans.filter((p) => binding.has(p));
      // Only prose a person can still edit puts a sense at risk: code shares words with the language (Promise), and a record is history.
      if (refused.length && f.kind === "prose") {
        // A rejected word inside a longer known name on the same line is that name, not the refusal.
        const masked = spans
          .filter((p) => !rejected.has(p))
          .reduce((line, p) => line.split(" " + p + " ").join("   "), normalized);
        const standing = refused.filter((p) => masked.includes(" " + p + " "));
        if (standing.length) {
          const byLine = rejectedLines.get(f.rel) ?? new Map<number, string[]>();
          byLine.set(n + 1, standing);
          rejectedLines.set(f.rel, byLine);
        }
      }
      if (f.kind === "code") {
        const name = declaredName(observed);
        if (name !== undefined && !name.startsWith("_")) {
          const term = clean(name);
          const sites = declarations.get(term) ?? [];
          sites.push(use);
          declarations.set(term, sites);
          nominate({ term, spelling: name, proper: false }, use, true);
        }
        const member = memberName(observed, exported, scan);
        if (member !== undefined) nominate({ term: clean(member), spelling: member, proper: false }, use, true);
        // A body opened by an exported type (or a top-level Python class) holds declared fields until it closes at the margin.
        if (scan?.opens.test(observed)) exported = true;
        else if (scan?.closes.test(observed)) exported = false;
        continue;
      }
      if (f.kind === "data") continue;
      if (f.kind === "prose" && /^\s*(```|~~~)/.test(observed)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const texts = f.kind === "record" ? recordProse(observed) : [observed];
      // Words inside a known multi-word name on this line are that name's ("order" in "work order"), not another candidate's.
      // Only the phrases this line's own words start can be on it: a plural changes the last word, never the first.
      const inside = new Set(
        candidates
          .map((i) => phrases[i]!)
          .filter((p) => p.includes(" ") && writes(p, true))
          .flatMap((p) => p.split(" ").flatMap((w) => [w, w + "s", w + "es"])),
      );
      const runs: Word[][] = [];
      for (const text of texts) {
        const heading = f.kind === "prose" && /^#{1,6}\s/.test(text);
        for (const nomination of proseNominations(text, heading))
          if (!(heading && inside.has(nomination.term))) nominate(nomination, use);
        runs.push(...wordRuns(text));
      }
      for (const run of runs)
        for (let i = 0; i < run.length; i++)
          if (inside.has(run[i]!.lower)) run[i] = { lower: "", original: "" };
      proseLines.push({ use, runs });
    }
  }
  countWork("phrase comparison", comparisons);
  for (const c of components)
    if (c !== ".") {
      const folder = c.split("/").at(-1)!;
      nominate({ term: clean(folder), spelling: folder, proper: false }, {
        file: c,
        line: 0,
        component: c,
        text: "Declared component folder",
        kind: "component",
        fingerprint: digest(c),
      });
    }
  // Each file's contribution, taken before the plural merge: a kept reading merges its own way (vocabulary-state.ts).
  const contributions = new Map<string, Contribution>();
  const contributionOf = (file: string, component: string): Contribution => {
    const found = contributions.get(file);
    if (found !== undefined) return found;
    const made: Contribution = { component, pool: {}, words: {}, uses: [] };
    contributions.set(file, made);
    return made;
  };
  if (scope.contributions === true) {
    for (const f of corpus.files) contributionOf(f.rel, componentFor(f.rel));
    for (const [term, entry] of pool)
      for (const site of entry.sites) {
        const c = contributionOf(site.file, site.component);
        const stats = (c.pool[term] ??= { named: 0, code: 0, sites: 0, declared: false });
        stats.sites += 1;
        if (site.kind === "prose" || site.kind === "record") stats.named += 1;
        if (site.kind === "code") stats.code += 1;
        if (declaredBy.get(term)?.has(site.file) === true) stats.declared = true;
      }
    for (const [term, list] of uses) for (const u of list) contributionOf(u.file, u.component).uses.push(`${term}\t${digest(u.text)}`);
  }
  // A plural nominated beside its singular is the singular's.
  const canonical = new Map<string, string>();
  for (const term of pool.keys()) {
    const words = term.split(" ");
    const one = singular(words.at(-1)!).map((s) => [...words.slice(0, -1), s].join(" ")).find((s) => pool.has(s));
    canonical.set(term, one ?? term);
  }
  for (const [term, into] of canonical)
    if (into !== term) {
      const from = pool.get(term)!;
      const to = pool.get(into)!;
      to.proper ||= from.proper;
      to.declared ||= from.declared;
      for (const s of from.spellings) to.spellings.add(s);
      for (const site of from.sites)
        if (!to.siteKeys.has(`${site.file}\n${site.line}`)) {
          to.siteKeys.add(`${site.file}\n${site.line}`);
          to.sites.push(site);
        }
      pool.delete(term);
    }
  // A declared name recurs wherever prose writes it as words, plural included; a well-known capitalized spelling is not a use.
  for (const line of proseLines) {
    const seen = new Set<string>();
    for (const run of line.runs)
      for (let i = 0; i < run.length; i++)
        for (let size = 1; size <= 3 && i + size <= run.length; size++) {
          const words = run.slice(i, i + size);
          if (words.some((w) => w.lower === "")) break;
          const last = words.at(-1)!.lower;
          const head = words.slice(0, -1).map((w) => w.lower);
          // A reading of a few files also counts the names code declares elsewhere: the kept reading holds where.
          const key = [last, ...singular(last)].map((w) => [...head, w].join(" ")).find((k) => pool.get(k)?.declared || scope.declared?.has(k));
          if (key === undefined || seen.has(key)) continue;
          if (isWellKnown(famous, key, words.map((w) => w.original).join(" "))) continue;
          seen.add(key);
          if (scope.contributions === true) {
            const c = contributionOf(line.use.file, line.use.component);
            c.words[key] = (c.words[key] ?? 0) + 1;
          }
          pool.get(key)?.words.push(line.use);
        }
  }
  const candidates = new Map<string, { uses: VocabularyUse[]; prose: number; components: number }>();
  for (const [term, entry] of pool) {
    // Written as a name (backticked, Title Case, a heading): the unknown-noun check's sense of a use.
    const named = entry.sites.filter((u) => u.kind === "prose" || u.kind === "record");
    const namedSpread = new Set(entry.sites.map((u) => u.component)).size;
    // Declared in code and written as words in prose: the vocabulary the code and the documents share.
    const wordSpread = new Set([...entry.words, ...entry.sites.filter((u) => u.kind === "code")].map((u) => u.component)).size;
    const byName = named.length >= 3 || (named.length >= 2 && namedSpread >= 2);
    const byWord = entry.declared && entry.words.length >= 10 && wordSpread >= 4;
    if (!byName && !byWord) continue;
    const all = [...entry.sites];
    for (const u of entry.words) if (!entry.siteKeys.has(`${u.file}\n${u.line}`)) all.push(u);
    const prose = all.filter((u) => u.kind === "prose" || u.kind === "record").length;
    candidates.set(term, { uses: all, prose, components: new Set(all.map((u) => u.component)).size });
  }
  for (const [term, found] of candidates) for (const u of found.uses) add(term, u);
  const decisions = scope.rulings === false ? new Map<string, { disposition: string; because: string }>() : rulings(root);
  // A name refused for this very concept, written on or beside a line that uses the concept: the writer may be mixing the two.
  const near = (list: VocabularyUse[], concept: string): string | undefined => {
    for (const u of list) {
      const byLine = rejectedLines.get(u.file);
      if (!byLine) continue;
      for (let d = -1; d <= 1; d++) {
        const name = byLine.get(u.line + d)?.find((r) => rejected.get(r)?.concept === concept);
        if (name) return `beside "${name}", a name rejected for ${concept}, at ${u.file}:${u.line + d}`;
      }
    }
    return undefined;
  };
  const terms: VocabularyTerm[] = [...uses]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([term, locations]) => {
      locations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      const candidate = candidates.get(term);
      const item = candidate ? undefined : knownMeaning(term, known);
      const refused = candidate ? undefined : rejected.get(term);
      const original = item?.concept
        ? rawEntries.get(item.layer + ":" + item.concept.name)
        : undefined;
      const alternatives = item?.propertyOwners?.map((owner) => ({
        concept: owner.concept.name,
        layer: owner.layer,
        definition: owner.concept.definition,
        properties: (rawEntries.get(owner.layer + ":" + owner.concept.name)?.["properties"] as Record<string, unknown> | undefined) ?? owner.concept.properties,
        confusables: owner.concept.notToBeConfusedWith,
      }));
      const fingerprint = digest({
        term,
        concept: original ?? item?.concept ?? null,
        layer: item?.layer ?? null,
        propertyOwners: alternatives ?? null,
        rejected: refused ?? null,
      });
      const recorded = senses.get(term);
      const multiple =
        alternatives && alternatives.length > 1
          ? `more than one recorded sense: ${alternatives.map((a) => `${a.concept} (${a.layer})`).join(", ")}`
          : recorded && recorded.size > 1
            ? `more than one recorded sense: ${[...recorded].join(", ")}`
            : undefined;
      // Why a context's sense is at risk, and whether that reason is the declared sense alone, whose ruling is keyed to the term and component.
      const atRisk = (here: VocabularyUse[]): { risk: string; declared: boolean } | undefined => {
        if (candidate || refused || !item || (!item.concept && !alternatives?.length)) return undefined;
        if (multiple) return { risk: multiple, declared: false };
        const beside = item.concept ? near(here, item.concept.name) : undefined;
        if (beside) return { risk: beside, declared: false };
        // In an adopter a Coherence name its code declares is the project's sense: at risk only where Coherence's grammar writes it too.
        if (!own && project && item.layer === "coherence") {
          const declared = declarations.get(term)?.[0];
          const written = declared ? here.find((u) => grammarOf.get(u)?.includes(" " + term + " ")) : undefined;
          if (declared && written)
            return { risk: `declared in this project's code (${declared.file}:${declared.line}) with its own sense, and written in text Coherence reads as its own (${written.file}:${written.line}), where the definition is Coherence's`, declared: true };
        }
        return undefined;
      };
      const contexts = [...new Set(locations.map((u) => u.component))]
        .sort()
        .map((component) => {
          const here = locations.filter((u) => u.component === component);
          const risk = atRisk(here);
          // Content, not line numbers, identifies a context; moving a line does not erase a human's answer.
          // A declared sense is one question per term and component, whichever uses raise it: a new use does not reopen its ruling.
          const evidence = risk?.declared
            ? digest({ fingerprint, component, declared: term })
            : digest({
                fingerprint,
                component,
                uses: [...new Set(here.map((u) => u.fingerprint + ":" + u.text))].sort(),
              });
          const ruling = decisions.get(evidence);
          return {
            component,
            fingerprint: evidence,
            disposition: ruling?.disposition ?? "unreviewed",
            because: ruling?.because ?? null,
            ...(risk ? { risk: risk.risk } : {}),
          };
        });
      return {
        term,
        state: candidate ? "unresolved" : refused ? "rejected" : (item?.state ?? "unresolved"),
        concept: item?.concept?.name ?? refused?.concept ?? null,
        layer: item?.layer ?? null,
        definition: item?.concept?.definition ?? null,
        properties:
          (original?.["properties"] as Record<string, unknown> | undefined) ??
          item?.concept?.properties ??
          {},
        confusables: item?.concept?.notToBeConfusedWith ?? [],
        ...(alternatives && alternatives.length > 1 ? { meaningAlternatives: alternatives } : {}),
        ...(candidate ? { recurrence: { prose: candidate.prose, components: candidate.components } } : {}),
        fingerprint,
        count: locations.length,
        uses: locations,
        contexts,
      };
    });
  const population: Coverage["population"] = {
    files: read
      .map((f) => ({ file: f.rel, kind: f.kind, lines: f.lines.length }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    ...(paths ? { paths: [...paths] } : {}),
    ...(scope.files !== undefined ? { named: [...scope.files] } : {}),
    // A narrowed reading reports what was left out under its paths, and any excluded folder a path lies inside.
    excluded: corpus.excluded
      .filter((e) => underPaths(e.file, paths) || (paths ?? []).some((p) => p.startsWith(e.file + "/")))
      .sort((a, b) => a.file.localeCompare(b.file)),
    unreadable: corpus.unreadable.filter((u) => underPaths(u.file, paths)),
    extraction:
      `Exact declared phrases in every kind. Candidates: from code, declared and exported names and the fields of exported types only; from prose and records, Title Case away from a sentence start, heading words, and single backticked words; declared component folders. A candidate stands only when prose writes it as a name on three lines, or on two across two components, or, for a name code declares (fields of exported types included), when prose writes it as words on ten lines across four components. Never candidates: ids, paths, fragments, punctuation-bearing tokens, general English and programming words, well-known names (list version ${famous.version}, the config's wellKnown, the project's own name), and names the lexicon declares or lists under "not:".`,
    limits: [
      "No exhaustive extraction or automatic proof of meaning.",
      "SQL/data/notebook bodies are text, not resolved language symbols; unsupported/binary files and symlinks are reported as excluded.",
      "Sense review is asked only where meaning is at risk: more than one recorded sense, a use on or beside a line with a name rejected for that concept, or a Coherence concept the project's code declares with its own sense written in a record or a spec's or practice's grammar. A matched spelling elsewhere is not a confirmed meaning either.",
      "Unknowns and deferred reviews are not covered. Journal review decisions do not nominate themselves.",
      "Totals are population facts about this reading, not a to-do count.",
    ],
  };
  const coverage: Coverage = {
    version: 1,
    projectLexicon: project?.path ?? (own ? coherence.path : null),
    fingerprint: digestAll([population.extraction, ...population.limits, ...population.files, ...population.excluded, ...population.unreadable, ...terms]),
    population,
    terms,
    totals: {
      terms: terms.length,
      uses: terms.reduce((n, t) => n + t.count, 0),
      known: terms.filter((t) => !["unresolved", "rejected"].includes(t.state))
        .length,
      rejected: terms.filter((t) => t.state === "rejected").length,
      unresolved: terms.filter((t) => t.state === "unresolved").length,
      unreviewedContexts: terms.reduce((n, t) => n + t.contexts.filter(awaitsReview).length, 0),
    },
  };
  return { coverage, contributions };
}

/* -------------------------------------------------------------- attention */

export interface Attention {
  /** Recurring terms that lack a definition, most recurring first; a term every context dismissed is gone. */
  undefinedTerms: { term: string; prose: number; components: number; first: string; fingerprint: string }[];
  /** Uses whose sense is at risk and no review has settled. */
  senses: { term: string; component: string; reason: string; evidence: string; state: string }[];
}

/** What a sense review may rule about a context. */
export const DISPOSITIONS = ["confirmed", "not-domain", "deferred", "defect"] as const;
/** The rulings that settle a context: confirmed in the concept's sense, or dismissed as not the domain's word. */
const SETTLING: ReadonlySet<string> = new Set<(typeof DISPOSITIONS)[number]>(["confirmed", "not-domain"]);

/** Whether a review has settled a context: confirmed in the concept's sense, or dismissed as not the domain's word. */
export function isSettled(disposition: string): boolean {
  return SETTLING.has(disposition);
}

/**
 * Whether a context awaits sense review: its sense is at risk and no review
 * has confirmed or dismissed it. An ordinary use of a defined word carries no
 * risk and awaits nothing, whatever its disposition says. The one rule
 * coverage, Scope and the agent query count a review by.
 */
export function awaitsReview(context: VocabularyContext): boolean {
  return context.risk !== undefined && !isSettled(context.disposition);
}

/** The short ranked signal a reader can act on: which names to define, and which uses to check. */
export function attention(report: Coverage): Attention {
  const undefinedTerms = report.terms
    .filter((t) => t.state === "unresolved" && t.recurrence !== undefined && !t.contexts.every((c) => isSettled(c.disposition)))
    .map((t) => ({
      term: t.term,
      prose: t.recurrence!.prose,
      components: t.recurrence!.components,
      first: ((u) => (u ? `${u.file}:${u.line}` : ""))(t.uses.find((u) => u.kind === "prose" || u.kind === "record") ?? t.uses[0]),
      fingerprint: t.fingerprint,
    }))
    .sort((a, b) => b.prose * b.components - a.prose * a.components || b.prose - a.prose || a.term.localeCompare(b.term));
  const senses = report.terms
    .flatMap((t) =>
      t.contexts
        .filter(awaitsReview)
        .map((c) => ({ term: t.term, component: c.component, reason: c.risk!, evidence: c.fingerprint, state: t.state })),
    )
    .sort((a, b) => a.term.localeCompare(b.term) || a.component.localeCompare(b.component));
  return { undefinedTerms, senses };
}

function listed(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The ranked short list as one or two lines, or nothing at all when nothing
 * is owed. Never a total: a number nobody can act on trains a reader to skip
 * the line.
 */
export function attentionText(report: Coverage, cli = "coherence", limit = 5): string {
  const { undefinedTerms, senses } = attention(report);
  const lines: string[] = [];
  if (undefinedTerms.length > 0) {
    const shown = undefinedTerms.slice(0, limit).map((t) => t.term);
    const head =
      undefinedTerms.length <= limit
        ? `${undefinedTerms.length === 1 ? "A recurring term lacks" : `${undefinedTerms.length} recurring terms lack`} a definition: ${listed(shown)}.`
        : `Recurring terms that lack a definition, most recurring first: ${shown.join(", ")}; the rest: ${cli} lexicon coverage.`;
    lines.push(`${head} Declare each (${cli} lexicon propose declare <term> --definition "<text>" --because "<why>") or map it as an alias of an existing concept.`);
  }
  if (senses.length > 0) {
    // One entry per term: the same risk in five components is one thing to check, named once.
    const byTerm = new Map<string, { reason: string; components: string[] }>();
    for (const s of senses) {
      const entry = byTerm.get(s.term) ?? { reason: s.reason, components: [] };
      entry.components.push(s.component);
      byTerm.set(s.term, entry);
    }
    const shown = [...byTerm].slice(0, 3).map(([term, e]) => `${term} in ${e.components.slice(0, 2).join(", ")}${e.components.length > 2 ? " and elsewhere" : ""} (${e.reason})`);
    lines.push(`Sense at risk: ${shown.join("; ")}${byTerm.size > 3 ? `; the rest: ${cli} lexicon coverage` : ""}. Check each use against the definition: ${cli} lexicon review <term>.`);
  }
  return lines.join("\n");
}

/** The line that says which paths a narrowed reading read, and how many files it found under them. */
export function readLine(report: Coverage): string {
  const paths = report.population.paths ?? [];
  const n = report.population.files.length;
  return `Read only under ${paths.map((p) => p || ".").join(", ")}: ${n} ${n === 1 ? "file" : "files"}.`;
}

export function coverageText(
  report: Coverage,
  term?: string,
  live?: { uses: VocabularyUse[]; total: number },
): string {
  if (term) {
    const entries = report.terms.filter(
      (t) => t.term === clean(term) || clean(t.concept ?? "") === clean(term),
    );
    const below =
      live && live.total > 0
        ? [
            `"${term}" is written on ${live.total} ${live.total === 1 ? "line" : "lines"}, below the recurrence a candidate needs; its live uses:`,
            ...live.uses.map((u) => `  ${u.file}:${u.line} ${u.text}`),
            ...(live.total > live.uses.length ? [`  ${live.total - live.uses.length} more in --json.`] : []),
          ]
        : [`No observed use of "${term}" in this reading.`];
    return [
      ...(entries.length ? [] : below),
      ...entries.flatMap((t) => [
        `${t.term} [${t.state}${t.concept ? "; " + t.concept : ""}] ${t.count} uses${t.recurrence ? `; recurs on ${t.recurrence.prose} prose lines across ${t.recurrence.components} components` : ""}`,
        t.definition ?? "No settled definition.",
        `  properties: ${JSON.stringify(t.properties)}; confusables: ${t.confusables.join("; ") || "none declared"}`,
        ...(t.meaningAlternatives ? t.meaningAlternatives.map((meaning) => `  applicable property meaning: ${meaning.concept} (${meaning.layer}) — ${meaning.definition}; properties ${JSON.stringify(meaning.properties)}`) : []),
        ...t.contexts.map(
          (c) =>
            `  ${c.component}: ${c.disposition}${c.risk ? `; sense at risk: ${c.risk}` : ""}; evidence ${c.fingerprint}`,
        ),
        ...t.uses.map((u) => `  ${u.file}:${u.line} ${u.text}`),
      ]),
      ...report.population.limits,
    ].join("\n");
  }
  const { undefinedTerms, senses } = attention(report);
  const lead = attentionText(report, "coherence", 5);
  return [
    ...(report.population.paths ? [readLine(report), ""] : []),
    lead === "" ? "No recurring term lacks a definition, and no use's sense is at risk." : lead,
    ...(undefinedTerms.length
      ? ["", "Recurring terms without a definition (prose lines, components, first prose use):",
          ...undefinedTerms.slice(0, 40).map((t) => `  ${t.term}: ${t.prose} prose lines, ${t.components} components; ${t.first}`),
          ...(undefinedTerms.length > 40 ? ["  More in --json."] : [])]
      : []),
    ...(senses.length
      ? ["", "Senses at risk (term in component: why; evidence key for lexicon review):",
          ...senses.slice(0, 40).map((s) => `  ${s.term} in ${s.component}: ${s.reason}; evidence ${s.evidence}`),
          ...(senses.length > 40 ? ["  More in --json."] : [])]
      : []),
    "",
    "Every observed term, use and population fact: lexicon coverage --json; one term whole: lexicon review <term>.",
    ...report.population.limits,
  ].join("\n");
}
