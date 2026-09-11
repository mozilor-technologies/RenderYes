import type {
  CSSProperties,
  FC,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import type { DataSlotState } from "@renderyes/site-sdk";
import { useCallback } from "react";
import { countBeyondPage } from "@renderyes/react";

/**
 * What the trusted executor actually writes to a component's `sources` path:
 * the approved source ids behind the slot's data, nothing else. Previously
 * declared here as `{ id?, entity?, description? }` — a shape the executor
 * never produces (`visitNode` in `@renderyes/site-sdk` writes
 * `provenance.sources.map(s => s.sourceId)`, i.e. plain strings). Reading
 * `.entity`/`.description`/`.id` off a string is always `undefined`, so
 * every starter component's provenance footer silently dropped the "Source:
 * …" segment and rendered only the as-of date — no error, just missing text.
 */
export type SourceStamp = string;

/**
 * Props every single-slot host component receives from the executor without
 * declaring them: `defineHostComponent` defaults the `state`, `errorMessage`,
 * `sources`, and `asOf` paths for any component with exactly one data slot.
 */
export interface SlotCompanions {
  /**
   * `"pending"` while the slot's request is still running (a streamed compose
   * reports it before any data exists), then `"ready"`, `"empty"` or
   * `"error"`. Absent when the host never wired the state path.
   */
  state?: DataSlotState;
  errorMessage?: string;
  sources?: readonly SourceStamp[] | null;
  asOf?: string | null;
  /**
   * Whether what arrived is the whole answer.
   *
   * The runtime has always known when a row budget cut a result short, and
   * `defineHostComponent` wires this path by default — but no component read
   * it, so a truncated collection rendered identically to a complete one and
   * every number on the screen was wrong in a way nothing disclosed.
   */
  completeness?: {
    complete?: boolean;
    truncated?: boolean;
    /**
     * A plan-level filter/sort ran over one page of a larger dataset — the
     * fetch met its own ask, but matches may live beyond the page.
     */
    narrowedAfterFetch?: boolean;
    /** Fetched rows the post-fetch narrowing ran over. */
    rowsBeforeNarrowing?: number;
    /** The dataset continues past what was fetched; the answer is still complete. */
    moreAvailable?: boolean;
    rowCount?: number;
    totalRows?: number;
    /**
     * Approved fields the upstream errored on. Rows arrived; these columns are
     * null because a resolver failed, not because the records have no value —
     * a distinction nothing on screen can make unless it is told.
     */
    degradedFields?: readonly string[];
  } | null;
}

export interface StarterMessages {
  loading?: string;
  empty?: string;
  /** Shown instead of the executor's sanitized errorMessage when set. */
  error?: string;
}

/** Options shared by every starter component factory. */
export interface StarterComponentOptions {
  /** Catalog component id. Each factory has a stable default. */
  id?: string;
  /** Bump when the host considers the component's contract changed. */
  version?: string;
  /** Planner-facing description override. Write it for a model. */
  description?: string;
  /** Default heading shown when the planner sets none. */
  defaultHeading?: string;
  /**
   * Drop the built-in inline styles entirely and style through class names
   * only — the mode a Tailwind (or any utility/design-system) host wants.
   */
  unstyled?: boolean;
  /**
   * Extra class names per part, appended after the stable `iv-starter-*`
   * class each part always carries.
   */
  classNames?: Partial<Record<StarterPart, string>>;
  messages?: StarterMessages;
  /** Provenance (source + as-of) is shown by default; opt out per component. */
  hideProvenance?: boolean;
}

export type StarterPart =
  | "root"
  | "header"
  | "heading"
  | "state"
  | "truncated"
  /** Footnote naming fetched fields a column cap left out of a table. */
  | "omittedFields"
  /** A value the plan never fetched — distinct from a fetched null. */
  | "notFetched"
  | "error"
  | "empty"
  | "body"
  | "toolbar"
  | "searchInput"
  | "table"
  | "headCell"
  | "row"
  | "cell"
  | "grid"
  | "card"
  | "cardTitle"
  | "cardBody"
  | "tile"
  | "tileLabel"
  | "tileValue"
  | "fieldRow"
  | "fieldLabel"
  | "fieldValue"
  /** Heading over a nested object's fields, or over an entity's embedded list. */
  | "groupTitle"
  | "list"
  | "listItem"
  /** Media-gallery grid, one framed image, and its caption. */
  | "gallery"
  | "galleryItem"
  | "galleryImage"
  | "galleryCaption"
  | "itemContent"
  | "itemTitle"
  | "itemMeta"
  | "itemThumb"
  | "cardImage"
  | "chart"
  | "skeleton"
  | "skeletonBar"
  | "provenance";

/**
 * Default look, kept deliberately quiet: neutral grays on CSS custom
 * properties (`--iv-starter-*`) so a host can retheme — including dark mode —
 * without touching markup, or pass `unstyled` and use classes alone.
 */
const styles: Partial<Record<StarterPart, CSSProperties>> = {
  root: {
    background: "var(--iv-starter-surface, #ffffff)",
    color: "var(--iv-starter-fg, #111827)",
    border: "1px solid var(--iv-starter-border, #e5e7eb)",
    borderRadius: "var(--iv-starter-radius, 12px)",
    padding: 16,
    fontFamily: "var(--iv-starter-font, inherit)",
    fontSize: "var(--iv-starter-size, inherit)",
  },
  header: { marginBottom: 12 },
  heading: { margin: 0, fontSize: "1.15em", fontWeight: 600 },
  state: { margin: 0, color: "var(--iv-starter-muted, #6b7280)" },
  empty: { margin: 0, color: "var(--iv-starter-muted, #6b7280)" },
  error: { margin: 0, color: "var(--iv-starter-danger, #b42318)" },
  body: { overflowX: "auto" },
  toolbar: { marginBottom: 12 },
  searchInput: {
    width: "100%",
    maxWidth: 280,
    padding: "6px 10px",
    border: "1px solid var(--iv-starter-border, #e5e7eb)",
    borderRadius: 8,
    background: "var(--iv-starter-surface, #ffffff)",
    color: "var(--iv-starter-fg, #111827)",
    font: "inherit",
    fontSize: "0.93em",
  },
  gallery: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: 12,
  },
  galleryItem: { margin: 0, display: "grid", gap: 4 },
  galleryImage: {
    width: "100%",
    aspectRatio: "4 / 3",
    objectFit: "cover",
    borderRadius: "var(--iv-starter-radius, 12px)",
    border: "1px solid var(--iv-starter-border, #e5e7eb)",
  },
  galleryCaption: { fontSize: "0.86em", color: "var(--iv-starter-muted, #6b7280)" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.93em" },
  headCell: {
    textAlign: "left",
    padding: "8px 6px",
    borderBottom: "1px solid var(--iv-starter-border, #e5e7eb)",
    color: "var(--iv-starter-muted, #6b7280)",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  row: { borderBottom: "1px solid var(--iv-starter-border, #e5e7eb)" },
  cell: { padding: "8px 6px", verticalAlign: "top" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: 12,
  },
  card: {
    border: "1px solid var(--iv-starter-border, #e5e7eb)",
    borderRadius: "var(--iv-starter-radius, 12px)",
    padding: 12,
    display: "grid",
    gap: 6,
  },
  cardTitle: { margin: 0, fontSize: "var(--iv-starter-size, inherit)", fontWeight: 600 },
  cardBody: { margin: 0, color: "var(--iv-starter-muted, #6b7280)", fontSize: "0.93em" },
  tile: {
    border: "1px solid var(--iv-starter-border, #e5e7eb)",
    borderRadius: "var(--iv-starter-radius, 12px)",
    padding: 12,
    display: "grid",
    gap: 4,
  },
  tileLabel: {
    margin: 0,
    fontSize: "0.86em",
    color: "var(--iv-starter-muted, #6b7280)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  tileValue: { margin: 0, fontSize: "1.7em", fontWeight: 700 },
  // Same visual register as `provenance`, because the completeness notice
  // lives in the same footer: it is a statement about what the numbers
  // cover, not a warning banner. This entry was missing, so the notice
  // rendered as an unstyled browser-default <p> under otherwise-styled
  // components.
  truncated: {
    marginTop: 12,
    marginBottom: 0,
    fontSize: "0.86em",
    color: "var(--iv-starter-muted, #6b7280)",
  },
  fieldRow: {
    display: "grid",
    gridTemplateColumns: "minmax(120px, 1fr) 2fr",
    gap: 8,
    padding: "6px 0",
    borderBottom: "1px solid var(--iv-starter-border, #e5e7eb)",
  },
  fieldLabel: { color: "var(--iv-starter-muted, #6b7280)" },
  fieldValue: { overflowWrap: "anywhere" },
  list: { listStyle: "none", margin: 0, padding: 0 },
  listItem: {
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
    padding: "10px 0",
    borderBottom: "1px solid var(--iv-starter-border, #e5e7eb)",
  },
  itemContent: { display: "grid", gap: 4, minWidth: 0, flex: 1 },
  itemTitle: { margin: 0, fontSize: "var(--iv-starter-size, inherit)", fontWeight: 600 },
  itemMeta: { margin: 0, fontSize: "0.86em", color: "var(--iv-starter-muted, #6b7280)" },
  itemThumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
    objectFit: "cover",
    flexShrink: 0,
  },
  cardImage: {
    width: "100%",
    aspectRatio: "16 / 9",
    objectFit: "cover",
    borderRadius: 8,
  },
  chart: { width: "100%" },
  skeleton: { display: "grid", gap: 10, padding: "4px 0" },
  skeletonBar: {
    height: 12,
    borderRadius: 6,
    background: "var(--iv-starter-border, #e5e7eb)",
    animation: "iv-starter-shimmer 1.4s ease-in-out infinite",
  },
  provenance: {
    marginTop: 12,
    fontSize: "0.86em",
    color: "var(--iv-starter-muted, #6b7280)",
  },
  omittedFields: {
    margin: "8px 0 0",
    fontSize: "0.86em",
    color: "var(--iv-starter-muted, #6b7280)",
  },
  notFetched: {
    color: "var(--iv-starter-muted, #6b7280)",
    cursor: "help",
  },
};

export interface PartsApi {
  cls(part: StarterPart): string;
  sty(part: StarterPart): CSSProperties | undefined;
  /**
   * True when this component has been told to drop its own styles and rely on
   * class names the host supplies. See `useExternalClassGuard`.
   */
  reliesOnExternalClasses: boolean;
}

export function createParts(options: StarterComponentOptions): PartsApi {
  return {
    cls(part) {
      const extra = options.classNames?.[part];
      return extra ? `iv-starter-${part} ${extra}` : `iv-starter-${part}`;
    },
    reliesOnExternalClasses: Boolean(
      options.unstyled && options.classNames && Object.keys(options.classNames).length > 0,
    ),
    sty(part) {
      return options.unstyled ? undefined : styles[part];
    },
  };
}

/** "application_id" / "avgTatHuman" → "Application id" / "Avg tat human". */
export function humanize(key: string): string {
  // A dotted key names a nested field, so label every segment rather than
  // leaving the dot in the middle of a sentence ("Category.name"). Only reached
  // for keys that contain a dot, which until now could not resolve at all.
  if (key.includes(".")) return key.split(".").map(humanize).join(" · ");
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Render any slot value as display text. Nulls become an em dash. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (typeof value === "string") {
    if (ISO_DATE.test(value)) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        // Explicit styles rather than bare toLocaleString(): the default in
        // most locales spells out seconds ("8/1/2026, 10:00:00 AM"), which is
        // false precision for the timestamps that reach these components and
        // wide enough to wrap table cells and meta lines.
        return value.length > 10
          ? parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
          : parsed.toLocaleDateString();
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number")) {
      const shown = value.slice(0, 5).join(", ");
      return value.length > 5 ? `${shown}…` : shown || "—";
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  // A nested object in a scalar position: don't dump JSON into the UI.
  // The data table goes further and suppresses columns that are objects in
  // *every* sampled row (see resolveColumns), so this ellipsis is what an
  // occasional nested value renders as, never a whole column of "…".
  return "…";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How a row/card/item becomes clickable. Both callbacks are registration-time
 * host code: the plan carries no URLs and no handlers, so the model can decide
 * *which* component renders but never *where* a click goes.
 */
export interface ActivationOptions {
  /**
   * Host-owned destination for one record — e.g.
   * `(row) => "#/recipes/" + row.id`. Return undefined to leave that record
   * non-clickable. Navigation uses `location.assign`, so hash routes and
   * ordinary paths both work; ctrl/cmd-click opens a new tab.
   */
  getHref?: (record: Record<string, unknown>) => string | undefined;
  /**
   * SPA alternative: called on activation instead of navigating, so a
   * router host can push client-side. Receives the record and, when
   * `getHref` is also set, the href it produced.
   */
  onActivate?: (record: Record<string, unknown>, href?: string) => void;
}

export interface ActivationProps {
  role: "link";
  tabIndex: 0;
  onClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

export interface Activation {
  href?: string;
  props: ActivationProps;
}

/**
 * DOM props that make one element activate one record: click, and Enter for
 * keyboard users (the element gets `role="link"` and joins the tab order).
 * Returns undefined when the record resolves to nothing clickable, so
 * non-clickable rows stay plain elements.
 */
export function activationFor(
  record: Record<string, unknown>,
  options: ActivationOptions | undefined,
): Activation | undefined {
  if (!options?.getHref && !options?.onActivate) return undefined;
  const href = options.getHref?.(record);
  if (href === undefined && !options.onActivate) return undefined;

  const activate = (openInNewTab: boolean) => {
    if (options.onActivate) {
      options.onActivate(record, href);
      return;
    }
    if (href === undefined) return;
    if (openInNewTab) window.open(href, "_blank", "noopener");
    else window.location.assign(href);
  };

  return {
    href,
    props: {
      role: "link",
      tabIndex: 0,
      onClick: (event) => activate(event.metaKey || event.ctrlKey),
      onKeyDown: (event) => {
        if (event.key === "Enter") activate(event.metaKey || event.ctrlKey);
      },
    },
  };
}

/** Extra affordance styling for a clickable element (skipped in unstyled mode). */
export const clickableStyle: CSSProperties = { cursor: "pointer" };

const ISOISH = /^\d{4}-\d{2}-\d{2}/;

const IMAGE_URL =
  /^(?:https?:\/\/\S+|\/\S+)\.(png|jpe?g|gif|webp|avif|svg)(\?\S*)?$/i;

/**
 * Does this value look like a URL to an image file?
 *
 * Absolute, or root-relative (`/api/media/file/x.jpg`): a CMS serving its own
 * media returns page-relative paths — Payload and Strapi both do — and a host
 * page on the same origin renders them correctly. The extension requirement
 * is what keeps this from matching arbitrary paths; a root-relative path
 * against a *different*-origin data source renders a visible broken image,
 * not a silent wrong one, which is the tolerable failure direction.
 */
export function isImageUrl(value: unknown): value is string {
  return typeof value === "string" && IMAGE_URL.test(value);
}

/**
 * First field whose value looks like an image URL — the natural thumbnail.
 * Sampled across a few rows so one record with a null image doesn't hide
 * the field. Leaf paths, because that is where images actually live in a
 * Relay-shaped API (`thumbnail.url`) — one level deep found nothing there.
 */
export function deriveImageKey(
  rows: readonly Record<string, unknown>[],
): string | undefined {
  for (const row of rows.slice(0, 5)) {
    for (const spec of scalarLeafEntries(row)) {
      if (isImageUrl(resolveFieldValue(row, spec.key))) return spec.key;
    }
  }
  return undefined;
}

/**
 * Does this key name an identifier rather than something a person reads?
 *
 * The approved catalog knows each field's `semanticType` — it *knows* `id`
 * is an identifier — but none of that reaches a component at runtime. All we
 * have here is the key and the value, so the best available signal is the
 * name: a trailing camel/snake word of `id`/`uuid`/`key` ("id",
 * "application_id", "userId", "itemUuid", "apiKey"). Whole words only, so
 * "paid", "grid", and "keyboard" stay ordinary fields. Dotted paths are
 * judged on their last word too, so a nested `category.id` is an identifier
 * while `total.gross.amount` is not. Shared by every deriver so the title,
 * meta, columns, tiles, and axes all agree on what an identifier is.
 */
export function isIdentifierKey(key: string): boolean {
  const last = lastWord(key);
  // `slug` earns its place the same way `uuid` did: it is a routing
  // identifier every CMS emits, it is always approved (link building needs
  // it), and a card printing "Slug: a-marathon-in-palgadh-…" as body copy is
  // the observed result of leaving it out.
  return last === "id" || last === "uuid" || last === "key" || last === "slug";
}

/** Does this key *say* it names the record — name/title/label as its last word? */
function isNamelikeKey(key: string): boolean {
  const last = lastWord(key);
  return last === "name" || last === "title" || last === "label";
}

function lastWord(key: string): string {
  const words = key
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
    .split(/\s+/);
  return words[words.length - 1] ?? "";
}

/**
 * First plain-string leaf that isn't date-like, an image URL, or an
 * identifier — the natural title. A field named name/title/label wins over
 * mere position: `{id, sku, name}` should title with the name even though
 * the sku comes first.
 */
export function deriveTitleKey(
  rows: readonly Record<string, unknown>[],
): string | undefined {
  const first = rows[0];
  if (!first) return undefined;
  const leaves = scalarLeafEntries(first).filter((spec) => !isIdentifierKey(spec.key));
  const candidates = leaves.filter((spec) => {
    const value = resolveFieldValue(first, spec.key);
    return (
      typeof value === "string" &&
      value !== "" &&
      !ISOISH.test(value) &&
      !isImageUrl(value)
    );
  });
  const named = candidates.find((spec) => isNamelikeKey(spec.key));
  // Candidates only — no last-resort key. The first raw key can be an object,
  // and a title of "…" tells a visitor nothing; an identifier is worse still,
  // because "p_9" reads as content. `undefined` asks the callers for their
  // honest "Item N" instead, which covers both.
  return (named ?? candidates[0])?.key;
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isScalarArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" || typeof item === "number")
  );
}

export function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isRecord);
}

/**
 * One cell of text for an embedded array of objects: the count, then the
 * first few items by their natural title leaf ("51 — Andorra, Albania, …").
 *
 * An array of objects has no scalar leaves, so the leaf enumeration skips it
 * and — before this existed — a fetched field like a zone's `countries`
 * rendered nothing at all: no column, no warning. A summary is not the full
 * table (that is `createRecordWithLines`'s job), but it is the difference
 * between an answer and a silent drop.
 */
export function summarizeObjectArray(value: unknown): string {
  if (!Array.isArray(value)) return formatValue(value);
  const rows = value.filter(isRecord);
  const titleKey = rows.length > 0 ? deriveTitleKey(rows) : undefined;
  if (!titleKey) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  const previews = rows.slice(0, 3).map((row) => formatValue(resolveFieldValue(row, titleKey)));
  return `${value.length} — ${previews.join(", ")}${value.length > previews.length ? ", …" : ""}`;
}

export interface ScalarLeafOptions {
  /** Path depth cap. Mirrors the catalog's own discovery default. */
  maxDepth?: number;
  /**
   * Treat an array of strings/numbers as a leaf (`formatValue` renders it as
   * a joined list). Off by default: a tile or a chart series has no use for
   * one, but a detail row does.
   */
  scalarArrays?: boolean;
  /**
   * Treat an array of objects as a leaf, carrying `summarizeObjectArray` as
   * its format. Off by default for the same reason arrays are skipped at all
   * (an embedded list is a table's job) — but a table column or a detail row
   * turns it on, because a fetched field must render or be reported, never
   * silently dropped.
   */
  objectArrays?: boolean;
}

/**
 * Every scalar leaf of a record, as dotted paths, in the record's own order.
 *
 * The one enumeration behind every "which fields does this record have"
 * decision. Its predecessors enumerated one level deep, so a value inside a
 * nested object did not exist as far as a renderer was concerned — and every
 * monetary value in a Relay-shaped API sits at a path like
 * `total.gross.amount`. The metric card showed the currency code where the
 * figure belonged; the charts found no numeric field and rendered their empty
 * state; tables grew a column of `…`; images at `thumbnail.url` never became
 * thumbnails — silently every time, with the catalog, planner and payload all
 * correct.
 *
 * Arrays of objects are skipped, not descended: an embedded list is a table's
 * or chart's job, not a field's.
 */
export function scalarLeafEntries(
  record: Record<string, unknown>,
  { maxDepth = 4, scalarArrays = false, objectArrays = false }: ScalarLeafOptions = {},
): FieldSpec[] {
  const found: FieldSpec[] = [];
  const walk = (value: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_PATH_SEGMENTS.has(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (isScalar(child) || (scalarArrays && isScalarArray(child))) {
        found.push({ key: path });
      } else if (objectArrays && isObjectArray(child)) {
        found.push({ key: path, format: summarizeObjectArray });
      } else if (isRecord(child) && depth < maxDepth) {
        walk(child, path, depth + 1);
      }
    }
  };
  walk(record, "", 1);
  return found;
}

function moneyFormat(
  currencyKey: string,
): (value: unknown, record?: Record<string, unknown>) => string {
  return (value, record) => {
    if (typeof value !== "number") return formatValue(value);
    const currency = record ? resolveFieldValue(record, currencyKey) : undefined;
    return typeof currency === "string" && currency !== ""
      ? `${formatValue(value)} ${currency}`
      : formatValue(value);
  };
}

export interface CollapseMoneyOptions {
  /**
   * A path prefix the surrounding UI already states (a detail group's own
   * key), stripped from derived labels so "Gross" is not re-labelled
   * "Total · Gross" under a heading that already says "Total".
   */
  stripLabelPrefix?: string;
}

/**
 * Reassembles the money pattern out of enumerated leaves.
 *
 * Money never arrives as one value in a GraphQL-shaped API: it is a numeric
 * `amount` leaf with a string `currency` leaf beside it or on an ancestor
 * (`{currency, gross: {amount}, net: {amount}}`). Leaf enumeration alone
 * renders those as co-equal stats — the currency code first, as if the
 * three-letter string were the most prominent figure on screen. This keys on
 * that structure and nothing else: each numeric `amount` whose nearest
 * `currency` sibling exists becomes one formatted value ("381,463.22 USD")
 * labelled by its parent path ("Gross", "Total · Gross"), and a currency leaf
 * consumed that way stops rendering on its own. A currency with no amount
 * anywhere near it is left exactly as it was — it is data, not a unit.
 *
 * The amount key survives as the spec's key, so sorting and per-row
 * resolution stay numeric; only the label and presentation change.
 */
export function collapseMoneyEntries(
  specs: readonly FieldSpec[],
  rows: readonly Record<string, unknown>[],
  { stripLabelPrefix }: CollapseMoneyOptions = {},
): FieldSpec[] {
  const keys = new Set(specs.map((spec) => spec.key));
  const sample = (key: string): unknown => {
    for (const row of rows) {
      const value = resolveFieldValue(row, key);
      if (value !== null && value !== undefined) return value;
    }
    return undefined;
  };
  const consumed = new Set<string>();
  const collapsed = specs.map((spec) => {
    // Only untouched derived leaves: an explicit label or format is the host
    // (or the object-array summary) already deciding the presentation.
    if (spec.format || spec.label) return spec;
    const segments = spec.key.split(".");
    if (segments[segments.length - 1] !== "amount") return spec;
    if (typeof sample(spec.key) !== "number") return spec;
    const parent = segments.slice(0, -1).join(".");
    // Nearest currency wins: the amount's own sibling first, then each
    // ancestor's sibling out to the root.
    let currencyKey: string | undefined;
    for (let prefix = parent; ; prefix = prefix.split(".").slice(0, -1).join(".")) {
      const candidate = prefix ? `${prefix}.currency` : "currency";
      if (keys.has(candidate) && typeof sample(candidate) === "string") {
        currencyKey = candidate;
        break;
      }
      if (prefix === "") break;
    }
    if (!currencyKey) return spec;
    consumed.add(currencyKey);
    const labelPath =
      stripLabelPrefix &&
      (parent === stripLabelPrefix || parent.startsWith(`${stripLabelPrefix}.`))
        ? parent.slice(stripLabelPrefix.length + 1)
        : parent;
    return {
      key: spec.key,
      ...(labelPath ? { label: humanize(labelPath) } : {}),
      format: moneyFormat(currencyKey),
    };
  });
  return collapsed.filter((spec) => !consumed.has(spec.key));
}

const OPAQUE_TOKEN = /^[A-Za-z0-9:_+/=-]{8,}$/;

/**
 * Does this value read as an opaque identifier rather than words? Machine
 * tokens mix letters and digits with no spaces (base64 ids, UUIDs, hashes);
 * human-readable values almost never do. Same family of value-shape checks as
 * `deriveTitleKey`'s date and image screens, and used the same way: to prefer
 * showing a person a value they can read.
 */
export function looksLikeOpaqueId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (ISO_DATE.test(value)) return false;
  if (!OPAQUE_TOKEN.test(value)) return false;
  return /\d/.test(value) && /[A-Za-z]/.test(value);
}

/**
 * The alt-text sibling of an image field: `heroImage.url` → `heroImage.alt`,
 * `image` → `alt`. An approved catalog that carries an image usually carries
 * its alt text too — approving it is the accessible thing to do — and that
 * field belongs ON the image element, not printed as body copy ("Hero image ·
 * Alt: Flooded paddy fields…" was the observed result). Purely a naming
 * convention, and used only where an image key is already established, so a
 * miss costs nothing: the caller falls back to the title.
 */
export function imageAltKey(imageKey: string | undefined): string | undefined {
  if (!imageKey) return undefined;
  const segments = imageKey.split(".");
  segments[segments.length - 1] = "alt";
  return segments.join(".");
}

/**
 * The next few scalar fields after the title — the natural supporting text.
 * Identifier-named keys are left out: "Id: p_9" in a meta line tells a
 * visitor nothing, and with the field cap it costs a slot a real field
 * (quantity, status) would have used.
 */
export function deriveScalarFields(
  rows: readonly Record<string, unknown>[],
  titleKey: string | undefined,
  max: number,
  excludeKeys: readonly (string | undefined)[] = [],
): FieldSpec[] {
  const first = rows[0];
  if (!first) return [];
  return scalarLeafEntries(first)
    .filter(
      (spec) =>
        spec.key !== titleKey &&
        !excludeKeys.includes(spec.key) &&
        !isIdentifierKey(spec.key),
    )
    .slice(0, max);
}

/**
 * One display field: which key to read, and optionally how to present it.
 * A format receives the whole record as its second argument so a value can be
 * presented with a sibling in view — money is an amount whose currency lives
 * on another leaf. Single-argument formats remain valid as they always were.
 */
export interface FieldSpec {
  key: string;
  label?: string;
  format?: (value: unknown, record?: Record<string, unknown>) => string;
}

/**
 * Per-key presentation for *derived* fields. Unlike an explicit field list,
 * this composes with shape-generic use: a component bound to several
 * different data types formats the keys it recognizes and leaves the rest to
 * the default formatter.
 */
export type FieldFormats = Readonly<
  Record<string, (value: unknown, record?: Record<string, unknown>) => string>
>;

export function applyFormats(
  specs: readonly FieldSpec[],
  formats: FieldFormats | undefined,
): FieldSpec[] {
  if (!formats) return [...specs];
  return specs.map((spec) =>
    spec.format || !formats[spec.key] ? spec : { ...spec, format: formats[spec.key] },
  );
}

/**
 * Segments that must never be walked, whatever a key says.
 *
 * The same guard `applyDataModelPatch` uses on JSON Pointer segments, for the
 * same reason: a key is data, and `__proto__` in a data-driven path walk reaches
 * the prototype chain rather than the record.
 */
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Reads a possibly-nested field by dotted path.
 *
 * The approval layer already names nested fields this way — an approved output
 * field is a path like `category.name`, and the executed payload nests
 * accordingly. The renderers only ever did `record[key]`, a flat lookup, so a
 * field the owner had explicitly approved could not be addressed at all: the
 * literal key `"category.name"` missed, and rendered as empty.
 *
 * A plain key with no dot resolves exactly as before, so every existing caller
 * is unaffected.
 */
export function resolveFieldValue(record: Record<string, unknown>, key: string): unknown {
  if (!key.includes(".")) return record[key];
  let current: unknown = record;
  for (const segment of key.split(".")) {
    if (UNSAFE_PATH_SEGMENTS.has(segment)) return undefined;
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function renderField(spec: FieldSpec, record: Record<string, unknown>): string {
  const raw = resolveFieldValue(record, spec.key);
  return spec.format ? spec.format(raw, record) : formatValue(raw);
}

export interface FieldPresence {
  value: unknown;
  /**
   * False only when a record along the path lacks the key itself — the plan
   * never fetched the field. A key that is present with a null value, or a
   * path hidden under a null ancestor, is `fetched: true`: nulls are data.
   */
  fetched: boolean;
}

/**
 * `resolveFieldValue` plus the distinction it erases: a missing key and a
 * null value both resolve to nothing, but they mean opposite things — "the
 * plan did not fetch this" versus "the record has no value here". One column
 * rendering both as the same dash is two claims in one pixel.
 */
export function resolveFieldPresence(
  record: Record<string, unknown>,
  key: string,
): FieldPresence {
  let current: unknown = record;
  for (const segment of key.split(".")) {
    if (UNSAFE_PATH_SEGMENTS.has(segment)) return { value: undefined, fetched: true };
    if (!isRecord(current)) return { value: undefined, fetched: true };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { value: undefined, fetched: false };
    }
    current = current[segment];
  }
  return { value: current, fetched: true };
}

/**
 * Like `renderField`, but a never-fetched value renders as its own marker —
 * the same quiet dash, carrying "Not fetched" for the pointer and the screen
 * reader — so it cannot be read as a fetched null.
 */
export function renderFieldNode(
  spec: FieldSpec,
  record: Record<string, unknown>,
  parts: PartsApi,
): ReactNode {
  const { value, fetched } = resolveFieldPresence(record, spec.key);
  if (!fetched) {
    return (
      <span
        className={parts.cls("notFetched")}
        style={parts.sty("notFetched")}
        title="Not fetched — the plan behind this view did not include this field"
        aria-label="Not fetched"
      >
        —
      </span>
    );
  }
  return spec.format ? spec.format(value, record) : formatValue(value);
}

/**
 * Says so when a result was cut short.
 *
 * Deliberately in the same footer as provenance and not as a warning banner:
 * it is a statement about what the numbers cover, which is exactly what a
 * source and an as-of date are.
 */
const Completeness: FC<{
  completeness?: SlotCompanions["completeness"];
  parts: PartsApi;
}> = ({ completeness, parts }) => {
  const degraded = completeness?.degradedFields ?? [];
  // `narrowedAfterFetch` without `truncated`: the fetch met its own ask, but a
  // plan-level filter/sort ran over one page of a larger dataset, so matches
  // may exist beyond what was searched. Silent, this renders exactly like the
  // whole answer — the completeness lie this footer exists to prevent.
  const narrowed =
    completeness?.narrowedAfterFetch === true && completeness?.truncated !== true;
  if (!completeness?.truncated && !narrowed && degraded.length === 0) return null;
  const { rowCount } = completeness ?? {};
  // The one honest counter: totalRows when the runtime reported it, "at
  // least" when it only knows the set continues — never the page size as
  // if it were the set.
  const { count, exact } = countBeyondPage(rowCount, completeness);
  const detail =
    rowCount === undefined
      ? "Showing a partial result"
      : exact
        ? `Showing ${rowCount} of ${count}`
        : `Showing at least ${count}`;
  const searched = completeness?.rowsBeforeNarrowing;
  return (
    <p className={parts.cls("truncated")} style={parts.sty("truncated")}>
      {completeness?.truncated
        ? `${detail} — this result was cut short, so totals and counts are incomplete.`
        : narrowed
          ? `Matched within ${searched !== undefined ? `the ${searched} records` : "the records"} fetched — more may exist beyond them.`
          : null}
      {(completeness?.truncated || narrowed) && degraded.length > 0 ? " " : null}
      {degraded.length > 0
        ? `The source could not return ${degraded.join(", ")}, so ${degraded.length === 1 ? "that value is" : "those values are"} blank here rather than absent from the record.`
        : null}
    </p>
  );
};

const Provenance: FC<{
  sources?: readonly SourceStamp[] | null;
  asOf?: string | null;
  parts: PartsApi;
}> = ({ sources, asOf, parts }) => {
  const labels = [...new Set((sources ?? []).filter(Boolean))];
  if (labels.length === 0 && !asOf) return null;
  return (
    <footer className={parts.cls("provenance")} style={parts.sty("provenance")}>
      {labels.length > 0 ? `Source: ${labels.join(", ")}` : ""}
      {labels.length > 0 && asOf ? " · " : ""}
      {asOf ? `as of ${formatValue(asOf)}` : ""}
    </footer>
  );
};

export interface StateShellProps extends SlotCompanions {
  heading?: string;
  /** Lets data render even when a host feeds the component outside a plan (no state written). */
  hasData: boolean;
  parts: PartsApi;
  messages?: StarterMessages;
  hideProvenance?: boolean;
  children: ReactNode;
}

/**
 * The standard lifecycle wrapper: every starter component distinguishes
 * loading, empty, failed, and ready without its author writing any of it,
 * and shows provenance whenever the executor supplied it.
 */
export const StateShell: FC<StateShellProps> = ({
  heading,
  state,
  errorMessage,
  sources,
  asOf,
  completeness,
  hasData,
  parts,
  messages,
  hideProvenance,
  children,
}) => {
  // `pending` is named rather than left to the fallback. It already reached
  // "loading" by being unrecognised, which is the right pixel for the wrong
  // reason: a state the component does not know about is indistinguishable
  // from one it is waiting on, and only one of those should render a spinner.
  const status =
    state === "error"
      ? "error"
      : state === "empty"
        ? "empty"
        : state === "pending"
          ? "loading"
          : state === "ready" || hasData
            ? "ready"
            : "loading";

  return (
    <section
      ref={useExternalClassGuard(parts.reliesOnExternalClasses)}
      className={parts.cls("root")}
      style={parts.sty("root")}
    >
      {heading ? (
        <header className={parts.cls("header")} style={parts.sty("header")}>
          <h3 className={parts.cls("heading")} style={parts.sty("heading")}>
            {heading}
          </h3>
        </header>
      ) : null}
      {status === "loading" ? (
        // A skeleton in place of a sentence: while a streamed compose fills
        // this slot, the shape of what is coming reads faster than the word
        // "Loading". The keyframes ride inline with the bars because the
        // starter styles are inline everywhere else — there is no stylesheet
        // to put them in, and a duplicate <style> per loading component is
        // inert. The message stays for screen readers (and hosts that set
        // messages.loading still see their words).
        <div
          className={parts.cls("skeleton")}
          style={parts.sty("skeleton")}
          role="status"
          aria-label={messages?.loading ?? "Loading…"}
        >
          <style>{"@keyframes iv-starter-shimmer{0%,100%{opacity:.45}50%{opacity:1}}"}</style>
          {[92, 100, 78].map((width, index) => (
            <span
              key={index}
              className={parts.cls("skeletonBar")}
              style={
                parts.sty("skeletonBar")
                  ? { ...parts.sty("skeletonBar"), width: `${width}%` }
                  : undefined
              }
            />
          ))}
        </div>
      ) : null}
      {status === "error" ? (
        <p role="alert" className={parts.cls("error")} style={parts.sty("error")}>
          {messages?.error ?? (errorMessage || "Something went wrong loading this data.")}
        </p>
      ) : null}
      {status === "empty" ? (
        <p className={parts.cls("empty")} style={parts.sty("empty")}>
          {messages?.empty ?? "No matching records."}
        </p>
      ) : null}
      {status === "ready" ? children : null}
      {status === "ready" ? (
        <Completeness completeness={completeness} parts={parts} />
      ) : null}
      {status === "ready" && !hideProvenance ? (
        <Provenance sources={sources} asOf={asOf} parts={parts} />
      ) : null}
    </section>
  );
};

/**
 * Warns when a component has been told to rely on the host's own CSS classes
 * and has been mounted somewhere those classes cannot reach.
 *
 * `shadcnStarterTheme()` sets `unstyled` and a table of Tailwind utilities.
 * That is correct in `renderMode: "host"` and silently fatal in the *default*
 * `"isolated"`: the host's stylesheet does not cross a shadow boundary, so the
 * classes resolve to nothing — and `unstyled` has already thrown away the
 * inline styles that would have carried the component. The result is a finished
 * frame around a raw table, which reads as a broken library rather than as a
 * configuration that cannot work.
 *
 * Detected rather than guessed: the element asks what root it is actually in.
 * Warned rather than repaired, because there is no repair from here — keeping
 * the inline styles would beat the host's classes in the mode where they *do*
 * work, which is the case the preset exists for.
 */
const warnedExternalClasses = new Set<string>();

function useExternalClassGuard(active: boolean) {
  return useCallback(
    (element: HTMLElement | null) => {
      if (!active || !element || typeof ShadowRoot === "undefined") return;
      if (!(element.getRootNode() instanceof ShadowRoot)) return;
      const key = element.className;
      if (warnedExternalClasses.has(key)) return;
      warnedExternalClasses.add(key);
      console.warn(
        "[renderyes/starter-catalog] This component was configured with " +
          "`unstyled` and host class names (shadcnStarterTheme, or your own " +
          "`classNames`), but it is rendering inside a shadow root — where your " +
          "stylesheet does not reach, so those classes match nothing and the " +
          "built-in styles have been switched off. Set " +
          '`renderMode: "host"` on ViewProvider, or drop `unstyled` and theme ' +
          "through the --iv-starter-* custom properties, which do cross the " +
          "boundary.",
      );
    },
    [active],
  );
}
