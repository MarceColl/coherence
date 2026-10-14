/**
 * Replay: every captured trace, event by event, through the model.
 *
 * Quint offers no way to pin a choice from outside, so replay writes quint:
 * one module per capture and model that imports the model and adds a run per
 * trace. For each event, in order:
 *
 *   1. its logged action resolves to model actions: the config's name map
 *      (one logged name may be several actions), else the same name;
 *   2. each action's parameters are pinned from the logged arguments by name;
 *   3. a parameter no argument pins is searched over its domain (bool, or the
 *      model's pure val domain_<parameter>), within the config's bounds per
 *      pick, per step and per trace; a bound exceeded fails the trace;
 *   4. every guard is evaluated on the state the trace has reached. A step
 *      whose guards all hold fires its action; a step whose guards do not is
 *      an unmatched trace, never a step skipped. A rejected attempt (logged
 *      with rejected: true) must be refused by the model: some guard of the
 *      action, its conformance facts aside, must be false, and the state
 *      does not move.
 *
 * Two quint runs answer each trace. The first, the ghost run, records every
 * guard's value and every landmark at every state in variables of its own and
 * never fails, so a failing trace is read to its first failing step with the
 * guards that were false. The second runs the matched traces again through
 * the model's own actions with the arguments the first chose, and must pass:
 * a guard the reading missed would make the model refuse what the ghost
 * allowed, and that disagreement fails the trace rather than passing it.
 *
 * Each step's resolution is kept: which action fired (or refused), which
 * parameters were pinned and to what, what was searched and chosen, which
 * guards were false, and which variables the action writes. That record is
 * what makes a failure debuggable and a pass auditable.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { CapturedTrace, TraceEvent } from "./collector.ts";
import type { ModelConformance, QuintConfig } from "./config.ts";
import type { Guard, ModelAction, ReadModel } from "./model-ir.ts";
import { test as quintTest, testReport } from "./quint.ts";
import { ValueError, fromItf, literal, typeText } from "./quint-values.ts";

/** The argument a rejected attempt carries, which pins nothing. */
export const REJECTED_ARGUMENT = "rejected";

/** How one step resolved. */
export interface Resolution {
  /** The step's place in its trace, from 1. */
  step: number;
  /** The action the code logged. */
  logged: string;
  /** The model action that fired, refused, or was tried; absent when no action took the name. */
  action?: string;
  outcome: "fired" | "refused" | "rejected-stutter" | "unresolved";
  pinned: { param: string; value: string }[];
  searched: { param: string; tried: number; chose: string }[];
  /** The guards that were false, by index, on the step that refused or the rejection the model took. */
  falseGuards: number[];
  writes: string[];
  /** Why the step did not resolve, or what went wrong at it. */
  cause?: string;
}

export interface TraceResult {
  test: string;
  matched: boolean;
  steps: Resolution[];
  /** The first failing step's place, when the trace did not match. */
  failedAt?: number;
  /** Why it did not match. */
  cause?: string;
  /** The landmarks in the order each first fired: the trace's behavior family. */
  family: string[];
  /** Each guard scenario this trace saw: action#index with what it was found. */
  guardsSeen: { action: string; index: number; value: boolean }[];
  /** Logged arguments, each either pinning a parameter of its step's action or not. */
  arguments: { action: string; name: string; pinned: boolean }[];
}

export interface ReplayOutcome {
  traces: TraceResult[];
  /** Why replay could not run at all, when it could not (a model it cannot drive, quint refusing the generated module). */
  failure?: string;
  /** The generated module, project-relative, for a reader who wants to rerun it. */
  module?: string;
}

interface Candidate {
  action: ModelAction;
  /** Each parameter's quint literal. */
  args: Record<string, string>;
  pinned: { param: string; value: string }[];
  searched: { param: string; tried: number; chose: string }[];
}

interface PlannedStep {
  step: number;
  event: TraceEvent;
  rejected: boolean;
  candidates: Candidate[];
  /** Why the step cannot be replayed before quint runs: a name no action takes, a value its type refuses, a search bound exceeded. */
  failure?: string;
}

const STUTTER_SENTINEL = "true";

