/**
 * The project's config as every reader sees it: its own
 * `coherence.config.json`, over what a repository-level registry declares.
 *
 * A `coherence.config.json` at the repository top that carries `projects`, a
 * list of repository-relative folders, is a registry: the top is no project
 * of its own, each listed folder (a leaf) is one, and the rest of the
 * repository is outside every project. A leaf inherits the registry's keys
 * unless its own config declares them, key by key:
 *
 *   name, entryDir, lexicon, projects, models   never inherited: each is the leaf's own
 *   ignore      concatenated: the registry's names apply anywhere, and a path
 *               it names is kept when it lies inside the leaf, rebased to it
 *   wellKnown   concatenated
 *   tests, test, testJson, testMatch, testFilterForm, testDir, testDirs
 *               one group: a leaf that declares any of them replaces the
 *               registry's whole group, so a leaf's command never runs with
 *               the registry's match; an inherited setup's cwd is rebased
 *               from the registry's folder to the leaf (the registry's "."
 *               is the repository top)
 *   everything else (language, references, latencyBudget, interfaceBudget,
 *               and any key not named here)   replaced whole
 *
 * A relative path an inherited key holds resolves against the file that
 * declared it. `references` folders are relative to the repository top in
 * either file, which is where the registry sits.
 *
 * Without a registry, a project's config is its own file, as before.
 */

import { spawnSync } from "../lifecycle/work-meter.ts";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CONFIG_FILE = "coherence.config.json";

/**
 * The top of the repository holding `root`: the nearest folder at or above
 * it with a `.git` (a folder, or a worktree's file); undefined outside one.
 * Stats only, no git call.
 */
export function repositoryTop(root: string): string | undefined {
  for (let dir = resolve(root); ; dir = resolve(dir, "..")) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (resolve(dir, "..") === dir) return undefined;
  }
}

/** A repository's registry: where it is, the leaves it opts in (absolute, sorted), and the keys it declares. */
export interface Registry {
  top: string;
  path: string;
  /** The leaves exactly as listed, repository-relative with forward slashes. */
  listed: string[];
  leaves: string[];
  record: Record<string, unknown>;
}

/** The keys a leaf never inherits. */
export const OWN_KEYS: ReadonlySet<string> = new Set(["name", "entryDir", "lexicon", "projects", "models"]);
/** The keys a leaf's own value adds to the registry's rather than replaces. */
export const CONCATENATED: ReadonlySet<string> = new Set(["ignore", "wellKnown"]);
/** The keys one test setup reads, top level or in each entry of tests; enforcement/config.ts reads a setup through these alone, so a key it reads is one this names. */
export const SETUP_KEYS = ["test", "testJson", "testMatch", "testFilterForm", "testDir", "testDirs"] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];
/** The test keys, inherited or replaced as one group: tests and every setup key. */
export const TEST_KEYS: ReadonlySet<string> = new Set(["tests", ...SETUP_KEYS]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

/** A config file's object, undefined when the file is absent; a file that is not a JSON object is an error naming it. */
export function readConfigFile(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(parsed)) throw new Error(`${path}: expected a JSON object`);
  return parsed;
}

/** One process asks this of one repository many times in one event; a reading a moment old answers again. */
const REGISTRY_MS = 2_000;
const registries = new Map<string, { at: number; mtime: number; registry: Registry | undefined }>();

/**
 * The registry of the repository holding `dir`, or undefined when its top's
 * config carries no `projects` (or there is no config, or no repository).
 * Stats and one small read: no git call. A `projects` that is not a list of
 * folders is an error naming the file.
 */
export function registryOf(dir: string): Registry | undefined {
  const found = repositoryTop(dir);
  if (found === undefined) return undefined;
  // Leaves are real paths, so a path spelled through a symbolic link (macOS /tmp) matches them once it is made real too.
  let top = found;
  try {
    top = realpathSync(found);
  } catch {
    // an unreadable top keeps its spelling
  }
  const path = join(top, CONFIG_FILE);
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const held = registries.get(path);
  if (held !== undefined && held.mtime === mtime && Date.now() - held.at < REGISTRY_MS) return held.registry;
  const registry = readRegistry(top, path);
  registries.set(path, { at: Date.now(), mtime, registry });
  return registry;
}

