import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadConfig } from "../src/config.ts";
import { buildGraph } from "../src/derive.ts";
import { loadProject } from "../src/plugins.ts";
import { renderClaude } from "../src/render-claude.ts";
import { atlas } from "../src/atlas.ts";
import { conventions } from "../src/conventions.ts";
import { runVerify } from "../src/verify.ts";
import { allBoundaries, diffGraphs, graphAtRef, structuralLog, withTreeAt } from "../src/structural.ts";
import { cleanup, runCaptured, tmpProject } from "./_helpers.ts";

const pluginSource = (name = "fixture") => `
export default {
  apiVersion: 1,
  name: ${JSON.stringify(name)},
  async create({ options }) {
    const ext = options.ext;
    return {
      adapters: {
        languages: {
          fixture: {
            exts: [ext],
            symbols() { return [{ name: "fromPlugin", kind: "function", line: 1 }]; },
            imports() { return []; },
            docAbove() { return ""; },
            fileDoc() { return ""; }
          }
        },
        platforms: {
          fixture: {
            async bindings() {
              return {
                entities: [],
                stores: [{ binding: "PLUGIN_STORE", label: "Plugin Store", sub: "fixture" }],
                vars: {},
                meta: {}
              };
            }
          }
        }
      }
    };
  }
};
`;

const languagePluginSource = (name: string, key: string, symbol = "fromPlugin") => `
export default {
  apiVersion: 1,
  name: ${JSON.stringify(name)},
  create() {
    return {
      adapters: {
        languages: {
          ${JSON.stringify(key)}: {
            exts: ["plug"],
            symbols() { return [{ name: ${JSON.stringify(symbol)}, kind: "function", line: 1 }]; },
            imports() { return []; },
            docAbove() { return ""; },
            fileDoc() { return ""; }
          }
        }
      }
    };
  }
};
`;

const fragmentPluginSource = (name: string, body: string) => `
export default {
  apiVersion: 1,
  name: ${JSON.stringify(name)},
  create() {
    return {
      contributeGraph(base) {
        ${body}
      }
    };
  }
};
`;

const claimPluginSource = (target = "guard") => `
export default {
  apiVersion: 1,
  name: "claims",
  create() {
    return {
      claimForms: [{
        name: "claims:fixture-boundary",
        grammar: 'fixture boundary "<invariant>" at <target> via "<oracle>"',
        example: 'fixture boundary "protected" at guard via "schema"',
        tier: "hybrid",
        parse(line) {
          const match = /^fixture boundary "([^"]+)" at (\\S+) via "([^"]+)"$/.exec(line);
          return match ? {
            family: "boundary",
            key: match[1],
            anchors: [match[1]],
            target: match[2],
            oracle: { kind: "fixture/schema", name: match[3] },
            data: { source: "fixture" }
          } : null;
        },
        evaluate(context, match) {
          return context.graph.nodes.some((node) =>
            node.kind === "symbol" && node.label === match.target)
            ? { kind: "pass", detail: "fixture boundary held" }
            : { kind: "fail", detail: "fixture target missing" };
        }
      }]
    };
  }
};
`;

const git = (root: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test("loadConfig — a missing config uses defaults", async () => {
  const root = await tmpProject();
  try {
    const config = await loadConfig(root);
    assert.equal(config.root, root);
    assert.equal(config.language, "typescript");
    assert.equal(config.platform, null);
  } finally {
    await cleanup(root);
  }
});

test("loadConfig — malformed JSON is fatal", async () => {
  const root = await tmpProject({ "coherence.config.json": "{" });
  try {
    await assert.rejects(loadConfig(root), /Invalid coherence\.config\.json/);
  } finally {
    await cleanup(root);
  }
});

test("loadConfig — the config root must be an object", async () => {
  for (const raw of ["null", "[]", "42"]) {
    const root = await tmpProject({ "coherence.config.json": raw });
    try {
      await assert.rejects(loadConfig(root), /expected a JSON object/);
    } finally {
      await cleanup(root);
    }
  }
});

test("loadProject — no-plugin projects retain the built-in graph behavior", async () => {
  const root = await tmpProject({
    "system.spec.md": "# System\nThe system.",
    "main.ts": "export function builtIn() {}\n",
  });
  try {
    const project = await loadProject(root);
    const graph = await buildGraph(project);
    assert.deepEqual(project.plugins, []);
    assert.ok(project.languages.has("typescript"));
    assert.ok(project.languages.has("python"));
    assert.ok(project.platforms.has("cloudflare"));
    assert.ok(graph.nodes.some((node) => node.id === "s:main.ts#builtIn"));
    assert.deepEqual(Object.keys(graph).sort(), ["absRoot", "bindings", "edges", "generatedAt", "nodes", "root"]);
  } finally {
    await cleanup(root);
  }
});

test("loadProject — configured plugin options initialize language and platform adapters", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({
      plugins: [{ path: ".coherence/plugin.ts", options: { ext: "plug" } }],
      language: "fixture",
      platform: "fixture",
      codeExt: ["plug"],
    }),
    ".coherence/plugin.ts": pluginSource(),
    "system.spec.md": "# System\nThe system.",
    "main.plug": "plugin source\n",
  });
  try {
    const project = await loadProject(root);
    const graph = await buildGraph(project);
    assert.deepEqual(project.plugins.map((plugin) => plugin.name), ["fixture"]);
    assert.deepEqual(project.languages.get("fixture")?.exts, ["plug"]);
    assert.ok(graph.nodes.some((node) => node.id === "s:main.plug#fromPlugin"));
    assert.ok(graph.nodes.some((node) => node.id === "i:PLUGIN_STORE"));
  } finally {
    await cleanup(root);
  }
});

