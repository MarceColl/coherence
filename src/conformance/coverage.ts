/**
 * Coverage, the second axis: agreement is cheap for a permissive model, and
 * coverage is what makes it count.
 *
 *   landmarks        every landmark_<name> the model declares must be reached
 *                    by some test's trace; one no test reaches is a gap
 *   guard scenarios  every guard of every action, conformance facts aside, is
 *                    found true by some step and false by some step (a rejected
 *                    attempt is where a guard is found false). One never found
 *                    false is probed: can any input its domain allows make it
 *                    false in a state the model reaches? If so, no test
 *                    exercises the refusal, and that is a gap. If the probe
 *                    never makes it false, the guard is untestable as declared:
 *                    widen the domain, or acknowledge it in the config with why.
 *   blind families   the behavior families the simulator reaches and no test
 *                    covers, each with its likeliest cause ruled in or out
 *                    in order: a test command that names part of the suite
 *                    first, then an action no trace ever logs (not
 *                    instrumented), and only then a genuine gap.
 *
 * The probe samples first (quint run with witnesses): a guard a sample makes
 * false is falsifiable. A sample that never does proves nothing, so each such
 * guard is then model-checked (quint verify, within the verify bound): only a
 * check that finds no falsifying state calls it unfalsifiable, and a checker
 * that cannot answer leaves it undecided, never unfalsifiable. With
 * quint.verify off the config accepts sampling alone, and the report says so.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { CapturedTrace } from "./collector.ts";
import type { ModelConformance, QuintConfig } from "./config.ts";
import type { ReadModel } from "./model-ir.ts";
import { runQuint, verify } from "./quint.ts";
import { literal, fromItf } from "./quint-values.ts";
import { REJECTED_ARGUMENT, type TraceResult } from "./replay.ts";

/** One guard scenario: an action's guard, and what replay and the probe found of it. */
export interface GuardScenario {
  /** action#index, as the config's acknowledged list names it. */
  id: string;
  text: string;
  seenTrue: boolean;
  seenFalse: boolean;
  /** Whether the probe made it false in a reachable state: undefined when no probe was needed (it was seen false). */
  falsifiable?: boolean;
  outcome: "tested" | "gap" | "unfalsifiable" | "acknowledged" | "unexercised";
  /** The acknowledgement's reason, when the config gives one. */
  because?: string;
  /** Why the model checker could not decide whether it can be false, when no sample made it false and the check did not answer. */
  unproven?: string;
}

export interface Coverage {
  landmarks: { name: string; reached: boolean; tests: number }[];
  scenarios: GuardScenario[];
  /** Families the simulator reached that no test covered, each with its cause. */
  blind: { family: string[]; cause: string }[];
  /** How many families the tests covered, and how many the simulator found. */
  families: { covered: number; simulated: number };
  /** The probe's bound, as the report states it: a sample, never a proof. */
  probe: string;
  /** Why the probe could not run, when it could not; its scenarios then read unexercised, never tested. */
  probeFailure?: string;
}

function importPath(from: string, to: string): string {
  const rel = relative(dirname(from), to).split("\\").join("/").replace(/\.qnt$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The values each parameter took across the traces, as quint literals of its type: the observed domain a probe draws from when the model declares none. */
function observedDomains(traces: readonly CapturedTrace[], model: ReadModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const types = new Map(model.actions.flatMap((a) => a.params.map((p) => [p.name, p.type] as const)));
  for (const trace of traces)
    for (const event of trace.events)
      for (const arg of event.arguments) {
        if (arg.name === REJECTED_ARGUMENT) continue;
        const type = types.get(arg.name);
        if (type === undefined) continue;
        const set = out.get(arg.name) ?? new Set<string>();
        for (const value of [arg.value, ...(Array.isArray(arg.domain) ? arg.domain : [])]) {
          try {
            set.add(literal(value, type, model.types));
          } catch {
            // A value the type refuses was already a replay failure; the probe leaves it out.
          }
        }
        out.set(arg.name, set);
      }
  return out;
}

/** The families each simulated ITF trace in `dir` reached, by the ghost landmarks it carries. */
function simulatedFamilies(dir: string, landmarks: readonly string[]): string[][] {
  const families: string[][] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".itf.json"))) {
    try {
      const itf = JSON.parse(readFileSync(join(dir, name), "utf8")) as { states?: Record<string, unknown>[] };
      const family: string[] = [];
      for (const state of itf.states ?? []) {
        const marks = fromItf(state["conform_marks_now"]) as boolean[] | undefined;
        (marks ?? []).slice(1).forEach((held, i) => {
          if (held && !family.includes(landmarks[i]!)) family.push(landmarks[i]!);
        });
      }
      families.push(family);
    } catch {
      // A torn trace file adds no family.
    }
  }
  return families;
}

