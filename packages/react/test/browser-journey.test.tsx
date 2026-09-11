import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState, type ReactNode } from "react";
import { defineProps, field } from "@renderyes/site-sdk";
import { defineHostComponent } from "../src/define-host-component.js";
import { ViewProvider } from "../src/provider.js";
import { ViewWorkspace } from "../src/workspace.js";
import { RenderBoundary } from "../src/isolated-view.js";
import { ViewLauncher } from "../src/launcher.js";
import { ViewSurface } from "../src/surface.js";
import { ViewNotices, ViewPrompt, ViewSavedBar, ViewSavedControls, ViewSuggestions } from "../src/parts.js";
import { ViewPage, ViewResult } from "../src/page.js";
import { useViewCompose } from "../src/use-compose.js";

/**
 * These tests exist because the defects they cover are invisible to everything
 * else we run. The repeat-composition crash shipped past a green typecheck and
 * ~90 server-side tests: nothing mounted a component, so nothing could see it.
 * Every case below is a failure that has actually happened, or one the type
 * system structurally cannot catch.
 */

function TicketCard({ report }: { report?: { status?: string } }) {
  return <div data-testid="ticket-card">{report?.status ?? "no status"}</div>;
}

const registered = defineHostComponent({
  id: "TicketCard",
  description: "Shows one report.",
  dataSlots: {
    report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
  },
  props: defineProps({ title: field.string() }),
  component: TicketCard,
});

const UI_CATALOG_ID = "support-assist:ui";

/**
 * Mirrors the shape `composeAgainstPublishedCatalogs` actually returns —
 * captured from a real response rather than invented, so a drift between this
 * fixture and the server would show up as these tests passing while the real
 * thing breaks. The server's own tests cover the real shape end to end.
 */
function composeMessages(status: string) {
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
          { id: "root", component: "Column", children: ["n1"] },
          {
            id: "n1",
            component: "TicketCard",
            title: "Report",
            report: { path: "/n1/report" },
          },
        ],
      },
    },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: "main",
        path: "/",
        value: { n1: { report: { status } } },
      },
    },
  ];
}

/**
 * Routes by URL so a test can prove a refine never reached `/api/compose`.
 * Counting total fetches would not distinguish "refined" from "recomposed",
 * which is the entire claim direct manipulation makes.
 */
