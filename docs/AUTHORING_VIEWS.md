# Authoring views

How to write a component RenderYes can render, and where to put it.

A visitor describes what they want; a planner picks components and the data to
feed them; the runtime renders **your** components with that data. This document
is the contract for those components. Write one file per component and put it in
your views folder.

There are two registration paths. A file written the way this page describes
exports a `defineView` *spec* and a default component — two halves that have to
be paired before anything can publish them.
`ingestViews(import.meta.glob("./views/*.view.tsx", { eager: true }))` does that
in a bundler, and `ingestViewDirectory` from `@renderyes/react/ingest-fs` does
it in Node, which is what a publish script needs. Either way, no list to
maintain.

The scaffold `npx @renderyes/init` writes takes the other route: an explicit
array in `views/index.js`, because it mixes your components with starter
factories like `createDataTable()`, which return registered components and are
not files to ingest. **Adding a bare `defineView` spec to that array
will not work** — it has no renderer, and the publish step refuses it by name.
Ingest the file, or register it with `defineHostComponent` instead.

## The shape of a view file

One file, two exports: the contract and the component.

```tsx
// src/renderyes/views/book-table.view.tsx
import { defineView, field, type ViewProps } from "@renderyes/react"
import { DataTableView } from "@/components/views/data-table-view"

export const spec = defineView({
  id: "BookTable",
  description:
    "Displays a list of books as a table, one row per book and one column " +
    "per field — the view for search results, queues, or any result that is a " +
    "collection of similar records.",
  props: { title: field.string() },
  dataSlots: {
    rows: { accepts: [{ shape: "collection" }] },
  },
  accessibility: {
    label: "Book table",
    description: "A tabular view of a list of books.",
  },
})

export default function BookTable({
  title,
  rows,
  state,
  errorMessage,
  sources,
  completeness,
}: ViewProps<typeof spec, { rows: Row[] | null }>) {
  if (state === "pending") return <p role="status">Loading books…</p>
  if (state === "error") {
    return <p role="alert">{errorMessage ?? "This data could not be loaded."}</p>
  }
  if (state === "empty") return <p>No books matched this request.</p>
  return (
    <>
      <DataTableView title={title} rows={rows ?? []} />
      {completeness?.complete === false ? (
        <p>
          Showing {completeness.rowCount ?? rows?.length ?? 0}
          {typeof completeness.totalRows === "number" ? ` of ${completeness.totalRows}` : ""} rows.
        </p>
      ) : null}
      {sources?.length === 0 ? (
        <p>Not attributed to a source — don't rely on these figures.</p>
      ) : null}
    </>
  )
}
```

Filename must match `*.view.{tsx,ts,jsx,js,mjs}` — overridable via `listViewFiles`/`ingestViewDirectory`'s `pattern` option. `ingestViews` imposes no filename rule at all; the extension is whatever your glob matched. The component is the **default** export; the
contract is the named export `spec`.

## Ingestion

Two lines in your app, one in your publish script. Both enumerate the same
folder, so adding a file is the only step to adding a component.

```ts
// src/renderyes/views/index.ts — the app
import { ingestViews } from "@renderyes/react"

export const components = ingestViews(import.meta.glob("./*.view.tsx", { eager: true }))
```

```ts
// scripts/publish-ui-catalog.ts — the build step, run under `tsx`
import { ingestViewDirectory } from "@renderyes/react/ingest-fs"

const components = await ingestViewDirectory(new URL("../src/renderyes/views/", import.meta.url))
```

`ingestViews` takes the record produced by a bundler's glob. It performs no
filesystem globbing because the syntax is bundler-specific and this package
isn't. `ingestViewDirectory` is the filesystem equivalent for a build step that
has no bundler; it lives at a separate entry point because it imports `node:fs`.

Every problem either one finds is a thrown error naming the file: a missing
`spec`, a missing default export, or two files claiming one id. Neither helper
silently skips an invalid file.

