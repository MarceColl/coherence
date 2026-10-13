/**
 * TypeScript's entrance rules and the syntax they read by: the shapes
 * Next.js, Remix, TanStack Start and the HTTP routers fix, how a statement
 * spans its lines, what binds a name, which scripts run rather than are
 * imported (entrance-candidates.ts reads them through ENTRANCE_SYNTAX).
 */

import { posix } from "node:path";
import { languageOfFile } from "./language-files.ts";
import { escape, handlerName, lineOf, NEXT_ROUTE_METHODS, REMIX_ROUTE_EXPORTS, spanOf, throughOf, type EntranceCandidate, type EntranceSyntax } from "./entrance-candidates.ts";

/** The text from its first code: leading whitespace and comments skipped by a walk, never a backtracking pattern. */
function leadingCode(text: string): string {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else return text.slice(i);
  }
}

function typescriptCandidates(file: string, text: string, wrappers: readonly string[]): EntranceCandidate[] {
  const out: EntranceCandidate[] = [];
  const lines = text.split("\n");
  // The file's own top-level helpers, so a route whose handlers are a local `handle` calling the wrapper is registered through it.
  const helpers = new Map<string, number>();
  lines.forEach((line, i) => {
    const m = /^(?:export\s+)?(?:async\s+)?(?:function\*?\s*|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/.exec(line);
    if (m !== null && !helpers.has(m[1]!)) helpers.set(m[1]!, i);
  });
  const add = (c: Omit<EntranceCandidate, "through">, span: string): void => {
    let through = throughOf(span, text, wrappers, TYPESCRIPT_ENTRANCES);
    if (through === undefined) {
      // One level into the file's own helpers the statement names, never further.
      const named = [...helpers].filter(([name, at]) => at !== c.line - 1 && new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`).test(span));
      if (named.length > 0) through = throughOf(named.map(([, at]) => spanOf(lines, at, TYPESCRIPT_ENTRANCES)).join("\n"), text, wrappers, TYPESCRIPT_ENTRANCES);
    }
    out.push(through === undefined ? c : { ...c, through });
  };
  const wrapperSet = new Set(wrappers);
  const nextRoute = /(^|\/)app\/(.+\/)?route\.(ts|tsx|js|mjs)$/.test(file);
  const pagesApi = /(^|\/)pages\/api\/.+\.(ts|tsx|js|mjs)$/.test(file);
  const remixRoute = /(^|\/)app\/routes\/.+\.(ts|tsx|js|jsx)$/.test(file);
  const useServer = /^["']use server["']/.test(leadingCode(text));
  // Next.js's request proxy (proxy.ts since Next.js 16, middleware.ts before it), at the project root or under src/.
  const proxyFile = /^(?:src\/)?(proxy|middleware)\.(ts|js|mjs)$/.exec(file)?.[1];
  const nextPage = /(^|\/)app\/(.+\/)?page\.(tsx|jsx|ts|js)$/.test(file) && !remixRoute;
  if (nextRoute || proxyFile !== undefined) {
    // What a route or proxy file exports by name without declaring it: an export list, re-exported or local, or a destructuring
    // (export { GET, POST } from "@/app/(auth)/auth", export { auth as proxy }, export const { GET, POST } = handlers).
    const wanted = (name: string): boolean => (nextRoute ? NEXT_ROUTE_METHODS.has(name) : name === proxyFile);
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}|^export\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) {
      const listed = m[1] !== undefined;
      const reexported = listed && /^\s*from\s*["']/.test(text.slice(m.index + m[0].length));
      for (const item of (m[1] ?? m[2]!).split(",")) {
        const named = listed ? /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(item) : /^\s*(?:[A-Za-z_$][\w$]*\s*:\s*)?([A-Za-z_$][\w$]*)\s*$/.exec(item);
        const name = named === null ? undefined : (named[2] ?? named[1]!);
        if (name === undefined || !wanted(name)) continue;
        const line = lineOf(text, m.index);
        const how = reexported ? "re-exported" : "exported by name";
        const c = nextRoute
          ? { file, line, symbol: name, rule: "route handler", why: `${name} ${how} in a Next.js route file: answers ${name} requests` }
          : { file, line, symbol: name, rule: "request proxy", why: `${name} ${how} in ${file}: Next.js runs it before every request it matches` };
        add(c, spanOf(lines, line - 1, TYPESCRIPT_ENTRANCES));
      }
    }
    if (proxyFile !== undefined) {
      const at = lines.findIndex((l) => /^export\s+default\b/.test(l));
      if (at >= 0) add({ file, line: at + 1, symbol: "", rule: "request proxy", why: `the default export of ${file}: Next.js runs it before every request it matches` }, spanOf(lines, at, TYPESCRIPT_ENTRANCES));
    }
  }
  const at = nextPage ? lines.findIndex((l) => /^export\s+default\b/.test(l)) : -1;
  if (at >= 0) {
    add({ file, line: at + 1, symbol: "", rule: "page route", why: "the default export of a Next.js app/**/page file: renders its route on the server for every visitor" }, spanOf(lines, at, TYPESCRIPT_ENTRANCES));
  }
  lines.forEach((line, i) => {
    const declared = proxyFile === undefined ? null : /^export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/.exec(line);
    if (declared !== null && declared[1] === proxyFile) {
      add({ file, line: i + 1, symbol: proxyFile!, rule: "request proxy", why: `export ${proxyFile} in ${file}: Next.js runs it before every request it matches` }, spanOf(lines, i, TYPESCRIPT_ENTRANCES));
      return;
    }
    const exported = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*\(/.exec(line);
    if (exported !== null) {
      const [, name, callee] = exported as unknown as [string, string, string];
      const span = spanOf(lines, i, TYPESCRIPT_ENTRANCES);
      if (callee === "createServerFn") {
        add({ file, line: i + 1, symbol: name, rule: "server function", why: `export const ${name} = createServerFn(...): a TanStack Start server function a browser can call` }, span);
        return;
      }
      if (callee === "createServerFileRoute" || callee === "createAPIFileRoute" || (callee === "createFileRoute" && /\bserver\s*:\s*\{[\s\S]*\bhandlers\b/.test(span))) {
        add({ file, line: i + 1, symbol: name, rule: "server route", why: `export const ${name} = ${callee}(...)${callee === "createFileRoute" ? " with server handlers" : ""}: a route that answers requests on the server` }, span);
        return;
      }
      if (wrapperSet.has(callee)) {
        add({ file, line: i + 1, symbol: name, rule: "wrapped export", why: `export const ${name} = ${callee}(...): created by ${callee}, which a declared entrance names` }, span);
        return;
      }
    }
    const fn = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\b|\(|function\b)/.exec(line);
    const fnName = fn?.[1] ?? fn?.[2];
    if (fnName !== undefined) {
      const span = spanOf(lines, i, TYPESCRIPT_ENTRANCES);
      if (nextRoute && NEXT_ROUTE_METHODS.has(fnName)) add({ file, line: i + 1, symbol: fnName, rule: "route handler", why: `export ${fnName} in a Next.js route file: answers ${fnName} requests` }, span);
      else if (remixRoute && REMIX_ROUTE_EXPORTS.has(fnName)) add({ file, line: i + 1, symbol: fnName, rule: "route handler", why: `export ${fnName} in app/routes: runs on the server for its route` }, span);
      else if (useServer && /^export\s+(?:async\s+function|const\s+\w+\s*(?::[^=]+)?=\s*async\b)/.test(line)) add({ file, line: i + 1, symbol: fnName, rule: "server action", why: `export ${fnName} in a 'use server' file: a server action a browser can call` }, span);
    }
    if (pagesApi && /^export\s+default\b/.test(line)) add({ file, line: i + 1, symbol: "", rule: "route handler", why: "the default export under pages/api: a Next.js API route" }, spanOf(lines, i, TYPESCRIPT_ENTRANCES));
    const table = /\b(?:pattern|path|route)\s*:\s*["'`](\/[^"'`]*)["'`][^\n]*?\bhandler\s*:\s*([A-Za-z_$][\w$.]*(?:\s*\(\s*[A-Za-z_$][\w$.]*\s*\))?)/.exec(line);
    if (table !== null) {
      const symbol = handlerName(table[2]!);
      if (symbol !== "") add({ file, line: i + 1, symbol, rule: "route table", why: `a route table entry: ${table[1]} handled by ${table[2]!.trim()}`, registered: true }, line);
      return;
    }
    // A statement, never text inside a string: the call opens its line, as `app.get(...)`, `await router.post(...)` or a chained `.get(...)`.
    const method = /^\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)?\.(get|post|put|patch|delete|all|head|options)\(\s*["'`](\/[^"'`]*)["'`]\s*,([^\n]*)$/.exec(line);
    if (method !== null) {
      const last = /,?\s*([A-Za-z_$][\w$.]*)\s*\)\s*;?\s*$/.exec(method[3]!);
      const symbol = last === null ? "" : handlerName(last[1]!);
      add({ file, line: i + 1, symbol, rule: "route method", why: `${method[1]!.toUpperCase()} ${method[2]} registered by a .${method[1]}() call${symbol === "" ? " with an inline handler" : ` to ${symbol}`}`, ...(symbol === "" ? {} : { registered: true as const }) }, spanOf(lines, i, TYPESCRIPT_ENTRANCES));
    }
  });
  return out;
}

const TS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;

/** The code files some other code file imports by a relative path. */
function importedFiles(files: readonly string[], read: (file: string) => string | undefined): Set<string> {
  const all = new Set(files);
  const out = new Set<string>();
  for (const file of files) {
    const text = read(file);
    if (text === undefined) continue;
    for (const m of text.matchAll(TS_IMPORT)) {
      const joined = posix.normalize(posix.join(posix.dirname(file), m[1]!));
      const stem = joined.replace(/\.(js|mjs|cjs|jsx)$/, "");
      for (const c of [joined, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((e) => stem + e), ...[".ts", ".tsx", ".js"].map((e) => posix.join(joined, "index" + e))]) {
        if (all.has(c) && c !== file) out.add(c);
      }
    }
  }
  return out;
}

/** Whether the file imports or declares the name: an import clause naming it, or a function, class or binding of it. */
function binds(text: string, name: string): boolean {
  const n = escape(name);
  for (const m of text.matchAll(/\bimport\s[^"'`;]*?\bfrom\s*["'][^"']+["']/g)) if (new RegExp(`(?<![\\w$])${n}(?![\\w$])`).test(m[0])) return true;
  return new RegExp(`(?:function\\*?|const|let|var|class)\\s+${n}(?![\\w$])`).test(text) || new RegExp(`(?:const|let|var)\\s*\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}\\s*=`).test(text);
}

/** TypeScript's entrance syntax: a statement goes on through a line that closes a bracket or continues a chain; a script is one no project file imports. */
export const TYPESCRIPT_ENTRANCES: EntranceSyntax = {
  isCode: (file) => languageOfFile(file) === "typescript",
  definitionAt: (_lines, start) => start,
  continues: (text) => /^\s*[)\]}.]/.test(text),
  binds,
  decorates: false,
  candidates: typescriptCandidates,
  manifestCandidates: () => [],
  script(file, folder, _read, imported) {
    if (imported.has(file)) return undefined;
    return { file, line: 1, symbol: "", rule: "script", why: `a script directly under ${folder}/ that no project file imports` };
  },
  importedAmong: importedFiles,
};
