/**
 * Which adapter a project gets: the config's `language`, else TypeScript.
 */

import { PythonAdapter } from "./python.ts";
import { RustAdapter } from "./rust.ts";
import { TypeScriptAdapter } from "./typescript.ts";
import type { AdapterBounds, LanguageAdapter } from "./adapter.ts";

export const LANGUAGES = ["typescript", "python", "rust"] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/**
 * The adapter for the language, over the whole workspace; with bounds, one
 * whose server leaves the bounded-away folders out, for the component
 * interface reading alone (Python narrows its workspace; TypeScript's server
 * reads the project its tsconfig names and rust-analyzer its Cargo workspace,
 * and neither takes bounds).
 */
export function adapterFor(language: Language, root: string, bounds?: AdapterBounds): LanguageAdapter {
  switch (language) {
    case "typescript":
      return new TypeScriptAdapter(root);
    case "python":
      return new PythonAdapter(root, undefined, bounds);
    case "rust":
      return new RustAdapter(root);
  }
}
