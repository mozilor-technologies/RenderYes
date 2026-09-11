/**
 * Every file this tool writes.
 *
 * Templates, not code generation: each returns a string, and what varies is
 * substituted rather than assembled. A reader can see exactly what lands in
 * their repository by reading this file.
 *
 * Two rules hold throughout.
 *
 * The five decisions with no default are *written out*, never defaulted
 * silently — the library refuses to guess who a visitor is or what a visitor
 * may read, and a scaffold that guessed on its behalf would undo that in the
 * one place nobody looks again. Where a value cannot be known it is a `TODO`
 * that throws, not a plausible-looking stub.
 *
 * And nothing here is a black box. Every generated file says what it is, what
 * the host must change, and why the thing it is doing is not optional.
 */

const BANNER = (what) =>
  `// Written by \`npx @renderyes/init\`. ${what}
// Safe to edit — this tool never overwrites a file that already exists.`;

/**
 * The origin allowlist, or an honest gap.
 *
 * `JSON.stringify(undefined)` is `undefined`, which template-interpolated into
 * a literal `[undefined]` under a comment claiming it was derived — broken
 * output that read as deliberate. It failed closed, so nothing was exposed; it
 * was still a lie in a generated file.
 */
function upstreamOriginsField(origin) {
  if (origin) {
    return `  // Fails closed: an absent or empty list rejects every capability at
  // execution time. Derived from the data source named during setup.
  allowedUpstreamOrigins: [${JSON.stringify(origin)}],`;
  }
  return `  // TODO: the origin of your data source, e.g. "https://api.example.com".
  // This fails closed, so while it is empty every capability is rejected at
  // execution time — which is the safe direction, and not a working setup.
  allowedUpstreamOrigins: [],`;
}

/**
 * `resolveSession`, fail-closed with one deliberate escape hatch.
 *
 * Doctrine says this should throw until the host implements it: guessing an
 * identity is guessing who may read what. But a scaffold that always throws
 * cannot compose even once, so the tool could never prove the wiring it just
 * wrote — and "it installed cleanly" is not the same claim as "a request went
 * through it".
 *
 * So it throws unless `RENDERYES_DEV_SESSION` is set. Fail-closed by default,
 * verifiable on the first run, and the exception is a greppable env var rather
 * than a permissive default nobody notices. Production has no such variable and
 * gets the throw.
 */
function sessionResolver(sessionStyle, ownerStyle) {
  if (sessionStyle === "anonymous") {
    return `async function resolveSession(request) {
  // No sign-in: every visitor is anonymous, and the session says so rather
  // than throwing. Only capabilities approved with authentication "public"
  // will execute for it — the policy gate reads this session, so it must
  // exist even when it identifies no one. Replace when the app gains sign-in.
  return { anonymous: true, permissions: new Set() };
}`;
  }

  // A placeholder must not *call* anything. Naming an undefined function here
  // threw a ReferenceError before the dev fallback below could be reached,
  // which made the fallback dead code and the tool unable to prove the very
  // pipeline it had just scaffolded. So each of these evaluates to `undefined`
  // and leaves the real call in a comment for the host to uncomment.
  const read = {
    cookie: `  // TODO: your own verified cookie — this package never parses or trusts one
  // itself. Something like:  const session = verifySessionCookie(request)
  const session = undefined;`,
    bearer: `  // TODO: your own bearer verification — this package never parses or trusts
  // one itself. Something like:  const session = verifyBearerToken(request)
  const session = undefined;`,
    custom: `  // TODO: return your own session. This package never inspects the request
  // itself; it hands it to you and uses only what you return.
  const session = undefined;`,
  }[sessionStyle];

  // Shaped by the identity style chosen above, because this stub is what the
  // scaffolded resolveViewOwner is verified against: a nested identity reads
  // session.user.id, so a flat { userId } here made the tool's own
  // verification path throw on the very files it had just written.
  const devSession = {
    "single-user": `{ userId: process.env.RENDERYES_DEV_SESSION, permissions: new Set() }`,
    tenant: `{ tenantId: "dev-tenant", userId: process.env.RENDERYES_DEV_SESSION, permissions: new Set() }`,
    nested: `{ user: { id: process.env.RENDERYES_DEV_SESSION }, permissions: new Set() }`,
    custom: `{ userId: process.env.RENDERYES_DEV_SESSION, permissions: new Set() }`,
    anonymous: `{ userId: process.env.RENDERYES_DEV_SESSION, permissions: new Set() }`,
  }[ownerStyle];

  return `async function resolveSession(request) {
${read}
  if (session) return session;

  // Fail closed. A default here would be a guess about who is asking, and the
  // wrong guess makes another visitor's saved views readable.
  //
  // The one exception is local verification: with RENDERYES_DEV_SESSION set,
  // a stub session is returned so \`npx @renderyes/init\` can prove the
  // pipeline end to end before real auth is wired. Never set it in production.
  if (process.env.RENDERYES_DEV_SESSION) {
    return ${devSession};
  }
  throw new UnauthenticatedError(
    "No session: resolveSession must return one, or the request is anonymous",
  );
}`;
}