test("buildGraph — configured extensions are matched literally", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({
      plugins: [{ path: "plugin.ts", options: { ext: "(" } }],
      language: "fixture",
      codeExt: ["("],
    }),
    "plugin.ts": pluginSource(),
    "system.spec.md": "# System\nThe system.",
    "main.(": "plugin source\n",
  });
  try {
    const graph = await buildGraph(await loadProject(root));
    assert.ok(graph.nodes.some((node) =>
      node.kind === "symbol" && node.path === "main.(" && node.label === "fromPlugin"));
  } finally {
    await cleanup(root);
  }
});

test("loadProject — missing plugin files are fatal", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: ".coherence/missing.ts" }] }),
  });
  try {
    await assert.rejects(loadProject(root), /Cannot load plugin.*missing\.ts/);
  } finally {
    await cleanup(root);
  }
});

test("loadProject — plugin paths cannot escape the repository", async () => {
  const root = await tmpProject();
  const outside = await tmpProject({ "plugin.ts": pluginSource() });
  try {
    await writeFile(
      join(root, "coherence.config.json"),
      JSON.stringify({ plugins: [{ path: relative(root, join(outside, "plugin.ts")) }] }),
    );
    await assert.rejects(loadProject(root), /outside project root/);
  } finally {
    await cleanup(root);
    await cleanup(outside);
  }
});

test("loadProject — symlinked plugin paths cannot escape the repository", async () => {
  const root = await tmpProject();
  const outside = await tmpProject({ "plugin.ts": pluginSource() });
  try {
    await symlink(join(outside, "plugin.ts"), join(root, "plugin.ts"));
    await writeFile(
      join(root, "coherence.config.json"),
      JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    );
    await assert.rejects(loadProject(root), /outside project root/);
  } finally {
    await cleanup(root);
    await cleanup(outside);
  }
});

test("loadProject — invalid exports and API versions are fatal", async () => {
  const invalid = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": "export default {};\n",
  });
  const versioned = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": "export default { apiVersion: 2, name: 'future', create() { return {}; } };\n",
  });
  try {
    await assert.rejects(loadProject(invalid), /invalid default export/);
    await assert.rejects(loadProject(versioned), /unsupported apiVersion 2/);
  } finally {
    await cleanup(invalid);
    await cleanup(versioned);
  }
});

test("loadProject — unsupported capability keys are fatal", async () => {
  const capability = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": "export default { apiVersion: 1, name: 'future', create() { return { commandz: {} }; } };\n",
  });
  const adapter = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": "export default { apiVersion: 1, name: 'typo', create() { return { adapters: { language: {} } }; } };\n",
  });
  try {
    await assert.rejects(loadProject(capability), /unsupported capability "commandz"/);
    await assert.rejects(loadProject(adapter), /unsupported adapter capability "language"/);
  } finally {
    await cleanup(capability);
    await cleanup(adapter);
  }
});

