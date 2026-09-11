import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createDataTableView } from "../src/data-table.js";
import { createDetailPanelView } from "../src/detail-panel.js";
import { createRecordWithLinesView } from "../src/record-with-lines.js";
import { createCardGridView } from "../src/card-grid.js";
import { createItemListView } from "../src/item-list.js";
import { createMetricCardView } from "../src/metric-card.js";
import { resolveAxes } from "../src/charts.js";
import { deriveImageKey, deriveTitleKey } from "../src/shared.js";

/**
 * The value-reachability sweep: one canonical Relay-shaped record through
 * every starter component, asserting the money actually lands on screen.
 *
 * Shape-reachability asks "does some component accept this shape"; coverage
 * asks "is this data type renderable". Neither asks whether a *value* survives
 * to the DOM — and that gap is where five silent one-level-enumeration bugs
 * lived, each found by a live evaluation instead of by CI: a metric card
 * showing a currency code where the figure belonged, charts empty over
 * non-empty rows, a table column of "…", thumbnails never derived from
 * `thumbnail.url`, money vanishing from entity groups one hop deeper than the
 * last fix reached.
 *
 * The fixture is deliberately hostile in the way real APIs are: every number
 * nested, the image nested, and nothing renderable at the top level except
 * strings. If a new component ever enumerates one level deep, this file is
 * where it fails.
 */

const order = {
  id: "T3JkZXI6MTIz",
  status: "FULFILLED",
  created: "2026-08-01T10:00:00Z",
  total: { gross: { amount: 9325.71, currency: "USD" }, net: { amount: 8100.5 } },
  thumbnail: { url: "https://cdn.example.com/order.png" },
  lines: [
    {
      quantity: 2,
      totalPrice: { gross: { amount: 4662.85, currency: "USD" } },
      variant: { product: { name: "Aurora Lamp" } },
    },
  ],
};

const MONEY = "9,325.71";

afterEach(cleanup);

/** Money in, object placeholder out — asserted on the rendered text. */
function expectMoneyAndNoPlaceholder(container: HTMLElement, money = MONEY) {
  expect(container.textContent).toContain(money);
  expect(container.textContent).not.toContain("…");
}

describe("nested values reach the screen in every starter component", () => {
  it("data table: the money is a column, not a cell of …", () => {
    const Table = createDataTableView();
    const { container } = render(<Table rows={[order]} state="ready" />);
    expectMoneyAndNoPlaceholder(container);
  });

  it("detail panel: the Total group carries its figures, disambiguated", () => {
    const Panel = createDetailPanelView();
    const { container } = render(<Panel entity={order} state="ready" />);
    expectMoneyAndNoPlaceholder(container);
    // gross.amount pairs with its sibling currency and becomes one money
    // value labelled by its parent; net.amount has no currency anywhere in
    // its ancestry, so it stays a plain figure labelled by its path — the
    // two must still be distinguishable under the one "Total" heading.
    expect(screen.getByText("Gross")).toBeDefined();
    expect(screen.getByText("9,325.71 USD")).toBeDefined();
    expect(screen.getByText("Net · Amount")).toBeDefined();
    expect(screen.queryByText("Gross · Currency")).toBeNull();
  });

  it("record with lines: header money and line money both land", () => {
    const Record = createRecordWithLinesView();
    const { container } = render(<Record entity={order} state="ready" />);
    expectMoneyAndNoPlaceholder(container);
    expect(container.textContent).toContain("4,662.85");
    expect(container.textContent).toContain("Aurora Lamp");
  });

  it("card grid and item list: nested thumbnail and nested meta", () => {
    for (const factory of [createCardGridView, createItemListView]) {
      const List = factory();
      const { unmount, container } = render(<List items={[order]} state="ready" />);
      expectMoneyAndNoPlaceholder(container);
      const image = container.querySelector("img");
      expect(image?.getAttribute("src")).toBe("https://cdn.example.com/order.png");
      unmount();
    }
  });

  it("metric card and charts: covered by their own file, axes re-asserted here", () => {
    const Card = createMetricCardView();
    const { container } = render(<Card metric={order.total} state="ready" />);
    expectMoneyAndNoPlaceholder(container);
    const { yKeys } = resolveAxes([order], {});
    expect(yKeys).toContain("total.gross.amount");
  });

  it("derivations find nested images and never title a row …", () => {
    expect(deriveImageKey([order])).toBe("thumbnail.url");
    // A row with no usable top-level string still gets a real leaf as title,
    // not the first raw key (an object, which renders as "…").
    expect(deriveTitleKey([{ total: { gross: { amount: 1, currency: "USD" } } }])).toBe(
      "total.gross.currency",
    );
  });
});

/**
 * The round-4 class of miss: the plan fetched it, the payload carried it, and
 * the render layer lost it without a word — behind a column cap, behind leaf
 * enumeration treating money as three stats, behind arrays of objects having
 * no scalar leaves, and behind one dash meaning both "null" and "never
 * fetched". Fetched data renders or is declared missing; never neither.
 */
