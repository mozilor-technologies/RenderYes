import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCardGrid,
  createCardGridView,
  createDataTable,
  createDataTableView,
  createDetailPanelView,
  createMetricCard,
  createMetricCardView,
  createRecordWithLines,
  createRecordWithLinesView,
  formatValue,
  humanize,
  isIdentifierKey,
} from "../src/index.js";

afterEach(cleanup);

const applications = [
  {
    application_id: "app-1",
    full_name: "Asha Nair",
    status: "pending",
    created_at: "2026-08-01T10:00:00Z",
    tapfiliate_synced: false,
  },
  {
    application_id: "app-2",
    full_name: "Ravi Kumar",
    status: "approved",
    created_at: "2026-08-02T11:30:00Z",
    tapfiliate_synced: true,
  },
];

const analytics = {
  total_applications: 128,
  approval_rate: 0.42,
  avg_tat_human: "2h 15m",
  status_counts: [{ status: "pending", count: 12 }],
};

describe("registration contract", () => {
  it("registers the table with a single structural collection slot and companions", () => {
    const { definition } = createDataTable();
    expect(definition.id).toBe("StarterDataTable");
    expect(Object.keys(definition.dataSlots)).toEqual(["rows"]);
    expect(definition.dataSlots.rows.accepts).toEqual([
      { shape: "collection" },
      { shape: "search-results" },
    ]);
    // Single-slot components get lifecycle + provenance paths defaulted.
    for (const key of ["rows", "state", "errorMessage", "sources", "asOf"]) {
      expect(definition.renderer.props).toHaveProperty(key);
    }
  });

  it("registers metric card against the metric shape with a planner-settable heading", () => {
    const { definition } = createMetricCard({ defaultHeading: "Programme stats" });
    expect(definition.dataSlots.metric.accepts).toEqual([{ shape: "metric" }]);
    const schema = definition.props.jsonSchema as {
      properties?: Record<string, { default?: unknown }>;
    };
    expect(schema.properties?.heading?.default).toBe("Programme stats");
  });

  it("honors id and acceptance overrides", () => {
    const { definition } = createCardGrid({
      id: "ApplicantCards",
      accepts: [{ shape: "collection", requires: [{ semanticType: "status" }] }],
    });
    expect(definition.id).toBe("ApplicantCards");
    expect(definition.dataSlots.items.accepts).toEqual([
      { shape: "collection", requires: [{ semanticType: "status" }] },
    ]);
  });
});

describe("data table view", () => {
  it("derives humanized columns and renders rows", () => {
    const Table = createDataTableView();
    render(<Table heading="Applications" rows={applications} state="ready" />);
    expect(screen.getByText("Applications")).toBeTruthy();
    expect(screen.getByText("Application id")).toBeTruthy();
    expect(screen.getByText("Full name")).toBeTruthy();
    expect(screen.getByText("Asha Nair")).toBeTruthy();
    // Booleans display as words, not "true"/"false".
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("respects explicit column specs, order, labels, and format", () => {
    const Table = createDataTableView({
      columns: [
        { key: "full_name", label: "Applicant" },
        { key: "status", format: (v) => String(v).toUpperCase() },
      ],
    });
    render(<Table rows={applications} state="ready" />);
    expect(screen.getByText("Applicant")).toBeTruthy();
    expect(screen.getByText("PENDING")).toBeTruthy();
    expect(screen.queryByText("Application id")).toBeNull();
  });

  it("caps derived columns", () => {
    const wide = [Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`col_${i}`, i]))];
    const Table = createDataTableView({ maxColumns: 3 });
    render(<Table rows={wide} state="ready" />);
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
  });

  it("shows loading before any state is written", () => {
    const Table = createDataTableView();
    render(<Table />);
    expect(screen.getByRole("status", { name: "Loading…" })).toBeTruthy();
  });

  it("shows the executor's sanitized error", () => {
    const Table = createDataTableView();
    render(<Table state="error" errorMessage="Upstream timed out" />);
    expect(screen.getByRole("alert").textContent).toBe("Upstream timed out");
  });

  it("shows the empty state", () => {
    const Table = createDataTableView({ messages: { empty: "No applications yet." } });
    render(<Table state="empty" rows={[]} />);
    expect(screen.getByText("No applications yet.")).toBeTruthy();
  });

  it("shows provenance when supplied", () => {
    // `sources` arrives as plain source-id strings — see visitNode in
    // @renderyes/site-sdk, which writes provenance.sources.map(s =>
    // s.sourceId). A previous version of this fixture used
    // { id, entity } objects, which the render code also (wrongly) expected
    // at the time — both sides were wrong the same way, so the mismatch
    // between this and real executor output went uncaught.
    const Table = createDataTableView();
    render(
      <Table
        rows={applications}
        state="ready"
        sources={["affiliate-applications"]}
        asOf="2026-08-09T08:00:00Z"
      />,
    );
    const footer = screen.getByText(/Source: affiliate-applications/);
    expect(footer.textContent).toContain("as of");
  });
});

