import {
  createComponentImplementation,
  type ReactComponentImplementation,
} from "@a2ui/react/v0_9";
import { DynamicValueSchema, type ComponentApi } from "@a2ui/web_core/v0_9";
import {
  defineComponent,
  defineProps,
  type ComponentDataAcceptance,
  type SiteComponentDefinition,
} from "@renderyes/site-sdk";
import type { ComponentDefinition, JsonValue } from "@renderyes/core";
import { createElement, type FC } from "react";
import { z } from "zod";

/**
 * Registers one of the host's own React components.
 *
 * A host previously had to make two calls in two different libraries to do
 * this: `defineComponent` (our semantic contract) and A2UI's
 * `createComponentImplementation` (the renderer binding), plus construct an
 * A2UI `Catalog` by hand. That meant learning A2UI to register a button.
 *
 * This does both from one declaration. The host describes *what their component
 * needs* — named data slots and their accepted data types, plus which data-model
 * path feeds each one — and never imports anything from A2UI.
 */

/**
 * A data slot the planner may bind, and the accepted result contracts —
 * re-exported from `@renderyes/site-sdk` rather than redeclared, so a
 * host can accept either a `{dataTypeId, shapes}` pin to one exact type, or
 * a `{shape, requires?, minFields?}` structural match against any catalog
 * (what makes a shared, catalog-agnostic component possible at all).
 */
export interface HostDataSlot {
  accepts: readonly ComponentDataAcceptance[];
  /**
   * Dotted field paths the component reads from this slot's records
   * (`"user.email"`). Nothing at plan time enforces these yet — they exist
   * because a plan is free to project different fields than the view reads,
   * and when it does, every affected cell renders the missing-value state
   * with no error anywhere. Declaring the paths turns that silence into a
   * console warning at data-bind time whenever a declared path is absent
   * from every record. Absent means the key itself is missing — a projected
   * field that is null still carries its key and never warns.
   */
  reads?: readonly string[];
}

/**
 * Keys that must never be walked, whatever a record says: a projected key is
 * data, and `__proto__` in a data-driven walk reaches the prototype chain.
 */
const UNSAFE_READ_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PathProjection = "projected" | "unprojected" | "undecidable";

/**
 * `unprojected` only when a record along the path lacks the key itself. A
 * null ancestor is `undecidable`: the projection may well have included the
 * field, but a null parent hides every key beneath it.
 */
function projectionOf(record: Record<string, unknown>, path: string): PathProjection {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (UNSAFE_READ_SEGMENTS.has(segment)) return "undecidable";
    if (!isPlainRecord(current)) return "undecidable";
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return "unprojected";
    current = current[segment];
  }
  return "projected";
}

/**
 * The declared paths this slot's data proves the plan did not project: at
 * least one record demonstrably lacks the key and none carries it. Rows where
 * a null ancestor makes the question unanswerable count for neither side, so
 * a column of genuinely-null parents never triggers a false alarm.
 */
export function findUnprojectedReads(reads: readonly string[], data: unknown): string[] {
  const records = Array.isArray(data)
    ? data.filter(isPlainRecord)
    : isPlainRecord(data)
      ? [data]
      : [];
  if (records.length === 0) return [];
  return reads.filter((path) => {
    let sawUnprojected = false;
    for (const record of records) {
      const status = projectionOf(record, path);
      if (status === "projected") return false;
      if (status === "unprojected") sawUnprojected = true;
    }
    return sawUnprojected;
  });
}

// Once per component/slot/path for the page's lifetime: the mismatch is a
// plan-shape fact, and re-stating it on every row and render buries it.
const warnedReads = new Set<string>();

/** Exposed for tests; components reach it through the render adapter. */
export function warnUnprojectedReads(
  componentId: string,
  slotName: string,
  reads: readonly string[],
  data: unknown,
): void {
  for (const path of findUnprojectedReads(reads, data)) {
    const dedupeKey = `${componentId}\u0000${slotName}\u0000${path}`;
    if (warnedReads.has(dedupeKey)) continue;
    warnedReads.add(dedupeKey);
    console.warn(
      `[renderyes] ${componentId}: slot "${slotName}" declares reads "${path}", ` +
        `but the plan did not project that field — the key is absent from every ` +
        `record (a null value would still carry its key). The view will render ` +
        `it as missing data.`,
    );
  }
}

