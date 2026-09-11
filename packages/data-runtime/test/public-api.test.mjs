import assert from "node:assert/strict";
import test from "node:test";
import * as dataRuntime from "@renderyes/data-runtime";

test("exports the deterministic executor from the package root", () => {
  assert.equal(typeof dataRuntime.createDataPlanningContract, "function");
  assert.equal(typeof dataRuntime.executeDataRequest, "function");
  assert.equal(typeof dataRuntime.executePlanDataRequests, "function");
  assert.equal(typeof dataRuntime.executePlanData, "function");
  assert.equal(typeof dataRuntime.composeExecutedData, "function");
  assert.equal(typeof dataRuntime.joinExecutedData, "function");
  assert.equal(typeof dataRuntime.validateDataRequestQuery, "function");
});
