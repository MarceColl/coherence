/**
 * A model's conformance standing, as a quint prop reads it before it can pass
 * under conformance.required: the model's latest verdict, or stale when the
 * code or the model has moved since that verdict was taken, or absent when
 * conform never ran on it.
 */

import { loadSpecModel } from "../spec/model.ts";
import type { ConformanceStanding } from "../enforcement/quint-prop.ts";
import { readConformanceConfig, readQuintConfig, type ModelConformance } from "./config.ts";
import { captureHash, replayHash } from "./hashes.ts";
import { quintVersion } from "./quint.ts";
import { loadVerdicts } from "./store.ts";

/** The spec's model file for each configured model, or why a configured folder has none. */
export function modelFiles(root: string, models: readonly ModelConformance[]): { conformance: ModelConformance; file?: string; problem?: string }[] {
  const spec = loadSpecModel(root, { runs: false });
  return models.map((conformance) => {
    const component = spec.components.find((c) => c.folder === conformance.folder);
    if (component === undefined) return { conformance, problem: `conformance.models names ${conformance.folder}, which holds no spec` };
    if (component.model?.kind !== "file" || component.model.path === undefined) return { conformance, problem: `${component.specPath} names no model file on its model: line` };
    if (conformance.scopes.length === 0) return { conformance, problem: `conformance.models.${conformance.folder}.scopes names no scope; an event belongs to a model by its scope` };
    return { conformance, file: component.model.path };
  });
}

/**
 * A model's conformance standing as a quint prop reads it: the latest verdict
 * taken of the code and the model as they are now, stale when every verdict
 * was taken of another capture or replay (the code or the model moved since),
 * and absent when conform never ran on it. Hashing walks the project, so it is
 * done only when a verdict exists.
 */
export async function conformanceStanding(root: string, folder: string): Promise<ConformanceStanding> {
  const mine = loadVerdicts(root).filter((v) => v.model === folder);
  if (mine.length === 0) return "absent";
  const config = readConformanceConfig(root);
  const conformance = config.models.find((m) => m.folder === folder);
  const [found] = conformance === undefined ? [] : modelFiles(root, [conformance]);
  const version = await quintVersion();
  if (found?.file === undefined || !("version" in version)) return "stale";
  const capture = captureHash(root, config);
  const replay = replayHash(root, capture, { files: [found.file] }, found.conformance, readQuintConfig(root), version.version);
  // The latest verdict taken of the code and the model as they are now: a code restored after a break reads its earlier verdict again.
  const current = mine.filter((v) => v.captureHash === capture && v.replayHash === replay).pop();
  return current === undefined ? "stale" : current.verdict;
}
