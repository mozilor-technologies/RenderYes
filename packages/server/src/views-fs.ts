/**
 * A filesystem-backed `ViewStore`.
 *
 * Exists because the memory store's caveat was being read as fine print: a
 * host wires `viewStore: createMemoryViewStore()`, the workspace invites
 * visitors to Save and Pin, and the next deploy deletes everything they kept.
 * The catalog already survives restarts through `createFileCatalogStore`; a
 * feature that ASKS the visitor to keep something must not be the half that
 * forgets. Found live on one production install: three saved views, one
 * gateway restart, "Nothing saved yet".
 *
 * Same entry point (`@renderyes/server/node`) and same shape as the catalog
 * store: one JSON file per saved view, listable and deletable by hand. A
 * multi-process or multi-node host still wants a database-backed
 * implementation; this covers the single-process host, which is every host
 * the memory store was silently failing.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SavedView, ViewStore } from "./views.js";

/**
 * Makes a view id safe as a filename. Ids are generated server-side today,
 * but the store's contract does not promise that, and
 * `join(dir, `${id}.json`)` with an id of `../../etc/x` writes outside the
 * directory. Same conservative set as the catalog store; the id inside the
 * file is authoritative, so a collision costs one overwritten record, never a
 * wrong one.
 */
function safeFileName(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return cleaned === "." || cleaned === ".." || cleaned === "" ? "_" : cleaned;
}

/**
 * Stores one saved view per file under `dir/views`.
 *
 * ```ts
 * const server = createViewServer({
 *   viewStore: createFileViewStore("./data"),
 *   resolveViewOwner: (session) => session.visitorId,
 *   ...
 * });
 * ```
 *
 * Reads go to disk on every call rather than through a warm cache: a saved
 * view is touched when a visitor opens their list, not per compose, and a
 * store an operator can edit by hand is only trustworthy if the process
 * actually reads what is on disk. The ownership rule is the interface's:
 * every read compares `ownerKey` and reports a mismatch as absent, never as
 * forbidden — distinguishing the two would tell a caller the id exists.
 */
export function createFileViewStore(dir: string | URL): ViewStore {
  const root = join(typeof dir === "string" ? dir : dir.pathname, "views");
  mkdirSync(root, { recursive: true });

  function readView(fileName: string): SavedView | undefined {
    try {
      const parsed = JSON.parse(
        readFileSync(join(root, fileName), "utf8"),
      ) as SavedView;
      return parsed && typeof parsed.id === "string" ? parsed : undefined;
    } catch {
      // A truncated or hand-mangled file loses that one view, not the store.
      return undefined;
    }
  }

  return {
    async save(view) {
      writeFileSync(
        join(root, `${safeFileName(view.id)}.json`),
        `${JSON.stringify(view, null, 2)}\n`,
      );
    },
    async get(id, ownerKey) {
      const found = readView(`${safeFileName(id)}.json`);
      if (!found || found.id !== id || found.ownerKey !== ownerKey) return undefined;
      return found;
    },
    async list(ownerKey) {
      return readdirSync(root)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readView(name))
        .filter((view): view is SavedView => view !== undefined)
        .filter((view) => view.ownerKey === ownerKey)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async delete(id, ownerKey) {
      const found = readView(`${safeFileName(id)}.json`);
      if (!found || found.id !== id || found.ownerKey !== ownerKey) return false;
      rmSync(join(root, `${safeFileName(id)}.json`), { force: true });
      return true;
    },
  };
}
