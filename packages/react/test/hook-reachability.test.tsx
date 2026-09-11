import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ViewProvider } from "../src/provider.js";
import {
  useViewCompose,
  useSavedViews,
  usePanelOrder,
  HOST_ONLY_HOOK_FIELDS,
} from "../src/use-compose.js";

afterEach(cleanup);

/**
 * Every field `useViewCompose` returns is rendered by a shipped component or
 * declared host-only. Nothing else is allowed to exist quietly.
 *
 * This is the route contract's invariant, applied one layer up. `http.test.mjs`
 * asserts every `ViewServer` method is routed or named in
 * `LIBRARY_ONLY_METHODS`, enumerating from a live instance so adding a method is
 * enough to trip it. The same shape works here, and it is the check that was
 * missing when `clarification` shipped: the hook exposed it, no component read
 * it, and `browser-journey.test.tsx` drove a bespoke component that did — so a
 * green suite was evidence for a surface that existed only in the test.
 *
 * What this cannot do is judge whether a field is rendered *well*.
 * `clarification` would have satisfied this the moment anything referenced it,
 * including the error paragraph that was mislabelling a question as a failure.
 * It catches disappearance, not misuse.
 */

/**
 * Only the components a host actually mounts.
 *
 * `clarification.tsx` is deliberately absent, and leaving it in was the first
 * version of this test: that file naturally contains the word "clarification",
 * so it satisfied the check on its own while nothing passed it the field —
 * verified by mutation, which the test survived. A leaf component vouching for
 * a field it is never handed is precisely the hole this exists to close, so the
 * scanned set is the entry points only, and a leaf counts only once one of them
 * references it.
 */
const COMPONENT_SOURCES = [
  "workspace.tsx",
  "launcher.tsx",
  "surface.tsx",
  // The workspace's parts. Added when the 620-line component was split into
  // them: the fields did not stop being rendered, they moved, and this list is
  // what tells the check where a shipped component now lives.
  //
  // The alternative — exempting the fields as host-only to get green again —
  // would have turned a working surface into a documented absence, which is the
  // exact failure this test exists to catch, arriving through the test itself.
  "parts.tsx",
];

/**
 * Comments are stripped before matching, or a comment explaining why a field is
 * *not* rendered would satisfy the check it is meant to fail.
 */
