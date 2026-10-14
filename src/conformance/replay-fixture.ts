/**
 * A tiny instrumented project for the conformance tests: a counter whose bump
 * and reset log at their sites through the vendored client (a refusal logs
 * the same action, rejected, before it throws), a node:test suite that drives
 * it, a quint model of it, and the config conform reads. Built in a scratch
 * folder; the caller removes it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vendorClient } from "./vendor.ts";

/** The model of the counter, correct: each action a thin wrapper over pure updates, with the count after as its conformance fact. */
export const COUNTER_MODEL = `module Counter {
  var count: int

  pure def bumped(c: int, by: int): int = c + by
  // The values a bump's by may take, as its callers write them (one to five): a search and the guard probe draw from it.
  pure val domain_by = 1.to(5)

  action init = count' = 0

  action bump(by: int, count_after: int): bool = all {
    by > 0,
    by <= 3,
    count_after == bumped(count, by),
    count' = bumped(count, by),
  }

  action reset(count_after: int): bool = all {
    count > 0,
    count_after == 0,
    count' = 0,
  }

  action step = any {
    nondet by = 1.to(3).oneOf()
    nondet after = Set(bumped(count, by)).oneOf()
    bump(by, after),
    nondet after = Set(0).oneOf()
    reset(after),
  }

  val countNeverNegative = count >= 0
  val landmark_counted = count > 0
  val landmark_high = count >= 3
}
`;

/** Each deliberately wrong model, by what is wrong with it: every one must fail replay. */
export const WRONG_MODELS: Record<string, string> = {
  "a guard weakened": COUNTER_MODEL.replace("    by <= 3,\n", ""),
  "an update off by one": COUNTER_MODEL.replace("pure def bumped(c: int, by: int): int = c + by", "pure def bumped(c: int, by: int): int = c + by + 1"),
  "a renamed parameter": COUNTER_MODEL.replace("action bump(by: int, count_after: int): bool = all {\n    by > 0,\n    by <= 3,\n    count_after == bumped(count, by),\n    count' = bumped(count, by),", "action bump(amount: int, count_after: int): bool = all {\n    amount > 0,\n    amount <= 3,\n    count_after == bumped(count, amount),\n    count' = bumped(count, amount),").replace("bump(by, after)", "bump(by, after)"),
  "an action dropped": COUNTER_MODEL.replace(/  action reset\(count_after: int\): bool = all \{[\s\S]*?\n  \}\n\n/, "").replace("    nondet after = Set(0).oneOf()\n    reset(after),\n", ""),
  "a rejection the model accepts": COUNTER_MODEL.replace("    count > 0,\n    count_after == 0,", "    count_after == 0,"),
};

const COUNTER_CODE = `import { log } from "../../test/coherence/coherence-trace.ts";

export class Counter {
  count = 0;

  bump(by: number): void {
    if (by <= 0 || by > 3) {
      log("bump", { by }, { scopes: ["counter"], rejected: true });
      throw new Error("a bump is 1 to 3");
    }
    this.count += by;
    log("bump", { by, count_after: this.count }, { scopes: ["counter"] });
  }

  reset(): void {
    if (this.count === 0) {
      log("reset", {}, { scopes: ["counter"], rejected: true });
      throw new Error("nothing to reset");
    }
    this.count = 0;
    log("reset", { count_after: this.count }, { scopes: ["counter"] });
  }
}
`;

const COUNTER_TESTS = `import assert from "node:assert/strict";
import { test } from "node:test";
import { log } from "../../test/coherence/coherence-trace.ts";
import { Counter } from "./counter.ts";

test("bumps twice and resets", () => {
  const c = new Counter();
  c.bump(1);
  c.bump(2);
  log("audit", { n: 1 }, { scopes: ["audit"] });
  c.reset();
  assert.equal(c.count, 0);
});

test("refuses a bump over three", () => {
  const c = new Counter();
  c.bump(3);
  assert.throws(() => c.bump(5));
  assert.equal(c.count, 3);
});

test("refuses a reset of nothing", () => {
  const c = new Counter();
  assert.throws(() => c.reset());
});
`;

/** Write the counter project into a scratch folder and return its root. */
export function counterProject(model = COUNTER_MODEL): string {
  const root = mkdtempSync(join(tmpdir(), "coherence-counter-"));
  const files: Record<string, string> = {
    "coherence.config.json": JSON.stringify(
      {
        name: "counter",
        quint: { seed: "0x2a", maxSamples: 200, maxSteps: 8, verify: "off" },
        conformance: {
          testCommand: [process.execPath, "--disable-warning=ExperimentalWarning", "--test", "src/counter/counter.test.ts"],
          client: "test/coherence",
          models: { "src/counter": { scopes: ["counter"] } },
        },
      },
      null,
      2,
    ),
    "src/counter/Counter.spec.md": "# Counter\n\nA counter that bumps by one to three and resets.\nmodel: Counter.qnt\n\n## invariants\n",
    "src/counter/Counter.qnt": model,
    "src/counter/counter.ts": COUNTER_CODE,
    "src/counter/counter.test.ts": COUNTER_TESTS,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  vendorClient(root, "test/coherence", "write");
  return root;
}
