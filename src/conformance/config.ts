/**
 * The config conformance replay and quint props read: the `quint` block (how
 * quint is run) and the `conformance` block (how the code's tests are run
 * under the collector, and how each model's traces are replayed).
 *
 *   "quint": { "backend": "rust", "maxSamples": 2000, "maxSteps": 20, "seed": "0x1", "verify": "apalache", "verifySteps": 3, "timeoutSeconds": 600 }
 *   "conformance": {
 *     "buildCommand": "npm run build",
 *     "testCommand": ["node", "--test", "src/journal/journal.test.ts"],
 *     "cwd": ".",
 *     "client": "test/coherence",
 *     "timeoutSeconds": 1800,
 *     "required": false,
 *     "models": {
 *       "src/journal": {
 *         "scopes": ["journal.work"],
 *         "names": { "work.create": ["create"] },
 *         "search": { "perPick": 10, "perStep": 50, "perRun": 5000 },
 *         "acknowledged": [{ "guard": "move#2", "because": "…" }]
 *       }
 *     }
 *   }
 *
 * The keys split by which side they touch: buildCommand, testCommand, cwd and
 * client decide what the code emits (capture-side), and scopes, names, search
 * and acknowledged decide only how the stored traces are read and replayed
 * (replay-side: a capture keeps every scope's events, and a model filters its
 * own). The split is what the capture and replay hashes are taken over, so a
 * replay-side change replays the stored traces and never runs the tests again.
 */

import { configRecord } from "../adapters/project-config.ts";
import { DEFAULT_VENDOR_DIR } from "./vendor.ts";

/** How quint runs: the evaluator backend, the simulation bounds, and which model checker proves a property, or off to accept simulation alone. */
export interface QuintConfig {
  backend: "rust" | "typescript";
  maxSamples: number;
  maxSteps: number;
  /** A fixed seed, so a simulation is repeatable; absent, quint picks one and prints it. */
  seed: string | undefined;
  verify: "apalache" | "tlc" | "off";
  /** The bound the model checker proves within: far fewer steps than a simulation samples, since each step widens the symbolic search. */
  verifySteps: number;
  timeoutSeconds: number;
}

export const DEFAULT_QUINT: QuintConfig = { backend: "rust", maxSamples: 2000, maxSteps: 20, seed: undefined, verify: "apalache", verifySteps: 3, timeoutSeconds: 600 };

/** The search bounds for a parameter no logged argument pins: alternatives per missing pick, per step, and per trace. Exceeding one fails the trace. */
export interface SearchBounds {
  perPick: number;
  perStep: number;
  perRun: number;
}

export const DEFAULT_SEARCH: SearchBounds = { perPick: 10, perStep: 50, perRun: 5000 };

/** A guard scenario declared untestable on purpose: no input the domain allows can make it false, and why that is acceptable. */
export interface Acknowledged {
  /** The action and the guard conjunct's index, as the report names it: move#2. */
  guard: string;
  because: string;
}

/** One model's conformance settings, keyed by the folder of the component whose spec names the model. */
export interface ModelConformance {
  folder: string;
  /** Capture-side: the scopes an event must carry to belong to this model; others are excluded and reported. */
  scopes: string[];
  /** Replay-side: a logged action name to the model actions it may be; absent, the name itself. */
  names: Record<string, string[]>;
  search: SearchBounds;
  acknowledged: Acknowledged[];
}

export interface ConformanceConfig {
  buildCommand: string | string[] | undefined;
  testCommand: string | string[] | undefined;
  /** The folder the build and the tests run from, relative to the config's folder. */
  cwd: string;
  /** The folder holding the vendored client and its node:test hooks, relative to the root; the hooks are loaded into the test command from there. */
  client: string;
  /** How long the build and the test command may each run before their process tree is killed. */
  timeoutSeconds: number;
  /** Whether a quint prop needs its model's latest conformance verdict to agree and be current. */
  required: boolean;
  models: ModelConformance[];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function commandOf(value: unknown): string | string[] | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) return value as string[];
  return undefined;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The config's quint block, each key falling back to the default; a malformed config keeps the defaults (the spec walker refuses it). */
export function readQuintConfig(root: string): QuintConfig {
  let block: Record<string, unknown>;
  try {
    block = objectOf(configRecord(root)["quint"]);
  } catch {
    return { ...DEFAULT_QUINT };
  }
  const backend = block["backend"] === "typescript" ? "typescript" : "rust";
  const verify = block["verify"] === "off" || block["verify"] === "tlc" ? block["verify"] : "apalache";
  const seed = typeof block["seed"] === "string" && block["seed"] !== "" ? block["seed"] : undefined;
  return {
    backend,
    maxSamples: numberOr(block["maxSamples"], DEFAULT_QUINT.maxSamples),
    maxSteps: numberOr(block["maxSteps"], DEFAULT_QUINT.maxSteps),
    seed,
    verify,
    verifySteps: numberOr(block["verifySteps"], DEFAULT_QUINT.verifySteps),
    timeoutSeconds: numberOr(block["timeoutSeconds"], DEFAULT_QUINT.timeoutSeconds),
  };
}

/** The config's conformance block; absent, no model is replayed and nothing is required. */
export function readConformanceConfig(root: string): ConformanceConfig {
  let block: Record<string, unknown>;
  try {
    block = objectOf(configRecord(root)["conformance"]);
  } catch {
    block = {};
  }
  const models = Object.entries(objectOf(block["models"])).map(([folder, raw]): ModelConformance => {
    const entry = objectOf(raw);
    const search = objectOf(entry["search"]);
    const names: Record<string, string[]> = {};
    for (const [logged, mapped] of Object.entries(objectOf(entry["names"]))) {
      const list = typeof mapped === "string" ? [mapped] : Array.isArray(mapped) ? mapped.filter((m): m is string => typeof m === "string") : [];
      if (list.length > 0) names[logged] = list;
    }
    const acknowledged = (Array.isArray(entry["acknowledged"]) ? entry["acknowledged"] : []).flatMap((a): Acknowledged[] => {
      const item = objectOf(a);
      return typeof item["guard"] === "string" && typeof item["because"] === "string" && item["because"].trim() !== "" ? [{ guard: item["guard"], because: item["because"] }] : [];
    });
    return {
      folder: folder.replace(/^\.\//, "").replace(/\/+$/, "") || ".",
      scopes: Array.isArray(entry["scopes"]) ? entry["scopes"].filter((s): s is string => typeof s === "string" && s !== "") : [],
      names,
      search: { perPick: numberOr(search["perPick"], DEFAULT_SEARCH.perPick), perStep: numberOr(search["perStep"], DEFAULT_SEARCH.perStep), perRun: numberOr(search["perRun"], DEFAULT_SEARCH.perRun) },
      acknowledged,
    };
  });
  return {
    buildCommand: commandOf(block["buildCommand"]),
    testCommand: commandOf(block["testCommand"]),
    cwd: typeof block["cwd"] === "string" && block["cwd"] !== "" ? block["cwd"] : ".",
    client: typeof block["client"] === "string" && block["client"] !== "" ? block["client"].replace(/\/+$/, "") : DEFAULT_VENDOR_DIR,
    timeoutSeconds: numberOr(block["timeoutSeconds"], 1800),
    required: block["required"] === true,
    models,
  };
}
