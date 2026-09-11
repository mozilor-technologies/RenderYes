/**
 * Tools for keeping a decisions file alive across format and schema changes.
 *
 * A decisions file is the durable record of a host's review — and it has been
 * cheaper to discard than to keep. When this package changed path semantics,
 * every existing decisions silently stopped compiling, and the only remedy was
 * repeating every click in the review UI against a live schema. Four such
 * changes landed in one branch. The functions here make the artifact
 * upgradeable and inspectable instead:
 *
 *  - `migrateGraphQlDecisions` performs the mechanical upgrades and reports
 *    each rewrite it made, so the migration itself is auditable.
 *  - `diffGraphQlDecisions` compares a decisions file against a current review
 *    inventory and says what a human actually needs to know: which approved
 *    fields no longer exist, which available fields are unapproved, and which
 *    approved fields will fail compilation without a semantic-type decision.
 *
 * `compileApprovedGraphQlCatalog` deliberately does NOT call the migration:
 * a compile that mutates its input is how format changes stop being visible
 * at all. The old shape fails compilation; the failure names this function.
 */

import type {
  GraphQlCatalogDecisions,
  GraphQlCatalogInventory,
} from "./graphql.js";

/** One mechanical rewrite `migrateGraphQlDecisions` performed. */
export interface DecisionsMigrationChange {
  capabilityId: string;
  path: string;
  /** What the entry became. */
  migratedTo: string;
  reason: string;
}

export interface DecisionsMigrationResult {
  decisions: GraphQlCatalogDecisions;
  /** Every rewrite performed, so the migration is reviewable like any diff. */
  changed: DecisionsMigrationChange[];
}

/**
 * The transport prefix the pre-connection format carried on every field of a
 * Relay list. Paths became row-relative when connections started being read
 * as the collections they represent; the version literal did not change when
 * the semantics did, so detection is structural rather than by version.
 */
const CONNECTION_PREFIX = "edges.node.";

export function migrateGraphQlDecisions(
  decisions: GraphQlCatalogDecisions,
): DecisionsMigrationResult {
  const changed: DecisionsMigrationChange[] = [];

  const migratePath = (capabilityId: string, path: string): string => {
    if (!path.startsWith(CONNECTION_PREFIX)) return path;
    const migrated = path.slice(CONNECTION_PREFIX.length);
    changed.push({
      capabilityId,
      path,
      migratedTo: migrated,
      reason:
        "connection fields are addressed row-relative; the edges.node transport " +
        "wrapper is reapplied at compile and no longer part of the decisions",
    });
    return migrated;
  };

  const queries = decisions.queries.map((query) => ({
    ...query,
    approvedOutputFields: query.approvedOutputFields.map((path) =>
      migratePath(query.capabilityId, path),
    ),
    requiredOutputFields: query.requiredOutputFields.map((path) =>
      migratePath(query.capabilityId, path),
    ),
  }));

  // `maximumPageSize` and `catalogId` deliberately get no migration entries:
  // both default correctly when absent (100, and the site id respectively),
  // so absence is a working configuration rather than a gap. Semantic-type
  // overrides are not invented here — they are decisions, and the diff below
  // reports where one is needed.
  return { decisions: { ...decisions, queries }, changed };
}

/** One capability's differences between a decisions file and the current inventory. */
export interface CapabilityDecisionsDiff {
  capabilityId: string;
  /**
   * Approved paths the schema no longer offers. Compilation will refuse
   * these; they have to be removed or the upstream regression fixed.
   */
  missingFromSchema: string[];
  /**
   * Paths the schema offers that the decisions does not cover, with the
   * semantic type discovery inferred. This is what silent under-decisions
   * looks like from the other side — the list a host never had.
   */
  unapproved: { path: string; semanticType: string }[];
  /**
   * Approved paths whose semantic type is unknown and undecided. Compilation
   * will raise `GraphQlSemanticTypeError` for exactly these; reporting them
   * here moves the decision before the failure. The key is what
   * `decisions.semanticTypeOverrides` takes.
   */
  needsSemanticType: { path: string; overrideKey: string; type: string }[];
}

/**
 * Whether these decisions are still bound to this inventory, and whether that
 * matters.
 *
 * `reviewSourceHash` covers the inventory's options, not just the schema — so
 * supplying a scalar mapping, narrowing `--queries`, or changing `--depth`
 * re-hashes an inventory whose schema is byte-identical, and the decisions file
 * stops compiling against it. `diff` used to report none of this: it compared
 * fields, found nothing wrong, and said "nothing to decide" while `compile`
 * refused the same pair. The compile error told the host to run `diff`, so the
 * two diagnostics sent each other in a circle.
 *
 * `affected` is the distinction worth having. A stale binding where every
 * decided field and argument still exists is a bookkeeping problem — nothing
 * the host chose has changed, and `rebindGraphQlDecisions` re-stamps it. A
 * stale binding that touches a decision is a review, and no tool should stamp
 * past it.
 */
