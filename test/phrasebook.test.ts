// phrasebook.test.ts — the claim grammar-as-data registry. The engine (verify.ts) is now
// a thin loop over CLAIM_FORMS, so these lock the properties that loop depends on: the
// ORDER (= precedence, first match wins), that every historical form still matches its
// canonical line, and that a line matching nothing is a dialect-gap skip (never red). The
// `coherence phrasebook` verb renders straight from this registry, so its output must name
// every form (the README's generated authority).
import test from "node:test";
import assert from "node:assert/strict";
import { CLAIM_FORMS, parseClaim, parseWord, reEscape } from "../src/phrasebook.ts";

test("registry — order IS the historical precedence (typechecks → conforms to)", () => {
  assert.deepEqual(
    CLAIM_FORMS.map((f) => f.name),
    ["typechecks", "exists", "imports", "responds", "passes test", "boundary", "lives in", "parity", "conforms to"],
  );
});

test("registry — each form parses its own canonical example line", () => {
  for (const f of CLAIM_FORMS) {
    const m = f.parse(f.example);
    assert.ok(m, `form "${f.name}" should parse its own example: ${f.example}`);
  }
});

test("registry — first match wins: `typechecks` resolves to the typechecks form, not a later one", () => {
  const first = CLAIM_FORMS.find((f) => f.parse("typechecks"));
  assert.equal(first?.name, "typechecks");
});

test("registry — every canonical claim line matches exactly ONE form (no ambiguous grammar)", () => {
  const lines = [
    "typechecks",
    "wrangler.jsonc exists at root",
    "main.ts imports ./registry",
    'http://localhost:8787/health responds 200 with "ok"',
    'passes test "write policy totality"',
    'boundary "x" at Choke via guard "g"',
    'boundary "x" at Choke crossing agent-mcp -> storage via test "t"',
    "lives in owner-trusted",
    'parity "x" over DOMAIN between f and g via test "t"',
    "conforms to OwnedScope",
  ];
  for (const l of lines) {
    const hits = CLAIM_FORMS.filter((f) => f.parse(l));
    assert.equal(hits.length, 1, `"${l}" should match exactly one form, matched: ${hits.map((h) => h.name).join(", ")}`);
  }
});

test("dialect gap — a line matching no form is recognized by NONE (verify then skips it)", () => {
  const gibberish = "this is prose, not a claim";
  assert.equal(CLAIM_FORMS.filter((f) => f.parse(gibberish)).length, 0);
});

test("tiers — each form declares one of the four known tiers", () => {
  const tiers = new Set(["deterministic", "live", "executable", "hybrid"]);
  for (const f of CLAIM_FORMS) assert.ok(tiers.has(f.tier), `form "${f.name}" has an unknown tier ${f.tier}`);
});

// ── parseClaim — the normalized reading every SHARED consumer works from ──────────────
// One immutable ParsedClaim per line: identity (form/key), anchoring, named symbols,
// blessed file tokens, record-lookup text, and the named non-identity fields (detail).
// The ledger, novelty, tree, contracts, and claimKey all read THESE fields — so this
// table is the contract that makes a claim form first-class beyond verify.

test("parseClaim — every form normalizes its canonical line (the shared-plumbing table)", () => {
  const table: Array<[string, object]> = [
    ["typechecks", {
      form: "typechecks", key: "typechecks", anchors: [], symbols: [], files: [],
      record: "typechecks", detail: {},
    }],
    ["wrangler.jsonc exists at root", {
      form: "exists", key: "wrangler.jsonc exists at root", anchors: [], symbols: [],
      files: ["wrangler.jsonc"], record: "wrangler.jsonc exists at root",
      detail: { file: "wrangler.jsonc", where: "root" },
    }],
    ["main.ts imports ./registry", {
      form: "imports", key: "main.ts imports ./registry", anchors: [], symbols: [],
      files: ["main.ts"], record: "main.ts imports ./registry",
      detail: { file: "main.ts", specifier: "./registry" },
    }],
    ['http://localhost:8787/health responds 200 with "ok"', {
      form: "responds", key: 'http://localhost:8787/health responds 200 with "ok"',
      anchors: [], symbols: [], files: [],
      record: 'http://localhost:8787/health responds 200 with "ok"',
      detail: { url: "http://localhost:8787/health", status: "200", text: "ok" },
    }],
    ['passes test "write policy totality"', {
      form: "passes test", key: 'passes test "write policy totality"', anchors: [], symbols: [],
      files: [], record: 'passes test "write policy totality"',
      detail: { test: "write policy totality" },
    }],
    ["lives in owner-trusted", {
      form: "lives in", key: "lives in owner-trusted", anchors: [], symbols: [], files: [],
      record: "lives in owner-trusted", detail: { zone: "owner-trusted" },
    }],
    ['parity "disclosure faithfulness" over TOOL_NAMES between toolActivity and messageProvenance via test "live equals settled"', {
      form: "parity", key: "disclosure faithfulness", anchors: ["disclosure faithfulness"],
      symbols: ["TOOL_NAMES", "toolActivity", "messageProvenance"], files: [],
      record: 'parity "disclosure faithfulness" over TOOL_NAMES between toolActivity and messageProvenance via test "live equals settled"',
      detail: { domain: "TOOL_NAMES", f: "toolActivity", g: "messageProvenance", oracle: "live equals settled" },
    }],
    ["conforms to OwnedScope", {
      form: "conforms to", key: "conforms to OwnedScope", anchors: [], symbols: [], files: [],
      record: "conforms to OwnedScope", detail: { word: "OwnedScope" },
    }],
  ];
  for (const [line, expected] of table) {
    const r = parseClaim(line);
    assert.ok(r, `parseClaim should read: ${line}`);
    assert.deepEqual({ ...r!.claim, anchors: [...r!.claim.anchors], symbols: [...r!.claim.symbols], files: [...r!.claim.files], detail: { ...r!.claim.detail } }, expected, line);
    assert.equal(r!.form.name, r!.claim.form);
  }
});

