import { useState } from "react";
import { SHARED_CHROME_STYLES } from "./chrome.js";
import { CLARIFICATION_STYLES } from "./clarification.js";
import { RenderBoundary } from "./isolated-view.js";
import { PAGE_STYLES, ViewPage, type ViewPageProps } from "./page.js";
import { useView } from "./provider.js";

/**
 * The dialog is `renderyes-dialog`, not `renderyes-panel`.
 *
 * `panels.tsx` already owns `.renderyes-panel` for each top-level panel of a
 * composed view, and this file's rules are concatenated after that file's — so
 * while the launcher was a separate implementation that never rendered content
 * panels, the collision was latent. Putting a whole `ViewPage` inside the
 * dialog woke it up: every panel in a dialog would have taken
 * `position: fixed` and the dialog's own background and shadow.
 */
const TRIGGER_STYLES = `
:host { all: initial; }
${SHARED_CHROME_STYLES}${CLARIFICATION_STYLES}${PAGE_STYLES}
.renderyes-scope .renderyes-dialog { position: fixed; inset: auto 16px 84px auto; width: min(560px, calc(100vw - 32px));
  max-height: min(70vh, 720px); overflow: auto; padding: 20px;
  border: 1px solid var(--iv-border); border-radius: 16px; background: var(--iv-accent-fg);
  box-shadow: 0 24px 60px rgb(16 24 40 / 18%); z-index: 2147483000; }
/* The page inside a panel is not a page: it must not keep the centred column
   and the page-sized padding, or the panel gets a second set of margins. */
.renderyes-scope .renderyes-dialog .renderyes-workspace { max-width: none;
  margin: 0; padding: 0; gap: 12px; }
`;

const BUTTON_STYLE = {
  position: "fixed" as const,
  inset: "auto 16px 16px auto",
  minHeight: 52,
  padding: "0 22px",
  border: 0,
  borderRadius: 999,
  background: "#1f6feb",
  color: "#fff",
  fontWeight: 800,
  fontSize: 15,
  cursor: "pointer" as const,
  boxShadow: "0 12px 32px rgb(31 111 235 / 35%)",
  zIndex: 2147483000,
};

// The panel-only piece of the host-mode fallback; every other piece comes from
// the parts, which carry their own.
const PANEL_FALLBACK_STYLE = {
  position: "fixed" as const,
  inset: "auto 16px 84px auto",
  width: "min(560px, calc(100vw - 32px))",
  maxHeight: "min(70vh, 720px)",
  overflow: "auto" as const,
  padding: 20,
  border: "1px solid #dfe3e8",
  borderRadius: 16,
  background: "#fff",
  boxShadow: "0 24px 60px rgb(16 24 40 / 18%)",
  zIndex: 2147483000,
};

export interface ViewTriggerProps extends ViewPageProps {
  label?: string;
  /**
   * `"dialog"` opens a `ViewPage` in a floating panel. `"link"` renders the
   * button only and hands the click back, for a host with a real route.
   */
  mode?: "dialog" | "link";
  /** Where `mode="link"` navigates. Ignored in dialog mode. */
  href?: string;
  /**
   * Called on click. In `"link"` mode this is the whole behaviour; in
   * `"dialog"` mode it runs alongside opening, for analytics.
   */
  onOpen?: () => void;
}

/**
 * The floating entry point, and the one place the panel form is defined.
 *
 * There used to be two entry points, `ViewLauncher` and `ViewWorkspace`, each
 * with its own prompt row, its own copy of the "typing means revision once a
 * view exists" rule — written twice, each with a comment pointing at the other
 * — and its own error rendering. They drifted, as two implementations of one
 * behaviour do: the launcher silently lacked suggestions, saved views, pins and
 * the refusal card, and a fix to shared copy landed in one of them.
 *
 * This is now a button and a container. Everything inside is `ViewPage`, so the
 * dialog cannot lack a feature the page has — and a host who wants their own
 * arrangement in the panel passes children exactly as they would to a page.
 */
export function ViewTrigger({
  label = "Ask",
  mode = "dialog",
  href,
  onOpen,
  ...page
}: ViewTriggerProps) {
  const { config } = useView();
  const [open, setOpen] = useState(false);
  const renderMode = config.renderMode ?? "isolated";

  function handleClick() {
    onOpen?.();
    if (mode === "link") {
      // Navigation is the host's if they took the click; otherwise honour href.
      if (!onOpen && href) window.location.assign(href);
      return;
    }
    setOpen((current) => !current);
  }

  return (
    <RenderBoundary mode={renderMode} styles={`${TRIGGER_STYLES}${config.styles ?? ""}`}>
      {/* Applied in both modes: the chrome stylesheet is namespaced under
            this class, and host mode now receives that stylesheet rather
            than a second set of inline approximations of it. */}
      <div className="renderyes-scope">
        <button
          onClick={handleClick}
          aria-expanded={mode === "link" ? undefined : open}
          style={BUTTON_STYLE}
        >
          {open && mode === "dialog" ? "Close" : label}
        </button>

        {open && mode === "dialog" ? (
          <section
            className="renderyes-dialog"
            aria-label="RenderYes"
          >
            {/* The page, whole. The boundary above already established
                isolation, and `RenderBoundary` refuses to nest — so the page
                contributes its arrangement and not a second shadow root. */}
            <ViewPage {...page} />
          </section>
        ) : null}
      </div>
    </RenderBoundary>
  );
}
