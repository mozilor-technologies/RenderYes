import assert from "node:assert/strict";
import test from "node:test";
import {
  compareToBaseline,
  formatEvalReport,
  runEvalSuite,
  toBaseline,
} from "../dist/index.js";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
} from "@renderyes/site-sdk";

/**
 * Meta-tests: the harness is only worth trusting if it demonstrably catches the
 * failures it claims to. Each test here drives a provider that makes one
 * specific mistake and asserts the report names that mistake.
 */

const TicketTable = defineComponent({
  id: "TicketTable",
  version: "1.0.0",
  description: "Shows approved tickets.",
  props: defineProps({
    density: field.enum(["comfortable", "compact"], { default: "comfortable" }),
  }),
  renderer: {
    component: "ResponsiveDataTable",
    props: { rows: { path: "/tickets/rows" } },
  },
  dataSlots: {
    rows: { accepts: [{ dataTypeId: "Ticket", shapes: ["collection"] }] },
  },
});

const InvoiceTable = defineComponent({
  id: "InvoiceTable",
  version: "1.0.0",
  description: "Shows approved invoices.",
  props: defineProps({}),
  renderer: {
    component: "ResponsiveDataTable",
    props: { rows: { path: "/invoices/rows" } },
  },
  dataSlots: {
    rows: { accepts: [{ dataTypeId: "Invoice", shapes: ["collection"] }] },
  },
});

const site = defineSite({
  id: "eval-demo",
  name: "Eval demo",
  version: "1.0.0",
  catalogId: "eval-demo-components",
  components: [TicketTable, InvoiceTable],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main surface.",
      componentIds: ["TicketTable", "InvoiceTable"],
      maxComponents: 2,
    }),
  ],
});

const dataType = (id) => ({
  id,
  version: "1.0.0",
  description: `${id} records`,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string" },
      status: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  fields: {
    id: { label: "ID", semanticType: "identifier" },
    status: { label: "Status", semanticType: "status" },
    createdAt: { label: "Created", semanticType: "date-time" },
  },
});

const capability = (id, dataTypeId) => ({
  id,
  version: "1.0.0",
  purpose: `${id} purpose.`,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  output: { dataTypeId, shape: "collection" },
  supports: {
    filterFields: ["status", "createdAt"],
    sortFields: ["createdAt"],
  },
  constraints: { authentication: "session", maximumRows: 50 },
});

const plannerManifest = {
  schemaVersion: "1.0",
  catalogId: "eval-data",
  catalogVersion: "1.0.0",
  catalogHash: "sha256:eval-data",
  description: "Eval demo capabilities.",
  dataTypes: [dataType("Ticket"), dataType("Invoice")],
  capabilities: [
    // Two operations on the same data type: this is what makes the
    // "right data type, wrong verb" diagnosis testable.
    capability("tickets.list", "Ticket"),
    capability("tickets.search", "Ticket"),
    capability("invoices.list", "Invoice"),
  ],
  relationships: [],
};

const draft = ({
  capabilityId = "tickets.list",
  componentId = "TicketTable",
  query,
  nodes,
} = {}) => ({
  status: "ready",
  dataRequests: [
    { requestId: "r1", capabilityId, params: {}, ...(query ? { query } : {}) },
  ],
  nodes: nodes ?? [
    {
      nodeId: "n1",
      componentId,
      props: componentId === "TicketTable" ? { density: "comfortable" } : {},
      dataBindings: { rows: { requestId: "r1" } },
    },
  ],
});

/** Consumes one scripted value per provider call, cycling once exhausted. */
function scriptedProvider(values) {
  let index = 0;
  return {
    id: "scripted",
    async generatePlan() {
      const value = values[index % values.length];
      index += 1;
      return { modelId: "scripted-1", value };
    },
  };
}

const run = (cases, provider, runs = 3, maxRetries) =>
  runEvalSuite({
    site,
    plannerManifest,
    surfaceId: "main",
    cases,
    provider,
    runs,
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  });

