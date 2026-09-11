import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDataModelPatch,
  parseComposeEvent,
  createComposeEventParser,
  diffDataModel,
  encodeComposeEvent,
  isTerminalComposeEvent,
} from "../dist/index.js";

const runId = "run-1";
const at = 1_700_000_000_000;

test("an event round-trips through SSE encoding unchanged", () => {
  const event = {
    runId,
    timestamp: at,
    type: "TOOL_CALL_END",
    requestId: "r1",
    capabilityId: "graphql.getTickets",
    state: "ready",
    durationMs: 12,
  };
  const parser = createComposeEventParser();
  const [decoded] = parser.push(encodeComposeEvent(event));
  assert.deepEqual(decoded, event);
});

test("the encoded frame names the type in the SSE event field too", () => {
  // A client using addEventListener reads the field; one reading frames
  // generically reads the body. Both have to work.
  const frame = encodeComposeEvent({
    runId,
    timestamp: at,
    type: "STEP_STARTED",
    step: "plan",
  });
  assert.match(frame, /^event: STEP_STARTED\n/);
  assert.match(frame, /\n\n$/);
});

test("frames split across arbitrary chunk boundaries still parse", () => {
  const stream =
    encodeComposeEvent({ runId, timestamp: at, type: "STEP_STARTED", step: "plan" }) +
    encodeComposeEvent({
      runId,
      timestamp: at,
      type: "STEP_FINISHED",
      step: "plan",
      durationMs: 40,
      planId: "plan-1",
    });

  for (const size of [1, 3, 17, stream.length - 1]) {
    const parser = createComposeEventParser();
    const events = [];
    for (let index = 0; index < stream.length; index += size) {
      events.push(...parser.push(stream.slice(index, index + size)));
    }
    events.push(...parser.end());
    assert.deepEqual(
      events.map((event) => event.type),
      ["STEP_STARTED", "STEP_FINISHED"],
      `chunk size ${size}`,
    );
  }
});

test("a malformed frame is skipped rather than abandoning the stream", () => {
  // Half a rendered view should not be thrown away because one frame was bad;
  // the run still ends with a terminal event either way.
  const parser = createComposeEventParser();
  const events = parser.push(
    "event: NONSENSE\ndata: {not json\n\n" +
      encodeComposeEvent({ runId, timestamp: at, type: "RUN_FINISHED", planId: "p" }),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["RUN_FINISHED"],
  );
});

test("an event of an unknown type does not validate", () => {
  assert.equal(parseComposeEvent({ runId, timestamp: at, type: "MADE_UP" }), undefined);
});

test("an event missing a field its type requires does not validate", () => {
  // TOOL_CALL_END without a state would render a slot in no state at all.
  assert.equal(
    parseComposeEvent({
      runId,
      timestamp: at,
      type: "TOOL_CALL_END",
      requestId: "r1",
      capabilityId: "c",
      durationMs: 1,
    }),
    undefined,
  );
});

test("only RUN_FINISHED and RUN_ERROR are terminal", () => {
  const terminal = (type, extra = {}) =>
    isTerminalComposeEvent({ runId, timestamp: at, type, ...extra });
  assert.equal(terminal("RUN_FINISHED"), true);
  assert.equal(terminal("RUN_ERROR", { kind: "unsupported", reason: "no" }), true);
  assert.equal(terminal("STATE_DELTA", { patch: [] }), false);
  assert.equal(terminal("TOOL_CALL_START", { requestId: "r", capabilityId: "c" }), false);
});

test("a patch describes only what changed", () => {
  const before = { a: { keep: 1, change: "old" }, drop: true };
  const after = { a: { keep: 1, change: "new" }, added: [1, 2] };
  const patch = diffDataModel(before, after);
  assert.deepEqual(patch.map((operation) => operation.path).sort(), [
    "/a/change",
    "/added",
    "/drop",
  ]);
  assert.deepEqual(applyDataModelPatch(before, patch), after);
});

test("a slot arriving is an add, and re-applying reproduces the model", () => {
  const pending = {
    __renderyes: { requests: [{ requestId: "r1", state: "pending" }] },
  };
  const ready = {
    __renderyes: { requests: [{ requestId: "r1", state: "ready", rowCount: 3 }] },
    n1: { records: [1, 2, 3] },
  };
  const patch = diffDataModel(pending, ready);
  assert.ok(patch.length > 0);
  assert.deepEqual(applyDataModelPatch(pending, patch), ready);
});

test("an unchanged model produces an empty patch", () => {
  const model = { a: { b: [1, 2, 3] } };
  assert.deepEqual(diffDataModel(model, structuredClone(model)), []);
});

test("keys containing / or ~ survive the pointer round trip", () => {
  const before = {};
  const after = { "surfaces/0~nodes": { value: 1 } };
  const patch = diffDataModel(before, after);
  assert.deepEqual(applyDataModelPatch(before, patch), after);
});

test("applying a patch does not mutate the source model", () => {
  const before = { a: { b: 1 } };
  const patch = diffDataModel(before, { a: { b: 2 } });
  applyDataModelPatch(before, patch);
  assert.deepEqual(before, { a: { b: 1 } });
});

// The per-operation half of STATE_DELTA validation had no test at all: removing
// `.every(isPatchOperation)` from parseComposeEvent left the whole suite green,
// so the only thing standing between a model-authored patch and the visitor's
// browser was never exercised on an input it should reject.

test("a STATE_DELTA entry that is not a patch operation invalidates the frame", () => {
  const frame = (patch) => parseComposeEvent({ runId, timestamp: at, type: "STATE_DELTA", patch });

  assert.equal(frame([{ op: "add", path: "/a", value: 1 }]) !== undefined, true);
  assert.equal(frame(["not-an-object"]), undefined);
  assert.equal(frame([{ op: "add", path: "/a" }]), undefined, "add without a value");
  assert.equal(frame([{ op: "replace", path: "/a" }]), undefined, "replace without a value");
  assert.equal(frame([{ op: "add", value: 1 }]), undefined, "no path");
  assert.equal(frame([{ op: "explode", path: "/a", value: 1 }]), undefined, "unknown op");
  assert.equal(
    frame([
      { op: "add", path: "/a", value: 1 },
      { op: "add", path: "/b" },
    ]),
    undefined,
    "one bad entry invalidates the whole frame",
  );
});

for (const segment of ["__proto__", "constructor", "prototype"]) {
  test(`a STATE_DELTA patch reaching ${segment} is refused at both layers`, () => {
    const path = `/${segment}/polluted`;

    assert.equal(
      parseComposeEvent({
        runId,
        timestamp: at,
        type: "STATE_DELTA",
        patch: [{ op: "add", path, value: "yes" }],
      }),
      undefined,
      "the frame must not parse",
    );

    // applyDataModelPatch is exported, so the sink has to refuse independently
    // of whether the caller went through parseComposeEvent.
    assert.throws(
      () => applyDataModelPatch({}, [{ op: "add", path, value: "yes" }]),
      /Refusing to apply a patch operation/,
    );

    assert.equal({}.polluted, undefined, "Object.prototype must be untouched");
  });
}

test("a pointer segment that merely contains an unsafe name still applies", () => {
  // The guard matches whole segments; rejecting substrings would break ordinary
  // keys like `constructorName`.
  const before = {};
  const after = { constructorName: "Foo", my__proto__key: 1 };
  const patch = diffDataModel(before, after);
  assert.deepEqual(applyDataModelPatch(before, patch), after);
});
