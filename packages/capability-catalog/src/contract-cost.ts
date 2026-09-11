/**
 * What a catalog's planning contract costs, and which decisions cost it.
 *
 * The contract is resent on every plan attempt and a compose makes up to three,
 * so its size is the dominant token cost of the whole system. Publishing already
 * computed the number and reported it as one integer with nothing to compare it
 * against, which is the wrong half of the fact: a host who reads "415568 bytes"
 * learns that their catalog is large, not what made it large or what to change.
 * The advice shipped alongside it — "fewer approved fields is the lever" — is
 * the weakest lever there is, measured.
 *
 * Measured on synthetic collection catalogs, 12 projected fields each, all four
 * `supports` facets advertised:
 *
 * | capabilities | contract bytes | ~tokens |
 * |---|---|---|
 * | 16 | 77,468 | 19,367 |
 * | 24 | 116,108 | 29,027 |
 * | 40 | 193,388 | 48,347 |
 * | 86 | 415,568 | 103,892 |
 *
 * Exactly linear, at ~4,830 bytes per capability. And the ranking of levers is
 * not what it looks like from the outside:
 *
 *  - advertising `filterFields` is 3.68x everything else combined, at every
 *    scale, because the filter grammar (operator vocabularies plus the field
 *    enum) is inlined once per nesting level the model may author;
 *  - capability count is linear, so halving it halves the contract;
 *  - projected field count — the thing the old advice named — moves it least:
 *    12 fields down to 4 saves 17%.
 *
 * So this reports the attribution rather than a total, computed by re-deriving
 * the contract with one facet dropped at a time. Derivation is pure and cheap
 * (~1.6ms at 86 capabilities, ~7.5ms for the whole attribution pass), which is
 * why this measures instead of modelling: an estimate of a schema's size drifts
 * from the schema, and the drift is invisible.
 */

import type { PlannerCapability, PlannerManifest } from "./compile.js";
import { createDataPlanningContract } from "./planning-contract.js";

/** The `supports` facets that carry contract weight, in the shape a host edits. */
const ATTRIBUTABLE_FACETS = [
  "filterFields",
  "sortFields",
  "groupFields",
  "aggregates",
] as const;

export type ContractCostFacet = (typeof ATTRIBUTABLE_FACETS)[number];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Top-level argument names across every capability's `inputSchema`. */
function argumentNamesIn(manifest: PlannerManifest): string[] {
  const names = new Set<string>();
  for (const capability of manifest.capabilities) {
    const schema = capability.inputSchema;
    if (!isPlainRecord(schema) || !isPlainRecord(schema.properties)) continue;
    for (const name of Object.keys(schema.properties)) names.add(name);
  }
  return [...names];
}

/**
 * The manifest with named arguments pruned from every capability's params.
 *
 * The reason this exists: the contract carries `inputSchema` verbatim, so an
 * approved argument whose type is recursive — a `where` filter input, most of
 * them — is inlined at every level the depth limit allows. On a real host that
 * was 98% of the contract, and none of it was attributable to any `supports`
 * facet, so the cost landed in what this file called an immovable floor and the
 * advice told the host to cut capabilities. Dropping the one argument was worth
 * 51x what cutting more than half the capabilities was.
 */
function withoutArguments(manifest: PlannerManifest, dropped: readonly string[]): PlannerManifest {
  return {
    ...manifest,
    capabilities: manifest.capabilities.map((capability) => {
      const schema = capability.inputSchema;
      if (!isPlainRecord(schema) || !isPlainRecord(schema.properties)) return capability;
      const properties = { ...schema.properties };
      let changed = false;
      for (const name of dropped) {
        if (name in properties) {
          delete properties[name];
          changed = true;
        }
      }
      if (!changed) return capability;
      const required = Array.isArray(schema.required)
        ? schema.required.filter((name) => !dropped.includes(String(name)))
        : undefined;
      return {
        ...capability,
        inputSchema: { ...schema, properties, ...(required ? { required } : {}) },
      };
    }),
  };
}

