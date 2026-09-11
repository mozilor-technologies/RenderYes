#!/usr/bin/env node
/**
 * Set up and diagnose a RenderYes integration.
 *
 *   npx @renderyes/init                 walk to completion from wherever you are
 *   npx @renderyes/init doctor          verify what exists, change nothing
 *
 * Two frontends over one library of checks (`src/checks.mjs`): `doctor` runs
 * them and reports, and the walk runs them and acts on the first level that is
 * not reached. Nothing is asserted in one mode and assumed in another — that
 * gap is the failure this tool exists to prevent.
 *
 * Reviewing a schema against a running host is `npx @renderyes/catalog-review
 * --host-url <url>`, which proxies the routes the review UI calls and pins them
 * to an allowlist. This tool points at that rather than reimplementing it.
 *
 * Never install this package. It is invoked, and it writes files into a project;
 * a scaffolder in a dependency tree ends up in a deployed application.
 */
import { inspectProject } from "../src/detect.mjs";
import { readEnvVar } from "../src/env.mjs";
import { runLocalChecks } from "../src/checks.mjs";
import { runLiveChecks } from "../src/live.mjs";

/**
 * What `doctor` composes when the caller names no question.
 *
 * Deliberately generic: what this proves is the pipeline — mount, session,
 * catalogs, registration, planning, render — not that any particular question
 * is answerable. A host who wants their own question passes --prompt.
 */
const DEFAULT_DOCTOR_PROMPT = "Show me what is here.";
import { exitCode, reachedLevel, render } from "../src/report.mjs";
import { walk } from "../src/walk.mjs";

const argv = process.argv.slice(2);
// A leading non-flag is the command; anything else means the walk, which is the
// default because it is what someone typing this the first time wants. Flags are
// read from the whole of argv either way, so their position never matters.
const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "walk";

function flag(name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}
const has = (name) => argv.includes(`--${name}`);

function usage() {
  console.error(
    `
Usage
  npx @renderyes/init [options]              set up, resuming from wherever you are
  npx @renderyes/init doctor [options]       report what is true, change nothing

Options
  --service-url <url>        where createViewHttpHandler is mounted; enables live checks
  --page-url <url>          the RenderYes page, checked for whether it renders
  --admin-token-env <NAME>   variable holding your admin token — read from the
                             environment, never prompted for, never stored
  --schema <file>            GraphQL SDL, for the headless candidate route
  --decisions <file>         your reviewed decisions, to compile and publish;
                             needs --schema and --endpoint, and finishes the
                             route --schema starts
  --inventory <file>         the inventory those decisions were made against
                             (defaults to <catalog-id>.inventory.json here)
  --ui-manifest <file>       your components as a site manifest, to publish both
                             halves in one call — npx tsx
                             scripts/publish-ui-catalog.mjs --emit <file>
  --endpoint <url>           your GraphQL endpoint; its origin becomes the
                             upstream allowlist
  --semantic-types <file>    JSON record deciding fields discovery could not
                             place, keyed as the compile error names them
  --shapes <file>            JSON record correcting a capability's result shape,
                             keyed by root field name — discovery can only
                             propose four of the nine
  --queries a,b              inventory only these root fields. Without it the
                             whole schema is taken: on a large API that is
                             dozens of capabilities and tens of megabytes, each
                             needing a decision before anything compiles
  --json                     doctor: emit the checks as JSON instead of a report
  --handoff <file>           consume the other repository's renderyes.handoff.json
  --role frontend|backend|both   override detection
  --catalog-id <id>          override the id derived from package.json
  --prompt <text>            a question in your own words; also the placeholder,
                             and what the verified level composes (doctor uses a
                             generic one when this is absent)
  --session cookie|bearer|anonymous|custom
                             how the app authenticates a visitor
  --owner single-user|tenant|nested|anonymous|custom
                             what identifies a visitor for saved views
  --topology standalone|coexist  where the RenderYes server lives
  --frontend-origin <origin> the frontend's origin, for a standalone service's CORS
  --rows <n>                 row budget hint for the headless candidate route
  --out <dir>                where a standalone service is written
  --port <n>                 port for a scaffolded standalone service
  --yes                      take every derived default, ask nothing
  --dry-run                  print the file plan, install nothing, write nothing
  --skip-install             scaffold only; install the packages yourself
  --env-file <path>          read the admin token from this dotenv file too

Every question the walk can ask has a flag above, so the whole thing runs
unattended: --yes takes the derived default for anything not passed.

GraphQL only for now. The catalog CLI and the export bundle are both
GraphQL-shaped; an OpenAPI catalog is published from the review app against a
running mount:
  npx @renderyes/catalog-review --host-url <your mount>
`.trim(),
  );
}

if (has("help") || has("h")) {
  usage();
  process.exit(0);
}