describe("metric card view", () => {
  it("renders scalar fields as tiles and skips nested arrays", () => {
    const Card = createMetricCardView();
    render(<Card heading="Analytics" metric={analytics} state="ready" />);
    expect(screen.getByText("Total applications")).toBeTruthy();
    expect(screen.getByText("128")).toBeTruthy();
    expect(screen.queryByText("Status counts")).toBeNull();
  });

  it("applies per-key formats to derived entries and leaves other keys alone", () => {
    const Card = createMetricCardView({
      formats: { approval_rate: (v) => `${((v as number) * 100).toFixed(0)}%` },
    });
    render(<Card metric={analytics} state="ready" />);
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("128")).toBeTruthy();
  });

  it("respects explicit entries with formatting", () => {
    const Card = createMetricCardView({
      entries: [
        {
          key: "approval_rate",
          label: "Approval rate",
          format: (v) => `${((v as number) * 100).toFixed(1)}%`,
        },
      ],
    });
    render(<Card metric={analytics} state="ready" />);
    expect(screen.getByText("42.0%")).toBeTruthy();
    expect(screen.queryByText("Total applications")).toBeNull();
  });
});

describe("detail panel view", () => {
  it("renders labeled rows for scalar and scalar-array fields", () => {
    const Panel = createDetailPanelView();
    render(
      <Panel
        entity={{
          full_name: "Asha Nair",
          promotion_methods: ["blog", "newsletter"],
        }}
        state="ready"
      />,
    );
    expect(screen.getByText("Full name")).toBeTruthy();
    expect(screen.getByText("blog, newsletter")).toBeTruthy();
  });

  /**
   * This used to assert the opposite — that a nested object was absent. Dropping
   * it was the behaviour, and on a real entity it discards about half the
   * fields: a Shopify order carries roughly forty scalars, twenty single nested
   * objects and fifteen lists.
   */
  it("renders a nested object as its own titled group", () => {
    const Panel = createDetailPanelView();
    render(
      <Panel
        entity={{
          reference: "SO-1042",
          shippingAddress: { city: "Kochi", postalCode: "682001" },
        }}
        state="ready"
      />,
    );
    expect(screen.getByText("Reference")).toBeTruthy();
    // The group is titled once, so the leaf is labelled without its prefix.
    expect(screen.getByText("Shipping address")).toBeTruthy();
    expect(screen.getByText("City")).toBeTruthy();
    expect(screen.getByText("Kochi")).toBeTruthy();
  });

  /**
   * The addressing fix, which everything else here depends on. An approved
   * output field is a dotted path (`category.name`) and the payload nests
   * accordingly, but the renderers did a flat `record[key]` lookup — so a field
   * the owner had explicitly approved resolved to nothing and rendered empty.
   */
  it("resolves an explicitly named nested field by its dotted path", () => {
    const Panel = createDetailPanelView({
      fields: [{ key: "category.name", label: "Category" }],
    });
    render(<Panel entity={{ id: "p-1", category: { name: "Outerwear" } }} state="ready" />);
    expect(screen.getByText("Category")).toBeTruthy();
    expect(screen.getByText("Outerwear")).toBeTruthy();
  });

  it("summarizes an array of objects in one row, never flattened and never dropped", () => {
    // A collection inside an entity is a table (`createRecordWithLines`), not
    // forty `lines.0.sku` rows — but it is fetched data, so dropping it
    // silently is worse than either. One summary row: count, then titles.
    const Panel = createDetailPanelView();
    render(
      <Panel
        entity={{ reference: "SO-1042", lines: [{ sku: "A-1", quantity: 2 }] }}
        state="ready"
      />,
    );
    expect(screen.getByText("Reference")).toBeTruthy();
    expect(screen.getByText("Lines")).toBeTruthy();
    expect(screen.getByText("1 — A-1")).toBeTruthy();
    // Still not flattened into dotted rows.
    expect(screen.queryByText("Sku")).toBeNull();
    expect(screen.queryByText("Quantity")).toBeNull();
  });

  it("refuses to walk a prototype-polluting path", () => {
    const Panel = createDetailPanelView({ fields: [{ key: "__proto__.polluted" }] });
    render(<Panel entity={{ id: "p-1" }} state="ready" />);
    // Resolves to nothing rather than reaching the prototype chain.
    expect(screen.queryByText("Polluted")).toBeNull();
  });
});

