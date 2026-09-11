import { describe, expect, it } from "vitest";
import {
  applyComposeEvent,
  initialComposeStreamState,
  readComposeStream,
  type ComposeStreamState,
} from "../src/compose-stream.js";
import { encodeComposeEvent, type ComposeEvent } from "@renderyes/core";

/**
 * The client half of streaming, against scripted event sequences. These are
 * the cases a live server will not produce on demand: a slot that fails while
 * others succeed, a stream that stops without saying why, frames arriving in
 * an order nobody planned for.
 */

const runId = "run-1";
let clock = 0;
const event = <T extends ComposeEvent["type"]>(
  type: T,
  fields: Record<string, unknown> = {},
): ComposeEvent =>
  ({ type, runId, timestamp: (clock += 1), ...fields }) as ComposeEvent;

const snapshotMessages = (requestIds: string[]) => [
  { version: "v0.9", createSurface: { surfaceId: "main", catalogId: "c:ui" } },
  {
    version: "v0.9",
    updateComponents: { surfaceId: "main", components: [{ id: "n1" }] },
  },
  {
    version: "v0.9",
    updateDataModel: {
      surfaceId: "main",
      path: "/",
      value: {
        __renderyes: {
          requests: requestIds.map((requestId) => ({ requestId, state: "pending" })),
        },
      },
    },
  },
];

const apply = (events: ComposeEvent[], from = initialComposeStreamState) =>
  events.reduce<ComposeStreamState>(
    (state, next) => applyComposeEvent(state, next),
    from,
  );

const dataModelOf = (state: ComposeStreamState) =>
  (
    state.messages.find(
      (message): message is { updateDataModel: { value: Record<string, unknown> } } =>
        typeof message === "object" && message !== null && "updateDataModel" in message,
    )?.updateDataModel.value ?? {}
  ) as Record<string, unknown>;

describe("applyComposeEvent", () => {
  it("renders the skeleton before any data arrives", () => {
    const state = apply([
      event("RUN_STARTED", { catalogId: "c", surfaceId: "main" }),
      event("STEP_STARTED", { step: "plan" }),
      event("STEP_FINISHED", { step: "plan", durationMs: 40, planId: "plan-1" }),
      event("STATE_SNAPSHOT", { messages: snapshotMessages(["r1", "r2"]) }),
    ]);

    expect(state.messages).toHaveLength(3);
    expect(state.planId).toBe("plan-1");
    expect(state.progress).toEqual({ settled: 0, total: 2 });
    expect(state.stage).toBe("executing");
    expect(JSON.stringify(dataModelOf(state))).toContain("pending");
  });

  it("counts settled requests as they land, in whatever order", () => {
    const state = apply([
      event("STATE_SNAPSHOT", { messages: snapshotMessages(["r1", "r2"]) }),
      event("TOOL_CALL_END", {
        requestId: "r2",
        capabilityId: "c2",
        state: "ready",
        durationMs: 5,
      }),
      event("TOOL_CALL_END", {
        requestId: "r1",
        capabilityId: "c1",
        state: "ready",
        durationMs: 900,
      }),
    ]);
    expect(state.progress).toEqual({ settled: 2, total: 2 });
  });

  it("keeps a failed slot as a failed slot, not a failed view", () => {
    const state = apply([
      event("STATE_SNAPSHOT", { messages: snapshotMessages(["r1", "r2"]) }),
      event("TOOL_CALL_END", {
        requestId: "r1",
        capabilityId: "c1",
        state: "error",
        durationMs: 3,
        errorMessage: "Upstream timed out.",
      }),
      event("TOOL_CALL_END", {
        requestId: "r2",
        capabilityId: "c2",
        state: "ready",
        durationMs: 4,
      }),
      event("RUN_FINISHED", { planId: "plan-1" }),
    ]);

    expect(state.failedRequests).toEqual({ r1: "Upstream timed out." });
    expect(state.failure).toBeNull();
    expect(state.finished).toBe(true);
    expect(state.messages.length).toBeGreaterThan(0);
  });

  it("applies a delta into the data model the surface renders", () => {
    const state = apply([
      event("STATE_SNAPSHOT", { messages: snapshotMessages(["r1"]) }),
      event("STATE_DELTA", {
        patch: [
          { op: "add", path: "/n1", value: { records: [1, 2] } },
          { op: "replace", path: "/__renderyes/requests/0/state", value: "ready" },
        ],
      }),
    ]);
    expect(dataModelOf(state).n1).toEqual({ records: [1, 2] });
  });

  it("ignores a delta that arrives before any snapshot", () => {
    // Nothing to patch yet. Inventing a data model here would render a view
    // whose components were never described.
    const state = apply([event("STATE_DELTA", { patch: [{ op: "add", path: "/a", value: 1 }] })]);
    expect(state.messages).toEqual([]);
  });

  it("reports a run error as a failure with its kind intact", () => {
    const state = apply([
      event("RUN_STARTED", { catalogId: "c", surfaceId: "main" }),
      event("RUN_ERROR", { kind: "unsupported", reason: "No approved data covers that." }),
    ]);
    expect(state.failure).toMatchObject({ kind: "unsupported" });
    expect(state.finished).toBe(true);
  });

  it("treats a fallback as finished-but-failed, never as success", () => {
    const state = apply([
      event("STATE_SNAPSHOT", { messages: snapshotMessages(["r1"]) }),
      event("RUN_FINISHED", {
        planId: "plan-0",
        fellBack: true,
        kind: "invalid",
        reason: "That change could not be applied.",
      }),
    ]);
    expect(state.fellBack).toBe(true);
    expect(state.failure?.kind).toBe("invalid");
    expect(state.planId).toBe("plan-0");
  });

  it("a new run clears the previous run's failures", () => {
    const failed = apply([
      event("RUN_ERROR", { kind: "invalid", reason: "nope" }),
    ]);
    const restarted = applyComposeEvent(
      failed,
      event("RUN_STARTED", { catalogId: "c", surfaceId: "main" }),
    );
    expect(restarted.failure).toBeNull();
    expect(restarted.finished).toBe(false);
  });
});

