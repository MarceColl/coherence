/**
 * The project's own files: the one rule for what may ever be evidence.
 *
 * A file belongs to the project when git would call it the project's — it
 * is tracked, or untracked and not ignored (`git ls-files --cached --others
 * --exclude-standard`) — and it does not lie inside a nested checkout: a
 * folder below the root holding a `.git` file or folder, which is another
 * repository or another worktree of this one (an agent's copy under
 * `.claude/worktrees/`, a vendored clone, a submodule). Git alone does not
 * settle the second half: a `.git` file whose gitdir it cannot follow makes
 * the folder read as ordinary untracked files, so the nesting is checked on
 * disk as well. Outside a repository there are no ignore rules to read, so
 * every file under the root that no nested checkout holds belongs, except
 * under node_modules, the one dependency folder assumed ignored everywhere.
 *
 * Every walk of the project and every reference an instrument reports goes
 * through this rule: a copy of a file in an agent's worktree is someone
 * else's working state, and a reference found there is not a reference in
 * this project, so it is never a bypass, never vocabulary, never mass.
 */

import { spawnSync } from "../lifecycle/work-meter.ts";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configRecord, repositoryTop } from "./project-config.ts";
import { HOST_FOLDER } from "../lifecycle/hosts.ts";
export { repositoryTop };

/** The most bytes one git listing may carry; a larger project is a failure worth reporting, not a truncated answer. */
const GIT_LISTING_LIMIT = 256 * 1024 * 1024;
/** Pathspecs per git call when asking about named files. */
const PATHSPEC_BATCH = 400;

const repositoryCache = new Map<string, boolean>();

/** Whether git answers for the root: a repository's work tree, at its top or below it. */
function inRepository(root: string): boolean {
  const cached = repositoryCache.get(root);
  if (cached !== undefined) return cached;
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" });
  const answer = probe.status === 0 && probe.stdout.trim() === "true";
  repositoryCache.set(root, answer);
  return answer;
}

/** A path as project-relative with forward slashes, or undefined when it is the root or lies outside it. */
function projectRelative(root: string, path: string): string | undefined {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute).split(sep).join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return undefined;
  return rel;
}

/** Whether the folder (project-relative, "" for the root) is the top of a checkout of its own. */
function holdsCheckout(root: string, folder: string, memo: Map<string, boolean>): boolean {
  let answer = memo.get(folder);
  if (answer === undefined) {
    answer = folder !== "" && existsSync(join(root, folder, ".git"));
    memo.set(folder, answer);
  }
  return answer;
}

/** Whether a project-relative path lies inside a nested checkout: some folder strictly between the root and it holds a `.git`. */
function insideNested(root: string, rel: string, memo: Map<string, boolean>): boolean {
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (holdsCheckout(root, parts.slice(0, i).join("/"), memo)) return true;
  }
  return false;
}

function isFileOnDisk(root: string, rel: string): boolean {
  try {
    return !lstatSync(join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

function isFolderOnDisk(root: string, rel: string): boolean {
  try {
    return lstatSync(join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

function gitList(root: string, pathspecs: readonly string[]): string[] {
  const args = ["--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", ...(pathspecs.length === 0 ? [] : ["--", ...pathspecs])];
  const listed = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: GIT_LISTING_LIMIT });
  if (listed.status !== 0) {
    const reason = (listed.stderr ?? "").trim() || (listed.error?.message ?? `exit ${listed.status}`);
    throw new Error(`the project's files are not known: git ls-files failed in ${root}: ${reason}`);
  }
  // A nested repository git lists as one folder entry ("nested/"), never as files: not the project's.
  return listed.stdout.split("\0").filter((entry) => entry !== "" && !entry.endsWith("/"));
}

/** Outside a repository: every file under the root, never into a nested checkout, a `.git`, or node_modules. */
function walkUnversioned(root: string, memo: Map<string, boolean>): string[] {
  const found: string[] = [];
  const walk = (folder: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, folder), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const rel = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!holdsCheckout(root, rel, memo)) walk(rel);
      } else {
        found.push(rel);
      }
    }
  };
  walk("");
  return found;
}

