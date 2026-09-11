import assert from "node:assert/strict";
import test from "node:test";
import { hashCapabilityCatalog } from "@renderyes/capability-catalog";
import { composeExecutedData, executePlanData } from "../dist/index.js";

const instrumentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["symbol", "name", "price", "change"],
  properties: {
    symbol: { type: "string" },
    name: { type: "string" },
    price: { type: "string" },
    change: { type: "number" },
  },
};

const marketInstrument = {
  id: "MarketInstrument",
  version: "1.0.0",
  description: "A tradable market instrument.",
  schema: instrumentSchema,
  fields: {
    symbol: { label: "Symbol", semanticType: "identifier" },
    name: { label: "Name", semanticType: "text" },
    price: { label: "Price", semanticType: "money" },
    change: { label: "Change", semanticType: "percentage" },
  },
  matchKey: "symbol",
};

function marketCapability(
  id,
  sourceId,
  {
    setOperations = ["union", "intersection", "difference"],
    auth = "public",
    permissions,
    sessionKeys = [],
  } = {},
) {
  return {
    id,
    version: "1.0.0",
    purpose: `Approved ${id} dataset.`,
    kind: "query",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "array", items: instrumentSchema },
    output: { dataTypeId: "MarketInstrument", shape: "collection" },
    requiredSessionKeys: sessionKeys,
    sourceIds: [sourceId],
    supports: { sortFields: ["symbol", "change"], setOperations },
    policy: {
      authentication: auth,
      ...(permissions ? { requiredPermissions: permissions } : {}),
      maximumRows: 50,
      timeoutMs: 100,
    },
  };
}

const catalog = {
  schemaVersion: "1.0",
  id: "northstar-finance-data",
  version: "0.1.0",
  description: "Approved market data.",
  dataTypes: [marketInstrument],
  sources: [
    { id: "market-movers-service", label: "Movers service" },
    { id: "watchlist-service", label: "Watchlist service" },
  ],
  capabilities: [
    marketCapability("market.topMovers", "market-movers-service"),
    marketCapability("market.watchlist", "watchlist-service", {
      auth: "session",
      permissions: ["watchlist.read"],
      sessionKeys: ["userId"],
    }),
  ],
  relationships: [],
};

const dataCatalog = {
  id: catalog.id,
  version: catalog.version,
  hash: hashCapabilityCatalog(catalog),
};

const moverRows = [
  { symbol: "NVDA", name: "NVIDIA", price: "$218.44", change: 6.82 },
  { symbol: "PLTR", name: "Palantir", price: "$84.12", change: 5.91 },
  { symbol: "AMD", name: "AMD", price: "$172.03", change: 4.37 },
];
const watchlistRows = [
  { symbol: "AAPL", name: "Apple", price: "$271.40", change: 0.44 },
  { symbol: "MSFT", name: "Microsoft", price: "$512.80", change: 0.91 },
  { symbol: "NVDA", name: "NVIDIA", price: "$218.44", change: 6.82 },
  { symbol: "TSLA", name: "Tesla", price: "$398.12", change: -1.05 },
];

function runtime(capabilityId, rows, sourceId, freshness) {
  return {
    capabilityId,
    inputSchema: {},
    outputSchema: {},
    async execute() {
      return {
        ok: true,
        data: rows.map((row) => ({ ...row })),
        provenance: { sources: [{ sourceId }], freshness },
      };
    },
  };
}

const runtimes = new Map([
  [
    "market.topMovers",
    runtime("market.topMovers", moverRows, "market-movers-service", {
      asOf: "2026-07-28T00:00:00.000Z",
      staleAt: "2026-07-28T00:05:00.000Z",
    }),
  ],
  [
    "market.watchlist",
    runtime("market.watchlist", watchlistRows, "watchlist-service", {
      asOf: "2026-07-28T00:02:00.000Z",
      staleAt: "2026-07-28T00:04:00.000Z",
    }),
  ],
]);

function host(permitted = true) {
  return {
    isAuthenticated: (session) => session.userId !== undefined,
    hasPermission: (session, permission) =>
      permitted && session.permissions.has(permission),
    getSessionValue: (session, key) => session[key],
  };
}

const session = { userId: "maya-demo", permissions: new Set(["watchlist.read"]) };

