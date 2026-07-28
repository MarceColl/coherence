// Project runtime owner: load config and repository-local plugins into a complete,
// validated adapter registry before exposing any state to graph construction.
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { cloudflare } from "./adapters/cloudflare.ts";
import { python } from "./adapters/python.ts";
import { typescript } from "./adapters/typescript.ts";
import { loadConfig } from "./config.ts";
import type { CoherencePluginModule, GraphFragment, PluginCapabilities, ReadonlyGraph } from "./plugin.ts";
import type {
  Config,
  Graph,
  GraphEdge,
  GraphNode,
  JsonValue,
  LanguageAdapter,
  PlatformAdapter,
  PluginDeclaration,
  StructuralFact,
} from "./types.ts";

const BUILTIN_LANGUAGES = { typescript, python } satisfies Record<string, LanguageAdapter>;
const BUILTIN_PLATFORMS = { cloudflare } satisfies Record<string, PlatformAdapter>;

export interface LoadedPlugin {
  readonly name: string;
  readonly path: string;
  readonly capabilities: PluginCapabilities;
}

export interface ProjectRuntime {
  readonly config: Config;
  readonly plugins: readonly LoadedPlugin[];
  readonly languages: ReadonlyMap<string, LanguageAdapter>;
  readonly platforms: ReadonlyMap<string, PlatformAdapter>;
}

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function outside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

async function pluginPath(root: string, declaration: PluginDeclaration, index: number): Promise<string> {
  if (!isRecord(declaration) || typeof declaration.path !== "string" || !declaration.path)
    throw new Error(`Invalid plugin declaration at index ${index}: expected a non-empty path`);
  if (isAbsolute(declaration.path))
    throw new Error(`Invalid plugin path "${declaration.path}": path must be relative to the project root`);
  let path: string;
  try {
    path = await realpath(resolve(root, declaration.path));
  } catch (cause) {
    throw new Error(`Cannot load plugin "${declaration.path}"`, { cause });
  }
  if (outside(root, path))
    throw new Error(`Cannot load plugin "${declaration.path}": resolved path is outside project root`);
  return path;
}

function pluginModule(value: unknown, path: string): CoherencePluginModule {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name || typeof value.create !== "function")
    throw new Error(`Plugin at ${path} has an invalid default export`);
  if (value.apiVersion !== 1)
    throw new Error(`Plugin "${value.name}" has unsupported apiVersion ${String(value.apiVersion)}; expected 1`);
  return value as unknown as CoherencePluginModule;
}

function languageAdapter(value: unknown, plugin: string, key: string): asserts value is LanguageAdapter {
  if (!isRecord(value) || !Array.isArray(value.exts) || !value.exts.every((ext) => typeof ext === "string")
      || typeof value.symbols !== "function" || typeof value.imports !== "function"
      || typeof value.docAbove !== "function" || typeof value.fileDoc !== "function")
    throw new Error(`Plugin "${plugin}" registered invalid language adapter "${key}"`);
}

function platformAdapter(value: unknown, plugin: string, key: string): asserts value is PlatformAdapter {
  if (!isRecord(value) || typeof value.bindings !== "function")
    throw new Error(`Plugin "${plugin}" registered invalid platform adapter "${key}"`);
}

function capabilityRecord(
  value: unknown,
  plugin: string,
  kind: "languages" | "platforms",
): UnknownRecord {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`Plugin "${plugin}" adapters.${kind} must be a record`);
  return value;
}

function pluginCapabilities(value: unknown, plugin: string): asserts value is PluginCapabilities {
  if (!isRecord(value))
    throw new Error(`Plugin "${plugin}" initialization returned invalid capabilities`);
  for (const key of Object.keys(value))
    if (key !== "adapters" && key !== "contributeGraph")
      throw new Error(`Plugin "${plugin}" returned unsupported capability "${key}"`);
  if (value.contributeGraph !== undefined && typeof value.contributeGraph !== "function")
    throw new Error(`Plugin "${plugin}" contributeGraph must be a function`);
  if (value.adapters !== undefined) {
    if (!isRecord(value.adapters)) throw new Error(`Plugin "${plugin}" adapters must be a record`);
    for (const key of Object.keys(value.adapters))
      if (key !== "languages" && key !== "platforms")
        throw new Error(`Plugin "${plugin}" returned unsupported adapter capability "${key}"`);
  }
}

const NODE_KEYS = new Set([
  "id", "parent", "label", "kind", "sub", "path", "line", "claimed", "claims",
  "invariants", "prose", "why", "data",
]);
const EDGE_KEYS = new Set(["id", "source", "target", "kind", "data"]);
const FACT_KEYS = new Set(["id", "label", "value", "policy"]);

