/**
 * The mirror reading: the lists a project keeps by hand that must mirror
 * something defined elsewhere (the lexicon's defect family `hand-list`),
 * whose drift fails silently. Built from the spike of PR #94 (d-520846aa).
 *
 * Three steps. Candidates are literal collections of names, read with the
 * TypeScript compiler's parser: string arrays and sets, object keys and
 * values, columns of an array of tuples or records, regular-expression and
 * string alternations (`Bash|Edit|Write`, `<review|ci|probe>`), string
 * literal unions, switch case labels, and in Markdown, alternations, table
 * key columns and prose enumerations. Universes are what a list may mirror
 * and code derives: a folder's files, the import closure of a list of files,
 * a module's exports, the keys a file reads off one object. Every candidate
 * is matched against every other set by overlap; equal sets cluster, close
 * literal pairs join one group, and git history says which pairs grew
 * together, which were caught up later, and which commit grew one side alone.
 *
 * Everything is read from git objects at one revision, never the working
 * tree, so the reading holds still while an agent edits. It is advisory and
 * costs about a second on Coherence: no hook ever computes it (recorded.ts
 * keeps the last one for orient, and a detached process takes a new one).
 *
 * The compiler's parser is loaded on demand: it is an optional dependency of
 * the package, and a project without it gets a reading that says so.
 */

import { execFileSync } from "../../lifecycle/work-meter.ts";
import { basename, dirname, extname, posix } from "node:path";
import type * as TS from "typescript";
import { languageOfFile } from "../../adapters/language-files.ts";
import { DERIVED, DOC_FORMS, type Finding, type Form, type Group, type MirrorHistory, type MirrorReading, type SetRef, type Verdict } from "./model.ts";

export type { Finding, Group, MirrorReading, SetRef, Verdict };

type Ts = typeof TS;

export interface MirrorOptions {
  /** HEAD when absent. */
  rev?: string;
  /** False skips the git history pass. */
  history?: boolean;
  /** True keeps the pairs no verdict holds (loose overlaps), for study. */
  all?: boolean;
}

/** Why no reading could be taken. */
export class MirrorUnable extends Error {}

/* ---------------------------------------------------------------- reading */

interface NameSet {
  id: number;
  file: string;
  line: number;
  name: string;
  form: Form;
  members: string[];
  /** Declarations that came from one source node (an object's keys and its values) never pair. */
  origin: string;
  checked: boolean;
  /** A switch with a default clause: a label it lacks is handled, not missed. */
  open?: boolean;
}

/** Test files: their literals are fixtures and expectations, which copy the lists on purpose. */
const TEST_FILE = /\.(test|e2e)\.[cm]?[tj]s$|fixture/;
const CODE_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;
const DOC_FILE = /\.md$/;
/** The Markdown read for candidates: the docs folder, every spec, the README. */
const READ_DOC = /(^docs\/|\.spec\.md$|^README\.md$)/;
/** Never the project's code wherever they sit, besides the folders the config ignores. */
const ALWAYS_IGNORED = ["node_modules", ".coherence"];

interface ModuleFacts {
  imports: { spec: string; typeOnly: boolean }[];
}

interface Context {
  ts: Ts;
  root: string;
  rev: string;
  sets: NameSet[];
  modules: Map<string, ModuleFacts>;
}

function git(root: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, { cwd: root, maxBuffer: 1024 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"], ...(input === undefined ? {} : { input }) });
}

/** Every file's text at the revision, through one cat-file process; paths relative to the root. */
function readAll(root: string, rev: string, files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (files.length === 0) return out;
  const buf = git(root, ["cat-file", "--batch"], files.map((f) => `${rev}:./${f}`).join("\n") + "\n");
  let at = 0;
  for (const file of files) {
    const nl = buf.indexOf(10, at);
    const header = buf.subarray(at, nl).toString("utf8");
    const size = Number(header.split(" ")[2]);
    if (header.endsWith("missing") || Number.isNaN(size)) {
      at = nl + 1;
      continue;
    }
    out.set(file, buf.subarray(nl + 1, nl + 1 + size).toString("utf8"));
    at = nl + 1 + size + 1;
  }
  return out;
}

/** The folders the config at the revision ignores, as project-relative prefixes. */
function ignoredAt(root: string, rev: string): string[] {
  const text = readAll(root, rev, ["coherence.config.json"]).get("coherence.config.json");
  let ignore: unknown;
  try {
    ignore = text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>)["ignore"];
  } catch {
    ignore = undefined;
  }
  const own = Array.isArray(ignore) ? ignore.filter((v): v is string => typeof v === "string") : [];
  return own.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")).filter((f) => f !== "" && f !== ".");
}

function addSet(ctx: Context, s: Omit<NameSet, "id" | "members"> & { members: readonly string[] }): void {
  const members = [...new Set(s.members)];
  if (members.length < 2) return;
  if (!members.every(nameLike)) return;
  ctx.sets.push({ ...s, members, id: ctx.sets.length });
}

