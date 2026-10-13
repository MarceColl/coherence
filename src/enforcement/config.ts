/**
 * What enforcement reads from `coherence.config.json`:
 *
 *   language   typescript (default) or python, or a list of both for a
 *              project that spans them: each file's language is chosen by
 *              its extension, and the first listed is the primary (the one a
 *              single-language reading, such as Structure, reads)
 *   test       the test command: an argv array the filter is appended to,
 *              or a string template with {filter}; absent means not configured
 *   testMatch  a regular expression the test output must match to pass
 *              (a runner that exits 0 when no test matched the filter
 *              needs it); absent means the exit code decides
 *   testJson   one invocation for every test the bullets name at once: an argv array or
 *              string template with {filter} (a combined name pattern) and
 *              {out} (where the runner writes a jest-shaped JSON report:
 *              testResults[].assertionResults[] with ancestorTitles, title,
 *              status). Results map back to invariants by test name; when
 *              absent the pass runs one test per invocation through `test`
 *   testFilterForm  how a name filter is written for the runner: "regex"
 *              (default: a title is escaped and several are joined with |,
 *              as jest, vitest, and node:test read --test-name-pattern) or
 *              "pytest" (a `-k` expression: names as written, joined with
 *              or). The report {out} names may be jest-shaped JSON, pytest's
 *              JUnit XML (--junitxml), or pytest-json-report's JSON; the
 *              pass tells them apart by their content
 *   testDir    a folder name (or testDirs, a list) whose files are tests,
 *              beside the built-in __tests__, test, tests
 *   latencyBudget  the latency budget: the most seconds a tool hook
 *              (PreToolUse, PostToolUse) may take; absent means 3
 *   tests      a list of test setups, one per runner, in place of the single
 *              test keys: each holds test, testJson, testMatch,
 *              testFilterForm, testDir/testDirs, and optionally language (the
 *              extension of the test files it claims), files (globs of the
 *              test files it claims, relative to the root), and cwd (the
 *              folder it runs from, relative to the root). The test a
 *              totality oracle names runs through the setup whose test files spell it
 *   chokepointFrom  which references a chokepoint governs when its bullet
 *              has no from: line: "anywhere" (default), "outside the
 *              component", or "outside <folder>"
 */

import { isAbsolute } from "node:path";
import { isLanguage, LANGUAGES, type Language } from "../adapters/index.ts";
import { languageOfFile } from "../adapters/language-files.ts";
import { effectiveConfig, type SetupKey } from "../adapters/project-config.ts";
import { FROM_FORM, parseFrom, type ChokepointFrom } from "../spec/grammar.ts";

export { languageOfFile } from "../adapters/language-files.ts";

export const CONFIG_FILE = "coherence.config.json";
export const DEFAULT_TEST_FOLDERS: readonly string[] = ["__tests__", "test", "tests"];

/** One runner's test setup: how the tests it claims run, and which test files those are. */
export interface TestSetup {
  /** The language whose test files this setup claims, when it names one. */
  language: Language | undefined;
  /** Globs (project-relative, `*` within a folder, `**` across folders) of the test files this setup claims, when it names them. */
  files: string[] | undefined;
  /** The folder the runner is started in, relative to the root; undefined runs it at the root. */
  cwd: string | undefined;
  test: string[] | string | undefined;
  testMatch: RegExp | undefined;
  testJson: string[] | string | undefined;
  testFilterForm: "regex" | "pytest";
  testFolders: string[];
}

export interface EnforcementConfig {
  /** The primary language: the first of `languages`. */
  language: Language;
  /** Every language the project spans, the primary first; one for a single-language project. */
  languages: Language[];
  /** Every test setup, the first being the one the single keys below describe. */
  tests: TestSetup[];
  /** Undefined when no test command is configured. */
  test: string[] | string | undefined;
  testMatch: RegExp | undefined;
  /** One invocation reporting every test the bullets name, or undefined to run them one at a time. */
  testJson: string[] | string | undefined;
  /** How a name filter is written for the runner: an escaped regex (jest, vitest, node:test) or a pytest -k expression. */
  testFilterForm: "regex" | "pytest";
  testFolders: string[];
  /** The latency budget: the most seconds a tool hook may take, or undefined for the default (src/lifecycle/hook-latency.ts). */
  latencyBudget: number | undefined;
  /** Which references a chokepoint governs when its bullet says nothing (a from: line); undefined is anywhere. */
  chokepointFrom: ChokepointFrom | undefined;
}

function commandValue(value: unknown): string[] | string | undefined {
  if (Array.isArray(value) && value.every((v): v is string => typeof v === "string") && value.length > 0) return value;
  if (typeof value === "string" && value.trim() !== "") return value;
  return undefined;
}

