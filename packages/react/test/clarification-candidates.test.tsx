import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineProps, field } from "@renderyes/site-sdk";
import { defineHostComponent } from "../src/define-host-component.js";
import { ViewProvider } from "../src/provider.js";
import { ViewPage } from "../src/page.js";
import { CLARIFICATION_ESCAPE_LABEL } from "../src/clarification.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * A question with capability candidates: the System One planner's uncertain
 * band, in model-only mode. The server names two to four approved
 * capabilities; the client renders them as chips; picking one composes the
 * same prompt again with `capabilityId`, which the server plans with no model
 * call. These pin the three things a visitor needs from that exchange: the
 * chips are reachable by mouse and keyboard, a pick sends the id rather than
 * prose, and there is always a visible way out to the full site.
 */

function PuzzleList({ items }: { items?: Array<{ title?: string }> }) {
  return (
    <div data-testid="puzzle-list">{(items ?? []).map((row) => row.title).join("|")}</div>
  );
}

const registered = defineHostComponent({
  id: "PuzzleList",
  description: "Puzzles.",
  dataSlots: { items: { accepts: [{ shape: "collection" }] } },
  props: defineProps({ heading: field.string() }),
  component: PuzzleList,
});

const UI_CATALOG_ID = "newsroom:ui";

function composeMessages(title: string) {
  return [
    { version: "v0.9", createSurface: { surfaceId: "main", catalogId: UI_CATALOG_ID } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "main",
        components: [
          { id: "root", component: "Column", children: ["n1"] },
          {
            id: "n1",
            component: "PuzzleList",
            heading: "Puzzles",
            items: { path: "/n1/items" },
          },
        ],
      },
    },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: "main",
        path: "/",
        value: { n1: { items: [{ title }] } },
      },
    },
  ];
}

const QUESTION = "Which of these is closest to what you want to see?";
const candidates = [
  { capabilityId: "news.puzzles.list", label: "The paper's puzzles, by difficulty" },
  { capabilityId: "news.posts.list", label: "Published news articles" },
];

/** The server's answer to an uncertain prompt, as the batch route returns it. */
const askedWithCandidates = {
  ok: false,
  kind: "needs-clarification",
  reason: QUESTION,
  question: QUESTION,
  options: candidates.map((candidate) => candidate.label),
  candidates,
};

function stubFetchOnce(payload: unknown, init: { ok?: boolean } = {}) {
  const impl = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.ok === false ? 400 : 200,
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", impl);
  return impl;
}

function Harness(props: { onExit?: () => void; fullSiteHref?: string } = {}) {
  return (
    <ViewProvider
      config={{
        serviceUrl: "https://intent.example",
        catalogId: "newsroom",
        components: [registered],
        renderMode: "host",
      }}
    >
      <ViewPage {...props} />
    </ViewProvider>
  );
}