/**
 * One identity, three readers.
 *
 * The session resolver's dev stub, the host adapter's isAuthenticated, and
 * resolveViewOwner all read the visitor's identity — from the same place, or
 * the scaffold's own verification path throws on files it just wrote. The
 * anonymous style is the one with no identity at all: resolveViewOwner is
 * omitted rather than faked, because the server refuses refine/save without
 * it (fail closed), while a shared constant would file every visitor's views
 * under one world-readable key.
 */
function normalizedOwnerStyle(answers) {
  return answers.sessionStyle === "anonymous" ? "anonymous" : answers.ownerStyle;
}

/** `resolveViewOwner`, by what identity actually means in the host's system. */
function ownerResolver(ownerStyle) {
  return {
    "single-user": `// One key per user. Every path that looks a plan up by id — refine, revise,
// save — checks against this, because such a lookup is an authorization
// decision and not a cache read.
const resolveViewOwner = (session) => String(session.userId);`,
    tenant: `// Composite, because a saved view belongs to a user *within* a tenant. A key
// of just the user id works in development and lets one tenant's visitor reach
// another's view once real data arrives.
const resolveViewOwner = (session) => \`\${session.tenantId}:\${session.userId}\`;`,
    nested: `// Nested identity, read from wherever your session actually carries it.
const resolveViewOwner = (session) => String(session.user.id);`,
    custom: `// TODO: return a stable key identifying this visitor. Whatever you return is
// what separates one visitor's saved views from another's, so it must be
// stable across their sessions and unique to them.
const resolveViewOwner = (session) => {
  throw new Error("resolveViewOwner is not implemented");
};`,
    anonymous: `// No resolveViewOwner: anonymous visitors have no stable identity to file a
// saved view under, and a shared key would make every visitor's views every
// other visitor's. Composing works without it; refine and save refuse with
// the library's own error until the app has real identities.`,
  }[ownerStyle];
}

/** The config line naming the owner resolver, or its deliberate absence. */
function ownerConfigField(ownerStyle) {
  return ownerStyle === "anonymous"
    ? `  // resolveViewOwner is deliberately absent — see the note above.`
    : `  resolveViewOwner,`;
}

/**
 * The admin gate, constant-time in every template.
 *
 * The obvious one-liner — `headers.get(...) === process.env.TOKEN` — is the
 * bug: `===` short-circuits on the first mismatched byte, so the routes it
 * gates (publish, rollback, model spending) leak the token one byte at a time
 * through response timing. Scaffolds teach habits, so the generated file
 * carries the safe shape *and* the reason, the same way the reference hosts
 * write it.
 */
function adminTokenGate(adminTokenEnv) {
  return `// Constant-time, so a caller cannot recover the admin token one byte at a
// time from response timing — \`===\` short-circuits on the first mismatched
// byte. Length is compared first because \`timingSafeEqual\` throws on a
// length mismatch. Fails closed: with ${adminTokenEnv} unset or empty,
// every request is refused rather than compared against nothing.
function isAdminToken(given) {
  const expected = Buffer.from(process.env.${adminTokenEnv} ?? "", "utf8");
  const presented = Buffer.from(given ?? "", "utf8");
  if (expected.length === 0 || presented.length === 0) return false;
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}`;
}

function hostAdapter(ownerStyle) {
  const authenticated = {
    "single-user": `(session) => Boolean(session?.userId)`,
    tenant: `(session) => Boolean(session?.tenantId && session?.userId)`,
    nested: `(session) => Boolean(session?.user?.id)`,
    custom: `(session) => Boolean(session?.userId)`,
    // Honest, not lazy: nobody is ever signed in, so only capabilities
    // approved with authentication "public" execute.
    anonymous: `() => false`,
  }[ownerStyle];
  return `// The only adapter allowed to inspect a session, and it scopes exactly what a
// capability runtime may see — never the whole session object.
const host = {
  isAuthenticated: ${authenticated},
  hasPermission: (session, permission) => Boolean(session?.permissions?.has(permission)),
  getSessionValue: (session, key) => session?.[key],
};`;
}

/**
 * The model that plans a visitor's request, or an honest gap.
 *
 * Nothing wrote this before, so a scaffolded server could execute everything
 * and plan nothing: the wizard composed the sample question it had just asked
 * for and got back a refusal naming configuration it had never offered to
 * configure.
 *
 * The variable's name, never a value. `apiKeyEnv` is what the server reads at
 * call time, so a key that is absent at scaffold time is not a problem to
 * solve here.
 */
function planProvidersField(planProvider) {
  if (!planProvider) {
    return `  // No plan provider chosen during setup, so a compose refuses with
  // PlanProviderNotConfiguredError and everything below planning still works.
  // Add one to plan for real:
  //   planProviders: [{ id: "openai", apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5.6" }],`;
  }
  return `  // The key is read from the environment at call time, by name. Put
  // ${planProvider.apiKeyEnv} in whatever your app already loads — this file never
  // holds a value, and nothing in the wizard reads one.
  planProviders: [
    {
      id: ${JSON.stringify(planProvider.id)},
      apiKeyEnv: ${JSON.stringify(planProvider.apiKeyEnv)},
      model: ${JSON.stringify(planProvider.model)},
    },
  ],`;
}