test("loadProject — claim/check/command contracts and duplicate form names are fatal", async () => {
  const invalidForm = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": `export default {
      apiVersion: 1,
      name: "invalid",
      create() { return { claimForms: [{ name: "invalid:form", grammar: "x", example: "x", tier: "deterministic" }] }; }
    };`,
  });
  const invalidChecks = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": `export default {
      apiVersion: 1,
      name: "invalid",
      create() { return { projectChecks: {} }; }
    };`,
  });
  const duplicate = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": `export default {
      apiVersion: 1,
      name: "duplicate",
      create() {
        return { claimForms: [{
          name: "typechecks",
          grammar: "duplicate",
          example: "duplicate",
          tier: "deterministic",
          parse() { return null; },
          evaluate() { return { kind: "pass" }; }
        }] };
      }
    };`,
  });
  const invalidCommands = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": `export default {
      apiVersion: 1,
      name: "invalid",
      create() { return { commands: { sync: 1 } }; }
    };`,
  });
  const accessorCommand = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": `export default {
      apiVersion: 1,
      name: "invalid",
      create() {
        const commands = {};
        Object.defineProperty(commands, "sync", { enumerable: true, get() { return () => {}; } });
        return { commands };
      }
    };`,
  });
  try {
    await assert.rejects(loadProject(invalidForm), /must define parse and evaluate functions/);
    await assert.rejects(loadProject(invalidChecks), /projectChecks must be an array of functions/);
    await assert.rejects(loadProject(duplicate), /Duplicate claim form name "typechecks"/);
    await assert.rejects(loadProject(invalidCommands), /command "sync" must be a function/);
    await assert.rejects(loadProject(accessorCommand), /commands must use enumerable data properties/);
  } finally {
    await cleanup(invalidForm);
    await cleanup(invalidChecks);
    await cleanup(duplicate);
    await cleanup(invalidCommands);
    await cleanup(accessorCommand);
  }
});

test("loadProject — duplicate plugin names are fatal", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({
      plugins: [{ path: "one.ts" }, { path: "two.ts" }],
    }),
    "one.ts": languagePluginSource("same", "one"),
    "two.ts": languagePluginSource("same", "two"),
  });
  try {
    await assert.rejects(loadProject(root), /Duplicate plugin name "same"/);
  } finally {
    await cleanup(root);
  }
});

test("loadProject — initialization failure cannot leak a partial runtime", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({
      plugins: [{ path: "good.ts" }, { path: "broken.ts" }],
    }),
    "good.ts": languagePluginSource("good", "leaked"),
    "broken.ts": "export default { apiVersion: 1, name: 'broken', create() { throw new Error('boom'); } };\n",
  });
  const clean = await tmpProject({
    "coherence.config.json": JSON.stringify({ language: "leaked" }),
  });
  try {
    await assert.rejects(loadProject(root), /Plugin "broken" initialization failed: boom/);
    await assert.rejects(loadProject(clean), /Unknown language adapter "leaked"/);
  } finally {
    await cleanup(root);
    await cleanup(clean);
  }
});

test("loadProject — duplicate adapter keys cannot replace built-ins or peers", async () => {
  const builtIn = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": languagePluginSource("override", "typescript"),
  });
  const peer = await tmpProject({
    "coherence.config.json": JSON.stringify({
      plugins: [{ path: "one.ts" }, { path: "two.ts" }],
    }),
    "one.ts": languagePluginSource("one", "shared"),
    "two.ts": languagePluginSource("two", "shared"),
  });
  try {
    await assert.rejects(loadProject(builtIn), /Duplicate language adapter "typescript"/);
    await assert.rejects(loadProject(peer), /Duplicate language adapter "shared"/);
  } finally {
    await cleanup(builtIn);
    await cleanup(peer);
  }
});

test("loadProject — unknown configured language and platform names are fatal", async () => {
  const language = await tmpProject({
    "coherence.config.json": JSON.stringify({ language: "missing" }),
  });
  const platform = await tmpProject({
    "coherence.config.json": JSON.stringify({ platform: "missing" }),
  });
  try {
    await assert.rejects(loadProject(language), /Unknown language adapter "missing"/);
    await assert.rejects(loadProject(platform), /Unknown platform adapter "missing"/);
  } finally {
    await cleanup(language);
    await cleanup(platform);
  }
});

test("graphAtRef — historical graphs load the plugin module from that ref", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({
      plugins: [{ path: "plugin.ts" }],
      language: "history",
      codeExt: ["plug"],
    }),
    "plugin.ts": languagePluginSource("history", "history", "oldSymbol"),
    "system.spec.md": "# System\nThe system.",
    "main.plug": "historical source\n",
  });
  try {
    git(root, "init");
    git(root, "config", "user.email", "coherence@example.test");
    git(root, "config", "user.name", "Coherence Test");
    git(root, "add", ".");
    git(root, "commit", "-m", "old plugin");
    const oldRef = git(root, "rev-parse", "HEAD");

    await writeFile(join(root, "plugin.ts"), languagePluginSource("history", "history", "newSymbol"));
    git(root, "add", "plugin.ts");
    git(root, "commit", "-m", "new plugin");

    const project = await loadProject(root);
    const oldGraph = await graphAtRef(project.config, oldRef);
    const liveGraph = await graphAtRef(project.config, null);
    assert.ok(oldGraph.nodes.some((node) => node.id === "s:main.plug#oldSymbol"));
    assert.ok(!oldGraph.nodes.some((node) => node.id === "s:main.plug#newSymbol"));
    assert.ok(liveGraph.nodes.some((node) => node.id === "s:main.plug#newSymbol"));
  } finally {
    await cleanup(root);
  }
});

test("buildGraph — contributors see one frozen base graph and merge deterministically", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({
      plugins: [{ path: "alpha.ts" }, { path: "beta.ts" }],
    }),
    "alpha.ts": fragmentPluginSource("alpha", `
      const complete = base.nodes.some((node) => node.id === "s:main.ts#builtIn");
      let mutationBlocked = false;
      try { base.nodes.push({ id: "alpha:mutated" }); } catch { mutationBlocked = true; }
      return {
        nodes: [{
          id: "alpha:model",
          label: "Alpha model",
          kind: "model",
          data: { complete, mutationBlocked }
        }],
        edges: [{
          id: "alpha:contains",
          source: "c:.",
          target: "alpha:model",
          kind: "contains",
          data: { role: "model" }
        }],
        facts: [{
          id: "alpha:materialization",
          label: "Alpha materialization",
          value: { mode: "table" },
          policy: { change: "loss" }
        }]
      };
    `),
    "beta.ts": fragmentPluginSource("beta", `
      if (base.nodes.some((node) => node.id === "alpha:model"))
        throw new Error("contributors observed another fragment");
      return {
        nodes: [{ id: "beta:model", label: "Beta model", kind: "model" }]
      };
    `),
    "system.spec.md": "# System\nThe system.",
    "main.ts": "export function builtIn() {}\n",
  });
  try {
    const graph = await buildGraph(await loadProject(root));
    const alpha = graph.nodes.find((node) => node.id === "alpha:model");
    assert.deepEqual(alpha?.data, { complete: true, mutationBlocked: true });
    assert.deepEqual(
      graph.nodes.filter((node) => node.id.endsWith(":model")).map((node) => node.id),
      ["alpha:model", "beta:model"],
    );
    assert.deepEqual(graph.edges.find((edge) => edge.id === "alpha:contains")?.data, { role: "model" });
    assert.deepEqual(graph.facts, [{
      id: "alpha:materialization",
      label: "Alpha materialization",
      value: { mode: "table" },
      policy: { change: "loss" },
    }]);
  } finally {
    await cleanup(root);
  }
});

test("buildGraph — invalid fragments fail before any contributed graph is published", async () => {
  const cases: Array<{ name: string; body: string; error: RegExp }> = [
    {
      name: "unscoped",
      body: `return { nodes: [{ id: "model", label: "Model", kind: "model" }] };`,
      error: /node id "model" must start with "unscoped:"/,
    },
    {
      name: "unscopededge",
      body: `return { edges: [{
        id: "edge", source: "c:.", target: "c:.", kind: "loops"
      }] };`,
      error: /edge id "edge" must start with "unscopededge:"/,
    },
    {
      name: "unscopedfact",
      body: `return { facts: [{ id: "fact", label: "Fact" }] };`,
      error: /structural fact id "fact" must start with "unscopedfact:"/,
    },
    {
      name: "replacement",
      body: `return { nodes: [{ id: "c:.", label: "Replacement", kind: "component" }] };`,
      error: /cannot replace or duplicate base node "c:\."/,
    },
    {
      name: "duplicate",
      body: `return { nodes: [
        { id: "duplicate:model", label: "One", kind: "model" },
        { id: "duplicate:model", label: "Two", kind: "model" }
      ] };`,
      error: /cannot replace or duplicate node "duplicate:model"/,
    },
    {
      name: "duplicateedge",
      body: `return {
        nodes: [{ id: "duplicateedge:model", label: "Model", kind: "model" }],
        edges: [
          { id: "duplicateedge:edge", source: "c:.", target: "duplicateedge:model", kind: "contains" },
          { id: "duplicateedge:edge", source: "c:.", target: "duplicateedge:model", kind: "contains" }
        ]
      };`,
      error: /Duplicate graph edge id "duplicateedge:edge"/,
    },
    {
      name: "duplicatefact",
      body: `return { facts: [
        { id: "duplicatefact:fact", label: "One" },
        { id: "duplicatefact:fact", label: "Two" }
      ] };`,
      error: /Duplicate structural fact id "duplicatefact:fact"/,
    },
    {
      name: "dangling",
      body: `return { edges: [{
        id: "dangling:edge", source: "c:.", target: "dangling:missing", kind: "contains"
      }] };`,
      error: /dangling target "dangling:missing"/,
    },
    {
      name: "self",
      body: `return {
        nodes: [{ id: "self:model", label: "Model", kind: "model" }],
        edges: [{ id: "self:edge", source: "self:model", target: "self:model", kind: "loops" }]
      };`,
      error: /cannot be a self-edge/,
    },
    {
      name: "function",
      body: `return {
        nodes: [{ id: "function:model", label: "Model", kind: "model", data: { bad() {} } }]
      };`,
      error: /data\.bad must be JSON-serializable/,
    },
    {
      name: "cycle",
      body: `const data = {}; data.self = data; return {
        facts: [{ id: "cycle:fact", label: "Cyclic", value: data }]
      };`,
      error: /value\.self must not contain cycles/,
    },
  ];

  for (const fixture of cases) {
    const root = await tmpProject({
      "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
      "plugin.ts": fragmentPluginSource(fixture.name, fixture.body),
      "system.spec.md": "# System\nThe system.",
    });
    try {
      await assert.rejects(buildGraph(await loadProject(root)), fixture.error, fixture.name);
    } finally {
      await cleanup(root);
    }
  }
});

test("buildGraph — endpoints may target the complete union of peer fragments", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({
      plugins: [{ path: "linker.ts" }, { path: "target.ts" }],
    }),
    "linker.ts": fragmentPluginSource("linker", `return {
      edges: [{
        id: "linker:peer", source: "c:.", target: "target:model", kind: "contains"
      }]
    };`),
    "target.ts": fragmentPluginSource("target", `return {
      nodes: [{ id: "target:model", label: "Target", kind: "model" }]
    };`),
    "system.spec.md": "# System\nThe system.",
  });
  try {
    const graph = await buildGraph(await loadProject(root));
    assert.equal(graph.edges.at(-1)?.target, "target:model");
  } finally {
    await cleanup(root);
  }
});

test("structuralLog — historical refs use their local plugin facts and strict loss policy", async () => {
  const plugin = (mode: string) => fragmentPluginSource("history", `return {
    facts: [{
      id: "history:mode",
      label: "Historical mode",
      value: { mode: ${JSON.stringify(mode)} },
      policy: { change: "loss" }
    }]
  };`);
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": plugin("view"),
    "system.spec.md": "# System\nThe system.",
  });
  try {
    git(root, "init");
    git(root, "config", "user.email", "coherence@example.test");
    git(root, "config", "user.name", "Coherence Test");
    git(root, "add", ".");
    git(root, "commit", "-m", "view fact");
    const oldRef = git(root, "rev-parse", "HEAD");

    await writeFile(join(root, "plugin.ts"), plugin("table"));
    assert.match(git(root, "show", `${oldRef}:plugin.ts`), /mode: "view"/);
    const config = await loadConfig(root);
    assert.match(await withTreeAt(config, oldRef, (at) => readFile(join(at, "plugin.ts"), "utf8")), /mode: "view"/);
    assert.deepEqual((await graphAtRef(config, oldRef)).facts?.[0].value, { mode: "view" });
    assert.deepEqual((await graphAtRef(config, null)).facts?.[0].value, { mode: "table" });
    const result = await runCaptured(async () =>
      structuralLog(config, oldRef, null, true));

    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /fact "Historical mode" \[history:mode\].*CHANGED — LOSS/);
    assert.match(result.out, /--strict: 1 structural loss/);
  } finally {
    await cleanup(root);
  }
});

test("plugin claims — one normalized runtime form feeds phrasebook, verify, anchors, ledger, CLAUDE, atlas, and conventions", async () => {
  const claim = 'fixture boundary "protected" at guard via "schema"';
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({
      plugins: [{ path: "plugin.ts" }],
      typecheck: ["true"],
      sources: ["."],
      atlas: {
        charts: { outside: "Outside", inside: "Inside" },
        transitions: {
          guard: {
            from: "outside",
            to: "inside",
            translates: "protected",
          },
        },
      },
    }),
    "plugin.ts": claimPluginSource(),
    "system.spec.md": [
      "# System",
      "The system.",
      "",
      "## works when",
      `- ${claim}`,
      "",
      "## invariants",
      "- protected",
      "",
      "## why",
      "Protected traffic crosses one declared boundary.",
    ].join("\n"),
    "main.ts": [
      "export function guard() {}",
      "export function first() { guard(); }",
      "export function second() { guard(); }",
    ].join("\n"),
  });
  try {
    const project = await loadProject(root);
    const graph = await buildGraph(project);

    assert.ok(project.claimForms.some((form) => form.name === "claims:fixture-boundary"));
    const phrasebook = spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), "phrasebook"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(phrasebook.status, 0, phrasebook.stderr);
    assert.match(phrasebook.stdout, /claims:fixture-boundary/);

    const verified = await runCaptured(() => runVerify(project.config, graph, { fast: true }));
    assert.equal(verified.code, 0, verified.out);
    assert.match(verified.out, /1 green · 0 red/);
    assert.doesNotMatch(verified.out, /not anchored/);

    const boundaries = allBoundaries(graph);
    assert.equal(boundaries.get("guard")?.inv, "protected");
    assert.equal(boundaries.get("guard")?.verb, "fixture/schema");
    assert.match(renderClaude(graph, "stamp"), /protected.*guard.*schema/);

    const atlasResult = await runCaptured(() => atlas(project.config, graph, "check"));
    assert.equal(atlasResult.code, 0, atlasResult.out);
    assert.match(atlasResult.out, /no drift/);
    const conventionResult = await runCaptured(() => conventions(project.config, graph, "report"));
    assert.equal(conventionResult.code, 0);
    assert.match(conventionResult.out, /guard\s+2\s+ANCHORED/);
  } finally {
    await cleanup(root);
  }

  const beforeRoot = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": claimPluginSource("guard"),
    "system.spec.md": `# System\nThe system.\n\n## works when\n- fixture boundary "protected" at guard via "schema"\n`,
    "main.ts": "export function guard() {}\nexport function nextGuard() {}\n",
  });
  const afterRoot = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": claimPluginSource("nextGuard"),
    "system.spec.md": `# System\nThe system.\n\n## works when\n- fixture boundary "protected" at nextGuard via "schema"\n`,
    "main.ts": "export function guard() {}\nexport function nextGuard() {}\n",
  });
  try {
    const before = await buildGraph(await loadProject(beforeRoot));
    const after = await buildGraph(await loadProject(afterRoot));
    const diff = diffGraphs(before, after);
    assert.equal(diff.boundaryRewired.length, 1);
    assert.equal(diff.boundaryRewired[0].before.chokepoint, "guard");
    assert.equal(diff.boundaryRewired[0].after.chokepoint, "nextGuard");
  } finally {
    await cleanup(beforeRoot);
    await cleanup(afterRoot);
  }
});

