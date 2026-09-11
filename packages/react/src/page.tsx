import type { ReactNode } from "react";
import { SHARED_CHROME_STYLES } from "./chrome.js";
import { CLARIFICATION_STYLES } from "./clarification.js";
import { ViewChromeOptionsProvider } from "./chrome-state.js";
import { RenderBoundary } from "./isolated-view.js";
import { PANEL_STYLES } from "./panels.js";
import { ViewNotices, ViewPrompt, ViewSavedBar, ViewSavedControls } from "./parts.js";
import { useView } from "./provider.js";
import { ViewSurface } from "./surface.js";

export const PAGE_STYLES = `
${SHARED_CHROME_STYLES}${CLARIFICATION_STYLES}
.renderyes-scope .renderyes-workspace { display: flex; flex-direction: column; gap: 16px;
  max-width: 1080px; margin: 0 auto; padding: 24px clamp(16px, 4vw, 32px) 56px; }
.renderyes-scope .renderyes-workspace-exit { align-self: flex-start; border: 0; background: transparent;
  color: var(--iv-accent); font-weight: 600; font-size: 14px; cursor: pointer; padding: 4px 0; }
.renderyes-scope .renderyes-stale { margin: 0; padding: 8px 12px; border-radius: 8px;
  background: #fff8e6; color: #6b5300; font-size: 13px; }
/* Save and My views take the Start over button's secondary weight: keeping and
   browsing views are side actions, not the equal of the button that builds one. */
.renderyes-scope .renderyes-save, .renderyes-scope .renderyes-my-views { min-height: 42px;
  padding: 0 14px; border: 1px solid var(--iv-border); border-radius: 10px; background: transparent;
  color: var(--iv-muted); font-weight: 600; cursor: pointer; }
.renderyes-scope .renderyes-save:disabled, .renderyes-scope .renderyes-my-views:disabled { opacity: .6; cursor: wait; }
.renderyes-scope .renderyes-save-confirmation { margin: 0; font-size: 13px; color: #1a7f37; }
.renderyes-scope .renderyes-saved-menu { border: 1px solid var(--iv-border); border-radius: 12px;
  padding: 8px; background: #fafbfc; display: grid; gap: 4px; }
.renderyes-scope .renderyes-saved-row { display: flex; align-items: center; gap: 8px; }
.renderyes-scope .renderyes-saved-open { flex: 1; display: flex; flex-wrap: wrap; align-items: baseline;
  gap: 8px; border: 0; background: transparent; text-align: left; padding: 8px; border-radius: 8px;
  font-size: 14px; color: var(--iv-fg); cursor: pointer; }
.renderyes-scope .renderyes-saved-open:hover { background: #eef1f4; }
.renderyes-scope .renderyes-saved-open:disabled { opacity: .6; cursor: wait; }
.renderyes-scope .renderyes-saved-date { font-size: 12px; color: var(--iv-muted); }
.renderyes-scope .renderyes-saved-stale { font-size: 12px; color: #6b5300; }
.renderyes-scope .renderyes-saved-delete { border: 0; background: transparent; color: var(--iv-muted);
  font-size: 16px; line-height: 1; padding: 6px 10px; border-radius: 8px; cursor: pointer; }
.renderyes-scope .renderyes-saved-delete:hover { background: #eef1f4; color: var(--iv-danger); }
.renderyes-scope .renderyes-saved-delete:disabled { opacity: .6; cursor: wait; }
.renderyes-scope .renderyes-saved-empty { margin: 0; padding: 8px; font-size: 13px; color: var(--iv-muted); }
${PANEL_STYLES}`;

/** How long the "Saved" confirmation stays before clearing itself. */

// The stylesheet's container rules, mirrored inline for renderMode "host",
// where no stylesheet is injected at all — without this the workspace runs
// edge-to-edge on wide screens in exactly the mode real hosts use.

