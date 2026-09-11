import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCapabilityRuntime,
  createGraphQlCatalogInventory,
  type GraphQlTransport,
} from "../src/graphql.js";
import { describeFilterRefusal, renderFilterValue } from "../src/filter-pushdown.js";
import { createDataPlanningContract } from "../src/planning-contract.js";
import { createPlannerManifest } from "../src/compile.js";

/**
 * SPIKE — what actually happens when real ecosystems' schema conventions meet
 * this pipeline. Fixtures are written from each ecosystem's documented schema
 * shape, not from what this package supports. Failures here are findings, not
 * regressions.
 */

function inventoryOf(sdl: string, query: Record<string, unknown>) {
  return createGraphQlCatalogInventory({
    schema: sdl,
    catalog: { id: "spike", version: "1.0.0", description: "Convention spike." },
    source: { id: "spike-api", label: "Spike", description: "Fixture upstream." },
    queries: [
      {
        purpose: "List records for a reader.",
        dataTypeId: "record",
        dataTypeDescription: "One record.",
        resultShape: "collection",
        ...query,
      } as never,
    ],
  });
}

function approve(
  sdl: string,
  query: Record<string, unknown>,
  decisions: Record<string, unknown>,
  extras: Record<string, unknown> = {},
) {
  const draft = inventoryOf(sdl, query);
  return compileApprovedGraphQlCatalog(sdl, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    ...extras,
    queries: [
      {
        identityArguments: {},
        policy: { authentication: "public", maximumRows: 50, timeoutMs: 5_000, cacheTtlSeconds: 0 },
        limits: { maximumSelectionDepth: 6, maximumSelectedFields: 60 },
        ...decisions,
      } as never,
    ],
  });
}

// ─── Hasura ──────────────────────────────────────────────────────────────────

const HASURA_SDL = /* GraphQL */ `
  scalar timestamptz

  type Query {
    articles(
      where: articles_bool_exp
      order_by: [articles_order_by!]
      limit: Int
      offset: Int
    ): [articles!]!
  }

  type articles {
    id: Int!
    title: String!
    published_at: timestamptz
  }

  input articles_bool_exp {
    _and: [articles_bool_exp!]
    _or: [articles_bool_exp!]
    _not: articles_bool_exp
    id: Int_comparison_exp
    title: String_comparison_exp
    published_at: timestamptz_comparison_exp
  }

  input Int_comparison_exp {
    _eq: Int
    _neq: Int
    _gt: Int
    _gte: Int
    _lt: Int
    _lte: Int
    _in: [Int!]
    _is_null: Boolean
  }

  input String_comparison_exp {
    _eq: String
    _neq: String
    _like: String
    _ilike: String
    _in: [String!]
    _is_null: Boolean
  }

  input timestamptz_comparison_exp {
    _eq: timestamptz
    _gt: timestamptz
    _gte: timestamptz
    _lt: timestamptz
    _lte: timestamptz
    _is_null: Boolean
  }

  enum order_by_enum {
    asc
    asc_nulls_first
    desc
    desc_nulls_last
  }

  input articles_order_by {
    id: order_by_enum
    title: order_by_enum
    published_at: order_by_enum
  }
`;

const HASURA_ROWS = [
  { id: 1, title: "Inland Waters bill passes", published_at: "2026-08-01" },
  { id: 2, title: "City draw at home", published_at: "2026-08-02" },
  { id: 3, title: "Inland Waters, explained", published_at: null },
];

/**
 * Honours Hasura's own rules: `_not` takes ONE bool_exp (a list is a type
 * error a real Hasura rejects), `_and`/`_or` take lists, operators are the
 * `_eq` family. Unknown operator names are rejected the way variable coercion
 * rejects them.
 */
function hasuraTransport(): GraphQlTransport & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const OPERATORS = new Set(["_eq", "_neq", "_gt", "_gte", "_lt", "_lte", "_in", "_like", "_ilike", "_is_null"]);
  const matches = (row: Record<string, unknown>, exp: Record<string, unknown>): boolean => {
    for (const [key, condition] of Object.entries(exp)) {
      if (key === "_and") {
        if (!Array.isArray(condition)) throw new Error("_and expects a list");
        if (!condition.every((part) => matches(row, part))) return false;
        continue;
      }
      if (key === "_or") {
        if (!Array.isArray(condition)) throw new Error("_or expects a list");
        if (!condition.some((part) => matches(row, part))) return false;
        continue;
      }
      if (key === "_not") {
        if (Array.isArray(condition)) throw new Error("_not expects a single bool_exp, got a list");
        if (matches(row, condition as Record<string, unknown>)) return false;
        continue;
      }
      const value = row[key];
      for (const [operator, operand] of Object.entries(condition as Record<string, unknown>)) {
        if (!OPERATORS.has(operator)) throw new Error(`unknown operator ${operator}`);
        if (operator === "_eq" && value !== operand) return false;
        if (operator === "_neq" && value === operand) return false;
        if (operator === "_gt" && !(value !== null && (value as never) > (operand as never))) return false;
        if (operator === "_gte" && !(value !== null && (value as never) >= (operand as never))) return false;
        if (operator === "_lt" && !(value !== null && (value as never) < (operand as never))) return false;
        if (operator === "_lte" && !(value !== null && (value as never) <= (operand as never))) return false;
        if (operator === "_in" && !(operand as unknown[]).includes(value)) return false;
        if (operator === "_ilike" && !String(value ?? "").toLowerCase().includes(String(operand).toLowerCase().replaceAll("%", ""))) return false;
        if (operator === "_is_null" && (value === null) !== operand) return false;
      }
    }
    return true;
  };
  const transport: GraphQlTransport = async (request) => {
    const variables = { ...(request.variables ?? {}) };
    calls.push(variables);
    try {
      let rows = [...HASURA_ROWS];
      const where = variables["where"] as Record<string, unknown> | undefined;
      if (where) rows = rows.filter((row) => matches(row, where));
      const limit = typeof variables["limit"] === "number" ? (variables["limit"] as number) : rows.length;
      return { data: { articles: rows.slice(0, limit) } };
    } catch (error) {
      return { data: null, errors: [{ message: String(error) }] };
    }
  };
  return Object.assign(transport, { calls });
}

function hasuraCompiled() {
  return approve(
    HASURA_SDL,
    {
      fieldName: "articles",
      capabilityId: "hasura.articles",
      matchKey: "id",
      scalarMappings: { timestamptz: { schema: { type: ["string", "null"] } } },
    },
    {
      capabilityId: "hasura.articles",
      approvedVisitorArguments: [],
      approvedOutputFields: ["id", "title", "published_at"],
      requiredOutputFields: ["id"],
    },
    { semanticTypeOverrides: { "Query.articles.id": "identifier" } },
  );
}