A view file must have a **default export**, which conflicts with the
no-default-exports rule many TypeScript codebases enforce. The folder convention
uses exactly one component per file and keeps its name in one place. Exempt the
views folder from the rule. For ESLint, set
`"import/no-default-export": "off"` scoped to `**/*.view.tsx`.

`ingestViewDirectory` imports the files itself, so Node resolves them from this
package. If Node cannot load your `.view.tsx`
from here — most often because the nearest `package.json` has no
`"type": "module"`, the default state of a Vite app, so `.tsx` is inferred as
CommonJS — use `listViewFiles` instead. It returns the same file list without
importing anything, so you import them the way that already works for you and
pass the record to `ingestViews`:

```ts
import { ingestViews } from "@renderyes/react"
import { listViewFiles } from "@renderyes/react/ingest-fs"

const files = listViewFiles(new URL("../src/renderyes/views/", import.meta.url))
const modules = Object.fromEntries(
  await Promise.all(files.map(async (file) => [file.href, await import(file.href)])),
)
const components = ingestViews(modules)
```

## What each field is for

### `id`

How a plan names your component. Unique within the folder and **stable** —
changing it invalidates any saved plan that referenced it.

### `description`

This text is the entire basis on which the planner picks your component over its
neighbours. Write it for a model, not for a developer. Say what the component
shows and which kind of result it suits. A description that reads like a
changelog entry ("Refactored table with sorting") tells the planner nothing;
"Displays a list of records as a table, one row per record — the view for search
results or any collection of similar items" tells it exactly when to reach for
this.

If two of your components keep getting confused for each other, their
descriptions are too close. Name what makes each the *better* choice.

### `dataSlots`

Named slots the planner may bind data to. Every key becomes a prop of the same
name on your component.

Each slot declares what it accepts, in one of two ways:

```ts
// Structural: any result of this shape, from any catalog.
dataSlots: { rows: { accepts: [{ shape: "collection" }] } }

// Pinned: only these exact data types.
dataSlots: {
  record: {
    accepts: [
      { dataTypeId: "StockSummary", shapes: ["entity"] },
      { dataTypeId: "SalesByHour", shapes: ["entity"] },
    ],
  },
}
```

Structural acceptance is what makes a handful of components cover a catalog of
dozens of capabilities — one `{ shape: "collection" }` component renders every
list you have. Use it for anything generic.

Pin by `dataTypeId` when your component understands *specific fields*. A
component that draws five stock-level tiles must not accept every entity in the
catalog: shape-matched, it would be offered for records with no stock fields at
all and would render five blank tiles. Naming the data types it understands means
the planner only reaches for it when it fits.

The shapes available are `entity` (one record), `collection` (a list of records),
`search-results`, `metric`, `time-series` (parallel arrays over a date axis),
`hierarchy`, `document`, `media-collection`, and `comparison`.

The capability catalog owns each `dataTypeId`. A GraphQL code-first integration
supplies it in the query selection; the catalog CLI derives a default from the
root field. Use this sequence:

1. **Review or compile the capability catalog** and inspect each capability's
   `output.dataTypeId`.
2. **Author generic components structurally** with `{ shape: "collection" }` or
   another result shape.
3. **Pin specialized components** to the exact catalog-owned ids, then publish
   the UI catalog.

Do not guess a data-type id from a schema or component name.

### `props`

Bounded values the planner may set, declared with `field` helpers:

```ts
props: {
  title: field.string(),
  density: field.enum(["comfortable", "compact"], { default: "comfortable" }),
  maxRows: field.number({ maximum: 100 }),
}
```

Declare them here and nowhere else — `ViewProps<typeof spec>` derives the
TypeScript types from this same record, so the two cannot drift. The bounds are
enforced before your component sees anything: a plan cannot set a prop you didn't
declare, or set an enum to a value you didn't list.

Props are optional in TypeScript regardless of `required`, because a plan is free
not to set one. `required` constrains what the planner may emit, not what
arrives.

### `accessibility`