describe("card grid view", () => {
  it("derives a title from the first human-readable string field, never an id", () => {
    const Grid = createCardGridView();
    render(<Grid items={applications} state="ready" />);
    // application_id is the first string field but names an identifier, so
    // the title falls to full_name — and the id stays out of the body too.
    expect(screen.getByText("Asha Nair")).toBeTruthy();
    expect(screen.getByText(/Status: pending/)).toBeTruthy();
    expect(screen.queryByText("app-1")).toBeNull();
    expect(screen.queryByText(/Application id/)).toBeNull();
  });

  it("uses configured title and body fields", () => {
    const Grid = createCardGridView({
      titleKey: "full_name",
      bodyFields: [{ key: "status", label: "Stage" }],
    });
    render(<Grid items={applications} state="ready" />);
    expect(screen.getByText("Asha Nair")).toBeTruthy();
    expect(screen.getByText(/Stage: pending/)).toBeTruthy();
  });
});

describe("formatting", () => {
  it("humanizes snake_case and camelCase", () => {
    expect(humanize("application_id")).toBe("Application id");
    expect(humanize("avgTatHuman")).toBe("Avg tat human");
  });

  it("formats nulls, booleans, numbers, dates, and nested values", () => {
    expect(formatValue(null)).toBe("—");
    expect(formatValue(true)).toBe("Yes");
    expect(formatValue(12345)).toBe((12345).toLocaleString());
    expect(formatValue("2026-08-01")).toBe(new Date("2026-08-01").toLocaleDateString());
    expect(formatValue([{ a: 1 }, { a: 2 }])).toBe("2 items");
    expect(formatValue({ nested: true })).toBe("…");
  });

  it("keeps date-times brief: medium date, short time, no seconds", () => {
    const iso = "2026-08-01T10:00:00Z";
    expect(formatValue(iso)).toBe(
      new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    );
  });
});

describe("identifier detection", () => {
  it("recognizes trailing id/uuid/key words across casings", () => {
    for (const key of ["id", "uuid", "application_id", "userId", "itemUuid", "apiKey", "primary-key", "applicationID"]) {
      expect(isIdentifierKey(key), key).toBe(true);
    }
  });

  it("leaves whole words that merely contain id/key alone", () => {
    for (const key of ["paid", "grid", "valid", "keyboard", "monkey", "identity", "name", "idle_time"]) {
      expect(isIdentifierKey(key), key).toBe(false);
    }
  });
});

