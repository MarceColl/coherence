/**
 * What the mirror reading puts in front of the agent, and what it proposes
 * (d-9f7c91c8). Pure functions over a reading; no file, no git, no parser,
 * so orient can use them on the recorded reading inside a hook's budget.
 *
 *   Never a spec problem, never blocking: everything here is advisory.
 *   Surfaced: a group that is cross-file, shares 3 or more names in one
 *     finding, and scores 20 or more. Everything else is listed on request.
 *   The alarm: a list of files drifted from the import closure of its own
 *     files, with the commit that grew the closure alone named. That shape is
 *     precise (BROWSER_SOURCES and b37627e), so it is named wherever it ranks.
 *   Proposed declarations: latent and duplicate findings of surfaced groups,
 *     and every alarm, as a pair the edit-time alarm can watch.
 */

import { DERIVED, type Finding, type Group, type MirrorReading, type SetRef, type Verdict } from "./model.ts";

/** The question's usage line, in query's usage and in its own errors. */
export const MIRRORS_USAGE = "  query mirrors [--all] [--limit <n>] [--rev <rev>] [--no-history] [--json | --proposals]   lists kept by hand that mirror another list, a folder or an import closure (hand lists), read from git objects at a revision; advisory: by default only cross-file groups sharing 3 or more names and scoring 20 or more; --proposals: the pairs proposed for declaration";

/** The threshold policy's numbers: a group shares at least this many names in one finding, and scores at least this much. */
export const SURFACE_SHARED = 3;
export const SURFACE_SCORE = 20;

function setsOf(group: Group): SetRef[] {
  return group.findings.flatMap((f) => [f.a, f.b, ...f.copies]);
}

/** Whether the group's sets live in more than one file: a copy beside its source is in the editor's sight. */
export function crossFile(group: Group): boolean {
  return new Set(setsOf(group).map((s) => s.file)).size > 1;
}

/** Whether the group is put in front of the agent: cross-file, three or more names shared in one finding, score 20 or more. */
export function surfaced(group: Group): boolean {
  return crossFile(group) && group.findings.some((f) => f.shared.length >= SURFACE_SHARED) && group.score >= SURFACE_SCORE;
}

/** The alarm-worthy shape: a list of files drifted from the import closure of its own files, with a missed commit named. */
export function isAlarm(finding: Finding): boolean {
  return finding.verdict === "drifted"
    && finding.b.form === "closure"
    && finding.b.list === `${finding.a.file}:${finding.a.line}`
    && (finding.history?.missed.length ?? 0) > 0;
}

export function alarmsOf(groups: readonly Group[]): Finding[] {
  return groups.flatMap((g) => g.findings.filter(isAlarm));
}

/**
 * A declaration proposed for the edit-time alarm, which owns the declaration
 * format; this is only the reading's proposal. `universe` is one recipe:
 *
 *   "closure of files"            the import closure of the list's own files
 *   "keys of <file>:<name>"       the keys of the object literal declared there
 *   "literal at <file>:<line>"    the other literal collection at that line
 */
export interface ProposedPair {
  list: { file: string; line: number; name: string };
  universe: string;
  /** The list's members as the reading saw them. */
  members: string[];
  /** The universe's members as the reading saw them. */
  mirrors: string[];
  verdict: Verdict;
  /** The group's rank in the reading, and the finding's score. */
  rank: number;
  score: number;
  /** For an alarm: the commits that grew one side alone. */
  missed?: string[];
  /** A third literal that accounts for the difference: the list together with it is the universe (KINDS with WORK_KINDS is RECORD_ROLES). */
  together?: { file: string; line: number; name: string };
}

/** The declaration name of a set: an object's keys or values are read off the object's name. */
function declared(s: SetRef): string {
  return s.name.replace(/ (keys|values)$/, "");
}

/** The universe recipe for a finding's other side, or undefined when it is none of the three (a folder, a module's exports, an index's closure). */
export function recipeOf(finding: Finding): string | undefined {
  const { a, b } = finding;
  if (b.form === "closure") return b.list === `${a.file}:${a.line}` ? "closure of files" : undefined;
  if (DERIVED.has(b.form)) return undefined;
  if (b.form === "keys") return `keys of ${b.file}:${declared(b)}`;
  return `literal at ${b.file}:${b.line}`;
}

