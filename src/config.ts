// config.ts — load coherence.config.json from a project root, over sane defaults.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./types.ts";

const DEFAULTS: Omit<Config, "root"> = {
  outputDir: "public",
  entryDir: ".",
  tooling: [],
  ignore: ["node_modules", ".git", "dist", ".turbo", ".wrangler"],
  codeExt: ["ts"],
  typecheck: ["npm", "run", "typecheck"],
  test: [],
  language: "typescript",
  platform: null,
  dictionary: "dictionary",
};

export async function loadConfig(root: string): Promise<Config> {
  const path = join(root, "coherence.config.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULTS, root };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Invalid coherence.config.json at ${path}`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`Invalid coherence.config.json at ${path}: expected a JSON object`);
  const file = parsed as Partial<Config>;
  return { ...DEFAULTS, ...file, root };
}
