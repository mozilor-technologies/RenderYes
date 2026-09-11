/**
 * Chart components, exported from `@renderyes/starter-catalog/charts` —
 * a separate entry point on purpose. These are the only starter components
 * with a third-party dependency (recharts, an optional peer), so a host that
 * never imports this module never pays for or installs it.
 */
import type { FC } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { defineHostComponent } from "@renderyes/react";
import type { RegisteredHostComponent } from "@renderyes/react";
import {
  barChartHostInput,
  donutChartHostInput,
  lineChartHostInput,
  type ChartContractOptions,
} from "./chart-definitions.js";
import {
  createParts,
  formatValue,
  humanize,
  isIdentifierKey,
  isRecord,
  resolveFieldValue,
  scalarLeafEntries,
  StateShell,
  type SlotCompanions,
  type StarterComponentOptions,
} from "./shared.js";

/**
 * Axis ticks through the same formatter every other component uses. Without
 * it a date axis rendered raw ISO-8601 with microseconds
 * ("2026-04-21T05:39:54.567073+00:00") — the one place in the suite where a
 * date semantic type reached the screen unformatted.
 */
const formatTick = (value: unknown) => formatValue(value);

export interface ChartOptions extends StarterComponentOptions, ChartContractOptions {
  /**
   * Key plotted along the x axis. Defaults to the first string field of the
   * first row (dates and labels are both strings by the time they reach a
   * component).
   */
  xKey?: string;
  /** Numeric keys plotted as series. Defaults to the numeric fields, capped. */
  yKeys?: readonly string[];
  /** Cap for derived series. Default 3. */
  maxSeries?: number;
  /** Chart height in pixels. Default 260. */
  height?: number;
  /**
   * Series colors, in order. SVG can't resolve CSS custom properties in
   * presentation attributes, so unlike the rest of the starter styling these
   * are concrete values.
   */
  colors?: readonly string[];
}

export interface ChartViewProps extends SlotCompanions {
  heading?: string;
  rows?: readonly unknown[] | null;
}

const DEFAULT_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#0ea5e9"];

/**
 * Axis derivation over leaf paths, not top-level keys.
 *
 * A Relay-shaped row keeps every number inside nested objects
 * (`total.gross.amount`), so enumerating one level found no numeric field:
 * `yKeys` came back empty and the chart rendered its empty state over
 * non-empty rows, silently. Leaf paths fix that, and recharts resolves dotted
 * `dataKey`s natively, so nothing downstream changes.
 *
 * Numeric detection samples a few rows, same as `deriveImageKey`: one leading
 * row with a null object must not hide the series behind it.
 */
export function resolveAxes(
  rows: readonly Record<string, unknown>[],
  options: ChartOptions,
): { xKey?: string; yKeys: string[] } {
  const first = rows[0];
  if (!first) return { xKey: options.xKey, yKeys: [...(options.yKeys ?? [])] };
  const sample = rows.slice(0, 5);
  const leafKeys = [
    ...new Set(sample.flatMap((row) => scalarLeafEntries(row).map((spec) => spec.key))),
  ];
  const typeOf = (key: string) => {
    for (const row of sample) {
      const value = resolveFieldValue(row, key);
      if (value !== null && value !== undefined) return typeof value;
    }
    return "undefined";
  };
  // Prefer a non-identifier string leaf for the x axis (and the donut's slice
  // names, which come through the same resolver): an axis labeled p_1…p_9
  // charts nothing a visitor can read. The catalog knows which field is the
  // identifier; at runtime only the key name survives, so the shared name
  // check stands in. When an id field is the *only* string leaf it still
  // wins — an id axis beats an unlabeled one.
  const stringKeys = leafKeys.filter((key) => typeOf(key) === "string");
  const xKey =
    options.xKey ??
    stringKeys.find((key) => !isIdentifierKey(key)) ??
    stringKeys[0] ??
    Object.keys(first)[0];
  const yKeys =
    options.yKeys && options.yKeys.length > 0
      ? [...options.yKeys]
      : leafKeys
          .filter((key) => key !== xKey && typeOf(key) === "number")
          .slice(0, options.maxSeries ?? 3);
  return { xKey, yKeys };
}

