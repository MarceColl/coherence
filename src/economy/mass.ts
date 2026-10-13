/**
 * Mass: two numbers side by side for each component and the project.
 *
 *   total      lines, files, and symbols (top-level declarations by a plain
 *              scan; the seam offers no declaration listing)
 *   unreached  code in no component (no spec file above it), and code inside
 *              a component that no invariant's chokepoint or totality oracle
 *              reaches
 *
 * Reach is at file level, and by either form of enforcement, as the lexicon
 * says. An invariant reaches the files the latest run says its check touched
 * (a chokepoint's definitions and reference sites, a totality oracle's test coverage)
 * when a run exists; without one, the files that declare the spec's named
 * symbols or are the named modules, which only a chokepoint has. Where a
 * totality oracle's run record does not say which files its test touched, the
 * report names it rather than quietly counting it as reaching nothing: what
 * the tool cannot decide it says it cannot decide. Test files are the detectors and
 * not the load: excluded and counted aside. Unreached prints first: a large
 * object with no definition is a wobbly load. Never a threshold, never a
 * baseline, never a failure on growth.
 */

import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { parseName } from "../adapters/adapter.ts";
import { configIgnore, exclusionSummary, walkBounds, walkedProjectFiles } from "../adapters/project-files.ts";
import { languagesReadLine, scannedLanguagesRead, type LanguagesRead } from "../readings/scope/languages-read.ts";
import { languageOfFile, readEnforcementConfig } from "../enforcement/config.ts";
import { loadSpecModel, type ModelInvariant, type SpecModel } from "../spec/model.ts";
import { componentOf, declarationsOf, isSourceFile, isTest, sourceFiles } from "./source.ts";

export interface Numbers {
  lines: number;
  files: number;
  symbols: number;
}

export interface FileMass extends Numbers {
  file: string;
  /** Which invariants reach it, as component/name; empty when none. */
  reachedBy: string[];
}

export interface ComponentMass {
  folder: string;
  total: Numbers;
  unreached: Numbers;
  unreachedFiles: string[];
  /**
   * Folders inside the component with no spec of their own that hold at
   * least UNIT_FILES code files directly: each may be a unit of its own,
   * folded into this component only because no spec sits there.
   */
  unspecced: { folder: string; total: Numbers }[];
}

/** Code files a folder must hold directly before mass names it as a possible component of its own. */
export const UNIT_FILES = 3;

export interface MassReport {
  language: string;
  /** Which of the project's languages mass read: every one, each file in its own language. */
  languages: LanguagesRead;
  total: Numbers;
  unreached: Numbers;
  /** Code in no component. */
  outside: { total: Numbers; files: string[] };
  components: ComponentMass[];
  files: FileMass[];
  /** How reach was decided: the latest run's files, the spec's names, or both across invariants. */
  reachFrom: ("run" | "spec")[];
  /**
   * Invariants enforced only by a totality oracle whose latest run record does
   * not say which files its test touched, as component/name. Their reach is
   * unknown, not zero, and the report says so.
   */
  silentTotalityOracles: string[];
  testsExcluded: number;
  /** The language's source files no walk reads, summed by the rule that left them out: what mass cannot see, said beside what it counts. */
  leftOut: { reason: string; files: number }[];
}

export interface MassOptions {
  model?: SpecModel | undefined;
}

const ZERO: Numbers = { lines: 0, files: 0, symbols: 0 };

function add(a: Numbers, b: Numbers): Numbers {
  return { lines: a.lines + b.lines, files: a.files + b.files, symbols: a.symbols + b.symbols };
}

function sum(files: readonly FileMass[]): Numbers {
  return files.reduce((acc, f) => add(acc, f), ZERO);
}

function chokepointNames(invariant: ModelInvariant): string[] {
  return invariant.enforcements.flatMap((e) => (e.form === "chokepoint" ? [e.protects, e.chokepoint] : []));
}

/**
 * The files one invariant reaches, and where the answer came from. Every
 * latest run entry counts, whichever form wrote it: a chokepoint's files are
 * its definitions and reference sites, a totality oracle's are the files its test
 * covered. `silent` says a totality oracle ran and named no file, so its reach is
 * unknown rather than empty.
 */
