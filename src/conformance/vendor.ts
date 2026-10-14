/**
 * The trace client vendored into a project: coherence scaffold client writes
 * the two files the package ships, byte for byte, into a folder of the
 * project, so the project's code imports a file of its own and no package.
 *
 *   scaffold client [--dir <folder>]            what it would write, and how to use it
 *   scaffold client [--dir <folder>] --write    write the files that are absent; never overwrite one
 *   scaffold client [--dir <folder>] --check    exit 1 when a vendored file is absent or differs from the shipped one
 *
 * The shipped bytes are the files beside this module in a checkout, and the
 * copies the build puts in dist/conformance/vendor in the package; both are
 * the same text, so a vendored client drifts only when its project edits it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The files a vendored client is made of: the client, and the node:test hooks beside it. */
export const VENDORED_FILES = ["coherence-trace.ts", "coherence-trace-hooks.ts"] as const;

/** The folder a vendored client goes to when none is named. */
export const DEFAULT_VENDOR_DIR = "test/coherence";

/** The shipped text of each vendored file: the build's copy in a package, else the source beside this module. */
export function shippedClient(): { name: string; text: string }[] {
  return VENDORED_FILES.map((name) => {
    const built = join(here, "vendor", name);
    return { name, text: readFileSync(existsSync(built) ? built : join(here, name), "utf8") };
  });
}

export interface VendorOutcome {
  lines: string[];
  /** Non-zero when --check found drift. */
  exit: number;
}

/** Print, write or check the vendored client in `dir`, relative to the project root. */
export function vendorClient(root: string, dir: string, mode: "print" | "write" | "check"): VendorOutcome {
  const folder = resolve(root, dir);
  const shown = (name: string): string => relative(root, join(folder, name)).split("\\").join("/");
  const lines: string[] = [];
  let exit = 0;
  for (const { name, text } of shippedClient()) {
    const path = join(folder, name);
    const present = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (mode === "check") {
      if (present === undefined) {
        lines.push(`missing ${shown(name)}: run scaffold client --dir ${dir} --write`);
        exit = 1;
      } else if (present !== text) {
        lines.push(`drift ${shown(name)}: it differs from the shipped client; the collector may refuse it, so write it again from the package`);
        exit = 1;
      } else lines.push(`same ${shown(name)}`);
      continue;
    }
    if (mode === "write") {
      if (present !== undefined) {
        lines.push(present === text ? `unchanged ${shown(name)}: already the shipped client` : `kept ${shown(name)}: it exists and differs from the shipped client; never overwritten (--check names the drift)`);
        continue;
      }
      mkdirSync(folder, { recursive: true });
      writeFileSync(path, text);
      lines.push(`wrote ${shown(name)}`);
      continue;
    }
    lines.push(`${present === undefined ? "would write" : present === text ? "already" : "differs"} ${shown(name)} (${text.length} bytes)`);
  }
  if (mode !== "check") {
    lines.push(
      `call it directly at each site: import { log } from "<relative path>/${VENDORED_FILES[0]}"; log("<action>", { <parameter>: <value> }, { scopes: ["<component>"] })`,
      `the node:test hooks load with NODE_OPTIONS=--import=./${shown(VENDORED_FILES[1])}; conform adds it for the test command it spawns`,
    );
    if (mode === "print") lines.push(`write them with: scaffold client --dir ${dir} --write`);
  }
  return { lines, exit };
}
