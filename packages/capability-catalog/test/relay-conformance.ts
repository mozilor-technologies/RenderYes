/**
 * A test transport that refuses what a real Relay API refuses.
 *
 * Our fixtures answered whatever document they were handed, so every rule a
 * Relay API enforces was invisible to the suite — and two shipped defects came
 * out of exactly that gap. A connection query with no `first` was invalid
 * against Saleor and green here; a `first` above the API's page cap was
 * rejected outright and green here. In both cases the tests passed and the
 * feature was broken for the entire class of API it was written for.
 *
 * So the rules live in one place and are opted out of deliberately, rather than
 * being re-remembered per test:
 *
 * - a connection field must carry `first` or `last` (Relay defines no default
 *   page; Saleor, GitHub and Shopify all reject the request);
 * - `first` may not exceed `maximumPageSize` (Saleor and GitHub 100,
 *   Shopify 250);
 * - an argument the schema does not declare is rejected, not ignored;
 * - `hasNextPage` is answered from the page actually served rather than
 *   asserted by the test, so a fixture cannot claim a complete result while
 *   handing back a partial one.
 *
 * Errors are returned in the GraphQL `errors` array, which is where a real API
 * puts them — not thrown. A thrown transport error is a network fault and takes
 * a different path through `executeApprovedGraphQlRequest`.
 */

import type { GraphQlTransport } from "../src/graphql.js";

export interface RelayConformanceOptions {
  /** Every row the upstream holds. Pages are served from this. */
  rows: readonly unknown[];
  /** Largest `first` accepted. Defaults to Saleor's and GitHub's 100. */
  maximumPageSize?: number;
  /** Arguments the field declares. An undeclared one is rejected. */
  declaredArguments?: readonly string[];
  /** Response key, i.e. the queried field name. Defaults to `orders`. */
  responseKey?: string;
  /** Connections require a page size; a non-connection field must not. */
  requiresPageSize?: boolean;
}

export type RelayConformanceTransport = GraphQlTransport & {
  /** Every request the transport saw, in order. */
  calls: Array<Record<string, unknown>>;
};

const DEFAULT_ARGUMENTS = ["first", "last", "after", "before"] as const;

export function relayConformanceTransport(
  options: RelayConformanceOptions,
): RelayConformanceTransport {
  const cap = options.maximumPageSize ?? 100;
  const responseKey = options.responseKey ?? "orders";
  const declared = new Set(options.declaredArguments ?? DEFAULT_ARGUMENTS);
  const requiresPageSize = options.requiresPageSize ?? true;
  const calls: Array<Record<string, unknown>> = [];

  const transport: GraphQlTransport = async (request) => {
    const variables: Record<string, unknown> = { ...(request.variables ?? {}) };
    calls.push({ ...variables });

    const undeclared = Object.keys(variables).filter((name) => !declared.has(name));
    if (undeclared.length > 0) {
      return {
        errors: [
          {
            message: `Unknown argument${undeclared.length > 1 ? "s" : ""} ${undeclared
              .map((name) => `"${name}"`)
              .join(", ")} on field "${responseKey}".`,
          },
        ],
      };
    }

    const first = variables["first"];
    const last = variables["last"];
    if (requiresPageSize && first === undefined && last === undefined) {
      return {
        errors: [{ message: "You must provide either `first` or `last` value" }],
      };
    }
    if (typeof first === "number" && first > cap) {
      return {
        errors: [
          {
            message:
              `Requesting ${first} records on the \`${responseKey}\` connection ` +
              `exceeds the \`first\` limit of ${cap} records.`,
          },
        ],
      };
    }

    // Served from the requested page, so `hasNextPage` is a fact rather than a
    // claim the test makes.
    const pageSize = typeof first === "number" ? first : options.rows.length;
    const after = variables["after"];
    const start =
      typeof after === "string" ? options.rows.findIndex((_, i) => cursorFor(i) === after) + 1 : 0;
    const page = options.rows.slice(start, start + pageSize);
    const endIndex = start + page.length - 1;

    return {
      data: {
        [responseKey]: {
          pageInfo: {
            hasNextPage: start + page.length < options.rows.length,
            hasPreviousPage: start > 0,
            startCursor: page.length > 0 ? cursorFor(start) : null,
            endCursor: page.length > 0 ? cursorFor(endIndex) : null,
          },
          // The whole set, not the page — which is the point of the field, and
          // the only thing that can turn "100 of many" into "100 of 2,500".
          totalCount: options.rows.length,
          edges: page.map((node, offset) => ({
            cursor: cursorFor(start + offset),
            node,
          })),
        },
      },
    };
  };

  return Object.assign(transport, { calls });
}

function cursorFor(index: number): string {
  return `cursor:${index}`;
}