export interface ViewPageProps {
  /**
   * A host's own "return to the rest of the site" action, rendered above the
   * prompt bar. Omit it if the workspace has its own route and the host's
   * normal navigation already covers getting back.
   */
  onExit?: () => void;
  /** Label on the control that returns the visitor to your site. Defaults to a generic "Back". */
  exitLabel?: string;
  /** Placeholder in the ask box. Worth naming your data — a visitor who cannot guess what is
   *  available asks for things the catalog does not hold. */
  placeholder?: string;
  /**
   * Example prompts, written by the host, rendered as one-click chips on the
   * empty workspace and inside refusals as "what you can ask instead". The
   * host writes these because it knows its catalog and its visitors' words;
   * nothing here is model-generated or catalog-derived, so a chip can never
   * promise something the host didn't choose to promise.
   */
  suggestions?: readonly string[];
  /**
   * Renders the built-in "Save view" and "My views" controls. Defaults to on.
   *
   * A host whose server has no `viewStore` configured must pass `false`,
   * because the client cannot tell that host apart on its own: the server
   * answers the saved-view routes with the same `400 {ok, error}` envelope it
   * uses for any rejected request — no machine-readable kind — and
   * `listSaved({silent: true})` deliberately reports every failure as an empty
   * list. Left on against such a host, the controls render and each use
   * surfaces the hook's normal error copy.
   *
   * A host that wants different saved-view UI entirely should also pass
   * `false` and build from `useViewCompose()` — `save`, `listSaved`, `reopen`
   * and `deleteSaved` are all on the hook. That, not more props here, is the
   * customisation path.
   */
  savedViews?: boolean;
  /**
   * Renders a grip on each panel of a multi-panel view — drag it, or focus it
   * and press an arrow key — and persists the arrangement as one background
   * `reorderNodes` refinement. Defaults to on.
   *
   * A host whose server has no `resolveViewOwner` configured must pass
   * `false`, for the same reason `savedViews` documents: `/api/refine` is
   * plan-addressed, and a server with no owner to check a planId against
   * refuses it with the plain `400 {ok, error}` envelope — no
   * machine-readable kind — so the client cannot tell such a host apart on
   * its own. Left on, every drop still rearranges the screen but then reports
   * "This arrangement won't be saved".
   *
   * Grips hide while a compose is running and never render on a single-panel
   * view. A revision deliberately resets the arrangement: nodeIds are
   * model-chosen labels with no stability across re-plans, so a new plan is a
   * new arrangement rather than an old order re-applied to different panels.
   */
  rearrange?: boolean;
  /**
   * The arrangement to render inside the page.
   *
   * Omitted, the page renders the standard one below — a prompt row with the
   * saved-view controls, the saved-view panel, the notices, and the composed
   * result with pins. Supplied, it renders exactly what is given, in that
   * order, and omitting a part is how that feature is turned off.
   *
   * This is the rung that did not exist. Before it a host chose between the
   * whole packaged surface and `useViewCompose` with nothing built, and the
   * middle answer — "your layout, one piece swapped" — could not be written.
   * The parts are individually mountable already; what this adds is the
   * container they need to look right: the render boundary and the stylesheet,
   * which live here and not in any part.
   */
  children?: ReactNode;
}

/**
 * RenderYes as a page: the container, and by default the whole arrangement.
 *
 * Everything a composed layout needs but no part provides — the isolation
 * boundary, the injected stylesheet, the page's own width and spacing. A host
 * composing parts without this gets working behaviour and no styling at all,
 * which is a real trap: it looks like the library is broken rather than like
 * the container is missing.
 *
 * `ViewWorkspace` is this component under its original name.
 */
export function ViewPage({
  onExit,
  exitLabel = "Back",
  placeholder,
  suggestions,
  savedViews = true,
  rearrange = true,
  children,
}: ViewPageProps) {
  const { config } = useView();
  const renderMode = config.renderMode ?? "isolated";

  return (
    <RenderBoundary mode={renderMode} styles={`${PAGE_STYLES}${config.styles ?? ""}`}>
      {/* `savedViews` and `rearrange` stay as page-level options rather than
          becoming "omit the part". A host who passes no children has no part to
          omit, so without these there is no way for them to turn saved views
          off at all — and the concern spans three parts (the row's controls, the
          panel below it, the pins on the surface), so one switch is also the
          only way to turn it off without leaving a Save button whose menu is
          missing. */}
      <ViewChromeOptionsProvider
        options={{ savedViewsEnabled: savedViews, rearrangeEnabled: rearrange }}
      >
        {/* Applied in both modes: the chrome stylesheet is namespaced under
            this class, and host mode now receives that stylesheet rather
            than a second set of inline approximations of it. */}
        <div className="renderyes-scope">
          <div className="renderyes-workspace">
            {children ?? (
              <>
                <ViewPrompt
                  {...(placeholder ? { placeholder } : {})}
                  {...(onExit ? { onExit } : {})}
                  exitLabel={exitLabel}
                >
                  <ViewSavedControls />
                </ViewPrompt>
                <ViewSavedBar />
                <ViewNotices {...(suggestions ? { suggestions } : {})} />
                <ViewResult>
                  <ViewSurface panels />
                </ViewResult>
              </>
            )}
          </div>
        </div>
      </ViewChromeOptionsProvider>
    </RenderBoundary>
  );
}

/**
 * The composed result's own block, exported because a custom arrangement needs
 * it to get the result's spacing — it is the one wrapper that carries layout
 * rather than being the page itself.
 */
export function ViewResult({ children }: { children?: ReactNode }) {
  return <div className="renderyes-result">{children ?? <ViewSurface panels />}</div>;
}

/**
 * A full-page alternative to `ViewLauncher`'s floating panel.
 *
 * The launcher's panel is a fixed-size overlay — a long or multi-component
 * composed result gets clipped to whatever fits in a small floating box,
 * scrolling inside it rather than the page. A host that wants RenderYes as
 * its own page or route, not a widget bolted onto another page, mounts this
 * instead: the same compose request lifecycle (`useViewCompose`), the
 * same registered components and `renderMode`, but laid out as a plain block
 * sized by the host's own page layout rather than a positioned overlay. The
 * host owns the surrounding page — where it's mounted, whether it scrolls,
 * what happens on exit — this only owns the prompt bar and the composed
 * result beneath it.
 */