describe("Hasura conventions", () => {
  it("compiles a plain-list snake_case schema at all", () => {
    const compiled = hasuraCompiled();
    expect(compiled.catalog.capabilities).toHaveLength(1);
  });

  it("resolves the _eq operator family and _and/_or/_not combinators", () => {
    const binding = hasuraCompiled().bindings.get("hasura.articles")!;
    expect(binding.filter?.argument).toBe("where");
    expect(binding.filter?.fields["title"]?.operators["eq"]).toBe("_eq");
    expect(binding.filter?.fields["title"]?.operators["contains"]).toBe("_ilike");
    expect(binding.filter?.fields["published_at"]?.nullTest).toEqual({ name: "_is_null", nullValue: true });
    expect(binding.filter?.combinators).toEqual({
      all: { name: "_and", list: true },
      any: { name: "_or", list: true },
      none: { name: "_not", list: false },
    });
  });

  it("executes a pushed filter and the rows that come back are the ones that qualify", async () => {
    const compiled = hasuraCompiled();
    const transport = hasuraTransport();
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema: HASURA_SDL,
      binding: compiled.bindings.get("hasura.articles")!,
      transport,
      resolveProvenance: () => ({ sources: [{ sourceId: "spike-api" }], freshness: { asOf: "2026-08-01T00:00:00Z" } }),
    });
    const result = await runtime.execute(
      {},
      {
        identity: { subject: "reader" },
        filter: { combine: "all", conditions: [{ field: "title", operator: "contains", value: "Inland" }] },
      },
    );
    expect(result.ok).toBe(true);
    expect((result as { data: Record<string, unknown>[] }).data.map((row) => row["id"])).toEqual([1, 3]);
  });

  it("FINDING? a `none` group must compile to a single bool_exp, not a list", async () => {
    const compiled = hasuraCompiled();
    const transport = hasuraTransport();
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema: HASURA_SDL,
      binding: compiled.bindings.get("hasura.articles")!,
      transport,
      resolveProvenance: () => ({ sources: [{ sourceId: "spike-api" }], freshness: { asOf: "2026-08-01T00:00:00Z" } }),
    });
    const result = await runtime.execute(
      {},
      {
        identity: { subject: "reader" },
        filter: { combine: "none", conditions: [{ field: "title", operator: "contains", value: "Inland" }] },
      },
    );
    // Hasura's _not takes one expression. If we rendered a list, the transport
    // errored and this comes back not-ok (or fell back to local narrowing).
    console.error("HASURA none-group:", JSON.stringify({ ok: result.ok, sent: transport.calls[0]?.["where"] ?? null, rows: result.ok ? (result as { data: unknown[] }).data.length : null, error: result.ok ? null : (result as { error: { message: string } }).error.message }));
    expect(result.ok).toBe(true);
    expect((result as { data: Record<string, unknown>[] }).data.map((row) => row["id"])).toEqual([2]);
  });
});

// ─── Strapi v5 ───────────────────────────────────────────────────────────────

const STRAPI_SDL = /* GraphQL */ `
  type Query {
    articles(filters: ArticleFiltersInput, sort: [String], pagination: PaginationArg): [Article]
  }

  type Article {
    documentId: ID!
    title: String
    views: Int
  }

  input ArticleFiltersInput {
    documentId: IDFilterInput
    title: StringFilterInput
    views: IntFilterInput
    and: [ArticleFiltersInput]
    or: [ArticleFiltersInput]
    not: ArticleFiltersInput
  }

  input IDFilterInput { eq: ID, ne: ID, in: [ID] }
  input StringFilterInput { eq: String, ne: String, containsi: String, in: [String], null: Boolean, notNull: Boolean }
  input IntFilterInput { eq: Int, ne: Int, gt: Int, gte: Int, lt: Int, lte: Int, between: [Int] }
  input PaginationArg { page: Int, pageSize: Int, start: Int, limit: Int }
`;

describe("Strapi v5 conventions", () => {
  function compiled() {
    return approve(
      STRAPI_SDL,
      { fieldName: "articles", capabilityId: "strapi.articles", matchKey: "documentId" },
      {
        capabilityId: "strapi.articles",
        approvedVisitorArguments: [],
        approvedOutputFields: ["documentId", "title", "views"],
        requiredOutputFields: ["documentId"],
        orderingArgument: { name: "sort", ascending: "{field}:asc", descending: "{field}:desc" },
      },
      { semanticTypeOverrides: { "Query.articles.views": "quantity" } },
    );
  }

  it("resolves the eq/containsi vocabulary on the `filters` argument", () => {
    const binding = compiled().bindings.get("strapi.articles")!;
    console.error("STRAPI filter:", JSON.stringify(binding.filter ?? null));
    expect(binding.filter?.argument).toBe("filters");
    expect(binding.filter?.fields["title"]?.operators["eq"]).toBe("eq");
    expect(binding.filter?.fields["title"]?.operators["contains"]).toBe("containsi");
    expect(binding.filter?.fields["views"]?.operators["gte"]).toBe("gte");
    expect(binding.filter?.combinators).toEqual({
      all: { name: "and", list: true },
      any: { name: "or", list: true },
      none: { name: "not", list: false },
    });
  });

  it("takes the declared string sort grammar alongside", () => {
    const binding = compiled().bindings.get("strapi.articles")!;
    expect(binding.ordering?.argument).toBe("sort");
  });

  it("takes a nested page size when the host declares the path", async () => {
    // Strapi pages with `pagination: { page, pageSize }`. The envelope's own
    // `pageSizeArgument` names a top-level argument, so this shape could not be
    // declared at all — nothing set the page size, `maximumRows` became a
    // truncation after the fetch, and the planner was told an argument that
    // chooses how much chooses which records qualify.
    const compiled = approve(
      STRAPI_SDL,
      { fieldName: "articles", capabilityId: "strapi.articles", matchKey: "documentId" },
      {
        capabilityId: "strapi.articles",
        approvedVisitorArguments: ["pagination"],
        approvedOutputFields: ["documentId", "title", "views"],
        requiredOutputFields: ["documentId"],
        pagingArguments: { pageSize: "pagination.pageSize", pageArguments: ["pagination.page"] },
      },
      { semanticTypeOverrides: { "Query.articles.views": "quantity" } },
    );
    const binding = compiled.bindings.get("strapi.articles")!;
    expect(binding.paging?.pageSize).toEqual(["pagination", "pageSize"]);

    const seen: Record<string, unknown>[] = [];
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema: STRAPI_SDL,
      binding,
      transport: async (request) => {
        seen.push({ ...(request.variables ?? {}) });
        return { data: { articles: [] } };
      },
      resolveProvenance: () => ({
        sources: [{ sourceId: "spike-api" }],
        freshness: { asOf: "2026-08-01T00:00:00Z" },
      }),
    });
    await runtime.execute({}, { identity: { subject: "reader" }, limit: 7 });
    // Written at the nested path, not at the root.
    expect(seen[0]!["pagination"]).toEqual({ pageSize: 7 });
  });

  it("leaves a page the planner already chose alone, and keeps its siblings", async () => {
    const compiled = approve(
      STRAPI_SDL,
      { fieldName: "articles", capabilityId: "strapi.articles", matchKey: "documentId" },
      {
        capabilityId: "strapi.articles",
        approvedVisitorArguments: ["pagination"],
        approvedOutputFields: ["documentId", "title", "views"],
        requiredOutputFields: ["documentId"],
        pagingArguments: { pageSize: "pagination.pageSize", pageArguments: ["pagination.page"] },
      },
      { semanticTypeOverrides: { "Query.articles.views": "quantity" } },
    );
    const seen: Record<string, unknown>[] = [];
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema: STRAPI_SDL,
      binding: compiled.bindings.get("strapi.articles")!,
      transport: async (request) => {
        seen.push({ ...(request.variables ?? {}) });
        return { data: { articles: [] } };
      },
      resolveProvenance: () => ({
        sources: [{ sourceId: "spike-api" }],
        freshness: { asOf: "2026-08-01T00:00:00Z" },
      }),
    });
    // The plan asked for page 3 with its own size: neither is overwritten, and
    // `page` survives the write that would otherwise replace the object.
    await runtime.execute(
      { pagination: { page: 3, pageSize: 25 } },
      { identity: { subject: "reader" }, limit: 7 },
    );
    expect(seen[0]!["pagination"]).toEqual({ page: 3, pageSize: 25 });
  });

  it("refuses a paging path whose argument the planner may not set", () => {
    expect(() =>
      approve(
        STRAPI_SDL,
        { fieldName: "articles", capabilityId: "strapi.articles", matchKey: "documentId" },
        {
          capabilityId: "strapi.articles",
          approvedVisitorArguments: [],
          approvedOutputFields: ["documentId", "title", "views"],
          requiredOutputFields: ["documentId"],
          pagingArguments: { pageSize: "pagination.pageSize" },
        },
        { semanticTypeOverrides: { "Query.articles.views": "quantity" } },
      ),
    ).toThrow(/not in approvedVisitorArguments/);
  });

  it("stops calling a paging argument one that narrows at the source", () => {
    const compiled = approve(
      STRAPI_SDL,
      { fieldName: "articles", capabilityId: "strapi.articles", matchKey: "documentId" },
      {
        capabilityId: "strapi.articles",
        approvedVisitorArguments: ["pagination", "filters"],
        approvedOutputFields: ["documentId", "title", "views"],
        requiredOutputFields: ["documentId"],
        pagingArguments: { pageSize: "pagination.pageSize" },
      },
      { semanticTypeOverrides: { "Query.articles.views": "quantity" } },
    );
    const supports = compiled.catalog.capabilities[0]!.supports;
    // `filters` narrows; `pagination` chooses how much. Advertising the second
    // as narrowing is how a planner comes to believe `pageSize: 10` answers
    // "the ten newest".
    expect(supports?.sourceNarrowingArguments).toEqual(["filters"]);
  });

  it("has no page-size role until the host declares one", () => {
    // Without `pagingArguments` there is still nothing to manage the window
    // with, which is correct: this package does not guess which argument pages.
    // The finding this replaces was that there was no way to declare it.
    const binding = compiled().bindings.get("strapi.articles")!;
    expect(binding.paging).toBeUndefined();
    expect(binding.listEnvelope).toBeUndefined();
  });
});

