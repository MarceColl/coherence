/**
 * A quint model as replay reads it, from quint's own parse (the IR and its
 * source map), never from a parser of Coherence's: each action's parameters
 * and their types, its guard conjuncts with their source text, the variables
 * it writes, the model's landmarks, and its type aliases.
 *
 * An action replay can drive is a thin wrapper over pure updates:
 *
 *   action move(id: str, target: str, state_after: str): bool = all {
 *     <guard>, <guard>, ...,                       no primed variable anywhere
 *     state_after == stateAfter(orders, id, target),   a conformance fact
 *     orders' = moved(orders, id, target),         one assignment per variable
 *   }
 *
 * A conjunct that assigns a variable inside something else (an if, another
 * action) mixes a guard with an update, and replay could not tell which of the
 * two refused a step; such an action is a model problem with its cause, never
 * replayed loosely. A guard of the form <parameter> == <expression>, whose
 * parameter no other conjunct and not the expression reads, is a conformance
 * fact: it holds the model's computed state to the value the code logged, and
 * it is never a guard scenario. An equality on a parameter the action also
 * reads elsewhere (target == "active") is an input guard like any other.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { QuintConfig } from "./config.ts";
import { parseIr } from "./quint.ts";

/** A quint type as the IR spells it: int, str, bool, a record, a set, a list, a map (fun), a tuple, or an alias (const). */
export interface QuintType {
  kind: string;
  name?: string;
  arg?: QuintType;
  res?: QuintType;
  elem?: QuintType;
  fields?: { kind: string; fields?: { fieldName: string; fieldType: QuintType }[] };
  elems?: QuintType[];
}

/** One top-level conjunct of an action that reads state and assigns nothing. */
export interface Guard {
  /** Its place among the action's guards, from 1, as the report names it: move#2. */
  index: number;
  /** Its source text, as written in the model. */
  text: string;
  /** Its line in the model file. */
  line: number;
  /** The parameter it holds equal to a computed value, when it is a conformance fact. */
  fact?: string;
}

export interface ModelAction {
  name: string;
  params: { name: string; type: QuintType }[];
  guards: Guard[];
  /** The variables it assigns. */
  writes: string[];
}

export interface ReadModel {
  /** The main module's name, which a replay module imports. */
  module: string;
  file: string;
  vars: { name: string; type: QuintType }[];
  actions: ModelAction[];
  /** The model's landmark_<name> vals, by their full names, in the order written. */
  landmarks: string[];
  /** Type aliases, by name. */
  types: Record<string, QuintType>;
  /** Every pure val named domain_<parameter>: the finite set a parameter no argument pins is searched over. */
  domains: string[];
  /** Why the model cannot be replayed as written, one cause per action that mixes a guard with an update; empty when it can. */
  problems: string[];
}

interface IrNode {
  id: number;
  kind: string;
  name?: string;
  opcode?: string;
  qualifier?: string;
  args?: IrNode[];
  expr?: IrNode;
  params?: { name: string; typeAnnotation?: QuintType }[];
  typeAnnotation?: QuintType;
  type?: QuintType;
  opdef?: IrNode;
}

/** Whether a node assigns a variable, or calls an action that may, anywhere below it; a name the action's own parameters shadow is no action. */
function updates(node: IrNode | undefined, actions: ReadonlySet<string>, shadowed: ReadonlySet<string>): boolean {
  if (node === undefined) return false;
  const isAction = (name: string | undefined): boolean => name !== undefined && actions.has(name) && !shadowed.has(name);
  if (node.kind === "app" && (node.opcode === "assign" || isAction(node.opcode))) return true;
  if (node.kind === "name" && isAction(node.name)) return true;
  return [...(node.args ?? []), node.expr, node.opdef].some((child) => updates(child, actions, shadowed));
}

/** Whether a node reads a name anywhere below it. */
function mentions(node: IrNode | undefined, name: string): boolean {
  if (node === undefined) return false;
  if (node.kind === "name" && node.name === name) return true;
  return [...(node.args ?? []), node.expr, node.opdef].some((child) => mentions(child, name));
}

/**
 * Read a model's IR (quint parse --out) and source map into what replay
 * needs. `text` is the model file's text, from which each guard's source is
 * cut by the source map's offsets.
 */
