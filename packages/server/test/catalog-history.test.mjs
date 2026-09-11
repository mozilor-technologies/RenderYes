import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCatalogStore } from "../dist/node.js";

/**
 * A publish replaced the catalog in place, so the previous one was gone: no
 * rollback, and no answer to "what was live an hour ago" for the artifact that
 * decides which fields a visitor can reach. Whole snapshots rather than
 * deltas, so recovery is a replay of one file.
 */
test("a replaced catalog is still recoverable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-hist-"));
  try {
    const store = createFileCatalogStore(dir);
    await store.put({ kind: "capability", id: "shop", body: { v: 1 }, publishedAt: "2026-08-25T10:00:00.000Z" });
    await store.put({ kind: "capability", id: "shop", body: { v: 2 }, publishedAt: "2026-08-25T11:00:00.000Z" });

    const live = await store.list();
    assert.deepEqual(live.find((r) => r.id === "shop").body, { v: 2 }, "newest serves");

    const history = await store.history("capability", "shop");
    assert.equal(history.length, 2, "both publishes retained");
    assert.ok(history[0].stamp > history[1].stamp, "newest first");

    const prior = await store.readSnapshot("capability", "shop", history[1].stamp);
    assert.deepEqual(prior.body, { v: 1 }, "the replaced catalog is readable and replayable");

    // Traversal is refused rather than resolved.
    assert.equal(await store.readSnapshot("capability", "shop", "../../etc/passwd"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