function eventArgs(event: TraceEvent): Map<string, unknown> {
  return new Map(event.arguments.filter((a) => a.name !== REJECTED_ARGUMENT).map((a) => [a.name, a.value]));
}

function isRejected(event: TraceEvent): boolean {
  return event.arguments.some((a) => a.name === REJECTED_ARGUMENT && a.value === true);
}

/**
 * Each logged argument of a trace, and whether it pins a parameter: its name
 * is a parameter of an action its event resolves to. An argument no parameter
 * takes pins nothing, and the check it was logged for silently does nothing.
 */
export function pinningOf(trace: CapturedTrace, model: ReadModel, conformance: ModelConformance): TraceResult["arguments"] {
  return trace.events.flatMap((event) => {
    const names = conformance.names[event.action] ?? [event.action];
    const params = new Set(model.actions.filter((a) => names.includes(a.name)).flatMap((a) => a.params.map((p) => p.name)));
    return event.arguments.filter((a) => a.name !== REJECTED_ARGUMENT).map((a) => ({ action: event.action, name: a.name, pinned: params.has(a.name) }));
  });
}

/** The cartesian product of each parameter's alternatives, in order. */
function product(lists: readonly (readonly { param: string; value: string }[])[]): { param: string; value: string }[][] {
  return lists.reduce<{ param: string; value: string }[][]>((acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])), [[]]);
}

/**
 * Plan one trace's steps: names resolved, parameters pinned by name, searched
 * parameters expanded within the bounds. `domains` holds each searched
 * parameter's alternatives, already written as quint literals.
 */
export function planTrace(trace: CapturedTrace, model: ReadModel, conformance: ModelConformance, domains: ReadonlyMap<string, string[]>): PlannedStep[] {
  const steps: PlannedStep[] = [];
  let spent = 0;
  for (const [i, event] of trace.events.entries()) {
    const step = i + 1;
    const rejected = isRejected(event);
    const names = conformance.names[event.action] ?? [event.action];
    const actions = names.map((n) => model.actions.find((a) => a.name === n)).filter((a): a is ModelAction => a !== undefined);
    if (actions.length === 0) {
      steps.push({ step, event, rejected, candidates: [], failure: `no model action takes ${event.action}${conformance.names[event.action] === undefined ? "" : ` (mapped to ${names.join(", ")})`}; map it in conformance.models.${conformance.folder}.names, or name the action as the model does` });
      break;
    }
    const logged = eventArgs(event);
    const candidates: Candidate[] = [];
    let failure: string | undefined;
    for (const action of actions) {
      const facts = new Set(action.guards.flatMap((g) => (g.fact === undefined ? [] : [g.fact])));
      const pinned: { param: string; value: string }[] = [];
      const open: { param: string; values: string[] }[] = [];
      for (const param of action.params) {
        if (logged.has(param.name)) {
          try {
            pinned.push({ param: param.name, value: literal(logged.get(param.name), param.type, model.types) });
          } catch (error) {
            failure = `${event.action}.${param.name}: ${error instanceof ValueError ? error.message : String(error)}`;
          }
          continue;
        }
        // A rejected attempt mutated nothing, so it logs no fact: its facts are left unbound and unchecked, and its other parameters must be logged.
        if (rejected && facts.has(param.name)) continue;
        if (rejected) {
          failure = `${event.action} was rejected without logging ${param.name}, so whether the model refuses it cannot be decided; log it at the site`;
          continue;
        }
        const values = domains.get(param.name) ?? (param.type.kind === "bool" ? ["false", "true"] : undefined);
        if (values === undefined) {
          failure = `${event.action}: parameter ${param.name} of ${action.name} is pinned by no logged argument and has no finite domain; log it at the site, or declare pure val domain_${param.name} in the model`;
          continue;
        }
        if (values.length > conformance.search.perPick) failure = `search bound: ${action.name}.${param.name} has ${values.length} alternatives, over perPick ${conformance.search.perPick}`;
        open.push({ param: param.name, values });
      }
      if (failure !== undefined) break;
      const combos = product(open.map((o) => o.values.map((value) => ({ param: o.param, value }))));
      if (combos.length > conformance.search.perStep) {
        failure = `search bound: step ${step} needs ${combos.length} alternatives for ${action.name}, over perStep ${conformance.search.perStep}`;
        break;
      }
      spent += open.length === 0 ? 0 : combos.length;
      for (const combo of combos) {
        const args = Object.fromEntries([...pinned, ...combo].map((p) => [p.param, p.value]));
        candidates.push({ action, args, pinned, searched: combo.map((c) => ({ param: c.param, tried: combos.length, chose: c.value })) });
      }
    }
    if (failure === undefined && spent > conformance.search.perRun) failure = `search bound: the trace needs ${spent} alternatives, over perRun ${conformance.search.perRun}`;
    steps.push({ step, event, rejected, candidates, ...(failure === undefined ? {} : { failure }) });
    if (failure !== undefined) break;
  }
  return steps;
}

