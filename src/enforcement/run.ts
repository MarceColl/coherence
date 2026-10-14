/**
 * The run: the chokepoint check for every chokepoint-form enforcement and
 * the totality oracle pass for every totality-oracle-form enforcement in
 * the spec model, appended as one record. A selection (one form, some
 * invariants) still appends one record; the enforcements it skipped keep
 * their prior dated verdict in the status view.
 *
 * The totality pass runs the project's whole test suite before the first
 * question the instrument is asked, and the warm server's idle timer only
 * resets on a request line: a suite longer than the idle timeout used to kill
 * the instrument mid-run, record not run for every chokepoint, and exit 0. The
 * run now keeps the instrument alive across the test pass with a heartbeat and
 * asks it again afterwards; a run whose instrument died says so in every entry
 * and in `instrumentDied`, and the command exits non-zero.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTestPath, parseName, type LanguageAdapter } from "../adapters/adapter.ts";
import { isLanguage, type Language } from "../adapters/index.ts";
import { projectFiles } from "../adapters/project-files.ts";
import { gitState } from "../journal/store.ts";
import { workBinding } from "../journal/work.ts";
import type { ChokepointFrom } from "../spec/grammar.ts";
import { loadSpecModel, type ModelInvariant, type SpecModel } from "../spec/model.ts";
import { checkChokepoint, type ChokepointResult } from "./check.ts";
import { languageOfFile, readEnforcementConfig, setupClaims, type EnforcementConfig } from "./config.ts";
import { appendRun, entryKey, loadRuns, machineLoad, type Form, type RunEntry, type RunRecord } from "./record.ts";
import { enforcesOf } from "../spec/floor.ts";
import { connectAdapter, type RemoteAdapter } from "./server.ts";
import { escapeRegExp, runTotalityBatch, runTotalityOracle, type TotalityResult } from "./totality.ts";
import { readLatency, type LatencyReading } from "./latency.ts";
import { createObserver, recordObservation, type ObservationOutcome, type TotalityVia } from "../observation/index.ts";
import { checkQuintProp, type StandingOf } from "./quint-prop.ts";

export interface RunOptions {
  session: string;
  agent: string;
  /** One form only, when given. */
  form?: Form | undefined;
  /** Only invariants with these names, when given. */
  invariants?: readonly string[] | undefined;
  /** Files (project-relative) whose text changed since the instrument last read them; the warm server re-reads them first. */
  refresh?: readonly string[] | undefined;
  /**
   * False for an edit's check: the run's entries are recorded ungraded, with
   * no state derived, since deriving one reads the whole spec model and run
   * store; the invariant floor counts only graded entries. A full run grades.
   */
  grade?: boolean | undefined;
  /** An adapter to use instead of the warm server (tests, and `--no-server`); in a multi-language project, for its own language. */
  adapter?: LanguageAdapter | undefined;
  /** Adapters by language to use instead of the warm servers (tests, and `--no-server` in a multi-language project). */
  adapters?: Partial<Record<string, LanguageAdapter>> | undefined;
  /** Whether to talk to the warm server (default true when no adapter is given). */
  server?: boolean | undefined;
  model?: SpecModel | undefined;
  now?: (() => Date) | undefined;
  /** The idle timeout to spawn the warm server with, when this run spawns it. */
  idleMs?: number | undefined;
  /** How often to keep the warm server awake during the test pass; the default is well inside the shortest sane idle. */
  heartbeatMs?: number | undefined;
  /** Observe the batched pass (src/observation): coverage rides the same one invocation, and one observation record is appended. */
  observe?: boolean | undefined;
  /** How long the one test invocation may run before its whole process tree is killed and its totality oracles read unfinished (default TOTALITY_TIMEOUT_MS). */
  timeoutMs?: number | undefined;
  /**
   * After the batched pass, run each batched totality oracle's test again in its own invocation through the
   * config's `test` command, and append those verdicts as a second run record (every entry mode one-at-a-time).
   */
  each?: boolean | undefined;
  /** Only quint props: the totality oracles whose detector is quint, never a test and never a chokepoint. */
  quint?: boolean | undefined;
  /** How a quint prop learns its model's conformance verdict; without it, each reads absent. */
  standing?: StandingOf | undefined;
}

/** The per-test confirmation `run --each` adds: the second record, and the totality oracles it caught. */
export interface EachOutcome {
  record: RunRecord;
  file: string;
  details: EntryDetail[];
  /** Totality oracles whose test passed in the batched invocation and failed in its own: it passed on what its neighbors left behind. */
  hidden: EntryDetail[];
  /** Totality oracles whose test the batched invocation passed and its own invocation could not run (no test command, or it never started). */
  unconfirmed: EntryDetail[];
}

