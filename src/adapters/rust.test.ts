/**
 * The Rust adapter over a small crate written into a temporary folder and
 * read by a real rust-analyzer: a library and a binary, a kernel module with
 * a private child module holding a pub fn, items at every visibility
 * (private, pub(super), pub(in …), pub(crate), pub), a #[cfg(test)] module
 * beside the chokepoint, and an integration test under tests/. The ladder,
 * the grades, the test marker, the refutation through unsaved overlays and
 * the disk it must leave alone, the quiescence barrier (through a controlled
 * client), forget, and where rust-analyzer is found. A missing rust-analyzer
 * is a test failure, never a skipped check: rustup component add
 * rust-analyzer rust-src.
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
import { locateRustAnalyzer } from "./installed.ts";
import { RUST_LADDER, RustAdapter, locateServer, marksTest, readHeader, scopeOf, useForm, type RustLanguageClient } from "./rust.ts";

const CARGO = `[package]
name = "fixture"
version = "0.1.0"
edition = "2021"

[dependencies]
`;

const LIB = `pub mod kernel;
pub mod app;
mod hidden;
`;

const MAIN = `fn main() {
    println!("{}", fixture::app::run());
}
`;

const KERNEL = `mod inner;

/// The chokepoint.
pub fn write_class(x: u32) -> u32 {
    private_policy(x) + inner::deep(x)
}

fn private_policy(x: u32) -> u32 {
    x + 1
}

pub(crate) fn crate_policy(x: u32) -> u32 {
    x * 2
}

pub(super) fn super_policy() -> u32 {
    0
}

pub fn public_policy() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_policy_adds() {
        assert_eq!(private_policy(1), 2);
    }
}
`;

const INNER = `pub fn deep(x: u32) -> u32 {
    x * 3
}

pub(super) fn sealed() -> u32 {
    7
}

pub(in crate::kernel) fn scoped() -> u32 {
    sealed() + 1
}
`;

const APP = `use crate::kernel::write_class;

pub fn run() -> u32 {
    write_class(3) + crate::kernel::crate_policy(1)
}
`;

const HIDDEN = `pub fn h() -> u32 {
    1
}
`;

const IT = `#[test]
fn write_class_adds() {
    assert_eq!(fixture::kernel::write_class(1), 5);
}
`;

let root: string;
let adapter: RustAdapter;
const hint = { component: ".", testFolders: readEnforcementConfig("/nowhere").testFolders };
const serverPresent = locateServer(process.cwd()).found;

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

function definitionOf(resolved: Awaited<ReturnType<RustAdapter["resolve"]>>): Definition {
  assert.ok(resolved.ok, JSON.stringify(resolved));
  return resolved.definition;
}

/** Every file of the crate but Cargo's build folder, with its bytes: what a refutation must leave as it found it. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (relative(root, path) !== "target") walk(path);
      } else out.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return out;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "coherence-rust-"));
  write("coherence.config.json", JSON.stringify({ language: "rust" }));
  write("Cargo.toml", CARGO);
  write("src/lib.rs", LIB);
  write("src/main.rs", MAIN);
  write("src/kernel/mod.rs", KERNEL);
  write("src/kernel/inner.rs", INNER);
  write("src/app.rs", APP);
  write("src/hidden.rs", HIDDEN);
  write("tests/it.rs", IT);
  adapter = new RustAdapter(root);
});

after(async () => {
  await adapter.close();
  rmSync(root, { recursive: true, force: true });
});

test("rust-analyzer is found, or its absence names each place looked", () => {
  assert.ok(serverPresent, "rust-analyzer must be installed: rustup component add rust-analyzer rust-src");
  const fake = mkdtempSync(join(tmpdir(), "coherence-rust-proxy-"));
  try {
    // rustup's proxy exists at ~/.cargo/bin without the component and fails only when run, as rustup which does.
    const proxy = `#!/bin/sh\necho "error: Unknown binary 'rust-analyzer' in official toolchain 'stable-x86_64-unknown-linux-gnu'" >&2\nexit 1\n`;
    for (const bin of ["rust-analyzer", "rustup"]) {
      writeFileSync(join(fake, bin), proxy, "utf8");
      chmodSync(join(fake, bin), 0o755);
    }
    const absent = locateRustAnalyzer(fake, "rust-analyzer", { PATH: fake });
    assert.equal(absent.found, false);
    assert.equal(absent.looked.length, 3, absent.looked.join("; "));
    assert.equal(absent.looked[0], "COHERENCE_RUST_ANALYZER: unset");
    assert.match(absent.looked[1]!, /^rustup which rust-analyzer: error: Unknown binary 'rust-analyzer'/);
    assert.match(absent.looked[2]!, /^rust-analyzer on PATH \(.*\): a rustup proxy without the rust-analyzer component/);

    const none = locateRustAnalyzer(fake, "rust-analyzer", { PATH: join(fake, "nowhere"), COHERENCE_RUST_ANALYZER: join(fake, "missing") });
    assert.equal(none.found, false);
    assert.deepEqual(none.looked, [`COHERENCE_RUST_ANALYZER (${join(fake, "missing")}): no such file`, "rustup which rust-analyzer: no rustup on PATH", "rust-analyzer on PATH: none"]);

    const real = locateServer(root);
    assert.ok(real.found);
    const named = locateRustAnalyzer(fake, "rust-analyzer", { PATH: fake, COHERENCE_RUST_ANALYZER: real.path });
    assert.ok(named.found && named.path === real.path, "an explicit path is taken first");
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test("the header, the use form and the scope are read from the text alone", () => {
  assert.deepEqual(readHeader("/// Doc.\n#[cfg(test)]\n#[allow(dead_code)]\npub(crate) fn "), { attributes: ["cfg(test)", "allow(dead_code)"], visibility: "pub(crate)" });
  assert.deepEqual(readHeader("pub ( in crate::kernel ) fn "), { attributes: [], visibility: "pub(in crate::kernel)" });
  assert.deepEqual(readHeader("// pub fn\nfn "), { attributes: [], visibility: undefined });
  assert.ok(marksTest("cfg(test)") && marksTest("test") && marksTest("tokio::test") && !marksTest("cfg(feature = \"x\")"));

  const text = "use crate::a::{b, c::{d}, e};\npub use crate::f;\npub(crate) use crate::g as h;\nfn x() {\n    use crate::i;\n    i() + j()\n}\n";
  const at = (needle: string): number => text.indexOf(needle);
  assert.equal(useForm(text, at("b,")), "import");
  assert.equal(useForm(text, at("e}")), "import");
  assert.equal(useForm(text, at("f;")), "re-export");
  assert.equal(useForm(text, at("g as")), "re-export");
  assert.equal(useForm(text, at("i;")), "import");
  assert.equal(useForm(text, at("i()")), undefined);
  assert.equal(useForm(text, at("j()")), undefined);

  assert.deepEqual(scopeOf(undefined, ["kernel"]), { kind: "module", path: ["kernel"] });
  assert.deepEqual(scopeOf("pub(super)", ["kernel", "inner"]), { kind: "module", path: ["kernel"] });
  assert.deepEqual(scopeOf("pub(crate)", ["kernel"]), { kind: "module", path: [] });
  assert.deepEqual(scopeOf("pub(in crate::kernel)", ["kernel", "inner"]), { kind: "module", path: ["kernel"] });
  assert.deepEqual(scopeOf("pub(in super)", ["kernel", "inner"]), { kind: "module", path: ["kernel"] });
  assert.deepEqual(scopeOf("pub", ["kernel"]), { kind: "public" });
});

test("Rust grades: visibility-choked short of the crate, reference-choked for pub(crate) and pub, broken with a bypass, a #[cfg(test)] site is a test", { timeout: 300_000 }, async () => {
  const input = { chokepoint: "write_class", ...hint, root };
  // A private item: its module's subtree is its scope, and rustc refuses a path to it from the crate root.
  const choked = await checkChokepoint(adapter, { ...input, protects: "private_policy in src/kernel/mod.rs" });
  assert.equal(choked.grade, "visibility-choked", choked.reason);
  assert.equal(choked.enforcer, "the compiler (rustc)");
  assert.equal(choked.refutation, "refused by the language", choked.refutationAccount);
  assert.equal(choked.verdict, "pass", choked.reason);
  assert.match(choked.reason, /reachable within crate::kernel/);
  assert.equal(choked.counts.test, 1, "the #[cfg(test)] use beside the chokepoint is a test reference");

  // A pub fn of a private module stops short of the crate too.
  const deep = await checkChokepoint(adapter, { ...input, protects: "deep" });
  assert.equal(deep.grade, "visibility-choked", deep.reason);
  assert.equal(deep.refutation, "refused by the language", deep.refutationAccount);

  // pub(crate) used outside the chokepoint: broken, with the bypass named.
  const broken = await checkChokepoint(adapter, { ...input, protects: "crate_policy" });
  assert.equal(broken.grade, "broken");
  assert.equal(broken.verdict, "fail");
  assert.deepEqual(broken.bypasses, [{ file: "src/app.rs", line: 4, symbol: "run" }]);

  // pub with no reference: reference-choked, and the staged re-export and same-module use are each a bypass.
  const clean = await checkChokepoint(adapter, { ...input, protects: "public_policy" });
  assert.equal(clean.grade, "reference-choked", clean.reason);
  assert.equal(clean.enforcer, "Coherence's check at the edit and in CI");
  assert.equal(clean.refutation, "automatic", clean.refutationAccount);
  assert.equal(clean.verdict, "pass");

  // Every scope on the ladder, read through the module chain.
  const scopeOfItem = async (name: string): Promise<string> => (await adapter.visibility(definitionOf(await adapter.resolve(name, hint)))).evidence;
  assert.match(await scopeOfItem("super_policy"), /^pub\(super\) super_policy in crate::kernel; reachable within crate$/);
  assert.match(await scopeOfItem("sealed"), /^pub\(super\) sealed in crate::kernel::inner; reachable within crate::kernel$/);
  assert.match(await scopeOfItem("scoped"), /^pub\(in crate::kernel\) scoped in crate::kernel::inner; reachable within crate::kernel$/);
  assert.match(await scopeOfItem("h"), /^pub h in crate::hidden; reachable within crate$/);
  assert.match(await scopeOfItem("public_policy"), /^pub public_policy in crate::kernel; reachable within outside the crate$/);
  for (const [name, top] of [["sealed", true], ["scoped", true], ["super_policy", false], ["h", false], ["public_policy", false]] as const) {
    const seen = await adapter.visibility(definitionOf(await adapter.resolve(name, hint)));
    assert.equal(seen.rung?.grade, top ? "visibility-choked" : "reference-choked", `${name}: ${seen.evidence}`);
    assert.equal(seen.visible, !top);
  }

  // The test marker: the #[cfg(test)] module in the chokepoint's own file is a test, the integration test by its folder.
  const protectedThing = definitionOf(await adapter.resolve("private_policy", hint));
  const chokepoint = definitionOf(await adapter.resolve("write_class", hint));
  const sites = await adapter.references(protectedThing);
  assert.deepEqual(
    sites.map((s) => `${s.file}:${s.line} ${s.symbol} ${s.test === true ? "marked" : "-"} ${classifySite(s, protectedThing, chokepoint, hint.testFolders)}`),
    ["src/kernel/mod.rs:5 write_class - inside", "src/kernel/mod.rs:30 tests.private_policy_adds marked test"],
  );
  const callers = await adapter.references(chokepoint);
  assert.deepEqual(callers.map((s) => `${s.file}:${s.line}${s.form === undefined ? "" : ` ${s.form}`}`), ["src/app.rs:1 import", "src/app.rs:4", "tests/it.rs:3"]);

  // A module path and a folder resolve to their files.
  assert.equal(definitionOf(await adapter.resolve("src/kernel/", hint)).file, "src/kernel/mod.rs");
  assert.equal(definitionOf(await adapter.resolve("./", hint)).file, "src/lib.rs");
  assert.equal(definitionOf(await adapter.resolve("src/kernel/inner.rs", hint)).kind, "module");
});

test("a Rust refutation stages an overlay pair, is seen or refused, and leaves the disk and the reference set unchanged", { timeout: 300_000 }, async () => {
  const before = snapshot();
  const chokepoint = definitionOf(await adapter.resolve("write_class", hint));
  const privateItem = definitionOf(await adapter.resolve("private_policy", hint));
  const publicItem = definitionOf(await adapter.resolve("public_policy", hint));
  const sitesBefore = [await adapter.references(privateItem), await adapter.references(publicItem), await adapter.references(chokepoint)];

  const refused = await adapter.refute(privateItem, chokepoint);
  assert.equal(refused.seen, true, refused.account);
  assert.match(refused.refused ?? "", /^rust-analyzer refused use crate::kernel::private_policy from the crate root: E0432/);

  const seen = await adapter.refute(publicItem, chokepoint);
  assert.equal(seen.seen, true, seen.account);
  assert.equal(seen.staged.length, 2);
  assert.deepEqual(seen.staged.map((s) => classifySite(s.site!, publicItem, chokepoint, hint.testFolders)), ["bypass", "bypass"]);
  assert.equal(seen.staged[0]!.site!.file, "src/kernel/mod.rs");
  assert.match(seen.staged[1]!.site!.file, /^src\/coherence_refutation_[0-9a-f]{8}\.rs$/);
  assert.equal(seen.staged[1]!.site!.form, "re-export");

  // Nothing written: every byte as it was, and the instrument answers what it answered before.
  assert.deepEqual(snapshot(), before);
  assert.deepEqual([await adapter.references(privateItem), await adapter.references(publicItem), await adapter.references(chokepoint)], sitesBefore);
});

test("a disk edit is seen after forget names the file", { timeout: 300_000 }, async () => {
  const publicItem = definitionOf(await adapter.resolve("public_policy", hint));
  assert.deepEqual(await adapter.references(publicItem), []);
  write("src/app.rs", `${APP}\npub fn sneak() -> u32 {\n    crate::kernel::public_policy()\n}\n`);
  try {
    await adapter.forget(["src/app.rs"]);
    assert.deepEqual((await adapter.references(publicItem)).map((s) => `${s.file}:${s.line} ${s.symbol}`), ["src/app.rs:8 sneak"]);
  } finally {
    write("src/app.rs", APP);
    await adapter.forget(["src/app.rs"]);
  }
  assert.deepEqual(await adapter.references(publicItem), []);
});

/** A stand-in for rust-analyzer that holds every answer back until the test says the server is quiescent. */
class ControlledRustClient implements RustLanguageClient {
  onNotification: RustLanguageClient["onNotification"];
  onRequest: RustLanguageClient["onRequest"];
  alive = true;
  configurationReply: unknown;
  private quiescent = false;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const uri = (rel: string): string => pathToFileURL(join(this.root, rel)).href;
    const target = { name: "TARGET", kind: 14, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 22 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } };
    switch (method) {
      case "initialize":
        this.configurationReply = await this.onRequest?.("workspace/configuration", { items: [{ section: "rust-analyzer" }] });
        return {} as T;
      case "workspace/symbol":
        return [{ name: "TARGET", kind: 14, location: { uri: uri("src/store.rs"), range: target.selectionRange } }] as T;
      case "textDocument/documentSymbol":
        return (String((params as { textDocument: { uri: string } }).textDocument.uri).endsWith("/src/store.rs") ? [target] : []) as T;
      case "textDocument/references":
        return [{ uri: uri("src/use.rs"), range: { start: { line: 0, character: 29 }, end: { line: 0, character: 35 } } }] as T;
      case "experimental/parentModule":
        return [{ targetUri: uri("Cargo.toml"), targetRange: target.range, targetSelectionRange: target.range }] as T;
      case "textDocument/diagnostic":
        return { kind: "full", items: [] } as T;
      case "shutdown":
        return null as T;
    }
    throw new Error(`unexpected request ${method}`);
  }

  notify(): void {}

  kill(): void {
    this.alive = false;
  }

  settle(): void {
    if (this.quiescent) return;
    this.quiescent = true;
    this.onNotification?.("experimental/serverStatus", { health: "ok", quiescent: true, message: null });
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

test("Rust waits for rust-analyzer's quiescent status before resolution, references and refutation", { timeout: 10_000 }, async () => {
  const controlledRoot = mkdtempSync(join(tmpdir(), "coherence-rust-quiescence-"));
  mkdirSync(join(controlledRoot, "src"), { recursive: true });
  writeFileSync(join(controlledRoot, "Cargo.toml"), CARGO, "utf8");
  writeFileSync(join(controlledRoot, "src/store.rs"), "const TARGET: u32 = 1;\n", "utf8");
  writeFileSync(join(controlledRoot, "src/use.rs"), "pub fn f() -> u32 { crate::store::TARGET }\n", "utf8");
  const client = new ControlledRustClient(controlledRoot);
  const controlled = new RustAdapter(controlledRoot, () => client);
  const definition: Definition = { name: "TARGET", kind: "symbol", file: "src/store.rs", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 22 } }, selection: { line: 0, character: 6 } };
  try {
    const resolution = controlled.resolve("TARGET", hint);
    const references = controlled.references(definition);
    const refutation = controlled.refute(definition, undefined);
    await assertStillPending(resolution, "resolution answered before rust-analyzer was quiescent");
    await assertStillPending(references, "references answered before rust-analyzer was quiescent");
    await assertStillPending(refutation, "the refutation staged before rust-analyzer was quiescent");
    const settings = (client.configurationReply as Record<string, unknown>[])[0]!;
    assert.equal(settings["checkOnSave"], false, "flycheck never runs cargo");
    assert.deepEqual(settings["workspace"], { symbol: { search: { kind: "all_symbols", scope: "workspace" } } });

    client.settle();
    assert.equal(definitionOf(await resolution).file, "src/store.rs");
    assert.deepEqual((await references).map((site) => `${site.file}:${site.line}`), ["src/use.rs:1"]);
    await refutation;
  } finally {
    client.settle();
    await controlled.close();
    rmSync(controlledRoot, { recursive: true, force: true });
  }
});

test("the Rust ladder names rustc for the top rung and Coherence's check below it", () => {
  assert.equal(new RustAdapter("/nowhere").ladder, RUST_LADDER);
  assert.deepEqual(RUST_LADDER.rungs.map((r) => `${r.grade}: ${r.enforcer}`), ["visibility-choked: the compiler (rustc)", "reference-choked: Coherence's check at the edit and in CI"]);
  assert.equal(RUST_LADDER.whenVacuous, undefined);
});