/**
 * Every file of the project under the root, project-relative with forward
 * slashes, sorted. The one enumeration every walk starts from; a walker may
 * narrow it (by extension, by folder) but never widen it.
 */
export function projectFiles(root: string): string[] {
  const base = resolve(root);
  const memo = new Map<string, boolean>();
  const listed = inRepository(base) ? gitList(base, []) : walkUnversioned(base, memo);
  return [...new Set(listed)].filter((rel) => !insideNested(base, rel, memo) && isFileOnDisk(base, rel)).sort();
}

/**
 * The project files under one folder of the project, by the same rule as
 * projectFiles, from a git listing of that folder alone: a caller asking
 * about one corner of a large project pays for that corner. The empty
 * folder is the whole project.
 */
export function projectFilesUnder(root: string, folder: string): string[] {
  const key = folderKey(folder);
  if (key === "") return projectFiles(root);
  const base = resolve(root);
  if (!inRepository(base)) return projectFiles(base).filter((rel) => rel.startsWith(`${key}/`));
  const memo = new Map<string, boolean>();
  return [...new Set(gitList(base, [key]))].filter((rel) => !insideNested(base, rel, memo) && isFileOnDisk(base, rel)).sort();
}

/**
 * The project files whose names end with `suffix` (a spec's `.spec.md`), by
 * the same rule as projectFiles, from a git listing of those files alone: a
 * caller that needs the specs pays for the specs, never for every file.
 * Outside a repository, the whole walk filtered.
 */
export function projectFilesEnding(root: string, suffix: string): string[] {
  const base = resolve(root);
  if (!inRepository(base)) return projectFiles(base).filter((rel) => rel.endsWith(suffix));
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", `:(glob)**/*${suffix}`], { cwd: base, encoding: "utf8", maxBuffer: GIT_LISTING_LIMIT });
  if (listed.status !== 0) throw new Error(`the project's files are not known: git ls-files failed in ${base}: ${(listed.stderr ?? "").trim() || `exit ${listed.status}`}`);
  const memo = new Map<string, boolean>();
  return [...new Set(listed.stdout.split("\0").filter((entry) => entry !== "" && !entry.endsWith("/") && entry.endsWith(suffix)))]
    .filter((rel) => !insideNested(base, rel, memo) && isFileOnDisk(base, rel))
    .sort();
}

