/**
 * Everything the checks read about a project, derived and never remembered.
 *
 * There is no state file anywhere in this tool. Each check re-derives what it
 * needs from the project on disk and the running server, which is what makes
 * the walk resumable: interrupt it, re-run it, hand it to a colleague, and it
 * continues from the first thing that is not true yet. A progress file would be
 * one more thing to go stale against the repo it describes.
 *
 * Detection is by artifact, never by convention. A lockfile names the package
 * manager; a dependency names the framework. Guessing from directory layout is
 * how a tool becomes confidently wrong about someone else's project.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** Packages a host installs, by tier. Tools are invoked, never installed. */
export const FRONTEND_PACKAGES = Object.freeze([
  "@renderyes/react",
  "@renderyes/site-sdk",
]);
export const FRONTEND_OPTIONAL = Object.freeze(["@renderyes/starter-catalog"]);
/**
 * `site-sdk` is here as well as in the frontend tier because both halves
 * import it: the browser registers components with it, and the server builds
 * the UI manifest it publishes — `defineComponent`, `defineSite`,
 * `toSiteManifest`, which is the documented code-first route.
 *
 * A backend-only host got `server` alone, and `server` does not re-export any
 * of that. Under pnpm's isolated `node_modules` a transitive dependency is not
 * importable, so the first line of the code-first guide failed on an install
 * this tool had reported complete.
 */
export const BACKEND_PACKAGES = Object.freeze([
  "@renderyes/server",
  "@renderyes/site-sdk",
]);
/**
 * Tools tier. Present in a host's dependencies means someone installed a
 * build-time GUI or a CLI into a deployed application — the review app ships
 * browser assets, and this package scaffolds files. Neither belongs in a
 * runtime dependency tree.
 */
export const TOOL_PACKAGES = Object.freeze([
  "@renderyes/catalog-review",
  "@renderyes/init",
]);

const LOCKFILES = Object.freeze([
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lockb", manager: "bun" },
]);

/**
 * Frameworks whose mount shape differs structurally, not just in syntax.
 *
 * The distinction that matters is where the boot step goes: a fetch-native
 * route handler has no `listen` to be "before", so `restorePublishedCatalogs()`
 * is a module-level await; a Node server has one, and the call must precede it.
 * Scaffolding the wrong shape produces a mount that looks right and serves
 * "no published catalog" on every request after a restart.
 */
const FRAMEWORKS = Object.freeze([
  { dependency: "next", id: "next", bootStyle: "module-await" },
  { dependency: "hono", id: "hono", bootStyle: "module-await" },
  { dependency: "express", id: "express", bootStyle: "before-listen" },
  { dependency: "fastify", id: "fastify", bootStyle: "before-listen" },
]);

