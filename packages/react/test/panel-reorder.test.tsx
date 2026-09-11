import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { z } from "zod";
import { defineProps, field } from "@renderyes/site-sdk";
import { createBinderlessComponentImplementation } from "@a2ui/react/v0_9";
import { encodeComposeEvent, type ComposeEvent } from "@renderyes/core";
import {
  defineHostComponent,
  type RegisteredHostComponent,
} from "../src/define-host-component.js";
import { ViewProvider } from "../src/provider.js";
import { ViewWorkspace } from "../src/workspace.js";

/**
 * Rearranging the panels of a composed multi-panel view. The properties these
 * pin are the two-phase contract (the screen moves at once, exactly one
 * background `reorderNodes` refinement persists it — never a compose), the
 * renderer decision (a moved panel keeps its local React state, which is the
 * entire reason `SurfacePanels` exists instead of asking the root Column to
 * reorder its index-keyed children), the guard (a host's own Column override
 * keeps the previous render path, gripless), and the keyboard path as a
 * first-class citizen (accessible grip names, a live-region announcement).
 */

const UI_CATALOG_ID = "support-assist:ui";

/**
 * A host component with panel-local state: the counter lives in `useState`
 * and nowhere else, so it survives a reorder only if the panel's React
 * subtree survives — a remounted panel silently resets it to 0.
 */
function PanelCard({ title, report }: { title?: string; report?: { status?: string } }) {
  const [count, setCount] = useState(0);
  return (
    <div data-testid="panel-card" data-title={title}>
      <span>{report?.status ?? "no status"}</span>
      <button data-testid={`count-${title}`} onClick={() => setCount(count + 1)}>
        {count}
      </button>
    </div>
  );
}

const registered = defineHostComponent({
  id: "PanelCard",
  description: "Shows one report with a local counter.",
  dataSlots: {
    report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
  },
  props: defineProps({ title: field.string() }),
  component: PanelCard,
});

/**
 * A composed view whose top-level panels are `children`, in that order — the
 * shape the server compiles: the root Column's children are the plan's
 * top-level nodeIds, and each node's `title` is its own id so a test can read
 * the rendered order straight off the DOM.
 */
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

/**
 * Routes by URL so a test can prove a reorder never reached `/api/compose`.
 * Counting total fetches would not distinguish "refined" from "recomposed",
 * which is the entire claim two-phase persistence makes.
 */
function stubFetchByRoute(
  routes: Record<string, { payload: unknown; ok?: boolean; status?: number }>,
) {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const target = String(url);
    const match = Object.keys(routes)
      .sort((left, right) => right.length - left.length)
      .find((path) => target.includes(path));
    calls.push({
      url: target,
      method: String(init.method ?? "GET"),
      body: init.body ? JSON.parse(String(init.body)) : {},
    });
    if (!match) throw new Error(`unexpected call to ${target}`);
    const route = routes[match];
    return {
      ok: route.ok ?? true,
      status: route.status ?? (route.ok === false ? 400 : 200),
      json: async () => route.payload,
    };
  });
  vi.stubGlobal("fetch", impl);
  return {
    calls,
    composeCalls: () => calls.filter((call) => call.url.includes("/api/compose")),
    refineCalls: () => calls.filter((call) => call.url.includes("/api/refine")),
  };
}

