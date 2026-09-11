/**
 * The questions, and the rule they follow.
 *
 * **Never be more opinionated than the API being configured.** Where the
 * library takes a function because the answer cannot be a field — identity is
 * the case that matters — the interview offers templates rather than asking for
 * a field name. Asking "which session field identifies a visitor?" produces
 * `session.userId`, which works in development and cross-contaminates between
 * tenants in production; the contract is a function precisely because that
 * answer is sometimes composite.
 *
 * Where a value can be derived it is derived and shown, not asked. Two real
 * choices and four confirmations beats six questions, and a derived catalog id
 * is truer to "pick it once, like a storage key" than asking someone to invent
 * one on the spot.
 *
 * Every prompt has a flag, so the whole thing runs unattended. `--yes` takes
 * every derived default.
 */
import { createInterface } from "node:readline/promises";
import { deriveCatalogId } from "./detect.mjs";
// Inlined rather than imported from @renderyes/capability-catalog: this tool
// runs via npx before anything is installed, and depends on nothing.
const CATALOG_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * The plan providers the server can construct, with the defaults this writes.
 *
 * Mirrors `ModelProviderConfig` in @renderyes/server, which accepts these two
 * ids. `model` has no default there — the host names it — so one is chosen here
 * and left as a literal the host can edit, rather than a value that silently
 * changes under them on an upgrade.
 */