function reachOf(invariant: ModelInvariant, files: readonly { file: string; names: Set<string> }[]): { files: string[]; from: "run" | "spec" | undefined; silent: boolean } {
  const ran = invariant.latest.filter((l) => l.files.length > 0);
  if (ran.length > 0) return { files: [...new Set(ran.flatMap((l) => l.files))], from: "run", silent: false };
  const silent = invariant.latest.some((l) => l.form === "totality oracle");
  const names = chokepointNames(invariant);
  if (names.length === 0) return { files: [], from: undefined, silent };
  const reached = new Set<string>();
  for (const value of names) {
    const parsed = parseName(value);
    if (parsed.form === "module") {
      for (const f of files) if (f.file === parsed.path || f.file.endsWith("/" + parsed.path)) reached.add(f.file);
    } else if (parsed.form === "symbol") {
      for (const f of files) {
        if (!f.names.has(parsed.name)) continue;
        if (parsed.fileHint !== undefined && f.file !== parsed.fileHint && !f.file.endsWith("/" + parsed.fileHint)) continue;
        // A bare name is looked for under the invariant's component first; elsewhere only when nothing there declares it.
        reached.add(f.file);
      }
    }
  }
  return { files: [...reached], from: "spec", silent };
}

export function computeMass(rootGiven: string, options: MassOptions = {}): MassReport {
  const root = resolve(rootGiven);
  const config = readEnforcementConfig(root);
  // Every declared language a scan reads, each file read in its own: a multi-language project's mass is the mass of all its code, and a language no scan reads yet is named as not read.
  const languages = scannedLanguagesRead(config);
  const model = options.model ?? loadSpecModel(root);
  const ignore = configIgnore(root);
  const all = languages.read.length === 1 ? sourceFiles(root, languages.read[0]!, ignore) : [...new Set(languages.read.flatMap((l) => sourceFiles(root, l, ignore)))].sort();
  const tests = all.filter((f) => isTest(f, config.testFolders));
  const code = all.filter((f) => !isTest(f, config.testFolders));

  const scanned = code.map((file) => {
    const text = readFileSync(resolve(root, file), "utf8");
    const declarations = declarationsOf(text, languageOfFile(file, languages.read) ?? languages.read[0]!);
    const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { file, lines, symbols: declarations.length, names: new Set(declarations.map((d) => d.name)) };
  });

  const reachedBy = new Map<string, Set<string>>();
  const reachFrom = new Set<"run" | "spec">();
  const silentTotalityOracles: string[] = [];
  for (const component of model.components) {
    for (const invariant of component.invariants) {
      const scoped = scanned.filter((f) => component.folder === "." || f.file.startsWith(component.folder + "/"));
      let reach = reachOf(invariant, scoped);
      if (reach.from === "spec" && reach.files.length === 0) reach = reachOf(invariant, scanned);
      if (reach.from !== undefined && reach.files.length > 0) reachFrom.add(reach.from);
      if (reach.silent && reach.files.length === 0) silentTotalityOracles.push(`${component.folder}/${invariant.name}`);
      for (const file of reach.files) {
        const set = reachedBy.get(file) ?? new Set<string>();
        set.add(`${component.folder}/${invariant.name}`);
        reachedBy.set(file, set);
      }
    }
  }
  silentTotalityOracles.sort();

  const files: FileMass[] = scanned.map((f) => ({ file: f.file, lines: f.lines, files: 1, symbols: f.symbols, reachedBy: [...(reachedBy.get(f.file) ?? [])].sort() }));
  const outsideFiles = files.filter((f) => componentOf(model, f.file) === undefined);
  const components: ComponentMass[] = model.components
    .map((component) => {
      const mine = files.filter((f) => componentOf(model, f.file)?.folder === component.folder);
      const unreached = mine.filter((f) => f.reachedBy.length === 0);
      const byFolder = new Map<string, FileMass[]>();
      for (const f of mine) {
        const folder = posix.dirname(f.file);
        if (folder === component.folder) continue;
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]);
      }
      const unspecced = [...byFolder]
        .filter(([, held]) => held.length >= UNIT_FILES)
        .map(([folder, held]) => ({ folder, total: sum(held) }))
        .sort((a, b) => b.total.lines - a.total.lines || a.folder.localeCompare(b.folder));
      return { folder: component.folder, total: sum(mine), unreached: sum(unreached), unreachedFiles: unreached.map((f) => f.file).sort(), unspecced };
    })
    .sort((a, b) => a.folder.localeCompare(b.folder));

  const unreached = add(sum(outsideFiles), components.reduce((acc, c) => add(acc, c.unreached), ZERO));
  return {
    language: languages.read.join("+"),
    languages,
    total: sum(files),
    unreached,
    outside: { total: sum(outsideFiles), files: outsideFiles.map((f) => f.file).sort() },
    components,
    files,
    reachFrom: [...reachFrom].sort(),
    silentTotalityOracles,
    testsExcluded: tests.length,
    leftOut: exclusionSummary(walkedProjectFiles(walkBounds(root, ignore)).excluded.filter((e) => languages.read.some((l) => isSourceFile(e.file, l)))),
  };
}