export interface ContractFacetCost {
  facet: ContractCostFacet;
  /**
   * Bytes the contract loses when this facet is dropped from every capability.
   *
   * Attribution by removal rather than by addition, because the facets are not
   * independent: measuring each in isolation over an empty baseline double-counts
   * the frame they share. Removal answers the question a host actually has —
   * "what do I get back if I stop advertising this".
   */
  bytes: number;
}

export interface ArgumentContractCost {
  /** The argument as it is named in `approvedVisitorArguments`. */
  argument: string;
  /** Bytes the contract loses when this argument is withheld from the planner. */
  bytes: number;
}

export interface CapabilityContractCost {
  capabilityId: string;
  /**
   * Bytes this capability's contract entry costs on its own.
   *
   * Includes the contract's fixed frame, so these do not sum to the total; they
   * rank, which is what a host cutting a catalog down needs.
   */
  bytes: number;
}

export interface ContractCost {
  bytes: number;
  /**
   * bytes/4, and labelled approximate because it is. An exact count needs the
   * model's tokenizer, which does not belong in this package, and the decision
   * this informs does not need the last 15%.
   */
  approximateTokens: number;
  /** Contract size with every attributable facet dropped — the floor. */
  baselineBytes: number;
  /** Ranked, largest first. */
  facets: ContractFacetCost[];
  /**
   * Ranked, largest first: what each approved argument's own schema costs.
   *
   * Separate from `facets` because they are cut with different controls —
   * a facet by not advertising it, an argument by `approvedInputFields` or by
   * withholding it entirely.
   */
  arguments: ArgumentContractCost[];
  /** Ranked, largest first. */
  capabilities: CapabilityContractCost[];
}

function contractBytes(manifest: PlannerManifest): number {
  return JSON.stringify(createDataPlanningContract(manifest).jsonSchema).length;
}

function withoutFacets(
  manifest: PlannerManifest,
  dropped: readonly ContractCostFacet[],
): PlannerManifest {
  return {
    ...manifest,
    capabilities: manifest.capabilities.map((capability) => {
      if (!capability.supports) return capability;
      const supports = { ...capability.supports };
      for (const facet of dropped) delete supports[facet];
      const next: PlannerCapability = { ...capability };
      if (Object.keys(supports).length === 0) delete next.supports;
      else next.supports = supports;
      return next;
    }),
  };
}

function soloManifest(
  manifest: PlannerManifest,
  capability: PlannerCapability,
): PlannerManifest {
  return {
    ...manifest,
    capabilities: [capability],
    // The contract only reads the data types its capabilities reference, but
    // carrying all of them would put every other capability's projection into a
    // "solo" measurement and flatten the ranking this exists to produce.
    dataTypes: manifest.dataTypes.filter(
      (dataType) => dataType.id === capability.output.dataTypeId,
    ),
  };
}

export function describeContractCost(manifest: PlannerManifest): ContractCost {
  const bytes = contractBytes(manifest);
  const argumentNames = argumentNamesIn(manifest);
  // The floor has to be a floor. It used to drop only `supports` facets, so a
  // catalog whose weight was in its arguments reported almost all of its cost
  // as immovable — and the advice said so in those words.
  const baselineBytes = contractBytes(
    withoutArguments(withoutFacets(manifest, ATTRIBUTABLE_FACETS), argumentNames),
  );

  const facets = ATTRIBUTABLE_FACETS.map((facet) => ({
    facet,
    bytes: bytes - contractBytes(withoutFacets(manifest, [facet])),
  }))
    .filter((entry) => entry.bytes > 0)
    .sort((left, right) => right.bytes - left.bytes);

  const argumentCosts = argumentNames
    .map((argument) => ({
      argument,
      bytes: bytes - contractBytes(withoutArguments(manifest, [argument])),
    }))
    .filter((entry) => entry.bytes > 0)
    .sort((left, right) => right.bytes - left.bytes);

  const capabilities = manifest.capabilities
    .map((capability) => ({
      capabilityId: capability.id,
      bytes: contractBytes(soloManifest(manifest, capability)),
    }))
    .sort((left, right) => right.bytes - left.bytes);

  return {
    bytes,
    approximateTokens: Math.round(bytes / 4),
    baselineBytes,
    facets,
    arguments: argumentCosts,
    capabilities,
  };
}