/** The guards of an action, conformance facts aside: what decides whether the code's attempt is allowed at all. */
function attemptGuards(action: ModelAction): Guard[] {
  return action.guards.filter((g) => g.fact === undefined);
}

/** An expression evaluated with the candidate's arguments bound to its parameter names; a rejected attempt's unlogged facts stay unbound. */
function bound(candidate: Candidate, expression: string): string {
  const vals = candidate.action.params.filter((p) => candidate.args[p.name] !== undefined).map((p) => `val ${p.name} = ${candidate.args[p.name]}`).join(" ");
  return vals === "" ? `(${expression})` : `{ ${vals} ${expression} }`;
}

/** A guard's value as the ghost records it: a conformance fact whose parameter is unbound (a rejected attempt logs none) reads true and is never consulted. */
function guardValue(candidate: Candidate, guard: Guard): string {
  return guard.fact !== undefined && candidate.args[guard.fact] === undefined ? "true" : `(${guard.text})`;
}

function conjunction(guards: readonly Guard[]): string {
  return guards.length === 0 ? "true" : guards.map((g) => `(${g.text})`).join(" and ");
}

function call(candidate: Candidate): string {
  const args = candidate.action.params.map((p) => candidate.args[p.name]!);
  return args.length === 0 ? candidate.action.name : `${candidate.action.name}(${args.join(", ")})`;
}

