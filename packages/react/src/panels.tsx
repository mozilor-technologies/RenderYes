import { DeferredChild, basicCatalog } from "@a2ui/react/v0_9";
import { MessageProcessor, type A2uiMessage } from "@a2ui/web_core/v0_9";
import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { RenderBoundary } from "./isolated-view.js";
import { useView } from "./provider.js";
import { SurfaceErrorBoundary, ViewSurface } from "./surface.js";

/**
 * Per-panel rendering for a composed multi-panel view: one wrapper per
 * top-level panel, each carrying its own control row (grip to rearrange, pin
 * to keep), rendered from a single message processor.
 *
 * This exists because of how the A2UI renderer keys a container's children:
 * `ChildList` keys each child `${childRef}-${index}` — the *position* is part
 * of the identity. Reordering the root Column's children inside one surface
 * therefore remounts every moved panel, wiping its local state: a table's
 * sort, a chart's zoom, anything a host component holds in `useState`. So the
 * root Column is not asked to reorder anything. This component renders the
 * root's children itself, one `DeferredChild` per panel inside a wrapper
 * keyed by nodeId alone — React moves the DOM node and the panel's whole
 * subtree survives the move.
 *
 * Taking over the root's rendering is only honest when the root is the
 * compiled shape this file understands: a plain `Column` whose rendering the
 * host has not overridden (a host may register its own `Column`, and
 * bypassing it here would silently drop their layout). Anything else keeps
 * the previous render path — per-panel surfaces with a pin, no grips.
 */

/** A compiled A2UI component record, as far as panel extraction reads it. */
type ComponentRecord = { id?: unknown; children?: unknown } & Record<string, unknown>;

/**
 * The compiled root record, when the messages carry one.
 *
 * `compileSurfaceMessages` always emits `{id: "root", component: "Column",
 * children: [...nodeIds]}` first in `updateComponents`; a hand-authored host
 * surface may look like anything, and returns `null` here.
 */
function findRootRecord(messages: readonly A2uiMessage[]): ComponentRecord | null {
  for (const message of messages) {
    const update = (message as { updateComponents?: { components?: unknown } })
      .updateComponents;
    if (!update || !Array.isArray(update.components)) continue;
    const root = (update.components as ComponentRecord[]).find(
      (record) => record?.id === "root",
    );
    if (root) return root;
  }
  return null;
}

/**
 * The plan nodeIds of the view's top-level panels, in render order.
 *
 * Read from the compiled messages rather than from the plan — the client never
 * holds a plan body, and it does not need one here: `@renderyes/site-sdk`'s
 * `compilePlanDataSurfaceMessages` carries each plan node's `nodeId` through as
 * the A2UI component id (`toComponentInstance`), and `compileSurfaceMessages`
 * lists the top-level instances, in plan order, as the root Column's
 * `children`. So the ids under `root` *are* the plan nodeIds, and no wire
 * format had to grow a parallel summary to say so. Anything that does not look
 * like that compiled shape (a hand-authored host surface, say) yields an empty
 * list, which simply renders without panel controls.
 */
export function topLevelPanelIds(messages: readonly A2uiMessage[]): readonly string[] {
  const root = findRootRecord(messages);
  if (!root || !Array.isArray(root.children)) return [];
  return root.children.every((child): child is string => typeof child === "string")
    ? root.children
    : [];
}

/**
 * One panel's literal `heading`, when the compiled component carries one.
 *
 * Used to label a pinned view: a pin files ONE panel away, so a saved-list
 * entry captioned with the whole original prompt is indistinguishable from
 * the full saved view — and from a second pin of its sibling. Only a literal
 * string qualifies; a data-model binding (`{path: ...}`) is not text this
 * side should resolve, so it yields undefined and the caller falls back to
 * the prompt.
 */
export function panelHeading(
  messages: readonly A2uiMessage[],
  nodeId: string,
): string | undefined {
  for (const message of messages) {
    const update = (message as { updateComponents?: { components?: unknown } })
      .updateComponents;
    if (!update || !Array.isArray(update.components)) continue;
    const record = (update.components as ComponentRecord[]).find(
      (candidate) => candidate?.id === nodeId,
    );
    const heading = record?.heading;
    if (typeof heading === "string" && heading.trim()) return heading.trim();
  }
  return undefined;
}

/**
 * The same message set narrowed to render one top-level panel: only the root
 * Column's `children` changes. Every component record and the whole data model
 * ride along untouched — records outside the panel's subtree are simply never
 * reached from the root, and their data-model entries are never read. Purely
 * presentational: nothing here touches the plan, which stays server-side.
 */
