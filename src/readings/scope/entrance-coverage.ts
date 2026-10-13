/**
 * Entrance coverage (c-3760638e): how much of the surface the reading
 * detected the declared entrances cover, so a spec-gap count can be read
 * against it. A project that declares 14 coarse entrances and one that
 * declares 94 fine ones over the same code have gap counts that cannot be
 * compared; their coverage can.
 *
 * A detected entrance is covered when a declared entrance
 *   names it     the handler is its symbol, in its file (a symbol registered
 *                in a route table or a URL pattern is matched by name, since
 *                it is declared elsewhere); a file-grain one (a script, a
 *                package bin) is named by any handler in that file
 *   or, when the handler names no detected entrance, stands for it:
 *     through    its own statement calls the handler (every server function
 *                wrapped in mutationRpc, for "server function mutations",
 *                handled by mutationRpc)
 *     module     it is detected in the handler's own file (a registry: a
 *                urls.py whose urlpatterns is the handler)
 * It is covered individually when some entrance covering it covers nothing
 * else, and by a grouped entrance otherwise. Pure, and browser-safe: the view,
 * the query and orient read the same derivation.
 */

import type { EntranceCandidate } from "../../adapters/entrance-candidates.ts";
import type { Language } from "../../adapters/index.ts";
import type { SpecComponent } from "./model.ts";

/** The rules, per language, each with its plural and what it detects: the documentation the query prints and the spec states, and the one place a rule's plural is said. */
export const CANDIDATE_RULES: Record<Language, readonly { rule: string; plural: string; detects: string }[]> = {
  typescript: [
    { rule: "server function", plural: "server functions", detects: "an exported const created by createServerFn (TanStack Start)" },
    { rule: "wrapped export", plural: "wrapped exports", detects: "an exported const created by calling a symbol a declared entrance names as its handler or guard" },
    { rule: "server route", plural: "server routes", detects: "an exported route created by createFileRoute with server handlers, createServerFileRoute or createAPIFileRoute" },
    { rule: "route handler", plural: "route handlers", detects: "a GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS a Next.js app/**/route file exports, declared there, in an export list or re-export, or destructured; a default export under pages/api; or an exported loader or action under app/routes" },
    { rule: "request proxy", plural: "request proxies", detects: "the proxy a Next.js proxy.ts exports, or the middleware a middleware.ts exports, at the root or under src/: declared, in an export list or re-export, or as the default export" },
    { rule: "page route", plural: "page routes", detects: "the default export of a Next.js app/**/page file, the page as a whole" },
    { rule: "server action", plural: "server actions", detects: "an exported function of a file that opens with 'use server'" },
    { rule: "route table", plural: "route table entries", detects: "an object literal naming a path or pattern that starts with / and a handler, on one line" },
    { rule: "route method", plural: "registered routes", detects: "a call like app.get('/path', handler) whose first argument is a path starting with /" },
    { rule: "package bin", plural: "package bins", detects: "a file package.json's bin names" },
    { rule: "package script", plural: "package scripts", detects: "a project file a package.json script runs with node, tsx, ts-node, bun, deno, vite-node or python" },
    { rule: "script", plural: "scripts", detects: "a file directly under a top-level scripts/ or bin/ folder that no project file imports" },
  ],
  python: [
    { rule: "url pattern", plural: "URL patterns", detects: "a path(), re_path() or url() in a urls.py that routes to a view (include() is delegation, not an entrance)" },
    { rule: "viewset", plural: "viewsets", detects: "a router.register('prefix', ViewSet) registration" },
    { rule: "route decorator", plural: "decorated routes", detects: "a function decorated @x.get/post/put/patch/delete/route/api_route/websocket('/path')" },
    { rule: "management command", plural: "management commands", detects: "a Command class in a management/commands/ module" },
    { rule: "task", plural: "tasks", detects: "a function decorated @shared_task or @<app>.task (Celery), or @activity.defn / @workflow.defn (Temporal)" },
    { rule: "console script", plural: "console scripts", detects: "a function pyproject.toml's [project.scripts] or [tool.poetry.scripts] names" },
    { rule: "script", plural: "scripts", detects: "a file directly under a top-level scripts/ folder with an if __name__ == \"__main__\" block" },
  ],
};

/** What the rules do not see, per language: said wherever the coverage is, so an absence is never read as none. */
export const NOT_DETECTED: Record<Language, string> = {
  typescript: "file routes outside a Next.js app/**/page without server handlers (their work enters through server functions), hand-written dispatchers, message consumers, workers and host callbacks are not detected",
  python: "views reached only through include(), hand-written dispatchers, message consumers and signal handlers are not detected",
};

/** A recorded reading's language, by name: its rules, or none for a name no language goes by. */
export function candidateRulesOf(language: string): readonly { rule: string; plural: string; detects: string }[] {
  const rules: Partial<Record<string, readonly { rule: string; plural: string; detects: string }[]>> = CANDIDATE_RULES;
  return rules[language] ?? [];
}

/** A recorded reading's language, by name: what its rules do not see, or nothing for a name no language goes by. */
export function notDetectedOf(language: string): string | undefined {
  const said: Partial<Record<string, string>> = NOT_DETECTED;
  return said[language];
}