/** A name, not prose or a pattern: up to three words, none of them long, no markup. */
function nameLike(value: string): boolean {
  if (value === "" || value.length > 60) return false;
  if (/[\n`{}()<>\\^$*+?[\]]/.test(value)) return false;
  return value.trim().split(/\s+/).length <= 3;
}

/* ------------------------------------------------------- code: candidates */

function scriptKind(ts: Ts, file: string): TS.ScriptKind {
  return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** Steps through wrappers that do not change what a literal is: `as const`, `satisfies`, parentheses, `new Set(…)`. */
function outer(ts: Ts, node: TS.Node): TS.Node {
  let at = node;
  for (;;) {
    const p = at.parent;
    if (p === undefined) return at;
    if (ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isParenthesizedExpression(p) || ts.isTypeAssertionExpression(p)) at = p;
    else if (ts.isNewExpression(p) && p.arguments?.[0] === at) at = p;
    else return at;
  }
}

function enclosingFunction(ts: Ts, node: TS.Node): string {
  for (let at: TS.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined) return at.name.getText();
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent)) return at.parent.name.getText();
    if (ts.isSourceFile(at)) return "module";
  }
  return "module";
}

function declName(ts: Ts, node: TS.Node): string {
  const top = outer(ts, node);
  const p = top.parent;
  if (p === undefined) return "<anon>";
  if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return p.name.getText();
  if (ts.isBinaryExpression(p) && p.right === top) return p.left.getText().slice(0, 40);
  if (ts.isTypeAliasDeclaration(p)) return p.name.text;
  return `<in ${enclosingFunction(ts, node)}>`;
}

function atModuleScope(ts: Ts, node: TS.Node): boolean {
  const top = outer(ts, node);
  const decl = top.parent;
  if (decl === undefined || !ts.isVariableDeclaration(decl)) return false;
  const stmt = decl.parent?.parent;
  return stmt !== undefined && ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent);
}

/** Whether the declared type is a `Record<K, …>` over anything but string or number: the compiler then checks the keys. */
function checkedKeys(ts: Ts, node: TS.Node): boolean {
  const top = outer(ts, node);
  const typeNode = (ts.isVariableDeclaration(top.parent) ? top.parent.type : undefined) ?? (ts.isSatisfiesExpression(node.parent) ? node.parent.type : undefined);
  if (typeNode === undefined || !ts.isTypeReferenceNode(typeNode) || typeNode.typeName.getText() !== "Record") return false;
  const key = typeNode.typeArguments?.[0];
  return key !== undefined && key.kind !== ts.SyntaxKind.StringKeyword && key.kind !== ts.SyntaxKind.NumberKeyword;
}

function stringValue(ts: Ts, node: TS.Node | undefined): string | undefined {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

function propName(ts: Ts, name: TS.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** A plain alternative: a name, maybe with escaped dots or dashes, and nothing a pattern means. */
function plainAlternative(alt: string): string | undefined {
  const unescaped = alt.replace(/\\([.\-/])/g, "$1");
  return /^[\w.\-/ ]+$/.test(unescaped) && /\w/.test(unescaped) ? unescaped : undefined;
}

function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "|" && depth === 0) {
      out.push(body.slice(from, i));
      from = i + 1;
    }
  }
  out.push(body.slice(from));
  return out;
}

/** The alternations in a regular expression's source: every group, and the whole pattern, whose alternatives are all plain. */
export function regexAlternations(source: string): string[][] {
  const out: string[][] = [];
  const consider = (body: string): void => {
    const alts = splitTopLevel(body);
    if (alts.length < 2) return;
    const plain = alts.map(plainAlternative);
    if (plain.every((a) => a !== undefined)) out.push(plain as string[]);
  };
  const stack: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") {
      while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "(") stack.push(i);
    else if (ch === ")" && stack.length > 0) {
      const open = stack.pop()!;
      consider(source.slice(open + 1, i).replace(/^\?(?::|<?[=!]|<\w+>)/, ""));
    }
  }
  consider(source.replace(/^\^|\$$/g, "").replace(/^\\b|\\b$/g, ""));
  return out;
}

/** Alternations written in a string: the whole string (`Bash|Edit|Write`) or a placeholder (`<review|ci|probe>`), with the flag before it. */
function stringAlternations(text: string): { members: string[]; label: string }[] {
  const out: { members: string[]; label: string }[] = [];
  if (/^[\w.-]+(\|[\w.-]+)+$/.test(text)) out.push({ members: text.split("|"), label: "" });
  for (const m of text.matchAll(/(--[\w-]+\s+)?<([\w.\- ]+(?:\|[\w.\- ]+)+)>/g)) out.push({ members: m[2]!.split("|").map((s) => s.trim()), label: m[1]?.trim() ?? "" });
  return out;
}

/**
 * A switch the compiler holds to its discriminant's type: no default, every
 * clause leaves by return or throw, the switch ends its function, and the
 * function declares a return type without undefined. A case missing from such
 * a switch over a union is a compile error (TS2366), so its labels are not
 * kept by hand. Syntactic: without the checker the discriminant's type is
 * assumed to be a union.
 */
function exhaustiveSwitch(ts: Ts, node: TS.SwitchStatement): boolean {
  const clauses = node.caseBlock.clauses;
  if (clauses.some(ts.isDefaultClause)) return false;
  const leaves = (c: TS.CaseOrDefaultClause): boolean => {
    const last = c.statements[c.statements.length - 1];
    if (last === undefined) return true;
    if (ts.isBlock(last)) {
      const inner = last.statements[last.statements.length - 1];
      return inner !== undefined && (ts.isReturnStatement(inner) || ts.isThrowStatement(inner));
    }
    return ts.isReturnStatement(last) || ts.isThrowStatement(last);
  };
  if (!clauses.every(leaves)) return false;
  const block = node.parent;
  if (!ts.isBlock(block) || block.statements[block.statements.length - 1] !== node) return false;
  const fn = block.parent;
  if (fn === undefined || !(ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  const type = fn.type?.getText();
  return type !== undefined && type !== "void" && !/\bundefined\b|\bvoid\b/.test(type);
}

function readCode(ctx: Context, file: string, text: string): void {
  const { ts } = ctx;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
  const lineOf = (node: TS.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const facts: ModuleFacts = { imports: [] };
  ctx.modules.set(file, facts);
  const exported: string[] = [];
  const reads = new Map<string, { keys: string[]; line: number }>();
  const isTest = TEST_FILE.test(file);
  const add = (s: Omit<NameSet, "id" | "members" | "file"> & { members: readonly string[] }): void => addSet(ctx, { ...s, file });

  const visit = (node: TS.Node): void => {
    // Imports and exports: the facts universes are made of; read in every file, tests too.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      // `import type …`, or `import { type A, type B }` with no default: erased when the module is stripped.
      const typeOnly = clause !== undefined && (clause.isTypeOnly || (clause.name === undefined && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)));
      facts.imports.push({ spec: node.moduleSpecifier.text, typeOnly });
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      facts.imports.push({ spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    }
    if (node.parent !== undefined && ts.isSourceFile(node.parent) && ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) exported.push(d.name.getText());
      else if ("name" in node && node.name !== undefined && ts.isIdentifier(node.name as TS.Node)) exported.push((node.name as TS.Identifier).text);
    }
    if (isTest) {
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isArrayLiteralExpression(node)) {
      const top = outer(ts, node);
      const argOfCall = ts.isCallExpression(top.parent) && top.parent.arguments.includes(top as TS.Expression);
      const strings = node.elements.map((e) => stringValue(ts, e));
      // An argument vector mixes flags with words (`["diff", "--name-only", "-z"]`): a command, not a list.
      const argvLike = strings.some((s) => s?.startsWith("-")) && !strings.every((s) => s?.startsWith("-"));
      if (!argOfCall && !argvLike && strings.length >= 2 && strings.every((s) => s !== undefined)) {
        const isSet = top !== node && ts.isNewExpression(top);
        add({ line: lineOf(node), name: declName(ts, node), form: isSet ? "set" : "array", members: strings as string[], origin: `${file}:${node.pos}`, checked: false });
      }
      // Columns: an array of tuples, or of records, holding a string in the same place.
      const rows = node.elements;
      const argvRows = rows.some((r) => ts.isArrayLiteralExpression(r) && r.elements.some((e) => stringValue(ts, e)?.startsWith("-") === true));
      if (rows.length >= 2 && !argvRows && rows.every((r) => ts.isArrayLiteralExpression(r))) {
        const width = Math.min(...rows.map((r) => (r as TS.ArrayLiteralExpression).elements.length));
        for (let c = 0; c < width; c++) {
          const col = rows.map((r) => stringValue(ts, (r as TS.ArrayLiteralExpression).elements[c]));
          if (col.every((s) => s !== undefined)) add({ line: lineOf(node), name: `${declName(ts, node)}[][${c}]`, form: "column", members: col as string[], origin: `${file}:${node.pos}`, checked: false });
        }
      }
      if (rows.length >= 2 && rows.every((r) => ts.isObjectLiteralExpression(r))) {
        const first = rows[0] as TS.ObjectLiteralExpression;
        for (const prop of first.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = propName(ts, prop.name);
          if (key === undefined) continue;
          const col = rows.map((r) => {
            const p = (r as TS.ObjectLiteralExpression).properties.find((q) => ts.isPropertyAssignment(q) && propName(ts, q.name) === key) as TS.PropertyAssignment | undefined;
            return p === undefined ? undefined : stringValue(ts, p.initializer);
          });
          if (col.every((s) => s !== undefined)) add({ line: lineOf(node), name: `${declName(ts, node)}[].${key}`, form: "column", members: col as string[], origin: `${file}:${node.pos}`, checked: false });
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const props = node.properties.filter(ts.isPropertyAssignment);
      const keys = props.map((p) => propName(ts, p.name));
      const literalValues = props.every((p) => {
        const v = p.initializer;
        return ts.isStringLiteralLike(v) || ts.isNumericLiteral(v) || ts.isArrayLiteralExpression(v) || v.kind === ts.SyntaxKind.TrueKeyword || v.kind === ts.SyntaxKind.FalseKeyword || v.kind === ts.SyntaxKind.NullKeyword;
      });
      // Inside a function an object literal is a shape (an answer, an options bag), not a list.
      const kept = atModuleScope(ts, node) && props.length === node.properties.length;
      if (kept && keys.every((k) => k !== undefined)) {
        // A dispatch table, whose every value calls the function its key names, is bound by code: the keys are the dispatch's verbs.
        const dispatch = props.filter((p) => new RegExp(`\\b${(propName(ts, p.name) ?? "").replace(/[^\w$]/g, "")}\\b`).test(p.initializer.getText())).length >= 0.8 * props.length && !literalValues;
        add({ line: lineOf(node), name: `${declName(ts, node)} keys`, form: "keys", members: keys as string[], origin: `${file}:${node.pos}`, checked: checkedKeys(ts, node) || dispatch });
        const values = props.map((p) => stringValue(ts, p.initializer));
        if (values.every((v) => v !== undefined)) add({ line: lineOf(node), name: `${declName(ts, node)} values`, form: "values", members: values as string[], origin: `${file}:${node.pos}`, checked: false });
      }
    }

    if (ts.isRegularExpressionLiteral(node)) {
      const source = node.text.slice(1, node.text.lastIndexOf("/"));
      for (const alts of regexAlternations(source)) add({ line: lineOf(node), name: `${declName(ts, node)} /…/`, form: "alternation", members: alts, origin: `${file}:${node.pos}:${alts.join("|")}`, checked: false });
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
        for (const alt of stringAlternations(node.text)) add({ line: lineOf(node), name: `${declName(ts, node)} ${alt.label}`.trim(), form: "alternation", members: alt.members, origin: `${file}:${node.pos}:${alt.members.join("|")}`, checked: false });
      }
    }

    // A union passed as a type argument (`Omit<T, "from" | "to">`) names members of another type: a selection, not a list.
    if (ts.isUnionTypeNode(node) && !ts.isTypeReferenceNode(node.parent) && !ts.isExpressionWithTypeArguments(node.parent)) {
      const lits = node.types.map((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : undefined));
      if (lits.every((l) => l !== undefined)) {
        let name = "<union>";
        for (let at: TS.Node = node.parent; at !== undefined && !ts.isSourceFile(at); at = at.parent) {
          if (ts.isTypeAliasDeclaration(at) || ts.isPropertySignature(at) || ts.isParameter(at) || ts.isVariableDeclaration(at)) {
            name = at.name.getText();
            break;
          }
        }
        add({ line: lineOf(node), name, form: "union", members: lits as string[], origin: `${file}:${node.pos}`, checked: false });
      }
    }

    if (ts.isSwitchStatement(node)) {
      const labels = node.caseBlock.clauses.filter(ts.isCaseClause).map((c) => stringValue(ts, c.expression));
      const strings = labels.filter((l): l is string => l !== undefined);
      if (strings.length >= 2 && strings.length === labels.length) {
        add({ line: lineOf(node), name: `${enclosingFunction(ts, node)}: switch (${node.expression.getText().slice(0, 30)})`, form: "cases", members: strings, origin: `${file}:${node.pos}`, checked: scriptKind(ts, file) === ts.ScriptKind.TS && exhaustiveSwitch(ts, node), open: node.caseBlock.clauses.some(ts.isDefaultClause) });
      }
    }

    // The keys one file reads off one object by string: `record["testMatch"]`.
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      const target = node.expression.getText();
      const entry = reads.get(target) ?? { keys: [], line: lineOf(node) };
      entry.keys.push(node.argumentExpression.text);
      reads.set(target, entry);
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!isTest) {
    if (exported.length >= 2) add({ line: 1, name: "exports", form: "exports", members: exported, origin: `${file}:exports`, checked: false });
    for (const [target, entry] of reads) add({ line: entry.line, name: `${target}["…"]`, form: "reads", members: entry.keys, origin: `${file}:reads:${target}`, checked: false });
  }
}

/* -------------------------------------------------------- docs: candidates */

function readDoc(ctx: Context, file: string, text: string): void {
  let table: { line: number; keys: string[]; heading: string } | undefined;
  let heading = "";
  const flushTable = (): void => {
    if (table !== undefined) addSet(ctx, { file, line: table.line, name: `table under "${table.heading}"`, form: "doc-table", members: table.keys, origin: `${file}:table:${table.line}`, checked: false });
    table = undefined;
  };
  text.split("\n").forEach((raw, index) => {
    const n = index + 1;
    if (/^#+ /.test(raw)) heading = raw.replace(/^#+ /, "").slice(0, 50);
    // Tables: the backticked names in each row's first cell.
    if (/^\|/.test(raw)) {
      const cell = raw.split("|")[1] ?? "";
      const names = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      if (names.length > 0) {
        table ??= { line: n, keys: [], heading };
        table.keys.push(...names);
      }
    } else flushTable();
    for (const alt of stringAlternations(raw)) addSet(ctx, { file, line: n, name: `${heading} ${alt.label}`.trim(), form: "doc-alternation", members: alt.members, origin: `${file}:${n}:${alt.members.join("|")}`, checked: false });
    // Prose enumerations of short single tokens: "review, ci, probe, adopter, self or test".
    for (const m of raw.matchAll(/(?:\b[\w-]{1,24}\b, ){2,}\b[\w-]{1,24}\b,? (?:or|and) \b[\w-]{1,24}\b/g)) {
      const members = m[0].split(/,? (?:or|and) |, /).map((s) => s.trim());
      addSet(ctx, { file, line: n, name: `${heading} (prose)`, form: "prose", members, origin: `${file}:${n}:${m.index}`, checked: false });
    }
  });
  flushTable();
}

/* --------------------------------------------------------- the universes */

interface Universes {
  /** A universe's id to its files, by the name it spells each with. */
  closureFiles: Map<number, Map<string, string>>;
  /** The lists of files that have an import closure: read against it, not against their folder. */
  hasClosure: Set<number>;
  /** An import closure's id to the files it starts from, as the list spells them, and the list's file:line when a list named them. */
  closureOf: Map<number, { of: string[]; list?: string }>;
}

function universes(ctx: Context, paths: readonly string[]): Universes {
  const tracked = new Set(paths);
  const filesByDir = new Map<string, string[]>();
  for (const p of paths) {
    if (!CODE_FILE.test(p) && !DOC_FILE.test(p)) continue;
    const d = dirname(p);
    filesByDir.set(d, [...(filesByDir.get(d) ?? []), p]);
  }
  for (const [dir, files] of filesByDir) {
    const own = files.filter((f) => !TEST_FILE.test(f) && CODE_FILE.test(f));
    addSet(ctx, { file: dir, line: 0, name: `files in ${dir}/`, form: "folder", members: own.map((f) => basename(f)), origin: `folder:${dir}`, checked: false });
  }

  const resolveImport = (from: string, spec: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined;
    const base = posix.normalize(posix.join(dirname(from), spec));
    for (const c of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}/index.ts`]) if (tracked.has(c)) return c;
    return undefined;
  };

  /** Every file the starts import at run time, transitively, staying inside the folders they are in. */
  const closure = (starts: string[], dirs: ReadonlySet<string>): string[] => {
    const seen = new Set(starts);
    const queue = [...starts];
    while (queue.length > 0) {
      const at = queue.pop()!;
      for (const imp of ctx.modules.get(at)?.imports ?? []) {
        if (imp.typeOnly) continue;
        const to = resolveImport(at, imp.spec);
        if (to === undefined || !dirs.has(dirname(to)) || TEST_FILE.test(to) || seen.has(to)) continue;
        seen.add(to);
        queue.push(to);
      }
    }
    return [...seen];
  };

  /** A list of files: every member resolves to a tracked code file from one home folder, or from src/. */
  const filesNamed = (members: string[]): { home: string; files: string[]; spell: (file: string) => string } | undefined => {
    if (!members.every((m) => CODE_FILE.test(m))) return undefined;
    for (const home of filesByDir.keys()) {
      const files = members.map((m) => posix.normalize(`${home}/${m}`));
      if (files.every((f) => tracked.has(f))) return { home, files, spell: (f) => posix.relative(home, f) };
    }
    const fromSrc = members.map((m) => `src/${m}`);
    if (fromSrc.every((f) => tracked.has(f))) return { home: "src", files: fromSrc, spell: (f) => posix.relative("src", f) };
    return undefined;
  };

  const out: Universes = { closureFiles: new Map(), hasClosure: new Set(), closureOf: new Map() };
  const literalCount = ctx.sets.length;
  for (const s of ctx.sets.slice(0, literalCount)) {
    if (DERIVED.has(s.form)) continue;
    const named = filesNamed(s.members);
    if (named === undefined) continue;
    const reach = closure(named.files, new Set(named.files.map((f) => dirname(f))));
    // Kept even when equal: a list that equals its closure is the latent case, right today and kept by hand.
    const id = ctx.sets.length;
    addSet(ctx, { file: named.home, line: 0, name: `import closure of ${s.name} (${s.file}:${s.line})`, form: "closure", members: reach.map(named.spell), origin: `closure:${s.id}`, checked: false });
    if (ctx.sets.length > id) {
      out.closureFiles.set(id, new Map(reach.map((f) => [named.spell(f), f])));
      out.closureOf.set(id, { of: s.members, list: `${s.file}:${s.line}` });
    }
    out.hasClosure.add(s.id);
  }
  for (const [dir, files] of filesByDir) {
    const index = files.find((f) => basename(f) === "index.ts");
    if (index === undefined) continue;
    const id = ctx.sets.length;
    const reach = closure([index], new Set([dir]));
    addSet(ctx, { file: index, line: 0, name: `import closure of ${index}`, form: "closure", members: reach.map((f) => basename(f)), origin: `closure:${index}`, checked: false });
    if (ctx.sets.length > id) {
      out.closureFiles.set(id, new Map(reach.map((f) => [basename(f), f])));
      out.closureOf.set(id, { of: [basename(index)] });
    }
  }
  return out;
}