test("plugin claims — verify reuses the graph-bound normalized match", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({
      plugins: [{ path: "plugin.ts" }],
      typecheck: ["true"],
    }),
    "plugin.ts": `
      let parses = 0;
      export default {
        apiVersion: 1,
        name: "single-parse",
        create() {
          return {
            claimForms: [{
              name: "single-parse:boundary",
              grammar: "single parse",
              example: "single parse",
              tier: "deterministic",
              parse(line) {
                if (line !== "single parse") return null;
                parses++;
                return {
                  family: "boundary",
                  key: "stable",
                  anchors: ["stable"],
                  target: "guard",
                  oracle: { kind: "single-parse/check" }
                };
              },
              evaluate(context, match) {
                const targetExists = context.graph.nodes.some((node) =>
                  node.kind === "symbol" && node.label === match.target);
                return {
                  kind: parses === 1 && targetExists ? "pass" : "fail",
                  detail: "parsed " + parses + " time(s)"
                };
              }
            }]
          };
        }
      };
    `,
    "system.spec.md": [
      "# System",
      "The system.",
      "",
      "## works when",
      "- single parse",
      "",
      "## invariants",
      "- stable",
      "",
      "## why",
      "Stable behavior crosses the declared guard.",
    ].join("\n"),
    "main.ts": "export function guard() {}\n",
  });
  try {
    const project = await loadProject(root);
    const result = await runCaptured(async () =>
      runVerify(project.config, await buildGraph(project), { fast: true }));
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /claims: 1 · 1 green · 0 red/);
  } finally {
    await cleanup(root);
  }
});