// ─── Prisma / Keystone ───────────────────────────────────────────────────────

const PRISMA_SDL = /* GraphQL */ `
  type Query {
    posts(where: PostWhereInput, orderBy: [PostOrderByInput!], take: Int, skip: Int): [Post!]!
  }

  type Post {
    id: ID!
    title: String!
    score: Int!
  }

  input PostWhereInput {
    id: IDFilter
    title: StringFilter
    score: IntFilter
    AND: [PostWhereInput!]
    OR: [PostWhereInput!]
    NOT: [PostWhereInput!]
  }

  input IDFilter { equals: ID, in: [ID!], not: ID }
  input StringFilter { equals: String, contains: String, startsWith: String, endsWith: String, not: String }
  input IntFilter { equals: Int, gt: Int, gte: Int, lt: Int, lte: Int, not: Int }

  enum OrderDirection { asc desc }
  input PostOrderByInput { id: OrderDirection, title: OrderDirection, score: OrderDirection }
`;

describe("Prisma/Keystone conventions", () => {
  function compiled() {
    return approve(
      PRISMA_SDL,
      { fieldName: "posts", capabilityId: "prisma.posts", matchKey: "id" },
      {
        capabilityId: "prisma.posts",
        approvedVisitorArguments: [],
        approvedOutputFields: ["id", "title", "score"],
        requiredOutputFields: ["id"],
      },
      { semanticTypeOverrides: { "Query.posts.score": "quantity" } },
    );
  }

  it("resolves equals/contains/startsWith and AND/OR/NOT", () => {
    const binding = compiled().bindings.get("prisma.posts")!;
    console.error("PRISMA filter:", JSON.stringify(binding.filter ?? null));
    expect(binding.filter?.argument).toBe("where");
    expect(binding.filter?.fields["title"]?.operators["eq"]).toBe("equals");
    expect(binding.filter?.fields["title"]?.operators["starts-with"]).toBe("startsWith");
    expect(binding.filter?.combinators).toEqual({
      all: { name: "AND", list: true },
      any: { name: "OR", list: true },
      none: { name: "NOT", list: true },
    });
  });

  it("FINDING? take/skip paging is not recognised as paging", () => {
    // PAGING_ARGUMENT_NAMES is the Relay set; `take`/`skip` are neither Relay
    // nor a declared envelope's pageSizeArgument. What are they classified as?
    const compiledCatalog = compiled();
    const capability = compiledCatalog.catalog.capabilities[0]!;
    console.error("PRISMA narrowing args:", JSON.stringify(capability.supports?.sourceNarrowingArguments ?? null));
    expect(capability.supports?.sourceNarrowingArguments ?? []).not.toContain("take");
  });
});

// ─── PostGraphile (connection-filter plugin vocabulary) ─────────────────────

const POSTGRAPHILE_SDL = /* GraphQL */ `
  type Query {
    allArticles(first: Int, after: String, filter: ArticleFilter, orderBy: [ArticlesOrderBy!]): ArticlesConnection
  }

  type ArticlesConnection {
    edges: [ArticlesEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type ArticlesEdge { cursor: String, node: Article! }
  type PageInfo { hasNextPage: Boolean!, hasPreviousPage: Boolean!, endCursor: String }

  type Article { id: Int!, headline: String! }

  input ArticleFilter {
    id: IntFilter
    headline: StringFilter
    and: [ArticleFilter!]
    or: [ArticleFilter!]
    not: ArticleFilter
  }

  input IntFilter { equalTo: Int, notEqualTo: Int, lessThan: Int, greaterThan: Int, in: [Int!], isNull: Boolean }
  input StringFilter { equalTo: String, notEqualTo: String, includes: String, includesInsensitive: String, startsWith: String, isNull: Boolean }

  enum ArticlesOrderBy { ID_ASC, ID_DESC, HEADLINE_ASC, HEADLINE_DESC }
`;