function stubFetchByRoute(routes: {
  compose?: { payload: unknown; ok?: boolean };
  refine?: { payload: unknown; ok?: boolean };
}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const target = String(url);
    const which = target.includes("/api/refine") ? "refine" : "compose";
    calls.push({ url: target, body: JSON.parse(String(init.body)) });
    const route = routes[which];
    if (!route) throw new Error(`unexpected call to ${target}`);
    return {
      ok: route.ok ?? true,
      status: route.ok === false ? 400 : 200,
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

function stubFetchOnce(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  const impl = vi.fn(async () => ({
    ok: init.ok ?? true,
    // The status is explicit rather than derived, because 400 and 401 are the
    // two the client now tells apart and a helper that can only produce one of
    // them cannot test the distinction.
    status: init.status ?? (init.ok === false ? 400 : 200),
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", impl);
  return impl;
}

function Harness({
  renderMode = "host",
  getAuthHeaders,
  onRender,
}: {
  renderMode?: "isolated" | "host";
  getAuthHeaders?: () => Record<string, string>;
  onRender?: () => void;
}) {
  return (
    <ViewProvider
      config={{
        serviceUrl: "https://intent.example",
        catalogId: "support-assist",
        components: [registered],
        renderMode,
        composeTimeoutMs: 50,
        ...(getAuthHeaders ? { getAuthHeaders } : {}),
      }}
    >
      <Composer onRender={onRender} />
    </ViewProvider>
  );
}

function Composer({ onRender }: { onRender?: () => void }) {
  const {
    prompt,
    setPrompt,
    submit,
    refine,
    messages,
    error,
    errorKind,
    busy,
    clarification,
    answerClarification,
  } = useViewCompose();
  onRender?.();
  return (
    <div>
      <button
        data-testid="sort"
        onClick={() =>
          void refine([
            {
              kind: "setSort",
              requestId: "r1",
              sort: [{ field: "status", direction: "asc" }],
            },
          ])
        }
      >
        Sort
      </button>
      <button data-testid="revise" onClick={() => void submit({ revise: true })}>
        Revise
      </button>
      {/* A real input rather than setting state inside the click handler:
          `setPrompt` schedules a render, so a same-tick `submit()` would read
          the previous (empty) prompt and fail its own length check. */}
      <input
        data-testid="prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <button data-testid="go" onClick={() => void submit()}>
        Go
      </button>
      <div data-testid="busy">{busy ? "busy" : "idle"}</div>
      {error ? <div data-testid="error">{error}</div> : null}
      {errorKind ? <div data-testid="error-kind">{errorKind}</div> : null}
      {clarification ? (
        <div data-testid="question">
          {clarification.question}
          {(clarification.options ?? []).map((option) => (
            <button
              key={option}
              data-testid={`answer-${option}`}
              onClick={() => void answerClarification(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <ViewSurface messages={messages} />
    </div>
  );
}

/** Types a prompt and submits, the way a visitor would. */
function ask(
  view: { getByTestId: (id: string) => HTMLElement },
  text = "show me open reports",
) {
  fireEvent.change(view.getByTestId("prompt"), { target: { value: text } });
  fireEvent.click(view.getByTestId("go"));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // A save writes the view's id into the URL, which is the point of it — and in
  // jsdom that URL outlives the test, so the next mount reopens a view it never
  // saved. Real behaviour, wrong scope.
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("compose journey", () => {
  it("renders a composed view, then survives a second submission", async () => {
    // The exact defect that shipped: the second response's `createSurface`
    // hit a processor that already had that surface, throwing
    // "Surface main already exists" and crashing the whole tree.
    stubFetchOnce({ ok: true, messages: composeMessages("open") });
    const view = render(<Harness />);

    ask(view);
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());
    expect(screen.getByTestId("ticket-card").textContent).toBe("open");

    stubFetchOnce({ ok: true, messages: composeMessages("closed") });
    ask(view);
    await waitFor(() =>
      expect(screen.getByTestId("ticket-card").textContent).toBe("closed"),
    );
  });

  it("does not re-render unboundedly when messages is a fresh array each render", async () => {
    // A host writing `<ViewSurface messages={[...x]} />` used to drive
    // setState -> re-render -> new reference -> setState forever.
    function UnstableParent() {
      const [tick, setTick] = useState(0);
      useEffect(() => {
        if (tick < 3) setTick(tick + 1);
      }, [tick]);
      return <ViewSurface messages={[...composeMessages("open")] as never} />;
    }
    let renders = 0;
    function Counting() {
      renders += 1;
      return <UnstableParent />;
    }
    render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [registered],
          renderMode: "host",
        }}
      >
        <Counting />
      </ViewProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());
    expect(renders).toBeLessThan(20);
  });

  it("renders into the host DOM in host mode and a shadow root in isolated mode", async () => {
    stubFetchOnce({ ok: true, messages: composeMessages("open") });
    const host = render(<Harness renderMode="host" />);
    ask(host);
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());
    // Reachable from the document means no shadow boundary in between.
    expect(host.container.querySelector("[data-testid='ticket-card']")).toBeTruthy();
    cleanup();

    stubFetchOnce({ ok: true, messages: composeMessages("open") });
    const isolated = render(<Harness renderMode="isolated" />);
    ask(isolated);
    const isolationHost = await waitFor(() => {
      const node = isolated.container.querySelector(
        "[data-testid='renderyes-isolation-host']",
      );
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    await waitFor(() => expect(isolationHost.shadowRoot).not.toBeNull());
    // Rendered through a portal into the shadow root, so a light-DOM query
    // cannot reach it — which is exactly the isolation being asserted.
    expect(isolated.container.querySelector("[data-testid='ticket-card']")).toBeNull();
    expect(
      isolationHost.shadowRoot?.querySelector("[data-testid='ticket-card']"),
    ).toBeTruthy();
  });

  it("sends the host's auth headers with the compose request", async () => {
    // A silent regression here means every compose 401s in production while
    // every existing test still passes.
    const impl = stubFetchOnce({ ok: true, messages: composeMessages("open") });
    const view = render(
      <Harness getAuthHeaders={() => ({ authorization: "Bearer test-token" })} />,
    );
    ask(view);
    await waitFor(() => expect(impl).toHaveBeenCalled());
    const [, init] = impl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer test-token",
    );
  });

  it("shows the timeout message when the service never responds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );
    const view = render(<Harness />);
    ask(view);
    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toMatch(
        /taking longer than expected/i,
      ),
    );
    // The submit control must come back, not stay stuck spinning.
    expect(screen.getByTestId("busy").textContent).toBe("idle");
  });

  it("surfaces a server-reported failure instead of rendering an empty view", async () => {
    stubFetchOnce(
      { ok: false, kind: "unsupported", reason: "No capability can answer that." },
      { ok: false },
    );
    const view = render(<Harness />);
    ask(view);
    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toBe(
        "No capability can answer that.",
      ),
    );
    expect(screen.queryByTestId("ticket-card")).toBeNull();
  });

  it("keeps the current view when a later compose fails", async () => {
    // The failure path used to clear `messages`, so a visitor lost a working
    // view as a side effect of asking for something else. Nothing about the
    // second prompt failing makes the first answer wrong.
    stubFetchOnce({ ok: true, messages: composeMessages("open") });
    const view = render(<Harness />);
    ask(view);
    await waitFor(() =>
      expect(screen.getByTestId("ticket-card").textContent).toBe("open"),
    );

    stubFetchOnce(
      {
        ok: false,
        kind: "invalid",
        reason: "/surfaces/0/nodes/0: must be equal to constant",
      },
      { ok: false },
    );
    ask(view, "something the catalog cannot do");
    await waitFor(() => expect(screen.getByTestId("error")).toBeTruthy());

    expect(screen.getByTestId("ticket-card").textContent).toBe("open");
  });

  it("never shows validator internals to a visitor", async () => {
    // AJV output names catalog paths and schema constraints. It is written for
    // whoever authored the catalog, and it leaks that structure to anyone who
    // can type a prompt.
    stubFetchOnce(
      {
        ok: false,
        kind: "invalid",
        reason:
          "/surfaces/0/nodes/0/componentId: must be equal to constant; /dataRequests: must NOT have fewer than 1 items",
        issues: [{ path: "/surfaces/0/nodes/0", message: "must be equal to constant" }],
      },
      { ok: false },
    );
    const view = render(<Harness />);
    ask(view);
    await waitFor(() => expect(screen.getByTestId("error")).toBeTruthy());

    const shown = screen.getByTestId("error").textContent ?? "";
    expect(shown).not.toMatch(/surfaces/);
    expect(shown).not.toMatch(/must be equal to constant/);
    expect(shown).toBe("Couldn't build that view. Rephrasing the question often works — or try one of the suggestions.");
  });

  it("distinguishes an unsupported prompt from a service failure", async () => {
    stubFetchOnce(
      { ok: false, kind: "unsupported", reason: "This site has no pricing data." },
      { ok: false },
    );
    const first = render(<Harness />);
    ask(first);
    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toBe(
        "This site has no pricing data.",
      ),
    );
    cleanup();

    stubFetchOnce(
      { ok: false, kind: "provider-error", reason: "upstream exploded" },
      { ok: false },
    );
    const second = render(<Harness />);
    ask(second);
    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toBe(
        "Couldn't build that view — please try again.",
      ),
    );
  });

  it("names a rejected credential instead of telling the visitor to retry", async () => {
    // A 401 carries no `kind` — it comes from the transport layer, above the
    // planner — so reading the body alone classified it as `network` and told
    // whoever's session had expired to try again, forever.
    stubFetchOnce({ ok: false, error: "Not authenticated." }, { ok: false, status: 401 });
    const view = render(<Harness />);
    ask(view);
    await waitFor(() => expect(screen.getByTestId("error-kind").textContent).toBe("auth"));
    const shown = screen.getByTestId("error").textContent ?? "";
    expect(shown).toMatch(/sign in/i);
    expect(shown).not.toMatch(/^Couldn't build that view/);
  });

  it("treats a forbidden request as auth, and a 400 as neither", async () => {
    stubFetchOnce({ ok: false, error: "Not permitted." }, { ok: false, status: 403 });
    const first = render(<Harness />);
    ask(first);
    await waitFor(() => expect(screen.getByTestId("error-kind").textContent).toBe("auth"));
    cleanup();

    // The boundary case: a plain rejected request must not become `auth` just
    // because it also lacks a `kind`. Nor `network` — this used to be one, and
    // a host whose `resolveSession` threw a plain `Error` got a 400 that told
    // the visitor the service was unreachable while it was answering fine.
    stubFetchOnce({ ok: false, error: "Unknown catalog." }, { ok: false, status: 400 });
    const second = render(<Harness />);
    ask(second);
    await waitFor(() =>
      expect(screen.getByTestId("error-kind").textContent).toBe("service-error"),
    );
    expect(screen.getByTestId("error").textContent ?? "").not.toMatch(/reachable/i);
    cleanup();

    // A faulting server keeps the outage copy: "try later" is right advice for
    // a 500, and wrong for a refusal.
    stubFetchOnce({ ok: false, error: "Boom." }, { ok: false, status: 503 });
    const third = render(<Harness />);
    ask(third);
    await waitFor(() =>
      expect(screen.getByTestId("error-kind").textContent).toBe("network"),
    );
  });

  /**
   * The clarification branch, from the visitor's side.
   *
   * The whole point is that this must not read as a failure. A question means
   * the catalog *can* answer and the planner declined to guess between two
   * answers — reporting that as "Couldn't build that view" would train people
   * to rephrase a prompt that was fine.
   */
  it("shows a question as a question, not as an error", async () => {
    stubFetchOnce(
      {
        ok: false,
        kind: "needs-clarification",
        reason: "Do you mean open reports, or reports you opened?",
        question: "Do you mean open reports, or reports you opened?",
        options: ["Open reports", "Reports I opened"],
      },
      { ok: false },
    );
    const view = render(<Harness />);
    ask(view);

    await waitFor(() => expect(screen.getByTestId("question")).toBeTruthy());
    expect(screen.getByTestId("error-kind").textContent).toBe("needs-clarification");
    // The visitor sees the question, not generic failure copy.
    expect(screen.getByTestId("error").textContent).toBe(
      "Do you mean open reports, or reports you opened?",
    );
  });

  it("sends the original prompt with the answer, and forbids a second question", async () => {
    stubFetchOnce(
      {
        ok: false,
        kind: "needs-clarification",
        reason: "Which ones?",
        question: "Which ones?",
        options: ["Open reports"],
      },
      { ok: false },
    );
    const view = render(<Harness />);
    ask(view, "show me reports");
    await waitFor(() => expect(screen.getByTestId("question")).toBeTruthy());

    const answered = stubFetchOnce({ ok: true, messages: composeMessages("open") });
    fireEvent.click(screen.getByTestId("answer-Open reports"));
    await waitFor(() =>
      expect(screen.getByTestId("ticket-card").textContent).toBe("open"),
    );

    const body = JSON.parse(String(answered.mock.calls[0]?.[1]?.body));
    // The answer alone is not a request: "Open reports" means nothing without
    // what it answers, so both travel.
    expect(body.prompt).toContain("show me reports");
    expect(body.prompt).toContain("Which ones?");
    expect(body.prompt).toContain("Open reports");
    // And the loop guard reaches the server, where it removes the branch from
    // the contract rather than merely discouraging a second question.
    expect(body.answersClarification).toBe(true);
    // The question is gone once answered.
    expect(screen.queryByTestId("question")).toBeNull();
  });

  it("answers what was asked even if the visitor retypes the box", async () => {
    stubFetchOnce(
      {
        ok: false,
        kind: "needs-clarification",
        reason: "Which ones?",
        question: "Which ones?",
        options: ["Open reports"],
      },
      { ok: false },
    );
    const view = render(<Harness />);
    ask(view, "show me reports");
    await waitFor(() => expect(screen.getByTestId("question")).toBeTruthy());

    // A question on screen does not disable the prompt box, and someone will
    // type in it. Answering must still compose what they originally asked.
    fireEvent.change(view.getByTestId("prompt"), {
      target: { value: "something else entirely" },
    });
    const answered = stubFetchOnce({ ok: true, messages: composeMessages("open") });
    fireEvent.click(screen.getByTestId("answer-Open reports"));
    await waitFor(() => expect(answered).toHaveBeenCalled());

    const body = JSON.parse(String(answered.mock.calls[0]?.[1]?.body));
    expect(body.prompt).toContain("show me reports");
    expect(body.prompt).not.toContain("something else entirely");
  });

  it("a kind with no question does not put an empty question on screen", async () => {
    // Defensive against a service that reports the kind and omits the field.
    stubFetchOnce(
      { ok: false, kind: "needs-clarification", reason: "ambiguous" },
      { ok: false },
    );
    const view = render(<Harness />);
    ask(view);
    await waitFor(() => expect(screen.getByTestId("error")).toBeTruthy());
    expect(screen.queryByTestId("question")).toBeNull();
  });

  it("caps a long unsupported reason before showing it", async () => {
    // "Visitor-safe by prompt design" is an expectation, not a guarantee —
    // this is model-generated text on its way to a screen.
    stubFetchOnce(
      { ok: false, kind: "unsupported", reason: "x".repeat(900) },
      { ok: false },
    );
    const view = render(<Harness />);
    ask(view);
    await waitFor(() => expect(screen.getByTestId("error")).toBeTruthy());
    expect((screen.getByTestId("error").textContent ?? "").length).toBeLessThanOrEqual(
      300,
    );
  });

  it("renders the fallback view a failed revision returns", async () => {
    // The planner has always built this fallback; the server used to discard
    // it, so the documented "a failed revision leaves you on what you had"
    // never actually happened.
    stubFetchOnce(
      {
        ok: false,
        kind: "invalid",
        reason: "could not apply that change",
        fellBack: true,
        planId: "plan-previous",
        messages: composeMessages("open"),
      },
      { ok: false },
    );
    const view = render(<Harness />);
    ask(view);

    await waitFor(() =>
      expect(screen.getByTestId("ticket-card").textContent).toBe("open"),
    );
    expect(screen.getByTestId("error").textContent).toBe(
      "Couldn't build that view. Rephrasing the question often works — or try one of the suggestions.",
    );
  });

  it("lets a host route the launcher button to its own page instead of the panel", async () => {
    const opened = vi.fn();
    render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [registered],
          renderMode: "host",
        }}
      >
        <ViewLauncher label="Ask" onOpen={opened} />
      </ViewProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(opened).toHaveBeenCalledTimes(1);
    // The built-in panel must stay closed — a host routing elsewhere would
    // otherwise get both its own page and an overlay.
    expect(screen.queryByPlaceholderText(/ask/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
  });

  it("contains a throwing host component instead of blanking the host page", async () => {
    // RenderYes renders inside someone else's site. Without a boundary, one
    // buggy registered component unmounts every tree above it — the site
    // owner's own product breaks because a visitor asked a question.
    function Exploding(): JSX.Element {
      throw new Error("component blew up");
    }
    const exploding = defineHostComponent({
      id: "TicketCard",
      description: "Throws on render.",
      dataSlots: {
        report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
      },
      props: defineProps({ title: field.string() }),
      component: Exploding,
    });
    // The boundary logs the stack for a host debugging its own component;
    // silence it so a deliberate throw does not look like a real failure.
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetchOnce({ ok: true, messages: composeMessages("open") });
    const view = render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [exploding],
          renderMode: "host",
        }}
      >
        <div data-testid="host-page">
          <Composer />
        </div>
      </ViewProvider>,
    );
    ask(view);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/component blew up/),
    );
    // The host's own DOM outlives the failure — that is the whole point.
    expect(screen.getByTestId("host-page")).toBeTruthy();
    expect(screen.getByTestId("go")).toBeTruthy();
    errorLog.mockRestore();
  });

  it("refines the view with zero model calls", async () => {
    // The claim direct manipulation makes: a sort or a remove is a
    // deterministic edit to an already-validated plan, so it costs no tokens
    // and never re-enters the planner. Asserting a total fetch count would not
    // show that — it has to be the *compose* route that stays untouched.
    const routes = stubFetchByRoute({
      compose: {
        payload: { ok: true, planId: "plan-1", messages: composeMessages("open") },
      },
      refine: {
        payload: { ok: true, planId: "plan-2", messages: composeMessages("closed") },
      },
    });
    const view = render(<Harness />);

    ask(view);
    await waitFor(() =>
      expect(screen.getByTestId("ticket-card").textContent).toBe("open"),
    );
    expect(routes.composeCalls()).toHaveLength(1);

    fireEvent.click(view.getByTestId("sort"));
    await waitFor(() =>
      expect(screen.getByTestId("ticket-card").textContent).toBe("closed"),
    );

    // One refine, and crucially still only the original compose.
    expect(routes.refineCalls()).toHaveLength(1);
    expect(routes.composeCalls()).toHaveLength(1);

    const refined = routes.refineCalls()[0]!.body;
    expect(refined.planId).toBe("plan-1");
    expect(refined.operations).toEqual([
      { kind: "setSort", requestId: "r1", sort: [{ field: "status", direction: "asc" }] },
    ]);
  });

  it("chains refinements from the latest plan, not the original", async () => {
    // A refinement returns a new planId. Refining twice from the first would
    // silently discard the first edit.
    const routes = stubFetchByRoute({
      compose: {
        payload: { ok: true, planId: "plan-1", messages: composeMessages("open") },
      },
      refine: {
        payload: { ok: true, planId: "plan-2", messages: composeMessages("closed") },
      },
    });
    const view = render(<Harness />);
    ask(view);
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());

    fireEvent.click(view.getByTestId("sort"));
    await waitFor(() => expect(routes.refineCalls()).toHaveLength(1));
    fireEvent.click(view.getByTestId("sort"));
    await waitFor(() => expect(routes.refineCalls()).toHaveLength(2));

    expect(routes.refineCalls()[0]!.body.planId).toBe("plan-1");
    expect(routes.refineCalls()[1]!.body.planId).toBe("plan-2");
  });

  it("keeps the view when a refinement is rejected", async () => {
    // A refusal here means the catalog never approved that field for querying.
    // The right response is to say the sort did not apply, not to remove the
    // table someone was reading.
    const routes = stubFetchByRoute({
      compose: {
        payload: { ok: true, planId: "plan-1", messages: composeMessages("open") },
      },
      refine: {
        ok: false,
        payload: {
          ok: false,
          kind: "invalid",
          reason: "dataRequests.0.query.sort.0.field: not an approved sort field",
        },
      },
    });
    const view = render(<Harness />);
    ask(view);
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());

    fireEvent.click(view.getByTestId("sort"));
    await waitFor(() => expect(screen.getByTestId("error")).toBeTruthy());

    expect(screen.getByTestId("ticket-card").textContent).toBe("open");
    // And the validator path never reaches the visitor.
    expect(screen.getByTestId("error").textContent).toBe(
      "Couldn't build that view. Rephrasing the question often works — or try one of the suggestions.",
    );
    expect(routes.composeCalls()).toHaveLength(1);
  });

  it("sends previousPlanId only when the caller asks for a revision", async () => {
    // Revision is opt-in because the two cases are indistinguishable from
    // inside the hook: "show my holdings" after "show my accounts" is usually a
    // new question, while "only the ones over 500" is a change to the current
    // view. The host knows which control was used.
    const routes = stubFetchByRoute({
      compose: {
        payload: { ok: true, planId: "plan-1", messages: composeMessages("open") },
      },
    });
    const view = render(<Harness />);

    ask(view);
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());
    expect(routes.composeCalls()[0]!.body.previousPlanId).toBeUndefined();

    fireEvent.click(view.getByTestId("revise"));
    await waitFor(() => expect(routes.composeCalls()).toHaveLength(2));
    expect(routes.composeCalls()[1]!.body.previousPlanId).toBe("plan-1");
  });

  it("lets a registered host component refine the view it is rendered inside", async () => {
    // The architectural point. A host's own component sits *inside* the
    // composed surface, so for its control to affect that surface it must
    // reach the same session the surface renders from. With per-call state it
    // would get a private copy and nothing would happen.
    const routes = stubFetchByRoute({
      compose: {
        payload: { ok: true, planId: "plan-1", messages: composeMessages("open") },
      },
      refine: {
        payload: { ok: true, planId: "plan-2", messages: composeMessages("closed") },
      },
    });

    function SortableCard({ report }: { report?: { status?: string } }) {
      const { refine } = useViewCompose();
      return (
        <div>
          <div data-testid="ticket-card">{report?.status ?? "no status"}</div>
          <button
            data-testid="inner-sort"
            onClick={() =>
              void refine([
                {
                  kind: "setSort",
                  requestId: "r1",
                  sort: [{ field: "status", direction: "desc" }],
                },
              ])
            }
          >
            Sort
          </button>
        </div>
      );
    }
    const sortable = defineHostComponent({
      id: "TicketCard",
      description: "A report card that can sort itself.",
      dataSlots: {
        report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
      },
      props: defineProps({ title: field.string() }),
      component: SortableCard,
    });

    const view = render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [sortable],
          renderMode: "host",
        }}
      >
        <Composer />
      </ViewProvider>,
    );
    ask(view);
    await waitFor(() =>
      expect(screen.getByTestId("ticket-card").textContent).toBe("open"),
    );

    // The control lives inside the rendered surface, not in the harness.
    fireEvent.click(screen.getByTestId("inner-sort"));
    await waitFor(() =>
      expect(screen.getByTestId("ticket-card").textContent).toBe("closed"),
    );
    expect(routes.refineCalls()).toHaveLength(1);
    expect(routes.composeCalls()).toHaveLength(1);
  });

  it("does not nest a second isolation boundary inside an existing one", async () => {
    // ViewLauncher/ViewWorkspace already wrap their panel in a boundary and
    // also render a ViewSurface. Two nested shadow roots would render, but the
    // outer stylesheet could not reach the inner content.
    stubFetchOnce({ ok: true, messages: composeMessages("open") });
    const view = render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [registered],
          renderMode: "isolated",
        }}
      >
        <RenderBoundary mode="isolated">
          <Composer />
        </RenderBoundary>
      </ViewProvider>,
    );
    const outer = view.container.querySelector(
      "[data-testid='renderyes-isolation-host']",
    ) as HTMLElement;
    expect(outer).toBeTruthy();
    fireEvent.change(
      outer.shadowRoot!.querySelector("[data-testid='prompt']") as HTMLInputElement,
      { target: { value: "show me open reports" } },
    );
    fireEvent.click(outer.shadowRoot!.querySelector("[data-testid='go']") as HTMLElement);
    await waitFor(() =>
      expect(outer.shadowRoot!.querySelector("[data-testid='ticket-card']")).toBeTruthy(),
    );
    // Exactly one boundary in the whole tree.
    expect(
      outer.shadowRoot!.querySelectorAll("[data-testid='renderyes-isolation-host']")
        .length,
    ).toBe(0);
  });
});

