// Public, type-only contract for repository-local Coherence plugins.
import type {
  Config,
  Graph,
  GraphEdge,
  GraphNode,
  JsonValue,
  LanguageAdapter,
  PlatformAdapter,
  StructuralFact,
} from "./types.ts";

export type {
  Graph,
  GraphEdge,
  GraphNode,
  JsonValue,
  LanguageAdapter,
  PlatformAdapter,
  StructuralFact,
  Config,
};

export type DeepReadonly<Value> =
  Value extends (...args: never[]) => unknown ? Value
  : Value extends readonly (infer Item)[] ?
    number extends Value["length"] ? readonly DeepReadonly<Item>[]
    : { readonly [Index in keyof Value]: DeepReadonly<Value[Index]> }
  : Value extends object ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
  : Value;

export type ReadonlyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };

export type ReadonlyGraph = DeepReadonly<Graph>;

export interface GraphFragment {
  readonly nodes?: readonly DeepReadonly<GraphNode>[];
  readonly edges?: readonly DeepReadonly<GraphEdge>[];
  readonly facts?: readonly DeepReadonly<StructuralFact>[];
}

export type GraphContributor =
  (base: ReadonlyGraph) => GraphFragment | Promise<GraphFragment>;

export interface ClaimMatch {
  readonly family: string;
  readonly key: string;
  readonly anchors?: readonly string[];
  readonly target?: string;
  readonly oracle?: {
    readonly kind: string;
    readonly name?: string;
  };
  readonly data?: ReadonlyJsonValue;
}

export interface ClaimContext {
  readonly root: string;
  readonly graph: ReadonlyGraph;
  readonly cfg: DeepReadonly<Config>;
  readonly nodeDir: string;
  readonly node: string;
  readonly fast: boolean;
  readonly typecheck: () => { readonly pass: boolean; readonly detail: string };
}

export interface ClaimResult {
  readonly kind: "pass" | "fail" | "skip";
  readonly detail?: string;
  readonly diagnosticIds?: readonly string[];
}

export interface ClaimForm {
  readonly name: string;
  readonly grammar: string;
  readonly example: string;
  readonly tier: "deterministic" | "live" | "executable" | "hybrid";
  parse(line: string): ClaimMatch | null;
  evaluate(context: ClaimContext, match: ClaimMatch): ClaimResult | Promise<ClaimResult>;
}

export interface Diagnostic {
  readonly id: string;
  readonly status: "pass" | "fail" | "skip";
  readonly category: string;
  readonly message: string;
}

export interface ProjectCheckContext {
  readonly root: string;
  readonly graph: ReadonlyGraph;
}

export type ProjectCheck =
  (context: ProjectCheckContext) => readonly Diagnostic[] | Promise<readonly Diagnostic[]>;

export interface PluginInitContext<Options = unknown> {
  readonly root: string;
  readonly options: DeepReadonly<Options> | undefined;
}

export interface PluginCapabilities {
  readonly adapters?: {
    readonly languages?: Readonly<Record<string, LanguageAdapter>>;
    readonly platforms?: Readonly<Record<string, PlatformAdapter>>;
  };
  readonly contributeGraph?: GraphContributor;
  readonly claimForms?: readonly ClaimForm[];
  readonly projectChecks?: readonly ProjectCheck[];
}

export interface CoherencePluginModule<Options = unknown> {
  readonly apiVersion: 1;
  readonly name: string;
  create(context: PluginInitContext<Options>): PluginCapabilities | Promise<PluginCapabilities>;
}