function ask(text = "show puzzle") {
  fireEvent.change(screen.getByLabelText("Describe what you want"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
}

describe("a question with capability candidates", () => {
  it("renders the candidates as chips under the question, with a way out to the full site", async () => {
    stubFetchOnce(askedWithCandidates, { ok: false });
    render(<Harness />);
    ask();

    await waitFor(() => expect(screen.getByText(QUESTION)).toBeTruthy());
    // The chips, grouped and labelled by the question for a screen reader.
    const group = screen.getByRole("group", { name: QUESTION });
    expect(group).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "The paper's puzzles, by difficulty" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Published news articles" })).toBeTruthy();
    // Not announced as a failure.
    expect(screen.queryByRole("alert")).toBeNull();
    // The escape: a link to the page the visitor is on, which under a dialog
    // is the full site. Nothing was passed, so it is the current location.
    const escape = screen.getByRole("link", { name: CLARIFICATION_ESCAPE_LABEL });
    expect(escape.getAttribute("href")).toBe("/");
  });

  it("picking a chip sends the original prompt with the capability id, not a sentence", async () => {
    stubFetchOnce(askedWithCandidates, { ok: false });
    render(<Harness />);
    ask("show puzzle");
    await waitFor(() => expect(screen.getByText(QUESTION)).toBeTruthy());

    // The box can be retyped while the question is up; the pick still
    // answers what was asked.
    fireEvent.change(screen.getByLabelText("Describe what you want"), {
      target: { value: "something else" },
    });
    const picked = stubFetchOnce({
      ok: true,
      messages: composeMessages("Monday crossword"),
    });
    fireEvent.click(
      screen.getByRole("button", { name: "The paper's puzzles, by difficulty" }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("puzzle-list").textContent).toBe("Monday crossword"),
    );
    const body = JSON.parse(String(picked.mock.calls[0]?.[1]?.body));
    expect(body.prompt).toBe("show puzzle");
    expect(body.capabilityId).toBe("news.puzzles.list");
    // No "You asked / The answer is" framing: the id is the answer, and the
    // server reads it rather than a sentence. `answersClarification` is
    // implied by the id on the server, so it does not travel either.
    expect(body.prompt).not.toContain("You asked");
    expect(body.answersClarification).toBeUndefined();
    // The question is gone once answered.
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it("the chips are reachable from the keyboard: arrows move between them, Enter picks", async () => {
    stubFetchOnce(askedWithCandidates, { ok: false });
    render(<Harness />);
    ask();
    await waitFor(() => expect(screen.getByText(QUESTION)).toBeTruthy());

    const first = screen.getByRole("button", {
      name: "The paper's puzzles, by difficulty",
    });
    const second = screen.getByRole("button", { name: "Published news articles" });
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "Home" });
    expect(document.activeElement).toBe(first);

    // A chip is a button, so Enter activates it the way a keyboard user
    // expects; the click is what the browser fires for that.
    const picked = stubFetchOnce({ ok: true, messages: composeMessages("Monday") });
    fireEvent.click(document.activeElement as HTMLElement);
    await waitFor(() => expect(picked).toHaveBeenCalled());
    const body = JSON.parse(String(picked.mock.calls[0]?.[1]?.body));
    expect(body.capabilityId).toBe("news.puzzles.list");
  });

  it("the way out honours the host's exit action or link when given", async () => {
    stubFetchOnce(askedWithCandidates, { ok: false });
    const onExit = vi.fn();
    const view = render(<Harness onExit={onExit} />);
    ask();
    await waitFor(() => expect(screen.getByText(QUESTION)).toBeTruthy());
    // With a host route, the escape is that action, not a reload.
    expect(screen.queryByRole("link", { name: CLARIFICATION_ESCAPE_LABEL })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: CLARIFICATION_ESCAPE_LABEL }));
    expect(onExit).toHaveBeenCalledTimes(1);
    view.unmount();

    stubFetchOnce(askedWithCandidates, { ok: false });
    render(<Harness fullSiteHref="https://news.example/" />);
    ask();
    await waitFor(() => expect(screen.getByText(QUESTION)).toBeTruthy());
    expect(
      screen.getByRole("link", { name: CLARIFICATION_ESCAPE_LABEL }).getAttribute("href"),
    ).toBe("https://news.example/");
  });

  it("a malformed candidate is dropped, and a question with none falls back to plain options", async () => {
    stubFetchOnce(
      {
        ...askedWithCandidates,
        candidates: [
          {
            capabilityId: "news.puzzles.list",
            label: "The paper's puzzles, by difficulty",
          },
          { capabilityId: 42, label: "Not an id" },
          { capabilityId: "news.posts.list" },
        ],
      },
      { ok: false },
    );
    const view = render(<Harness />);
    ask();
    await waitFor(() => expect(screen.getByText(QUESTION)).toBeTruthy());
    expect(
      screen.getAllByRole("button", { name: /puzzles|articles|Not an id/ }),
    ).toHaveLength(1);
    view.unmount();

    // The language model's shape: options only. Rendered as before — answer
    // strings, no escape link, since the prompt box is the way out.
    stubFetchOnce(
      {
        ok: false,
        kind: "needs-clarification",
        reason: "Which?",
        question: "Which?",
        options: ["A", "B"],
      },
      { ok: false },
    );
    render(<Harness />);
    ask();
    await waitFor(() => expect(screen.getByText("Which?")).toBeTruthy());
    expect(screen.getByRole("button", { name: "A" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: CLARIFICATION_ESCAPE_LABEL })).toBeNull();
  });
});
