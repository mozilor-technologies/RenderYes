import { describe, expect, it } from "vitest";
import { defineHostComponent } from "../src/define-host-component.js";
import { defineProps, field } from "@renderyes/site-sdk";

function TicketTable() {
  return null;
}

const validInput = {
  id: "TicketTable",
  version: "1.0.0",
  description: "A support ticket queue with approved columns.",
  props: defineProps({
    density: field.enum(["comfortable", "compact"], { default: "comfortable" }),
  }),
  paths: {
    rows: "/tickets/rows",
    state: "/tickets/state",
  },
  dataSlots: {
    rows: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["collection"] }] },
  },
  component: TicketTable,
};

describe("defineHostComponent", () => {
  it("produces both the semantic contract and the renderer implementation from one declaration", () => {
    const registered = defineHostComponent(validInput);

    // The host wrote no A2UI code, yet gets a usable renderer implementation.
    expect(registered.implementation).toBeDefined();
    expect(registered.definition.id).toBe("TicketTable");
    // Declared paths became immutable renderer bindings the plan cannot name.
    expect(registered.definition.renderer.props.rows).toEqual({ path: "/tickets/rows" });
    expect(registered.definition.renderer.props.state).toEqual({
      path: "/tickets/state",
    });
    // The data slot survived as a planner-bindable slot with its accepted contract.
    expect(registered.definition.dataSlots.rows.accepts).toEqual([
      { dataTypeId: "SupportTicket", shapes: ["collection"] },
    ]);
  });

  it("derives a default /<slotName> path for a data slot with no explicit path", () => {
    // Safe because the executor scopes each node instance's writes by its
    // own node id (see `scopedDataPath` in @renderyes/site-sdk), so two
    // instances of this component can never collide even with identical,
    // undecorated slot-name paths.
    const registered = defineHostComponent({
      id: "MinimalCard",
      description: "A minimal component with no explicit paths, version, or props.",
      dataSlots: {
        item: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["entity"] }] },
      },
      component: TicketTable,
    });
    expect(registered.definition.renderer.props.item).toEqual({ path: "/item" });
    expect(registered.definition.version).toBe("1.0.0");
  });

  it("lets an explicit path override the derived default for the same slot", () => {
    const registered = defineHostComponent({
      ...validInput,
      dataSlots: {
        rows: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["collection"] }] },
      },
      paths: { rows: "/custom/rows" },
    });
    expect(registered.definition.renderer.props.rows).toEqual({ path: "/custom/rows" });
  });

  it("keeps an explicit path with no matching slot (e.g. a state companion)", () => {
    const registered = defineHostComponent({
      id: "CardWithState",
      description: "A component whose state path has no matching data slot.",
      dataSlots: {
        rows: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["collection"] }] },
      },
      paths: { state: "/tickets/state" },
      component: TicketTable,
    });
    expect(registered.definition.renderer.props.rows).toEqual({ path: "/rows" });
    expect(registered.definition.renderer.props.state).toEqual({
      path: "/tickets/state",
    });
  });

  it("defaults state and errorMessage paths for a component with a data slot", () => {
    // A minimally registered data component — no explicit `paths` at all —
    // still gets a way to distinguish loading, empty, and failed data.
    // Without this default, only a host that hand-wrote `paths: { state:
    // ..., errorMessage: ... }` ever received these; every other data
    // component silently got no lifecycle signal at all.
    const registered = defineHostComponent({
      id: "MinimalDataCard",
      description: "A minimal data-bound component with no explicit paths.",
      dataSlots: {
        item: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["entity"] }] },
      },
      component: TicketTable,
    });
    expect(registered.definition.renderer.props.state).toEqual({ path: "/state" });
    expect(registered.definition.renderer.props.errorMessage).toEqual({
      path: "/errorMessage",
    });
  });

  it("does not default state or errorMessage for a component with no data slots", () => {
    // A purely presentational component (static props only) has no data
    // lifecycle to report — defaulting these here would be dead wiring.
    const registered = defineHostComponent({
      id: "StaticBanner",
      description: "A static component with no data slots.",
      props: defineProps({ title: field.string() }),
      component: TicketTable,
    });
    expect(registered.definition.renderer.props.state).toBeUndefined();
    expect(registered.definition.renderer.props.errorMessage).toBeUndefined();
  });

  it("does not default shared companions for a multi-slot composite layout", () => {
    // Each slot is filled by an independent request. One shared `/state` path
    // would have them all writing the same location, so whichever resolved
    // last would decide what the whole layout reported — a composite showing
    // "ready" while half its data is still in flight, or "failed" when only
    // one of three requests did. Its children report their own readiness.
    const registered = defineHostComponent({
      id: "OverviewLayout",
      description: "A composite layout fed by two independent requests.",
      dataSlots: {
        tickets: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["collection"] }] },
        summary: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["entity"] }] },
      },
      props: defineProps({ title: field.string() }),
      component: TicketTable,
    });
    // The slots themselves are still bound — only the shared companions are not.
    expect(registered.definition.renderer.props.tickets).toEqual({ path: "/tickets" });
    expect(registered.definition.renderer.props.summary).toEqual({ path: "/summary" });
    expect(registered.definition.renderer.props.state).toBeUndefined();
    expect(registered.definition.renderer.props.errorMessage).toBeUndefined();
    expect(registered.definition.renderer.props.sources).toBeUndefined();
  });

  it("still honours explicit companion paths on a multi-slot component", () => {
    // Opting in is the host's call: a layout that does render its own
    // aggregate status can say so, and nothing about the collision above
    // makes that invalid — only defaulting to it silently.
    const registered = defineHostComponent({
      id: "ExplicitOverviewLayout",
      description: "A composite layout that renders its own aggregate status.",
      dataSlots: {
        tickets: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["collection"] }] },
        summary: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["entity"] }] },
      },
      paths: { state: "/layout/state" },
      props: defineProps({ title: field.string() }),
      component: TicketTable,
    });
    expect(registered.definition.renderer.props.state).toEqual({ path: "/layout/state" });
  });

  it("lets an explicit path override the default state path", () => {
    const registered = defineHostComponent({
      id: "CustomStateCard",
      description: "A data component that overrides the default state path.",
      dataSlots: {
        item: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["entity"] }] },
      },
      paths: { state: "/custom/state" },
      component: TicketTable,
    });
    expect(registered.definition.renderer.props.state).toEqual({ path: "/custom/state" });
    expect(registered.definition.renderer.props.errorMessage).toEqual({
      path: "/errorMessage",
    });
  });

  it("rejects a planner-settable prop that collides with an immutable renderer binding", () => {
    // `rows` is a bound path; letting a plan also set it as a prop would let the
    // model overwrite host-controlled data placement.
    expect(() =>
      defineHostComponent({
        ...validInput,
        props: defineProps({ rows: field.string({ default: "" }) }),
      }),
    ).toThrow(/conflicts with a registered renderer binding/);
  });

  it("defaults provenance paths for a component with data slots", () => {
    const registered = defineHostComponent({
      id: "ProvenanceCard",
      description: "A data component that never declares provenance itself.",
      dataSlots: {
        item: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["entity"] }] },
      },
      props: defineProps({ title: field.string() }),
      component: TicketTable,
    });
    // Grounded, attributable output is the product's central claim, so it
    // cannot depend on each component author remembering to opt in.
    expect(registered.definition.renderer.props.sources).toEqual({ path: "/sources" });
    expect(registered.definition.renderer.props.asOf).toEqual({ path: "/asOf" });
  });

  it("does not default provenance paths for a component with no data slots", () => {
    const registered = defineHostComponent({
      id: "StaticProvenanceBanner",
      description: "A static component with no data slots.",
      props: defineProps({ title: field.string() }),
      component: TicketTable,
    });
    // Nothing was fetched, so there is nothing to attribute.
    expect(registered.definition.renderer.props.sources).toBeUndefined();
    expect(registered.definition.renderer.props.asOf).toBeUndefined();
  });
});
