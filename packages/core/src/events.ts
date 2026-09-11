/**
 * Compose events: what a compose emits while it runs, instead of what it
 * returns once it has finished.
 *
 * The vocabulary follows AG-UI — run lifecycle, steps, tool calls, and state
 * snapshots/deltas — because A2UI and AG-UI are converging and inventing our
 * own event names would cost nothing today and a great deal later. We
 * implement it ourselves rather than depending on `@ag-ui/*`: the packages are
 * pre-1.0 and the part we need is an event envelope plus JSON Patch, which is
 * smaller than the dependency.
 *
 * The mapping to what this system actually does:
 *
 *   RUN_STARTED        compose accepted; carries the runId
 *   STEP_STARTED plan  the planner is working, including any repair attempts
 *   STEP_FINISHED plan a validated Plan exists; planId is now known
 *   STATE_SNAPSHOT     the A2UI surface and components, with every data slot
 *                      still pending — this is the frame a skeleton renders
 *   TOOL_CALL_START    one per data request, as execution begins
 *   TOOL_CALL_END      that request settled (ok or not; `state` says which)
 *   STATE_DELTA        JSON Patch against the last emitted data model
 *   RUN_ERROR          the compose produced no view at all — a fault, a refusal
 *                      (`kind: "unsupported"`), or a question the planner needs
 *                      answered first (`kind: "needs-clarification"`)
 *   RUN_FINISHED       terminal; carries the same summary the batch API returns
 *
 * Every run ends with exactly one RUN_FINISHED or RUN_ERROR. A consumer that
 * sees the stream close without either should treat the run as failed: that is
 * a dropped connection, not a quiet success.
 */

export const COMPOSE_EVENT_TYPES = [
  "RUN_STARTED",
  "STEP_STARTED",
  "STEP_FINISHED",
  "STATE_SNAPSHOT",
  "TOOL_CALL_START",
  "TOOL_CALL_END",
  "STATE_DELTA",
  "RUN_ERROR",
  "RUN_FINISHED",
] as const;

export type ComposeEventType = (typeof COMPOSE_EVENT_TYPES)[number];

/** Steps a compose moves through. Not every run reports every step. */
export const COMPOSE_STEPS = ["plan", "execute", "render"] as const;
export type ComposeStep = (typeof COMPOSE_STEPS)[number];

/**
 * A single JSON Patch operation (RFC 6902). Only the three operations a data
 * model projection can produce are accepted — `move`, `copy` and `test` have
 * no meaning here, and allowing them would widen what a client must implement
 * for no gain.
 */
export type JsonPatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

/**
 * State of one data request as reported to the client. `pending` is ours: the
 * projection has to describe a slot whose request has not settled yet, which
 * batch delivery never needed to express.
 */
export const DATA_REQUEST_STATES = ["pending", "ready", "empty", "error"] as const;
export type DataRequestState = (typeof DATA_REQUEST_STATES)[number];

interface ComposeEventBase {
  runId: string;
  timestamp: number;
}

