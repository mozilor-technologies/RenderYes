/** A local-only example which the reviewer may choose to load. The review UI never calls this API. */
export const sampleOpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "Poster API", version: "1.0.0" },
  servers: [{ url: "https://api.example.test" }],
  paths: {
    "/products": {
      get: {
        operationId: "listProducts",
        summary: "Search the sellable product catalog",
        parameters: [
          {
            name: "stockMin",
            in: "query",
            schema: { type: "integer", minimum: 0 },
            description: "Minimum units currently in stock.",
          },
          {
            name: "stockMax",
            in: "query",
            schema: { type: "integer", minimum: 0 },
            description: "Maximum units currently in stock.",
          },
          {
            name: "Authorization",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Products",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    description: "A sellable poster product.",
                    additionalProperties: false,
                    properties: {
                      id: { type: "string", description: "Stable product identifier." },
                      name: {
                        type: "string",
                        description: "Customer-facing product name.",
                      },
                      image: {
                        type: "string",
                        format: "uri",
                        description: "Poster thumbnail.",
                      },
                      price: {
                        type: "number",
                        description: "Current retail price in US dollars.",
                      },
                      stock: {
                        type: "integer",
                        description: "Units currently available to sell.",
                      },
                      supplierCost: {
                        type: "number",
                        description:
                          "Internal purchasing cost; do not expose in visitor views.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
