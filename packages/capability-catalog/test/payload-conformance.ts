/**
 * A test transport that refuses what a real Payload CMS API refuses.
 *
 * The counterpart of `relay-conformance.ts`, kept as its own file for the same
 * reason that one opens with: each transport pins ONE API family's rules, and
 * parameterizing them together is how a leaked assumption from one family goes
 * green against the other. Payload's family — the `{docs, totalDocs}` list
 * envelope — differs from Relay in every rule that matters:
 *
 * - rows live under `docs` directly; there is no `edges`, no `node`, no
 *   `pageInfo`, and no cursor anywhere, so any Relay assumption that survives
 *   into the envelope path fails loudly here;
 * - paging is positional (`limit`/`page`), not cursor-based;
 * - a request with no `limit` is NOT rejected — Payload serves its default
 *   page (10), the mirror image of `requiresPageSize` proving the Relay rule;
 * - `hasNextPage` is computed from the page actually served, so a fixture
 *   cannot claim a complete result while handing back a partial one;
 * - `totalDocs` is the whole set's size, with the page-shape filler a real
 *   Payload response carries alongside it.
 *
 * Errors are returned in the GraphQL `errors` array, not thrown, for the same
 * reason as the Relay transport: a thrown transport error is a network fault
 * and takes a different path through `executeApprovedGraphQlRequest`.
 */

import type { GraphQlTransport } from "../src/graphql.js";

export interface PayloadConformanceOptions {
  /** Every row the upstream holds. Pages are served from this. */
  rows: readonly unknown[];
  /** Payload's default page size when no `limit` is sent. Defaults to 10. */
  defaultLimit?: number;
  /** Arguments the field declares. An undeclared one is rejected. */
  declaredArguments?: readonly string[];
  /** Response key, i.e. the queried field name. Defaults to `Posts`. */
  responseKey?: string;
}

export type PayloadConformanceTransport = GraphQlTransport & {
  /** Every request the transport saw, in order. */
  calls: Array<Record<string, unknown>>;
};

const DEFAULT_ARGUMENTS = ["limit", "page", "sort", "where", "draft", "trash"] as const;

export function payloadConformanceTransport(
  options: PayloadConformanceOptions,
): PayloadConformanceTransport {
  const defaultLimit = options.defaultLimit ?? 10;
  const responseKey = options.responseKey ?? "Posts";
  const declared = new Set(options.declaredArguments ?? DEFAULT_ARGUMENTS);
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

    // No limit is not an error: Payload serves its default page. This is the
    // deliberate opposite of the Relay transport's `requiresPageSize`.
    const rawLimit = variables["limit"];
    const limit =
      typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0
        ? rawLimit
        : defaultLimit;
    const rawPage = variables["page"];
    const page =
      typeof rawPage === "number" && Number.isInteger(rawPage) && rawPage > 0
        ? rawPage
        : 1;

    const start = (page - 1) * limit;
    const docs = options.rows.slice(start, start + limit);
    const totalPages = Math.max(1, Math.ceil(options.rows.length / limit));

    return {
      data: {
        [responseKey]: {
          docs,
          // Facts of the page actually served, never claims made by a test.
          hasNextPage: start + docs.length < options.rows.length,
          hasPrevPage: page > 1,
          totalDocs: options.rows.length,
          totalPages,
          page,
          limit,
          offset: start,
          pagingCounter: start + 1,
          nextPage: start + docs.length < options.rows.length ? page + 1 : null,
          prevPage: page > 1 ? page - 1 : null,
        },
      },
    };
  };

  return Object.assign(transport, { calls });
}