test("parseClaim — boundary normalizes with the crossing stripped from record", () => {
  const line = 'boundary "fail-closed writes" at applyWritePolicy crossing agent-mcp -> storage via test "write policy totality"';
  const r = parseClaim(line);
  assert.equal(r!.form.name, "boundary");
  assert.deepEqual({ ...r!.claim, anchors: [...r!.claim.anchors], symbols: [...r!.claim.symbols], files: [...r!.claim.files], detail: { ...r!.claim.detail } }, {
    form: "boundary", key: "fail-closed writes",
    anchors: ["fail-closed writes"], symbols: ["applyWritePolicy"], files: [],
    record: 'boundary "fail-closed writes" at applyWritePolicy via test "write policy totality"',
    detail: { chokepoint: "applyWritePolicy", verb: "test", oracle: "write policy totality",
              crossingFrom: "agent-mcp", crossingTo: "storage" },
  });
});

test("parseClaim — a boundary without via/crossing omits those detail keys entirely", () => {
  const r = parseClaim('boundary "x" at applyWritePolicy');
  assert.deepEqual({ ...r!.claim.detail }, { chokepoint: "applyWritePolicy" });
  assert.equal(r!.claim.record, 'boundary "x" at applyWritePolicy');
});

test("parseClaim — an unmatched line is null (the dialect gap stays a gap)", () => {
  assert.equal(parseClaim("wibbles the frobnicator"), null);
});

test("parseClaim — the value is deeply frozen (append-only doctrine)", () => {
  const r = parseClaim('boundary "x" at Choke via guard "g"')!;
  assert.ok(Object.isFrozen(r.claim));
  assert.ok(Object.isFrozen(r.claim.anchors));
  assert.ok(Object.isFrozen(r.claim.symbols));
  assert.ok(Object.isFrozen(r.claim.files));
  assert.ok(Object.isFrozen(r.claim.detail));
});

test("parseWord — heading + intent + commitments; markdown escapes stripped", () => {
  const w = parseWord(
    ["# OwnedScope", "Reads and writes stay inside the owner's scope.", "", "## commitments", "- typechecks", '- boundary "scoped" at \\_query via guard "g"'].join("\n"),
  );
  assert.ok(w);
  assert.equal(w!.name, "OwnedScope");
  assert.equal(w!.intent, "Reads and writes stay inside the owner's scope.");
  assert.deepEqual(w!.commitments, ["typechecks", 'boundary "scoped" at _query via guard "g"']);
});

test("parseWord — no heading, or no `## commitments` section, is unparseable (null → RED)", () => {
  assert.equal(parseWord("just prose, no heading"), null);
  assert.equal(parseWord("# Word\nan intent but no commitments section"), null);
});

test("reEscape — regex metacharacters in a runner name are escaped to match literally", () => {
  // The runner's `-t <name>` is a regex; a name with `+`/parens must match the literal string.
  const name = "Patient send + transcript (v2)";
  const escaped = reEscape(name);
  assert.ok(new RegExp(escaped).test(name), "escaped name matches its own literal");
  // Every metacharacter is backslash-prefixed; the raw name would compile to a different pattern.
  assert.equal(escaped, "Patient send \\+ transcript \\(v2\\)");
});
