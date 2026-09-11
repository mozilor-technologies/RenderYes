import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTRACT_TOKEN_BUDGET,
  assertCapabilityCatalog,
  createPlannerManifest,
  describeContractCost,
  judgeContractCost,
} from "../src/index.js";

/**
 * What a catalog's planning contract costs, and whether the attribution is
 * right about which decision costs it.
 *
 * The reason to test the *ranking* rather than the total: the total was already
 * reported and was already correct, and it did not help anybody. The advice
 * shipped beside it named the projected field count, and these assertions are
 * how the record shows that advice was pointing at the wrong lever — the filter
 * vocabulary is several times larger than everything else combined, at every
 * catalog size measured.
 */

function catalogOf(
  capabilityCount: number,
  options: { fields?: number; filterable?: boolean } = {},
) {
  const fieldCount = options.fields ?? 12;
  const parts = Array.from({ length: capabilityCount }, (_, index) => {
    const fields: Record<string, { label: string; semanticType: string }> = {};
    const properties: Record<string, { type: string }> = {};
    for (let f = 0; f < fieldCount; f += 1) {
      fields[`field_${f}`] = {
        label: `Field ${f}`,
        semanticType: f % 3 === 0 ? "money" : f % 3 === 1 ? "text" : "date-time",
      };
      properties[`field_${f}`] = { type: f % 3 === 0 ? "number" : "string" };
    }
    const row = {
      type: "object" as const,
      additionalProperties: false,
      required: ["field_0"],
      properties,
    };
    return {
      dataType: {
        id: `type_${index}`,
        version: "1.0.0",
        description: `Data type ${index}.`,
        schema: { type: "array" as const, items: row },
        fields,
      },
      capability: {
        id: `cap.${index}`,
        version: "1.0.0",
        purpose: `Read collection ${index} from the upstream.`,
        kind: "query" as const,
        inputSchema: {
          type: "object" as const,
          additionalProperties: false,
          properties: { q: { type: "string" } },
        },
        outputSchema: { type: "array" as const, items: row },
        output: { dataTypeId: `type_${index}`, shape: "collection" as const },
        requiredSessionKeys: [],
        sourceIds: ["src"],
        supports: {
          ...(options.filterable === false ? {} : { filterFields: Object.keys(fields) }),
          sortFields: Object.keys(fields),
          groupFields: ["field_1"],
          aggregates: ["count", "sum", "average"] as const,
        },
        policy: { authentication: "public" as const, maximumRows: 50, timeoutMs: 2_000 },
      },
    };
  });
  // Through the real validator rather than a cast: a fixture that would not
  // publish is not a measurement of anything.
  return assertCapabilityCatalog({
    schemaVersion: "1.0",
    id: "measure",
    version: "1.0.0",
    description: "Measurement catalog.",
    dataTypes: parts.map((part) => part.dataType),
    sources: [{ id: "src", label: "Source" }],
    capabilities: parts.map((part) => part.capability),
    relationships: [],
  });
}

const costOf = (...args: Parameters<typeof catalogOf>) =>
  describeContractCost(createPlannerManifest(catalogOf(...args)));

describe("what the contract actually costs", () => {
  it("grows linearly with capability count", () => {
    // The fact that makes "publish everything the upstream can answer" a
    // non-option, and the one a host cannot see from a single number.
    const small = costOf(4);
    const large = costOf(16);
    const perCapability = (large.bytes - small.bytes) / 12;
    expect(perCapability).toBeGreaterThan(1_000);
    // Linear, not super-linear: four times the capabilities is within a few
    // percent of four times the bytes above the fixed frame.
    const ratio =
      (large.bytes - large.baselineBytes) / ((small.bytes - small.baselineBytes) * 4);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });

  it("names the filter vocabulary as the dominant cost, not the field count", () => {
    const cost = costOf(16);
    expect(cost.facets[0]!.facet).toBe("filterFields");
    // Measured at 3.68x everything else combined. Asserted as a floor rather
    // than an equality so the test survives a contract change that moves the
    // number without changing which lever is largest.
    expect(cost.facets[0]!.bytes / cost.bytes).toBeGreaterThan(0.6);

    // The lever the old advice named, measured against the one it did not.
    const twelveFields = costOf(16, { fields: 12 }).bytes;
    const fourFields = costOf(16, { fields: 4 }).bytes;
    const fieldSaving = (twelveFields - fourFields) / twelveFields;
    const filterSaving = cost.facets[0]!.bytes / cost.bytes;
    expect(fieldSaving).toBeLessThan(0.25);
    expect(filterSaving).toBeGreaterThan(fieldSaving * 2);
  });

  it("ranks capabilities so a host cutting a catalog down knows where to start", () => {
    const cost = costOf(8);
    expect(cost.capabilities).toHaveLength(8);
    for (let index = 1; index < cost.capabilities.length; index += 1) {
      expect(cost.capabilities[index - 1]!.bytes).toBeGreaterThanOrEqual(
        cost.capabilities[index]!.bytes,
      );
    }
  });

  it("attributes nothing to a facet the catalog does not advertise", () => {
    const cost = costOf(8, { filterable: false });
    expect(cost.facets.map((entry) => entry.facet)).not.toContain("filterFields");
    // And the floor is genuinely a floor: dropping every facet cannot cost more
    // than the contract that has them.
    expect(cost.baselineBytes).toBeLessThan(cost.bytes);
  });
});