const PLAN_PROVIDERS = Object.freeze({
  openai: { apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5.6" },
  gemini: { apiKeyEnv: "GEMINI_API_KEY", model: "gemini-3.6-flash" },
});
import { hasMountTemplate } from "./scaffold.mjs";

const SESSION_STYLES = Object.freeze(["cookie", "bearer", "anonymous", "custom"]);
const OWNER_STYLES = Object.freeze(["single-user", "tenant", "nested", "anonymous", "custom"]);

/**
 * An environment-variable *name*, which is the only thing this tool may put in
 * a generated file. Also the shape a pasted token value never has, so this is
 * the gate that keeps a secret out of scaffolded source when someone answers
 * the admin-token question with the token itself.
 */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

async function ask(rl, question, fallback) {
  if (!rl) return fallback;
  const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""} `)).trim();
  return answer.length > 0 ? answer : fallback;
}

async function choose(rl, question, options, fallback) {
  if (!rl) return fallback;
  console.error(`\n${question}`);
  options.forEach((option, index) => {
    console.error(`  ${index + 1}. ${option.label}${option.note ? ` — ${option.note}` : ""}`);
  });
  const raw = (await rl.question(`Choice [${options.findIndex((o) => o.id === fallback) + 1}] `)).trim();
  const picked = raw.length === 0 ? undefined : Number(raw);
  if (!picked || !Number.isInteger(picked) || picked < 1 || picked > options.length) {
    return fallback;
  }
  return options[picked - 1].id;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Resolves every answer the templates need.
 *
 * `flags` wins over a prompt; a prompt wins over a derived default. With
 * `--yes` nothing is prompted at all, which is what makes the tool usable in a
 * test loop and in CI.
 */
export async function conductInterview(project, flags, { interactive = true } = {}) {
  // Never a prompt without a terminal: a readline question over a piped or
  // closed stdin never resolves, and the process dies on an unsettled await.
  // The CLI refuses such a run up front with the flag list; this guard is what
  // makes the refusal a guarantee rather than one caller's behaviour.
  const rl =
    interactive && process.stdin.isTTY
      ? createInterface({ input: process.stdin, output: process.stderr })
      : undefined;
  try {
    const derivedCatalogId = deriveCatalogId(project.manifest);
    const catalogId =
      flags.catalogId ??
      (await ask(
        rl,
        `\nCatalog id — the key your two catalogs are joined by, and a durable storage key.\n` +
          `Derived from this package's name.\nCatalog id?`,
        derivedCatalogId,
      ));
    if (!catalogId) {
      throw new Error(
        "No catalog id: could not derive one from package.json's name. Pass --catalog-id.",
      );
    }
    // Refused here rather than three steps downstream. An id with a space was
    // accepted by this prompt, accepted when the capability catalog was
    // published, rewritten by the file store, and rejected only by the UI
    // catalog — so the wizard reported success on a pair that could never be
    // joined.
    if (!CATALOG_ID_PATTERN.test(catalogId)) {
      throw new Error(
        `Catalog id "${catalogId}" must match ${CATALOG_ID_PATTERN.source}: a letter first, ` +
          `then letters, digits, dot, dash or underscore. It is the key your capability and ` +
          `UI catalogs are joined by, and the UI half accepts nothing else.`,
      );
    }

    const schemaEndpoint =
      flags.schemaEndpoint ??
      (await ask(
        rl,
        `\nYour GraphQL endpoint. This is the one thing RenderYes cannot provide:\n` +
          `the whole model is that you approve reads against data you already own.\nEndpoint?`,
        undefined,
      ));

    // Derived, not asked: the allowlist fails closed, and its correct value is
    // exactly the origin of the endpoint just named.
    const upstreamOrigin = schemaEndpoint ? originOf(schemaEndpoint) : undefined;

    const adminTokenEnv =
      flags.adminTokenEnv ??
      (await ask(
        rl,
        `\nEnvironment variable holding your admin token (it gates every publish route).\n` +
          `The value stays in your environment — this tool never reads or stores it.\nVariable name?`,
        "RENDERYES_ADMIN_TOKEN",
      ));
    if (!ENV_VAR_NAME.test(adminTokenEnv)) {
      throw new Error(
        `"${adminTokenEnv}" is not an environment variable name (expected something like ` +
          "RENDERYES_ADMIN_TOKEN). This answer is written into generated files, so it must " +
          "be the variable's name — never the token itself, which stays in your environment.",
      );
    }

    const sessionStyle =
      flags.sessionStyle ??
      (await choose(
        rl,
        "How does this app already authenticate a visitor?",
        [
          { id: "cookie", label: "A verified cookie", note: "most common" },
          { id: "bearer", label: "A bearer token" },
          {
            id: "anonymous",
            label: "It doesn't — visitors are anonymous",
            note: "public site: only capabilities approved as public will execute",
          },
          { id: "custom", label: "Something else", note: "writes a TODO that throws" },
        ],
        "cookie",
      ));

    // An anonymous site has no visitor identity to ask about: resolveViewOwner
    // is omitted (the server refuses refine/save without one, which is the
    // fail-closed direction), so the owner question would demand an answer the
    // templates are then required to ignore.
    const ownerStyle =
      sessionStyle === "anonymous"
        ? "anonymous"
        : (flags.ownerStyle ??
          (await choose(
            rl,
            "What identifies a visitor, for deciding whose saved views are whose?",
            [
              { id: "single-user", label: "A user id", note: "session.userId" },
              {
                id: "tenant",
                label: "A user within a tenant",
                note: "composite — a user id alone lets one tenant reach another's views",
              },
              { id: "nested", label: "A nested field", note: "session.user.id" },
              {
                id: "anonymous",
                label: "Nothing — visitors are anonymous",
                note: "composes work; saving views refuses until an identity exists",
              },
              { id: "custom", label: "Something else", note: "writes a TODO that throws" },
            ],
            "single-user",
          )));

    const mountable = hasMountTemplate(project.framework?.id);
    const topology =
      flags.topology ??
      (await choose(
        rl,
        "Where should the RenderYes server live?",
        [
          {
            id: "standalone",
            label: "Its own Node service",
            note: "for a backend that is not Node",
          },
          {
            id: "coexist",
            label: "Mounted into this app's existing backend",
            note: mountable
              ? `detected ${project.framework.id}`
              : project.framework
                ? `no mount template for ${project.framework.id} — you would adapt the Express one by hand`
                : "no framework detected",
          },
        ],
        // Only a framework a mount template exists for defaults to mounting.
        // Defaulting on detection alone handed fastify and hono a file written
        // for Express.
        mountable ? "coexist" : "standalone",
      ));

    // Mandatory for standalone, where the frontend is on another origin by
    // construction; omitted for co-located, where adding it is noise.
    //
    // No default. This used to fall back to "http://localhost:3000", which the
    // scaffold then wrote as if decided — into the CORS allowlist AND into the
    // handoff file, so a wrong guess travelled to whoever sets up the frontend
    // and surfaced later as preflight failures nothing pointed at. Left blank,
    // the templates emit their TODO branch instead: fail-closed and honest.
    const frontendOrigin =
      flags.frontendOrigin ??
      (topology === "standalone"
        ? await ask(
            rl,
            `\nWhere is your frontend served from? A standalone service is cross-origin by\n` +
              `construction, so this becomes the CORS allowlist and is not optional.\n` +
              `Leave blank to decide later — the scaffold writes a TODO that fails closed.\nFrontend origin?`,
            undefined,
          )
        : undefined);

    const port = Number(flags.port ?? 4200);
    const serviceUrl =
      flags.serviceUrl ??
      (topology === "standalone" ? `http://127.0.0.1:${port}/` : "/api/renderyes");

    const placeholder =
      flags.prompt ??
      (await ask(
        rl,
        `\nA question one of your visitors might actually ask. It becomes the prompt bar's\n` +
          `placeholder, and the wizard composes it once to prove the wiring.\nExample question?`,
        "What should I look at today?",
      ));

    // The one thing a walk that promises to compose cannot do without. Nothing
    // asked for this and nothing wrote it, so a fresh install reached the point
    // of composing the sample question and could only refuse — reported as a
    // warning about configuration the wizard had just declined to configure.
    const planProvider =
      flags.planProvider ??
      (await choose(
        rl,
        "\nWhich model plans a visitor's request? The key stays in your environment —\n" +
          "this writes the variable's name, never a value.",
        [
          { id: "openai", label: "OpenAI", note: `reads ${PLAN_PROVIDERS.openai.apiKeyEnv}` },
          { id: "gemini", label: "Gemini", note: `reads ${PLAN_PROVIDERS.gemini.apiKeyEnv}` },
          {
            id: "none",
            label: "None for now",
            note: "everything but planning is still wired and checked",
          },
        ],
        "openai",
      ));

    return {
      catalogId,
      ...(planProvider && planProvider !== "none"
        ? {
            planProvider: {
              id: planProvider,
              apiKeyEnv: flags.planProviderKeyEnv ?? PLAN_PROVIDERS[planProvider].apiKeyEnv,
              model: flags.planProviderModel ?? PLAN_PROVIDERS[planProvider].model,
            },
          }
        : {}),
      schemaEndpoint,
      upstreamOrigin,
      adminTokenEnv,
      sessionStyle: SESSION_STYLES.includes(sessionStyle) ? sessionStyle : "custom",
      ownerStyle: OWNER_STYLES.includes(ownerStyle) ? ownerStyle : "custom",
      topology,
      frontendOrigin,
      port,
      serviceUrl,
      placeholder,
      // Not the catalog id. `resolveProvenance` must return a source id the
      // catalog declares in `sources`, and the scaffold returned the catalog id
      // instead — so every capability failed execution on a fresh install until
      // the host corrected it by hand. `<catalogId>-source` is what
      // `renderyes-catalog` files its single GraphQL source under, so the two
      // halves of the same wizard now agree by construction.
      sourceId: flags.sourceId ?? `${catalogId}-source`,
      sourceLabel: project.manifest?.name ?? catalogId,
      mountPath: "/api/renderyes",
    };
  } finally {
    rl?.close();
  }
}
