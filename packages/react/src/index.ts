/**
 * The one package a host frontend installs.
 *
 * A host should never need to know that A2UI, planner manifests, or capability
 * catalogs exist. They register their own React components, mount a provider,
 * drop in a launcher, and point it at their RenderYes service.
 *
 * Re-exports the prop helpers from site-sdk so a host installs one package
 * rather than learning our internal package layout.
 */
/**
 * The folder convention — one file per component, ingested as a folder. The
 * way a host should register components; see `define-view.tsx` for why.
 */
export { defineView, ingestViews } from "./define-view.js";
export type {
  DefineViewInput,
  ViewDataSlot,
  ViewLifecycleProps,
  ViewModule,
  ViewProps,
  ViewSpec,
} from "./define-view.js";

/**
 * The lower-level call `ingestViews` is built on. Reach for it when a component
 * can't be one file with one default export — a component built by a factory,
 * or one whose contract is computed at startup.
 */
export { defineHostComponent } from "./define-host-component.js";
export type {
  DefineHostComponentInput,
  HostDataSlot,
  RegisteredHostComponent,
} from "./define-host-component.js";

/**
 * The honest row count for a slot: `rows.length` is a page, not the set, and
 * is wrong for every truncated result. Prefer this anywhere a count renders.
 */
export { countBeyondPage } from "./slot-count.js";
export type { BeyondPageCount } from "./slot-count.js";

export { ViewProvider, useView } from "./provider.js";
export type { ViewConfig, ViewContextValue } from "./provider.js";

export { ViewLauncher } from "./launcher.js";
export { ViewWorkspace } from "./workspace.js";
export type { ViewWorkspaceProps } from "./workspace.js";
export { ViewPage, ViewResult } from "./page.js";
export { ViewTrigger } from "./trigger.js";
export type { ViewTriggerProps } from "./trigger.js";
export type { ViewPageProps } from "./page.js";
export { ViewSurface } from "./surface.js";
export type { ViewSurfaceProps } from "./surface.js";
export {
  ViewNotices,
  ViewPrompt,
  ViewSavedBar,
  ViewSavedControls,
  ViewSuggestions,
} from "./parts.js";
export type { ViewPromptProps } from "./parts.js";
export { IsolatedView, RenderBoundary } from "./isolated-view.js";
export {
  useViewCompose,
  useSavedViews,
  usePanelOrder,
  HOST_ONLY_HOOK_FIELDS,
} from "./use-compose.js";
export type {
  ComposeFailureKind,
  ComposeSessionState,
  ComposeState,
  PanelOrderState,
  SavedViewsState,
  SavedViewSummary,
} from "./use-compose.js";
export type { ComposeStage, ComposeStreamState } from "./compose-stream.js";
export type {
  RefineCondition,
  RefineFilterGroup,
  RefineOperation,
  RefineSort,
} from "./refine-operations.js";

/** Prop declaration helpers. `field` bounds what a planner may set. */
export { defineProps, field } from "@renderyes/site-sdk";