describe("the cost against a budget", () => {
  it("stays quiet under budget and names the levers over it", () => {
    const under = judgeContractCost(costOf(2));
    expect(under.overBudget).toBe(false);
    expect(under.advice).toBeUndefined();

    const over = judgeContractCost(costOf(40));
    expect(over.overBudget).toBe(true);
    expect(over.budgetTokens).toBe(DEFAULT_CONTRACT_TOKEN_BUDGET);
    // Every part a host needs to act: the cost, the multiplier, the linear
    // lever with the heaviest capabilities named, and the facet with its bytes.
    expect(over.advice).toMatch(/over the 25000-token budget/);
    expect(over.advice).toMatch(/up to three/);
    expect(over.advice).toMatch(/Fewer capabilities is the linear lever/);
    expect(over.advice).toMatch(/cap\.\d+ \(\d+ B\)/);
    expect(over.advice).toMatch(/Dropping "filterFields"/);
    expect(over.advice).toMatch(/% of the\s*contract|% of the contract/);
  });

  it("honours a budget the host chose", () => {
    const cost = costOf(4);
    expect(judgeContractCost(cost, 1).overBudget).toBe(true);
    expect(judgeContractCost(cost, 10_000_000).overBudget).toBe(false);
  });
});

describe("the catalog id both halves are filed under", () => {
  it("refuses an id the UI catalog would reject", () => {
    // The third install typed a display name with spaces at a prompt that calls it a
    // durable storage key. It was accepted here, accepted by POST /api/catalog,
    // rewritten by the file store, and rejected only by POST /api/ui-catalog —
    // at which point nothing could ever render under it.
    expect(() => catalogOf(1)).not.toThrow();
    const bad = { ...catalogOf(1), id: "bharat times 2808" };
    expect(() => assertCapabilityCatalog(bad)).toThrow(/Catalog id must match/);
    expect(() => assertCapabilityCatalog({ ...catalogOf(1), id: "9lives" })).toThrow(
      /Catalog id must match/,
    );
    expect(() => assertCapabilityCatalog({ ...catalogOf(1), id: "a.b-c_d" })).not.toThrow();
  });
});

/**
 * The shape the measurement was blind to.
 *
 * Every fixture above declares `inputSchema: { q: { type: "string" } }`, and
 * against that the attribution was correct. A real host approves a filter
 * argument whose input type contains itself, the contract inlines it at every
 * level the depth limit allows, and on the install that found this it was 98%
 * of a 456,000-token contract — attributed to no facet, counted into the
 * "floor", and described in the advice as the part that responds to nothing.
 * Dropping the one argument was worth 51x what halving the capabilities was.
 */
function recursiveFilterSchema(depth: number): Record<string, unknown> {
  const leaf: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      ["title", "slug", "status", "publishedAt", "section"].map((field) => [
        field,
        {
          type: "object",
          additionalProperties: false,
          properties: {
            equals: { type: "string" },
            not_equals: { type: "string" },
            in: { type: "array", items: { type: "string" } },
            contains: { type: "string" },
          },
        },
      ]),
    ),
  };
  if (depth <= 0) return leaf;
  const nested = recursiveFilterSchema(depth - 1);
  return {
    ...leaf,
    properties: {
      ...(leaf.properties as Record<string, unknown>),
      AND: { type: "array", items: nested },
      OR: { type: "array", items: nested },
    },
  };
}

function catalogWithFilterArgument() {
  const base = catalogOf(6, { filterable: false });
  return assertCapabilityCatalog({
    ...base,
    capabilities: base.capabilities.map((capability) => ({
      ...capability,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { limit: { type: "number" }, where: recursiveFilterSchema(3) },
      },
    })),
  });
}

describe("cost carried by an approved argument, not by a supports facet", () => {
  it("attributes it to the argument instead of calling it an immovable floor", () => {
    const cost = describeContractCost(createPlannerManifest(catalogWithFilterArgument()));
    const where = cost.arguments.find((entry) => entry.argument === "where");
    expect(where).toBeDefined();
    expect(where!.bytes / cost.bytes).toBeGreaterThan(0.8);
    // The regression this pins: the floor must not contain what the argument
    // costs, or the advice describes a movable cost as immovable.
    expect(cost.baselineBytes / cost.bytes).toBeLessThan(0.2);
    expect(cost.arguments[0]!.argument).toBe("where");
  });

  it("names the argument and the control that narrows it, ahead of every facet", () => {
    const verdict = judgeContractCost(
      describeContractCost(createPlannerManifest(catalogWithFilterArgument())),
      1_000,
    );
    expect(verdict.overBudget).toBe(true);
    expect(verdict.advice).toMatch(/The "where" argument's own schema/);
    expect(verdict.advice).toMatch(/largest single lever/);
    expect(verdict.advice).toMatch(/approvedInputFields/);
    // What the install actually did, having been told capabilities were the
    // lever: cut from 9 to 4 and stayed 6.6x over budget.
    const advice = verdict.advice!;
    expect(advice.indexOf("where")).toBeLessThan(advice.indexOf("Fewer capabilities"));
  });
});
