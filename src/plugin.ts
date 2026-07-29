// Public, type-only contract for repository-local Coherence plugins.
import type {
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
};

export type DeepReadonly<Value> =
  Value extends (...args: never[]) => unknown ? Value
  : Value extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
  : Value extends object ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
  : Value;

export type ReadonlyGraph = DeepReadonly<Graph>;

export interface GraphFragment {
  readonly nodes?: readonly DeepReadonly<GraphNode>[];
  readonly edges?: readonly DeepReadonly<GraphEdge>[];
  readonly facts?: readonly DeepReadonly<StructuralFact>[];
}

export type GraphContributor =
  (base: ReadonlyGraph) => GraphFragment | Promise<GraphFragment>;

export interface PluginInitContext<Options = unknown> {
  readonly root: string;
  readonly options: Options | undefined;
}

export interface PluginCapabilities {
  readonly adapters?: {
    readonly languages?: Readonly<Record<string, LanguageAdapter>>;
    readonly platforms?: Readonly<Record<string, PlatformAdapter>>;
  };
  readonly contributeGraph?: GraphContributor;
}

export interface CoherencePluginModule<Options = unknown> {
  readonly apiVersion: 1;
  readonly name: string;
  create(context: PluginInitContext<Options>): PluginCapabilities | Promise<PluginCapabilities>;
}