/**
 * Saved views: save the plan behind the current view, list them, replay one.
 *
 * All four existed on the server with no client method and no route, so a
 * visitor could compose a view and had no way to keep it. These tests pin the
 * two properties that matter at this boundary: only the `planId` crosses the
 * wire, and reopening replaces the view rather than appending to it.
 */
function stubFetchByPath(
  handlers: Record<string, { payload: unknown; ok?: boolean; status?: number }>,
) {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const target = String(url);
    const match = Object.keys(handlers)
      .sort((left, right) => right.length - left.length)
      .find((path) => target.includes(path));
    calls.push({
      url: target,
      method: String(init.method ?? "GET"),
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (!match) throw new Error(`unexpected call to ${target}`);
    const route = handlers[match];
    return {
      ok: route.ok ?? true,
      status: route.status ?? (route.ok === false ? 400 : 200),
      json: async () => route.payload,
    };
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

function SavedViewsHarness() {
  const { submit, setPrompt, prompt, save, listSaved, reopen, deleteSaved, startOver, messages, staleReason, error } =
    useViewCompose();
  const [listed, setListed] = useState<string>("");
  const [savedId, setSavedId] = useState<string>("");
  return (
    <div>
      <input
        data-testid="prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <button data-testid="go" onClick={() => void submit()}>Go</button>
      <button
        data-testid="save"
        onClick={() => void save("My view").then((r) => setSavedId(r.viewId ?? "none"))}
      >
        Save
      </button>
      <button
        data-testid="list"
        onClick={() => void listSaved().then((views) => setListed(views.length ? views.map((v) => v.id).join(",") : "empty"))}
      >
        List
      </button>
      <button
        data-testid="list-silent"
        onClick={() => void listSaved({ silent: true }).then((views) => setListed(views.length ? views.map((v) => v.id).join(",") : "empty"))}
      >
        List
      </button>
      <button data-testid="reopen" onClick={() => void reopen("view-1")}>Reopen</button>
      <button data-testid="start-over" onClick={() => startOver()}>Start over</button>
      <button data-testid="delete" onClick={() => void deleteSaved("view-1")}>Delete</button>
      <div data-testid="saved-id">{savedId}</div>
      <div data-testid="listed">{listed}</div>
      {staleReason ? <div data-testid="stale">{staleReason}</div> : null}
      {error ? <div data-testid="error">{error}</div> : null}
      <ViewSurface messages={messages} />
    </div>
  );
}

function renderSavedViews() {
  return render(
    <ViewProvider
      config={{
        serviceUrl: "https://intent.example",
        catalogId: "support-assist",
        components: [registered],
        renderMode: "host",
        composeTimeoutMs: 50,
      }}
    >
      <SavedViewsHarness />
    </ViewProvider>,
  );
}

describe("saved views", () => {
  it("saves the current view by planId alone, never the plan body", async () => {
    const calls = stubFetchByPath({
      "/api/compose": { payload: { ok: true, planId: "plan-7", messages: composeMessages("ready") } },
      "/api/views": { payload: { ok: true, viewId: "view-1" } },
    });
    const view = renderSavedViews();
    ask(view);
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());

    fireEvent.click(view.getByTestId("save"));
    await waitFor(() => expect(view.getByTestId("saved-id").textContent).toBe("view-1"));

    const saveCall = calls.find((call) => call.url.includes("/api/views"));
    expect(saveCall?.body).toEqual({
      catalogId: "support-assist",
      planId: "plan-7",
      label: "My view",
    });
    // The plan body must not cross the wire: the service saves the plan it
    // composed and owns, so a caller cannot store an arbitrary plan and have it
    // executed on reopen.
    expect(JSON.stringify(saveCall?.body)).not.toContain("surfaces");
  });

  /**
   * Saving worked and reopening worked; neither had an address, so a visitor
   * could keep a view and have no way back to it. `replaceState` rather than
   * `pushState`: saving is not navigation, and a Back button that undid a save
   * would be lying about what it does.
   */
  it("gives a saved view a URL, and drops it when the visitor starts over", async () => {
    stubFetchByPath({
      "/api/compose": { payload: { ok: true, planId: "plan-7", messages: composeMessages("ready") } },
      "/api/views": { payload: { ok: true, viewId: "view-1" } },
    });
    const view = renderSavedViews();
    ask(view);
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    expect(new URLSearchParams(window.location.search).get("iv")).toBeNull();

    fireEvent.click(view.getByTestId("save"));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("iv")).toBe("view-1"),
    );

    // Otherwise a reload silently reopens what they cleared, and a copied link
    // points at something other than what is on screen.
    fireEvent.click(view.getByTestId("start-over"));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("iv")).toBeNull(),
    );
  });

  /**
   * `reopenSavedView` reports `stale` and `staleReason` when a saved plan
   * replays against a catalog that has moved — and nothing rendered them, so a
   * visitor saw an older answer presented as current. Same class as an
   * undisclosed truncation, and routine now that bookmarks make reopening a
   * page-load path rather than a menu action.
   */
  it("a stale reopen says so instead of presenting an older answer as current", async () => {
    stubFetchByPath({
      "/api/views/reopen": {
        payload: {
          ok: true,
          planId: "plan-9",
          stale: true,
          staleReason: "component TicketQueue is no longer registered",
          messages: composeMessages("reopened"),
        },
      },
    });
    window.history.replaceState(null, "", "/?iv=view-42");

    const view = render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [registered],
          renderMode: "host",
          composeTimeoutMs: 50,
        }}
      >
        <ViewWorkspace />
      </ViewProvider>,
    );

    await waitFor(() => expect(view.getByText("reopened")).toBeTruthy());
    const badge = view.getByRole("status");
    expect(badge.textContent).toContain("the site has changed since it was saved");
    expect(badge.textContent).toContain("TicketQueue is no longer registered");
  });

  it("reopens the view named in the URL instead of showing an empty prompt", async () => {
    const calls = stubFetchByPath({
      "/api/views/reopen": {
        payload: { ok: true, planId: "plan-9", messages: composeMessages("reopened") },
      },
    });
    window.history.replaceState(null, "", "/?iv=view-42");

    const view = renderSavedViews();
    await waitFor(() => expect(view.getByText("reopened")).toBeTruthy());

    const reopenCall = calls.find((call) => call.url.includes("/api/views/reopen"));
    expect(reopenCall?.body).toEqual({ viewId: "view-42" });
    // Once. A second reopen would overwrite whatever the visitor composed after
    // landing.
    expect(calls.filter((call) => call.url.includes("/api/views/reopen"))).toHaveLength(1);
  });

  it("refuses to save when there is no view yet, instead of posting a null plan", async () => {
    const calls = stubFetchByPath({ "/api/views": { payload: { ok: true, viewId: "view-1" } } });
    const view = renderSavedViews();

    fireEvent.click(view.getByTestId("save"));
    // Says what actually went wrong. Routed through the compose failure path
    // this read "Couldn't build that view", which is nonsense when there is no
    // view to build.
    await waitFor(() =>
      expect(view.getByTestId("error").textContent).toMatch(/no view to save/i),
    );
    // And nothing was posted: a save with no plan is refused here, not by the
    // service rejecting a null planId.
    expect(calls).toHaveLength(0);
    expect(view.getByTestId("saved-id").textContent).toBe("none");
  });

  it("lists saved views and replays one, replacing the view on screen", async () => {
    stubFetchByPath({
      "/api/compose": { payload: { ok: true, planId: "plan-7", messages: composeMessages("ready") } },
      "/api/views/reopen": {
        payload: { ok: true, planId: "plan-9", messages: composeMessages("solved") },
      },
      "/api/views": {
        payload: {
          ok: true,
          views: [
            {
              id: "view-1",
              catalogId: "support-assist",
              surfaceId: "main",
              prompt: "show me open reports",
              createdAt: "2026-08-11T00:00:00.000Z",
              updatedAt: "2026-08-11T00:00:00.000Z",
              stale: false,
            },
          ],
        },
      },
    });
    const view = renderSavedViews();
    ask(view);
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());

    fireEvent.click(view.getByTestId("list"));
    await waitFor(() => expect(view.getByTestId("listed").textContent).toBe("view-1"));

    fireEvent.click(view.getByTestId("reopen"));
    // Replaced, not appended: a reopen is a different view, not more of this one.
    await waitFor(() => expect(view.getByText("solved")).toBeTruthy());
    expect(view.queryByText("ready")).toBeNull();
  });

  it("surfaces the drift reason when a replayed view no longer matches what is published", async () => {
    stubFetchByPath({
      "/api/views/reopen": {
        payload: {
          ok: true,
          planId: "plan-9",
          messages: composeMessages("solved"),
          stale: true,
          staleReason: "the host's component registrations have changed since this view was saved",
        },
      },
    });
    const view = renderSavedViews();

    fireEvent.click(view.getByTestId("reopen"));
    await waitFor(() => expect(view.getByText("solved")).toBeTruthy());
    // It rendered, so it is not an error — but it is not necessarily the view
    // that was saved, and silence here would present an older answer as current.
    expect(view.getByTestId("stale").textContent).toMatch(/registrations have changed/);
    expect(view.queryByTestId("error")).toBeNull();
  });

  it("an expired session on a saved-view call reads as auth, not as a delete bug", async () => {
    // These calls share one request helper that threw a plain Error, so the
    // status was formatted into a sentence and thrown away. "Couldn't delete
    // that view: Not authenticated." is a true sentence that points at the
    // wrong thing.
    stubFetchByPath({
      "/api/views/delete": {
        payload: { ok: false, error: "Not authenticated." },
        ok: false,
        status: 401,
      },
    });
    const view = renderSavedViews();

    fireEvent.click(view.getByTestId("delete"));
    await waitFor(() =>
      expect(view.getByTestId("error").textContent).toMatch(/sign in/i),
    );
  });

  it("reports a failed delete rather than silently doing nothing", async () => {
    stubFetchByPath({
      "/api/views/delete": { payload: { error: "No saved view \"view-1\"." }, ok: false },
    });
    const view = renderSavedViews();

    fireEvent.click(view.getByTestId("delete"));
    await waitFor(() => expect(view.getByTestId("error").textContent).toBeTruthy());
  });
});

  it("a prefetched list reports nothing on failure, but an explicit one does", async () => {
    stubFetchByPath({ "/api/views": { payload: { error: "Not found" }, ok: false } });
    const view = renderSavedViews();

    // The prefetch case: mounting a page whose service has no saved-view route
    // must not greet the visitor with a red error before they have acted.
    fireEvent.click(view.getByTestId("list-silent"));
    await waitFor(() => expect(view.getByTestId("listed").textContent).toBe("empty"));
    expect(view.queryByTestId("error")).toBeNull();

    // The same failure, asked for on purpose, is reported.
    fireEvent.click(view.getByTestId("list"));
    await waitFor(() =>
      expect(view.getByTestId("error").textContent).toMatch(/Couldn't load saved views/),
    );
  });
describe("revision affordance", () => {
  /**
   * The visitor-facing half of revision. Everything below it — the server's
   * `previousPlanId` path, `submit({revise:true})` — has existed and been
   * tested for weeks; nothing in any shipped UI reached it, so no visitor
   * could revise anything. These cover the control that closes that gap.
   */
  function LauncherHarness() {
    return (
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [registered],
          renderMode: "host",
        }}
      >
        <ViewLauncher label="Ask" />
      </ViewProvider>
    );
  }

  const open = () => fireEvent.click(screen.getByText("Ask"));
  const type = (text: string) =>
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });

  it("offers Go before a view exists and Refine once one does", async () => {
    const routes = stubFetchByRoute({
      compose: { payload: { ok: true, planId: "plan-1", messages: composeMessages("open") } },
    });
    render(<LauncherHarness />);
    open();

    expect(screen.getByText("Go")).toBeTruthy();
    expect(screen.queryByText("Start over")).toBeNull();

    type("show me open reports");
    fireEvent.click(screen.getByText("Go"));
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());

    // The compose bar is gone: with a view on screen, typing means changing it.
    expect(screen.queryByText("Go")).toBeNull();
    expect(screen.getByText("Refine")).toBeTruthy();
    expect(screen.getByText("Start over")).toBeTruthy();
    expect(routes.composeCalls()).toHaveLength(1);
  });

  it("a refine carries the current plan, so the prompt reads as a change", async () => {
    const routes = stubFetchByRoute({
      compose: { payload: { ok: true, planId: "plan-1", messages: composeMessages("open") } },
    });
    render(<LauncherHarness />);
    open();
    type("show me open reports");
    fireEvent.click(screen.getByText("Go"));
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());

    type("only the urgent ones");
    fireEvent.click(screen.getByText("Refine"));
    await waitFor(() => expect(routes.composeCalls()).toHaveLength(2));

    const [first, second] = routes.composeCalls();
    expect(first?.body.previousPlanId).toBeUndefined();
    expect(second?.body.previousPlanId).toBe("plan-1");
  });

  it("Start over returns to a fresh compose, not a revision of what was cleared", async () => {
    // The failure this guards: keeping the plan id after a reset would revise
    // a view the visitor can no longer see.
    const routes = stubFetchByRoute({
      compose: { payload: { ok: true, planId: "plan-1", messages: composeMessages("open") } },
    });
    render(<LauncherHarness />);
    open();
    type("show me open reports");
    fireEvent.click(screen.getByText("Go"));
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());

    fireEvent.click(screen.getByText("Start over"));
    await waitFor(() => expect(screen.queryByTestId("ticket-card")).toBeNull());
    expect(screen.getByText("Go")).toBeTruthy();

    type("something else entirely");
    fireEvent.click(screen.getByText("Go"));
    await waitFor(() => expect(routes.composeCalls()).toHaveLength(2));
    expect(routes.composeCalls()[1]?.body.previousPlanId).toBeUndefined();
  });
});

