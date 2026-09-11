import type { FC } from "react";
import { defineHostComponent, defineProps, field } from "@renderyes/react";
import type { RegisteredHostComponent } from "@renderyes/react";
import type { ComponentDataAcceptance } from "@renderyes/site-sdk";
import {
  applyFormats,
  createParts,
  humanize,
  isRecord,
  renderField,
  scalarLeafEntries,
  StateShell,
  type FieldSpec,
  type FieldFormats,
  type SlotCompanions,
  type StarterComponentOptions,
} from "./shared.js";

/**
 * One record, plus the collections inside it.
 *
 * This is what `entity` usually means in a real schema. A Shopify order carries
 * roughly forty scalar fields, twenty single nested objects, and fifteen lists;
 * a Saleor order has line items, a Stripe invoice has line items, a GitHub pull
 * request has commits and reviews. The detail panel rendered the scalars, showed
 * nested objects as groups, and had nowhere to put the lists — so `lineItems`
 * simply did not appear, which on an order is most of the answer.
 *
 * Distinct from a join, deliberately. Every admin framework separates the two:
 * React Admin has `ArrayField` for an array already in the record and
 * `ReferenceManyField` for a related resource fetched separately. This is the
 * first — the rows arrived inside the approved payload, so no relationship and
 * no second capability is involved. Related resources go through an approved
 * relationship instead, and are a different mechanism with a different
 * authorization story.
 */
export interface RecordWithLinesOptions extends StarterComponentOptions {
  /** Header fields, in order. Defaults to the record's own scalar fields. */
  fields?: readonly FieldSpec[];
  /**
   * Which embedded arrays to render as tables, in order. Defaults to every
   * array-of-objects the record carries.
   */
  lineKeys?: readonly string[];
  /** Columns per line table, keyed by the array's own field name. */
  lineColumns?: Readonly<Record<string, readonly FieldSpec[]>>;
  /** Cap on rows shown per table, so one long array cannot bury the record. */
  maximumLinesShown?: number;
  formats?: FieldFormats;
  accepts?: readonly ComponentDataAcceptance[];
}

export interface RecordWithLinesViewProps extends SlotCompanions {
  heading?: string;
  entity?: unknown;
}

function isRowArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isRecord);
}

// Leaf paths, not top-level keys: an order's total sits at
// `total.gross.amount`, and a one-level scan left the money out of the header.
// Row arrays are skipped by the walk, so the line tables below never repeat
// as dotted header rows.
function scalarHeaderFields(entity: Record<string, unknown>): FieldSpec[] {
  return scalarLeafEntries(entity, { scalarArrays: true });
}

/** Column set for one embedded array: the union of its rows' scalar leaves. */
function columnsFor(rows: readonly Record<string, unknown>[]): FieldSpec[] {
  const keys: string[] = [];
  for (const row of rows) {
    // Leaves as dotted columns — a line's own money sits at
    // `totalPrice.gross.amount`. That is a column, not a table of tables:
    // descending into an object is not the same as rendering one.
    for (const spec of scalarLeafEntries(row)) {
      if (!keys.includes(spec.key)) keys.push(spec.key);
    }
  }
  return keys.map((key) => ({ key }));
}

export function createRecordWithLinesView(
  options: RecordWithLinesOptions = {},
): FC<RecordWithLinesViewProps> {
  const parts = createParts(options);
  const maximumLinesShown = options.maximumLinesShown ?? 50;

  return function StarterRecordWithLinesView({ heading, entity, ...companions }) {
    const record = isRecord(entity) ? entity : undefined;
    const headerFields = applyFormats(
      options.fields && options.fields.length > 0
        ? [...options.fields]
        : record
          ? scalarHeaderFields(record)
          : [],
      options.formats,
    );

    const lineGroups = record
      ? (options.lineKeys ?? Object.keys(record))
          .map((key) => ({ key, rows: record[key] }))
          .filter((group): group is { key: string; rows: Record<string, unknown>[] } =>
            isRowArray(group.rows),
          )
          .map((group) => ({
            key: group.key,
            rows: group.rows,
            columns: applyFormats(
              options.lineColumns?.[group.key] ?? columnsFor(group.rows),
              options.formats,
            ),
          }))
      : [];

    return (
      <StateShell
        heading={heading}
        hasData={Boolean(record && (headerFields.length > 0 || lineGroups.length > 0))}
        parts={parts}
        messages={options.messages}
        hideProvenance={options.hideProvenance}
        {...companions}
      >
        {record ? (
          <dl className={parts.cls("body")} style={{ margin: 0 }}>
            {headerFields.map((spec) => (
              <div
                key={spec.key}
                className={parts.cls("fieldRow")}
                style={parts.sty("fieldRow")}
              >
                <dt className={parts.cls("fieldLabel")} style={parts.sty("fieldLabel")}>
                  {spec.label ?? humanize(spec.key)}
                </dt>
                <dd
                  className={parts.cls("fieldValue")}
                  style={{ margin: 0, ...parts.sty("fieldValue") }}
                >
                  {renderField(spec, record)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {lineGroups.map((group) => (
          <section key={group.key}>
            <h4
              className={parts.cls("groupTitle")}
              style={{ margin: "12px 0 4px", fontSize: 13, ...parts.sty("groupTitle") }}
            >
              {humanize(group.key)}
            </h4>
            <table className={parts.cls("table")} style={parts.sty("table")}>
              <thead>
                <tr>
                  {group.columns.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={parts.cls("headCell")}
                      style={parts.sty("headCell")}
                    >
                      {column.label ?? humanize(column.key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.rows.slice(0, maximumLinesShown).map((row, index) => (
                  <tr
                    key={index}
                    className={parts.cls("row")}
                    style={parts.sty("row")}
                  >
                    {group.columns.map((column) => (
                      <td
                        key={column.key}
                        className={parts.cls("cell")}
                        style={parts.sty("cell")}
                      >
                        {renderField(column, row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {group.rows.length > maximumLinesShown ? (
              // Said rather than silently sliced, for the same reason the
              // runtime reports `truncated`: a shortened list presented as the
              // whole one is a wrong answer, not a smaller one.
              <p className={parts.cls("truncated")} style={parts.sty("truncated")}>
                {`Showing ${maximumLinesShown} of ${group.rows.length}.`}
              </p>
            ) : null}
          </section>
        ))}
      </StateShell>
    );
  };
}

/**
 * A record and its embedded collections. Accepts by shape, so it works against
 * any approved catalog whose entity carries line items.
 */
export function createRecordWithLines(
  options: RecordWithLinesOptions = {},
): RegisteredHostComponent {
  return defineHostComponent({
    id: options.id ?? "StarterRecordWithLines",
    version: options.version ?? "1.0.0",
    description:
      options.description ??
      "One record shown in full, with any lists inside it rendered as tables. Use for an order with line items, an invoice with charges, or any single item that contains a collection.",
    props: defineProps({
      heading: field.string({
        default: options.defaultHeading ?? "Record",
        description:
          "Heading shown above the component. Restate the visitor's request in their own words — not the data type's internal name.",
      }),
    }),
    dataSlots: {
      entity: { accepts: options.accepts ?? [{ shape: "entity" }] },
    },
    component: createRecordWithLinesView(options),
  });
}
