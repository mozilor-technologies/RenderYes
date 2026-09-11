/**
 * The one content hash in this package, and the canonical form it hashes.
 *
 * There were four copies of each, in `compile.ts`, `graphql.ts`, `openapi.ts`
 * and `operation-effect.ts`. They agreed, but only by luck: the four
 * `canonicalize` bodies each tested "is this an object" differently
 * (`value && typeof value === "object"` against two spellings of an `isRecord`
 * guard), and agreed solely because every input they ever see is already JSON.
 *
 * That mattered more than duplication normally does, because these hashes are
 * load-bearing across time and machines. A catalog hash mismatch is what raises
 * `DATA_CATALOG_MISMATCH` at compose time; a review source hash is what lets
 * `diff` tell whether a schema moved under stored decisions; a document hash is
 * what OpenAPI drift compares. Two copies drifting would not fail a build — it
 * would invalidate artifacts already published by people who cannot see the
 * change. `test/hash-stability.test.ts` pins the outputs for that reason.
 *
 * Deliberately not shared with `@renderyes/core`'s `fnv1a`, which returns a
 * `fnv1a-`-prefixed string for registry ids. That is a different hash family
 * with a different output format, it is never compared against these values,
 * and merging the two would invite someone to "fix" the prefix and silently
 * renumber every registry id.
 */

/**
 * Sorts object keys at every depth so serialization is order-independent.
 *
 * Arrays keep their order — that is data, not formatting. `null` and primitives
 * pass through, which is why the object test is written as it is rather than as
 * a truthiness check: `typeof null === "object"`, and treating it as a record
 * would hash `null` as `{}`.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

/**
 * FNV-1a, 32-bit, as eight lowercase hex digits.
 *
 * Not a cryptographic hash and not used as one: every caller is asking "is this
 * the same content as before", never "prove this content was not tampered
 * with". A collision here means a stale catalog is accepted as current, which is
 * why the comparison is always against a value the host itself stored.
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** `fnv1a` over the canonical form — the shape every call site actually wanted. */
export function hashContent(value: unknown): string {
  return fnv1a(JSON.stringify(canonicalize(value)));
}
