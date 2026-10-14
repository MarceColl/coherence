/**
 * The Go adapter over a small module written into a temporary folder and read
 * by a real gopls: a package main, an api package, a store package holding an
 * item at each visibility (unexported, exported, exported under internal/,
 * an unexported method), an in-package _test.go and an external store_test
 * package. The ladder, the grades, the test files, the refutation through
 * unsaved overlays and the disk it must leave alone, the quiescence barrier
 * (through a controlled client), forget, and where gopls is found. A missing
 * gopls is a test failure, never a skipped check: go install
 * golang.org/x/tools/gopls@latest.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { checkChokepoint, classifySite } from "../enforcement/check.ts";
import { readEnforcementConfig } from "../enforcement/config.ts";
import type { Definition } from "./adapter.ts";
import { GO_LADDER, GoAdapter, goScopeOf, isExported, locateServer, packageClause, readOnlyGoflags, refusesInternal, refusesName, type GoLanguageClient } from "./go.ts";
import { locateGopls } from "./installed.ts";

const GO_MOD = "module example.com/fixture\n\ngo 1.22\n";

const STORE = `package store

import "example.com/fixture/store/internal/keys"

// Write is the chokepoint.
func Write(v string) string {
	return write(v) + keys.Key
}

func write(v string) string {
	return v
}

// Policy is exported, and nothing outside the chokepoint uses it.
func Policy() int {
	return 1
}

// Shared is exported, and the api package uses it.
var Shared = 2

type Box struct{ n int }

func (b *Box) set(v int) { b.n = v }
`;

const KEYS = `package keys

const Key = "k"
`;

const STORE_TEST = `package store

import "testing"

func TestWrite(t *testing.T) {
	_ = write("x")
}
`;

const EXT_TEST = `package store_test

import (
	"testing"

	"example.com/fixture/store"
)

func TestShared(t *testing.T) {
	_ = store.Shared
}
`;

const API = `package api

import "example.com/fixture/store"

func Handle() int {
	return store.Shared + len(store.Write("a"))
}
`;

const MAIN = `package main

import "example.com/fixture/api"

func main() {
	api.Handle()
}
`;

let root: string;
let caches: string;
let adapter: GoAdapter;
const hint = { component: ".", testFolders: readEnforcementConfig("/nowhere").testFolders };
const serverPresent = locateServer(process.cwd()).found;

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

function definitionOf(resolved: Awaited<ReturnType<GoAdapter["resolve"]>>): Definition {
  assert.ok(resolved.ok, JSON.stringify(resolved));
  return resolved.definition;
}

/** Every file of the module, with its bytes: what a refutation must leave as it found it. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return out;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "coherence-go-"));
  // gopls's and go's caches go to a scratch folder, never the user's.
  caches = mkdtempSync(join(tmpdir(), "coherence-go-caches-"));
  process.env["GOPLSCACHE"] = join(caches, "gopls");
  process.env["GOCACHE"] = join(caches, "go-build");
  write("coherence.config.json", JSON.stringify({ language: "go" }));
  write("go.mod", GO_MOD);
  write("store/store.go", STORE);
  write("store/store_test.go", STORE_TEST);
  write("store/ext_test.go", EXT_TEST);
  write("store/internal/keys/keys.go", KEYS);
  write("api/api.go", API);
  write("cmd/app/main.go", MAIN);
  adapter = new GoAdapter(root);
});

after(async () => {
  await adapter.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(caches, { recursive: true, force: true });
});

test("gopls is found, or its absence names each place looked", () => {
  assert.ok(serverPresent, "gopls must be installed, with go on PATH: go install golang.org/x/tools/gopls@latest");
  const fake = mkdtempSync(join(tmpdir(), "coherence-gopls-fake-"));
  try {
    const none = locateGopls(fake, "gopls", { PATH: join(fake, "nowhere"), COHERENCE_GOPLS: join(fake, "missing") });
    assert.equal(none.found, false);
    assert.deepEqual(none.looked, [`COHERENCE_GOPLS (${join(fake, "missing")}): no such file`, "go env GOBIN GOPATH: no go on PATH", "gopls on PATH: none"]);

    // A go whose GOPATH holds no gopls, and a gopls on PATH that fails when run.
    writeFileSync(join(fake, "go"), `#!/bin/sh\nprintf '\\n%s\\n' "${join(fake, "gopath")}"\n`, "utf8");
    writeFileSync(join(fake, "gopls"), `#!/bin/sh\necho "gopls: broken install" >&2\nexit 1\n`, "utf8");
    for (const bin of ["go", "gopls"]) chmodSync(join(fake, bin), 0o755);
    const absent = locateGopls(fake, "gopls", { PATH: fake });
    assert.equal(absent.found, false);
    assert.deepEqual(absent.looked, ["COHERENCE_GOPLS: unset", `go install's gopls: none at ${join(fake, "gopath", "bin", "gopls")}`, `gopls on PATH (${join(fake, "gopls")}): gopls: broken install`]);

    const real = locateServer(root);
    assert.ok(real.found);
    const named = locateGopls(fake, "gopls", { PATH: fake, COHERENCE_GOPLS: real.path });
    assert.ok(named.found && named.path === real.path && named.args[0] === "serve", "an explicit path is taken first, and served over stdio");
    const noGo = locateGopls(fake, "gopls", { PATH: join(fake, "nowhere"), COHERENCE_GOPLS: real.path });
    assert.equal(noGo.found, false);
    assert.match(noGo.looked[noGo.looked.length - 1]!, /no go on PATH: gopls runs go list/);
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test("the name's case, the package clause and the scope are read from the text alone", () => {
  assert.ok(isExported("Write") && isExported("Ünicode") && !isExported("write") && !isExported("_x"));
  assert.equal(packageClause("//go:build linux\n\n/* doc */\npackage store // the store\n"), "store");
  assert.equal(packageClause("// package nope\n"), undefined);
  assert.deepEqual(goScopeOf(false, "store", "."), { kind: "package", dir: "store" });
  assert.deepEqual(goScopeOf(true, "store", "."), { kind: "public" });
  assert.deepEqual(goScopeOf(true, "store/internal/keys", "."), { kind: "subtree", dir: "store" });
  assert.deepEqual(goScopeOf(true, "internal/keys", "."), { kind: "module" }, "an internal/ at the module root reaches the whole module");
  assert.deepEqual(goScopeOf(true, "svc/a/internal/b/internal/c", "svc"), { kind: "subtree", dir: "svc/a/internal/b" }, "the last internal decides");
  assert.equal(readOnlyGoflags("-mod=mod -tags=x"), "-tags=x");
  assert.ok(refusesName({ code: "UndeclaredImportedName", message: "undefined: store.write" }) && refusesName({ code: "UnexportedName", message: "name write not exported by package store" }));
  assert.ok(refusesInternal({ message: "could not import example.com/fixture/store/internal/keys (invalid use of internal package \"example.com/fixture/store/internal/keys\")" }));
  assert.ok(!refusesName({ code: "BrokenImport", message: "could not import example.com/nowhere" }) && !refusesInternal({ message: "could not import example.com/nowhere" }));
});