/** How often the run touches the instrument while the test suite holds the floor. */
export const HEARTBEAT_MS = 20_000;

export interface EntryDetail {
  entry: RunEntry;
  chokepoint?: ChokepointResult;
  totality?: TotalityResult;
  /** A totality oracle's test filter as the runner was given it, so a second pass re-runs this test and no other. */
  filter?: string;
  /** A totality oracle's test setup (its index in the config's tests), so a second pass runs it through the same runner. */
  setup?: number;
}

export interface RunOutcome {
  record: RunRecord;
  file: string | undefined;
  details: EntryDetail[];
  /** Why the instrument was unavailable, when it was. */
  instrumentReason: string | undefined;
  /** True when the instrument was needed and could not answer: the run proved nothing and must not exit 0. */
  instrumentDied: boolean;
  /** The observation appended, when the run was observed and the batched pass ran. */
  observation?: ObservationOutcome;
  /** Why an observed run appended no observation. */
  observationSkipped?: string;
  /** With `each`: the second record, one invocation per totality oracle the batched pass ran. */
  each?: EachOutcome;
  /** With `each`: why no per-test record was appended (no totality oracle ran batched). */
  eachSkipped?: string;
  /** The timing debt this run showed: its tests over their own history. */
  latency?: LatencyReading;
}

function chokepointEnforcements(invariant: Pick<ModelInvariant, "enforcements">): { protects: string; chokepoint: string; from: ChokepointFrom | undefined }[] {
  return invariant.enforcements.flatMap((e) => (e.form === "chokepoint" ? [{ protects: e.protects, chokepoint: e.chokepoint, from: e.from }] : []));
}

function totalityEnforcements(invariant: ModelInvariant): { over: string; via: string; quintProp: string | undefined }[] {
  return invariant.enforcements.flatMap((e) => (e.form === "totality oracle" ? [{ over: e.over, via: e.via, quintProp: e.quintProp }] : []));
}

/** Whether a chokepoint invariant may involve a file: its latest run touched it, or the file's text carries one of its names. */
export function mayTouch(invariant: Pick<ModelInvariant, "enforcements"> & { latest: readonly { form: string; files: readonly string[] }[] }, file: string, text: string | undefined): boolean {
  const latest = invariant.latest.find((l) => l.form === "chokepoint");
  if (latest !== undefined && latest.files.includes(file)) return true;
  if (text === undefined) return false;
  for (const { protects, chokepoint } of chokepointEnforcements(invariant)) {
    for (const value of [protects, chokepoint]) {
      const name = /^([A-Za-z_$][A-Za-z0-9_$]*)(\s+in\s+\S+)?$/.exec(value.trim())?.[1];
      if (name !== undefined && new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(text)) return true;
      if (name === undefined && file.endsWith(value.trim())) return true;
    }
  }
  return false;
}

/** One language's instrument as the run reached it: the adapter, how it was reached, or why there is none. */
interface Door {
  adapter: LanguageAdapter | undefined;
  server: "cold" | "warm" | undefined;
  reason: string | undefined;
}

/**
 * The run's instruments, one per language, each opened only when a check
 * first asks for it: a multi-language project never starts a language's
 * server that no check needs. `open` reaches one; `ready` also asks it
 * whether it is loaded, once, and keeps the answer.
 */
class Instruments {
  private readonly opened = new Map<string, Promise<Door>>();
  private readonly checked = new Map<string, Promise<Door>>();
  private readonly connect: (language: string) => Promise<Door>;
  constructor(connect: (language: string) => Promise<Door>) {
    this.connect = connect;
  }

  open(language: string): Promise<Door> {
    let door = this.opened.get(language);
    if (door === undefined) {
      door = this.connect(language).catch((error: unknown): Door => ({ adapter: undefined, server: undefined, reason: error instanceof Error ? error.message : String(error) }));
      this.opened.set(language, door);
    }
    return door;
  }

  ready(language: string): Promise<Door> {
    let door = this.checked.get(language);
    if (door === undefined) {
      door = this.open(language).then(async (d) => {
        if (d.adapter === undefined || d.reason !== undefined) return d;
        const state = await d.adapter.ready();
        return state.ok ? d : { ...d, reason: state.reason };
      });
      this.checked.set(language, door);
    }
    return door;
  }

  /** Mark a language's instrument unavailable from here on, with why. */
  fail(language: string, reason: string): void {
    const failed = this.open(language).then((d): Door => ({ ...d, reason: d.reason ?? reason }));
    this.checked.set(language, failed);
  }

  /** The languages opened, with what each answered. */
  async doors(): Promise<{ language: string; door: Door }[]> {
    return Promise.all([...this.opened.keys()].map(async (language) => ({ language, door: await (this.checked.get(language) ?? this.opened.get(language)!) })));
  }
}

