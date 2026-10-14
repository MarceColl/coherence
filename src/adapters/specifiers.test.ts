/**
 * The pure rules the review of the JavaScript admission asked for: which
 * files a relative specifier may name, which of them a resolver with the file
 * list picks, and which files count as the project's sources when the walk
 * holds compiled JavaScript beside TypeScript.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSources, resolveSpecifier, seedFile, specifierCandidates } from "./typescript.ts";

test("a NodeNext specifier written with .js names the TypeScript source first, and the JavaScript file only where that is what exists", () => {
  const candidates = specifierCandidates("src/index.ts", "./foo.js");
  assert.deepEqual(candidates.slice(0, 2), ["src/foo.js", "src/foo.ts"], "the specifier as written, then its TypeScript rewrite");
  const typescriptProject = new Set(["src/index.ts", "src/foo.ts"]);
  assert.equal(resolveSpecifier("src/index.ts", "./foo.js", (c) => typescriptProject.has(c)), "src/foo.ts", "export * from './foo.js' in a NodeNext project reaches foo.ts");
  const javascriptProject = new Set(["src/index.js", "src/foo.js"]);
  assert.equal(resolveSpecifier("src/index.js", "./foo.js", (c) => javascriptProject.has(c)), "src/foo.js");
  assert.equal(resolveSpecifier("src/index.ts", "./foo.js"), "src/foo.js", "without a file list the specifier as written wins, so readers that cannot test existence key by every candidate instead");
});

test("an extensionless specifier has JavaScript and folder-index candidates, in TypeScript-first order", () => {
  const candidates = specifierCandidates("src/app.js", "./components");
  assert.ok(candidates.includes("src/components.js"), candidates.join(","));
  assert.ok(candidates.includes("src/components/index.js"), candidates.join(","));
  assert.ok(candidates.indexOf("src/components.ts") < candidates.indexOf("src/components.js"));
  const bundlerProject = new Set(["src/app.js", "src/components/index.js"]);
  assert.equal(resolveSpecifier("src/app.js", "./components", (c) => bundlerProject.has(c)), "src/components/index.js");
  assert.deepEqual(specifierCandidates("src/app.ts", "react"), [], "a package is never a project file");
  assert.deepEqual(specifierCandidates("src/app.ts", "../../outside.ts"), [], "a specifier that leaves the project names nothing");
  assert.deepEqual(resolveSpecifier("src/index.ts", "./missing.js", () => false), undefined, "no existing candidate resolves to nothing, never to a guess");
});

test("compiled JavaScript a repository tracks beside its TypeScript is not a source: the seed and the text search stay on the TypeScript", () => {
  const tracked = ["dist/bar.js", "dist/foo.js", "src/bar.ts", "src/foo.ts"];
  assert.deepEqual(projectSources(tracked), ["src/bar.ts", "src/foo.ts"]);
  assert.equal(seedFile(tracked), "src/bar.ts", "the seed is a TypeScript file, never the compiled copy that sorts first");
  assert.deepEqual(projectSources(["src/a.mjs", "src/b.js", "README.md"]), ["src/a.mjs", "src/b.js"], "a project with no TypeScript is written in JavaScript");
  assert.equal(seedFile(["lib/types.d.ts", "src/a.mjs"]), "src/a.mjs", "a declaration file is neither language's source");
});
