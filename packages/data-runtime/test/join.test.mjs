import assert from "node:assert/strict";
import test from "node:test";
import { joinExecutedData } from "../dist/index.js";

const baseCatalog = {
  schemaVersion: "1.0",
  id: "svc",
  version: "0.1.0",
  description: "Join test catalog.",
  dataTypes: [
    {
      id: "Ticket",
      version: "1.0.0",
      description: "A ticket.",
      schema: { type: "object" },
      fields: {
        ticket: { label: "Ticket", semanticType: "identifier" },
        owner: { label: "Owner", semanticType: "text" },
      },
      matchKey: "ticket",
    },
    {
      id: "Agent",
      version: "1.0.0",
      description: "An agent.",
      schema: { type: "object" },
      fields: {
        name: { label: "Name", semanticType: "identifier" },
        team: { label: "Team", semanticType: "text" },
      },
      matchKey: "name",
    },
  ],
  sources: [],
  capabilities: [
    {
      id: "tickets.search",
      version: "1.0.0",
      purpose: "Tickets.",
      kind: "query",
      inputSchema: {},
      outputSchema: {},
      output: { dataTypeId: "Ticket", shape: "collection" },
      requiredSessionKeys: [],
      sourceIds: [],
      policy: { authentication: "public" },
    },
    {
      id: "agents.list",
      version: "1.0.0",
      purpose: "Agents.",
      kind: "query",
      inputSchema: {},
      outputSchema: {},
      output: { dataTypeId: "Agent", shape: "collection" },
      requiredSessionKeys: [],
      sourceIds: [],
      policy: { authentication: "public" },
    },
  ],
  relationships: [
    {
      id: "ticket-owner-agent",
      description: "A ticket's owner is an agent.",
      from: { dataTypeId: "Ticket", field: "owner" },
      to: { dataTypeId: "Agent", field: "name" },
      cardinality: "many-to-one",
    },
  ],
};

const provenance = (sourceId) => ({
  sources: [{ sourceId }],
  freshness: { asOf: "2026-07-28T00:00:00.000Z" },
});

function executed(overrides = {}) {
  return {
    planId: "p",
    results: {
      tickets: {
        ok: true,
        data: [
          { ticket: "T1", owner: "Maya" },
          { ticket: "T2", owner: "Priya" },
          { ticket: "T3", owner: "Ghost" },
        ],
        provenance: provenance("ticket-svc"),
      },
      agents: {
        ok: true,
        data: [
          { name: "Maya", team: "Billing" },
          { name: "Priya", team: "SSO" },
        ],
        provenance: provenance("agent-svc"),
      },
      ...overrides,
    },
  };
}

const plan = {
  dataRequests: [
    { requestId: "tickets", capabilityId: "tickets.search", params: {} },
    { requestId: "agents", capabilityId: "agents.list", params: {} },
  ],
  dataJoins: [
    {
      joinId: "j",
      relationshipId: "ticket-owner-agent",
      left: "tickets",
      right: "agents",
      as: "agent",
    },
  ],
};

test("enriches left rows with the matched right row's fields", () => {
  const { j } = joinExecutedData({ plan, executed: executed(), catalog: baseCatalog });
  assert.equal(j.ok, true);
  assert.deepEqual(j.data[0], {
    ticket: "T1",
    owner: "Maya",
    agent_name: "Maya",
    agent_team: "Billing",
  });
  // Unmatched left row keeps only its own fields.
  assert.deepEqual(j.data[2], { ticket: "T3", owner: "Ghost" });
  assert.deepEqual(j.provenance.sources.map((s) => s.sourceId).sort(), [
    "agent-svc",
    "ticket-svc",
  ]);
});

test("rejects a to-many relationship", () => {
  const catalog = structuredClone(baseCatalog);
  catalog.relationships[0].cardinality = "one-to-many";
  const { j } = joinExecutedData({ plan, executed: executed(), catalog });
  assert.equal(j.ok, false);
  assert.equal(j.error.code, "JOIN_CARDINALITY_UNSUPPORTED");
});

test("rejects a join whose inputs do not match the relationship types", () => {
  const catalog = structuredClone(baseCatalog);
  catalog.relationships[0].from.dataTypeId = "Agent";
  catalog.relationships[0].to.dataTypeId = "Ticket";
  const { j } = joinExecutedData({ plan, executed: executed(), catalog });
  assert.equal(j.ok, false);
  assert.equal(j.error.code, "JOIN_TYPE_MISMATCH");
});

