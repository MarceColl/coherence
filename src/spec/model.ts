/**
 * The model: every spec under a root, read into components, trust levels,
 * and invariants with their lifecycle state.
 *
 * A component is any folder with a spec file; nesting follows the folders,
 * with folders that hold no spec transparent. The entry component (the
 * config's entryDir, else the root) declares the trust levels crossings
 * name. Cross-spec facts are checked here: crossings against trust levels,
 * declared-as names against the invariants that exist, names unique within
 * a component, an entrance's declared trust against the declared levels and
 * against the crossings on its handler. State is derived from what the
 * bullet carries and, when runs exist under .coherence/runs, from the latest
 * run that checked each enforcement; with no run every enforcement reports as
 * declared, unverified.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { countWork, readProjectText, spawnSync } from "../lifecycle/work-meter.ts";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { MODEL_LINE_FORM, isModuleHandler, parseSpec, type Entrance, type Invariant, type ModelLine, type Problem, type TrustLevel } from "./grammar.ts";
import { applicableShapes, loadSeed, type Seed } from "./seed.ts";
import { creditedByCrossingAlone, crossingChecksTrust, resolveCovered } from "./covers.ts";
import { entryKey, latestByEnforcement, latestFor, loadRuns, parseLine as parseRunLine, witnessedRefutations, type Latest, type LoadedRuns, type RunRecord } from "../enforcement/record.ts";
import { latestSeeing } from "../enforcement/run-index.ts";
import { deriveState, type Lack, type State } from "./state.ts";
import { exclusionOf, projectFilesEnding, walkBounds, walkedProjectFiles, type Walked } from "../adapters/project-files.ts";
import { configuredName, effectiveConfig, lexiconFileOf, readConfigFile } from "../adapters/project-config.ts";
import { PRACTICE_SUFFIX, parsePractices } from "./practice.ts";
import { invariantFloorGaps, invariantFloorProblems, rawFloorGaps } from "./floor.ts";
import { declaredClasses, declaredFamilies, defectFloor, defectStates, type DefectFloor, type GuardStanding } from "../journal/defects.ts";
import { kernelPractices, enactmentsIn, isCoherenceTree, journalRecords, modelPractice, practiceProblems, stemOf, type ModelPractice } from "./practices.ts";

export const SPEC_SUFFIX = ".spec.md";
export const CONFIG_FILE = "coherence.config.json";
/** The suffix of a quint model a spec names on its model: line. */
export const QUINT_SUFFIX = ".qnt";

/**
 * The project files the spec model finds by their names, each kind by the
 * suffix that marks it. The model's walk selects its specs and practice files
 * through modelFileKind, and so does every watcher that refreshes what the
 * model drew, so a kind of file the model begins to read is watched with it.
 */
export const MODEL_FILES = { spec: SPEC_SUFFIX, practice: PRACTICE_SUFFIX, quint: QUINT_SUFFIX } as const;

export type ModelFileKind = keyof typeof MODEL_FILES;

/** Which of the model's files a path is, by its name, or undefined when the model's walk never reads it. */
export function modelFileKind(rel: string): ModelFileKind | undefined {
  return (Object.keys(MODEL_FILES) as ModelFileKind[]).find((kind) => rel.endsWith(MODEL_FILES[kind]));
}

/** Whether the spec model reads this project path: one of its files by name, or the config. */
export function readByModel(rel: string): boolean {
  return modelFileKind(rel) !== undefined || rel === CONFIG_FILE;
}

export interface ModelInvariant extends Invariant {
  /** The folder of the component the bullet lives in. */
  component: string;
  /** The checklist shapes the bullet's kinds make applicable. */
  applicable: string[];
  /** Applicable shapes with no declared or dismissed line. */
  missingShapes: string[];
  state: State;
  lacks: Lack[];
  /** The latest run entry per form that checked this bullet; empty when no run has. */
  latest: Latest[];
  /** Enforcements the latest run found passing. */
  verified: Latest[];
  /** Enforcements the latest run found failing: the structural defects. */
  defects: Latest[];
}

export interface Component {
  /** Relative to the root, with "." for the root itself. */
  folder: string;
  name: string;
  specPath: string;
  intent: string;
  /** Who owns it, as the spec's owners: line declares; absent when it declares none. Declared, never routed on. */
  owners?: string[];
  /** The spec's model: line, with a named file resolved project-relative; absent when the spec has none. */
  model?: ComponentModel;
  trustLevels: TrustLevel[] | undefined;
  /** Where work enters through this component, as its spec declares; each handler was found declared in the code. */
  entrances: ModelEntrance[];
  invariants: ModelInvariant[];
  /** The practice file paired with the spec, when there is one. */
  practicePath: string | undefined;
  /** The component's practices, from its practice file. */
  practices: ModelPractice[];
  parent: string | undefined;
  children: string[];
}

/** A component's model: line as the model reads it: a named file carries its project-relative path, set only when the file exists. */
export type ComponentModel = ModelLine & { path?: string };

export interface ModelEntrance extends Entrance {
  /** The folder of the component whose spec declares it. */
  component: string;
  /** The project-relative file whose top level declares the handler, when one was found. */
  file: string | undefined;
}

export interface Counts {
  components: number;
  bullets: number;
  invariants: number;
  requirements: number;
  structuralDefects: number;
  lacking: Record<Lack, number>;
  unfilled: number;
  problems: number;
}