function provenanceResolver(sourceId, upstreamOrigin) {
  return `  // Required to publish a GraphQL catalog. GraphQL establishes no provenance of
  // its own — nothing in a response says which system a row came from or how
  // old it is — and this package will not invent it. Replace \`asOf\` with a real
  // timestamp if your upstream reports one; a fabricated freshness is worse
  // than none, because components render it as fact.
  graphql: {
    resolveProvenance: () => ({
      sources: [{ sourceId: ${JSON.stringify(sourceId)} }],
      freshness: { asOf: new Date().toISOString() },
    }),
    // Upstream credentials, resolved per request from trusted state — never
    // seen by the planner or the browser.
    //
    // Scoped by \`destinationOrigin\`, which is the part worth doing deliberately.
    // A catalog names where each capability lives, so forwarding a credential to
    // every destination a catalog *could* name hands whoever publishes it a say
    // in where your visitor's token goes. Checking the origin keeps that
    // decision here, in code you own.
    resolveHeaders: ({ destinationOrigin, session }) => {
      ${
        upstreamOrigin
          ? `if (destinationOrigin !== ${JSON.stringify(upstreamOrigin)}) return {};`
          : `// TODO: compare destinationOrigin against your own upstream's origin and
      // return {} for anything else.`
      }
      // TODO: return the header your upstream expects, from the session or from
      // server-side configuration. Never from anything the planner controls.
      return {};
    },
  },`;
}

/**
 * A standalone RenderYes service, for a host whose backend is not Node.
 *
 * Plain `node:http` and `toNodeHandler`: no framework, no dependency beyond
 * the package itself. CORS is mandatory here rather than optional — the
 * frontend is on another origin by construction, which is the opposite of the
 * co-located case where omitting it is correct.
 */
export function standaloneService(answers) {
  const ownerStyle = normalizedOwnerStyle(answers);
  return `#!/usr/bin/env node
${BANNER("A standalone RenderYes service, for a backend that is not Node.")}
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { ADMIN_TOKEN_HEADER, createViewServer, createViewHttpHandler${answers.sessionStyle === "anonymous" ? "" : ", UnauthenticatedError"} } from "@renderyes/server";
import { toNodeHandler, createFileCatalogStore } from "@renderyes/server/node";

${hostAdapter(ownerStyle)}

${sessionResolver(answers.sessionStyle, ownerStyle)}

${ownerResolver(ownerStyle)}

const renderYes = createViewServer({
  host,
  resolveSession,
${ownerConfigField(ownerStyle)}
${upstreamOriginsField(answers.upstreamOrigin)}
  // Without this the registries are purely in-memory, so a restart leaves
  // every visitor's compose failing until someone republishes by hand.
  //
  // Anchored to the working directory, never import.meta.url: a bundler or
  // build step relocates this file into build output that the next rebuild
  // wipes, and published catalogs stored beside it silently vanish. Start the
  // service from this folder (\`npm start\` does), or make the path absolute.
  catalogStore: createFileCatalogStore(join(process.cwd(), "data")),
${planProvidersField(answers.planProvider)}
${provenanceResolver(answers.sourceId, answers.upstreamOrigin)}
});

${adminTokenGate(answers.adminTokenEnv)}

const handler = createViewHttpHandler(renderYes, {
  // Required, and required to be a function. Every possible default is wrong:
  // open ships a publish endpoint an anonymous caller can replace your catalog
  // through; closed breaks the review app with a 403 that looks like our bug.
  requireAdmin: (request) => isAdminToken(request.headers.get(ADMIN_TOKEN_HEADER)),
  // Mandatory for a standalone service: the frontend is on another origin, so
  // without this every browser request fails preflight.
${
    answers.frontendOrigin
      ? `  cors: { allowedOrigins: [${JSON.stringify(answers.frontendOrigin)}] },`
      : `  // TODO: your frontend's origin, e.g. "https://app.example.com". A standalone
  // service is cross-origin by construction, so until this names the frontend
  // every browser request fails preflight — which reads as a broken install
  // rather than as an unanswered question.
  cors: { allowedOrigins: [] },`
  }
});

// Before listen(), not after. Published catalogs live in memory because a
// capability holds a live executor closure, so they survive a restart only
// through the store plus this call. Forgetting it serves "no published
// catalog" for something plainly published.
await renderYes.restorePublishedCatalogs();