/* --------------------------------------------------------------- matching */

/** Strip the affix every member shares (`.coherence/`, `-`, `.ts`) so `.coherence/journal` meets `journal`. */
export function stripped(members: readonly string[]): string[] | undefined {
  if (members.length < 2) return undefined;
  let pre = members[0]!;
  let suf = members[0]!;
  for (const m of members) {
    while (!m.startsWith(pre)) pre = pre.slice(0, -1);
    while (!m.endsWith(suf)) suf = suf.slice(1);
  }
  // Only affixes that end (or start) at a separator, so `runs`/`run-index` keep their stems.
  pre = pre.replace(/[^/.\-_:]*$/, "");
  suf = suf.replace(/^[^/.\-_:]*/, "");
  if (pre === "" && suf === "") return undefined;
  const out = members.map((m) => m.slice(pre.length, m.length - suf.length));
  if (out.some((m) => m === "") || new Set(out).size !== out.length) return undefined;
  return out;
}

interface Variant {
  set: number;
  members: string[];
}

interface Working {
  a: NameSet;
  b: NameSet;
  verdict: Verdict;
  shared: string[];
  onlyA: string[];
  onlyB: string[];
  union?: NameSet;
  jaccard: number;
  containment: number;
  overlap: number;
  copiesA: NameSet[];
  copiesB: NameSet[];
  score: number;
  overlapScore: number;
  historyScore: number;
  history?: MirrorHistory;
}