test("Go grades: visibility-choked for an unexported name and an internal package, reference-choked for an exported name, broken with a bypass, a _test.go site is a test", { timeout: 300_000 }, async () => {
  const input = { chokepoint: "Write in store/store.go", ...hint, root };
  // An unexported function: its package is its scope, and the compiler refuses a use from another package.
  const choked = await checkChokepoint(adapter, { ...input, protects: "write in store/store.go" });
  assert.equal(choked.grade, "visibility-choked", choked.reason);
  assert.equal(choked.enforcer, "the compiler (go build)");
  assert.equal(choked.refutation, "refused by the language", choked.refutationAccount);
  assert.equal(choked.verdict, "pass", choked.reason);
  assert.match(choked.reason, /reachable within package example\.com\/fixture\/store/);
  assert.equal(choked.counts.test, 1, "the in-package _test.go use is a test reference");

  // An exported constant of an internal package below the module root: the go command refuses its import outside store/.
  const internal = await checkChokepoint(adapter, { ...input, protects: "Key" });
  assert.equal(internal.grade, "visibility-choked", internal.reason);
  assert.equal(internal.refutation, "refused by the language", internal.refutationAccount);
  assert.match(internal.refutationAccount ?? "", /internal package/);

  // An exported variable used outside the chokepoint: broken, with the bypass named; the external test package is a test.
  const broken = await checkChokepoint(adapter, { ...input, protects: "Shared" });
  assert.equal(broken.grade, "broken");
  assert.equal(broken.verdict, "fail");
  assert.deepEqual(broken.bypasses, [{ file: "api/api.go", line: 6, symbol: "Handle" }]);
  assert.equal(broken.counts.test, 1);

  // An exported function with no reference: reference-choked, and the staged outside package and same-file use are each a bypass.
  const clean = await checkChokepoint(adapter, { ...input, protects: "Policy" });
  assert.equal(clean.grade, "reference-choked", clean.reason);
  assert.equal(clean.enforcer, "Coherence's check at the edit and in CI");
  assert.equal(clean.refutation, "automatic", clean.refutationAccount);
  assert.equal(clean.verdict, "pass");

  // Every scope, read from the name and the import path.
  const evidenceOf = async (name: string): Promise<string> => (await adapter.visibility(definitionOf(await adapter.resolve(name, hint)))).evidence;
  assert.equal(await evidenceOf("write"), "unexported write in package example.com/fixture/store; reachable within package example.com/fixture/store");
  assert.equal(await evidenceOf("Key"), "exported Key in package example.com/fixture/store/internal/keys; reachable within the tree under example.com/fixture/store");
  assert.equal(await evidenceOf("Policy"), "exported Policy in package example.com/fixture/store; reachable within every importer");
  assert.equal(await evidenceOf("set"), "unexported Box.set in package example.com/fixture/store; reachable within package example.com/fixture/store");

  // A method has no package-level name, so its refutation is not run.
  const method = await adapter.refute(definitionOf(await adapter.resolve("set", hint)), undefined);
  assert.equal(method.seen, false);
  assert.match(method.account, /method or field of Box/);

  // The sites: the chokepoint's own use is inside, the _test.go uses are tests by their file name.
  const protectedThing = definitionOf(await adapter.resolve("write", hint));
  const chokepoint = definitionOf(await adapter.resolve("Write in store/store.go", hint));
  assert.deepEqual(
    (await adapter.references(protectedThing)).map((s) => `${s.file}:${s.line} ${s.symbol} ${classifySite(s, protectedThing, chokepoint, hint.testFolders)}`),
    ["store/store_test.go:6 TestWrite test", "store/store.go:7 Write inside"],
  );
  assert.deepEqual((await adapter.references(chokepoint)).map((s) => `${s.file}:${s.line}${s.form === undefined ? "" : ` ${s.form}`}`), ["api/api.go:6"]);

  // A file is a module; a package folder has no owner file and is refused with a reason.
  assert.equal(definitionOf(await adapter.resolve("store/store.go", hint)).kind, "module");
  const folder = await adapter.resolve("store/", hint);
  assert.ok(!folder.ok && /package folder/.test(folder.reason), JSON.stringify(folder));
});

