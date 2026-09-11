import { describe, expect, it } from "vitest";
import { RESULT_SHAPES } from "@renderyes/site-sdk";
import type { ComponentDataAcceptance } from "@renderyes/site-sdk";
import {
  createCardGrid,
  createDataTable,
  createDetailPanel,
  createItemList,
  createMetricCard,
  createRecordWithLines,
} from "../src/index.js";
import { createBarChart, createDonutChart, createLineChart } from "../src/charts.js";

/**
 * Every result shape a catalog can declare is renderable by something here, or
 * declared unrenderable on purpose.
 *
 * The route contract's invariant again, at the shape layer. It exists because
 * `metric` sat in this enum for months while `inferResultShape` never returned
 * it, so `StarterMetricCard` could not be selected for anything a GraphQL schema
 * offered — a shipped component with no path to it, and nothing failing.
 *
 * Two halves, and both matter. A shape nothing produces is dead inference; a
 * shape nothing renders is a dead component. This file covers the second.
 */

const FACTORIES = [
  createDataTable,
  createMetricCard,
  createDetailPanel,
  createRecordWithLines,
  createCardGrid,
  createItemList,
  createBarChart,
  createLineChart,
  createDonutChart,
];

/**
 * Shapes with no starter renderer, on purpose.
 *
 * These four are vocabulary the schema admits and nothing in this repo produces
 * or consumes: `inferResultShape` never returns them, no OpenAPI path emits
 * them, and they never reach the planner contract, so they cost nothing today.
 * Listed rather than trimmed from the enum, because removing a member of a
 * published schema is a format change and these describe real presentations a
 * host may want to declare for its own components.
 */
const UNRENDERED_SHAPES: readonly string[] = Object.freeze([
  "hierarchy",
  "document",
  "media-collection",
  "comparison",
]);

function acceptedShapes(): Set<string> {
  const shapes = new Set<string>();
  for (const factory of FACTORIES) {
    const slots = factory().definition.dataSlots;
    for (const slot of Object.values(slots)) {
      for (const acceptance of slot.accepts as readonly ComponentDataAcceptance[]) {
        if ("shapes" in acceptance) {
          for (const shape of acceptance.shapes) shapes.add(shape);
        } else if ("shape" in acceptance) {
          shapes.add(acceptance.shape);
        }
      }
    }
  }
  return shapes;
}

describe("result shape reachability", () => {
  it("renders every declarable shape or declares it unrendered", () => {
    const rendered = acceptedShapes();
    const missing = RESULT_SHAPES.filter(
      (shape) => !rendered.has(shape) && !UNRENDERED_SHAPES.includes(shape),
    );

    expect(missing).toEqual([]);
  });

  it("declares nothing unrendered that a component actually accepts", () => {
    // The list drifting the other way: a shape gains a renderer and stays
    // listed, so the list stops describing the catalog.
    const rendered = acceptedShapes();
    expect(UNRENDERED_SHAPES.filter((shape) => rendered.has(shape))).toEqual([]);
  });

  it("declares nothing unrendered that is not a real shape", () => {
    const declarable = new Set<string>(RESULT_SHAPES);
    expect(UNRENDERED_SHAPES.filter((shape) => !declarable.has(shape))).toEqual([]);
  });
});
