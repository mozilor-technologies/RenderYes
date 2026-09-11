import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCapabilityRuntime,
  createGraphQlCatalogInventory,
  type GraphQlTransport,
} from "../src/graphql.js";

/**
 * A planned filter arriving at the source, in the source's own spelling.
 *
 * What this closes. Every planned request offered two independently filterable
 * fields: `params`, carrying the upstream's native filter argument, and
 * `query.filter`, carrying a typed condition tree. The first is compiled into
 * the GraphQL query and narrowed by the database; the second was applied in
 * this process to whatever rows a bounded fetch returned. The planner chose
 * between them, guided only by a sentence in the system prompt asking it to
 * prefer the first — and on a live newspaper it chose the second six times,
 * turning seven matching articles out of five hundred into zero rows reported
 * as a success.
 *
 * The transport below refuses to be lenient about this: it applies the filter
 * it is sent, and returns everything when it is sent none. So a test that
 * asserts on the delivered rows fails if the filter never left this process.
 */

const SDL = `
  type Query {
    Articles(where: ArticleWhere, limit: Int, page: Int): Articles
    Notes(limit: Int, page: Int): Articles
  }

  input ArticleWhere {
    title: StringFilter
    section: StringFilter
    AND: [ArticleWhere!]
    OR: [ArticleWhere!]
  }

  input StringFilter {
    equals: String
    not_equals: String
    contains: String
    in: [String!]
  }

  type Articles {
    docs: [Article!]!
    hasNextPage: Boolean!
    totalDocs: Int!
  }

  type Article {
    id: Int!
    title: String!
    section: String!
  }
`;

const ENVELOPE = {
  rowsField: "docs",
  hasNextPageField: "hasNextPage",
  totalCountField: "totalDocs",
  pageSizeArgument: "limit",
  pageArguments: ["page"],
} as const;

const ROWS: readonly Record<string, unknown>[] = [
  { id: 1, title: "Inland Waters bill passes", section: "politics" },
  { id: 2, title: "City draw at home", section: "sport" },
  { id: 3, title: "Budget reaction", section: "business" },
  { id: 4, title: "Inland Waters, explained", section: "politics" },
];

function compile(fieldName: string, capabilityId: string, filterFields: string[]) {
  const draft = createGraphQlCatalogInventory({
    schema: SDL,
    catalog: { id: "paper", version: "1.0.0", description: "Approved article reads." },
    source: { id: "paper-api", label: "The paper", description: "The newspaper's CMS." },
    queries: [
      {
        fieldName,
        capabilityId,
        purpose: "List published articles.",
        dataTypeId: "article",
        dataTypeDescription: "One article.",
        resultShape: "collection",
        matchKey: "id",
        listEnvelope: ENVELOPE,
        supports: { filterFields },
      },
    ],
  });
  return compileApprovedGraphQlCatalog(SDL, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId,
        approvedVisitorArguments: [],
        identityArguments: {},
        approvedOutputFields: ["id", "title", "section"],
        requiredOutputFields: ["id"],
        policy: { authentication: "public", maximumRows: 50, timeoutMs: 5_000, cacheTtlSeconds: 0 },
        limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
      },
    ],
  });
}

/** Applies what it is sent, and nothing when it is sent nothing. */
function filteringTransport(): GraphQlTransport & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [key, condition] of Object.entries(where)) {
      if (key === "AND") return (condition as Record<string, unknown>[]).every((part) => matches(row, part));
      if (key === "OR") return (condition as Record<string, unknown>[]).some((part) => matches(row, part));
      const value = String(row[key] ?? "");
      const test = condition as Record<string, unknown>;
      if ("equals" in test && value !== test["equals"]) return false;
      if ("not_equals" in test && value === test["not_equals"]) return false;
      if ("contains" in test && !value.includes(String(test["contains"]))) return false;
      if ("in" in test && !(test["in"] as string[]).includes(value)) return false;
    }
    return true;
  };
  const transport: GraphQlTransport = async (request) => {
    const variables = { ...(request.variables ?? {}) };
    calls.push(variables);
    const where = variables["where"] as Record<string, unknown> | undefined;
    const docs = where ? ROWS.filter((row) => matches(row, where)) : [...ROWS];
    return {
      data: { Articles: { docs, hasNextPage: false, totalDocs: docs.length } },
    };
  };
  return Object.assign(transport, { calls });
}

function runtimeFor(compiled: ReturnType<typeof compile>, capabilityId: string, transport: GraphQlTransport) {
  return createGraphQlCapabilityRuntime({
    catalog: compiled.catalog,
    schema: SDL,
    binding: compiled.bindings.get(capabilityId)!,
    transport,
    resolveProvenance: () => ({
      sources: [{ sourceId: "paper-api" }],
      freshness: { asOf: "2026-08-01T00:00:00.000Z" },
    }),
  });
}

