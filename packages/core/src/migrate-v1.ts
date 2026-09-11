import type { Plan, SurfaceNode } from "./plan.js";
import type { Registry } from "./registry.js";
import { assertValidPlan } from "./validate.js";

export interface V1LayoutNode {
  nodeId: string;
  componentId: string;
  props: Record<string, unknown>;
  children?: V1LayoutNode[];
}

export interface V1StructuredLayout {
  schemaVersion: "1.0";
  layoutId: string;
  generatedAt: string;
  sourcePrompt?: string;
  regions: Array<{ id: string; nodes: V1LayoutNode[] }>;
  meta: { providerId: string; modelId: string };
}

export interface MigrateV1Options {
  siteId: string;
  childSlotByComponent?: Record<string, string>;
}

export function migrateV1Layout(
  v1: V1StructuredLayout,
  registry: Registry,
  options: MigrateV1Options,
): Plan {
  const plan: Plan = {
    schemaVersion: "3.0",
    planId: v1.layoutId,
    siteId: options.siteId,
    sourcePrompt: v1.sourcePrompt,
    catalog: {
      id: registry.id,
      version: registry.version,
      fingerprint: registry.fingerprint,
    },
    surfaces: v1.regions.map((region) => ({
      id: region.id,
      nodes: region.nodes.map(convertNode),
    })),
    generation: {
      providerId: v1.meta.providerId,
      modelId: v1.meta.modelId,
      createdAt: v1.generatedAt,
      repairCount: 0,
    },
  };

  return assertValidPlan(plan, registry);

  function convertNode(node: V1LayoutNode): SurfaceNode {
    const children = node.children ?? [];
    if (children.length === 0) {
      return {
        nodeId: node.nodeId,
        componentId: node.componentId,
        props: node.props as SurfaceNode["props"],
      };
    }

    const definition = registry.get(node.componentId);
    const declaredSlots = Object.keys(definition?.slots ?? {});
    const slotName =
      options.childSlotByComponent?.[node.componentId] ??
      (declaredSlots.length === 1 ? declaredSlots[0] : undefined);

    if (!slotName) {
      throw new Error(
        `Cannot migrate children of ${node.componentId}: v1 flattened slots and v3 needs an explicit slot mapping`,
      );
    }

    return {
      nodeId: node.nodeId,
      componentId: node.componentId,
      props: node.props as SurfaceNode["props"],
      slots: { [slotName]: children.map(convertNode) },
    };
  }
}
