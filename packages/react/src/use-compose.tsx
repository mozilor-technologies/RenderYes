import type { A2uiMessage } from "@a2ui/web_core/v0_9";
import type { RefineOperation } from "./refine-operations.js";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useView, type ViewConfig } from "./provider.js";
import { topLevelPanelIds, withPanelOrder } from "./panels.js";
import {
  initialComposeStreamState,
  readComposeStream,
  type ComposeStage,
  type ComposeStreamState,
} from "./compose-stream.js";

/**
 * Default ceiling on how long a `/api/compose` request may run before giving
 * up and re-enabling the caller's submit control, rather than leaving it
 * spinning forever on a stalled service or data source.
 *
 * A real compose call chains a model call and one round trip per requested
 * capability — a multi-capability prompt against a real backend easily
 * clears 10-15s on its own. On top of that, a provider whose structured-
 * output schema a large catalog can't satisfy (see
 * `shouldRetryWithoutStructuredSchema` in `@renderyes/server`) pays for two
 * sequential model calls instead of one the first time that happens per
 * server process — every restart, not just once ever, since the fallback
 * memory doesn't survive a restart. 45s leaves headroom for that combination
 * without the busy state looking unbounded to whoever's waiting on it.
 * `ViewConfig.composeTimeoutMs` overrides this per host.
 */
const DEFAULT_COMPOSE_TIMEOUT_MS = 45_000;

/**
 * Added to a server-reported deadline before the client gives up.
 *
 * The server's budget bounds its own work; the response still has to be
 * serialized and travel. Aborting at exactly the server's number races it, and
 * losing that race throws away a result that was produced in time.
 */
const DEADLINE_GRACE_MS = 5_000;

/**
 * Why a compose failed, for a host that wants to vary its own copy.
 *
 * `auth` is separate from `network` because the two need opposite responses.
 * A rejected credential — the visitor's session expired, or the host's
 * `resolveSession` refused the request — is not fixed by trying again, and
 * "please try again" is the one instruction guaranteed to waste their time.
 * It arrived here as `network` because the client read only `payload.kind`,
 * which no error response carries for a 401 or 403, so the status code that
 * held the whole answer was never looked at.
 */
export type ComposeFailureKind =
  | "unsupported"
  | "invalid"
  | "provider-error"
  | "timeout"
  | "network"
  /**
   * The service answered and refused the request. Distinct from `network`,
   * which means nothing answered at all — telling a visitor the service is
   * unreachable when it replied sends them to wait out an outage that is not
   * happening, and hides a fault that needs someone to look at it.
   */
  | "service-error"
  | "auth"
  /**
   * Not a failure. The planner can answer this prompt in two or more
   * materially different ways and asked which, rather than guessing. Read
   * `clarification`, not `error`.
   */
  | "needs-clarification"
  /**
   * The plan was right and the data did not arrive: every bound slot resolved
   * to `error`. The view still renders — each slot carries its own
   * explanation — so this reads as "that view is empty", not "nothing
   * happened". Retrying is reasonable; rephrasing is not, because the wording
   * was never the problem.
   */
  | "data-unavailable"
  /**
   * This host composes statelessly: it declared no `resolveViewOwner`, so
   * refining, saving, pinning and reopening are unavailable by configuration
   * rather than broken. Chrome should stop offering them rather than surface
   * an error — until it does, this at least lets a host tell the two apart.
   */
  | "visitor-identity-required";

/**
 * One executed data request, as the service summarised it — ids and state,
 * never rows. `requestId` is what `refine` aims at.
 */
export interface ComposedRequestSummary {
  requestId: string;
  capabilityId: string;
  state: string;
}

/**
 * Which data source feeds which panel: one entry per plan node, bindings
 * copied verbatim from the validated plan. This is the join that lets a
 * host aim `refine` — a click in one panel naming another panel's request.
 */
export interface ComposedNodeBinding {
  nodeId: string;
  componentId: string;
  bindings: Readonly<
    Record<string, { requestId?: string; compositionId?: string; joinId?: string }>
  >;
}

export interface ComposeSessionState {
  /**
   * The executed requests behind the current view, ids only. Derived from the
   * `__renderyes` envelope in the current messages, so it is correct after a
   * stream, a batch compose, a refine, a revise, and a reopen alike — every
   * path that can change the view rebuilds the messages this reads.
   *
   * Together with `nodeBindings` and `refine`, this is the cross-filter seam:
   * find the request behind another panel (by nodeId via `nodeBindings`, or
   * by `capabilityId`) and send it a literal filter from the clicked row.
   * The service still validates every operation against the approved catalog
   * and the plan's owner, so a wrong or hostile target fails closed.
   */
  requests: readonly ComposedRequestSummary[];
  /** Which request/composition/join feeds each panel's slots. See `requests`. */
  nodeBindings: readonly ComposedNodeBinding[];
  prompt: string;
  setPrompt: (value: string) => void;
  busy: boolean;
  /**
   * The plan behind the view currently on screen, or `null` before the first
   * successful compose.
   *
   * Every follow-up takes it: `refine`, a revision, and a host's own save
   * call. A component rendered inside the surface can read it too, which is
   * what lets a table header trigger a sort of the view it belongs to.
   */
  planId: string | null;
  /**
   * Applies plan edits — sort, filter, limit, remove, reorder — with **no
   * model call**. Rejected if the edit would query something the catalog
   * never approved, so a refinement cannot widen what a visitor may see.
   */
  refine: (operations: readonly RefineOperation[]) => Promise<void>;
  /** Clears the view and its plan, returning to the pre-compose state. */
  reset: () => void;
  /** Visitor-facing message. Never contains validator output. */
  error: string | null;
  /**
   * What kind of failure produced `error`, for a host writing its own copy or
   * deciding whether to offer a retry. `null` whenever `error` is.
   */
  errorKind: ComposeFailureKind | null;
  /**
   * A question the planner needs answered before it will commit to a view, or
   * `null`.
   *
   * Set when the approved capabilities could answer the prompt in two or more
   * materially different ways. It is deliberately separate from `error`: a host
   * that renders this as an error message tells the visitor something went
   * wrong, when what happened is that the system declined to guess. `error`
   * still carries the question as text, so a host that has not updated shows
   * something true rather than "Couldn't build that view".
   *
   * `options` is present only when the question has a closed answer set.
   */
  clarification: { question: string; options?: readonly string[] } | null;
  /**
   * Answers the outstanding `clarification` and composes again.
   *
   * Sends the original prompt and the answer together, because the answer alone
   * is not a request — "the last 30 days" means nothing without the question it
   * answers. Does nothing when there is no question outstanding.
   */
  answerClarification: (answer: string) => Promise<void>;
  /**
   * Validator detail for the failure, when the service returned any. Provided
   * for host logging and debugging — never render it. These are AJV paths and
   * schema messages written for whoever wrote the catalog, not for a visitor.
   */
  issues: readonly { path: string; message: string }[];
  messages: readonly A2uiMessage[];
  /**
   * How far the current run has got: planning, executing, rendering, done.
   *
   * `busy` says only that something is happening. This says what, which is the
   * difference between a spinner and a visitor who can tell a slow answer from
   * a stuck one. Always "idle" when the service returns a batch response.
   */
  stage: ComposeStage;
  /**
   * Settled and total data requests for the run on screen, or `null` before a
   * plan exists. Streamed composes only.
   */
  progress: { settled: number; total: number } | null;
  /**
   * Requests that came back as failures, keyed by `requestId`. A view with one
   * failed slot is still a view; this is what lets a host say which part of it
   * is missing rather than discarding the whole thing.
   */
  failedRequests: Record<string, string>;
  /**
   * Composes a view from `prompt`.
   *
   * `{ revise: true }` sends the current `planId`, so the prompt reads as a
   * change to the view already on screen rather than a fresh request.
   *
   * Revision is opt-in rather than automatic-whenever-a-view-exists, because
   * the two cases are indistinguishable from here: after "show my accounts",
   * a visitor typing "show my holdings" usually means a new question, while
   * "only the ones over 500" means a change to what they are looking at. A
   * host knows which affordance the visitor used; this hook does not.
   */
  /**
   * `prompt` submits that text in one action (a suggestion chip's click),
   * updating the input to match — state alone can't, because setPrompt hasn't
   * landed by the time submit reads it.
   */
  submit: (options?: { revise?: boolean; prompt?: string }) => Promise<void>;
  /**
   * Changes the view already on screen, reading the prompt against the current
   * plan.
   *
   * `submit({ revise: true })` with the affordance made explicit. Once a view
   * exists, a visitor typing into it means a change to what they are looking
   * at — a separate control for that is what makes the meaning unambiguous
   * without this hook having to guess it. Falls back to a fresh compose when
   * there is nothing on screen to revise.
   */
  revise: () => Promise<void>;
  /**
   * Clears the view and returns to the pre-compose state — the escape hatch
   * that makes revision safe to be the default. Identical to `reset`, named
   * for the control a visitor actually sees.
   */
  startOver: () => void;
}

