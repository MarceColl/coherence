/**
 * Where an installed package is, asked of Node's package resolver and never
 * spelled as a path: the language servers both adapters start and the
 * tsserver the TypeScript one drives. Under pnpm, Coherence's own
 * dependencies sit beside its package in the store, not inside it, so a path
 * built as <Coherence>/node_modules/<package> names nothing; the resolver,
 * asked from a file of Coherence's own, finds them wherever the package
 * manager put them. A package's exports map can refuse a subpath (TypeScript
 * 7 exports no lib/tsserver.js), so a package's folder is found by its
 * manifest, through the folders the resolver's own lookup walks, and a file
 * inside it is read from there.
 *
 * This module is the one place an adapter learns where a package is
 * (Adapters.spec.md, "packages found by the resolver"), and where the Rust
 * and Go adapters learn where rust-analyzer and gopls are: binaries found on
 * the machine, not packages.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lifecycle/work-meter.ts";

/** A file of Coherence's own, which the resolver walks up from to find Coherence's dependencies. */
export const COHERENCE_FROM = fileURLToPath(import.meta.url);

export interface InstalledPackage {
  /** The package's folder. */
  dir: string;
  version: string;
  manifest: Record<string, unknown>;
}

/** The file the resolver starts from for a project: one at its root, which need not exist. */
export function projectFrom(root: string): string {
  return join(root, "package.json");
}

/**
 * A package as Node's resolver finds it from a file: its manifest resolved,
 * or, when the package's exports refuse that subpath, the first folder of the
 * resolver's lookup that holds it.
 */
