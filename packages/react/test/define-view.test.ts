import { describe, expect, it } from "vitest";
import { defineView, ingestViews } from "../src/define-view.js";
import { field } from "@renderyes/site-sdk";

function TicketTable() {
  return null;
}

const ticketTableSpec = defineView({
  id: "TicketTable",
  description: "Displays a list of tickets as a table, one row per ticket.",
  props: { title: field.string() },
  dataSlots: { rows: { accepts: [{ shape: "collection" }] } },
  accessibility: { label: "Ticket table" },
});

/** What a bundler's eager glob produces: file path → module. */
function folder(entries: Record<string, unknown>): Record<string, unknown> {
  return entries;
}

describe("ingestViews", () => {
  it("registers a folder of view files without a separate registration module", () => {
    const registered = ingestViews(
      folder({
        "./views/ticket-table.view.tsx": { spec: ticketTableSpec, default: TicketTable },
      }),
    );

    expect(registered).toHaveLength(1);
    expect(registered[0].definition.id).toBe("TicketTable");
    // The contract the planner reads came from the file that defines the
    // component, which is the whole point of the convention.
    expect(registered[0].definition.description).toContain("one row per ticket");
    expect(registered[0].implementation).toBeDefined();
  });

  it("declares props from the field record, so a host writes them in one place", () => {
    const registered = ingestViews(
      folder({ "./views/a.view.tsx": { spec: ticketTableSpec, default: TicketTable } }),
    );

    const properties = registered[0].definition.props.jsonSchema.properties as Record<
      string,
      unknown
    >;
    expect(Object.keys(properties)).toEqual(["title"]);
  });

  it("ingests in filename order rather than the bundler's traversal order", () => {
    const registered = ingestViews(
      folder({
        "./views/zebra.view.tsx": {
          spec: defineView({ id: "Zebra", description: "Z." }),
          default: TicketTable,
        },
        "./views/alpha.view.tsx": {
          spec: defineView({ id: "Alpha", description: "A." }),
          default: TicketTable,
        },
      }),
    );

    expect(registered.map((entry) => entry.definition.id)).toEqual(["Alpha", "Zebra"]);
  });

  it("names the file when a view file forgets to export a spec", () => {
    expect(() =>
      ingestViews(folder({ "./views/orphan.view.tsx": { default: TicketTable } })),
    ).toThrow(/orphan\.view\.tsx does not export `spec`/);
  });

  it("rejects a spec that did not come from defineView", () => {
    // Looks right, isn't branded — so nothing validated the fields, and the
    // failure would otherwise surface as a malformed catalog much later.
    const handRolled = {
      id: "TicketTable",
      description: "Displays a list of tickets.",
      dataSlots: { rows: { accepts: [{ shape: "collection" }] } },
    };

    expect(() =>
      ingestViews(folder({ "./views/hand-rolled.view.tsx": { spec: handRolled, default: TicketTable } })),
    ).toThrow(/did not come from `defineView`/);
  });

  it("names the file when the component is missing, rather than registering a spec with nothing to render", () => {
    expect(() => ingestViews(folder({ "./views/no-default.view.tsx": { spec: ticketTableSpec } }))).toThrow(
      /no default component/,
    );
  });

  it("rejects two files claiming the same id, naming both", () => {
    const other = defineView({ id: "TicketTable", description: "A different table." });

    expect(() =>
      ingestViews(
        folder({
          "./views/a.view.tsx": { spec: ticketTableSpec, default: TicketTable },
          "./views/b.view.tsx": { spec: other, default: TicketTable },
        }),
      ),
    ).toThrow(/both declare the id "TicketTable": \.\/views\/a\.view\.tsx and \.\/views\/b\.view\.tsx/);
  });

  it("reports a lazy glob rather than silently ingesting nothing", () => {
    // `import.meta.glob` without `{ eager: true }` yields loader functions.
    expect(() => ingestViews(folder({ "./views/lazy.view.tsx": () => Promise.resolve({}) }))).toThrow(
      /Was the glob eager\?/,
    );
  });

  it("gives every slot a data-model path and single-slot views their lifecycle props", () => {
    const registered = ingestViews(
      folder({ "./views/ticket-table.view.tsx": { spec: ticketTableSpec, default: TicketTable } }),
    );

    const rendererProps = registered[0].definition.renderer.props as Record<string, unknown>;
    expect(rendererProps.rows).toEqual({ path: "/rows" });
    // A view author who reads nothing but `ViewProps` still receives these, and
    // an empty `sources` is what stops ungrounded data being presented as
    // authoritative — so ingestion has to wire them without being asked.
    expect(rendererProps.state).toEqual({ path: "/state" });
    expect(rendererProps.errorMessage).toEqual({ path: "/errorMessage" });
    expect(rendererProps.sources).toEqual({ path: "/sources" });
    expect(rendererProps.asOf).toEqual({ path: "/asOf" });
  });

  it("accepts an empty folder, so a host can add the glob before the first view", () => {
    expect(ingestViews(folder({}))).toEqual([]);
  });
});