test("fails the join when an input failed to resolve", () => {
  const failed = executed({
    agents: {
      ok: false,
      error: { code: "RUNTIME_ERROR", message: "x", retryable: true },
    },
  });
  const { j } = joinExecutedData({ plan, executed: failed, catalog: baseCatalog });
  assert.equal(j.ok, false);
  assert.equal(j.error.code, "JOIN_INPUT_FAILED");
});

test("rejects a join over the row budget", () => {
  const { j } = joinExecutedData({
    plan,
    executed: executed(),
    catalog: baseCatalog,
    options: { maxComposedRows: 1 },
  });
  assert.equal(j.ok, false);
  assert.equal(j.error.code, "JOIN_TOO_LARGE");
});

test("rejects an unknown relationship", () => {
  const badPlan = {
    ...plan,
    dataJoins: [{ ...plan.dataJoins[0], relationshipId: "missing" }],
  };
  const { j } = joinExecutedData({
    plan: badPlan,
    executed: executed(),
    catalog: baseCatalog,
  });
  assert.equal(j.ok, false);
  assert.equal(j.error.code, "NO_RELATIONSHIP");
});

test("declares the output schema of the rows it actually produced", () => {
  const { j } = joinExecutedData({ plan, executed: executed(), catalog: baseCatalog });
  assert.equal(j.ok, true);
  const schema = j.outputSchema;
  assert.equal(schema.prefix, "agent");
  assert.deepEqual(schema.leftFields.sort(), ["owner", "ticket"]);
  // Prefixed exactly as they appear on an enriched row.
  assert.deepEqual(schema.rightFields.sort(), ["agent_name", "agent_team"]);
  // T3 matched nothing, so every prefixed field must be treated as optional.
  assert.equal(schema.hasUnmatchedRows, true);
  assert.equal(schema.leftDataTypeId, "Ticket");
  assert.equal(schema.rightDataTypeId, "Agent");

  // The schema must describe the real rows, not the catalog's ideal.
  for (const field of schema.rightFields) {
    assert.ok(Object.hasOwn(j.data[0], field), `${field} missing from a matched row`);
  }
  for (const field of schema.leftFields) {
    assert.ok(Object.hasOwn(j.data[2], field), `${field} missing from an unmatched row`);
  }
});

test("fails rather than silently overwriting a colliding left-hand field", () => {
  // The `as` prefix makes a collision unlikely, not impossible. Here the left
  // rows already carry `agent_team`, and the join writes `agent_` + `team`
  // over it — so the left value silently became the right one. The key still
  // existed and still held a plausible value, which is exactly why this was
  // invisible: a wrong answer presented as a correct one.
  const collidingTickets = {
    tickets: {
      ok: true,
      data: [
        { ticket: "T1", owner: "Maya", agent_team: "Escalations" },
        { ticket: "T2", owner: "Priya", agent_team: "Escalations" },
      ],
      provenance: provenance("ticket-svc"),
    },
  };

  const { j } = joinExecutedData({
    plan,
    executed: executed(collidingTickets),
    catalog: baseCatalog,
  });

  assert.equal(j.ok, false);
  assert.equal(j.error.code, "JOIN_FIELD_COLLISION");
  assert.match(j.error.message, /agent_team/);
  // Deterministic, so retrying cannot help.
  assert.equal(j.error.retryable, false);
});

test("a left field sharing the prefix but not a joined field name is fine", () => {
  // `agent_note` is not produced by the right side, so nothing overwrites it.
  // The check must not reject on the prefix alone.
  const { j } = joinExecutedData({
    plan,
    executed: executed({
      tickets: {
        ok: true,
        data: [{ ticket: "T1", owner: "Maya", agent_note: "vip" }],
        provenance: provenance("ticket-svc"),
      },
    }),
    catalog: baseCatalog,
  });

  assert.equal(j.ok, true);
  assert.deepEqual(j.data[0], {
    ticket: "T1",
    owner: "Maya",
    agent_note: "vip",
    agent_name: "Maya",
    agent_team: "Billing",
  });
});