/**
 * A run asked for invariants that no bullet names. Nothing runs: a run that
 * left them out would report the others' verdicts and exit as if every one
 * asked for had passed, so a misspelled name would look checked.
 */
export class UnknownInvariants extends Error {
  readonly names: readonly string[];
  constructor(names: readonly string[]) {
    super(`run: no bullet is named ${names.map((n) => `"${n}"`).join(", ")}; give a bullet's name, or <component folder>/<bullet name> as refute takes it`);
    this.names = names;
  }
}

/** One chokepoint enforcement of a selected invariant, with the languages it may be written in, the likeliest first. */
interface ChokepointPlan {
  component: string;
  invariant: ModelInvariant;
  protects: string;
  chokepoint: string;
  /** The bullet's own from: line, when it has one. */
  from: ChokepointFrom | undefined;
  languages: Language[];
}

/**
 * The languages a chokepoint enforcement may be written in, the likeliest
 * first: the language of a file either value names (`X in backend/a.py`, a
 * module path); else the language the invariant's latest run graded it with,
 * or of the files that run touched; else the languages whose files the
 * component holds, in the config's order; else every language. A
 * single-language project has the one.
 */
export function enforcementLanguages(config: EnforcementConfig, component: string, invariant: ModelInvariant, protects: string, chokepoint: string, files: () => readonly string[]): Language[] {
  if (config.languages.length === 1) return [config.language];
  const named = [protects, chokepoint].flatMap((value) => {
    const form = parseName(value);
    const file = form.form === "symbol" ? form.fileHint : form.form === "module" ? form.path : undefined;
    const language = file === undefined ? undefined : languageOfFile(file, config.languages);
    return language === undefined ? [] : [language];
  });
  if (named.length > 0) return [...new Set(named)];
  const latest = invariant.latest.find((l) => l.form === "chokepoint");
  const graded = latest?.language !== undefined && isLanguage(latest.language) && config.languages.includes(latest.language) ? [latest.language] : [];
  const touched = (latest?.files ?? []).flatMap((f) => {
    const language = languageOfFile(f, config.languages);
    return language === undefined ? [] : [language];
  });
  const seen = [...new Set([...graded, ...touched])];
  if (seen.length > 0) return seen;
  const prefix = component === "." ? "" : `${component}/`;
  const held = new Set(files().filter((f) => f.startsWith(prefix)).flatMap((f) => languageOfFile(f, config.languages) ?? []));
  const ordered = config.languages.filter((l) => held.has(l));
  return ordered.length > 0 ? ordered : [...config.languages];
}

/**
 * Which test setup runs a totality oracle's test: the one setup a
 * single-setup project has; else the first setup whose test files define a
 * test of that name (a pytest `def` or `class` for a pytest setup, a quoted
 * title for any other), else the first whose test files spell it at all,
 * else the first setup. Test files are read once per run, and only when the
 * config has more than one setup.
 */