export interface DecisionsBinding {
  bound: boolean;
  /** The hash the decisions carry, and the one this inventory has. */
  decisionsHash: string;
  inventoryHash: string;
  /**
   * True when something the decisions file actually decided is no longer
   * offered — a gone capability, or an approved field the inventory dropped.
   * Only meaningful when `bound` is false.
   */
  affected: boolean;
}

export interface DecisionsDiff {
  /** Present whether or not the hashes agree; see `DecisionsBinding`. */
  binding: DecisionsBinding;
  capabilities: CapabilityDecisionsDiff[];
  /** Approved capabilities the inventory no longer reviews at all. */
  capabilitiesGone: string[];
  /**
   * Capabilities the inventory offers that the decisions does not mention.
   *
   * The same argument as `unapproved` one level up: an operation added
   * upstream since the last review is something the host never declined, and
   * a re-review that reports only what was lost leaves them to notice the
   * addition by reading the schema themselves.
   */
  capabilitiesNew: string[];
}

export function diffGraphQlDecisions(
  inventory: GraphQlCatalogInventory,
  decisions: GraphQlCatalogDecisions,
): DecisionsDiff {
  const overrides = decisions.semanticTypeOverrides ?? {};
  const capabilities: CapabilityDecisionsDiff[] = [];
  const capabilitiesGone: string[] = [];
  const approved = new Set(decisions.queries.map((entry) => entry.capabilityId));
  const capabilitiesNew = inventory.queries
    .map((query) => query.capabilityId)
    .filter((capabilityId) => !approved.has(capabilityId));

  for (const entry of decisions.queries) {
    const review = inventory.queries.find(
      (query) => query.capabilityId === entry.capabilityId,
    );
    if (!review) {
      capabilitiesGone.push(entry.capabilityId);
      continue;
    }

    const available = new Map(
      review.availableOutputFields.map((field) => [field.path, field]),
    );
    const approved = new Set(entry.approvedOutputFields);

    capabilities.push({
      capabilityId: entry.capabilityId,
      missingFromSchema: entry.approvedOutputFields.filter(
        (path) => !available.has(path),
      ),
      unapproved: review.availableOutputFields
        .filter((field) => !approved.has(field.path))
        .map((field) => ({ path: field.path, semanticType: field.semanticType })),
      needsSemanticType: review.availableOutputFields
        .filter(
          (field) =>
            approved.has(field.path) &&
            field.semanticType === "unknown" &&
            overrides[`${review.coordinate}.${field.path}`] === undefined,
        )
        .map((field) => ({
          path: field.path,
          overrideKey: `${review.coordinate}.${field.path}`,
          type: field.type,
        })),
    });
  }

  const affected =
    capabilitiesGone.length > 0 ||
    capabilities.some((entry) => entry.missingFromSchema.length > 0);

  return {
    binding: {
      bound: decisions.reviewSourceHash === inventory.reviewSourceHash,
      decisionsHash: decisions.reviewSourceHash,
      inventoryHash: inventory.reviewSourceHash,
      affected,
    },
    capabilities,
    capabilitiesGone,
    capabilitiesNew,
  };
}

/**
 * Re-binds a decisions file to an inventory, when nothing decided has moved.
 *
 * The escape from a dead end that had only one other exit: hand-editing
 * `reviewSourceHash` to the value the error printed. That works, and it is
 * forging the hash the review depends on — so the design's own pressure pushed
 * a host toward defeating its only audit control. Adding a custom scalar
 * mapping was enough to get there, and the schema had not changed at all.
 *
 * Refuses whenever a decision is affected. That is the whole safety argument:
 * a re-stamp is legitimate exactly when it changes nothing a reviewer decided,
 * and the same comparison `diff` already performs says whether it does. New
 * capabilities and newly-available fields do not block it — they stay
 * unapproved, which is what they already were, and `diff` reports them.
 */
export function rebindGraphQlDecisions(
  inventory: GraphQlCatalogInventory,
  decisions: GraphQlCatalogDecisions,
): { decisions: GraphQlCatalogDecisions; diff: DecisionsDiff; rebound: boolean } {
  const diff = diffGraphQlDecisions(inventory, decisions);
  if (diff.binding.bound || diff.binding.affected) {
    return { decisions, diff, rebound: false };
  }
  return {
    decisions: { ...decisions, reviewSourceHash: inventory.reviewSourceHash },
    diff,
    rebound: true,
  };
}
