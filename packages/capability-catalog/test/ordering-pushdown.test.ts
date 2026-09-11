import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  compileGraphQlOperation,
  createGraphQlCapabilityRuntime,
  createGraphQlCatalogInventory,
  type GraphQlTransport,
} from "../src/graphql.js";
import { canPushOrdering } from "../src/ordering.js";

/**
 * Ordering sent to the source, in the source's own spelling.
 *
 * The hole this closes: a filter argument publishes its grammar as types, so
 * the plan contract offers the planner a closed menu; an ordering argument
 * typed `sort: String` publishes nothing, and a planner handed a bare string
 * has to invent a dialect. Its inventions are plausible, and an upstream that
 * cannot parse an ordering expression ignores it rather than failing — so "the
 * three newest" comes back as three arbitrary rows in a convincing order.
 *
 * The host declares the grammar once; deterministic code renders it from the
 * typed `query.sort` terms the planner already emits. Both widely-used
 * spellings are exercised below, and neither is built in: two popular CMSes
 * disagree about this, so a default would be silently wrong for one of them.
 */

const SDL = `
  type Query {
    Posts(where: JSON, limit: Int, page: Int, sort: String): Posts
    Articles(limit: Int, page: Int, sort: [String]): Posts
    Stories(limit: Int, page: Int, orderBy: StoryOrder): Posts
  }

  scalar JSON

  enum StoryOrder {
    TITLE_ASC
    TITLE_DESC
  }

  type Posts {
    docs: [Post!]!
    hasNextPage: Boolean!
    totalDocs: Int!
  }

  type Post {
    id: Int!
    title: String!
    slug: String!
  }
`;

const ENVELOPE = {
  rowsField: "docs",
  hasNextPageField: "hasNextPage",
  totalCountField: "totalDocs",
  pageSizeArgument: "limit",
  pageArguments: ["page"],
} as const;

type QuerySpec = {
  fieldName: string;
  capabilityId: string;
  approvedVisitorArguments: string[];
  orderingArgument?: {
    name: string;
    ascending: string;
    descending: string;
    separator?: string;
  };
};

function compile(spec: QuerySpec) {
  const draft = createGraphQlCatalogInventory({
    schema: SDL,
    catalog: { id: "cms", version: "1.0.0", description: "Approved post reads." },
    source: { id: "cms-api", label: "The CMS", description: "The site's CMS." },
    queries: [
      {
        fieldName: spec.fieldName,
        capabilityId: spec.capabilityId,
        purpose: "List published posts.",
        dataTypeId: "post",
        dataTypeDescription: "One post.",
        resultShape: "collection",
        matchKey: "id",
        scalarMappings: { JSON: { schema: {} } },
        listEnvelope: ENVELOPE,
      },
    ],
  });
  return compileApprovedGraphQlCatalog(SDL, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: spec.capabilityId,
        approvedVisitorArguments: spec.approvedVisitorArguments,
        identityArguments: {},
        ...(spec.orderingArgument ? { orderingArgument: spec.orderingArgument } : {}),
        approvedOutputFields: ["id", "title", "slug"],
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
  });
}

const PAYLOAD_GRAMMAR = {
  name: "sort",
  ascending: "{field}",
  descending: "-{field}",
  separator: ",",
} as const;

const ROWS: readonly Record<string, unknown>[] = [
  { id: 1, title: "Bravo", slug: "bravo" },
  { id: 2, title: "Alpha", slug: "alpha" },
  { id: 3, title: "Charlie", slug: "charlie" },
];

/**
 * Parses the two grammars the fixtures below declare — `-field` in a comma
 * separated string, and `field:desc` in a list — and silently ignores anything
 * else, which is what an upstream actually does with an expression in a dialect
 * it does not speak.
 *
 * Understanding both is not a claim that a real API would: each fixture
 * declares one of them, and the transport standing in for that API accepts only
 * what a correct rendering of that declaration produces. A misrendered value —
 * an unsubstituted token, the wrong separator, a joined list — parses to no
 * terms here and leaves the rows in fixture order.
 */