export interface SpecModel {
  root: string;
  /** The entry component's folder, when a spec is there. */
  entry: string | undefined;
  trustLevels: TrustLevel[];
  components: Component[];
  problems: Problem[];
  counts: Counts;
  /**
   * When runs exist: the time of the latest, how many run lines were
   * unreadable, and the time of the latest full run (every bullet, both
   * forms, graded) dated no later than now, undefined when none is.
   */
  runs: { latest: string; count: number; damaged: number; graded: string | undefined } | undefined;
  /** The floor on defects: closes with neither a guard nor a decision, and guard failures; advisory, never a problem. */
  defects?: DefectFloor;
  /** The entrances an invariant covered by its crossing alone and no longer does, until it names them (covers.ts); advisory, never a problem. Absent when none. */
  crossingAlone?: CrossingAloneCredit[];
  /** Specs with no model: line in a project that has begun naming models but does not require them (config models unset); advisory, never a problem. Absent when none. */
  unmodelled?: Problem[];
  /** A project lexicon's stored project field that disagrees with the config's name; advisory, never a problem: the config's name is the one read, and an earlier release wrote the stored one. Absent when they agree. */
  storedName?: Problem;
}

interface Config {
  ignore: string[];
  entryDir: string;
  /** Whether every spec must carry a model: line (the config's models key); a project that never set it is never asked. */
  models: boolean;
}

function readConfig(root: string): Config {
  const config: Config = { ignore: [], entryDir: ".", models: false };
  // The project's own config over its registry's keys (project-config.ts); a malformed file is refused with its path.
  const found = effectiveConfig(root);
  if (found === undefined) return config;
  const record = found.record;
  if (Array.isArray(record["ignore"])) config.ignore = record["ignore"].filter((v): v is string => typeof v === "string");
  if (typeof record["entryDir"] === "string") config.entryDir = record["entryDir"];
  config.models = modelsRequired(record["models"]);
  return config;
}

/** The config's models key read: true, or an object whose required is true, asks every spec for its model: line. */
export function modelsRequired(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)["required"] === true;
}

/**
 * A model: line's file, resolved: beside the spec (the component's folder),
 * confined to the project; a path that climbs out, or a file that does not
 * exist, is the reason. The file is the model the component's quint props
 * and conformance replay read.
 */
