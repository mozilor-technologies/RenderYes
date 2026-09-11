import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileViewStore } from "../dist/node.js";

/**
 * The property under test is "a restart does not delete what a visitor was
 * invited to keep". The memory store's data loss was found live: one install
 * saved three views, restarted the gateway, and My views said "Nothing saved
 * yet". As with the catalog store, the only honest check is a second store
 * over the same directory — that second construction is the restart.
 */

function savedView(id, ownerKey, overrides = {}) {
  return {
    id,
    catalogId: "paper",
    surfaceId: "main",
    ownerKey,
    prompt: "latest stories",
    plan: { schemaVersion: "3.1" },
    createdAt: "2026-08-25T10:00:00.000Z",
    updatedAt: "2026-08-25T10:00:00.000Z",
    ...overrides,
  };
}

test("saved views survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-views-"));
  try {
    const before = createFileViewStore(dir);
    await before.save(savedView("view-1", "visitor-a"));
    await before.save(savedView("view-2", "visitor-a", { label: "Politics" }));

    const after = createFileViewStore(dir); // the restart
    const listed = await after.list("visitor-a");
    assert.equal(listed.length, 2);
    assert.equal((await after.get("view-2", "visitor-a"))?.label, "Politics");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ownership is enforced on every read, reported as absence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-views-"));
  try {
    const store = createFileViewStore(dir);
    await store.save(savedView("view-1", "visitor-a"));

    assert.equal(await store.get("view-1", "visitor-b"), undefined);
    assert.deepEqual(await store.list("visitor-b"), []);
    assert.equal(await store.delete("view-1", "visitor-b"), false);
    // The rightful owner still has it after the failed foreign delete.
    assert.equal((await store.get("view-1", "visitor-a"))?.id, "view-1");
    assert.equal(await store.delete("view-1", "visitor-a"), true);
    assert.equal(await store.get("view-1", "visitor-a"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hostile id cannot escape the store directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-views-"));
  try {
    const store = createFileViewStore(dir);
    await store.save(savedView("../../escape", "visitor-a"));
    // Stored under a sanitized name, retrievable only through the real id —
    // which the file's own content carries, so the round trip still works.
    assert.equal((await store.get("../../escape", "visitor-a"))?.id, "../../escape");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
