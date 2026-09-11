import {
  applyDataModelPatch,
  createComposeEventParser,
  type ComposeEvent,
} from "@renderyes/core";

/**
 * Client half of the streamed compose: turns a stream of events into the
 * state a surface renders.
 *
 * Kept out of the hook so the reducer can be tested against scripted event
 * sequences — out-of-order arrivals, a mid-stream failure, a stream that ends
 * without a terminal event — none of which are reachable through a component
 * test without a live server.
 */

/** What a run is doing right now, for hosts that show progress. */
export type ComposeStage = "idle" | "planning" | "executing" | "rendering" | "done";

export interface ComposeStreamState {
  stage: ComposeStage;
  /** A2UI messages as they stand, ready to render. Grows a skeleton first. */
  messages: unknown[];
  planId: string | null;
  /** Settled and total data requests, or null before the plan exists. */
  progress: { settled: number; total: number } | null;
  /**
   * The server's whole-request budget, once RUN_STARTED reports it.
   *
   * A client that reads this stops holding its own copy of a number the server
   * owns — the two drifting apart is how a produced response came to be
   * discarded unread.
   */
  deadlineMs?: number;
  /** Requests that failed, by requestId, with the host's own message. */
  failedRequests: Record<string, string>;
  /** Set once the run ends badly. */
  failure: {
    kind: string;
    reason: string;
    issues?: unknown[];
    /** Set when `kind` is `"needs-clarification"`. See `ComposeEvent`. */
    question?: string;
    options?: string[];
  } | null;
  /** Set when the view on screen is a fallback, not what was asked for. */
  fellBack: boolean;
  /** True once a terminal event arrived. A stream that closes without one did not finish. */
  finished: boolean;
}

export const initialComposeStreamState: ComposeStreamState = {
  stage: "idle",
  messages: [],
  planId: null,
  progress: null,
  failedRequests: {},
  failure: null,
  fellBack: false,
  finished: false,
};

const dataModelIndex = (messages: readonly unknown[]): number =>
  messages.findIndex(
    (message) =>
      typeof message === "object" && message !== null && "updateDataModel" in message,
  );

/**
 * Applies one event.
 *
 * Pure, and total: an event that cannot be applied returns the state
 * unchanged rather than throwing. A malformed frame in the middle of a run
 * must not cost the visitor the view that has already rendered.
 */
export function applyComposeEvent(
  state: ComposeStreamState,
  event: ComposeEvent,
): ComposeStreamState {
  switch (event.type) {
    case "RUN_STARTED":
      return {
        ...initialComposeStreamState,
        stage: "planning",
        // The server's own budget, carried on the first frame. The client used
        // to hold an independent constant, so a response the server produced
        // successfully at 43s was thrown away by a caller that gave up at 40.
        // Whoever arms the timeout should not be guessing what the other side
        // will allow.
        ...(typeof event.deadlineMs === "number" ? { deadlineMs: event.deadlineMs } : {}),
      };

    case "STEP_STARTED":
      return {
        ...state,
        stage: event.step === "plan" ? "planning" : event.step === "execute" ? "executing" : "rendering",
      };

    case "STEP_FINISHED":
      return {
        ...state,
        ...(event.planId ? { planId: event.planId } : {}),
      };

    case "STATE_SNAPSHOT": {
      // The skeleton: components are known, no data has arrived. Rendering
      // starts here, which is the entire reason this transport exists.
      const total = countPendingRequests(event.messages);
      return {
        ...state,
        stage: "executing",
        messages: event.messages,
        progress: { settled: 0, total },
      };
    }

    case "TOOL_CALL_START":
      return state;

    case "TOOL_CALL_END":
      return {
        ...state,
        progress: state.progress
          ? { ...state.progress, settled: state.progress.settled + 1 }
          : null,
        ...(event.state === "error"
          ? {
              failedRequests: {
                ...state.failedRequests,
                [event.requestId]: event.errorMessage ?? "Request failed.",
              },
            }
          : {}),
      };

    case "STATE_DELTA": {
      const index = dataModelIndex(state.messages);
      if (index === -1) return state;
      const message = state.messages[index] as {
        updateDataModel: { value: Record<string, unknown> };
      };
      const messages = [...state.messages];
      messages[index] = {
        ...message,
        updateDataModel: {
          ...message.updateDataModel,
          value: applyDataModelPatch(message.updateDataModel.value ?? {}, event.patch),
        },
      };
      return { ...state, messages };
    }

    case "RUN_ERROR":
      return {
        ...state,
        stage: "done",
        finished: true,
        failure: {
          kind: event.kind,
          reason: event.reason,
          ...(event.issues ? { issues: event.issues } : {}),
          ...(event.question ? { question: event.question } : {}),
          ...(event.options ? { options: event.options } : {}),
        },
      };

    case "RUN_FINISHED":
      return {
        ...state,
        stage: "done",
        finished: true,
        ...(event.planId ? { planId: event.planId } : {}),
        fellBack: event.fellBack === true,
        ...(event.fellBack === true
          ? {
              failure: {
                kind: event.kind ?? "invalid",
                reason: event.reason ?? "That change could not be applied.",
                ...(event.issues ? { issues: event.issues } : {}),
                ...(event.question ? { question: event.question } : {}),
                ...(event.options ? { options: event.options } : {}),
              },
            }
          : {}),
      };

    default:
      return state;
  }
}

/** How many data requests the skeleton describes, for a progress indicator. */
function countPendingRequests(messages: readonly unknown[]): number {
  const index = dataModelIndex(messages);
  if (index === -1) return 0;
  const value = (
    messages[index] as { updateDataModel?: { value?: Record<string, unknown> } }
  ).updateDataModel?.value;
  const requests = (value as { __renderyes?: { requests?: unknown[] } } | undefined)
    ?.__renderyes?.requests;
  return Array.isArray(requests) ? requests.length : 0;
}

/**
 * Reads an SSE response body, applying each event as it arrives.
 *
 * `onState` fires per event rather than once at the end — that is the point.
 * `onEvent` is separate so a caller can reset an inactivity timer on any
 * traffic, including events that do not change the rendered state.
 */
export async function readComposeStream(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onState: (state: ComposeStreamState) => void;
    onEvent?: (event: ComposeEvent) => void;
  },
  initial: ComposeStreamState = initialComposeStreamState,
): Promise<ComposeStreamState> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createComposeEventParser();
  let state = initial;

  const consume = (events: readonly ComposeEvent[]): void => {
    for (const event of events) {
      handlers.onEvent?.(event);
      state = applyComposeEvent(state, event);
      handlers.onState(state);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(parser.push(decoder.decode(value, { stream: true })));
    }
    consume(parser.end());
  } finally {
    reader.releaseLock();
  }

  return state;
}
