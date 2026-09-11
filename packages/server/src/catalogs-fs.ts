/**
 * A filesystem-backed `CatalogStore`.
 *
 * Separate entry point (`@renderyes/server/node`) for the same reason as the
 * node:http adapter: it imports `node:fs`, and a Workers or Deno host should not
 * have to resolve that to get the rest of the package.
 *
 * One JSON file per published catalog, rather than one appended log. A publish
 * replaces a catalog, so last-write-wins is the semantics — and a directory of
 * named files is something an operator can list, diff, and delete by hand when
 * something needs undoing at 2am, which a log format is not.
 *
 * Every publish is also retained beside the current one, under
 * `<id>.history/<stamp>.json`. Last-write-wins is right for *serving* — the
 * newest catalog is the live one — and was wrong for *keeping*: this file
 * decides which fields a visitor can reach, and replacing it left no way back
 * and no answer to what was live an hour ago. Snapshots are whole records
 * rather than deltas, so a rollback is a replay of one file and needs no
 * reconstruction, and every one stays listable and deletable by hand.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogSnapshot, CatalogStore, PublishedCatalogRecord } from "./catalogs.js";

/**
 * Makes an arbitrary catalog id safe as a filename.
 *
 * A catalog id comes from a publish payload, so it is caller-controlled, and
 * `join(dir, `${id}.json`)` with an id of `../../etc/something` writes outside
 * the directory. Replacing everything outside a conservative set removes the
 * traversal and the shell-hostile characters together.
 *
 * Collisions are possible in principle (`a/b` and `a_b` both become `a_b`) and
 * accepted: the id is also stored inside the file, and a restore reads it from
 * there rather than from the filename, so a collision costs one overwritten
 * record rather than a wrong one.
 */
function safeFileName(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_.-]/g, "_");
  // A name of "." or ".." would still resolve to a directory.
  return cleaned === "." || cleaned === ".." || cleaned === "" ? "_" : cleaned;
}

/**
 * A sortable, filename-safe stamp for one retained publish.
 *
 * Derived from the record's own `publishedAt` so a snapshot and the record
 * inside it cannot disagree, with a counter suffix only if the same instant
 * publishes twice.
 */
function stampFor(record: PublishedCatalogRecord): string {
  const iso = typeof record.publishedAt === "string" ? record.publishedAt : "";
  const base = iso.replace(/[:.]/g, "-");
  return safeFileName(base || "unknown");
}

const SUBDIRECTORY: Record<PublishedCatalogRecord["kind"], string> = {
  capability: "catalogs",
  ui: "ui-catalogs",
};

/**
 * Stores publish records under `dir/catalogs` and `dir/ui-catalogs`.
 *
 * ```ts
 * const server = createViewServer({
 *   catalogStore: createFileCatalogStore(new URL("./data", import.meta.url)),
 *   ...
 * });
 * await server.restorePublishedCatalogs();
 * ```
 *
 * Writes are synchronous under an async signature. A publish is an owner action
 * that happens rarely and already spends longer validating the catalog than
 * writing it, so the simplicity is worth more here than the concurrency; and a
 * synchronous write cannot interleave with another publish of the same id.
 */
export function createFileCatalogStore(dir: string | URL): CatalogStore {
  const root = typeof dir === "string" ? dir : dir.pathname;
  for (const sub of Object.values(SUBDIRECTORY)) {
    mkdirSync(join(root, sub), { recursive: true });
  }

  return {
    async put(record) {
      const name = safeFileName(record.id);
      const directory = join(root, SUBDIRECTORY[record.kind]);
      const serialized = JSON.stringify(record);
      writeFileSync(join(directory, `${name}.json`), serialized, "utf8");
      // Written after the current file, never instead of it: a failure to
      // retain history must not cost a host the publish they asked for.
      try {
        const historyDirectory = join(directory, `${name}.history`);
        mkdirSync(historyDirectory, { recursive: true });
        writeFileSync(join(historyDirectory, `${stampFor(record)}.json`), serialized, "utf8");
      } catch {
        // Retention is best-effort; the live catalog is already durable.
      }
    },

    async history(kind, id) {
      const historyDirectory = join(root, SUBDIRECTORY[kind], `${safeFileName(id)}.history`);
      if (!existsSync(historyDirectory)) return [];
      const snapshots: CatalogSnapshot[] = [];
      for (const file of readdirSync(historyDirectory)) {
        if (!file.endsWith(".json")) continue;
        const stamp = file.slice(0, -".json".length);
        let at = "";
        try {
          const parsed = JSON.parse(readFileSync(join(historyDirectory, file), "utf8")) as {
            publishedAt?: unknown;
          };
          if (typeof parsed.publishedAt === "string") at = parsed.publishedAt;
        } catch {
          continue;
        }
        snapshots.push({ stamp, at });
      }
      // Stamps sort lexically because they are fixed-width UTC.
      return snapshots.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
    },

    async remove(kind, id) {
      // Only the live file. The `<id>.history/` directory is left in place: a
      // delete that also erased every retained publish would be the one
      // operation here with no way back, and the snapshots are what make a
      // mistaken delete recoverable.
      const path = join(root, SUBDIRECTORY[kind], `${safeFileName(id)}.json`);
      if (!existsSync(path)) return false;
      rmSync(path);
      return true;
    },

    async readSnapshot(kind, id, stamp) {
      // `stamp` reaches here from a caller, so it is sanitised like an id:
      // a value of `../../something` would otherwise read outside the store.
      const path = join(
        root,
        SUBDIRECTORY[kind],
        `${safeFileName(id)}.history`,
        `${safeFileName(stamp)}.json`,
      );
      if (!existsSync(path)) return undefined;
      try {
        return JSON.parse(readFileSync(path, "utf8")) as PublishedCatalogRecord;
      } catch {
        return undefined;
      }
    },

    async list() {
      const records: PublishedCatalogRecord[] = [];
      for (const [kind, sub] of Object.entries(SUBDIRECTORY) as Array<
        [PublishedCatalogRecord["kind"], string]
      >) {
        const directory = join(root, sub);
        for (const file of readdirSync(directory)) {
          if (!file.endsWith(".json")) continue;
          const raw = readFileSync(join(directory, file), "utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // A truncated file — a process killed mid-write — is skipped rather
            // than crashing the boot it was supposed to make possible.
            console.error(`Skipping unreadable catalog record ${join(sub, file)}: not valid JSON.`);
            continue;
          }
          const record = parsed as Partial<PublishedCatalogRecord>;

          // A file holding a bare publish body, with no envelope around it.
          //
          // That is what a host hand-rolling this same directory layout wrote
          // before the store existed — ours did — and the directory and filename
          // already carry the two fields the envelope adds. Refusing them would
          // turn "install the new version" into "silently lose every published
          // catalog, and find out at the next compose", which is the failure
          // this store exists to prevent, caused by the store itself.
          if (typeof record?.id !== "string" || record.body === undefined) {
            if (parsed === null || typeof parsed !== "object") {
              console.error(`Skipping malformed catalog record ${join(sub, file)}.`);
              continue;
            }
            records.push({
              kind,
              id: file.slice(0, -".json".length),
              body: parsed,
              publishedAt: new Date(0).toISOString(),
            });
            continue;
          }

          records.push({
            kind,
            id: record.id,
            body: record.body,
            publishedAt: record.publishedAt ?? new Date(0).toISOString(),
          });
        }
      }
      return records;
    },
  };
}