describe("readComposeStream", () => {
  const streamOf = (events: ComposeEvent[], chunkSize = 7) => {
    const text = events.map(encodeComposeEvent).join("");
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });
  };

  it("emits state on every event, not once at the end", async () => {
    const states: ComposeStreamState[] = [];
    const final = await readComposeStream(
      streamOf([
        event("RUN_STARTED", { catalogId: "c", surfaceId: "main" }),
        event("STATE_SNAPSHOT", { messages: snapshotMessages(["r1"]) }),
        event("TOOL_CALL_END", {
          requestId: "r1",
          capabilityId: "c1",
          state: "ready",
          durationMs: 2,
        }),
        event("RUN_FINISHED", { planId: "plan-1" }),
      ]),
      { onState: (state) => states.push(state) },
    );

    expect(states.length).toBe(4);
    // The view was renderable well before the run ended.
    expect(states[1]?.messages.length).toBeGreaterThan(0);
    expect(final.finished).toBe(true);
    expect(final.planId).toBe("plan-1");
  });

  it("a stream that ends without a terminal event is not finished", async () => {
    // A dropped connection. Reporting this as success would present a partial
    // view as a complete one.
    const final = await readComposeStream(
      streamOf([
        event("RUN_STARTED", { catalogId: "c", surfaceId: "main" }),
        event("STATE_SNAPSHOT", { messages: snapshotMessages(["r1"]) }),
      ]),
      { onState: () => {} },
    );
    expect(final.finished).toBe(false);
    expect(final.messages.length).toBeGreaterThan(0);
  });

  it("reports every event to onEvent, including ones that change nothing", async () => {
    // The hook resets its inactivity deadline on these, so a run that is alive
    // but not yet rendering must still count as traffic.
    const seen: string[] = [];
    await readComposeStream(
      streamOf([
        event("RUN_STARTED", { catalogId: "c", surfaceId: "main" }),
        event("TOOL_CALL_START", { requestId: "r1", capabilityId: "c1" }),
        event("RUN_FINISHED", {}),
      ]),
      { onState: () => {}, onEvent: (next) => seen.push(next.type) },
    );
    expect(seen).toEqual(["RUN_STARTED", "TOOL_CALL_START", "RUN_FINISHED"]);
  });
});
