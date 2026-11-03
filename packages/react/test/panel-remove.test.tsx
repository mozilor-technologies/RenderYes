import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineProps, field } from "@renderyes/site-sdk";
import {
  defineHostComponent,
  type RegisteredHostComponent,
} from "../src/define-host-component.js";
import { ViewProvider } from "../src/provider.js";
import { ViewWorkspace } from "../src/workspace.js";

/**
 * Removing a panel from a composed multi-panel view. What these pin: the
 * control is one `removeNode` refinement of the plan on screen (never a
 * compose), it is never offered on a single-panel view because the server
 * refuses to empty one, and `removePanels={false}` keeps it off entirely.
 */

const UI_CATALOG_ID = "support-assist:ui";

function PanelCard({ title, report }: { title?: string; report?: { status?: string } }) {
  return (
    <div data-testid="panel-card" data-title={title}>
      <span>{report?.status ?? "no status"}</span>
    </div>
  );
}

const registered = defineHostComponent({
  id: "PanelCard",
  description: "Shows one report.",
  dataSlots: {
    report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
  },
  props: defineProps({ title: field.string() }),
  component: PanelCard,
});

function panelsFixture(children: string[], statuses: Record<string, string>) {
  return [
    {
      version: "v0.9",
      createSurface: { surfaceId: "main", catalogId: UI_CATALOG_ID },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "main",
        components: [
          { id: "root", component: "Column", children },
          ...Object.keys(statuses).map((id) => ({
            id,
            component: "PanelCard",
            title: id,
            report: { path: `/${id}/report` },
          })),
        ],
      },
    },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: "main",
        path: "/",
        value: Object.fromEntries(
          Object.entries(statuses).map(([id, status]) => [id, { report: { status } }]),
        ),
      },
    },
  ];
}

function stubFetchByRoute(routes: Record<string, { payload: unknown }>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const target = String(url);
    const match = Object.keys(routes)
      .sort((left, right) => right.length - left.length)
      .find((path) => target.includes(path));
    calls.push({ url: target, body: init.body ? JSON.parse(String(init.body)) : {} });
    if (!match) throw new Error(`unexpected call to ${target}`);
    return { ok: true, status: 200, json: async () => routes[match].payload };
  });
  vi.stubGlobal("fetch", impl);
  return {
    calls,
    composeCalls: () => calls.filter((call) => call.url.includes("/api/compose")),
    refineCalls: () => calls.filter((call) => call.url.includes("/api/refine")),
  };
}

function renderWorkspace(
  props: { removePanels?: boolean } = {},
  config: { components?: RegisteredHostComponent[] } = {},
) {
  return render(
    <ViewProvider
      config={{
        serviceUrl: "https://intent.example",
        catalogId: "support-assist",
        components: config.components ?? [registered],
        renderMode: "host",
        composeTimeoutMs: 1_000,
        stream: false,
      }}
    >
      <ViewWorkspace {...props} />
    </ViewProvider>,
  );
}

function askWorkspace(text = "open reports and closed reports") {
  fireEvent.change(screen.getByLabelText("Describe what you want"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
}

function renderedPanels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-testid='panel-card']")).map(
    (card) => card.getAttribute("data-title") ?? "",
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("panel removal", () => {
  it("drops a panel through exactly one removeNode refinement, never a compose", async () => {
    const routes = stubFetchByRoute({
      "/api/compose": {
        payload: {
          ok: true,
          planId: "plan-7",
          messages: panelsFixture(["n1", "n2"], { n1: "open", n2: "closed" }),
        },
      },
      "/api/refine": {
        payload: {
          ok: true,
          planId: "plan-8",
          messages: panelsFixture(["n1"], { n1: "open" }),
        },
      },
    });
    const view = renderWorkspace();
    askWorkspace();
    await waitFor(() => expect(renderedPanels(view.container)).toEqual(["n1", "n2"]));

    fireEvent.click(screen.getByLabelText("Remove panel 2 of 2"));
    await waitFor(() => expect(routes.refineCalls()).toHaveLength(1), { timeout: 2_000 });

    const refine = routes.refineCalls()[0];
    expect(refine.body.planId).toBe("plan-7");
    expect(refine.body.operations).toEqual([{ kind: "removeNode", nodeId: "n2" }]);
    expect(routes.composeCalls()).toHaveLength(1);

    // The server's answer is the view: one panel left, and no control to
    // remove it, because the server would refuse to empty the view.
    await waitFor(() => expect(renderedPanels(view.container)).toEqual(["n1"]));
    expect(screen.queryByLabelText(/Remove panel/)).toBeNull();
  });

  it("is never offered on a single-panel view", async () => {
    stubFetchByRoute({
      "/api/compose": {
        payload: {
          ok: true,
          planId: "plan-7",
          messages: panelsFixture(["n1"], { n1: "open" }),
        },
      },
    });
    const view = renderWorkspace();
    askWorkspace();
    await waitFor(() => expect(renderedPanels(view.container)).toEqual(["n1"]));
    expect(screen.queryByLabelText(/Remove panel/)).toBeNull();
  });

  it("removePanels={false} keeps the control off a multi-panel view", async () => {
    stubFetchByRoute({
      "/api/compose": {
        payload: {
          ok: true,
          planId: "plan-7",
          messages: panelsFixture(["n1", "n2"], { n1: "open", n2: "closed" }),
        },
      },
    });
    const view = renderWorkspace({ removePanels: false });
    askWorkspace();
    await waitFor(() => expect(renderedPanels(view.container)).toEqual(["n1", "n2"]));
    expect(screen.queryByLabelText(/Remove panel/)).toBeNull();
    // The other controls are untouched by the switch.
    expect(screen.getByLabelText("Move panel 1 of 2")).toBeTruthy();
  });
});
