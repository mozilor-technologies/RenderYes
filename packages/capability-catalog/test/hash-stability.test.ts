import { describe, expect, it } from "vitest";
import { hashCapabilityCatalog } from "../src/compile.js";
import { createGraphQlCatalogInventory, hashGraphQlSchema } from "../src/graphql.js";
import { hashOpenApiDocument } from "../src/openapi.js";
import { hashOperationClassificationInput } from "../src/operation-effect.js";
import type { CapabilityCatalog } from "../src/schema.js";

/**
 * Golden hashes. These values are not a design choice — they are whatever the
 * implementation already produced, recorded so it cannot change by accident.
 *
 * Every one of these gates something a host has already stored. A catalog hash
 * mismatch is what raises `DATA_CATALOG_MISMATCH` at compose time; a review
 * source hash is what an exported approval carries so `diff` can tell whether
 * the schema moved underneath it; a document hash is what OpenAPI drift
 * detection compares against. So a hash that changes does not fail a test on a
 * developer's machine — it silently invalidates published catalogs and stored
 * approvals belonging to people who are not in the room.
 *
 * Written to hold four copies of `fnv1a` and `canonicalize` to a single
 * behaviour while they were consolidated into `hash.ts`. Kept afterwards,
 * because the risk it covers is permanent and the next change to hashing will
 * be made by someone who does not know that.
 *
 * If one of these fails: do not update the expected value to make it pass. That
 * converts a break for every existing host into a green suite. Either revert the
 * change, or treat it as a deliberate format migration with a version bump and a
 * path for artifacts already in the wild.
 */

const CATALOG: CapabilityCatalog = {
  catalogId: "hash-fixture",
  version: "1",
  capabilities: [
    {
      capabilityId: "orders.list",
      // Deliberately unsorted keys and a nested object: the whole point of
      // canonicalize is that key order must not reach the hash.
      description: "List orders",
      dataTypeId: "fixture.order",
      resultShape: "collection",
      policy: {
        authentication: "session",
        maximumRows: 25,
      },
      supports: {
        filterFields: ["status", "createdAt"],
        sortFields: ["createdAt"],
      },
      outputFields: [
        { path: "id", semanticType: "identifier" },
        { path: "status", semanticType: "category" },
      ],
    },
  ],
} as unknown as CapabilityCatalog;

const OPENAPI_DOCUMENT = {
  openapi: "3.0.0",
  info: { title: "Fixture API", version: "1.0.0" },
  paths: {
    "/orders": {
      get: {
        operationId: "listOrders",
        summary: "List orders",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

const GRAPHQL_SCHEMA = `
  type Order { id: ID!, status: String, total: Float }
  type Query { order(id: ID!): Order, orders: [Order!]! }
`;

const CLASSIFICATION_INPUT = {
  operations: [
    { key: "GET /orders", method: "GET", path: "/orders", summary: "List orders" },
  ],
};

describe("hash stability", () => {
  it("hashes a capability catalog to a fixed value", () => {
    expect(hashCapabilityCatalog(CATALOG)).toBe("9fe4b66f");
  });

  it("hashes an OpenAPI document to a fixed value", () => {
    expect(hashOpenApiDocument(OPENAPI_DOCUMENT)).toBe("609c0edc");
  });

  it("hashes a GraphQL schema to a fixed value", () => {
    expect(hashGraphQlSchema(GRAPHQL_SCHEMA)).toBe("7a51388c");
  });

  it("hashes a classification input to a fixed value", () => {
    expect(
      hashOperationClassificationInput(
        CLASSIFICATION_INPUT as never,
        "fixture-classifier",
      ),
    ).toBe("6fb92cec");
  });

  /**
   * The gap the rest of this file left open.
   *
   * A review source hash is what an exported approval carries so `diff` can tell
   * whether the schema moved underneath it. It was named above as one of the
   * three things at stake and then not pinned — it appears in five test files
   * and no assertion anywhere fixes its value, so it could change and every
   * suite would still pass.
   *
   * Note what it covers: `hashContent({ schemaHash, ...options })`, where the
   * options are the *reviewer's* selections. Discovery output — including
   * `suggestedResultShape` — is not in it. So changing shape inference does not
   * move this hash, which is worth writing down because it is the opposite of
   * what it looks like from the call site.
   */
  it("hashes a review source to a fixed value", () => {
    const draft = createGraphQlCatalogInventory({
      schema: GRAPHQL_SCHEMA,
      catalog: { id: "hash-fixture", version: "1", description: "Fixture." },
      source: { id: "fixture-source", label: "Fixture source" },
      queries: [
        {
          fieldName: "orders",
          capabilityId: "orders.list",
          purpose: "List orders.",
          dataTypeId: "fixture.order",
          dataTypeDescription: "An order.",
          resultShape: "collection",
          matchKey: "id",
        },
      ],
    } as never);
    expect(draft.reviewSourceHash).toBe("ba79c893");
  });

  it("ignores key order, which is the reason canonicalize exists", () => {
    // Same document, keys declared in a different order. If canonicalize is
    // ever dropped or narrowed, this is what catches it — and it catches it
    // without needing a golden value, so it stays meaningful across migrations.
    const reordered = {
      paths: {
        "/orders": {
          get: {
            responses: { "200": { description: "ok" } },
            summary: "List orders",
            operationId: "listOrders",
          },
        },
      },
      info: { version: "1.0.0", title: "Fixture API" },
      openapi: "3.0.0",
    };
    expect(hashOpenApiDocument(reordered)).toBe(hashOpenApiDocument(OPENAPI_DOCUMENT));
  });

  it("still separates documents that differ", () => {
    const changed = { ...OPENAPI_DOCUMENT, info: { title: "Other", version: "1.0.0" } };
    expect(hashOpenApiDocument(changed)).not.toBe(hashOpenApiDocument(OPENAPI_DOCUMENT));
  });
});