function readJsonIfPresent(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Every dependency field merged, because a host may put ours in any of them. */
export function declaredDependencies(manifest) {
  return {
    ...(manifest?.dependencies ?? {}),
    ...(manifest?.devDependencies ?? {}),
    ...(manifest?.peerDependencies ?? {}),
  };
}

export function detectPackageManager(root) {
  const found = LOCKFILES.find((candidate) => existsSync(join(root, candidate.file)));
  // Reported as unknown rather than defaulted to npm: running the wrong package
  // manager in a workspace leaves a second lockfile and a node_modules layout
  // the first one did not expect, and the damage outlives the install.
  return found ? found.manager : undefined;
}

export function detectFramework(dependencies) {
  return FRAMEWORKS.find((candidate) => dependencies[candidate.dependency]);
}

/**
 * Which halves of the integration live here.
 *
 * Both is the common case and one is normal: a host may keep its frontend and
 * backend in separate repositories, and then each side is set up on its own
 * with the other's decisions arriving as a handoff file rather than as a second
 * round of questions.
 */
/**
 * What a previous run of this tool recorded about this directory.
 *
 * Absent for a host's own tree, which is the normal case and not a problem —
 * detection handles that. Present only where the scaffold wrote it, which is
 * exactly where guessing was wrong.
 */
export function readMountMarker(root) {
  if (!root) return undefined;
  try {
    const raw = readFileSync(join(root, "renderyes.mount.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    // A missing marker is the common case; a corrupt one must not stop a
    // diagnosis that works fine without it.
    return undefined;
  }
}

export function detectRole(dependencies) {
  const frontend =
    Boolean(dependencies["react"]) ||
    FRONTEND_PACKAGES.some((name) => dependencies[name]);
  const backend =
    Boolean(detectFramework(dependencies)) ||
    BACKEND_PACKAGES.some((name) => dependencies[name]);
  if (frontend && backend) return "both";
  if (frontend) return "frontend";
  if (backend) return "backend";
  return undefined;
}

/**
 * The scope mapping a host needs before anything named `@renderyes` resolves.
 *
 * Read from every `.npmrc` the package manager itself would read: the project
 * root, each directory above it (a pnpm/npm workspace keeps one at the
 * workspace root while this tool runs in an app folder below it), then the
 * user-level `~/.npmrc`. Reading only `<root>/.npmrc` reported "not
 * configured" for setups whose installs plainly succeed — the check
 * predicting an install must look where the install looks.
 *
 * Only the *scope* line is searched for. A token in `~/.npmrc` is the right
 * place for a secret and none of this tool's business; the mapping is the
 * part that belongs in the project and is safe to commit, which is what the
 * remedies keep recommending.
 */
export function detectScopeMapping(root, { home = homedir() } = {}) {
  const candidates = [];
  let directory = root;
  for (;;) {
    candidates.push(join(directory, ".npmrc"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const userNpmrc = join(home, ".npmrc");
  if (!candidates.includes(userNpmrc)) candidates.push(userNpmrc);

  for (const npmrc of candidates) {
    if (!existsSync(npmrc)) continue;
    const line = readFileSync(npmrc, "utf8")
      .split("\n")
      .find((candidate) => candidate.trim().startsWith("@renderyes:registry="));
    if (!line) continue;
    return {
      configured: true,
      registry: line.split("=").slice(1).join("=").trim(),
      source: npmrc,
    };
  }
  return { configured: false };
}

/** Files that mention a symbol, searched shallowly through source directories. */
export function findSourceFilesContaining(root, needles, options = {}) {
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    ".turbo",
  ]);
  const extensions = options.extensions ?? [".ts", ".tsx", ".js", ".jsx", ".mjs"];
  const maxDepth = options.maxDepth ?? 6;
  const matches = [];

  const walk = (directory, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry) || entry.startsWith(".")) continue;
      const path = join(directory, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!extensions.some((extension) => entry.endsWith(extension))) continue;
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (needles.some((needle) => text.includes(needle))) {
        matches.push({ path, text });
      }
    }
  };

  walk(root, 0);
  return matches;
}

/**
 * The `@renderyes/*` versions actually on disk, read from `node_modules`.
 *
 * The declared range is not the answer: a host who wrote `^0.1.0` and a host
 * who pinned a build can hold the same manifest line over different code.
 * Only the installed manifest says what will run.
 */
export function detectInstalledVersions(root) {
  const versions = {};
  const scope = join(root, "node_modules", "@renderyes");
  if (!existsSync(scope)) return versions;
  for (const entry of readdirSync(scope)) {
    const manifest = readJsonIfPresent(join(scope, entry, "package.json"));
    if (manifest?.version) versions[`@renderyes/${entry}`] = manifest.version;
  }
  return versions;
}

/**
 * This CLI's own version, from the manifest beside it.
 *
 * Read from disk rather than baked in at build time so it cannot go stale
 * against the package it ships in. Undefined if unreadable, and every caller
 * treats that as "make no claim" — a version check that guesses is worse than
 * none.
 */
export function detectCliVersion() {
  const manifest = readJsonIfPresent(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
  );
  return typeof manifest?.version === "string" ? manifest.version : undefined;
}

/** Everything derived about a project, in one pass. */
export function inspectProject(rootInput = process.cwd()) {
  const root = resolve(rootInput);
  const manifest = readJsonIfPresent(join(root, "package.json"));
  const dependencies = declaredDependencies(manifest);
  const marker = readMountMarker(root);
  return {
    root,
    manifest,
    dependencies,
    installedVersions: detectInstalledVersions(root),
    cliVersion: detectCliVersion(),
    packageManager: detectPackageManager(root),
    framework: detectFramework(dependencies),
    // Recorded beats inferred. `detectRole` reads dependencies, which is the
    // right answer for a host's own tree and the wrong one for a directory this
    // tool wrote: a standalone service renders nothing and has no React, so it
    // was read as `both` and asked for frontend packages it will never import.
    role: marker?.role ?? detectRole(dependencies),
    ...(marker ? { mount: marker } : {}),
    scope: detectScopeMapping(root),
  };
}

/**
 * A catalog id derived from the project rather than invented by the host.
 *
 * `catalogId` is a durable storage key — react's README calls it exactly that,
 * and changing it later orphans every saved view filed under the old one. So a
 * stable default beaten out of the package name is truer to how it is meant to
 * be chosen than asking someone to think of a name on the spot. The npm scope
 * is dropped: it says who publishes the app, not which catalog this is.
 */
export function deriveCatalogId(manifest) {
  const raw = String(manifest?.name ?? "").replace(/^@[^/]+\//, "");
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : undefined;
}

/**
 * What a previous run already committed to, read from the repository.
 *
 * A re-run used to re-ask every question with defaults derived from
 * package.json, while `doctor` printed the true values from the same files two
 * lines earlier. Pressing Enter through a second walk therefore filed the UI
 * catalog under an id nothing looks up — and the catalog-id default was the
 * package name, so the two runs disagreed by construction.
 *
 * Literals only, and silent when it finds none or finds several: a value that
 * comes from configuration is a correct setup this cannot see, and guessing
 * between two is worse than offering the derived default.
 */
export function existingChoices(root) {
  const found = {};
  const once = (needle, pattern) => {
    const values = new Set();
    for (const match of findSourceFilesContaining(root, [needle])) {
      for (const hit of match.text.matchAll(pattern)) values.add(hit[1]);
    }
    return values.size === 1 ? [...values][0] : undefined;
  };
  const catalogId = once("catalogId", /catalogId\s*:\s*["'`]([^"'`]+)["'`]/g);
  if (catalogId) found.catalogId = catalogId;
  const serviceUrl = once("serviceUrl", /serviceUrl\s*:\s*["'`]([^"'`]+)["'`]/g);
  if (serviceUrl) found.serviceUrl = serviceUrl;
  const endpoint = once("endpoint", /endpoint\s*:\s*["'`](https?:[^"'`]+)["'`]/g);
  if (endpoint) found.schemaEndpoint = endpoint;
  const adminTokenEnv = once("ADMIN_TOKEN", /process\.env\.([A-Z0-9_]*ADMIN_TOKEN[A-Z0-9_]*)/g);
  if (adminTokenEnv) found.adminTokenEnv = adminTokenEnv;
  return found;
}