`label` is what a screen reader announces for the rendered component. Worth
writing — it's the difference between "table" and "stock level by section".

## What your component receives

Slots and props as declared, plus seven more that arrive whether or not you
asked, on any component with exactly one data slot:

| Prop | Type | Meaning |
| --- | --- | --- |
| `state` | `"pending" \| "ready" \| "empty" \| "error"` | `pending` is the **first** state on every streamed run — the surface is emitted before any data exists — then `ready` with data, `empty` when the request succeeded and matched nothing, `error` when it failed. Handle `pending`: a component that switches exhaustively without it renders nothing on the first frame |
| `errorMessage` | `string` | Present when `state` is `"error"`. Safe to display |
| `sources` | `readonly string[]` | Which data sources the slot came from |
| `asOf` | `string` | When the data was current, ISO 8601, or empty if unknown |
| `staleAt` | `string` | When it stops being usable, if the source declares a horizon. Empty means none was declared — not "never goes stale" |
| `completeness` | `{ complete, truncated, narrowedAfterFetch?, rowsBeforeNarrowing?, moreAvailable?, degradedFields?, rowCount?, totalRows? }` | Whether what arrived is the whole answer, whether a larger dataset continues, and whether fields or post-fetch narrowing reduced it |
| `records` | `readonly { sourceId, recordUrl }[]` | Deep links to the underlying records, for sources that publish one |

**Three of these are not optional to handle.**

`state` — a component that ignores it renders an empty box on failure and leaves
the visitor unable to tell a broken request from a genuine zero.

`sources` — **empty means the data is not grounded in anything.** If `sources`
is empty, say so; do not render the values as authoritative.

`completeness` — `complete: false` means the request succeeded and returned
provably less than the answer, such as when a row budget cut it short. Render
"showing the first `rowCount` of `totalRows`". A component that ignores this
displays a truncated result identically to a complete one, so every figure
derived from it is wrong and nothing on screen discloses it. Note that `state`
stays `"ready"` here: the request worked. Completeness and success are different
questions.

`ViewProps<typeof spec>` includes all seven, so they're in your editor's
completion whether you thought about them or not.

## Rules your component has to follow

**Take data through props; never fetch it.** A view that fetches ignores what the
planner selected and re-queries with its own parameters. The result looks right
and shows the wrong numbers, which is worse than showing nothing. This is the one
rule with no exceptions.

**Don't read context, environment, or globals.** No auth context, no router, no
`import.meta.env`, no toast. If your component needs to know which workspace it's
in, that's a prop. A component that reads context can't be rendered anywhere the
context isn't, and the surface is one of those places.

**Render what you were given, tolerantly.** Field sets vary per capability. A
missing optional field should render as a dash, not throw.

**UI state is fine.** Which column is sorted, which row is expanded, which tab is
open — hold all of it. What you must not hold is the *data*.

The practical test: your component renders correctly when mounted with nothing
around it. No providers, no router, no query client. If it does, it will render
on the surface too.

## Suggested layout

```
src/
  components/views/          your presentational components — no RenderYes imports
  renderyes/
    views/
      index.ts               the glob
      book-table.view.tsx    spec + a thin adapter over a presentational component
      trend-chart.view.tsx
```

The presentational components are your app's own and do not need to know
RenderYes exists; the `.view.tsx` files are the seam that
maps planner-selected data onto them. That's usually a handful of lines —
an approved path like `total.open` arrives with its nested shape restored:
`{ total: { open } }`. The adapter
is where you map that onto whatever props your component actually wants. (A
literal top-level key containing a dot is preserved as-is, for the rare source
row that really has one.)

It also means adopting RenderYes doesn't require rewriting a single existing
component. You write one small adapter per component you want to expose.

## When one file with one default export isn't enough

`defineHostComponent` is the lower-level call `ingestViews` is built on; it takes
the contract and the component as one argument. Reach for it for a component
built by a factory, or one whose contract is computed at startup. Everything
else should be a file in the folder.