export function setupChooser(root: string, config: EnforcementConfig): (via: string) => number {
  if (config.tests.length <= 1) return () => 0;
  let claimed: string[][] | undefined;
  const texts = new Map<string, string>();
  const text = (file: string): string => {
    let t = texts.get(file);
    if (t === undefined) {
      try {
        t = readFileSync(join(root, file), "utf8");
      } catch {
        t = "";
      }
      texts.set(file, t);
    }
    return t;
  };
  const claims = (): string[][] => {
    if (claimed !== undefined) return claimed;
    const all = projectFiles(root);
    claimed = config.tests.map((setup) => all.filter((f) => isTestPath(f, setup.testFolders) && setupClaims(setup, f)));
    return claimed;
  };
  return (via) => {
    const files = claims();
    const escaped = escapeRegExp(via);
    const defines = config.tests.map((setup) =>
      setup.testFilterForm === "pytest" && /^[A-Za-z_][\w]*$/.test(via) ? new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${escaped}\\b`, "m") : new RegExp(`["'\`]${escaped}["'\`]`),
    );
    for (let i = 0; i < files.length; i += 1) if (files[i]!.some((f) => defines[i]!.test(text(f)))) return i;
    for (let i = 0; i < files.length; i += 1) if (files[i]!.some((f) => text(f).includes(via))) return i;
    return 0;
  };
}

export async function performRun(root: string, options: RunOptions): Promise<RunOutcome> {
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const load = machineLoad();
  const model = options.model ?? loadSpecModel(root);
  const config = readEnforcementConfig(root);
  const wantChokepoints = options.quint !== true && (options.form === undefined || options.form === "chokepoint");
  const wantTotality = options.form === undefined || options.form === "totality oracle";
  const chosen = new Set(options.invariants ?? []);
  const multi = config.languages.length > 1;
  // A name is a bullet's own, or its component folder and name as refute takes it; each must name a bullet, or nothing runs.
  const isChosen = (folder: string, name: string): boolean => chosen.has(name) || chosen.has(`${folder}/${name}`);
  const unmatched = [...chosen].filter((wanted) => !model.components.some((c) => c.invariants.some((i) => wanted === i.name || wanted === `${c.folder}/${i.name}`)));
  if (unmatched.length > 0) throw new UnknownInvariants(unmatched);

  const quintOnly = options.quint === true;
  const selected = model.components.flatMap((c) =>
    c.invariants
      .filter((i) => (chosen.size === 0 || isChosen(c.folder, i.name)) && i.enforcements.length > 0)
      .filter((i) => !quintOnly || totalityEnforcements(i).some((e) => e.quintProp !== undefined))
      .map((i) => ({ component: c.folder, invariant: i })),
  );

  const details: EntryDetail[] = [];
  const needsAdapter = wantChokepoints && selected.some(({ invariant }) => chokepointEnforcements(invariant).length > 0);
  // A totality oracle's refutation is the record `refute` wrote, never the bullet's own refuted: line.
  // Read only when a totality oracle is checked: an edit's chokepoint check never reads the run history.
  const recorded = wantTotality ? new Set(loadRuns(root).refutations.map((r) => entryKey(r.component, r.name, r.form))) : new Set<string>();
  let listed: string[] | undefined;
  const files = (): string[] => (listed ??= projectFiles(root));
  const plans: ChokepointPlan[] = wantChokepoints
    ? selected.flatMap(({ component, invariant }) => chokepointEnforcements(invariant).map(({ protects, chokepoint, from }) => ({ component, invariant, protects, chokepoint, from, languages: enforcementLanguages(config, component, invariant, protects, chokepoint, files) })))
    : [];
  const chooseSetup = setupChooser(root, config);
  const multiSetup = config.tests.length > 1;

  // The pass itself, once the instrument question is settled: the instruments, the record's instrument when it is fixed, or why there is none.
  const pass = async (instruments: Instruments, fixed: RunRecord["instrument"] | undefined, unavailable: string | undefined): Promise<RunOutcome> => {
  let instrumentReason = unavailable;
  // The likeliest language of every chokepoint is asked first, before the test pass, so its server loads while the tests run.
  const upfront = [...new Set(plans.map((p) => p.languages[0]!))];
  for (const language of upfront) await instruments.ready(language);
  const primary = multi ? undefined : (await instruments.open(config.language)).adapter;

  // Every test a bullet names in one invocation per setup, when the runner can report per test; else one at a time below.
  const batched = new Map<number, Map<string, TotalityResult>>();
  const batchLatency = new Map<number, number>();
  // An observed run rides the first setup's one invocation: the observer only adds coverage to it.
  const observing = options.observe === true && wantTotality && config.testJson !== undefined ? createObserver(root, config) : undefined;
  // An observed pass reads through the primary language's instrument after it, so that one is reached first and kept awake.
  if (observing !== undefined) await instruments.open(config.language);
  // A quint prop is no test: quint answers it below, and the batched runner never sees it.
  const allVias = quintOnly ? [] : selected.flatMap(({ component, invariant }) => totalityEnforcements(invariant).filter((e) => e.quintProp === undefined).map(({ via }) => ({ component, name: invariant.name, filter: primary?.testFilter(via) ?? via, setup: chooseSetup(via) })));
  const vias: TotalityVia[] = allVias.filter((v) => v.setup === 0).map(({ component, name, filter }) => ({ component, name, filter }));
  if (wantTotality) {
    // The test suite can outlast a warm server's idle timeout, and its timer only resets on a request line.
    const live = (await instruments.doors()).flatMap(({ door }) => (door.adapter !== undefined && door.reason === undefined ? [door.adapter] : []));
    const beat = live.length === 0 || (!needsAdapter && observing === undefined) ? undefined : setInterval(() => { for (const a of live) void a.ready().catch(() => {}); }, options.heartbeatMs ?? HEARTBEAT_MS);
    beat?.unref();
    try {
      for (const [index, setup] of config.tests.entries()) {
        const filters = allVias.filter((v) => v.setup === index).map((v) => v.filter);
        if (filters.length === 0 && !(index === 0 && observing !== undefined)) continue;
        const t0 = Date.now();
        const result = await runTotalityBatch(root, setup, filters, options.timeoutMs, index === 0 ? observing?.observer : undefined);
        batchLatency.set(index, Date.now() - t0);
        if (result !== undefined) batched.set(index, result);
      }
    } finally {
      if (beat !== undefined) clearInterval(beat);
    }
    // Each instrument is asked again before the first chokepoint: a suite that outlived it must not read as not run.
    if (needsAdapter) {
      const spent = [...batchLatency.values()].reduce((a, b) => a + b, 0);
      for (const { language, door } of await instruments.doors()) {
        if (door.adapter === undefined || door.reason !== undefined) continue;
        let alive: { ok: true } | { ok: false; reason: string };
        try {
          alive = await door.adapter.ready();
        } catch (error) {
          alive = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        if (!alive.ok) instruments.fail(language, `the instrument did not survive the test pass (${Math.round(spent / 1000)} s): ${alive.reason}`);
      }
    }
  }

  for (const { component, invariant } of selected) {
    if (wantChokepoints) {
      for (const plan of plans.filter((p) => p.component === component && p.invariant === invariant)) {
        const { protects, chokepoint, from } = plan;
        // The bullet's own from: line governs; a silent bullet takes the config's default, and with none, anywhere.
        const governs = from !== undefined ? { from, fromBy: "bullet" as const } : config.chokepointFrom !== undefined ? { from: config.chokepointFrom, fromBy: "config" as const } : {};
        const t0 = Date.now();
        let firstReason: string | undefined;
        for (const [i, language] of plan.languages.entries()) {
          const last = i === plan.languages.length - 1;
          const tag = multi ? { language } : {};
          const door = await instruments.ready(language);
          if (door.adapter === undefined || door.reason !== undefined) {
            firstReason ??= door.reason ?? "no adapter";
            if (!last) continue;
            instrumentReason ??= firstReason;
            details.push({
              entry: entryOf(component, invariant.name, "chokepoint", {
                verdict: "not run",
                grade: undefined,
                refutation: "missing",
                bypasses: [],
                testReferences: 0,
                files: [],
                latency: Date.now() - t0,
                reason: `instrument unavailable: ${firstReason}`,
                ...(multi ? { language: plan.languages[0]! } : {}),
              }),
            });
            break;
          }
          let result: ChokepointResult;
          try {
            result = await checkChokepoint(door.adapter, { protects, chokepoint, component, testFolders: config.testFolders, root, ...governs });
          } catch (error) {
            const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
            instruments.fail(language, message);
            firstReason ??= message;
            if (!last) continue;
            details.push({
              entry: entryOf(component, invariant.name, "chokepoint", {
                verdict: "not run",
                grade: undefined,
                refutation: "missing",
                bypasses: [],
                testReferences: 0,
                files: [],
                latency: Date.now() - t0,
                reason: `instrument failed: ${message}`,
                ...tag,
              }),
            });
            instrumentReason ??= message;
            break;
          }
          // A protected thing this language's server cannot find may be written in the next language the component holds.
          if (!last && result.verdict === "not run" && result.protectedThing === undefined) continue;
          details.push({
            entry: entryOf(component, invariant.name, "chokepoint", {
              verdict: result.verdict,
              grade: result.grade,
              ...(result.enforcer === undefined ? {} : { enforcer: result.enforcer }),
              ...(result.governed === undefined ? {} : { from: result.governed }),
              refutation: result.refutation,
              bypasses: result.bypasses,
              ...(result.siteEvidence !== "complete" ? {} : { sites: result.sites.map((site) => ({
                file: site.file,
                line: site.line,
                symbol: site.symbol ?? "module top level",
                class: site.class,
                of: site.of,
                test: site.test,
                ...(site.form === undefined ? {} : { form: site.form }),
              })) }),
              testReferences: result.counts.test,
              files: result.files,
              latency: Date.now() - t0,
              reason: result.reason,
              ...tag,
            }),
            chokepoint: result,
          });
          break;
        }
      }
    }
    if (wantTotality) {
      for (const { via, quintProp } of totalityEnforcements(invariant)) {
        const t0 = Date.now();
        if (quintProp !== undefined) {
          const modelFile = model.components.find((c) => c.folder === component)?.model?.path;
          const result = await checkQuintProp(root, component, modelFile, quintProp, options.standing);
          details.push({
            entry: {
              ...entryOf(component, invariant.name, "totality oracle", {
                verdict: result.verdict,
                grade: undefined,
                refutation: recorded.has(entryKey(component, invariant.name, "totality oracle")) ? "witnessed" : "missing",
                bypasses: [],
                testReferences: 0,
                files: modelFile === undefined ? [] : [modelFile],
                latency: Date.now() - t0,
                reason: result.reason,
              }),
              quintProp,
              ...(result.grade === undefined || result.verdict !== "pass" ? {} : { quintGrade: result.grade }),
              quintSteps: result.steps,
              conformance: result.conformance,
              ...(result.counterexample === undefined ? {} : { counterexample: result.counterexample }),
            },
            totality: result,
          });
          continue;
        }
        if (quintOnly) continue;
        const filter = primary?.testFilter(via) ?? via;
        const index = chooseSetup(via);
        const setup = config.tests[index]!;
        const fromBatch = batched.get(index)?.get(filter);
        const result = fromBatch ?? (await runTotalityOracle(root, setup, filter, options.timeoutMs));
        details.push({
          entry: {
            ...entryOf(component, invariant.name, "totality oracle", {
              verdict: result.verdict,
              grade: undefined,
              refutation: recorded.has(entryKey(component, invariant.name, "totality oracle")) ? "witnessed" : "missing",
              bypasses: [],
              testReferences: 0,
              files: [],
              latency: fromBatch === undefined ? Date.now() - t0 : (batchLatency.get(index) ?? 0),
              reason: result.reason,
              ...(multiSetup && setup.language !== undefined ? { language: setup.language } : {}),
            }),
            ...(result.testMs === undefined ? {} : { testMs: result.testMs }),
            mode: fromBatch === undefined ? "one-at-a-time" : "batched",
          },
          totality: result,
          filter,
          setup: index,
        });
      }
    }
  }

  const doors = await instruments.doors();
  const instrument: RunRecord["instrument"] = fixed ?? instrumentOf(config, doors);
  // The observation reads interfaces through the primary language's instrument: opened only for an observed run.
  const observed = options.observe === true && observing !== undefined && batched.has(0) ? await instruments.open(config.language) : undefined;
  const { commit, dirty } = gitState(root);
  const totalBatch = [...batchLatency.entries()].filter(([index]) => batched.has(index)).reduce((sum, [, ms]) => sum + ms, 0);
  const record: RunRecord = {
    at: now().toISOString(),
    session: options.session,
    agent: options.agent,
    ...workBinding(root, options.session),
    commit,
    dirty,
    instrument,
    latency: Date.now() - started,
    load,
    ...(batched.size === 0 ? {} : { batch: { ms: totalBatch } }),
    // A full run: every bullet, both forms, from the project's own model, and graded.
    ...(chosen.size === 0 && options.form === undefined && options.quint !== true && options.model === undefined && options.grade !== false ? { full: true as const } : {}),
    invariants: details.map((d) => d.entry),
  };
  if (options.grade === false) for (const entry of record.invariants) entry.ungraded = true;
  else gradeRecord(root, record);
  const file = appendRun(root, record);
  const outcome: RunOutcome = { record, file, details, instrumentReason, instrumentDied: needsAdapter && instrumentReason !== undefined };
  if (batched.size > 0) {
    // Read against the whole store: a test is slower only against its own earlier runs.
    outcome.latency = { slower: readLatency(loadRuns(root).records).slower.filter((s) => s.at === record.at) };
  }
  if (options.observe === true) {
    if (observing === undefined || !batched.has(0)) {
      outcome.observationSkipped = !wantTotality
        ? "the run checked no totality oracle, so no test ran to observe"
        : config.testJson === undefined
          ? "no testJson command: observation rides only the one batched invocation"
          : "no bullet names a test, so no batched pass ran";
      observing?.collect();
    } else {
      outcome.observation = await recordObservation({
        root,
        capture: observing.collect(),
        adapter: observed?.adapter,
        instrumentReason: needsAdapter ? instrumentReason : (observed?.reason ?? unavailable),
        model,
        config,
        vias,
        session: options.session,
        agent: options.agent,
        at: record.at,
        passLatency: batchLatency.get(0) ?? 0,
        commit,
      });
    }
  }
  if (options.each === true) {
    const batchedDetails = details.filter((d) => d.entry.form === "totality oracle" && d.entry.mode === "batched");
    if (batchedDetails.length === 0) {
      outcome.eachSkipped = !wantTotality ? "the run checked no totality oracle" : "no totality oracle ran in the batched invocation, so each already ran in its own";
    } else {
      // The one function that performs a pass is the only one that appends: confirmEach builds the second record, performRun writes it.
      const each = await confirmEach(root, config, options, batchedDetails, instrument, recorded, now);
      gradeRecord(root, each.record);
      outcome.each = { ...each, file: appendRun(root, each.record) };
    }
  }
  return outcome;
  };

  if (!multi) {
    // One language: the one instrument is settled before the pass, as it always was.
    const one = (door: Door): Instruments => new Instruments(async () => door);
    if ((needsAdapter || options.observe === true) && options.adapter === undefined && options.adapters === undefined && options.server !== false) {
      return withWarmAdapter(root, (remote, server, reason) => pass(one({ adapter: remote, server, reason }), { language: remote?.language ?? config.language, server: server ?? "none" }, reason), {
        refresh: options.refresh ?? [],
        idleMs: options.idleMs,
      });
    }
    const given = options.adapter ?? options.adapters?.[config.language];
    if (given !== undefined) {
      // An adapter handed in lives in this process: no server was warm before it.
      await given.forget(options.refresh ?? []);
      return pass(one({ adapter: given, server: "cold", reason: undefined }), { language: given.language, server: "cold" }, undefined);
    }
    return pass(one({ adapter: undefined, server: undefined, reason: undefined }), { language: config.language, server: "none" }, undefined);
  }

  // Several languages: each language's instrument is reached through the one door only when a check first asks for it, and let go after.
  return withWarmAdapters(
    root,
    (open) => {
      const instruments = new Instruments(async (language): Promise<Door> => {
        const given = options.adapters?.[language] ?? (options.adapter?.language === language ? options.adapter : undefined);
        if (given !== undefined) {
          await given.forget(options.refresh ?? []);
          return { adapter: given, server: "cold", reason: undefined };
        }
        if (options.adapter !== undefined || options.adapters !== undefined || options.server === false) return { adapter: undefined, server: undefined, reason: `no ${language} adapter was handed to this run` };
        const door = await open(language);
        if (door.adapter === undefined) return { adapter: undefined, server: undefined, reason: door.reason };
        await door.adapter.forget(options.refresh ?? []);
        return { adapter: door.adapter, server: door.server, reason: undefined };
      });
      return pass(instruments, undefined, undefined);
    },
    { idleMs: options.idleMs },
  );
}

/**
 * The record's instrument for a multi-language run: the one language whose
 * server answered, as before; or, when several did, their names joined with
 * `+`, cold when any was, and each one under `languages`; the primary
 * language with no server when none was asked.
 */
function instrumentOf(config: EnforcementConfig, doors: readonly { language: string; door: Door }[]): RunRecord["instrument"] {
  const used = doors.map(({ language, door }) => ({ language, server: door.adapter === undefined ? ("none" as const) : (door.server ?? "none") }));
  if (used.length === 0) return { language: config.language, server: "none" };
  if (used.length === 1) return used[0]!;
  const server = used.some((u) => u.server === "none") ? "none" : used.some((u) => u.server === "cold") ? "cold" : "warm";
  return { language: used.map((u) => u.language).join("+"), server, languages: used };
}

/**
 * `run --each`: every totality oracle the batched invocation ran, run again in its own invocation through the
 * config's `test` command, appended as a second record so each record stays one pass. A test that passed batched
 * and fails alone passed on what an earlier test left behind (df-9e673484); the second record's verdict is the
 * latest, so the status view shows it as a structural defect.
 */
async function confirmEach(
  root: string,
  config: EnforcementConfig,
  options: RunOptions,
  batchedDetails: readonly EntryDetail[],
  instrument: RunRecord["instrument"],
  recorded: ReadonlySet<string>,
  now: () => Date,
): Promise<Omit<EachOutcome, "file">> {
  const started = Date.now();
  const details: EntryDetail[] = [];
  const hidden: EntryDetail[] = [];
  const unconfirmed: EntryDetail[] = [];
  // Each batched detail carries the filter it ran under and its setup, so the confirmation re-runs that test, whichever of an invariant's vias it was, through the same runner.
  for (const batched of batchedDetails) {
    const { component, name } = batched.entry;
    const filter = batched.filter;
    if (filter !== undefined) {
      const t0 = Date.now();
      const setup = config.tests[batched.setup ?? 0] ?? config;
      const result = await runTotalityOracle(root, setup, filter, options.timeoutMs);
      const reason = batched.entry.verdict === "pass" && result.verdict !== "pass" ? `passed in the batched invocation, ${result.verdict === "fail" ? "failed" : "did not run"} in its own: ${result.reason}` : result.reason;
      const detail: EntryDetail = {
        entry: {
          ...entryOf(component, name, "totality oracle", {
            verdict: result.verdict,
            grade: undefined,
            refutation: recorded.has(entryKey(component, name, "totality oracle")) ? "witnessed" : "missing",
            bypasses: [],
            testReferences: 0,
            files: [],
            latency: Date.now() - t0,
            reason,
            ...(batched.entry.language === undefined ? {} : { language: batched.entry.language }),
          }),
          mode: "one-at-a-time",
        },
        totality: result,
        ...(batched.setup === undefined ? {} : { setup: batched.setup }),
      };
      details.push(detail);
      if (batched.entry.verdict === "pass" && result.verdict === "fail") hidden.push(detail);
      if (batched.entry.verdict === "pass" && result.verdict === "not run") unconfirmed.push(detail);
    }
  }
  const { commit, dirty } = gitState(root);
  const record: RunRecord = {
    at: now().toISOString(),
    session: options.session,
    agent: options.agent,
    ...workBinding(root, options.session),
    commit,
    dirty,
    instrument,
    latency: Date.now() - started,
    load: machineLoad(),
    invariants: details.map((d) => d.entry),
  };
  return { record, details, hidden, unconfirmed };
}

/**
 * One language's warm instrument through the one door, for the run and for a
 * reading that needs the adapter itself (the economy's closure): re-reads the
 * named files, hands the adapter to `fn` with whether the server was warm,
 * and ends the connection after. When no server answers, `fn` gets no
 * adapter and the reason, so a caller records not run rather than crashing.
 */
export async function withWarmAdapter<T>(
  root: string,
  fn: (adapter: RemoteAdapter | undefined, server: "cold" | "warm" | undefined, reason: string | undefined) => Promise<T>,
  options: { refresh?: readonly string[] | undefined; idleMs?: number | undefined; language?: string | undefined } = {},
): Promise<T> {
  return withWarmAdapters(
    root,
    async (open) => {
      const door = await open(options.language);
      let reason = door.reason;
      if (door.adapter !== undefined) {
        try {
          await door.adapter.forget(options.refresh ?? []);
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      return fn(door.adapter, door.server, reason);
    },
    { idleMs: options.idleMs },
  );
}

/**
 * The one door to the warm instruments: `open` connects over the socket to
 * one language's warm server (the primary's when no language is named) the
 * first time it is asked, spawning it detached when none listens, never
 * before, and every connection is ended after `fn`. A language whose server
 * cannot be reached answers with the reason, so a caller says so rather than
 * crashing. Nothing else connects.
 */
export async function withWarmAdapters<T>(
  root: string,
  fn: (open: (language?: string) => Promise<{ adapter: RemoteAdapter | undefined; server?: "cold" | "warm" | undefined; reason?: string | undefined }>) => Promise<T>,
  options: { idleMs?: number | undefined } = {},
): Promise<T> {
  const remotes: RemoteAdapter[] = [];
  const opened = new Map<string, Promise<{ adapter: RemoteAdapter | undefined; server?: "cold" | "warm" | undefined; reason?: string | undefined }>>();
  const open = (language?: string): Promise<{ adapter: RemoteAdapter | undefined; server?: "cold" | "warm" | undefined; reason?: string | undefined }> => {
    let door = opened.get(language ?? "");
    if (door === undefined) {
      door = connectAdapter(root, { ...(language === undefined ? {} : { language }), ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }) }).then(
        (connected) => {
          remotes.push(connected.adapter);
          return { adapter: connected.adapter, server: connected.server };
        },
        (error: unknown) => ({ adapter: undefined, reason: error instanceof Error ? error.message : String(error) }),
      );
      opened.set(language ?? "", door);
    }
    return door;
  };
  try {
    return await fn(open);
  } finally {
    for (const remote of remotes) await remote.close();
  }
}

/**
 * Warm the project's instrument: connect to its warm server, which a
 * connection spawns when none listens and which loads the project as it
 * starts, then let go. A hook starts this detached at a session's start and
 * at each prompt, so the stop that ends the turn finds the server loaded and
 * its idle timer fresh. Nothing is printed and nothing is recorded.
 */
export async function warmInstrument(root: string): Promise<void> {
  await withWarmAdapter(root, async () => {});
}

/**
 * Each entry's bullet state as this record leaves it, with what its form
 * enforces through, set on the entries before the record is appended: the
 * model is loaded with the record read in as the latest run, so the state is
 * the one loadSpecModel derives and no other. The invariant floor
 * (src/spec/floor.ts) reads it.
 */
export function gradeRecord(root: string, record: RunRecord): void {
  const after = loadSpecModel(root, { pending: record });
  const byKey = new Map(after.components.flatMap((c) => c.invariants.map((i) => [`${c.folder}\u0000${i.name}`, i] as const)));
  for (const entry of record.invariants) {
    const invariant = byKey.get(`${entry.component}\u0000${entry.name}`);
    if (invariant === undefined) continue;
    entry.state = invariant.state;
    entry.enforces = enforcesOf(invariant, entry.form);
  }
}

function entryOf(component: string, name: string, form: Form, rest: Omit<RunEntry, "component" | "name" | "form" | "grade"> & { grade: RunEntry["grade"] | undefined }): RunEntry {
  const { grade, ...others } = rest;
  return grade === undefined ? { component, name, form, ...others } : { component, name, form, grade, ...others };
}

/** The configuration the run reads, for callers that print it. */
export function enforcementConfigFor(root: string): EnforcementConfig {
  return readEnforcementConfig(root);
}
