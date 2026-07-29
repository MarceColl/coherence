import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadConfig } from "../src/config.ts";
import { buildGraph } from "../src/derive.ts";
import { loadProject } from "../src/plugins.ts";
import { graphAtRef, structuralLog, withTreeAt } from "../src/structural.ts";
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
    "plugin.ts": "export default { apiVersion: 1, name: 'future', create() { return { commands: {} }; } };\n",
  });
  const adapter = await tmpProject({
    "coherence.config.json": JSON.stringify({ plugins: [{ path: "plugin.ts" }] }),
    "plugin.ts": "export default { apiVersion: 1, name: 'typo', create() { return { adapters: { language: {} } }; } };\n",
  });
  try {
    await assert.rejects(loadProject(capability), /unsupported capability "commands"/);
    await assert.rejects(loadProject(adapter), /unsupported adapter capability "language"/);
  } finally {
    await cleanup(capability);
    await cleanup(adapter);
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
