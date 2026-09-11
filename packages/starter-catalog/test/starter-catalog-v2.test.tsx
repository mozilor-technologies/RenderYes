import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBarChartDefinition,
  createCardGridView,
  createDataTableView,
  createItemList,
  createItemListView,
  createLineChartDefinition,
  shadcnStarterTheme,
} from "../src/index.js";
import {
  createBarChart,
  createBarChartView,
  createDonutChart,
  createDonutChartView,
  createLineChart,
  resolveAxes,
} from "../src/charts.js";
import { createDonutChartDefinition } from "../src/chart-definitions.js";

afterEach(cleanup);

const recipes = [
  { id: "r1", title: "Dal Tadka", cuisine: "Indian", cookTimeMinutes: 30 },
  { id: "r2", title: "Pasta Aglio", cuisine: "Italian", cookTimeMinutes: 20 },
];

const weekly = [
  { week: "2026-W01", signups: 12, churn: 3 },
  { week: "2026-W02", signups: 19, churn: 2 },
];

describe("row/card/item activation", () => {
  it("makes table rows clickable when getRowHref returns a URL", () => {
    const onRowActivate = vi.fn();
    const Table = createDataTableView({
      getRowHref: (row) => `#/recipes/${row.id}`,
      onRowActivate,
    });
    render(<Table rows={recipes} state="ready" />);

    const row = screen.getByText("Dal Tadka").closest("tr")!;
    expect(row.getAttribute("role")).toBe("link");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.className).toContain("iv-starter-clickable");
    expect(row.style.cursor).toBe("pointer");

    fireEvent.click(row);
    expect(onRowActivate).toHaveBeenCalledWith(recipes[0], "#/recipes/r1");
  });

  it("activates from the keyboard with Enter", () => {
    const onRowActivate = vi.fn();
    const Table = createDataTableView({ onRowActivate });
    render(<Table rows={recipes} state="ready" />);
    fireEvent.keyDown(screen.getByText("Pasta Aglio").closest("tr")!, { key: "Enter" });
    expect(onRowActivate).toHaveBeenCalledWith(recipes[1], undefined);
  });

  it("leaves rows plain when getRowHref declines a record and nothing else is configured", () => {
    const Table = createDataTableView({
      getRowHref: (row) => (row.id === "r1" ? "#/recipes/r1" : undefined),
    });
    render(<Table rows={recipes} state="ready" />);
    expect(screen.getByText("Dal Tadka").closest("tr")!.getAttribute("role")).toBe("link");
    expect(screen.getByText("Pasta Aglio").closest("tr")!.getAttribute("role")).toBeNull();
  });

  it("stays completely inert with no activation options — the pre-v2 contract", () => {
    const Table = createDataTableView();
    render(<Table rows={recipes} state="ready" />);
    const row = screen.getByText("Dal Tadka").closest("tr")!;
    expect(row.getAttribute("role")).toBeNull();
    expect(row.className).not.toContain("iv-starter-clickable");
  });

  it("makes cards clickable through getCardHref/onCardActivate", () => {
    const onCardActivate = vi.fn();
    const Grid = createCardGridView({
      titleKey: "title",
      getCardHref: (item) => `#/recipes/${item.id}`,
      onCardActivate,
    });
    render(<Grid items={recipes} state="ready" />);
    const card = screen.getByText("Dal Tadka").closest("article")!;
    expect(card.getAttribute("role")).toBe("link");
    fireEvent.click(card);
    expect(onCardActivate).toHaveBeenCalledWith(recipes[0], "#/recipes/r1");
  });
});

