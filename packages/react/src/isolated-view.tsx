import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * True once a `RenderBoundary` is above in the tree, so a nested one renders
 * children directly instead of establishing a second isolation layer.
 */
const InsideRenderBoundary = createContext(false);

/**
 * Isolation boundary. Mounts children inside a Shadow DOM so host-page CSS
 * cannot alter or break the composed view, and styles declared inside cannot
 * leak onto the host page.
 *
 * Required because RenderYes renders *inside someone else's site*. Without
 * this, a host's global CSS reset silently deforms the composed view and our
 * styles bleed into their page.
 *
 * If shadow-root creation is unavailable, children render directly into the
 * host node rather than not rendering at all — fail toward visibility, since
 * the alternative is a blank overlay.
 */
export function IsolatedView({
  children,
  styles,
}: {
  children: ReactNode;
  styles?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);
  const [isolationFailed, setIsolationFailed] = useState(false);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (typeof host.attachShadow !== "function") {
      setIsolationFailed(true);
      return;
    }

    setShadowRoot(host.shadowRoot ?? host.attachShadow({ mode: "open" }));
  }, []);

  return (
    <div ref={hostRef} data-testid="renderyes-isolation-host">
      {shadowRoot
        ? createPortal(
            <>
              {styles ? <style>{styles}</style> : null}
              {children}
            </>,
            shadowRoot as unknown as Element,
          )
        : null}
      {isolationFailed ? children : null}
    </div>
  );
}

/**
 * One `<style>` element per distinct stylesheet in `document.head`, refcounted.
 *
 * Host mode needs the chrome's stylesheet in the document, and a page can hold
 * several boundaries (a page and a trigger) asking for the same one. Keyed by
 * content so identical requests share an element, refcounted so the last
 * consumer to unmount removes it rather than leaving it behind for the life of
 * the tab.
 */
const injectedSheets = new Map<string, { element: HTMLStyleElement; count: number }>();

function useDocumentStyleSheet(styles: string | undefined): void {
  useLayoutEffect(() => {
    if (!styles || typeof document === "undefined") return;
    const existing = injectedSheets.get(styles);
    if (existing) {
      existing.count += 1;
    } else {
      const element = document.createElement("style");
      element.setAttribute("data-renderyes", "chrome");
      element.textContent = styles;
      document.head.append(element);
      injectedSheets.set(styles, { element, count: 1 });
    }
    return () => {
      const entry = injectedSheets.get(styles);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count > 0) return;
      entry.element.remove();
      injectedSheets.delete(styles);
    };
  }, [styles]);
}

/**
 * Picks the render boundary a host configured with `ViewConfig.renderMode`.
 *
 * `"host"` renders directly into the caller's own tree, so a host's registered
 * components pick up its Tailwind classes, CSS variables and dark-mode rules
 * exactly as they would anywhere else on the page. `"isolated"` (the default)
 * mounts a shadow root instead.
 *
 * Both modes get `styles` — into the shadow root, or into `document.head`.
 * Host mode used to refuse it, for fear of leaking shadow-scoped CSS onto the
 * host page, and the chrome carried a second set of inline styles to
 * compensate. That trade cost more than it saved: inline styles cannot express
 * `:hover`, `:focus-visible` or a media query, so host mode had no focus rings
 * and no dark mode, and they beat any stylesheet a host wrote — so the chrome
 * was simultaneously less styled and impossible to restyle. Every chrome rule
 * is namespaced `.renderyes-scope .renderyes-*`, which is what makes
 * injecting it safe: it cannot match an element outside our own container.
 */
export function RenderBoundary({
  mode,
  children,
  styles,
}: {
  mode: "isolated" | "host";
  children: ReactNode;
  styles?: string;
}) {
  const alreadyInside = useContext(InsideRenderBoundary);
  // Called unconditionally, as hooks must be. A no-op unless host mode is what
  // the returns below select.
  useDocumentStyleSheet(mode === "host" && !alreadyInside ? styles : undefined);
  // Nesting one boundary inside another would put a shadow root inside a
  // shadow root: the content still renders, but the outer boundary's injected
  // stylesheet cannot cross the inner one, so the chrome silently loses its
  // styling. `ViewLauncher`/`ViewWorkspace` wrap their whole panel and also
  // render a `ViewSurface`, which now establishes its own boundary when used
  // standalone — this is what keeps those two facts from colliding.
  if (alreadyInside) return <>{children}</>;
  if (mode === "host") {
    return (
      <InsideRenderBoundary.Provider value={true}>
        {children}
      </InsideRenderBoundary.Provider>
    );
  }
  return (
    <InsideRenderBoundary.Provider value={true}>
      <IsolatedView styles={styles}>{children}</IsolatedView>
    </InsideRenderBoundary.Provider>
  );
}
