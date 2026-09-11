import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  compileGraphQlOperation,
  createGraphQlCatalogInventory,
  executeApprovedGraphQlRequest,
  listGraphQlQueries,
} from "../src/graphql.js";

/**
 * Interfaces as row types.
 *
 * They already worked, which was itself the problem: a `Content` connection
 * discovers, compiles and executes exactly like an object type, so a reviewer
 * sees a clean three-field list and no sign that the article rows carry a word
 * count and the video rows a duration. Those fields need `... on Article {}` —
 * the same fragment machinery unions need, which GraphQL 0.2 does not have —
 * and they were absent with nothing said.
 *
 * Interfaces usually *are* the whole story, so absence read as completeness.
 * These pin both halves: the shared fields work end to end, and the ones that
 * cannot are on the ledger with the concrete type that declares them.
 */

const SDL = `
  interface Content {
    id: ID!
    title: String!
    publishedAt: String
  }
  type Article implements Content {
    id: ID!
    title: String!
    publishedAt: String
    wordCount: Int!
    "Declared by both implementations, still not by the interface."
    slug: String!
  }
  type Video implements Content {
    id: ID!
    title: String!
    publishedAt: String
    durationSeconds: Int!
    slug: String!
  }
  type ContentConnection { edges: [ContentEdge!]!  pageInfo: PageInfo! }
  type ContentEdge { cursor: String!  node: Content! }
  type PageInfo { hasNextPage: Boolean!  endCursor: String }
  type Query { contents(first: Int): ContentConnection }
`;

const contents = (depth = 3) =>
  listGraphQlQueries(SDL, { maximumDiscoveryDepth: depth }).find(
    (query) => query.fieldName === "contents",
  )!;

function approved() {
  const draft = createGraphQlCatalogInventory({
    schema: SDL,
    catalog: { id: "cms", version: "1.0.0", description: "Approved content reads." },
    source: { id: "cms-api", label: "CMS", description: "The content graph." },
    queries: [
      {
        fieldName: "contents",
        capabilityId: "graphql.contents",
        purpose: "List published content.",
        dataTypeId: "content",
        dataTypeDescription: "One content item.",
        resultShape: "collection",
        matchKey: "id",
      },
    ],
    discoveryMaxDepth: 3,
  });
  return {
    draft,
    compiled: compileApprovedGraphQlCatalog(SDL, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "graphql.contents",
          approvedVisitorArguments: ["first"],
          identityArguments: {},
          approvedOutputFields: ["id", "title", "publishedAt"],
          requiredOutputFields: ["id"],
          policy: {
            authentication: "public",
            maximumRows: 50,
            timeoutMs: 5_000,
            cacheTtlSeconds: 0,
          },
          limits: { maximumSelectionDepth: 3, maximumSelectedFields: 20 },
        },
      ],
    }),
  };
}

describe("an interface behind a connection", () => {
  it("is a supported row type, not a rejected one", () => {
    const query = contents();
    expect(query.support.status).toBe("supported");
    expect(query.connection?.nodeTypeName).toBe("Content");
    expect(query.outputFields.map((field) => field.path)).toEqual([
      "id",
      "title",
      "publishedAt",
    ]);
  });

  it("compiles to a plain selection with no fragment in it", () => {
    const { compiled } = approved();
    const operation = compileGraphQlOperation(
      SDL,
      compiled.bindings.get("graphql.contents")!,
      { capabilityId: "graphql.contents", params: { first: 2 } },
      {},
    );
    expect(operation.document).toContain("node {");
    expect(operation.document).not.toContain("... on");
  });

  it("executes and delivers rows of mixed implementations", async () => {
    const { compiled } = approved();
    const result = await executeApprovedGraphQlRequest({
      catalog: compiled.catalog,
      schema: SDL,
      binding: compiled.bindings.get("graphql.contents")!,
      request: { capabilityId: "graphql.contents", params: { first: 2 } },
      context: { identity: {} },
      // The upstream returns an article and a video through one interface
      // selection; nothing downstream needs to know which is which.
      transport: async () => ({
        data: {
          contents: {
            pageInfo: { hasNextPage: false },
            edges: [
              { cursor: "c1", node: { id: "a1", title: "An article", publishedAt: null } },
              { cursor: "c2", node: { id: "v1", title: "A video", publishedAt: null } },
            ],
          },
        },
      }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "cms-api" }],
        freshness: { asOf: "2026-08-13T10:00:00.000Z" },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(2);
  });

  it("puts every implementation-only field on the ledger, with who declares it", () => {
    const query = contents();
    const byPath = new Map(
      query.exclusions
        .filter((exclusion) => exclusion.reason === "interface-implementation")
        .map((exclusion) => [exclusion.path, exclusion]),
    );

    expect([...byPath.keys()].sort()).toEqual([
      "durationSeconds",
      "slug",
      "wordCount",
    ]);
    expect(byPath.get("wordCount")).toMatchObject({ type: "Int!" });
    expect(byPath.get("wordCount")?.detail).toContain("Article");
    expect(byPath.get("durationSeconds")?.detail).toContain("Video");
    // A field both implementations declare is one entry naming both, not two
    // entries fighting over the same path.
    expect(byPath.get("slug")?.detail).toContain("Article, Video");
    // And the advice is the same one the union case gives, because the remedy
    // is the same: register the concrete type as its own capability.
    expect(byPath.get("wordCount")?.detail).toMatch(/separate capability/);
  });

  it("does not offer any of them for approval", () => {
    // The ledger explains an absence; it must not become a second field list a
    // host can accidentally approve from.
    const offered = contents().outputFields.map((field) => field.path);
    expect(offered).not.toContain("wordCount");
    expect(offered).not.toContain("slug");
  });

  it("says it once, not once per field", () => {
    const notes = contents().issues.filter((issue) =>
      issue.message.includes("Declared by implementations"),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain("wordCount");
    expect(notes[0]?.message).toContain("durationSeconds");
  });

  it("the draft a host stores carries the ledger too", () => {
    // The draft is the artifact reviewed months later, and "what could I not
    // approve" is a question about that artifact.
    const { draft } = approved();
    expect(
      draft.queries[0]?.exclusions.some(
        (exclusion) => exclusion.reason === "interface-implementation",
      ),
    ).toBe(true);
  });
});