/** A folder as the ignore list compares it: project-relative, forward slashes, no leading "./" and no trailing "/". */
function folderKey(folder: string): string {
  return folder.split(sep).join("/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/**
 * The config's ignore list: the folders, by name or by project-relative
 * path, and the files, by project-relative path, the adoption bounds the
 * project away from. An absent or unreadable
 * config ignores nothing here; the spec walker is the reader that refuses a
 * malformed config.
 */
export function configIgnore(root: string): string[] {
  try {
    // The project's own ignore list over its registry's (project-config.ts).
    const ignore = configRecord(root)["ignore"];
    return Array.isArray(ignore) ? ignore.filter((value): value is string => typeof value === "string").map(folderKey).filter((f) => f !== "") : [];
  } catch {
    return [];
  }
}

/**
 * Whether a project-relative path is one the list names: the path itself, a
 * file by its path from the root ("CHANGELOG.md", "src/generated.ts"), or
 * some folder on its way down, by its own name ("node_modules", anywhere) or
 * by its path from the root ("posthog/api"). A file is named by its path
 * alone, never by its name anywhere; pass a folder with a trailing "/" to ask
 * about the folder itself. The one rule every walk applies to the config's
 * ignore list.
 */
export function underIgnored(rel: string, ignore: Iterable<string>): boolean {
  const skip = ignore instanceof Set ? (ignore as Set<string>) : new Set([...ignore].map(folderKey));
  if (skip.size === 0) return false;
  if (skip.has(rel)) return true;
  const folders = rel.split("/").slice(0, -1);
  return folders.some((name, i) => skip.has(name) || skip.has(folders.slice(0, i + 1).join("/")));
}

/**
 * The project's files inside the config's bounds: projectFiles, less every
 * file under a folder the config's ignore list names. What an adoption
 * bounded to one subsystem reads, and nothing past it.
 */
export function boundedProjectFiles(root: string, ignore: readonly string[] = configIgnore(root)): string[] {
  const skip = new Set(ignore.map(folderKey));
  return projectFiles(root).filter((rel) => !underIgnored(rel, skip));
}

/* ------------------------------------------------------------ the walks */

/**
 * Folder names no project authors its code in, wherever they sit: a package
 * manager's install and an interpreter's cache. Nothing else is left out by
 * its name alone: a folder named public, dist or build may hold the
 * project's own code (billing's api/public held five routes no walk read),
 * and a generated one is already left out by the project's git ignore rules.
 */
const ENVIRONMENT_FOLDERS: ReadonlySet<string> = new Set(["node_modules", "__pycache__", "site-packages"]);

/** The agent hosts' folders, as hosts.ts declares them, and git's own: never the project's words, even for a walk that reads hidden folders. */
const HOST_FOLDERS: ReadonlySet<string> = new Set([".git", ...Object.values(HOST_FOLDER)]);

/** A file the walks leave out, and the rule that left it out. */
export interface Exclusion {
  file: string;
  reason: string;
}

/** What a walk reads and what it leaves out: together, exactly projectFiles. */
export interface Walked {
  files: string[];
  excluded: Exclusion[];
}

/** The bounds one walk applies: the config's ignore list, and whether hidden folders are read. */
export interface Bounds {
  root: string;
  ignore: ReadonlySet<string>;
  /** Read hidden folders other than the hosts' (.github, .coherence): the vocabulary check reads them; a code walk never does. */
  readHidden: boolean;
  /** Per folder, its reason or "" when the folder is walked. */
  memo: Map<string, string>;
}

export function walkBounds(root: string, ignore: readonly string[] = configIgnore(root), options: { readHidden?: boolean } = {}): Bounds {
  return { root: resolve(root), ignore: new Set(ignore.map(folderKey).filter((f) => f !== "")), readHidden: options.readHidden ?? false, memo: new Map() };
}

/** Whether a folder on disk is a Python virtual environment. */
export function isVirtualEnvironment(dir: string): boolean {
  return existsSync(join(dir, "pyvenv.cfg"));
}

/**
 * Whether a folder on disk is Cargo's build output: a folder named target
 * beside a Cargo.toml. Named by its place, never by its name alone, since a
 * folder called target elsewhere may hold the project's own code.
 */
export function isCargoTarget(dir: string): boolean {
  return basename(dir) === "target" && existsSync(join(dirname(dir), "Cargo.toml"));
}

/** Whether a disk walk looking for folders (virtual environments, nested checkouts) may skip descending into one by its name: hidden, a host's, or an environment folder. */
export function neverWalkedName(name: string): boolean {
  return name.startsWith(".") || HOST_FOLDERS.has(name) || ENVIRONMENT_FOLDERS.has(name);
}

/** Why one folder (project-relative) is left out, or "" when the walk enters it. */
function folderReason(bounds: Bounds, folder: string): string {
  let reason = bounds.memo.get(folder);
  if (reason !== undefined) return reason;
  const name = folder.slice(folder.lastIndexOf("/") + 1);
  if (bounds.ignore.has(folder) || bounds.ignore.has(name)) reason = `config ignore: ${bounds.ignore.has(folder) ? folder : name}`;
  else if (HOST_FOLDERS.has(name)) reason = `host folder: ${folder}`;
  else if (name.startsWith(".") && !bounds.readHidden) reason = `hidden folder: ${folder}`;
  else if (ENVIRONMENT_FOLDERS.has(name)) reason = `environment folder: ${folder}`;
  else if (isVirtualEnvironment(join(bounds.root, folder))) reason = `virtual environment: ${folder}`;
  else if (isCargoTarget(join(bounds.root, folder))) reason = `Cargo build folder: ${folder}`;
  else reason = "";
  bounds.memo.set(folder, reason);
  return reason;
}

/**
 * Why a project-relative path lies outside the walk, or undefined when the
 * walk reads it: the first folder on its way down that a rule leaves out,
 * named with the rule, else the file itself when the config's ignore list
 * names its path. The one place any walk of the project leaves a file out; a
 * walker may narrow what it reads by kind (an extension, a test), but a
 * folder or a named file is left out here or not at all.
 */
export function exclusionOf(rel: string, bounds: Bounds): string | undefined {
  const folders = rel.split("/").slice(0, -1);
  for (let i = 0; i < folders.length; i++) {
    const reason = folderReason(bounds, folders.slice(0, i + 1).join("/"));
    if (reason !== "") return reason;
  }
  return bounds.ignore.has(rel) ? `config ignore: ${rel}` : undefined;
}

/** Every project file a walk reads, and every one it leaves out with its reason. */
export function walkedProjectFiles(bounds: Bounds): Walked {
  const files: string[] = [];
  const excluded: Exclusion[] = [];
  for (const file of projectFiles(bounds.root)) {
    const reason = exclusionOf(file, bounds);
    if (reason === undefined) files.push(file);
    else excluded.push({ file, reason });
  }
  return { files, excluded };
}

/** The exclusions summed by reason, largest first: what a reading shows of what no walk read. */
export function exclusionSummary(excluded: readonly Exclusion[]): { reason: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const { reason } of excluded) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, files]) => ({ reason, files })).sort((a, b) => b.files - a.files || a.reason.localeCompare(b.reason));
}

