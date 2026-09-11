import assert from "node:assert/strict";
import test from "node:test";
import { createPlanContract } from "../dist/index.js";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
} from "@renderyes/site-sdk";

/**
 * The prompt's worked examples. Two risks are pinned mechanically here, because
 * both are the kind that a passing plan would not reveal:
 *
 * - **Selection bias.** An example naming a real capability teaches the model to
 *   prefer it. That never shows up in a single case's pass/fail, only as a
 *   skewed distribution across a whole suite — so the examples must be provably
 *   free of real catalog ids, not just carefully written.
 * - **Schema drift.** An example may only use keys the enforced schema accepts.
 *   The `readySchema` is `additionalProperties: false`, so an example teaching a
 *   key the schema omits produces a guaranteed rejection.
 */

const ReportTable = defineComponent({
  id: "ReportTable",
  version: "1.0.0",
  description: "Shows approved reports.",
  props: defineProps({
    density: field.enum(["comfortable", "compact"], { default: "comfortable" }),
  }),
  renderer: {
    component: "ResponsiveDataTable",
    props: { rows: { path: "/reports/rows" } },
  },
  dataSlots: {
    rows: { accepts: [{ dataTypeId: "AgentReport", shapes: ["collection"] }] },
  },
});

const site = defineSite({
  id: "examples-demo",
  name: "Examples demo",
  version: "1.0.0",
  catalogId: "examples-demo-components",
  components: [ReportTable],
  surfaces: [
    defineSurface({
      id: "reports",
      description: "Report results.",
      componentIds: ["ReportTable"],
      maxComponents: 1,
    }),
    // Uncapped: the sibling example and the capacity sentence must appear here
    // and only here — showing either to the capped surface above would teach a
    // shape its enforced schema (maxItems: 1) rejects.
    defineSurface({
      id: "reports-open",
      description: "Report results, uncapped.",
      componentIds: ["ReportTable"],
    }),
    defineSurface({
      id: "reports-pair",
      description: "Report results, at most two.",
      componentIds: ["ReportTable"],
      maxComponents: 2,
    }),
  ],
});

const dataType = (id) => ({
  id,
  version: "1.0.0",
  description: id,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { id: { type: "string" } },
  },
  fields: { id: { label: "ID", semanticType: "identifier" } },
});

const capability = (id, dataTypeId, shape) => ({
  id,
  version: "1.0.0",
  purpose: `${id} purpose.`,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  output: { dataTypeId, shape },
  constraints: { authentication: "session", maximumRows: 20 },
});

const manifest = {
  schemaVersion: "1.0",
  catalogId: "examples-data",
  catalogVersion: "1.0.0",
  catalogHash: "sha256:examples-data",
  description: "Examples demo capabilities.",
  dataTypes: [dataType("AgentReport"), dataType("Auditor")],
  capabilities: [
    capability("reports.list", "AgentReport", "collection"),
    capability("auditors.list", "Auditor", "collection"),
  ],
  relationships: [],
};

const joinManifest = {
  ...manifest,
  catalogHash: "sha256:examples-data-join",
  relationships: [
    {
      id: "report-auditor",
      description: "The auditor assigned to each report.",
      fromDataTypeId: "AgentReport",
      toDataTypeId: "Auditor",
      cardinality: "many-to-one",
    },
  ],
};

/** Every JSON object the prompt presents as an example. */
function examplesIn(contract) {
  return contract.systemPrompt
    .split("\n")
    .filter((line) => line.startsWith('{"status":'))
    .map((line) => JSON.parse(line));
}

test("presents a flat example and a refusal example by default", () => {
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  const examples = examplesIn(contract);
  assert.equal(examples.length, 2);
  assert.equal(examples[0].status, "ready");
  assert.equal(examples[1].status, "unsupported");
  // Models under-refuse, so the refusal branch is shown and argued for.
  assert.match(contract.systemPrompt, /worse than no view/);
  assert.match(contract.systemPrompt, /Do not add nodes the request did not call for/);
  // The multi-part clauses are gated exactly like the sibling example: a
  // one-component surface must not be told "one component per part" — the
  // schema would reject the very draft that sentence instructs.
  assert.doesNotMatch(contract.systemPrompt, /asks for two things has called for two/);
  assert.doesNotMatch(contract.systemPrompt, /NOT partial either/);
});

test("includeShapeExamples: false removes them so a harness can A/B the change", () => {
  const contract = createPlanContract(site, manifest, {
    surfaceId: "reports",
    includeShapeExamples: false,
  });
  assert.deepEqual(examplesIn(contract), []);
  assert.doesNotMatch(contract.systemPrompt, /bracketed names/);
});

