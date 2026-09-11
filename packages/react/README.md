# @renderyes/react

The only RenderYes package a host frontend _must_ import. It provides the
provider, the launcher, an isolated render boundary, and host-component
registration.

Two others are optional, and worth naming because the example below imports one
of them:

- `@renderyes/starter-catalog` — generic table, metric card, card grid, item
  list, detail panel, media gallery, record-with-lines and chart
  components, used in the example below. Skip it once you have your own.
- `@renderyes/site-sdk` — needed at build time if you publish a UI catalog.
  This package re-exports only `defineProps` and `field` from it, so
  `toSiteManifest` has to be imported from `site-sdk` directly.

```tsx
import { ViewProvider, ViewLauncher } from "@renderyes/react";
import { createDataTable, createMetricCard } from "@renderyes/starter-catalog";

<ViewProvider
  config={{
    serviceUrl: "", // base URL immediately before the service's /api paths.
    // Use "" for a direct same-origin mount.
    catalogId: "your-catalog",
    components: [createDataTable(), createMetricCard()],
  }}
>
  <YourApp />
  <ViewLauncher />
</ViewProvider>;
```

Everything goes through the single `config` prop — there are no flat props and
no `site` prop. `ViewConfig` in `dist/provider.d.ts` documents every field,
including the ones whose defaults carry invariants:

- `catalogId` must equal the **capability catalog id** published to the server.
  UI registrations are filed under it; a mismatch renders nothing.
- `uiCatalogId` defaults to `` `${catalogId}:ui` ``. Setting it here is enough —
  the server records the value with each composed plan and replays it on refine
  and reopen. Existing plans and saved views retain the id they were composed
  under, so changing it prevents registrations under the new id from matching
  those views. Treat it as a storage key.
- A slot's rows are a page, not the set. When the row budget cuts a result
  short, `rows.length` is the page size — a headline built from it is silently
  wrong for every truncated result. Count via `countBeyondPage(rows,
  completeness)`: it prefers `completeness.totalRows`, falls back to the page,
  and returns `exact: false` when the set is known to continue, so you can
  render "at least N" without presenting N as the total.

Components are registered from `defineHostComponent` definitions (one per file
works well). For a lower starting cost, `@renderyes/starter-catalog` provides
generic table, metric card, card grid, item list, detail panel, media gallery,
record-with-lines and chart components.

## What the shipped components cover, and what they don't

`ViewLauncher` and `ViewWorkspace` are the compose loop: type a prompt, get a
view, refine it in place, start over, and answer a clarifying question.
`ViewWorkspace` goes further — it saves a view, lists and reopens what was
saved, and lets a visitor pin or rearrange the panels of one. They are there so
you can see the pipeline work before designing anything of your own.

`useViewCompose` returns more than they render. Everything below works and is
tested; none of it has shipped UI, and building it is the host's. The list is
`HOST_ONLY_HOOK_FIELDS` in `use-compose.tsx`, which
`test/hook-reachability.test.tsx` checks against the components in both
directions — so this table has one place to stay honest against:

| Not in the shipped components           | Fields on `useViewCompose()` |
| --------------------------------------- | ---------------------------- |
| Streaming progress and skeletons        | `progress`, `stage`          |
| Per-request failure detail              | `issues`, `failedRequests`   |
| Programmatic refine and reset           | `refine`, `reset`            |
| A rearrangement's background save state | `reordering`                 |

If you need any of that, mount `ViewProvider` and build directly on the hook.
`ViewSurface` renders the composed
messages and is the only piece you should not reimplement.

The guides for frontend work ship in this package under `docs/`: `API.md` for
behavior and defaults, `AUTHORING_VIEWS.md` for component registration,
`TROUBLESHOOTING.md` for symptoms and fixes, `HOST_INTEGRATION_STEPS.md` for the
full integration sequence, and `EXAMPLE_HOST.md` for the example domain. The
backend guides — quickstart, server wiring, and catalog authoring — ship in
`@renderyes/server`.

## Rendering inside your own site

`renderMode` decides where your components render, and the default is not the
one most hosts want.

- `"isolated"` (default) renders inside a Shadow DOM. Your markup arrives with
  every class intact and none of them applying, because your stylesheet is
  outside the boundary. Nothing errors — a correct, complete answer simply looks
  unstyled.
- `"host"` renders in the page. Choose this when your registered components are
  trusted first-party code meant to look native to the site, which is the usual
  reason for registering them at all.

```tsx
<ViewProvider config={{ serviceUrl: "", catalogId: "…", components, renderMode: "host" }}>
```

Isolation is the default because a surface dropped into an unknown page should
not inherit its CSS by surprise. Once the components are yours, that protection
is working against you.

The chrome this package renders — the workspace shell, the prompt, the empty and
error states — is themed entirely through CSS custom properties: `--iv-fg`,
`--iv-muted`, `--iv-border`, `--iv-surface`, `--iv-surface-subtle`,
`--iv-accent`, `--iv-accent-fg`, `--iv-danger`, `--iv-radius` and `--iv-font`.
Set them on any ancestor to restyle without replacing anything. They cross a
shadow boundary, so they apply in `"isolated"` mode too.

The starter components are a separate seam with its own `--iv-starter-*` family
and per-part class names; `@renderyes/starter-catalog`'s README documents both.

## Turning off what your server does not support

`ViewPage` — also exported as `ViewWorkspace`, the same component under two
names — renders "Save view" and "My views" by default. If your server has no
`viewStore` configured, pass `savedViews={false}` — the client cannot detect it
on its own, because the saved-view routes answer with the same `400 {ok, error}`
envelope as any rejected request. Left on, the controls render and every use
surfaces an error.

Set `rearrange={false}` when there is no `resolveViewOwner`. A failed refine is
typed as `visitor-identity-required`, but the prop prevents an unavailable
control from being offered in the first place. Both props are documented in
full on `ViewPageProps`.

The shipped `.d.ts` files carry the same contracts as typed, documented
config: `ViewConfig`, `ComposeState`, and `defineHostComponent` are the three
to read first.

Requires React 18 or later; only React 19 is currently tested.

## Two Zod majors

**Do not pass a Zod schema you built yourself between `@renderyes` packages.** A
schema constructed with Zod 4 and handed to something on Zod 3 fails validation
in a way that reads like a bug in this library. Declare component props with
`defineProps` and `field.*` from `@renderyes/site-sdk`, which avoids the
boundary entirely.

This package depends on **Zod 3**; `@renderyes/capability-catalog`,
`@renderyes/data-runtime` and `@renderyes/planner` depend on **Zod 4**. Both
resolve side by side — npm and pnpm nest them — so a plain install needs no
override table. `defineHostComponent` composes A2UI's `DynamicValueSchema` into
the schema it builds, and `@a2ui/react` declares `zod ^3.25.76` as a peer, so
this package tracks A2UI's major. It will move to Zod 4 when A2UI does.
