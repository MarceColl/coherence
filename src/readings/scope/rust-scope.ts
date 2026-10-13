/**
 * Rust's facts for the component interface reading: none of its text is
 * scanned yet, so readLanguage answers unread for Rust before any of these
 * is asked (component-interfaces.ts reads them through INTERFACE_SYNTAX,
 * kept-answers.ts through KEPT_MODULES).
 */

import type { InterfaceSyntax } from "./component-interfaces.ts";

/** Rust is not read by this reading yet: no type-only declaration, default export, import list or glob use is read; rust-analyzer reads its Cargo workspace, so it takes no bounds. */
export const RUST_INTERFACES: InterfaceSyntax = {
  isTypeDeclaration: () => false,
  isDefaultExport: () => false,
  serverBounds: false,
  importLists: () => [],
  defaultNames: () => [],
  wildcardModules: () => [],
};

/** Rust is not read by this reading yet: no glob use is scanned, so a changed file names no module a kept answer depends on. */
export const rustKeptModules: (file: string, text: string) => string[] = () => [];
