# API guide

Use this page for public API behavior and defaults. The exported TypeScript
types are the exact contract for return shapes, configuration fields, and named
exports; each package's `package.json` defines its public entry points.

## React runtime

### `ViewProvider` config

| Field              | Default            | Notes                                                                                                                             |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `serviceUrl`       | —                  | Base URL immediately before the RenderYes `/api/*` paths. Use `""` for a direct same-origin mount; include a framework prefix only when the adapter strips it. |
| `catalogId`        | —                  | The published capability catalog id.                                                                                              |
| `components`       | —                  | Components registered with `defineHostComponent`.                                                                                 |
| `renderMode`       | `"isolated"`       | `"host"` renders in the host DOM and uses the host's CSS.                                                                         |
| `styles`           | —                  | CSS injected into the isolation boundary.                                                                                         |
| `uiCatalogId`      | `"<catalogId>:ui"` | Treat this as a storage key. Existing plans and saved views retain the id used when they were composed.                           |
| `stream`           | `true`             | Set to `false` when a proxy buffers streaming responses.                                                                          |
| `composeTimeoutMs` | 45 seconds         | Browser-side abort deadline for `/api/compose`. Keep the server deadline at or below it.                                          |
| `savedViewParam`   | `"iv"`             | Query parameter containing an owner-scoped saved-view id. Set to `false` to manage URLs yourself.                                 |
| `getAuthHeaders`   | —                  | Returns the visitor's request headers and may refresh credentials asynchronously. Cookies are sent with `credentials: "include"`. |

### `ViewWorkspace` props

`ViewPage` and `ViewWorkspace` are two names for the same component.

| Prop          | Default         | Notes                                                                                                                            |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `suggestions` | —               | Host-written example prompts.                                                                                                    |
| `placeholder` | —               | Prompt input placeholder.                                                                                                        |
| `onExit`      | —               | Host navigation action shown above the prompt.                                                                                   |
| `exitLabel`   | `"Back"`        | Label for `onExit`.                                                                                                              |
| `savedViews`  | `true`          | Set to `false` when the server has no `viewStore`, or when the host supplies its own saved-view controls.                        |
| `rearrange`   | `true`          | Set to `false` when the server has no `resolveViewOwner`, or when the host supplies its own panel controls.                      |
| `children`    | packaged layout | Replaces the packaged arrangement with individually exported React parts while retaining the page container and render boundary. |

`ViewLauncher` takes `label` (default `"Ask"`) and `onOpen`. When `onOpen` is
set, it renders only the launcher button and leaves the panel or page to the
host.

### Compose state and failures

The exported `ComposeState` type is the exact `useViewCompose()` return shape,
and `ComposeFailureKind` is the exact set of values for `errorKind`.

`ok: true` means the compose request completed; it does not mean every data
request succeeded. A partial response keeps the panels that resolved and puts
failed slots in `state: "error"`. Read `failedRequests` to report those failures
without discarding the rest of the view.

`clarification` is separate from `error`. It means the planner needs a choice
before composing. Call `answerClarification(answer)` with the visitor's answer.

`issues` contains validator paths and schema messages for host logging. Do not
render it to visitors.

## HTTP service

`createViewHttpHandler` owns the fixed paths exported as `VIEW_HTTP_ROUTES`.
Visitor routes are called by `@renderyes/react`; admin routes are gated by
`requireAdmin`.

`ViewServerConfig` defines the server construction fields. In particular:

- `host` and `resolveSession` are required.
- `planProviders` is required for model-backed planning. A scripted provider is
  available for deterministic integration tests.
- `allowedUpstreamOrigins` fails closed when omitted or empty.
- `viewStore` enables saving; `resolveViewOwner` authorizes every plan-addressed
  action, including refine, revise, save, and reopen.
- `catalogStore` persists published catalogs. Call
  `restorePublishedCatalogs()` once before accepting requests.
- `allowCompose`, `planDeadlineMs`, `composeDeadlineMs`, and the contract budget
  fields are the main public-deployment cost controls.

### `createViewHttpHandler` options

| Field          | Default                  | Notes                                                                                                        |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `requireAdmin` | —                        | Required authorization check for every admin route.                                                          |
| `maxBodyBytes` | `DEFAULT_MAX_BODY_BYTES` | Maximum request body size.                                                                                   |
| `cors`         | off                      | Exact allowed origins for credentialed cross-origin requests. Wildcards are not supported.                   |
| `onError`      | —                        | Observes dispatch and streaming exceptions after known transport, auth, and rate-limit failures are handled. |

The handler applies these transport rules:

- Throw `UnauthenticatedError` from `resolveSession` to return 401. Other
  request or domain validation failures return their mapped 4xx status.
- POST requests require `content-type: application/json` and are size-limited
  while streaming.
- CORS is disabled unless `cors` is supplied. Preflight requests are checked
  against the exact-origin allowlist.
- Trailing slashes are normalized.
- Error bodies never include a stack. `onError` receives the original dispatch
  or streaming failure, and an exception in the observer cannot alter the
  response.

## Package exports

Each package's `exports` map defines its public entry points, and its generated
declarations define the named exports. Files under a package's `dist/` directory
are not separate public entry points.