describe("workspace suggestions and refusals", () => {
  function WorkspaceHarness({ suggestions }: { suggestions?: readonly string[] }) {
    return (
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [registered],
          renderMode: "host",
          composeTimeoutMs: 50,
          stream: false,
        }}
      >
        <ViewWorkspace suggestions={suggestions} />
      </ViewProvider>
    );
  }

  it("renders host-written chips on the empty workspace and submits one on click", async () => {
    const stub = stubFetchByRoute({
      compose: { payload: { ok: false, kind: "unsupported", reason: "nothing here" } },
    });
    render(<WorkspaceHarness suggestions={["Show my tickets", "Weekly summary"]} />);

    expect(screen.getByText("Try one of these:")).toBeTruthy();
    fireEvent.click(screen.getByText("Show my tickets"));
    await waitFor(() => expect(stub.composeCalls().length).toBe(1));
    // The chip's own words went to the service — one click, no typing.
    expect(stub.composeCalls()[0]!.body.prompt).toBe("Show my tickets");
  });

  it("renders a refusal as a designed card carrying the suggestions", async () => {
    stubFetchByRoute({
      compose: {
        payload: {
          ok: false,
          kind: "unsupported",
          reason: "No approved capability returns weather.",
        },
      },
    });
    render(<WorkspaceHarness suggestions={["Show my tickets"]} />);

    fireEvent.change(screen.getByLabelText("Describe what you want"), {
      target: { value: "what is the weather" },
    });
    fireEvent.click(screen.getByText("Go"));

    await waitFor(() =>
      expect(screen.getByText("This site can't answer that one")).toBeTruthy(),
    );
    expect(screen.getByText(/No approved capability returns weather/)).toBeTruthy();
    // The dead end offers the host's own suggestions as the way forward.
    expect(screen.getByText("Things it can answer:")).toBeTruthy();
    expect(screen.getByText("Show my tickets")).toBeTruthy();
  });

  it("keeps non-refusal failures as the plain error line", async () => {
    stubFetchByRoute({
      compose: { payload: { ok: false, kind: "provider-error", reason: "boom" }, ok: false },
    });
    render(<WorkspaceHarness suggestions={["Show my tickets"]} />);
    fireEvent.change(screen.getByLabelText("Describe what you want"), {
      target: { value: "show tickets" },
    });
    fireEvent.click(screen.getByText("Go"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByText("This site can't answer that one")).toBeNull();
  });
});