test("a Go refutation stages unsaved files, is seen or refused, and leaves the disk and the reference set unchanged", { timeout: 300_000 }, async () => {
  const before = snapshot();
  const chokepoint = definitionOf(await adapter.resolve("Write in store/store.go", hint));
  const privateItem = definitionOf(await adapter.resolve("write", hint));
  const publicItem = definitionOf(await adapter.resolve("Policy", hint));
  const sitesBefore = [await adapter.references(privateItem), await adapter.references(publicItem), await adapter.references(chokepoint)];

  const refused = await adapter.refute(privateItem, chokepoint);
  assert.equal(refused.seen, true, refused.account);
  assert.match(refused.refused ?? "", /^gopls refused var _ = coherence_target\.write from package example\.com\/fixture\/cmd\/app: UndeclaredImportedName undefined: coherence_target\.write/);

  const seen = await adapter.refute(publicItem, chokepoint);
  assert.equal(seen.seen, true, seen.account);
  assert.equal(seen.staged.length, 2);
  assert.deepEqual(seen.staged.map((s) => classifySite(s.site!, publicItem, chokepoint, hint.testFolders)), ["bypass", "bypass"]);
  assert.equal(seen.staged[0]!.site!.file, "store/store.go");
  assert.match(seen.staged[1]!.site!.file, /^coherence_refutation_[0-9a-f]{8}\/coherence_refutation_[0-9a-f]{8}\.go$/);

  // Nothing written: every byte as it was, and the instrument answers what it answered before.
  assert.deepEqual(snapshot(), before);
  assert.deepEqual([await adapter.references(privateItem), await adapter.references(publicItem), await adapter.references(chokepoint)], sitesBefore);
});