const literal = (s: NameSet): boolean => !DERIVED.has(s.form) && !s.checked;

function match(ctx: Context, u: Universes, all: boolean): { findings: Working[]; find: (i: number) => number } {
  const { sets } = ctx;
  const variants: Variant[] = [];
  for (const s of sets) {
    variants.push({ set: s.id, members: s.members });
    const st = stripped(s.members);
    if (st !== undefined) variants.push({ set: s.id, members: st });
  }

  // Rarity: a member few sets hold is evidence; `id` or `name` is not.
  const df = new Map<string, number>();
  for (const s of sets) for (const m of new Set([...s.members, ...(stripped(s.members) ?? [])])) df.set(m, (df.get(m) ?? 0) + 1);
  const n = sets.length;
  const idf = (m: string): number => Math.log(1 + n / (df.get(m) ?? 1));

  const index = new Map<string, number[]>();
  variants.forEach((v, i) => {
    for (const m of v.members) {
      const at = index.get(m);
      if (at === undefined) index.set(m, [i]);
      else at.push(i);
    }
  });

  const pairBest = new Map<string, { va: Variant; vb: Variant; shared: string[] }>();
  for (let i = 0; i < variants.length; i++) {
    const va = variants[i]!;
    const counts = new Map<number, number>();
    for (const m of va.members) for (const j of index.get(m) ?? []) if (j > i) counts.set(j, (counts.get(j) ?? 0) + 1);
    for (const [j, count] of counts) {
      if (count < 2) continue;
      const vb = variants[j]!;
      if (va.set === vb.set) continue;
      const A = sets[va.set]!;
      const B = sets[vb.set]!;
      if (A.origin === B.origin) continue;
      if (!literal(A) && !literal(B)) continue;
      // Prose against prose is two documents agreeing; a mirror reading wants code on one side.
      if (DOC_FORMS.has(A.form) && DOC_FORMS.has(B.form)) continue;
      // A list of files that has its own import closure is read against that, not against its whole folder.
      if ((A.form === "folder" && u.hasClosure.has(B.id)) || (B.form === "folder" && u.hasClosure.has(A.id))) continue;
      const key = `${Math.min(A.id, B.id)}:${Math.max(A.id, B.id)}`;
      const setB = new Set(vb.members);
      const shared = va.members.filter((m) => setB.has(m));
      const prev = pairBest.get(key);
      if (prev === undefined || shared.length > prev.shared.length) pairBest.set(key, { va, vb, shared });
    }
  }

  const findings: Working[] = [];
  for (const { va, vb, shared } of pairBest.values()) {
    let A = sets[va.set]!;
    let B = sets[vb.set]!;
    let ma = va.members;
    let mb = vb.members;
    // The hand-kept side first.
    if (!literal(A) && literal(B)) {
      [A, B] = [B, A];
      [ma, mb] = [mb, ma];
    }
    const sb = new Set(mb);
    const sa = new Set(ma);
    const onlyA = ma.filter((m) => !sb.has(m));
    const onlyB = mb.filter((m) => !sa.has(m));
    const jaccard = shared.length / new Set([...ma, ...mb]).size;
    const containment = shared.length / Math.min(ma.length, mb.length);
    const overlap = shared.reduce((sum, m) => sum + idf(m), 0);
    const bothLiteral = literal(A) && literal(B);
    let verdict: Verdict | undefined;
    if (onlyA.length === 0 && onlyB.length === 0) verdict = bothLiteral ? "duplicate" : "latent";
    else if (containment >= 0.8 && jaccard >= 0.3) verdict = bothLiteral && jaccard >= 0.6 ? "duplicate" : "drifted";
    // A switch with a default that handles a subset of a list is choosing, not mirroring.
    const openSubset = (s: NameSet, only: string[]): boolean => s.form === "cases" && s.open === true && only.length === 0;
    if (openSubset(A, onlyA) || openSubset(B, onlyB)) verdict = undefined;
    if ((DOC_FORMS.has(A.form) || DOC_FORMS.has(B.form)) && jaccard < 0.6) verdict = undefined;
    if (verdict === undefined && !all) continue;
    findings.push({ a: A, b: B, verdict: verdict ?? "drifted", shared, onlyA, onlyB, jaccard, containment, overlap, score: 0, overlapScore: 0, historyScore: 0, copiesA: [], copiesB: [] });
  }

  // Copies: sets equal to one another form one cluster, so twelve copies of KINDS are one finding, not sixty-six.
  const parent = sets.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const f of findings) if (f.onlyA.length === 0 && f.onlyB.length === 0) parent[find(f.a.id)] = find(f.b.id);
  const clusterOf = new Map<number, NameSet[]>();
  for (const s of sets) clusterOf.set(find(s.id), [...(clusterOf.get(find(s.id)) ?? []), s]);
  const kept = new Map<string, Working>();
  for (const f of findings) {
    const ka = find(f.a.id);
    const kb = find(f.b.id);
    const key = ka === kb ? `${ka}` : `${Math.min(ka, kb)}:${Math.max(ka, kb)}`;
    f.copiesA = clusterOf.get(ka)!;
    f.copiesB = ka === kb ? [] : clusterOf.get(kb)!;
    const prev = kept.get(key);
    if (prev === undefined || f.overlap > prev.overlap || (f.overlap === prev.overlap && f.a.checked && !prev.a.checked)) kept.set(key, f);
  }
  const out: Working[] = [];
  for (const f of kept.values()) {
    const every = [...f.copiesA, ...f.copiesB];
    const literals = every.filter((s) => literal(s) && !DOC_FORMS.has(s.form));
    // A cluster all of whose copies are bound by code is not kept by hand.
    if (literals.length === 0) continue;
    // One literal and the rest held to it by the compiler (`Record<Kind, …>`, an exhaustive switch): the type is the derivation.
    const derived = every.filter((s) => DERIVED.has(s.form));
    if (literals.length === 1 && derived.length === 0 && f.onlyA.length === 0 && f.onlyB.length === 0) continue;
    if (f.copiesB.length === 0) f.verdict = literals.length >= 2 ? "duplicate" : "latent";
    out.push(f);
  }
  // A difference another set accounts for: RECORD_ID's alternation is KINDS' values together with WORK_KINDS'.
  for (const f of out) {
    if (f.onlyA.length === 0 && f.onlyB.length === 0) continue;
    const extra = f.onlyA.length > 0 && f.onlyB.length === 0 ? f.onlyA : f.onlyB.length > 0 && f.onlyA.length === 0 ? f.onlyB : undefined;
    if (extra === undefined) continue;
    const whole = new Set(extra === f.onlyA ? [...f.shared, ...f.onlyA] : [...f.shared, ...f.onlyB]);
    for (const vi of index.get(extra[0]!) ?? []) {
      const v = variants[vi]!;
      const C = sets[v.set]!;
      if (C === f.a || C === f.b || find(C.id) === find(f.a.id) || find(C.id) === find(f.b.id)) continue;
      if (extra.every((m) => v.members.includes(m)) && v.members.every((m) => whole.has(m))) {
        f.union = C;
        f.verdict = "latent";
        break;
      }
    }
  }
  return { findings: out, find };
}