test("plugin contract — frozen inputs are deeply readonly at compile time", async () => {
  const root = await tmpProject();
  try {
    const pluginContract = relative(root, join(process.cwd(), "src", "plugin.ts"))
      .replaceAll("\\", "/");
    await writeFile(join(root, "contract.ts"), `
      import type {
        ClaimContext,
        ClaimMatch,
        PluginInitContext
      } from ${JSON.stringify(pluginContract)};

      declare const init: PluginInitContext<{ nested: { value: string } }>;
      // @ts-expect-error initialized plugin options are deeply frozen
      init.options!.nested.value = "changed";

      declare const tupleInit: PluginInitContext<{ pair: [string, number] }>;
      const first: string = tupleInit.options!.pair[0];

      declare const context: ClaimContext;
      // @ts-expect-error claim configuration is deeply frozen
      context.cfg.ignore.push("dist");

      type DataObject = Exclude<
        Extract<NonNullable<ClaimMatch["data"]>, object>,
        readonly unknown[]
      >;
      declare const data: DataObject;
      // @ts-expect-error normalized claim data is deeply frozen
      data.value = "changed";
    `);
    const typed = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsc"), [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target", "es2022",
      "--module", "nodenext",
      "--moduleResolution", "nodenext",
      "--allowImportingTsExtensions",
      join(root, "contract.ts"),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(typed.status, 0, typed.stderr || typed.stdout);
  } finally {
    await cleanup(root);
  }
});