test("a correct plan reports a full pass rate and first-attempt validity", async () => {
  const report = await run(
    [
      {
        id: "tickets-basic",
        prompt: "show me my tickets",
        expect: {
          outcome: "ready",
          usesCapabilities: ["tickets.list"],
          usesComponents: ["TicketTable"],
        },
      },
    ],
    scriptedProvider([draft()]),
  );

  assert.equal(report.cases[0].passRate, 1);
  assert.equal(report.cases[0].firstAttemptValidRate, 1);
  assert.equal(report.cases[0].unstable, false);
  assert.equal(report.cases[0].meanProviderCalls, 1);
  assert.equal(report.totals.falseReady, 0);
  assert.equal(report.totals.falseUnsupported, 0);
  assert.equal(report.resolution, 1 / 3);
});

test("diagnoses right-data-type-wrong-operation separately from a plain miss", async () => {
  const report = await run(
    [
      {
        id: "tickets-search",
        prompt: "find tickets mentioning refunds",
        expect: {
          outcome: "ready",
          usesCapabilities: ["tickets.search"],
        },
      },
    ],
    scriptedProvider([draft({ capabilityId: "tickets.list" })]),
  );

  const checks = report.cases[0].checks;
  assert.equal(checks["capability-selection"].passRate, 0);
  assert.equal(checks["capability-verb"].passRate, 0);
  assert.match(
    checks["capability-verb"].failures[0],
    /right data type, wrong operation: chose tickets\.list instead of tickets\.search/,
  );
});

test("does not raise the verb diagnosis when an unrelated data type was chosen", async () => {
  const report = await run(
    [
      {
        id: "tickets-not-invoices",
        prompt: "show me my tickets",
        expect: { outcome: "ready", usesCapabilities: ["tickets.list"] },
      },
    ],
    scriptedProvider([
      draft({ capabilityId: "invoices.list", componentId: "InvoiceTable" }),
    ]),
  );

  const checks = report.cases[0].checks;
  assert.equal(checks["capability-selection"].passRate, 0);
  assert.equal(
    checks["capability-verb"].passRate,
    1,
    "picking a different data type is a selection miss, not a verb confusion",
  );
});

test("catches a wrong component even when the capability was right", async () => {
  const report = await run(
    [
      {
        id: "tickets-component",
        prompt: "show me my tickets",
        expect: { outcome: "ready", usesComponents: ["TicketTable"] },
      },
    ],
    scriptedProvider([
      draft({ capabilityId: "invoices.list", componentId: "InvoiceTable" }),
    ]),
  );
  assert.equal(report.cases[0].checks["component-selection"].passRate, 0);
  assert.match(
    report.cases[0].checks["component-selection"].failures[0],
    /expected TicketTable; rendered InvoiceTable/,
  );
});

test("reports a rate rather than a verdict when the provider is inconsistent", async () => {
  // Alternates correct and wrong on every call, so half the runs pass.
  const report = await run(
    [
      {
        id: "flaky",
        prompt: "show me my tickets",
        expect: { outcome: "ready", usesCapabilities: ["tickets.list"] },
      },
    ],
    scriptedProvider([draft(), draft({ capabilityId: "tickets.search" })]),
    4,
    0,
  );

  assert.equal(report.cases[0].passRate, 0.5);
  assert.equal(report.cases[0].unstable, true);
  assert.deepEqual(report.unstableCaseIds, ["flaky"]);
});

test("separates a needed repair from a first-attempt success", async () => {
  // First draft names a capability outside the schema, so it is rejected and
  // repaired; the second is valid.
  const invalid = draft({ capabilityId: "tickets.doesNotExist" });
  const report = await run(
    [
      {
        id: "repaired",
        prompt: "show me my tickets",
        expect: {
          outcome: "ready",
          usesCapabilities: ["tickets.list"],
        },
      },
    ],
    scriptedProvider([invalid, draft()]),
    1,
  );

  const caseReport = report.cases[0];
  assert.equal(caseReport.checks["capability-selection"].passRate, 1);
  assert.equal(
    caseReport.firstAttemptValidRate,
    0,
    "the repair loop must not be allowed to hide a bad first draft",
  );
  assert.equal(caseReport.meanRepairCount, 1);
  assert.equal(caseReport.meanProviderCalls, 2);
  assert.equal(caseReport.passRate, 0, "a repaired plan is not a clean pass");
});