function numbers(n: Numbers): string {
  return `${n.lines} lines, ${n.files} file${n.files === 1 ? "" : "s"}, ${n.symbols} symbol${n.symbols === 1 ? "" : "s"}`;
}

function share(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

const SHOWN = 6;

export function formatMass(report: MassReport): string {
  const lines: string[] = [];
  lines.push(`unreached mass: ${numbers(report.unreached)} (${share(report.unreached.lines, report.total.lines)} of lines)`);
  lines.push(`  in no component: ${numbers(report.outside.total)}${report.outside.files.length === 0 ? "" : ` — ${report.outside.files.slice(0, SHOWN).join(", ")}${report.outside.files.length > SHOWN ? `, and ${report.outside.files.length - SHOWN} more` : ""}`}`);
  for (const c of report.components) {
    if (c.unreached.files === 0) continue;
    lines.push(`  ${c.folder}: ${numbers(c.unreached)} unreached of ${numbers(c.total)} — ${c.unreachedFiles.slice(0, SHOWN).join(", ")}${c.unreachedFiles.length > SHOWN ? `, and ${c.unreachedFiles.length - SHOWN} more` : ""}`);
  }
  const unspecced = report.components.flatMap((c) => c.unspecced.map((u) => ({ ...u, within: c.folder }))).sort((a, b) => b.total.lines - a.total.lines || a.folder.localeCompare(b.folder));
  if (unspecced.length > 0) {
    lines.push(`folders with no spec of their own, folded into a component above them (${UNIT_FILES} or more code files each; give each that is a unit its own spec): ${unspecced.length}`);
    for (const u of unspecced.slice(0, SHOWN)) lines.push(`  ${u.folder}: ${numbers(u.total)}, inside ${u.within}`);
    if (unspecced.length > SHOWN) lines.push(`  and ${unspecced.length - SHOWN} more`);
  }
  lines.push(`total mass: ${numbers(report.total)}`);
  for (const c of report.components) lines.push(`  ${c.folder}: ${numbers(c.total)}; unreached ${numbers(c.unreached)}`);
  const from = report.reachFrom.length === 0 ? "no invariant reaches any file" : `reach from ${report.reachFrom.map((f) => (f === "run" ? "the latest run's files" : "the spec's named symbols")).join(" and ")}`;
  lines.push(`${from}; symbols are top-level declarations by a plain scan; ${report.testsExcluded} test file${report.testsExcluded === 1 ? "" : "s"} excluded`);
  if (report.leftOut.length > 0) {
    const n = report.leftOut.reduce((total, r) => total + r.files, 0);
    lines.push(`left out of every walk: ${n} source file${n === 1 ? "" : "s"} — ${report.leftOut.slice(0, SHOWN).map((r) => `${r.reason} (${r.files})`).join(", ")}${report.leftOut.length > SHOWN ? `, and ${report.leftOut.length - SHOWN} more` : ""}`);
  }
  const read = languagesReadLine(report.languages);
  if (read !== undefined) lines.push(read);
  if (report.silentTotalityOracles.length > 0) {
    const n = report.silentTotalityOracles.length;
    lines.push(`${n} totality oracle${n === 1 ? "'s" : "s'"} run record does not say which files its test touched, so nothing is counted reached through it: ${report.silentTotalityOracles.join(", ")}`);
  }
  return lines.join("\n");
}