function renderWorkspace(
  props: { savedViews?: boolean; rearrange?: boolean } = {},
  config: { components?: RegisteredHostComponent[]; stream?: boolean } = {},
) {
  return render(
    <ViewProvider
      config={{
        serviceUrl: "https://intent.example",
        catalogId: "support-assist",
        components: config.components ?? [registered],
        renderMode: "host",
        composeTimeoutMs: 1_000,
        stream: config.stream ?? false,
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

/** The rendered top-level panel order, read off each card's own node id. */
function renderedOrder(container: HTMLElement): string[] {
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

describe("panel rearrangement", () => {
  it("a keyboard move-down changes the rendered order immediately", async () => {
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
          messages: panelsFixture(["n2", "n1"], { n1: "open", n2: "closed" }),
        },
      },
    });
    const view = renderWorkspace();
    askWorkspace();
    await waitFor(() => expect(renderedOrder(view.container)).toEqual(["n1", "n2"]));

    fireEvent.keyDown(screen.getByLabelText("Move panel 1 of 2"), {
      key: "ArrowDown",
    });
    // The move is on screen before any network round-trip: phase one is local.
    expect(renderedOrder(view.container)).toEqual(["n2", "n1"]);
    expect(routes.refineCalls()).toHaveLength(0);

    // Let the debounced write land so it does not outlive the test.
    await waitFor(() => expect(routes.refineCalls()).toHaveLength(1), {
      timeout: 2_000,
    });
    expect(renderedOrder(view.container)).toEqual(["n2", "n1"]);
  });

  it("persists via exactly one reorderNodes refinement, never a compose", async () => {
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
          messages: panelsFixture(["n2", "n1"], { n1: "open", n2: "closed" }),
        },
      },
    });
    const view = renderWorkspace();
    askWorkspace();
    await waitFor(() => expect(renderedOrder(view.container)).toEqual(["n1", "n2"]));

    fireEvent.keyDown(screen.getByLabelText("Move panel 1 of 2"), {
      key: "ArrowDown",
    });
    await waitFor(() => expect(routes.refineCalls()).toHaveLength(1), {
      timeout: 2_000,
    });

    // The wire contract: the plan on screen, one operation, the full new
    // order — every current nodeId exactly once.
    const refine = routes.refineCalls()[0];
    expect(refine.body.planId).toBe("plan-7");
    expect(refine.body.operations).toEqual([
      { kind: "reorderNodes", nodeIds: ["n2", "n1"] },
    ]);
    // One compose built the view; the reorder never asked for another.
    expect(routes.composeCalls()).toHaveLength(1);
  });

  it("panel-local state survives the move and the server's confirmation", async () => {
    // The refine response carries a changed status so the test can see the
    // moment the server's messages are adopted — a whole-message replacement,
    // which is exactly when an index-keyed renderer would remount the panels.
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
          messages: panelsFixture(["n2", "n1"], { n1: "refreshed", n2: "closed" }),
        },
      },
    });
    const view = renderWorkspace();
    askWorkspace();
    await waitFor(() => expect(renderedOrder(view.container)).toEqual(["n1", "n2"]));

    fireEvent.click(screen.getByTestId("count-n1"));
    fireEvent.click(screen.getByTestId("count-n1"));
    expect(screen.getByTestId("count-n1").textContent).toBe("2");

    fireEvent.keyDown(screen.getByLabelText("Move panel 1 of 2"), {
      key: "ArrowDown",
    });
    // Immediately after the local move: the panel moved, its state did not.
    expect(renderedOrder(view.container)).toEqual(["n2", "n1"]);
    expect(screen.getByTestId("count-n1").textContent).toBe("2");

    // And after the refine response replaces the messages (the data refreshed
    // — a refinement re-executes the plan), the counter still stands: the
    // wrappers are keyed by nodeId alone, so nothing remounted.
    await waitFor(() => expect(screen.getByText("refreshed")).toBeTruthy(), {
      timeout: 2_000,
    });
    expect(renderedOrder(view.container)).toEqual(["n2", "n1"]);
    expect(screen.getByTestId("count-n1").textContent).toBe("2");
    expect(routes.refineCalls()).toHaveLength(1);
  });

  it("keeps panel order stable across streamed STATE_SNAPSHOT and STATE_DELTA events", async () => {
    // A streamed compose replaces `messages` wholesale on every event. The
    // panel order must ride the snapshot's root children throughout — a delta
    // that fills one slot's data must neither shuffle nor remount panels.
    const runId = "run-1";
    let clock = 0;
    const event = (type: ComposeEvent["type"], fields: Record<string, unknown> = {}) =>
      ({ type, runId, timestamp: (clock += 1), ...fields }) as ComposeEvent;
    const frames = [
      event("RUN_STARTED", { catalogId: "support-assist", surfaceId: "main" }),
      event("STATE_SNAPSHOT", {
        messages: panelsFixture(["n1", "n2"], { n1: "pending", n2: "pending" }),
      }),
      event("STATE_DELTA", {
        patch: [{ op: "replace", path: "/n1/report/status", value: "open" }],
      }),
      event("STATE_DELTA", {
        patch: [{ op: "replace", path: "/n2/report/status", value: "closed" }],
      }),
      event("RUN_FINISHED", { planId: "plan-7" }),
    ];
    const bytes = new TextEncoder().encode(frames.map(encodeComposeEvent).join(""));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "text/event-stream" : null,
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        json: async () => ({}),
      })),
    );

    const view = renderWorkspace({}, { stream: true });
    askWorkspace();
    // Both deltas landed…
    await waitFor(() => expect(screen.getByText("closed")).toBeTruthy());
    expect(screen.getByText("open")).toBeTruthy();
    // …and the order is still the snapshot's, with the grips live because the
    // finished run delivered a planId.
    expect(renderedOrder(view.container)).toEqual(["n1", "n2"]);
    expect(screen.getByLabelText("Move panel 1 of 2")).toBeTruthy();
  });

  it("a failed write keeps the local order and says the arrangement won't be saved", async () => {
    const routes = stubFetchByRoute({
      "/api/compose": {
        payload: {
          ok: true,
          planId: "plan-7",
          messages: panelsFixture(["n1", "n2"], { n1: "open", n2: "closed" }),
        },
      },
      "/api/refine": {
        ok: false,
        payload: {
          ok: false,
          error: 'No recently composed plan "plan-7" for catalog "support-assist" to refine.',
        },
      },
    });
    const view = renderWorkspace();
    askWorkspace();
    await waitFor(() => expect(renderedOrder(view.container)).toEqual(["n1", "n2"]));

    fireEvent.keyDown(screen.getByLabelText("Move panel 1 of 2"), {
      key: "ArrowDown",
    });
    await waitFor(() => expect(routes.refineCalls()).toHaveLength(1), {
      timeout: 2_000,
    });
    // The failure is reported as what it is — a lost save, not a broken view —
    // and the panels stay exactly where the visitor put them.
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /This arrangement won't be saved/,
      ),
    );
    expect(renderedOrder(view.container)).toEqual(["n2", "n1"]);
  });

  it("rapid moves coalesce into one write carrying the final order", async () => {
    const routes = stubFetchByRoute({
      "/api/compose": {
        payload: {
          ok: true,
          planId: "plan-7",
          messages: panelsFixture(["n1", "n2", "n3"], {
            n1: "one",
            n2: "two",
            n3: "three",
          }),
        },
      },
      "/api/refine": {
        payload: {
          ok: true,
          planId: "plan-8",
          messages: panelsFixture(["n2", "n3", "n1"], {
            n1: "one",
            n2: "two",
            n3: "three",
          }),
        },
      },
    });
    const view = renderWorkspace();
    askWorkspace();
    await waitFor(() =>
      expect(renderedOrder(view.container)).toEqual(["n1", "n2", "n3"]),
    );

    // Arrow n1 to the bottom, one slot at a time — two moves, well inside the
    // debounce window.
    fireEvent.keyDown(screen.getByLabelText("Move panel 1 of 3"), {
      key: "ArrowDown",
    });
    expect(renderedOrder(view.container)).toEqual(["n2", "n1", "n3"]);
    fireEvent.keyDown(screen.getByLabelText("Move panel 2 of 3"), {
      key: "ArrowDown",
    });
    expect(renderedOrder(view.container)).toEqual(["n2", "n3", "n1"]);

    await waitFor(() => expect(routes.refineCalls()).toHaveLength(1), {
      timeout: 2_000,
    });
    expect(routes.refineCalls()[0].body.operations).toEqual([
      { kind: "reorderNodes", nodeIds: ["n2", "n3", "n1"] },
    ]);
    // And no second write follows: the moves were one arrangement, not two.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(routes.refineCalls()).toHaveLength(1);
  });

  it("a host Column override keeps the previous render path, with no grips", async () => {
    // A host may register its own Column, which the provider deliberately
    // lets override the primitive. `SurfacePanels` must then honour it —
    // render through it, previous per-panel-surface path, no grips — rather
    // than silently bypassing the host's layout to make panels draggable.
    const hostColumn = {
      // Only `implementation` matters client-side (the provider builds the
      // A2UI catalog from it); the definition is borrowed to satisfy the type.
      definition: registered.definition,
      implementation: createBinderlessComponentImplementation(
        { name: "Column", schema: z.any() },
        () => <div data-testid="host-column" />,
      ),
    } as RegisteredHostComponent;

    stubFetchByRoute({
      "/api/compose": {
        payload: {
          ok: true,
          planId: "plan-7",
          messages: panelsFixture(["n1", "n2"], { n1: "open", n2: "closed" }),
        },
      },
    });
    renderWorkspace({}, { components: [registered, hostColumn] });
    askWorkspace();
    // The override renders (twice — once per panel surface, the previous
    // path), the pins stay, and no grip is offered anywhere.
    await waitFor(() => expect(screen.getAllByTestId("host-column")).toHaveLength(2));
    expect(screen.getAllByLabelText("Pin this panel")).toHaveLength(2);
    expect(screen.queryAllByLabelText(/Move panel/)).toHaveLength(0);
  });

  it("rearrange={false} renders no grips", async () => {
    stubFetchByRoute({
      "/api/compose": {
        payload: {
          ok: true,
          planId: "plan-7",
          messages: panelsFixture(["n1", "n2"], { n1: "open", n2: "closed" }),
        },
      },
    });
    const view = renderWorkspace({ rearrange: false });
    askWorkspace();
    await waitFor(() => expect(renderedOrder(view.container)).toEqual(["n1", "n2"]));
    // The pins remain — the gate removes rearranging, not the panel split.
    expect(screen.getAllByLabelText("Pin this panel")).toHaveLength(2);
    expect(screen.queryAllByLabelText(/Move panel/)).toHaveLength(0);
  });

  it("names each grip accessibly and announces a move politely", async () => {
    stubFetchByRoute({
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
          messages: panelsFixture(["n2", "n1"], { n1: "open", n2: "closed" }),
        },
      },
    });
    const view = renderWorkspace();
    askWorkspace();
    await waitFor(() => expect(renderedOrder(view.container)).toEqual(["n1", "n2"]));

    // Every grip carries its position in its accessible name.
    expect(screen.getByLabelText("Move panel 1 of 2")).toBeTruthy();
    expect(screen.getByLabelText("Move panel 2 of 2")).toBeTruthy();

    fireEvent.keyDown(screen.getByLabelText("Move panel 1 of 2"), {
      key: "ArrowDown",
    });
    // The announcement lives in a polite live region, so a screen reader
    // hears where the panel went without focus ever leaving the grip.
    const liveRegion = view.container.querySelector("[aria-live='polite']");
    expect(liveRegion?.textContent).toBe("Moved to position 2 of 2");

    await waitFor(
      () => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1),
      { timeout: 2_000 },
    );
  });

  it("styles the panel controls in host mode from the stylesheet, not inline", async () => {
    stubFetchByRoute({
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
          messages: panelsFixture(["n2", "n1"], { n1: "open", n2: "closed" }),
        },
      },
    });
    const view = renderWorkspace();
    askWorkspace();
    await waitFor(() => expect(renderedOrder(view.container)).toEqual(["n1", "n2"]));

    // This test used to assert the opposite: that the grip carried
    // `cursor: grab` and `touch-action: none` as *inline* styles, because host
    // mode injected no stylesheet and the chrome shipped a duplicate inline
    // table to compensate. Host mode now gets the real stylesheet, so those
    // rules live where every other rule lives and inline styles are reserved
    // for values a stylesheet cannot know.
    const grip = screen.getByLabelText("Move panel 1 of 2");
    expect(grip.style.cursor).toBe("");
    expect(grip.getAttribute("class")).toContain("renderyes-grip");
    const controls = grip.parentElement as HTMLElement;
    expect(controls.style.position).toBe("");
    expect(controls.getAttribute("class")).toContain("renderyes-panel-controls");

    // The class the rules are namespaced under has to be present, or none of
    // them match. jsdom applies no CSS, so this is the reachable half of the
    // claim; `chrome-css.test.mjs` covers the rules themselves.
    const scope = view.container.querySelector(".renderyes-scope");
    expect(scope).toBeTruthy();
    expect(scope?.contains(grip)).toBe(true);
    // And the stylesheet really is in the document in host mode.
    expect(
      document.head.querySelector('style[data-renderyes="chrome"]'),
    ).toBeTruthy();
  });
});