export type ComposeEvent =
  | (ComposeEventBase & {
      type: "RUN_STARTED";
      catalogId: string;
      surfaceId: string;
      /** Present when this run revises an existing view. */
      previousPlanId?: string;
      /**
       * The whole-request budget this run is bounded by, in milliseconds.
       *
       * Sent first, before any model call, so a client arms its own timeout
       * from the server's number instead of a constant compiled into the
       * bundle. Two independently chosen constants either side of the wire is
       * how a response the server produced successfully came to be discarded
       * by a caller that had already given up.
       */
      deadlineMs?: number;
    })
  | (ComposeEventBase & { type: "STEP_STARTED"; step: ComposeStep })
  | (ComposeEventBase & {
      type: "STEP_FINISHED";
      step: ComposeStep;
      durationMs: number;
      /** Known once planning finishes; a saved view is keyed by it. */
      planId?: string;
      /** Whether the plan came from the plan cache rather than the model. */
      cached?: boolean;
    })
  | (ComposeEventBase & {
      type: "STATE_SNAPSHOT";
      /** A2UI messages: createSurface, updateComponents, and the initial data model. */
      messages: unknown[];
    })
  | (ComposeEventBase & {
      type: "TOOL_CALL_START";
      requestId: string;
      capabilityId: string;
    })
  | (ComposeEventBase & {
      type: "TOOL_CALL_END";
      requestId: string;
      capabilityId: string;
      state: DataRequestState;
      durationMs: number;
      /**
       * Present only when `state` is "error". It is the same message the batch
       * response would have carried in the slot envelope — a host-authored
       * failure reason, not an internal stack.
       */
      errorMessage?: string;
    })
  | (ComposeEventBase & { type: "STATE_DELTA"; patch: JsonPatchOperation[] })
  | (ComposeEventBase & {
      type: "RUN_ERROR";
      kind: string;
      reason: string;
      issues?: unknown[];
      /**
       * Present when `kind` is `"needs-clarification"`: the planner is asking
       * the visitor something rather than guessing between two answers the
       * catalog could equally give.
       *
       * Carried on RUN_ERROR rather than on a new terminal event, and that is a
       * compatibility decision rather than a taxonomic one. `parseComposeEvent`
       * drops frames whose type it does not recognise, so a third terminal type
       * would be invisible to every existing client — which would then wait for
       * a terminal event that never came and report the connection as dropped.
       * RUN_ERROR already carries `unsupported`, which is a refusal and not a
       * fault either, so the category is "this run produced no view, and here
       * is why". A client that ignores these fields shows the question as the
       * reason, which is degraded but true.
       */
      question?: string;
      options?: string[];
    })
  | (ComposeEventBase & {
      type: "RUN_FINISHED";
      planId?: string;
      cached?: boolean;
      /**
       * A run that renders a *previous* view because this plan failed. The view
       * is real, so this is not RUN_ERROR — but it is not what was asked for
       * either, and a client that reports it as success hides the failure.
       */
      fellBack?: boolean;
      kind?: string;
      reason?: string;
      issues?: unknown[];
      /**
       * A *revision* that produced a question. The previous view is still on
       * screen — that is what `fellBack` means — and the visitor can answer or
       * carry on looking at what they have. See RUN_ERROR's copy of these.
       */
      question?: string;
      options?: string[];
    });

/**
 * Validates a decoded frame.
 *
 * Hand-written rather than a Zod schema on purpose: `@renderyes/core` has no
 * runtime dependencies and is imported from both sides of a deliberate Zod
 * major split — `@renderyes/react` is pinned to Zod 3 because `@a2ui/*`
 * requires it as a peer and its schemas are composed with ours, while the
 * server-side packages are on Zod 4. A schema *value* here could therefore not
 * be used by half its consumers: a Zod 3 schema and a Zod 4 schema cannot be
 * combined. See "Two Zod majors" in `@renderyes/react`'s README. The shape is
 * small enough that a hand-written check is cheaper than the boundary problem.
 */
export function parseComposeEvent(value: unknown): ComposeEvent | undefined {
  if (!isRecord(value)) return undefined;
  const { type, runId, timestamp } = value;
  if (typeof runId !== "string" || runId.length === 0) return undefined;
  if (typeof timestamp !== "number") return undefined;
  if (typeof type !== "string") return undefined;
  if (!(COMPOSE_EVENT_TYPES as readonly string[]).includes(type)) return undefined;

  const ok = (() => {
    switch (type) {
      case "RUN_STARTED":
        return isString(value.catalogId) && isString(value.surfaceId);
      case "STEP_STARTED":
        return isStep(value.step);
      case "STEP_FINISHED":
        return isStep(value.step) && typeof value.durationMs === "number";
      case "STATE_SNAPSHOT":
        return Array.isArray(value.messages);
      case "TOOL_CALL_START":
        return isString(value.requestId) && isString(value.capabilityId);
      case "TOOL_CALL_END":
        return (
          isString(value.requestId) &&
          isString(value.capabilityId) &&
          typeof value.durationMs === "number" &&
          (DATA_REQUEST_STATES as readonly unknown[]).includes(value.state)
        );
      case "STATE_DELTA":
        return Array.isArray(value.patch) && value.patch.every(isPatchOperation);
      case "RUN_ERROR":
        return isString(value.kind) && isString(value.reason);
      case "RUN_FINISHED":
        return true;
      default:
        return false;
    }
  })();

  return ok ? (value as unknown as ComposeEvent) : undefined;
}

/**
 * Segments that let a JSON Pointer walk leave the target object and reach the
 * prototype chain.
 *
 * `applyDataModelPatch` creates missing intermediate objects as it descends, so
 * a patch naming `/__proto__/x` writes to `Object.prototype` — and the patch
 * arrives over SSE, from a model, into every visitor's browser. Rejecting the
 * segment is cheaper and more certain than trying to make the walk safe.
 */
const UNSAFE_POINTER_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function pointerSegments(path: string): string[] {
  return path.split("/").slice(1).map(unescapeJsonPointer);
}

function hasUnsafePointerSegment(path: string): boolean {
  return pointerSegments(path).some((segment) => UNSAFE_POINTER_SEGMENTS.has(segment));
}