function readRegistry(top: string, path: string): Registry | undefined {
  let record: Record<string, unknown> | undefined;
  try {
    record = readConfigFile(path);
  } catch {
    // A registry that will not parse is the spec check's to refuse, with its path; the hooks answer as if there were none.
    return undefined;
  }
  if (record === undefined || !("projects" in record)) return undefined;
  const projects = record["projects"];
  if (!Array.isArray(projects)) return undefined;
  const listed = projects.filter((p): p is string => typeof p === "string").map((p) => slash(p).replace(/^(\.\/)+/, "").replace(/\/+$/, "")).filter((p) => p !== "" && p !== ".");
  return { top, path, listed, leaves: [...new Set(listed.map((p) => resolve(top, p)))].sort(), record };
}

/** Whether `path` is `dir` or lies below it, by spelling (both absolute and resolved). */
export function under(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The leaf a path lies in, the longest listed prefix; undefined when it is in none. */
export function leafOf(registry: Registry, path: string): string | undefined {
  const absolute = resolve(path);
  let found: string | undefined;
  for (const leaf of registry.leaves) if (under(leaf, absolute) && (found === undefined || leaf.length > found.length)) found = leaf;
  return found;
}

/** The registry `root` is a leaf of, or undefined when it is none's. */
export function registryForLeaf(root: string): Registry | undefined {
  const registry = registryOf(root);
  return registry !== undefined && registry.leaves.includes(realOr(root)) ? registry : undefined;
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** A registry's ignore entry seen from a leaf: a name as it is, a path rebased to the leaf when it lies inside it, else nothing. */
function rebasedIgnore(registry: Registry, leaf: string, entry: string): string[] {
  const key = slash(entry).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (key === "") return [];
  if (!key.includes("/")) return [key];
  const absolute = resolve(registry.top, key);
  if (!under(leaf, absolute) || absolute === leaf) return [];
  return [slash(relative(leaf, absolute))];
}

/** A registry's test setup seen from a leaf: its cwd, relative to the registry's folder, rebased to the leaf. */
function rebasedSetup(registry: Registry, leaf: string, setup: unknown): unknown {
  if (!isRecord(setup) || typeof setup["cwd"] !== "string" || isAbsolute(setup["cwd"])) return setup;
  return { ...setup, cwd: slash(relative(leaf, resolve(registry.top, setup["cwd"]))) || "." };
}

/**
 * The config a project at `root` reads: its own file over its registry's
 * keys, by the rules above; undefined when neither declares anything.
 * `path` is the file a reader names in an error: the project's own when it
 * has one, else the registry's.
 */
export function effectiveConfig(root: string): { record: Record<string, unknown>; path: string } | undefined {
  const base = realOr(root);
  const ownPath = join(resolve(root), CONFIG_FILE);
  const registry = registryForLeaf(base);
  const own = readConfigFile(ownPath);
  if (registry === undefined) return own === undefined ? undefined : { record: own, path: ownPath };
  const inherited: Record<string, unknown> = {};
  const ownsTests = own !== undefined && Object.keys(own).some((k) => TEST_KEYS.has(k));
  for (const [key, value] of Object.entries(registry.record)) {
    if (OWN_KEYS.has(key)) continue;
    if (TEST_KEYS.has(key) && ownsTests) continue;
    if (key === "ignore") inherited[key] = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").flatMap((v) => rebasedIgnore(registry, base, v)) : [];
    else if (key === "tests") inherited[key] = Array.isArray(value) ? value.map((s) => rebasedSetup(registry, base, s)) : value;
    else inherited[key] = value;
  }
  const record: Record<string, unknown> = { ...inherited };
  for (const [key, value] of Object.entries(own ?? {})) {
    if (CONCATENATED.has(key) && Array.isArray(value) && Array.isArray(inherited[key])) record[key] = [...new Set([...(inherited[key] as unknown[]), ...value])];
    else record[key] = value;
  }
  return { record, path: own === undefined ? registry.path : ownPath };
}

/** The effective config's object, or an empty one. */
export function configRecord(root: string): Record<string, unknown> {
  return effectiveConfig(root)?.record ?? {};
}

/** The project lexicon's file name at the root when the config names no other. */
export const DEFAULT_PROJECT_LEXICON = "lexicon.json";

/** Where the project's lexicon is or would be: the file its own config's lexicon key names (never a registry's), else the default at the root. */
export function lexiconFileOf(root: string): string {
  const named = readConfigFile(join(resolve(root), CONFIG_FILE))?.["lexicon"];
  return resolve(root, typeof named === "string" ? named : DEFAULT_PROJECT_LEXICON);
}

/** The name the project's own config gives it (`name`, never a registry's), trimmed; undefined when it gives none or the config will not parse. */
export function configuredName(root: string): string | undefined {
  try {
    const named = readConfigFile(join(resolve(root), CONFIG_FILE))?.["name"];
    return typeof named === "string" && named.trim() !== "" ? named.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project's name, the one answer every reader takes: its config's name;
 * else the name a lexicon stored before any config named one (`stored`,
 * read from the lexicon's project field and never written now); else its
 * folder's. A stored name that disagrees with the config's is a spec problem
 * (model.ts), never a second answer.
 */
export function projectName(root: string, stored?: string): string {
  return configuredName(root) ?? (stored !== undefined && stored.trim() !== "" ? stored.trim() : basename(resolve(root)));
}

/** One thing wrong with a registry: the file it is about, and what. */
export interface RegistryProblem {
  file: string;
  message: string;
}

/**
 * What is wrong with the repository's registry: a `projects` that is not a
 * list of folders, a listed folder that leaves the repository, is missing,
 * or lies inside another listed one, and a coherence.config.json git lists
 * below the top that no listed folder holds, adopted there but not opted
 * in. One git listing. Repository-relative file names.
 */
export function registryProblems(top: string): RegistryProblem[] {
  const path = join(top, CONFIG_FILE);
  let record: Record<string, unknown> | undefined;
  try {
    record = readConfigFile(path);
  } catch (error) {
    return [{ file: CONFIG_FILE, message: (error as Error).message }];
  }
  if (record === undefined || !("projects" in record)) return [];
  const projects = record["projects"];
  if (!Array.isArray(projects) || !projects.every((p) => typeof p === "string")) return [{ file: CONFIG_FILE, message: "projects is a list of folders relative to the repository top" }];
  const registry = registryOf(top);
  if (registry === undefined) return [];
  const problems: RegistryProblem[] = [];
  for (const listed of registry.listed) {
    const absolute = resolve(registry.top, listed);
    if (!under(registry.top, absolute) || absolute === registry.top) problems.push({ file: CONFIG_FILE, message: `projects lists ${listed}, which is not a folder below the repository top` });
    else if (!existsSync(absolute) || !statSync(absolute).isDirectory()) problems.push({ file: CONFIG_FILE, message: `projects lists ${listed}, which is not a folder` });
    const outer = registry.leaves.find((leaf) => leaf !== absolute && under(leaf, absolute));
    if (outer !== undefined) problems.push({ file: CONFIG_FILE, message: `projects lists ${listed} inside ${slash(relative(registry.top, outer))}; a project is never nested in another` });
  }
  const listing = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", `:(glob)**/${CONFIG_FILE}`], { cwd: registry.top, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (listing.status === 0) {
    for (const file of listing.stdout.split("\0").filter((f) => f !== "" && f !== CONFIG_FILE && f.endsWith(`/${CONFIG_FILE}`)).sort()) {
      const folder = resolve(registry.top, file, "..");
      if (!registry.leaves.includes(folder)) problems.push({ file, message: `adopted here but not opted in: ${CONFIG_FILE} at the repository top lists projects, and not ${slash(relative(registry.top, folder))}; opt it in with adopt ${slash(relative(registry.top, folder))}, or remove this file` });
    }
  }
  return problems;
}
