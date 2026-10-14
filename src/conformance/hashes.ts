/**
 * The two hashes that decide what conform does, so no agent has to reason
 * about staleness:
 *
 *   captureHash  everything that changes what the code emits: the protocol, the
 *                vendored client and hooks, the capture-side config (build and
 *                test commands, their folder, the client's folder), and every
 *                project file the tests could run, by path and content. Models,
 *                specs, practices and Coherence's own records are left out, so
 *                editing a model never runs the tests again.
 *   replayHash   the captureHash, and everything that changes how stored
 *                traces replay: the model files and every .qnt file they
 *                import, the replay-side config (names, search bounds, scopes,
 *                acknowledged guards), the quint version, backend, seed and
 *                simulation and verify bounds the coverage probe runs within,
 *                and the replay engine's own version.
 *
 * A capture missing for the current captureHash runs the tests; one present
 * replays; a verdict already stored for the current replayHash is read back.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { walkBounds, walkedProjectFiles } from "../adapters/project-files.ts";
import { configIgnore } from "../adapters/project-files.ts";
import { TRACE_PROTOCOL } from "./collector.ts";
import type { ConformanceConfig, ModelConformance, QuintConfig } from "./config.ts";
import { VENDORED_FILES } from "./vendor.ts";

/** The replay engine's version: a change to how traces replay changes every replayHash. */
export const REPLAY_VERSION = 2;

/** Files no test runs: the models, the specs and practices beside them, Coherence's own records and caches, and the config, whose capture-side keys are hashed on their own. */
export function capturedFile(rel: string): boolean {
  if (rel.startsWith(".coherence/") || rel === "coherence.config.json") return false;
  return !/\.qnt$|\.spec\.md$|\.practice\.md$/.test(rel);
}

function sha(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return hash.digest("hex");
}

function fileSha(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "absent";
  }
}

/** The capture-side config, as hashed: what decides what the code emits. */
export function captureSide(config: ConformanceConfig): unknown {
  return { buildCommand: config.buildCommand ?? null, testCommand: config.testCommand ?? null, cwd: config.cwd, client: config.client };
}

/** The hash of what the code emits, over the project's files as they are now. */
export function captureHash(root: string, config: ConformanceConfig): string {
  const files = walkedProjectFiles(walkBounds(root, configIgnore(root))).files.filter(capturedFile).sort();
  const client = VENDORED_FILES.map((name) => fileSha(join(root, config.client, name)));
  return sha([`protocol ${TRACE_PROTOCOL}`, ...client, JSON.stringify(captureSide(config)), ...files.map((rel) => `${rel}\0${fileSha(join(root, rel))}`)]);
}

/** The model files and every .qnt file they import, followed through each import's relative path; a commented import is followed too, which only replays more often. */
function modelClosure(root: string, files: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = files.map((rel) => normalize(rel));
  while (pending.length > 0) {
    const rel = pending.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    let text = "";
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    for (const [, from] of text.matchAll(/\bfrom\s+"([^"]+)"/g)) pending.push(normalize(join(dirname(rel), from!.endsWith(".qnt") ? from! : `${from}.qnt`)));
  }
  return [...seen].sort();
}

/** The hash of how a capture replays through one model. */
export function replayHash(root: string, capture: string, model: { files: readonly string[] }, conformance: ModelConformance, quint: Pick<QuintConfig, "backend" | "maxSamples" | "maxSteps" | "seed" | "verify" | "verifySteps">, quintVersion: string): string {
  const replaySide = { scopes: conformance.scopes, names: conformance.names, search: conformance.search, acknowledged: conformance.acknowledged };
  const bounds = { maxSamples: quint.maxSamples, maxSteps: quint.maxSteps, seed: quint.seed ?? null, verify: quint.verify, verifySteps: quint.verifySteps };
  return sha([capture, `replay ${REPLAY_VERSION}`, `quint ${quintVersion} ${quint.backend}`, JSON.stringify(bounds), JSON.stringify(replaySide), ...modelClosure(root, model.files).map((rel) => `${rel}\0${fileSha(join(root, rel))}`)]);
}
