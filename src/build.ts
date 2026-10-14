/**
 * The published package's build: `npm run build`. Node will not strip types
 * from a file under node_modules, so the package ships JavaScript compiled
 * from src into dist, at the same depth, so every path a module takes from
 * its own location (the lexicon and checklist seed in docs, the package.json)
 * resolves the same compiled as in a checkout. Beside the JavaScript go the
 * files modules read at run time: the data files, the stylesheet, the Scope
 * browser sources stripped by the same stripper a checkout runs when it
 * builds a page, and the one font file the page embeds with its license.
 * npm runs this as prepare, so an install from the git repository builds too.
 */

import { spawnSync } from "./lifecycle/work-meter.ts";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserSources, strippedName } from "./readings/scope/build.ts";
import { VENDORED_FILES } from "./conformance/vendor.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");
const scope = join("readings", "scope");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__pycache__" ? [] : files(path);
    return [path];
  });
}

function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

rmSync(dist, { recursive: true, force: true });
// The compiler as the package resolver finds it from this checkout, never a path into node_modules built by hand (installed.ts).
const tsc = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

for (const file of files(src)) {
  const at = relative(src, file);
  if (/\.(json|css)$/.test(file) || dirname(at) === join(scope, "fonts")) copy(file, join(dist, at));
}
// The same modules the page joins, found the same way: from the entry, by what each imports at run time.
for (const name of await browserSources()) {
  const source = readFileSync(join(src, scope, name), "utf8");
  writeFileSync(join(dist, scope, strippedName(name)), stripTypeScriptTypes(source, { mode: "strip" }));
}
// The conformance trace client, as text: scaffold client vendors these bytes into a project, so the package ships them unchanged.
for (const name of VENDORED_FILES) copy(join(src, "conformance", name), join(dist, "conformance", "vendor", name));