/**
 * Keeping and reopening views.
 *
 * Split from the session because a host that composes statelessly has none of
 * it — `resolveViewOwner` is what these need, and a site without one gets a
 * typed refusal rather than a broken menu. Splitting it also means chrome that
 * wants to add a Save button no longer inherits drag-to-rearrange along with
 * it.
 */
export interface SavedViewsState {
  /**
   * Stores the view currently on screen so a visitor can come back to it.
   *
   * Only the `planId` is sent — never the plan body. The service saves the plan
   * it composed and owns, so a caller cannot store an arbitrary plan and have it
   * executed on reopen.
   */
  save: (label?: string) => Promise<{ ok: boolean; viewId?: string }>;
  /**
   * Pins one top-level panel of the view on screen as its own saved view.
   *
   * Like `save`, only the `planId` and the panel's `nodeId` cross the wire —
   * never a plan body. The service slices its own remembered plan down to that
   * node and the data it needs, so the pin reopens as a live single-panel
   * view through the same saved-views machinery (My views, its own URL,
   * staleness). A separate function rather than a parameter on `save`, so
   * existing `save(label?)` callers keep their exact signature.
   *
   * Unlike `save`, this does not point the page's URL at the new view: the
   * visitor is still looking at the full view, and a reload should bring that
   * back, not the single panel they filed away for later.
   */
  pin: (nodeId: string, label?: string) => Promise<{ ok: boolean; viewId?: string }>;
  /**
   * The visitor's own saved views, newest first. Never another visitor's.
   *
   * Pass `{ silent: true }` for a prefetch — a load the visitor didn't ask for
   * reports nothing on failure and returns an empty list, because an error
   * shown before anyone has acted reads as the page being broken.
   */
  listSaved: (options?: { silent?: boolean }) => Promise<readonly SavedViewSummary[]>;
  /**
   * Replays a saved view, refetching its data now rather than restoring a
   * snapshot — a saved view is a saved *question*, not a saved answer.
   *
   * Sets `stale` on the result when the catalog or the host's components have
   * changed since it was saved: it still rendered, but it is not necessarily the
   * view that was saved.
   */
  reopen: (viewId: string) => Promise<void>;
  deleteSaved: (viewId: string) => Promise<boolean>;
  /**
   * Set after `reopen` when the saved view no longer matches what is published.
   * Cleared by any other action.
   */
  staleReason: string | null;
}

/**
 * Arranging the panels of the view on screen.
 *
 * Its own concern because it is the one thing here that writes without the
 * visitor asking: a background refinement, deliberately not gated on `busy`.
 * A host building its own chrome should be able to take pins without taking
 * drag-to-rearrange, and before this split the two arrived together.
 */
export interface PanelOrderState {
  /**
   * Applies a new top-level panel order — the full list of the current
   * panels' nodeIds, each exactly once.
   *
   * Two phases, deliberately. The order applies to the screen at once, with
   * zero network — panels move as they are dropped. Persistence follows in
   * the background as a single `reorderNodes` refinement: rapid moves
   * coalesce into one write, and the write is skipped entirely when the
   * order already matches what the server last delivered. Never sets `busy`
   * — hiding Save and disabling the prompt because a panel moved would read
   * as the page breaking.
   *
   * When the write lands, the refine response's messages and planId are
   * adopted — the server is the source of truth, and a refinement re-executes
   * the plan's data, so panels may refresh moments after settling. Expected,
   * not a bug. On failure the local order stays exactly where the visitor put
   * it and `error` reports that the *arrangement* won't be saved; snapping
   * panels back under their hands would trade a failed save for a broken
   * screen.
   *
   * Resolves `true` once the order is known to the server (or already was),
   * `false` when it could not be persisted.
   */
  reorderPanels: (nodeIds: readonly string[]) => Promise<boolean>;
  /**
   * True while a reorder write is pending or in flight. Distinct from `busy`
   * on purpose: a background save of an arrangement should never disable the
   * prompt or hide the Save control.
   */
  reordering: boolean;
}

/**
 * Everything one compose session exposes.
 *
 * Retained as the union of the three concerns above, so every existing caller
 * keeps working unchanged. New code should prefer the narrower hook: a
 * component that only saves does not need to re-render when a panel moves, and
 * a 26-field return is how the entry points came to share everything by
 * accident.
 */
export type ComposeState = ComposeSessionState & SavedViewsState & PanelOrderState;

/**
 * A saved view as listed back for a menu.
 *
 * Structurally the server's `SavedViewSummary`, mirrored here rather than
 * imported for the same reason `RefineOperation` is: this package ships to a
 * browser bundle and must not pull in the server package to describe a response
 * shape. Deliberately carries no `plan` — a list is for choosing what to reopen,
 * and shipping every stored plan body to render a menu would leak the shape of
 * each one for no benefit.
 */