describe("PostGraphile conventions", () => {
  function compiled() {
    return approve(
      POSTGRAPHILE_SDL,
      { fieldName: "allArticles", capabilityId: "pg.articles", matchKey: "id" },
      {
        capabilityId: "pg.articles",
        approvedVisitorArguments: [],
        approvedOutputFields: ["id", "headline"],
        requiredOutputFields: ["id"],
      },
    );
  }

  it("detects the connection structurally", () => {
    const binding = compiled().bindings.get("pg.articles")!;
    expect(binding.connection).toBeDefined();
  });

  it("resolves the equalTo vocabulary that was missing entirely", () => {
    const binding = compiled().bindings.get("pg.articles")!;
    expect(binding.filter?.fields["id"]?.operators["eq"]).toBe("equalTo");
    expect(binding.filter?.fields["headline"]?.operators["eq"]).toBe("equalTo");
    // `includesInsensitive` is a substring match natively, unlike SQL LIKE.
    expect(binding.filter?.fields["headline"]?.operators["contains"]).toBe(
      "includesInsensitive",
    );
    expect(binding.filter?.combinators).toEqual({
      all: { name: "and", list: true },
      any: { name: "or", list: true },
      none: { name: "not", list: false },
    });
  });

  /**
   * Honours PostGraphile's connection-filter rules, so the inverse of the LIKE
   * fix cannot pass unnoticed.
   *
   * `includesInsensitive` matches a substring on its own. Wrapping its value in
   * `%…%` — which is exactly right for Hasura's `_ilike` — would send a literal
   * percent to a matcher that does not treat it as a wildcard, and the search
   * would find nothing. That is the same wrong-answer shape as the bug the
   * wildcards fixed, in the opposite direction, and only executing catches it.
   */
  function postgraphileTransport(): GraphQlTransport & { calls: Record<string, unknown>[] } {
    const rows = [
      { id: 1, headline: "Inland Waters bill passes" },
      { id: 2, headline: "City draw at home" },
      { id: 3, headline: "Inland Waters, explained" },
    ];
    const calls: Record<string, unknown>[] = [];
    const OPERATORS = new Set([
      "equalTo",
      "notEqualTo",
      "lessThan",
      "greaterThan",
      "in",
      "isNull",
      "includes",
      "includesInsensitive",
      "startsWith",
    ]);
    const matches = (row: Record<string, unknown>, filter: Record<string, unknown>): boolean => {
      for (const [key, condition] of Object.entries(filter)) {
        if (key === "and") {
          if (!Array.isArray(condition)) throw new Error("and expects a list");
          if (!condition.every((part) => matches(row, part))) return false;
          continue;
        }
        if (key === "or") {
          if (!Array.isArray(condition)) throw new Error("or expects a list");
          if (!condition.some((part) => matches(row, part))) return false;
          continue;
        }
        if (key === "not") {
          if (Array.isArray(condition)) throw new Error("not expects one filter, got a list");
          if (matches(row, condition as Record<string, unknown>)) return false;
          continue;
        }
        const value = row[key];
        for (const [operator, operand] of Object.entries(condition as Record<string, unknown>)) {
          if (!OPERATORS.has(operator)) throw new Error(`unknown operator ${operator}`);
          const text = String(value ?? "");
          if (operator === "equalTo" && value !== operand) return false;
          if (operator === "notEqualTo" && value === operand) return false;
          if (operator === "in" && !(operand as unknown[]).includes(value)) return false;
          if (operator === "isNull" && (value === null) !== operand) return false;
          if (operator === "startsWith" && !text.startsWith(String(operand))) return false;
          // Substring, literally. A `%`-wrapped value simply will not be found,
          // which is the point of executing this rather than resolving it.
          if (operator === "includes" && !text.includes(String(operand))) return false;
          if (
            operator === "includesInsensitive" &&
            !text.toLowerCase().includes(String(operand).toLowerCase())
          ) {
            return false;
          }
        }
      }
      return true;
    };
    const transport: GraphQlTransport = async (request) => {
      const variables = { ...(request.variables ?? {}) };
      calls.push(variables);
      try {
        const filter = variables["filter"] as Record<string, unknown> | undefined;
        const matched = filter ? rows.filter((row) => matches(row, filter)) : [...rows];
        const first = typeof variables["first"] === "number" ? (variables["first"] as number) : matched.length;
        const page = matched.slice(0, first);
        return {
          data: {
            allArticles: {
              edges: page.map((row) => ({ cursor: `c${row.id}`, node: row })),
              pageInfo: { hasNextPage: page.length < matched.length, hasPreviousPage: false, endCursor: null },
              totalCount: matched.length,
            },
          },
        };
      } catch (error) {
        return { data: null, errors: [{ message: String(error) }] };
      }
    };
    return Object.assign(transport, { calls });
  }

  it("executes a substring filter without the wildcards SQL LIKE needs", async () => {
    const compiledCatalog = compiled();
    const transport = postgraphileTransport();
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiledCatalog.catalog,
      schema: POSTGRAPHILE_SDL,
      binding: compiledCatalog.bindings.get("pg.articles")!,
      transport,
      resolveProvenance: () => ({
        sources: [{ sourceId: "spike-api" }],
        freshness: { asOf: "2026-08-01T00:00:00Z" },
      }),
    });
    const result = await runtime.execute(
      {},
      {
        identity: { subject: "reader" },
        filter: {
          combine: "all",
          conditions: [{ field: "headline", operator: "contains", value: "Inland" }],
        },
      },
    );
    expect(result.ok).toBe(true);
    expect((result as { data: Record<string, unknown>[] }).data.map((row) => row["id"])).toEqual([
      1, 3,
    ]);
    // No `%` reached the upstream: this dialect would have matched nothing.
    expect(JSON.stringify(transport.calls[0]!["filter"])).not.toContain("%");
  });

  it("executes a `none` group as one filter, since PostGraphile's not takes one", async () => {
    const compiledCatalog = compiled();
    const transport = postgraphileTransport();
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiledCatalog.catalog,
      schema: POSTGRAPHILE_SDL,
      binding: compiledCatalog.bindings.get("pg.articles")!,
      transport,
      resolveProvenance: () => ({
        sources: [{ sourceId: "spike-api" }],
        freshness: { asOf: "2026-08-01T00:00:00Z" },
      }),
    });
    const result = await runtime.execute(
      {},
      {
        identity: { subject: "reader" },
        filter: {
          combine: "none",
          conditions: [{ field: "headline", operator: "contains", value: "Inland" }],
        },
      },
    );
    expect(result.ok).toBe(true);
    expect((result as { data: Record<string, unknown>[] }).data.map((row) => row["id"])).toEqual([2]);
  });
});

// ─── Contentful (suffix-flattened operators) ─────────────────────────────────

const CONTENTFUL_SDL = /* GraphQL */ `
  type Query {
    blogPostCollection(where: BlogPostFilter, order: [BlogPostOrder], limit: Int, skip: Int): BlogPostCollection
  }

  type BlogPostCollection {
    items: [BlogPost]!
    total: Int!
    skip: Int!
    limit: Int!
  }

  type BlogPost { title: String, slug: String }

  input BlogPostFilter {
    title: String
    title_contains: String
    title_not: String
    title_in: [String]
    slug: String
    slug_in: [String]
    AND: [BlogPostFilter]
    OR: [BlogPostFilter]
  }

  enum BlogPostOrder { title_ASC, title_DESC, sys_publishedAt_ASC, sys_publishedAt_DESC }
`;

describe("Contentful conventions", () => {
  /**
   * Suffix-flattened operators — `title_contains` where Payload writes
   * `title: { contains }` — are documented here as unsupported rather than
   * hidden. Contentful, DatoCMS and older Gatsby use this shape.
   *
   * A resolver for it was built and reverted: the return is speculative without
   * a host on this dialect, and it lives in the filter-compilation path. One
   * finding from that attempt is worth keeping, and is pinned below: equality in
   * this dialect is the bare field name, and a *sort* input object also has one
   * field per column named exactly after it — so a flattened resolver matched
   * Hasura's `order_by` as a filter argument until a genuine suffix was required
   * somewhere in the type. Anyone building this next needs that discriminator.
   */
  it("does not read a sort input as a filter argument", () => {
    const binding = hasuraCompiled().bindings.get("hasura.articles")!;
    expect(binding.filter?.argument).toBe("where");
    expect(Object.keys(binding.filter?.fields ?? {}).sort()).toEqual([
      "id",
      "published_at",
      "title",
    ]);
  });

  it("FINDING? suffix-flattened operators — what resolves?", () => {
    const compiled = approve(
      CONTENTFUL_SDL,
      {
        fieldName: "blogPostCollection",
        capabilityId: "ctf.posts",
        matchKey: "slug",
        listEnvelope: { rowsField: "items", totalCountField: "total", pageSizeArgument: "limit" },
      },
      {
        capabilityId: "ctf.posts",
        approvedVisitorArguments: [],
        approvedOutputFields: ["title", "slug"],
        requiredOutputFields: ["slug"],
      },
    );
    const binding = compiled.bindings.get("ctf.posts")!;
    console.error("CONTENTFUL filter:", JSON.stringify(binding.filter ?? null), "envelope:", JSON.stringify(binding.listEnvelope ?? null));
    expect(binding.listEnvelope?.rowsField).toBe("items");
  });
});

