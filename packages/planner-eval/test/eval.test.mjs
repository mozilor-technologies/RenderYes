import assert from "node:assert/strict";
import test from "node:test";
import { compareToBaseline, formatBaselineComparison } from "../dist/index.js";

/**
 * Guards on the two ways a baseline diff can quietly mislead: comparing across
 * models, and reading an average that hides a churned suite.
 */

test("a baseline diff across different models refuses rather than misleads", () => {
  // A provider can change the model behind a name without telling anyone. A
  // diff across two models attributes their change to ours, which is the most
  // expensive wrong conclusion this harness can produce because it looks like
  // evidence.
  const report = {
    runs: 3,
    resolution: 1 / 3,
    cases: [{ id: "a", passRate: 1, firstAttemptValidRate: 1 }],
    totals: {},
    selectionDistribution: {},
    unstableCaseIds: [],
  };
  const baseline = {
    runs: 3,
    model: { providerId: "openai", modelId: "gpt-5.6" },
    cases: { a: { passRate: 1, firstAttemptValidRate: 1 } },
  };

  const comparison = compareToBaseline(report, baseline, {
    model: { providerId: "openai", modelId: "gpt-5.7" },
  });
  assert.ok(comparison.modelMismatch);
  assert.equal(comparison.modelMismatch.baseline, "openai:gpt-5.6");
  assert.equal(comparison.modelMismatch.current, "openai:gpt-5.7");

  const matched = compareToBaseline(report, baseline, {
    model: { providerId: "openai", modelId: "gpt-5.6" },
  });
  assert.equal(matched.modelMismatch, undefined);
});

test("the flip table counts cases that moved, not the average that hides them", () => {
  // Five improving and four regressing nets out to "slightly better" while
  // half the suite moved. Per-case counts are what say whether a change helped
  // or merely rearranged the failures.
  const report = {
    runs: 3,
    resolution: 1 / 3,
    cases: [
      { id: "improved", passRate: 1, firstAttemptValidRate: 1 },
      { id: "regressed", passRate: 0, firstAttemptValidRate: 0 },
      { id: "unchanged", passRate: 2 / 3, firstAttemptValidRate: 1 },
    ],
    totals: {},
    selectionDistribution: {},
    unstableCaseIds: [],
  };
  const baseline = {
    runs: 3,
    cases: {
      improved: { passRate: 0, firstAttemptValidRate: 0 },
      regressed: { passRate: 1, firstAttemptValidRate: 1 },
      unchanged: { passRate: 2 / 3, firstAttemptValidRate: 1 },
    },
  };

  const comparison = compareToBaseline(report, baseline);
  assert.equal(comparison.strictlyBetter, 1);
  assert.equal(comparison.strictlyWorse, 1);
  assert.equal(comparison.flips.length, 3);

  // Reported in whole runs: "0.67 -> 0.33" reads very differently from "2/3 -> 1/3".
  const improved = comparison.flips.find((flip) => flip.id === "improved");
  assert.equal(improved.before, 0);
  assert.equal(improved.after, 3);

  const table = formatBaselineComparison(comparison, 3);
  assert.match(table, /1 better · 1 worse · 1 unchanged/);
  // Moved cases appear; the unchanged one is not what anyone opened this for.
  assert.match(table, /improved/);
  assert.match(table, /regressed/);
});