export interface SavedViewSummary {
  id: string;
  catalogId: string;
  surfaceId: string;
  prompt: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  /** The catalog or the component set has changed since this was saved. */
  stale: boolean;
}

/**
 * Fields `useViewCompose` returns that no shipped component renders, declared
 * so the omission is a decision rather than an oversight.
 *
 * This library is headless-first: every capability becomes a hook field, and
 * whether anything renders it is the host's business. That default has produced
 * the same defect repeatedly — a feature landed, was tested, shipped, and no
 * surface reached it. `clarification` is the clearest case: it rode
 * `RUN_ERROR`, the hook exposed it, no component read it, and a test drove a
 * bespoke component that did — so the suite stayed green while a planner's
 * question reached visitors as red error text.
 *
 * So the list is here rather than in a test file, mirroring
 * `LIBRARY_ONLY_METHODS`: a host reading these types learns which fields they
 * have to build a surface for, and `hook-reachability.test.tsx` fails when a new
 * field appears in neither this list nor a component.
 *
 * Being on this list is not an apology. Saved-view management and streaming
 * progress are genuinely host territory — the point is only that leaving them
 * out was chosen.
 */
export const HOST_ONLY_HOOK_FIELDS: readonly string[] = Object.freeze([
  // Cross-filter addressing. The shipped workspace deliberately renders no
  // cross-filter gesture: which click narrows which panel is host policy, the
  // same way getCardHref is — the library cannot know that clicking a section
  // should filter articles. These two fields are the aiming data for a host's
  // own gesture: the requests behind the view and which request feeds which
  // panel. If a starter component ever grows a shipped cross-filter control,
  // they come off this list and the test names them, as designed.
  "requests",
  "nodeBindings",
  // Saved views are *not* on this list: `ViewWorkspace`'s toolbar renders
  // `save`, `listSaved`, `reopen` and `deleteSaved`. They were here until that
  // shipped, and this list is checked against the components rather than
  // trusted, so the test named them the moment they became wrong — which is
  // the entire reason it exists.
  //
  // `planId` came off it for the same reason: the workspace reads it to decide
  // whether pinning and rearranging are offered at all, so calling it an
  // addressing detail a host needs only for its own URLs stopped being true.
  // Streaming progress: the surface renders when messages arrive rather than
  // animating the wait.
  "stage",
  "progress",
  // Per-request failure detail. `error` carries the visitor-facing summary and
  // `errorKind` is now read by the workspace's refusal handling; these two are
  // for a host that wants to log or surface *which* request failed and why.
  "issues",
  "failedRequests",
  // Deterministic refinement is implemented and routed, and no shipped UI
  // triggers it: model-driven revision covers what changes the answer, and
  // display ordering belongs to the component.
  "refine",
  "reset",
  // The pending state of a panel rearrangement's background write. Nothing
  // renders it deliberately: the whole point of keeping it off `busy` is that
  // an arrangement saving in the background must not disable the prompt or
  // gray out a control, so the workspace shows a spinner for it nowhere. A
  // host that wants "saving…" chrome of its own has it.
  "reordering",
]);

/**
 * Deadline for service calls that are not composing a view — saving, listing,
 * deleting. The compose ceiling exists to accommodate a model call and several
 * upstream fetches; applying it to a save means a dead service leaves a button
 * spinning for a minute and a half.
 */
const DEFAULT_SERVICE_TIMEOUT_MS = 15_000;

/** Ceiling on a service-supplied message before it reaches a visitor. */
const MAX_REASON_LENGTH = 300;

/**
 * How long after the last panel move before its `reorderNodes` refinement is
 * sent. Long enough that arrowing a panel three slots down is one write, short
 * enough that the arrangement is on the server before the visitor's attention
 * has moved on. Each refinement re-executes the plan's data, so coalescing is
 * about not re-fetching a view per keypress, not about request count.
 */
const REORDER_DEBOUNCE_MS = 400;

/**
 * Turns a failure into something safe to show a visitor.
 *
 * Only `unsupported` carries the service's own words through, because that
 * reason is written by the planner to explain what the catalog cannot answer
 * — the one case where the specific text helps. It is still capped and
 * stripped of newlines: it is model-generated text on its way to a screen, and
 * "the prompt biases it toward being safe" is a reason to expect good output,
 * not a reason to skip bounding it.
 *
 * Every other kind gets fixed copy. A visitor cannot act on
 * `/surfaces/0/nodes/0: must be equal to constant`, and showing it exposes
 * internals of the host's catalog to whoever typed a prompt.
 */
function visitorMessage(kind: ComposeFailureKind, reason: unknown): string {
  if (kind === "timeout") {
    return "This is taking longer than expected. Please try again.";
  }
  if (kind === "needs-clarification" && typeof reason === "string" && reason.trim()) {
    // The question itself, capped and stripped like the `unsupported` reason
    // for the same reason: it is model-generated text on its way to a screen.
    const clean = reason.replace(/\s+/g, " ").trim();
    return clean.length > MAX_REASON_LENGTH
      ? `${clean.slice(0, MAX_REASON_LENGTH - 1)}…`
      : clean;
  }
  if (kind === "auth") {
    // Deliberately not "try again": retrying an expired session produces the
    // same 401 indefinitely. A host with a login flow overrides this copy off
    // `errorKind` and sends them somewhere that can actually resolve it.
    return "Your session isn't valid for this. Please sign in and try again.";
  }
  if (kind === "unsupported" && typeof reason === "string" && reason.trim()) {
    const clean = reason.replace(/\s+/g, " ").trim();
    return clean.length > MAX_REASON_LENGTH
      ? `${clean.slice(0, MAX_REASON_LENGTH - 1)}…`
      : clean;
  }
  if (kind === "service-error") {
    // Not "try later": a refusal is deterministic and waiting changes nothing.
    // Not "rephrase" either — the request never got far enough for the wording
    // to be the problem. This one is for someone to fix, not the visitor.
    return "This view can't be built right now — this isn't about your question.";
  }
  if (kind === "network") {
    // Not "try again": the service is unreachable, and retrying into an
    // outage teaches the visitor the feature is flaky rather than down. The
    // copy owns the failure being on this side of the screen.
    return "The service isn't reachable right now — this isn't about your question. Please try later.";
  }
  if (kind === "data-unavailable") {
    // Not "rephrase": the plan was correct and the fetch failed, so different
    // wording produces the same request. Not "unreachable" either — the
    // service answered. The slots on screen carry the specific reasons.
    return "The data for this view couldn't be loaded just now. Please try again.";
  }
  if (kind === "visitor-identity-required") {
    // Not the visitor's problem and not retryable: the site never offered
    // this. Copy owns it rather than implying they did something wrong.
    return "Saved views aren't available on this site.";
  }
  if (kind === "invalid") {
    // The one failure where rephrasing genuinely helps: the model produced a
    // plan the validator refused, and different wording routes around it.
    // "Try again" alone reads as a transient fault and invites the same
    // words, which mostly reproduce the same plan.
    return "Couldn't build that view. Rephrasing the question often works — or try one of the suggestions.";
  }
  return "Couldn't build that view — please try again.";
}