describe("data table search", () => {
  it("filters rows against the displayed cell text", () => {
    const Table = createDataTableView({ searchable: true });
    render(<Table rows={recipes} state="ready" />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "italian" } });
    expect(screen.getByText("Pasta Aglio")).toBeTruthy();
    expect(screen.queryByText("Dal Tadka")).toBeNull();
  });

  it("says so when nothing matches, and recovers when cleared", () => {
    const Table = createDataTableView({ searchable: true });
    render(<Table rows={recipes} state="ready" />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("No rows match your search.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("Dal Tadka")).toBeTruthy();
  });

  it("renders no search box unless asked", () => {
    const Table = createDataTableView();
    render(<Table rows={recipes} state="ready" />);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});

describe("item list", () => {
  it("registers a single structural collection slot", () => {
    const { definition } = createItemList();
    expect(definition.id).toBe("StarterItemList");
    expect(definition.dataSlots.items.accepts).toEqual([
      { shape: "collection" },
      { shape: "search-results" },
    ]);
  });

  it("derives a title line and a meta line per item", () => {
    const List = createItemListView();
    render(<List heading="Recipes" items={recipes} state="ready" />);
    // id comes first but names an identifier; title is the field that says
    // it names the record, and the id stays out of the meta line.
    expect(screen.getByText("Dal Tadka")).toBeTruthy();
    expect(screen.getByText(/Cuisine: Indian/)).toBeTruthy();
    expect(screen.queryByText("r1")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("honors explicit title/meta and item activation", () => {
    const onItemActivate = vi.fn();
    const List = createItemListView({
      titleKey: "title",
      metaFields: [{ key: "cuisine", label: "Cuisine" }],
      onItemActivate,
    });
    render(<List items={recipes} state="ready" />);
    expect(screen.getByText(/Cuisine: Indian/)).toBeTruthy();
    fireEvent.click(screen.getByText("Dal Tadka").closest("li")!);
    expect(onItemActivate).toHaveBeenCalledWith(recipes[0], undefined);
  });
});

describe("charts", () => {
  it("registers charts against grouped collections only", () => {
    expect(createBarChart().definition.id).toBe("StarterBarChart");
    expect(createLineChart().definition.id).toBe("StarterLineChart");
    // `requiresGrouping` is the contract change that stopped raw order rows
    // from rendering as a "trend": a chart binds a collection only when the
    // feeding request grouped and aggregated it.
    expect(createBarChart().definition.dataSlots.rows.accepts).toEqual([
      { shape: "collection", requiresGrouping: true },
    ]);
    expect(createLineChart().definition.dataSlots.rows.accepts).toEqual([
      { shape: "collection", requiresGrouping: true },
      { shape: "time-series" },
    ]);
  });

  it("derives x from the first string field and y from numeric fields", () => {
    expect(resolveAxes(weekly, {})).toEqual({
      xKey: "week",
      yKeys: ["signups", "churn"],
    });
    expect(resolveAxes(weekly, { yKeys: ["signups"] })).toEqual({
      xKey: "week",
      yKeys: ["signups"],
    });
  });

  it("skips identifier fields for the x axis when a readable string exists", () => {
    // The shape that charted axis labels p_1…p_9: id is the first string
    // field, but the axis (and the donut's slice names, same resolver)
    // should read the name.
    const pantry = [
      { id: "p_1", name: "Spinach", quantity: 120 },
      { id: "p_9", name: "Rice", quantity: 900 },
    ];
    expect(resolveAxes(pantry, {})).toEqual({ xKey: "name", yKeys: ["quantity"] });
  });

  it("still uses an id axis when it is the only string field", () => {
    // An id-labeled axis beats an unlabeled one.
    expect(resolveAxes([{ id: "p_1", quantity: 120 }], {}).xKey).toBe("id");
  });

  it("honors an explicit xKey even when it names an identifier", () => {
    const pantry = [{ id: "p_1", name: "Spinach", quantity: 120 }];
    expect(resolveAxes(pantry, { xKey: "id" }).xKey).toBe("id");
  });

  it("caps derived series", () => {
    const wide = [
      Object.fromEntries([
        ["label", "a"],
        ...Array.from({ length: 6 }, (_, i) => [`m${i}`, i]),
      ]),
    ];
    expect(resolveAxes(wide, { maxSeries: 2 }).yKeys).toHaveLength(2);
  });

  it("keeps the recharts-free definitions identical to the /charts contracts", () => {
    // A server publishing createBarChartDefinition() (main entry, no
    // recharts) and a browser registering createBarChart() (/charts entry)
    // must agree on the contract — both are built from the same host input.
    for (const [defOnly, full] of [
      [createBarChartDefinition(), createBarChart().definition],
      [createLineChartDefinition(), createLineChart().definition],
    ] as const) {
      expect(defOnly.id).toBe(full.id);
      expect(defOnly.version).toBe(full.version);
      expect(defOnly.description).toBe(full.description);
      expect(defOnly.dataSlots).toEqual(full.dataSlots);
      expect(defOnly.renderer.props).toEqual(full.renderer.props);
      expect(defOnly.props.jsonSchema).toEqual(full.props.jsonSchema);
    }
  });

  it("renders the shell states and a chart container when ready", () => {
    const Chart = createBarChartView();
    const { container, rerender } = render(<Chart heading="Signups" />);
    expect(screen.getByRole("status", { name: "Loading…" })).toBeTruthy();
    rerender(<Chart heading="Signups" rows={weekly} state="ready" />);
    expect(container.querySelector(".iv-starter-chart")).toBeTruthy();
  });
});

describe("data table sorting", () => {
  it("sorts by raw value on header click and reverses on the second", () => {
    const Table = createDataTableView({ sortable: true, columns: [{ key: "cookTimeMinutes" }, { key: "title" }] });
    render(<Table rows={recipes} state="ready" />);
    const header = screen.getByText("Cook time minutes");
    expect(header.getAttribute("aria-sort")).toBe("none");

    fireEvent.click(header);
    let cells = screen.getAllByRole("row").slice(1).map((r) => r.firstChild!.textContent);
    expect(cells).toEqual(["20", "30"]);

    fireEvent.click(screen.getByText(/Cook time minutes/));
    cells = screen.getAllByRole("row").slice(1).map((r) => r.firstChild!.textContent);
    expect(cells).toEqual(["30", "20"]);
  });

  it("adds no sorting affordances unless asked", () => {
    const Table = createDataTableView();
    render(<Table rows={recipes} state="ready" />);
    expect(screen.getByText("Title").getAttribute("aria-sort")).toBeNull();
  });
});

describe("donut chart", () => {
  it("registers against the collection shape with a drift-pinned definition", () => {
    const full = createDonutChart().definition;
    const defOnly = createDonutChartDefinition();
    expect(full.id).toBe("StarterDonutChart");
    expect(defOnly.dataSlots).toEqual(full.dataSlots);
    expect(defOnly.props.jsonSchema).toEqual(full.props.jsonSchema);
  });

  it("renders shell states and a chart container when ready", () => {
    const Donut = createDonutChartView();
    const { container, rerender } = render(<Donut heading="Share" />);
    expect(screen.getByRole("status", { name: "Loading…" })).toBeTruthy();
    rerender(<Donut heading="Share" rows={weekly} state="ready" />);
    expect(container.querySelector(".iv-starter-chart")).toBeTruthy();
  });
});

describe("image-aware cards and lists", () => {
  const products = [
    { name: "Laptop stand", photo: "https://cdn.example.com/stand.jpg", price: 51 },
    { name: "Desk mat", photo: "https://cdn.example.com/mat.png", price: 19 },
  ];

  it("detects an image field, renders it, and keeps it out of title and body text", () => {
    const Grid = createCardGridView();
    const { container } = render(<Grid items={products} state="ready" />);
    const img = container.querySelector("img.iv-starter-cardImage")!;
    expect(img.getAttribute("src")).toBe("https://cdn.example.com/stand.jpg");
    expect(img.getAttribute("alt")).toBe("Laptop stand");
    // The URL is neither the derived title nor printed as body text.
    expect(screen.getByText("Laptop stand")).toBeTruthy();
    expect(screen.queryByText(/https:\/\//)).toBeNull();
  });

  it("renders a root-relative image path — how a CMS serves its own media", () => {
    // Payload and Strapi return `/api/media/file/x.jpg`, not an absolute URL.
    // Before this, even an EXPLICIT imageKey refused to render one: the render
    // gate shared the absolute-only detection regex, so a host that declared
    // the field an image still got text-only cards with no error.
    const articles = [
      { title: "Marathon record", heroImage: { url: "/api/media/file/bt-14.jpg" } },
    ];
    const Grid = createCardGridView({ titleKey: "title" });
    const { container } = render(<Grid items={articles} state="ready" />);
    const img = container.querySelector("img.iv-starter-cardImage")!;
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("/api/media/file/bt-14.jpg");
  });

  it("still refuses a path without an image extension", () => {
    const rows = [{ title: "Row", link: "/posts/some-article" }];
    const Grid = createCardGridView({ titleKey: "title" });
    const { container } = render(<Grid items={rows} state="ready" />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows list thumbnails and honors imageKey: false", () => {
    const List = createItemListView();
    const { container, unmount } = render(<List items={products} state="ready" />);
    expect(container.querySelector("img.iv-starter-itemThumb")).toBeTruthy();
    unmount();

    const Plain = createItemListView({ imageKey: false });
    const { container: c2 } = render(<Plain items={products} state="ready" />);
    expect(c2.querySelector("img")).toBeNull();
  });
});

describe("shadcn theme preset", () => {
  it("spreads into a factory as unstyled + token classes, with overrides appended", () => {
    const Table = createDataTableView({
      ...shadcnStarterTheme({ root: "my-extra" }),
    });
    const { container } = render(<Table rows={recipes} state="ready" />);
    const root = container.querySelector("section")!;
    expect(root.className).toContain("iv-starter-root");
    expect(root.className).toContain("bg-card");
    expect(root.className).toContain("my-extra");
    expect(root.getAttribute("style")).toBeNull();
    expect(container.querySelector("table")!.className).toContain("iv-starter-table");
  });

  it("covers the completeness notice and the loading skeleton with token classes", () => {
    // These parts were missing from the preset, so shadcn hosts rendered a
    // browser-default <p> for the notice and invisible bare <span>s while
    // loading.
    const Table = createDataTableView({ ...shadcnStarterTheme() });
    const { container, rerender } = render(<Table heading="Orders" />);
    const bar = container.querySelector(".iv-starter-skeletonBar")!;
    expect(bar.className).toContain("animate-pulse");
    expect(bar.className).toContain("bg-muted");

    rerender(
      <Table
        heading="Orders"
        rows={[{ name: "A" }]}
        state="ready"
        completeness={{ truncated: true, rowCount: 1, totalRows: 9 }}
      />,
    );
    const notice = screen.getByText(/cut short/);
    expect(notice.className).toContain("iv-starter-truncated");
    expect(notice.className).toContain("text-muted-foreground");
  });
});

/**
 * The v2 components were written against the three slot states that existed
 * then — ready, empty, error — while a streamed compose also writes `pending`
 * for a slot whose request has not settled, and `completeness` when the row
 * budget cut a result short. Both reach these components only because each one
 * spreads `{...companions}` into `StateShell`; nothing asserted that, so a
 * component that destructured its props instead would silently drop a skeleton
 * frame and show a truncated result as if it were whole.
 */
describe("streamed slot state reaches the v2 components", () => {
  /** Each collection component with the prop name it takes its rows under. */
  const components = [
    ["item list", createItemListView(), "items"],
    ["card grid", createCardGridView(), "items"],
    ["data table", createDataTableView(), "rows"],
  ] as const;

  for (const [name, View, rowsProp] of components) {
    it(`${name}: shows a loading frame while the request is still running`, () => {
      render(<View heading="Recipes" {...({ [rowsProp]: [] } as never)} state="pending" />);
      expect(screen.getByRole("status", { name: "Loading…" })).toBeTruthy();
      // Not the empty message: nothing has come back yet, so "no matching
      // records" would be a claim about data that has not arrived.
      expect(screen.queryByText("No matching records.")).toBeNull();
      cleanup();
    });

    it(`${name}: discloses a truncated result rather than presenting it as whole`, () => {
      render(
        <View
          heading="Recipes"
          {...({ [rowsProp]: recipes } as never)}
          state="ready"
          completeness={{ truncated: true, rowCount: 2, totalRows: 2500 }}
        />,
      );
      expect(screen.getByText(/Showing 2 of 2,?500/)).toBeTruthy();
      cleanup();
    });
  }
});
