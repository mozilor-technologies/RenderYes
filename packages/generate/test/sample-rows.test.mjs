import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStateFixtures,
  loadDataContractFromExport,
  sliceCapability,
  synthesizeSampleRows,
} from "../dist/index.js";
import { buildReviewExportBundle } from "./fixture.mjs";

function shoppingItemType() {
  const contract = loadDataContractFromExport(buildReviewExportBundle());
  return sliceCapability(contract, "pantry.items.list").dataType;
}

test("each semantic type gets a recognizable canned value", () => {
  const rows = synthesizeSampleRows({ dataType: shoppingItemType() });
  assert.equal(rows.length, 3);
  const [first] = rows;
  assert.equal(first.id, "x_1");
  assert.equal(first.name, "Item name 1");
  assert.equal(first.quantity, 120);
  assert.equal(typeof first.price, "number");
  assert.match(first.expiresOn, /^\d{4}-\d{2}-\d{2}$/);
  // Status honors the enum declared in the data type's JSON schema.
  assert.equal(first.status, "needed");
  assert.equal(rows[1].status, "low");
  assert.equal(typeof first.purchased, "boolean");
  assert.equal(rows[1].purchased, false);
});

test("dotted approved paths are restored to nested objects", () => {
  const rows = synthesizeSampleRows({ dataType: shoppingItemType() });
  assert.deepEqual(rows[0].nutrition, { calories: 120 });
  assert.ok(!("nutrition.calories" in rows[0]));
});

test("required output fields survive a narrowed field selection", () => {
  const rows = synthesizeSampleRows({
    dataType: shoppingItemType(),
    fieldPaths: ["name"],
    requiredOutputFields: ["id"],
  });
  assert.equal(rows[0].id, "x_1");
  assert.equal(rows[0].name, "Item name 1");
  assert.equal(rows[0].status, undefined);
});

test("state fixtures cover the four states with executor-shaped companions", () => {
  const rows = synthesizeSampleRows({ dataType: shoppingItemType() });
  const fixtures = buildStateFixtures({ rows, shape: "collection" });
  assert.deepEqual(
    fixtures.map((fixture) => fixture.name),
    ["ready", "empty", "error", "truncated"],
  );
  const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
  assert.equal(byName.get("ready").companions.state, "ready");
  assert.deepEqual(byName.get("empty").slotValue, []);
  assert.deepEqual(byName.get("error").companions.sources, []);
  assert.equal(
    byName.get("error").companions.errorMessage,
    "This data could not be loaded.",
  );
  const truncated = byName.get("truncated").companions.completeness;
  assert.equal(truncated.complete, false);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.rowCount, rows.length);
  assert.ok(truncated.totalRows > rows.length);
});

test("entity-shaped fixtures bind one record, not an array", () => {
  const rows = synthesizeSampleRows({ dataType: shoppingItemType(), rowCount: 1 });
  const fixtures = buildStateFixtures({ rows, shape: "entity" });
  const ready = fixtures.find((fixture) => fixture.name === "ready");
  assert.ok(!Array.isArray(ready.slotValue));
  assert.equal(ready.slotValue.id, "x_1");
});