/**
 * The same clarification exchange, driven through `ViewWorkspace` rather than
 * through the bespoke `Composer` above.
 *
 * That distinction is the whole point. The hook-level tests passed from the day
 * `needs-clarification` shipped, because `Composer` reads `clarification` and
 * renders answer buttons — while neither shipped component read the field at
 * all. A host on the documented path got the question in the error slot, styled
 * as a failure, with no options and no way to answer. Green suite, broken
 * default path: the test built the UI the library didn't.
 */
describe("ViewWorkspace renders a clarification, not a failure", () => {
  function WorkspaceHarness() {
    return (
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [registered],
          renderMode: "host",
        }}
      >
        <ViewWorkspace />
      </ViewProvider>
    );
  }

  function askWorkspace(text = "show me reports") {
    fireEvent.change(screen.getByLabelText("Describe what you want"), {
      target: { value: text },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
  }

  it("shows the question and its options as buttons, not as an alert", async () => {
    stubFetchOnce(
      {
        ok: false,
        kind: "needs-clarification",
        reason: "Do you mean open reports, or reports you opened?",
        question: "Do you mean open reports, or reports you opened?",
        options: ["Open reports", "Reports I opened"],
      },
      { ok: false },
    );
    render(<WorkspaceHarness />);
    askWorkspace();

    await waitFor(() =>
      expect(
        screen.getByText("Do you mean open reports, or reports you opened?"),
      ).toBeTruthy(),
    );

    // Both options are reachable. This is what a host could not get before:
    // the planner supplied them and nothing rendered them.
    expect(screen.getByRole("button", { name: "Open reports" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reports I opened" })).toBeTruthy();

    // And it is not announced as a failure. The hook still populates `error`
    // with the question for compatibility, so a component that renders both
    // would print the same sentence twice — once asked, once as an alert.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("answers by clicking an option, and the exchange completes", async () => {
    stubFetchOnce(
      {
        ok: false,
        kind: "needs-clarification",
        reason: "Which ones?",
        question: "Which ones?",
        options: ["Open reports"],
      },
      { ok: false },
    );
    render(<WorkspaceHarness />);
    askWorkspace("show me reports");
    await waitFor(() => expect(screen.getByText("Which ones?")).toBeTruthy());

    const answered = stubFetchOnce({ ok: true, messages: composeMessages("open") });
    fireEvent.click(screen.getByRole("button", { name: "Open reports" }));

    await waitFor(() =>
      expect(screen.getByTestId("ticket-card").textContent).toBe("open"),
    );
    // The answer carries what it answers: "Open reports" is meaningless alone.
    const body = String(answered.mock.calls[0]?.[1]?.body);
    expect(body).toContain("show me reports");
    expect(body).toContain("Open reports");
    // And the question is gone once answered.
    expect(screen.queryByText("Which ones?")).toBeNull();
  });

  it("a question with no options tells the visitor the prompt box is the answer", async () => {
    stubFetchOnce(
      { ok: false, kind: "needs-clarification", reason: "Which region?", question: "Which region?" },
      { ok: false },
    );
    render(<WorkspaceHarness />);
    askWorkspace();

    await waitFor(() => expect(screen.getByText("Which region?")).toBeTruthy());
    expect(screen.getByText("Answer above to continue.")).toBeTruthy();
  });
});

/**
 * The hook shipped `save`/`listSaved`/`reopen`/`deleteSaved` with nothing on
 * the documented path calling them — the same green-suite-broken-default
 * failure the clarification tests above describe. These pin the workspace's
 * built-in entrance to that flow.
 */
describe("workspace saved-views controls", () => {
  function renderWorkspace(props: { savedViews?: boolean } = {}) {
    return render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [registered],
          renderMode: "host",
          composeTimeoutMs: 50,
          stream: false,
        }}
      >
        <ViewWorkspace {...props} />
      </ViewProvider>,
    );
  }

  function askWorkspace(text = "show me open reports") {
    fireEvent.change(screen.getByLabelText("Describe what you want"), {
      target: { value: text },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
  }

  const savedSummary = {
    id: "view-9",
    catalogId: "support-assist",
    surfaceId: "main",
    prompt: "open reports by team",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    stale: false,
  };
  const staleSummary = {
    id: "view-10",
    catalogId: "support-assist",
    surfaceId: "main",
    prompt: "weekly digest of everything",
    label: "Weekly digest",
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:00:00.000Z",
    stale: true,
  };

  it("offers Save only once there is a view, and confirms a save inline", async () => {
    const calls = stubFetchByPath({
      "/api/compose": {
        payload: { ok: true, planId: "plan-7", messages: composeMessages("ready") },
      },
      "/api/views": { payload: { ok: true, viewId: "view-1" } },
    });
    renderWorkspace();

    // No view yet: nothing to save — but My views is already there, because
    // reopening is most useful on the empty workspace.
    expect(screen.queryByRole("button", { name: "Save view" })).toBeNull();
    expect(screen.getByRole("button", { name: "My views" })).toBeTruthy();

    askWorkspace();
    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() =>
      expect(screen.getByText("Saved — this view now has its own URL")).toBeTruthy(),
    );
    // A confirmation is announced, not just painted.
    expect(screen.getByRole("status").textContent).toContain("its own URL");

    const saveCall = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/views"),
    );
    expect(saveCall?.body).toEqual({ catalogId: "support-assist", planId: "plan-7" });
  });

  it("My views lists the saved views and reopens the row clicked", async () => {
    const calls = stubFetchByPath({
      "/api/views": { payload: { ok: true, views: [savedSummary, staleSummary] } },
      "/api/views/reopen": {
        payload: { ok: true, planId: "plan-9", messages: composeMessages("reopened") },
      },
    });
    renderWorkspace();

    const toggle = screen.getByRole("button", { name: "My views" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("open reports by team")).toBeTruthy());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The listing was a GET to the same route a save POSTs to.
    expect(
      calls.some((call) => call.method === "GET" && call.url.endsWith("/api/views")),
    ).toBe(true);
    // A labelled view shows its label; an unlabelled one falls back to its
    // prompt; a drifted one says so before it is reopened.
    expect(screen.getByText("Weekly digest")).toBeTruthy();
    expect(screen.getByText("Changed since saved")).toBeTruthy();
    expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("open reports by team"));
    await waitFor(() => expect(screen.getByText("reopened")).toBeTruthy());
    const reopenCall = calls.find((call) => call.url.includes("/api/views/reopen"));
    expect(reopenCall?.body).toEqual({ viewId: "view-9" });
    // The menu closed with the choice made.
    expect(screen.queryByText("open reports by team")).toBeNull();
  });

  it("deleting a saved view removes its row and keeps the menu open", async () => {
    const handlers = {
      "/api/views": {
        payload: { ok: true, views: [savedSummary, staleSummary] } as unknown,
      },
      "/api/views/delete": { payload: { ok: true } },
    };
    const calls = stubFetchByPath(handlers);
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "My views" }));
    await waitFor(() => expect(screen.getByText("open reports by team")).toBeTruthy());

    // The menu re-lists after a delete, so the stub's next answer is the
    // store's next truth.
    handlers["/api/views"].payload = { ok: true, views: [staleSummary] };
    fireEvent.click(
      screen.getByRole("button", { name: "Delete saved view open reports by team" }),
    );

    await waitFor(() => expect(screen.queryByText("open reports by team")).toBeNull());
    const deleteCall = calls.find((call) => call.url.includes("/api/views/delete"));
    expect(deleteCall?.body).toEqual({ viewId: "view-9" });
    // The other row survives, in the still-open menu.
    expect(screen.getByText("Weekly digest")).toBeTruthy();
  });

  it("says what to do when nothing is saved yet", async () => {
    stubFetchByPath({ "/api/views": { payload: { ok: true, views: [] } } });
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "My views" }));
    await waitFor(() =>
      expect(
        screen.getByText("Nothing saved yet — compose a view and press Save."),
      ).toBeTruthy(),
    );
  });

  it("savedViews={false} renders neither control", async () => {
    stubFetchByPath({
      "/api/compose": {
        payload: { ok: true, planId: "plan-7", messages: composeMessages("ready") },
      },
    });
    renderWorkspace({ savedViews: false });

    expect(screen.queryByRole("button", { name: "My views" })).toBeNull();
    askWorkspace();
    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Save view" })).toBeNull();
  });

  /**
   * A host whose server has no `viewStore` answers the saved-view routes with
   * `400 {ok, error}` and no machine-readable kind — the same envelope as any
   * rejected request — which is why the workspace cannot detect such a host on
   * its own and `savedViews={false}` exists. Left on, the failure surfaces as
   * the hook's own error copy rather than a crash or a silent nothing.
   */
  it("a host without a view store gets the hook's error copy, not a broken menu", async () => {
    stubFetchByPath({
      "/api/views": {
        ok: false,
        status: 400,
        payload: {
          ok: false,
          error: "Saved views are not enabled: set ViewServerConfig.viewStore.",
        },
      },
    });
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "My views" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't load saved views",
    );
    // And the menu settles on the empty state rather than wedging on Loading.
    expect(
      screen.getByText("Nothing saved yet — compose a view and press Save."),
    ).toBeTruthy();
  });
});