const port = Number(process.env.PORT ?? ${answers.port});
createServer(toNodeHandler(handler)).listen(port, () => {
  console.log(\`RenderYes listening on http://127.0.0.1:\${port}\`);
});
`;
}

export function standaloneManifest(answers) {
  return `${JSON.stringify(
    {
      name: `${answers.catalogId}-renderyes`,
      private: true,
      type: "module",
      engines: { node: ">=22" },
      scripts: { start: "node server.mjs" },
      // No `dependencies` here on purpose. This file used to declare a fixed
      // `"@renderyes/server": "^0.1.0"`, which meant the one dependency the
      // service has was both installed in the wrong directory and pinned to a
      // range the scaffold had guessed. The installer adds it here instead and
      // writes whatever version actually resolved, so the scaffold pins at a
      // real published version rather than floating on a range.
    },
    null,
    2,
  )}\n`;
}

export function standaloneEnvExample(answers) {
  return `# Gates every publish route. Any value; it only has to match what the
# review tool and your CI send.
${answers.adminTokenEnv}=change-me
${
    answers.sessionStyle === "anonymous"
      ? `` // Anonymous sessions resolve without a dev stub, so offering the
      // variable here would document a switch the generated code never reads.
      : `
# Local verification only. Uncomment so \`npx @renderyes/init\` can prove the
# pipeline before real auth exists — resolveSession returns a stub session while
# it is set. Shipped commented out so copying this file forward is safe: set in
# production, it makes every request that visitor.
# RENDERYES_DEV_SESSION=dev-user
`
  }`;
}

/** An Express mount, for a host whose Node backend already exists. */
/**
 * The framework-agnostic mount, for a host this tool has no template for.
 *
 * The alternative was worse than nothing: everything that was not Next fell to
 * the Express template, so a fastify host, a hono host, and a host whose
 * framework was not detected at all each received `app.use(path, handler)` —
 * which fastify does not have and hono does not mean. Generated code that
 * cannot run is more expensive than no code, because it reads as a starting
 * point rather than a mistake.
 *
 * This exports the same two things every mount exports, and leaves exactly one
 * decision — how your framework attaches a handler — with the two shapes it
 * usually takes written out.
 */
export function manualMount(answers, { frameworkId } = {}) {
  const ownerStyle = normalizedOwnerStyle(answers);
  return `${BANNER(
    `Wire this into your server. ${
      frameworkId ? `Detected ${frameworkId}, which has no template yet.` : "Framework not detected."
    }`,
  )}
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { ADMIN_TOKEN_HEADER, createViewServer, createViewHttpHandler${answers.sessionStyle === "anonymous" ? "" : ", UnauthenticatedError"} } from "@renderyes/server";
import { toNodeHandler, createFileCatalogStore } from "@renderyes/server/node";

${hostAdapter(ownerStyle)}

${sessionResolver(answers.sessionStyle, ownerStyle)}

${ownerResolver(ownerStyle)}

const renderYes = createViewServer({
  host,
  resolveSession,
${ownerConfigField(ownerStyle)}
${upstreamOriginsField(answers.upstreamOrigin)}
  // Anchored to the project root via process.cwd(), never import.meta.url: a
  // bundled build relocates this module into build output the next rebuild
  // wipes, so catalogs stored URL-relative to it silently vanish.
  catalogStore: createFileCatalogStore(join(process.cwd(), "renderyes-data")),
${planProvidersField(answers.planProvider)}
${provenanceResolver(answers.sourceId, answers.upstreamOrigin)}
});

${adminTokenGate(answers.adminTokenEnv)}

/**
 * A standard Request -> Response handler. Every framework below can serve one;
 * they differ only in how you hand it over.
 */
export const handler = createViewHttpHandler(renderYes, {
  requireAdmin: (request) => isAdminToken(request.headers.get(ADMIN_TOKEN_HEADER)),${
      answers.frontendOrigin
        ? `
  cors: { allowedOrigins: [${JSON.stringify(answers.frontendOrigin)}] },`
        : `
  // Omitted: same-origin. Add \`cors: { allowedOrigins: [...] }\` if the
  // frontend is served from somewhere else.`
    }
});

/**
 * Call once at startup, before your server listens. It replays catalogs
 * published in an earlier process; without it the first request after a restart
 * finds an empty catalog and the failure looks like a publish that never
 * happened.
 */
export async function startRenderYes() {
  await renderYes.restorePublishedCatalogs();
  return renderYes;
}

// ─── TODO: attach \`handler\` at ${answers.mountPath} ───────────────────────
//
// Everything under that prefix must reach it, including the trailing segments —
// the paths are a contract with @renderyes/react, so route the whole subtree
// rather than transcribing individual routes.
//
// If your framework speaks Request/Response (hono, and most edge runtimes):
//
//   import { handler, startRenderYes } from "./renderyes.mjs";
//   await startRenderYes();
//   app.all(${JSON.stringify(`${answers.mountPath}/*`)}, (c) => handler(c.req.raw));
//
// If it speaks Node req/res (fastify, and http.createServer):
//
//   import { toNodeHandler } from "@renderyes/server/node";
//   import { handler, startRenderYes } from "./renderyes.mjs";
//   await startRenderYes();
//   const nodeHandler = toNodeHandler(handler);
//   fastify.all(${JSON.stringify(`${answers.mountPath}/*`)}, (request, reply) =>
//     nodeHandler(request.raw, reply.raw));
//
// Verify it with: npx @renderyes/init doctor --service-url <your mount>
`;
}

export function expressMount(answers) {
  const ownerStyle = normalizedOwnerStyle(answers);
  return `${BANNER("Mount this into your existing Express app.")}
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { ADMIN_TOKEN_HEADER, createViewServer, createViewHttpHandler${answers.sessionStyle === "anonymous" ? "" : ", UnauthenticatedError"} } from "@renderyes/server";
import { toNodeHandler, createFileCatalogStore } from "@renderyes/server/node";