describe("Prisma paging, on a field with no envelope at all", () => {
  it("takes `take` as the page size once declared", async () => {
    // Prisma and Keystone page a plain list with `take`/`skip`. There is no
    // envelope to hang a declaration on, and neither name is Relay's — so
    // before `pagingArguments` this shape had nowhere to state its page size,
    // and `take` was classified as an argument that narrows at the source.
    const compiled = approve(
      PRISMA_SDL,
      { fieldName: "posts", capabilityId: "prisma.posts", matchKey: "id" },
      {
        capabilityId: "prisma.posts",
        approvedVisitorArguments: ["take", "skip", "where"],
        approvedOutputFields: ["id", "title", "score"],
        requiredOutputFields: ["id"],
        pagingArguments: { pageSize: "take", pageArguments: ["skip"] },
      },
      { semanticTypeOverrides: { "Query.posts.score": "quantity" } },
    );
    const binding = compiled.bindings.get("prisma.posts")!;
    expect(binding.paging?.pageSize).toEqual(["take"]);
    expect(compiled.catalog.capabilities[0]!.supports?.sourceNarrowingArguments).toEqual([
      "where",
    ]);

    const seen: Record<string, unknown>[] = [];
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema: PRISMA_SDL,
      binding,
      transport: async (request) => {
        seen.push({ ...(request.variables ?? {}) });
        return { data: { posts: [] } };
      },
      resolveProvenance: () => ({
        sources: [{ sourceId: "spike-api" }],
        freshness: { asOf: "2026-08-01T00:00:00Z" },
      }),
    });
    await runtime.execute({}, { identity: { subject: "reader" }, limit: 5 });
    expect(seen[0]!["take"]).toBe(5);
  });
});

/**
 * Strapi and Prisma, executed rather than resolved.
 *
 * Both were read correctly and neither had ever run. That distinction is not
 * academic: of the three bugs the Hasura transport found, two were correct at
 * resolution and wrong on the wire — a combinator sent as a list where the
 * dialect takes one object, and a substring search sent without the wildcards
 * SQL LIKE needs. Each transport below refuses what its own upstream refuses.
 */
const ROWS = [
  { documentId: "a", title: "Inland Waters bill passes", views: 900 },
  { documentId: "b", title: "City draw at home", views: 120 },
  { documentId: "c", title: "Inland Waters, explained", views: 640 },
];

function dialectTransport(options: {
  responseKey: string;
  filterVariable: string;
  operators: Record<string, (value: unknown, operand: unknown) => boolean>;
  combinators: { all: string; any: string; none: string };
  /** Combinators this dialect gives a list; anything else takes one object. */
  listCombinators: readonly string[];
  /**
   * Relation fields whose filter input has no bare nesting — a condition must
   * sit inside `some`/`every`/`none`. Prisma's list-relation filters are this
   * shape and reject anything else, which is what makes the test enforce the
   * dialect rather than accept whatever is sent.
   */
  quantifiedRelations?: readonly string[];
  rows?: readonly Record<string, unknown>[];
}): GraphQlTransport & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const rows = options.rows ?? ROWS;
  const matches = (row: Record<string, unknown>, filter: Record<string, unknown>): boolean => {
    for (const [key, condition] of Object.entries(filter)) {
      const combine = (["all", "any", "none"] as const).find(
        (mode) => options.combinators[mode] === key,
      );
      if (combine) {
        const wantsList = options.listCombinators.includes(key);
        if (wantsList && !Array.isArray(condition)) {
          throw new Error(`${key} expects a list`);
        }
        if (!wantsList && Array.isArray(condition)) {
          throw new Error(`${key} expects one filter, got a list`);
        }
        const parts = Array.isArray(condition)
          ? (condition as Record<string, unknown>[])
          : [condition as Record<string, unknown>];
        if (combine === "all" && !parts.every((part) => matches(row, part))) return false;
        if (combine === "any" && !parts.some((part) => matches(row, part))) return false;
        if (combine === "none" && parts.some((part) => matches(row, part))) return false;
        continue;
      }
      const entries = Object.entries(condition as Record<string, unknown>);
      // A condition whose keys are not operators is a relation: either a
      // quantifier or the related type's own fields.
      if (entries.some(([name]) => !(name in options.operators))) {
        if (!matchesRelation(key, row[key], condition as Record<string, unknown>)) return false;
        continue;
      }
      for (const [operator, operand] of entries) {
        const test = options.operators[operator]!;
        if (!test(row[key], operand)) return false;
      }
    }
    return true;
  };
  const matchesRelation = (
    relation: string,
    related: unknown,
    condition: Record<string, unknown>,
  ): boolean => {
    const relatedRows = Array.isArray(related)
      ? (related as Record<string, unknown>[])
      : related && typeof related === "object"
        ? [related as Record<string, unknown>]
        : [];
    for (const [name, nested] of Object.entries(condition)) {
      const inner = nested as Record<string, unknown>;
      if (name === "some") {
        if (!relatedRows.some((candidate) => matches(candidate, inner))) return false;
        continue;
      }
      if (name === "none") {
        if (relatedRows.some((candidate) => matches(candidate, inner))) return false;
        continue;
      }
      if (name === "every") {
        if (!relatedRows.every((candidate) => matches(candidate, inner))) return false;
        continue;
      }
      if (options.quantifiedRelations?.includes(relation)) {
        throw new Error(`${relation} takes some/every/none, got ${name}`);
      }
      // A bare nested condition on a to-many relation is existential, which is
      // what Hasura and Strapi mean by it. On a to-one there is one related row
      // and the same evaluation is a plain match.
      if (!relatedRows.some((candidate) => matches(candidate, { [name]: inner }))) return false;
    }
    return true;
  };
  const transport: GraphQlTransport = async (request) => {
    const variables = { ...(request.variables ?? {}) };
    calls.push(variables);
    try {
      const filter = variables[options.filterVariable] as Record<string, unknown> | undefined;
      const matched = filter ? rows.filter((row) => matches(row, filter)) : [...rows];
      return { data: { [options.responseKey]: matched } };
    } catch (error) {
      return { data: null, errors: [{ message: String(error) }] };
    }
  };
  return Object.assign(transport, { calls });
}

const contains = (value: unknown, operand: unknown) =>
  String(value ?? "").toLowerCase().includes(String(operand).toLowerCase());

describe("Strapi, executed", () => {
  const compiled = () =>
    approve(
      STRAPI_SDL,
      { fieldName: "articles", capabilityId: "strapi.articles", matchKey: "documentId" },
      {
        capabilityId: "strapi.articles",
        approvedVisitorArguments: [],
        approvedOutputFields: ["documentId", "title", "views"],
        requiredOutputFields: ["documentId"],
      },
      { semanticTypeOverrides: { "Query.articles.views": "quantity" } },
    );

  const transport = () =>
    dialectTransport({
      responseKey: "articles",
      filterVariable: "filters",
      // `containsi` is case-insensitive substring natively — no wildcards.
      operators: {
        eq: (value, operand) => value === operand,
        ne: (value, operand) => value !== operand,
        containsi: contains,
        gte: (value, operand) => Number(value) >= Number(operand),
        lte: (value, operand) => Number(value) <= Number(operand),
      },
      combinators: { all: "and", any: "or", none: "not" },
      // Strapi's `not` takes one filter, like Hasura's `_not`.
      listCombinators: ["and", "or"],
    });

  const runtimeFor = (t: GraphQlTransport) => {
    const compiledCatalog = compiled();
    return createGraphQlCapabilityRuntime({
      catalog: compiledCatalog.catalog,
      schema: STRAPI_SDL,
      binding: compiledCatalog.bindings.get("strapi.articles")!,
      transport: t,
      resolveProvenance: () => ({
        sources: [{ sourceId: "spike-api" }],
        freshness: { asOf: "2026-08-01T00:00:00Z" },
      }),
    });
  };

  it("delivers the rows a substring filter actually qualifies", async () => {
    const t = transport();
    const result = await runtimeFor(t).execute(
      {},
      {
        identity: { subject: "reader" },
        filter: { combine: "all", conditions: [{ field: "title", operator: "contains", value: "Inland" }] },
      },
    );
    expect(result.ok).toBe(true);
    expect((result as { data: Record<string, unknown>[] }).data.map((r) => r["documentId"])).toEqual(["a", "c"]);
    expect(JSON.stringify(t.calls[0]!["filters"])).not.toContain("%");
  });

  it("sends `not` as one filter, which is what this dialect accepts", async () => {
    const result = await runtimeFor(transport()).execute(
      {},
      {
        identity: { subject: "reader" },
        filter: { combine: "none", conditions: [{ field: "title", operator: "contains", value: "Inland" }] },
      },
    );
    expect(result.ok).toBe(true);
    expect((result as { data: Record<string, unknown>[] }).data.map((r) => r["documentId"])).toEqual(["b"]);
  });

  it("groups a range and a match together", async () => {
    const result = await runtimeFor(transport()).execute(
      {},
      {
        identity: { subject: "reader" },
        filter: {
          combine: "all",
          conditions: [
            { field: "title", operator: "contains", value: "Inland" },
            { field: "views", operator: "gte", value: 700 },
          ],
        },
      },
    );
    expect(result.ok).toBe(true);
    expect((result as { data: Record<string, unknown>[] }).data.map((r) => r["documentId"])).toEqual(["a"]);
  });
});