function shippedComponentSource(): string {
  // Resolved from the package root, which is where vitest runs. Read at test
  // time on purpose: the invariant is about what the shipped source contains,
  // so nothing here can be satisfied by a mock.
  return COMPONENT_SOURCES.map((name) =>
    readFileSync(resolve(process.cwd(), "src", name), "utf8"),
  )
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

/** Enumerated from a live hook, so a new field cannot arrive unnoticed. */
function hookFields(read: () => object = useViewCompose): string[] {
  let captured: string[] = [];
  function Probe() {
    captured = Object.keys(read());
    return null;
  }
  render(
    <ViewProvider
      config={{
        serviceUrl: "https://intent.example",
        catalogId: "support-assist",
        components: [],
      }}
    >
      <Probe />
    </ViewProvider>,
  );
  return captured;
}

describe("hook field reachability", () => {
  it("renders every returned field or declares it host-only", () => {
    const source = shippedComponentSource();
    const exempt = new Set(HOST_ONLY_HOOK_FIELDS);

    const unreachable = hookFields().filter(
      (fieldName) => !exempt.has(fieldName) && !new RegExp(`\\b${fieldName}\\b`).test(source),
    );

    expect(unreachable).toEqual([]);
    if (unreachable.length > 0) {
      throw new Error(
        `These useViewCompose fields are rendered by no shipped component and are not ` +
          `declared host-only, so a visitor cannot reach them: ${unreachable.join(", ")}. ` +
          `Render one in ViewWorkspace/ViewLauncher, or add it to HOST_ONLY_HOOK_FIELDS to ` +
          `say the omission is deliberate.`,
      );
    }
  });

  it("declares nothing host-only that a component actually renders", () => {
    // The list going stale in the other direction: a field gets a surface and
    // stays on the list, so the list stops describing the library and a reader
    // builds something that already exists.
    const source = shippedComponentSource();
    const stale = HOST_ONLY_HOOK_FIELDS.filter((fieldName) =>
      new RegExp(`\\b${fieldName}\\b`).test(source),
    );
    expect(stale).toEqual([]);
  });

  it("declares nothing host-only that the hook does not return", () => {
    // A renamed or removed field leaving its exemption behind, which would
    // silently weaken the first assertion for whatever takes its name next.
    const returned = new Set(hookFields());
    const orphaned = HOST_ONLY_HOOK_FIELDS.filter((fieldName) => !returned.has(fieldName));
    expect(orphaned).toEqual([]);
  });
});

/**
 * The narrow hooks together are exactly the wide one.
 *
 * `useViewCompose` is kept as the union of three concerns so no caller breaks,
 * which means the split can go wrong in two silent ways: a field assigned to no
 * concern is unreachable through the narrow hooks, and a field assigned to two
 * makes a component re-render for work it does not do. Enumerated from live
 * hooks rather than from the types, because the types are an intersection and
 * would agree with themselves.
 */
describe("hook composition", () => {
  it("partitions the session between the narrow hooks, with nothing lost or shared", () => {
    const wide = new Set(hookFields());
    const saved = hookFields(useSavedViews);
    const panels = hookFields(usePanelOrder);

    const overlap = saved.filter((field) => panels.includes(field));
    expect(overlap).toEqual([]);

    for (const field of [...saved, ...panels]) {
      expect(wide.has(field), `${field} is not on useViewCompose`).toBe(true);
    }

    // What is left is the session's own. Named explicitly so that a new field
    // has to be placed deliberately: adding one to the session interface and
    // forgetting the narrow hook is the failure this catches.
    const claimed = new Set([...saved, ...panels]);
    const sessionOnly = [...wide].filter((field) => !claimed.has(field)).sort();
    expect(sessionOnly).toEqual([
      "answerClarification",
      "busy",
      "clarification",
      "error",
      "errorKind",
      "failedRequests",
      "issues",
      "messages",
      // The cross-filter aiming data: which requests are behind the view and
      // which request feeds which panel. Session-owned — they change exactly
      // when messages do, never on a saved-views or panel-order write.
      "nodeBindings",
      "planId",
      "progress",
      "prompt",
      "refine",
      "requests",
      "reset",
      "revise",
      "setPrompt",
      "stage",
      "startOver",
      "submit",
    ]);
  });

  it("returns the session's own values, not copies or placeholders", () => {
    // The partition above compares key sets, which a narrow hook can satisfy
    // while returning something else entirely: a wrapped function, a copied
    // object, a constant.
    //
    // Its limit, stated because it was measured rather than assumed: a field
    // whose session value is already `null` at mount — `staleReason` is the
    // only one — can be replaced by a literal `null` and neither this nor the
    // key check will see it. Comparing at initial state cannot. The behaviour
    // that would notice is in `browser-journey.test.tsx`, where a stale reopen
    // has to report itself.
    let wide: Record<string, unknown> = {};
    let saved: Record<string, unknown> = {};
    let panels: Record<string, unknown> = {};
    function Probe() {
      wide = useViewCompose() as unknown as Record<string, unknown>;
      saved = useSavedViews() as unknown as Record<string, unknown>;
      panels = usePanelOrder() as unknown as Record<string, unknown>;
      return null;
    }
    render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [],
        }}
      >
        <Probe />
      </ViewProvider>,
    );

    for (const [name, narrow] of [["useSavedViews", saved], ["usePanelOrder", panels]] as const) {
      for (const field of Object.keys(narrow)) {
        expect(narrow[field], `${name}.${field} is not the session's own`).toBe(wide[field]);
      }
    }
  });

  it("lets a host take saving without taking drag-to-rearrange", () => {
    // The point of the split, as a host would feel it. Before this, chrome that
    // wanted a Save button called a 26-field hook and got `reorderPanels` with
    // it — so adding one feature meant re-rendering on another feature's
    // background writes, and the two could not be adopted separately.
    let panelFields: string[] = [];
    let savedFields: string[] = [];
    function OwnChrome() {
      const saved = useSavedViews();
      savedFields = Object.keys(saved);
      panelFields = Object.keys(usePanelOrder());
      return <button onClick={() => void saved.save()}>Keep this</button>;
    }
    const view = render(
      <ViewProvider
        config={{
          serviceUrl: "https://intent.example",
          catalogId: "support-assist",
          components: [],
        }}
      >
        <OwnChrome />
      </ViewProvider>,
    );

    expect(view.getByText("Keep this")).toBeTruthy();
    // Saving arrives without arranging; arranging is there when asked for, and
    // only then.
    expect(savedFields).not.toContain("reorderPanels");
    expect(savedFields).not.toContain("reordering");
    expect(panelFields.sort()).toEqual(["reorderPanels", "reordering"]);
  });

  it("names each narrow hook in its own provider error", () => {
    // A host calling useSavedViews outside a provider read "useViewCompose must
    // be used inside a ViewProvider", which sends them looking for a call they
    // never made.
    function Bare() {
      useSavedViews();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/useSavedViews must be used inside/);
  });
});
