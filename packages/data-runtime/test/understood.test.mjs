import assert from "node:assert/strict";
import test from "node:test";
import { createPlannerManifest } from "@renderyes/capability-catalog";
import {
  applyInputEdit,
  describeUnderstoodInputs,
  enumeratedInputs,
  missingRequiredInputs,
} from "@renderyes/data-runtime";

const REGIONS = ["Germany", "France", "California", "Utah"];
const LAW = {
  type: "object",
  additionalProperties: false,
  required: ["id", "regions", "status"],
  properties: {
    id: { type: "string" },
    regions: { type: "array", items: { type: "string", enum: REGIONS } },
    status: { type: ["string", "null"], enum: ["active", "draft", null] },
    name: { type: "string" },
  },
};

const manifest = createPlannerManifest({
  schemaVersion: "1.0",
  id: "laws",
  version: "1.0.0",
  description: "Laws.",
  dataTypes: [
    {
      id: "Law",
      version: "1.0.0",
      description: "A law.",
      schema: LAW,
      fields: {
        id: { label: "Id", semanticType: "identifier" },
        regions: { label: "Visitors from", semanticType: "text" },
        status: { label: "Status", semanticType: "status" },
        name: { label: "Name", semanticType: "text" },
      },
    },
  ],
  sources: [{ id: "api", label: "API" }],
  capabilities: [
    {
      id: "laws.mine",
      version: "1.0.0",
      purpose: "The signed-in account's laws.",
      kind: "query",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["market"],
        properties: {
          market: { type: "string", enum: ["eu", "us"] },
          page_size: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
      outputSchema: { type: "array", items: LAW },
      output: { dataTypeId: "Law", shape: "collection" },
      // An identity key: supplied by the executor from the session, never a visitor input.
      requiredSessionKeys: ["accountId"],
      sourceIds: ["api"],
      supports: { filterFields: ["regions", "status", "name"], sortFields: ["id"] },
      policy: { authentication: "session", maximumRows: 50 },
    },
  ],
  relationships: [],
});

const request = (query, params = { market: "eu" }) => ({
  requestId: "r1",
  capabilityId: "laws.mine",
  params,
  ...(query ? { query } : {}),
});
const edit = (req, input, name, values) => applyInputEdit(manifest, req, { input, name, values });

test("only arguments and filter fields with declared string values are visitor inputs — never a session key", () => {
  const inputs = enumeratedInputs(manifest, manifest.capabilities[0]);
  assert.deepEqual(
    inputs.map((entry) => `${entry.kind}:${entry.name}`),
    ["param:market", "filter:regions", "filter:status"],
  );
  // null is "no value", not an option a visitor picks.
  assert.deepEqual(inputs.find((entry) => entry.name === "status").options, ["active", "draft"]);
  assert.equal(JSON.stringify(manifest).includes("accountId"), false);
});

test("the summary classifies values the way text filters compare, and keeps unmatched words", () => {
  const [market, regions] = describeUnderstoodInputs(manifest, {
    dataRequests: [
      request({
        filter: {
          combine: "all",
          conditions: [
            {
              combine: "any",
              conditions: [
                { field: "regions", operator: "contains", value: "germany" },
                { field: "regions", operator: "contains", value: " Texas " },
              ],
            },
            { field: "name", operator: "contains", value: "privacy" },
          ],
        },
      }),
    ],
  });
  assert.deepEqual(market.values, ["eu"]);
  assert.deepEqual(regions.values, ["Germany"]);
  assert.deepEqual(regions.notFound, ["Texas"]);
  assert.equal(regions.editable, true);
});

test("a field the filter also excludes is not summarised as what was asked for", () => {
  const summary = describeUnderstoodInputs(manifest, {
    dataRequests: [
      request({
        filter: {
          combine: "all",
          conditions: [
            { field: "regions", operator: "contains", value: "Germany" },
            { combine: "none", conditions: [{ field: "regions", operator: "contains", value: "France" }] },
          ],
        },
      }),
    ],
  });
  assert.equal(summary.some((entry) => entry.name === "regions"), false);
});

test("a shape an edit cannot rewrite is shown read-only, and an edit to it is refused", () => {
  const tangled = request({
    filter: {
      combine: "any",
      conditions: [
        { field: "regions", operator: "contains", value: "Germany" },
        { field: "name", operator: "contains", value: "privacy" },
      ],
    },
  });
  const regions = describeUnderstoodInputs(manifest, { dataRequests: [tangled] }).find(
    (entry) => entry.name === "regions",
  );
  assert.equal(regions.editable, false);
  const refused = edit(tangled, "filter", "regions", ["France"]);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /cannot change/);
});

test("an edit keeps the operator the plan used and the rest of the filter untouched", () => {
  const original = request({
    filter: {
      combine: "all",
      conditions: [
        { field: "regions", operator: "in", value: ["Germany", "Texas"] },
        { field: "status", operator: "eq", value: "active" },
      ],
    },
  });
  const edited = edit(original, "filter", "regions", ["France", "Utah"]);
  assert.equal(edited.ok, true);
  assert.deepEqual(edited.request.query.filter, {
    combine: "all",
    conditions: [
      { field: "regions", operator: "in", value: ["France", "Utah", "Texas"] },
      { field: "status", operator: "eq", value: "active" },
    ],
  });
  assert.deepEqual(original.query.filter.conditions[0].value, ["Germany", "Texas"], "input untouched");

  const cleared = edit(edited.request, "filter", "regions", []);
  assert.deepEqual(cleared.request.query.filter, {
    combine: "all",
    conditions: [{ field: "status", operator: "eq", value: "active" }],
  });
});

test("an edit can add a field the filter did not mention, as membership for a list field", () => {
  const added = edit(request(undefined), "filter", "regions", ["Utah"]);
  assert.deepEqual(added.request.query.filter, {
    combine: "all",
    conditions: [{ field: "regions", operator: "contains", value: "Utah" }],
  });
});

test("adversarial edits are refused before anything is changed", () => {
  const base = request(undefined);
  const cases = [
    ["param", "accountId", ["acct_1"], /not an input a visitor can change/],
    ["param", "page_size", ["10"], /not an input a visitor can change/],
    ["filter", "name", ["GDPR"], /not an input a visitor can change/],
    ["filter", "id", ["gdpr"], /not an input a visitor can change/],
    ["param", "market", ["apac"], /"apac" is not a value this site lists for Market/],
    ["param", "market", ["EU"], /"EU" is not a value/],
    ["param", "market", ["eu", "us"], /takes one value/],
    ["param", "market", [], /needs a value/],
    ["filter", "regions", ["Texas"], /"Texas" is not a value this site lists for Visitors from/],
    ["filter", "regions", [{ toString: () => "Germany" }], /must be a list of strings/],
    ["identity", "market", ["eu"], /Unknown input kind/],
  ];
  for (const [input, name, values, reason] of cases) {
    const result = edit(base, input, name, values);
    assert.equal(result.ok, false, `${input}:${name}`);
    assert.match(result.reason, reason, `${input}:${name}`);
  }
  assert.deepEqual(base.params, { market: "eu" });
});

test("a missing required argument with declared values is askable; one without is not", () => {
  const missing = missingRequiredInputs(manifest, request(undefined, {}));
  assert.deepEqual(
    missing.declared.map((entry) => [entry.name, entry.options]),
    [["market", ["eu", "us"]]],
  );
  assert.deepEqual(missing.undeclared, []);
  assert.deepEqual(missingRequiredInputs(manifest, request(undefined)).declared, []);
});
