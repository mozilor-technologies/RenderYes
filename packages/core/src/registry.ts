import type { JsonValue } from "./plan.js";

export interface PropsValidationIssue {
  path: Array<string | number>;
  message: string;
}

export type PropsValidationResult<Props extends Record<string, JsonValue>> =
  { success: true; data: Props } | { success: false; issues: PropsValidationIssue[] };

export interface PropsContract<
  Props extends Record<string, JsonValue> = Record<string, JsonValue>,
> {
  jsonSchema: Record<string, JsonValue>;
  safeParse(value: unknown): PropsValidationResult<Props>;
}

export interface SlotDefinition {
  description: string;
  cardinality: "one" | "many";
  accepts?: string[];
}

export interface ComponentPolicy {
  maxInstances?: number;
  weight?: number;
}

export interface ComponentDefinition<
  Props extends Record<string, JsonValue> = Record<string, JsonValue>,
> {
  id: string;
  version: string;
  description: string;
  props: PropsContract<Props>;
  slots?: Record<string, SlotDefinition>;
  policy?: ComponentPolicy;
  tags?: string[];
}

export interface Registry {
  id: string;
  version: string;
  fingerprint: string;
  components: readonly ComponentDefinition[];
  get(componentId: string): ComponentDefinition | undefined;
}

export function defineComponent<Props extends Record<string, JsonValue>>(
  definition: ComponentDefinition<Props>,
): ComponentDefinition<Props> {
  return definition;
}

export function defineRegistry(input: {
  id: string;
  version: string;
  components: readonly ComponentDefinition[];
}): Registry {
  if (!input.id.trim()) throw new Error("Registry id is required");
  if (!input.version.trim()) throw new Error("Registry version is required");
  if (input.components.length === 0)
    throw new Error("Registry must contain at least one component");

  const byId = new Map<string, ComponentDefinition>();
  for (const component of input.components) {
    if (byId.has(component.id)) {
      throw new Error(`Duplicate component id: ${component.id}`);
    }
    byId.set(component.id, component);
  }

  for (const component of input.components) {
    for (const [slotName, slot] of Object.entries(component.slots ?? {})) {
      if (!slotName.trim())
        throw new Error(`Component ${component.id} has an empty slot name`);
      for (const acceptedId of slot.accepts ?? []) {
        if (!byId.has(acceptedId)) {
          throw new Error(
            `Component ${component.id} slot ${slotName} accepts unknown component ${acceptedId}`,
          );
        }
      }
    }
  }

  const fingerprint = fingerprintRegistry(input);

  return {
    id: input.id,
    version: input.version,
    fingerprint,
    components: [...input.components],
    get(componentId: string) {
      return byId.get(componentId);
    },
  };
}

export function fingerprintRegistry(input: {
  id: string;
  version: string;
  components: readonly ComponentDefinition[];
}): string {
  const serializable = {
    id: input.id,
    version: input.version,
    components: [...input.components]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((component) => ({
        id: component.id,
        version: component.version,
        description: component.description,
        propsSchema: component.props.jsonSchema,
        slots: component.slots ?? {},
        policy: component.policy ?? {},
        tags: [...(component.tags ?? [])].sort(),
      })),
  };

  return fnv1a(stableStringify(serializable));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
