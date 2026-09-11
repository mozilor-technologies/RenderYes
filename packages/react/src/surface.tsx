import { A2uiSurface } from "@a2ui/react/v0_9";
import { MessageProcessor, type A2uiMessage } from "@a2ui/web_core/v0_9";
import { Component, useMemo, type ErrorInfo, type ReactNode } from "react";
import { RenderBoundary } from "./isolated-view.js";
import { useChromeOptions, useChromeState } from "./chrome-state.js";
import { SurfacePanels, panelHeading, topLevelPanelIds } from "./panels.js";
import { useView } from "./provider.js";
import { usePanelOrder, useSavedViews, useViewCompose } from "./use-compose.js";

const ERROR_STYLE = { color: "#b42318", fontSize: 13, margin: 0 } as const;

/**
 * Contains a render-time failure inside a composed view.
 *
 * RenderYes renders inside someone else's site, and a host component that
 * throws while rendering takes down every React tree above it — meaning a bad
 * plan, or one registered component with a bug, blanks the host's own page.
 * That is the worst possible failure mode for an embedded widget: the site
 * owner's product breaks because a visitor asked a question.
 *
 * A class component because this is the one thing hooks still cannot express.
 *
 * Exported for `SurfacePanels`, which renders host components without going
 * through `ViewSurface` and needs the identical containment — not part of the
 * package's public API (`index.ts` deliberately does not re-export it).
 */
export class SurfaceErrorBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Logged as well as displayed: the visible message is deliberately short,
    // and a host debugging its own component needs the stack.
    console.error("[renderyes] surface render failed", error, info.componentStack);
  }

  render() {
    if (this.state.message !== null) {
      return (
        <p role="alert" style={ERROR_STYLE}>
          Could not render this result: {this.state.message}
        </p>
      );
    }
    return this.props.children;
  }
}

/**
 * Renders a composed view from the message stream the service returned.
 *
 * The host never constructs a MessageProcessor or reasons about A2UI surfaces;
 * it hands over messages and gets a rendered view built entirely from its own
 * registered components.
 */
export interface ViewSurfaceProps {
  /**
   * The messages to render. Defaults to the surrounding session's, so a host
   * composing their own layout does not have to thread them through — the
   * session already holds the view on screen.
   *
   * Still accepted explicitly, because a host rendering a surface from
   * something other than the live session (a stored plan, a test fixture) is a
   * real case and the primitive should stay usable for it.
   */
  messages?: readonly A2uiMessage[];
  /**
   * Renders each top-level panel in its own wrapper, with a pin and a drag
   * grip, when the view's shape and the host's chrome options support it.
   *
   * This was an `if/else` at the call site between `SurfacePanels` and this
   * component, so pinning was a feature a host got only by knowing that the
   * other component existed. Now it is one prop on the component they already
   * render, and the conditions for it — a plan to refine, at least one panel,
   * saved views enabled — are decided here rather than restated by every
   * caller.
   *
   * Off by default, so that mounting a bare `ViewSurface` renders exactly what
   * it always has. The packaged chrome passes `true`.
   */
  panels?: boolean;
}

/**
 * Renders a composed view.
 *
 * The panelled and plain forms are one component on purpose. They were
 * siblings, chosen between by whoever rendered them, which meant the decision
 * lived in every call site and pinning was available only from the one that
 * knew to ask.
 */