/**
 * The given paths (absolute or project-relative) that are project files, as
 * project-relative paths with forward slashes. The same rule as
 * projectFiles, asked of a few paths at once: an instrument's reference
 * sites, a file an edit wrote. A tracked file an edit just deleted is still
 * the project's until the deletion is committed.
 */
export function keepProjectFiles(root: string, paths: readonly string[], listing?: ProjectListing): Set<string> {
  const base = resolve(root);
  const memo = new Map<string, boolean>();
  const candidates = [...new Set(paths.map((p) => projectRelative(base, p)).filter((rel): rel is string => rel !== undefined))].filter(
    (rel) => !insideNested(base, rel, memo) && !isFolderOnDisk(base, rel) && !rel.split("/").includes(".git"),
  );
  if (candidates.length === 0 || !inRepository(base)) {
    return new Set(inRepository(base) ? [] : candidates.filter((rel) => !rel.split("/").includes("node_modules")));
  }
  // A listing taken once answers what git would for each batch: the same listing, without a git call per question.
  if (listing !== undefined && listing.root === base) return new Set(candidates.filter((rel) => listing.listed.has(rel)));
  const kept = new Set<string>();
  for (let i = 0; i < candidates.length; i += PATHSPEC_BATCH) {
    for (const rel of gitList(base, candidates.slice(i, i + PATHSPEC_BATCH))) kept.add(rel);
  }
  return new Set(candidates.filter((rel) => kept.has(rel)));
}

/**
 * What git lists for a project at one moment: every tracked and every
 * untracked, unignored file. A caller asking many questions of a tree that
 * holds still (one reading, an instrument between two forgets) takes it once
 * and hands it to keepProjectFiles and projectSites, which then answer
 * exactly as git would without asking it again. A caller that must see a
 * file written a moment ago (the check at an edit) takes none.
 */
export interface ProjectListing {
  root: string;
  listed: ReadonlySet<string>;
}

/** The listing of a repository now, or undefined outside one (where keepProjectFiles asks no git). */
export function projectListing(root: string): ProjectListing | undefined {
  const base = resolve(root);
  if (!inRepository(base)) return undefined;
  return { root: base, listed: new Set(gitList(base, [])) };
}

/**
 * The reference sites that sit in the project's own files, in their order.
 * Every consumer of an instrument's references accepts sites through this,
 * whatever instrument answered: a warm server started before this rule
 * existed may still report a nested checkout's copy.
 */
export function projectSites<T extends { file: string }>(root: string, sites: readonly T[], listing?: ProjectListing): T[] {
  const own = keepProjectFiles(root, sites.map((site) => site.file), listing);
  return sites.filter((site) => own.has(site.file));
}

/** The reference sites a chokepoint check may classify: the project's own (projectSites), and those in a folder of the config's reference horizon. */
export function horizonSites<T extends { file: string }>(root: string, sites: readonly T[]): T[] {
  const kept = keepHorizonFiles(root, sites.map((site) => site.file));
  return sites.filter((site) => kept.has(site.file));
}

/** Whether one path (absolute or project-relative) is a project file. */
export function isProjectFile(root: string, path: string): boolean {
  return keepProjectFiles(root, [path]).size === 1;
}