describe("Prisma, executed", () => {
  const PRISMA_ROWS = [
    { id: "a", title: "Inland Waters bill passes", score: 9 },
    { id: "b", title: "City draw at home", score: 2 },
    { id: "c", title: "Inland Waters, explained", score: 6 },
  ];
  const compiled = () =>
    approve(
      PRISMA_SDL,
      { fieldName: "posts", capabilityId: "prisma.posts", matchKey: "id" },
      {
        capabilityId: "prisma.posts",
        approvedVisitorArguments: [],
        approvedOutputFields: ["id", "title", "score"],
        requiredOutputFields: ["id"],
      },
      { semanticTypeOverrides: { "Query.posts.score": "quantity" } },
    );

  it("delivers the rows its own vocabulary qualifies, NOT as a list", async () => {
    const t = dialectTransport({
      responseKey: "posts",
      filterVariable: "where",
      operators: {
        equals: (value, operand) => value === operand,
        not: (value, operand) => value !== operand,
        // Prisma's `contains` is a substring match, not a LIKE pattern.
        contains: (value, operand) => String(value ?? "").includes(String(operand)),
        startsWith: (value, operand) => String(value ?? "").startsWith(String(operand)),
        gte: (value, operand) => Number(value) >= Number(operand),
      },
      combinators: { all: "AND", any: "OR", none: "NOT" },
      // Unlike Hasura and Strapi, Prisma's NOT takes a list too.
      listCombinators: ["AND", "OR", "NOT"],
      rows: PRISMA_ROWS,
    });
    const compiledCatalog = compiled();
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiledCatalog.catalog,
      schema: PRISMA_SDL,
      binding: compiledCatalog.bindings.get("prisma.posts")!,
      transport: t,
      resolveProvenance: () => ({
        sources: [{ sourceId: "spike-api" }],
        freshness: { asOf: "2026-08-01T00:00:00Z" },
      }),
    });
    const result = await runtime.execute(
      {},
      {
        identity: { subject: "reader" },
        filter: { combine: "all", conditions: [{ field: "title", operator: "starts-with", value: "Inland" }] },
      },
    );
    expect(result.ok).toBe(true);
    expect((result as { data: Record<string, unknown>[] }).data.map((r) => r["id"])).toEqual(["a", "c"]);
    expect(JSON.stringify(t.calls[0]!["where"])).not.toContain("%");
  });

  it("sends NOT as a list, because this dialect wants one", async () => {
    const t = dialectTransport({
      responseKey: "posts",
      filterVariable: "where",
      operators: {
        equals: (value, operand) => value === operand,
        not: (value, operand) => value !== operand,
        contains: (value, operand) => String(value ?? "").includes(String(operand)),
        startsWith: (value, operand) => String(value ?? "").startsWith(String(operand)),
      },
      combinators: { all: "AND", any: "OR", none: "NOT" },
      listCombinators: ["AND", "OR", "NOT"],
      rows: PRISMA_ROWS,
    });
    const compiledCatalog = compiled();
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiledCatalog.catalog,
      schema: PRISMA_SDL,
      binding: compiledCatalog.bindings.get("prisma.posts")!,
      transport: t,
      resolveProvenance: () => ({
        sources: [{ sourceId: "spike-api" }],
        freshness: { asOf: "2026-08-01T00:00:00Z" },
      }),
    });
    const result = await runtime.execute(
      {},
      {
        identity: { subject: "reader" },
        filter: { combine: "none", conditions: [{ field: "title", operator: "starts-with", value: "Inland" }] },
      },
    );
    expect(result.ok).toBe(true);
    expect((result as { data: Record<string, unknown>[] }).data.map((r) => r["id"])).toEqual(["b"]);
  });
});

describe("aggregation, which the schema may already answer", () => {
  const AGG_SDL = /* GraphQL */ `
    type Query {
      articles(where: articles_bool_exp, limit: Int): [articles!]!
      articles_aggregate(where: articles_bool_exp): articles_aggregate_result!
    }
    type articles { id: Int!, section: String! }
    type articles_aggregate_result { aggregate: articles_aggregate_fields }
    type articles_aggregate_fields { count: Int! }
    input articles_bool_exp { section: String_comparison_exp }
    input String_comparison_exp { _eq: String, _ilike: String }
  `;

  it("says a count is available rather than leaving it to be discovered from a refusal", () => {
    // A plan that asks a capped collection for a count is refused, correctly:
    // aggregating one fetched page reports the page's numbers as the whole
    // collection's. What that refusal never said is that the schema often holds
    // the real answer one field away.
    const draft = createGraphQlCatalogInventory({
      schema: AGG_SDL,
      catalog: { id: "paper", version: "1.0.0", description: "Newspaper." },
      source: { id: "api", label: "API", description: "CMS." },
      queries: [
        {
          fieldName: "articles",
          capabilityId: "paper.articles",
          purpose: "List articles for a reader.",
          dataTypeId: "article",
          dataTypeDescription: "One article.",
          resultShape: "collection",
          matchKey: "id",
        },
      ],
    });
    const hint = draft.issues?.find((issue) => issue.message.includes("articles_aggregate"));
    expect(hint).toBeTruthy();
    expect(hint!.severity).toBe("warning");
    expect(hint!.message).toMatch(/resultShape: "metric"/);
  });

  it("and that route needs no new mechanism — the aggregate field compiles today", () => {
    // The reason the hint is the whole fix: declaring the sibling as its own
    // capability already works, filter argument included. This was checked
    // before anything was built, and it is why "aggregation push-down" turned
    // out not to be a feature.
    const draft = createGraphQlCatalogInventory({
      schema: AGG_SDL,
      catalog: { id: "paper", version: "1.0.0", description: "Newspaper." },
      source: { id: "api", label: "API", description: "CMS." },
      queries: [
        {
          fieldName: "articles_aggregate",
          capabilityId: "paper.articles.count",
          purpose: "Count articles matching a filter, across the whole collection.",
          dataTypeId: "agg",
          dataTypeDescription: "One aggregate result.",
          resultShape: "metric",
        },
      ],
    });
    const compiled = compileApprovedGraphQlCatalog(AGG_SDL, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      semanticTypeOverrides: { "Query.articles_aggregate.aggregate.count": "quantity" },
      queries: [
        {
          capabilityId: "paper.articles.count",
          approvedVisitorArguments: ["where"],
          identityArguments: {},
          approvedOutputFields: ["aggregate.count"],
          requiredOutputFields: ["aggregate.count"],
          policy: { authentication: "public", maximumRows: 1, timeoutMs: 5_000, cacheTtlSeconds: 0 },
          limits: { maximumSelectionDepth: 6, maximumSelectedFields: 20 },
        },
      ],
    });
    expect(compiled.catalog.capabilities[0]!.output.shape).toBe("metric");
    // And the filter argument narrows it, so "how many in sport" is answerable
    // over the whole collection rather than over a page.
    expect(compiled.bindings.get("paper.articles.count")!.visitorArguments).toContain("where");
  });
});