test("plugin claims — dictionary commitments recurse through the graph's runtime registry", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": claimPluginSource(),
    "dictionary/Fixture.md": [
      "# Fixture",
      "Uses the fixture boundary.",
      "",
      "## commitments",
      '- fixture boundary "protected" at guard via "schema"',
    ].join("\n"),
    "system.spec.md": [
      "# System",
      "The system.",
      "",
      "## works when",
      "- conforms to Fixture",
      "",
      "## invariants",
      "- protected",
      "",
      "## why",
      "Protected traffic crosses one declared boundary.",
    ].join("\n"),
    "main.ts": "export function guard() {}\n",
  });
  try {
    const project = await loadProject(root);
    const result = await runCaptured(async () =>
      runVerify(project.config, await buildGraph(project), { fast: true }));
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /matches no claim form|not anchored/);
  } finally {
    await cleanup(root);
  }
});

test("structuralLog — each ref uses its local plugin parser for boundary rewiring", async () => {
  const plugin = (target: string) => `
    export default {
      apiVersion: 1,
      name: "historyclaims",
      create() {
        return {
          claimForms: [{
            name: "historyclaims:boundary",
            grammar: "fixture semantic boundary",
            example: "fixture semantic boundary",
            tier: "deterministic",
            parse(line) {
              return line === "fixture semantic boundary"
                ? {
                    family: "boundary",
                    key: "protected",
                    anchors: ["protected"],
                    target: ${JSON.stringify(target)},
                    oracle: { kind: "fixture/schema" }
                  }
                : null;
            },
            evaluate() { return { kind: "pass" }; }
          }]
        };
      }
    };
  `;
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": plugin("guard"),
    "system.spec.md": "# System\nThe system.\n\n## works when\n- fixture semantic boundary\n",
    "main.ts": "export function guard() {}\nexport function nextGuard() {}\n",
  });
  try {
    git(root, "init");
    git(root, "config", "user.email", "coherence@example.test");
    git(root, "config", "user.name", "Coherence Test");
    git(root, "add", ".");
    git(root, "commit", "-m", "old claim parser");
    const oldRef = git(root, "rev-parse", "HEAD");

    await writeFile(join(root, "plugin.ts"), plugin("nextGuard"));
    const result = await runCaptured(async () =>
      structuralLog(await loadConfig(root), oldRef, null, false));
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /boundary "protected".*rewired/);
    assert.match(result.out, /chokepoint guard → nextGuard/);
  } finally {
    await cleanup(root);
  }
});

