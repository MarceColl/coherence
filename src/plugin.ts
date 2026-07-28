// Public, type-only contract for repository-local Coherence plugins.
import type { LanguageAdapter, PlatformAdapter } from "./types.ts";

export type { LanguageAdapter, PlatformAdapter };

export interface PluginInitContext<Options = unknown> {
  readonly root: string;
  readonly options: Options | undefined;
}

export interface PluginCapabilities {
  readonly adapters?: {
    readonly languages?: Readonly<Record<string, LanguageAdapter>>;
    readonly platforms?: Readonly<Record<string, PlatformAdapter>>;
  };
}

export interface CoherencePluginModule<Options = unknown> {
  readonly apiVersion: 1;
  readonly name: string;
  create(context: PluginInitContext<Options>): PluginCapabilities | Promise<PluginCapabilities>;
}
