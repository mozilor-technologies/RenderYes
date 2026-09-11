import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GraphQlCatalogDecisionsSchema } from "../src/graphql.js";

/**
 * A format violation must read as prose, not as the validator's own JSON.
 *
 * `GraphQlCatalogDecisionsSchema.parse` throws a `ZodError` whose `.message` is
 * a dump of its `issues` array, and the CLI printed it straight through — in a
 * tool whose every other error is written prose. A cold install hit this with
 * `semanticTypeOverrides` placed on a query entry, which is the reasonable
 * reading (every other control lives there) and is refused.
 *
 * The formatter lives in the CLI, which has no module exports, so it is read
 * out of the file rather than imported. That is deliberate: testing a copy of
 * the logic would prove nothing about what the CLI actually prints.
 */
function describeValidationIssues(error: unknown): string | undefined {
  const source = readFileSync(
    fileURLToPath(new URL("../bin/catalog.mjs", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf("const TOP_LEVEL_DECISION_KEYS");
  const end = source.indexOf("function fail(message)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const factory = new Function(
    `${source.slice(start, end)}; return describeValidationIssues;`,
  ) as () => (error: unknown) => string | undefined;
  return factory()(error);
}

function parseFailure(decisions: unknown): unknown {
  try {
    GraphQlCatalogDecisionsSchema.parse(decisions);
  } catch (error) {
    return error;
  }
  throw new Error("expected these decisions to be refused");
}

const QUERY = {
  capabilityId: "graphql.orders",
  approvedVisitorArguments: [],
  identityArguments: {},
  approvedOutputFields: ["id"],
  requiredOutputFields: ["id"],
  policy: { authentication: "public", maximumRows: 10, timeoutMs: 1_000, cacheTtlSeconds: 0 },
  limits: { maximumSelectionDepth: 3, maximumSelectedFields: 10 },
};

describe("decisions-file validation reads as prose", () => {
  it("names the top level when a top-level control is put on a query entry", () => {
    const error = parseFailure({
      schemaVersion: "1.0",
      reviewSourceHash: "x",
      queries: [{ ...QUERY, semanticTypeOverrides: { "Query.orders.total": "money" } }],
    });
    const text = describeValidationIssues(error);
    expect(text).toMatch(/"semanticTypeOverrides" at queries\[0\]/);
    expect(text).toMatch(/belongs at the top level/);
    // The raw validator output must not be what a host reads.
    expect(text).not.toMatch(/unrecognized_keys/);
    expect(text).not.toMatch(/^\s*\[/);
  });

  it("points an unknown key at the published schema rather than guessing", () => {
    const error = parseFailure({
      schemaVersion: "1.0",
      reviewSourceHash: "x",
      queries: [{ ...QUERY, approvedOutpuFields: ["id"] }],
    });
    expect(describeValidationIssues(error)).toMatch(/graphql-decisions\.schema\.json/);
  });

  it("falls back to the issue's own message for a plain type error", () => {
    const error = parseFailure({ schemaVersion: "1.0", reviewSourceHash: "x", queries: {} });
    const text = describeValidationIssues(error);
    expect(text).toMatch(/queries/);
    expect(text).not.toMatch(/unrecognized_keys/);
  });
});
