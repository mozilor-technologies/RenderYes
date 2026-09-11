import type { SiteManifest } from "./index.js";
import { defineSiteFromManifest, type RegisteredSite } from "./index.js";

/**
 * The UI-catalog counterpart to `@renderyes/data-runtime`'s
 * `createCapabilityCatalogStore`. Before this existed, a `RegisteredSite`
 * only ever came from a hard-coded module constant built at import time — a
 * host's own component registration had no route into the runtime, the exact
 * gap the capability-catalog registry closed for data.
 *
 * Deliberately in-memory. Durable storage is a host concern; this interface
 * is the seam for it.
 */

export interface RegisteredSiteEntry {
  siteId: string;
  /**
   * The capability catalog this UI catalog renders, and the key it is filed
   * under. Defaults to `siteId`, which is what it always silently was.
   */
  catalogId: string;
  version: string;
  registrationFingerprint: string;
  site: RegisteredSite;
  publishedAt: string;
}

export interface PublishSiteInput {
  /** Typically the exact payload a host's `@renderyes/react` install POSTs. */
  manifest: SiteManifest;
  /**
   * Which capability catalog this UI catalog belongs to.
   *
   * Every consumer looks a UI catalog up by capability catalog id, while this
   * store filed it under the site id — so the two had to be the same string
   * and nothing said so. A host naming the site `<catalog>-ui`, the obvious
   * name, published successfully and failed at compose, from a message naming
   * a catalog that existed.
   *
   * Defaults to the site id, so an existing host is unaffected. Supplying it
   * turns the convention into a declaration and lets a site be named freely.
   */
  catalogId?: string;
  now?: () => Date;
}

export interface SiteCatalogStore {
  publish(input: PublishSiteInput): RegisteredSiteEntry;
  get(siteId: string): RegisteredSiteEntry | undefined;
  list(): RegisteredSiteEntry[];
  /** Unregisters a site. Returns false when nothing was filed under that id. */
  remove(siteId: string): boolean;
}

export function createSiteCatalogStore(): SiteCatalogStore {
  const byId = new Map<string, RegisteredSiteEntry>();

  return {
    publish(input: PublishSiteInput): RegisteredSiteEntry {
      // The manifest is untrusted input exactly like a published capability
      // catalog: reconstruct and validate rather than trust the wire payload.
      const site = defineSiteFromManifest(input.manifest);

      const entry: RegisteredSiteEntry = {
        siteId: site.id,
        catalogId: input.catalogId ?? site.id,
        version: site.version,
        registrationFingerprint: site.registrationFingerprint,
        site,
        publishedAt: (input.now ?? (() => new Date()))().toISOString(),
      };

      // Filed under the capability catalog id, because that is what every
      // lookup uses. Republishing the same catalog replaces it — that is how a
      // host ships a new component set, so a collision here is an update and
      // not a conflict.
      byId.set(entry.catalogId, entry);
      return entry;
    },

    /** Takes the *capability* catalog id. See `PublishSiteInput.catalogId`. */
    get(catalogId: string): RegisteredSiteEntry | undefined {
      return byId.get(catalogId);
    },

    remove(siteId: string): boolean {
      return byId.delete(siteId);
    },

    list(): RegisteredSiteEntry[] {
      return [...byId.values()];
    },
  };
}