function assertKeys(value: UnknownRecord, allowed: ReadonlySet<string>, subject: string): void {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${subject} has unsupported field "${key}"`);
}

function jsonValue(value: unknown, subject: string, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${subject} must contain only finite JSON numbers`);
  }
  if (typeof value !== "object")
    throw new Error(`${subject} must be JSON-serializable`);
  if (ancestors.has(value))
    throw new Error(`${subject} must not contain cycles`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length
        || Reflect.ownKeys(value).some((key) =>
          typeof key === "symbol" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key))))
      throw new Error(`${subject} must be a dense JSON array without custom properties`);
    for (const [index, item] of value.entries()) jsonValue(item, `${subject}[${index}]`, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error(`${subject} must contain only plain JSON objects`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol")
        throw new Error(`${subject} must not contain symbol keys`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error(`${subject}.${key} must be an enumerable JSON value`);
      jsonValue(descriptor.value, `${subject}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function stringField(
  value: UnknownRecord,
  key: string,
  subject: string,
  required = false,
): void {
  if (value[key] === undefined && !required) return;
  if (typeof value[key] !== "string" || (required && value[key] === ""))
    throw new Error(`${subject}.${key} must be ${required ? "a non-empty" : "a"} string`);
}

function stringArray(value: UnknownRecord, key: string, subject: string): void {
  if (value[key] === undefined) return;
  if (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === "string"))
    throw new Error(`${subject}.${key} must be an array of strings`);
}

function namespaced(id: string, plugin: string, kind: string): void {
  if (!id.startsWith(`${plugin}:`))
    throw new Error(`Plugin "${plugin}" ${kind} id "${id}" must start with "${plugin}:"`);
}

function graphNode(value: unknown, plugin: string, index: number): asserts value is GraphNode {
  const subject = `Plugin "${plugin}" graph node at index ${index}`;
  if (!isRecord(value)) throw new Error(`${subject} must be an object`);
  assertKeys(value, NODE_KEYS, subject);
  for (const key of ["id", "label", "kind"]) stringField(value, key, subject, true);
  for (const key of ["parent", "sub", "path", "prose", "why"]) stringField(value, key, subject);
  if (value.line !== undefined && (!Number.isInteger(value.line) || (value.line as number) < 1))
    throw new Error(`${subject}.line must be a positive integer`);
  if (value.claimed !== undefined && typeof value.claimed !== "boolean")
    throw new Error(`${subject}.claimed must be a boolean`);
  stringArray(value, "claims", subject);
  stringArray(value, "invariants", subject);
  if (value.data !== undefined) {
    if (!isRecord(value.data)) throw new Error(`${subject}.data must be an object`);
    jsonValue(value.data, `${subject}.data`);
  }
}

function graphEdge(value: unknown, plugin: string, index: number): asserts value is GraphEdge {
  const subject = `Plugin "${plugin}" graph edge at index ${index}`;
  if (!isRecord(value)) throw new Error(`${subject} must be an object`);
  assertKeys(value, EDGE_KEYS, subject);
  for (const key of ["id", "source", "target", "kind"]) stringField(value, key, subject, true);
  if (value.data !== undefined) {
    if (!isRecord(value.data)) throw new Error(`${subject}.data must be an object`);
    jsonValue(value.data, `${subject}.data`);
  }
}

function structuralFact(value: unknown, plugin: string, index: number): asserts value is StructuralFact {
  const subject = `Plugin "${plugin}" structural fact at index ${index}`;
  if (!isRecord(value)) throw new Error(`${subject} must be an object`);
  assertKeys(value, FACT_KEYS, subject);
  stringField(value, "id", subject, true);
  stringField(value, "label", subject, true);
  if (Object.hasOwn(value, "value")) jsonValue(value.value, `${subject}.value`);
  if (value.policy !== undefined) {
    if (!isRecord(value.policy)) throw new Error(`${subject}.policy must be an object`);
    assertKeys(value.policy, new Set(["removal", "change"]), `${subject}.policy`);
    for (const key of ["removal", "change"])
      if (value.policy[key] !== undefined && value.policy[key] !== "loss")
        throw new Error(`${subject}.policy.${key} must be "loss"`);
  }
}

function graphFragment(value: unknown, plugin: string): asserts value is GraphFragment {
  if (!isRecord(value)) throw new Error(`Plugin "${plugin}" graph contribution must be an object`);
  assertKeys(value, new Set(["nodes", "edges", "facts"]), `Plugin "${plugin}" graph contribution`);
  for (const key of ["nodes", "edges", "facts"])
    if (value[key] !== undefined && !Array.isArray(value[key]))
      throw new Error(`Plugin "${plugin}" graph contribution.${key} must be an array`);
  for (const [index, node] of ((value.nodes as unknown[] | undefined) ?? []).entries())
    graphNode(node, plugin, index);
  for (const [index, edge] of ((value.edges as unknown[] | undefined) ?? []).entries())
    graphEdge(edge, plugin, index);
  for (const [index, fact] of ((value.facts as unknown[] | undefined) ?? []).entries())
    structuralFact(fact, plugin, index);
}

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

/** Compose validated repository contributions without exposing partial graph state. */
export async function composePluginGraph(project: ProjectRuntime, base: Graph): Promise<Graph> {
  const contributors = project.plugins.filter((plugin) => plugin.capabilities.contributeGraph);
  if (!contributors.length) return base;

  const snapshot = deepFreeze(clone(base)) as ReadonlyGraph;
  const fragments: Array<{ plugin: string; fragment: GraphFragment }> = [];
  for (const plugin of contributors) {
    let contribution: unknown;
    try {
      contribution = await plugin.capabilities.contributeGraph!(snapshot);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Plugin "${plugin.name}" graph contribution failed: ${detail}`, { cause });
    }
    graphFragment(contribution, plugin.name);
    fragments.push({ plugin: plugin.name, fragment: clone(contribution) });
  }

  const nodes = [...base.nodes];
  const edges = [...base.edges];
  const facts = [...(base.facts ?? [])];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const factIds = new Set(facts.map((fact) => fact.id));

  for (const { plugin, fragment } of fragments) {
    for (const node of fragment.nodes ?? []) {
      if (nodeIds.has(node.id)) {
        const source = base.nodes.some((item) => item.id === node.id) ? "base " : "";
        throw new Error(`Plugin "${plugin}" cannot replace or duplicate ${source}node "${node.id}"`);
      }
      namespaced(node.id, plugin, "node");
      nodeIds.add(node.id);
      nodes.push(node as GraphNode);
    }
    for (const edge of fragment.edges ?? []) {
      if (edgeIds.has(edge.id)) throw new Error(`Duplicate graph edge id "${edge.id}"`);
      namespaced(edge.id, plugin, "edge");
      edgeIds.add(edge.id);
      edges.push(edge as GraphEdge);
    }
    for (const fact of fragment.facts ?? []) {
      if (factIds.has(fact.id)) throw new Error(`Duplicate structural fact id "${fact.id}"`);
      namespaced(fact.id, plugin, "structural fact");
      factIds.add(fact.id);
      facts.push(fact as StructuralFact);
    }
  }

  for (const node of nodes)
    if (node.parent !== undefined && !nodeIds.has(node.parent))
      throw new Error(`Graph node "${node.id}" has dangling parent "${node.parent}"`);
  for (const edge of edges) {
    if (edge.source === edge.target) throw new Error(`Graph edge "${edge.id}" cannot be a self-edge`);
    if (!nodeIds.has(edge.source)) throw new Error(`Graph edge "${edge.id}" has dangling source "${edge.source}"`);
    if (!nodeIds.has(edge.target)) throw new Error(`Graph edge "${edge.id}" has dangling target "${edge.target}"`);
  }

  return {
    ...base,
    nodes,
    edges,
    ...(facts.length ? { facts } : {}),
  };
}