test("shows a join example only when the catalog advertises a qualifying relationship", () => {
  const withoutJoins = createPlanContract(site, manifest, { surfaceId: "reports" });
  assert.equal(
    examplesIn(withoutJoins).some((example) => "dataJoins" in example),
    false,
    "teaching dataJoins to a catalog with no relationship names a key the schema rejects",
  );

  const withJoins = createPlanContract(site, joinManifest, { surfaceId: "reports" });
  const joinExample = examplesIn(withJoins).find((e) => "dataJoins" in e);
  assert.ok(joinExample, "a join-capable catalog should see the join example");
  // Both sides declared as requests first, which is the part that is not obvious.
  assert.equal(joinExample.dataRequests.length, 2);
  assert.equal(joinExample.dataJoins[0].left, "left");
  assert.equal(joinExample.nodes[0].dataBindings["<that slot's name>"].joinId, "j1");
});

test("shows sibling nodes only when the surface can hold two components", () => {
  const capped = createPlanContract(site, manifest, { surfaceId: "reports" });
  assert.equal(
    examplesIn(capped).some((example) => (example.nodes ?? []).length > 1),
    false,
    "teaching sibling nodes to a maxComponents: 1 surface shows a shape the schema rejects",
  );

  const open = createPlanContract(site, manifest, { surfaceId: "reports-open" });
  const sibling = examplesIn(open).find((example) => (example.nodes ?? []).length > 1);
  assert.ok(sibling, "an uncapped surface should see the sibling example");
  // Each part gets its own request and its own component, wired one-to-one —
  // the shape the join example (two requests, one node) would otherwise anchor.
  assert.equal(sibling.dataRequests.length, 2);
  assert.equal(sibling.nodes.length, 2);
  assert.equal(sibling.nodes[0].dataBindings["<that slot's name>"].requestId, "r1");
  assert.equal(sibling.nodes[1].dataBindings["<that slot's name>"].requestId, "r2");
});

test("states the surface's capacity only when plural is actually allowed", () => {
  const capped = createPlanContract(site, manifest, { surfaceId: "reports" });
  assert.doesNotMatch(capped.systemPrompt, /holds one or several components/);

  const open = createPlanContract(site, manifest, { surfaceId: "reports-open" });
  assert.match(
    open.systemPrompt,
    /This surface holds one or several components side by side\./,
  );

  const pair = createPlanContract(site, manifest, { surfaceId: "reports-pair" });
  assert.match(
    pair.systemPrompt,
    /This surface holds one or several components side by side, at most 2\./,
  );
});

test("every example uses only keys the enforced schema accepts", () => {
  for (const [label, activeManifest, surfaceId] of [
    ["no joins", manifest, "reports"],
    ["joins", joinManifest, "reports"],
    ["no joins, uncapped", manifest, "reports-open"],
    ["joins, uncapped", joinManifest, "reports-open"],
  ]) {
    const contract = createPlanContract(site, activeManifest, {
      surfaceId,
    });
    const [ready, unsupported] = [
      contract.jsonSchema.oneOf[0],
      contract.jsonSchema.oneOf[1],
    ];
    for (const example of examplesIn(contract)) {
      const branch = example.status === "ready" ? ready : unsupported;
      const allowed = new Set(Object.keys(branch.properties));
      for (const key of Object.keys(example)) {
        assert.ok(
          allowed.has(key),
          `[${label}] example key "${key}" is not in the ${example.status} schema branch`,
        );
      }
      // Node shape too — this is where a stale example would drift first.
      const nodeProperties = new Set(
        Object.keys(ready.properties.nodes.items.oneOf[0].properties),
      );
      for (const node of example.nodes ?? []) {
        for (const key of Object.keys(node)) {
          assert.ok(
            nodeProperties.has(key),
            `[${label}] example node key "${key}" is not in the node schema`,
          );
        }
      }
    }
  }
});

test("no example names a real capability, component, or data type", () => {
  // Both surfaces, so the sibling example (uncapped only) is covered too.
  for (const surfaceId of ["reports", "reports-open"]) {
    const contract = createPlanContract(site, joinManifest, { surfaceId });
    const serialized = JSON.stringify(examplesIn(contract));
    const realIds = [
      ...joinManifest.capabilities.map((c) => c.id),
      ...joinManifest.dataTypes.map((d) => d.id),
      ...joinManifest.relationships.map((r) => r.id),
      ...site.components.map((c) => c.id),
      "rows",
      "density",
    ];
    for (const id of realIds) {
      assert.ok(
        !serialized.includes(id),
        `[${surfaceId}] example text names "${id}" — a real id in an example biases selection toward it`,
      );
    }
  }
});

test("examples still leak no renderer path or trusted context", () => {
  const contract = createPlanContract(site, joinManifest, { surfaceId: "reports" });
  const serialized = JSON.stringify(contract);
  assert.doesNotMatch(serialized, /reports\/rows/);
  assert.doesNotMatch(serialized, /ResponsiveDataTable/);
  assert.doesNotMatch(serialized, /fromDataTypeId|toDataTypeId|cardinality/);
});
