import type { FC } from "react";
import { defineHostComponent, defineProps, field } from "@renderyes/react";
import type { RegisteredHostComponent } from "@renderyes/react";
import type { ComponentDataAcceptance } from "@renderyes/site-sdk";
import {
  applyFormats,
  collapseMoneyEntries,
  createParts,
  humanize,
  isIdentifierKey,
  isRecord,
  renderField,
  scalarLeafEntries,
  StateShell,
  type FieldSpec,
  type SlotCompanions,
  type StarterComponentOptions,
} from "./shared.js";

export interface MetricCardOptions extends StarterComponentOptions {
  /**
   * Which metric fields to show as tiles, in order. When absent, every
   * scalar field of the result is shown and nested arrays/objects are
   * skipped (a status-breakdown array is a chart's job, not a stat tile's).
   */
  entries?: readonly FieldSpec[];
  /** Format derived entries by key. */
  formats?: import("./shared.js").FieldFormats;
  accepts?: readonly ComponentDataAcceptance[];
}

export interface MetricCardViewProps extends SlotCompanions {
  heading?: string;
  metric?: unknown;
}

/**
 * Every scalar leaf of the metric, minus the identifiers.
 *
 * A stat tile shouting an id in 24px bold is the worst place an identifier can
 * land. The catalog knows which fields are identifiers; at runtime only the key
 * name survives, so the shared name check is the best we can do. A host that
 * truly wants one tiles it via explicit `entries`.
 */
function scalarEntries(metric: Record<string, unknown>): FieldSpec[] {
  return scalarLeafEntries(metric).filter((spec) => !isIdentifierKey(spec.key));
}

export function createMetricCardView(options: MetricCardOptions = {}): FC<MetricCardViewProps> {
  const parts = createParts(options);

  return function StarterMetricCardView({ heading, metric, ...companions }) {
    const record = isRecord(metric) ? metric : undefined;
    // Leaf enumeration, not one level: a Relay-shaped metric carries its figure
    // at `gross.amount`, and enumerating only the top level rendered the
    // currency code where the figure belonged. Enumeration alone then rendered
    // the currency as its own co-equal stat — the collapse reassembles each
    // amount with its currency into one tile ("Gross: 10,137.88 USD").
    const entries = applyFormats(
      options.entries && options.entries.length > 0
        ? [...options.entries]
        : record
          ? collapseMoneyEntries(scalarEntries(record), [record])
          : [],
      options.formats,
    );

    return (
      <StateShell
        heading={heading}
        hasData={Boolean(record && entries.length > 0)}
        parts={parts}
        messages={options.messages}
        hideProvenance={options.hideProvenance}
        {...companions}
      >
        <div className={parts.cls("grid")} style={parts.sty("grid")}>
          {record
            ? entries.map((entry) => (
                <div key={entry.key} className={parts.cls("tile")} style={parts.sty("tile")}>
                  <p className={parts.cls("tileLabel")} style={parts.sty("tileLabel")}>
                    {entry.label ?? humanize(entry.key)}
                  </p>
                  <p className={parts.cls("tileValue")} style={parts.sty("tileValue")}>
                    {renderField(entry, record)}
                  </p>
                </div>
              ))
            : null}
        </div>
      </StateShell>
    );
  };
}

/**
 * Labeled stat tiles over any approved metric result. Accepts by shape, so
 * any aggregate/summary capability can feed it.
 */
export function createMetricCard(options: MetricCardOptions = {}): RegisteredHostComponent {
  return defineHostComponent({
    id: options.id ?? "StarterMetricCard",
    version: options.version ?? "1.0.0",
    description:
      options.description ??
      "Summary metric panel. Renders the fields of one metric result as labeled stat tiles. Use for totals, rates, averages, and other aggregate statistics.",
    props: defineProps({
      heading: field.string({
        default: options.defaultHeading ?? "Summary",
        description:
          "Heading shown above the component. Restate the visitor's request in their own words — not the data type's internal name.",
      }),
    }),
    dataSlots: {
      metric: { accepts: options.accepts ?? [{ shape: "metric" }] },
    },
    component: createMetricCardView(options),
  });
}