export function installedPackage(name: string, from: string): InstalledPackage | undefined {
  const require = createRequire(from);
  const candidates: string[] = [];
  try {
    candidates.push(require.resolve(`${name}/package.json`));
  } catch {
    // not installed, or its exports refuse the manifest: the lookup folders below
  }
  for (const folder of require.resolve.paths(name) ?? []) candidates.push(join(folder, name, "package.json"));
  for (const manifestPath of candidates) {
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (manifest["name"] !== name) continue;
      return { dir: dirname(manifestPath), version: typeof manifest["version"] === "string" ? manifest["version"] : "unknown", manifest };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** A regular file inside a package, or undefined when the package does not hold it. */
export function packageFile(found: InstalledPackage, file: string): string | undefined {
  const path = join(found.dir, file);
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/** The script a package's manifest names for a bin, when the package holds it. */
function binScript(found: InstalledPackage, bin: string): string | undefined {
  const bins = found.manifest["bin"];
  const named = typeof bins === "string" ? (found.manifest["name"] === bin ? bins : undefined) : bins !== null && typeof bins === "object" ? (bins as Record<string, unknown>)[bin] : undefined;
  return typeof named === "string" ? packageFile(found, named) : undefined;
}

/** How to start a language server: a package's script run by this Node, or a binary on PATH, with every place looked. */
export type ServerLocation = { found: true; command: string; args: string[]; path: string; looked: string[] } | { found: false; looked: string[] };

/**
 * A language server's binary: the package resolved from the project, then
 * from Coherence's own module, then the bin on PATH, in that order; absent,
 * the places looked, each named.
 */
export function locateServer(pkg: string, bin: string, root: string, coherenceFrom: string = COHERENCE_FROM, path: string = process.env["PATH"] ?? ""): ServerLocation {
  const looked: string[] = [];
  for (const [whose, from] of [["the project", projectFrom(root)], ["Coherence", coherenceFrom]] as const) {
    const found = installedPackage(pkg, from);
    const script = found === undefined ? undefined : binScript(found, bin);
    looked.push(found === undefined ? `${pkg} resolved from ${whose} (${dirname(from)}): not installed` : `${pkg} ${found.version} resolved from ${whose} (${found.dir})${script === undefined ? `: no ${bin} bin` : ""}`);
    if (script !== undefined) return { found: true, command: process.execPath, args: [script], path: script, looked };
  }
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return { found: true, command: candidate, args: [], path: candidate, looked: [...looked, `${bin} on PATH (${candidate})`] };
  }
  looked.push(`${bin} on PATH: none`);
  return { found: false, looked };
}

/** The first line a failed program printed, for a looked string. */
function firstLine(run: { stderr?: string | null; stdout?: string | null; error?: Error | undefined; status: number | null }): string {
  if (run.error !== undefined) return run.error.message;
  return `${run.stderr ?? ""}${run.stdout ?? ""}`.trim().split("\n")[0] || `exit ${run.status}`;
}

/**
 * rust-analyzer's binary, which is no npm package and so is found on the
 * machine, the way tach is: COHERENCE_RUST_ANALYZER when it names a file;
 * else `rustup which rust-analyzer` run from the project root, so its
 * rust-toolchain.toml is honoured; else the first rust-analyzer on PATH that
 * answers `--version`, since rustup's proxy at ~/.cargo/bin exists without
 * the component and fails only when run. Absent, every place looked is named.
 */
export function locateRustAnalyzer(root: string, bin = "rust-analyzer", env: NodeJS.ProcessEnv = process.env): ServerLocation {
  const looked: string[] = [];
  const explicit = env["COHERENCE_RUST_ANALYZER"];
  if (explicit !== undefined && explicit !== "") {
    if (existsSync(explicit)) return { found: true, command: explicit, args: [], path: explicit, looked: [...looked, `COHERENCE_RUST_ANALYZER (${explicit})`] };
    looked.push(`COHERENCE_RUST_ANALYZER (${explicit}): no such file`);
  } else looked.push("COHERENCE_RUST_ANALYZER: unset");
  const dirs = (env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  const childEnv = { ...process.env, ...env };
  const rustup = dirs.map((dir) => join(dir, "rustup")).find((candidate) => existsSync(candidate));
  if (rustup === undefined) looked.push(`rustup which ${bin}: no rustup on PATH`);
  else {
    const which = spawnSync(rustup, ["which", bin], { cwd: root, encoding: "utf8", env: childEnv, timeout: 30_000 });
    const path = which.status === 0 ? which.stdout.trim() : "";
    if (path !== "" && existsSync(path)) return { found: true, command: path, args: [], path, looked: [...looked, `rustup which ${bin} (${path})`] };
    looked.push(`rustup which ${bin}: ${firstLine(which)}`);
  }
  let onPath = false;
  for (const dir of dirs) {
    const candidate = join(dir, bin);
    if (!existsSync(candidate)) continue;
    onPath = true;
    const probe = spawnSync(candidate, ["--version"], { cwd: root, encoding: "utf8", env: childEnv, timeout: 30_000 });
    if (probe.status === 0) return { found: true, command: candidate, args: [], path: candidate, looked: [...looked, `${bin} on PATH (${candidate})`] };
    const said = firstLine(probe);
    looked.push(`${bin} on PATH (${candidate}): ${/unknown binary/i.test(said) ? `a rustup proxy without the ${bin} component (${said})` : said}`);
  }
  if (!onPath) looked.push(`${bin} on PATH: none`);
  return { found: false, looked };
}

/**
 * gopls's binary, which is no npm package and so is found on the machine:
 * COHERENCE_GOPLS when it names a file; else where `go install` puts it,
 * `$(go env GOBIN)/gopls`, then each `$(go env GOPATH)` entry's `bin/gopls`;
 * else the first gopls on PATH that answers `version`. gopls loads packages by
 * running `go list`, so a gopls with no `go` on PATH is not a server that
 * works, and is a reason too. Absent, every place looked is named.
 */
export function locateGopls(root: string, bin = "gopls", env: NodeJS.ProcessEnv = process.env): ServerLocation {
  const looked: string[] = [];
  const dirs = (env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  const childEnv = { ...process.env, ...env };
  const go = dirs.map((dir) => join(dir, "go")).find((candidate) => existsSync(candidate));
  const found = (path: string, where: string): ServerLocation =>
    go === undefined
      ? { found: false, looked: [...looked, `${where}, but no go on PATH: gopls runs go list to load packages`] }
      : { found: true, command: path, args: ["serve"], path, looked: [...looked, where] };
  const explicit = env["COHERENCE_GOPLS"];
  if (explicit !== undefined && explicit !== "") {
    if (existsSync(explicit)) return found(explicit, `COHERENCE_GOPLS (${explicit})`);
    looked.push(`COHERENCE_GOPLS (${explicit}): no such file`);
  } else looked.push("COHERENCE_GOPLS: unset");
  if (go === undefined) looked.push(`go env GOBIN GOPATH: no go on PATH`);
  else {
    const goEnv = spawnSync(go, ["env", "GOBIN", "GOPATH"], { cwd: root, encoding: "utf8", env: childEnv, timeout: 30_000 });
    if (goEnv.status !== 0) looked.push(`go env GOBIN GOPATH: ${firstLine(goEnv)}`);
    else {
      const [gobin = "", gopath = ""] = goEnv.stdout.split("\n").map((line) => line.trim());
      const installed = [...(gobin === "" ? [] : [join(gobin, bin)]), ...gopath.split(delimiter).filter((p) => p !== "").map((p) => join(p, "bin", bin))];
      const hit = installed.find((candidate) => existsSync(candidate));
      if (hit !== undefined) return found(hit, `go install's ${bin} (${hit})`);
      looked.push(`go install's ${bin}: none at ${installed.join(", ") || "no GOBIN or GOPATH"}`);
    }
  }
  let onPath = false;
  for (const dir of dirs) {
    const candidate = join(dir, bin);
    if (!existsSync(candidate)) continue;
    onPath = true;
    const probe = spawnSync(candidate, ["version"], { cwd: root, encoding: "utf8", env: childEnv, timeout: 30_000 });
    if (probe.status === 0) return found(candidate, `${bin} on PATH (${candidate})`);
    looked.push(`${bin} on PATH (${candidate}): ${firstLine(probe)}`);
  }
  if (!onPath) looked.push(`${bin} on PATH: none`);
  return { found: false, looked };
}

/** The first number of a version. */
function major(version: string): number {
  return Number.parseInt(version, 10);
}

/** The tsserver the TypeScript language server drives, whose it is, and, when it is Coherence's, the project's TypeScript it stands in for. */
export interface TsserverChoice {
  path: string;
  version: string;
  whose: "project" | "coherence";
  /** The project's own TypeScript when it is installed but ships no tsserver (TypeScript 7 and later). */
  passedOver: string | undefined;
}

/**
 * The tsserver to drive: the project's own typescript/lib/tsserver.js when
 * that file exists and is a tsserver (TypeScript below 7: from 7 the language
 * service is native and ships none), otherwise Coherence's own, resolved from
 * its module; undefined when neither holds one.
 */
export function locateTsserver(root: string, coherenceFrom: string = COHERENCE_FROM): TsserverChoice | undefined {
  const project = installedPackage("typescript", projectFrom(root));
  const own = project === undefined ? undefined : packageFile(project, "lib/tsserver.js");
  if (project !== undefined && own !== undefined && major(project.version) < 7) return { path: own, version: project.version, whose: "project", passedOver: undefined };
  const passedOver = project === undefined ? undefined : project.version;
  const coherence = installedPackage("typescript", coherenceFrom);
  const theirs = coherence === undefined ? undefined : packageFile(coherence, "lib/tsserver.js");
  if (coherence !== undefined && theirs !== undefined && major(coherence.version) < 7) return { path: theirs, version: coherence.version, whose: "coherence", passedOver };
  return undefined;
}

/**
 * The line an agent reads when the project's TypeScript ships no tsserver and
 * Coherence reads with its own; empty otherwise.
 */
export function tsserverNotice(root: string, coherenceFrom: string = COHERENCE_FROM): string {
  const project = installedPackage("typescript", projectFrom(root));
  if (project === undefined || major(project.version) < 7) return "";
  const choice = locateTsserver(root, coherenceFrom);
  if (choice === undefined) return `TypeScript: this project's TypeScript ${project.version} ships no tsserver and Coherence has no TypeScript of its own installed, so no TypeScript reading can be made; install Coherence with its optional dependencies (its typescript is one).`;
  return `TypeScript: this project's TypeScript ${project.version} ships no tsserver, so Coherence is using its own TypeScript ${choice.version} for readings (references, symbols and the compiler's refusals).`;
}