/**
 * The project folder relative to its repository's top, when the project is
 * nested below the top; undefined when the project is the whole repository
 * (or lies in none).
 */
export function nestedFolder(root: string): string | undefined {
  const top = repositoryTop(root);
  if (top === undefined) return undefined;
  const rel = relative(top, resolve(root)).split(sep).join("/");
  return rel === "" || rel.startsWith("..") ? undefined : rel;
}

/**
 * Where a chokepoint check searches for references, from the config's
 * `references`: the project alone ("project", the default), the whole
 * repository ("repository"), or the project and the listed folders, each
 * relative to the repository top. A value of any other shape is the default.
 */
export type ReferenceScope = "project" | "repository" | readonly string[];

export function configReferences(root: string): ReferenceScope {
  try {
    const value = configRecord(root)["references"];
    if (value === "repository") return "repository";
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.map(folderKey).filter((f) => f !== "");
    return "project";
  } catch {
    return "project";
  }
}

/**
 * The folders outside a nested project that its reference search also
 * reads, absolute and outermost only: none for "project" or for a project
 * at the repository top, the top itself for "repository", and each listed
 * folder otherwise, less any that is the project, lies inside it, or leaves
 * the repository.
 */
export function horizonFolders(root: string, scope: ReferenceScope = configReferences(root)): string[] {
  const base = resolve(root);
  const top = repositoryTop(base);
  if (top === undefined || nestedFolder(base) === undefined || scope === "project") return [];
  if (scope === "repository") return [top];
  const inside = (outer: string, inner: string): boolean => {
    const rel = relative(outer, inner);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const folders = [...new Set(scope.map((f) => resolve(top, f)))].filter((f) => inside(top, f) && !inside(base, f));
  return folders.filter((f) => !folders.some((other) => other !== f && inside(other, f))).sort();
}

/**
 * What a chokepoint verdict says its reference search covered, when that is
 * less than the repository: the project folder and every horizon folder,
 * each relative to the repository top; undefined when the search covered
 * the whole repository (a project at the top, or "repository").
 */
export function searchedHorizon(root: string, scope: ReferenceScope = configReferences(root)): string | undefined {
  const own = nestedFolder(root);
  if (own === undefined || scope === "repository") return undefined;
  const top = repositoryTop(root)!;
  const names = [own, ...horizonFolders(root, scope).map((f) => relative(top, f).split(sep).join("/"))];
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The given root-relative paths that are evidence for a reference search:
 * the project's own files (keepProjectFiles), and a path that leaves the
 * root ("../../posthog/api/x.py") when it lies in a horizon folder and git
 * lists it at the repository top, outside any nested checkout there.
 */
export function keepHorizonFiles(root: string, paths: readonly string[], listing?: ProjectListing, folders: readonly string[] = horizonFolders(root)): Set<string> {
  const base = resolve(root);
  const kept = keepProjectFiles(base, paths, listing);
  if (folders.length === 0) return kept;
  const top = repositoryTop(base)!;
  const outside = new Map<string, string>();
  for (const path of paths) {
    const absolute = resolve(base, path);
    const rel = relative(base, absolute);
    if (!(rel.startsWith("..") || isAbsolute(rel))) continue;
    if (!folders.some((f) => { const r = relative(f, absolute); return r !== "" && !r.startsWith("..") && !isAbsolute(r); })) continue;
    outside.set(relative(top, absolute).split(sep).join("/"), path);
  }
  if (outside.size === 0) return kept;
  for (const rel of keepProjectFiles(top, [...outside.keys()])) kept.add(outside.get(rel)!);
  return kept;
}

/**
 * The nested checkouts under the root, project-relative, outermost only: the
 * folders a language server must be told to leave out of its workspace.
 * node_modules and `.git` are never entered.
 */
export function nestedCheckouts(root: string): string[] {
  const base = resolve(root);
  const found: string[] = [];
  const walk = (folder: string): void => {
    let entries;
    try {
      entries = readdirSync(join(base, folder), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
      const rel = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (existsSync(join(base, rel, ".git"))) found.push(rel);
      else walk(rel);
    }
  };
  walk("");
  return found.sort();
}
