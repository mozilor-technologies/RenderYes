import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCatalogInventory,
} from "../src/graphql.js";

/**
 * `requiredOutputFields` reaching the runtime, not only the fetch.
 *
 * The decisions file's only lever for "my component cannot render without this
 * field" forced the field into the GraphQL selection and stopped there. Nothing
 * downstream could see it, so a plan that narrowed `query.project` dropped the
 * field one layer after it was fetched — approved, selected, and gone before it
 * reached the component.
 *
 * Found on a live install: a component wrapping `next/image` needs intrinsic
 * width and height. They were approved and required, `next/image` threw, and
 * two components had to abandon the host's own image wrapper for a plain
 * `<img>`. The compile now publishes them on the capability so the projection
 * honours them too.
 *
 * The reporter diagnosed this as the compile discarding dotted paths. It does
 * not — `binding.requiredOutputFields` keeps every one. What they read as the
 * compiled required list was `outputSchema.required`, which is derived from
 * GraphQL non-nullness and answers a different question entirely. Both facts
 * are asserted below so neither reading is lost again.
 */

const SDL = `
  type Query {
    Posts(limit: Int, page: Int): PostPage!
  }
  type PostPage {
    docs: [Post!]!
    totalDocs: Int!
  }
  type Post {
    id: Int!
    title: String!
    slug: String
    meta: Meta
  }
  type Meta {
    image: Image
  }
  type Image {
    url: String
    width: Int
    height: Int
  }
`;

const APPROVED = ["id", "title", "slug", "meta.image.url", "meta.image.width", "meta.image.height"];

function compile(requiredOutputFields: readonly string[]) {
  const draft = createGraphQlCatalogInventory({
    schema: SDL,
    catalog: { id: "paper", version: "1.0.0", description: "A paper." },
    source: { id: "cms", label: "CMS", description: "The site's own endpoint." },
    queries: [
      {
        fieldName: "Posts",
        capabilityId: "graphql.Posts",
        purpose: "List articles for a reader.",
        dataTypeId: "Post",
        dataTypeDescription: "One article.",
        resultShape: "collection",
        listEnvelope: { rowsField: "docs", totalCountField: "totalDocs" },
      } as never,
    ],
  });
  return compileApprovedGraphQlCatalog(SDL, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    semanticTypeOverrides: {
      "Query.Posts.meta.image.width": "quantity",
      "Query.Posts.meta.image.height": "quantity",
    },
    queries: [
      {
        capabilityId: "graphql.Posts",
        approvedVisitorArguments: [],
        identityArguments: {},
        approvedOutputFields: APPROVED,
        requiredOutputFields: [...requiredOutputFields],
        policy: { authentication: "public", maximumRows: 50, timeoutMs: 5_000, cacheTtlSeconds: 0 },
        limits: { maximumSelectionDepth: 6, maximumSelectedFields: 40 },
      } as never,
    ],
  });
}

describe("requiredOutputFields", () => {
  it("publishes the host's required fields on the capability, dotted paths included", () => {
    const { catalog } = compile(APPROVED);
    expect(catalog.capabilities[0]!.supports?.requiredFields).toEqual(APPROVED);
  });

  it("keeps every dotted path on the binding, which forces the fetch selection", () => {
    const { bindings } = compile(APPROVED);
    expect(bindings.get("graphql.Posts")!.requiredOutputFields).toEqual(APPROVED);
  });

  it("does not confuse them with outputSchema.required, which is non-nullness", () => {
    const { catalog } = compile(APPROVED);
    const output = catalog.capabilities[0]!.outputSchema as {
      items?: { required?: string[] };
      required?: string[];
    };
    // `id` and `title` are the non-null fields in the schema. That list is not
    // a statement about what a projection may drop.
    expect(output.items?.required ?? output.required).toEqual(["id", "title"]);
  });

  it("states nothing when the host required nothing", () => {
    const { catalog } = compile([]);
    expect(catalog.capabilities[0]!.supports?.requiredFields).toBeUndefined();
  });
});

/**
 * Two contradictions a live install hit, refused and named at the compile
 * rather than three steps later.
 */
describe("declarations that contradict each other", () => {
  const ENVELOPE_SDL = `
    type Query { Posts(limit: Int): PostPage!  Post(id: Int!): Post }
    type PostPage { docs: [Post!]!  totalDocs: Int! }
    type Post { id: Int!  title: String! }
  `;

  function compileWith(resultShape: string, extras: Record<string, unknown> = {}) {
    const draft = createGraphQlCatalogInventory({
      schema: ENVELOPE_SDL,
      catalog: { id: "paper", version: "1.0.0", description: "A paper." },
      source: { id: "cms", label: "CMS", description: "The endpoint." },
      queries: [
        {
          fieldName: "Posts",
          capabilityId: "graphql.Posts",
          purpose: "List articles for a reader.",
          dataTypeId: "Post",
          dataTypeDescription: "One article.",
          resultShape,
          listEnvelope: { rowsField: "docs", totalCountField: "totalDocs" },
        } as never,
      ],
    });
    return compileApprovedGraphQlCatalog(ENVELOPE_SDL, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "graphql.Posts",
          approvedVisitorArguments: [],
          identityArguments: {},
          approvedOutputFields: ["id", "title"],
          requiredOutputFields: ["id"],
          policy: { authentication: "public", maximumRows: 50, timeoutMs: 5_000, cacheTtlSeconds: 0 },
          limits: { maximumSelectionDepth: 4, maximumSelectedFields: 20 },
          ...extras,
        } as never,
      ],
    });
  }

  it("refuses an envelope published as one record", () => {
    // 401 articles as a single entity: nothing failed until a component
    // declined to bind, three steps from the cause.
    expect(() => compileWith("entity")).toThrow(/listEnvelope .* resultShape is "entity"/s);
  });

  it("still allows a reviewer to reinterpret rows", () => {
    // `time-series` over rows is what --shapes exists for.
    expect(() => compileWith("time-series")).not.toThrow();
  });

  it("warns when a required argument is one the planner cannot know", () => {
    const draft = createGraphQlCatalogInventory({
      schema: ENVELOPE_SDL,
      catalog: { id: "paper", version: "1.0.0", description: "A paper." },
      source: { id: "cms", label: "CMS", description: "The endpoint." },
      queries: [
        {
          fieldName: "Post",
          capabilityId: "graphql.Post",
          purpose: "Fetch one article.",
          dataTypeId: "Post",
          dataTypeDescription: "One article.",
          resultShape: "entity",
        } as never,
      ],
    });
    const { issues } = compileApprovedGraphQlCatalog(ENVELOPE_SDL, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "graphql.Post",
          approvedVisitorArguments: ["id"],
          identityArguments: {},
          approvedOutputFields: ["id", "title"],
          requiredOutputFields: ["id"],
          policy: { authentication: "public", maximumRows: 1, timeoutMs: 5_000, cacheTtlSeconds: 0 },
          limits: { maximumSelectionDepth: 4, maximumSelectedFields: 20 },
        } as never,
      ],
    });
    const warning = issues.find((issue) => issue.path === "graphql.Post.arguments");
    expect(warning?.message).toMatch(/impossible for it to obtain/);
  });
});
