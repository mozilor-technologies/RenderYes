import {
  defineProps,
  type ComponentDataAcceptance,
  type DataSlotState,
  type FieldDefinition,
} from "@renderyes/site-sdk";
import type { JsonValue } from "@renderyes/core";
import type { FC } from "react";
import { defineHostComponent, type RegisteredHostComponent } from "./define-host-component.js";

/**
 * The folder convention: a host writes one file per component, and we ingest
 * the folder.
 *
 * `defineHostComponent` is the low-level call — it takes the component *and*
 * its contract as one argument, which means a host assembling a set of
 * components maintains a separate registration module listing every one of
 * them. That module is a second place to edit for every change, and the two
 * drift in the direction that hurts most: a component grows a prop, the
 * registration doesn't mention it, and the planner never sets it. There is no
 * error — the prop is just always `undefined`.
 *
 * Here the contract lives in the same file as the component it describes:
 *
 * ```tsx
 * // src/renderyes/views/ticket-table.view.tsx
 * export const spec = defineView({
 *   id: "TicketTable",
 *   description: "Displays a list of tickets as a table, one row per ticket …",
 *   props: { title: field.string() },
 *   dataSlots: { rows: { accepts: [{ shape: "collection" }] } },
 * })
 *
 * export default function TicketTable({ rows, state, sources }: ViewProps<typeof spec, { rows: Row[] }>) {
 *   …
 * }
 * ```
 *
 * and the host registers the whole folder in one line:
 *
 * ```ts
 * const components = ingestViews(import.meta.glob("./views/*.view.tsx", { eager: true }))
 * ```
 *
 * Adding a component is adding a file. Nothing else has to be edited, which is
 * the property that makes the convention worth having.
 */

const VIEW_SPEC = Symbol.for("renderyes.viewSpec");

/** A data slot the planner may bind, and the result contracts it accepts. */
export interface ViewDataSlot {
  accepts: readonly ComponentDataAcceptance[];
  /**
   * Dotted field paths the component reads from this slot's records
   * (`"user.email"`). A plan may project different fields than the view
   * reads, and when it does every affected cell renders its missing-value
   * state with no error anywhere. Declaring the paths turns that silence
   * into a console warning at data-bind time whenever a declared path is
   * absent from every record — absent meaning the key itself is missing; a
   * projected field that is null still carries its key and never warns.
   */
  reads?: readonly string[];
}

export interface DefineViewInput {
  /**
   * How a plan names this component. Unique across the folder, and stable —
   * changing it invalidates any saved plan that referenced it.
   */
  id: string;
  /** Defaults to "1.0.0". Bump it when the component's contract changes. */
  version?: string;
  /**
   * Read by the planner when it chooses which component to use. Write it for a
   * model, not for a developer: say what the component shows and which kind of
   * result it suits, because this text is the entire basis on which it gets
   * picked over its neighbours.
   */
  description: string;
  /**
   * Bounded props the planner may set, as a record of `field` helpers. Declared
   * here and nowhere else — `ViewProps<typeof spec>` derives the TypeScript
   * types from this same record.
   */
  props?: Readonly<Record<string, FieldDefinition>>;
  /** Named slots the planner may bind data to. Each becomes a prop of the same name. */
  dataSlots?: Readonly<Record<string, ViewDataSlot>>;
  /** Overrides for the derived data-model paths. Rarely needed — see `defineHostComponent`. */
  paths?: Readonly<Record<string, string>>;
  /** Forwarded to the renderer. Worth writing: it is what a screen reader announces. */
  accessibility?: { label: string; description?: string };
}

export type ViewSpec<Input extends DefineViewInput = DefineViewInput> = Input & {
  readonly [VIEW_SPEC]: true;
};

/**
 * Declares a component's contract, in the file that defines the component.
 *
 * Returns the input with a brand attached, so `ingestViews` can tell a real
 * spec from an object that merely looks like one and report the difference
 * against the file it came from.
 */
