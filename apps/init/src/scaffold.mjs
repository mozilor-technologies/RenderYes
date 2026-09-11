/**
 * Writing files into someone else's repository.
 *
 * Two rules, both about not being clever.
 *
 * **Never overwrite.** A file that exists is the host's, whether they wrote it
 * or an earlier run did. On collision this reports and refuses — it does not
 * merge, back up, or write alongside with a suffix. A scaffolder that edits
 * existing code is a scaffolder nobody can safely re-run.
 *
 * **Never half-write.** The whole plan is computed, then checked for
 * collisions, then written. A run that fails partway leaves nothing behind,
 * because a mount without its provider is harder to diagnose than an empty
 * directory.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  exampleView,
  expressMount,
  frontendRoute,
  handoffFile,
  nextRootLayout,
  nextRouteHandler,
  publishUiScript,
  manualMount,
  standaloneEnvExample,
  standaloneManifest,
  standaloneService,
  viewsIndex,
} from "./templates.mjs";

/**
 * Every file a given set of answers produces, as {path, contents, why}.
 *
 * Computed rather than written so `--dry-run` shows exactly the same list the
 * real run would produce — a preview that runs different code from the thing it
 * previews is not a preview.
 */
/**
 * Frameworks a mount template exists for.
 *
 * Detection knows four; only these two are written. A host on one of the others
 * previously defaulted to mounting and received the Express file — `app.use`
 * with a Node req/res handler, which fastify does not have and hono does not
 * mean. Detection is a promise, and this is the list that can keep it; the
 * standalone service is framework-agnostic by construction and covers the rest.
 */
export const MOUNTABLE_FRAMEWORKS = Object.freeze(["next", "express"]);

export function hasMountTemplate(frameworkId) {
  return MOUNTABLE_FRAMEWORKS.includes(frameworkId);
}

/** Extensions Next will route a `page.*` or `layout.*` from. */
const ROUTE_EXTENSIONS = ["jsx", "tsx", "js", "ts"];

/** `(frontend)`, `(payload)` — a directory that groups routes without naming a path segment. */
function isRouteGroup(segment) {
  return segment.startsWith("(") && segment.endsWith(")");
}

/**
 * The URL a Next `page.*` is served at, or undefined when the file is not a
 * route.
 *
 * A file's directory is not its route, and that gap is what took a host down.
 * Route groups contribute no path segment — that is the entire point of them —
 * so `(frontend)/renderyes/page.jsx` and `renderyes/page.jsx` are the same
 * URL, and Next refuses to serve a project containing both: every route 500s,
 * the host's own homepage included. The wizard wrote the second one because it
 * checked for the first by exact path, found nothing, and concluded the page
 * was missing.
 *
 * Segments beginning with `_` are private folders and are not routed at all.
 */
export function nextRouteOf(relativePath, appDir) {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const base = appDir.split(/[\\/]/).filter(Boolean);
  if (base.some((segment, index) => parts[index] !== segment)) return undefined;
  const rest = parts.slice(base.length);
  const file = rest.pop();
  if (!file || !ROUTE_EXTENSIONS.some((extension) => file === `page.${extension}`)) {
    return undefined;
  }
  if (rest.some((segment) => segment.startsWith("_"))) return undefined;
  return `/${rest.filter((segment) => !isRouteGroup(segment)).join("/")}`;
}

/** Every route the host already serves out of `appDir`, as route -> the file serving it. */
function existingNextRoutes(root, appDir) {
  const routes = new Map();
  const start = join(root, appDir);
  if (!existsSync(start)) return routes;
  const stack = [start];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        stack.push(full);
        continue;
      }
      const route = nextRouteOf(relative(root, full), appDir);
      if (route !== undefined && !routes.has(route)) routes.set(route, relative(root, full));
    }
  }
  return routes;
}

/**
 * Where a scaffolded page has to live to render, and whether it needs a layout
 * of its own.
 *
 * Next requires `<html>` and `<body>` from a root layout. Most apps put one at
 * `app/layout`; some put one inside each top-level route group instead, which
 * is a documented pattern and what a Payload app does with its
 * `(frontend)`/`(payload)` split. A page written outside any of them is served
 * as HTTP 200 with an empty shell — alive to a status check, dead to a reader.
 *
 * Four cases. With a root layout, nothing is needed. With exactly one group
 * carrying a layout, the page belongs in it. With several, there is no way to
 * choose that is not a guess about what the host's groups mean — so the page
 * gets a group and a bare root layout of its own rather than being dropped into
 * somebody else's; it renders unstyled, and the layout beside it says how to
 * adopt the host's chrome in one move. With no layout anywhere, nothing is
 * interpreted and the page goes where it always went.
 */
