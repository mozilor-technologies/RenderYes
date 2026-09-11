import { useState } from "react";
import type { FC } from "react";
import { defineHostComponent, defineProps, field } from "@renderyes/react";
import type { RegisteredHostComponent } from "@renderyes/react";
import type { ComponentDataAcceptance } from "@renderyes/site-sdk";
import {
  activationFor,
  applyFormats,
  clickableStyle,
  collapseMoneyEntries,
  createParts,
  humanize,
  isIdentifierKey,
  isRecord,
  looksLikeOpaqueId,
  renderField,
  renderFieldNode,
  resolveFieldValue,
  scalarLeafEntries,
  StateShell,
  type FieldSpec,
  type SlotCompanions,
  type StarterComponentOptions,
} from "./shared.js";

export interface DataTableOptions extends StarterComponentOptions {
  /**
   * Columns to show, in order. When absent, columns are derived from the
   * union of row keys (sampled from the first 20 rows), capped at
   * `maxColumns` — deriving *every* field is exactly the generic-table
   * failure this component exists to avoid, so the cap is deliberate and low.
   */
  columns?: readonly FieldSpec[];
  /**
   * Cap for derived columns. Ignored when `columns` is explicit. Default 8.
   * Fields the cap drops are named in a "+N more" footnote — the cap trims
   * the layout, never silently the answer.
   */
  maxColumns?: number;
  /** Format derived (or explicit, format-less) columns by key. */
  formats?: import("./shared.js").FieldFormats;
  /** Override which result shapes this table accepts. */
  accepts?: readonly ComponentDataAcceptance[];
  /**
   * Host-owned URL for a row, e.g. `(row) => "/orders/" + row.id`. Rows it
   * returns a string for become clickable (mouse and keyboard). The model
   * never sees or influences these URLs.
   */
  getRowHref?: (row: Record<string, unknown>) => string | undefined;
  /** SPA alternative to `getRowHref` navigation: push through your router instead. */
  onRowActivate?: (row: Record<string, unknown>, href?: string) => void;
  /**
   * Render a search box that filters the rows *as displayed* — purely
   * client-side, over the already-approved, already-fetched result. It never
   * changes what data is requested.
   */
  searchable?: boolean;
  searchPlaceholder?: string;
  /**
   * Make column headers clickable to sort the displayed rows (click again to
   * reverse). Client-side over the fetched result, like `searchable`.
   */
  sortable?: boolean;
}

export interface DataTableViewProps extends SlotCompanions {
  heading?: string;
  rows?: readonly unknown[] | null;
}

export interface ColumnPlan {
  columns: FieldSpec[];
  /**
   * Fetched fields the column cap dropped. The cap is a legitimate layout
   * default; showing 8 of 15 fetched fields while saying nothing is not —
   * the table renders these as a "+N more" footnote, never silently.
   */
  omitted: FieldSpec[];
}

export function planColumns(
  explicit: readonly FieldSpec[] | undefined,
  rows: readonly Record<string, unknown>[],
  maxColumns: number,
): ColumnPlan {
  if (explicit && explicit.length > 0) return { columns: [...explicit], omitted: [] };
  // Leaf paths, not top-level keys: a Relay-shaped row keeps its numbers in
  // nested objects, and a top-level key union gave those objects a column
  // whose every cell rendered "…" — where the money belonged. Arrays of
  // objects become summary columns rather than vanishing from the union.
  const sampled = rows.slice(0, 20);
  const specs: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const row of sampled) {
    for (const spec of scalarLeafEntries(row, { objectArrays: true })) {
      if (!seen.has(spec.key)) {
        seen.add(spec.key);
        specs.push(spec);
      }
    }
  }
  const collapsed = collapseMoneyEntries(specs, sampled);
  // Identifier columns go last, and yield their seat first when the cap bites.
  // Two independent signals, because each catches what the other cannot: the
  // value shape spots an opaque token under an innocent name (a base64 `code`),
  // and the key name spots a readable id the shape test clears (`p_9`, `r_1`).
  // Ordering is not deferred to the cap the way the seat-yielding is: a table
  // that fits every column still reads better with the id at the far end,
  // because the catalog's field order almost always leads with it and the
  // leftmost column is the one a visitor actually scans.
  const isOpaqueColumn = (spec: FieldSpec): boolean => {
    const values = sampled
      .map((row) => resolveFieldValue(row, spec.key))
      .filter((value) => value !== null && value !== undefined);
    return values.length > 0 && values.every(looksLikeOpaqueId);
  };
  const ranked = collapsed.map((spec, index) => ({
    spec,
    index,
    opaque: isOpaqueColumn(spec) || isIdentifierKey(spec.key),
  }));
  const ordered = [
    ...ranked.filter((entry) => !entry.opaque),
    ...ranked.filter((entry) => entry.opaque),
  ];
  if (collapsed.length <= maxColumns) {
    return { columns: ordered.map((entry) => entry.spec), omitted: [] };
  }
  const kept = new Set(ordered.slice(0, maxColumns).map((entry) => entry.index));
  return {
    columns: ordered.filter((entry) => kept.has(entry.index)).map((entry) => entry.spec),
    omitted: ordered.filter((entry) => !kept.has(entry.index)).map((entry) => entry.spec),
  };
}

/** The columns of `planColumns`, for callers with no use for the omissions. */
export function resolveColumns(
  explicit: readonly FieldSpec[] | undefined,
  rows: readonly Record<string, unknown>[],
  maxColumns: number,
): FieldSpec[] {
  return planColumns(explicit, rows, maxColumns).columns;
}