export function defineView<const Input extends DefineViewInput>(input: Input): ViewSpec<Input> {
  return { ...input, [VIEW_SPEC]: true } as ViewSpec<Input>;
}

function isViewSpec(value: unknown): value is ViewSpec {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[VIEW_SPEC] === true;
}

/**
 * What every component with exactly one data slot receives alongside its slot,
 * whether or not it asked for them.
 *
 * A component that ignores these is a component that renders an empty box when
 * a request fails, and — worse — presents rows as authoritative when it has no
 * idea where they came from. `sources` empty means *do not present this as
 * authoritative*: the request failed, and whatever is in the slot is not
 * grounded in anything. That is not a rule the renderer can enforce for a host,
 * so it is stated here, on the type the host has to read.
 */
export interface ViewLifecycleProps {
  /**
   * `"pending"` while the request is still running — a streamed compose emits
   * the surface before any data exists, so this is the first state on every
   * streamed run — then `"ready"` with data, `"empty"` when the request
   * succeeded and matched nothing, or `"error"` when it failed.
   *
   * `"pending"` was missing from this union while the runtime emitted it, so a
   * host writing an exhaustive switch was told by TypeScript that all cases were
   * covered and then rendered nothing on the first frame.
   */
  state?: DataSlotState;
  /** Present when `state` is `"error"`. Safe to show — it carries no upstream internals. */
  errorMessage?: string;
  /** Ids of the data sources behind the slot. Empty means ungrounded; say so rather than implying otherwise. */
  sources?: readonly string[];
  /** When the data was current, ISO 8601. Empty when unknown. */
  asOf?: string;
  /**
   * When the data stops being usable, ISO 8601, if the source declares a
   * horizon. Empty means no horizon was declared — which is not the same as
   * "never goes stale", and shouldn't be presented as if it were.
   */
  staleAt?: string;
  /**
   * Whether what arrived is the whole answer.
   *
   * `complete: false` means the request succeeded and returned provably less
   * than the answer — today that is the row budget cutting a collection short.
   * A component that ignores this renders a truncated result exactly like a
   * complete one, so every figure derived from it is wrong with nothing on
   * screen disclosing it. Say "showing the first `rowCount` of `totalRows`".
   */
  completeness?: {
    complete: boolean;
    truncated: boolean;
    /**
     * A plan-level filter/sort ran over one page of a larger dataset, so the
     * rows shown may be missing matches that live beyond the page. Distinct
     * from `truncated`: the fetch itself met its ask. Present only when true.
     */
    narrowedAfterFetch?: boolean;
    /** Fetched rows the post-fetch narrowing ran over. Rides with `narrowedAfterFetch`. */
    rowsBeforeNarrowing?: number;
    /**
     * The dataset continues past what was fetched. Routine for a bounded ask —
     * the answer is still complete; render "show more", not a warning.
     */
    moreAvailable?: boolean;
    /** Approved fields the upstream errored on; their values are blank, not absent. */
    degradedFields?: readonly string[];
    /** Rows actually delivered. Absent for a result that isn't a collection. */
    rowCount?: number;
    /** Rows the upstream returned before truncation. Present only when truncated. */
    totalRows?: number;
  };
  /** Deep links to the underlying records, for the sources that publish one. */
  records?: readonly { sourceId: string; recordUrl: string }[];
}

type PropTypeOf<Field> = Field extends { type: "string" }
  ? string
  : Field extends { type: "number" }
    ? number
    : Field extends { type: "boolean" }
      ? boolean
      : Field extends { type: "enum"; values: readonly (infer Value)[] }
        ? Value
        : Field extends { type: "stringArray" }
          ? readonly string[]
          : never;

/**
 * Planner-settable props are optional in TypeScript regardless of whether the
 * schema marks them required: a plan is free not to set one, and a component
 * that assumes otherwise breaks on the first plan that doesn't. `required` in
 * the schema constrains what the planner may emit, not what arrives at runtime.
 */
type DeclaredProps<Spec> = Spec extends { props: infer Fields }
  ? { [Key in keyof Fields]?: PropTypeOf<Fields[Key]> }
  : Record<never, never>;