function nextLayoutPlan(root, appDir) {
  const directory = root ? join(root, appDir) : undefined;
  if (!directory || !existsSync(directory)) return { group: undefined, ownLayout: false };
  const layoutIn = (...segments) =>
    ROUTE_EXTENSIONS.some((extension) =>
      existsSync(join(directory, ...segments, `layout.${extension}`)),
    );
  if (layoutIn()) return { group: undefined, ownLayout: false };
  const groups = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isRouteGroup(entry.name))
    .map((entry) => entry.name)
    .filter((name) => layoutIn(name));
  if (groups.length === 1) return { group: groups[0], ownLayout: false };
  if (groups.length > 1) return { group: "(renderyes)", ownLayout: true };
  // No layout anywhere: not a host whose grouping needs interpreting, just one
  // this tool does not understand. The ungrouped path is where the page would
  // always have gone, and inventing a route group for a layout the host has
  // not adopted anywhere would be a bigger guess than leaving it alone.
  return { group: undefined, ownLayout: false };
}

export function planFiles(project, answers, { role }) {
  const files = [];
  const wantsBackend = role === "backend" || role === "both";
  const wantsFrontend = role === "frontend" || role === "both";
  const next = project.framework?.id === "next";
  // Next reads routes from `app/` or `src/app/` — whichever the host already
  // uses. Everything scaffolded for a Next host lives under that directory,
  // frontend included: `src/renderyes/page.jsx` is not a route in Next's
  // convention, and a plan that mixes the two layouts contradicts itself.
  const appDir =
    next && project.root && existsSync(join(project.root, "src", "app"))
      ? join("src", "app")
      : "app";

  if (wantsBackend) {
    if (answers.topology === "standalone") {
      const base = answers.outDir ?? "renderyes-service";
      files.push(
        {
          path: join(base, "server.mjs"),
          contents: standaloneService(answers),
          why: "the service itself — mount, boot step, and the five decisions",
        },
        {
          path: join(base, "package.json"),
          contents: standaloneManifest(answers),
          why:
            "its own manifest and start script — the installer writes the " +
            "dependency versions that actually resolved, so run the install " +
            "before deploying this directory on its own",
        },
        {
          path: join(base, ".env.example"),
          contents: standaloneEnvExample(answers),
          why: "the two variables it reads, and why one of them is local-only",
        },
      );
    } else if (next) {
      // The route directory is derived from the mount path so the mount and
      // the client's serviceUrl cannot drift apart — they are the same string.
      const mountSegments = (answers.mountPath ?? "/api/renderyes")
        .split("/")
        .filter(Boolean);
      files.push({
        // route.js, not route.ts: a JS route runs in every Next host, while a
        // generated .ts file fails `next build` under strict type-checking and
        // triggers the TypeScript bootstrap in a JS-only host.
        path: join(appDir, ...mountSegments, "[...route]", "route.js"),
        contents: nextRouteHandler(answers),
        why: "the handler is the route; catalogs are replayed before the first request",
      });
    } else if (project.framework?.id === "express") {
      files.push({
        path: join("src", "renderyes.mjs"),
        contents: expressMount(answers),
        why: "exports mountRenderYes(app) — call it before app.listen()",
      });
    } else {
      // Everything that is not Next used to land in the Express branch, so a
      // fastify host, a hono host, and a host whose framework was not detected
      // each received `app.use(path, handler)` — which fastify does not have
      // and hono does not mean. `hasMountTemplate` previously only steered the
      // interview's default topology, which a host passing `--topology coexist`
      // walks straight past.
      files.push({
        path: join("src", "renderyes.mjs"),
        contents: manualMount(answers, { frameworkId: project.framework?.id }),
        why: project.framework?.id
          ? `exports handler + startRenderYes — ${project.framework.id} has no template, so the last step is yours`
          : "exports handler + startRenderYes — attach it wherever your server routes",
      });
    }
  }

  if (wantsFrontend) {
    // For a Next host this is a real route (`/renderyes`); anywhere else it
    // is a component the host mounts on a route of its own, and the plan says
    // so instead of implying a path any framework would pick up by itself.
    const layout = next ? nextLayoutPlan(project.root, appDir) : { ownLayout: false };
    const frontendBase = next
      ? join(appDir, ...(layout.group ? [layout.group] : []), "renderyes")
      : join("src", "renderyes");
    if (layout.ownLayout) {
      files.push({
        path: join(appDir, layout.group, "layout.jsx"),
        contents: nextRootLayout(),
        why: "your root layout lives inside a route group, so this page needs one of its own",
      });
    }
    files.push(
      {
        path: join(frontendBase, "page.jsx"),
        contents: frontendRoute(answers, { next }),
        // Carried so a collision is judged by the URL this serves rather than
        // by the directory it sits in — a page the host moved into a route
        // group is the same route, and writing a second one breaks the build.
        ...(next ? { route: "/renderyes", routeRoot: appDir } : {}),
        why: next
          ? "the full-page surface, served at /renderyes"
          : "the full-page surface — a component to mount on a route of yours, not a route itself",
      },
      {
        path: join(frontendBase, "views", "index.js"),
        contents: viewsIndex(),
        why: "where your components are registered — the part that makes it yours",
      },
      {
        path: join(frontendBase, "views", "order-summary.jsx"),
        contents: exampleView(),
        why: "one component of your own, to copy the shape of",
      },
      {
        path: join("scripts", "publish-ui-catalog.mjs"),
        // Import specifiers are POSIX regardless of the platform the scaffold
        // ran on, so the path is assembled with "/" rather than join().
        contents: publishUiScript(answers, {
          viewsImport: `../${frontendBase.split(/[\\/]/).join("/")}/views/index.js`,
        }),
        why: "publishes your components, and reads back whether the id matched",
      },
    );
  }

  // Only when the halves are apart: the four facts that otherwise travel by
  // hand between two teams. Standalone is always apart.
  if (answers.topology === "standalone" && wantsBackend) {
    files.push({
      path: "renderyes.handoff.json",
      contents: handoffFile(answers),
      why: "hand this to whoever sets up the frontend; `--handoff` consumes it",
    });
    // The service directory gets its own, saying what *it* is. Run from inside
    // it, `doctor` read the parent's dependencies and called a service that
    // renders nothing `both`, then asked it to install React.
    files.push({
      path: join(answers.outDir ?? "renderyes-service", "renderyes.mount.json"),
      contents: `${JSON.stringify(
        { catalogId: answers.catalogId, role: "backend", topology: "standalone" },
        null,
        2,
      )}\n`,
      why: "what this directory is, so `doctor` run from inside it does not guess",
    });
  }

  // What this run decided, recorded rather than left to be inferred.
  //
  // Role and topology are chosen here — from the host's answers and their
  // dependencies — and were then guessed back later from directory contents,
  // by a detector that has never seen the layout this tool itself writes. It
  // reported `unknown` in the app directory and `both` in a backend-only
  // service, and demanded frontend packages of a service that renders nothing.
  // A tool should never infer what it can record.
  files.push({
    path: "renderyes.mount.json",
    contents: `${JSON.stringify(
      {
        catalogId: answers.catalogId,
        role,
        topology: answers.topology,
        ...(answers.outDir ? { outDir: answers.outDir } : {}),
      },
      null,
      2,
    )}\n`,
    why: "what this run decided, so `doctor` reads it back instead of guessing",
  });

  return files;
}

