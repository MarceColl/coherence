/**
 * A quint prop: a totality oracle whose detector is quint, checking one
 * property of the spec's quint model over every state the model reaches.
 * Three quint steps answer it, in order, through src/conformance/quint.ts:
 *
 *   typecheck   the model parses and types; a refusal fails the bullet
 *   simulate    quint run --invariant <property> within the configured samples and steps
 *   verify      quint verify --invariant <property>, the bounded model check
 *
 * Every step must answer. The prop passes `verified` when all three do, and
 * `simulated` only when the config turns verify off on purpose. A step that
 * is unavailable (no quint, no Java for the model checker) or timed out leaves
 * the prop not run, never passing: "quint verify unavailable" says what to
 * install, or to set quint.verify off to accept simulation only.
 *
 * A property proved of a model says nothing of the code until conformance
 * replay has held the model against it. With conformance.required set, the
 * prop also needs the model's latest conformance verdict to agree and be
 * current: disagrees fails it, and stale or absent leaves it not run.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQuintConfig, readConformanceConfig, type QuintConfig } from "../conformance/config.ts";
import { simulate, typecheck, verify, type QuintResult } from "../conformance/quint.ts";
import type { RunEntry } from "./record.ts";
import type { TotalityResult } from "./totality.ts";

/** The model's conformance verdict as a quint prop reads it: the latest verdict, and whether its capture and replay are still the current ones. */
export type ConformanceStanding = NonNullable<RunEntry["conformance"]>;

/** How the prop learns its model's conformance standing; the conformance store answers it. */
export type StandingOf = (root: string, folder: string) => ConformanceStanding | Promise<ConformanceStanding>;

export interface QuintPropResult extends TotalityResult {
  grade?: "verified" | "simulated";
  steps: NonNullable<RunEntry["quintSteps"]>;
  conformance: ConformanceStanding;
  counterexample?: string;
}

/** The lines quint printed for a violation, kept short enough for a record. */
function counterexampleOf(result: QuintResult): string {
  const lines = result.stdout.split("\n").filter((l) => l.trim() !== "");
  const text = lines.slice(0, 40).join("\n");
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/**
 * Check one quint prop: `model` is the spec's model file, project-relative,
 * or undefined when the spec names none. `standing` answers the model's
 * conformance; without one the prop reads absent and, unless the config
 * requires conformance, is not held back by it.
 */
export async function checkQuintProp(root: string, folder: string, model: string | undefined, property: string, standing?: StandingOf, quint: QuintConfig = readQuintConfig(root)): Promise<QuintPropResult> {
  if (model === undefined) return { command: `quint prop ${property}`, tail: "", steps: {}, verdict: "not run", reason: "the spec names no quint model file on its model: line", conformance: "absent" };
  const conformance: ConformanceStanding = standing === undefined ? "absent" : await standing(root, folder);
  // Quint runs from a scratch folder: the model checker writes its working files (_apalache-out) where it starts, never in the project.
  const scratch = mkdtempSync(join(tmpdir(), "coherence-quint-prop-"));
  try {
    return await quintSteps({ root, model, property, conformance, quint, cwd: scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The three quint steps of one prop, in order, from `cwd`; the first that does not answer ok settles the verdict. */
async function quintSteps(given: { root: string; model: string; property: string; conformance: ConformanceStanding; quint: QuintConfig; cwd: string }): Promise<QuintPropResult> {
  const { root, model, property, conformance, quint } = given;
  const file = join(root, model);
  const steps: QuintPropResult["steps"] = {};
  const base = { command: `quint prop ${property}`, tail: "", steps, conformance };
  const options = { cwd: given.cwd, timeoutMs: quint.timeoutSeconds * 1000 };
  const stepOf = (result: QuintResult): { outcome: string; ms: number } => ({ outcome: result.outcome, ms: result.ms });
  /** A step that did not answer leaves the prop not run; one that refused or found a violation fails it. */
  const settle = (name: string, result: QuintResult): QuintPropResult | undefined => {
    if (result.outcome === "ok") return undefined;
    const tail = `${result.stdout}\n${result.stderr}`.split("\n").filter((l) => l.trim() !== "").slice(-12).join("\n");
    if (result.outcome === "unavailable" || result.outcome === "timeout") {
      const hint = name === "verify" ? "; set quint.verify off to accept simulation only" : "";
      return { ...base, tail, verdict: "not run", reason: `quint ${name} ${result.outcome === "timeout" ? "did not finish" : "unavailable"}: ${result.reason}${hint}` };
    }
    if (result.outcome === "violation") return { ...base, tail, verdict: "fail", reason: `quint ${name} found a state of ${model} that breaks ${property}`, counterexample: counterexampleOf(result) };
    return { ...base, tail, verdict: "fail", reason: `quint ${name} refused ${model}: ${result.reason}` };
  };

  const checked = await typecheck(file, options);
  steps.typecheck = stepOf(checked);
  const typed = settle("typecheck", checked);
  if (typed !== undefined) return typed;

  const simulated = await simulate(file, property, quint, options);
  steps.simulate = stepOf(simulated);
  const sampled = settle("run", simulated);
  if (sampled !== undefined) return sampled;

  let grade: "verified" | "simulated" = "simulated";
  if (quint.verify === "off") steps.verify = { outcome: "skipped", ms: 0 };
  else {
    const proved = await verify(file, property, quint, options);
    steps.verify = stepOf(proved);
    const refused = settle("verify", proved);
    if (refused !== undefined) return refused;
    grade = "verified";
  }
  const how = grade === "verified" ? `typechecked, simulated (${quint.maxSamples} samples of ${quint.maxSteps} steps) and model-checked within ${quint.verifySteps} steps` : `typechecked and simulated (${quint.maxSamples} samples of ${quint.maxSteps} steps); verify is off in the config`;

  // The model's agreement with the code, when the config requires it: a property of a model nobody held against the code says nothing of the code.
  if (readConformanceConfig(root).required) {
    if (conformance === "disagrees") return { ...base, verdict: "fail", reason: `${property} holds in ${model}, but the model's latest conformance replay disagrees with the code`, grade };
    if (conformance !== "agrees") return { ...base, verdict: "not run", reason: `${property} holds in ${model}, but the model's conformance verdict is ${conformance}; run conform`, grade };
  }
  return { ...base, verdict: "pass", reason: `${property} holds in ${model}: ${how}${conformance === "absent" ? "" : `; conformance ${conformance}`}`, grade };
}