${hostAdapter(ownerStyle)}

${sessionResolver(answers.sessionStyle, ownerStyle)}

${ownerResolver(ownerStyle)}

const renderYes = createViewServer({
  host,
  resolveSession,
${ownerConfigField(ownerStyle)}
${upstreamOriginsField(answers.upstreamOrigin)}
  // Anchored to the project root via process.cwd(), never import.meta.url: a
  // bundled build relocates this module into build output the next rebuild
  // wipes, so catalogs stored URL-relative to it silently vanish.
  catalogStore: createFileCatalogStore(join(process.cwd(), "renderyes-data")),
${planProvidersField(answers.planProvider)}
${provenanceResolver(answers.sourceId, answers.upstreamOrigin)}
});

${adminTokenGate(answers.adminTokenEnv)}

const handler = createViewHttpHandler(renderYes, {
  requireAdmin: (request) => isAdminToken(request.headers.get(ADMIN_TOKEN_HEADER)),${
      answers.frontendOrigin
        ? `
  cors: { allowedOrigins: [${JSON.stringify(answers.frontendOrigin)}] },`
        : `
  // Omitted: same-origin. Add \`cors: { allowedOrigins: [...] }\` if the
  // frontend is served from somewhere else.`
    }
});

/**
 * Call once at startup, before app.listen(), then mount.
 *
 *   const mount = await mountRenderYes(app)
 *
 * Write the handler rather than the routes: their paths are a contract with
 * @renderyes/react, and hand-transcribing them is how finished features
 * ship that no client can reach.
 */
export async function mountRenderYes(app) {
  await renderYes.restorePublishedCatalogs();
  app.use(${JSON.stringify(answers.mountPath)}, toNodeHandler(handler));
  return renderYes;
}
`;
}

/**
 * A Next.js route handler, written as plain JavaScript on purpose.
 *
 * A `.ts` file here fails the whole host app twice over: `next build`
 * type-checks routes, and a generated file whose functions take untyped
 * parameters is an implicit-any error under the `strict` default; and in a
 * JS-only host a single `.ts` file triggers Next's TypeScript bootstrap,
 * which refuses to start until the compiler is installed. A `.js` route runs
 * identically in both kinds of host and is type-checked in neither.
 */
export function nextRouteHandler(answers) {
  const ownerStyle = normalizedOwnerStyle(answers);
  return `${BANNER("A Next.js catch-all route for RenderYes.")}
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { ADMIN_TOKEN_HEADER, createViewServer, createViewHttpHandler${answers.sessionStyle === "anonymous" ? "" : ", UnauthenticatedError"} } from "@renderyes/server";
import { createFileCatalogStore } from "@renderyes/server/node";

${hostAdapter(ownerStyle)}

${sessionResolver(answers.sessionStyle, ownerStyle)}

${ownerResolver(ownerStyle)}

const renderYes = createViewServer({
  host,
  resolveSession,
${ownerConfigField(ownerStyle)}
${upstreamOriginsField(answers.upstreamOrigin)}
  // Anchored to the project root via process.cwd(), never import.meta.url:
  // inside a built route this module runs from .next/, which every rebuild
  // wipes — catalogs stored URL-relative to it silently vanish. Bundlers also
  // rewrite URL construction from import.meta.url at build time.
  catalogStore: createFileCatalogStore(join(process.cwd(), "renderyes-data")),
${planProvidersField(answers.planProvider)}
${provenanceResolver(answers.sourceId, answers.upstreamOrigin)}
});

${adminTokenGate(answers.adminTokenEnv)}

const handler = createViewHttpHandler(renderYes, {
  requireAdmin: (request) => isAdminToken(request.headers.get(ADMIN_TOKEN_HEADER)),
});

// This route lives under the mount path, and the handler matches its route
// table against the pathname it is given — the client's serviceUrl is this
// same prefix, and @renderyes/react appends the concrete route to it. So
// the prefix is stripped exactly once, here, before the request is delegated.
const MOUNT_PATH = ${JSON.stringify(answers.mountPath)};

// Stored catalogs are replayed once per process, before the first request is
// served. Not a module-level await: Next evaluates this module during
// \`next build\` and again in each server instance, so a boot step that runs
// at import time runs at build time too.
let restored;

async function route(request) {
  await (restored ??= renderYes.restorePublishedCatalogs());
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(MOUNT_PATH.length) || "/";
  return handler(
    new Request(url, {
      method: request.method,
      headers: request.headers,
      ...(request.body ? { body: request.body, duplex: "half" } : {}),
    }),
  );
}

// Without this Next prerenders the GET at build time and serves that frozen
// response forever; every route here answers per request.
export const dynamic = "force-dynamic";

// The route is the handler: one fetch-standard (Request) => Promise<Response>.
export const GET = route;
export const POST = route;
export const OPTIONS = route;
`;
}

/** The provider mount: a full page, which is the intended surface. */
export function frontendRoute(answers, { next = false } = {}) {
  return `${
    next
      ? `"use client";
// A client component on purpose: the provider and workspace hold state and
// stream events, which a server component cannot.
`
      : ""
  }${BANNER("The RenderYes page. A full page, not a floating widget.")}