test("plugin claims — ambiguous matches fail closed", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": `
      export default {
        apiVersion: 1,
        name: "ambiguous",
        create() {
          return {
            claimForms: [{
              name: "ambiguous:typechecks",
              grammar: "typechecks",
              example: "typechecks",
              tier: "deterministic",
              parse(line) {
                return line === "typechecks"
                  ? { family: "ambiguous", key: "typechecks" }
                  : null;
              },
              evaluate() { return { kind: "pass" }; }
            }]
          };
        }
      };
    `,
    "system.spec.md": "# System\nThe system.\n\n## works when\n- typechecks\n",
  });
  try {
    await assert.rejects(
      buildGraph(await loadProject(root)),
      /Claim "typechecks" matches multiple forms: typechecks, ambiguous:typechecks/,
    );
  } finally {
    await cleanup(root);
  }
});

test("project checks — final-graph diagnostics and referenced claim failures count once by stable id", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": `
      export default {
        apiVersion: 1,
        name: "checks",
        create() {
          const diagnostic = ({ graph }) => [{
            id: "checks:bypass",
            status: graph.nodes.some((node) => node.id === "checks:model") ? "fail" : "pass",
            category: "fixture",
            message: "one bypass"
          }];
          return {
            contributeGraph() {
              return { nodes: [{ id: "checks:model", label: "Model", kind: "model" }] };
            },
            claimForms: [{
              name: "checks:no-bypass",
              grammar: "has no bypass",
              example: "has no bypass",
              tier: "deterministic",
              parse(line) {
                return line === "has no bypass"
                  ? { family: "checks", key: "no-bypass" }
                  : null;
              },
              evaluate() {
                return {
                  kind: "fail",
                  detail: "bypass diagnostic failed",
                  diagnosticIds: ["checks:bypass"]
                };
              }
            }],
            projectChecks: [diagnostic, diagnostic]
          };
        }
      };
    `,
    "system.spec.md": [
      "# System",
      "The system.",
      "",
      "## works when",
      "- has no bypass",
      "",
      "## why",
      "The project rejects bypasses.",
    ].join("\n"),
  });
  try {
    const project = await loadProject(root);
    const result = await runCaptured(async () =>
      runVerify(project.config, await buildGraph(project), { fast: true }));
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /diagnostics: 1 · 0 green · 1 red · 0 skipped/);
    assert.match(result.out, /\[checks:bypass\].*one bypass/);
    assert.match(result.out, /✗ 1 coherence failure\(s\)/);
  } finally {
    await cleanup(root);
  }
});

test("project checks — diagnostic ids must be namespaced by their plugin", async () => {
  const root = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": `export default {
      apiVersion: 1,
      name: "checks",
      create() {
        return {
          projectChecks: [() => [{
            id: "unscoped",
            status: "fail",
            category: "fixture",
            message: "bad id"
          }]]
        };
      }
    };`,
    "system.spec.md": "# System\nThe system.\n\n## works when\n- unknown dialect\n\n## why\nThe system is checked.\n",
  });
  try {
    const project = await loadProject(root);
    await assert.rejects(
      runCaptured(async () => runVerify(project.config, await buildGraph(project), { fast: true })),
      /diagnostic at index 0\.id must start with "checks:"/,
    );
  } finally {
    await cleanup(root);
  }
});

test("plugin fixture — actual CLI composes every capability and runs commands only on demand", async () => {
  const parent = await tmpProject();
  const root = join(parent, "project");
  const fixture = join(process.cwd(), "test", "fixtures", "plugin-project");
  const cli = join(process.cwd(), "src", "cli.ts");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  const receiptPath = join(root, "command-receipt.json");
  try {
    await cp(fixture, root, { recursive: true });

    const graphRun = run("graph");
    assert.equal(graphRun.status, 0, graphRun.stderr);
    await assert.rejects(readFile(receiptPath, "utf8"), /ENOENT/);
    const graph = JSON.parse(await readFile(join(root, "artifacts", "graph.json"), "utf8"));
    assert.ok(graph.nodes.some((node: { id: string }) => node.id === "s:main.fixture#adapterSymbol"));
    assert.ok(graph.nodes.some((node: { id: string }) => node.id === "i:FIXTURE_STORE"));
    assert.ok(graph.nodes.some((node: { id: string }) => node.id === "fixture:guard"));
    assert.ok(graph.edges.some((edge: { id: string }) => edge.id === "fixture:guards"));
    assert.ok(graph.facts.some((fact: { id: string }) => fact.id === "fixture:mode"));

    const verifyRun = run("verify");
    assert.equal(verifyRun.status, 0, verifyRun.stderr);
    assert.match(verifyRun.stdout, /claims: 1 · 1 green/);
    assert.match(verifyRun.stdout, /diagnostics: 1 · 1 green/);
    assert.match(verifyRun.stdout, /✓ coherent/);
    await assert.rejects(readFile(receiptPath, "utf8"), /ENOENT/);

    const phrasebookRun = run("phrasebook");
    assert.equal(phrasebookRun.status, 0, phrasebookRun.stderr);
    assert.match(phrasebookRun.stdout, /fixture:boundary/);

    const commandRun = run("plugin", "fixture", "inspect", "alpha", "--check", "omega");
    assert.equal(commandRun.status, 0, commandRun.stderr);
    assert.match(commandRun.stdout, /fixture command args: \["alpha","--check","omega"\]/);
    assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), {
      root: await realpath(root),
      marker: "fixture-marker",
      args: ["alpha", "--check", "omega"],
    });

    const nonzeroRun = run("plugin", "fixture", "inspect", "--fail");
    assert.equal(nonzeroRun.status, 7, nonzeroRun.stderr);

    const unknownPlugin = run("plugin", "missing", "inspect");
    assert.equal(unknownPlugin.status, 2);
    assert.match(unknownPlugin.stderr, /Unknown plugin "missing"/);

    const unknownCommand = run("plugin", "fixture", "missing");
    assert.equal(unknownCommand.status, 2);
    assert.match(unknownCommand.stderr, /Plugin "fixture" has no command "missing"/);

    const inheritedCommand = run("plugin", "fixture", "toString");
    assert.equal(inheritedCommand.status, 2);
    assert.match(inheritedCommand.stderr, /Plugin "fixture" has no command "toString"/);
  } finally {
    await cleanup(parent);
  }
});

test("package — packed public declarations type-check a consuming repository plugin", async () => {
  const root = await tmpProject();
  const packageRoot = process.cwd();
  const cache = join(root, "npm-cache");
  const env = { ...process.env, npm_config_cache: cache };
  try {
    const packed = spawnSync(
      "npm",
      ["pack", "--json", "--pack-destination", root],
      { cwd: packageRoot, encoding: "utf8", env },
    );
    assert.equal(packed.status, 0, packed.stderr);
    const jsonStart = packed.stdout.indexOf("[");
    assert.notEqual(jsonStart, -1, packed.stdout);
    const metadata = JSON.parse(packed.stdout.slice(jsonStart))[0];
    assert.ok(metadata.files.some((file: { path: string }) => file.path === "dist/plugin.d.ts"));

    const consumer = join(root, "consumer");
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), JSON.stringify({
      name: "plugin-consumer",
      private: true,
      type: "module",
    }));
    await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "es2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        skipLibCheck: true,
      },
      include: ["plugin.ts"],
    }));
    await writeFile(join(consumer, "plugin.ts"), `
import type { CoherencePluginModule } from "coherence-harness/plugin";

interface Options { marker: string }

const plugin: CoherencePluginModule<Options> = {
  apiVersion: 1,
  name: "consumer",
  create() {
    return {
      commands: {
        inspect(context, args) {
          const marker: string | undefined = context.options?.marker;
          const first: string | undefined = args[0];
          return marker && first ? 0 : undefined;
        }
      }
    };
  }
};

export default plugin;
`);
    const tarball = join(root, metadata.filename);
    const installed = spawnSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      { cwd: consumer, encoding: "utf8", env },
    );
    assert.equal(installed.status, 0, installed.stderr);
    const typed = spawnSync(
      join(packageRoot, "node_modules", ".bin", "tsc"),
      ["-p", "tsconfig.json"],
      { cwd: consumer, encoding: "utf8" },
    );
    assert.equal(typed.status, 0, typed.stderr || typed.stdout);
  } finally {
    await cleanup(root);
  }
});
