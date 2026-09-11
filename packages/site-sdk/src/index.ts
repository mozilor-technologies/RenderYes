import {
  defineCatalog,
  defineComponent as defineCoreComponent,
  isJsonValue,
  validatePlan,
  type ComponentDefinition,
  type ComponentPolicy,
  type JsonValue,
  type Catalog,
  type SurfaceNode,
  type Plan,
  type PlanV3_1,
  type PropsContract,
  type PropsValidationIssue,
  type SlotDefinition,
} from "@renderyes/core";
import { propsContractFromJsonSchema } from "./props-contract-from-schema.js";
// Type-only on purpose. Importing a *value* from capability-catalog (e.g. its
// Zod enum schemas) pulls zod@4 into this package's runtime graph, and since
// `@renderyes/react` depends on site-sdk, that lands ~327 KB minified in
// every host's browser bundle — 51% of the whole bundle, measured. The lists
// below are duplicated instead: 20 strings is a far cheaper price than a
// second Zod major shipped to visitors. `satisfies readonly ResultShape[]`
// keeps them honest — adding a shape to the catalog without updating these
// is a compile error here.
import type {
  DataProvenance,
  PlannerManifest,
  ResultShape,
  SemanticType,
} from "@renderyes/capability-catalog";

/**
 * Exported so a component library can assert it renders every shape a catalog
 * can declare. `@renderyes/starter-catalog` cannot import the zod enum — it
 * depends on this package and not on `capability-catalog`, which is what keeps
 * a browser bundle free of a second Zod major — so this is the only runtime
 * enumeration available to it, and `satisfies` keeps it honest.
 */
export const RESULT_SHAPES = [
  "entity",
  "collection",
  "search-results",
  "metric",
  "time-series",
  "hierarchy",
  "document",
  "media-collection",
  "comparison",
] as const satisfies readonly ResultShape[];

const SEMANTIC_TYPES = [
  "unknown",
  "identifier",
  "text",
  "rich-text",
  "image-url",
  "url",
  "money",
  "quantity",
  "percentage",
  "date",
  "date-time",
  "status",
  "boolean",
  "location",
] as const satisfies readonly SemanticType[];

function isResultShape(value: unknown): value is ResultShape {
  return (
    typeof value === "string" && (RESULT_SHAPES as readonly string[]).includes(value)
  );
}

function isSemanticType(value: unknown): value is SemanticType {
  return (
    typeof value === "string" && (SEMANTIC_TYPES as readonly string[]).includes(value)
  );
}
import type {
  ExecutedPlanData,
  CompositionResult,
  ExecutionResult,
  JoinResult,
} from "@renderyes/data-runtime";
import {
  toSourceSnapshot,
  type DataSourceDefinition,
  type DataSourceSnapshot,
} from "./data.js";

export * from "./data.js";

const idPattern = /^[A-Za-z][A-Za-z0-9._-]*$/;
/**
 * A site id may carry one `:`-separated suffix, because the server defaults its
 * A2UI catalog id to `${catalogId}:ui` and a host that takes the default must be
 * able to build the matching site. `idPattern` stays closed for everything else:
 * prop fields, slot names and component ids reach code as object keys, and a
 * colon in one of those buys nothing and reads as a namespace that isn't there.
 */
const siteIdPattern = /^[A-Za-z][A-Za-z0-9._-]*(?::[A-Za-z0-9._-]+)?$/;
const tokenPattern = /^[a-z][a-zA-Z0-9]*$/;

export type FieldDefinition =
  | {
      type: "string";
      required?: boolean;
      default?: string;
      minLength?: number;
      maxLength?: number;
      /**
       * What this prop means and when to set it, written for the model. It
       * lands in the planner-facing JSON schema as the property's
       * `description`. Without one, the planner infers the prop's meaning
       * from its name and the component's blurb alone — fine for `heading`,
       * hopeless for anything subtler.
       */
      description?: string;
    }
  | {
      type: "number";
      required?: boolean;
      default?: number;
      minimum?: number;
      maximum?: number;
      integer?: boolean;
      description?: string;
    }
  | {
      type: "boolean";
      required?: boolean;
      default?: boolean;
      description?: string;
    }
  | {
      type: "enum";
      required?: boolean;
      default?: string;
      values: readonly string[];
      description?: string;
    }
  | {
      type: "stringArray";
      required?: boolean;
      default?: readonly string[];
      minItems?: number;
      maxItems?: number;
      unique?: boolean;
      values?: readonly string[];
      description?: string;
    };

export type StringField = Extract<FieldDefinition, { type: "string" }>;
export type NumberField = Extract<FieldDefinition, { type: "number" }>;
export type BooleanField = Extract<FieldDefinition, { type: "boolean" }>;
export type EnumField<Values extends readonly string[] = readonly string[]> = Omit<
  Extract<FieldDefinition, { type: "enum" }>,
  "values"
> & { values: Values };
export type StringArrayField = Extract<FieldDefinition, { type: "stringArray" }>;

/**
 * Each helper returns its own member of `FieldDefinition` rather than the whole
 * union, and `enum` preserves its literal values. Every member is still
 * assignable to `FieldDefinition`, so nothing that consumed these before is
 * affected — the narrower types are what let `ViewProps` in
 * `@renderyes/react` derive a component's TypeScript prop types from the same
 * declaration the planner reads, instead of a host writing the prop types twice
 * and having them drift.
 */
export const field = {
  string(options: Omit<StringField, "type"> = {}): StringField {
    return { type: "string", ...options };
  },
  number(options: Omit<NumberField, "type"> = {}): NumberField {
    return { type: "number", ...options };
  },
  boolean(options: Omit<BooleanField, "type"> = {}): BooleanField {
    return { type: "boolean", ...options };
  },
  enum<const Values extends readonly string[]>(
    values: Values,
    options: Omit<EnumField, "type" | "values"> = {},
  ): EnumField<Values> {
    return { type: "enum", values, ...options };
  },
  stringArray(options: Omit<StringArrayField, "type"> = {}): StringArrayField {
    return { type: "stringArray", ...options };
  },
};

export function defineProps(
  fields: Readonly<Record<string, FieldDefinition>>,
): PropsContract {
  for (const [name, definition] of Object.entries(fields)) {
    assertId(name, "Prop field");
    validateFieldDefinition(name, definition);
  }

  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(fields).map(([name, definition]) => [
        name,
        fieldJsonSchema(definition),
      ]),
    ),
    required: Object.entries(fields)
      .filter(([, definition]) => definition.required)
      .map(([name]) => name),
  } as unknown as Record<string, JsonValue>;

  return {
    jsonSchema,
    safeParse(value: unknown) {
      if (!isRecord(value)) {
        return issue([], "Expected an object");
      }

      const unknown = Object.keys(value).find((key) => !(key in fields));
      if (unknown) {
        return issue([unknown], "Unknown property");
      }

      const data: Record<string, JsonValue> = {};
      const issues: PropsValidationIssue[] = [];

      for (const [name, definition] of Object.entries(fields)) {
        const candidate =
          value[name] === undefined ? cloneDefault(definition.default) : value[name];
        if (candidate === undefined) {
          if (definition.required) {
            issues.push({ path: [name], message: "Required property" });
          }
          continue;
        }

        const parsed = parseField(name, definition, candidate);
        if (parsed.ok) {
          data[name] = parsed.value;
        } else {
          issues.push(parsed.issue);
        }
      }

      return issues.length > 0
        ? { success: false as const, issues }
        : { success: true as const, data };
    },
  };
}

export interface RendererBinding {
  component: string;
  props: Readonly<Record<string, JsonValue>>;
}

/**
 * The binding must deliver grouped or upstream-aggregated data.
 *
 * For a `time-series` output the requirement is inherently met — the upstream
 * already aggregated. For a collection it is met only when the bound request's
 * own query groups (`groupBy`/`aggregates`); a composition or join never does.
 * Declared per acceptance entry because it is a claim about what the component
 * *presents*: a chart drawn over raw rows renders one mark per record under a
 * heading asserting a computation that never ran — measured live as three
 * "revenue trend" charts of a hundred raw orders each, every layer green.
 */
interface GroupedDataRequirement {
  requiresGrouping?: boolean;
}

/** Names an exact data type by id — for a component pinned to one host-specific type. */
export interface NominalDataAcceptance extends GroupedDataRequirement {
  dataTypeId: string;
  shapes: readonly ResultShape[];
}

/**
 * Accepts any data type whose shape (and, optionally, field semantics)
 * satisfy the requirement — for a component meant to be reusable across
 * unrelated catalogs (a generic table, a generic metric card). This is what
 * makes a prebuilt component library possible at all: nothing in it can
 * reference a specific host's `dataTypeId`.
 */
export interface StructuralDataAcceptance extends GroupedDataRequirement {
  shape: ResultShape;
  /** At least one field of the matched data type must have each listed semantic type. */
  requires?: readonly { semanticType: SemanticType }[];
  /** The matched data type must declare at least this many fields. */
  minFields?: number;
}

export type ComponentDataAcceptance = NominalDataAcceptance | StructuralDataAcceptance;

function isStructuralAcceptance(
  acceptance: ComponentDataAcceptance,
): acceptance is StructuralDataAcceptance {
  return !("dataTypeId" in acceptance);
}

/**
 * Describes only what a trusted renderer can display. Query operations are
 * deliberately absent: filter/sort/set-operation policy belongs exclusively
 * to the capability catalog and executor.
 *
 * The slot name must match a registered renderer prop whose value is a fixed
 * A2UI `{ path: "/..." }` binding. A Plan can bind a requestId to the
 * slot, but cannot choose or override that renderer path.
 */
export interface ComponentDataSlot {
  accepts: readonly ComponentDataAcceptance[];
}

export interface SiteComponentDefinition extends ComponentDefinition {
  renderer: RendererBinding;
  dataSlots: Readonly<Record<string, ComponentDataSlot>>;
}

