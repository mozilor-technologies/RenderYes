import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineProps, field } from "@renderyes/site-sdk";
import { defineHostComponent } from "../src/define-host-component.js";
import { ViewProvider } from "../src/provider.js";
import { ViewPage } from "../src/page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * What a view was built from, shown so the visitor can correct it, and a
 * missing-input question answered without a model. The service derives both;
 * these pin what the browser does with them: the summary renders the values
 * and the not-found words, an edit sends one `setInput` refinement, and a
 * field question's chip answers the held plan through `/api/refine`.
 */

function LawList({ laws }: { laws?: Array<{ name?: string }> }) {
  return <div data-testid="laws">{(laws ?? []).map((row) => row.name).join("|")}</div>;
}

const registered = defineHostComponent({
  id: "LawList",
  description: "Laws.",
  dataSlots: { laws: { accepts: [{ shape: "collection" }] } },
  props: defineProps({ heading: field.string() }),
  component: LawList,
});

const REGIONS = ["Germany", "France", "California", "Utah"];

function regionsEntry(values: string[], notFound: string[]) {
  return {
    requestId: "r1",
    capabilityId: "laws.list",
    kind: "filter",
    name: "regions",
    label: "Visitors from",
    multiple: true,
    required: false,
    values,
    notFound,
    options: REGIONS,
    editable: true,
  };
}

function viewPayload(planId: string, names: string[], understood: unknown[]) {
  return {
    ok: true,
    planId,
    requests: [{ requestId: "r1", capabilityId: "laws.list", ok: true, state: "ready" }],
    understood,
    messages: [
      { version: "v0.9", createSurface: { surfaceId: "main", catalogId: "consent:ui" } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "main",
          components: [
            { id: "root", component: "Column", children: ["n1"] },
            { id: "n1", component: "LawList", heading: "Laws", laws: { path: "/n1/laws" } },
          ],
        },
      },
      {
        version: "v0.9",
        updateDataModel: {
          surfaceId: "main",
          path: "/",
          value: {
            n1: { laws: names.map((name) => ({ name })) },
            __renderyes: {
              planId,
              requests: [{ requestId: "r1", capabilityId: "laws.list", state: "ready" }],
              nodes: [],
              understood,
            },
          },
        },
      },
    ],
  };
}

function stubFetch(...payloads: unknown[]) {
  const queue = [...payloads];
  const impl = vi.fn(async (_url: string, _init?: RequestInit) => {
    const payload = queue.shift() as { ok?: boolean };
    return {
      ok: payload?.ok !== false,
      status: payload?.ok === false ? 400 : 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => payload,
    };
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function Harness() {
  return (
    <ViewProvider
      config={{
        serviceUrl: "https://consent.example",
        catalogId: "consent",
        components: [registered],
        renderMode: "host",
      }}
    >
      <ViewPage />
    </ViewProvider>
  );
}

function ask(text: string) {
  fireEvent.change(screen.getByLabelText("Describe what you want"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
}

const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

describe("what the view is based on", () => {
  it("shows the values in effect and the words that matched nothing", async () => {
    stubFetch(viewPayload("plan-1", ["GDPR", "CCPA"], [regionsEntry(["Germany", "California"], ["Texas"])]));
    render(<Harness />);
    ask("customers in Germany, California and Texas");

    const summary = await screen.findByRole("region", { name: "What this view is based on" });
    expect(summary.textContent).toContain("Visitors from:");
    expect(summary.textContent).toContain("Germany");
    expect(summary.textContent).toContain("California");
    expect(screen.getByText("Not found: Texas")).toBeTruthy();
  });

  it("an edit sends one setInput refinement with the complete new value list", async () => {
    const fetch = stubFetch(
      viewPayload("plan-1", ["GDPR"], [regionsEntry(["Germany"], ["Texas"])]),
      viewPayload("plan-2", ["GDPR", "UCPA"], [regionsEntry(["Germany", "Utah"], ["Texas"])]),
    );
    render(<Harness />);
    ask("customers in Germany and Texas");
    const add = await screen.findByLabelText("Add to Visitors from");
    fireEvent.change(add, { target: { value: "Utah" } });

    await waitFor(() => expect(screen.getByTestId("laws").textContent).toBe("GDPR|UCPA"));
    const [url] = fetch.mock.calls[1] as [string];
    expect(url).toBe("https://consent.example/api/refine");
    expect(bodyOf(fetch.mock.calls[1])).toMatchObject({
      planId: "plan-1",
      operations: [
        { kind: "setInput", requestId: "r1", input: "filter", name: "regions", values: ["Germany", "Utah"] },
      ],
    });
    // Not-found words are shown, never offered as a choice.
    expect(screen.queryByRole("option", { name: "Texas" })).toBeNull();
  });

  it("removing a value sends the list without it", async () => {
    const fetch = stubFetch(
      viewPayload("plan-1", ["GDPR", "CCPA"], [regionsEntry(["Germany", "California"], [])]),
      viewPayload("plan-2", ["GDPR"], [regionsEntry(["Germany"], [])]),
    );
    render(<Harness />);
    ask("Germany and California");
    fireEvent.click(await screen.findByRole("button", { name: "Remove California" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetch.mock.calls[1]).operations[0].values).toEqual(["Germany"]);
  });
});

describe("a question for one missing input", () => {
  const asked = {
    ok: false,
    kind: "needs-clarification",
    reason: "Which platform?",
    question: "Which platform?",
    options: ["shopify", "html"],
    input: {
      planId: "plan-held",
      requestId: "r1",
      capabilityId: "install.guide",
      kind: "param",
      name: "platform",
      label: "Platform",
      options: ["shopify", "html"],
    },
    issues: [],
  };

  it("is answered by a setInput against the held plan, with no second compose", async () => {
    const fetch = stubFetch(asked, viewPayload("plan-answered", ["Shopify guide"], []));
    render(<Harness />);
    ask("how do I install it?");
    fireEvent.click(await screen.findByRole("button", { name: "shopify" }));

    await waitFor(() => expect(screen.getByTestId("laws").textContent).toBe("Shopify guide"));
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url] = fetch.mock.calls[1] as [string];
    expect(url).toBe("https://consent.example/api/refine");
    expect(bodyOf(fetch.mock.calls[1])).toMatchObject({
      planId: "plan-held",
      operations: [
        { kind: "setInput", requestId: "r1", input: "param", name: "platform", values: ["shopify"] },
      ],
    });
    expect(screen.queryByText("Which platform?")).toBeNull();
  });

  it("stays on screen when the answer is refused, so the visitor can pick again", async () => {
    stubFetch(asked, { ok: false, kind: "invalid", reason: "That value is not listed.", issues: [] });
    render(<Harness />);
    ask("how do I install it?");
    fireEvent.click(await screen.findByRole("button", { name: "html" }));
    await waitFor(() => expect(screen.getByText("Which platform?")).toBeTruthy());
    expect(screen.getByRole("button", { name: "shopify" })).toBeTruthy();
  });
});