/**
 * Pinning one panel out of a multi-panel view. The properties pinned here are
 * the wire contract (only `planId` + the panel's `nodeId` cross, never a plan
 * body), the mapping (the clicked panel's pin carries that panel's plan
 * nodeId — which `compileSurfaceMessages` preserves as the A2UI component id),
 * and the gate (pins are saved views, so `savedViews={false}` removes them).
 */
describe("workspace pin affordance", () => {
  function renderWorkspace(props: { savedViews?: boolean } = {}) {
    return render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [registered],
          renderMode: "host",
          composeTimeoutMs: 50,
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

  /** A composed view with two top-level panels, ids n1 and n2 — the shape the
   * server compiles: root Column children are the plan's top-level nodeIds. */
  function twoPanelMessages(first: string, second: string) {
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
            { id: "root", component: "Column", children: ["n1", "n2"] },
            {
              id: "n1",
              component: "TicketCard",
              title: "First",
              report: { path: "/n1/report" },
            },
            {
              id: "n2",
              component: "TicketCard",
              title: "Second",
              report: { path: "/n2/report" },
            },
          ],
        },
      },
      {
        version: "v0.9",
        updateDataModel: {
          surfaceId: "main",
          path: "/",
          value: { n1: { report: { status: first } }, n2: { report: { status: second } } },
        },
      },
    ];
  }

  it("offers the pin on a single-panel view too, where it pins the whole view", async () => {
    // Pinning the only panel yields the view Save would have saved. That is a
    // reason to make the two agree, not a reason to hide the control: a reader
    // who finds no pin concludes the feature is missing, not redundant.
    const calls = stubFetchByPath({
      "/api/compose": {
        payload: { ok: true, planId: "plan-9", messages: composeMessages("open") },
      },
      "/api/views": { payload: { ok: true, viewId: "view-91" } },
    });
    renderWorkspace();
    askWorkspace();
    await waitFor(() => expect(screen.getByText("open")).toBeTruthy());

    expect(screen.getAllByLabelText("Pin this panel")).toHaveLength(1);
    // Nothing to reorder with one panel, so the grip stays away.
    expect(screen.queryAllByLabelText(/^Move /)).toHaveLength(0);

    fireEvent.click(screen.getByLabelText("Pin this panel"));
    await waitFor(() =>
      expect(screen.getByText("Pinned — find it in My views")).toBeTruthy(),
    );
    const pinCall = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/views"),
    );
    expect(pinCall?.body).toMatchObject({ planId: "plan-9" });
    expect((pinCall?.body as { nodeIds: string[] }).nodeIds).toHaveLength(1);
  });

  it("renders a pin per top-level panel and pins the panel that was clicked", async () => {
    const calls = stubFetchByPath({
      "/api/compose": {
        payload: { ok: true, planId: "plan-7", messages: twoPanelMessages("open", "closed") },
      },
      "/api/views": { payload: { ok: true, viewId: "view-77" } },
    });
    renderWorkspace();
    askWorkspace();
    await waitFor(() => expect(screen.getByText("closed")).toBeTruthy());
    // Both panels rendered, each with its own pin.
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getAllByLabelText("Pin this panel")).toHaveLength(2);

    fireEvent.click(screen.getAllByLabelText("Pin this panel")[1]);
    // Hidden while the pin is in flight, like the Save control.
    expect(screen.queryAllByLabelText("Pin this panel")).toHaveLength(0);

    await waitFor(() =>
      expect(screen.getByText("Pinned — find it in My views")).toBeTruthy(),
    );
    // Announced, not just painted — the Save confirmation's pattern.
    expect(screen.getByRole("status").textContent).toContain("My views");

    // The wire contract: planId plus the clicked panel's nodeId, never a plan
    // body — the server slices the plan it already owns.
    const pinCall = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/views"),
    );
    expect(pinCall?.body).toEqual({
      catalogId: "support-assist",
      planId: "plan-7",
      nodeIds: ["n2"],
    });
    expect(JSON.stringify(pinCall?.body)).not.toContain("surfaces");

    // Unlike Save, a pin does not point the page's URL at the new view — the
    // visitor is still looking at the full one.
    expect(new URLSearchParams(window.location.search).get("iv")).toBeNull();

    // The full view survives the pin, and the affordances return.
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getByText("closed")).toBeTruthy();
    expect(screen.getAllByLabelText("Pin this panel")).toHaveLength(2);
  });

  it("reopening a pin renders only that panel", async () => {
    stubFetchByPath({
      "/api/views/reopen": {
        payload: {
          ok: true,
          planId: "plan-pin-9",
          messages: composeMessages("pinned-only"),
        },
      },
    });
    window.history.replaceState(null, "", "/?iv=view-77");

    renderWorkspace();
    await waitFor(() => expect(screen.getByText("pinned-only")).toBeTruthy());
    // One panel, one card — carrying a pin like any other panel. Pinning a
    // reopened view hits the same "no recently composed plan" wall Save does,
    // because reopening does not remember the plan it replayed; the control is
    // still offered rather than selectively hidden, so the two agree and the
    // limitation surfaces as an error the visitor can read instead of a
    // feature that silently is not there.
    expect(screen.getAllByTestId("ticket-card")).toHaveLength(1);
    expect(screen.getAllByLabelText("Pin this panel")).toHaveLength(1);
  });

  it("savedViews={false} renders no pins", async () => {
    stubFetchByPath({
      "/api/compose": {
        payload: { ok: true, planId: "plan-7", messages: twoPanelMessages("open", "closed") },
      },
    });
    renderWorkspace({ savedViews: false });
    askWorkspace();
    await waitFor(() => expect(screen.getByText("closed")).toBeTruthy());
    // Pins are saved views; a host with no view store gets none.
    expect(screen.queryAllByLabelText("Pin this panel")).toHaveLength(0);
  });
});

