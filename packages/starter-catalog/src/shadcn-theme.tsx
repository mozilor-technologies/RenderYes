import type { StarterComponentOptions, StarterPart } from "./shared.js";

/**
 * Ready-made `classNames` for a host built on shadcn/ui (or any Tailwind
 * project that defines shadcn's design tokens: `bg-card`, `border-border`,
 * `text-muted-foreground`, …). Composed views then inherit the host's own
 * theme — light/dark included — because the tokens resolve through the
 * host's CSS variables, not ours.
 *
 * This is just strings: no Tailwind or shadcn dependency is added to this
 * package, and a host without those tokens simply shouldn't use it.
 */
const SHADCN_CLASSES: Partial<Record<StarterPart, string>> = {
  root: "rounded-xl border border-border bg-card text-card-foreground p-4 text-sm shadow-sm",
  header: "mb-3",
  heading: "text-base font-semibold leading-none tracking-tight",
  state: "text-sm text-muted-foreground",
  empty: "text-sm text-muted-foreground",
  error: "text-sm text-destructive",
  body: "overflow-x-auto",
  toolbar: "mb-3",
  searchInput:
    "flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  table: "w-full text-sm border-collapse",
  headCell:
    "h-10 px-2 text-left align-middle font-medium text-muted-foreground whitespace-nowrap border-b border-border",
  row: "border-b border-border transition-colors hover:bg-muted/50",
  cell: "p-2 align-top",
  grid: "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]",
  card: "rounded-xl border border-border bg-card p-3 grid gap-1.5 shadow-sm",
  cardTitle: "text-sm font-semibold",
  cardBody: "text-sm text-muted-foreground",
  tile: "rounded-xl border border-border p-3 grid gap-1",
  tileLabel: "text-xs uppercase tracking-wide text-muted-foreground",
  tileValue: "text-2xl font-bold",
  fieldRow: "grid grid-cols-[minmax(120px,1fr)_2fr] gap-2 border-b border-border py-1.5",
  fieldLabel: "text-muted-foreground",
  fieldValue: "[overflow-wrap:anywhere]",
  list: "list-none m-0 p-0",
  listItem: "flex items-start gap-3 border-b border-border py-2.5",
  itemContent: "grid gap-1 min-w-0 flex-1",
  itemTitle: "text-sm font-semibold",
  itemMeta: "text-xs text-muted-foreground",
  itemThumb: "h-12 w-12 shrink-0 rounded-md object-cover",
  cardImage: "w-full rounded-md object-cover aspect-video",
  chart: "w-full",
  // The completeness notice shares the provenance footer's register — a
  // statement about coverage, not a warning — so it shares its classes.
  // Without an entry it rendered as a bare browser-default <p> inside an
  // otherwise token-styled card.
  truncated: "mt-3 text-xs text-muted-foreground",
  // The loading skeleton had no entries either, so unstyled hosts showed
  // three naked <span>s (zero-height, invisible) instead of shimmer bars.
  skeleton: "grid gap-2.5 py-1",
  skeletonBar: "h-3 rounded-md bg-muted animate-pulse",
  provenance: "mt-3 text-xs text-muted-foreground",
};

/**
 * Spread into any starter factory to render shadcn-native markup:
 *
 * ```ts
 * createDataTable({ ...shadcnStarterTheme(), searchable: true })
 * ```
 *
 * Sets `unstyled` (no inline styles at all) and the full per-part class map.
 * Anything you pass in `overrides` is appended after the preset's classes,
 * so utility-class overrides win in Tailwind's usual last-wins fashion.
 */
export function shadcnStarterTheme(
  overrides: Partial<Record<StarterPart, string>> = {},
): Pick<StarterComponentOptions, "unstyled" | "classNames"> {
  const classNames: Partial<Record<StarterPart, string>> = { ...SHADCN_CLASSES };
  for (const [part, extra] of Object.entries(overrides) as [StarterPart, string][]) {
    classNames[part] = classNames[part] ? `${classNames[part]} ${extra}` : extra;
  }
  return { unstyled: true, classNames };
}