test("counts a refusal of an answerable request as falseUnsupported", async () => {
  const report = await run(
    [
      {
        id: "should-have-worked",
        prompt: "show me my tickets",
        expect: { outcome: "ready", usesCapabilities: ["tickets.list"] },
      },
    ],
    scriptedProvider([{ status: "unsupported", reason: "I could not find a way." }]),
    2,
  );

  assert.equal(report.totals.falseUnsupported, 2);
  assert.equal(report.cases[0].passRate, 0);
  assert.match(
    report.cases[0].checks.outcome.failures[0],
    /refused a request the catalog can answer/,
  );
});

test("counts an invented view for an unanswerable request as falseReady", async () => {
  const report = await run(
    [
      {
        id: "should-have-refused",
        prompt: "show me a live map of drivers",
        expect: { outcome: "unsupported" },
      },
    ],
    scriptedProvider([draft()]),
    2,
  );

  assert.equal(report.totals.falseReady, 2);
  assert.equal(report.cases[0].passRate, 0);
});

test("passes a case that correctly refuses", async () => {
  const report = await run(
    [
      {
        id: "correct-refusal",
        prompt: "show me a live map of drivers",
        expect: { outcome: "unsupported" },
      },
    ],
    scriptedProvider([
      {
        status: "unsupported",
        reason: "No approved component renders a map.",
      },
    ]),
  );

  assert.equal(report.cases[0].passRate, 1);
  assert.equal(report.totals.falseReady, 0);
  assert.equal(report.totals.falseUnsupported, 0);
});

test("checks filter fields at any nesting depth", async () => {
  const nested = draft({
    query: {
      filter: {
        combine: "all",
        conditions: [
          {
            combine: "any",
            conditions: [{ field: "status", operator: "eq", value: "open" }],
          },
        ],
      },
    },
  });
  const report = await run(
    [
      {
        id: "nested-filter",
        prompt: "show my open tickets",
        expect: { outcome: "ready", filtersOn: ["status"] },
      },
    ],
    scriptedProvider([nested]),
    1,
  );
  assert.equal(
    report.cases[0].checks["filter-fields"].passRate,
    1,
    "a field nested one group down must still count — filter groups nest 3 deep",
  );
});

test("checks limit and sort against what the prompt implies", async () => {
  const report = await run(
    [
      {
        id: "top-two-recent",
        prompt: "my 2 most recent tickets",
        expect: {
          outcome: "ready",
          limit: 2,
          sortsBy: [{ field: "createdAt", direction: "desc" }],
        },
      },
    ],
    scriptedProvider([
      draft({
        query: { limit: 10, sort: [{ field: "createdAt", direction: "asc" }] },
      }),
    ]),
    1,
  );
  const checks = report.cases[0].checks;
  assert.match(checks.limit.failures[0], /expected limit 2; used 10/);
  assert.match(checks.sort.failures[0], /expected sort createdAt desc/);
});

test("flags over-building against maxNodes", async () => {
  const report = await run(
    [
      {
        id: "one-thing",
        prompt: "how many open tickets do I have",
        expect: { outcome: "ready", maxNodes: 1 },
      },
    ],
    scriptedProvider([
      draft({
        nodes: [
          {
            nodeId: "n1",
            componentId: "TicketTable",
            props: { density: "comfortable" },
            dataBindings: { rows: { requestId: "r1" } },
          },
          {
            nodeId: "n2",
            componentId: "TicketTable",
            props: { density: "compact" },
            dataBindings: { rows: { requestId: "r1" } },
          },
        ],
      }),
    ]),
    1,
  );
  assert.match(
    report.cases[0].checks["node-count"].failures[0],
    /built 2 nodes, expected at most 1/,
  );
});

test("flags under-building against minNodes", async () => {
  // The over-refusal failure in miniature: a compound prompt answered with a
  // single component. The default draft builds exactly one node.
  const report = await run(
    [
      {
        id: "two-things",
        prompt: "show my tickets and my invoices",
        expect: { outcome: "ready", minNodes: 2 },
      },
    ],
    scriptedProvider([draft({})]),
    1,
  );
  assert.match(
    report.cases[0].checks["node-count"].failures[0],
    /expected at least 2 top-level nodes, got 1/,
  );
});