/* ─── entry-point parity ──────────────────────────────────────────────────────
 *
 * Every feature below, asserted against every entry point a host can mount.
 *
 * This exists because the two entry points forked. `ViewWorkspace` and
 * `ViewLauncher` each own a prompt row, each write the
 * `hasView ? revise() : submit()` rule, and each render errors their own way —
 * and only the workspace had a journey test. So a fix landed in one and not the
 * other, silently, and the launcher quietly lacks saved views, suggestions, the
 * refusal card and the error-kind split.
 *
 * `lacks` records that fork as data. A feature listed there is asserted
 * *absent*, so the gap is pinned rather than merely unnoticed — and when one
 * entry point becomes a composition of the other, these assertions fail until
 * the entry is removed from `lacks`. That failure is the acceptance test for
 * unifying them: the set going empty is the proof.
 */

const PARITY_CONFIG = {
  serviceUrl: "https://intent.example",
  catalogId: "support-assist",
  components: [registered],
  renderMode: "host" as const,
  composeTimeoutMs: 50,
  stream: false,
};

interface EntryPoint {
  name: string;
  /** Features this entry point does not implement yet. See the note above. */
  lacks: ReadonlySet<string>;
  /** Renders it and gets the visitor to a usable prompt box. */
  mount: (props?: Record<string, unknown>) => void;
}

const ENTRY_POINTS: readonly EntryPoint[] = [
  {
    name: "ViewWorkspace",
    lacks: new Set(),
    mount: (props = {}) => {
      render(
        <ViewProvider config={PARITY_CONFIG}>
          <ViewWorkspace {...props} />
        </ViewProvider>,
      );
    },
  },
  {
    name: "ViewLauncher",
    // Empty, and that is the acceptance test for the unification: the dialog is
    // a `ViewPage` in a positioned panel, so it cannot lack a feature the page
    // has. When these four were listed here, each was a feature nobody had
    // decided to leave out — the launcher simply had its own implementation of
    // the same screen and had not grown them.
    lacks: new Set<string>(),
    mount: (props = {}) => {
      render(
        <ViewProvider config={PARITY_CONFIG}>
          <ViewLauncher label="Ask" {...props} />
        </ViewProvider>,
      );
      // The panel is closed until someone opens it; every assertion below is
      // about what a visitor sees once they have.
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    },
  },
];

/** Both entry points label their input identically, so one helper drives both. */
function typeInto(text: string) {
  const box = screen.queryByLabelText("Describe what you want")
    ?? screen.getByLabelText("Describe a change to this view");
  fireEvent.change(box, { target: { value: text } });
}

function clickButton(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

async function composeOnce(text = "show me open reports") {
  typeInto(text);
  clickButton("Go");
  await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());
}

const composeOk = (planId = "plan-1", status = "open") => ({
  payload: { ok: true, planId, messages: composeMessages(status) },
});

describe.each(ENTRY_POINTS)("$name parity", (entry) => {
  const skipIfLacking = (feature: string, assertPresent: () => void, assertAbsent: () => void) => {
    if (entry.lacks.has(feature)) {
      assertAbsent();
      return false;
    }
    assertPresent();
    return true;
  };

  it("asks, and renders the composed view", async () => {
    stubFetchByPath({ "/api/compose": composeOk() });
    entry.mount();
    await composeOnce();
    expect(screen.getByTestId("ticket-card").textContent).toBe("open");
  });

  it("revises the view on screen rather than composing afresh", async () => {
    const calls = stubFetchByPath({ "/api/compose": composeOk("plan-1") });
    entry.mount();
    await composeOnce();

    // With a view up, the control changes meaning: typing is a change to it.
    expect(screen.queryByRole("button", { name: "Go" })).toBeNull();
    typeInto("only the urgent ones");
    clickButton("Refine");
    await waitFor(() => expect(calls.filter((call) => call.url.includes("/api/compose"))).toHaveLength(2));
    const composes = calls.filter((call) => call.url.includes("/api/compose"));
    expect(composes[0]?.body?.previousPlanId).toBeUndefined();
    expect(composes[1]?.body?.previousPlanId).toBe("plan-1");
  });

  it("starts over into a fresh compose, not a revision of what was cleared", async () => {
    const calls = stubFetchByPath({ "/api/compose": composeOk() });
    entry.mount();
    await composeOnce();

    clickButton("Start over");
    expect(screen.queryByTestId("ticket-card")).toBeNull();
    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();

    typeInto("something else entirely");
    clickButton("Go");
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());
    const composes = calls.filter((call) => call.url.includes("/api/compose"));
    expect(composes.at(-1)?.body?.previousPlanId).toBeUndefined();
  });

  it("shows a clarifying question as a question, not as an error", async () => {
    stubFetchOnce(
      {
        ok: false,
        kind: "needs-clarification",
        reason: "Open by team, or by age?",
        question: "Open by team, or by age?",
        options: ["by team", "by age"],
      },
      { ok: false },
    );
    entry.mount();
    typeInto("show me open reports");
    clickButton("Go");

    await waitFor(() => expect(screen.getByText("Open by team, or by age?")).toBeTruthy());
    expect(screen.getByRole("button", { name: "by team" })).toBeTruthy();
  });

  it("tells a visitor a rejected credential is not something to retry", async () => {
    stubFetchOnce({ ok: false, error: "Not authenticated." }, { ok: false, status: 401 });
    entry.mount();
    typeInto("show me open reports");
    clickButton("Go");
    await waitFor(() => expect(screen.getByText(/sign in/i)).toBeTruthy());
    // Not the retry copy: retrying an expired session reproduces it forever.
    expect(screen.queryByText(/please try again\.$/i)).toBeNull();
  });

  it("renders host-written suggestions on the empty state", async () => {
    stubFetchByPath({ "/api/compose": composeOk() });
    entry.mount({ suggestions: ["open reports by team"] });
    skipIfLacking(
      "suggestions",
      () => expect(screen.getByRole("button", { name: "open reports by team" })).toBeTruthy(),
      () => expect(screen.queryByRole("button", { name: "open reports by team" })).toBeNull(),
    );
  });

  it("renders a refusal as a card carrying its suggestions", async () => {
    stubFetchOnce(
      {
        ok: false,
        kind: "unsupported",
        reason: "No approved data covers spend by vendor.",
      },
      { ok: false },
    );
    entry.mount({ suggestions: ["open reports by team"] });
    typeInto("spend by vendor");
    clickButton("Go");

    // The reason reaches the visitor on both — that is the error line.
    await waitFor(() => expect(screen.getByText(/No approved data covers/)).toBeTruthy());
    // The designed card, with a way forward, is what forked.
    skipIfLacking(
      "refusal-card",
      () => expect(screen.getByRole("button", { name: "open reports by team" })).toBeTruthy(),
      () => expect(screen.queryByRole("button", { name: "open reports by team" })).toBeNull(),
    );
  });

  it("offers Save once a view exists", async () => {
    stubFetchByPath({
      "/api/compose": composeOk("plan-7"),
      "/api/views": { payload: { ok: true, viewId: "view-1" } },
    });
    entry.mount();
    await composeOnce();
    skipIfLacking(
      "saved-views",
      () => expect(screen.getByRole("button", { name: "Save view" })).toBeTruthy(),
      () => expect(screen.queryByRole("button", { name: "Save view" })).toBeNull(),
    );
  });

  it("offers My views, and lists what is saved", async () => {
    stubFetchByPath({
      "/api/compose": composeOk(),
      "/api/views": { payload: { ok: true, views: [savedParitySummary] } },
    });
    entry.mount();
    await composeOnce();
    if (!skipIfLacking(
      "saved-views",
      () => expect(screen.getByRole("button", { name: "My views" })).toBeTruthy(),
      () => expect(screen.queryByRole("button", { name: "My views" })).toBeNull(),
    )) return;

    clickButton("My views");
    await waitFor(() => expect(screen.getByText("open reports by team")).toBeTruthy());
  });

  it("offers a pin on the composed view", async () => {
    stubFetchByPath({ "/api/compose": composeOk() });
    entry.mount();
    await composeOnce();
    skipIfLacking(
      "panels",
      () => expect(screen.getAllByRole("button", { name: /pin/i }).length).toBeGreaterThan(0),
      () => expect(screen.queryByRole("button", { name: /pin/i })).toBeNull(),
    );
  });
});

