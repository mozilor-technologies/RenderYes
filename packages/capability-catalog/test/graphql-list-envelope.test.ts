import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  compileGraphQlOperation,
  createGraphQlCapabilityRuntime,
  createGraphQlCatalogInventory,
  executeApprovedGraphQlRequest,
  listGraphQlQueries,
} from "../src/graphql.js";
import { payloadConformanceTransport } from "./payload-conformance.js";

/**
 * Non-Relay list envelopes: `{docs: [Post], totalDocs, hasNextPage, ...}` —
 * an object wrapping a list, which is how Payload CMS 3, Strapi, and most
 * REST-shaped GraphQL facades page. Before this, no such list was expressible
 * at all: `relayConnectionInfo` is structural (edges/node) and correctly
 * refused it, discovery reported wrapper-relative paths (`docs.title`),
 * execution never unwrapped, and a `collection` capability delivered one
 * object where the runtime counts rows.
 *
 * The envelope is DECLARED by the host (`listEnvelope` on the query
 * selection), never detected: an entity that is scalars plus one nested list
 * has the same structural signature, and only the host can tell them apart.
 */

const SDL = `
  type Query {
    Posts(where: JSON, limit: Int, page: Int, sort: String, draft: Boolean): Posts
    Post(id: Int!): Post
  }

  scalar JSON

  type Posts {
    docs: [Post!]!
    hasNextPage: Boolean!
    hasPrevPage: Boolean!
    totalDocs: Int!
    totalPages: Int!
    page: Int!
    limit: Int!
    offset: Int
    pagingCounter: Int!
    nextPage: Int
    prevPage: Int
  }

  type Post {
    id: Int!
    title: String!
    slug: String!
    publishedAt: String
    heroImage: Media
    category: Category
  }

  type Media { url: String!, alt: String }
  type Category { title: String! }
`;


const ENVELOPE = {
  rowsField: "docs",
  hasNextPageField: "hasNextPage",
  totalCountField: "totalDocs",
  pageSizeArgument: "limit",
  pageArguments: ["page"],
} as const;

const SCALARS = { JSON: { schema: {} } };

function draftFor(overrides: Partial<Parameters<typeof createGraphQlCatalogInventory>[0]> = {}) {
  return createGraphQlCatalogInventory({
    schema: SDL,
    catalog: { id: "payload", version: "1.0.0", description: "Approved post reads." },
    source: { id: "payload-cms", label: "Payload", description: "The site's CMS." },
    queries: [
      {
        fieldName: "Posts",
        capabilityId: "graphql.posts",
        purpose: "List published posts.",
        dataTypeId: "post",
        dataTypeDescription: "One post.",
        resultShape: "collection",
        matchKey: "id",
        scalarMappings: SCALARS,
        listEnvelope: ENVELOPE,
      },
    ],
    ...overrides,
  });
}

function approvedCatalog(
  policyOverrides: { maximumRows?: number; maximumPageSize?: number } = {},
  approvalOverrides: { approvedVisitorArguments?: string[] } = {},
) {
  const draft = draftFor();
  return compileApprovedGraphQlCatalog(SDL, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: "graphql.posts",
        approvedVisitorArguments: approvalOverrides.approvedVisitorArguments ?? [
          "limit",
          "page",
          "sort",
        ],
        identityArguments: {},
        approvedOutputFields: ["id", "title", "heroImage.url", "category.title"],
        requiredOutputFields: ["id"],
        policy: {
          authentication: "public",
          maximumRows: policyOverrides.maximumRows ?? 50,
          ...(policyOverrides.maximumPageSize !== undefined
            ? { maximumPageSize: policyOverrides.maximumPageSize }
            : {}),
          timeoutMs: 5_000,
          cacheTtlSeconds: 0,
        },
        limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
      },
    ],
  });
}

const ROWS = Array.from({ length: 42 }, (_, index) => ({
  id: index + 1,
  title: `Story ${index + 1}`,
  heroImage: { url: `/media/${index + 1}.jpg` },
  category: { title: "News" },
}));