/** Failure kinds the service names for itself, and this hook passes through. */
const SERVICE_FAILURE_KINDS: readonly string[] = [
  "unsupported",
  "invalid",
  "provider-error",
  "needs-clarification",
  "data-unavailable",
  "visitor-identity-required",
];

/**
 * Classifies a failed JSON response.
 *
 * The status code is read *first*, and beats whatever `kind` the body carries.
 * A 401 or 403 is produced by the transport layer — `UnauthenticatedError` from
 * the host's own `resolveSession`, or an admin route refusing the caller — and
 * those responses are `{ok: false, error}` with no `kind` at all. Reading the
 * body alone therefore classified every rejected credential as `network`, which
 * is the one kind whose copy tells the visitor to do the thing that cannot work.
 */
function failureKindFor(status: number, bodyKind: unknown): ComposeFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (typeof bodyKind === "string" && SERVICE_FAILURE_KINDS.includes(bodyKind)) {
    return bodyKind as ComposeFailureKind;
  }
  // A response reached us, so `network` is false by construction: a transport
  // failure never gets here, it calls `fail("network")` with no status at all.
  // Everything unrecognised used to land on `network` anyway, so a host whose
  // `resolveSession` threw a plain `Error` — a 400 saying "No session" — told
  // the visitor the service was unreachable while it was answering fine.
  //
  // 5xx keeps that copy: the server is faulting and "try later" is the right
  // advice. A 4xx is a refusal, and waiting will not change it.
  return status >= 500 ? "network" : "service-error";
}

/**
 * A failed service call, carrying the classification the response status
 * supports.
 *
 * The saved-view calls share one request helper that threw a plain `Error`, so
 * the status was read, formatted into a message, and then discarded. Reopening
 * a saved view with an expired session is the same problem as composing with
 * one, and it deserves the same answer rather than "Couldn't load saved views:
 * Not authenticated."
 */
class ServiceCallError extends Error {
  constructor(
    message: string,
    readonly kind: ComposeFailureKind,
  ) {
    super(message);
    this.name = "ServiceCallError";
  }
}

/**
 * The `/api/compose` request lifecycle shared by every entry point a host can
 * mount — `ViewLauncher`'s floating panel and `ViewWorkspace`'s
 * full page both need the same prompt state, the same timeout, and the same
 * "fail toward the host's own site staying usable" error handling. Extracted
 * so that behavior stays identical across entry points instead of drifting
 * as each gets modified independently.
 */
const ComposeSessionContext = createContext<ComposeState | undefined>(undefined);

/**
 * Shares one compose session with everything under it.
 *
 * State has to live above the surface, not inside whoever renders it. A host's
 * registered component — a table wanting to sort by a column header — is
 * rendered *inside* the composed view, so for its refine to affect the view it
 * belongs to, it must reach the same session the surface is rendering from.
 * With per-call `useState`, a component calling the hook would get its own
 * isolated state and nothing would happen.
 *
 * `ViewProvider` mounts this, so any descendant can call `useViewCompose()`.
 */
export function ComposeSessionProvider({ children }: { children: ReactNode }) {
  const session = useComposeSessionState();
  return (
    <ComposeSessionContext.Provider value={session}>
      {children}
    </ComposeSessionContext.Provider>
  );
}

/**
 * The compose session for the surrounding `ViewProvider`.
 *
 * Safe to call from a registered host component: it returns the same session
 * the visible surface came from, so `refine` re-renders what they are looking
 * at rather than a private copy.
 */
export function useViewCompose(): ComposeState {
  return useSession("useViewCompose");
}

/**
 * The saved-view half of the session: keeping, listing, reopening, pinning.
 *
 * Reads the same session as `useViewCompose`, so what it saves is the view on
 * screen. Takes no `planId` argument on purpose: the session already knows
 * which plan is rendered, and accepting one would let a caller save a plan the
 * visitor is not looking at — a request the server would refuse anyway, since
 * every plan-addressed call is an ownership check.
 */
export function useSavedViews(): SavedViewsState {
  const session = useSession("useSavedViews");
  const { save, pin, listSaved, reopen, deleteSaved, staleReason } = session;
  return { save, pin, listSaved, reopen, deleteSaved, staleReason };
}

/**
 * The panel-arrangement half of the session.
 *
 * Separate so chrome can offer pinning without inheriting drag-to-rearrange,
 * which is what a single 26-field hook made unavoidable.
 */
export function usePanelOrder(): PanelOrderState {
  const { reorderPanels, reordering } = useSession("usePanelOrder");
  return { reorderPanels, reordering };
}

function useSession(caller: string): ComposeState {
  const session = useContext(ComposeSessionContext);
  if (!session) {
    // Named after the hook the caller actually used: "useViewCompose must be
    // used inside a ViewProvider" is a confusing thing to read when you called
    // useSavedViews.
    throw new Error(`${caller} must be used inside a ViewProvider`);
  }
  return session;
}