/** A path for an import: relative, without the .qnt, with forward slashes, starting with a dot. */
function importPath(from: string, to: string): string {
  const rel = relative(dirname(from), to).split("\\").join("/").replace(/\.qnt$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The generated module's text: the ghost run of each planned trace, every guard and landmark recorded, never failing. */
export function ghostModule(path: string, model: ReadModel, traces: readonly { index: number; steps: PlannedStep[] }[]): string {
  const stutter = model.vars.map((v) => `${v.name}' = ${v.name}`);
  const marks = `[${[STUTTER_SENTINEL, ...model.landmarks].join(", ")}]`;
  const lines = [`module conform_replay {`, `  import ${model.module}.* from "${importPath(path, model.file)}"`, `  var conform_guards: List[List[List[bool]]]`, `  var conform_marks: List[List[bool]]`, `  action conform_init = all { init, conform_guards' = [], conform_marks' = [] }`];
  for (const { index, steps } of traces) {
    const names: string[] = [];
    for (const step of steps) {
      const name = `conform_t${index}_s${step.step}`;
      names.push(name);
      const values = step.candidates.map((c) => bound(c, `[${[STUTTER_SENTINEL, ...c.action.guards.map((g) => guardValue(c, g))].join(", ")}]`));
      const chosen = step.rejected ? "" : step.candidates.map((c) => `if (${bound(c, conjunction(c.action.guards))}) ${call(c)} else `).join("");
      const move = `${chosen}all { ${stutter.join(", ")} }`;
      lines.push(`  action ${name} = all {`, `    conform_marks' = conform_marks.append(${marks}),`, `    conform_guards' = conform_guards.append([${values.join(", ")}]),`, `    ${move},`, `  }`);
    }
    lines.push(`  action conform_t${index}_end = all { conform_marks' = conform_marks.append(${marks}), conform_guards' = conform_guards, ${stutter.join(", ")} }`);
    lines.push(`  run conform_ghost_${index} = conform_init${names.map((n) => `.then(${n})`).join("")}.then(conform_t${index}_end)`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** The confirming module: each matched trace through the model's own actions, with the arguments the ghost run chose, which must pass. */
export function checkModule(path: string, model: ReadModel, traces: readonly { index: number; steps: { candidate: Candidate; rejected: boolean }[] }[]): string {
  const stutter = model.vars.map((v) => `${v.name}' = ${v.name}`).join(", ");
  const lines = [`module conform_check {`, `  import ${model.module}.* from "${importPath(path, model.file)}"`];
  for (const { index, steps } of traces) {
    const actions = steps.map(({ candidate, rejected }) => (rejected ? `all { not(${bound(candidate, conjunction(attemptGuards(candidate.action)))}), ${stutter} }` : call(candidate)));
    lines.push(`  run conform_check_${index} = init${actions.map((a) => `.then(${a})`).join("")}`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** The probe that reads each named domain's value: one run whose ITF holds them. */
function domainModule(path: string, model: ReadModel, wanted: readonly { name: string; type: string }[]): string {
  return [
    `module conform_domains {`,
    `  import ${model.module}.* from "${importPath(path, model.file)}"`,
    ...wanted.map((d) => `  var conform_${d.name}: ${d.type}`),
    `  run conform_read_domains = all { init, ${wanted.map((d) => `conform_${d.name}' = ${d.name}`).join(", ")} }`,
    `}`,
  ].join("\n") + "\n";
}

/** The last state of each ITF trace quint wrote into `dir`, by run name. */
function lastStates(dir: string): Map<string, Record<string, unknown>> {
  const states = new Map<string, Record<string, unknown>>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".itf.json"))) {
    const run = /^itf_(.+)_\d+\.itf\.json$/.exec(name)?.[1];
    if (run === undefined) continue;
    try {
      const itf = JSON.parse(readFileSync(join(dir, name), "utf8")) as { states?: Record<string, unknown>[] };
      const last = itf.states?.[itf.states.length - 1];
      if (last !== undefined) states.set(run, last);
    } catch {
      // A torn trace file reads as no state: the run is reported unread, never as a pass.
    }
  }
  return states;
}

/**
 * Replay every trace through the model. `scratch` is a folder of the capture
 * the generated modules are written to; `cwd` is where quint runs.
 */
export async function replay(traces: readonly CapturedTrace[], model: ReadModel, conformance: ModelConformance, quint: QuintConfig, scratch: string): Promise<ReplayOutcome> {
  const unreplayable = (cause: string): ReplayOutcome => ({ traces: traces.map((t) => ({ test: t.test, matched: false, steps: [], cause, failedAt: 1, family: [], guardsSeen: [], arguments: [] })), failure: cause });
  if (model.problems.length > 0) return unreplayable(`the model cannot be replayed as written: ${model.problems.join("; ")}`);
  mkdirSync(scratch, { recursive: true });
  const options = { cwd: scratch, timeoutMs: quint.timeoutSeconds * 1000 };

  // The domains a search needs, read from the model once: a parameter some event leaves unpinned, with a domain_<name> the model declares.
  const needed = new Map<string, string>();
  for (const trace of traces)
    for (const event of trace.events) {
      const names = conformance.names[event.action] ?? [event.action];
      for (const action of model.actions.filter((a) => names.includes(a.name)))
        for (const param of action.params)
          if (!eventArgs(event).has(param.name) && model.domains.includes(`domain_${param.name}`) && !needed.has(param.name)) needed.set(param.name, typeText({ kind: "set", elem: param.type }));
    }
  const domains = new Map<string, string[]>();
  if (needed.size > 0) {
    const path = join(scratch, "domains.qnt");
    writeFileSync(path, domainModule(path, model, [...needed].map(([param, type]) => ({ name: `domain_${param}`, type }))));
    const itf = join(scratch, "itf-domains");
    rmSync(itf, { recursive: true, force: true });
    mkdirSync(itf, { recursive: true });
    const read = await quintTest(path, "^conform_read_domains$", quint, { ...options, main: "conform_domains", itf: join(itf, "itf_{test}_{seq}.itf.json") });
    if (read.outcome !== "ok") return unreplayable(`quint could not read the model's domains: ${read.reason}`);
    const state = lastStates(itf).get("conform_read_domains") ?? {};
    for (const [param] of needed) {
      const type = model.actions.flatMap((a) => a.params).find((p) => p.name === param)!.type;
      const set = fromItf(state[`conform_domain_${param}`]) as { "#set"?: unknown[] };
      try {
        domains.set(param, (set["#set"] ?? []).map((v) => literal(v, type, model.types)));
      } catch (error) {
        return unreplayable(`domain_${param}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const planned = traces.map((trace, index) => ({ index, trace, steps: planTrace(trace, model, conformance, domains) }));
  const ghostable = planned.filter((p) => p.steps.length > 0 && p.steps.every((s) => s.failure === undefined));
  const ghostPath = join(scratch, "ghost.qnt");
  writeFileSync(ghostPath, ghostModule(ghostPath, model, ghostable));
  const itfDir = join(scratch, "itf-ghost");
  rmSync(itfDir, { recursive: true, force: true });
  mkdirSync(itfDir, { recursive: true });
  const ghost = ghostable.length === 0 ? undefined : await quintTest(ghostPath, "^conform_ghost_", quint, { ...options, main: "conform_replay", itf: join(itfDir, "itf_{test}_{seq}.itf.json") });
  if (ghost !== undefined && (ghost.outcome === "error" || ghost.outcome === "unavailable" || ghost.outcome === "timeout")) return { ...unreplayable(`quint ${ghost.outcome === "error" ? "refused the generated replay module" : ghost.outcome === "timeout" ? "did not finish the replay" : "is unavailable"}: ${ghost.reason}`), module: ghostPath };
  const ghostReport = testReport(ghost?.json);
  const states = lastStates(itfDir);

  const results: TraceResult[] = [];
  const confirm: { index: number; steps: { candidate: Candidate; rejected: boolean }[] }[] = [];
  for (const { index, trace, steps } of planned) {
    const result: TraceResult = { test: trace.test, matched: true, steps: [], family: [], guardsSeen: [], arguments: pinningOf(trace, model, conformance) };
    results.push(result);
    const fail = (step: number, cause: string): void => {
      result.matched = false;
      result.failedAt ??= step;
      result.cause ??= cause;
    };
    const planning = steps.find((s) => s.failure !== undefined);
    if (planning !== undefined || steps.length === 0) {
      for (const s of steps) result.steps.push({ step: s.step, logged: s.event.action, outcome: "unresolved", pinned: [], searched: [], falseGuards: [], writes: [], ...(s.failure === undefined ? {} : { cause: s.failure }) });
      fail(planning?.step ?? 1, planning?.failure ?? "the trace holds no event");
      continue;
    }
    const state = states.get(`conform_ghost_${index}`);
    if (state === undefined || ghostReport?.failed.includes(`conform_ghost_${index}`) === true) {
      fail(1, `quint could not evaluate the trace through the model (a guard or an update raised an error on the logged values): run quint test ${relative(scratch, ghostPath)} --main conform_replay --match conform_ghost_${index}`);
      continue;
    }
    const guards = fromItf(state["conform_guards"]) as boolean[][][];
    const marks = fromItf(state["conform_marks"]) as boolean[][];
    const chosen: { candidate: Candidate; rejected: boolean }[] = [];
    for (const [i, step] of steps.entries()) {
      const values = (guards[i] ?? []).map((v) => v.slice(1));
      const allowed = step.candidates.map((c, k) => attemptGuards(c.action).every((g) => values[k]?.[g.index - 1] === true));
      const enabled = step.candidates.map((c, k) => c.action.guards.every((g) => values[k]?.[g.index - 1] === true));
      const falseOf = (k: number, only?: readonly Guard[]): number[] => (only ?? step.candidates[k]!.action.guards).filter((g) => values[k]?.[g.index - 1] !== true).map((g) => g.index);
      if (step.rejected) {
        const accepted = allowed.findIndex((ok) => ok);
        const k = accepted === -1 ? 0 : accepted;
        const candidate = step.candidates[k]!;
        for (const g of attemptGuards(candidate.action)) result.guardsSeen.push({ action: candidate.action.name, index: g.index, value: values[k]?.[g.index - 1] === true });
        result.steps.push({ step: step.step, logged: step.event.action, action: candidate.action.name, outcome: "rejected-stutter", pinned: candidate.pinned, searched: candidate.searched, falseGuards: falseOf(k, attemptGuards(candidate.action)), writes: [] });
        if (accepted !== -1) {
          result.steps[result.steps.length - 1]!.cause = `the code refused ${step.event.action} and the model allows it: every guard of ${candidate.action.name} holds`;
          fail(step.step, `step ${step.step}: the code refused ${step.event.action}, and ${candidate.action.name} allows it`);
          break;
        }
        chosen.push({ candidate, rejected: true });
        continue;
      }
      const firing = enabled.flatMap((ok, k) => (ok ? [k] : []));
      if (firing.length === 0) {
        const k = 0;
        const candidate = step.candidates[k]!;
        for (const g of candidate.action.guards.filter((g) => g.fact === undefined)) result.guardsSeen.push({ action: candidate.action.name, index: g.index, value: values[k]?.[g.index - 1] === true });
        const falses = falseOf(k);
        const texts = falses.map((n) => candidate.action.guards[n - 1]!).map((g) => `#${g.index} ${g.text.replace(/\s+/g, " ")}${g.fact === undefined ? "" : ` (the conformance fact ${g.fact})`}`);
        result.steps.push({ step: step.step, logged: step.event.action, action: candidate.action.name, outcome: "refused", pinned: candidate.pinned, searched: candidate.searched, falseGuards: falses, writes: candidate.action.writes, cause: `${candidate.action.name} refused it: ${texts.join("; ")}` });
        fail(step.step, `step ${step.step}: ${candidate.action.name}(${candidate.pinned.map((p) => `${p.param}=${p.value}`).join(", ")}) refused: ${texts.join("; ")}`);
        break;
      }
      const actionsFiring = new Set(firing.map((k) => step.candidates[k]!.action.name));
      const k = firing[0]!;
      const candidate = step.candidates[k]!;
      if (actionsFiring.size > 1) {
        result.steps.push({ step: step.step, logged: step.event.action, action: candidate.action.name, outcome: "unresolved", pinned: candidate.pinned, searched: candidate.searched, falseGuards: [], writes: [], cause: `ambiguous: ${[...actionsFiring].join(", ")} all fire` });
        fail(step.step, `step ${step.step}: ${step.event.action} is ambiguous: ${[...actionsFiring].join(", ")} all fire; pin an argument that tells them apart, or narrow the name map`);
        break;
      }
      for (const g of candidate.action.guards.filter((g) => g.fact === undefined)) result.guardsSeen.push({ action: candidate.action.name, index: g.index, value: true });
      result.steps.push({ step: step.step, logged: step.event.action, action: candidate.action.name, outcome: "fired", pinned: candidate.pinned, searched: candidate.searched.map((s) => ({ ...s, tried: step.candidates.filter((c) => c.action === candidate.action).length })), falseGuards: [], writes: candidate.action.writes });
      chosen.push({ candidate, rejected: false });
    }
    // The behavior family: each landmark in the order it first held, over the states the trace reached before any failing step.
    for (const at of marks.slice(0, result.matched ? marks.length : (result.failedAt ?? 1))) at.slice(1).forEach((held, i) => {
      const name = model.landmarks[i]!;
      if (held && !result.family.includes(name)) result.family.push(name);
    });
    if (result.matched) confirm.push({ index, steps: chosen });
  }

  // The matched traces again, through the model's own actions: what the ghost run allowed, the model must allow.
  if (confirm.length > 0) {
    const checkPath = join(scratch, "check.qnt");
    writeFileSync(checkPath, checkModule(checkPath, model, confirm));
    const checked = await quintTest(checkPath, "^conform_check_", quint, { ...options, main: "conform_check" });
    const report = testReport(checked.json);
    if (report === undefined || report.errors.length > 0) return { traces: results, failure: `quint refused the confirming module: ${checked.reason}`, module: ghostPath };
    for (const { index } of confirm) {
      if (!report.failed.includes(`conform_check_${index}`)) continue;
      const result = results[index]!;
      result.matched = false;
      result.failedAt ??= 1;
      result.cause = "the model's own actions refused a trace its guards allowed: an action holds a guard the reading did not see (a nested all, a let, an if); write its guards as top-level conjuncts";
    }
  }
  return { traces: results, module: ghostPath };
}