describe("discovery through a declared envelope", () => {
  const posts = () =>
    listGraphQlQueries(SDL, {
      scalarMappings: SCALARS,
      listEnvelopes: { Posts: ENVELOPE },
    }).find((query) => query.fieldName === "Posts")!;

  it("reports row-relative paths, never docs-prefixed ones", () => {
    const paths = posts().outputFields.map((field) => field.path);
    expect(paths).toContain("title");
    expect(paths).toContain("heroImage.url");
    expect(paths).toContain("category.title");
    expect(paths.some((path) => path.startsWith("docs."))).toBe(false);
  });

  it("offers no envelope plumbing as a selectable field", () => {
    const paths = posts().outputFields.map((field) => field.path);
    for (const plumbing of ["totalDocs", "hasNextPage", "page", "limit", "pagingCounter"]) {
      expect(paths).not.toContain(plumbing);
    }
  });

  it("suggests collection and echoes the declaration", () => {
    expect(posts().suggestedResultShape).toBe("collection");
    expect(posts().listEnvelope).toEqual(ENVELOPE);
    expect(posts().support.status).toBe("supported");
  });

  it("warns about the envelope shape when nothing was declared", () => {
    // The report is a question, not a claim: the same shape is also an entity
    // with one nested list. It names the candidate rows field so the fix is
    // one line, and it must never populate the declaration itself.
    const undeclared = listGraphQlQueries(SDL, { scalarMappings: SCALARS }).find(
      (query) => query.fieldName === "Posts",
    )!;
    const warning = undeclared.issues.find((issue) =>
      issue.message.includes("listEnvelope"),
    );
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain('rowsField: "docs"');
    expect(undeclared.listEnvelope).toBeUndefined();
    expect(undeclared.suggestedResultShape).toBe("entity");
  });

  it("acknowledges the false-positive class: an entity with one nested list also warns", () => {
    // Deliberate, not a bug to fix later: `Order { id, lines: [Line!]! }` is
    // structurally an envelope. The warning is phrased conditionally for
    // exactly this case; asserting it here makes the behaviour a decision.
    const entity = `
      type Line { sku: String!, quantity: Int! }
      type Order { id: ID!, number: String!, lines: [Line!]! }
      type Query { order: Order }
    `;
    const candidate = listGraphQlQueries(entity).find(
      (query) => query.fieldName === "order",
    )!;
    expect(
      candidate.issues.some((issue) => issue.message.includes("listEnvelope")),
    ).toBe(true);
  });
});

describe("declaration validation fails closed with the fix named", () => {
  const declare = (declaration: Record<string, unknown>) => () =>
    listGraphQlQueries(SDL, {
      scalarMappings: SCALARS,
      listEnvelopes: { Posts: declaration as never },
    });

  it("refuses a rowsField the type does not declare", () => {
    expect(declare({ rowsField: "items" })).toThrow(/"items" is not a field of "Posts"/);
  });

  it("refuses a rowsField that is not a list", () => {
    expect(declare({ rowsField: "page" })).toThrow(/not a list/);
  });

  it("refuses a non-numeric totalCountField", () => {
    const stringTotal = `
      type Row { id: ID! }
      type Rows { docs: [Row!]!, totalDocs: String! }
      type Query { rows: Rows }
    `;
    expect(() =>
      listGraphQlQueries(stringTotal, {
        listEnvelopes: { rows: { rowsField: "docs", totalCountField: "totalDocs" } },
      }),
    ).toThrow(/not numeric/);
  });

  it("refuses a hasNextPageField that is not Boolean", () => {
    expect(declare({ rowsField: "docs", hasNextPageField: "totalDocs" })).toThrow(
      /not Boolean/,
    );
  });

  it("refuses a paging argument the field does not declare", () => {
    expect(declare({ rowsField: "docs", pageSizeArgument: "first" })).toThrow(
      /paging argument "first", which "Posts" does not declare/,
    );
  });

  it("refuses a declaration on a real Relay connection", () => {
    const relay = `
      type Row { id: ID! }
      type RowEdge { node: Row!, cursor: String! }
      type RowConnection { edges: [RowEdge!]! }
      type Query { rows(first: Int): RowConnection }
    `;
    expect(() =>
      listGraphQlQueries(relay, {
        listEnvelopes: { rows: { rowsField: "edges" } },
      }),
    ).toThrow(/Relay connection; remove its listEnvelope declaration/);
  });
});