export interface DefineHostComponentInput<Props extends Record<string, JsonValue>> {
  id: string;
  /** Defaults to "1.0.0". Bump it when a component's contract changes in a way a host cares to track. */
  version?: string;
  /** Read by the planner when choosing components. Write it for a model, not a developer. */
  description: string;
  /** Bounded props the planner may set, from `field` helpers. Defaults to no planner-settable props. */
  props?: ComponentDefinition<Props>["props"];
  /**
   * Immutable data-model locations. Every key here becomes a prop the host
   * component receives, resolved by the trusted executor. The plan can never
   * name or override these — that is what keeps rendering host-controlled.
   *
   * Every `dataSlots` key gets a default path of `/<slotName>` — collision-free
   * across component instances, since the executor scopes each instance's
   * writes by its own node id (see `scopedDataPath` in `@renderyes/site-sdk`).
   * A component with any `dataSlots` also defaults to `state: "/state"` and
   * `errorMessage: "/errorMessage"`, so it can distinguish loading, empty,
   * and failed data without declaring them by hand. Only declare a path here
   * to override one of these defaults, or to add a path for something that
   * isn't a planner-bindable slot (e.g. a static host-configured prop).
   * Explicit entries here always win over the derived default for the same
   * key.
   */
  paths?: Readonly<Record<string, string>>;
  /** Named slots the planner may bind data to. Keys not present in `paths` get a default path of `/<slotName>`. */
  dataSlots?: Readonly<Record<string, HostDataSlot>>;
  /** Accessibility metadata forwarded to the renderer. */
  accessibility?: { label: string; description?: string };
  /** The host's real React component. Receives resolved props. */
  component: FC<any>;
}

export interface RegisteredHostComponent {
  /** The semantic contract the planner and validators consume. */
  definition: SiteComponentDefinition;
  /** The renderer implementation the surface consumes. Host never touches this. */
  implementation: ReactComponentImplementation;
}