import { ViewProvider, ViewWorkspace } from "@renderyes/react";
import { views } from "./views/index.js";

/**
 * ViewWorkspace rather than ViewLauncher: the launcher's panel is a fixed-size
 * overlay, so a long or multi-component result scrolls inside a small box. This
 * owns the prompt bar and the composed result; the page around it is yours.
 */
export default function RenderYesPage() {
  return (
    <ViewProvider
      config={{
        serviceUrl: ${JSON.stringify(answers.serviceUrl)},
        // Must equal the capability catalog id published to the server. UI
        // registrations are filed under it, and a mismatch renders nothing.
        // Pick it once, like a storage key — changing it later orphans every
        // saved view filed under the old one.
        catalogId: ${JSON.stringify(answers.catalogId)},
        components: views,
        // Your components render in this page, sharing its stylesheet.
        //
        // The default is "isolated", which mounts a shadow root — right for a
        // surface dropped into an unknown page, wrong here: your markup would
        // arrive with every class intact and none of them applying, because
        // your stylesheet is outside the boundary. Nothing errors. A correct,
        // complete answer just looks unstyled, which reads as a broken theme.
        renderMode: "host",
      }}
    >
      <ViewWorkspace placeholder={${JSON.stringify(answers.placeholder)}} />
    </ViewProvider>
  );
}
`;
}

/**
 * The views folder. This is the load-bearing scaffold: the starter components
 * are a bootstrap the host replaces, and their own components are the product.
 */
export function viewsIndex() {
  return `${BANNER("Your components. Register each one here.")}
import {
  createDataTable,
  createDetailPanel,
  createMetricCard,
  createRecordWithLines,
} from "@renderyes/starter-catalog";
import { orderSummary } from "./order-summary.jsx";

/**
 * The generic starter components accept data *by shape*, so they work against
 * any approved catalog and give you something on screen immediately. They are a
 * starting point, not the destination: your own components — one file each,
 * like ./order-summary.jsx — are what makes a view yours.
 *
 * One renderer per shape is enough to make that shape reachable. Registering
 * several for the same shape is fine, and gives the planner a choice it makes
 * from your descriptions.
 *
 * This is an explicit list because it has to work under every bundler. The
 * folder convention — one \`*.view.jsx\` per component, no list to maintain — is
 * the better way to write your own, and reaching it needs a glob your bundler
 * supports (\`import.meta.glob\` on Vite). When yours does:
 *
 *   import { ingestViews } from "@renderyes/react";
 *   const mine = ingestViews(import.meta.glob("./*.view.jsx", { eager: true }));
 *   export const views = [createDataTable(), ...mine];
 *
 * Everything in this list is an already-registered component: a starter
 * factory, or something you built with defineHostComponent. A file written with
 * defineView exports a spec and a default component instead, and the two have
 * to be paired before they can go here — ingestViews over an import.meta.glob,
 * or ingestViewDirectory in Node. Putting the bare spec in this array is
 * refused at publish, by name.
 */
export const views = [
  createDataTable(),
  createMetricCard(),
  createDetailPanel(),
  createRecordWithLines(),
  orderSummary,
];
`;
}

export function exampleView() {
  return `${BANNER("An example of your own component. Copy this shape.")}
import { countBeyondPage, defineHostComponent, defineProps, field } from "@renderyes/react";

/**
 * A host component the planner may select and bind data to.
 *
 * \`defineHostComponent\` takes the contract and the component together: the
 * planner reads the contract, the surface renders the component. Props are
 * declared with \`field.*\` rather than raw Zod, which keeps you off the
 * Zod-major boundary between this package and the catalog packages — and
 * bounds what a planner is allowed to set. \`dataSlots\` accepts by *shape*,
 * so this works against any catalog producing that shape rather than one
 * specific data type.
 */
export const orderSummary = defineHostComponent({
  id: "OrderSummary",
  version: "1.0.0",
  description:
    "Headline figures for a short list of records, one line each. Use when the visitor wants an overview of several items rather than one item in full.",
  props: defineProps({
    heading: field.string({
      default: "Summary",
      description:
        "Restate the visitor's request in their own words — not the data type's internal name.",
    }),
  }),
  dataSlots: {
    rows: { accepts: [{ shape: "collection" }] },
  },
  // What a screen reader announces for the rendered component — the
  // difference between "list" and "order summary list".
  accessibility: {
    label: "Order summary list",
    description: "Headline figures for a short list of records.",
  },
  component: OrderSummaryView,
});