describe("the structural refusal: a list shape needs somewhere for rows to come from", () => {
  it("refuses collection over an undeclared envelope, naming the declaration", () => {
    // Before this check the combination compiled, published, probed ok, and
    // then delivered one object where the runtime counts rows — an invisible
    // dead end three stages from its cause.
    const draft = createGraphQlCatalogInventory({
      schema: SDL,
      catalog: { id: "payload", version: "1.0.0", description: "x" },
      source: { id: "payload-cms", label: "Payload", description: "x" },
      queries: [
        {
          fieldName: "Posts",
          capabilityId: "graphql.posts",
          purpose: "List posts.",
          dataTypeId: "post",
          resultShape: "collection",
          scalarMappings: SCALARS,
        },
      ],
    });
    expect(() =>
      compileApprovedGraphQlCatalog(SDL, draft, {
        schemaVersion: "1.0",
        reviewSourceHash: draft.reviewSourceHash,
        queries: [
          {
            capabilityId: "graphql.posts",
            approvedVisitorArguments: [],
            identityArguments: {},
            approvedOutputFields: ["docs.id", "docs.title"],
            requiredOutputFields: ["docs.id"],
            policy: {
              authentication: "public",
              maximumRows: 50,
              timeoutMs: 5_000,
              cacheTtlSeconds: 0,
            },
            limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
          },
        ],
      }),
    ).toThrow(/listEnvelope: \{ rowsField: "docs" \}/);
  });

  it("still compiles an entity over the same root", () => {
    // `entity` is not a list shape; the refusal must not catch it.
    const draft = createGraphQlCatalogInventory({
      schema: SDL,
      catalog: { id: "payload", version: "1.0.0", description: "x" },
      source: { id: "payload-cms", label: "Payload", description: "x" },
      queries: [
        {
          fieldName: "Posts",
          capabilityId: "graphql.posts",
          purpose: "The posts envelope as one record.",
          dataTypeId: "posts-envelope",
          resultShape: "entity",
          scalarMappings: SCALARS,
        },
      ],
    });
    const compiled = compileApprovedGraphQlCatalog(SDL, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      semanticTypeOverrides: { "Query.Posts.totalDocs": "quantity" },
      queries: [
        {
          capabilityId: "graphql.posts",
          approvedVisitorArguments: [],
          identityArguments: {},
          approvedOutputFields: ["totalDocs"],
          requiredOutputFields: ["totalDocs"],
          policy: {
            authentication: "public",
            maximumRows: 1,
            timeoutMs: 5_000,
            cacheTtlSeconds: 0,
          },
          limits: { maximumSelectionDepth: 1, maximumSelectedFields: 1 },
        },
      ],
    });
    expect(compiled.catalog.capabilities).toHaveLength(1);
  });
});

