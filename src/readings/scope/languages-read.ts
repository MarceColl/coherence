/**
 * Which of a project's languages a reading read: the one field every
 * reading carries in its result, and the one line every renderer prints.
 *
 * A project may declare several languages (the config's `language` list, the
 * first being the primary). A reading that covers fewer than the project
 * declares must say so, by name, in its output and in its JSON: a checking
 * tool that skips a language quietly reports a clean result it never read.
 * So the reading states what it read, and a language it did not read carries
 * the reason, and the renderers print the line whenever the project declares
 * more than one language. For one language the line is absent, so a
 * single-language reading prints exactly what it always did.
 *
 * primaryOnly is the one way a reading takes the primary language alone: it
 * hands back the language together with the statement that the others were
 * not read, so the statement cannot be left behind. A test (languages-read.test.ts)
 * refuses any reading that takes the config's primary language another way.
 */

import type { Language } from "../../adapters/index.ts";

/** One language a reading did not read, and why. */
export interface LanguageNotRead {
  language: Language;
  because: string;
}

/** What a reading read of the project's declared languages. */
export interface LanguagesRead {
  /** Every language the project declares, the primary first. */
  declared: Language[];
  /** The declared languages the reading read, in declared order. */
  read: Language[];
  /** The declared languages it did not read, each with its reason. */
  unread: LanguageNotRead[];
}

/** The project's languages as a reading sees them: the config's list, the primary first. */
export interface DeclaredLanguages {
  readonly language: Language;
  readonly languages: readonly Language[];
}

/**
 * What a reading read: every declared language not named in `unread`.
 * `unread` maps a language to the reason it was not read.
 */
export function languagesRead(declared: readonly Language[], unread: ReadonlyMap<Language, string> = new Map()): LanguagesRead {
  return {
    declared: [...declared],
    read: declared.filter((l) => !unread.has(l)),
    unread: declared.flatMap((language) => (unread.has(language) ? [{ language, because: unread.get(language)! }] : [])),
  };
}

/** Every declared language read. */
export function allLanguagesRead(config: DeclaredLanguages): LanguagesRead {
  return languagesRead(config.languages);
}

/** The reason a reading gives for Rust, whose text no scan of the economy and scope readings reads yet. */
export const RUST_NOT_READ = "Rust is not read by this reading yet";

/** Each language's text scan, decided once per language: undefined when it is read, else why not; a language with no key fails to compile. */
const NOT_SCANNED: Record<Language, string | undefined> = {
  typescript: undefined,
  python: undefined,
  rust: RUST_NOT_READ,
};

/**
 * Why a reading that scans a language's text (declarations, imports, entrance
 * rules) does not read the language, or undefined when it reads it: Rust has
 * an adapter but no text scan yet, so a reading names it rather than parse
 * Rust as another language.
 */
export function notScannedYet(language: Language): string | undefined {
  return NOT_SCANNED[language];
}

/** Every declared language a text scan reads, and each one it does not read yet named with why (notScannedYet). */
export function scannedLanguagesRead(config: DeclaredLanguages): LanguagesRead {
  return languagesRead(config.languages, new Map(config.languages.flatMap((l) => {
    const because = notScannedYet(l);
    return because === undefined ? [] : [[l, because] as const];
  })));
}

/**
 * The primary language, for a reading that reads it alone, with the
 * statement that every other declared language was not read, and why.
 */
export function primaryOnly(config: DeclaredLanguages, because: string): { language: Language; languages: LanguagesRead } {
  const primary = config.languages[0] ?? config.language;
  return { language: primary, languages: languagesRead(config.languages, new Map(config.languages.filter((l) => l !== primary).map((l) => [l, because]))) };
}

/**
 * The line a renderer prints: undefined for a project of one language read
 * whole (its output is unchanged); otherwise the languages read and, for
 * each one not read, its name and why. An absent field (a record written
 * before readings said so) is undefined too.
 */
export function languagesReadLine(languages: LanguagesRead | undefined): string | undefined {
  if (languages === undefined) return undefined;
  if (languages.declared.length <= 1 && languages.unread.length === 0) return undefined;
  const read = languages.read.length === 0 ? "none" : languages.read.join(" and ");
  if (languages.unread.length === 0) return `languages read: ${read}, each through its own files`;
  return `languages read: ${read}; NOT READ: ${languages.unread.map((u) => `${u.language} (${u.because})`).join("; ")}`;
}