export function ViewSurface({ messages: given, panels = false }: ViewSurfaceProps) {
  const session = useViewCompose();
  const messages = given ?? session.messages;
  const { catalog, config } = useView();
  // `messages` is fully replaced (not appended to) on every `/api/compose`
  // response — see `submit()` in use-compose.ts, which calls `setMessages(...)`
  // with the new response's whole array, never accumulates. Each submission is
  // therefore an independent surface tree starting from its own
  // `createSurface`, not a continuation of the previous one. Reusing one
  // processor across submissions made a second "Go" click's fresh
  // `createSurface` hit a processor that already had that surface registered,
  // throwing `A2uiStateError: Surface main already exists` and crashing the
  // tree (no error boundary catches it). So: one processor per message set.
  //
  // Derived in `useMemo` rather than held in state deliberately. The earlier
  // state-plus-effect version re-derived `surfaces` into a new array whenever
  // the `messages` *reference* changed, so a host rendering
  // `<ViewSurface messages={[...x]} />` — a fresh array literal each render —
  // drove setState → re-render → new reference → setState in an unbounded
  // loop. With no state there is nothing to loop on: an unstable reference
  // costs a recomputation and nothing worse, while a genuine resubmission
  // still gets its own processor.
  //
  // Processing is caught rather than allowed to throw out of render: an error
  // boundary cannot help here, because a `useMemo` that throws does so while
  // *this* component renders, and a boundary only catches what its children
  // throw. A malformed or unexpected message stream is a service-side problem
  // the host should see reported, not a reason to unmount the page.
  const { surfaces, processError } = useMemo(() => {
    if (messages.length === 0) return { surfaces: [], processError: null };
    try {
      const processor = new MessageProcessor([catalog]);
      processor.processMessages([...messages]);
      return {
        surfaces: Array.from(processor.model.surfacesMap.values()),
        processError: null,
      };
    } catch (cause) {
      return {
        surfaces: [],
        processError:
          cause instanceof Error ? cause.message : "Could not read the composed result.",
      };
    }
  }, [catalog, messages]);

  if (processError !== null) {
    return (
      <RenderBoundary mode={config.renderMode ?? "isolated"} styles={config.styles}>
        <p role="alert" style={ERROR_STYLE}>
          {processError}
        </p>
      </RenderBoundary>
    );
  }
  if (surfaces.length === 0) return null;
  // Honours `renderMode` here rather than only in `ViewLauncher`/`ViewWorkspace`.
  // This is the primitive a host uses when building its own native UI — the
  // a host page composes with `useViewCompose` + `ViewSurface` and
  // nothing else — so leaving the boundary to the packaged chrome meant a host
  // that configured `renderMode: "isolated"` and rendered a surface directly
  // silently got no isolation at all.
  return (
    <RenderBoundary mode={config.renderMode ?? "isolated"} styles={config.styles}>
      <SurfaceErrorBoundary>
        {panels ? (
          <PanelledSurface messages={messages} />
        ) : (
          surfaces.map((surface) => <A2uiSurface key={surface.id} surface={surface} />)
        )}
      </SurfaceErrorBoundary>
    </RenderBoundary>
  );
}

/**
 * The panelled form: one wrapper per top-level panel, each with its controls.
 *
 * Its own component so the hooks it needs — the session, the chrome state —
 * are not paid for by every plain `ViewSurface`, and so `panels={false}` is
 * genuinely the same work it was before this existed.
 */
function PanelledSurface({ messages }: { messages: readonly A2uiMessage[] }) {
  const { busy, planId } = useViewCompose();
  const { pin } = useSavedViews();
  const { reorderPanels } = usePanelOrder();
  const { savedViewsEnabled, rearrangeEnabled } = useChromeOptions();
  const { confirmPinned } = useChromeState();
  const panelIds = useMemo(() => topLevelPanelIds(messages), [messages]);

  // Pinning needs a plan to pin and something to pin. Deliberately NOT gated on
  // having several panels: pinning the only one produces the same view Save
  // would, but hiding the control there teaches that pinning is unavailable
  // rather than redundant — the first reader of a one-panel view went looking
  // for the button and concluded the feature was missing.
  const pinnable = savedViewsEnabled && planId !== null && panelIds.length > 0;
  // Rearranging needs the same plan (the write is a refinement of it) and the
  // "more than one panel" bar: one panel has exactly one arrangement.
  const rearrangeable = rearrangeEnabled && planId !== null && panelIds.length > 1;

  // Nothing to offer: render exactly what the plain path renders, rather than a
  // panel wrapper with an empty control row.
  if (!pinnable && !rearrangeable) return <ViewSurface messages={messages} />;
  return (
    <SurfacePanels
      messages={messages}
      busy={busy}
      pinnable={pinnable}
      onPin={(nodeId: string) => {
        void pin(nodeId, panelHeading(messages, nodeId)).then((result) => {
          if (result.ok) confirmPinned();
        });
      }}
      rearrangeable={rearrangeable}
      onReorder={(order: readonly string[]) => void reorderPanels(order)}
    />
  );
}
