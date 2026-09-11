import type { PlanV3_1 } from "@renderyes/core";

/**
 * A composed view a visitor chose to keep.
 *
 * Stores the `Plan`, not the rendered messages. A plan is the durable
 * artifact: replaying it re-fetches current data through the same approved
 * capabilities, so reopening a saved view shows today's numbers rather than a
 * snapshot of whatever was on screen when it was saved. It also means a saved
 * view carries no fetched customer data at rest — only the shape of the
 * request that produced it.
 */
export interface SavedView {
  id: string;
  /** Which published capability catalog this plan was composed against. */
  catalogId: string;
  surfaceId: string;
  /**
   * Opaque owner key, derived by the host from the session — see
   * `ViewServerConfig.resolveViewOwner`. Every read is filtered by it, so one
   * visitor's saved view id is useless to another.
   */
  ownerKey: string;
  /** The prompt that produced the plan, kept so a list can be labelled. */
  prompt: string;
  /** Visitor-supplied name, when they gave one. */
  label?: string;
  plan: PlanV3_1;
  createdAt: string;
  updatedAt: string;
  /**
   * Hash of the catalog the plan was composed against. A catalog can change
   * after a view is saved — a capability withdrawn, a field removed — which
   * can make a stored plan unreplayable. Keeping the hash lets a reopen detect
   * drift instead of failing with a confusing runtime error.
   */
  catalogHash: string;
  /**
   * Fingerprint of the host's component registrations at save time.
   *
   * The catalog hash covers the *data* half of a plan and nothing else, so a
   * view whose component was renamed or whose slot acceptance narrowed listed
   * as perfectly fresh and then threw on reopen — the plan named a component
   * the published site no longer had. Both halves of a plan can drift
   * independently, so both are recorded.
   *
   * Optional because views saved before this existed have no value for it. A
   * missing fingerprint means "unknown", which is reported as stale: it cannot
   * be shown to still match, and claiming freshness on no evidence is the wrong
   * direction to fail.
   */
  siteFingerprint?: string;
  /**
   * The planId of the full composed plan this view was sliced from, set only
   * when the view is a pin (`saveComposedView` with `nodeIds`).
   *
   * Provenance, not behaviour: nothing on the replay path reads it — a pin
   * reopens exactly like any other saved view. It is recorded because a pin's
   * stored plan is one the server derived rather than one the model produced,
   * and when a host is staring at a saved plan wondering why it has one node
   * and two requests, "sliced from plan X" is the difference between a
   * ten-second answer and an incident. Optional because every view saved
   * before pins existed — and every non-pin save after — has no value for it.
   */
  pinnedFromPlanId?: string;
  /**
   * The A2UI catalog id this plan was composed against.
   *
   * Recorded because reopen used to recompute `${catalogId}:ui`, which is only
   * correct for a host that never set `uiCatalogId`. One that did got a working
   * compose and an empty surface every time they came back to a saved view,
   * with nothing logged — the component registrations were filed under a
   * different id than the reopen named.
   *
   * Optional because views saved before this existed have no value for it;
   * those fall back to the derived default, which is what they were reopened
   * with anyway.
   */
  uiCatalogId?: string;
}

/**
 * Durable storage for saved views.
 *
 * Deliberately narrow and fully async so a host can back it with anything —
 * Postgres, Redis, DynamoDB, a file. The default is in-memory and therefore
 * per-process: fine for development, wrong for anything a visitor expects to
 * come back to.
 *
 * Published catalogs have their own store (`CatalogStore` in `catalogs.ts`)
 * rather than sharing this one, because what is persisted is different in kind:
 * a saved view *is* data, while a published catalog holds live runtime closures
 * that cannot be serialized, so persisting it means recording the publish input
 * and replaying it at boot. Two mechanisms, deliberately not merged.
 *
 * This comment used to say that replay "belongs to the host". It did, and that
 * was the wrong call: every host wrote it, ours included, and getting it wrong
 * looks like an empty registry after a restart with nothing logged.
 */
export interface ViewStore {
  save(view: SavedView): Promise<void>;
  /**
   * Reads one view. Implementations MUST compare `ownerKey` and return
   * undefined on a mismatch rather than returning another owner's view — the
   * id alone is not an authorisation.
   */
  get(id: string, ownerKey: string): Promise<SavedView | undefined>;
  list(ownerKey: string): Promise<SavedView[]>;
  /** Returns true when a view was actually removed for this owner. */
  delete(id: string, ownerKey: string): Promise<boolean>;
}

/**
 * Process-local `ViewStore`. Everything is lost on restart, and nothing is
 * shared between instances — a host running more than one process needs a real
 * implementation. Exists so the save/reopen path is exercisable end to end
 * without standing up a database first.
 */
export function createMemoryViewStore(): ViewStore {
  const byId = new Map<string, SavedView>();

  return {
    async save(view) {
      byId.set(view.id, { ...view });
    },
    async get(id, ownerKey) {
      const found = byId.get(id);
      // An id belonging to someone else is reported as absent, not as
      // forbidden: distinguishing the two tells a caller that an id exists.
      if (!found || found.ownerKey !== ownerKey) return undefined;
      return { ...found };
    },
    async list(ownerKey) {
      return [...byId.values()]
        .filter((view) => view.ownerKey === ownerKey)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((view) => ({ ...view }));
    },
    async delete(id, ownerKey) {
      const found = byId.get(id);
      if (!found || found.ownerKey !== ownerKey) return false;
      return byId.delete(id);
    },
  };
}
