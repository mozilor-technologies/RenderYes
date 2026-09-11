/**
 * Chart *contracts* — id, description, props, data slots — with no recharts
 * anywhere in sight, exported from the package's main entry.
 *
 * A component definition is built entirely from its contract; the React view
 * never shapes it. Splitting the two matters for definition-only consumers —
 * a Node host publishing `createBarChart().definition` from a seed script —
 * which previously had to install recharts just because importing the
 * `/charts` entry evaluates its imports. Now they call
 * `createBarChartDefinition()` from the main entry and install nothing.
 * The `/charts` entry builds its real views on these same contract functions,
 * so the two can never drift.
 */
import type { FC } from "react";
import { defineHostComponent, defineProps, field } from "@renderyes/react";
import type {
  ComponentDataAcceptance,
  SiteComponentDefinition,
} from "@renderyes/site-sdk";

/** The contract half of a chart's options — everything the planner can see. */
export interface ChartContractOptions {
  id?: string;
  version?: string;
  /** Planner-facing description override. Write it for a model. */
  description?: string;
  /** Default heading shown when the planner sets none. */
  defaultHeading?: string;
  accepts?: readonly ComponentDataAcceptance[];
}

interface ChartContractDefaults {
  id: string;
  description: string;
  defaultHeading: string;
  /**
   * Shapes this chart accepts when the host names none.
   *
   * Only the line chart takes `time-series`, and it takes it because it was
   * already the renderer for one — its description says "ordered by date or
   * sequence… trends over time" — while accepting `collection` alone. So
   * `inferResultShape` classified a dated root as `time-series` and then nothing
   * could render it: the same defect `metric` had, sitting next to it.
   *
   * A bar chart over dated buckets is defensible and deliberately left out. One
   * renderer per shape is enough to make it reachable, and widening acceptance
   * gives the planner more ways to pick wrongly.
   *
   * Every collection acceptance carries `requiresGrouping`: a chart over raw
   * rows draws one mark per record under a heading asserting a computation
   * that never ran (measured: three "revenue trend" charts of a hundred raw
   * orders, and an x axis of order numbers). Against a catalog with no
   * grouping support the planner now refuses the chart — the intended
   * outcome; a host who wants raw-row marks passes their own `accepts`.
   */
  accepts: readonly ComponentDataAcceptance[];
}

const BAR_DEFAULTS: ChartContractDefaults = {
  id: "StarterBarChart",
  description:
    "Bar chart over grouped data. Use for comparisons and breakdowns by category — counts per status, totals per plan, results per group. The bound request must group and aggregate (query.groupBy + aggregates); raw ungrouped rows will not bind.",
  defaultHeading: "Breakdown",
  accepts: [{ shape: "collection", requiresGrouping: true }],
};

const LINE_DEFAULTS: ChartContractDefaults = {
  id: "StarterLineChart",
  description:
    "Line chart over a time series or grouped data. Use for trends over time — signups per week, revenue by month, activity by day. A collection binds only when the request groups and aggregates (query.groupBy + aggregates); raw ungrouped rows will not bind.",
  defaultHeading: "Trend",
  accepts: [{ shape: "collection", requiresGrouping: true }, { shape: "time-series" }],
};

const DONUT_DEFAULTS: ChartContractDefaults = {
  id: "StarterDonutChart",
  description:
    "Donut chart showing each category's share of the whole. Use for proportion questions — what portion of applications are approved, share of sales per region. The bound request must group and aggregate (query.groupBy + aggregates); raw ungrouped rows will not bind.",
  defaultHeading: "Share",
  accepts: [{ shape: "collection", requiresGrouping: true }],
};

function chartHostInput(defaults: ChartContractDefaults, options: ChartContractOptions) {
  return {
    id: options.id ?? defaults.id,
    version: options.version ?? "1.0.0",
    description: options.description ?? defaults.description,
    props: defineProps({
      heading: field.string({
        default: options.defaultHeading ?? defaults.defaultHeading,
        description:
          "Heading shown above the component. Restate the visitor's request in their own words — not the data type's internal name.",
      }),
    }),
    dataSlots: {
      rows: { accepts: options.accepts ?? defaults.accepts },
    },
  };
}

export function barChartHostInput(options: ChartContractOptions = {}) {
  return chartHostInput(BAR_DEFAULTS, options);
}

export function lineChartHostInput(options: ChartContractOptions = {}) {
  return chartHostInput(LINE_DEFAULTS, options);
}

export function donutChartHostInput(options: ChartContractOptions = {}) {
  return chartHostInput(DONUT_DEFAULTS, options);
}

/**
 * Definitions carry no rendering, so the component here is a placeholder
 * that must never actually render. Registering it browser-side instead of
 * the real chart would draw nothing — use `/charts` for that.
 */
const DefinitionOnly: FC = () => null;

/** The bar chart's contract alone — for servers that publish but never render. */
export function createBarChartDefinition(
  options: ChartContractOptions = {},
): SiteComponentDefinition {
  return defineHostComponent({ ...barChartHostInput(options), component: DefinitionOnly })
    .definition;
}

/** The line chart's contract alone — for servers that publish but never render. */
export function createLineChartDefinition(
  options: ChartContractOptions = {},
): SiteComponentDefinition {
  return defineHostComponent({ ...lineChartHostInput(options), component: DefinitionOnly })
    .definition;
}

/** The donut chart's contract alone — for servers that publish but never render. */
export function createDonutChartDefinition(
  options: ChartContractOptions = {},
): SiteComponentDefinition {
  return defineHostComponent({ ...donutChartHostInput(options), component: DefinitionOnly })
    .definition;
}