function orderingTerms(value: unknown): { field: string; descending: boolean }[] {
  const parts =
    typeof value === "string"
      ? value.split(",").map((term) => term.trim())
      : Array.isArray(value)
        ? value.filter((term): term is string => typeof term === "string")
        : [];
  return parts.flatMap((term) => {
    if (term.startsWith("-")) return [{ field: term.slice(1), descending: true }];
    const [field, direction] = term.split(":");
    if (direction === "asc" || direction === "desc") {
      return [{ field: field!, descending: direction === "desc" }];
    }
    if (direction !== undefined || field === "") return [];
    return [{ field: term, descending: false }];
  });
}

/**
 * The upstream side of the exercise: an API that orders rows by the expression
 * it was sent, and records every request.
 *
 * The point of making it parse rather than record: a test that only asserts
 * which string we sent proves we are consistent, not that we are right.
 */
function orderingAwareTransport(
  options: {
    rows?: readonly Record<string, unknown>[];
    responseKey?: string;
  } = {},
): GraphQlTransport & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const transport: GraphQlTransport = async (request) => {
    const variables = { ...(request.variables ?? {}) };
    calls.push({ ...variables });
    let docs = [...(options.rows ?? ROWS)];
    const terms = orderingTerms(variables["sort"]);
    if (terms.length > 0) {
      docs.sort((left, right) => {
        for (const term of terms) {
          const a = left[term.field];
          const b = right[term.field];
          if (a === b) continue;
          if (typeof a !== typeof b) continue;
          const compared = (a as string) < (b as string) ? -1 : 1;
          return term.descending ? -compared : compared;
        }
        return 0;
      });
    }
    const limit = typeof variables["limit"] === "number" ? variables["limit"] : 10;
    docs = docs.slice(0, limit);
    return {
      data: {
        [options.responseKey ?? "Posts"]: {
          docs,
          hasNextPage: docs.length < (options.rows ?? ROWS).length,
          totalDocs: (options.rows ?? ROWS).length,
        },
      },
    };
  };
  return Object.assign(transport, { calls });
}

function runtimeFor(
  compiled: ReturnType<typeof compile>,
  transport: GraphQlTransport,
  capabilityId = "graphql.posts",
) {
  return createGraphQlCapabilityRuntime({
    catalog: compiled.catalog,
    schema: SDL,
    binding: compiled.bindings.get(capabilityId)!,
    transport,
    resolveProvenance: () => ({
      sources: [{ sourceId: "cms-api" }],
      freshness: { asOf: "2026-08-01T00:00:00.000Z" },
    }),
  });
}