function createChartView(
  options: ChartOptions,
  kind: "bar" | "line",
): FC<ChartViewProps> {
  const parts = createParts(options);
  const height = options.height ?? 260;
  const colors = options.colors ?? DEFAULT_COLORS;

  return function StarterChartView({ heading, rows, ...companions }) {
    const list = (Array.isArray(rows) ? rows : []).filter(isRecord);
    const { xKey, yKeys } = resolveAxes(list, options);
    const plottable = list.length > 0 && yKeys.length > 0;

    return (
      <StateShell
        heading={heading}
        hasData={plottable}
        parts={parts}
        messages={options.messages}
        hideProvenance={options.hideProvenance}
        {...companions}
      >
        <div className={parts.cls("chart")} style={parts.sty("chart")}>
          {/* Height goes to the container as a number, and bars/lines skip the
              entry animation: the composed workspace mounts while its parent
              is still resizing, and recharts' animation freezes the scale it
              measured first — axes then re-render correctly but bars keep the
              tiny initial geometry. */}
          <ResponsiveContainer width="100%" height={height}>
            {kind === "bar" ? (
              <BarChart data={list as Record<string, unknown>[]}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey={xKey} fontSize={12} tickFormatter={formatTick} />
                <YAxis fontSize={12} width={40} />
                <Tooltip />
                {yKeys.length > 1 ? <Legend /> : null}
                {yKeys.map((key, i) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    isAnimationActive={false}
                    name={humanize(key)}
                    fill={colors[i % colors.length]}
                    radius={[3, 3, 0, 0]}
                  />
                ))}
              </BarChart>
            ) : (
              <LineChart data={list as Record<string, unknown>[]}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey={xKey} fontSize={12} tickFormatter={formatTick} />
                <YAxis fontSize={12} width={40} />
                <Tooltip />
                {yKeys.length > 1 ? <Legend /> : null}
                {yKeys.map((key, i) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    isAnimationActive={false}
                    name={humanize(key)}
                    stroke={colors[i % colors.length]}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      </StateShell>
    );
  };
}

export function createBarChartView(options: ChartOptions = {}): FC<ChartViewProps> {
  return createChartView(options, "bar");
}

/**
 * Donut view: one category (from `xKey` or the first string field) sliced by
 * one value (the first entry of `yKeys`, or the first numeric field).
 */
export function createDonutChartView(options: ChartOptions = {}): FC<ChartViewProps> {
  const parts = createParts(options);
  const height = options.height ?? 260;
  const colors = options.colors ?? DEFAULT_COLORS;

  return function StarterDonutChartView({ heading, rows, ...companions }) {
    const list = (Array.isArray(rows) ? rows : []).filter(isRecord);
    const { xKey, yKeys } = resolveAxes(list, options);
    const valueKey = yKeys[0];
    const plottable = list.length > 0 && Boolean(xKey) && Boolean(valueKey);

    return (
      <StateShell
        heading={heading}
        hasData={plottable}
        parts={parts}
        messages={options.messages}
        hideProvenance={options.hideProvenance}
        {...companions}
      >
        <div className={parts.cls("chart")} style={parts.sty("chart")}>
          <ResponsiveContainer width="100%" height={height}>
            <PieChart>
              <Pie
                data={list as Record<string, unknown>[]}
                dataKey={valueKey}
                nameKey={xKey}
                innerRadius="55%"
                outerRadius="85%"
                paddingAngle={2}
                isAnimationActive={false}
              >
                {list.map((_, i) => (
                  <Cell key={i} fill={colors[i % colors.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </StateShell>
    );
  };
}

export function createLineChartView(options: ChartOptions = {}): FC<ChartViewProps> {
  return createChartView(options, "line");
}

/**
 * Bar chart over any approved collection: categories along x, numeric fields
 * as bars. The contract comes from `barChartHostInput`, the same function
 * behind `createBarChartDefinition` on the main entry — so a server
 * publishing the definition and a browser registering this view can never
 * disagree about the contract.
 */
export function createBarChart(options: ChartOptions = {}): RegisteredHostComponent {
  return defineHostComponent({
    ...barChartHostInput(options),
    component: createBarChartView(options),
  });
}

/**
 * Line chart over any approved collection ordered by date or sequence.
 */
export function createLineChart(options: ChartOptions = {}): RegisteredHostComponent {
  return defineHostComponent({
    ...lineChartHostInput(options),
    component: createLineChartView(options),
  });
}

/**
 * Donut chart over any approved collection — each row a slice, sized by its
 * first numeric field. The share-of-the-whole complement to the bar chart.
 */
export function createDonutChart(options: ChartOptions = {}): RegisteredHostComponent {
  return defineHostComponent({
    ...donutChartHostInput(options),
    component: createDonutChartView(options),
  });
}
