/**
 * Python's entrance rules and the syntax they read by: the shapes Django,
 * FastAPI, Flask, Celery and Temporal fix, how a definition spans its
 * decorators and body, what binds a name, pyproject's console scripts and
 * the scripts with a __main__ block (entrance-candidates.ts reads them
 * through ENTRANCE_SYNTAX).
 */

import { posix } from "node:path";
import { languageOfFile } from "./language-files.ts";
import { escape, handlerName, spanOf, throughOf, type EntranceCandidate, type EntranceSyntax } from "./entrance-candidates.ts";

function pythonCandidates(file: string, text: string, wrappers: readonly string[]): EntranceCandidate[] {
  const out: EntranceCandidate[] = [];
  const lines = text.split("\n");
  const add = (c: Omit<EntranceCandidate, "through">, span: string): void => {
    const through = throughOf(span, text, wrappers, PYTHON_ENTRANCES);
    out.push(through === undefined ? c : { ...c, through });
  };
  /** The def or class a decorator at line i decorates: its name, and the line the decorators start on. */
  const decorated = (i: number): { name: string; start: number } | undefined => {
    let start = i;
    while (start > 0 && /^\s*@/.test(lines[start - 1] ?? "")) start -= 1;
    for (let j = i; j < lines.length; j++) {
      const def = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(lines[j] ?? "");
      if (def !== null) return { name: def[1]!, start };
      if (!/^\s*(@|#|$)/.test(lines[j] ?? "") && !/^\s+/.test(lines[j] ?? "")) return undefined;
    }
    return undefined;
  };
  const seen = new Set<number>();
  const urls = /(^|\/)urls\.py$/.test(file);
  const command = /(^|\/)management\/commands\/[^_/][^/]*\.py$/.test(file);
  // A URL pattern and a router registration are read over the whole text, not line by line: a call may break after its open parenthesis, its route and its handler on the lines below, as billing's seats/<id>/reactivate/ route is written.
  const lineAt = (index: number): number => text.slice(0, index).split("\n").length;
  const callText = (index: number, end: number): string => text.slice(index, end);
  if (urls) {
    for (const pattern of text.matchAll(/\b(?:re_path|path|url)\(\s*[rbuf]*["'][^"']*["']\s*,\s*([A-Za-z_][\w.]*(?:\.as_view\s*\([^)]*\))?)/g)) {
      if (/^include\b/.test(pattern[1]!)) continue;
      const symbol = handlerName(pattern[1]!);
      if (symbol !== "") add({ file, line: lineAt(pattern.index), symbol, rule: "url pattern", why: `a URL pattern routed to ${pattern[1]!.trim()}`, registered: true }, callText(pattern.index, pattern.index + pattern[0].length));
    }
  }
  for (const viewset of text.matchAll(/\b\w+\.register\(\s*[rbuf]*["'][^"']*["']\s*,\s*([A-Za-z_][\w.]*)/g)) {
    add({ file, line: lineAt(viewset.index), symbol: handlerName(viewset[1]!), rule: "viewset", why: `a router registration of ${viewset[1]}`, registered: true }, callText(viewset.index, viewset.index + viewset[0].length));
  }
  lines.forEach((line, i) => {
    if (command && /^class\s+Command\b/.test(line)) add({ file, line: i + 1, symbol: "Command", rule: "management command", why: `a Django management command, run as manage.py ${posix.basename(file, ".py")}` }, spanOf(lines, i, PYTHON_ENTRANCES));
    const route = /^\s*@[\w.]*\.(get|post|put|patch|delete|route|api_route|websocket)\(\s*[rbuf]*["'](\/[^"']*)["']/.exec(line);
    const task = /^\s*@(shared_task|[\w.]*\.task|(?:activity|workflow)\.defn)\b/.exec(line);
    if (route !== null || task !== null) {
      const target = decorated(i);
      if (target === undefined || seen.has(target.start)) return;
      seen.add(target.start);
      const span = spanOf(lines, target.start, PYTHON_ENTRANCES);
      if (route !== null) add({ file, line: target.start + 1, symbol: target.name, rule: "route decorator", why: `${target.name} is decorated @…${route[1]}('${route[2]}'): a web route` }, span);
      else add({ file, line: target.start + 1, symbol: target.name, rule: "task", why: `${target.name} is decorated @${task![1]}: ${/defn$/.test(task![1]!) ? "a Temporal worker runs it" : "a Celery worker runs it"}` }, span);
    }
  });
  return out;
}

/** Whether the file imports or declares the name: a from-import naming it, or a def, class or module-level binding of it. */
function binds(text: string, name: string): boolean {
  const n = escape(name);
  return new RegExp(`^\\s*from\\s+\\S+\\s+import\\s+[^\\n]*\\b${n}\\b`, "m").test(text) || new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${n}\\b|^${n}\\s*=`, "m").test(text) || new RegExp(`^\\s*from\\s+\\S+\\s+import\\s*\\([^)]*\\b${n}\\b`, "m").test(text);
}

/** The console scripts pyproject.toml names, under [project.scripts] or [tool.poetry.scripts], each at the module file it runs. */
function consoleScripts(read: (file: string) => string | undefined, exists: (file: string) => boolean): EntranceCandidate[] {
  const out: EntranceCandidate[] = [];
  const pyproject = read("pyproject.toml");
  if (pyproject === undefined) return out;
  let section = "";
  for (const raw of pyproject.split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (header !== null) {
      section = header[1]!.trim();
      continue;
    }
    if (section !== "project.scripts" && section !== "tool.poetry.scripts") continue;
    const entry = /^\s*["']?([\w.-]+)["']?\s*=\s*["']([\w.]+):([\w]+)["']/.exec(raw);
    if (entry === null) continue;
    const module = entry[2]!.split(".").join("/");
    const file = [`${module}.py`, `${module}/__init__.py`, `src/${module}.py`, `src/${module}/__init__.py`].find(exists);
    if (file !== undefined) out.push({ file, line: 1, symbol: entry[3]!, rule: "console script", why: `pyproject's console script "${entry[1]}" runs ${entry[2]}:${entry[3]}` });
  }
  return out;
}

/** Python's entrance syntax: a definition begins at its decorators and its body is indented past the def; a decorator passes through a wrapper as a call does. */
export const PYTHON_ENTRANCES: EntranceSyntax = {
  // A stub (.pyi) declares and never runs, so it registers no entrance.
  isCode: (file) => languageOfFile(file) === "python" && !file.endsWith(".pyi"),
  definitionAt(lines, start) {
    let def = start;
    while (def < lines.length && /^\s*@/.test(lines[def] ?? "")) def += 1;
    return def;
  },
  continues: () => false,
  binds,
  decorates: true,
  candidates: pythonCandidates,
  manifestCandidates: consoleScripts,
  script(file, folder, read) {
    if (folder !== "scripts") return undefined;
    const text = read(file) ?? "";
    if (!/^if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(text)) return undefined;
    return { file, line: 1, symbol: "", rule: "script", why: `a script under ${folder}/ with an if __name__ == "__main__" block` };
  },
  importedAmong: () => new Set(),
};