export function createDataTableView(options: DataTableOptions = {}): FC<DataTableViewProps> {
  const parts = createParts(options);
  const maxColumns = options.maxColumns ?? 8;
  const rowActivation = {
    getHref: options.getRowHref,
    onActivate: options.onRowActivate,
  };

  return function StarterDataTableView({ heading, rows, ...companions }) {
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
    const list = (Array.isArray(rows) ? rows : []).filter(isRecord);
    const plan = planColumns(options.columns, list, maxColumns);
    const columns = applyFormats(plan.columns, options.formats);

    // Match against the text the visitor actually sees (formatted cells of
    // visible columns), so searching behaves like scanning the table.
    const needle = query.trim().toLowerCase();
    let visible = needle
      ? list.filter((row) =>
          columns.some((column) => renderField(column, row).toLowerCase().includes(needle)),
        )
      : list;

    // Sort on raw values, not display text, so numbers order numerically and
    // ISO dates chronologically. Nulls sink to the bottom either direction.
    if (sort) {
      visible = [...visible].sort((a, b) => {
        // Dotted-path read, same as the cells: a derived column names a leaf,
        // and a flat read would sort every row as undefined.
        const left = resolveFieldValue(a, sort.key);
        const right = resolveFieldValue(b, sort.key);
        if (left === right) return 0;
        if (left === null || left === undefined) return 1;
        if (right === null || right === undefined) return -1;
        if (typeof left === "number" && typeof right === "number") {
          return (left - right) * sort.dir;
        }
        return String(left).localeCompare(String(right), undefined, { numeric: true }) * sort.dir;
      });
    }

    const toggleSort = (key: string) =>
      setSort((current) =>
        current?.key === key
          ? current.dir === 1
            ? { key, dir: -1 }
            : null
          : { key, dir: 1 },
      );

    return (
      <StateShell
        heading={heading}
        hasData={list.length > 0}
        parts={parts}
        messages={options.messages}
        hideProvenance={options.hideProvenance}
        {...companions}
      >
        {options.searchable ? (
          <div className={parts.cls("toolbar")} style={parts.sty("toolbar")}>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={options.searchPlaceholder ?? "Search…"}
              aria-label={options.searchPlaceholder ?? "Search rows"}
              className={parts.cls("searchInput")}
              style={parts.sty("searchInput")}
            />
          </div>
        ) : null}
        {visible.length === 0 ? (
          <p className={parts.cls("empty")} style={parts.sty("empty")}>
            {needle
              ? "No rows match your search."
              : (options.messages?.empty ?? "No matching records.")}
          </p>
        ) : (
          <div className={parts.cls("body")} style={parts.sty("body")}>
            <table className={parts.cls("table")} style={parts.sty("table")}>
              <thead>
                <tr>
                  {columns.map((column) => {
                    const active = sort?.key === column.key;
                    const sortProps = options.sortable
                      ? {
                          onClick: () => toggleSort(column.key),
                          onKeyDown: (event: { key: string }) => {
                            if (event.key === "Enter") toggleSort(column.key);
                          },
                          tabIndex: 0,
                          role: "button" as const,
                          "aria-sort": (active
                            ? sort.dir === 1
                              ? "ascending"
                              : "descending"
                            : "none") as "ascending" | "descending" | "none",
                        }
                      : {};
                    return (
                      <th
                        key={column.key}
                        scope="col"
                        className={parts.cls("headCell")}
                        style={
                          options.sortable && !options.unstyled
                            ? { ...parts.sty("headCell"), cursor: "pointer" }
                            : parts.sty("headCell")
                        }
                        {...sortProps}
                      >
                        {column.label ?? humanize(column.key)}
                        {active ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visible.map((row, index) => {
                  const activation = activationFor(row, rowActivation);
                  return (
                    <tr
                      key={index}
                      className={
                        parts.cls("row") + (activation ? " iv-starter-clickable" : "")
                      }
                      style={
                        activation && !options.unstyled
                          ? { ...parts.sty("row"), ...clickableStyle }
                          : parts.sty("row")
                      }
                      {...activation?.props}
                    >
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          className={parts.cls("cell")}
                          style={parts.sty("cell")}
                        >
                          {renderFieldNode(column, row, parts)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {plan.omitted.length > 0 ? (
              // The cap said less than the plan fetched; say so. Silence here
              // is a wrong answer wearing a complete one's clothes.
              <p
                className={parts.cls("omittedFields")}
                style={parts.sty("omittedFields")}
              >
                {`+${plan.omitted.length} more fetched field${
                  plan.omitted.length === 1 ? "" : "s"
                } not shown: ${plan.omitted
                  .map((spec) => spec.label ?? humanize(spec.key))
                  .join(", ")}.`}
              </p>
            ) : null}
          </div>
        )}
      </StateShell>
    );
  };
}

/**
 * A general-purpose table over any approved collection. Accepts data by
 * shape, so it works against any host's catalog without naming a data type.
 */
export function createDataTable(options: DataTableOptions = {}): RegisteredHostComponent {
  return defineHostComponent({
    id: options.id ?? "StarterDataTable",
    version: options.version ?? "1.0.0",
    description:
      options.description ??
      "General-purpose data table. Renders any approved collection or search result as rows and columns under a heading. Use for lists of records.",
    props: defineProps({
      heading: field.string({
        default: options.defaultHeading ?? "Results",
        description:
          "Heading shown above the component. Restate the visitor's request in their own words — not the data type's internal name.",
      }),
    }),
    dataSlots: {
      rows: {
        accepts: options.accepts ?? [{ shape: "collection" }, { shape: "search-results" }],
      },
    },
    component: createDataTableView(options),
  });
}
