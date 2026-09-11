import { z } from "zod";
import type { CapabilityExecutionResult } from "../src/index.js";
import {
  createManualCatalog,
  defineCapability,
  defineDataType,
  findCapabilityRuntime,
  validateCapabilityPreflight,
  validateCapabilityResult,
} from "../src/server.js";

const Product = z.strictObject({
  id: z.string(),
  name: z.string(),
  stock: z.number().int().nonnegative(),
});

export const exampleCatalog = createManualCatalog({
  id: "example-store",
  version: "1.0.0",
  description: "Small integration example for an approved product source.",
  dataTypes: [
    defineDataType({
      id: "product",
      version: "1.0.0",
      description: "A product available from the host catalog.",
      schema: Product,
      matchKey: "id",
      fields: {
        id: { label: "Product ID", semanticType: "identifier" },
        name: { label: "Product", semanticType: "text" },
        stock: { label: "Stock", semanticType: "quantity", unit: "item" },
      },
    }),
  ],
  sources: [{ id: "host-products", label: "Host product service" }],
  capabilities: [
    defineCapability({
      id: "products.search",
      version: "1.0.0",
      purpose: "Find products within an approved stock range.",
      kind: "query",
      inputSchema: z.strictObject({
        minimumStock: z.number().int().nonnegative().optional(),
        maximumStock: z.number().int().nonnegative().optional(),
      }),
      outputSchema: z.array(Product),
      output: { dataTypeId: "product", shape: "collection" },
      requiredSessionKeys: ["viewerId"],
      sourceIds: ["host-products"],
      supports: { filterFields: ["stock"], sortFields: ["stock"] },
      policy: {
        authentication: "session",
        requiredPermissions: ["products.read"],
        maximumRows: 100,
      },
      execute: async () => ({
        ok: true,
        data: [{ id: "p1", name: "Example", stock: 4 }],
        provenance: {
          sources: [{ sourceId: "host-products" }],
          freshness: { asOf: "2026-07-28T00:00:00.000Z" },
        },
      }),
    }),
  ],
});

/**
 * Illustrative adapter only. A host should place the same checks inside its own deterministic
 * executor and translate failures into its existing error model.
 */
export async function executeExampleRequest(
  capabilityId: string,
  params: unknown,
  trustedContext: {
    identity: Readonly<Record<string, unknown>>;
    permissions: ReadonlySet<string>;
    signal?: AbortSignal;
  },
): Promise<CapabilityExecutionResult<unknown>> {
  const preflight = validateCapabilityPreflight(
    exampleCatalog.catalog,
    capabilityId,
    params,
    trustedContext,
  );
  if (!preflight.ok) {
    return {
      ok: false,
      error: {
        code: "PREFLIGHT_FAILED",
        message: preflight.issues.map((issue) => issue.message).join("; "),
        retryable: false,
      },
    };
  }

  const runtime = findCapabilityRuntime(exampleCatalog.runtimes, capabilityId);
  if (!runtime) {
    return {
      ok: false,
      error: {
        code: "RUNTIME_NOT_FOUND",
        message: `No runtime is registered for "${capabilityId}"`,
        retryable: false,
      },
    };
  }

  const result = await runtime.execute(params, {
    identity: trustedContext.identity,
    ...(trustedContext.signal ? { signal: trustedContext.signal } : {}),
  });
  const validation = validateCapabilityResult(
    exampleCatalog.catalog,
    capabilityId,
    result,
  );

  return validation.ok
    ? result
    : {
        ok: false,
        error: {
          code: "INVALID_RUNTIME_RESULT",
          message: validation.issues.map((issue) => issue.message).join("; "),
          retryable: false,
        },
      };
}