describe("identifier-aware derivation (the p_9 regression)", () => {
  // The exact PantryQL shape that produced id-as-title "p_9" in the wild.
  const pantry = [
    { id: "p_9", name: "Spinach", quantity: 120, unit: "g" },
    { id: "p_1", name: "Rice", quantity: 900, unit: "g" },
  ];

  it("card grid titles with the name, never the id — even though id comes first", () => {
    const Grid = createCardGridView();
    render(<Grid items={pantry} state="ready" />);
    expect(screen.getByText("Spinach")).toBeTruthy();
    expect(screen.getByText(/Quantity: 120/)).toBeTruthy();
    expect(screen.queryByText("p_9")).toBeNull();
    expect(screen.queryByText(/Id:/)).toBeNull();
  });

  it("prefers a name/title/label field over an earlier non-id string", () => {
    const Grid = createCardGridView();
    render(<Grid items={[{ id: "p_9", sku: "SKU-42", name: "Spinach" }]} state="ready" />);
    expect(screen.getByText("Spinach")).toBeTruthy();
    // sku is still a fine body field — it just doesn't get to be the title.
    expect(screen.getByText(/Sku: SKU-42/)).toBeTruthy();
  });

  it("falls back to Item N rather than titling with an id when nothing readable exists", () => {
    const Grid = createCardGridView();
    render(<Grid items={[{ id: "p_9", quantity: 120 }]} state="ready" />);
    expect(screen.getByText("Item 1")).toBeTruthy();
    expect(screen.queryByText("p_9")).toBeNull();
  });

  it("data table demotes identifier columns to the end instead of leading with them", () => {
    const Table = createDataTableView();
    render(<Table rows={pantry} state="ready" />);
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["Name", "Quantity", "Unit", "Id"]);
  });

  it("data table never grows a column of \u2026 for a nested object", () => {
    const Table = createDataTableView();
    render(
      <Table
        rows={[
          { name: "Asha", address: { city: "Kochi" } },
          { name: "Ravi", address: { city: "Pune" } },
        ]}
        state="ready"
      />,
    );
    expect(screen.getByText("Name")).toBeTruthy();
    // The object itself never becomes a column; its leaf does, and carries the
    // value that used to render as "\u2026".
    expect(screen.queryByText("Address")).toBeNull();
    expect(screen.getByText("Address \u00b7 City")).toBeTruthy();
    expect(screen.getByText("Kochi")).toBeTruthy();
    expect(screen.queryByText("\u2026")).toBeNull();
  });

  it("data table keeps a column where objects only sometimes appear", () => {
    const Table = createDataTableView();
    render(
      <Table
        rows={[
          { name: "Asha", note: { rich: true } },
          { name: "Ravi", note: "plain text" },
        ]}
        state="ready"
      />,
    );
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.getByText("plain text")).toBeTruthy();
  });

  /**
   * The seam between the two halves of the merge.
   *
   * `isIdentifierKey` judges a dotted path on its last word, which is what
   * makes it work at all on leaf paths — but it means the identifier rule now
   * prunes *nested* leaves, and reaching nested leaves is the whole point of
   * the enumerator it filters. Both directions are pinned here: a nested id is
   * pruned (or demoted), and a nested value whose last word merely sits next to
   * one is not.
   */
  it("prunes nested identifiers without touching the nested values beside them", () => {
    const Table = createDataTableView();
    render(
      <Table
        rows={[
          {
            name: "Spinach",
            total: { gross: { amount: 120, currency: "INR" } },
            category: { id: "c_1", name: "Greens" },
          },
        ]}
        state="ready"
      />,
    );
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    // The nested money leaf the leaf walk exists to reach is still a column —
    // as one column, since the amount and its currency sibling collapse into a
    // single formatted value rather than two co-equal ones.
    expect(headers).toContain("Total \u00b7 Gross");
    expect(headers).not.toContain("Total \u00b7 Gross \u00b7 Currency");
    expect(headers).toContain("Category \u00b7 Name");
    // And the nested identifier is demoted rather than leading.
    expect(headers[headers.length - 1]).toBe("Category \u00b7 Id");
  });

  it("metric card tiles a nested figure and never a nested identifier", () => {
    const Card = createMetricCardView();
    render(
      <Card
        metric={{ report: { id: "r_77" }, total: { gross: { amount: 12, currency: "INR" } } }}
        state="ready"
      />,
    );
    // The figure is tiled with its currency, under the parent's label — the
    // amount and currency leaves collapse into one stat rather than two.
    expect(screen.getByText("12 INR")).toBeTruthy();
    expect(screen.getByText("Total \u00b7 Gross")).toBeTruthy();
    // And the nested identifier is not a stat at all.
    expect(screen.queryByText("r_77")).toBeNull();
    expect(screen.queryByText("Report \u00b7 Id")).toBeNull();
  });

  it("metric card never tiles an identifier", () => {
    const Card = createMetricCardView();
    render(
      <Card metric={{ report_id: "r_77", total_items: 12, low_stock: 3 }} state="ready" />,
    );
    expect(screen.getByText("Total items")).toBeTruthy();
    expect(screen.queryByText("Report id")).toBeNull();
    expect(screen.queryByText("r_77")).toBeNull();
  });

  it("metric card still tiles an id the host explicitly asks for", () => {
    const Card = createMetricCardView({ entries: [{ key: "report_id", label: "Report" }] });
    render(<Card metric={{ report_id: "r_77", total_items: 12 }} state="ready" />);
    expect(screen.getByText("r_77")).toBeTruthy();
  });

  it("detail panel keeps ids but sinks them to the bottom, muted", () => {
    const Panel = createDetailPanelView();
    const { container } = render(
      <Panel
        entity={{ id: "p_9", full_name: "Asha Nair", status: "pending" }}
        state="ready"
      />,
    );
    const labels = [...container.querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(labels).toEqual(["Full name", "Status", "Id"]);
    const idValue = [...container.querySelectorAll("dd")].at(-1)!;
    expect(idValue.textContent).toBe("p_9");
    expect(idValue.getAttribute("style")).toContain("--iv-starter-muted");
    // The human-readable fields stay unmuted.
    const nameValue = [...container.querySelectorAll("dd")][0]!;
    expect(nameValue.getAttribute("style") ?? "").not.toContain("--iv-starter-muted");
  });
});