export function panelMessages(
  messages: readonly A2uiMessage[],
  nodeId: string,
): readonly A2uiMessage[] {
  return withRootChildren(messages, [nodeId]);
}

/**
 * The same message set with the root's `children` in a new order — the local
 * half of a reorder, applied before (and regardless of whether) the server
 * confirms it. Refuses to apply anything that is not a permutation of the
 * current children: a stale order (a node removed while a drag settled, say)
 * must not resurrect or drop a panel, so the messages come back unchanged.
 */
export function withPanelOrder(
  messages: readonly A2uiMessage[],
  nodeIds: readonly string[],
): readonly A2uiMessage[] {
  const current = topLevelPanelIds(messages);
  if (
    current.length === 0 ||
    current.length !== nodeIds.length ||
    [...current].sort().join("\u0000") !== [...nodeIds].sort().join("\u0000")
  ) {
    return messages;
  }
  return withRootChildren(messages, nodeIds);
}

function withRootChildren(
  messages: readonly A2uiMessage[],
  children: readonly string[],
): readonly A2uiMessage[] {
  return messages.map((message) => {
    const update = (message as { updateComponents?: { components?: unknown } })
      .updateComponents;
    if (!update || !Array.isArray(update.components)) return message;
    return {
      ...(message as unknown as Record<string, unknown>),
      updateComponents: {
        ...update,
        components: (update.components as ComponentRecord[]).map((record) =>
          record?.id === "root" ? { ...record, children: [...children] } : record,
        ),
      },
    } as A2uiMessage;
  });
}

/**
 * Panel chrome, concatenated into `WORKSPACE_STYLES`. The pin rules moved
 * here from `workspace.tsx` when the pin joined the grip in one per-panel
 * control row — one control surface, one place its styling lives.
 */
export const PANEL_STYLES = `
/* One wrapper per top-level panel, so its controls can sit in its own corner.
   Deliberately subtle: rearranging and pinning are side actions on the panel,
   not part of it. */
.renderyes-scope .renderyes-panel { position: relative; }
.renderyes-scope .renderyes-panel + .renderyes-panel { margin-top: 12px; }
/* Inside the panels container the container's own gap spaces panels. */
.renderyes-scope .renderyes-panels .renderyes-panel + .renderyes-panel { margin-top: 0; }
.renderyes-scope .renderyes-pin { position: absolute; top: 4px; right: 4px; z-index: 1;
  border: 1px solid var(--iv-border); border-radius: 8px; background: rgba(255,255,255,.92);
  color: var(--iv-muted); font-size: 12px; font-weight: 600; padding: 3px 9px; cursor: pointer; }
.renderyes-scope .renderyes-pin:hover { background: #eef1f4; color: var(--iv-fg); }
.renderyes-scope .renderyes-panel-controls { position: absolute; top: 4px; right: 4px;
  z-index: 1; display: flex; gap: 4px; }
.renderyes-scope .renderyes-panel-controls .renderyes-pin { position: static; }
.renderyes-scope .renderyes-grip { border: 1px solid var(--iv-border); border-radius: 8px;
  background: rgba(255,255,255,.92); color: var(--iv-muted); font-size: 12px; font-weight: 600;
  padding: 3px 7px; cursor: grab; touch-action: none; }
.renderyes-scope .renderyes-grip:hover { background: #eef1f4; color: var(--iv-fg); }
.renderyes-scope .renderyes-grip:active { cursor: grabbing; }
.renderyes-scope .renderyes-dropline { position: absolute; left: 0; right: 0; height: 2px;
  background: var(--iv-accent); border-radius: 1px; pointer-events: none; z-index: 2; }
`;

/**
 * Screen-reader-only, in both render modes: the reorder announcement is meant
 * for assistive tech, and painting "Moved to position 2 of 3" onto the page
 * would double what the moving panel already shows. Inline always — it is
 * functional, not thematic, so it must hold in host mode too.
 */
const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

const ERROR_STYLE = { color: "#b42318", fontSize: 13, margin: 0 } as const;

/** A2UI `justify` values mapped to CSS, matching the basic catalog's Column. */
function mapJustify(value: string): CSSProperties["justifyContent"] {
  switch (value) {
    case "center":
      return "center";
    case "end":
      return "flex-end";
    case "spaceAround":
      return "space-around";
    case "spaceBetween":
      return "space-between";
    case "spaceEvenly":
      return "space-evenly";
    case "stretch":
      return "stretch";
    default:
      return "flex-start";
  }
}

function mapAlign(value: string): CSSProperties["alignItems"] {
  switch (value) {
    case "start":
      return "flex-start";
    case "center":
      return "center";
    case "end":
      return "flex-end";
    default:
      return "stretch";
  }
}