export function defineComponent(
  definition: ComponentDefinition & {
    renderer: RendererBinding;
    dataSlots?: Readonly<Record<string, ComponentDataSlot>>;
  },
): SiteComponentDefinition {
  const dataSlots = definition.dataSlots ?? {};
  // A data-backed component needs the same executor-owned lifecycle contract
  // on both sides of a host integration: the browser renderer built by
  // `defineHostComponent`, and the catalog published to the server. Deriving
  // it here as well as there is what stops a host registering a component
  // with one contract and publishing another.
  //
  // Exactly one slot, for the same reason as in `defineHostComponent`: these
  // are single shared paths, and a composite layout's independent requests
  // would collide on them. Such layouts may declare per-slot companions
  // explicitly; otherwise their children report their own readiness.
  const rendererProps: Record<string, JsonValue> = { ...definition.renderer.props };
  if (Object.keys(dataSlots).length === 1) {
    rendererProps.state ??= { path: "/state" };
    rendererProps.errorMessage ??= { path: "/errorMessage" };
    rendererProps.sources ??= { path: "/sources" };
    rendererProps.asOf ??= { path: "/asOf" };
    rendererProps.staleAt ??= { path: "/staleAt" };
    rendererProps.completeness ??= { path: "/completeness" };
    rendererProps.records ??= { path: "/records" };
  }
  assertId(definition.id, "Component id");
  assertNonEmpty(definition.version, `Component ${definition.id} version`);
  assertNonEmpty(definition.description, `Component ${definition.id} description`);
  assertId(definition.renderer.component, "Renderer component");
  if (!isJsonValue(rendererProps)) {
    throw new Error(`Component ${definition.id} renderer props must be JSON-compatible`);
  }
  const schemaProperties = definition.props.jsonSchema.properties;
  const declaredPropNames = isRecord(schemaProperties)
    ? Object.keys(schemaProperties)
    : [];
  const bindingCollision = declaredPropNames.find((name) => name in rendererProps);
  if (bindingCollision) {
    throw new Error(
      `Component ${definition.id} prop ${bindingCollision} conflicts with a registered renderer binding`,
    );
  }
  // Two renderer props bound to the identical path would collide the moment
  // this component's data is projected — catch that at registration instead
  // of after a plan executes against it. Node-scoping (see `scopedDataPath`)
  // only isolates paths *across* instances; it cannot save a component from
  // colliding with itself.
  const pathBindingsByPath = new Map<string, string>();
  for (const [propName, value] of Object.entries(rendererProps)) {
    if (!isA2UIPathBinding(value)) continue;
    const existing = pathBindingsByPath.get(value.path);
    if (existing) {
      throw new Error(
        `Component ${definition.id} renderer props "${existing}" and "${propName}" both bind path ${value.path}`,
      );
    }
    pathBindingsByPath.set(value.path, propName);
  }
  for (const [slotName, slot] of Object.entries(dataSlots)) {
    assertId(slotName, `Component ${definition.id} data slot`);
    const rendererBinding = rendererProps[slotName];
    if (!isA2UIPathBinding(rendererBinding)) {
      throw new Error(
        `Component ${definition.id} data slot ${slotName} requires a fixed renderer path binding with the same name`,
      );
    }
    const slotKeys = Object.keys(slot);
    if (slotKeys.length !== 1 || slotKeys[0] !== "accepts") {
      throw new Error(
        `Component ${definition.id} data slot ${slotName} may declare only accepts`,
      );
    }
    if (!Array.isArray(slot.accepts) || slot.accepts.length === 0) {
      throw new Error(
        `Component ${definition.id} data slot ${slotName} must accept at least one data contract`,
      );
    }
    const acceptanceKeys = new Set<string>();
    for (const acceptance of slot.accepts) {
      const keys = Object.keys(acceptance);
      if (isStructuralAcceptance(acceptance)) {
        if (
          keys.some(
            (key) =>
              key !== "shape" &&
              key !== "requires" &&
              key !== "minFields" &&
              key !== "requiresGrouping",
          )
        ) {
          throw new Error(
            `Component ${definition.id} data slot ${slotName} structural acceptance may declare only shape, requires, minFields, and requiresGrouping`,
          );
        }
        if (
          acceptance.requiresGrouping !== undefined &&
          typeof acceptance.requiresGrouping !== "boolean"
        ) {
          throw new Error(
            `Component ${definition.id} data slot ${slotName} requiresGrouping must be a boolean`,
          );
        }
        if (!isResultShape(acceptance.shape)) {
          throw new Error(
            `Component ${definition.id} data slot ${slotName} declares an unknown result shape ${JSON.stringify(acceptance.shape)}`,
          );
        }
        if (acceptance.requires !== undefined) {
          if (!Array.isArray(acceptance.requires) || acceptance.requires.length === 0) {
            throw new Error(
              `Component ${definition.id} data slot ${slotName} requires must list at least one semantic type`,
            );
          }
          for (const requirement of acceptance.requires) {
            if (!isSemanticType(requirement.semanticType)) {
              throw new Error(
                `Component ${definition.id} data slot ${slotName} declares an unknown semantic type ${JSON.stringify(requirement.semanticType)}`,
              );
            }
          }
        }
        if (
          acceptance.minFields !== undefined &&
          (!Number.isInteger(acceptance.minFields) || acceptance.minFields < 1)
        ) {
          throw new Error(
            `Component ${definition.id} data slot ${slotName} minFields must be a positive integer`,
          );
        }
        const acceptanceKey = `shape:${acceptance.shape}:${
          acceptance.requires
            ? [...acceptance.requires.map((r) => r.semanticType)].sort().join(",")
            : ""
        }:${acceptance.minFields ?? ""}:${acceptance.requiresGrouping === true}`;
        if (acceptanceKeys.has(acceptanceKey)) {
          throw new Error(
            `Duplicate Component ${definition.id} data slot ${slotName} acceptance: ${acceptanceKey}`,
          );
        }
        acceptanceKeys.add(acceptanceKey);
        continue;
      }
      if (
        keys.some(
          (key) =>
            key !== "dataTypeId" && key !== "shapes" && key !== "requiresGrouping",
        )
      ) {
        throw new Error(
          `Component ${definition.id} data slot ${slotName} acceptance may declare only dataTypeId, shapes, and requiresGrouping`,
        );
      }
      if (
        acceptance.requiresGrouping !== undefined &&
        typeof acceptance.requiresGrouping !== "boolean"
      ) {
        throw new Error(
          `Component ${definition.id} data slot ${slotName} requiresGrouping must be a boolean`,
        );
      }
      assertId(
        acceptance.dataTypeId,
        `Component ${definition.id} data slot ${slotName} data type`,
      );
      if (!Array.isArray(acceptance.shapes) || acceptance.shapes.length === 0) {
        throw new Error(
          `Component ${definition.id} data slot ${slotName} must accept at least one result shape`,
        );
      }
      assertUnique(
        acceptance.shapes,
        `Component ${definition.id} data slot ${slotName} result shape`,
      );
      const acceptanceKey = `${acceptance.dataTypeId}:${[...acceptance.shapes]
        .sort()
        .join(",")}:${acceptance.requiresGrouping === true}`;
      if (acceptanceKeys.has(acceptanceKey)) {
        throw new Error(
          `Duplicate Component ${definition.id} data slot ${slotName} acceptance: ${acceptanceKey}`,
        );
      }
      acceptanceKeys.add(acceptanceKey);
    }
  }

  const coreDefinition = defineCoreComponent(definition);
  return Object.freeze({
    ...coreDefinition,
    dataSlots: freezeDataSlots(dataSlots),
    renderer: Object.freeze({
      component: definition.renderer.component,
      props: Object.freeze({ ...rendererProps }),
    }),
  });
}

export interface SurfaceDefinition {
  id: string;
  description: string;
  componentIds: readonly string[];
  maxComponents?: number;
}

export function defineSurface(definition: SurfaceDefinition): SurfaceDefinition {
  assertId(definition.id, "Surface id");
  assertNonEmpty(definition.description, `Surface ${definition.id} description`);
  if (definition.componentIds.length === 0) {
    throw new Error(`Surface ${definition.id} must allow at least one component`);
  }
  assertUnique(definition.componentIds, `Surface ${definition.id} component`);
  if (
    definition.maxComponents !== undefined &&
    (!Number.isInteger(definition.maxComponents) || definition.maxComponents < 1)
  ) {
    throw new Error(`Surface ${definition.id} maxComponents must be positive`);
  }
  return Object.freeze({
    ...definition,
    componentIds: Object.freeze([...definition.componentIds]),
  });
}

export interface ThemeDefinition {
  id: string;
  tokens: Readonly<Record<string, string | number>>;
}