test("omits checks a case does not assert instead of scoring them as passes", async () => {
  const report = await run(
    [
      {
        id: "minimal",
        prompt: "show me my tickets",
        expect: { outcome: "ready" },
      },
    ],
    scriptedProvider([draft()]),
    1,
  );
  const checks = report.cases[0].checks;
  assert.ok(checks.outcome);
  assert.ok(checks["first-attempt-valid"]);
  assert.equal(checks.limit, undefined);
  assert.equal(checks["capability-selection"], undefined);
  assert.equal(checks["filter-fields"], undefined);
});

test("accumulates a suite-wide selection distribution, which per-case checks cannot see", async () => {
  const report = await run(
    [
      {
        id: "a",
        prompt: "show me my tickets",
        expect: { outcome: "ready" },
      },
      {
        id: "b",
        prompt: "show me my invoices",
        expect: { outcome: "ready" },
      },
    ],
    scriptedProvider([draft()]),
    2,
  );
  // Both cases got tickets.list, 2 runs each. A real bias check looks exactly
  // like this: one capability absorbing every selection.
  assert.deepEqual(report.selectionDistribution, { "tickets.list": 4 });
  assert.equal(report.selectionDistribution["invoices.list"], undefined);
});

test("baseline comparison reports a regression with its magnitude", async () => {
  const good = await run(
    [
      {
        id: "tickets-basic",
        prompt: "show me my tickets",
        expect: { outcome: "ready", usesCapabilities: ["tickets.list"] },
      },
    ],
    scriptedProvider([draft()]),
    2,
  );
  const baseline = toBaseline(good);
  assert.equal(baseline.cases["tickets-basic"].passRate, 1);

  const regressed = await run(
    [
      {
        id: "tickets-basic",
        prompt: "show me my tickets",
        expect: { outcome: "ready", usesCapabilities: ["tickets.list"] },
      },
    ],
    scriptedProvider([draft({ capabilityId: "tickets.search" })]),
    2,
  );
  const comparison = compareToBaseline(regressed, baseline);
  const passRateRegression = comparison.regressions.find(
    (delta) => delta.metric === "passRate",
  );
  assert.ok(passRateRegression);
  assert.equal(passRateRegression.before, 1);
  assert.equal(passRateRegression.after, 0);
  assert.equal(comparison.runsMismatch, false);
  assert.deepEqual(comparison.newCaseIds, []);
});

test("baseline comparison flags a run-count mismatch instead of comparing rates blindly", async () => {
  const threeRuns = await run(
    [{ id: "x", prompt: "show me my tickets", expect: { outcome: "ready" } }],
    scriptedProvider([draft()]),
    3,
  );
  const comparison = compareToBaseline(threeRuns, {
    runs: 20,
    cases: { x: { passRate: 1, firstAttemptValidRate: 1 } },
  });
  assert.equal(comparison.runsMismatch, true);
});

test("baseline comparison names cases added and removed since the snapshot", async () => {
  const report = await run(
    [{ id: "kept", prompt: "show me my tickets", expect: { outcome: "ready" } }],
    scriptedProvider([draft()]),
    1,
  );
  const comparison = compareToBaseline(report, {
    runs: 1,
    cases: { removed: { passRate: 1, firstAttemptValidRate: 1 } },
  });
  assert.deepEqual(comparison.newCaseIds, ["kept"]);
  assert.deepEqual(comparison.missingCaseIds, ["removed"]);
});

test("formats a report that leads with the worst cases", async () => {
  const report = await run(
    [
      {
        id: "passes",
        prompt: "show me my tickets",
        expect: { outcome: "ready", usesCapabilities: ["tickets.list"] },
      },
      {
        id: "fails",
        prompt: "find tickets mentioning refunds",
        expect: { outcome: "ready", usesCapabilities: ["tickets.search"] },
      },
    ],
    scriptedProvider([draft()]),
    1,
  );
  const text = formatEvalReport(report);
  assert.match(text, /2 cases x 1 runs/);
  assert.match(text, /first-attempt valid\s+100%/);
  assert.ok(
    text.indexOf("fails") < text.indexOf("passes"),
    "the failures are the point, so they sort first",
  );
  assert.match(text, /capability selection distribution \(bias check\)/);
});