export function resolveModelFile(root: string, folder: string, file: string): string | { reason: string } {
  const rel = (folder === "." ? file : `${folder}/${file}`).replace(/^\.\//, "");
  if (file.startsWith("/") || rel.split("/").includes("..")) return { reason: `model: ${file} climbs out of the component; name a .qnt file beside the spec or under its folder` };
  const at = resolve(root, rel);
  if (!existsSync(at) || !statSync(at).isFile()) return { reason: `model: ${file} does not exist beside the spec (read at ${rel}); write the model, or say ${MODEL_LINE_FORM.replace(/^model: <file>\.qnt, /, "")}` };
  return rel;
}

/**
 * The project's own ignore entries that name nothing: no file or folder at
 * that path from the root, for a bare name no folder of that name on any
 * project file's way down, and nothing git ignores by it. Such an entry
 * leaves nothing out, so a typo or a path that moved would bound nothing and
 * say nothing. An entry git ignores (dist, build: output absent from a fresh
 * checkout, or present only in a package) bounds that output whenever it
 * exists, so it is no typo. A registry's entries are its own to check; only
 * the project's file is read. The walk the model already took answers, and
 * git is asked once, only when some entry names nothing there.
 */
function ignoreProblems(root: string, walked: Walked): Problem[] {
  const path = join(root, CONFIG_FILE);
  const own = readConfigFile(path)?.["ignore"];
  if (!Array.isArray(own)) return [];
  let folders: Set<string> | undefined;
  const folderSet = (): Set<string> =>
    (folders ??= new Set([...walked.files, ...walked.excluded.map((e) => e.file)].flatMap((rel) => rel.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/")))));
  const missing: { entry: string; key: string }[] = [];
  for (const entry of own) {
    if (typeof entry !== "string") continue;
    const key = entry.split(sep).join("/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (key === "" || existsSync(join(root, key))) continue;
    if (!key.includes("/") && [...folderSet()].some((folder) => folder === key || folder.endsWith("/" + key))) continue;
    missing.push({ entry, key });
  }
  if (missing.length === 0) return [];
  const ignored = gitIgnoredEntries(root, missing.map((m) => m.key), folderSet());
  const text = readFileSync(path, "utf8").split("\n");
  return missing
    .filter((m) => !ignored.has(m.key))
    .map(({ entry }) => ({
      file: CONFIG_FILE,
      line: Math.max(text.findIndex((line) => line.includes(JSON.stringify(entry))) + 1, 1),
      message: `ignore entry "${entry}" names no file or folder in the project and nothing git ignores, so it leaves nothing out: a typo, or a path that moved? A folder is named by its name or its path from the root, a file by its path from the root`,
    }));
}

/**
 * The entries git ignores, asked in one git check-ignore: a path entry as a
 * file and as a folder at its path, a bare name as a folder at the root and
 * under every folder the project holds (a package's own .gitignore). Outside
 * a repository nothing is ignored.
 */
function gitIgnoredEntries(root: string, keys: readonly string[], folders: ReadonlySet<string>): Set<string> {
  const asked = new Map<string, string>();
  for (const key of keys) {
    const at = key.includes("/") ? [key] : [key, ...[...folders].map((folder) => `${folder}/${key}`)];
    for (const candidate of at) for (const spelled of [candidate, candidate + "/"]) asked.set(spelled, key);
  }
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: root, encoding: "utf8", input: [...asked.keys()].join("\n") + "\n" });
  // 0: some ignored, 1: none; anything else (no repository) leaves every entry reported.
  if (result.status !== 0) return new Set();
  return new Set(String(result.stdout).split("\n").filter((line) => line !== "").map((line) => asked.get(line)).filter((key): key is string => key !== undefined));
}

/**
 * A project lexicon whose stored project field disagrees with the name the
 * config gives: the config's name is the one every reader takes
 * (projectName), so the stored one is a second copy that has drifted. It is
 * advisory, never a problem: lexicon apply wrote that field until #67, so an
 * adopter upgrading carries it without having done anything, and a copy no
 * reader takes changes no answer (df-be527a7b). A lexicon that will not parse
 * is the lexicon check's to refuse.
 */
function storedNameProblems(root: string): Problem[] {
  const name = configuredName(root);
  if (name === undefined) return [];
  let path: string;
  let stored: unknown;
  try {
    path = lexiconFileOf(root);
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    stored = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["project"] : undefined;
  } catch {
    return [];
  }
  if (typeof stored !== "string" || stored.trim().toLowerCase() === name.toLowerCase()) return [];
  const line = readFileSync(path, "utf8").split("\n").findIndex((text) => text.includes('"project"')) + 1;
  return [{ file: relative(root, path).split(sep).join("/"), line: Math.max(line, 1), message: `the lexicon stores project "${stored}" and the config names the project "${name}"; the config's name is the one read, so drop the lexicon's project field or make it agree` }];
}

/** Every spec file under the root, sorted by path. */
export function findSpecs(root: string, ignore: readonly string[] = []): string[] {
  return walkedFiles(root, ".", ignore).filter((rel) => rel.endsWith(SPEC_SUFFIX)).map((rel) => join(root, rel)).sort();
}

/**
 * The project's own files under a folder that the walk reads
 * (walkedProjectFiles), project-relative: a spec in a nested checkout is
 * another tree's component, and its source is not this project's.
 */
function walkedFiles(root: string, folder: string, ignore: readonly string[]): string[] {
  const prefix = folder === "." || folder === "" ? "" : folder.replace(/\/+$/, "") + "/";
  return walkedProjectFiles(walkBounds(root, ignore)).files.filter((rel) => rel.startsWith(prefix));
}

function folderOf(root: string, specPath: string): string {
  const rel = relative(root, dirname(specPath));
  return rel === "" ? "." : rel.split(sep).join("/");
}

/** The nearest ancestor folder among the component folders, or undefined at the top. */
function parentOf(folder: string, folders: ReadonlySet<string>): string | undefined {
  if (folder === ".") return undefined;
  let current = folder;
  for (;;) {
    const up = dirname(current);
    const candidate = up === "." || up === "" ? "." : up;
    if (folders.has(candidate)) return candidate;
    if (candidate === ".") return undefined;
    current = candidate;
  }
}

/** One chokepoint invariant as the check at an edit reads it: its component, its enforcements, and the files its latest run saw. */
export interface ChokepointEntry {
  component: string;
  name: string;
  enforcements: Invariant["enforcements"];
  latest: { form: "chokepoint"; files: string[]; language?: string }[];
}

/**
 * Every chokepoint invariant in the project, the light way an edit can
 * afford: each spec the spec model would read, read and parsed (specs are
 * small; nothing of them is kept between calls), with no state derived and
 * no practice, handler or journal read; and, for each of `written`, whether
 * an invariant's latest run saw it, from the run index (run-index.ts). Throws
 * when a spec or the index cannot be read; the caller falls back to the
 * whole model and says so. An edit that touches an invariant runs the check
 * over these entries alone.
 */
export function chokepointIndex(rootGiven: string, written: readonly string[] = []): ChokepointEntry[] {
  const root = resolve(rootGiven);
  const config = readConfig(root);
  const seeing = written.length === 0 ? undefined : latestSeeing(root, written, parseRunLine);
  const entries: ChokepointEntry[] = [];
  const seen = new Set<string>();
  // The specs findSpecs would find, from a listing of the specs alone.
  const bounds = walkBounds(root, config.ignore);
  const specs = projectFilesEnding(root, SPEC_SUFFIX).filter((rel) => exclusionOf(rel, bounds) === undefined).map((rel) => join(root, rel));
  // No spec from the light listing is a claim to check, never an answer: a listing that matched nothing it should have
  // (a pathspec read another way) would leave every edit unchecked. The walk the spec model reads decides.
  if (specs.length === 0 && findSpecs(root, config.ignore).length > 0) throw new Error("the listing of the specs found none where the project holds some");
  for (const specPath of specs) {
    const folder = folderOf(root, specPath);
    // A folder holds one spec, as the model reads it: a second is a problem there, and nothing here.
    if (seen.has(folder)) continue;
    seen.add(folder);
    const rel = relative(root, specPath).split(sep).join("/");
    for (const invariant of parseSpec(readProjectText(specPath, "spec"), rel).invariants) {
      if (!invariant.enforcements.some((e) => e.form === "chokepoint")) continue;
      const key = entryKey(folder, invariant.name, "chokepoint");
      // The latest run's whole file list and its language, as the model carries them: the run of a touched invariant asks that language first.
      const last = seeing?.latest.get(key);
      entries.push({ component: folder, name: invariant.name, enforcements: invariant.enforcements, latest: last === undefined ? [] : [{ form: "chokepoint", files: last.files, ...(last.language === undefined ? {} : { language: last.language }) }] });
    }
  }
  return entries;
}

export interface LoadOptions {
  seed?: Seed | undefined;
  /** Read .coherence/runs and derive run-informed state (default true). */
  runs?: boolean | undefined;
  /** A run not yet appended, read in as the latest: the run grades each entry's bullet with it before it writes. */
  pending?: RunRecord | undefined;
}

export function loadSpecModel(rootGiven: string, options: LoadOptions = {}): SpecModel {
  countWork("spec model");
  const root = resolve(rootGiven);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${root}: not a folder`);
  const seed = options.seed ?? loadSeed();
  const config = readConfig(root);
  const problems: Problem[] = [];
  const loadedRuns: LoadedRuns = options.runs === false ? { records: [], refutations: [], damaged: [] } : loadRuns(root);
  if (options.pending !== undefined) loadedRuns.records.push(options.pending);
  const latest = latestByEnforcement(loadedRuns.records);
  // A totality oracle's refutation is witnessed by the record, never by the bullet's own refuted: line.
  const witnessed = witnessedRefutations(loadedRuns.records, loadedRuns.refutations);
  const runs =
    loadedRuns.records.length === 0
      ? undefined
      : {
          latest: loadedRuns.records[loadedRuns.records.length - 1]!.at,
          count: loadedRuns.records.length,
          damaged: loadedRuns.damaged.length,
          // Only a full run moves the floor for every bullet; a run dated in the future (a skewed clock, a hand-written line) says nothing of now.
          graded: loadedRuns.records
            .filter((record) => record.full === true && record.invariants.some((entry) => entry.ungraded !== true) && Date.parse(record.at) <= Date.now())
            .reduce<string | undefined>((at, record) => (at === undefined || record.at > at ? record.at : at), undefined),
        };

  // One walk of the project serves the specs, the practice files and the ignore list's check.
  const walked = walkedProjectFiles(walkBounds(root, config.ignore));
  problems.push(...ignoreProblems(root, walked));
  const storedName = storedNameProblems(root)[0];
  const byFolder = new Map<string, { folder: string; specPath: string; parsed: ReturnType<typeof parseSpec> }>();
  for (const specPath of walked.files.filter((rel) => modelFileKind(rel) === "spec").map((rel) => join(root, rel)).sort()) {
    const folder = folderOf(root, specPath);
    const rel = relative(root, specPath).split(sep).join("/");
    const existing = byFolder.get(folder);
    if (existing !== undefined) {
      problems.push({ file: rel, line: 1, message: `a folder holds one spec; ${existing.specPath} is already this component's` });
      continue;
    }
    const parsed = parseSpec(readProjectText(specPath, "spec"), rel, { seed });
    problems.push(...parsed.problems);
    byFolder.set(folder, { folder, specPath: rel, parsed });
  }

  // A practice file stands beside its folder's spec, with the spec's stem (d-861e8319).
  const practiceFiles = new Map<string, { file: string; parsed: ReturnType<typeof parsePractices> }>();
  for (const rel of walked.files.filter((f) => modelFileKind(f) === "practice").sort()) {
    const folder = folderOf(root, join(root, rel));
    const spec = byFolder.get(folder);
    if (spec === undefined) {
      problems.push({ file: rel, line: 1, message: `a practice file is paired with a spec; ${folder === "." ? "the root" : folder} has none (a spec and its practice file are always paired)` });
      continue;
    }
    if (stemOf(rel) !== stemOf(spec.specPath)) {
      problems.push({ file: rel, line: 1, message: `a practice file takes its spec's stem: ${stemOf(spec.specPath)}${PRACTICE_SUFFIX} beside ${spec.specPath}` });
      continue;
    }
    if (practiceFiles.has(folder)) {
      problems.push({ file: rel, line: 1, message: `a folder holds one practice file; ${practiceFiles.get(folder)!.file} is already this component's` });
      continue;
    }
    const parsed = parsePractices(readProjectText(join(root, rel), "practice"), rel);
    problems.push(...parsed.problems);
    practiceFiles.set(folder, { file: rel, parsed });
  }
  const records = practiceFiles.size === 0 ? [] : journalRecords(root);
  const enactments = enactmentsIn(records);

  const folders = new Set(byFolder.keys());
  const entryFolder = folderOf(root, join(resolve(root, config.entryDir), "x"));
  const entry = byFolder.get(entryFolder);
  const trustLevels = entry?.parsed.trustLevels ?? [];
  const levelNames = new Set(trustLevels.map((level) => level.name));

  // Every invariant name in the model, for declared-as lines to resolve against.
  const allNames = new Set<string>();
  for (const { parsed } of byFolder.values()) for (const invariant of parsed.invariants) allNames.add(invariant.name);

  const components: Component[] = [];
  for (const { folder, specPath, parsed } of byFolder.values()) {
    if (parsed.trustLevels !== undefined && folder !== entryFolder) {
      problems.push({
        file: specPath,
        line: parsed.trustLevelsLine ?? 1,
        message: `trust levels are declared in the entry spec only (${entry?.specPath ?? `the spec at ${entryFolder}`})`,
      });
    }
    const seen = new Set<string>();
    const invariants: ModelInvariant[] = [];
    for (const invariant of parsed.invariants) {
      if (seen.has(invariant.name)) {
        problems.push({ file: specPath, line: invariant.line, message: `invariant ${invariant.name} declared twice in this component` });
      }
      seen.add(invariant.name);
      if (invariant.crossing !== undefined) {
        for (const end of [invariant.crossing.from, invariant.crossing.to]) {
          if (levelNames.has(end)) continue;
          const declared = trustLevels.length === 0 ? "no entry spec declares trust levels" : `declared: ${[...levelNames].join(", ")}`;
          problems.push({ file: specPath, line: invariant.crossing.line, message: `crossing on ${invariant.name} names trust level ${end}; ${declared}` });
        }
      }
      // A shape may be declared as the bullet itself: the requirement often is the shape.
      for (const line of invariant.checklist) {
        if (line.outcome !== "declared") continue;
        if (!allNames.has(line.as)) {
          problems.push({ file: specPath, line: line.line, message: `checklist on ${invariant.name}: ${line.shape} declared as "${line.as}", which names no invariant` });
        }
      }
      const applicable = invariant.kinds === undefined || invariant.kinds === "none" ? [] : applicableShapes(seed, invariant.kinds).map((s) => s.shape);
      const mine = latestFor(latest, folder, invariant.name);
      const { state, lacks, missingShapes, verified, defects } = deriveState(invariant, applicable, mine, witnessed.has(entryKey(folder, invariant.name, "totality oracle")));
      const forms = new Set(invariant.enforcements.map((e) => e.form));
      const entries = [forms.has("chokepoint") ? mine.chokepoint : undefined, forms.has("totality oracle") ? mine.totality : undefined].filter(
        (e): e is Latest => e !== undefined,
      );
      invariants.push({ ...invariant, component: folder, applicable, missingShapes, state, lacks, latest: entries, verified, defects });
    }
    const entrances: ModelEntrance[] = parsed.entrances.map((entrance) => {
      if (entrance.handler === undefined || entrance.handler === "") return { ...entrance, component: folder, file: undefined };
      const found = handlerFile(root, folder, entrance.handler, config.ignore);
      if (typeof found !== "string") {
        problems.push({ file: specPath, line: entrance.handlerLine, message: `entrance ${entrance.name}: ${found.reason}` });
        return { ...entrance, component: folder, file: undefined };
      }
      return { ...entrance, component: folder, file: found };
    });
    // The model: line: a named file must exist beside the spec; with models required, a spec must carry the line.
    let model: ComponentModel | undefined = parsed.model;
    if (model?.kind === "file") {
      const found = resolveModelFile(root, folder, model.file);
      if (typeof found === "string") model = { ...model, path: found };
      else problems.push({ file: specPath, line: model.line, message: found.reason });
    } else if (model === undefined && config.models) {
      problems.push({ file: specPath, line: 1, message: `no model: line; the config's models key asks every spec to name its quint model or say why not: ${MODEL_LINE_FORM}` });
    }
    const paired = practiceFiles.get(folder);
    const practices = (paired?.parsed.practices ?? []).map((practice) => modelPractice(practice, `${folder}/${practice.name}`, folder, paired!.file, enactments));
    components.push({
      folder,
      name: parsed.title ?? basename(folder === "." ? root : folder),
      specPath,
      intent: parsed.intent ?? "",
      ...(parsed.owners === undefined ? {} : { owners: parsed.owners }),
      ...(model === undefined ? {} : { model }),
      trustLevels: parsed.trustLevels,
      entrances,
      invariants,
      practicePath: paired?.file,
      practices,
      parent: parentOf(folder, folders),
      children: [],
    });
  }
  components.sort((a, b) => a.folder.localeCompare(b.folder));
  problems.push(...entranceTrustProblems(components, trustLevels));
  problems.push(...entranceGuardProblems(root, components));
  problems.push(...coveredEntranceProblems(components));
  // The invariant floor (df-f3826eaa): a bullet the run store graded an invariant is not demoted without a decision; the journal is read only when one was.
  const demoted = rawFloorGaps(components, loadedRuns.records, loadedRuns.refutations);
  if (demoted.length > 0) problems.push(...invariantFloorProblems(components, invariantFloorGaps(demoted, practiceFiles.size === 0 ? journalRecords(root) : records)));
  problems.push(
    ...practiceProblems({
      root,
      practices: components.flatMap((c) => c.practices),
      invariantsByFolder: new Map(components.map((c) => [c.folder, new Set(c.invariants.map((i) => i.name))])),
      coherenceTree: practiceFiles.size === 0 ? true : isCoherenceTree(root),
      records,
    }),
  );
  const byName = new Map(components.map((c) => [c.folder, c]));
  for (const component of components) {
    if (component.parent !== undefined) byName.get(component.parent)!.children.push(component.folder);
  }
  problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const counts = countModel(components, problems);
  // The journal is read for defects even where no practice file asked for it; a project with no spec reads none.
  const journal = practiceFiles.size === 0 && components.length > 0 ? journalRecords(root) : records;
  const defects = defectFloor(defectStates(journal), guardStanding(components), declaredClasses(root), declaredFamilies(root));
  const crossingAlone = crossingAloneCredits(components, trustLevels);
  // A project that names a model somewhere but does not require the line hears which specs name none; one that names none hears nothing.
  const unmodelled = config.models || !components.some((c) => c.model !== undefined) ? [] : components.filter((c) => c.model === undefined).map((c) => ({ file: c.specPath, line: 1, message: `names no model; add ${MODEL_LINE_FORM}` }));
  return { root, entry: entry === undefined ? undefined : entryFolder, trustLevels, components, problems, counts, runs, defects, ...(crossingAlone.length === 0 ? {} : { crossingAlone }), ...(unmodelled.length === 0 ? {} : { unmodelled }), ...(storedName === undefined ? {} : { storedName }) };
}

/** How a defect's guard stands in this model: the invariant <folder>/<name> is declared and its refutation witnessed, declared only, or missing. */
export function guardStanding(components: readonly Component[]): (guard: string) => GuardStanding {
  return (guard) => {
    const slash = guard.lastIndexOf("/");
    const invariant = components.find((c) => c.folder === guard.slice(0, slash))?.invariants.find((i) => i.name === guard.slice(slash + 1));
    if (slash === -1 || invariant === undefined) return "missing";
    return invariant.enforcements.length > 0 && !invariant.lacks.includes("refutation") ? "witnessed" : "unwitnessed";
  };
}

/** The component whose folder holds a project-relative file: the deepest component folder above it. */
export function componentHolding<C extends Pick<Component, "folder">>(components: readonly C[], file: string): C | undefined {
  let best: C | undefined;
  for (const component of components) {
    const inside = component.folder === "." || file.startsWith(`${component.folder}/`);
    if (inside && (best === undefined || component.folder.length > best.folder.length || best.folder === ".")) best = component;
  }
  return best;
}

/**
 * An entrance's declared trust, checked (decision d-ba18b0fd): it names a
 * trust level the entry spec declares, and every crossing whose chokepoint is
 * its handler, in the component holding the handler, enters from that level.
 * The crossing's entering side is the trust the handler receives; a
 * declaration that disagrees is two statements of one fact, one of them wrong,
 * so it is a problem and never a warning.
 */
function entranceTrustProblems(components: readonly Component[], trustLevels: readonly TrustLevel[]): Problem[] {
  const problems: Problem[] = [];
  const names = new Set(trustLevels.map((level) => level.name));
  for (const component of components) {
    for (const entrance of component.entrances) {
      if (entrance.trust === undefined) continue;
      const line = entrance.trustLine ?? entrance.line;
      if (!names.has(entrance.trust)) {
        const declared = trustLevels.length === 0 ? "no entry spec declares trust levels" : `declared: ${[...names].join(", ")}`;
        problems.push({ file: component.specPath, line, message: `entrance ${entrance.name} declares trust ${entrance.trust}, which is no trust level; ${declared}` });
        continue;
      }
      const handler = entrance.handler === undefined ? undefined : HANDLER.exec(entrance.handler.trim())?.[1];
      const holder = entrance.file === undefined ? undefined : componentHolding(components, entrance.file);
      if (handler === undefined || holder === undefined) continue;
      for (const invariant of holder.invariants) {
        if (invariant.crossing === undefined || invariant.crossing.from === entrance.trust) continue;
        if (!invariant.enforcements.some((e) => e.form === "chokepoint" && HANDLER.exec(e.chokepoint.trim())?.[1] === handler)) continue;
        problems.push({
          file: component.specPath,
          line,
          message: `entrance ${entrance.name} declares trust ${entrance.trust}, but its handler ${handler} is the chokepoint of ${invariant.name} in ${holder.specPath}, whose crossing enters from ${invariant.crossing.from}`,
        });
      }
    }
  }
  return problems;
}

const HANDLER = /^([A-Za-z_$][\w$]*)(?:\s+in\s+(\S+))?$/;

/** The trust an entrance carries in, as the model can tell without a reading: the level it declares, else the entering side of every crossing whose chokepoint is its handler, in the component holding it. */
function entranceTrust(entrance: ModelEntrance, components: readonly Component[]): string[] {
  if (entrance.trust !== undefined) return [entrance.trust];
  const handler = entrance.handler === undefined ? undefined : HANDLER.exec(entrance.handler.trim())?.[1];
  const holder = entrance.file === undefined ? undefined : componentHolding(components, entrance.file);
  if (handler === undefined || holder === undefined) return [];
  return [...new Set(holder.invariants.flatMap((invariant) => (invariant.crossing !== undefined && invariant.enforcements.some((e) => e.form === "chokepoint" && HANDLER.exec(e.chokepoint.trim())?.[1] === handler) ? [invariant.crossing.from] : [])))];
}

/**
 * An invariant's entrances: line, checked: every name is an entrance some
 * spec declares (covers.ts resolves it), and an entrance that declares its
 * trust carries in a level the invariant's crossing checks, entering from it
 * or entering it. A name that resolves to nothing, or to an entrance whose
 * trust the crossing never checks, would credit nothing while reading as
 * coverage, so each is a problem.
 */
function coveredEntranceProblems(components: readonly Component[]): Problem[] {
  const problems: Problem[] = [];
  for (const component of components) {
    for (const invariant of component.invariants) {
      const names = invariant.entrances?.names;
      if (names === undefined || names === "none") continue;
      const line = invariant.entrances!.line;
      for (const name of names) {
        const resolved = resolveCovered(name, component.folder, components);
        if ("problem" in resolved) {
          problems.push({ file: component.specPath, line, message: `entrances on ${invariant.name}: ${resolved.problem}` });
          continue;
        }
        const entrance = components.find((c) => c.folder === resolved.entrance.component)?.entrances.find((e) => e.name === resolved.entrance.name);
        if (entrance?.trust === undefined || crossingChecksTrust(invariant.crossing, [entrance.trust])) continue;
        problems.push({ file: component.specPath, line, message: `entrances on ${invariant.name} names ${name}, which carries ${entrance.trust} in, but its crossing ${invariant.crossing!.from} -> ${invariant.crossing!.to} neither enters from ${entrance.trust} nor enters it, so it checks nothing that entrance sends` });
      }
    }
  }
  return problems;
}

/** An entrance an invariant covered by its crossing alone, before entrances: (PR #4), and no longer covers: advisory, never a problem. */
export interface CrossingAloneCredit {
  invariant: { component: string; name: string; specPath: string; line: number };
  entrance: { component: string; name: string; specPath: string; line: number };
}

/**
 * Every entrance that lost a test-backed control when crossings stopped
 * covering entrances by themselves: a verified invariant enforced by a
 * totality oracle alone, with no entrances: line, owned where the entrance is
 * declared or its handler lies, whose crossing checks the entrance's trust,
 * on an entrance carrying a level from outside the system's control in, where
 * the loss can leave it with no traced control. An entrance that declares
 * control: none needed none. Naming the entrances
 * it checks (or none) on the invariant ends the advisory.
 */
export function crossingAloneCredits(components: readonly Component[], trustLevels: readonly TrustLevel[]): CrossingAloneCredit[] {
  const outside = new Set(trustLevels.filter((level) => level.outside).map((level) => level.name));
  const credits: CrossingAloneCredit[] = [];
  for (const component of components) {
    for (const entrance of component.entrances) {
      if (entrance.noControl !== undefined) continue;
      const holder = entrance.file === undefined ? undefined : componentHolding(components, entrance.file);
      const owners = [...new Set([component.folder, ...(holder === undefined ? [] : [holder.folder])])];
      const trust = entranceTrust(entrance, components);
      // Only where the loss can open a gap: work carried in from outside the system's control (a level marked outside).
      if (!trust.some((level) => outside.has(level))) continue;
      for (const owner of components.filter((c) => owners.includes(c.folder))) {
        for (const invariant of owner.invariants) {
          if (invariant.state !== "invariant" || !creditedByCrossingAlone(invariant, owners, trust)) continue;
          credits.push({ invariant: { component: owner.folder, name: invariant.name, specPath: owner.specPath, line: invariant.line }, entrance: { component: component.folder, name: entrance.name, specPath: component.specPath, line: entrance.line } });
        }
      }
    }
  }
  return credits;
}

/**
 * An entrance's declared guard, checked (d-127ab8e4): it names a chokepoint
 * some invariant declares, by its symbol, or a symbol declared at the top
 * level of a chokepoint that is a module. That its handler really is
 * registered through it is the reading's to confirm, where references resolve.
 */
function entranceGuardProblems(root: string, components: readonly Component[]): Problem[] {
  const problems: Problem[] = [];
  const chokepoints = components.flatMap((c) => c.invariants.flatMap((invariant) => invariant.enforcements.flatMap((e) => (e.form === "chokepoint" ? [{ component: c, value: e.chokepoint.trim() }] : []))));
  for (const component of components) {
    for (const entrance of component.entrances) {
      if (entrance.guard === undefined) continue;
      const guard = HANDLER.exec(entrance.guard.trim());
      const line = entrance.guardLine ?? entrance.line;
      if (guard === null) {
        problems.push({ file: component.specPath, line, message: `entrance ${entrance.name}: guard "${entrance.guard}" reads <chokepoint symbol> or <symbol> in <file>` });
        continue;
      }
      const name = guard[1]!;
      const named = chokepoints.some(({ component: owner, value }) => {
        const symbol = HANDLER.exec(value)?.[1];
        if (symbol !== undefined) return symbol === name;
        if (!SOURCE.test(value)) return false;
        return [owner.folder === "." ? value : `${owner.folder}/${value}`, value].some((path) => {
          const at = resolve(root, path);
          return existsSync(at) && statSync(at).isFile() && declaresAtTop(readProjectText(at, "source"), name);
        });
      });
      if (!named) {
        const listed = chokepoints.length === 0 ? "no invariant declares a chokepoint" : `declared chokepoints: ${[...new Set(chokepoints.map((c) => c.value))].join(", ")}`;
        problems.push({ file: component.specPath, line, message: `entrance ${entrance.name}: guard ${name} is no chokepoint an invariant declares, nor a symbol of a chokepoint module; ${listed}` });
      }
    }
  }
  return problems;
}
const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;

/**
 * Whether a source text declares the name at its top level (TypeScript,
 * JavaScript, or Python). A destructured binding counts, on one line or
 * across several and however deeply nested, as a factory's products are
 * exported (export const { handlers: { GET, POST }, auth } = NextAuth(...));
 * so does an export list, with or without a from, under the name it exports
 * (export { GET, POST } from "./auth", export { handle as GET }): the
 * re-exporting file is where a framework finds the name, and the source is
 * not followed (d-7155e46f).
 */
export function declaresAtTop(text: string, name: string): boolean {
  const escaped = name.replace(/\$/g, "\\$");
  const typescript = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum|namespace)\\s+${escaped}\\b`, "m");
  if (destructuredAtTop(text).has(name) || exportListed(text).has(name)) return true;
  const python = new RegExp(`^(?:async\\s+)?(?:def|class)\\s+${escaped}\\b|^${escaped}\\s*(?::[^=\\n]+)?=`, "m");
  return typescript.test(text) || python.test(text);
}

/** The text of the braces opening at `open`, through its matching close, or undefined when it never closes. */
function braced(text: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return undefined;
}

/** The names a top-level object destructuring binds, on one line or several, nested or not: a name followed by , } or = (a key followed by : binds nothing). */
function destructuredAtTop(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/^(?:export\s+)?(?:const|let|var)\s*(?=\{)/gm)) {
    const open = m.index + m[0].length;
    const pattern = braced(text, open);
    if (pattern === undefined || !/^\s*(?::[^=]+)?=/.test(text.slice(open + pattern.length))) continue;
    for (const b of pattern.matchAll(/(?<=[\s,{:])([A-Za-z_$][\w$]*)(?=\s*[,}=])/g)) names.add(b[1]!);
  }
  return names;
}

/** The names a top-level export list exports, with or without a from: export { a, b as c } from "x" exports a and c. */
function exportListed(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const item of m[1]!.split(",")) {
      const named = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(item.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""));
      if (named !== null) names.add(named[2] ?? named[1]!);
    }
  }
  return names;
}

/** Source files under a folder, sorted, never into the folders no walk enters. */
function sourcesUnder(root: string, folder: string, ignore: readonly string[]): string[] {
  return walkedFiles(root, folder, ignore).filter((rel) => SOURCE.test(rel));
}

/**
 * The file whose top level declares an entrance's handler, or why none does.
 * `name in file` reads the file relative to the component, then to the root;
 * a bare name searches the component's own source. This is the spec's own
 * check that the handler exists; the language adapter resolves it again at
 * the reading, where reachability is known.
 */
function handlerFile(root: string, folder: string, handler: string, ignore: readonly string[]): string | { reason: string } {
  if (isModuleHandler(handler)) {
    // A module file: its top-level script is the handler. It must be a source file that exists, under the component or the root.
    const file = handler.trim();
    if (!SOURCE.test(file)) return { reason: `handler ${file} names a file that is not source code` };
    const candidates = [folder === "." ? file : `${folder}/${file}`, file].filter((path, index, all) => all.indexOf(path) === index && !path.split("/").includes(".."));
    for (const candidate of candidates) {
      const path = resolve(root, candidate);
      if (existsSync(path) && statSync(path).isFile()) return candidate;
    }
    return { reason: `handler module ${file} does not exist (read under ${folder} and under the root)` };
  }
  const parsed = HANDLER.exec(handler.trim());
  if (parsed === null) return { reason: `handler "${handler}" reads <symbol>, <symbol> in <file>, or a module file` };
  const [, name, file] = parsed as unknown as [string, string, string | undefined];
  const candidates =
    file === undefined
      ? sourcesUnder(root, folder, ignore)
      : [folder === "." ? file : `${folder}/${file}`, file].filter((path, index, all) => all.indexOf(path) === index && !path.split("/").includes(".."));
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    if (declaresAtTop(readProjectText(path, "source"), name)) return candidate;
  }
  return {
    reason:
      file === undefined
        ? `handler ${name} is declared at the top level of no source file under ${folder}`
        : `handler ${name} is not declared at the top level of ${file} (read under ${folder} and under the root)`,
  };
}

function countModel(components: Component[], problems: Problem[]): Counts {
  const lacking: Record<Lack, number> = { enforcement: 0, refutation: 0, kinds: 0, checklist: 0, because: 0 };
  let bullets = 0;
  let invariants = 0;
  let structuralDefects = 0;
  let unfilled = 0;
  for (const component of components) {
    for (const invariant of component.invariants) {
      bullets += 1;
      if (invariant.state === "invariant") invariants += 1;
      if (invariant.state === "structural defect") structuralDefects += 1;
      for (const lack of invariant.lacks) lacking[lack] += 1;
      unfilled += invariant.unfilled.length;
    }
  }
  return { components: components.length, bullets, invariants, requirements: bullets - invariants - structuralDefects, structuralDefects, lacking, unfilled, problems: problems.length };
}

/**
 * Every practice a session at this root may enact: the project's own, from
 * its practice files, and in an adopter the practices of Coherence's own
 * kernel practices, read from where Coherence is installed, their ids led by coherence:.
 */
export function projectPractices(root: string, model: SpecModel = loadSpecModel(root, { runs: false })): ModelPractice[] {
  const own = model.components.flatMap((c) => c.practices);
  if (isCoherenceTree(root)) return own;
  return [...own, ...kernelPractices(enactmentsIn(journalRecords(root)))];
}