/* ---------------------------------------------------------------- history */

interface FileDiff {
  added: string[];
  removed: string[];
  created: boolean;
}
interface Commit {
  sha: string;
  subject: string;
  files: Map<string, FileDiff>;
}

/** One `git log -p --unified=0` pass over the code and Markdown the reading reads, up to the revision, paths relative to the root. */
function readCommits(root: string, rev: string, ignored: readonly string[]): Commit[] {
  const specs = ["*.ts", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs", "*.md"].map((g) => `:(glob)**/${g}`);
  const excludes = ignored.map((f) => `:(exclude)${f}`);
  const log = git(root, ["log", "-p", "--unified=0", "--no-merges", "--no-renames", "--relative", "--no-color", "--format=@@@%H%x09%s", rev, "--", ...specs, ...excludes]).toString("utf8");
  const commits: Commit[] = [];
  let commit: Commit | undefined;
  let file: FileDiff | undefined;
  for (const line of log.split("\n")) {
    if (line.startsWith("@@@")) {
      const [sha, subject] = line.slice(3).split("\t");
      commit = { sha: sha!, subject: subject ?? "", files: new Map() };
      commits.push(commit);
      file = undefined;
    } else if (line.startsWith("diff --git ") && commit !== undefined) {
      file = { added: [], removed: [], created: false };
      commit.files.set(line.slice(line.lastIndexOf(" b/") + 3), file);
    } else if (file === undefined) continue;
    else if (line.startsWith("new file mode")) file.created = true;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) file.added.push(line.slice(1));
    else if (line.startsWith("-")) file.removed.push(line.slice(1));
  }
  return commits;
}