export async function loadProject(root: string): Promise<ProjectRuntime> {
  const projectRoot = await realpath(root);
  const config = await loadConfig(projectRoot);
  const declarations = config.plugins ?? [];
  if (!Array.isArray(declarations)) throw new Error("Invalid plugins config: expected an array");

  const modules: Array<{ declaration: PluginDeclaration; path: string; module: CoherencePluginModule }> = [];
  const names = new Set<string>();
  for (const [index, declaration] of declarations.entries()) {
    const path = await pluginPath(projectRoot, declaration, index);
    const imported = await import(pathToFileURL(path).href);
    const module = pluginModule(imported.default, path);
    if (names.has(module.name)) throw new Error(`Duplicate plugin name "${module.name}"`);
    names.add(module.name);
    modules.push({ declaration, path, module });
  }

  const loaded: LoadedPlugin[] = [];
  for (const entry of modules) {
    let capabilities: unknown;
    try {
      capabilities = await entry.module.create({
        root: projectRoot,
        options: entry.declaration.options,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Plugin "${entry.module.name}" initialization failed: ${detail}`, { cause });
    }
    pluginCapabilities(capabilities, entry.module.name);
    loaded.push(Object.freeze({
      name: entry.module.name,
      path: entry.path,
      capabilities,
    }));
  }

  const languages = new Map<string, LanguageAdapter>(Object.entries(BUILTIN_LANGUAGES));
  const platforms = new Map<string, PlatformAdapter>(Object.entries(BUILTIN_PLATFORMS));
  for (const plugin of loaded) {
    const adapters = plugin.capabilities.adapters;
    for (const [key, adapter] of Object.entries(capabilityRecord(adapters?.languages, plugin.name, "languages"))) {
      if (languages.has(key)) throw new Error(`Duplicate language adapter "${key}"`);
      languageAdapter(adapter, plugin.name, key);
      languages.set(key, adapter);
    }
    for (const [key, adapter] of Object.entries(capabilityRecord(adapters?.platforms, plugin.name, "platforms"))) {
      if (platforms.has(key)) throw new Error(`Duplicate platform adapter "${key}"`);
      platformAdapter(adapter, plugin.name, key);
      platforms.set(key, adapter);
    }
  }

  if (!languages.has(config.language)) throw new Error(`Unknown language adapter "${config.language}"`);
  if (config.platform !== null && !platforms.has(config.platform))
    throw new Error(`Unknown platform adapter "${config.platform}"`);

  return Object.freeze({
    config,
    plugins: Object.freeze(loaded),
    languages,
    platforms,
  });
}