/** What narrows a test command to part of the suite: a name filter, or the test files, folders or globs it names; undefined when it names none. */
export function testScope(command: string | readonly string[]): string | undefined {
  const words = typeof command === "string" ? command.trim().split(/\s+/) : [...command];
  const narrowing = words.slice(1).filter((w) => /^--?(test-name-pattern|test-skip-pattern|test-only|grep|match|filter|t|g)(=|$)/.test(w) || (!w.startsWith("-") && /[/*]|\.\w+$/.test(w)));
  return narrowing.length === 0 ? undefined : narrowing.join(" ");
}

/** Why no test covers a family the simulator reaches, ruled in order: the test command's scope (unknown when conform did not start the runner), then an action no trace logs, and only then a genuine gap. */
export function blindCause(testCommand: string | readonly string[] | undefined, uninstrumented: readonly string[]): string {
  const scope = testCommand === undefined ? "nothing conform can see: a runner it did not start" : testScope(testCommand);
  if (scope !== undefined) return `the test command may run part of the suite (it names ${scope}): run the whole suite before reading this family as a gap${uninstrumented.length === 0 ? "" : `, then check that ${uninstrumented.join(", ")} is instrumented`}`;
  if (uninstrumented.length > 0) return `not instrumented: no trace logs an event that resolves to ${uninstrumented.join(", ")}`;
  return "a genuine gap: the whole suite ran, every action is logged somewhere, and no test reaches this order";
}

/** Coverage of the model by the replayed traces, with the probe and the simulation run from `scratch`; `testCommand` is the one the capture ran, whose scope is ruled out before a blind family reads as a gap. */
export async function coverage(traces: readonly CapturedTrace[], results: readonly TraceResult[], model: ReadModel, conformance: ModelConformance, quint: QuintConfig, scratch: string, testCommand?: string | readonly string[]): Promise<Coverage> {
  const matched = results.filter((r) => r.matched);
  const landmarks = model.landmarks.map((name) => ({ name, reached: matched.some((r) => r.family.includes(name)), tests: matched.filter((r) => r.family.includes(name)).length }));
  const seen = new Map<string, { t: boolean; f: boolean }>();
  for (const r of results) for (const g of r.guardsSeen) {
    const id = `${g.action}#${g.index}`;
    const at = seen.get(id) ?? { t: false, f: false };
    if (g.value) at.t = true;
    else at.f = true;
    seen.set(id, at);
  }
  const scenarios: GuardScenario[] = model.actions.flatMap((action) =>
    action.guards.filter((g) => g.fact === undefined).map((g) => {
      const id = `${action.name}#${g.index}`;
      const found = seen.get(id) ?? { t: false, f: false };
      return { id, text: g.text.replace(/\s+/g, " "), seenTrue: found.t, seenFalse: found.f, outcome: found.t && found.f ? "tested" : "unexercised" } as GuardScenario;
    }),
  );

  mkdirSync(scratch, { recursive: true });
  const options = { cwd: scratch, timeoutMs: quint.timeoutSeconds * 1000 };
  const probe = `not falsified in ${quint.maxSamples} simulated traces of ${quint.maxSteps} steps${quint.verify === "off" ? " (quint.verify is off: sampled, never model-checked)" : `, nor by quint verify (${quint.verify}) within ${quint.verifySteps} steps`}`;
  const domains = observedDomains(traces, model);
  const probed = scenarios.filter((s) => !s.seenFalse);
  const witnesses: { scenario: GuardScenario; name: string; expression: string }[] = [];
  for (const scenario of probed) {
    const [actionName, index] = scenario.id.split("#") as [string, string];
    const action = model.actions.find((a) => a.name === actionName)!;
    const guard = action.guards[Number(index) - 1]!;
    // Each parameter's domain: the model's domain_<name>, else bool's two values, else the values the traces logged.
    const binders = action.params.map((p) => {
      if (model.domains.includes(`domain_${p.name}`)) return { name: p.name, set: `domain_${p.name}` };
      if (p.type.kind === "bool") return { name: p.name, set: "Set(false, true)" };
      const observed = [...(domains.get(p.name) ?? [])];
      return { name: p.name, set: observed.length === 0 ? undefined : `Set(${observed.join(", ")})` };
    });
    if (binders.some((b) => b.set === undefined)) continue;
    const expression = binders.reduceRight((inner, b) => `${b.set}.exists(${b.name} => ${inner})`, `not(${guard.text})`);
    witnesses.push({ scenario, name: `conform_falsifiable_${actionName}_${index}`, expression });
  }

  // One simulation answers every probe (as witnesses) and the reachable families (a ghost of landmarks per state).
  const path = join(scratch, "coverage.qnt");
  const marks = `[${["true", ...model.landmarks].join(", ")}]`;
  writeFileSync(
    path,
    [
      `module conform_coverage {`,
      `  import ${model.module}.* from "${importPath(path, model.file)}"`,
      `  var conform_marks_now: List[bool]`,
      `  action conform_init = all { init, conform_marks_now' = [] }`,
      `  action conform_step = all { step, conform_marks_now' = ${marks} }`,
      ...witnesses.map((w) => `  val ${w.name} = ${w.expression}`),
      `  val conform_true = true`,
      `}`,
    ].join("\n") + "\n",
  );
  // The ghost holds each state's landmarks one step late (the initial state's are read at the first step), so a family is read up to the state before the last.
  const itf = join(scratch, "itf-coverage");
  rmSync(itf, { recursive: true, force: true });
  mkdirSync(itf, { recursive: true });
  const argv = ["run", path, "--main", "conform_coverage", "--init", "conform_init", "--step", "conform_step", "--invariant", "conform_true", "--max-samples", String(quint.maxSamples), "--max-steps", String(quint.maxSteps), "--backend", quint.backend, "--n-traces", "50", "--out-itf", join(itf, "sim_{seq}.itf.json"), "--verbosity", "2"];
  if (quint.seed !== undefined) argv.push("--seed", quint.seed);
  if (witnesses.length > 0) argv.push("--witnesses", ...witnesses.map((w) => w.name));
  const run = await runQuint(argv, options);
  let probeFailure: string | undefined;
  if (run.outcome !== "ok") probeFailure = `quint run ${run.outcome}: ${run.reason}`;
  const unwitnessed: typeof witnesses = [];
  for (const w of witnesses) {
    if (probeFailure !== undefined) continue;
    const count = new RegExp(`${w.name} was witnessed in (\\d+) trace`).exec(run.stdout)?.[1];
    if (count !== undefined && Number(count) > 0) w.scenario.falsifiable = true;
    else if (quint.verify === "off") w.scenario.falsifiable = false;
    else unwitnessed.push(w);
  }
  // No sample made these false, which proves nothing: the model checker decides, over every state within its bound, whether some input makes each false.
  if (unwitnessed.length > 0) {
    const probePath = join(scratch, "probe.qnt");
    writeFileSync(probePath, [`module conform_probe {`, `  import ${model.module}.* from "${importPath(probePath, model.file)}"`, ...unwitnessed.map((w) => `  val ${w.name} = not(${w.expression})`), `}`].join("\n") + "\n");
    for (const w of unwitnessed) {
      const checked = await verify(probePath, w.name, quint, { ...options, main: "conform_probe" });
      if (checked.outcome === "violation") w.scenario.falsifiable = true;
      else if (checked.outcome === "ok") w.scenario.falsifiable = false;
      else w.scenario.unproven = `quint verify ${checked.outcome}: ${checked.reason}`;
    }
  }
  const acknowledged = new Map(conformance.acknowledged.map((a) => [a.guard, a.because]));
  for (const s of scenarios) {
    if (s.outcome === "tested") continue;
    const because = acknowledged.get(s.id);
    if (s.seenFalse) s.outcome = s.seenTrue ? "tested" : "unexercised";
    else if (s.falsifiable === true) s.outcome = "gap";
    else if (s.falsifiable === false) s.outcome = because === undefined ? "unfalsifiable" : "acknowledged";
    else s.outcome = "unexercised";
    if (because !== undefined) s.because = because;
  }

  const simulated = probeFailure === undefined ? simulatedFamilies(itf, model.landmarks) : [];
  const key = (f: readonly string[]): string => f.join(" > ");
  const covered = new Set(matched.map((r) => key(r.family)));
  const reachable = new Map(simulated.filter((f) => f.length > 0).map((f) => [key(f), f]));
  const logged = new Set(traces.flatMap((t) => t.events.flatMap((e) => conformance.names[e.action] ?? [e.action])));
  const uninstrumented = model.actions.filter((a) => !logged.has(a.name)).map((a) => a.name);
  const blind = [...reachable.entries()].filter(([k]) => !covered.has(k)).map(([, family]) => ({ family, cause: blindCause(testCommand, uninstrumented) }));
  return { landmarks, scenarios, blind, families: { covered: covered.size, simulated: reachable.size }, probe, ...(probeFailure === undefined ? {} : { probeFailure }) };
}