describe("a generated placeholder purpose is refused at compile", () => {
  it("names the capability and the fact that the draft cannot be hand-patched", () => {
    // The headless CLI writes "Review the purpose of …" when the host supplied
    // none, and that string used to publish silently — becoming the prose the
    // planner reads to choose the capability. It is hash-covered, so the only
    // honest fix is upstream of the hash, which is what the error must say.
    const draft = createGraphQlCatalogInventory({
      schema: SDL,
      catalog: { id: "payload", version: "1.0.0", description: "x" },
      source: { id: "payload-cms", label: "Payload", description: "x" },
      queries: [
        {
          fieldName: "Posts",
          capabilityId: "graphql.posts",
          purpose: "Review the purpose of graphql.Posts before publishing.",
          dataTypeId: "post",
          resultShape: "collection",
          scalarMappings: SCALARS,
          listEnvelope: ENVELOPE,
        },
      ],
    });
    expect(() =>
      compileApprovedGraphQlCatalog(SDL, draft, {
        schemaVersion: "1.0",
        reviewSourceHash: draft.reviewSourceHash,
        queries: [
          {
            capabilityId: "graphql.posts",
            approvedVisitorArguments: [],
            identityArguments: {},
            approvedOutputFields: ["id", "title"],
            requiredOutputFields: ["id"],
            policy: {
              authentication: "public",
              maximumRows: 50,
              timeoutMs: 5_000,
              cacheTtlSeconds: 0,
            },
            limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
          },
        ],
      }),
    ).toThrow(/placeholder purpose[\s\S]*take the inventory again/);
  });
});

describe("compiling an envelope query", () => {
  it("puts the envelope back with paging fields as siblings, no node hop", () => {
    const compiled = approvedCatalog();
    const operation = compileGraphQlOperation(
      SDL,
      compiled.bindings.get("graphql.posts")!,
      { capabilityId: "graphql.posts", params: { limit: 3 } },
      {},
    );
    expect(operation.document).toContain("docs {");
    expect(operation.document).not.toContain("node {");
    expect(operation.document).not.toContain("pageInfo");
    // Paging facts are siblings of the rows on this family of API.
    expect(operation.document).toMatch(/\n {4}hasNextPage\n/);
    expect(operation.document).toMatch(/\n {4}totalDocs\n/);
    expect(operation.variables).toEqual({ limit: 3 });
  });

  it("validates the response as an array of rows", () => {
    const compiled = approvedCatalog();
    const operation = compileGraphQlOperation(
      SDL,
      compiled.bindings.get("graphql.posts")!,
      { capabilityId: "graphql.posts", params: {} },
      {},
    );
    expect(operation.outputSchema).toMatchObject({ type: "array" });
  });

  it("keeps the binding's approved paths row-relative end to end", () => {
    const binding = approvedCatalog().bindings.get("graphql.posts")!;
    expect(binding.approvedOutputFields).toContain("heroImage.url");
    expect(
      binding.approvedOutputFields.some((path) => path.startsWith("docs.")),
    ).toBe(false);
    expect(binding.listEnvelope).toEqual(ENVELOPE);
    expect(binding.connection).toBeUndefined();
  });
});

describe("paging arguments are transport, not steering", () => {
  it("excludes declared paging arguments from source-narrowing facts", () => {
    // `limit` chooses how much to read; `sort` and `where` choose what
    // qualifies. Advertising `limit` as narrowing tells the planner a page
    // size is a filter — the exact false claim sourceNarrowingArguments ends.
    const capability = approvedCatalog().catalog.capabilities[0]!;
    const narrowing = capability.supports?.sourceNarrowingArguments ?? [];
    expect(narrowing).toContain("sort");
    expect(narrowing).not.toContain("limit");
    expect(narrowing).not.toContain("page");
  });

  it("bounds the declared page-size argument in the planner contract", () => {
    const capability = approvedCatalog({ maximumPageSize: 25 }).catalog.capabilities[0]!;
    const limitSchema = (
      capability.inputSchema as {
        properties: Record<string, { minimum?: number; maximum?: number }>;
      }
    ).properties.limit!;
    expect(limitSchema.maximum).toBe(25);
    expect(limitSchema.minimum).toBe(1);
  });
});