describe("rendering the host's ordering grammar", () => {
  it("sends a spelling the upstream's own parser accepts, and the rows arrive ordered", async () => {
    const compiled = compile({
      fieldName: "Posts",
      capabilityId: "graphql.posts",
      approvedVisitorArguments: ["limit", "page"],
      orderingArgument: PAYLOAD_GRAMMAR,
    });
    const transport = orderingAwareTransport();
    const result = await runtimeFor(compiled, transport).execute(
      {},
      { identity: {}, sort: [{ field: "title", direction: "desc" }] },
    );

    expect(transport.calls[0]!["sort"]).toBe("-title");
    expect(result.ok).toBe(true);
    // The rows are the proof: this transport reordered them by parsing what we
    // sent, so an unparseable spelling would leave them in fixture order.
    expect(
      (result as { data: { title: string }[] }).data.map((row) => row.title),
    ).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("joins several terms with the declared separator", async () => {
    const compiled = compile({
      fieldName: "Posts",
      capabilityId: "graphql.posts",
      approvedVisitorArguments: ["limit"],
      orderingArgument: PAYLOAD_GRAMMAR,
    });
    const transport = orderingAwareTransport();
    const result = await runtimeFor(compiled, transport).execute(
      {},
      {
        identity: {},
        sort: [
          { field: "slug", direction: "asc" },
          { field: "title", direction: "desc" },
        ],
      },
    );

    expect(transport.calls[0]!["sort"]).toBe("slug,-title");
    expect(result.ok).toBe(true);
    expect(
      (result as { data: { slug: string }[] }).data.map((row) => row.slug),
    ).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("carries each term as its own element when the argument takes a list", async () => {
    // The other popular spelling, and the reason no grammar is built in. `list`
    // is read off the argument's type rather than declared, so the same
    // declaration shape covers both.
    const compiled = compile({
      fieldName: "Articles",
      capabilityId: "graphql.articles",
      approvedVisitorArguments: ["limit"],
      orderingArgument: {
        name: "sort",
        ascending: "{field}:asc",
        descending: "{field}:desc",
      },
    });
    const transport = orderingAwareTransport({ responseKey: "Articles" });
    const result = await runtimeFor(compiled, transport, "graphql.articles").execute(
      {},
      {
        identity: {},
        sort: [
          { field: "title", direction: "desc" },
          { field: "slug", direction: "asc" },
        ],
      },
    );

    expect(transport.calls[0]!["sort"]).toEqual(["title:desc", "slug:asc"]);
    expect(result.ok).toBe(true);
    expect(
      (result as { data: { title: string }[] }).data.map((row) => row.title),
    ).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("leaves the request untouched when the plan asked for no ordering", async () => {
    const compiled = compile({
      fieldName: "Posts",
      capabilityId: "graphql.posts",
      approvedVisitorArguments: ["limit"],
      orderingArgument: PAYLOAD_GRAMMAR,
    });
    const transport = orderingAwareTransport();
    await runtimeFor(compiled, transport).execute({}, { identity: {} });

    expect(transport.calls[0]).not.toHaveProperty("sort");
  });
});

describe("what cannot be pushed falls back rather than being sent wrong", () => {
  const grammar = {
    argument: "sort",
    ascending: "{field}",
    descending: "-{field}",
    separator: ",",
    list: false,
  };

  it("refuses a dotted field, which is a row path and not the upstream's field name", () => {
    expect(canPushOrdering(grammar, [{ field: "category.title", direction: "asc" }])).toBe(
      false,
    );
  });

  it("refuses several terms with nowhere to put the second one", () => {
    // Ordering by A then B is not ordering by A: sending only the head would
    // change which rows a top-N returns, so nothing is sent at all.
    const { separator: _declared, ...noSeparator } = grammar;
    expect(
      canPushOrdering(noSeparator, [
        { field: "title", direction: "asc" },
        { field: "slug", direction: "asc" },
      ]),
    ).toBe(false);
    expect(canPushOrdering(noSeparator, [{ field: "title", direction: "asc" }])).toBe(
      true,
    );
  });
});

describe("the planner stops being offered what it no longer writes", () => {
  it("keeps the ordering argument out of the contract but in the operation", async () => {
    const compiled = compile({
      fieldName: "Posts",
      capabilityId: "graphql.posts",
      approvedVisitorArguments: ["limit", "page"],
      orderingArgument: PAYLOAD_GRAMMAR,
    });
    const capability = compiled.catalog.capabilities[0]!;
    const properties = (capability.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties)).not.toContain("sort");

    const binding = compiled.bindings.get("graphql.posts")!;
    expect(binding.ordering).toEqual({
      argument: "sort",
      ascending: "{field}",
      descending: "-{field}",
      separator: ",",
      list: false,
    });
    // The document declares the variable only when a value is actually present,
    // so an unordered request compiles to exactly the document it always did.
    const withOrdering = compileGraphQlOperation(
      SDL,
      binding,
      { capabilityId: "graphql.posts", params: { sort: "-title" } },
      {},
    );
    expect(withOrdering.document).toContain("$sort: String");
    expect(withOrdering.variables).toMatchObject({ sort: "-title" });
    const without = compileGraphQlOperation(
      SDL,
      binding,
      { capabilityId: "graphql.posts", params: {} },
      {},
    );
    expect(without.document).not.toContain("$sort");
  });

  it("refuses a declaration that also leaves the argument with the planner", () => {
    expect(() =>
      compile({
        fieldName: "Posts",
        capabilityId: "graphql.posts",
        approvedVisitorArguments: ["limit", "sort"],
        orderingArgument: PAYLOAD_GRAMMAR,
      }),
    ).toThrow(/remove "sort" from approvedVisitorArguments/);
  });
});

describe("declarations that would compile and then send something wrong are refused", () => {
  it("refuses a template that never names the field", () => {
    expect(() =>
      compile({
        fieldName: "Posts",
        capabilityId: "graphql.posts",
        approvedVisitorArguments: ["limit"],
        orderingArgument: { ...PAYLOAD_GRAMMAR, descending: "-publishedAt" },
      }),
    ).toThrow(/never names the field/);
  });

  it("refuses an argument the field does not accept, and lists the ones it does", () => {
    expect(() =>
      compile({
        fieldName: "Posts",
        capabilityId: "graphql.posts",
        approvedVisitorArguments: ["limit"],
        orderingArgument: { ...PAYLOAD_GRAMMAR, name: "orderBy" },
      }),
    ).toThrow(/does not accept.*where, limit, page, sort/s);
  });

  it("refuses a separator on a list-typed argument, which would render it into a term", () => {
    expect(() =>
      compile({
        fieldName: "Articles",
        capabilityId: "graphql.articles",
        approvedVisitorArguments: ["limit"],
        orderingArgument: PAYLOAD_GRAMMAR,
      }),
    ).toThrow(/takes a list/);
  });

  it("refuses an ordering the schema already types, and names approving it instead", () => {
    // The declaration exists for grammars introspection cannot carry. An enum
    // carries its own, so the planner should be given the real values.
    expect(() =>
      compile({
        fieldName: "Stories",
        capabilityId: "graphql.stories",
        approvedVisitorArguments: ["limit"],
        orderingArgument: { ...PAYLOAD_GRAMMAR, name: "orderBy" },
      }),
    ).toThrow(/is an enum.*Approve "orderBy" as a visitor argument/s);
  });
});

describe("a capability that can be sorted with no way to send it says so", () => {
  it("warns once, naming the declaration and the alternative", () => {
    const compiled = compile({
      fieldName: "Posts",
      capabilityId: "graphql.posts",
      approvedVisitorArguments: ["limit", "page", "sort"],
    });
    const warnings = compiled.issues.filter(
      (issue) => issue.path === "graphql.posts.ordering",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/applies to the fetched page only/);
    expect(warnings[0]!.message).toMatch(/orderingArgument/);
    expect(warnings[0]!.message).toMatch(/drop sortFields/);
  });

  it("stays quiet once the grammar is declared", () => {
    const compiled = compile({
      fieldName: "Posts",
      capabilityId: "graphql.posts",
      approvedVisitorArguments: ["limit", "page"],
      orderingArgument: PAYLOAD_GRAMMAR,
    });
    expect(
      compiled.issues.filter((issue) => issue.path === "graphql.posts.ordering"),
    ).toHaveLength(0);
  });

  it("stays quiet for a schema that types ordering itself", () => {
    // Structural, not a name test: an approved enum or input-object argument
    // can carry an ordering, so there is nothing to declare and nothing to warn
    // about. Asking whether an argument is *called* something sort-shaped is
    // the guess this design refuses to make.
    const compiled = compile({
      fieldName: "Stories",
      capabilityId: "graphql.stories",
      approvedVisitorArguments: ["limit", "orderBy"],
    });
    expect(
      compiled.issues.filter((issue) => issue.path === "graphql.stories.ordering"),
    ).toHaveLength(0);
  });
});