function useComposeSessionState(): ComposeState {
  const { config } = useView();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<ComposeFailureKind | null>(null);
  /**
   * The server's own whole-request budget, once it has told us.
   *
   * Held rather than configured: the number belongs to the server, and a
   * constant on this side that disagrees is how a 43s response was discarded
   * by a client that stopped listening at 40. Read on the *next* request,
   * which is the earliest a batch caller can act on it.
   */
  const serverDeadlineMs = useRef<number | null>(null);
  const [clarification, setClarification] = useState<
    { question: string; options?: readonly string[] } | null
  >(null);
  /**
   * The prompt the outstanding question is about.
   *
   * Held separately from `prompt` because the visitor may type over the box
   * while the question is on screen, and answering has to send what they
   * originally asked — an answer attached to a different question composes
   * something neither of them meant.
   */
  const askedAbout = useRef<string | null>(null);
  const [issues, setIssues] = useState<readonly { path: string; message: string }[]>([]);
  const [messages, setMessages] = useState<readonly A2uiMessage[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [stream, setStream] = useState<ComposeStreamState>(initialComposeStreamState);

  /**
   * Per-request failures from a batch-shaped response.
   *
   * A streamed compose fills `failedRequests` from TOOL_CALL_END events, and
   * that was the only writer — so a plain-JSON compose, a refine, or a reopen
   * with `requests: [{ok: false, error}]` in its body reported nothing: the
   * caller saw a slot in its error state and `failedRequests` empty, and the
   * real reason (already classified safe by the executor) never reached them.
   * Every batch path now projects the response's own request summaries.
   */
  function applyRequestSummaries(requests: unknown) {
    if (!Array.isArray(requests)) return;
    const failed: Record<string, string> = {};
    for (const entry of requests) {
      if (typeof entry !== "object" || entry === null) continue;
      const summary = entry as { requestId?: unknown; ok?: unknown; error?: unknown };
      if (summary.ok === false && typeof summary.requestId === "string") {
        failed[summary.requestId] =
          typeof summary.error === "string" && summary.error.length > 0
            ? summary.error
            : "Request failed.";
      }
    }
    setStream((current) => ({ ...current, failedRequests: failed }));
  }
  const [staleReason, setStaleReason] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  // Latest-value mirrors for the reorder machinery, which runs from timers and
  // therefore cannot trust the closures of whichever render armed them: a
  // chained reorder must send the planId the *previous* write returned, not
  // the one on screen when the drag started.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const planIdRef = useRef(planId);
  planIdRef.current = planId;

  /**
   * Everything a coalesced reorder write needs to survive re-renders.
   *
   * `serverOrder` is the panel order the server last delivered (captured just
   * before the first local move, cleared whenever a server response replaces
   * `messages`), so a drag that ends where it started writes nothing.
   * `target` is the order the visitor currently wants persisted. `generation`
   * increments whenever the view itself is replaced — a response from a write
   * against a plan nobody is looking at any more must be discarded, not
   * adopted over the new view.
   */
  const reorder = useRef({
    serverOrder: null as readonly string[] | null,
    target: null as readonly string[] | null,
    timer: null as ReturnType<typeof setTimeout> | null,
    resolvers: [] as ((ok: boolean) => void)[],
    inFlight: false,
    generation: 0,
  });
  useEffect(
    () => () => {
      if (reorder.current.timer) clearTimeout(reorder.current.timer);
    },
    [],
  );

  const sameOrder = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  /**
   * Abandons any pending or in-flight reorder write. Called when the view it
   * would have arranged is being replaced (a new compose, a reopen, a reset):
   * the arrangement belonged to that view, and firing its write afterwards
   * would refine a plan the visitor has left.
   */
  function clearPendingReorder() {
    const state = reorder.current;
    state.generation += 1;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.target = null;
    state.serverOrder = null;
    for (const resolve of state.resolvers.splice(0)) resolve(false);
    setReordering(false);
  }

  /**
   * A failure that is not about building a view.
   *
   * Saving, listing and deleting go through here rather than `fail`, because
   * `fail` maps every kind onto compose copy — a failed save reported through it
   * told the visitor "Couldn't build that view", which is both wrong and
   * confusing when the view is sitting right there on screen. `errorKind` stays
   * null: there is no compose failure to classify, the same as the
   * minimum-length check above.
   */
  function failWithText(text: string) {
    setErrorKind(null);
    setError(text);
    setIssues([]);
  }

  /**
   * Reports a failed saved-view call, keeping the one classification that
   * changes what the visitor should do about it.
   *
   * A rejected credential gets the shared `auth` copy and sets `errorKind`, so
   * a host can send them to a login. Everything else keeps its specific
   * sentence — "Couldn't delete that view" is more use than a generic failure —
   * and leaves `errorKind` null, because these are not compose failures.
   */
  function failFromService(cause: unknown, sentence: string) {
    if (cause instanceof ServiceCallError && cause.kind === "auth") {
      fail("auth", undefined);
      return;
    }
    failWithText(
      cause instanceof Error ? `${sentence}: ${cause.message}` : `${sentence}.`,
    );
  }

  function fail(
    kind: ComposeFailureKind,
    reason: unknown,
    detail?: unknown,
    asked?: { question?: unknown; options?: unknown },
  ) {
    setErrorKind(kind);
    setError(visitorMessage(kind, reason));
    setIssues(
      Array.isArray(detail) ? (detail as { path: string; message: string }[]) : [],
    );
    // Only ever set from a response that actually carried a question. Deriving
    // it from `kind` alone would put an empty question box on screen the moment
    // a service reported the kind without the field.
    const question =
      typeof asked?.question === "string" && asked.question.trim()
        ? asked.question.trim()
        : undefined;
    if (kind === "needs-clarification" && question) {
      const options = Array.isArray(asked?.options)
        ? (asked.options as unknown[]).filter(
            (option): option is string => typeof option === "string",
          )
        : undefined;
      setClarification({
        question,
        ...(options && options.length > 0 ? { options } : {}),
      });
    } else {
      setClarification(null);
    }
  }

  async function submit(
    options: {
      revise?: boolean;
      /**
       * A suggestion chip submits its own text in one click; state alone
       * can't, because setPrompt hasn't landed by the time submit reads it.
       * Unlike `promptOverride`, the text also lands in the prompt box.
       */
      prompt?: string;
      /**
       * Composes this text instead of the prompt box. Used only by
       * `answerClarification`, which must send the question's original prompt —
       * the visitor may have typed over the box while the question was up, and
       * an answer attached to a different request composes something neither of
       * them meant. Not part of `ComposeState["submit"]`.
       */
      promptOverride?: string;
      answersClarification?: boolean;
    } = {},
  ) {
    if (options.prompt !== undefined) setPrompt(options.prompt);
    const text = (options.promptOverride ?? options.prompt ?? prompt).trim();
    if (text.length < 3) {
      setError("Enter at least 3 characters.");
      setErrorKind(null);
      return;
    }
    setBusy(true);
    setError(null);
    setErrorKind(null);
    setIssues([]);
    // Cleared before the request, not after it: leaving the old question on
    // screen while a new compose runs invites answering it twice.
    setClarification(null);
    // A pending arrangement write belongs to the view this compose replaces.
    clearPendingReorder();
    askedAbout.current = text;
    const timeoutController = new AbortController();
    const timeoutMs =
      config.composeTimeoutMs ??
      (serverDeadlineMs.current === null
        ? DEFAULT_COMPOSE_TIMEOUT_MS
        : serverDeadlineMs.current + DEADLINE_GRACE_MS);
    let timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    try {
      const authHeaders = (await config.getAuthHeaders?.()) ?? {};
      const streaming = config.stream !== false;
      const response = await fetch(
        `${config.serviceUrl.replace(/\/$/, "")}/api/compose`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // The server answers with whichever the caller asked for; a server
            // that predates streaming ignores this and returns JSON, which the
            // branch below still handles.
            ...(streaming ? { accept: "text/event-stream" } : {}),
            ...authHeaders,
          },
          credentials: "include",
          body: JSON.stringify({
            catalogId: config.catalogId,
            uiCatalogId: config.uiCatalogId,
            prompt: text,
            // Only when the caller asked for a revision *and* there is a view
            // to revise. Sending a stale id after a reset would revise a plan
            // the visitor can no longer see.
            ...(options.revise && planId ? { previousPlanId: planId } : {}),
            ...(options.answersClarification ? { answersClarification: true } : {}),
          }),
          signal: timeoutController.signal,
        },
      );
      if (
        response.ok &&
        response.body &&
        (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ) {
        // Each event is a sign of life, so the deadline is on silence rather
        // than on the run: a compose that is still delivering slots should not
        // be cut off for taking longer than a fixed budget, and one that has
        // stalled should not be waited on for the rest of that budget.
        const streamed = await readComposeStream(response.body, {
          onEvent: () => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
          },
          onState: (next) => {
            setStream(next);
            if (next.messages.length > 0) setMessages(next.messages as A2uiMessage[]);
            if (next.planId) setPlanId(next.planId);
          },
        });
        if (streamed.failure) {
          // A stream only opens on a 2xx, so there is no status left to read:
          // whatever this is, it happened after the credential was accepted.
          const kind = failureKindFor(response.status, streamed.failure.kind);
          fail(kind, streamed.failure.reason, streamed.failure.issues, streamed.failure);
        } else if (!streamed.finished) {
          // The connection dropped mid-run. Whatever rendered stays on screen;
          // silently treating this as success would report a partial view as
          // complete.
          fail("network", undefined);
        }
        return;
      }

      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) {
        const kind = failureKindFor(response.status, payload?.kind);
        fail(kind, payload?.reason ?? payload?.error, payload?.issues, payload);
        // A failure can still carry a view worth showing: a revision that fell
        // back to what the visitor already had (`fellBack`), or a compose whose
        // every slot errored (`data-unavailable`), where the view *is* the
        // per-slot explanation. The rule is the payload, not the kind — if the
        // server sent messages, it sent them to be rendered.
        if (Array.isArray(payload.messages)) {
          setMessages(payload.messages as A2uiMessage[]);
          // The fallback is a real, addressable plan — refining or saving from
          // here acts on the view actually on screen, not the one that failed.
          if (typeof payload.planId === "string") setPlanId(payload.planId);
        }
        return;
      }
      if (!Array.isArray(payload.messages)) {
        fail("network", undefined);
        return;
      }
      setMessages(payload.messages as A2uiMessage[]);
      if (typeof payload.planId === "string") setPlanId(payload.planId);
      if (typeof payload.deadlineMs === "number") serverDeadlineMs.current = payload.deadlineMs;
      applyRequestSummaries(payload.requests);
    } catch (cause) {
      // Fail toward the host's own site staying usable: surface the problem,
      // never replace the page with an error state.
      //
      // `messages` is deliberately left alone. Clearing it used to wipe a
      // working view every time a *later* prompt failed — the visitor lost
      // what they had as a side effect of asking for something else. The error
      // renders above whatever is still on screen instead.
      const timedOut = cause instanceof Error && cause.name === "AbortError";
      fail(timedOut ? "timeout" : "network", undefined);
    } finally {
      clearTimeout(timeoutId);
      setBusy(false);
    }
  }

  /**
   * Applies plan edits without a model call.
   *
   * The whole point of the plan artifact: sorting a column or removing a block
   * is a deterministic edit to something already validated, so it costs no
   * tokens and no latency beyond re-fetching data. The server still
   * re-validates every operation against the approved catalog, because these
   * arrive from a browser — a refinement can rearrange what a visitor has, and
   * cannot widen it.
   */
  async function refine(operations: readonly RefineOperation[]) {
    if (!planId || operations.length === 0) return;
    setBusy(true);
    setError(null);
    setErrorKind(null);
    setIssues([]);
    const timeoutController = new AbortController();
    const timeoutMs =
      config.composeTimeoutMs ??
      (serverDeadlineMs.current === null
        ? DEFAULT_COMPOSE_TIMEOUT_MS
        : serverDeadlineMs.current + DEADLINE_GRACE_MS);
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    try {
      const authHeaders = (await config.getAuthHeaders?.()) ?? {};
      const response = await fetch(`${config.serviceUrl.replace(/\/$/, "")}/api/refine`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        credentials: "include",
        body: JSON.stringify({
          catalogId: config.catalogId,
          uiCatalogId: config.uiCatalogId,
          planId,
          operations,
        }),
        signal: timeoutController.signal,
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) {
        const kind = failureKindFor(response.status, payload?.kind);
        // The previous view stays on screen. A rejected sort is a reason to
        // tell someone the sort did not apply, not to take their table away.
        fail(kind, payload?.reason ?? payload?.error, payload?.issues);
        return;
      }
      if (!Array.isArray(payload.messages)) {
        fail("network", undefined);
        return;
      }
      // The response carries the server's panel order, which — if a reorder
      // is still waiting to be written — is *older* than the arrangement on
      // screen. Re-apply the pending order on top rather than snapping the
      // panels back for the duration of the debounce; the pending write then
      // persists it against this refinement's new planId.
      const pendingOrder = reorder.current.target;
      setMessages(
        pendingOrder
          ? (withPanelOrder(
              payload.messages as A2uiMessage[],
              pendingOrder,
            ) as A2uiMessage[])
          : (payload.messages as A2uiMessage[]),
      );
      reorder.current.serverOrder = null;
      // A refinement produces a new plan, so chaining refines builds on the
      // latest view rather than repeatedly re-refining the original.
      if (typeof payload.planId === "string") setPlanId(payload.planId);
      applyRequestSummaries(payload.requests);
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "AbortError";
      fail(timedOut ? "timeout" : "network", undefined);
    } finally {
      clearTimeout(timeoutId);
      setBusy(false);
    }
  }

  /**
   * The background half of `reorderPanels`: one `reorderNodes` refinement for
   * the most recent order, sent after the debounce window closes.
   *
   * Not routed through `refine()` on purpose — that path sets `busy`, maps
   * failures onto compose copy, and adopts responses unconditionally. This one
   * must do none of those: the view already shows the right arrangement, so
   * the only user-visible outcomes are "persisted silently" and "kept on
   * screen but reported as unsaved".
   */
  async function flushReorder(): Promise<void> {
    const state = reorder.current;
    state.timer = null;
    if (state.inFlight) return; // the in-flight completion reschedules
    const target = state.target;
    if (!target) {
      setReordering(false);
      return;
    }
    if (state.serverOrder && sameOrder(state.serverOrder, target)) {
      // Moved and moved back within one debounce window — the server already
      // has this order, so there is nothing to write.
      state.target = null;
      for (const resolve of state.resolvers.splice(0)) resolve(true);
      setReordering(false);
      return;
    }
    const currentPlanId = planIdRef.current;
    if (!currentPlanId) {
      state.target = null;
      for (const resolve of state.resolvers.splice(0)) resolve(false);
      setReordering(false);
      failWithText("This arrangement won't be saved — there is no composed view yet.");
      return;
    }
    state.inFlight = true;
    const generation = state.generation;
    const waiting = state.resolvers.splice(0);
    try {
      const payload = await callService(
        "/api/refine",
        {
          catalogId: config.catalogId,
          uiCatalogId: config.uiCatalogId,
          planId: currentPlanId,
          operations: [{ kind: "reorderNodes", nodeIds: target }],
        },
        // A reorder re-executes the plan's data, so it gets the compose
        // deadline rather than the short service one — same reason `reopen`
        // passes it explicitly.
        { timeoutMs: config.composeTimeoutMs ?? DEFAULT_COMPOSE_TIMEOUT_MS },
      );
      if (reorder.current.generation !== generation) {
        // The view was replaced while this was in flight; the response
        // describes a plan nobody is looking at any more.
        for (const resolve of waiting) resolve(false);
        return;
      }
      if (typeof payload.planId === "string") setPlanId(payload.planId);
      if (Array.isArray(payload.messages)) {
        const served = payload.messages as A2uiMessage[];
        const latest = reorder.current.target;
        if (latest && !sameOrder(latest, target)) {
          // The visitor kept moving while the request ran. The response is
          // server truth for the order it was asked, so adopt it underneath
          // and keep the newer arrangement on top — the rescheduled write in
          // the finally block persists it.
          setMessages(withPanelOrder(served, latest) as A2uiMessage[]);
        } else {
          setMessages(served);
          reorder.current.target = null;
        }
      } else if (reorder.current.target && sameOrder(reorder.current.target, target)) {
        reorder.current.target = null;
      }
      reorder.current.serverOrder = [...target];
      for (const resolve of waiting) resolve(true);
    } catch (cause) {
      if (reorder.current.generation === generation) {
        // The local order stays exactly where the visitor put it — snapping
        // panels back under their hands would trade a failed save for a
        // broken screen. The copy names what was actually lost: persistence.
        failFromService(cause, "This arrangement won't be saved");
        if (reorder.current.target && sameOrder(reorder.current.target, target)) {
          reorder.current.target = null;
        }
      }
      for (const resolve of waiting) resolve(false);
    } finally {
      state.inFlight = false;
      if (reorder.current.generation === generation) {
        if (reorder.current.target) {
          reorder.current.timer = setTimeout(
            () => void flushReorder(),
            REORDER_DEBOUNCE_MS,
          );
        } else {
          setReordering(false);
        }
      }
    }
  }

  function reorderPanels(nodeIds: readonly string[]): Promise<boolean> {
    const current = topLevelPanelIds(messagesRef.current);
    if (
      current.length < 2 ||
      nodeIds.length !== current.length ||
      [...nodeIds].sort().join(" ") !== [...current].sort().join(" ")
    ) {
      // Not a permutation of the panels on screen — a stale order must not
      // resurrect a removed panel or drop a live one.
      return Promise.resolve(false);
    }
    const state = reorder.current;
    // The order on screen right now is server truth until the first local
    // move: `serverOrder` is null whenever a server response last set
    // `messages`, so capturing here — before the move applies — records what
    // the server actually has.
    if (state.serverOrder === null) state.serverOrder = current;
    setError(null);
    setErrorKind(null);
    // Phase one: the screen, immediately and locally. The compiled root's
    // children are the panel order, so reordering them *is* the move — no
    // network, no plan, no waiting.
    setMessages((previous) => withPanelOrder(previous, nodeIds) as A2uiMessage[]);
    state.target = [...nodeIds];
    setReordering(true);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void flushReorder(), REORDER_DEBOUNCE_MS);
    return new Promise((resolve) => state.resolvers.push(resolve));
  }

  function reset() {
    // The URL named a view the visitor has now left. Leaving it there means a
    // reload silently reopens what they cleared, and a copied link points at
    // something other than what is on screen.
    clearSavedViewParam(config);
    // Any arrangement write still pending belongs to the view being cleared.
    clearPendingReorder();
    setMessages([]);
    setPlanId(null);
    setError(null);
    setErrorKind(null);
    setClarification(null);
    askedAbout.current = null;
    setIssues([]);
    setStaleReason(null);
    setPrompt("");
    // Progress and per-slot failures belong to the run that produced them.
    // Leaving them would show the next composition starting out with the last
    // one's failed slots.
    setStream(initialComposeStreamState);
  }

  /**
   * One POST to the service, with the host's auth headers and an abort deadline.
   *
   * Saved-view calls do not build a view, so they get the shorter deadline: the
   * long one exists for compose, where a model call and several upstream fetches
   * happen behind the request. `reopen` is the exception — it re-executes the
   * plan's data — and passes the compose deadline explicitly.
   */
  async function callService(
    path: string,
    body: unknown,
    options: { method?: "GET" | "POST"; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS,
    );
    try {
      const authHeaders = (await config.getAuthHeaders?.()) ?? {};
      const response = await fetch(`${config.serviceUrl.replace(/\/$/, "")}${path}`, {
        method: options.method ?? "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        credentials: "include",
        ...(options.method === "GET" ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok || payload.ok !== true) {
        throw new ServiceCallError(
          typeof payload.reason === "string"
            ? payload.reason
            : typeof payload.error === "string"
              ? payload.error
              : `Request to ${path} failed (${response.status})`,
          failureKindFor(response.status, payload.kind),
        );
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Answers the outstanding question and composes again.
   *
   * Sends the original prompt with the exchange appended rather than the answer
   * alone: "the last 30 days" is not a request, and the planner would have to
   * reconstruct what it was an answer to. `answersClarification` removes the
   * question branch from the contract for this call, so the model cannot ask
   * again and leave the visitor in a loop.
   */
  async function answerClarification(answer: string): Promise<void> {
    const question = clarification?.question;
    const original = askedAbout.current;
    if (!question || !original || !answer.trim()) return;
    await submit({
      promptOverride: `${original}\n\nYou asked: ${question}\nThe answer is: ${answer.trim()}`,
      answersClarification: true,
    });
  }

  async function save(label?: string): Promise<{ ok: boolean; viewId?: string }> {
    if (!planId) {
      failWithText("There is no view to save yet.");
      return { ok: false };
    }
    setBusy(true);
    setError(null);
    setErrorKind(null);
    try {
      const payload = await callService("/api/views", {
        catalogId: config.catalogId,
        planId,
        ...(label ? { label } : {}),
      });
      const viewId = typeof payload.viewId === "string" ? payload.viewId : undefined;
      // Saving and reopening both worked; neither had an address, so a visitor
      // could keep a view and not return to it. Written with replaceState
      // rather than pushState: saving is not navigation, and a Back button that
      // undoes a save would be lying about what it does.
      if (viewId) writeSavedViewParam(config, viewId);
      return { ok: true, ...(viewId ? { viewId } : {}) };
    } catch (cause) {
      failFromService(cause, "Couldn't save this view");
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  async function pin(
    nodeId: string,
    label?: string,
  ): Promise<{ ok: boolean; viewId?: string }> {
    if (!planId) {
      failWithText("There is no view to pin from yet.");
      return { ok: false };
    }
    setBusy(true);
    setError(null);
    setErrorKind(null);
    try {
      const payload = await callService("/api/views", {
        catalogId: config.catalogId,
        planId,
        nodeIds: [nodeId],
        ...(label ? { label } : {}),
      });
      const viewId = typeof payload.viewId === "string" ? payload.viewId : undefined;
      // Deliberately no `writeSavedViewParam` here, unlike `save`: the page is
      // still showing the full view, and stamping the pin's id onto the URL
      // would make a reload (or a copied link) open one panel where the
      // visitor had many.
      return { ok: true, ...(viewId ? { viewId } : {}) };
    } catch (cause) {
      failFromService(cause, "Couldn't pin this panel");
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  // Reopens the view named in the URL, once, on first mount. A load with the
  // parameter present is a request for that view, not for an empty prompt.
  const openedFromUrl = useRef(false);
  useEffect(() => {
    if (openedFromUrl.current) return;
    const viewId = readSavedViewParam(config);
    if (!viewId) return;
    openedFromUrl.current = true;
    void reopen(viewId);
    // Empty deps deliberately: `config` is read for the parameter name only,
    // and re-running on an unrelated config change would reopen the view over
    // whatever the visitor has since composed.
  }, []);

  async function listSaved(
    options: { silent?: boolean } = {},
  ): Promise<readonly SavedViewSummary[]> {
    // Deliberately does not set `busy`: this populates a menu, and disabling the
    // prompt while a list loads would make the page feel broken.
    try {
      const payload = await callService("/api/views", undefined, { method: "GET" });
      return Array.isArray(payload.views) ? (payload.views as SavedViewSummary[]) : [];
    } catch (cause) {
      // A prefetch on mount is not something the visitor asked for, and
      // reporting its failure puts an error in front of someone who has done
      // nothing yet — which is exactly what a host mounting this page saw. An
      // empty menu is the correct rendering of "no list available"; a red
      // message is not. An explicit "show my saved views" click passes no
      // `silent`, and does report.
      if (!options.silent) {
        failFromService(cause, "Couldn't load saved views");
      }
      return [];
    }
  }

  async function reopen(viewId: string) {
    setBusy(true);
    setError(null);
    setErrorKind(null);
    setIssues([]);
    setStaleReason(null);
    // The reopened view replaces whatever a pending arrangement write was for.
    clearPendingReorder();
    try {
      const payload = await callService(
        "/api/views/reopen",
        { viewId },
        { timeoutMs: config.composeTimeoutMs ?? DEFAULT_COMPOSE_TIMEOUT_MS },
      );
      if (!Array.isArray(payload.messages)) {
        fail("network", undefined);
        return;
      }
      setMessages(payload.messages as A2uiMessage[]);
      if (typeof payload.planId === "string") setPlanId(payload.planId);
      applyRequestSummaries(payload.requests);
      // Rendered, but against a catalog or component set that has moved. The
      // host decides how loudly to say so; without this it would present an
      // older answer as current.
      if (payload.stale === true && typeof payload.staleReason === "string") {
        setStaleReason(payload.staleReason);
      }
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "AbortError";
      const kind: ComposeFailureKind = timedOut
        ? "timeout"
        : cause instanceof ServiceCallError
          ? cause.kind
          : "network";
      fail(kind, kind === "network" && cause instanceof Error ? cause.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSaved(viewId: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setErrorKind(null);
    try {
      await callService("/api/views/delete", { viewId });
      return true;
    } catch (cause) {
      failFromService(cause, "Couldn't delete that view");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const envelope = useMemo(() => renderYesEnvelope(messages), [messages]);

  return {
    requests: envelope.requests,
    nodeBindings: envelope.nodeBindings,
    prompt,
    setPrompt,
    busy,
    error,
    errorKind,
    clarification,
    answerClarification,
    issues,
    messages,
    planId,
    revise: () => submit({ revise: true }),
    startOver: reset,
    stage: stream.stage,
    progress: stream.progress,
    failedRequests: stream.failedRequests,
    submit,
    refine,
    reorderPanels,
    reordering,
    reset,
    save,
    pin,
    listSaved,
    reopen,
    deleteSaved,
    staleReason,
  };
}

/**
 * Reads the `__renderyes` envelope out of the current messages.
 *
 * From the messages rather than from a state writer on each transport path:
 * stream, batch, refine, revise and reopen all end by replacing the message
 * set, so a derivation over messages cannot go stale or miss a path — the
 * exact failure mode that left `failedRequests` empty on three of five paths
 * before `applyRequestSummaries`.
 */
function renderYesEnvelope(messages: readonly A2uiMessage[]): {
  requests: ComposedRequestSummary[];
  nodeBindings: ComposedNodeBinding[];
} {
  for (const message of messages) {
    const update = (message as { updateDataModel?: { path?: string; value?: unknown } })
      .updateDataModel;
    if (!update || update.path !== "/") continue;
    const envelope = (update.value as { __renderyes?: unknown } | undefined)
      ?.__renderyes as
      | { requests?: unknown; nodes?: unknown }
      | undefined;
    if (!envelope) continue;
    const requests: ComposedRequestSummary[] = [];
    if (Array.isArray(envelope.requests)) {
      for (const entry of envelope.requests) {
        const summary = entry as {
          requestId?: unknown;
          capabilityId?: unknown;
          state?: unknown;
        };
        if (
          typeof summary.requestId === "string" &&
          typeof summary.capabilityId === "string"
        ) {
          requests.push({
            requestId: summary.requestId,
            capabilityId: summary.capabilityId,
            state: typeof summary.state === "string" ? summary.state : "unknown",
          });
        }
      }
    }
    const nodeBindings: ComposedNodeBinding[] = [];
    if (Array.isArray(envelope.nodes)) {
      for (const entry of envelope.nodes) {
        const node = entry as {
          nodeId?: unknown;
          componentId?: unknown;
          bindings?: unknown;
        };
        if (typeof node.nodeId === "string" && typeof node.componentId === "string") {
          nodeBindings.push({
            nodeId: node.nodeId,
            componentId: node.componentId,
            bindings:
              typeof node.bindings === "object" && node.bindings !== null
                ? (node.bindings as ComposedNodeBinding["bindings"])
                : {},
          });
        }
      }
    }
    return { requests, nodeBindings };
  }
  return { requests: [], nodeBindings: [] };
}

const DEFAULT_SAVED_VIEW_PARAM = "iv";

/**
 * The saved-view id in the current URL, if the host wants one there.
 *
 * Guarded on `window` because this module is imported by server-side renders,
 * where reading `location` throws and a saved view has no meaning yet.
 */
function readSavedViewParam(config: ViewConfig): string | undefined {
  if (config.savedViewParam === false) return undefined;
  if (typeof window === "undefined") return undefined;
  const name = config.savedViewParam ?? DEFAULT_SAVED_VIEW_PARAM;
  const value = new URLSearchParams(window.location.search).get(name);
  return value && value.length > 0 ? value : undefined;
}

function clearSavedViewParam(config: ViewConfig): void {
  if (config.savedViewParam === false) return;
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const name = config.savedViewParam ?? DEFAULT_SAVED_VIEW_PARAM;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(name)) return;
  url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", url.toString());
}

function writeSavedViewParam(config: ViewConfig, viewId: string): void {
  if (config.savedViewParam === false) return;
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const name = config.savedViewParam ?? DEFAULT_SAVED_VIEW_PARAM;
  const url = new URL(window.location.href);
  url.searchParams.set(name, viewId);
  window.history.replaceState(window.history.state, "", url.toString());
}
