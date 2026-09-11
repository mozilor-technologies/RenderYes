import type { JsonValue } from "./plan.js";
import { defineRegistry, type ComponentDefinition, type Registry } from "./registry.js";

/**
 * RenderYes's A2UI-aligned catalog definition. The catalog id should be a
 * stable URI so an agent and renderer can negotiate the same contract.
 */
export interface Catalog extends Registry {
  readonly catalogId: string;
}

export function defineCatalog(input: {
  catalogId: string;
  version: string;
  components: readonly ComponentDefinition[];
}): Catalog {
  const registry = defineRegistry({
    id: input.catalogId,
    version: input.version,
    components: input.components,
  });

  return { ...registry, catalogId: input.catalogId };
}

export interface RendererCatalog<Renderer> {
  definitions: Catalog;
  renderers: Readonly<Record<string, Renderer>>;
  getRenderer(componentId: string): Renderer | undefined;
}

/**
 * Binds trusted client renderers to catalog definitions and fails fast when a
 * definition has no implementation. This mirrors A2UI's definition/renderer
 * split without coupling the core package to React or another UI framework.
 */
export function createCatalog<Renderer>(
  definitions: Catalog,
  renderers: Record<string, Renderer>,
): RendererCatalog<Renderer> {
  const componentIds = new Set(definitions.components.map((component) => component.id));
  const missing = [...componentIds].filter((componentId) => !(componentId in renderers));
  const unknown = Object.keys(renderers).filter(
    (componentId) => !componentIds.has(componentId),
  );

  if (missing.length > 0) {
    throw new Error(`Missing catalog renderers: ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    throw new Error(`Renderers without catalog definitions: ${unknown.join(", ")}`);
  }

  const stableRenderers = Object.freeze({ ...renderers });
  return {
    definitions,
    renderers: stableRenderers,
    getRenderer(componentId: string) {
      return stableRenderers[componentId];
    },
  };
}

export interface A2UICatalogDocument {
  $schema: string;
  $id: string;
  catalogId: string;
  components: Record<string, Record<string, unknown>>;
  functions: unknown[];
  theme: Record<string, unknown>;
}

/** Builds the JSON Schema document shared by an A2UI agent and renderer. */
export function toA2UICatalogDefinition(
  catalog: Catalog,
  options: { rootComponent?: string; rootChildrenProperty?: string } = {},
): A2UICatalogDocument {
  const rootComponent = options.rootComponent ?? "Surface";
  const rootChildrenProperty = options.rootChildrenProperty ?? "children";
  const components = Object.fromEntries(
    catalog.components.map((component) => [component.id, componentSchema(component)]),
  );

  components[rootComponent] = {
    type: "object",
    description: "Root container for a RenderYes surface.",
    additionalProperties: false,
    required: [rootChildrenProperty],
    properties: {
      [rootChildrenProperty]: {
        type: "array",
        items: { type: "string" },
      },
    },
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: catalog.catalogId,
    catalogId: catalog.catalogId,
    components,
    functions: [],
    theme: {},
  };
}

function componentSchema(component: ComponentDefinition): Record<string, unknown> {
  const schema = cloneJson(component.props.jsonSchema) as Record<string, unknown>;
  const existingProperties = isObject(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  const slotProperties = Object.fromEntries(
    Object.entries(component.slots ?? {}).map(([slotName, slot]) => [
      slotName,
      slot.cardinality === "one"
        ? { type: ["string", "null"] }
        : { type: "array", items: { type: "string" } },
    ]),
  );

  return {
    ...schema,
    description: component.description,
    properties: { ...existingProperties, ...slotProperties },
  };
}

function cloneJson<T extends Record<string, JsonValue>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
