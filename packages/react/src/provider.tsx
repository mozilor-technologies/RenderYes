import { Catalog } from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/react/v0_9";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { RegisteredHostComponent } from "./define-host-component.js";
import { ComposeSessionProvider } from "./use-compose.js";
import { ViewChromeProvider } from "./chrome-state.js";

/**
 * Host-supplied configuration. Deliberately small: a service URL, which
 * published catalog to ask, and the host's own components.
 *
 * No model key appears here. Credentials stay on the RenderYes service, the
 * same way they never reach a browser today — a key in a frontend bundle is a
 * published key.
 */
export interface ViewConfig {
  /** Base URL of the RenderYes service. Same-origin or CORS-allowed. */
  serviceUrl: string;
  /**
   * Which published capability catalog this surface may ask.
   *
   * Must equal the `id` of the capability catalog published to the server.
   * The server files UI registrations under that same id, so a value that
   * merely looks right — the site's own id, a slug — resolves no components
   * and composes nothing, with no error to say why.
   */
  catalogId: string;
  /**
   * A2UI catalog id the host's components are registered under.
   *
   * Setting it here is enough: the value is sent with each compose, the server
   * records it with the plan, and refine and reopen replay the recorded value
   * rather than recomputing a default. (It used to be recomputed, so overriding
   * this field gave a working first compose and a silently empty surface on
   * every refinement.)
   *
   * The caveat that remains is *changing* it. A plan or saved view carries the
   * id it was composed under, so components registered under a new value no
   * longer match older views — binding fails silently and the surface renders
   * empty. Treat it like a storage key: pick it once.
   */
  uiCatalogId?: string;
  /** The host's registered components, from `defineHostComponent`. */
  components: readonly RegisteredHostComponent[];
  /** Optional CSS injected inside the isolation boundary. */
  styles?: string;
  /**
   * Where composed views render.
   *
   * `"isolated"` (default): inside a Shadow DOM boundary, unaffected by and
   * unable to affect the host page's own CSS. The right choice for a
   * third-party or embedded widget, or any host that hasn't registered
   * first-party components sharing its own design system.
   *
   * `"host"`: directly in the host page's DOM. A registered component then
   * renders with the host's own Tailwind classes, design tokens, dark mode,
   * and responsive rules applying exactly as they would anywhere else on the
   * page — no CSS has to be duplicated or reinjected across a shadow
   * boundary. Choose this when a host's registered components are trusted
   * first-party code meant to look native to the site.
   */
  renderMode?: "isolated" | "host";
  /**
   * Overrides how long a `/api/compose` request may run before the request
   * is aborted and the caller shown a timeout error. Defaults to 45s — see
   * `DEFAULT_COMPOSE_TIMEOUT_MS` in `@renderyes/react`'s `use-compose.ts`
   * for what that default is sized against.
   */
  composeTimeoutMs?: number;
  /**
   * Receives a compose as it happens rather than once it has finished, so the
   * surface renders a skeleton the moment the plan validates and fills each
   * slot as its data lands. On by default.
   *
   * Set `false` to force the single-response form — useful behind a proxy that
   * buffers responses, which would otherwise turn a stream back into one long
   * wait with none of the batch path's simplicity.
   */
  stream?: boolean;
  /**
   * Query parameter carrying the id of a saved view, so a composed view has a
   * URL: `save()` writes it, and a load with it present reopens that view
   * instead of showing an empty prompt.
   *
   * Saving already worked and reopening already worked; neither had an address,
   * so a visitor could keep a view and not return to it without building the
   * plumbing themselves. Set to `false` to opt out and drive the URL yourself.
   *
   * Owner-scoped, like the saved view it names: pasting the link to a colleague
   * will not open it for them. That is the authorization decision `reopen`
   * already makes, not an oversight — a genuinely shareable link needs a token
   * and a decision about who may see composed data.
   */
  savedViewParam?: string | false;
  /**
   * Called before every `/api/compose` request to attach the visitor's own
   * session credential as request headers — most commonly `Authorization`.
   *
   * This package never assumes where that credential lives. A host using an
   * httpOnly session cookie needs nothing here (`credentials: "include"`
   * already forwards it); a host that reads a token out of `localStorage` or
   * an in-memory auth store, as most single-page apps do, wires it here.
   *
   * **If your token has a refresh cycle, refresh it inside this hook.** That is
   * what the promise return type is for. Reading a stored token is the obvious
   * implementation and the wrong one for most SPAs:
   *
   * ```ts
   * // Wrong whenever the token expires: sends whatever was last written.
   * getAuthHeaders: () => ({ authorization: `Bearer ${localStorage.getItem("access_token")}` })
   *
   * // Right: the same refresh the app's own transport performs.
   * getAuthHeaders: async () => ({ authorization: `Bearer ${await auth.getValidToken()}` })
   * ```
   *
   * An SPA that renews its token inside its own transport — an Apollo link, an
   * axios interceptor, a fetch wrapper — renews it only for requests that pass
   * through that layer. RenderYes's requests do not, so a page left open long
   * enough sends a token that expired while it sat there. The upstream rejects
   * it, permissions resolve empty, and the visitor is told they are missing a
   * permission they hold — three hops from the cause.
   *
   * `credentials: "include"` is still sent alongside whatever this returns,
   * so a host relying on cookies loses nothing by leaving this unset.
   */
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
}