export interface CoverageGroup {
  /** The folder of the component whose spec declares it. */
  component: string;
  name: string;
  handler: string;
  /** How many detected entrances it stands for. */
  covers: number;
  /** The rules of the detected entrances it stands for, most frequent first, for "stands for 36 server functions". */
  rules: string[];
}

export interface EntranceCoverage {
  /** Every detected entrance. */
  detected: number;
  /** Every declared entrance. */
  declared: number;
  /** Detected entrances some declared entrance covers alone. */
  individually: number;
  /** Detected entrances covered only by an entrance that stands for more than one. */
  grouped: number;
  /** The entrances that stand for more than one detected entrance, largest first. */
  groups: CoverageGroup[];
  /** Detected entrances no declared entrance covers, in file order. */
  uncovered: EntranceCandidate[];
  /** Declared entrances that cover no detected entrance: declared where the rules do not reach, or declared at a finer grain than they detect. */
  beyond: number;
}

const COVERAGE_NAMED = /^([A-Za-z_$][\w$]*)(?:\s+in\s+(\S+))?$/;

/** Whether a file the spec model resolved is the candidate's file; the spec model gives project-relative paths. */
function coverageSameFile(a: string | undefined, b: string): boolean {
  return a !== undefined && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`));
}

/** The coverage of `candidates` by every entrance the spec declares. Undefined when nothing was detected by an older reading (no candidates recorded). */
export function coverageOf(components: readonly Pick<SpecComponent, "folder" | "entrances">[], candidates: readonly EntranceCandidate[] | undefined): EntranceCoverage | undefined {
  if (candidates === undefined) return undefined;
  const symbols = new Set(candidates.map((c) => c.symbol).filter((s) => s !== ""));
  const coveredBy = new Map<EntranceCandidate, number[]>();
  const groups: CoverageGroup[] = [];
  const sizes: number[] = [];
  let beyond = 0;
  let declared = 0;
  for (const component of components) {
    for (const e of component.entrances) {
      declared += 1;
      const handler = e.handler?.trim() ?? "";
      const named = COVERAGE_NAMED.exec(handler);
      const symbol = named?.[1];
      const file = e.file;
      let set = candidates.filter((c) => (c.symbol === "" ? coverageSameFile(file, c.file) : symbol !== undefined && symbol === c.symbol && (c.registered === true || file === undefined || coverageSameFile(file, c.file))));
      if (set.length === 0) {
        // The handler names no detected entrance: it may be what they are registered through.
        const wrapper = symbol !== undefined && !symbols.has(symbol) ? symbol : undefined;
        set = candidates.filter((c) => (wrapper !== undefined && c.through?.includes(wrapper) === true) || (file !== undefined && c.symbol !== "" && coverageSameFile(file, c.file) && (symbol === undefined || !symbols.has(symbol))));
      }
      if (set.length === 0) {
        beyond += 1;
        continue;
      }
      const index = sizes.length;
      sizes.push(set.length);
      for (const c of set) coveredBy.set(c, [...(coveredBy.get(c) ?? []), index]);
      if (set.length > 1) {
        const tally = new Map<string, number>();
        for (const c of set) tally.set(c.rule, (tally.get(c.rule) ?? 0) + 1);
        groups.push({ component: component.folder, name: e.name, handler, covers: set.length, rules: [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([rule]) => rule) });
      }
    }
  }
  let individually = 0;
  let grouped = 0;
  const uncovered: EntranceCandidate[] = [];
  for (const c of candidates) {
    const by = coveredBy.get(c);
    if (by === undefined) uncovered.push(c);
    else if (by.some((i) => sizes[i] === 1)) individually += 1;
    else grouped += 1;
  }
  groups.sort((a, b) => b.covers - a.covers || a.name.localeCompare(b.name));
  return { detected: candidates.length, declared, individually, grouped, groups, uncovered, beyond };
}

function coveragePlural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The one-line summary the health strip, the query and orient share: "entrances: 94 declared, covering 118 of 124 detected; 6 undeclared". */
export function coverageLine(coverage: EntranceCoverage): string {
  const covered = coverage.individually + coverage.grouped;
  const grouping = coverage.groups.length === 0 ? "" : ` (${coverage.individually} individually, ${coverage.grouped} through ${coveragePlural(coverage.groups.length, "grouped entrance")})`;
  return `entrances: ${coverage.declared} declared, covering ${covered} of ${coveragePlural(coverage.detected, "detected entrance")}${grouping}; ${coverage.uncovered.length} undeclared`;
}

/** Each rule's plural, read off the rules themselves, so a rule added there is never counted as "<rule>s" (df-5c6288f3). */
export const RULE_PLURALS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(CANDIDATE_RULES).flatMap((rules) => rules.map((r) => [r.rule, r.plural])));

/** A count of entrances detected by one rule, in words: "1 request proxy", "3 request proxies". */
export function ruleCount(n: number, rule: string): string {
  return `${n} ${n === 1 ? rule : (RULE_PLURALS[rule] ?? "detected entrances")}`;
}

/** One grouped entrance in words: `"server function mutations" (mutationRpc) stands for 36 server functions`. */
export function groupLine(group: CoverageGroup): string {
  const rule = group.rules.length === 1 ? ` ${RULE_PLURALS[group.rules[0]!] ?? "detected entrances"}` : " detected entrances";
  return `"${group.name}" (${group.handler}) stands for ${group.covers}${rule}`;
}