test("a disk edit is seen after forget names the file", { timeout: 300_000 }, async () => {
  const publicItem = definitionOf(await adapter.resolve("Policy", hint));
  assert.deepEqual(await adapter.references(publicItem), []);
  write("api/api.go", `${API}\nfunc Sneak() int {\n\treturn store.Policy()\n}\n`);
  try {
    await adapter.forget(["api/api.go"]);
    assert.deepEqual((await adapter.references(publicItem)).map((s) => `${s.file}:${s.line} ${s.symbol}`), ["api/api.go:10 Sneak"]);
  } finally {
    write("api/api.go", API);
    await adapter.forget(["api/api.go"]);
  }
  assert.deepEqual(await adapter.references(publicItem), []);
});

/** A stand-in for gopls that holds every answer back until the test ends its package load. */
class ControlledGoClient implements GoLanguageClient {
  onNotification: GoLanguageClient["onNotification"];
  onRequest: GoLanguageClient["onRequest"];
  alive = true;
  configurationReply: unknown;
  private loaded = false;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const uri = (rel: string): string => pathToFileURL(join(this.root, rel)).href;
    const target = { name: "Target", kind: 14, range: { start: { line: 2, character: 6 }, end: { line: 2, character: 16 } }, selectionRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 12 } } };
    switch (method) {
      case "initialize":
        this.configurationReply = await this.onRequest?.("workspace/configuration", { items: [{ section: "gopls" }] });
        this.onNotification?.("$/progress", { token: "load", value: { kind: "begin", title: "Setting up workspace", message: "Loading packages..." } });
        return {} as T;
      case "workspace/symbol":
        return [{ name: "Target", kind: 14, location: { uri: uri("store/store.go"), range: target.selectionRange } }] as T;
      case "textDocument/documentSymbol":
        return (String((params as { textDocument: { uri: string } }).textDocument.uri).endsWith("/store/store.go") ? [target] : []) as T;
      case "textDocument/references":
        return [{ uri: uri("use/use.go"), range: { start: { line: 4, character: 15 }, end: { line: 4, character: 21 } } }] as T;
      case "shutdown":
        return null as T;
    }
    throw new Error(`unexpected request ${method}`);
  }

  notify(method: string): void {
    if (method === "exit") this.alive = false;
  }

  kill(): void {
    this.alive = false;
  }

  /** End the package load, with gopls's own message for a load that worked or failed. */
  settle(message = "Finished loading packages."): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onNotification?.("$/progress", { token: "load", value: { kind: "end", message } });
  }
}

