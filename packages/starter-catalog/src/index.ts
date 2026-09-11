/**
 * @renderyes/starter-catalog — a deliberately small set of reusable host
 * components. Every component:
 *
 * - accepts data **by shape** (`{ shape: "collection" }`), never by a
 *   host-specific `dataTypeId`, so it works against any approved catalog;
 * - handles loading, empty, and error states itself;
 * - shows provenance (source and as-of) by default;
 * - themes through `--iv-starter-*` CSS custom properties and stable
 *   `iv-starter-*` class names, or fully host-styled via `unstyled` +
 *   `classNames`.
 *
 * Each factory returns a `RegisteredHostComponent` ready for
 * `ViewConfig.components`; the matching `create*View` returns the plain
 * React component for hosts that want to reuse the rendering directly.
 */
export {
  createDataTable,
  createDataTableView,
  planColumns,
  resolveColumns,
  type ColumnPlan,
  type DataTableOptions,
  type DataTableViewProps,
} from "./data-table.js";
export {
  createMetricCard,
  createMetricCardView,
  type MetricCardOptions,
  type MetricCardViewProps,
} from "./metric-card.js";
export {
  createDetailPanel,
  createDetailPanelView,
  type DetailPanelOptions,
  type DetailPanelViewProps,
} from "./detail-panel.js";
export {
  createRecordWithLines,
  createRecordWithLinesView,
  type RecordWithLinesOptions,
  type RecordWithLinesViewProps,
} from "./record-with-lines.js";
export {
  createCardGrid,
  createCardGridView,
  type CardGridOptions,
  type CardGridViewProps,
} from "./card-grid.js";
export {
  createItemList,
  createItemListView,
  type ItemListOptions,
  type ItemListViewProps,
} from "./item-list.js";
export {
  createMediaGallery,
  createMediaGalleryView,
  type MediaGalleryOptions,
  type MediaGalleryViewProps,
} from "./media-gallery.js";
export { shadcnStarterTheme } from "./shadcn-theme.js";
export {
  createBarChartDefinition,
  createDonutChartDefinition,
  createLineChartDefinition,
  type ChartContractOptions,
} from "./chart-definitions.js";
export {
  activationFor,
  applyFormats,
  collapseMoneyEntries,
  formatValue,
  humanize,
  isIdentifierKey,
  looksLikeOpaqueId,
  renderFieldNode,
  resolveFieldPresence,
  StateShell,
  summarizeObjectArray,
  type Activation,
  type ActivationOptions,
  type CollapseMoneyOptions,
  type FieldFormats,
  type FieldPresence,
  type FieldSpec,
  type SlotCompanions,
  type SourceStamp,
  type StarterComponentOptions,
  type StarterMessages,
  type StarterPart,
} from "./shared.js";

// Chart *views* live in a separate entry — `@renderyes/starter-catalog/charts`
// — because they alone depend on recharts (an optional peer). Importing them
// from here would make every host pay that dependency. Chart *definitions*
// (above) are recharts-free, so a server that only publishes contracts
// imports them from this entry and installs nothing extra.
