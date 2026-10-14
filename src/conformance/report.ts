/**
 * The conformance report and its verdict. Green needs all three:
 *
 *   1. every captured trace replays through the model;
 *   2. every landmark is reached by some test;
 *   3. every guard scenario is found true and false, or acknowledged in the
 *      config as unfalsifiable, with why.
 *
 * Every run also says how many logged arguments pin a step's parameter,
 * N/M, and names each one that pins nothing: an argument whose name no
 * parameter takes checks nothing while the run stays green, so the ratio is
 * what tells a real check from a decorative one, and a drop against the
 * model's last verdict fails the run.
 *
 * Each failure names the side that can fix it, since that decides whether
 * the next attempt is cheap:
 *
 *   replay-side    the model, the name map, the search bounds, the
 *                  acknowledgements: the stored traces replay again, no test runs
 *   capture-side   the instrumented sites, the logged arguments, the tests, the
 *                  test command: the traces must be captured again
 *
 * A guard that refuses a trace is replay-side only when the model moved since
 * its last agreeing verdict and the code did not; otherwise it is the code's.
 * A failing guard is a finding: assume the code is wrong before the model.
 */

import type { CaptureMeta, ConformanceVerdict } from "./store.ts";
import type { Coverage } from "./coverage.ts";
import type { TraceResult } from "./replay.ts";

/** The line printed beside every guard failure: the rule the whole check rests on. */
export const FINDING_RULE = "a failing guard is a finding: assume the code is wrong before the model, and never relax a guard to make a trace pass";

export interface ModelReport {
  verdict: ConformanceVerdict;
  lines: string[];
}

/** Which side moved since the model last agreed: its capture, its replay inputs, both, or neither known. */
export interface Moved {
  capture: boolean;
  model: boolean;
  /** Whether the model has agreed before. */
  prior: boolean;
}

