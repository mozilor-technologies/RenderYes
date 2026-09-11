/**
 * Durable storage for what has been published.
 *
 * The registries inside `createViewServer` are in-memory and have to be: a
 * published capability holds a live executor closure, and a published component
 * holds a renderer id bound to a compiled surface. Those are not serializable,
 * so "persist the catalog" cannot mean persisting the registry.
 *
 * What *is* persistable is the publish input — the exact body that
 * `publishReviewedCatalog` or `publishUiCatalog` was called with. Replaying it
 * at boot is the same function with the same argument, so the restored state is
 * correct by construction rather than by a second implementation that has to be
 * kept in step.
 *
 * This used to be the host's job, and the note in `views.ts` said so. That was
 * wrong in the way that only shows up once: the registries are silently empty
 * after a restart, `/api/compose` fails with "no published catalog" for every
 * visitor, and nothing logs a cause — so the host looks broken rather than
 * un-restored. Every host that keeps its catalog across a restart writes this,
 * and each writes the "replay the input, not the state" insight for themselves
 * or gets it wrong.
 */

/**
 * One publish call, kept so it can be replayed.
 *
 * `body` is stored verbatim and never interpreted here. It is validated on the
 * way in by the publish function itself, and re-validated identically on replay
 * — so a stored body that has become invalid (a catalog referencing a field the
 * schema no longer has) fails at boot with the real reason rather than
 * corrupting a registry.
 */
export interface PublishedCatalogRecord {
  /**
   * Which registry this belongs to. `capability` replays through
   * `publishReviewedCatalog`, `ui` through `publishUiCatalog`.
   */
  kind: "capability" | "ui";
  /**
   * The id this record is filed under, so a later publish of the same catalog
   * replaces it rather than accumulating.
   *
   * For `capability` this is `body.catalog.id`. For `ui` it is
   * `body.manifest.site.id` — the key the UI registry itself uses, which is not
   * necessarily `body.manifest.catalog.id`. Filing under the registry's own key
   * means a restore lands where a lookup will look for it, regardless of whether
   * those two ids are ever made to agree.
   */
  id: string;
  /** The publish body, verbatim. */
  body: unknown;
  /** When this was published, ISO 8601. Informational. */
  publishedAt: string;
}

/** One retained publish of a catalog, newest first in `history`. */
export interface CatalogSnapshot {
  /** Sortable UTC stamp, and the handle `readSnapshot` takes. */
  stamp: string;
  /** When it was written, ISO-8601. */
  at: string;
}

export interface CatalogStore {
  /** Records one publish, replacing any earlier record with the same kind and id. */
  put(record: PublishedCatalogRecord): Promise<void>;
  /**
   * Prior publishes of one catalog, newest first.
   *
   * Optional so a custom store stays valid without it — a store that cannot
   * retain history reports none rather than failing. The filesystem store
   * retains every publish, because the artifact it holds decides what data a
   * visitor can reach and a replaced one had no way back.
   */
  history?(kind: PublishedCatalogRecord["kind"], id: string): Promise<CatalogSnapshot[]>;
  /** One retained publish, verbatim, replayable exactly as boot replay does. */
  readSnapshot?(
    kind: PublishedCatalogRecord["kind"],
    id: string,
    stamp: string,
  ): Promise<PublishedCatalogRecord | undefined>;
  /**
   * Forgets one catalog, so it does not come back at the next boot.
   *
   * Optional for the same reason as `history`: a store that cannot remove says
   * so rather than failing to load. Without it, unpublishing was impossible —
   * a catalog published by mistake survived every restart, and the only remedy
   * was editing the store's files by hand.
   *
   * Retained snapshots are left alone. Removing a catalog is not the same as
   * destroying the record of what it was, and a delete that also erased the
   * history would make itself the one unreversible operation here.
   */
  remove?(kind: PublishedCatalogRecord["kind"], id: string): Promise<boolean>;
  /**
   * Every record, for boot replay.
   *
   * Order is not significant: the two registries are independent, and within a
   * registry each id is distinct.
   */
  list(): Promise<PublishedCatalogRecord[]>;
}

/** What a boot replay did, so a host can log it rather than guess. */
export interface RestoreSummary {
  capabilityCatalogs: number;
  uiCatalogs: number;
  /**
   * Records that failed to replay, with the reason.
   *
   * Reported rather than thrown. One unpublishable catalog should not stop the
   * process from starting and serving the others — but it must not be silent
   * either, because the visible symptom ("that capability isn't available") says
   * nothing about a stored body that no longer validates.
   */
  failures: Array<{ kind: "capability" | "ui"; id: string; reason: string }>;
}

/**
 * Process-local `CatalogStore`. Lost on restart, which makes it pointless for
 * the job this interface exists for — it is here so tests can exercise the
 * write-through and replay paths without touching a filesystem.
 */
export function createMemoryCatalogStore(): CatalogStore {
  const records = new Map<string, PublishedCatalogRecord>();
  return {
    async put(record) {
      records.set(`${record.kind}:${record.id}`, { ...record });
    },
    async list() {
      return [...records.values()].map((record) => ({ ...record }));
    },
  };
}
