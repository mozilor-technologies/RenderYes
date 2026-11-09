import test from "node:test";
import assert from "node:assert/strict";

import {
  parseComposeEvent,
  readClarificationInput,
  readUnderstoodInputs,
} from "../dist/index.js";

const base = { runId: "run-1", timestamp: 1_700_000_000_000 };
const input = {
  planId: "plan-1",
  requestId: "r1",
  capabilityId: "install.guide",
  kind: "param",
  name: "platform",
  label: "Platform",
  options: ["shopify", "html"],
};

test("RUN_ERROR carries a well-formed missing-input question through parsing", () => {
  const event = parseComposeEvent({
    ...base,
    type: "RUN_ERROR",
    kind: "needs-clarification",
    reason: "Which platform?",
    question: "Which platform?",
    options: ["shopify", "html"],
    input,
  });
  assert.deepEqual(event.input, input);
});

test("a malformed input is dropped, and the question still arrives as a question", () => {
  for (const bad of [
    { ...input, kind: "filter" },
    { ...input, options: [] },
    { ...input, options: [1, 2] },
    { ...input, planId: "" },
    "plan-1",
  ]) {
    const event = parseComposeEvent({
      ...base,
      type: "RUN_ERROR",
      kind: "needs-clarification",
      reason: "Which platform?",
      question: "Which platform?",
      input: bad,
    });
    assert.ok(event, "the frame is kept");
    assert.equal("input" in event, false);
    assert.equal(event.question, "Which platform?");
  }
});

test("a fell-back revision's RUN_FINISHED carries the input too", () => {
  const event = parseComposeEvent({ ...base, type: "RUN_FINISHED", fellBack: true, input });
  assert.equal(event.input.planId, "plan-1");
});

test("readClarificationInput copies, so a caller cannot mutate the wire value", () => {
  const read = readClarificationInput(input);
  read.options.push("wix");
  assert.deepEqual(input.options, ["shopify", "html"]);
});

test("readUnderstoodInputs keeps well-formed entries and skips the rest", () => {
  const good = {
    requestId: "r1",
    capabilityId: "laws.list",
    kind: "filter",
    name: "regions",
    label: "Visitors from",
    multiple: true,
    required: false,
    values: ["Germany"],
    notFound: ["Texas"],
    options: ["Germany", "France"],
    editable: true,
  };
  const read = readUnderstoodInputs([
    good,
    { ...good, kind: "identity" },
    { ...good, values: "Germany" },
    { ...good, editable: "yes" },
    null,
  ]);
  assert.deepEqual(read, [good]);
  assert.deepEqual(readUnderstoodInputs(undefined), []);
});
