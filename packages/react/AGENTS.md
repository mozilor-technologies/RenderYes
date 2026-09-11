# @renderyes/react — notes for a coding agent

You are wiring a component into a system where **the planner chooses what data
lands in your props**. That is the difference from every other React data
library, and every mistake below follows from it.

## The shape of a component

`defineHostComponent` takes the contract and the component together — the
planner reads the contract, the surface renders the component. There is no
separate registration call.

```jsx
import { defineHostComponent, defineProps, field } from "@renderyes/react";

export const orderSummary = defineHostComponent({
  id: "OrderSummary",
  version: "1.0.0",
  // The planner selects on this. Write it for the visitor's intent, not the
  // data type's internal name.
  description: "Headline figures for a short list of records, one line each.",
  props: defineProps({ heading: field.string({ default: "Summary" }) }),
  dataSlots: { rows: { accepts: [{ shape: "collection" }] } },
  accessibility: { label: "Order summary list", description: "…" },
  component: OrderSummaryView,
});
```

## The seven things that go wrong

### 1. `rows.length` is a page, not the answer

A slot holds one *fetched page*, cut by the capability's row budget. A headline
of `rows.length` reads "100 orders" over a 2,500-order dataset, confidently.

```jsx
import { countBeyondPage } from "@renderyes/react";

const total = countBeyondPage(records, completeness);
<h3>{total.exact ? total.count : `at least ${total.count}`} order(s)</h3>
```

`completeness` is a prop on every data slot. Read it before you count.

`countBeyondPage` returns `exact: false` when `completeness.truncated` is true
or `complete` is false, and takes `totalRows` as the answer when the upstream
reported one. It does **not** read `moreAvailable` — if you need "complete for
this request, but the dataset continues", check that flag yourself.

### 2. `state` starts at `"pending"`, on every streamed run

`"pending" | "ready" | "empty" | "error"`. A streamed compose emits the surface
*before* any request settles, so `"pending"` is the first state your component
sees every time — not an edge case. Handle it first, or the first frame is
blank.

### 3. Don't hard-code a column path

`row.customer.name` blanks the moment a plan projects different leaves, and it
will: the planner picks fields per request. Render what arrived —
`Object.entries(row)` — or declare the fields you need in `dataSlots`.

### 4. Empty `sources` means ungrounded — say so

```jsx
{(sources ?? []).length === 0 ? <p>Not attributed to a source.</p> : null}
```

Presenting ungrounded figures as grounded is the single thing this system
exists to prevent. It is not a nicety.

### 5. `completeness.complete` is about the plan, not the truth

`complete: true` means *the plan ran as written*. It does not mean you have the
whole dataset. Three separate flags qualify what arrived:

| flag | meaning |
|---|---|
| `truncated` | the runtime capped the fetch |
| `moreAvailable` | answer complete, dataset continues |
| `narrowedAfterFetch` | a filter, or a sort the source could not apply, ran over a page that was provably partial — so it may have missed every matching row |

When `narrowedAfterFetch` is set, `rowsBeforeNarrowing` tells you what it ran
over: "4 of the 100 fetched", never "4 of the orders".

### 6. `defineProps` and `field.*`, not raw Zod

Props are declared with `field.string()` etc. That bounds what a planner may
set, and keeps you off the Zod-major boundary between this package and the
catalog packages.

### 7. `dataSlots` accept by **shape**, not by data type

`{ accepts: [{ shape: "collection" }] }` works against any catalog producing
that shape. Naming a concrete type couples your component to one schema.

## Mechanics

- **ESM build.** The package's `import` and `default` export conditions resolve
  to the same ESM files. Node >= 22 can load the synchronous entry points from
  either module loader.
- Exports: `.` and `./ingest-fs`.
- A component is registered by being in the array your UI catalog publishes —
  writing the file is not enough.

## Verifying without a model key

Configure a scripted provider with a plan you own. It needs no API key and
returns the same answer on every run:

```ts
planProviders: [{ id: "rehearsal", plans: [myPlan] }]
```