describe("theming", () => {
  it("carries stable part classes plus host classNames, and drops inline styles when unstyled", () => {
    const Table = createDataTableView({
      unstyled: true,
      classNames: { root: "bg-white dark:bg-gray-800", table: "w-full" },
    });
    const { container } = render(<Table rows={applications} state="ready" />);
    const root = container.querySelector("section");
    expect(root?.className).toBe("iv-starter-root bg-white dark:bg-gray-800");
    expect(root?.getAttribute("style")).toBeNull();
    expect(container.querySelector("table")?.className).toBe("iv-starter-table w-full");
  });
});

describe("streamed composes", () => {
  it("renders a loading state for a slot whose request has not settled", () => {
    // The frame that arrives before any data: components are known, every slot
    // is pending. Without this the skeleton renders as an empty result, which
    // tells a visitor there is nothing rather than not yet.
    const Table = createDataTableView();
    render(<Table heading="Tickets" rows={[]} state="pending" />);
    expect(screen.getByRole("status", { name: "Loading…" })).toBeTruthy();
    expect(screen.queryByText("No matching records.")).toBeNull();
  });
});

describe("truncated results", () => {
  it("says so when a row budget cut the result short", () => {
    // The runtime always knew; nothing on screen said it, so every total was
    // wrong in a way the view did not disclose.
    const Table = createDataTableView();
    render(
      <Table
        heading="Orders"
        rows={[{ id: 1 }, { id: 2 }]}
        state="ready"
        completeness={{ complete: false, truncated: true, rowCount: 2, totalRows: 2500 }}
      />,
    );
    expect(screen.getByText(/Showing 2 of 2500/)).toBeTruthy();
    expect(screen.getByText(/totals and counts are incomplete/)).toBeTruthy();
  });

  it("styles the notice like the provenance footer instead of a bare browser <p>", () => {
    // `truncated` was missing from the styles map, so the notice rendered
    // with browser-default margins and full-size text inside an otherwise
    // styled component.
    const Table = createDataTableView();
    render(
      <Table
        rows={[{ name: "A" }]}
        state="ready"
        completeness={{ truncated: true, rowCount: 1, totalRows: 10 }}
      />,
    );
    const notice = screen.getByText(/cut short/);
    expect(notice.className).toBe("iv-starter-truncated");
    expect(notice.getAttribute("style")).toContain("--iv-starter-muted");
  });

  it("says nothing when the result is complete", () => {
    const Table = createDataTableView();
    render(
      <Table
        heading="Orders"
        rows={[{ id: 1 }]}
        state="ready"
        completeness={{ complete: true, truncated: false, rowCount: 1 }}
      />,
    );
    expect(screen.queryByText(/Showing/)).toBeNull();
  });
});

