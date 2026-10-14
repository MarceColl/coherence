/**
 * Which language a file is written in, by its extension: the one rule every
 * reader asks (enforcement, the economy's source scan, entrance detection,
 * the lexicon's member scan). A reader that reads fewer of a language's files
 * narrows this rule and says why; none answers the question on its own. It
 * imports only types, so any module can read it without a cycle.
 */

import type { Language } from "./index.ts";

/**
 * The file names each language is written in, by extension; no two languages
 * share one. A Python stub (.pyi) is Python's; a TypeScript declaration file
 * (.d.ts) is no language's, so no instrument, scan or rule reads one as code.
 */
const LANGUAGE_FILES: Record<Language, RegExp> = {
  typescript: /^(?!.*\.d\.ts$).*\.(?:[cm]?[tj]sx?)$/,
  python: /\.pyi?$/,
  rust: /\.rs$/,
  go: /\.go$/,
};

/** The language a file is written in, by its extension, among the languages given (every language when none are); undefined for any other file. */
export function languageOfFile(file: string, languages?: readonly Language[]): Language | undefined {
  const base = file.trim();
  const found = (Object.keys(LANGUAGE_FILES) as Language[]).find((language) => LANGUAGE_FILES[language].test(base));
  return found !== undefined && (languages === undefined || languages.includes(found)) ? found : undefined;
}