/**
 * The container standing in for the root Column, derived from the root
 * record's own properties where it has any. The compiled root today carries
 * only `id`/`component`/`children`, so the defaults are what renders: a flex
 * column with the 12px the panel chrome has always used between panels.
 * Inline in both modes — this replaces a component the A2UI renderer would
 * otherwise lay out, so its layout cannot depend on a stylesheet that host
 * mode never injects.
 */
function containerStyle(root: ComponentRecord | null): CSSProperties {
  const style: CSSProperties = { display: "flex", flexDirection: "column", gap: 12 };
  if (!root) return style;
  if (typeof root.gap === "number" || typeof root.gap === "string") style.gap = root.gap;
  if (typeof root.justify === "string") style.justifyContent = mapJustify(root.justify);
  if (typeof root.align === "string") style.alignItems = mapAlign(root.align);
  return style;
}

export interface SurfacePanelsProps {
  messages: readonly A2uiMessage[];
  /** Hides every panel control, matching how the pin has always behaved. */
  busy: boolean;
  /** Renders the pin in each panel's control row. */
  pinnable: boolean;
  onPin: (nodeId: string) => void;
  /** Renders the grip in each panel's control row (plain-Column views only). */
  rearrangeable: boolean;
  /** Receives the full new order — every current nodeId exactly once. */
  onReorder: (nodeIds: readonly string[]) => void;
  /** True in `renderMode: "host"`, where inline fallback styles must apply. */
}

/**
 * While a grip is held: which panel is being dragged and where it would land.
 * `dropIndex` is an insertion point in the current order, 0..panels.length.
 */
interface DragState {
  nodeId: string;
  dropIndex: number;
}