function history(findings: Working[], commits: readonly Commit[], u: Universes): void {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const mentionCache = new Map<string, RegExp>();
  const mention = (member: string, quoted: boolean): RegExp => {
    const key = `${quoted}:${member}`;
    let re = mentionCache.get(key);
    if (re === undefined) {
      const esc = member.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      re = quoted ? new RegExp(`["'\`]${esc}["'\`]|\\b${esc}\\s*:|[|<(]${esc}[|>)]`) : new RegExp(`(^|[^\\w-])${esc}($|[^\\w-])`);
      mentionCache.set(key, re);
    }
    return re;
  };

  /** The commits that added the member to the set: a line naming it appeared where the set lives, and none naming it left. */
  const growth = (s: NameSet, member: string): string[] => {
    const out: string[] = [];
    for (const c of commits) {
      if (s.form === "folder") {
        if (c.files.get(`${s.file}/${member}`)?.created === true) out.push(c.sha);
      } else if (s.form === "closure") {
        // The closure grew by the member when a file of the closure began importing it.
        const files = u.closureFiles.get(s.id);
        const target = files?.get(member);
        if (files === undefined || target === undefined) continue;
        const within = new Set(files.values());
        for (const [path, d] of c.files) {
          if (!within.has(path) || path === target) continue;
          if (d.added.some((l) => /^\s*(import|export)\b.*from\s+["']/.test(l) && !/^\s*(import|export)\s+type\b/.test(l) && l.includes(`/${basename(target)}"`))) {
            out.push(c.sha);
            break;
          }
        }
      } else {
        const d = c.files.get(s.file);
        if (d === undefined) continue;
        const quoted = !["doc-alternation", "doc-table", "prose", "exports", "alternation"].includes(s.form);
        const re = mention(member, quoted);
        if (d.added.some((l) => re.test(l)) && !d.removed.some((l) => re.test(l))) out.push(c.sha);
      }
    }
    return out;
  };

  const touches = (s: NameSet, sha: string): boolean => {
    const c = bySha.get(sha);
    if (c === undefined) return false;
    return DERIVED.has(s.form) || c.files.has(s.file);
  };

  const cache = new Map<string, string[]>();
  const grown = (s: NameSet, member: string, raw: readonly string[]): string[] => {
    const key = `${s.id}:${member}`;
    let out = cache.get(key);
    if (out === undefined) {
      // The member as the set spells it, when matching used the stripped form.
      const i = raw.indexOf(member);
      out = growth(s, i >= 0 ? s.members[i] ?? member : member);
      cache.set(key, out);
    }
    return out;
  };

  /** The commits that added most of a set at once: where it was written, or copied, not where it was kept. */
  const births = (s: NameSet, view: readonly string[]): Set<string> => {
    const counts = new Map<string, number>();
    for (const m of view) for (const c of grown(s, m, view)) counts.set(c, (counts.get(c) ?? 0) + 1);
    return new Set([...counts].filter(([, k]) => k >= Math.max(2, 0.6 * view.length)).map(([c]) => c));
  };

  for (const f of findings) {
    const h: MirrorHistory = { together: [], lagged: [], missed: [] };
    const view = (s: NameSet, m: string): string[] => (s.members.includes(m) ? s.members : stripped(s.members) ?? s.members);
    const bornA = births(f.a, view(f.a, f.shared[0]!));
    const bornB = births(f.b, view(f.b, f.shared[0]!));
    for (const m of f.shared) {
      const ga = grown(f.a, m, view(f.a, m));
      const gb = grown(f.b, m, view(f.b, m));
      // Grew by the same name in the same commit, which was the birth of neither: someone kept them together.
      const both = ga.filter((c) => gb.includes(c) && !bornA.has(c) && !bornB.has(c));
      for (const c of both) if (!h.together.includes(c)) h.together.push(c);
      // Grew by the same name in different commits, neither a birth: someone caught one up to the other.
      const keptBy = (g: string[], born: Set<string>): boolean => g.some((c) => !born.has(c));
      if (both.length === 0 && keptBy(ga, bornA) && keptBy(gb, bornB) && !ga.some((c) => gb.includes(c))) h.lagged.push(m);
    }
    for (const [side, only, s, other] of [["b", f.onlyB, f.b, f.a], ["a", f.onlyA, f.a, f.b]] as const) {
      for (const m of only) {
        for (const sha of grown(s, m, view(s, m))) {
          if (!touches(other, sha)) h.missed.push({ commit: sha.slice(0, 7), subject: bySha.get(sha)!.subject.slice(0, 70), member: m, side });
        }
      }
    }
    h.together = h.together.map((c) => c.slice(0, 7));
    f.history = h;
  }
}

/* ---------------------------------------------------------------- ranking */

const VERDICT_WEIGHT: Record<Verdict, number> = { drifted: 1.2, latent: 1, duplicate: 1 };

function rank(findings: Working[], find: (i: number) => number): Working[][] {
  for (const f of findings) {
    const shape = f.containment * (0.5 + 0.5 * f.jaccard);
    const overlapScore = f.overlap * shape * VERDICT_WEIGHT[f.verdict];
    const h = f.history;
    const historyScore = h === undefined ? 0 : 4 * Math.min(h.together.length, 5) + 2 * Math.min(h.lagged.length, 5);
    const every = [f.a, f.b, ...f.copiesA, ...f.copiesB];
    const literalFiles = new Set(every.filter((s) => !DERIVED.has(s.form)).map((s) => s.file));
    // A copy in another file is out of the editor's sight; one beside it is not.
    const spread = literalFiles.size > 1 || every.some((s) => DERIVED.has(s.form)) ? 1 : 0.5;
    const copies = Math.max(0, new Set(every).size - 2);
    f.score = overlapScore * spread * (1 + 0.25 * Math.min(copies, 4)) + historyScore;
    f.overlapScore = overlapScore;
    f.historyScore = historyScore;
  }
  findings.sort((x, y) => y.score - x.score);
  // Only a close pairing of two hand-kept lists joins groups; a universe or a loose overlap would chain everything.
  const groupParent = new Map<number, number>();
  const groupFind = (i: number): number => {
    const p = groupParent.get(i) ?? i;
    if (p === i) return i;
    const r = groupFind(p);
    groupParent.set(i, r);
    return r;
  };
  for (const f of findings) {
    if (f.jaccard < 0.5 || DERIVED.has(f.a.form) || DERIVED.has(f.b.form)) continue;
    const x = groupFind(find(f.a.id));
    const y = groupFind(find(f.b.id));
    if (x !== y) groupParent.set(x, y);
  }
  const groups = new Map<number, Working[]>();
  for (const f of findings) {
    const k = groupFind(find(f.a.id));
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  // Findings are sorted, so each group's first is its strongest.
  return [...groups.values()].sort((x, y) => y[0]!.score - x[0]!.score);
}

function refOf(s: NameSet, u: Universes): SetRef {
  const closure = u.closureOf.get(s.id);
  return { file: s.file, line: s.line, name: s.name, form: s.form, checked: s.checked, members: s.members, ...(closure === undefined ? {} : closure) };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * The reading at one revision (HEAD by default), from git objects alone.
 * Throws MirrorUnable when the root is no git repository, the revision is
 * unknown, or the compiler's parser is not installed.
 */
export async function readMirrors(root: string, options: MirrorOptions = {}): Promise<MirrorReading> {
  const t0 = performance.now();
  const phases: Record<string, number> = {};
  let mark = t0;
  const phase = (name: string): void => {
    const now = performance.now();
    phases[name] = Math.round(now - mark);
    mark = now;
  };
  const rev = options.rev ?? "HEAD";
  let commit: string;
  try {
    commit = git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).toString("utf8").trim();
  } catch {
    throw new MirrorUnable(`no commit at ${rev}: the mirror reading reads git objects, so it needs a git repository with that revision`);
  }
  let ts: Ts;
  try {
    const loaded = (await import("typescript")) as Ts & { default?: Ts };
    ts = loaded.default ?? loaded;
  } catch {
    throw new MirrorUnable("the TypeScript compiler is not installed (an optional dependency): the mirror reading parses with it; npm install --save-dev typescript");
  }
  phase("load");

  const ignored = [...ALWAYS_IGNORED, ...ignoredAt(root, commit)];
  const isIgnored = (p: string): boolean => ignored.some((f) => p === f || p.startsWith(`${f}/`) || p.includes(`/${f}/`) && !f.includes("/"));
  const paths = git(root, ["ls-tree", "-r", "-z", "--name-only", commit]).toString("utf8").split("\0").filter((p) => p !== "" && !isIgnored(p));
  const wanted = paths.filter((p) => (CODE_FILE.test(p) && !p.endsWith(".d.ts")) || (DOC_FILE.test(p) && READ_DOC.test(p)));
  // No silent skip: a file in a language the reading does not parse is counted, so a Python project learns its code went unread.
  const unread: Record<string, number> = {};
  for (const p of paths) if (!CODE_FILE.test(p) && languageOfFile(p) !== undefined) unread[extname(p)] = (unread[extname(p)] ?? 0) + 1;
  const texts = readAll(root, commit, wanted);
  phase("read");

  const ctx: Context = { ts, root, rev: commit, sets: [], modules: new Map() };
  for (const [file, text] of texts) {
    if (CODE_FILE.test(file)) readCode(ctx, file, text);
    else readDoc(ctx, file, text);
  }
  phase("candidates");
  const u = universes(ctx, paths);
  phase("universes");
  const { findings, find } = match(ctx, u, options.all === true);
  phase("matching");
  if (options.history !== false) {
    history(findings, readCommits(root, commit, ignored), u);
    phase("history");
  }
  const ranked = rank(findings, find);
  phase("ranking");

  const groups: Group[] = ranked.map((fs, i) => ({
    rank: i + 1,
    score: round(fs[0]!.score),
    overlapScore: round(Math.max(...fs.map((f) => f.overlapScore))),
    historyScore: round(Math.max(...fs.map((f) => f.historyScore))),
    findings: fs.map((f) => ({
      a: refOf(f.a, u),
      b: refOf(f.b, u),
      verdict: f.verdict,
      shared: f.shared,
      onlyA: f.onlyA,
      onlyB: f.onlyB,
      ...(f.union === undefined ? {} : { union: refOf(f.union, u) }),
      jaccard: round(f.jaccard),
      containment: round(f.containment),
      score: round(f.score),
      overlapScore: round(f.overlapScore),
      historyScore: round(f.historyScore),
      copies: [...f.copiesA, ...f.copiesB].filter((c) => c !== f.a && c !== f.b).map((c) => refOf(c, u)),
      ...(f.history === undefined ? {} : { history: f.history }),
    })),
  }));
  return { rev, commit, ms: Math.round(performance.now() - t0), phases, sets: ctx.sets.length, read: wanted.filter((p) => CODE_FILE.test(p)).length, unread, groups };
}