describe("the plan's filter, compiled into the upstream's argument", () => {
  it("is declared on the runtime when the schema can carry it", () => {
    const compiled = compile("Articles", "paper.articles", ["title", "section"]);
    const runtime = runtimeFor(compiled, "paper.articles", filteringTransport());
    expect(runtime.filter?.argument).toBe("where");
    expect(Object.keys(runtime.filter!.fields).sort()).toEqual(["section", "title"]);
    // Read off the schema, not assumed: this input type spells equality
    // `equals` and has no `startsWith` at all.
    expect(runtime.filter!.fields["title"]!.operators["eq"]).toBe("equals");
    expect(runtime.filter!.fields["title"]!.operators["starts-with"]).toBeUndefined();
    expect(runtime.filter!.combinators).toEqual({
      all: { name: "AND", list: true },
      any: { name: "OR", list: true },
    });
  });

  it("reaches the source, and the delivered rows are the ones that qualified", async () => {
    const compiled = compile("Articles", "paper.articles", ["title", "section"]);
    const transport = filteringTransport();
    const runtime = runtimeFor(compiled, "paper.articles", transport);
    const result = await runtime.execute(
      {},
      {
        identity: { subject: "reader" },
        filter: { combine: "all", conditions: [{ field: "title", operator: "contains", value: "Inland Waters" }] },
      },
    );
    expect(result.ok).toBe(true);
    expect(transport.calls[0]!["where"]).toEqual({ title: { contains: "Inland Waters" } });
    expect((result as { data: Record<string, unknown>[] }).data.map((row) => row["id"])).toEqual([1, 4]);
  });

  it("is absent when no argument of the field can carry it", () => {
    const compiled = compile("Notes", "paper.notes", ["title"]);
    const runtime = runtimeFor(compiled, "paper.notes", filteringTransport());
    expect(runtime.filter).toBeUndefined();
    // And the compile says so rather than leaving it to be discovered from
    // wrong answers.
    expect(
      compiled.issues.some(
        (issue) => issue.path === "paper.notes.filter" && /rather than at the source/.test(issue.message),
      ),
    ).toBe(true);
  });

  it("does not push a filter the schema cannot express, and says nothing false about it", async () => {
    const compiled = compile("Articles", "paper.articles", ["title"]);
    const transport = filteringTransport();
    const runtime = runtimeFor(compiled, "paper.articles", transport);
    await runtime.execute(
      {},
      {
        identity: { subject: "reader" },
        // No `starts-with` in StringFilter.
        filter: { combine: "all", conditions: [{ field: "title", operator: "starts-with", value: "Inland" }] },
      },
    );
    expect(transport.calls[0]!["where"]).toBeUndefined();
  });
});

/**
 * One filtering vocabulary per capability, wherever one can do the job.
 *
 * `filterFields` defaults on for every list-shaped capability, so a host who
 * also approves the upstream's filter argument published both — the argument in
 * `params`, narrowed by the database, and `query.filter` in this package's own
 * grammar, narrowed over one fetched page. The system prompt asked the planner
 * to prefer the first. It picked the second six times on a live newspaper.
 */
function compileWithApprovedArgument(filterFields: string[], approve: string[]) {
  const draft = createGraphQlCatalogInventory({
    schema: SDL,
    catalog: { id: "paper", version: "1.0.0", description: "Approved article reads." },
    source: { id: "paper-api", label: "The paper", description: "The newspaper's CMS." },
    queries: [
      {
        fieldName: "Articles",
        capabilityId: "paper.articles",
        purpose: "List published articles.",
        dataTypeId: "article",
        dataTypeDescription: "One article.",
        resultShape: "collection",
        matchKey: "id",
        listEnvelope: ENVELOPE,
        supports: { filterFields },
      },
    ],
  });
  return compileApprovedGraphQlCatalog(SDL, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: "paper.articles",
        approvedVisitorArguments: approve,
        identityArguments: {},
        approvedOutputFields: ["id", "title", "section"],
        requiredOutputFields: ["id"],
        policy: { authentication: "public", maximumRows: 50, timeoutMs: 5_000, cacheTtlSeconds: 0 },
        limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
      },
    ],
  });
}