export interface ViewContextValue {
  config: ViewConfig;
  /** Built once from the host's components; the surface renders through it. */
  catalog: Catalog<never>;
}

const ViewContext = createContext<ViewContextValue | undefined>(undefined);

export function ViewProvider({
  config,
  children,
}: {
  config: ViewConfig;
  children: ReactNode;
}) {
  const value = useMemo<ViewContextValue>(() => {
    const uiCatalogId = config.uiCatalogId ?? `${config.catalogId}:ui`;
    return {
      config,
      // Constructing the A2UI catalog is exactly the step a host previously had
      // to do by hand. It happens here instead, from their registrations.
      //
      // `basicCatalog`'s primitives (Column, Row, ...) go first, not just the
      // host's own components: the trusted executor's compiled surface
      // messages always wrap a plan's components in a root `{component:
      // "Column", children: [...]}` node, with no way for a host to opt out
      // of that wrapper. Without Column registered, every composition fails
      // to render — "Unknown component: Column" — regardless of how correct
      // a host's own components are. Host components are listed after, so a
      // host that deliberately registers its own `Column`/`Row` can still
      // override the primitive (Map construction keeps the last entry for a
      // given key).
      catalog: new Catalog(uiCatalogId, [
        ...basicCatalog.components.values(),
        ...config.components.map((component, index) => {
          // Checked here because the failure is otherwise invisible until a
          // visitor loads the page: a missing `implementation` reaches A2UI as
          // `undefined` and surfaces as "Cannot read properties of undefined
          // (reading 'name')", which names nothing a host can act on.
          //
          // The mistake worth naming is registering a *definition* — what
          // `defineComponent` and the `create*Definition` helpers return. Its
          // shape is close enough to look right and it belongs on the server,
          // in `componentDefinitions`. The browser wants the registration that
          // carries a renderer.
          if (!component?.implementation) {
            const id =
              (component as { definition?: { id?: unknown }; id?: unknown } | undefined)
                ?.definition?.id ??
              (component as { id?: unknown } | undefined)?.id;
            const named = typeof id === "string" ? `"${id}"` : `at index ${index}`;
            throw new Error(
              (component as { renderer?: unknown } | undefined)?.renderer
                ? `The entry ${named} in ViewProvider's \`components\` is a component ` +
                  `definition, not a registered component. A definition — from ` +
                  `\`defineComponent\` or a \`create*Definition\` helper — is the server's ` +
                  `half and belongs in the catalog you publish. The browser needs the ` +
                  `value \`defineHostComponent\` returns, which carries the renderer.`
                : `The entry ${named} in ViewProvider's \`components\` has no renderer. ` +
                  `Each entry must be the value returned by \`defineHostComponent\`, or ` +
                  `one produced by \`ingestViews\`/\`ingestViewDirectory\`.`,
            );
          }
          return component.implementation;
        }),
      ] as never[]),
    };
  }, [config]);

  // The compose session lives here rather than in whoever renders a surface,
  // so a registered host component can reach the same session the surface came
  // from. That is what makes a column-header sort affect the table it belongs
  // to instead of a private copy of the state.
  return (
    <ViewContext.Provider value={value}>
      <ComposeSessionProvider>
        <ViewChromeProvider>{children}</ViewChromeProvider>
      </ComposeSessionProvider>
    </ViewContext.Provider>
  );
}

export function useView(): ViewContextValue {
  const value = useContext(ViewContext);
  if (!value) {
    throw new Error("useView must be used inside an <ViewProvider>");
  }
  return value;
}
