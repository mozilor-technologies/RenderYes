import assert from "node:assert/strict";
import test from "node:test";
import { deliveryOf, firstRequestError, summarizeRequests } from "../dist/index.js";

/**
 * What "delivered" means when a result is legitimately empty.
 *
 * The envelope used to count any request that did not throw as delivered, so a
 * view with two bound slots and no rows in either reported `ok: true` with no
 * partial flag — against a documented contract that says `ok: false, kind:
 * "data-unavailable"`. Eight cases of half-answered questions and one of
 * nothing-at-all came out of a single eval run against a live newspaper.
 *
 * The fix is not "empty means failure". A filter the database applied and that
 * matched nothing is a real answer, and reporting it as an error would be the
 * opposite mistake. The two are indistinguishable in the data: what tells them
 * apart is where the narrowing ran, which the runtime already records.
 */

const plan = { dataRequests: [{ requestId: "r1", capabilityId: "c1" }, { requestId: "r2", capabilityId: "c2" }] };

const executed = (results) => ({ results });

test("rows in a slot are delivered", () => {
  const summary = summarizeRequests(plan, executed({
    r1: { ok: true, data: [{ id: 1 }], provenance: {} },
    r2: { ok: true, data: [{ id: 2 }], provenance: {} },
  }));
  assert.equal(summary[0].delivered, true);
  assert.equal(deliveryOf(summary), "all");
});

test("an empty result the source narrowed is an answer, not a failure", () => {
  // "Articles about X" when there are none. The database evaluated the filter
  // over the whole collection and said nothing matched. That is the answer.
  const summary = summarizeRequests(plan, executed({
    r1: { ok: true, data: [], provenance: {} },
    r2: { ok: true, data: [], provenance: {} },
  }));
  assert.equal(summary[0].delivered, false);
  assert.equal(summary[0].emptyUnconfirmed, undefined);
  assert.equal(deliveryOf(summary), "all");
});

test("an empty result narrowed over one fetched page is withheld", () => {
  // The install case: 7 matching articles out of 500, a 50-row fetch, filtering
  // done here. Zero rows says nothing about the collection.
  const summary = summarizeRequests(plan, executed({
    r1: { ok: true, data: [], provenance: { narrowedAfterFetch: true } },
    r2: { ok: true, data: [], provenance: { narrowedAfterFetch: true } },
  }));
  assert.equal(summary[0].emptyUnconfirmed, true);
  assert.equal(deliveryOf(summary), "none");
  // And the reason says which of the two it is, rather than claiming a load
  // failure that did not happen.
  assert.match(firstRequestError(summary), /matching was done here over one page/);
});

test("one confirmed empty beside one unconfirmed is partial, not success", () => {
  const summary = summarizeRequests(plan, executed({
    r1: { ok: true, data: [{ id: 1 }], provenance: {} },
    r2: { ok: true, data: [], provenance: { narrowedAfterFetch: true } },
  }));
  assert.equal(deliveryOf(summary), "partial");
});

test("a scalar capability delivering a falsy value has delivered", () => {
  // `0 open tickets` is an answer. Only an empty collection, or nothing at all,
  // is an absence.
  const single = { dataRequests: [{ requestId: "r1", capabilityId: "c1" }] };
  const zero = summarizeRequests(single, executed({ r1: { ok: true, data: 0, provenance: {} } }));
  assert.equal(zero[0].delivered, true);
  assert.equal(deliveryOf(zero), "all");
  const nothing = summarizeRequests(single, executed({ r1: { ok: true, data: null, provenance: {} } }));
  assert.equal(nothing[0].delivered, false);
});

test("a failed request still reports its own reason ahead of the empty one", () => {
  // The reason is the failure's, not the page-narrowed explanation — and it is
  // the redacted sentence for that code, never the executor's own message.
  // An operator-facing message reaching `reason` would put upstream-authored
  // text into a visitor's envelope, which is what the redaction seam exists to
  // stop; this is the seam and the delivery rule meeting.
  const summary = summarizeRequests(plan, executed({
    r1: { ok: false, error: { code: "GRAPHQL_EXECUTION_ERROR", message: "Field 'ssn' on User: permission denied at /users/0/ssn" } },
    r2: { ok: true, data: [], provenance: { narrowedAfterFetch: true } },
  }));
  assert.equal(deliveryOf(summary), "none");
  const reason = firstRequestError(summary);
  assert.equal(reason, "The data request failed.");
  assert.doesNotMatch(reason, /ssn/, "upstream-authored detail must not reach the envelope");
  assert.doesNotMatch(reason, /over one page/, "a real failure outranks the empty explanation");
});

test("a forwarded code keeps its exact sentence, since hosts match on it", () => {
  const summary = summarizeRequests(plan, executed({
    r1: { ok: false, error: { code: "TIMEOUT", message: "The data request timed out after 5000ms." } },
    r2: { ok: true, data: [{ id: 1 }], provenance: {} },
  }));
  assert.equal(deliveryOf(summary), "partial");
  assert.equal(summary[0].error, "The data request timed out after 5000ms.");
});

/**
 * The field `use-compose` reads to decide which panel a click can aim `refine`
 * at. The batch envelope never carried it — only the streamed TOOL_CALL_END
 * frames did — so against a real server every panel read "unknown", and the
 * client's own test passed because its fixture wrote `state` in by hand.
 *
 * Derived here exactly as the streaming path derives it, so a view assembled
 * from frames and the same view assembled from the batch envelope describe
 * their slots identically.
 */
test("every request carries the slot state, matching the streamed frames", () => {
  const summary = summarizeRequests(
    { dataRequests: [
      { requestId: "r1", capabilityId: "c1" },
      { requestId: "r2", capabilityId: "c2" },
      { requestId: "r3", capabilityId: "c3" },
    ] },
    { results: {
      r1: { ok: true, data: [{ id: 1 }], provenance: {} },
      r2: { ok: true, data: [], provenance: {} },
      r3: { ok: false, error: { code: "GRAPHQL_EXECUTION_ERROR", message: "boom" } },
    } },
  );
  assert.deepEqual(summary.map((entry) => entry.state), ["ready", "empty", "error"]);
  // Never "pending": a batch envelope is built after everything has settled.
  assert.ok(!summary.some((entry) => entry.state === "pending"));
});