// ─── Relation-nested filter paths ────────────────────────────────────────────

/**
 * The axis every fixture above missed: a filter path that reaches through a
 * relation. `categories.title` is one approved field to the planner and two
 * hops to the upstream, and it is the shape a visitor's own words arrive in —
 * people name a desk, not a foreign key.
 *
 * Three dialects publish three different answers to the same path, and none of
 * them is a special case in the compiler: Hasura nests the related type's own
 * `bool_exp`, Prisma nests it inside a `some`/`none` quantifier and rejects a
 * bare nesting, and Payload's relationship operator takes ids and nothing else
 * so the path does not compile at all.
 *
 * The row that matters in every negation test below is the one filed under two
 * desks. "No category is Politics" excludes it; "some category is not Politics"
 * includes it. Both compile, both look right, and only one agrees with the
 * post-fetch engine this has to match.
 */

const NESTED_ROWS = [
  { id: 1, title: "Bill passes", categories: [{ title: "Politics" }], author: { name: "Rao" } },
  { id: 2, title: "City draw at home", categories: [{ title: "Sports" }], author: { name: "Iyer" } },
  {
    id: 3,
    title: "Filed under two desks",
    categories: [{ title: "Politics" }, { title: "Sports" }],
    author: { name: "Rao" },
  },
  { id: 4, title: "Filed nowhere", categories: [], author: null },
];

const NESTED_HASURA_SDL = /* GraphQL */ `
  type Query {
    articles(where: articles_bool_exp, limit: Int): [articles!]!
  }

  type articles {
    id: Int!
    title: String!
    categories: [categories!]!
    author: authors
  }

  type categories {
    id: Int!
    title: String!
  }

  type authors {
    id: Int!
    name: String!
  }

  input articles_bool_exp {
    _and: [articles_bool_exp!]
    _or: [articles_bool_exp!]
    _not: articles_bool_exp
    id: Int_comparison_exp
    title: String_comparison_exp
    categories: categories_bool_exp
    author: authors_bool_exp
  }

  input categories_bool_exp {
    _and: [categories_bool_exp!]
    _or: [categories_bool_exp!]
    _not: categories_bool_exp
    id: Int_comparison_exp
    title: String_comparison_exp
  }

  input authors_bool_exp {
    name: String_comparison_exp
  }

  input Int_comparison_exp {
    _eq: Int
    _neq: Int
    _gt: Int
    _in: [Int!]
  }

  input String_comparison_exp {
    _eq: String
    _neq: String
    _ilike: String
    _in: [String!]
    _is_null: Boolean
  }
`;