describe("fetched values are shown or declared, never silently dropped", () => {
  it("data table: sliced columns are counted and named, and the count is right", () => {
    const wide = [
      Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field_${i}`, `value ${i}`])),
    ];
    const Table = createDataTableView();
    render(<Table rows={wide} state="ready" />);
    // The cap itself is a legitimate layout default — the silence was the bug.
    expect(screen.getAllByRole("columnheader")).toHaveLength(8);
    const note = screen.getByText(/\+4 more fetched fields not shown/);
    expect(note.textContent).toContain("Field 8");
    expect(note.textContent).toContain("Field 11");
  });

  it("data table: no footnote when nothing was sliced", () => {
    const Table = createDataTableView();
    const { container } = render(<Table rows={[order]} state="ready" />);
    expect(container.textContent).not.toContain("more fetched field");
  });

  it("data table: under the cap, opaque identifiers yield to readable fields", () => {
    const rows = [
      { id: "T3JkZXI6MTIz", name: "Aurora Lamp", status: "OPEN" },
      { id: "T3JkZXI6NDU2", name: "Desk Mat", status: "CLOSED" },
    ];
    const Table = createDataTableView({ maxColumns: 2 });
    render(<Table rows={rows} state="ready" />);
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["Name", "Status"]);
    // Dropped, but named — not silently gone.
    expect(screen.getByText(/\+1 more fetched field not shown: Id\./)).toBeDefined();
  });

  it("data table: amount and currency render as one money value, not two columns", () => {
    const Table = createDataTableView();
    const { container } = render(<Table rows={[order]} state="ready" />);
    expect(screen.getByText("Total · Gross")).toBeDefined();
    expect(container.textContent).toContain("9,325.71 USD");
    // The consumed currency leaf is not a column of its own.
    expect(screen.queryByText("Total · Gross · Currency")).toBeNull();
    // No currency anywhere in net's ancestry, so it stays a plain figure.
    expect(screen.getByText("Total · Net · Amount")).toBeDefined();
  });

  it("data table: an array-of-objects field renders a summarizing cell", () => {
    const zones = [
      {
        name: "Europe",
        countries: [
          { country: "Andorra" },
          { country: "Albania" },
          { country: "Austria" },
          { country: "Belgium" },
        ],
      },
      { name: "Asia", countries: [{ country: "Japan" }] },
    ];
    const Table = createDataTableView();
    render(<Table rows={zones} state="ready" />);
    // Fetched (Europe carried 51 in the live eval) and previously rendered
    // nothing: no column, no warning — an array of objects has no scalar leaf.
    expect(screen.getByText("Countries")).toBeDefined();
    expect(screen.getByText("4 — Andorra, Albania, Austria, …")).toBeDefined();
    expect(screen.getByText("1 — Japan")).toBeDefined();
  });

  it("detail panel: an array-of-objects group field summarizes too", () => {
    const Panel = createDetailPanelView();
    render(
      <Panel
        entity={{
          name: "Europe",
          shipping: { carrier: "DHL", countries: [{ country: "Andorra" }, { country: "Albania" }] },
        }}
        state="ready"
      />,
    );
    expect(screen.getByText("Countries")).toBeDefined();
    expect(screen.getByText("2 — Andorra, Albania")).toBeDefined();
  });

  it("data table: a fetched null and a never-fetched field are different dashes", () => {
    const Table = createDataTableView({ columns: [{ key: "user.email", label: "Email" }] });
    const { container } = render(
      <Table
        rows={[
          // user null: the plan fetched the field, the record has no user.
          { user: null },
          // user projected without email: the plan never fetched the field.
          { user: { firstName: "Ada" } },
        ]}
        state="ready"
      />,
    );
    const cells = screen.getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(["—", "—"]);
    const notFetched = container.querySelectorAll('[title^="Not fetched"]');
    expect(notFetched).toHaveLength(1);
    expect(notFetched[0]?.getAttribute("aria-label")).toBe("Not fetched");
  });

  it("detail panel: a fetched null and a never-fetched field are different dashes", () => {
    const Panel = createDetailPanelView({
      fields: [
        { key: "user.email", label: "Email" },
        { key: "note", label: "Note" },
      ],
    });
    const { container } = render(
      <Panel entity={{ user: { firstName: "Ada" }, note: null }} state="ready" />,
    );
    const notFetched = container.querySelectorAll('[title^="Not fetched"]');
    expect(notFetched).toHaveLength(1);
    // The null renders the plain dash with no "not fetched" claim on it.
    const noteRow = screen.getByText("Note").parentElement!;
    expect(noteRow.textContent).toContain("—");
    expect(noteRow.querySelector('[title^="Not fetched"]')).toBeNull();
  });
});