export function defineTheme(definition: ThemeDefinition): ThemeDefinition {
  assertId(definition.id, "Theme id");
  if (Object.keys(definition.tokens).length === 0) {
    throw new Error("Theme must contain at least one token");
  }
  for (const [name, value] of Object.entries(definition.tokens)) {
    if (!tokenPattern.test(name)) {
      throw new Error(`Invalid theme token: ${name}`);
    }
    if (
      (typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new Error(`Invalid value for theme token: ${name}`);
    }
  }
  return Object.freeze({
    id: definition.id,
    tokens: Object.freeze({ ...definition.tokens }),
  });
}

export interface SiteDefinition {
  id: string;
  name: string;
  version: string;
  catalogId: string;
  components: readonly SiteComponentDefinition[];
  surfaces: readonly SurfaceDefinition[];
  /**
   * Optional. `defineSite` never validated a theme and the runtime has always
   * worked without one — a host whose components carry their own styling needs
   * no tokens at all, which is the normal case for host-owned components. The
   * type said `required` only because every test in this workspace is `.mjs` and
   * so never exercised it; a TypeScript host hit the mismatch immediately.
   */
  theme?: ThemeDefinition;
  // Sources are stored with an erased session type: the trusted host supplies
  // the session when a resolver runs, so the registry cannot track it.
  sources?: readonly DataSourceDefinition<any>[];
}

export interface RegisteredSite extends SiteDefinition {
  catalog: Catalog;
  registrationFingerprint: string;
  sources: readonly DataSourceDefinition<any>[];
  getComponent(id: string): SiteComponentDefinition | undefined;
  getSurface(id: string): SurfaceDefinition | undefined;
  getSource(id: string): DataSourceDefinition<any> | undefined;
}

export function defineSite(definition: SiteDefinition): RegisteredSite {
  assertSiteId(definition.id);
  assertNonEmpty(definition.name, "Site name");
  assertNonEmpty(definition.version, "Site version");
  assertNonEmpty(definition.catalogId, "Catalog id");
  if (definition.components.length === 0) {
    throw new Error("Site must register at least one component");
  }
  if (definition.surfaces.length === 0) {
    throw new Error("Site must register at least one surface");
  }

  assertUnique(
    definition.components.map((component) => component.id),
    "Component",
  );
  assertUnique(
    definition.surfaces.map((surface) => surface.id),
    "Surface",
  );

  const componentsById = new Map(
    definition.components.map((component) => [component.id, component]),
  );
  for (const surface of definition.surfaces) {
    for (const componentId of surface.componentIds) {
      if (!componentsById.has(componentId)) {
        throw new Error(
          `Surface ${surface.id} references unknown component ${componentId}`,
        );
      }
    }
  }

  const sources = definition.sources ?? [];
  assertUnique(
    sources.map((source) => source.id),
    "Data source",
  );

  const catalog = defineCatalog({
    catalogId: definition.catalogId,
    version: definition.version,
    components: definition.components,
  });
  const stableDefinition = {
    ...definition,
    components: Object.freeze([...definition.components]),
    surfaces: Object.freeze([...definition.surfaces]),
    sources: Object.freeze([...sources]),
  };
  const surfacesById = new Map(
    stableDefinition.surfaces.map((surface) => [surface.id, surface]),
  );
  const sourcesById = new Map(
    stableDefinition.sources.map((source) => [source.id, source]),
  );
  const registrationFingerprint = fingerprint({
    id: definition.id,
    name: definition.name,
    version: definition.version,
    catalogId: definition.catalogId,
    catalogFingerprint: catalog.fingerprint,
    components: definition.components.map((component) => ({
      id: component.id,
      dataSlots: component.dataSlots,
      renderer: component.renderer,
    })),
    surfaces: definition.surfaces,
    ...(definition.theme ? { theme: definition.theme } : {}),
    sources: sources.map((source) => toSourceSnapshot(source) as unknown as JsonValue),
  });

  return Object.freeze({
    ...stableDefinition,
    catalog,
    registrationFingerprint,
    getComponent(id: string) {
      return componentsById.get(id);
    },
    getSurface(id: string) {
      return surfacesById.get(id);
    },
    getSource(id: string) {
      return sourcesById.get(id);
    },
  });
}

export interface ComponentInstance {
  id: string;
  componentId: string;
  props?: Record<string, JsonValue>;
  /**
   * Named child slots (component-declared `slots`, distinct from data slots).
   * Each key names a slot the component declares; each child is compiled the
   * same way as a top-level instance, recursively.
   */
  slots?: Record<string, ComponentInstance[]>;
}

export type DataBindingIssueCode =
  | "invalid-plan"
  | "data-catalog-mismatch"
  | "unknown-capability"
  | "unknown-data-slot"
  | "incompatible-data-slot"
  | "incompatible-composition-slot"
  | "composition-input-type-mismatch"
  | "unknown-join"
  | "incompatible-join-slot";

/** Composed datasets are always delivered to a slot as a flat collection. */
const COMPOSED_RESULT_SHAPE = "collection";

/**
 * The single acceptance check shared by all three binding kinds (request,
 * composition, join) so they cannot silently diverge on what "compatible"
 * means. Returns a reason string on failure — that string is the host's
 * only debugging signal when a plan can't bind its data, so it names what
 * was required and what the actual data type provided instead of just
 * "incompatible".
 */
type ManifestFieldDescriptor = NonNullable<
  PlannerManifest["dataTypes"][number]["fields"]
>[string];

function acceptsCapabilityOutput(
  acceptance: ComponentDataAcceptance,
  output: { dataTypeId: string; shape: ResultShape },
  plannerManifest: PlannerManifest,
  /**
   * Fields a join adds to each row beyond the declared data type — the right
   * side's descriptors, for a join binding. They participate in `requires` and
   * `minFields` because the rows genuinely carry them; they are deliberately
   * never written into the data type itself, or an *unjoined* row of the same
   * type would claim fields it does not have.
   */
  joinedFields: readonly ManifestFieldDescriptor[] = [],
  /**
   * Whether this binding context satisfies `requiresGrouping`: true for a
   * request whose query groups (plan-time), or for a capability that supports
   * grouping (catalog-time scope/coverage, where the plan does not exist yet
   * but a legal grouped request could). Compositions and joins never group,
   * so their contexts pass false.
   */
  groupingSatisfied = false,
): { ok: true } | { ok: false; reason: string } {
  // Checked ahead of the nominal/structural split — the requirement means the
  // same thing on both. `time-series` satisfies it inherently: the upstream
  // already aggregated the series.
  if (
    acceptance.requiresGrouping === true &&
    output.shape !== "time-series" &&
    !groupingSatisfied
  ) {
    return {
      ok: false,
      reason:
        "requires grouped data: bind a request whose query uses groupBy/aggregates " +
        "(or a time-series output); raw rows would be drawn as if a computation ran",
    };
  }
  if (!isStructuralAcceptance(acceptance)) {
    if (acceptance.dataTypeId !== output.dataTypeId) {
      return {
        ok: false,
        reason: `expects data type ${acceptance.dataTypeId}, got ${output.dataTypeId}`,
      };
    }
    if (!acceptance.shapes.includes(output.shape)) {
      return {
        ok: false,
        reason: `expects shape ${acceptance.shapes.join(" or ")}, got ${output.shape}`,
      };
    }
    return { ok: true };
  }

  if (acceptance.shape !== output.shape) {
    return {
      ok: false,
      reason: `expects shape ${acceptance.shape}, got ${output.shape}`,
    };
  }
  const dataType = plannerManifest.dataTypes.find(
    (candidate) => candidate.id === output.dataTypeId,
  );
  if (!dataType) {
    return {
      ok: false,
      reason: `data type ${output.dataTypeId} is not in the planner manifest`,
    };
  }
  const fields = [...Object.values(dataType.fields ?? {}), ...joinedFields];
  if (acceptance.minFields !== undefined && fields.length < acceptance.minFields) {
    return {
      ok: false,
      reason: `needs at least ${acceptance.minFields} fields; ${output.dataTypeId} has ${fields.length}`,
    };
  }
  for (const requirement of acceptance.requires ?? []) {
    if (!fields.some((field) => field.semanticType === requirement.semanticType)) {
      return {
        ok: false,
        reason: `needs a ${requirement.semanticType} field; ${output.dataTypeId} has none`,
      };
    }
  }
  return { ok: true };
}

/** Tries every acceptance on a slot; on failure, reports every reason so the host can see what would have to change. */
function slotAcceptsOutput(
  slot: ComponentDataSlot,
  output: { dataTypeId: string; shape: ResultShape },
  plannerManifest: PlannerManifest,
  joinedFields: readonly ManifestFieldDescriptor[] = [],
  groupingSatisfied = false,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  for (const acceptance of slot.accepts) {
    const result = acceptsCapabilityOutput(
      acceptance,
      output,
      plannerManifest,
      joinedFields,
      groupingSatisfied,
    );
    if (result.ok) return { ok: true };
    reasons.push(result.reason);
  }
  return { ok: false, reasons };
}

/**
 * Whether a plan could legally satisfy `requiresGrouping` against this
 * capability — used where no plan exists yet (surface scoping, coverage), so
 * the answer is "a grouped request is expressible", not "this one grouped".
 */
function capabilityCanGroup(capability: {
  supports?: { groupFields?: readonly string[]; aggregates?: readonly string[] };
}): boolean {
  return Boolean(
    capability.supports?.groupFields?.length || capability.supports?.aggregates?.length,
  );
}

export interface DataBindingIssue {
  code: DataBindingIssueCode;
  path: string;
  message: string;
}

export type DataBindingValidationResult =
  { ok: true; plan: Plan } | { ok: false; issues: DataBindingIssue[] };

/**
 * Validates request-to-component compatibility without executing data or
 * interpreting capability operations. In particular, `capability.supports`
 * does not participate in this check.
 */
export interface PlanDataBindingOptions {
  /**
   * Skips the two identity pins — the plan's site catalog fingerprint and its
   * data catalog hash — while leaving every structural check in place.
   *
   * Only for replaying a *stored* plan whose catalogs have moved since it was
   * composed. The pins exist so a freshly generated plan can't be validated
   * against a catalog it wasn't generated from; for a saved view the mismatch is
   * the expected condition, not an attack, and refusing on it means every saved
   * view dies the moment a host adds one component. What still runs is
   * everything that decides whether the plan is *executable*: unknown
   * components, unknown capabilities, slot acceptance, unknown fields. So a plan
   * that still fits replays, and one that doesn't fails on the specific thing
   * that no longer fits.
   */
  allowCatalogDrift?: boolean;
}

export function validatePlanDataBindings(
  site: RegisteredSite,
  input: unknown,
  plannerManifest: PlannerManifest,
  options: PlanDataBindingOptions = {},
): DataBindingValidationResult {
  const planResult = validatePlan(input, site.catalog, {
    allowCatalogMismatch: options.allowCatalogDrift === true,
  });
  if (!planResult.ok) {
    return {
      ok: false,
      issues: planResult.issues.map((item) => ({
        code: "invalid-plan",
        path: item.path,
        message: item.message,
      })),
    };
  }
  const plan = planResult.plan;
  if (plan.schemaVersion === "3.0") return { ok: true, plan };

  const issues: DataBindingIssue[] = [];
  if (
    !options.allowCatalogDrift &&
    (plan.dataCatalog.id !== plannerManifest.catalogId ||
      plan.dataCatalog.version !== plannerManifest.catalogVersion ||
      plan.dataCatalog.hash !== plannerManifest.catalogHash)
  ) {
    issues.push({
      code: "data-catalog-mismatch",
      path: "dataCatalog",
      message: `Plan data catalog ${plan.dataCatalog.id}@${plan.dataCatalog.version} does not match ${plannerManifest.catalogId}@${plannerManifest.catalogVersion}`,
    });
  }

  const requestsById = new Map(
    plan.dataRequests.map((request) => [request.requestId, request]),
  );
  const compositionsById = new Map(
    (plan.dataCompositions ?? []).map((composition) => [
      composition.compositionId,
      composition,
    ]),
  );
  const joinsById = new Map((plan.dataJoins ?? []).map((join) => [join.joinId, join]));
  const capabilitiesById = new Map(
    plannerManifest.capabilities.map((capability) => [capability.id, capability]),
  );

  for (const [surfaceIndex, surface] of plan.surfaces.entries()) {
    for (const [nodeIndex, node] of surface.nodes.entries()) {
      visitNode(node, `surfaces.${surfaceIndex}.nodes.${nodeIndex}`);
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, plan };

  function visitNode(node: SurfaceNode, path: string): void {
    const component = site.getComponent(node.componentId);
    if (!component) return;

    for (const [slotName, binding] of Object.entries(node.dataBindings ?? {})) {
      const slotPath = `${path}.dataBindings.${slotName}`;
      const slot = component.dataSlots[slotName];
      if (!slot) {
        issues.push({
          code: "unknown-data-slot",
          path: slotPath,
          message: `Component ${component.id} does not declare data slot ${slotName}`,
        });
        continue;
      }

      if ("requestId" in binding) {
        const request = requestsById.get(binding.requestId);
        if (!request) continue; // Core validation reports this reference first.
        const capability = capabilitiesById.get(request.capabilityId);
        if (!capability) {
          issues.push({
            code: "unknown-capability",
            path: `${slotPath}.requestId`,
            message: `Capability ${request.capabilityId} is not in the planner manifest`,
          });
          continue;
        }

        // The one context where grouping is a fact, not a possibility: this
        // request's own query either grouped or it did not.
        const grouped = Boolean(
          request.query?.groupBy?.length || request.query?.aggregates?.length,
        );
        const compatibility = slotAcceptsOutput(
          slot,
          capability.output,
          plannerManifest,
          [],
          grouped,
        );
        if (!compatibility.ok) {
          issues.push({
            code: "incompatible-data-slot",
            path: slotPath,
            message: `Component ${component.id}.${slotName} does not accept ${capability.output.dataTypeId} as ${capability.output.shape} (${compatibility.reasons.join("; ")})`,
          });
        }
        continue;
      }

      if ("compositionId" in binding) {
        // Composition binding: the merged dataset's type is the shared input
        // data type, delivered to the slot as a collection.
        const composition = compositionsById.get(binding.compositionId);
        if (!composition) continue; // Core validation reports this reference first.
        let composedDataTypeId: string | undefined;
        let inputMismatch = false;
        let unknownInputCapability = false;
        for (const inputRequestId of composition.inputs) {
          const inputRequest = requestsById.get(inputRequestId);
          if (!inputRequest) continue; // Core reports unknown composition input first.
          const inputCapability = capabilitiesById.get(inputRequest.capabilityId);
          if (!inputCapability) {
            unknownInputCapability = true;
            break;
          }
          if (composedDataTypeId === undefined) {
            composedDataTypeId = inputCapability.output.dataTypeId;
          } else if (composedDataTypeId !== inputCapability.output.dataTypeId) {
            inputMismatch = true;
            break;
          }
        }
        if (unknownInputCapability) {
          issues.push({
            code: "unknown-capability",
            path: `${slotPath}.compositionId`,
            message: `Composition ${composition.compositionId} references a capability outside the planner manifest`,
          });
          continue;
        }
        if (inputMismatch) {
          issues.push({
            code: "composition-input-type-mismatch",
            path: `${slotPath}.compositionId`,
            message: `Composition ${composition.compositionId} combines inputs of different data types`,
          });
          continue;
        }
        if (composedDataTypeId === undefined) continue;
        const composedCompatibility = slotAcceptsOutput(
          slot,
          { dataTypeId: composedDataTypeId, shape: COMPOSED_RESULT_SHAPE },
          plannerManifest,
        );
        if (!composedCompatibility.ok) {
          issues.push({
            code: "incompatible-composition-slot",
            path: slotPath,
            message: `Component ${component.id}.${slotName} does not accept ${composedDataTypeId} as ${COMPOSED_RESULT_SHAPE} (${composedCompatibility.reasons.join("; ")})`,
          });
        }
        continue;
      }

      // Join binding: the enriched dataset keeps the left capability's data type,
      // delivered to the slot as a collection.
      const join = joinsById.get(binding.joinId);
      if (!join) continue; // Core validation reports this reference first.
      const leftRequest = requestsById.get(join.left);
      const leftCapability = leftRequest
        ? capabilitiesById.get(leftRequest.capabilityId)
        : undefined;
      if (!leftCapability) {
        issues.push({
          code: "unknown-join",
          path: `${slotPath}.joinId`,
          message: `Join ${join.joinId} references a capability outside the planner manifest`,
        });
        continue;
      }
      // The crossed-over fields count toward `requires` and `minFields`. A
      // to-one join enriches the left row — same identity, same count — so the
      // result is still the left data type, but its rows genuinely carry the
      // right side's fields, and a component that needs (say) an email should
      // match a joined Order and not a plain one. The overlay is computed here
      // per plan rather than declared on the type, precisely so the plain one
      // does not match. Matched-row optionality is the same optionality any
      // nullable field already has; `hasUnmatchedRows` reports it.
      const rightRequest = requestsById.get(join.right);
      const rightCapability = rightRequest
        ? capabilitiesById.get(rightRequest.capabilityId)
        : undefined;
      const rightDataType = rightCapability
        ? plannerManifest.dataTypes.find(
            (candidate) => candidate.id === rightCapability.output.dataTypeId,
          )
        : undefined;
      const joinedFields = Object.values(rightDataType?.fields ?? {});
      const joinCompatibility = slotAcceptsOutput(
        slot,
        { dataTypeId: leftCapability.output.dataTypeId, shape: COMPOSED_RESULT_SHAPE },
        plannerManifest,
        joinedFields,
      );
      if (!joinCompatibility.ok) {
        issues.push({
          code: "incompatible-join-slot",
          path: slotPath,
          message: `Component ${component.id}.${slotName} does not accept ${leftCapability.output.dataTypeId} as ${COMPOSED_RESULT_SHAPE} (${joinCompatibility.reasons.join("; ")})`,
        });
      }
    }

    for (const [slotName, children] of Object.entries(node.slots ?? {})) {
      for (const [childIndex, child] of children.entries()) {
        visitNode(child, `${path}.slots.${slotName}.${childIndex}`);
      }
    }
  }
}

export interface DataTypeCoverage {
  dataTypeId: string;
  shape: ResultShape;
  /** Capabilities in the manifest that produce this exact (dataTypeId, shape) pair. */
  producedByCapabilityIds: readonly string[];
  /** Registered components with at least one data slot that accepts this pair. */
  matchingComponentIds: readonly string[];
  /** True when no registered component can render this pair at all. */
  unrenderable: boolean;
}

/**
 * Reports, for every (dataTypeId, shape) a published capability catalog can
 * actually produce, which registered components (if any) can render it.
 *
 * Before this existed, an approved capability with no matching component was
 * silently invisible: the planner would simply never select it, and a host
 * would see "no plan found" with no indication that the real cause was a
 * missing renderer rather than a bad prompt. This is the deterministic check
 * that turns that into an explicit, host-visible gap — reuses the exact same
 * `acceptsCapabilityOutput` matcher `validatePlanDataBindings` uses, so this
 * report can never claim something is renderable that validation would then
 * reject, or vice versa.
 */
export function matchCatalogToComponents(
  plannerManifest: PlannerManifest,
  site: RegisteredSite,
): DataTypeCoverage[] {
  const produced = new Map<
    string,
    { dataTypeId: string; shape: ResultShape; capabilityIds: string[] }
  >();
  for (const capability of plannerManifest.capabilities) {
    const key = `${capability.output.dataTypeId}:${capability.output.shape}`;
    const existing = produced.get(key);
    if (existing) {
      existing.capabilityIds.push(capability.id);
    } else {
      produced.set(key, {
        dataTypeId: capability.output.dataTypeId,
        shape: capability.output.shape,
        capabilityIds: [capability.id],
      });
    }
  }

  const slots = site.components.flatMap((component) =>
    Object.entries(component.dataSlots).map(([slotName, slot]) => ({
      componentId: component.id,
      slotName,
      slot,
    })),
  );

  return [...produced.values()]
    .sort(
      (a, b) =>
        a.dataTypeId.localeCompare(b.dataTypeId) || a.shape.localeCompare(b.shape),
    )
    .map(({ dataTypeId, shape, capabilityIds }) => {
      // A `requiresGrouping` slot counts as a match only when some producing
      // capability could serve a grouped request — otherwise coverage would
      // claim renderable pairs the compose validator now rejects.
      const groupable = capabilityIds.some((capabilityId) => {
        const capability = plannerManifest.capabilities.find(
          (candidate) => candidate.id === capabilityId,
        );
        return capability !== undefined && capabilityCanGroup(capability);
      });
      const matchingComponentIds = [
        ...new Set(
          slots
            .filter(
              ({ slot }) =>
                slotAcceptsOutput(slot, { dataTypeId, shape }, plannerManifest, [], groupable)
                  .ok,
            )
            .map(({ componentId }) => componentId),
        ),
      ];
      return {
        dataTypeId,
        shape,
        producedByCapabilityIds: capabilityIds,
        matchingComponentIds,
        unrenderable: matchingComponentIds.length === 0,
      };
    });
}

export interface SurfaceCapabilityScope {
  surfaceId: string;
  /** Capability ids the planner could legally bind on this surface, sorted. */
  capabilityIds: readonly string[];
  /** Capability ids excluded because nothing on this surface can render them. */
  excludedCapabilityIds: readonly string[];
  /**
   * What the excluded capabilities *produce*, deduplicated to one entry per
   * (dataTypeId, shape) pair and sorted.
   *
   * The scope has always known which capabilities it dropped and why, and the
   * fact went nowhere: the planner saw a manifest with the capability absent,
   * truthfully reported having none for the request, and named the catalog as
   * the blocker. Measured — a `hierarchy` capability was refused as data the
   * catalog "does not provide", then rendered 17 rows the moment a component
   * accepting that shape was registered, with nothing about the catalog
   * changed. A host reading that message goes looking for fields to approve,
   * which is the one action that cannot help.
   *
   * Deliberately (dataTypeId, shape) and nothing else. This travels into the
   * prompt, where contract size is a live cost, and a refusal only has to
   * name *what* cannot be displayed — never how to call it, which is exactly
   * what must not reach a planner that cannot bind it.
   */
  unrenderableOutputs: readonly { dataTypeId: string; shape: ResultShape }[];
}

const JOIN_TO_ONE_CARDINALITIES = new Set(["one-to-one", "many-to-one"]);

/**
 * Narrows a planner manifest to the capabilities a specific surface could
 * actually bind.
 *
 * The contract handed to the model previously advertised *every* approved
 * capability on every surface, even though components are already scoped by
 * `surface.componentIds`. On a catalog with hundreds of approved operations
 * that is mostly noise: a capability no slot on the surface accepts is one the
 * planner can never bind, so offering it can only cost tokens and invite a
 * rejected draft.
 *
 * This is derived, not configured — it reuses `slotAcceptsOutput`, the same
 * matcher `validatePlanDataBindings` enforces afterwards, so the scope can
 * never exclude something validation would have accepted.
 *
 * A capability qualifies four ways, and the last two are the reason this is not
 * a one-line filter:
 *
 * 1. **Direct** — a slot accepts its output as-is.
 * 2. **Composition input** — it advertises a set operation and a slot accepts
 *    its data type as a `collection` (compositions always deliver a collection).
 * 3. **Join left** — a slot accepts its data type as a `collection` and an
 *    approved to-one relationship starts at that data type.
 * 4. **Join right** — its output is *never bound to a slot at all*; it only has
 *    to be the `to` side of a relationship whose `from` side qualifies under
 *    rule 3. A filter that only checked slot acceptance would silently drop
 *    every join's right-hand capability and break joins entirely.
 */
export function scopeManifestToSurface(
  plannerManifest: PlannerManifest,
  site: RegisteredSite,
  surfaceId: string,
): SurfaceCapabilityScope {
  const surface = site.getSurface(surfaceId);
  if (!surface) {
    throw new Error(`Unknown site surface: ${surfaceId}`);
  }

  const slots = surface.componentIds.flatMap((componentId) => {
    const component = site.getComponent(componentId);
    if (!component) {
      throw new Error(
        `Surface ${surface.id} references unknown component ${componentId}`,
      );
    }
    return Object.values(component.dataSlots);
  });

  const acceptedBySomeSlot = (
    output: {
      dataTypeId: string;
      shape: ResultShape;
    },
    groupingSatisfiable = false,
  ): boolean =>
    slots.some(
      (slot) => slotAcceptsOutput(slot, output, plannerManifest, [], groupingSatisfiable).ok,
    );

  const included = new Set<string>();

  // Rules 1-3.
  const joinableFromDataTypes = new Set<string>();
  for (const capability of plannerManifest.capabilities) {
    const { dataTypeId } = capability.output;
    // Direct binding may satisfy a grouping-only slot when the capability can
    // serve a grouped request; composed/joined deliveries never group, so the
    // collection checks below stay ungrouped.
    if (acceptedBySomeSlot(capability.output, capabilityCanGroup(capability))) {
      included.add(capability.id);
    }
    const acceptsAsCollection = acceptedBySomeSlot({
      dataTypeId,
      shape: COMPOSED_RESULT_SHAPE,
    });
    if (!acceptsAsCollection) continue;
    if (capability.supports?.setOperations?.length) {
      included.add(capability.id);
    }
    const startsARelationship = plannerManifest.relationships.some(
      (relationship) =>
        JOIN_TO_ONE_CARDINALITIES.has(relationship.cardinality) &&
        relationship.fromDataTypeId === dataTypeId,
    );
    if (startsARelationship) {
      included.add(capability.id);
      joinableFromDataTypes.add(dataTypeId);
    }
  }

  // Rule 4: the right side of a join is consumed by the join, never rendered.
  const joinableToDataTypes = new Set(
    plannerManifest.relationships
      .filter(
        (relationship) =>
          JOIN_TO_ONE_CARDINALITIES.has(relationship.cardinality) &&
          joinableFromDataTypes.has(relationship.fromDataTypeId),
      )
      .map((relationship) => relationship.toDataTypeId),
  );
  for (const capability of plannerManifest.capabilities) {
    if (joinableToDataTypes.has(capability.output.dataTypeId)) {
      included.add(capability.id);
    }
  }

  const capabilityIds = plannerManifest.capabilities
    .map((capability) => capability.id)
    .filter((id) => included.has(id))
    .sort();
  const excludedCapabilityIds = plannerManifest.capabilities
    .map((capability) => capability.id)
    .filter((id) => !included.has(id))
    .sort();
  const unrenderableOutputs = [
    ...new Map(
      plannerManifest.capabilities
        .filter((capability) => !included.has(capability.id))
        .map((capability) => [
          `${capability.output.dataTypeId}:${capability.output.shape}`,
          {
            dataTypeId: capability.output.dataTypeId,
            shape: capability.output.shape,
          },
        ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.dataTypeId.localeCompare(right.dataTypeId) ||
      left.shape.localeCompare(right.shape),
  );

  return { surfaceId: surface.id, capabilityIds, excludedCapabilityIds, unrenderableOutputs };
}

export interface CompiledSiteSurface {
  version: "v0.9";
  createSurface?: {
    surfaceId: string;
    catalogId: string;
  };
  updateComponents?: {
    surfaceId: string;
    components: Array<Record<string, JsonValue>>;
  };
  updateDataModel?: {
    surfaceId: string;
    path: "/";
    value: JsonValue;
  };
}

export interface ProjectPlanDataModelInput {
  plan: PlanV3_1;
  plannerManifest: PlannerManifest;
  executedData: ExecutedPlanData & {
    compositions?: Record<string, CompositionResult>;
    joins?: Record<string, JoinResult>;
  };
  baseDataModel: Record<string, JsonValue>;
  /**
   * Prefixes every write with the owning node's id (see `scopedDataPath`),
   * so two instances of the same component never target the same path.
   * Defaults to false for source compatibility with existing direct callers
   * (e.g. `apps/demo-finance-site`'s finance composition, which builds and
   * reads the returned data model itself using the component's declared
   * paths verbatim). `compilePlanDataSurfaceMessages` always enables this,
   * since it also scopes the paths in the A2UI messages it emits.
   */
  scopeDataPathsByInstance?: boolean;
  /** See `PlanDataBindingOptions.allowCatalogDrift`. Only a saved-view replay sets this. */
  allowCatalogDrift?: boolean;
  /**
   * Projects a result that has not arrived yet as `pending` instead of
   * throwing. Off by default, because for a completed compose a missing
   * result is a bug and silence would hide it.
   *
   * Streaming needs it: the frame that lets a skeleton render is the surface
   * and its components *before* any data exists, and every later frame is a
   * partial one. A pending slot gets the same empty value a failed one gets,
   * so a component that only understands `ready` renders empty rather than
   * breaking — but `state` says `pending`, so one that does understand it can
   * show a skeleton, and provenance is written as absent rather than as an
   * authoritative empty.
   */
  treatMissingAsPending?: boolean;
  /**
   * Turns a failed result into the string a **visitor** sees.
   *
   * Defaults to one fixed, uninformative sentence, because the alternative is
   * not safe. This projection used to copy `result.error.message` straight to a
   * renderer path, and `starter-catalog` renders that path in a live
   * `<p role="alert">` — so whatever a host's `runtime.execute` put in a failure
   * message went to the browser verbatim. Built-in runtimes return fixed
   * strings, but `INTEGRATION.md` tells hosts to supply their own, and nothing
   * told them the field was visitor-facing.
   *
   * The full error is untouched in `executedData`, which is where a host's own
   * logging and observability should read it. Override this only to improve the
   * *visitor's* wording — for example to localise, or to distinguish
   * "sign in" from "not available" using `error.code`. Never return
   * `error.message` from here without knowing what every runtime behind the
   * catalog can put in it.
   */
  formatVisitorError?: (error: {
    code: string;
    message: string;
    retryable?: boolean;
  }) => string;
}

/**
 * What a visitor sees when a data request fails and the host supplied no
 * `formatVisitorError`.
 *
 * Deliberately says nothing: no code, no upstream detail, no hint about what
 * exists. A host that wants better copy owns that decision.
 */
export const DEFAULT_VISITOR_ERROR_MESSAGE = "This information could not be loaded.";

/**
 * Projects only executor-validated results into a caller-created data model.
 *
 * Every result is recorded in a reserved metadata envelope. Bound result data
 * is also copied to the component's immutable owner-registered renderer path.
 * The plan supplies request IDs only and can never supply an A2UI path.
 */
export function projectPlanDataModel(
  site: RegisteredSite,
  input: ProjectPlanDataModelInput,
): Record<string, JsonValue> {
  const compatibility = validatePlanDataBindings(site, input.plan, input.plannerManifest, {
    allowCatalogDrift: input.allowCatalogDrift === true,
  });
  if (!compatibility.ok) {
    throw new Error(
      compatibility.issues.map((item) => `${item.path}: ${item.message}`).join("; "),
    );
  }
  if (input.executedData.planId !== input.plan.planId) {
    throw new Error(
      `Executed data belongs to plan ${input.executedData.planId}, not ${input.plan.planId}`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(input.baseDataModel, "__renderyes")) {
    throw new Error("Base data model cannot define reserved __renderyes state");
  }
  if (!isJsonValue(input.baseDataModel)) {
    throw new Error("Base data model must be JSON-compatible");
  }

  const dataModel = cloneJsonObject(input.baseDataModel);
  const requestsById = new Map(
    input.plan.dataRequests.map((request) => [request.requestId, request]),
  );
  const compositionsById = new Map(
    (input.plan.dataCompositions ?? []).map((composition) => [
      composition.compositionId,
      composition,
    ]),
  );
  const joinsById = new Map(
    (input.plan.dataJoins ?? []).map((join) => [join.joinId, join]),
  );
  const composedResults = input.executedData.compositions ?? {};
  const joinedResults = input.executedData.joins ?? {};
  const capabilitiesById = new Map(
    input.plannerManifest.capabilities.map((capability) => [capability.id, capability]),
  );
  const writes = new Map<string, { sourceId: string; value: JsonValue }>();
  const requestEnvelopes: JsonValue[] = [];
  const compositionEnvelopes: JsonValue[] = [];
  const joinEnvelopes: JsonValue[] = [];

  for (const request of input.plan.dataRequests) {
    const result = input.executedData.results[request.requestId];
    if (!result) {
      if (input.treatMissingAsPending) {
        requestEnvelopes.push({
          requestId: request.requestId,
          capabilityId: request.capabilityId,
          state: "pending",
        });
        continue;
      }
      throw new Error(`Missing executed result for request ${request.requestId}`);
    }
    if (!isJsonValue(result)) {
      throw new Error(
        `Executed result for request ${request.requestId} is not JSON-compatible`,
      );
    }
    requestEnvelopes.push(resultEnvelope(request, result));
  }

  for (const composition of input.plan.dataCompositions ?? []) {
    const result = composedResults[composition.compositionId];
    if (!result) {
      if (input.treatMissingAsPending) {
        compositionEnvelopes.push({
          compositionId: composition.compositionId,
          operation: composition.operation,
          state: "pending",
        });
        continue;
      }
      throw new Error(
        `Missing composed result for composition ${composition.compositionId}`,
      );
    }
    compositionEnvelopes.push(compositionEnvelope(result));
  }

  for (const join of input.plan.dataJoins ?? []) {
    const result = joinedResults[join.joinId];
    if (!result) {
      if (input.treatMissingAsPending) {
        joinEnvelopes.push({ joinId: join.joinId, state: "pending" });
        continue;
      }
      throw new Error(`Missing joined result for join ${join.joinId}`);
    }
    joinEnvelopes.push(joinEnvelope(result));
  }

  // Which data source feeds which panel, copied verbatim from the validated
  // plan's own bindings. Without this the browser holds panels (nodeIds) and
  // request summaries (requestIds) and nothing joining them — so a click in
  // one panel could never aim the already-shipped `refine` at another. Ids
  // only, no rows, and nothing here is host-specific: every plan on every
  // host carries these bindings.
  const nodeEnvelopes: JsonValue[] = [];
  const visitNodeBindings = (node: SurfaceNode): void => {
    nodeEnvelopes.push({
      nodeId: node.nodeId,
      componentId: node.componentId,
      bindings: Object.fromEntries(
        Object.entries(node.dataBindings ?? {}).map(([slot, binding]) => [
          slot,
          { ...binding },
        ]),
      ),
    });
    for (const children of Object.values(node.slots ?? {})) {
      for (const child of children) visitNodeBindings(child);
    }
  };
  for (const surface of input.plan.surfaces) {
    for (const node of surface.nodes) visitNodeBindings(node);
  }

  dataModel.__renderyes = {
    planId: input.plan.planId,
    requests: requestEnvelopes,
    compositions: compositionEnvelopes,
    joins: joinEnvelopes,
    nodes: nodeEnvelopes,
  };

  for (const [surfaceIndex, surface] of input.plan.surfaces.entries()) {
    for (const [nodeIndex, node] of surface.nodes.entries()) {
      visitNode(node, `surfaces.${surfaceIndex}.nodes.${nodeIndex}`);
    }
  }

  return dataModel;

  function visitNode(node: SurfaceNode, path: string): void {
    const component = site.getComponent(node.componentId);
    if (!component) return;

    for (const [slotName, binding] of Object.entries(node.dataBindings ?? {})) {
      // Scoped by this node's id so two instances of the same component
      // never target the same data-model path. See `scopedDataPath`.
      const scope = (relativePath: string) =>
        input.scopeDataPathsByInstance
          ? scopedDataPath(node.nodeId, relativePath)
          : relativePath;
      const scopeOptional = (relativePath: string | undefined) =>
        relativePath === undefined ? undefined : scope(relativePath);
      const dataPath = scope(pathFromRendererProp(component, slotName));
      const statePath = scopeOptional(optionalPathFromRendererProp(component, "state"));
      const errorPath = scopeOptional(
        optionalPathFromRendererProp(component, "errorMessage"),
      );
      // Optional, component-declared provenance display. A component that
      // wants a source/freshness tag next to its bound data declares these
      // renderer paths the same way it already declares `state` and
      // `errorMessage`; a component that doesn't declare them gets no writes.
      const sourcesPath = scopeOptional(
        optionalPathFromRendererProp(component, "sources"),
      );
      const asOfPath = scopeOptional(optionalPathFromRendererProp(component, "asOf"));
      const provenancePaths: ProvenancePaths = {
        sources: sourcesPath,
        asOf: asOfPath,
        staleAt: scopeOptional(optionalPathFromRendererProp(component, "staleAt")),
        completeness: scopeOptional(
          optionalPathFromRendererProp(component, "completeness"),
        ),
        records: scopeOptional(optionalPathFromRendererProp(component, "records")),
      };

      /**
       * A slot whose result has not arrived. The empty value matches what a
       * failure would write, so a component that switches only on `ready`
       * behaves identically to today; `state` is what distinguishes "still
       * coming" from "came back with nothing".
       */
      // Visitor-facing, deliberately. The full error stays in `executedData`
      // for a host's own logging; this is the only copy that reaches a browser.
      const visitorError = (error: {
        code: string;
        message: string;
        retryable?: boolean;
      }): string =>
        input.formatVisitorError?.(error) ?? DEFAULT_VISITOR_ERROR_MESSAGE;

      const writePending = (sourceId: string, emptyValue: JsonValue): void => {
        write(dataPath, sourceId, emptyValue);
        if (statePath) write(statePath, sourceId, "pending");
        if (errorPath) write(errorPath, sourceId, "");
        writeProvenance(provenancePaths, sourceId, undefined, undefined);
      };

      if ("compositionId" in binding) {
        // Composition binding: project the composed result. Composed results are
        // always collections, so the empty value for an error state is [].
        const result = composedResults[binding.compositionId];
        if (!compositionsById.has(binding.compositionId) || !result) {
          if (input.treatMissingAsPending && compositionsById.has(binding.compositionId)) {
            writePending(binding.compositionId, []);
            continue;
          }
          throw new Error(`${path}.dataBindings.${slotName}: Missing composed result`);
        }
        if (result.ok) {
          if (!isJsonValue(result.data)) {
            throw new Error(
              `Composed data for ${binding.compositionId} is not JSON-compatible`,
            );
          }
          write(dataPath, binding.compositionId, result.data);
          if (statePath) {
            write(
              statePath,
              binding.compositionId,
              result.data.length === 0 ? "empty" : "ready",
            );
          }
          if (errorPath) write(errorPath, binding.compositionId, "");
          writeProvenance(
            provenancePaths,
            binding.compositionId,
            result.provenance,
            result.data.length,
          );
        } else {
          write(dataPath, binding.compositionId, []);
          if (statePath) write(statePath, binding.compositionId, "error");
          if (errorPath) write(errorPath, binding.compositionId, visitorError(result.error));
          writeProvenance(provenancePaths, binding.compositionId, undefined, 0);
        }
        continue;
      }

      if ("joinId" in binding) {
        // Join binding: project the enriched left rows (always a collection).
        const result = joinedResults[binding.joinId];
        if (!joinsById.has(binding.joinId) || !result) {
          if (input.treatMissingAsPending && joinsById.has(binding.joinId)) {
            writePending(binding.joinId, []);
            continue;
          }
          throw new Error(`${path}.dataBindings.${slotName}: Missing joined result`);
        }
        if (result.ok) {
          if (!isJsonValue(result.data)) {
            throw new Error(`Joined data for ${binding.joinId} is not JSON-compatible`);
          }
          write(dataPath, binding.joinId, result.data);
          if (statePath) {
            write(
              statePath,
              binding.joinId,
              result.data.length === 0 ? "empty" : "ready",
            );
          }
          if (errorPath) write(errorPath, binding.joinId, "");
          writeProvenance(
            provenancePaths,
            binding.joinId,
            result.provenance,
            result.data.length,
          );
        } else {
          write(dataPath, binding.joinId, []);
          if (statePath) write(statePath, binding.joinId, "error");
          if (errorPath) write(errorPath, binding.joinId, visitorError(result.error));
          writeProvenance(provenancePaths, binding.joinId, undefined, 0);
        }
        continue;
      }

      const request = requestsById.get(binding.requestId);
      const result = input.executedData.results[binding.requestId];
      if (!request || (!result && !input.treatMissingAsPending)) {
        throw new Error(`${path}.dataBindings.${slotName}: Missing executed request`);
      }
      const capability = capabilitiesById.get(request.capabilityId);
      if (!capability) {
        throw new Error(
          `${path}.dataBindings.${slotName}: Unknown capability ${request.capabilityId}`,
        );
      }

      if (!result) {
        writePending(request.requestId, emptyValueForShape(capability.output.shape));
        continue;
      }

      if (result.ok) {
        if (!isJsonValue(result.data)) {
          throw new Error(
            `Executed data for request ${request.requestId} is not JSON-compatible`,
          );
        }
        write(dataPath, request.requestId, result.data);
        if (statePath) {
          // `null` data is an entity lookup that matched nothing — the same
          // "request worked, nothing to show" an empty collection means.
          write(
            statePath,
            request.requestId,
            (Array.isArray(result.data) && result.data.length === 0) ||
              result.data === null
              ? "empty"
              : "ready",
          );
        }
        if (errorPath) write(errorPath, request.requestId, "");
        writeProvenance(
          provenancePaths,
          request.requestId,
          result.provenance,
          Array.isArray(result.data) ? result.data.length : undefined,
        );
      } else {
        write(dataPath, request.requestId, emptyValueForShape(capability.output.shape));
        if (statePath) write(statePath, request.requestId, "error");
        if (errorPath) {
          write(errorPath, request.requestId, visitorError(result.error));
        }
        writeProvenance(provenancePaths, request.requestId, undefined, undefined);
      }
    }

    for (const [slotName, children] of Object.entries(node.slots ?? {})) {
      for (const [childIndex, child] of children.entries()) {
        visitNode(child, `${path}.slots.${slotName}.${childIndex}`);
      }
    }
  }

  function write(path: string, sourceId: string, value: JsonValue): void {
    const previous = writes.get(path);
    if (
      previous &&
      (previous.sourceId !== sourceId ||
        stableStringify(previous.value) !== stableStringify(value))
    ) {
      throw new Error(`Conflicting data projections target immutable path ${path}`);
    }
    writes.set(path, { sourceId, value });
    setJsonPointer(dataModel, path, value);
  }

  /**
   * Optional provenance and completeness tags, written only for the paths the
   * component declares. On failure (`provenance` undefined) each declared path
   * gets an empty value rather than a stale prior tag — a component that
   * displays this must treat an empty `sources` array as "do not present this
   * as authoritative" per the provenance principle, the same way `errorPath`
   * already carries a message on failure.
   *
   * `completeness` is the one a component cannot afford to ignore. The runtime
   * already knew a result had been cut short — `provenance.truncated` has been
   * set by the row budget since it was introduced — and there was no path by
   * which a component could find out, so a truncated collection rendered
   * identically to a complete one. Every number on the screen was then wrong in
   * a way nothing on the screen disclosed, which is the failure this system's
   * central claim is about.
   */
  function writeProvenance(
    paths: ProvenancePaths,
    sourceId: string,
    provenance: DataProvenance | undefined,
    rowCount: number | undefined,
  ): void {
    if (
      !paths.sources &&
      !paths.asOf &&
      !paths.staleAt &&
      !paths.completeness &&
      !paths.records
    ) {
      return;
    }
    if (paths.sources) {
      write(
        paths.sources,
        sourceId,
        provenance?.sources.map((source) => source.sourceId) ?? [],
      );
    }
    if (paths.asOf) {
      write(paths.asOf, sourceId, provenance?.freshness.asOf ?? "");
    }
    if (paths.staleAt) {
      // Empty rather than absent when the source declares no staleness horizon:
      // "this never goes stale" and "we don't know" are different claims, and
      // only the source can distinguish them. A component showing a freshness
      // tag reads an empty value as "no horizon declared".
      write(paths.staleAt, sourceId, provenance?.freshness.staleAt ?? "");
    }
    if (paths.records) {
      // Only sources that actually carry a deep link. A `recordUrl`-less entry
      // would be an object with one key that no component can do anything with.
      write(
        paths.records,
        sourceId,
        provenance?.sources
          .filter((source) => source.recordUrl !== undefined)
          .map((source) => ({ sourceId: source.sourceId, recordUrl: source.recordUrl! })) ??
          [],
      );
    }
    if (paths.completeness) {
      const truncated = provenance?.truncated === true;
      // A filter/sort/aggregation ran over one page of a larger collection.
      // The fetch may have satisfied its own ask exactly — no `truncated` —
      // and yet the narrowed rows are not the answer: the matches may live
      // entirely in pages never fetched. `moreAvailable` alone stays routine
      // only for un-narrowed results.
      const narrowedAfterFetch = provenance?.narrowedAfterFetch === true;
      // Fewer *columns* rather than fewer rows, but the same claim: what
      // arrived is provably less than the answer. A field the upstream errored
      // on comes through as null, and a component that cannot tell that apart
      // from a real absence renders "—" or "0" as though it were the value.
      const degradedFields = provenance?.degradedFields ?? [];
      write(paths.completeness, sourceId, {
        // A failed request is not "incomplete", it is absent — `state` already
        // says so. `complete: false` means the request succeeded and what
        // arrived is provably less than the answer.
        complete:
          provenance !== undefined &&
          !truncated &&
          !narrowedAfterFetch &&
          degradedFields.length === 0,
        truncated,
        ...(narrowedAfterFetch ? { narrowedAfterFetch: true } : {}),
        ...(provenance?.rowsBeforeNarrowing !== undefined
          ? { rowsBeforeNarrowing: provenance.rowsBeforeNarrowing }
          : {}),
        // Routine, not a caveat: the answer is complete and the dataset goes
        // on. Carried so a component can offer "show more" without implying —
        // as `truncated` would — that the rows on screen are short of the ask.
        ...(provenance?.moreAvailable === true ? { moreAvailable: true } : {}),
        ...(degradedFields.length > 0 ? { degradedFields: [...degradedFields] } : {}),
        ...(rowCount !== undefined ? { rowCount } : {}),
        ...(provenance?.totalRowsBeforeTruncation !== undefined
          ? { totalRows: provenance.totalRowsBeforeTruncation }
          : {}),
      });
    }
  }
}

/**
 * The already-scoped data-model paths for one slot's provenance companions.
 * Grouped rather than passed as five positional arguments — the call sites
 * differ only in which result they are reporting, and a five-argument version
 * made "which undefined is which" a real hazard.
 */
interface ProvenancePaths {
  sources: string | undefined;
  asOf: string | undefined;
  staleAt: string | undefined;
  completeness: string | undefined;
  records: string | undefined;
}

export interface CompilePlanDataSurfaceInput extends ProjectPlanDataModelInput {
  surfaceId: string;
  a2uiCatalogId: string;
}

/**
 * Data-aware surface compiler. Component nodes may declare child slots
 * (nested layout); each slot's children are compiled the same way as a
 * top-level component, recursively.
 */
export function compilePlanDataSurfaceMessages(
  site: RegisteredSite,
  input: CompilePlanDataSurfaceInput,
): CompiledSiteSurface[] {
  const surface = input.plan.surfaces.find(
    (candidate) => candidate.id === input.surfaceId,
  );
  if (!surface) {
    throw new Error(`Plan does not contain surface ${input.surfaceId}`);
  }
  const dataModel = projectPlanDataModel(site, {
    ...input,
    scopeDataPathsByInstance: true,
  });
  return compileSurfaceMessages(site, {
    surfaceId: input.surfaceId,
    a2uiCatalogId: input.a2uiCatalogId,
    instances: surface.nodes.map(toComponentInstance),
    dataModel,
    // The data model above was projected with node-scoped paths (see
    // `scopedDataPath`), so component records must reference the same
    // scoped paths or the two would silently disagree.
    scopeDataPathsByInstance: true,
  });
}

function toComponentInstance(node: SurfaceNode): ComponentInstance {
  const slots = Object.fromEntries(
    Object.entries(node.slots ?? {}).map(([slotName, children]) => [
      slotName,
      children.map(toComponentInstance),
    ]),
  );
  return {
    id: node.nodeId,
    componentId: node.componentId,
    props: node.props,
    ...(Object.keys(slots).length > 0 ? { slots } : {}),
  };
}

function collectInstanceIds(instances: readonly ComponentInstance[]): string[] {
  const ids: string[] = [];
  for (const instance of instances) {
    ids.push(instance.id);
    for (const children of Object.values(instance.slots ?? {})) {
      ids.push(...collectInstanceIds(children));
    }
  }
  return ids;
}

/**
 * Compiles one instance (and, recursively, its slot children) into an A2UI
 * component record. `surface.componentIds` is checked at every depth (not only
 * the top level): a nested-only leaf component must still be declared on the
 * surface for its schema/binding to exist at all, so this matches the
 * planner's node-variant source of truth. Slot cardinality/`accepts` are
 * structurally enforced by `validatePlanDataBindings` before compilation ever
 * runs; this function only guards its own silent-corruption mode — an
 * undeclared slot name throws rather than silently emitting a bogus prop.
 */
function compileInstance(
  site: RegisteredSite,
  surface: SurfaceDefinition,
  instance: ComponentInstance,
  target: Array<Record<string, JsonValue>>,
  scopeDataPathsByInstance: boolean,
): void {
  assertId(instance.id, "Component instance id");
  const component = site.getComponent(instance.componentId);
  if (!component) {
    throw new Error(`Unknown registered component: ${instance.componentId}`);
  }
  if (!surface.componentIds.includes(component.id)) {
    throw new Error(`Component ${component.id} is not allowed on surface ${surface.id}`);
  }
  const propsResult = component.props.safeParse(instance.props ?? {});
  if (!propsResult.success) {
    const summary = propsResult.issues
      .map((item) => `${item.path.join(".") || "props"}: ${item.message}`)
      .join("; ");
    throw new Error(`Invalid props for ${component.id}: ${summary}`);
  }
  const bindingCollision = Object.keys(propsResult.data).find(
    (name) => name in component.renderer.props,
  );
  if (bindingCollision) {
    throw new Error(
      `Component ${component.id} prop ${bindingCollision} cannot override its registered renderer binding`,
    );
  }

  // `renderer.props` mixes three kinds of value: plain JSON (e.g.
  // `accessibility`), a dataSlot's fixed path, and executor-owned companion
  // paths (`state`/`errorMessage`/`sources`/`asOf`) that `visitNode` writes
  // alongside whichever slot triggered them. Only those two path kinds are
  // ever written by `projectPlanDataModel`'s node-scoped writes, so only
  // those are rewritten here — a static, host-populated prop like `columns`
  // or `title` lives at its original unscoped `baseDataModel` location and
  // rewriting it here would point the component at a path nothing ever
  // writes to.
  const executorOwnedPropNames = new Set([
    ...Object.keys(component.dataSlots),
    "state",
    "errorMessage",
    "sources",
    "asOf",
    "staleAt",
    "completeness",
    "records",
  ]);
  const rendererProps = scopeDataPathsByInstance
    ? Object.fromEntries(
        Object.entries(component.renderer.props).map(([key, value]) =>
          isA2UIPathBinding(value) && executorOwnedPropNames.has(key)
            ? [key, { path: scopedDataPath(instance.id, value.path) }]
            : [key, value],
        ),
      )
    : component.renderer.props;

  const record: Record<string, JsonValue> = {
    id: instance.id,
    component: component.renderer.component,
    ...propsResult.data,
    ...rendererProps,
  };
  for (const [slotName, children] of Object.entries(instance.slots ?? {})) {
    const slot = component.slots?.[slotName];
    if (!slot) {
      throw new Error(`${component.id} does not declare slot ${slotName}`);
    }
    const childIds = children.map((child) => child.id);
    record[slotName] = slot.cardinality === "one" ? (childIds[0] ?? null) : childIds;
  }
  target.push(record);

  for (const children of Object.values(instance.slots ?? {})) {
    for (const child of children) {
      compileInstance(site, surface, child, target, scopeDataPathsByInstance);
    }
  }
}

export function compileSurfaceMessages(
  site: RegisteredSite,
  input: {
    surfaceId: string;
    a2uiCatalogId: string;
    instances: readonly ComponentInstance[];
    dataModel: JsonValue;
    /**
     * Rewrites each instance's fixed renderer paths to be prefixed by its own
     * instance id, so two instances of the same component never target the
     * same data-model path. Defaults to false so hand-authored callers (the
     * zero-AI path — see AGENTS.md) that build their own `dataModel` and
     * expect the component's declared paths verbatim keep working unchanged.
     * `compilePlanDataSurfaceMessages` (the plan-driven path) always enables
     * this, since its data model is projected with the same scoping.
     */
    scopeDataPathsByInstance?: boolean;
  },
): CompiledSiteSurface[] {
  const surface = site.getSurface(input.surfaceId);
  if (!surface) {
    throw new Error(`Unknown site surface: ${input.surfaceId}`);
  }
  assertNonEmpty(input.a2uiCatalogId, "A2UI catalog id");
  if (!isJsonValue(input.dataModel)) {
    throw new Error("Surface data model must be JSON-compatible");
  }
  if (input.instances.length === 0) {
    throw new Error(`Surface ${surface.id} requires at least one component`);
  }
  if (
    surface.maxComponents !== undefined &&
    input.instances.length > surface.maxComponents
  ) {
    throw new Error(
      `Surface ${surface.id} allows at most ${surface.maxComponents} components`,
    );
  }
  assertUnique(collectInstanceIds(input.instances), "Component instance");

  const components: Array<Record<string, JsonValue>> = [];
  for (const instance of input.instances) {
    compileInstance(
      site,
      surface,
      instance,
      components,
      input.scopeDataPathsByInstance ?? false,
    );
  }

  return [
    {
      version: "v0.9",
      createSurface: {
        surfaceId: surface.id,
        catalogId: input.a2uiCatalogId,
      },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: surface.id,
        components: [
          {
            id: "root",
            component: "Column",
            children: input.instances.map((instance) => instance.id),
          },
          ...components,
        ],
      },
    },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: surface.id,
        path: "/",
        value: input.dataModel,
      },
    },
  ];
}

export interface SiteManifest {
  schemaVersion: "1.0";
  site: {
    id: string;
    name: string;
    version: string;
  };
  catalog: {
    id: string;
    fingerprint: string;
    registrationFingerprint: string;
  };
  components: Array<{
    id: string;
    version: string;
    description: string;
    rendererComponent: string;
    /**
     * Immutable data-model path bindings. A plan can never name or override
     * these; they exist purely so a reconstructed component still resolves
     * the same fixed locations the host originally registered. Without this
     * field, `toSiteManifest` was display-only — sufficient for the CLI's
     * `scan`, insufficient to actually reconstruct a working site, since
     * `projectPlanDataModel` resolves every write through these paths.
     */
    rendererProps: Readonly<Record<string, JsonValue>>;
    dataSlots: Readonly<Record<string, ComponentDataSlot>>;
    slots?: Readonly<Record<string, SlotDefinition>>;
    /** Instance/weight limits. Omitted server-side enforcement would silently vanish. */
    policy?: ComponentPolicy;
    tags?: readonly string[];
    propsSchema: Record<string, JsonValue>;
  }>;
  surfaces: readonly SurfaceDefinition[];
  /** Optional, mirroring `SiteDefinition.theme`. */
  theme?: ThemeDefinition;
  sources: DataSourceSnapshot[];
}

export function toSiteManifest(site: RegisteredSite): SiteManifest {
  return {
    schemaVersion: "1.0",
    site: { id: site.id, name: site.name, version: site.version },
    catalog: {
      id: site.catalogId,
      fingerprint: site.catalog.fingerprint,
      registrationFingerprint: site.registrationFingerprint,
    },
    components: site.components.map((component) => ({
      id: component.id,
      version: component.version,
      description: component.description,
      rendererComponent: component.renderer.component,
      rendererProps: component.renderer.props,
      dataSlots: component.dataSlots,
      ...(component.slots ? { slots: component.slots } : {}),
      ...(component.policy ? { policy: component.policy } : {}),
      ...(component.tags ? { tags: component.tags } : {}),
      propsSchema: component.props.jsonSchema,
    })),
    surfaces: site.surfaces,
    ...(site.theme ? { theme: site.theme } : {}),
    sources: site.sources.map(toSourceSnapshot),
  };
}

/**
 * Reconstructs a working `RegisteredSite` from a wire-serialized manifest.
 *
 * This is the counterpart to `toSiteManifest`: the only way a component
 * survives crossing a network boundary is as JSON, so props validation is
 * rebuilt from the raw JSON Schema via Ajv rather than the host's original
 * Zod schema. Everything downstream — `validatePlanDataBindings`,
 * `projectPlanDataModel`, `compilePlanDataSurfaceMessages` — operates on the
 * result exactly as it would on a locally-defined site.
 */
export function defineSiteFromManifest(manifest: SiteManifest): RegisteredSite {
  const components = manifest.components.map((component) =>
    defineComponent({
      id: component.id,
      version: component.version,
      description: component.description,
      props: propsContractFromJsonSchema(component.propsSchema),
      renderer: {
        component: component.rendererComponent,
        props: component.rendererProps,
      },
      dataSlots: component.dataSlots,
      ...(component.slots ? { slots: component.slots } : {}),
      ...(component.policy ? { policy: component.policy } : {}),
      ...(component.tags ? { tags: [...component.tags] } : {}),
    }),
  );

  return defineSite({
    id: manifest.site.id,
    name: manifest.site.name,
    version: manifest.site.version,
    catalogId: manifest.catalog.id,
    components,
    surfaces: [...manifest.surfaces],
    ...(manifest.theme ? { theme: manifest.theme } : {}),
  });
}

/** Accepts `undefined` so a caller can pass `site.theme` directly: a themeless site simply contributes no CSS variables. */
export function themeToCssVariables(
  theme: ThemeDefinition | undefined,
): Record<string, string> {
  if (!theme) return {};
  return Object.fromEntries(
    Object.entries(theme.tokens).map(([name, value]) => [
      `--persona-${toKebabCase(name)}`,
      String(value),
    ]),
  );
}

function validateFieldDefinition(name: string, definition: FieldDefinition) {
  if (definition.type === "enum" && definition.values.length === 0) {
    throw new Error(`Enum field ${name} requires at least one value`);
  }
  if (
    definition.type === "stringArray" &&
    definition.minItems !== undefined &&
    definition.maxItems !== undefined &&
    definition.minItems > definition.maxItems
  ) {
    throw new Error(`Field ${name} minItems cannot exceed maxItems`);
  }
}

function fieldJsonSchema(definition: FieldDefinition): JsonValue {
  const base: Record<string, JsonValue> = {};
  if (definition.type === "string") {
    base.type = "string";
    if (definition.minLength !== undefined) base.minLength = definition.minLength;
    if (definition.maxLength !== undefined) base.maxLength = definition.maxLength;
  } else if (definition.type === "number") {
    base.type = definition.integer ? "integer" : "number";
    if (definition.minimum !== undefined) base.minimum = definition.minimum;
    if (definition.maximum !== undefined) base.maximum = definition.maximum;
  } else if (definition.type === "boolean") {
    base.type = "boolean";
  } else if (definition.type === "enum") {
    base.type = "string";
    base.enum = [...definition.values];
  } else {
    base.type = "array";
    base.items = definition.values
      ? { type: "string", enum: [...definition.values] }
      : { type: "string" };
    if (definition.minItems !== undefined) base.minItems = definition.minItems;
    if (definition.maxItems !== undefined) base.maxItems = definition.maxItems;
    if (definition.unique !== undefined) base.uniqueItems = definition.unique;
  }
  if (definition.default !== undefined) {
    base.default = cloneDefault(definition.default) as JsonValue;
  }
  // The planner reads this schema; a per-prop description is how a host
  // tells the model what a prop means rather than hoping the name carries it.
  if (definition.description !== undefined) {
    base.description = definition.description;
  }
  return base;
}

function parseField(
  name: string,
  definition: FieldDefinition,
  value: unknown,
): { ok: true; value: JsonValue } | { ok: false; issue: PropsValidationIssue } {
  const invalid = (message: string) => ({
    ok: false as const,
    issue: { path: [name], message },
  });

  if (definition.type === "string") {
    if (typeof value !== "string") return invalid("Expected string");
    if (definition.minLength !== undefined && value.length < definition.minLength) {
      return invalid(`Expected at least ${definition.minLength} characters`);
    }
    if (definition.maxLength !== undefined && value.length > definition.maxLength) {
      return invalid(`Expected at most ${definition.maxLength} characters`);
    }
    return { ok: true, value };
  }

  if (definition.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return invalid("Expected finite number");
    }
    if (definition.integer && !Number.isInteger(value)) {
      return invalid("Expected integer");
    }
    if (definition.minimum !== undefined && value < definition.minimum) {
      return invalid(`Expected at least ${definition.minimum}`);
    }
    if (definition.maximum !== undefined && value > definition.maximum) {
      return invalid(`Expected at most ${definition.maximum}`);
    }
    return { ok: true, value };
  }

  if (definition.type === "boolean") {
    return typeof value === "boolean" ? { ok: true, value } : invalid("Expected boolean");
  }

  if (definition.type === "enum") {
    return typeof value === "string" && definition.values.includes(value)
      ? { ok: true, value }
      : invalid(`Expected one of: ${definition.values.join(", ")}`);
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return invalid("Expected string array");
  }
  if (definition.minItems !== undefined && value.length < definition.minItems) {
    return invalid(`Expected at least ${definition.minItems} items`);
  }
  if (definition.maxItems !== undefined && value.length > definition.maxItems) {
    return invalid(`Expected at most ${definition.maxItems} items`);
  }
  if (definition.unique && new Set(value).size !== value.length) {
    return invalid("Expected unique items");
  }
  if (definition.values && value.some((item) => !definition.values?.includes(item))) {
    return invalid(`Expected values from: ${definition.values.join(", ")}`);
  }
  return { ok: true, value: [...value] };
}

function cloneDefault(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  return typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
}

function isA2UIPathBinding(value: JsonValue | undefined): value is { path: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.path === "string" &&
    isSafeJsonPointer(value.path)
  );
}

function pathFromRendererProp(
  component: SiteComponentDefinition,
  propName: string,
): string {
  const path = optionalPathFromRendererProp(component, propName);
  if (!path) {
    throw new Error(
      `Component ${component.id} renderer prop ${propName} is not a fixed path binding`,
    );
  }
  return path;
}

function optionalPathFromRendererProp(
  component: SiteComponentDefinition,
  propName: string,
): string | undefined {
  const value = component.renderer.props[propName];
  return isA2UIPathBinding(value) ? String(value.path) : undefined;
}

/**
 * Prefixes a component's fixed renderer path with the node instance that
 * owns it. Two instances of the same registered component (e.g. showing
 * "urgent" vs "low priority" side by side) previously resolved to the exact
 * same data-model path, since the path came from the *component definition*
 * rather than the *node* — the first write would succeed and the second
 * would throw ("Conflicting data projections"), even though both instances
 * are legitimately declared on the surface. Scoping by nodeId makes that
 * collision impossible by construction instead of detecting it after the
 * fact (and after any upstream capability calls already ran).
 *
 * nodeId comes from a plan (untrusted input) and core's schema only enforces
 * `minLength: 1`, not a safe-identifier pattern, so it is JSON-Pointer
 * escaped here (RFC 6901: "~" -> "~0", "/" -> "~1") rather than assumed safe.
 */
function scopedDataPath(nodeId: string, relativePath: string): string {
  const segment = nodeId.replace(/~/g, "~0").replace(/\//g, "~1");
  if (
    segment.length === 0 ||
    segment === "__proto__" ||
    segment === "prototype" ||
    segment === "constructor"
  ) {
    throw new Error(`Unsafe node id for data-model scoping: ${nodeId}`);
  }
  return `/${segment}${relativePath}`;
}

function isSafeJsonPointer(path: string): boolean {
  if (!path.startsWith("/") || path.length <= 1) return false;
  try {
    return jsonPointerSegments(path).every(
      (segment) =>
        segment.length > 0 &&
        segment !== "__proto__" &&
        segment !== "prototype" &&
        segment !== "constructor",
    );
  } catch {
    return false;
  }
}

function jsonPointerSegments(path: string): string[] {
  return path
    .slice(1)
    .split("/")
    .map((segment) => {
      if (/~(?![01])/u.test(segment)) {
        throw new Error(`Invalid JSON pointer escape in ${path}`);
      }
      return segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    });
}

function setJsonPointer(
  target: Record<string, JsonValue>,
  path: string,
  value: JsonValue,
): void {
  if (!isSafeJsonPointer(path)) {
    throw new Error(`Unsafe A2UI data-model path: ${path}`);
  }
  const segments = jsonPointerSegments(path);
  let cursor: Record<string, JsonValue> = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (existing === undefined) {
      const child: Record<string, JsonValue> = {};
      cursor[segment] = child;
      cursor = child;
      continue;
    }
    if (!isRecord(existing) || Array.isArray(existing)) {
      throw new Error(
        `Cannot project through non-object data-model path segment ${segment}`,
      );
    }
    cursor = existing as Record<string, JsonValue>;
  }
  cursor[segments.at(-1) as string] = cloneJsonValue(value);
}

/**
 * Per-request metadata for `__renderyes`, deliberately without the rows.
 *
 * Every row a component renders already reaches it through that node's own
 * data binding (see `visitNode`). This envelope used to clone the full result
 * as well, so every byte of every result crossed the wire twice — doubling the
 * payload of exactly the requests that return the most.
 *
 * `rowCount` replaces it, which is what `compositionEnvelope` and
 * `joinEnvelope` already reported: those never carried their data, and the
 * inconsistency is what made this easy to miss. Nothing read `data` here.
 */
function resultEnvelope(
  request: { requestId: string; capabilityId: string },
  result: ExecutionResult,
): JsonValue {
  return result.ok
    ? {
        requestId: request.requestId,
        capabilityId: request.capabilityId,
        // `null` data is an entity lookup that matched nothing — empty, not
        // ready, for the same reason a zero-row collection is.
        state:
          (Array.isArray(result.data) && result.data.length === 0) ||
          result.data === null
            ? "empty"
            : "ready",
        ...(Array.isArray(result.data) ? { rowCount: result.data.length } : {}),
        provenance: cloneJsonValue(result.provenance as unknown as JsonValue),
      }
    : {
        requestId: request.requestId,
        capabilityId: request.capabilityId,
        state: "error",
        error: cloneJsonValue(result.error as unknown as JsonValue),
      };
}

function compositionEnvelope(result: CompositionResult): JsonValue {
  return result.ok
    ? {
        compositionId: result.compositionId,
        operation: result.operation,
        state: result.data.length === 0 ? "empty" : "ready",
        rowCount: result.data.length,
        partial: result.partial ?? false,
        provenance: cloneJsonValue(result.provenance as unknown as JsonValue),
      }
    : {
        compositionId: result.compositionId,
        state: "error",
        error: cloneJsonValue(result.error as unknown as JsonValue),
      };
}

function joinEnvelope(result: JoinResult): JsonValue {
  return result.ok
    ? {
        joinId: result.joinId,
        state: result.data.length === 0 ? "empty" : "ready",
        rowCount: result.data.length,
        // The join computed this and then dropped it, so a result where some
        // left rows found no match rendered identically to one where every row
        // matched — a table of orders silently missing its guest orders' user
        // columns, with nothing on screen saying so. It lives on the output
        // schema because that is where the join declares the shape of the rows
        // it produced, unmatched ones included.
        //
        // Present only when the join actually reported it. Defaulting to
        // `false` would assert that every left row matched, which is precisely
        // the false statement this exists to stop making.
        ...(typeof result.outputSchema?.hasUnmatchedRows === "boolean"
          ? { hasUnmatchedRows: result.outputSchema.hasUnmatchedRows }
          : {}),
        provenance: cloneJsonValue(result.provenance as unknown as JsonValue),
      }
    : {
        joinId: result.joinId,
        state: "error",
        error: cloneJsonValue(result.error as unknown as JsonValue),
      };
}

/**
 * The value written to a slot's data-model path when there is nothing to put
 * there — a failed request, or a plan that resolved to no data.
 *
 * It has to match the shape the component would have received on success, or
 * the empty case takes a different code path from every other case. A
 * `time-series` result is an *object* of parallel arrays
 * (`{dates: [...], created: [...]}`), not an array — see `looksLikeTimeSeries`
 * in `@renderyes/capability-catalog`, which is what assigns the shape. It was
 * grouped with the list shapes here purely because "series" sounds plural, so a
 * chart handed the empty value got `[]` where it expected an object, and every
 * chart component needed an `Array.isArray` branch that exists for no other
 * reason.
 */
function emptyValueForShape(shape: ResultShape): JsonValue {
  if (shape === "time-series") return {};
  return shape === "collection" || shape === "search-results" || shape === "media-collection"
    ? []
    : null;
}

function cloneJsonObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return cloneJsonValue(value) as Record<string, JsonValue>;
}