export function SurfacePanels({
  messages,
  busy,
  pinnable,
  onPin,
  rearrangeable,
  onReorder,
}: SurfacePanelsProps) {
  const { catalog, config } = useView();
  const panels = useMemo(() => topLevelPanelIds(messages), [messages]);
  const root = useMemo(() => findRootRecord(messages), [messages]);

  // The takeover guard. Rendering the root's children ourselves is only
  // faithful when the root is the plain compiled Column *and* "Column" still
  // means the basic catalog's implementation — a host that registered its own
  // Column (provider.tsx keeps the last entry per name, deliberately) gets its
  // override honoured by falling back to the previous per-surface path.
  const hostOverridesColumn =
    (catalog.components as ReadonlyMap<string, unknown>).get("Column") !==
    (basicCatalog.components as ReadonlyMap<string, unknown>).get("Column");
  const takeOver =
    root !== null && root.component === "Column" && !hostOverridesColumn;

  // One processor for the whole view, exactly like `ViewSurface` — see its
  // comments for why per-message-set, memoized, and caught rather than thrown.
  const { surface, processError } = useMemo(() => {
    if (!takeOver || messages.length === 0)
      return { surface: null, processError: null };
    try {
      const processor = new MessageProcessor([catalog]);
      processor.processMessages([...messages]);
      const surfaces = Array.from(processor.model.surfacesMap.values());
      return { surface: surfaces[0] ?? null, processError: null };
    } catch (cause) {
      return {
        surface: null,
        processError:
          cause instanceof Error ? cause.message : "Could not read the composed result.",
      };
    }
  }, [takeOver, catalog, messages]);

  // The previous path's per-panel message sets, keyed by nodeId so a reorder
  // of the wrappers never rebuilds a panel's messages reference.
  const splitSets = useMemo(
    () =>
      takeOver
        ? new Map<string, readonly A2uiMessage[]>()
        : new Map(panels.map((nodeId) => [nodeId, panelMessages(messages, nodeId)])),
    [takeOver, panels, messages],
  );

  const [announcement, setAnnouncement] = useState("");
  const [drag, setDrag] = useState<DragState | null>(null);
  const panelRefs = useRef(new Map<string, HTMLDivElement>());

  const renderMode = config.renderMode ?? "isolated";

  function moveTo(from: number, to: number) {
    if (to < 0 || to >= panels.length || to === from) return;
    const next = [...panels];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    onReorder(next);
    setAnnouncement(`Moved to position ${to + 1} of ${panels.length}`);
  }

  /**
   * Where a pointer at `clientY` would insert, measured against the panels'
   * own rects rather than the event's target. Pointer capture keeps every
   * move event on the grip, and inside a shadow root event targets are
   * retargeted anyway — the rects sidestep both, since the refs are direct
   * element handles no boundary rewrites.
   */
  function dropIndexFor(clientY: number): number {
    let index = 0;
    for (const nodeId of panels) {
      const element = panelRefs.current.get(nodeId);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (clientY > rect.top + rect.height / 2) index += 1;
    }
    return index;
  }

  function onGripPointerDown(event: PointerEvent<HTMLButtonElement>, index: number) {
    // Left button only for mice; every touch or pen contact counts.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Capture on the grip itself: pointer events, unlike HTML5 drag events,
    // keep firing on the captured element across the shadow boundary, which
    // is what makes dragging inside an isolated view possible at all.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const nodeId = panels[index];
    if (nodeId !== undefined) setDrag({ nodeId, dropIndex: index });
  }

  function onGripPointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    setDrag({ ...drag, dropIndex: dropIndexFor(event.clientY) });
  }

  function onGripPointerUp() {
    if (!drag) return;
    const from = panels.indexOf(drag.nodeId);
    if (from !== -1) {
      // The insertion point counts the dragged panel's own slot, so a drop
      // below it lands one index lower once the panel leaves its old place.
      const to = drag.dropIndex > from ? drag.dropIndex - 1 : drag.dropIndex;
      moveTo(from, to);
    }
    setDrag(null);
  }

  const showControls = !busy;
  // Grips render only where a drop can actually be honoured: the takeover
  // path. The fallback path is the guard saying "this view is not the shape
  // reordering understands", and a grip that shuffles what a host's own
  // Column would then re-lay-out its own way promises something it can't keep.
  const grips = rearrangeable && takeOver && panels.length > 1;

  if (!takeOver) {
    // The previous render path, unchanged from the pin commit: one narrowed
    // surface per panel, a pin in its corner, no grips.
    if (!pinnable) return <ViewSurface messages={messages} />;
    return (
      <RenderBoundary mode={renderMode} styles={config.styles}>
        {panels.map((nodeId, index) => (
          <div
            key={nodeId}
            className="renderyes-panel"
          >
            {showControls ? (
              <button
                className="renderyes-pin"
                onClick={() => onPin(nodeId)}
                aria-label="Pin this panel"
                title="Pin this panel"
              >
                Pin
              </button>
            ) : null}
            <ViewSurface messages={splitSets.get(nodeId) ?? messages} />
          </div>
        ))}
      </RenderBoundary>
    );
  }

  if (processError !== null) {
    return (
      <RenderBoundary mode={renderMode} styles={config.styles}>
        <p role="alert" style={ERROR_STYLE}>
          {processError}
        </p>
      </RenderBoundary>
    );
  }
  if (!surface) return null;

  return (
    <RenderBoundary mode={renderMode} styles={config.styles}>
      <SurfaceErrorBoundary>
        <div className="renderyes-panels" style={containerStyle(root)}>
          <div aria-live="polite" style={VISUALLY_HIDDEN_STYLE}>
            {announcement}
          </div>
          {panels.map((nodeId, index) => (
            <div
              key={nodeId}
              ref={(element) => {
                if (element) panelRefs.current.set(nodeId, element);
                else panelRefs.current.delete(nodeId);
              }}
              className="renderyes-panel"
            >
              {drag && drag.dropIndex === index ? (
                <div
                  className="renderyes-dropline"
                  // Data-driven: which edge the line sits on depends on the
                  // drop index, which no stylesheet can know.
                  style={{ top: -7 }}
                />
              ) : null}
              {drag &&
              index === panels.length - 1 &&
              drag.dropIndex === panels.length ? (
                <div
                  className="renderyes-dropline"
                  style={{ bottom: -7 }}
                />
              ) : null}
              {showControls && (grips || pinnable) ? (
                <div
                  className="renderyes-panel-controls"
                >
                  {grips ? (
                    <button
                      className="renderyes-grip"
                      aria-label={`Move panel ${index + 1} of ${panels.length}`}
                      title="Drag to move, or press an arrow key"
                      onKeyDown={(event) => {
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          moveTo(index, index - 1);
                        } else if (event.key === "ArrowDown") {
                          event.preventDefault();
                          moveTo(index, index + 1);
                        }
                      }}
                      onPointerDown={(event) => onGripPointerDown(event, index)}
                      onPointerMove={onGripPointerMove}
                      onPointerUp={onGripPointerUp}
                      onPointerCancel={() => setDrag(null)}
                    >
                      ⋮⋮
                    </button>
                  ) : null}
                  {pinnable ? (
                    <button
                      className="renderyes-pin"
                      onClick={() => onPin(nodeId)}
                      aria-label="Pin this panel"
                      title="Pin this panel"
                    >
                      Pin
                    </button>
                  ) : null}
                </div>
              ) : null}
              <DeferredChild surface={surface} id={nodeId} basePath="/" />
            </div>
          ))}
        </div>
      </SurfaceErrorBoundary>
    </RenderBoundary>
  );
}
