# @renderyes/starter-catalog

A small set of reusable host components for an initial RenderYes integration.
Each accepts data **by shape**, so it works across host-specific data types and
approved catalogs:

| Factory                 | Slot     | Accepts                          | Use for                          |
| ----------------------- | -------- | -------------------------------- | -------------------------------- |
| `createDataTable`       | `rows`   | `collection`, `search-results`   | Lists of records                 |
| `createMetricCard`      | `metric` | `metric`                         | Totals, rates, aggregates        |
| `createDetailPanel`     | `entity` | `entity`                         | One record in full               |
| `createRecordWithLines` | `entity` | `entity`                         | A record that contains a list    |
| `createCardGrid`        | `items`  | `collection`                     | Browsable, less dense lists      |
| `createItemList`        | `items`  | `collection`, `search-results`   | Feeds, activity, text-heavy rows |
| `createMediaGallery`    | `items`  | `media-collection`, `collection` | Image collections                |
| `createBarChart`*       | `rows`   | `collection`                     | Breakdowns by category           |
| `createLineChart`*      | `rows`   | `collection`, `time-series`      | Trends over time                 |
| `createDonutChart`*     | `rows`   | `collection`                     | Share-of-the-whole proportions   |

\* Charts are imported from `@renderyes/starter-catalog/charts` — a
separate entry because only they depend on `recharts` (an optional peer
dependency). Hosts that never import it never install it.

## Two components for `entity`, and which to register

An `entity` result may contain scalars, nested objects, and lists, so the right
default depends on whether the record's fields or its nested line items are the
main content.

- **`createDetailPanel`** shows scalars as rows and each nested object as its own
  titled group. Right for a record whose interesting parts are fields.
- **`createRecordWithLines`** additionally renders arrays *inside* the record as
  tables. Right for an order with line items, an invoice with charges, or
  anything whose answer is mostly the list it contains.

Register both and let the planner choose, or register one if your entities are
consistently shaped.

Neither is a join. An array rendered here arrived inside the approved entity
payload; a *related* resource fetched through an owner-approved relationship is
a different mechanism. React Admin splits the same way, `ArrayField` versus
`ReferenceManyField`, for the same reason.

Nested fields are addressed by dotted path — `{ key: "shippingAddress.city" }` —
which is how an approved output field is named, so anything the owner approved
can be displayed.

Every component handles loading, empty, and error states itself and shows
provenance (source and as-of) by default — grounded output is not opt-in.

## Click-through into your site

Rows, cards, and list items become clickable through a registration-time
function that maps a record to one of **your** URLs. The plan carries no
URLs and no handlers: the model decides *which* component renders, never
*where* a click goes.

```tsx
createDataTable({
  searchable: true, // client-side filter over the fetched rows, never the query
  sortable: true,   // clickable column headers, same client-side rule
  getRowHref: (row) => (row.id ? `#/orders/${row.id}` : undefined),
});
createCardGrid({
  // SPA alternative: keep navigation inside your router.
  onCardActivate: (item) => router.push(`/recipes/${item.id}`),
});
```

Records the function declines (returns `undefined`) stay plain. Clickable
elements get `role="link"`, keyboard activation with Enter, and an
`iv-starter-clickable` class.

Cards and list items also show images automatically: the first field whose
value looks like an image URL becomes the card picture / row thumbnail, and
is excluded from the derived text fields. Pin it with `imageKey: "photo"`
or disable with `imageKey: false`. One shell caveat: if opening your composed
workspace unmounts the page's normal router, listen for the navigation
(e.g. `hashchange`) and close the workspace — otherwise the URL changes and
nothing visible happens.

## Register

```tsx
import { createDataTable, createMetricCard } from "@renderyes/starter-catalog";
import { ViewProvider, ViewLauncher } from "@renderyes/react";

const components = [
  createMetricCard({ defaultHeading: "Summary" }),
  createDataTable({
    // Optional: pick and label columns; otherwise they derive from row keys, capped at 8.
    columns: [
      { key: "full_name", label: "Applicant" },
      { key: "status" },
      { key: "created_at", label: "Applied" },
    ],
  }),
];

<ViewProvider config={{ serviceUrl: "", catalogId: "my-site", components }}>
  <ViewLauncher label="Ask" />
</ViewProvider>;
```

## Theme

Two layers, use either or both:

- **CSS custom properties** — `--iv-starter-surface`, `--iv-starter-fg`,
  `--iv-starter-muted`, `--iv-starter-border`, `--iv-starter-danger`,
  `--iv-starter-radius`, `--iv-starter-font`, `--iv-starter-size`. The last
  two default to `inherit`, so a component takes your typeface and text size
  unless you say otherwise. Set the colours per scheme and
  dark mode follows automatically.
- **Class names** — every part carries a stable `iv-starter-<part>` class;
  pass `classNames: { root: "…", table: "…" }` to append your own. Pass
  `unstyled: true` to drop the built-in inline styles entirely and style
  through classes alone (the mode a Tailwind host wants).

```tsx
createDataTable({
  unstyled: true,
  classNames: {
    root: "bg-white dark:bg-gray-800 rounded-lg shadow p-6",
    headCell: "text-left text-gray-500 dark:text-gray-400 px-3 py-2",
    cell: "px-3 py-2 text-gray-900 dark:text-gray-100",
  },
});
```

### shadcn/ui hosts

A ready-made class map for hosts whose Tailwind config defines shadcn's
design tokens (`bg-card`, `border-border`, `text-muted-foreground`, …).
Composed views then follow the host's own theme, dark mode included:

```tsx
import { shadcnStarterTheme } from "@renderyes/starter-catalog";

createDataTable({ ...shadcnStarterTheme(), searchable: true });
// Appended overrides win in Tailwind's usual last-wins fashion:
createCardGrid({ ...shadcnStarterTheme({ card: "hover:shadow-md" }) });
```

## Charts

```tsx
import { createBarChart, createLineChart } from "@renderyes/starter-catalog/charts";

createBarChart();                       // x: first string field; series: numeric fields (max 3)
createLineChart({ xKey: "week", yKeys: ["signups"], height: 320 });
```

Requires `recharts` in the host (`npm install recharts`). Series colors are
concrete values (`colors: [...]`) because SVG presentation attributes cannot
resolve CSS custom properties.

A server that only *publishes* a chart's contract should not install a
charting library, so the definitions live recharts-free on the main entry:

```ts
// Server-side (definition publishing) — no recharts anywhere:
import { createBarChartDefinition } from "@renderyes/starter-catalog";
componentDefinitions.push(createBarChartDefinition());
```

Both are built from the same contract function, so the published definition
and the registered view cannot drift.

Each factory also exports its plain React view (`createDataTableView`, …)
for hosts that want the rendering without the registration.
