/**
 * Getting from a schema to a published catalog.
 *
 * Two routes, and the fork is a real choice rather than a preference.
 *
 * **Headless** runs `renderyes-catalog inventory`, `candidate`, `compile` and
 * `publish` — the whole way, with a human editing the decisions in the middle.
 * Scriptable and reproducible. The candidate step approves visitor access to
 * every field discovery found, which is a starting point and not a review; the
 * CLI refuses to do it without `--approve-all-discovered` spelled out, and this
 * tool passes that warning through verbatim rather than summarising it away.
 *
 * **Browser** serves the review app behind a proxy to the host's own mount, so
 * an actual person decides field by field. Publishing then goes through their
 * real `requireAdmin`.
 *
 * GraphQL only, and it says so. The catalog CLI imports only GraphQL builders,
 * and the review-export bundle is `bindingKind: "graphql"` by construction, so
 * an OpenAPI host has neither a headless route nor a bundle. Claiming otherwise
 * would be the kind of promise a doc makes and the code cannot keep.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CATALOG_PACKAGE = "@renderyes/capability-catalog";

function runCatalogCli(args, { cwd, env }) {
  const run = spawnSync(
    "npx",
    ["--yes", "--package", CATALOG_PACKAGE, "renderyes-catalog", ...args],
    {
      cwd,
      encoding: "utf8",
      shell: process.platform === "win32",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    },
  );
  return {
    ok: run.status === 0,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    status: run.status,
  };
}

/**
 * Schema file or endpoint to a candidate decisions file, without a browser.
 *
 * The `--schema` pass on `candidate` is deliberate: it compiles what was just
 * built, so a candidate that cannot publish fails here rather than at publish,
 * and it prints the planner-manifest size where the approving is happening
 * rather than after every decision that determines it.
 */
export function inventoryAndCandidate({ cwd, schemaPath, catalogId, rows, semanticTypes, shapes, queries }) {
  const inventoryPath = join(cwd, `${catalogId}.inventory.json`);
  const decisionsPath = join(cwd, `${catalogId}.decisions.json`);

  const inventory = runCatalogCli(
    [
      "inventory", "--schema", schemaPath, "--catalog-id", catalogId,
      // Discovery proposes four of nine result shapes and a schema cannot
      // express the rest, so a host correcting one does the expected thing.
      ...(shapes ? ["--shapes", shapes] : []),
      // Without this the whole schema is inventoried. On a large commerce API
      // that is 86 capabilities and tens of megabytes, and every one of them
      // then needs a decision — the format has no "declined", so narrowing
      // afterwards means taking the inventory again.
      ...(queries ? ["--queries", queries] : []),
      "--out", inventoryPath,
    ],
    { cwd },
  );
  if (!inventory.ok) {
    return { ok: false, stage: "inventory", message: inventory.stderr || inventory.stdout };
  }

  const candidate = runCatalogCli(
    [
      "candidate",
      "--inventory",
      inventoryPath,
      "--approve-all-discovered",
      "--schema",
      schemaPath,
      ...(rows ? ["--rows", String(rows)] : []),
      // Fields discovery could not place need a host-decided semantic type;
      // without this passthrough the headless route refused its own output
      // with no way to answer short of hand-editing the emitted JSON.
      ...(semanticTypes ? ["--semantic-types", semanticTypes] : []),
      "--out",
      decisionsPath,
    ],
    { cwd },
  );
  if (!candidate.ok) {
    return { ok: false, stage: "candidate", message: candidate.stderr || candidate.stdout };
  }

  return {
    ok: true,
    inventoryPath,
    decisionsPath,
    // Passed through rather than summarised: it carries the approve-everything
    // warning and the contract cost, both of which are the point.
    notes: candidate.stderr.trim(),
  };
}

/**
 * The other half of the headless route: edited decisions to a live catalog.
 *
 * `inventoryAndCandidate` used to be the end of the road — it produced a
 * decisions file and there was no verb that could do anything with one, so a host who did
 * exactly what the tool asked (cut the candidate down, decide the arguments)
 * had nowhere to go but the browser app they were avoiding. `compile` and
 * `publish` are the two steps that were missing.
 *
 * Capability half only unless a UI manifest is supplied. That is deliberate:
 * the UI catalog is built from components that exist in the host's repository
 * and nowhere else, so this cannot produce one, and pretending otherwise would
 * publish a starter set over the host's own.
 */
export function compileAndPublish({
  cwd,
  schemaPath,
  inventoryPath,
  decisionsPath,
  endpoint,
  uiManifest,
  serviceUrl,
  adminToken,
  catalogId,
}) {
  const compiledPath = join(cwd, `${catalogId}.catalog.json`);
  const compile = runCatalogCli(
    [
      "compile",
      "--schema", schemaPath,
      "--inventory", inventoryPath,
      "--decisions", decisionsPath,
      "--endpoint", endpoint,
      ...(uiManifest ? ["--ui-manifest", uiManifest] : []),
      "--out", compiledPath,
    ],
    { cwd },
  );
  if (!compile.ok) {
    return { ok: false, stage: "compile", message: compile.stderr || compile.stdout };
  }

  // The token goes to the child as an environment variable under the name the
  // CLI reads, never as an argument: an argument is in the shell history and in
  // the process list for everyone on the box.
  const publish = runCatalogCli(
    ["publish", "--service-url", serviceUrl, "--file", compiledPath],
    { cwd, env: { RENDERYES_ADMIN_TOKEN: adminToken } },
  );
  if (!publish.ok) {
    return { ok: false, stage: "publish", message: publish.stderr || publish.stdout };
  }
  return {
    ok: true,
    compiledPath,
    bundled: Boolean(uiManifest),
    notes: `${compile.stderr.trim()}\n${publish.stdout.trim()}`.trim(),
  };
}

/**
 * Publishes a review-export bundle through the host's own mount.
 *
 * The bundle is one call carrying both catalogs with the id threaded through,
 * so the two cannot disagree — which is the failure the two-call path makes
 * silently. It also declares `requirements.upstreamOrigins`, and the server
 * checks those before publishing anything, so an allowlist mismatch leaves the
 * server unchanged and says what to configure.
 */
export async function publishBundle({ serviceUrl, adminToken, bundlePath }) {
  if (!existsSync(bundlePath)) {
    return { ok: false, message: `No bundle at ${bundlePath}` };
  }
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  } catch (cause) {
    return { ok: false, message: `Bundle is not valid JSON: ${String(cause)}` };
  }

  // Trailing slash before resolving, or the mount prefix's last segment is
  // replaced instead of appended — same normalization as live.mjs's call().
  const response = await fetch(new URL("api/review-export", serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`), {
    method: "POST",
    headers: { "content-type": "application/json", "x-renderyes-admin-token": adminToken },
    body: JSON.stringify(bundle),
  });
  const text = await response.text();
  let summary;
  try {
    summary = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: `Expected JSON from the mount, got ${text.slice(0, 80)}…`,
    };
  }
  if (!response.ok) {
    return { ok: false, message: summary.error ?? `HTTP ${response.status}` };
  }
  return { ok: true, summary };
}

/**
 * What the review app produced, if the host went the browser route.
 *
 * It downloads `<catalogId>.review-export.json`. Rather than watching a
 * downloads directory — different per platform, per browser, per
 * configuration — the host is asked where it landed, and the common places are
 * checked first so the answer is usually one keystroke.
 */
export function findBundle({ cwd, catalogId }) {
  const candidates = [
    join(cwd, `${catalogId}.review-export.json`),
    join(process.env.HOME ?? "", "Downloads", `${catalogId}.review-export.json`),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