describe("relation-nested paths, Hasura", () => {
  const compiled = () =>
    approve(
      NESTED_HASURA_SDL,
      { fieldName: "articles", capabilityId: "hasura.nested", matchKey: "id" },
      {
        capabilityId: "hasura.nested",
        approvedVisitorArguments: [],
        approvedOutputFields: ["id", "title", "categories.title", "author.name"],
        requiredOutputFields: ["id"],
      },
    );

  const transport = () =>
    dialectTransport({
      responseKey: "articles",
      filterVariable: "where",
      operators: {
        _eq: (value, operand) => value === operand,
        _neq: (value, operand) => value !== operand,
        _ilike: (value, operand) =>
          contains(value, String(operand).replaceAll("%", "")),
        _in: (value, operand) => (operand as unknown[]).includes(value),
      },
      combinators: { all: "_and", any: "_or", none: "_not" },
      listCombinators: ["_and", "_or"],
      rows: NESTED_ROWS,
    });

  const runtimeFor = (t: GraphQlTransport) => {
    const compiledCatalog = compiled();
    return createGraphQlCapabilityRuntime({
      catalog: compiledCatalog.catalog,
      schema: NESTED_HASURA_SDL,
      binding: compiledCatalog.bindings.get("hasura.nested")!,
      transport: t,
      resolveProvenance: () => ({
        sources: [{ sourceId: "spike-api" }],
        freshness: { asOf: "2026-08-01T00:00:00Z" },
      }),
    });
  };

  const rowsOf = (result: unknown) =>
    (result as { data: Record<string, unknown>[] }).data.map((row) => row["id"]);

  it("resolves a path through a relation, and every advertised field is reachable", () => {
    const { catalog, issues } = compiled();
    const supports = catalog.capabilities[0]!.supports!;
    expect(supports.filterFields).toContain("categories.title");
    // Everything reaches the source here, so there is no subset to publish and
    // nothing to warn about.
    expect(supports.sourceFilterFields).toBeUndefined();
    expect(issues.filter((issue) => issue.path.endsWith(".filter"))).toEqual([]);
  });

  it("pushes an equality through a to-many relation, existentially", async () => {
    const t = transport();
    const result = await runtimeFor(t).execute(
      {},
      {
        identity: { subject: "reader" },
        filter: {
          combine: "all",
          conditions: [{ field: "categories.title", operator: "eq", value: "Politics" }],
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(rowsOf(result)).toEqual([1, 3]);
    expect(t.calls[0]!["where"]).toEqual({ categories: { title: { _eq: "Politics" } } });
  });

  it("negates the existential rather than existentially negating", async () => {
    const t = transport();
    const result = await runtimeFor(t).execute(
      {},
      {
        identity: { subject: "reader" },
        filter: {
          combine: "all",
          conditions: [{ field: "categories.title", operator: "not-eq", value: "Politics" }],
        },
      },
    );
    expect(result.ok).toBe(true);
    // 3 is filed under Politics *and* Sports. `EXISTS(title != Politics)` would
    // return it; the post-fetch engine does not, and neither does this.
    expect(rowsOf(result)).toEqual([2, 4]);
    expect(t.calls[0]!["where"]).toEqual({
      _not: { categories: { title: { _eq: "Politics" } } },
    });
  });

  it("leaves substring alone on a relation path, because post-fetch reads it as membership", async () => {
    const t = transport();
    const result = await runtimeFor(t).execute(
      {},
      {
        identity: { subject: "reader" },
        filter: {
          combine: "all",
          conditions: [{ field: "categories.title", operator: "contains", value: "Politics" }],
        },
      },
    );
    expect(result.ok).toBe(true);
    // Not pushed: `contains` over a list is element membership post-fetch and
    // substring at the source, and the two disagree. Nothing narrows here, so
    // the whole page comes back and the engine above filters it — the disclosed
    // fallback, unchanged by any of this.
    expect(t.calls[0]!["where"]).toBeUndefined();
    expect(rowsOf(result)).toEqual([1, 2, 3, 4]);
  });

  it("pushes every operator through a to-one relation, which crosses no list", async () => {
    const t = transport();
    const result = await runtimeFor(t).execute(
      {},
      {
        identity: { subject: "reader" },
        filter: {
          combine: "all",
          conditions: [{ field: "author.name", operator: "contains", value: "ra" }],
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(t.calls[0]!["where"]).toEqual({ author: { name: { _ilike: "%ra%" } } });
    expect(rowsOf(result)).toEqual([1, 3]);
  });
});

const NESTED_PRISMA_SDL = /* GraphQL */ `
  type Query {
    posts(where: PostWhereInput, take: Int): [Post!]!
  }

  type Post {
    id: Int!
    title: String!
    categories: [Category!]!
  }

  type Category {
    id: Int!
    title: String!
  }

  input PostWhereInput {
    AND: [PostWhereInput!]
    OR: [PostWhereInput!]
    NOT: [PostWhereInput!]
    title: StringFilter
    categories: CategoryListRelationFilter
  }

  input CategoryListRelationFilter {
    every: CategoryWhereInput
    some: CategoryWhereInput
    none: CategoryWhereInput
  }

  input CategoryWhereInput {
    AND: [CategoryWhereInput!]
    title: StringFilter
  }

  input StringFilter {
    equals: String
    not: String
    contains: String
    in: [String!]
  }
`;

/** The same rows without the author this fixture does not approve. */
const PRISMA_NESTED_ROWS = NESTED_ROWS.map(({ author: _author, ...rest }) => rest);

describe("relation-nested paths, Prisma", () => {
  const compiled = () =>
    approve(
      NESTED_PRISMA_SDL,
      { fieldName: "posts", capabilityId: "prisma.nested", matchKey: "id" },
      {
        capabilityId: "prisma.nested",
        approvedVisitorArguments: [],
        approvedOutputFields: ["id", "title", "categories.title"],
        requiredOutputFields: ["id"],
      },
    );

  const transport = () =>
    dialectTransport({
      responseKey: "posts",
      filterVariable: "where",
      operators: {
        equals: (value, operand) => value === operand,
        not: (value, operand) => value !== operand,
        contains: contains,
        in: (value, operand) => (operand as unknown[]).includes(value),
      },
      combinators: { all: "AND", any: "OR", none: "NOT" },
      listCombinators: ["AND", "OR", "NOT"],
      // Prisma's list-relation filter has no bare nesting: a condition must sit
      // inside every/some/none, and one that does not is a type error.
      quantifiedRelations: ["categories"],
      rows: PRISMA_NESTED_ROWS,
    });

  const runtimeFor = (t: GraphQlTransport) => {
    const compiledCatalog = compiled();
    return createGraphQlCapabilityRuntime({
      catalog: compiledCatalog.catalog,
      schema: NESTED_PRISMA_SDL,
      binding: compiledCatalog.bindings.get("prisma.nested")!,
      transport: t,
      resolveProvenance: () => ({
        sources: [{ sourceId: "spike-api" }],
        freshness: { asOf: "2026-08-01T00:00:00Z" },
      }),
    });
  };

  const rowsOf = (result: unknown) =>
    (result as { data: Record<string, unknown>[] }).data.map((row) => row["id"]);

  it("sends the quantifier this dialect demands, not a bare nesting", async () => {
    const t = transport();
    const result = await runtimeFor(t).execute(
      {},
      {
        identity: { subject: "reader" },
        filter: {
          combine: "all",
          conditions: [{ field: "categories.title", operator: "eq", value: "Politics" }],
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(t.calls[0]!["where"]).toEqual({
      categories: { some: { title: { equals: "Politics" } } },
    });
    expect(rowsOf(result)).toEqual([1, 3]);
  });

  it("negates with `none`, which is the quantifier that means what the IR means", async () => {
    const t = transport();
    const result = await runtimeFor(t).execute(
      {},
      {
        identity: { subject: "reader" },
        filter: {
          combine: "all",
          conditions: [{ field: "categories.title", operator: "not-eq", value: "Politics" }],
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(t.calls[0]!["where"]).toEqual({
      categories: { none: { title: { equals: "Politics" } } },
    });
    expect(rowsOf(result)).toEqual([2, 4]);
  });
});

const NESTED_PAYLOAD_SDL = /* GraphQL */ `
  type Query {
    Posts(where: Post_where, limit: Int): [Post!]!
  }

  type Post {
    id: String!
    title: String!
    sectionSlug: String
    categories: [Category!]!
  }

  type Category {
    id: String!
    title: String!
  }

  input Post_where {
    AND: [Post_where]
    OR: [Post_where]
    title: Post_title_operator
    sectionSlug: Post_sectionSlug_operator
    categories: Post_categories_operator
  }

  input Post_title_operator {
    equals: String
    not_equals: String
    contains: String
    in: [String]
  }

  input Post_sectionSlug_operator {
    equals: String
    not_equals: String
    contains: String
    in: [String]
  }

  input Post_categories_operator {
    equals: String
    in: [String]
    not_in: [String]
    all: [String]
    exists: Boolean
  }
`;

describe("relation-nested paths, Payload — the dialect that cannot say it", () => {
  const compiled = () =>
    approve(
      NESTED_PAYLOAD_SDL,
      { fieldName: "Posts", capabilityId: "payload.nested", matchKey: "id" },
      {
        capabilityId: "payload.nested",
        approvedVisitorArguments: [],
        approvedOutputFields: ["id", "title", "sectionSlug", "categories.title"],
        requiredOutputFields: ["id"],
      },
    );

  it("offers the planner only the fields that reach the source", () => {
    const supports = compiled().catalog.capabilities[0]!.supports!;
    // The relationship operator takes ids, so no nesting reaches `title`.
    expect(supports.filterFields).toContain("categories.title");
    expect(supports.sourceFilterFields).toEqual(["title", "sectionSlug"]);
    expect(supports.sourceFilterFields).not.toContain("categories.title");
  });

  it("names the unreachable path, and points at the column that answers instead", () => {
    const filterIssues = compiled().issues.filter((issue) => issue.path.endsWith(".filter"));
    expect(filterIssues).toHaveLength(1);
    expect(filterIssues[0]!.severity).toBe("warning");
    expect(filterIssues[0]!.message).toContain("categories.title");
    expect(filterIssues[0]!.message).toContain("sectionSlug");
    expect(filterIssues[0]!.message).toContain("projection");
  });

  it("keeps the unreachable path readable and projectable, and out of the filter vocabulary", () => {
    const { catalog } = compiled();
    const contract = createDataPlanningContract(createPlannerManifest(catalog));
    // Every enum the filter grammar offers, at every nesting level of the
    // condition tree — a substring check over the whole document would pass on
    // the field being merely readable, which it still is and should be.
    const filterEnums = filterFieldEnums(contract);
    expect(filterEnums.length).toBeGreaterThan(0);
    for (const values of filterEnums) {
      expect(values).toEqual(["title", "sectionSlug"]);
    }
    // Still fetchable and still projectable: unreachable-by-filter is not
    // unreadable.
    expect(JSON.stringify(contract)).toContain("categories.title");
  });
});

/**
 * Every `field` enum inside a filter condition, found by walking rather than by
 * matching text: the condition tree nests to its recursion limit, and each
 * level carries its own copy.
 */
function filterFieldEnums(node: unknown, insideFilter = false): string[][] {
  if (Array.isArray(node)) return node.flatMap((item) => filterFieldEnums(item, insideFilter));
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const found: string[][] = [];
  for (const [key, value] of Object.entries(record)) {
    const within = insideFilter || key === "filter";
    if (within && key === "field") {
      const values = (value as { enum?: unknown }).enum;
      if (Array.isArray(values)) found.push(values as string[]);
      continue;
    }
    found.push(...filterFieldEnums(value, within));
  }
  return found;
}

describe("a negation with nowhere to go", () => {
  it("refuses rather than compiling an existential negation", () => {
    // A relation with no `none` quantifier, on a filter input with no root
    // negation either: the only faithful renderings are unavailable, and the
    // available one means something else.
    const pushdown = {
      argument: "where",
      fields: {
        "categories.title": {
          operators: { eq: "eq", "not-eq": "ne" },
          through: [{ name: "categories", list: true }],
        },
      },
      combinators: { all: { name: "and", list: true } },
    } as const;
    const refused = renderFilterValue(pushdown, {
      combine: "all",
      conditions: [{ field: "categories.title", operator: "not-eq", value: "Politics" }],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.kind).toBe("unsupported-negation");
    expect(describeFilterRefusal(refused.refusal)).toContain("no related record matches");
  });
});