function OrderSummaryView({ heading, rows, state, errorMessage, sources, completeness }) {
  // \`state\` is "pending" | "ready" | "empty" | "error" — a streamed compose
  // emits the surface before its requests settle, so every slot starts
  // pending and this component sees it on the first frame of every run.
  if (state === "pending") return <p>Loading…</p>;
  if (state === "error") return <p role="alert">{errorMessage}</p>;
  const records = Array.isArray(rows) ? rows : [];
  if (state === "empty" || records.length === 0) return <p>Nothing to show.</p>;
  // Never rows.length in a headline: the slot holds one *page* of the set,
  // cut by the row budget, so the page size silently headlines 100 for a
  // 2,500-record answer. countBeyondPage reads \`completeness\` and says when
  // the count is a floor rather than the total.
  const total = countBeyondPage(records, completeness);
  return (
    <section>
      <h3>
        {heading} — {total.exact ? total.count : \`at least \${total.count}\`} record(s)
      </h3>
      <ul>
        {records.map((record, index) => (
          <li key={index}>
            {Object.entries(record)
              .filter(([, value]) => value === null || typeof value !== "object")
              .map(([key, value]) => \`\${key}: \${String(value)}\`)
              .join(" · ")}
          </li>
        ))}
      </ul>
      {(sources ?? []).length === 0 ? (
        // Empty \`sources\` means the data is not grounded in anything — the
        // one thing this system exists to prevent is presenting it as if it
        // were.
        <p>Not attributed to a data source — treat these figures as unverified.</p>
      ) : null}
    </section>
  );
}
`;
}

/**
 * Publishing the UI catalog from the frontend repository.
 *
 * The one legitimate use of the two-call publish path: a frontend deploy must
 * not require re-approving data, and the UI catalog is built from components
 * that only exist here. Made safe by reading what the server reports back —
 * `capabilityCatalogRegistered` says whether the id matched anything, which is
 * the failure this call used to make silently.
 */
export function publishUiScript(answers, { viewsImport = "../src/renderyes/views/index.js" } = {}) {
  return `#!/usr/bin/env node
${BANNER("Publish this repo's components as the UI catalog. Run under tsx.")}
import { toSiteManifest, defineSite, defineSurface } from "@renderyes/site-sdk";

// Imported dynamically so the loader failure below can be caught. Node cannot
// load a \`.jsx\` file at all — not a syntax error, a refused extension — and
// your components are the whole input to this script. Statically imported, that
// arrived as ERR_UNKNOWN_FILE_EXTENSION with a stack trace and no instruction.
let views;
try {
  ({ views } = await import(${JSON.stringify(viewsImport)}));
} catch (cause) {
  const message = String(cause?.message ?? cause);
  if (/Unknown file extension|Cannot find module.*\\.jsx/.test(message)) {
    console.error(
      "Node cannot load JSX on its own, and this script has to import your\\n" +
        "components to publish them. Run it through a loader:\\n" +
        "\\n" +
        "  npx tsx scripts/publish-ui-catalog.mjs" +
        process.argv.slice(2).map((argument) => \` \${argument}\`).join("") +
        "\\n\\n" +
        "Any loader your project already uses will do — this needs nothing from\\n" +
        "tsx but the ability to import your views.",
    );
    process.exit(2);
  }
  throw cause;
}

// \`--emit <file>\` writes the manifest to a file instead of posting it, so the
// same components can become the UI half of a review-export bundle:
//
//   npx tsx scripts/publish-ui-catalog.mjs --emit ui.json
//   renderyes-catalog compile ... --ui-manifest ui.json --out bundle.json
//   renderyes-catalog publish --service-url ... --file bundle.json
//
// That publishes both halves in one call with the id threaded through both by
// construction — which is the mismatch this two-call script can only warn about
// after the fact. Writing a file talks to nothing, so it needs neither a
// running mount nor an admin token, and the checks below are skipped for it.
const emitIndex = process.argv.indexOf("--emit");
const emitTo = emitIndex === -1 ? undefined : process.argv[emitIndex + 1];
if (emitIndex !== -1 && !emitTo) {
  console.error("--emit needs a file path.");
  process.exit(2);
}

// The browser's serviceUrl can be a path prefix because the page has an
// origin to resolve it against. This script runs in Node, which has none —
// so the URL here must be absolute, mount prefix included.
const serviceUrl = process.env.RENDERYES_SERVICE_URL ?? ${JSON.stringify(answers.serviceUrl)};
let serviceBase;
try {
  serviceBase = new URL(serviceUrl.endsWith("/") ? serviceUrl : \`\${serviceUrl}/\`);
} catch {
  if (!emitTo) {
    console.error(
      \`"\${serviceUrl}" is not an absolute URL. Set RENDERYES_SERVICE_URL to where\\n\` +
        "the mount is actually served, e.g. http://127.0.0.1:3000${answers.mountPath ?? "/api/renderyes"}",
    );
    process.exit(2);
  }
}
const adminToken = process.env.${answers.adminTokenEnv};
if (!adminToken && !emitTo) {
  console.error("${answers.adminTokenEnv} is not set; the publish routes are admin-gated.");
  process.exit(2);
}

// Both \`defineHostComponent\` and the starter factories return
// \`{definition, implementation}\`; the definition is the half a catalog
// publishes. A bare \`defineView\` spec has neither, and used to be filed here
// as though it were a component definition — accepted by this script, rejected
// far away at publish or, worse, published in the wrong shape. Named at the
// point the mistake is visible instead.
const definitions = views.map((view, index) => {
  if (view && typeof view === "object" && view.definition) return view.definition;
  if (view && typeof view === "object" && view.renderer && view.dataSlots) return view;
  throw new Error(
    \`views[\${index}]\${view?.id ? \` ("\${view.id}")\` : ""} is not a registered component. \` +
      "Export the result of defineHostComponent (or a starter factory like createDataTable()), " +
      "not a bare defineView spec — a component needs its renderer, which the spec does not carry. " +
      "A file written with defineView plus a default export becomes one by being ingested: " +
      "ingestViewDirectory from @renderyes/react/ingest-fs here in Node, or ingestViews over " +
      "an import.meta.glob in the browser.",
  );
});
const site = defineSite({
  id: ${JSON.stringify(answers.catalogId)},
  name: ${JSON.stringify(answers.sourceLabel)},
  version: "1.0.0",
  catalogId: ${JSON.stringify(answers.catalogId)},
  components: definitions,
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main surface.",
      componentIds: definitions.map((definition) => definition.id),
    }),
  ],
});

if (emitTo) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(emitTo, \`\${JSON.stringify(toSiteManifest(site), null, 2)}\n\`);
  console.log(\`Wrote \${definitions.length} component(s) to \${emitTo}.\`);
  process.exit(0);
}

const response = await fetch(new URL("api/ui-catalog", serviceBase), {
  method: "POST",
  // The same header name the scaffolded mount's requireAdmin reads —
  // \`ADMIN_TOKEN_HEADER\` in @renderyes/server, inlined here because this
  // repository does not depend on the server package.
  headers: { "content-type": "application/json", "x-renderyes-admin-token": adminToken },
  // \`catalogId\` names the *capability* catalog this UI renders. It defaults to
  // the site's own id, which is why a site called \`<catalog>-ui\` publishes
  // fine and then resolves nothing at compose.
  body: JSON.stringify({ manifest: toSiteManifest(site), catalogId: ${JSON.stringify(
    answers.catalogId,
  )} }),
});

const summary = await response.json();
if (!response.ok) {
  console.error("Publish failed:", summary.error ?? response.status);
  process.exit(1);
}

console.log(\`Published \${summary.componentIds.length} component(s) under "\${summary.catalogId}".\`);
if (summary.capabilityCatalogRegistered === false) {
  console.error(
    \`\\nNo capability catalog is registered under "\${summary.catalogId}". Nothing will\\n\` +
      "resolve at compose until one is. If that catalog is published under a\\n" +
      "different id, this UI catalog is filed where nothing looks for it.",
  );
  process.exit(1);
}
if ((summary.unrenderableDataTypes ?? []).length > 0) {
  console.error(
    \`\\nApproved data types no component here can render:\\n  \${summary.unrenderableDataTypes.join("\\n  ")}\\n\` +
      "The planner will never select these; the symptom is a thin answer, not an error.",
  );
}
`;
}

/**
 * What crosses a repository boundary when the two halves are separate.
 *
 * Four facts that are otherwise carried by a person between two teams, and the
 * one-string rule survives the split only because they travel as data. No
 * secrets: the auth *shape*, never a value, so this can be handed over the same
 * way the login script already is.
 */
export function handoffFile(answers) {
  return `${JSON.stringify(
    {
      format: "renderyes.handoff",
      formatVersion: 1,
      catalogId: answers.catalogId,
      serviceUrl: answers.serviceUrl,
      adminTokenEnv: answers.adminTokenEnv,
      auth: { style: answers.sessionStyle },
      corsRegistered: answers.frontendOrigin ? [answers.frontendOrigin] : [],
    },
    null,
    2,
  )}\n`;
}

/**
 * A root layout for the wizard's own route group.
 *
 * Only written when the host has no root layout this page could inherit — a
 * Next app that puts `<html>`/`<body>` inside route groups rather than at
 * `app/layout`, which is what Payload's `(frontend)`/`(payload)` split does and
 * what Next documents as multiple root layouts. Without one, the scaffolded
 * page is served as HTTP 200 with an empty shell and
 * `NEXT_MISSING_ROOT_TAGS` in the body: alive to a status-code check, dead to a
 * reader.
 *
 * Deliberately bare. It carries no stylesheet import, because guessing which of
 * the host's globals belongs here is how a scaffolder breaks a page it was
 * asked to add.
 *
 * It said so only in this file's own header, which is not where the reader is
 * when they meet the symptom. A live install rendered the page with browser
 * defaults and nothing pointed at the cause — the site's Tailwind build hangs
 * off a sibling route group's layout, one import away and invisible. The
 * generated file now names the missing line at the top, where someone looking
 * at an unstyled page will read it.
 */
export function nextRootLayout() {
  return `${BANNER("A root layout for this page's route group.")}
//
// Your app keeps its root layout inside a route group, so this page needs one
// of its own — Next requires every top-level group to supply <html> and <body>
// when there is no app/layout.
//
// NO STYLESHEET IS IMPORTED HERE, on purpose: guessing which of your globals
// belongs in a page we just added is how a scaffolder breaks a working site.
// So this page renders with browser defaults until you add the import your
// other route group already has — usually one line, e.g.
//
//   import "../globals.css";
//
// To adopt your site's own chrome wholesale instead: move the renderyes
// directory into the route group that holds your layout, and delete this file.

export const metadata = { title: "RenderYes" };

export default function RenderYesRootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;
}
