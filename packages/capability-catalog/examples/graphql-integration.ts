import {
  compileApprovedGraphQlCatalog,
  compileGraphQlOperation,
  createGraphQlCatalogInventory,
  type GraphQlCatalogDecisions,
} from "../src/graphql.js";

const schema = /* GraphQL */ `
  type Product {
    id: ID!
    name: String!
    price: Float!
    stock: Int!
    internalCost: Float!
  }

  type Query {
    products(minStock: Int, maxStock: Int, tenantId: ID!): [Product!]!
  }
`;

const review = createGraphQlCatalogInventory({
  schema,
  catalog: {
    id: "host-products",
    version: "1.0.0",
    description: "Host-approved product graph.",
  },
  source: {
    id: "host-graphql",
    label: "Host GraphQL API",
    description: "Host-owned product source.",
  },
  queries: [
    {
      fieldName: "products",
      capabilityId: "products.search",
      purpose: "Find products using approved stock filters.",
      dataTypeId: "product",
      dataTypeDescription: "A product available for generated views.",
      resultShape: "collection",
      matchKey: "id",
    },
  ],
});

const approval: GraphQlCatalogDecisions = {
  schemaVersion: "1.0",
  reviewSourceHash: review.reviewSourceHash,
  queries: [
    {
      capabilityId: "products.search",
      approvedVisitorArguments: ["minStock", "maxStock"],
      identityArguments: { tenantId: "tenantId" },
      approvedOutputFields: ["id", "name", "price", "stock"],
      requiredOutputFields: ["id"],
      policy: {
        authentication: "session",
        requiredPermissions: ["products:read"],
        maximumRows: 100,
        timeoutMs: 5_000,
      },
      limits: {
        maximumSelectionDepth: 2,
        maximumSelectedFields: 10,
        freshnessMaximumAgeSeconds: 300,
      },
    },
  ],
};

const bundle = compileApprovedGraphQlCatalog(schema, review, approval);
const binding = bundle.bindings.get("products.search");
if (!binding) throw new Error("Missing GraphQL binding");

/**
 * This is the only model-proposed portion. The model does not see tenantId, permissions,
 * endpoint details or credentials.
 */
const operation = compileGraphQlOperation(
  schema,
  binding,
  {
    capabilityId: "products.search",
    params: { minStock: 1, maxStock: 9 },
    selection: ["name", "price", "stock"],
  },
  { tenantId: "trusted-tenant-7" },
);

void operation;