function plan(operation, query) {
  return {
    schemaVersion: "3.1",
    planId: `plan-${operation}`,
    siteId: "northstar-finance",
    catalog: { id: "ui", version: "1.0.0", fingerprint: "fp" },
    dataCatalog,
    dataRequests: [
      { requestId: "movers", capabilityId: "market.topMovers", params: {} },
      { requestId: "watchlist", capabilityId: "market.watchlist", params: {} },
    ],
    dataCompositions: [
      {
        compositionId: "combo",
        operation,
        inputs: ["movers", "watchlist"],
        ...(query ? { query } : {}),
      },
    ],
    surfaces: [],
    generation: {
      providerId: "hand",
      modelId: "none",
      createdAt: "2026-07-28T00:00:00.000Z",
      repairCount: 0,
    },
  };
}

async function compose(operation, query, options = {}) {
  const executed = await executePlanData({
    plan: plan(operation, query),
    catalog,
    runtimes,
    session,
    host: host(options.permitted ?? true),
    options: options.executor,
  });
  return executed.compositions.combo;
}

test("union merges and deduplicates by the catalog matchKey", async () => {
  const result = await compose("union");
  assert.equal(result.ok, true);
  const symbols = result.data.map((row) => row.symbol);
  assert.deepEqual(symbols, ["NVDA", "PLTR", "AMD", "AAPL", "MSFT", "TSLA"]);
});

test("union merges provenance sources and reduces freshness", async () => {
  const result = await compose("union");
  assert.deepEqual(result.provenance.sources.map((s) => s.sourceId).sort(), [
    "market-movers-service",
    "watchlist-service",
  ]);
  assert.equal(result.provenance.freshness.asOf, "2026-07-28T00:00:00.000Z");
  assert.equal(result.provenance.freshness.staleAt, "2026-07-28T00:04:00.000Z");
});

test("intersection keeps only symbols present in both datasets", async () => {
  const result = await compose("intersection");
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.data.map((row) => row.symbol),
    ["NVDA"],
  );
});

test("difference removes symbols in the second dataset from the first", async () => {
  const result = await compose("difference");
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.data.map((row) => row.symbol),
    ["PLTR", "AMD"],
  );
});

test("applies a post-merge sort and limit over the composed result", async () => {
  const result = await compose("union", {
    sort: [{ field: "change", direction: "desc" }],
    limit: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].symbol, "NVDA");
  assert.equal(result.data[1].symbol, "PLTR");
});

test("union tolerates a failed input and flags it partial", async () => {
  const result = await compose("union", undefined, { permitted: false });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.failedInputs, ["watchlist"]);
  assert.deepEqual(
    result.data.map((row) => row.symbol),
    ["NVDA", "PLTR", "AMD"],
  );
});

test("intersection fails when any input failed", async () => {
  const result = await compose("intersection", undefined, { permitted: false });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "COMPOSITION_INPUT_FAILED");
});

test("rejects an oversized composition against the row budget", async () => {
  const result = await compose("union", undefined, { executor: { maxComposedRows: 3 } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "COMPOSITION_TOO_LARGE");
});

test("rejects a composition when a data type has no matchKey", () => {
  const noKeyCatalog = {
    ...catalog,
    dataTypes: [{ ...marketInstrument, matchKey: undefined }],
  };
  const executed = {
    planId: "p",
    results: {
      movers: {
        ok: true,
        data: moverRows,
        provenance: { sources: [], freshness: { asOf: "2026-07-28T00:00:00.000Z" } },
      },
      watchlist: {
        ok: true,
        data: watchlistRows,
        provenance: { sources: [], freshness: { asOf: "2026-07-28T00:00:00.000Z" } },
      },
    },
  };
  const compositions = composeExecutedData({
    plan: plan("union"),
    executed,
    catalog: noKeyCatalog,
  });
  assert.equal(compositions.combo.ok, false);
  assert.equal(compositions.combo.error.code, "NO_MATCH_KEY");
});

test("rejects a composition when a capability does not support the set operation", () => {
  const noSetOpCatalog = {
    ...catalog,
    capabilities: [
      marketCapability("market.topMovers", "market-movers-service", {
        setOperations: [],
      }),
      catalog.capabilities[1],
    ],
  };
  const executed = {
    planId: "p",
    results: {
      movers: {
        ok: true,
        data: moverRows,
        provenance: { sources: [], freshness: { asOf: "2026-07-28T00:00:00.000Z" } },
      },
      watchlist: {
        ok: true,
        data: watchlistRows,
        provenance: { sources: [], freshness: { asOf: "2026-07-28T00:00:00.000Z" } },
      },
    },
  };
  const compositions = composeExecutedData({
    plan: plan("union"),
    executed,
    catalog: noSetOpCatalog,
  });
  assert.equal(compositions.combo.ok, false);
  assert.equal(compositions.combo.error.code, "SET_OP_NOT_SUPPORTED");
});