type SlotProps<Spec, Overrides> = Spec extends { dataSlots: infer Slots }
  ? {
      [Key in keyof Slots]: Key extends keyof Overrides ? Overrides[Key] : JsonValue | null;
    }
  : Record<never, never>;

/**
 * The props a view receives, derived from its own spec.
 *
 * Slots are `JsonValue | null` unless narrowed. Narrow them — the second type
 * argument is how a component says what it actually expects:
 *
 * ```tsx
 * ViewProps<typeof spec, { rows: Row[] }>
 * ```
 *
 * The narrowing is an assertion, not a guarantee: it says "the shapes I accept
 * produce this", which is true exactly as far as the `accepts` in the spec is
 * accurate. A slot that accepts `{ shape: "collection" }` really does arrive as
 * an array of objects; one that accepts two unrelated shapes should be typed as
 * their union and handled as such.
 */
export type ViewProps<
  Spec,
  Overrides extends Partial<Record<string, unknown>> = Record<never, never>,
> = SlotProps<Spec, Overrides> & DeclaredProps<Spec> & ViewLifecycleProps;

/** One entry of the record a bundler's glob produces. */
export interface ViewModule {
  spec?: unknown;
  default?: unknown;
}

/**
 * Turns a folder of view files into registrations for `ViewProvider`.
 *
 * Takes the record a bundler's glob produces — keys are file paths, values are
 * the modules — rather than doing the globbing itself, because the glob is
 * bundler-specific and this package must not be. With Vite:
 *
 * ```ts
 * ingestViews(import.meta.glob("./views/*.view.tsx", { eager: true }))
 * ```
 *
 * Every problem it can find is a thrown error naming the file, because the
 * alternative — skipping a malformed file — means a component silently missing
 * from the catalog, which surfaces much later as the planner "not choosing" a
 * component that was never offered.
 */
export function ingestViews(modules: Readonly<Record<string, unknown>>): RegisteredHostComponent[] {
  const registered: RegisteredHostComponent[] = [];
  const filesById = new Map<string, string>();
  // Sorted so ingestion order — and therefore the order components appear in
  // the planner's catalog — depends on filenames rather than on the bundler's
  // directory traversal.
  const paths = Object.keys(modules).sort();

  for (const path of paths) {
    const module = modules[path] as ViewModule | undefined;

    if (!module || typeof module !== "object") {
      throw new Error(`${path} did not resolve to a module. Was the glob eager?`);
    }

    if (module.spec === undefined) {
      throw new Error(
        `${path} does not export \`spec\`. Every view file must export ` +
          "`export const spec = defineView({ id, description, dataSlots })`, " +
          "which is how the planner learns the component exists.",
      );
    }

    if (!isViewSpec(module.spec)) {
      throw new Error(
        `${path} exports \`spec\`, but it did not come from \`defineView\`. ` +
          "Wrap the object: `export const spec = defineView({ ... })`.",
      );
    }

    const component = module.default;
    if (typeof component !== "function") {
      throw new Error(
        `${path} exports \`spec\` for "${module.spec.id}" but no default component. ` +
          "Export the React component as the file's default export.",
      );
    }

    const previous = filesById.get(module.spec.id);
    if (previous) {
      throw new Error(
        `Two view files both declare the id "${module.spec.id}": ${previous} and ${path}. ` +
          "Ids must be unique — a plan names a component by its id, so a duplicate makes " +
          "which component renders depend on ingestion order.",
      );
    }
    filesById.set(module.spec.id, path);

    const { props, ...rest } = module.spec;
    registered.push(
      defineHostComponent({
        ...rest,
        ...(props ? { props: defineProps(props) } : {}),
        // The spec describes the props; the component's own signature declares
        // them. Nothing at this boundary can check the two agree — that is what
        // `ViewProps<typeof spec>` is for, inside the file where both are
        // visible.
        component: component as FC<Record<string, unknown>>,
      }),
    );
  }

  return registered;
}