const savedParitySummary = {
  id: "view-9",
  catalogId: "support-assist",
  surfaceId: "main",
  prompt: "open reports by team",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  stale: false,
};

/* ─── the parts, mounted on their own ─────────────────────────────────────────
 *
 * The claim Stage 2 makes: each part reads what it needs from context, renders
 * standalone, and omitting one is how a host turns that feature off. Asserted
 * rather than assumed, because "extracted" and "independently usable" are
 * different properties and only the second is worth anything to a host.
 */
describe("composed layouts", () => {
  function mountParts(children: ReactNode) {
    return render(<ViewProvider config={PARITY_CONFIG}>{children}</ViewProvider>);
  }

  it("composes a prompt and a surface with no saved views and no notices", async () => {
    const calls = stubFetchByPath({ "/api/compose": composeOk() });
    mountParts(
      <>
        <ViewPrompt />
        <ViewSurface />
      </>,
    );

    typeInto("show me open reports");
    clickButton("Go");
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());

    // The features not mounted are absent, and — the part that matters — no
    // saved-view request was ever made. An omitted part must cost nothing, not
    // merely render nothing.
    expect(screen.queryByRole("button", { name: "My views" })).toBeNull();
    expect(calls.some((call) => call.url.includes("/api/views"))).toBe(false);
  });

  it("renders suggestions on their own, wired to the session", async () => {
    const calls = stubFetchByPath({ "/api/compose": composeOk() });
    mountParts(<ViewSuggestions suggestions={["open reports by team"]} />);

    // No prompt box in this layout at all: the chip is the whole entry point.
    fireEvent.click(screen.getByRole("button", { name: "open reports by team" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body?.prompt).toBe("open reports by team");
  });

  it("renders notices on their own, without a prompt or a surface", async () => {
    stubFetchOnce({ ok: false, kind: "unsupported", reason: "No approved data covers that." }, { ok: false });
    mountParts(
      <>
        <ViewPrompt />
        <ViewNotices suggestions={["open reports by team"]} />
      </>,
    );
    typeInto("spend by vendor");
    clickButton("Go");

    await waitFor(() => expect(screen.getByText(/No approved data covers/)).toBeTruthy());
    // The refusal card's own way out, from a layout that mounted no surface.
    expect(screen.getByRole("button", { name: "open reports by team" })).toBeTruthy();
  });

  it("a bare ViewSurface renders no panel controls, and asking for them adds pins", async () => {
    stubFetchByPath({ "/api/compose": composeOk() });
    const view = mountParts(
      <>
        <ViewPrompt />
        <ViewSurface />
      </>,
    );
    typeInto("show me open reports");
    clickButton("Go");
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());
    // Default off, so every host rendering a bare surface today is unchanged.
    expect(screen.queryByRole("button", { name: /pin/i })).toBeNull();

    view.unmount();
    stubFetchByPath({ "/api/compose": composeOk() });
    mountParts(
      <>
        <ViewPrompt />
        <ViewSurface panels />
      </>,
    );
    typeInto("show me open reports");
    clickButton("Go");
    await waitFor(() => expect(screen.getByTestId("ticket-card")).toBeTruthy());
    // One prop on the component a host already renders, instead of knowing that
    // a second component exists.
    expect(screen.getAllByRole("button", { name: /pin/i }).length).toBeGreaterThan(0);
  });
  it("puts saved views on their own page, with no prompt and no compose", async () => {
    // A route that only reopens: "My views" as its own page, which the
    // all-or-nothing workspace could not express. The list, the reopen and the
    // rendered result all work with no prompt mounted anywhere.
    const calls = stubFetchByPath({
      "/api/views/reopen": { payload: { ok: true, planId: "plan-9", messages: composeMessages("reopened") } },
      "/api/views": { payload: { ok: true, views: [savedParitySummary] } },
    });
    mountParts(
      <>
        <ViewSavedControls />
        <ViewSavedBar />
        <ViewSurface />
      </>,
    );

    clickButton("My views");
    await waitFor(() => expect(screen.getByText("open reports by team")).toBeTruthy());
    fireEvent.click(screen.getByText("open reports by team"));
    await waitFor(() => expect(screen.getByTestId("ticket-card").textContent).toBe("reopened"));

    // Nothing composed: this page never asked the planner for anything.
    expect(calls.some((call) => call.url.includes("/api/compose"))).toBe(false);
    const reopened = calls.find((call) => call.url.includes("/reopen"));
    expect((reopened?.body as { viewId?: string })?.viewId).toBe("view-9");
  });
});

describe("ViewPage", () => {
  it("with no children renders the standard arrangement", async () => {
    stubFetchByPath({ "/api/compose": composeOk(), "/api/views": { payload: { ok: true, views: [] } } });
    render(
      <ViewProvider config={PARITY_CONFIG}>
        <ViewPage suggestions={["open reports by team"]} />
      </ViewProvider>,
    );
    // Every part of the default layout, from one element with no children.
    expect(screen.getByLabelText("Describe what you want")).toBeTruthy();
    expect(screen.getByRole("button", { name: "My views" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "open reports by team" })).toBeTruthy();
    await composeOnce();
    expect(screen.getAllByRole("button", { name: /pin/i }).length).toBeGreaterThan(0);
  });

  it("with children renders exactly those, and omitting a part turns it off", async () => {
    const calls = stubFetchByPath({ "/api/compose": composeOk() });
    render(
      <ViewProvider config={PARITY_CONFIG}>
        <ViewPage>
          <ViewPrompt />
          <ViewResult />
        </ViewPage>
      </ViewProvider>,
    );

    await composeOnce();
    // The rung that did not exist: this layout, minus saved views.
    expect(screen.queryByRole("button", { name: "My views" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save view" })).toBeNull();
    // And omitting the part costs nothing, rather than rendering nothing.
    expect(calls.some((call) => call.url.includes("/api/views"))).toBe(false);
  });

  it("gives a custom arrangement the container that parts alone do not have", () => {
    // The trap this closes. `parts.tsx` injects no stylesheet and mounts no
    // render boundary — only the page does — so a host composing parts got
    // working behaviour and no styling, which reads as a broken library rather
    // than a missing container.
    stubFetchByPath({ "/api/compose": composeOk() });
    const bare = render(
      <ViewProvider config={{ ...PARITY_CONFIG, renderMode: "isolated" }}>
        <ViewPrompt />
      </ViewProvider>,
    );
    expect(bare.container.querySelector("style")).toBeNull();
    bare.unmount();

    const paged = render(
      <ViewProvider config={{ ...PARITY_CONFIG, renderMode: "isolated" }}>
        <ViewPage>
          <ViewPrompt />
        </ViewPage>
      </ViewProvider>,
    );
    // Isolated mode puts the chrome stylesheet inside the shadow root the page
    // mounts, so the assertion is that a root exists and carries styles.
    const host = paged.container.querySelector("div");
    const root = (host as HTMLElement & { shadowRoot?: ShadowRoot | null })?.shadowRoot
      ?? paged.container.shadowRoot;
    expect(root?.querySelector("style")).toBeTruthy();
    expect(root?.querySelector(".renderyes-workspace")).toBeTruthy();
  });

  it("savedViews={false} still turns saved views off for a host with no children to omit", async () => {
    const calls = stubFetchByPath({ "/api/compose": composeOk() });
    render(
      <ViewProvider config={PARITY_CONFIG}>
        <ViewPage savedViews={false} />
      </ViewProvider>,
    );
    await composeOnce();
    // The reason these props stay: a tier-one host has no part to leave out,
    // and the concern spans the row's controls, the panel below it, and the
    // pins on the surface.
    expect(screen.queryByRole("button", { name: "My views" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save view" })).toBeNull();
    expect(screen.queryByRole("button", { name: /pin/i })).toBeNull();
    expect(calls.some((call) => call.url.includes("/api/views"))).toBe(false);
  });
});