export function readModelIr(file: string, text: string, ir: unknown, sourceMap: unknown, main?: string): ReadModel {
  const modules = ((ir as { modules?: { name: string; declarations: IrNode[] }[] }).modules ?? []);
  const wanted = main ?? basename(file).replace(/\.qnt$/, "");
  const module = modules.find((m) => m.name === wanted) ?? modules[modules.length - 1];
  if (module === undefined) return { module: wanted, file, vars: [], actions: [], landmarks: [], types: {}, domains: [], problems: [`quint parse found no module in ${file}`] };
  const map = ((sourceMap as { map?: Record<string, [number, { index: number; line: number }, { index: number; line: number }]> }).map ?? {});
  const spanText = (id: number): { text: string; line: number } => {
    const span = map[String(id)];
    return span === undefined ? { text: `<node ${id}>`, line: 0 } : { text: text.slice(span[1].index, span[2].index + 1), line: span[1].line + 1 };
  };
  const declarations = module.declarations;
  const types: Record<string, QuintType> = {};
  for (const d of declarations) if (d.kind === "typedef" && d.name !== undefined && d.type !== undefined) types[d.name] = d.type;
  const vars = declarations.filter((d) => d.kind === "var" && d.name !== undefined).map((d) => ({ name: d.name!, type: d.typeAnnotation ?? { kind: "unknown" } }));
  const actionNames = new Set(declarations.filter((d) => d.kind === "def" && d.qualifier === "action" && d.name !== undefined).map((d) => d.name!));
  const problems: string[] = [];
  const actions: ModelAction[] = [];
  for (const d of declarations) {
    if (d.kind !== "def" || d.qualifier !== "action" || d.name === undefined || d.name === "init" || d.name === "step") continue;
    const lambda = d.expr?.kind === "lambda" ? d.expr : undefined;
    const params = (lambda?.params ?? []).map((p) => ({ name: p.name, type: p.typeAnnotation ?? { kind: "unknown" } }));
    const body = lambda?.expr ?? d.expr;
    const conjuncts = body?.kind === "app" && body.opcode === "actionAll" ? (body.args ?? []) : body === undefined ? [] : [body];
    const guards: Guard[] = [];
    const writes: string[] = [];
    const paramNames = new Set(params.map((p) => p.name));
    for (const conjunct of conjuncts) {
      if (conjunct.kind === "app" && conjunct.opcode === "assign") {
        const variable = conjunct.args?.[0]?.name;
        if (variable !== undefined) writes.push(variable);
        if (updates(conjunct.args?.[1], actionNames, paramNames)) problems.push(`${d.name}: the update of ${variable} calls an action or assigns inside its value; write it as ${variable}' = <a pure function>`);
        continue;
      }
      if (updates(conjunct, actionNames, paramNames)) {
        problems.push(`${d.name}: "${spanText(conjunct.id).text.replace(/\s+/g, " ").slice(0, 80)}" mixes a guard with an update; write the guards and then one assignment per variable, each through a pure function`);
        continue;
      }
      const { text: source, line } = spanText(conjunct.id);
      const [left, right] = conjunct.kind === "app" && conjunct.opcode === "eq" ? (conjunct.args ?? []) : [];
      // A fact's parameter exists only to be held to the computed value: one the other side or any other conjunct reads is an input, and its equality an ordinary guard.
      const fact = [left, right].find((side, i) => side?.kind === "name" && paramNames.has(side.name ?? "") && !mentions([left, right][1 - i], side.name!) && conjuncts.every((other) => other === conjunct || !mentions(other, side.name!)))?.name;
      guards.push({ index: guards.length + 1, text: source, line, ...(fact === undefined ? {} : { fact }) });
    }
    if (conjuncts.length > 0 && writes.length === 0 && vars.length > 0) problems.push(`${d.name}: it assigns no variable; replay drives actions that assign every variable they change`);
    actions.push({ name: d.name, params, guards, writes });
  }
  const vals = declarations.filter((d) => d.kind === "def" && (d.qualifier === "val" || d.qualifier === "pureval") && d.name !== undefined).map((d) => d.name!);
  return {
    module: module.name,
    file,
    vars,
    actions,
    landmarks: vals.filter((n) => n.startsWith("landmark_")),
    types,
    domains: vals.filter((n) => n.startsWith("domain_")),
    problems,
  };
}

/** Parse a model with quint and read it. Rejects with quint's own reason when it does not parse. */
export async function readModel(file: string, quint: Pick<QuintConfig, "timeoutSeconds">, cwd: string, main?: string): Promise<ReadModel> {
  const parsed = await parseIr(file, { cwd, timeoutMs: quint.timeoutSeconds * 1000 });
  if (parsed.result.outcome !== "ok" || parsed.ir === undefined) throw new Error(`quint parse ${file}: ${parsed.result.outcome}: ${parsed.result.reason}`);
  return readModelIr(file, readFileSync(file, "utf8"), parsed.ir, parsed.sourceMap, main);
}