/** A file glob as a regular expression: `**` crosses folders, `*` and `?` stay within one. */
export function globPattern(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Whether a setup claims a project-relative file as one of its test files: its globs match it, else its language is the file's. */
export function setupClaims(setup: TestSetup, file: string): boolean {
  if (setup.files !== undefined) return setup.files.some((glob) => globPattern(glob).test(file));
  return setup.language === undefined || languageOfFile(file) === setup.language;
}

function testSetupOf(raw: Record<string, unknown>, path: string, where: string): TestSetup {
  // Only the declared setup keys are read, so a key read here is one the registry inherits as a group.
  const record = raw as { readonly [K in SetupKey]?: unknown };
  const setup: TestSetup = { language: undefined, files: undefined, cwd: undefined, test: commandValue(record["test"]), testMatch: undefined, testJson: commandValue(record["testJson"]), testFilterForm: record["testFilterForm"] === "pytest" ? "pytest" : "regex", testFolders: [...DEFAULT_TEST_FOLDERS] };
  const testMatch = record["testMatch"];
  if (typeof testMatch === "string" && testMatch !== "") {
    try {
      setup.testMatch = new RegExp(testMatch);
    } catch (error) {
      throw new Error(`${path}: ${where}testMatch is not a regular expression (${(error as Error).message})`);
    }
  }
  const folders = new Set(setup.testFolders);
  if (typeof record["testDir"] === "string") folders.add(record["testDir"]);
  if (Array.isArray(record["testDirs"])) for (const dir of record["testDirs"]) if (typeof dir === "string") folders.add(dir);
  setup.testFolders = [...folders];
  return setup;
}

export function readEnforcementConfig(root: string): EnforcementConfig {
  const config: EnforcementConfig = { language: "typescript", languages: ["typescript"], tests: [], test: undefined, testMatch: undefined, testJson: undefined, testFilterForm: "regex", testFolders: [...DEFAULT_TEST_FOLDERS], latencyBudget: undefined, chokepointFrom: undefined };
  config.tests = [{ language: undefined, files: undefined, cwd: undefined, test: undefined, testMatch: undefined, testJson: undefined, testFilterForm: "regex", testFolders: [...DEFAULT_TEST_FOLDERS] }];
  // The project's own config over its registry's keys (project-config.ts), each inherited path rebased to the project.
  const found = effectiveConfig(root);
  if (found === undefined) return config;
  const { record, path } = found;
  const language = record["language"];
  if (typeof language === "string" && isLanguage(language)) config.languages = [language];
  else if (Array.isArray(language)) {
    const named = language.filter((l): l is Language => typeof l === "string" && isLanguage(l));
    const unknown = language.filter((l) => typeof l !== "string" || !isLanguage(l));
    if (unknown.length > 0) throw new Error(`${path}: language lists ${unknown.map((l) => JSON.stringify(l)).join(", ")}; each is one of ${LANGUAGES.join(", ")}`);
    if (named.length > 0) config.languages = [...new Set(named)];
  }
  config.language = config.languages[0]!;
  const budget = record["latencyBudget"];
  if (budget !== undefined) {
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) throw new Error(`${path}: latencyBudget is a number of seconds above 0`);
    config.latencyBudget = budget;
  }
  const from = record["chokepointFrom"];
  if (from !== undefined) {
    const parsed = typeof from === "string" ? parseFrom(from) : undefined;
    if (parsed === undefined) throw new Error(`${path}: chokepointFrom reads ${FROM_FORM}`);
    config.chokepointFrom = parsed;
  }
  const tests = record["tests"];
  if (tests !== undefined) {
    if (!Array.isArray(tests) || tests.length === 0 || !tests.every((t) => typeof t === "object" && t !== null && !Array.isArray(t))) throw new Error(`${path}: tests is a list of test setups, each an object with test or testJson`);
    config.tests = (tests as Record<string, unknown>[]).map((t, i) => {
      const where = `tests[${i}].`;
      const setup = testSetupOf(t, path, where);
      if (setup.test === undefined && setup.testJson === undefined) throw new Error(`${path}: ${where.slice(0, -1)} names neither test nor testJson`);
      const lang = t["language"];
      if (lang !== undefined) {
        if (typeof lang !== "string" || !isLanguage(lang)) throw new Error(`${path}: ${where}language is one of ${LANGUAGES.join(", ")}`);
        setup.language = lang;
      }
      const files = t["files"];
      if (files !== undefined) {
        const list = typeof files === "string" ? [files] : files;
        if (!Array.isArray(list) || list.length === 0 || !list.every((f): f is string => typeof f === "string" && f !== "")) throw new Error(`${path}: ${where}files is a glob or a list of globs`);
        setup.files = list;
      }
      const cwd = t["cwd"];
      if (cwd !== undefined) {
        if (typeof cwd !== "string" || cwd === "" || isAbsolute(cwd)) throw new Error(`${path}: ${where}cwd is a folder relative to the project root`);
        setup.cwd = cwd;
      }
      return setup;
    });
  } else {
    config.tests = [testSetupOf(record, path, "")];
  }
  // The single keys read as the first setup, so every reader of one setup keeps working.
  const first = config.tests[0]!;
  config.test = first.test;
  config.testJson = first.testJson;
  config.testMatch = first.testMatch;
  config.testFilterForm = first.testFilterForm;
  config.testFolders = [...new Set(config.tests.flatMap((t) => t.testFolders))];
  return config;
}