describe("record with lines view", () => {
  const order = {
    reference: "SO-1042",
    status: "fulfilled",
    lines: [
      { sku: "A-1", quantity: 2, price: 19.5 },
      { sku: "B-7", quantity: 1, price: 4 },
    ],
  };

  /**
   * The case the detail panel could not render at all. An order's line items
   * arrive inside the approved entity payload and were dropped, which on an
   * order is most of the answer.
   */
  it("renders the record's scalars and its embedded array as a table", () => {
    const View = createRecordWithLinesView();
    render(<View entity={order} state="ready" />);

    expect(screen.getByText("Reference")).toBeTruthy();
    expect(screen.getByText("SO-1042")).toBeTruthy();
    // The array becomes a titled table, not forty `lines.0.sku` rows.
    expect(screen.getByText("Lines")).toBeTruthy();
    expect(screen.getByText("Sku")).toBeTruthy();
    expect(screen.getByText("A-1")).toBeTruthy();
    expect(screen.getByText("B-7")).toBeTruthy();
  });

  it("takes columns from the union of the rows, not just the first", () => {
    // A second row carrying a key the first lacks would otherwise be invisible.
    const View = createRecordWithLinesView();
    render(
      <View
        entity={{ id: "1", lines: [{ sku: "A-1" }, { sku: "B-7", discount: "10%" }] }}
        state="ready"
      />,
    );
    expect(screen.getByText("Discount")).toBeTruthy();
    expect(screen.getByText("10%")).toBeTruthy();
  });

  it("says so when it shows fewer lines than the record carries", () => {
    const View = createRecordWithLinesView({ maximumLinesShown: 1 });
    render(<View entity={order} state="ready" />);
    // A shortened list presented as the whole one is a wrong answer, not a
    // smaller one — the same reason the runtime reports `truncated`.
    expect(screen.getByText("Showing 1 of 2.")).toBeTruthy();
    expect(screen.queryByText("B-7")).toBeNull();
  });

  it("ignores an array of scalars, which belongs in the header", () => {
    const View = createRecordWithLinesView();
    render(<View entity={{ id: "1", tags: ["a", "b"] }} state="ready" />);
    expect(screen.getByText("Tags")).toBeTruthy();
    expect(screen.getByText("a, b")).toBeTruthy();
  });

  it("registers as an entity component", () => {
    const registered = createRecordWithLines();
    expect(registered.definition.dataSlots.entity.accepts).toEqual([{ shape: "entity" }]);
  });
});