/** Build one model's verdict and its printed report from its replay and coverage. */
export function reportModel(input: {
  base: Pick<ConformanceVerdict, "at" | "session" | "agent" | "commit" | "dirty" | "model" | "file" | "captureHash" | "replayHash">;
  meta: CaptureMeta;
  traces: readonly TraceResult[];
  coverage: Coverage | undefined;
  excluded: Record<string, number>;
  /** Why replay could not run at all, when it could not. */
  failure?: string | undefined;
  moved: Moved;
  /** The pinning ratio of the model's last verdict, when there is one. */
  lastRatio?: { pinned: number; logged: number } | undefined;
  replayOnly: boolean;
  verbose?: boolean;
}): ModelReport {
  const { base, meta, traces, coverage } = input;
  const failures: ConformanceVerdict["failures"] = [];
  const lines: string[] = [];
  const matched = traces.filter((t) => t.matched).length;
  const args = traces.flatMap((t) => t.arguments);
  const pinned = args.filter((a) => a.pinned).length;
  const unpinned = [...new Set(args.filter((a) => !a.pinned).map((a) => `${a.action}.${a.name}`))].sort();
  const guardSide: "replay-side" | "capture-side" = input.moved.prior && input.moved.model && !input.moved.capture ? "replay-side" : "capture-side";

  lines.push(`${base.model} (${base.file}): ${input.replayOnly ? `replay only: capture ${base.captureHash.slice(0, 12)} is current` : `captured ${base.captureHash.slice(0, 12)}`}`);
  if (traces.length === 0) failures.push({ side: "capture-side", cause: "no trace of this model's scopes reached the collector: are its sites instrumented with its scope, and do the tests that reach them pass?" });
  if (input.failure !== undefined) failures.push({ side: "replay-side", cause: input.failure });
  if (meta.clients.dropped > 0 || meta.clients.unattributed > 0) failures.push({ side: "capture-side", cause: `events lost in the capture: ${meta.clients.dropped} dropped, ${meta.clients.unattributed} logged outside any test, or while two tests ran at once in one process` });

  lines.push(`  traces: ${matched}/${traces.length} replay`);
  for (const trace of traces) {
    if (trace.matched && input.verbose !== true) continue;
    if (input.failure !== undefined) continue;
    lines.push(`  ${trace.matched ? "✓" : "✕"} ${trace.test}${trace.matched ? "" : `: ${trace.cause ?? "unmatched"}`}`);
    // A model replay cannot drive at all is one failure, said once above, never one per trace.
    if (!trace.matched && input.failure === undefined) {
      const step = trace.steps.find((s) => s.step === trace.failedAt);
      const planning = step === undefined || step.outcome === "unresolved";
      const side = planning ? "replay-side" : guardSide;
      failures.push({ test: trace.test, side, ...(trace.failedAt === undefined ? {} : { step: trace.failedAt }), cause: trace.cause ?? "unmatched" });
      if (!planning) lines.push(`      ${FINDING_RULE}`);
    }
    if (input.verbose === true || !trace.matched)
      for (const s of trace.steps) {
        const pins = s.pinned.map((p) => `${p.param}=${p.value}`).join(", ");
        const searched = s.searched.length === 0 ? "" : `; searched ${s.searched.map((x) => `${x.param}=${x.chose} of ${x.tried}`).join(", ")}`;
        const falses = s.falseGuards.length === 0 ? "" : `; false guards #${s.falseGuards.join(", #")}`;
        lines.push(`      ${s.step}. ${s.logged} -> ${s.action ?? "?"} ${s.outcome} (${pins}${searched}${falses})${s.writes.length === 0 ? "" : ` writes ${s.writes.join(", ")}`}`);
      }
  }

  lines.push(`  ${pinned}/${args.length} logged args pin a step choice`);
  if (unpinned.length > 0) lines.push(`  warning: these logged arguments pin nothing, so the check each was logged for does nothing: ${unpinned.join(", ")}; name each as the model parameter it should pin`);
  if (input.lastRatio !== undefined && input.lastRatio.logged > 0 && args.length > 0 && pinned / args.length < input.lastRatio.pinned / input.lastRatio.logged) {
    failures.push({ side: "replay-side", cause: `the pinning ratio dropped from ${input.lastRatio.pinned}/${input.lastRatio.logged} to ${pinned}/${args.length}: an argument stopped pinning its parameter (${unpinned.join(", ") || "renamed"})` });
  }
  const excluded = Object.entries(input.excluded);
  if (excluded.length > 0) lines.push(`  excluded by scope: ${excluded.map(([s, n]) => `${n} ${s}`).join(", ")}`);
  lines.push(`  capture: test command exited ${meta.exit}; ${meta.collector.queued} trace(s) queued, ${meta.collector.discarded} failed test(s) discarded, ${meta.collector.unfinished} unfinished; ${meta.clients.acknowledged}/${meta.clients.posted} events acknowledged`);

  const unreached: string[] = [];
  const gaps: string[] = [];
  if (coverage !== undefined) {
    for (const l of coverage.landmarks) {
      if (l.reached) continue;
      unreached.push(l.name);
      failures.push({ side: "capture-side", cause: `${l.name} is reached by no test: write a test that reaches it, or instrument the branch that does` });
    }
    lines.push(`  landmarks: ${coverage.landmarks.filter((l) => l.reached).length}/${coverage.landmarks.length} reached${unreached.length === 0 ? "" : `; unreached ${unreached.join(", ")}`}`);
    for (const s of coverage.scenarios) {
      if (s.outcome === "gap") {
        gaps.push(s.id);
        failures.push({ side: "capture-side", cause: `gap: ${s.id} (${s.text}) is falsifiable but no test exercises its refusal path` });
      } else if (s.outcome === "unfalsifiable") {
        gaps.push(s.id);
        failures.push({ side: "replay-side", cause: `${s.id} (${s.text}) was never false and the probe could not make it false (${coverage.probe}): widen the domain, or acknowledge it in conformance.models.${base.model}.acknowledged with why` });
      } else if (s.outcome === "unexercised") {
        gaps.push(s.id);
        failures.push({ side: "capture-side", cause: `${s.id} (${s.text}) was ${s.seenTrue ? "never found false" : s.seenFalse ? "never found true: its action never fired" : "never evaluated: no test reached its action"}${coverage.probeFailure === undefined ? "" : `; the probe could not run: ${coverage.probeFailure}`}${s.unproven === undefined ? "" : `; whether it can be false is undecided: ${s.unproven}`}` });
      }
    }
    const tested = coverage.scenarios.filter((s) => s.outcome === "tested" || s.outcome === "acknowledged").length;
    lines.push(`  guard scenarios: ${tested}/${coverage.scenarios.length} found true and false or acknowledged (probe: ${coverage.probe})`);
    for (const s of coverage.scenarios.filter((x) => x.outcome === "acknowledged")) lines.push(`    acknowledged ${s.id}: ${s.because}`);
    lines.push(`  families: ${coverage.families.covered} covered by tests, ${coverage.families.simulated} reached in simulation, ${coverage.blind.length} blind`);
    const shown = input.verbose === true ? coverage.blind : coverage.blind.slice(0, 3);
    for (const b of shown) lines.push(`    blind [${b.family.join(", ")}]: ${b.cause}`);
    if (shown.length < coverage.blind.length) lines.push(`    and ${coverage.blind.length - shown.length} more blind families (--verbose lists them)`);
  }

  const verdict: ConformanceVerdict = {
    ...base,
    verdict: failures.length === 0 ? "agrees" : "disagrees",
    matched,
    total: traces.length,
    pinned,
    logged: args.length,
    unpinned,
    failures,
    unreached,
    gaps,
  };
  lines.push(`  verdict: ${verdict.verdict}${failures.length === 0 ? "" : ` (${failures.length} failure${failures.length === 1 ? "" : "s"})`}`);
  for (const f of failures) lines.push(`    ${f.side}: ${f.test === undefined ? "" : `${f.test}: `}${f.cause}`);
  return { verdict, lines };
}