function isPatchOperation(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.path)) return false;
  if (hasUnsafePointerSegment(value.path)) return false;
  if (value.op === "remove") return true;
  return (value.op === "add" || value.op === "replace") && "value" in value;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStep = (value: unknown): value is ComposeStep =>
  (COMPOSE_STEPS as readonly unknown[]).includes(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True for the two events that may only ever appear last. */
export function isTerminalComposeEvent(event: ComposeEvent): boolean {
  return event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";
}

/**
 * Encodes one event as an SSE frame.
 *
 * The event type goes in the `event:` field as well as the JSON body. A client
 * using `addEventListener` needs the field; a client reading frames generically
 * needs the body. Carrying it twice costs a few bytes and saves every consumer
 * from choosing.
 */
export function encodeComposeEvent(event: ComposeEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Parses SSE frames out of a byte stream, tolerating chunk boundaries that
 * fall anywhere — including inside a frame or between the `\n\n` bytes that
 * terminate one.
 *
 * Returns complete events and keeps the remainder for the next call. Frames
 * that are not valid events are skipped rather than thrown: a stream that has
 * already rendered half a view should not be abandoned because one frame was
 * malformed, and the run still ends with a terminal event either way.
 */
export function createComposeEventParser(): {
  push(chunk: string): ComposeEvent[];
  end(): ComposeEvent[];
} {
  let buffer = "";
  const parseFrame = (frame: string): ComposeEvent | undefined => {
    const dataLines = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());
    if (dataLines.length === 0) return undefined;
    try {
      return parseComposeEvent(JSON.parse(dataLines.join("\n")));
    } catch {
      return undefined;
    }
  };
  const drain = (final: boolean): ComposeEvent[] => {
    const events: ComposeEvent[] = [];
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const event = parseFrame(buffer.slice(0, index));
      if (event) events.push(event);
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
    }
    if (final && buffer.trim().length > 0) {
      const event = parseFrame(buffer);
      if (event) events.push(event);
      buffer = "";
    }
    return events;
  };
  return {
    push: (chunk) => {
      buffer += chunk;
      return drain(false);
    },
    end: () => drain(true),
  };
}

/**
 * Diffs two data models into a JSON Patch.
 *
 * Deliberately shallow-by-key at each level and whole-value at the leaves: a
 * data model's changes between events are "this request's envelope appeared"
 * and "this slot's rows arrived", never a character inside a string. A
 * structural differ would produce smaller patches for changes this system
 * does not make.
 */
export function diffDataModel(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): JsonPatchOperation[] {
  const patch: JsonPatchOperation[] = [];
  walk(previous, next, "");
  return patch;

  function walk(before: unknown, after: unknown, path: string): void {
    if (Object.is(before, after)) return;
    if (!isPlainObject(before) || !isPlainObject(after)) {
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      patch.push(
        after === undefined
          ? { op: "remove", path }
          : { op: before === undefined ? "add" : "replace", path, value: after },
      );
      return;
    }
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const childPath = `${path}/${escapeJsonPointer(key)}`;
      if (!(key in after)) {
        patch.push({ op: "remove", path: childPath });
        continue;
      }
      if (!(key in before)) {
        patch.push({ op: "add", path: childPath, value: after[key] });
        continue;
      }
      walk(before[key], after[key], childPath);
    }
  }
}

/** Applies a patch produced by `diffDataModel`, returning a new object. */
export function applyDataModelPatch(
  target: Record<string, unknown>,
  patch: readonly JsonPatchOperation[],
): Record<string, unknown> {
  const next = structuredClone(target) as Record<string, unknown>;
  for (const operation of patch) {
    // Checked here as well as in `parseComposeEvent`, because this is exported:
    // a caller applying a patch it obtained some other way must not be able to
    // reach the prototype chain either. Thrown rather than skipped — a pointer
    // naming `__proto__` is an attack, not a condition to absorb quietly.
    if (hasUnsafePointerSegment(operation.path)) {
      throw new Error(`Refusing to apply a patch operation targeting ${operation.path}`);
    }
    const segments = pointerSegments(operation.path);
    if (segments.length === 0) continue;
    let cursor: Record<string, unknown> = next;
    for (const segment of segments.slice(0, -1)) {
      const child = cursor[segment];
      if (!isPlainObject(child)) {
        cursor[segment] = {};
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1] as string;
    if (operation.op === "remove") delete cursor[leaf];
    else cursor[leaf] = operation.value;
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const escapeJsonPointer = (segment: string): string =>
  segment.replace(/~/g, "~0").replace(/\//g, "~1");

const unescapeJsonPointer = (segment: string): string =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");