describe("which vocabulary the planner is offered", () => {
  it("keeps the argument and drops the derived grammar when the argument covers it", () => {
    // Derived rather than declared: this is the default every importer produces,
    // and the state every capability on the install was in.
    const draft = createGraphQlCatalogInventory({
      schema: SDL,
      catalog: { id: "paper", version: "1.0.0", description: "Approved article reads." },
      source: { id: "paper-api", label: "The paper", description: "The newspaper's CMS." },
      queries: [
        {
          fieldName: "Articles",
          capabilityId: "paper.articles",
          purpose: "List published articles.",
          dataTypeId: "article",
          dataTypeDescription: "One article.",
          resultShape: "collection",
          matchKey: "title",
          listEnvelope: ENVELOPE,
        },
      ],
    });
    const compiled = compileApprovedGraphQlCatalog(SDL, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "paper.articles",
          approvedVisitorArguments: ["where"],
          identityArguments: {},
          // Only the two the filter argument can reach, so coverage is total.
          approvedOutputFields: ["title", "section"],
          requiredOutputFields: ["title"],
          policy: { authentication: "public", maximumRows: 50, timeoutMs: 5_000, cacheTtlSeconds: 0 },
          limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
        },
      ],
    });
    const capability = compiled.catalog.capabilities[0]!;
    expect(capability.supports?.filterFields).toBeUndefined();
    expect(capability.supports?.sourceNarrowingArguments).toEqual(["where"]);
    // And nothing is compiled into it, because the plan writes it directly.
    expect(compiled.bindings.get("paper.articles")!.filter).toBeUndefined();
  });

  it("keeps both when the argument reaches only some of the filter fields", () => {
    // The ordinary case, and the reason the rule is coverage rather than
    // presence: `id` is filterable and the where input has no such field, so
    // dropping the grammar would lose the host a capability to buy a tidier
    // contract.
    const compiled = compileWithApprovedArgument(["id", "title", "section"], ["where"]);
    const capability = compiled.catalog.capabilities[0]!;
    expect(capability.supports?.filterFields).toEqual(["id", "title", "section"]);
    const issue = compiled.issues.find((entry) => entry.path === "paper.articles.filter");
    expect(issue?.message).toMatch(/cannot reach id/);
  });

  it("compiles the grammar into the argument when the argument is not approved", () => {
    const compiled = compileWithApprovedArgument(["title", "section"], []);
    expect(compiled.catalog.capabilities[0]!.supports?.filterFields).toEqual(["title", "section"]);
    expect(compiled.bindings.get("paper.articles")!.filter?.argument).toBe("where");
  });

  it("names the duplication when a reviewer stated the fields the argument covers", () => {
    const compiled = compileWithApprovedArgument(["title", "section"], ["where"]);
    // An explicit declaration is the reviewer's and is never dropped for them.
    expect(compiled.catalog.capabilities[0]!.supports?.filterFields).toEqual(["title", "section"]);
    const issue = compiled.issues.find((entry) => entry.path === "paper.articles.filter");
    expect(issue?.message).toMatch(/two ways to narrow the same data/);
  });
});

/**
 * A source-side result says which column answered.
 *
 * Post-fetch narrowing announces itself — `narrowedAfterFetch` says matches may
 * exist beyond the page that was searched. Pushing the filter to the source
 * removed that net without replacing it, and the replacement has to answer a
 * different question: not "was this the whole archive" but "which field did it
 * look in".
 *
 * A live newspaper approved nine filterable fields, and one question answered
 * three ways: 8 rows matching on `title`, 5 on `storySlug`, 0 on `tagSlugs`.
 * The zero was a true database zero for a subject the paper had covered eight
 * times, and nothing distinguished it from no coverage at all.
 */
describe("what narrowed the result", () => {
  const filtered = () =>
    runtimeFor(
      compile("Articles", "paper.articles", ["title", "section"]),
      "paper.articles",
      filteringTransport(),
    ).execute(
      {},
      {
        identity: { subject: "reader" },
        filter: {
          combine: "all",
          conditions: [{ field: "title", operator: "contains", value: "Inland" }],
        },
      },
    );

  it("records the field and operator the source filtered on", async () => {
    const result = (await filtered()) as { ok: boolean; provenance: Record<string, unknown> };
    expect(result.ok).toBe(true);
    expect(result.provenance.narrowedAtSource).toEqual([
      { field: "title", operator: "contains" },
    ]);
  });

  it("carries no values, because those are the visitor's own words", async () => {
    const result = (await filtered()) as { provenance: unknown };
    expect(JSON.stringify(result.provenance)).not.toContain("Inland");
  });

  it("says nothing when no filter was pushed", async () => {
    const result = (await runtimeFor(
      compile("Articles", "paper.articles", ["title", "section"]),
      "paper.articles",
      filteringTransport(),
    ).execute({}, { identity: { subject: "reader" } })) as {
      provenance: Record<string, unknown>;
    };
    expect(result.provenance.narrowedAtSource).toBeUndefined();
  });
});