/** The pairs the reading proposes to declare: latent and duplicate findings of surfaced groups, and every alarm. */
export function proposalsOf(groups: readonly Group[]): ProposedPair[] {
  const out: ProposedPair[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const f of group.findings) {
      const wanted = isAlarm(f) || (surfaced(group) && (f.verdict === "latent" || f.verdict === "duplicate"));
      if (!wanted || DERIVED.has(f.a.form)) continue;
      const universe = recipeOf(f);
      if (universe === undefined) continue;
      const key = `${f.a.file}:${f.a.line}:${f.a.name}|${universe}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const missed = f.history?.missed.map((m) => `${m.commit} added ${m.member} to the ${m.side === "a" ? "list" : "universe"} alone (${m.subject})`);
      out.push({
        list: { file: f.a.file, line: f.a.line, name: declared(f.a) },
        universe,
        members: f.a.members,
        mirrors: f.b.members,
        verdict: f.verdict,
        rank: group.rank,
        score: f.score,
        ...(isAlarm(f) && missed !== undefined ? { missed } : {}),
        ...(f.union === undefined ? {} : { together: { file: f.union.file, line: f.union.line, name: declared(f.union) } }),
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- text */

/** What the reading parses, said wherever it names what it did not read. */
export const PARSED_LANGUAGES = "TypeScript, JavaScript and Markdown";

/** The files left unread for their language, most first: "4123 .py files, 3 .rs files"; "" when none were. */
export function unreadText(unread: Readonly<Record<string, number>>): string {
  return Object.entries(unread).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([ext, n]) => `${n} ${ext} file${n === 1 ? "" : "s"}`).join(", ");
}

export function where(s: SetRef): string {
  return `${s.file}${s.line > 0 ? `:${s.line}` : ""} ${s.name} [${s.form}${s.checked ? ", checked" : ""}]`;
}

/** One alarm in one sentence: the list, what it lacks, and the commit that grew the closure alone. */
export function alarmText(f: Finding): string {
  const lacks = f.onlyB.slice(0, 4).join(", ") + (f.onlyB.length > 4 ? ` and ${f.onlyB.length - 4} more` : "");
  const extra = f.onlyA.length === 0 ? "" : `; it names ${f.onlyA.slice(0, 3).join(", ")} the closure does not reach`;
  const missed = (f.history?.missed ?? []).filter((m) => m.side === "b").slice(0, 2).map((m) => `${m.commit} added ${m.member} to the closure alone`);
  const named = missed.length > 0 ? missed.join("; ") : (f.history?.missed ?? []).slice(0, 1).map((m) => `${m.commit} added ${m.member} to the list alone`).join("");
  return `${declared(f.a)} (${f.a.file}:${f.a.line}) has drifted from the import closure of its own files${lacks === "" ? "" : `: it lacks ${lacks}`}${extra}; ${named}`;
}

export function findingLines(f: Finding): string[] {
  const lines = [`  ${f.verdict.toUpperCase()}  score ${f.score.toFixed(1)}  shared ${f.shared.length}, J ${f.jaccard.toFixed(2)}`, `     ${where(f.a)}`, `     ${where(f.b)}`];
  for (const c of f.copies) lines.push(`     copy: ${where(c)}`);
  if (f.union !== undefined) lines.push(`     = together with ${where(f.union)}`);
  if (f.onlyA.length > 0) lines.push(`     only in the first: ${f.onlyA.join(", ")}`);
  if (f.onlyB.length > 0) lines.push(`     only in the second: ${f.onlyB.join(", ")}`);
  const h = f.history;
  if (h !== undefined && h.together.length + h.lagged.length + h.missed.length > 0) {
    lines.push(`     history: kept together in ${h.together.length} commit(s); ${h.lagged.length} shared name(s) caught up later`);
    for (const m of h.missed.slice(0, 3)) lines.push(`     missed: ${m.commit} added ${m.member} to the ${m.side === "a" ? "first" : "second"} alone (${m.subject})`);
  }
  return lines;
}

/** The answer to query mirrors: alarms, then the groups asked for (surfaced ones by default), each with its findings. */
export function readingText(reading: MirrorReading, options: { all?: boolean; limit?: number } = {}): string {
  const shown = options.all === true ? reading.groups : reading.groups.filter(surfaced);
  const limited = options.limit === undefined ? shown : shown.slice(0, options.limit);
  const surfacedCount = reading.groups.filter(surfaced).length;
  const unread = unreadText(reading.unread);
  const lines = [
    `mirror reading at ${reading.commit.slice(0, 7)} (${reading.rev}): ${reading.sets} sets, ${reading.groups.length} groups, ${surfacedCount} worth a look (cross-file, ${SURFACE_SHARED} or more shared names, score ${SURFACE_SCORE} or more), in ${reading.ms} ms${unread === "" ? "" : `; not read: ${unread} (the reading parses ${PARSED_LANGUAGES})`}`,
    "Advisory: hand lists are never a spec problem and never block. --all lists every group.",
  ];
  const alarms = alarmsOf(reading.groups);
  if (alarms.length > 0) {
    lines.push("", "Drifted from its own import closure, with the commit named:");
    for (const f of alarms) lines.push(`  ${alarmText(f)}`);
  }
  for (const g of limited) {
    lines.push("", `#${g.rank}  score ${g.score.toFixed(1)}  ${g.findings.length} finding(s)${surfaced(g) ? "" : "  (on request)"}`);
    for (const f of g.findings.slice(0, options.all === true ? Infinity : 3)) lines.push(...findingLines(f));
    if (options.all !== true && g.findings.length > 3) lines.push(`  … and ${g.findings.length - 3} more in this group`);
  }
  if (limited.length < shown.length) lines.push("", `and ${shown.length - limited.length} more groups`);
  return lines.join("\n");
}