/**
 * The contract size past which a publish says so.
 *
 * Chosen from the measurements above, not from any provider's documented limit:
 * a limit belongs to whoever is being called, and hardcoding one vendor's
 * numbers here is how this package would start being wrong for the next one.
 * 25,000 tokens is roughly a 24-capability catalog, which is where the measured
 * per-compose cost (three attempts, plus the component schemas on top) stops
 * being something a host would choose by accident.
 *
 * A warning, not a refusal. Hosts who want a hard gate declare a ceiling.
 */
export const DEFAULT_CONTRACT_TOKEN_BUDGET = 25_000;

export interface ContractBudgetVerdict {
  approximateTokens: number;
  budgetTokens: number;
  overBudget: boolean;
  /** Present when over budget: what to change, ranked by what it actually saves. */
  advice?: string;
}

/**
 * States the cost against a budget, and names the levers in measured order.
 *
 * The ordering is the point. Every earlier version of this advice named the
 * projected field count, which is the smallest of the three, so a host who
 * followed it did the most tedious work available for the least return.
 */
export function judgeContractCost(
  cost: ContractCost,
  budgetTokens: number = DEFAULT_CONTRACT_TOKEN_BUDGET,
): ContractBudgetVerdict {
  const overBudget = cost.approximateTokens > budgetTokens;
  if (!overBudget) {
    return { approximateTokens: cost.approximateTokens, budgetTokens, overBudget };
  }

  const heaviest = cost.capabilities.slice(0, 3);
  const facet = cost.facets[0];
  // Ranked together, because they are alternatives competing for the same
  // decision and the previous version could not compare them: facets were
  // measured and arguments were not, so on a host whose weight was in a
  // recursive filter argument the advice named the smallest lever available.
  const largestArgument = cost.arguments[0];
  const argumentLine =
    largestArgument && largestArgument.bytes > (facet?.bytes ?? 0)
      ? [
          `The "${largestArgument.argument}" argument's own schema is ${largestArgument.bytes} ` +
            `bytes — ${Math.round((largestArgument.bytes / cost.bytes) * 100)}% of the contract, ` +
            `and the largest single lever here. An argument typed as a recursive input object is ` +
            `inlined at every level the depth limit allows. Narrow it with \`approvedInputFields\` ` +
            `(dotted paths rooted at the argument name, e.g. ` +
            `"${largestArgument.argument}.title"), or drop it from ` +
            `\`approvedVisitorArguments\` to withhold it entirely.`,
        ]
      : largestArgument
        ? [
            `The "${largestArgument.argument}" argument costs ${largestArgument.bytes} bytes; ` +
              `narrow it with \`approvedInputFields\` if that is more than it is worth.`,
          ]
        : [];
  const advice = [
    ...argumentLine,
    `${cost.capabilities.length} capabilities produce a ${cost.bytes}-byte planning contract ` +
      `(~${cost.approximateTokens} tokens), over the ${budgetTokens}-token budget. It is resent ` +
      `on every plan attempt and a compose makes up to three, so budget ` +
      `~${cost.approximateTokens * 3} tokens per compose before the component schemas are added.`,
    `Fewer capabilities is the linear lever: the contract costs about ` +
      `${Math.round((cost.bytes - cost.baselineBytes) / Math.max(cost.capabilities.length, 1))} ` +
      `bytes per capability above a ${cost.baselineBytes}-byte floor.` +
      (heaviest.length > 0
        ? ` Heaviest: ${heaviest
            .map((entry) => `${entry.capabilityId} (${entry.bytes} B)`)
            .join(", ")}.`
        : ""),
    ...(facet
      ? [
          `Dropping "${facet.facet}" from capabilities that do not need it returns ` +
            `${facet.bytes} bytes — ${Math.round((facet.bytes / cost.bytes) * 100)}% of the ` +
            `contract. Advertising a filter vocabulary is the single largest cost here, well ` +
            `above the number of projected fields.`,
        ]
      : []),
  ].join(" ");

  return { approximateTokens: cost.approximateTokens, budgetTokens, overBudget, advice };
}