/** Fail promptly if a controlled operation settles before the test releases its barrier. */
async function assertStillPending(promise: Promise<unknown>, message: string): Promise<void> {
  const pending = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise<typeof pending>((resolvePending) => setTimeout(() => resolvePending(pending), 50)),
  ]);
  assert.equal(result, pending, message);
}

test("Go waits for gopls's package load before resolution, references and refutation", { timeout: 10_000 }, async () => {
  const controlledRoot = mkdtempSync(join(tmpdir(), "coherence-go-quiescence-"));
  mkdirSync(join(controlledRoot, "store"), { recursive: true });
  mkdirSync(join(controlledRoot, "use"), { recursive: true });
  writeFileSync(join(controlledRoot, "go.mod"), "module example.com/controlled\n\ngo 1.22\n", "utf8");
  writeFileSync(join(controlledRoot, "store/store.go"), "package store\n\nconst Target = 1\n", "utf8");
  writeFileSync(join(controlledRoot, "use/use.go"), 'package use\n\nimport "example.com/controlled/store"\n\nvar _ = store.Target\n', "utf8");
  const goflags = process.env["GOFLAGS"];
  process.env["GOFLAGS"] = "-mod=mod -tags=x";
  const client = new ControlledGoClient(controlledRoot);
  let started: Record<string, string> | undefined;
  const controlled = new GoAdapter(controlledRoot, (_command, _args, _cwd, env) => {
    started = env;
    return client;
  });
  const failing = new ControlledGoClient(controlledRoot);
  const failed = new GoAdapter(controlledRoot, () => failing);
  const definition: Definition = { name: "Target", kind: "symbol", file: "store/store.go", range: { start: { line: 2, character: 6 }, end: { line: 2, character: 16 } }, selection: { line: 2, character: 6 } };
  try {
    const resolution = controlled.resolve("Target", hint);
    const references = controlled.references(definition);
    const refutation = controlled.refute(definition, undefined);
    await assertStillPending(resolution, "resolution answered before gopls loaded the packages");
    await assertStillPending(references, "references answered before gopls loaded the packages");
    await assertStillPending(refutation, "the refutation staged before gopls loaded the packages");
    const settings = (client.configurationReply as Record<string, unknown>[])[0]!;
    assert.equal(settings["verboseWorkDoneProgress"], true, "every diagnosis is reported as progress");
    assert.equal(settings["symbolScope"], "workspace");
    assert.equal(started?.["GOFLAGS"], "-tags=x", "go list is never let rewrite go.mod");

    client.settle();
    assert.equal(definitionOf(await resolution).file, "store/store.go");
    assert.deepEqual((await references).map((site) => `${site.file}:${site.line}`), ["use/use.go:5"]);
    await refutation;

    // A load that failed is a reason, never an empty answer.
    const answer = failed.references(definition);
    await assertStillPending(answer, "references answered before gopls loaded the packages");
    failing.settle("Error loading packages: go: updates to go.mod needed");
    await assert.rejects(answer, /gopls reported Error loading packages: go: updates to go\.mod needed/);
  } finally {
    if (goflags === undefined) delete process.env["GOFLAGS"];
    else process.env["GOFLAGS"] = goflags;
    client.settle();
    failing.settle();
    await controlled.close();
    await failed.close();
    rmSync(controlledRoot, { recursive: true, force: true });
  }
});

test("the Go ladder names the compiler for the top rung and Coherence's check below it", () => {
  assert.equal(new GoAdapter("/nowhere").ladder, GO_LADDER);
  assert.deepEqual(GO_LADDER.rungs.map((r) => `${r.grade}: ${r.enforcer}`), ["visibility-choked: the compiler (go build)", "reference-choked: Coherence's check at the edit and in CI"]);
  assert.equal(GO_LADDER.whenVacuous, undefined);
});
