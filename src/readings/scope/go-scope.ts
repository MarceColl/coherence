/**
 * Go's facts for the component interface reading: none of its text is
 * scanned yet, so readLanguage answers unread for Go before any of these is
 * asked (component-interfaces.ts reads them through INTERFACE_SYNTAX,
 * kept-answers.ts through KEPT_MODULES).
 */

import type { InterfaceSyntax } from "./component-interfaces.ts";

/** Go is not read by this reading yet: no type-only declaration, default export, import list or dot import is read; gopls reads its Go module, so it takes no bounds. */
export const GO_INTERFACES: InterfaceSyntax = {
  isTypeDeclaration: () => false,
  isDefaultExport: () => false,
  serverBounds: false,
  importLists: () => [],
  defaultNames: () => [],
  wildcardModules: () => [],
};

/** Go is not read by this reading yet: no dot import is scanned, so a changed file names no module a kept answer depends on. */
export const goKeptModules: (file: string, text: string) => string[] = () => [];