const flags = {
  serviceUrl: flag("service-url"),
  pageUrl: flag("page-url"),
  adminTokenEnv: flag("admin-token-env"),
  schemaPath: flag("schema"),
  decisionsPath: flag("decisions"),
  inventoryPath: flag("inventory"),
  uiManifest: flag("ui-manifest"),
  handoff: flag("handoff"),
  role: flag("role"),
  catalogId: flag("catalog-id"),
  prompt: flag("prompt"),
  outDir: flag("out"),
  port: flag("port"),
  rows: flag("rows"),
  semanticTypes: flag("semantic-types"),
  shapes: flag("shapes"),
  queries: flag("queries"),
  sessionStyle: flag("session"),
  ownerStyle: flag("owner"),
  topology: flag("topology"),
  frontendOrigin: flag("frontend-origin"),
  schemaEndpoint: flag("endpoint"),
  envFile: flag("env-file"),
  yes: has("yes"),
  json: has("json"),
  dryRun: has("dry-run"),
  skipInstall: has("skip-install"),
};

async function runDoctor() {
  const inspected = inspectProject(process.cwd());
  if (!inspected.manifest) {
    console.error(
      `No package.json in ${inspected.root}. Run this from the directory holding the app ` +
        "you are integrating.",
    );
    return 2;
  }
  // `--role` overrides detection here exactly as it does in the walk. The
  // first version parsed the flag and never applied it — `flags` is module
  // scope, so --service-url worked and --role silently did not, and a
  // backend-only folder was reported as missing the frontend packages.
  const project = flags.role ? { ...inspected, role: flags.role } : inspected;

  console.error(
    `RenderYes · ${project.root}\n` +
      `  package manager: ${project.packageManager ?? "unknown"}\n` +
      `  framework:       ${project.framework?.id ?? "none detected"}\n` +
      `  role:            ${project.role ?? "unknown"}${flags.role ? " (from --role)" : ""}`,
  );

  const checks = [...runLocalChecks(project)];
  if (flags.serviceUrl) {
    const adminToken = flags.adminTokenEnv
      ? readEnvVar(flags.adminTokenEnv, flags.envFile)
      : undefined;
    if (flags.adminTokenEnv && !adminToken) {
      console.error(
        `\n${flags.adminTokenEnv} is not set, and no .env file here defines it. ` +
          "Pass --env-file <path> if it lives somewhere else.",
      );
      return 2;
    }
    checks.push(
      ...(await runLiveChecks(flags.serviceUrl, {
        ...(adminToken ? { adminToken } : {}),
        ...(flags.catalogId ? { catalogId: flags.catalogId } : {}),
        // Not derived from --service-url: doctor is run against installs it did
        // not scaffold, where the page may be anywhere or may not exist. Named
        // or not checked.
        ...(flags.pageUrl ? { pageUrl: flags.pageUrl } : {}),
        // Attempted by default rather than skipped. `verified` is the only
        // level that proves the pipeline end to end, and gating it behind a
        // flag meant the common invocation reported "nothing blocking" without
        // ever trying the one check that could block. A host with no provider
        // gets a warning naming what is missing, which is the honest answer.
        prompt: flags.prompt ?? DEFAULT_DOCTOR_PROMPT,
      })),
    );
  } else {
    console.error(
      "\nNo --service-url, so only the checks that read this repository ran. Catalog " +
        "state, the probe, and a real compose need the app running.",
    );
  }

  const code = exitCode(checks);
  if (flags.json) {
    // The same facts the report renders, as data. A caller that has to parse
    // "✗" out of prose is a caller that breaks when the prose improves; the
    // check objects already carry every field this prints.
    console.log(
      JSON.stringify(
        {
          root: project.root,
          role: project.role ?? null,
          framework: project.framework?.id ?? null,
          packageManager: project.packageManager ?? null,
          reached: reachedLevel(checks) ?? null,
          ok: code === 0,
          // Explicit, because `ok` alone cannot carry it: a run that never
          // attempted `verified` is not a verified install, and a consumer
          // branching on `ok` read the two as the same thing.
          attempted: Object.fromEntries(
            ["access", "installed", "mounted", "published", "verified"].map((level) => [
              level,
              checks.some((check) => check.level === level && check.status !== "unknown"),
            ]),
          ),
          checks: checks.map((check) => ({
            id: check.id,
            level: check.level ?? null,
            status: check.status,
            summary: check.summary,
            ...(check.advisory ? { advisory: true } : {}),
            ...(check.remedy ? { remedy: check.remedy } : {}),
            ...(check.detail?.length ? { detail: check.detail } : {}),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(render(checks));
  }
  return code;
}

let code = 0;
if (command === "doctor") {
  code = await runDoctor();
} else if (command === "walk" && !flags.yes && !process.stdin.isTTY) {
  // No terminal, no --yes: readline prompts over a piped or closed stdin never
  // resolve, and the process used to die on an unsettled top-level await.
  // Failing fast with the flag list is the version of this a script can act on.
  console.error(
    "stdin is not a terminal, so the walk cannot ask its questions.\n" +
      "Pass --yes to take every derived default, or supply answers as flags:\n" +
      "  --catalog-id, --endpoint, --admin-token-env, --session, --owner,\n" +
      "  --topology, --frontend-origin, --prompt.\n" +
      "Run `npx @renderyes/init --help` for what each one answers.",
  );
  code = 2;
} else if (command === "walk") {
  const outcome = await walk(flags);
  if (outcome.checks) console.log(render(outcome.checks));
  console.error(outcome.message);
  code = outcome.ok ? 0 : 1;
} else {
  console.error(`Unknown command "${command}".`);
  usage();
  code = 2;
}

process.exit(code);
