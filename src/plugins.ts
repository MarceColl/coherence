// Project runtime owner: load config and repository-local plugins into a complete,
// validated adapter registry before exposing any state to graph construction.
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { cloudflare } from "./adapters/cloudflare.ts";
import { python } from "./adapters/python.ts";
import { typescript } from "./adapters/typescript.ts";
import { loadConfig } from "./config.ts";
import type { CoherencePluginModule, PluginCapabilities } from "./plugin.ts";
import type { Config, LanguageAdapter, PlatformAdapter, PluginDeclaration } from "./types.ts";

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
    if (key !== "adapters") throw new Error(`Plugin "${plugin}" returned unsupported capability "${key}"`);
  if (value.adapters === undefined) return;
  if (!isRecord(value.adapters)) throw new Error(`Plugin "${plugin}" adapters must be a record`);
  for (const key of Object.keys(value.adapters))
    if (key !== "languages" && key !== "platforms")
      throw new Error(`Plugin "${plugin}" returned unsupported adapter capability "${key}"`);
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