describe("executing an envelope query", () => {
  const run = (
    params: Record<string, unknown> = {},
    context: { limit?: number } = {},
    transport = payloadConformanceTransport({ rows: ROWS }),
  ) => {
    const compiled = approvedCatalog();
    return executeApprovedGraphQlRequest({
      catalog: compiled.catalog,
      schema: SDL,
      binding: compiled.bindings.get("graphql.posts")!,
      request: { capabilityId: "graphql.posts", params },
      context: { identity: {}, ...context },
      transport,
      resolveProvenance: () => ({
        sources: [{ sourceId: "payload-cms" }],
        freshness: { asOf: "2026-08-24T10:00:00.000Z" },
      }),
    });
  };

  it("delivers rows, not the envelope", async () => {
    const result = await run({ limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.data as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ id: 1, title: "Story 1" });
    expect(rows[0]).not.toHaveProperty("docs");
  });

  it("reports the whole set behind a truncated page, from totalDocs", async () => {
    const result = await run({ limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.truncated).toBe(true);
    expect(result.provenance.totalRowsBeforeTruncation).toBe(42);
    expect(result.provenance.moreAvailable).toBe(true);
  });

  it("claims no truncation when the plan's own limit was met", async () => {
    const result = await run({ limit: 10 }, { limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.truncated).toBeUndefined();
  });

  it("drops a null row rather than failing the collection", async () => {
    const result = await run({ limit: 2 }, {}, (async () => ({
      data: {
        Posts: {
          docs: [ROWS[0], null],
          hasNextPage: false,
          totalDocs: 2,
        },
      },
    })) as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
  });

  it("names the envelope, not a connection, when the response is malformed", async () => {
    const result = await run({}, {}, (async () => ({
      data: { Posts: { docs: "not-a-list", hasNextPage: false, totalDocs: 0 } },
    })) as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GRAPHQL_INVALID_RESPONSE");
    expect(result.error.message).toContain("list envelope");
    expect(result.error.message).not.toContain('with "node"');
  });

  it("treats a null envelope as a named failure, not an unwrap crash", async () => {
    const result = await run({}, {}, (async () => ({ data: { Posts: null } })) as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GRAPHQL_NULL_RESULT");
  });

  it("degrades a failed optional field to its row-relative path", async () => {
    const result = await run({ limit: 2 }, {}, (async () => ({
      data: {
        Posts: {
          docs: [{ ...ROWS[0], heroImage: null }, ROWS[1]],
          hasNextPage: false,
          totalDocs: 2,
        },
      },
      errors: [
        {
          message: "Media unavailable",
          path: ["Posts", "docs", 0, "heroImage", "url"],
        },
      ],
    })) as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.degradedFields).toEqual(["heroImage.url"]);
  });

  it("keeps an error on the envelope wrapper fatal", async () => {
    const result = await run({}, {}, (async () => ({
      data: { Posts: null },
      errors: [{ message: "count failed", path: ["Posts", "totalDocs"] }],
    })) as never);
    expect(result.ok).toBe(false);
  });
});

describe("the runtime injects the declared page size", () => {
  const runtimeVariables = (
    limit: number | undefined,
    params: Record<string, unknown> = {},
    policyOverrides: { maximumRows?: number; maximumPageSize?: number } = {},
  ) => {
    const compiled = approvedCatalog(policyOverrides);
    const transport = payloadConformanceTransport({ rows: ROWS });
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema: SDL,
      binding: compiled.bindings.get("graphql.posts")!,
      transport,
      resolveProvenance: () => ({
        sources: [{ sourceId: "payload-cms" }],
        freshness: { asOf: "2026-08-24T10:00:00.000Z" },
      }),
    });
    return runtime
      .execute(params, { identity: {}, ...(limit === undefined ? {} : { limit }) })
      .then(() => transport.calls[0]!);
  };

  it("asks the upstream for only as many rows as the plan wants", async () => {
    // Without this a plan wanting 10 rows fetched Payload's default page of 10
    // by luck, or a configured default of 100 by silent excess.
    expect(await runtimeVariables(7)).toMatchObject({ limit: 7 });
  });

  it("does not override a page size the planner chose itself", async () => {
    expect(await runtimeVariables(7, { limit: 3 })).toMatchObject({ limit: 3 });
  });

  it("clamps the derived page size to the declared cap", async () => {
    expect(await runtimeVariables(500, {}, { maximumPageSize: 25 })).toMatchObject({
      limit: 25,
    });
  });
});
