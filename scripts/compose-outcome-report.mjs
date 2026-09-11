#!/usr/bin/env node
// Read a host's `onComposeMetrics` log and answer one question: of the prompts
// people typed, how many became a view they could use?
//
// Usage: node scripts/compose-outcome-report.mjs <path-to-compose-metrics.jsonl>
//
// This exists because the project has been managed on latency and token
// numbers, which are the cost of the answer and say nothing about whether
// there was one. The only success figure anywhere is the eval corpus's, and it
// measures the deterministic offline planner against fixtures — a number that
// can be perfect while every real prompt fails.
//
// The distinction this report is built around: `outcome: "ready"` means the
// *planner* produced a valid plan. It does not mean the visitor saw anything.
// A plan whose every data request failed is still "ready", and renders a view
// of empty error slots. Counting those as successes is the metric agreeing
// with itself instead of measuring anything, so a ready compose is split by
// `failedRequestCount` and only the whole ones are called delivered.
//
// A host produces the input by writing one JSON object per compose from
// `ViewServerConfig.onComposeMetrics`. See `compose-metrics-report.mjs` for
// where the time and the tokens went; this one is about outcomes.

import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/compose-outcome-report.mjs <metrics.jsonl>");
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

const pct = (part, whole) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(0)}%`);

/**
 * Four outcomes, each a different party's problem — which is the whole reason
 * to separate them rather than report one failure rate:
 *
 *   unsupported     the catalog cannot answer this. The host approves more, or
 *                   the prompt is genuinely outside the site. Not a defect.
 *   invalid         the planner produced something that failed validation
 *                   three times running. Ours, and the expensive one.
 *   provider-error  the model or the network. Neither the catalog's fault nor
 *                   the planner's, and a retry may simply work.
 *   ready           a valid plan. Split below by whether the data arrived.
 */
const ready = rows.filter((row) => row.outcome === "ready");
const unsupported = rows.filter((row) => row.outcome === "unsupported");
const invalid = rows.filter((row) => row.outcome === "invalid");
const providerError = rows.filter((row) => row.outcome === "provider-error");

// A ready compose with no `failedRequestCount` predates the field. Reported as
// its own bucket rather than assumed whole: assuming would silently inflate
// the delivered rate on exactly the older logs where nothing can check it.
const unmeasured = ready.filter((row) => typeof row.failedRequestCount !== "number");
const measured = ready.filter((row) => typeof row.failedRequestCount === "number");
const whole = measured.filter((row) => row.failedRequestCount === 0);
const partial = measured.filter(
  (row) => row.failedRequestCount > 0 && row.failedRequestCount < (row.capabilityCount ?? 0),
);
const empty = measured.filter(
  (row) => row.capabilityCount > 0 && row.failedRequestCount >= row.capabilityCount,
);

console.log(`\n${rows.length} prompts in ${path}`);
if (unparsed > 0) console.log(`  (${unparsed} unparsable line(s) skipped)`);

console.log("\nWhat happened to them");
console.log(`  delivered a whole view      ${whole.length.toString().padStart(5)}  ${pct(whole.length, rows.length)}`);
console.log(`  delivered a partial view    ${partial.length.toString().padStart(5)}  ${pct(partial.length, rows.length)}`);
console.log(`  planned, no data arrived    ${empty.length.toString().padStart(5)}  ${pct(empty.length, rows.length)}`);
if (unmeasured.length > 0) {
  console.log(
    `  planned, data unmeasured    ${unmeasured.length.toString().padStart(5)}  ${pct(unmeasured.length, rows.length)}  (logged before failedRequestCount existed)`,
  );
}
console.log(`  catalog could not answer    ${unsupported.length.toString().padStart(5)}  ${pct(unsupported.length, rows.length)}`);
console.log(`  planner produced garbage    ${invalid.length.toString().padStart(5)}  ${pct(invalid.length, rows.length)}`);
console.log(`  model or network failed     ${providerError.length.toString().padStart(5)}  ${pct(providerError.length, rows.length)}`);

// The headline. Deliberately the strictest reading: a partial view is a view
// with a hole in it, and calling it a success is how a system reports health
// while its users work around it.
console.log(
  `\n  ${pct(whole.length, rows.length)} of prompts produced a complete view.`,
);

if (unsupported.length > 0) {
  console.log(
    `\n${unsupported.length} prompt(s) the catalog could not answer. This is the one bucket that\n` +
      "is not necessarily a defect — but it is the bucket that grows when the\n" +
      "catalog is under-approved, and it is invisible from the server logs alone.\n" +
      "The prompts themselves are not in this file by design; a host wanting to act\n" +
      "on them has to log the reasons their planner returned.",
  );
}

if (empty.length > 0 || partial.length > 0) {
  console.log(
    `\n${empty.length + partial.length} plan(s) validated and then lost data. That is an upstream or a binding\n` +
      "problem, not a planner one — run the catalog probe (POST /api/catalog/probe)\n" +
      "against the same catalog to see which capabilities are broken.",
  );
}

// Cache hits are excluded from nothing here on purpose: a visitor who got a
// view from the plan cache got a view. The cache split matters for cost, which
// is the other script's subject.
const cached = rows.filter((row) => row.cached === true).length;
if (cached > 0) {
  console.log(
    `\n${cached} of these were served from the plan cache. Counted as prompts and as\n` +
      "outcomes, because a visitor who got a view got a view.",
  );
}

// By catalog, when there is more than one — a single bad catalog dragging an
// otherwise working system down is invisible in an aggregate.
const byCatalog = new Map();
for (const row of rows) {
  const key = row.catalogId ?? "(no catalog id)";
  if (!byCatalog.has(key)) byCatalog.set(key, []);
  byCatalog.get(key).push(row);
}
if (byCatalog.size > 1) {
  console.log("\nBy catalog");
  for (const [catalogId, catalogRows] of byCatalog) {
    const delivered = catalogRows.filter(
      (row) => row.outcome === "ready" && row.failedRequestCount === 0,
    ).length;
    console.log(
      `  ${catalogId.padEnd(28)} ${pct(delivered, catalogRows.length)} complete   (n=${catalogRows.length})`,
    );
  }
}
console.log();
