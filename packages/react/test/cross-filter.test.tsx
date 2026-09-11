import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineProps, field } from "@renderyes/site-sdk";
import { defineHostComponent } from "../src/define-host-component.js";
import { ViewProvider } from "../src/provider.js";
import { useViewCompose } from "../src/use-compose.js";
import { ViewSurface } from "../src/surface.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The cross-filter seam, end to end on the client: the `__renderyes`
 * envelope's request summaries and node bindings surface through
 * `useViewCompose`, and a host gesture in one panel aims the already-shipped
 * `refine` at the request behind ANOTHER panel — with a literal value, so the
 * plan never references another request and the trust model never comes up.
 *
 * The scenario is a newspaper's: a sections panel and an articles panel; click
 * a section, the articles request gets a `setFilter`. The fixture mirrors the
 * server's real envelope shape (requests + nodes with verbatim plan
 * bindings), so drift between this and `compilePlanDataSurfaceMessages`
 * surfaces as this test breaking.
 */

function Sections({ items }: { items?: Array<{ title?: string }> }) {
  const { requests, nodeBindings, refine } = useViewCompose();
  return (
    <div>
      {(items ?? []).map((row, index) => (
        <button
          key={index}
          data-testid={`section-${index}`}
          onClick={() => {
            // Host policy: aim at the panel rendering Articles. The join is
            // nodeBindings (which request feeds which node); capabilityId on
            // the summaries is the other valid route.
            const articlesNode = nodeBindings.find(
              (node) => node.componentId === "Articles",
            );
            const target = articlesNode?.bindings.items?.requestId;
            if (!target) return;
            void refine([
              {
                kind: "setFilter",
                requestId: target,
                filter: {
                  combine: "all",
                  conditions: [
                    {
                      field: "categories.title",
                      operator: "eq",
                      value: String(row.title),
                    },
                  ],
                },
              },
            ]);
          }}
        >
          {row.title}
        </button>
      ))}
      <div data-testid="request-states">
        {requests.map((request) => `${request.requestId}:${request.state}`).join(" ")}
      </div>
    </div>
  );
}

function Articles({ items }: { items?: Array<{ title?: string }> }) {
  return <div data-testid="articles">{(items ?? []).map((row) => row.title).join("|")}</div>;
}

const sections = defineHostComponent({
  id: "Sections",
  description: "Section list.",
  dataSlots: { items: { accepts: [{ shape: "collection" }] } },
  props: defineProps({ heading: field.string() }),
  component: Sections,
});

const articles = defineHostComponent({
  id: "Articles",
  description: "Article list.",
  dataSlots: { items: { accepts: [{ shape: "collection" }] } },
  props: defineProps({ heading: field.string() }),
  component: Articles,
});

function viewMessages(articleTitles: string[]) {
  return [
    { version: "v0.9", createSurface: { surfaceId: "main", catalogId: "paper:ui" } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "main",
        components: [
          { id: "root", component: "Column", children: ["n1", "n2"] },
          { id: "n1", component: "Sections", heading: "Sections", items: { path: "/n1/items" } },
          { id: "n2", component: "Articles", heading: "Articles", items: { path: "/n2/items" } },
        ],
      },
    },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: "main",
        path: "/",
        value: {
          __renderyes: {
            planId: "plan-1",
            requests: [
              { requestId: "r1", capabilityId: "paper.sections.list", state: "ready" },
              { requestId: "r2", capabilityId: "paper.articles.list", state: "ready" },
            ],
            compositions: [],
            joins: [],
            nodes: [
              { nodeId: "n1", componentId: "Sections", bindings: { items: { requestId: "r1" } } },
              { nodeId: "n2", componentId: "Articles", bindings: { items: { requestId: "r2" } } },
            ],
          },
          n1: { items: [{ title: "Politics" }, { title: "Sport" }] },
          n2: { items: articleTitles.map((title) => ({ title })) },
        },
      },
    },
  ];
}

function Harness() {
  const { submit, prompt, setPrompt, messages } = useViewCompose();
  return (
    <div>
      <input data-testid="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <button data-testid="go" onClick={() => void submit()}>Go</button>
      <ViewSurface messages={messages} />
    </div>
  );
}

describe("cross-panel filtering through the envelope", () => {
  it("a click in one panel aims refine at the other panel's request", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const target = String(url);
        calls.push({ url: target, body: JSON.parse(String(init.body)) });
        return {
          ok: true,
          status: 200,
          json: async () =>
            target.includes("/api/refine")
              ? { ok: true, planId: "plan-2", messages: viewMessages(["Cup final"]) }
              : { ok: true, planId: "plan-1", messages: viewMessages(["Budget passes", "Cup final"]) },
        };
      }),
    );

    render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "paper",
          components: [sections, articles],
          renderMode: "host",
          composeTimeoutMs: 50,
        }}
      >
        <Harness />
      </ViewProvider>,
    );

    fireEvent.change(screen.getByTestId("prompt"), { target: { value: "sections and articles" } });
    fireEvent.click(screen.getByTestId("go"));
    await waitFor(() =>
      expect(screen.getByTestId("articles").textContent).toBe("Budget passes|Cup final"),
    );

    // The envelope surfaced through the hook.
    expect(screen.getByTestId("request-states").textContent).toBe("r1:ready r2:ready");

    // The gesture: click "Sport" in the sections panel.
    fireEvent.click(screen.getByTestId("section-1"));
    await waitFor(() =>
      expect(screen.getByTestId("articles").textContent).toBe("Cup final"),
    );

    // It was a refine aimed at the OTHER panel's request, with a literal —
    // never a compose, never a cross-request reference.
    const refines = calls.filter((call) => call.url.includes("/api/refine"));
    expect(refines).toHaveLength(1);
    const operation = (refines[0]!.body.operations as Record<string, unknown>[])[0]!;
    expect(operation.kind).toBe("setFilter");
    expect(operation.requestId).toBe("r2");
    expect(JSON.stringify(operation.filter)).toContain('"value":"Sport"');
    expect(calls.filter((call) => call.url.includes("/api/compose"))).toHaveLength(1);
  });
});
