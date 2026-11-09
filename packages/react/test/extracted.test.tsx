import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewProvider } from "../src/provider.js";
import { useViewCompose, type ComposeState } from "../src/use-compose.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * `extracted` is what the service read out of the visitor's prompt by code —
 * today a website address for the host's handover link. It follows the view
 * on screen: replaced by a fresh compose, kept by a revision that names no
 * site, untouched by a failure, cleared by reset. Each value is re-checked on
 * arrival, so a server that sent something malformed gets nothing through.
 */

const messages = [
  { version: "v0.9", createSurface: { surfaceId: "main", catalogId: "setup:ui" } },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "main",
      components: [{ id: "root", component: "Column", children: [] }],
    },
  },
  { version: "v0.9", updateDataModel: { surfaceId: "main", path: "/", value: {} } },
];

const ok = (planId: string, extracted?: unknown) => ({
  ok: true,
  catalogId: "setup",
  cached: false,
  planId,
  requests: [],
  messages,
  ...(extracted === undefined ? {} : { extracted }),
});

function stubResponses(...payloads: unknown[]) {
  const queue = [...payloads];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const payload = queue.shift();
      const failed = (payload as { ok?: boolean }).ok === false;
      return {
        ok: !failed,
        status: failed ? 422 : 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => payload,
      };
    }),
  );
}

function mountHook(): { current: () => ComposeState } {
  let state: ComposeState | undefined;
  function Probe() {
    state = useViewCompose();
    return null;
  }
  render(
    <ViewProvider
      config={{
        serviceUrl: "https://setup.example",
        catalogId: "setup",
        components: [],
        stream: false,
      }}
    >
      <Probe />
    </ViewProvider>,
  );
  return { current: () => state! };
}

describe("extracted", () => {
  it("is empty before any compose", () => {
    const hook = mountHook();
    expect(hook.current().extracted).toEqual({});
  });

  it("follows the view: set by a compose, kept by a revision naming no site, cleared by reset", async () => {
    stubResponses(
      ok("plan-1", { websiteAddress: "https://candlecraft.example" }),
      ok("plan-2"),
      {
        ok: false,
        kind: "unsupported",
        reason: "Not something this site can show.",
        issues: [],
      },
    );
    const hook = mountHook();

    await act(() =>
      hook.current().submit({ prompt: "Store is candlecraft.example on Shopify" }),
    );
    expect(hook.current().extracted).toEqual({
      websiteAddress: "https://candlecraft.example",
    });

    await act(() => hook.current().submit({ prompt: "only the EU laws", revise: true }));
    expect(hook.current().planId).toBe("plan-2");
    expect(hook.current().extracted).toEqual({
      websiteAddress: "https://candlecraft.example",
    });

    await act(() => hook.current().submit({ prompt: "delete my account" }));
    // A failed compose leaves the view, and what it carried, where it was.
    expect(hook.current().extracted).toEqual({
      websiteAddress: "https://candlecraft.example",
    });

    act(() => hook.current().reset());
    expect(hook.current().extracted).toEqual({});
  });

  it("a fresh compose naming no site clears the last one", async () => {
    stubResponses(
      ok("plan-1", { websiteAddress: "https://candlecraft.example" }),
      ok("plan-2"),
    );
    const hook = mountHook();
    await act(() => hook.current().submit({ prompt: "Store is candlecraft.example" }));
    await act(() => hook.current().submit({ prompt: "laws in Germany" }));
    expect(hook.current().extracted).toEqual({});
  });

  it("re-checks what the server sent and drops what fails", async () => {
    stubResponses(ok("plan-1", { websiteAddress: "javascript:alert(document.cookie)" }));
    const hook = mountHook();
    await act(() => hook.current().submit({ prompt: "my site" }));
    expect(hook.current().extracted).toEqual({});
  });
});
