#!/usr/bin/env node
// Read a host's `onComposeMetrics` log and report where a compose spends its
// time and tokens.
//
// Usage: node scripts/compose-metrics-report.mjs <path-to-compose-metrics.jsonl>
//
// This exists because the 23-57s compose swing has been attributed by reading
// code, never by measurement. The repair loop resends the whole contract on
// every attempt, so two numbers decide what to build next and neither is known:
//
//   - the plan-versus-data split, which says whether to attack the planner or
//     push filtering into the upstream
//   - contract size per model call, which says whether the contract will still
//     fit at real catalog size, and therefore whether retrieval is needed
//
// A host produces the input by writing one JSON object per compose from
// `ViewServerConfig.onComposeMetrics`. Fields used here are exactly the ones
// that callback reports; anything else in the line is ignored.
//
// Note `inputTokens` is accumulated across a compose's attempts rather than
// per call, so contract size is `inputTokens / modelCalls`. Reading it as
// per-call would understate the contract by up to 3x on a repaired compose —
// precisely on the composes that cost the most.

import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/compose-metrics-report.mjs <metrics.jsonl>");
  process.exit(2);
}

const lines = (await readFile(path, "utf8"))
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const rows = [];
let unparsed = 0;
for (const line of lines) {
  try {
    rows.push(JSON.parse(line));
  } catch {
    unparsed += 1;
  }
}

if (rows.length === 0) {
  console.error(`No usable records in ${path}.`);
  process.exit(1);
}

const numbers = (key, from = rows) =>
  from.map((row) => row[key]).filter((value) => typeof value === "number");

const quantile = (values, q) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank rather than interpolated: these are wall-clock measurements of
  // real composes, and reporting a p90 that no compose actually took invites
  // exactly the misattribution this script exists to end.
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)];
};

const ms = (value) => (value === undefined ? "—" : `${(value / 1000).toFixed(1)}s`);
const count = (value) => (value === undefined ? "—" : value.toLocaleString());

const report = (label, values, format = ms) => {
  if (values.length === 0) {
    console.log(`  ${label.padEnd(22)} no data`);
    return;
  }
  const median = quantile(values, 0.5);
  const p90 = quantile(values, 0.9);
  const max = Math.max(...values);
  console.log(
    `  ${label.padEnd(22)} median ${format(median)}   p90 ${format(p90)}   max ${format(max)}   (n=${values.length})`,
  );
};

const outcomes = new Map();
for (const row of rows) outcomes.set(row.outcome, (outcomes.get(row.outcome) ?? 0) + 1);

// A cache hit made no model call, so it says nothing about planner cost and
// would drag every planning median toward zero.
const planned = rows.filter((row) => row.cached !== true);
const cachedCount = rows.length - planned.length;

/**
 * The offline provider answers from a fixture in microseconds and still
 * reports one "model call", so a log holding both it and a real provider mixes
 * two populations three orders of magnitude apart. In a real log 7 of 9 calls
 * had never touched a model, and the mock's near-zero planning times pulled the
 * planning share down to 11% — which printed "Data-dominated: push filters and
 * paging into the upstream". For the two real composes planning was 13.2s and
 * 20.0s, 97-99.9% of wall clock. The headline said the opposite of the truth.
 *
 * Every figure below is therefore reported per model, and the conclusion is
 * drawn per model. This is the same cross-population error the cache split
 * above already fixes once; a second axis needed the same treatment.
 */
const MOCK_MODEL_IDS = new Set(["deterministic-published-catalog-1"]);
const isMock = (row) => MOCK_MODEL_IDS.has(row.modelId);

const byModel = new Map();
for (const row of planned) {
  const key = row.modelId ?? "(no model id)";
  if (!byModel.has(key)) byModel.set(key, []);
  byModel.get(key).push(row);
}

console.log(`\n${rows.length} composes in ${path}`);
if (unparsed > 0) console.log(`  (${unparsed} unparsable line(s) skipped)`);
console.log(
  `  outcomes: ${[...outcomes].map(([outcome, n]) => `${outcome} ${n}`).join(", ")}`,
);
if (cachedCount > 0) {
  console.log(`  ${cachedCount} served from the plan cache, excluded from planning figures`);
}

const mockCount = planned.filter(isMock).length;
if (mockCount > 0) {
  console.log(
    `  ${mockCount} planned by the offline provider — reported separately below, ` +
      "never averaged with a real model",
  );
}

// `dataMs` is the one figure that does not depend on which planner ran, so it
// is the only one reported across the whole log.
console.log("\nData fetching (all composes)");
report("data", numbers("dataMs"));

for (const [modelId, modelRows] of byModel) {
  console.log(
    `\n── ${modelId}${MOCK_MODEL_IDS.has(modelId) ? "  (offline fixture, not a model)" : ""} — ${modelRows.length} compose(s)`,
  );

  console.log("\nWall clock");
  report("total", numbers("totalMs", modelRows));
  report("planning", numbers("planMs", modelRows));

  // Both figures come from the same rows, never from all of them: a cache hit
  // has a tiny total and no planning at all, and an offline plan has no model
  // latency, so mixing populations produces a share that describes nothing
  // that ever ran.
  const totals = numbers("totalMs", modelRows);
  const plans = numbers("planMs", modelRows);
  if (totals.length > 0 && plans.length > 0) {
    const share = (quantile(plans, 0.5) / quantile(totals, 0.5)) * 100;
    if (MOCK_MODEL_IDS.has(modelId)) {
      console.log(
        `\n  Planning is ~${share.toFixed(0)}% of a median compose — an offline fixture, ` +
          "so this says nothing about planner cost. Drawn no conclusion.",
      );
    } else {
      console.log(
        `\n  Planning is ~${share.toFixed(0)}% of a median compose. ` +
          (share >= 60
            ? "Planner-dominated: streaming hides this wait but does not shorten it — attack the repair loop and contract size."
            : "Data-dominated: pushing filters and paging into the upstream is the lever, and streaming delivers slots as they land."),
      );
    }
  }

  console.log("\nModel calls");
  report("calls per compose", numbers("modelCalls", modelRows), count);
  report("repairs per compose", numbers("repairCount", modelRows), count);

  const perCall = modelRows
    .filter((row) => typeof row.inputTokens === "number" && row.modelCalls > 0)
    .map((row) => Math.round(row.inputTokens / row.modelCalls));
  report("contract tokens/call", perCall, count);
  report("input tokens/compose", numbers("inputTokens", modelRows), count);
  report("output tokens/compose", numbers("outputTokens", modelRows), count);

  const repairs = numbers("repairCount", modelRows);
  if (repairs.length > 0) {
    const repaired = repairs.filter((value) => value > 0).length;
    console.log(
      `\n  ${repaired} of ${repairs.length} composes needed a repair. ` +
        "Each one resends the whole contract, so the token figures above are " +
        "roughly contract size times calls.",
    );
  }
}
console.log();
