# @renderyes/core

Shared, dependency-free contracts for the RenderYes packages: the Plan
schema and its validator, the component registry types, the compose event
vocabulary (`ComposeEvent`, `parseComposeEvent`, SSE encoding), and the
plan-provider interface.

Hosts rarely import this directly — `@renderyes/server`,
`@renderyes/react`, and `@renderyes/site-sdk` re-export what an
integration needs. Packages that consume the shared plan and event contracts
depend on it, and all public `@renderyes/*` packages version together.
