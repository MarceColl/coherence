/**
 * The check's printed form: every component with its invariants and their
 * state, every problem with its file and line, and the counts.
 */

import type { Latest } from "../enforcement/record.ts";
import { fromText } from "./grammar.ts";
import type { Component, ModelInvariant, SpecModel } from "./model.ts";
import { LACKS } from "./state.ts";
import { defectFloorLines } from "../journal/defects.ts";

/** How the latest run left one enforcement, or "declared, unverified" when no run has checked it. */
export function verdictText(latest: Latest | undefined): string {
  if (latest === undefined) return "declared, unverified";
  const date = latest.at.slice(0, 10);
  const grade = latest.grade !== undefined ? ` ${latest.grade}` : latest.quintGrade !== undefined ? ` ${latest.quintGrade}` : "";
  switch (latest.verdict) {
    case "pass":
      return `verified ${date}${grade}`;
    case "fail":
      return `structural defect ${date}${grade}: ${latest.reason}`;
    case "not run":
      return `not run ${date}${grade}: ${latest.reason}`;
  }
}

function invariantLines(invariant: ModelInvariant): string[] {
  const lines: string[] = [];
  const lacks = invariant.lacks.length === 0 ? "" : `  lacks ${invariant.lacks.join(", ")}`;
  lines.push(`  ${invariant.name}  ${invariant.state}${lacks}`);
  for (const enforcement of invariant.enforcements) {
    const latest = invariant.latest.find((l) => l.form === enforcement.form);
    if (enforcement.form === "chokepoint") {
      const from = enforcement.from === undefined || enforcement.from === "anywhere" ? "" : ` from ${fromText(enforcement.from)}`;
      lines.push(`      chokepoint ${enforcement.chokepoint} protects ${enforcement.protects}${from}: ${verdictText(latest)}`);
    } else {
      const what = enforcement.quintProp === undefined ? `totality oracle "${enforcement.via}"` : `quint prop ${enforcement.quintProp}`;
      lines.push(`      ${what} over ${enforcement.over}: ${verdictText(latest)}`);
    }
  }
  if (invariant.crossing !== undefined) lines.push(`      crossing ${invariant.crossing.from} -> ${invariant.crossing.to}`);
  for (const refutation of invariant.refutations) lines.push(`      refuted ${refutation.date}: ${refutation.broke}`);
  if (invariant.kinds !== undefined) {
    const kinds = invariant.kinds === "none" ? "none" : invariant.kinds.join(", ");
    const declared = invariant.checklist.filter((line) => line.outcome === "declared").length;
    const dismissed = invariant.checklist.length - declared;
    const missing = invariant.missingShapes.length === 0 ? "" : `; missing ${invariant.missingShapes.join(", ")}`;
    lines.push(`      kinds ${kinds}: ${invariant.applicable.length} shapes apply, ${declared} declared, ${dismissed} dismissed${missing}`);
  }
  if (invariant.unfilled.length > 0) lines.push(`      unfilled: ${invariant.unfilled.join(", ")}`);
  return lines;
}

function componentLines(component: Component): string[] {
  const lines: string[] = [`${component.name}  ${component.specPath}`];
  if (component.owners !== undefined) lines.push(`  owners: ${component.owners.join(", ")}`);
  if (component.model !== undefined) lines.push(`  model: ${component.model.kind === "file" ? component.model.file : `${component.model.kind} — ${component.model.kind === "none" ? component.model.reason : component.model.what}`}`);
  if (component.trustLevels !== undefined) lines.push(`  trust levels: ${component.trustLevels.map((level) => level.name).join(", ")}`);
  if (component.invariants.length === 0) lines.push("  (no invariants)");
  for (const invariant of component.invariants) lines.push(...invariantLines(invariant));
  if (component.practicePath !== undefined) {
    lines.push(`  practices  ${component.practicePath}`);
    for (const p of component.practices) {
      const evidenced = p.steps.filter((s) => s.leaves !== undefined).length;
      lines.push(`  ${p.name}  ${p.state}, version ${p.version}, ${p.enactments} enacted; ${p.steps.length} steps (${evidenced} name their evidence), ${p.pitfalls.length} pitfalls`);
    }
  }
  return lines;
}