/**
 * Every planned file that must not be written, and what is already there.
 *
 * Two ways a file can already exist: at the exact path, or — for a Next page —
 * at a different path serving the same route. The second is not a nicety. A
 * host that moves the scaffolded page into a route group so it renders leaves
 * the original path empty, and an exact-path check then reports the page as
 * missing and writes it again, at which point Next refuses two parallel routes
 * and the whole application 500s.
 */
export function collisionReport(root, files) {
  const routesByRoot = new Map();
  const report = [];
  for (const file of files) {
    if (existsSync(join(root, file.path))) {
      report.push({ planned: file.path, existing: file.path, sameRoute: false });
      continue;
    }
    if (file.route === undefined || file.routeRoot === undefined) continue;
    if (!routesByRoot.has(file.routeRoot)) {
      routesByRoot.set(file.routeRoot, existingNextRoutes(root, file.routeRoot));
    }
    const existing = routesByRoot.get(file.routeRoot).get(file.route);
    if (existing !== undefined) {
      report.push({ planned: file.path, existing, sameRoute: true });
    }
  }
  return report;
}

export function findCollisions(root, files) {
  return collisionReport(root, files).map((entry) => entry.planned);
}

/**
 * Writes the plan, or refuses entirely.
 *
 * The collision check covers the whole plan before the first write, so a
 * conflict on the last file does not leave the first four behind.
 */
export function writePlan(root, files, { dryRun = false } = {}) {
  const collisions = findCollisions(root, files);
  if (collisions.length > 0) {
    return { written: [], refused: collisions };
  }
  if (dryRun) return { written: [], refused: [], planned: files.map((file) => file.path) };

  const written = [];
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents);
    written.push(relative(root, target));
  }
  return { written, refused: [] };
}
