import { describe, expect, it } from "vitest";
import { exampleCatalog, executeExampleRequest } from "../examples/integration.js";
import {
  findCapabilityRuntime,
  validateCapabilityPreflight,
  validateCapabilityResult,
} from "../src/server.js";

describe("capability catalog handoff contract", () => {
  it("keeps trusted runtime and authorization details out of the planner manifest", () => {
    const serialized = JSON.stringify(exampleCatalog.plannerManifest);

    expect(serialized).toContain("products.search");
    expect(serialized).not.toContain("viewerId");
    expect(serialized).not.toContain("products.read");
    expect(serialized).not.toContain("execute");
  });

  it("preflights planner parameters separately from trusted identity and permissions", () => {
    const invalid = validateCapabilityPreflight(
      exampleCatalog.catalog,
      "products.search",
      { viewerId: "model-controlled" },
      { identity: {}, permissions: new Set() },
    );

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues.map((issue) => issue.message).join(" ")).toContain(
        "Missing required trusted session key",
      );
      expect(invalid.issues.map((issue) => issue.message).join(" ")).toContain(
        "Missing required permission",
      );
    }
  });

  it("looks up and executes a capability-owned runtime", async () => {
    const runtime = findCapabilityRuntime(exampleCatalog.runtimes, "products.search");
    expect(runtime?.capabilityId).toBe("products.search");

    const result = await executeExampleRequest(
      "products.search",
      { minimumStock: 1, maximumStock: 9 },
      {
        identity: { viewerId: "trusted-session-value" },
        permissions: new Set(["products.read"]),
      },
    );

    expect(result.ok).toBe(true);
  });

  it("rejects invalid data, provenance, and freshness before rendering", () => {
    const result = validateCapabilityResult(exampleCatalog.catalog, "products.search", {
      ok: true,
      data: [{ id: "p1", name: "Broken", stock: "four" }],
      provenance: {
        sources: [{ sourceId: "unapproved-source" }],
        freshness: {
          asOf: "2026-07-28T00:00:00.000Z",
          staleAt: "2026-07-27T00:00:00.000Z",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const messages = result.issues.map((issue) => issue.message).join(" ");
      expect(messages).toContain("must be integer");
      expect(messages).toContain("is not approved");
      expect(messages).toContain("must not be earlier");
    }
  });

  it("accepts a standardized runtime failure without treating it as data", () => {
    expect(
      validateCapabilityResult(exampleCatalog.catalog, "products.search", {
        ok: false,
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "The approved source is temporarily unavailable.",
          retryable: true,
        },
      }),
    ).toEqual({ ok: true });
  });
});
