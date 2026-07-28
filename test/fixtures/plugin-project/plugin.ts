import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoherencePluginModule } from "coherence-harness/plugin";

interface FixtureOptions {
  marker: string;
}

const plugin: CoherencePluginModule<FixtureOptions> = {
  apiVersion: 1,
  name: "fixture",
  create() {
    return {
      adapters: {
        languages: {
          fixture: {
            exts: ["fixture"],
            symbols() {
              return [{ name: "adapterSymbol", kind: "function", line: 1 }];
            },
            imports() {
              return [];
            },
            docAbove() {
              return "Adapter-derived symbol.";
            },
            fileDoc() {
              return "Adapter-derived file.";
            },
          },
        },
        platforms: {
          fixture: {
            async bindings() {
              return {
                entities: [],
                stores: [{
                  binding: "FIXTURE_STORE",
                  label: "Fixture Store",
                  sub: "fixture adapter",
                }],
                vars: {},
                meta: {},
              };
            },
          },
        },
      },
      contributeGraph(base) {
        const adapterSymbol = base.nodes.find((node) =>
          node.kind === "symbol" && node.label === "adapterSymbol");
        if (!adapterSymbol) throw new Error("fixture language adapter did not run");
        return {
          nodes: [{
            id: "fixture:guard",
            parent: "c:.",
            label: "fixtureGuard",
            kind: "symbol",
            path: "main.fixture",
            line: 1,
            prose: "Plugin-contributed guard.",
            data: { "fixture:role": "guard" },
          }],
          edges: [{
            id: "fixture:guards",
            source: "fixture:guard",
            target: adapterSymbol.id,
            kind: "guards",
          }],
          facts: [{
            id: "fixture:mode",
            label: "Fixture mode",
            value: { marker: "fixture-marker" },
            policy: { change: "loss" },
          }],
        };
      },
      claimForms: [{
        name: "fixture:boundary",
        grammar: 'fixture boundary "<invariant>" at <target>',
        example: 'fixture boundary "fixture route" at fixtureGuard',
        tier: "deterministic",
        parse(line) {
          const match = /^fixture boundary "([^"]+)" at (\S+)$/.exec(line);
          return match ? {
            family: "boundary",
            key: match[1],
            anchors: [match[1]],
            target: match[2],
            oracle: { kind: "fixture/check" },
          } : null;
        },
        evaluate(context, match) {
          const exists = context.graph.nodes.some((node) =>
            node.kind === "symbol" && node.label === match.target);
          return exists
            ? { kind: "pass", detail: "fixture guard exists" }
            : { kind: "fail", detail: "fixture guard is missing" };
        },
      }],
      projectChecks: [
        ({ graph }) => {
          const complete = graph.nodes.some((node) => node.id === "fixture:guard")
            && graph.edges.some((edge) => edge.id === "fixture:guards")
            && graph.facts?.some((fact) => fact.id === "fixture:mode");
          return [{
            id: "fixture:complete",
            status: complete ? "pass" : "fail",
            category: "fixture",
            message: complete
              ? "all fixture graph contributions are present"
              : "fixture graph contribution is incomplete",
          }];
        },
      ],
      commands: {
        async inspect(context, args) {
          await writeFile(
            join(context.root, "command-receipt.json"),
            JSON.stringify({
              root: context.root,
              marker: context.options?.marker,
              args,
            }, null, 2) + "\n",
          );
          console.log(`fixture command args: ${JSON.stringify(args)}`);
          return args.includes("--fail") ? 7 : undefined;
        },
      },
    };
  },
};

export default plugin;