export function defineHostComponent<Props extends Record<string, JsonValue>>(
  input: DefineHostComponentInput<Props>,
): RegisteredHostComponent {
  const version = input.version ?? "1.0.0";
  const props = input.props ?? (defineProps({}) as ComponentDefinition<Props>["props"]);
  const slotNames = Object.keys(input.dataSlots ?? {});
  // Exactly one, not "at least one". The companions below are single shared
  // paths, which is coherent for a component fed by one request and wrong for
  // a composite layout: its slots are filled by independent requests that
  // would each write status to the same `/state`, so whichever resolved last
  // would decide what the whole component reported. A composite's children
  // handle their own readiness, and a host that genuinely wants layout-level
  // companions can still declare per-slot paths explicitly.
  const hasOneDataSlot = slotNames.length === 1;
  // Every dataSlot gets a default path of `/<slotName>` — safe because the
  // executor scopes each node instance's writes by its own node id (see
  // `scopedDataPath`), so two instances of this component can never target
  // the same data-model path even with the same slot name. An explicit
  // entry in `paths` always overrides the default for that key, and `paths`
  // may still declare keys with no matching slot (e.g. a static
  // host-configured prop) — those are never defaulted, only ever explicit.
  //
  // A component with exactly one dataSlot also gets default `state` and
  // `errorMessage` paths. The trusted executor (see `visitNode` in
  // `@renderyes/site-sdk`) already looks for renderer props named exactly
  // `state`/`errorMessage` and writes to whatever path they resolve to — but
  // only if the component declares them at all. Without a default here,
  // every host had to hand-write `paths: { state: "/state", errorMessage:
  // "/errorMessage" }` just to receive lifecycle status, and a component that
  // didn't got no writes and therefore no way to distinguish "still loading"
  // from "the plan resolved to nothing" from "the request failed" —
  // `TicketSummaryCards` fell back to silently returning `null` in exactly
  // this gap. Explicit entries in `input.paths` still override these
  // defaults for a host that wants a different path, or none.
  //
  // `sources` and `asOf` are defaulted for the same reason and are the same
  // kind of gap, but the stakes differ: state/errorMessage failing open costs
  // a confusing empty box, whereas provenance failing open means a component
  // presents fetched data with no indication of where it came from or how
  // stale it is. Grounded, attributable output is the product's central claim,
  // so it cannot depend on each component author remembering to opt in.
  // A host that genuinely wants no provenance can still pass
  // `paths: { sources: undefined }` explicitly — the point is that silence
  // now yields provenance rather than suppressing it.
  const paths: Record<string, string> = {
    ...Object.fromEntries(slotNames.map((slotName) => [slotName, `/${slotName}`])),
    ...(hasOneDataSlot
      ? {
          state: "/state",
          errorMessage: "/errorMessage",
          sources: "/sources",
          asOf: "/asOf",
          staleAt: "/staleAt",
          // `completeness` is defaulted for the same reason as `sources`, and
          // matters more: the runtime has always known when a row budget cut a
          // result short, and until this path existed no component could find
          // out. A truncated collection then rendered as a complete one, so
          // every figure derived from it was wrong with nothing on screen
          // saying so.
          completeness: "/completeness",
          records: "/records",
        }
      : {}),
    ...input.paths,
  };

  const declaredProps = props.jsonSchema.properties;
  const propNames =
    declaredProps && typeof declaredProps === "object" && !Array.isArray(declaredProps)
      ? Object.keys(declaredProps)
      : [];

  // Every bound path and every planner-set prop becomes a dynamic A2UI value,
  // so the renderer resolves it from the data model rather than the plan.
  const schemaShape: Record<string, z.ZodTypeAny> = {
    accessibility: z
      .object({ label: z.unknown().optional(), description: z.unknown().optional() })
      .optional(),
  };
  for (const key of [...Object.keys(paths), ...propNames]) {
    schemaShape[key] = DynamicValueSchema.optional();
  }

  const api = {
    name: input.id,
    schema: z.object(schemaShape).strict(),
  } satisfies ComponentApi;

  const definition = defineComponent({
    id: input.id,
    version,
    description: input.description,
    props,
    renderer: {
      component: input.id,
      props: {
        ...(input.accessibility ? { accessibility: input.accessibility } : {}),
        ...Object.fromEntries(
          Object.entries(paths).map(([key, path]) => [key, { path }]),
        ),
      },
    },
    ...(input.dataSlots
      ? {
          // `reads` is a renderer-side declaration; the published contract's
          // slots may carry only `accepts` (defineComponent enforces it).
          dataSlots: Object.fromEntries(
            Object.entries(input.dataSlots).map(([slotName, slot]) => [
              slotName,
              { accepts: slot.accepts },
            ]),
          ) as NonNullable<Parameters<typeof defineComponent>[0]["dataSlots"]>,
        }
      : {}),
  });

  const declaredReads = Object.entries(input.dataSlots ?? {}).flatMap(
    ([slotName, slot]) =>
      slot.reads && slot.reads.length > 0
        ? [[slotName, slot.reads] as const]
        : [],
  );

  // `createComponentImplementation` calls its render component as
  // `RenderComponent({ props: resolvedProps, buildChild, context })` — a
  // *different* calling convention from a plain React component, which
  // receives its props directly as the single argument. `input.component`
  // is documented to "receive resolved props" (i.e. plain React component
  // conventions, which is what a host actually writes), so passing it
  // straight through as `RenderComponent` means every one of its declared
  // props — including a plain static string like `title` — arrives as
  // `undefined`: `input.component` would need to destructure `{ props: {
  // title, entity } }`, not `{ title, entity }`, to see anything at all. This
  // adapter is what keeps the flat-props contract real host components are
  // written against, by doing that unwrapping once, here, instead of asking
  // every host component to know about A2UI's calling convention.
  const Adapter: FC<{ props: Props; buildChild: unknown; context: unknown }> = ({
    props: resolvedProps,
  }) => {
    // Data-bind time is the only moment both sides of the field-level
    // agreement are visible: what the view declared it reads, and what the
    // plan actually projected into the slot.
    for (const [slotName, reads] of declaredReads) {
      warnUnprojectedReads(
        input.id,
        slotName,
        reads,
        (resolvedProps as Record<string, unknown>)[slotName],
      );
    }
    return createElement(input.component, resolvedProps);
  };

  return {
    definition,
    implementation: createComponentImplementation(api, Adapter as never),
  };
}