export function formatCounts(model: SpecModel): string {
  const c = model.counts;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lacking = LACKS.map((lack) => `${lack} ${c.lacking[lack]}`).join(", ");
  const defects = c.structuralDefects === 0 ? "" : `, ${plural(c.structuralDefects, "structural defect")}`;
  const runs =
    model.runs === undefined
      ? "no run yet: every enforcement is declared, unverified"
      : `latest run ${model.runs.latest} (${plural(model.runs.count, "run")}${model.runs.damaged === 0 ? "" : `, ${model.runs.damaged} unreadable`})`;
  const practices = model.components.flatMap((component) => component.practices);
  const practiceLine = practices.length === 0 ? [] : [`${plural(practices.length, "practice")}: ${practices.filter((p) => p.state === "established").length} established, ${practices.filter((p) => p.state === "candidate").length} candidate`];
  return [
    `${plural(c.components, "component")}, ${plural(c.bullets, "bullet")}: ${plural(c.invariants, "invariant")}, ${plural(c.requirements, "requirement")}${defects}`,
    `lacking: ${lacking}; unfilled placeholders ${c.unfilled}; ${plural(c.problems, "problem")}; ${runs}`,
    ...practiceLine,
  ].join("\n");
}

export function formatReport(model: SpecModel): string {
  const lines: string[] = [];
  for (const component of model.components) lines.push(...componentLines(component));
  if (model.components.length === 0) lines.push(`no spec under ${model.root}`);
  for (const problem of model.problems) lines.push(`PROBLEM  ${problem.file}:${problem.line}  ${problem.message}`);
  lines.push(formatCounts(model));
  lines.push(...crossingAloneLines(model.crossingAlone));
  // Advisory: specs naming no model in a project that has begun naming them and does not require the line.
  for (const spec of model.unmodelled ?? []) lines.push(`COVERAGE  ${spec.file}:${spec.line}  ${spec.message}`);
  // Advisory: a stored lexicon project that disagrees with the config's name, which is the one read.
  if (model.storedName !== undefined) lines.push(`NOTE  ${model.storedName.file}:${model.storedName.line}  ${model.storedName.message}`);
  // Advisory, after the counts: a close with neither a guard nor a decision, and each guard failure (defects.ts).
  lines.push(...defectFloorLines(model.defects));
  return lines.join("\n") + "\n";
}

/** How many entrance names one advisory line lists before it counts the rest. */
const NAMED = 6;

/**
 * Advisory, after the counts: each invariant that covered entrances by its
 * crossing alone and no longer does (covers.ts), the entrances that lost it,
 * and the line that names them. Never a problem: the old credit was the
 * over-claim, and naming is the adopter's to decide.
 */
export function crossingAloneLines(credits: SpecModel["crossingAlone"]): string[] {
  if (credits === undefined || credits.length === 0) return [];
  const byInvariant = new Map<string, NonNullable<SpecModel["crossingAlone"]>>();
  for (const credit of credits) {
    const key = `${credit.invariant.component}\u0000${credit.invariant.name}`;
    byInvariant.set(key, [...(byInvariant.get(key) ?? []), credit]);
  }
  return [...byInvariant.values()].map((group) => {
    const { invariant } = group[0]!;
    const names = group.map((c) => c.entrance.name);
    const listed = names.length <= NAMED ? names.join(", ") : `${names.slice(0, NAMED).join(", ")} and ${names.length - NAMED} more`;
    return `COVERAGE  ${invariant.specPath}:${invariant.line}  ${invariant.name} no longer covers ${names.length === 1 ? "an entrance" : `${names.length} entrances`} by its crossing alone: ${listed} lost it as a control. Under it, name the ones its test checks (entrances: <name>, <name>), or write entrances: none; scaffold control ${JSON.stringify(names[0])} proposes the line.`;
  });
}

export function hasProblems(model: SpecModel): boolean {
  return model.problems.length > 0;
}
