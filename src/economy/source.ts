/**
 * What economy and mass read from the tree without an instrument: which
 * files are source, which top-level names a file declares, which names it
 * imports and from where, and which component a file lies in. A plain scan,
 * never a parse; the adapter confirms what matters through resolve and
 * references, and mass says when a number came from the scan alone.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { isTestPath } from "../adapters/adapter.ts";
import { walkBounds, walkedProjectFiles } from "../adapters/project-files.ts";
import type { Language } from "../adapters/index.ts";
import { languageOfFile } from "../adapters/language-files.ts";
import type { Component, SpecModel } from "../spec/model.ts";
import { PYTHON_SOURCE } from "./python-source.ts";
import { RUST_SOURCE } from "./rust-source.ts";
import { TYPESCRIPT_SOURCE } from "./typescript-source.ts";

/**
 * What the scan leaves out of a language's files (languageOfFile): TypeScript's
 * JavaScript, so its source is the files the TypeScript adapter reads as source
 * (SOURCE_EXTENSIONS in adapters/typescript.ts); Python's stubs, which restate
 * the names their module declares and would count each one twice.
 */
const NOT_SOURCE: Record<Language, RegExp> = {
  typescript: /\.[cm]?jsx?$/,
  python: /\.pyi$/,
  rust: /(?!)/,
};

/** Whether a file is source the plain scan reads for the language. */
export function isSourceFile(file: string, language: Language): boolean {
  return languageOfFile(file, [language]) === language && !NOT_SOURCE[language].test(file);
}

/**
 * Every source file of the project for the language, project-relative with
 * forward slashes, sorted: the files the walk reads (walkedProjectFiles),
 * which leaves a folder out only by a named rule.
 */
export function sourceFiles(root: string, language: Language, ignore: readonly string[] = []): string[] {
  return walkedProjectFiles(walkBounds(root, ignore)).files.filter((rel) => isSourceFile(rel, language));
}

/** A path as project-relative with forward slashes, or undefined when it lies outside the root. */
export function toRelative(root: string, path: string): string | undefined {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(resolve(root), absolute).split(sep).join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../")) return undefined;
  return rel;
}

/**
 * What the plain scan reads of one language's source, each language's in its
 * own module (typescript-source.ts, python-source.ts, rust-source.ts): a language
 * SOURCE_SYNTAX lacks fails to compile, never reads as another language.
 */
export interface SourceSyntax {
  /** The name a line declares at the top level and whether its file exports it, or undefined when it declares none. */
  declarationOf(line: string): { name: string; exported: boolean } | undefined;
  /** resolveModule for the language. */
  resolveModule(root: string, from: string, specifier: string, vanished: ReadonlySet<string>): string | undefined;
  /** Hands `add` each name the text imports with the specifier it comes from: undefined for a whole-module import. */
  importsOf(text: string, add: (name: string | undefined, specifier: string) => void): void;
}

/**
 * Each language's source scan: one key per language, so a new one is one
 * module and one key here. Read at call time: typescript-source.ts imports
 * toRelative and isSourceFile from here, so a table filled at load would read
 * a module that has not run yet whenever that one is loaded first.
 */
const SOURCE_SYNTAX: Record<Language, () => SourceSyntax> = {
  typescript: () => TYPESCRIPT_SOURCE,
  python: () => PYTHON_SOURCE,
  rust: () => RUST_SOURCE,
};

export interface Declaration {
  name: string;
  /** One-based. */
  line: number;
  exported: boolean;
}

/** The top-level names a file declares, by a plain scan of line starts. */
export function declarationsOf(text: string, language: Language): Declaration[] {
  const found: Declaration[] = [];
  const seen = new Set<string>();
  const syntax = SOURCE_SYNTAX[language]();
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    const declared = syntax.declarationOf(line);
    if (declared === undefined || seen.has(declared.name)) return;
    seen.add(declared.name);
    found.push({ name: declared.name, line: index + 1, exported: declared.exported });
  });
  return found;
}

export interface Import {
  /** The imported name, or undefined for a whole-module import (namespace or side effect). */
  name: string | undefined;
  /** The module file, project-relative, when it resolves to a file under the root. */
  module: string;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Resolve a module specifier from a file to a project-relative source file,
 * or undefined for a package or a file not under the root. A path in
 * `vanished` (a file the working change deleted or renamed away) resolves as
 * though it were still on disk, so its importers can be found.
 */
export function resolveModule(root: string, from: string, specifier: string, language: Language, vanished: ReadonlySet<string> = NONE): string | undefined {
  return SOURCE_SYNTAX[language]().resolveModule(root, from, specifier, vanished);
}

/** The names a file imports from files under the root, with the module each comes from; `vanished` as for resolveModule. */
export function importsOf(root: string, file: string, text: string, language: Language, vanished: ReadonlySet<string> = NONE): Import[] {
  const found: Import[] = [];
  const add = (name: string | undefined, specifier: string): void => {
    const module = resolveModule(root, file, specifier, language, vanished);
    if (module === undefined || module === file) return;
    found.push({ name, module });
  };
  SOURCE_SYNTAX[language]().importsOf(text, add);
  const seen = new Set<string>();
  return found.filter((i) => {
    const key = `${i.name ?? "*"} ${i.module}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The component whose folder is the nearest ancestor of the file, or undefined when no spec lies above it. */
export function componentOf(model: SpecModel, file: string): Component | undefined {
  let best: Component | undefined;
  for (const component of model.components) {
    const inside = component.folder === "." || file === component.folder || file.startsWith(component.folder + "/");
    if (!inside) continue;
    if (best === undefined || component.folder.length > best.folder.length) best = component;
  }
  return best;
}

/** Whether a project-relative file is a test by folder or by name. */
export function isTest(file: string, testFolders: readonly string[]): boolean {
  return isTestPath(file, testFolders);
}