function cloneJsonValue<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeDataSlots(
  dataSlots: Readonly<Record<string, ComponentDataSlot>>,
): Readonly<Record<string, ComponentDataSlot>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(dataSlots).map(([slotName, slot]) => [
        slotName,
        Object.freeze({
          accepts: Object.freeze(
            slot.accepts.map((acceptance) =>
              isStructuralAcceptance(acceptance)
                ? Object.freeze({
                    shape: acceptance.shape,
                    ...(acceptance.requires
                      ? {
                          requires: Object.freeze(
                            acceptance.requires.map((r) => Object.freeze({ ...r })),
                          ),
                        }
                      : {}),
                    ...(acceptance.minFields !== undefined
                      ? { minFields: acceptance.minFields }
                      : {}),
                    ...(acceptance.requiresGrouping !== undefined
                      ? { requiresGrouping: acceptance.requiresGrouping }
                      : {}),
                  })
                : Object.freeze({
                    dataTypeId: acceptance.dataTypeId,
                    shapes: Object.freeze([...acceptance.shapes]),
                    ...(acceptance.requiresGrouping !== undefined
                      ? { requiresGrouping: acceptance.requiresGrouping }
                      : {}),
                  }),
            ),
          ),
        }),
      ]),
    ),
  );
}

function issue(path: Array<string | number>, message: string) {
  return {
    success: false as const,
    issues: [{ path, message }],
  };
}

function assertId(value: string, label: string) {
  if (!idPattern.test(value)) {
    throw new Error(`${label} must match ${idPattern.source}`);
  }
}

function assertSiteId(value: string) {
  if (!siteIdPattern.test(value)) {
    throw new Error(`Site id must match ${siteIdPattern.source}`);
  }
}

function assertNonEmpty(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function assertUnique(values: readonly string[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function fingerprint(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export * from "./site-registry.js";
