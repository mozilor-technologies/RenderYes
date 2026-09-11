#!/usr/bin/env node
/**
 * The whole life of a capability catalog, from a terminal.
 *
 * Two artifacts, and the names say which is which. The **inventory** is the
 * machine's reading of a schema: what could be offered, hash-locked, not yours
 * to edit. The **decisions** file is yours: what a visitor may actually read,
 * which arguments they may steer, how many rows, how long a result lives.
 * Everything else here transforms one into the other, or one of them into a
 * catalog.
 *
 *   inventory   schema                -> what the schema could offer
 *   candidate   inventory             -> a starting-point decisions file
 *   curated     schema                -> a catalog with no review at all (gated)
 *   compile     schema + both         -> a publishable catalog, or a bundle
 *   publish     that file             -> registered on a running mount
 *   diff        inventory + decisions -> what a schema change makes you decide
 *   migrate     decisions             -> the same file, current format
 *
 * Each exists because the browser was previously the only way to do it. A host
 * integrating from a registry had a schema file and no route to a catalog at
 * all; CI had none either, so nothing about onboarding could be scripted or
 * reproduced. The review app is a door onto this, not a separate system: what
 * it can do from a browser is reachable from here.
 *
 * The whole route, from a schema file to a running catalog:
 *
 *   renderyes-catalog inventory --schema schema.graphql --catalog-id shop \
 *                                 --out shop.inventory.json
 *   renderyes-catalog candidate --inventory shop.inventory.json \
 *                                 --approve-all-discovered --out shop.decisions.json
 *   # edit shop.decisions.json — this is the file that is yours
 *   renderyes-catalog compile   --schema schema.graphql \
 *                                 --inventory shop.inventory.json \
 *                                 --decisions shop.decisions.json \
 *                                 --endpoint https://api.example/graphql \
 *                                 --out shop.catalog.json
 *   renderyes-catalog publish   --service-url http://127.0.0.1:3000/api/renderyes \
 *                                 --file shop.catalog.json
 *
 * `migrateGraphQlDecisions` and `diffGraphQlDecisions` are exported from
 * `@renderyes/capability-catalog/graphql` — reachable from a script inside
 * this repository and not from a host who installed the package, who would have
 * to write the script we already wrote.
 *
 * Writes to stdout unless `--out`/`--write` is given, because a tool that
 * rewrites a host's decisions file by default is one mistyped path away from
 * destroying the artifact it exists to preserve.
 *
 * Exit codes are for CI: `diff` exits 1 when a human has to decide something —
 * an approved field the schema dropped, or one needing a semantic type — so a
 * pipeline can gate a republish on it. Fields merely left unapproved are
 * reported and do not fail, because approving less is a judgement, not a
 * breakage.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  compileApprovedGraphQlCatalog,
  compileCuratedGraphQlCatalog,
  createGraphQlCatalogInventory,
  customScalarNames,
  diffGraphQlDecisions,
  DISCOVERABLE_RESULT_SHAPES,
  GRAPHQL_APPROVAL_LIMITS,
  listGraphQlQueries,
  migrateGraphQlDecisions,
  rebindGraphQlDecisions,
} from "../dist/graphql.js";
import { buildGraphQlReviewExport } from "../dist/review-export.js";
import {
  describeContractCost,
  judgeContractCost,
} from "../dist/contract-cost.js";
import { ResultShapeSchema } from "../dist/schema.js";

const CATALOG_PACKAGE = "@renderyes/capability-catalog";

const args = process.argv.slice(2);
const command = args[0];

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function readJson(path, label) {
  if (!path) fail(`Missing --${label}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    fail(`Could not read ${label} at ${path}: ${cause instanceof Error ? cause.message : cause}`);
  }
}

/** SDL text or an introspection JSON document — both are legal schema inputs. */
function readSchema(path) {
  if (!path) fail("Missing --schema");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    fail(`Could not read schema at ${path}: ${cause instanceof Error ? cause.message : cause}`);
  }
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return text;
  try {
    return JSON.parse(text);
  } catch (cause) {
    fail(`Schema at ${path} looks like JSON but did not parse: ${cause instanceof Error ? cause.message : cause}`);
  }
}

function emit(value, outPath) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, json);
    console.error(`\nWritten to ${outPath}.`);
  } else {
    console.log(json.trimEnd());
  }
}

/**
 * What each command makes, and whose file it is.
 *
 * The second column is the one that was missing. A host looking at a directory
 * with `shop.inventory.json`, `shop.decisions.json` and `shop.catalog.json` in
 * it has no way to tell which they may edit, which is regenerated, and which is
 * refused if touched — and getting that wrong is silent: an edited inventory
 * fails a hash check much later, wearing a message about review drift.
 */
const COMMANDS = {
  inventory: {
    summary: "Read a schema and list everything it could offer.",
    produces: "an inventory file",
    owner:
      "The machine's. Its hash covers the selections, so an edited inventory is\n" +
      "  refused at compile.\n" +
      "\n" +
      "  --shapes is a convenience: it writes resultShape into the inventory, and a\n" +
      '  "resultShape" in the decisions file overrides it. Prefer the decisions\n' +
      "  file, which is where the other corrections live and what survives a\n" +
      "  schema change. Setting both is reported at compile rather than resolved\n" +
      "  in silence.\n" +
      "\n" +
      "  --scalars is not a convenience: scalar mappings live only here, so\n" +
      "  correcting one means taking the inventory again and re-deriving the\n" +
      "  decisions file against the new hash.\n" +
      "\n" +
      '  --purposes {"<root field>": "what a visitor gets from it"} supplies the\n' +
      "  prose the planner selects by, for a schema whose fields carry no\n" +
      "  description. Without it a generated schema has no headless route to a\n" +
      "  publishable catalog: the compile refuses the placeholder, and the\n" +
      "  alternatives are editing a schema your upstream generates or an\n" +
      "  inventory whose hash covers the purpose.",
    synopsis: [
      "inventory --schema <file> --catalog-id <id> [--out <file>]",
      "          [--source-label <label>] [--depth <n>] [--queries a,b]",
      "          [--scalars <file>] [--shapes <file>] [--list-envelopes <file>]",
      "          [--purposes <file>]",
    ],
  },
  candidate: {
    summary: "Turn an inventory into a starting-point decisions file.",
    produces: "a decisions file",
    owner:
      "Yours, from the moment it is written. It approves visitor access to every\n" +
      "  field discovery found, which is a starting point and not a review — cut it\n" +
      "  down. That is why --approve-all-discovered has to be spelled out.\n" +
      "\n" +
      "  --semantic-types seeds this file rather than replacing anything in it:\n" +
      "  a field discovery could not place is refused at compile, and this is how\n" +
      "  the decision gets written down the first time. Afterwards it is just\n" +
      '  "semanticTypeOverrides" here, and yours to edit.',
    synopsis: [
      "candidate --inventory <file> --approve-all-discovered [--out <file>]",
      "          [--schema <file>] [--rows <n>] [--semantic-types <file>]",
    ],
  },
  curated: {
    summary: "Compile a catalog straight from a schema, with no review step.",
    produces: "a publishable catalog, or a bundle with --ui-manifest",
    owner:
      "Nobody's — no human decided anything. --confirm-visitor-safe is you saying\n" +
      "  every field it can place a meaning on is safe for a visitor to read.\n" +
      "  --yes does not satisfy that flag: it answers prompts, not this question.",
    synopsis: [
      "curated --schema <file> --catalog-id <id> --endpoint <url>",
      "        --confirm-visitor-safe [--out <file>] [--auth public|session]",
      "        [--rows <n>] [--timeout <ms>] [--page-size <n>] [--depth <n>]",
      "        [--max-fields <n>] [--scalars <file>] [--semantic-types <file>]",
      "        [--ui-manifest <file>]",
    ],
  },
  compile: {
    summary: "Turn an inventory and your decisions into something publishable.",
    produces:
      "a capability catalog — or, with --ui-manifest, a review-export bundle\n" +
      "  carrying the UI catalog too, under the same id by construction",
    owner:
      "Derived. Rebuild it rather than editing it; every input is a file you\n" +
      "  already have.",
    synopsis: [
      "compile --schema <file> --inventory <file> --decisions <file>",
      "        --endpoint <url> [--out <file>] [--credential-id <id>]",
      "        [--ui-manifest <file>]",
    ],
  },
  publish: {
    summary: "Register a compiled catalog on a running mount.",
    produces: "nothing on disk — it changes a running server",
    owner:
      "The server's, once this returns. The admin token is read from the\n" +
      "  environment and never taken as a flag: an argument is in your shell\n" +
      "  history and in the process list for everyone on the machine.",
    synopsis: ["publish --service-url <url> --file <file> [--admin-token-env <NAME>]"],
  },
  diff: {
    summary: "Say what a schema change makes you decide.",
    produces: "a report, and an exit code",
    owner:
      "Nothing — it only reads. Exits 1 when a human has to decide something, so\n" +
      "  a pipeline can gate a republish on it. Fields merely left unapproved are\n" +
      "  reported and do not fail: approving less is a judgement, not a breakage.\n" +
      "\n" +
      "  It checks the binding first — whether these decisions were made against\n" +
      "  this inventory at all — and exits 1 when they were not, even if every\n" +
      "  field still lines up. The pair does not compile in that state, so a\n" +
      "  green report would be a false one. When nothing you decided is affected\n" +
      "  it says so, and `migrate --inventory` re-binds without a re-review.",
    synopsis: ["diff --inventory <file> --decisions <file>"],
  },
  migrate: {
    summary: "Bring a decisions file up to the current format, or re-bind it.",
    produces: "the same decisions, rewritten",
    owner:
      "Yours — and --write edits it in place. Without --write it goes to stdout,\n" +
      "  because a tool that rewrites your file by default is one mistyped path\n" +
      "  away from destroying the artifact it exists to preserve.\n" +
      "\n" +
      "  --inventory re-binds: it re-stamps reviewSourceHash when the inventory\n" +
      "  moved but nothing you decided did — a scalar mapping, a narrower\n" +
      "  --queries, a different --depth. It refuses whenever an approved\n" +
      "  capability or field is no longer offered, because re-stamping there\n" +
      "  would record a review that never happened. `diff` says which case you\n" +
      "  are in before you run it.",
    synopsis: ["migrate --decisions <file> [--inventory <file>] [--write]"],
  },
};

/**
 * When a schema moves, this is the loop.
 *
 * Written once, here, because it was previously only inferable by reading the
 * exit codes: a host whose upstream changed had a compile failure naming a hash
 * and no stated route from there back to a working catalog.
 */
const SCHEMA_CHANGE_WORKFLOW =
  "When the schema changes:\n" +
  "  1. inventory  again, over the new schema\n" +
  "  2. diff       the new inventory against your existing decisions\n" +
  "  3. edit       what it names — gone fields, missing semantic types, new\n" +
  "                capabilities you may or may not want\n" +
  "  4. compile and publish\n" +
  "Your decisions file survives all of it. That is the point of keeping it in\n" +
  "your repository: the review happens once, not once per schema change.";

function overview() {
  const lines = [
    "renderyes-catalog — a schema to a published capability catalog.",
    "",
    "Two artifacts. The INVENTORY is the machine's reading of your schema: what",
    "could be offered, hash-locked, not yours to edit. The DECISIONS file is",
    "yours: what a visitor may actually read, which arguments they may steer, how",
    "many rows, how long a result lives.",
    "",
    "Commands:",
  ];
  for (const [name, spec] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(11)}${spec.summary}`);
  }
  lines.push(
    "",
    "  renderyes-catalog <command> --help    what it produces, and whose file it is",
    "",
    "The whole route:",
    "  renderyes-catalog inventory --schema schema.graphql --catalog-id shop \\",
    "                                --out shop.inventory.json",
    "  renderyes-catalog candidate --inventory shop.inventory.json \\",
    "                                --approve-all-discovered --out shop.decisions.json",
    "  # edit shop.decisions.json — this is the file that is yours",
    "  renderyes-catalog compile   --schema schema.graphql \\",
    "                                --inventory shop.inventory.json \\",
    "                                --decisions shop.decisions.json \\",
    "                                --endpoint https://api.example/graphql \\",
    "                                --out shop.catalog.json",
    "  renderyes-catalog publish   --service-url http://127.0.0.1:3000/api/renderyes \\",
    "                                --file shop.catalog.json",
    "",
    SCHEMA_CHANGE_WORKFLOW,
    "",
    "JSON goes to stdout unless --out is given; every report goes to stderr, so",
    "the output pipes cleanly.",
  );
  return lines.join("\n");
}

function commandHelp(name) {
  const spec = COMMANDS[name];
  return [
    `renderyes-catalog ${name} — ${spec.summary}`,
    "",
    ...spec.synopsis.map((line) => `  ${line}`),
    "",
    "Produces:",
    `  ${spec.produces}`,
    "Whose is it?",
    `  ${spec.owner}`,
    ...(name === "diff" ? ["", SCHEMA_CHANGE_WORKFLOW] : []),
  ].join("\n");
}

// Help is a successful outcome, so it goes to stdout and exits 0. It used to be
// neither: `--help` fell through to "Unknown command" on stderr with exit 2,
// and `inventory --help` answered "Missing --schema" — the first thing a host
// types, refused.
if (args.length === 0 || wantsHelp(args[0])) {
  console.log(overview());
  process.exit(0);
}
if (COMMANDS[command] && args.slice(1).some(wantsHelp)) {
  console.log(commandHelp(command));
  process.exit(0);
}

function wantsHelp(value) {
  return value === "--help" || value === "-h" || value === "help";
}

/**
 * A validation failure as sentences, not as the validator's own JSON.
 *
 * `GraphQlCatalogDecisionsSchema.parse` throws a `ZodError` whose `.message`
 * is a pretty-printed dump of its `issues` array. Printed straight through it
 * read as the operator's mistake rather than as a misplaced key, in a CLI whose
 * every other error is written prose. The commonest one has a specific fix
 * worth naming: a control put on a query entry that belongs at the top level.
 */
const TOP_LEVEL_DECISION_KEYS = new Set([
  "schemaVersion",
  "reviewSourceHash",
  "semanticTypeOverrides",
  "scalarMappings",
  "queries",
]);

function describeValidationIssues(error) {
  const issues = Array.isArray(error?.issues) ? error.issues : undefined;
  if (!issues || issues.length === 0) return undefined;
  const lines = issues.slice(0, 12).map((issue) => {
    const where = Array.isArray(issue.path) && issue.path.length > 0
      ? issue.path.reduce(
          (acc, part) =>
            typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${part}` : String(part),
          "",
        )
      : "the top level of the file";
    const keys = Array.isArray(issue.keys) ? issue.keys : [];
    const misplaced = keys.filter((key) => TOP_LEVEL_DECISION_KEYS.has(key));
    if (misplaced.length > 0) {
      return `  - "${misplaced.join('", "')}" at ${where} belongs at the top level of the ` +
        `decisions file, beside "queries" — not on a query entry.`;
    }
    if (keys.length > 0) {
      return `  - ${where} has no place for "${keys.join('", "')}". Check the spelling ` +
        `against schemas/graphql-decisions.schema.json.`;
    }
    return `  - ${where}: ${issue.message}`;
  });
  if (issues.length > lines.length) {
    lines.push(`  - …and ${issues.length - lines.length} more.`);
  }
  return lines.join("\n");
}

const depthOf = (path) => path.split(".").length;

/**
 * Semantic types worth naming when a field is dropped.
 *
 * Not "important" — that is the host's call and depends entirely on the domain.
 * These are the ones whose absence changes what a view can be *about* rather
 * than how much detail it carries, so an operator scanning the report can tell
 * at a glance whether the cut took something structural.
 */
const NOTABLE_SEMANTIC_TYPES = new Set([
  "money",
  "identifier",
  "date",
  "date-time",
  "status",
  "location",
  "quantity",
]);

/**
 * Fields that fit the budget, keeping the leaves of one nested object together.
 *
 * Shallowest-first is a reasonable prior — plans select shallow fields
 * overwhelmingly, and a deep path costs contract budget. On its own it has a
 * systematic bias nobody chose: a *composite* value is nested by definition. A
 * price is an amount and a currency, a measure is a number and a unit, a point
 * is a latitude and a longitude. Sorting by depth therefore discriminates
 * against exactly the values that cannot be expressed as one scalar, whatever
 * the domain — and splitting one is worse than dropping it, because a number
 * rendered without its unit is not partial information, it is wrong.
 *
 * So the unit of selection is the parent object, not the leaf. Root-level
 * scalars are independent of each other and stay individually selectable;
 * anything nested is admitted whole or not at all.
 */
function selectWithinBudget(fields, budget) {
  const parentOf = (path) => path.slice(0, path.lastIndexOf("."));
  const groups = new Map();
  for (const [index, field] of fields.entries()) {
    const key = depthOf(field.path) === 1 ? `\u0000root:${index}` : parentOf(field.path);
    const group = groups.get(key);
    if (group) group.members.push(field);
    else groups.set(key, { index, depth: depthOf(field.path), members: [field] });
  }
  const ordered = [...groups.values()].sort(
    (a, b) => a.depth - b.depth || a.index - b.index,
  );
  const kept = [];
  for (const group of ordered) {
    if (kept.length + group.members.length > budget) continue;
    kept.push(...group.members);
  }
  return kept;
}

function fail(message) {
  console.error(message);
  console.error(`\nRun \`renderyes-catalog ${COMMANDS[command] ? `${command} ` : ""}--help\`.`);
  process.exit(2);
}

if (command === "inventory") {
  const schema = readSchema(flag("schema"));
  const catalogId = flag("catalog-id");
  if (!catalogId) fail("Missing --catalog-id");
  const depth = flag("depth") === undefined ? undefined : Number(flag("depth"));
  if (depth !== undefined && !Number.isInteger(depth)) fail("--depth must be an integer");
  const scalarMappings = flag("scalars") ? readJson(flag("scalars"), "scalars") : {};
  // Result-shape overrides, keyed by root field name or capability id.
  //
  // A flag rather than "edit the inventory": `reviewSourceHash` covers
  // `querySelections`, so hand-editing a shape in the emitted file is refused
  // as review drift. Without this the CLI passed discovery's guess straight
  // through with no way to correct it, which left five of the nine shapes —
  // hierarchy, media-collection, document, comparison, search-results —
  // unreachable through the headless route, even though the compile accepts
  // every one of them.
  const shapeOverrides = flag("shapes") ? readJson(flag("shapes"), "shapes") : {};
  // The prose the planner selects capabilities by. Taken from the schema's own
  // field description when it has one, and otherwise a placeholder that the
  // compile refuses — correctly, since publishing it would describe the
  // capability to the model as an unfinished review. But the only two ways out
  // named were editing the schema an upstream generates, or editing an
  // inventory whose hash covers the purpose. A generated schema with no
  // descriptions had no headless route to a publishable catalog at all.
  const purposeOverrides = flag("purposes") ? readJson(flag("purposes"), "purposes") : {};
  for (const [key, purpose] of Object.entries(purposeOverrides)) {
    if (typeof purpose !== "string" || purpose.trim().length === 0) {
      fail(`--purposes gave a non-string purpose for "${key}".`);
    }
    if (purpose.startsWith("Review the purpose of")) {
      fail(
        `--purposes gave the placeholder itself for "${key}". The planner chooses\n` +
          `  capabilities by this prose; write what a visitor gets from it.`,
      );
    }
  }
  // Where the rows live, for an API that wraps them — Payload's `{docs,
  // totalDocs}` and most REST-shaped facades. Never detected, because an entity
  // that is scalars plus one nested list has the same structural signature and
  // only the host knows which it is; the compile refuses a collection over a
  // wrapper and names the candidate rows field, and this is how that answer gets
  // back in. Without it the headless route could not express one at all.
  const listEnvelopes = flag("list-envelopes")
    ? readJson(flag("list-envelopes"), "list-envelopes")
    : {};
  const allShapes = ResultShapeSchema.options;
  for (const [key, shape] of Object.entries(shapeOverrides)) {
    if (!allShapes.includes(shape)) {
      fail(
        `--shapes gave "${shape}" for "${key}", which is not a result shape.\n` +
          `  One of: ${allShapes.join(", ")}`,
      );
    }
  }

  const discovered = listGraphQlQueries(schema, {
    ...(depth === undefined ? {} : { maximumDiscoveryDepth: depth }),
    scalarMappings,
  });
  const wanted = flag("queries")?.split(",").map((name) => name.trim()).filter(Boolean);
  const supported = discovered.filter((query) => query.support.status === "supported");
  const selected = wanted
    ? supported.filter((query) => wanted.includes(query.fieldName))
    : supported;

  if (wanted) {
    // A named query that is not here was either not found or not supportable,
    // and those are different problems. Silence would let a typo look like a
    // schema limitation.
    for (const name of wanted) {
      if (selected.some((query) => query.fieldName === name)) continue;
      const found = discovered.find((query) => query.fieldName === name);
      console.error(
        found
          ? `Skipped "${name}": ${found.support.reason ?? "unsupported"}`
          : `Skipped "${name}": no such root query field`,
      );
    }
  }
  if (selected.length === 0) fail("No supported root query fields to inventory");

  // The schema makes the answer exact: scalars inside input-object arguments
  // are found (the ones that otherwise surface one compile failure at a time),
  // and input-object/enum type names — which need no mapping — are not listed.
  const missingScalars = customScalarNames(selected, schema).filter(
    (name) => scalarMappings[name] === undefined,
  );
  if (missingScalars.length > 0) {
    // Compilation refuses a custom scalar it has no mapping for, and finding
    // that out one failure at a time is how this was discovered before
    // `customScalarNames` existed. Reported now, at the step that can still act
    // on it.
    console.error(
      `\n${missingScalars.length} custom scalar(s) need a mapping before this compiles:`,
    );
    for (const name of missingScalars) console.error(`  ${name}`);
    console.error(`  Pass --scalars with {"${missingScalars[0]}": {"schema": {}}} or narrower.`);
  }

  const inventory = createGraphQlCatalogInventory({
    schema,
    catalog: {
      id: catalogId,
      version: "1.0.0",
      description: `Approved reads from ${flag("source-label") ?? catalogId}.`,
    },
    source: {
      id: `${catalogId}-source`,
      label: flag("source-label") ?? catalogId,
      description: `The ${flag("source-label") ?? catalogId} GraphQL API.`,
    },
    ...(depth === undefined ? {} : { discoveryMaxDepth: depth }),
    queries: selected.map((query) => {
      // `matchKey` has to name a field that exists; `id` is the Relay
      // convention and the overwhelming majority case, but guessing it when it
      // is absent produces an inventory that fails to compile for a reason the
      // operator did not choose.
      const hasId = query.outputFields.some((field) => field.path === "id");
      return {
        fieldName: query.fieldName,
        capabilityId: `graphql.${query.fieldName}`,
        purpose:
          purposeOverrides[query.fieldName] ??
          purposeOverrides[`graphql.${query.fieldName}`] ??
          query.description ??
          `Review the purpose of graphql.${query.fieldName} before publishing.`,
        dataTypeId: query.connection?.nodeTypeName ?? query.fieldName,
        dataTypeDescription: `One record from ${query.fieldName}.`,
        resultShape:
          shapeOverrides[query.fieldName] ??
          shapeOverrides[`graphql.${query.fieldName}`] ??
          query.suggestedResultShape,
        ...(() => {
          const envelope =
            listEnvelopes[query.fieldName] ?? listEnvelopes[`graphql.${query.fieldName}`];
          return envelope ? { listEnvelope: envelope } : {};
        })(),
        ...(hasId ? { matchKey: "id" } : {}),
        ...(Object.keys(scalarMappings).length > 0 ? { scalarMappings } : {}),
      };
    }),
  });

  console.error(
    `\nInventoried ${inventory.queries.length} quer${inventory.queries.length === 1 ? "y" : "ies"} ` +
      `from ${discovered.length} root field(s).`,
  );
  for (const query of inventory.queries) {
    const excluded = query.exclusions.length;
    console.error(
      `  ${query.capabilityId}: ${query.availableOutputFields.length} field(s) available` +
        (excluded > 0 ? `, ${excluded} excluded — see "exclusions"` : ""),
    );
  }
  // The token cost of what is on offer is a decision input, not a
  // post-publish discovery; the exact figure needs compiled decisions, which
  // `candidate --schema` produces.
  console.error(
    "Contract size scales with capabilities and approved fields and is resent up\n" +
      "to 3 times per compose. Run `candidate --schema <file>` to see the projected\n" +
      "planner-contract size before publishing.",
  );

  // Every generated purpose is a placeholder until someone writes one, and the
  // planner reads them: a catalog of "Review the purpose of…" is a catalog the
  // planner cannot choose between.
  const placeholders = inventory.queries.filter((query) =>
    query.purpose.startsWith("Review the purpose of"),
  );
  if (placeholders.length > 0) {
    console.error(
      `\n${placeholders.length} quer${placeholders.length === 1 ? "y has" : "ies have"} no purpose from the schema. ` +
        "The planner chooses capabilities by their purpose; write these before publishing.",
    );
  }

  // Said once, plainly: the shape is a proposal from a schema that cannot
  // express most of the vocabulary. Nothing used to tell a host that four of
  // nine shapes are all discovery can ever suggest, so an unsuggested shape
  // read as an unsupported one and hosts left `collection` in place on data
  // that was a hierarchy or a media collection.
  const undiscoverable = ResultShapeSchema.options.filter(
    (shape) => !DISCOVERABLE_RESULT_SHAPES.includes(shape),
  );
  const overridden = Object.keys(shapeOverrides).length;
  console.error(
    "\n`resultShape` is a suggestion. Discovery can only propose " +
      `${DISCOVERABLE_RESULT_SHAPES.join(", ")} — a schema does not say which ` +
      `collections are really ${undiscoverable.join(", ")}, and guessing from field ` +
      "names would be wrong on the next schema." +
      (overridden > 0
        ? ` ${overridden} override(s) applied from --shapes.`
        : '\n  Correct one with --shapes {"<root field>": "hierarchy"} here, or set ' +
          '"resultShape" on the capability\'s entry in the decisions file, which ' +
          "is the one review expects you to edit. Editing the shape in the emitted " +
          "inventory is still refused: its hash covers those selections."),
  );

  emit(inventory, flag("out"));
  process.exit(0);
}

if (command === "candidate") {
  const inventory = readJson(flag("inventory"), "inventory");
  if (!args.includes("--approve-all-discovered")) {
    fail(
      "candidate refuses to approve anything implicitly.\n" +
        "\n" +
        "  --approve-all-discovered approves every field discovery found, for every\n" +
        "  query in the inventory. That is a starting point for a review, not a review:\n" +
        "  it approves visitor access to each of those fields. Pass the flag if that\n" +
        "  is what you mean, then cut it down.",
    );
  }
  const maximumRows = flag("rows") === undefined ? 100 : Number(flag("rows"));
  if (!Number.isInteger(maximumRows) || maximumRows <= 0) {
    fail("--rows must be a positive integer");
  }
  // The escape hatch for fields discovery could not place. Compiling refuses
  // an approved field with no semantic type and names each one — but this CLI
  // had no way to supply the answer, so "approve everything discovered" could
  // refuse its own output with no route forward short of editing the emitted
  // JSON by hand. The file is a record keyed exactly as the error reports:
  //   { "Query.orders.discountRate": "quantity", ... }
  // Semantic meaning is a host decision, so there is no auto-assignment here;
  // this only carries the decision the host already made.
  const semanticTypeOverrides = flag("semantic-types")
    ? readJson(flag("semantic-types"), "semantic-types")
    : undefined;

  /**
   * "Approve everything discovered" meets two hard ceilings the decisions
   * format enforces per capability. Discovery is unbounded by them — on one
   * commerce schema, 26 of 86 queries exceed 500 fields (one of them 1904) —
   * and writing the raw count into `limits` produced a candidate the schema
   * itself rejected,
   * on the documented headless route, as a validation dump that read as the
   * operator's mistake.
   *
   * Kept shallowest-first, because a deep path costs contract budget and
   * plans select shallow fields overwhelmingly; inventory order is preserved
   * within a depth so the file still diffs cleanly against its inventory. What
   * was cut is reported per query, loudly — a silent cap would read as
   * "approved everything" when it did not.
   */

  const truncated = [];
  const decisions = {
    // Relative, and resolved by an editor against this file's own directory —
    // which is where the wizard and the documented commands put it. A host who
    // moves it deeper adjusts the path or drops the line; nothing here reads it.
    $schema: `./node_modules/${CATALOG_PACKAGE}/schemas/graphql-decisions.schema.json`,
    schemaVersion: "1.0",
    reviewSourceHash: inventory.reviewSourceHash,
    ...(semanticTypeOverrides ? { semanticTypeOverrides } : {}),
    queries: inventory.queries.map((query) => {
      const discovered = query.availableOutputFields.map((field) => field.path);
      const eligible = query.availableOutputFields.filter(
        (field) => depthOf(field.path) <= GRAPHQL_APPROVAL_LIMITS.maximumSelectionDepth,
      );
      let paths = eligible.map((field) => field.path);
      let cut = [];
      if (eligible.length > GRAPHQL_APPROVAL_LIMITS.maximumSelectedFields) {
        const kept = selectWithinBudget(eligible, GRAPHQL_APPROVAL_LIMITS.maximumSelectedFields);
        const keptPaths = new Set(kept.map((field) => field.path));
        paths = eligible.filter((field) => keptPaths.has(field.path)).map((field) => field.path);
        cut = eligible.filter((field) => !keptPaths.has(field.path));
      }
      if (paths.length < discovered.length) {
        const overDepth = query.availableOutputFields.filter(
          (field) => depthOf(field.path) > GRAPHQL_APPROVAL_LIMITS.maximumSelectionDepth,
        );
        truncated.push({
          capabilityId: query.capabilityId,
          discovered: discovered.length,
          kept: paths.length,
          // Named, not just counted. "1,404 dropped" tells an operator nothing
          // about whether the one field their view is about survived.
          notable: [...cut, ...overDepth]
            .filter((field) => NOTABLE_SEMANTIC_TYPES.has(field.semanticType))
            .slice(0, 6),
          cutCount: cut.length + overDepth.length,
        });
      }
      // `first` and `after` are the exception to "approve no arguments". They
      // are not visitor steering — they are how a Relay connection is read at
      // all, and the size sent is clamped to the page cap regardless of what a
      // plan asks for. Without them a candidate over a connection compiles and
      // then fails against any API that requires a page size, which Saleor
      // does: the operator's first headless run would report a broken system
      // rather than a working starting point. Every filtering argument is
      // still left off, because those are decisions about what a visitor may
      // steer and there is no defensible default.
      const paging = ["first", "after"].filter((name) =>
        query.availableVisitorArguments.some((argument) => argument.name === name),
      );
      return {
        capabilityId: query.capabilityId,
        approvedVisitorArguments: paging,
        // Empty: whose data a visitor sees is the decision this tool is least
        // entitled to make.
        identityArguments: {},
        approvedOutputFields: paths,
        requiredOutputFields: paths.includes("id") ? ["id"] : [],
        policy: {
          // `session`, not `public`: the restrictive side of a guess whose
          // consequence is who can read the data. The probe measures what the
          // upstream actually enforces; this is what to assume until it has.
          authentication: "session",
          maximumRows,
          timeoutMs: 5_000,
          cacheTtlSeconds: 0,
        },
        limits: {
          // Wide enough to admit what was kept — a candidate that cannot
          // compile teaches nothing — and inside the schema's ceilings by
          // construction, because `paths` was capped above.
          maximumSelectionDepth: Math.max(
            1,
            ...paths.map((path) => depthOf(path)),
          ),
          maximumSelectedFields: Math.max(1, paths.length),
        },
      };
    }),
  };

  const total = decisions.queries.reduce(
    (sum, query) => sum + query.approvedOutputFields.length,
    0,
  );
  console.error(
    `\nCandidate decisions: ${decisions.queries.length} capabilit${decisions.queries.length === 1 ? "y" : "ies"}, ` +
      `${total} field(s) approved for visitor access.`,
  );
  if (truncated.length > 0) {
    console.error(
      `\n${truncated.length} capabilit${truncated.length === 1 ? "y" : "ies"} discovered more than the ` +
        `library allows one capability to approve (${GRAPHQL_APPROVAL_LIMITS.maximumSelectedFields} fields, ` +
        `${GRAPHQL_APPROVAL_LIMITS.maximumSelectionDepth} levels). Shallowest first, and the ` +
        `leaves of one nested object are kept or dropped together — half a price is worse ` +
        `than no price:`,
    );
    for (const entry of truncated) {
      console.error(`  ${entry.capabilityId}: ${entry.discovered} discovered, ${entry.kept} kept`);
      if (entry.notable.length > 0) {
        for (const field of entry.notable) {
          console.error(`      dropped: ${field.path} (${field.semanticType})`);
        }
        const rest = entry.cutCount - entry.notable.length;
        if (rest > 0) console.error(`      …and ${rest} more`);
      }
    }
    console.error(
      `Every dropped field is still in ${flag("inventory")}, under the same capability id\n` +
        "and path — copy one into `approvedOutputFields` to keep it, and raise that\n" +
        "capability's `limits` to match. These caps bound a single capability; a real\n" +
        "review should land far below them.",
    );
  }
  console.error(
    "This is a starting point, not a review. Cut it down, set the visitor and\n" +
      "identity arguments, then `diff` it against the inventory before publishing.",
  );
  // The flag's name promises more than it can deliver, and the shortfall is
  // silent: an entity lookup takes a required identifier owned by neither the
  // visitor (it is opaque, so no visitor wording supplies it) nor identity (it
  // is not a session fact), so approving one automatically would produce a
  // catalog that fails to compile. Nothing here is wrong; it just means a
  // detail panel never appears in an all-discovered candidate.
  console.error(
    "Note: entity lookups are not in this candidate. A capability whose\n" +
      "identifier argument is required cannot be approved automatically, so a\n" +
      "detail view needs hand-written or code-first decisions.",
  );
  // Stated here because this candidate approves only paging arguments, and the
  // consequence is easy to miss: post-fetch filters (`supports.filterFields`)
  // run on the server over one fetched page, so until the source's own
  // filter/search arguments are approved, every visitor constraint narrows a
  // page and is reported incomplete rather than narrowing the dataset.
  console.error(
    "No filtering or search arguments are approved yet. Only approved visitor\n" +
      "arguments narrow at the data source; plan-level filters run afterwards,\n" +
      "over one fetched page. Approve the source's filter/search arguments to\n" +
      "let a visitor's constraint reach the upstream.",
  );
  // Contract cost was only visible after publish — `contractBytes` on the
  // publish summary — which is after every decision it should inform. Approving
  // forty more fields is a token-budget decision, and the number belongs where
  // the approving happens. Optional because compiling needs the schema, which
  // candidate otherwise has no reason to require.
  const schemaPath = flag("schema");
  if (schemaPath !== undefined) {
    try {
      const compiled = compileApprovedGraphQlCatalog(
        readFileSync(schemaPath, "utf8"),
        inventory,
        decisions,
      );
      // The same measurement the publish summary reports, reused rather than
      // re-derived: a second estimator drifts, and this number should be known
      // where the approving happens, not after publish.
      reportContractSize(compiled, "Compiles. ");
    } catch (error) {
      fail(
        `This candidate does not compile against the schema:\n${describeValidationIssues(error) ?? `  ${error instanceof Error ? error.message : String(error)}`}` +
          (error instanceof Error && error.name === "GraphQlSemanticTypeError"
            ? "\n\nPass --semantic-types <file> with a JSON record keyed exactly as above,\n" +
              'e.g. {"Query.orders.discountRate": "quantity"}. Semantic meaning is a host\n' +
              "decision, so this tool will not guess one."
            : ""),
      );
    }
  }
  emit(decisions, flag("out"));
  process.exit(0);
}

if (command === "migrate") {
  const path = flag("decisions");
  let { decisions, changed } = migrateGraphQlDecisions(readJson(path, "decisions"));

  // `--inventory` re-binds as well as migrates: same job, one step out. The
  // only other exit from a stale binding was hand-editing `reviewSourceHash`
  // to the value the error printed — which works, and forges the hash the
  // review depends on. Refused whenever a decision is affected.
  const inventoryPath = flag("inventory");
  if (inventoryPath !== undefined) {
    const inventory = readJson(inventoryPath, "inventory");
    const rebind = rebindGraphQlDecisions(inventory, decisions);
    if (rebind.diff.binding.bound) {
      console.error("Already bound to this inventory; nothing to re-bind.");
    } else if (!rebind.rebound) {
      fail(
        "Refusing to re-bind: something these decisions decided is no longer offered.\n" +
          (rebind.diff.capabilitiesGone.length > 0
            ? `  gone entirely: ${rebind.diff.capabilitiesGone.join(", ")}\n`
            : "") +
          rebind.diff.capabilities
            .filter((entry) => entry.missingFromSchema.length > 0)
            .map((entry) => `  ${entry.capabilityId}: ${entry.missingFromSchema.join(", ")}\n`)
            .join("") +
          "\n  Re-stamping the hash here would record a review that never happened.\n" +
          "  Run `diff` and decide what to do with these first.",
      );
    } else {
      decisions = rebind.decisions;
      console.error(
        `Re-bound ${rebind.diff.binding.decisionsHash} -> ${rebind.diff.binding.inventoryHash}. ` +
          "Every approved capability and field is still offered, so nothing you\n" +
          "decided changed.",
      );
      if (rebind.diff.capabilitiesNew.length > 0) {
        console.error(
          `  New and still unapproved: ${rebind.diff.capabilitiesNew.join(", ")}`,
        );
      }
    }
  }

  if (changed.length === 0) {
    console.error("Already in the current format; nothing to migrate.");
  } else {
    // To stderr, so `--write`-less output can be piped without the report
    // contaminating the JSON.
    console.error(`${changed.length} path(s) migrated:`);
    for (const entry of changed) {
      console.error(`  ${entry.capabilityId}: ${entry.path} -> ${entry.migratedTo}`);
    }
    console.error(`  reason: ${changed[0].reason}`);
  }

  if (args.includes("--write")) {
    writeFileSync(path, `${JSON.stringify(decisions, null, 2)}\n`);
    console.error(`\nWritten to ${path}.`);
  } else {
    console.log(JSON.stringify(decisions, null, 2));
  }
  process.exit(0);
}

if (command === "diff") {
  const inventory = readJson(flag("inventory"), "inventory");
  const decisions = readJson(flag("decisions"), "decisions");
  const diff = diffGraphQlDecisions(inventory, decisions);

  // First, because a stale binding makes the rest of this report describe two
  // files that will not compile together. `diff` used to skip straight to the
  // fields, find nothing wrong, and print "nothing to decide" over a pair the
  // compile refuses — while the compile's own error told the host to run this.
  let mustDecide = 0;
  if (!diff.binding.bound) {
    console.log(
      `These decisions were made against a different inventory ` +
        `(decisions ${diff.binding.decisionsHash}, this inventory ${diff.binding.inventoryHash}).`,
    );
    if (diff.binding.affected) {
      // Counted: something decided is genuinely gone, so no tool should stamp
      // past it.
      mustDecide += 1;
      console.log("  Something you decided is affected — see below, then re-review.");
    } else {
      console.log(
        "  Nothing you decided is affected: every approved capability and field\n" +
          "  is still offered. Re-bind without repeating the review:\n" +
          "    renderyes-catalog migrate --decisions <file> --inventory <file> --write",
      );
    }
  }

  mustDecide += diff.capabilitiesGone.length;
  if (diff.capabilitiesGone.length > 0) {
    console.log(`No longer reviewed: ${diff.capabilitiesGone.join(", ")}`);
  }
  // Reported, but not counted as something that must be decided: leaving a new
  // operation unapproved is a valid answer, and the common one. It is named
  // because nothing else names it — a re-review that lists only losses leaves
  // the host to spot additions by reading the schema themselves.
  if (diff.capabilitiesNew.length > 0) {
    console.log(`New since these decisions, not approved: ${diff.capabilitiesNew.join(", ")}`);
  }
  for (const entry of diff.capabilities) {
    const lines = [];
    if (entry.missingFromSchema.length > 0) {
      lines.push(`  gone from the schema: ${entry.missingFromSchema.join(", ")}`);
    }
    for (const gap of entry.needsSemanticType) {
      lines.push(`  needs a semantic type: ${gap.path} (${gap.type}) -> "${gap.overrideKey}"`);
    }
    if (entry.unapproved.length > 0) {
      lines.push(`  ${entry.unapproved.length} available field(s) not approved:`);
      for (const field of entry.unapproved.slice(0, 10)) {
        lines.push(`    ${field.path} (${field.semanticType})`);
      }
      // Truncation is stated. A silent "and 40 more" is how a list stops being
      // read as a list at all.
      if (entry.unapproved.length > 10) {
        lines.push(`    ... and ${entry.unapproved.length - 10} more`);
      }
    }
    mustDecide += entry.missingFromSchema.length + entry.needsSemanticType.length;
    if (lines.length > 0) {
      console.log(`\n${entry.capabilityId}`);
      console.log(lines.join("\n"));
    }
  }

  if (mustDecide === 0 && diff.binding.bound) {
    console.log("These decisions match the current schema; nothing to decide.");
  }
  // Non-zero for a stale binding even when nothing is affected: the pair does
  // not compile, so a pipeline gating a republish on this must not go green.
  // Re-binding is a deliberate act, not something a CI run should infer.
  process.exit(mustDecide > 0 || !diff.binding.bound ? 1 : 0);
}

/**
 * Where a compiled catalog goes, in one of its two shapes.
 *
 * Without a UI manifest this is the `/api/catalog` body — the capability half
 * alone, which is publishable and renders nothing until a UI catalog is filed
 * under the same id. With one it is the same review-export bundle the browser
 * app downloads, which carries both halves and the upstream origins the server
 * checks before it publishes either.
 *
 * The bundle is the safer artifact and the reason is not style: the two-call
 * path files the UI catalog under whatever id the caller passes, so a
 * mistyped id publishes successfully and resolves nothing at compose. In a
 * bundle the id is threaded through both halves by construction.
 */
function publishPayload({ catalogId, compiled, schema, endpoint, credentialId, uiManifestPath }) {
  const bindings = Object.fromEntries(compiled.bindings);
  if (!uiManifestPath) {
    return {
      bindingKind: "graphql",
      catalog: compiled.catalog,
      bindings,
      schema,
      endpoint,
      ...(credentialId ? { credentialId } : {}),
    };
  }
  const loaded = readJson(uiManifestPath, "ui-manifest");
  // Both the manifest itself and the `{manifest, catalogId}` body the
  // scaffolded publish script posts are accepted. A host who captured the
  // request body rather than the manifest has the right bytes in the wrong
  // wrapper, and refusing that is a puzzle with no information in it.
  const uiManifest =
    loaded && typeof loaded === "object" && loaded.manifest && typeof loaded.manifest === "object"
      ? loaded.manifest
      : loaded;
  if (!uiManifest || !Array.isArray(uiManifest.components)) {
    fail(
      `--ui-manifest at ${uiManifestPath} has no "components" array, so it is not a site manifest.\n` +
        "  Produce one from your own components:\n" +
        "    npx tsx scripts/publish-ui-catalog.mjs --emit <file>",
    );
  }
  return buildGraphQlReviewExport({
    catalogId,
    compiled,
    schema,
    endpoint,
    ...(credentialId ? { credentialId } : {}),
    uiManifest,
  });
}

/**
 * Contract cost, reported where the decisions that determine it are made.
 *
 * Attributed rather than totalled, and the ordering is the whole point. This
 * used to close with "fewer approved fields is the lever", which is the
 * smallest of the three levers measured: cutting a capability's projection from
 * twelve fields to four returns 17% of the contract, halving the capability
 * count returns 50%, and not advertising a filter vocabulary returns 73%. A
 * host who followed the old sentence did the most tedious available work for
 * the least return.
 */
function reportContractSize(compiled, prefix = "") {
  const cost = describeContractCost(compiled.plannerManifest);
  const verdict = judgeContractCost(cost);
  console.error(
    `${prefix}Data-planning contract: ${cost.bytes} bytes (~${cost.approximateTokens} tokens), resent on\n` +
      `every plan attempt — a compose retries up to 3 times, so budget ` +
      `~${cost.approximateTokens * 3}\ntokens per compose worst case, before component schemas.`,
  );
  if (verdict.advice) {
    console.error(`\nOver the ~${verdict.budgetTokens}-token budget. ${verdict.advice}`);
    return;
  }
  // Facets and arguments ranked together. Naming the largest facet regardless
  // of what the arguments cost is how a host was pointed at a 1% lever while
  // one approved filter argument carried the rest of the contract.
  const facet = cost.facets[0];
  const argument = cost.arguments[0];
  const share = (bytes) => Math.round((bytes / cost.bytes) * 100);
  if (argument && argument.bytes > (facet?.bytes ?? 0)) {
    console.error(
      `Largest single lever if that needs to come down: the "${argument.argument}" argument's\n` +
        `own schema is ${argument.bytes} bytes (${share(argument.bytes)}% of the contract).\n` +
        `Narrow it with \`approvedInputFields\`, or withhold it from \`approvedVisitorArguments\`.`,
    );
  } else if (facet) {
    console.error(
      `Largest single lever if that needs to come down: dropping "${facet.facet}" from\n` +
        `capabilities that do not need it returns ${facet.bytes} bytes ` +
        `(${share(facet.bytes)}% of the contract).`,
    );
  }
}

/** Endpoint validation shared by everything that emits a publishable artifact. */
function requireEndpoint() {
  const endpoint = flag("endpoint");
  if (!endpoint) {
    fail(
      "Missing --endpoint. The compiled catalog names the GraphQL endpoint every\n" +
        "  approved capability is executed against, and the server refuses to publish\n" +
        "  one whose origin is not in allowedUpstreamOrigins.",
    );
  }
  try {
    new URL(endpoint);
  } catch {
    fail(`--endpoint "${endpoint}" is not an absolute URL (http://… or https://…).`);
  }
  return endpoint;
}

if (command === "compile") {
  const schema = readSchema(flag("schema"));
  const inventory = readJson(flag("inventory"), "inventory");
  const decisions = readJson(flag("decisions"), "decisions");
  const endpoint = requireEndpoint();
  // The id comes from the inventory rather than a flag, so the catalog cannot be
  // published under a name the decisions never reviewed. An inventory without
  // one is not an inventory this CLI wrote.
  const catalogId = inventory.catalog?.id;
  if (typeof catalogId !== "string" || catalogId.length === 0) {
    fail(`The inventory at ${flag("inventory")} has no catalog.id, so there is nothing to publish under.`);
  }

  let compiled;
  try {
    compiled = compileApprovedGraphQlCatalog(schema, inventory, decisions);
  } catch (error) {
    // The two structured failures carry the fix in their fields; a bare
    // message here would send the host back to reading the schema.
    fail(
      `These decisions do not compile against the schema:\n${describeValidationIssues(error) ?? `  ${error instanceof Error ? error.message : String(error)}`}` +
        (error instanceof Error && error.name === "GraphQlSemanticTypeError"
          ? '\n\nAdd "semanticTypeOverrides" at the TOP LEVEL of the decisions file,\n' +
            'beside "queries" — every other control lives on a query entry, and this\n' +
            'one placed there is refused as an unrecognized key. Keyed exactly as\n' +
            'above — e.g. {"Query.orders.discountRate": "quantity"}. Semantic meaning\n' +
            "is a host decision, so this tool will not guess one."
          : "") +
        (error instanceof Error && error.name === "GraphQlScalarMappingError"
          ? "\n\nAdd the scalar to --scalars and take the inventory again: `inventory\n" +
            "--scalars <file>` takes the same record."
          : ""),
    );
  }

  const payload = publishPayload({
    catalogId,
    compiled,
    schema,
    endpoint,
    credentialId: flag("credential-id"),
    uiManifestPath: flag("ui-manifest"),
  });

  const capabilityCount = compiled.catalog.capabilities.length;
  console.error(
    `\nCompiled ${capabilityCount} capabilit${capabilityCount === 1 ? "y" : "ies"} for "${catalogId}".`,
  );
  for (const issue of compiled.issues ?? []) {
    console.error(`  ${issue.code ?? "issue"}: ${issue.message ?? JSON.stringify(issue)}`);
  }
  reportContractSize(compiled);
  if (payload.format) {
    console.error(
      `\nBundle: both halves under one id, plus the upstream origin the server\n` +
        `checks before publishing either (${payload.requirements.upstreamOrigins.join(", ")}).`,
    );
  } else {
    // Said plainly, because the symptom of forgetting is a working publish
    // followed by a compose that renders nothing and blames the planner.
    console.error(
      "\nThis is the capability half only. Nothing renders until a UI catalog is\n" +
        `published under the same id ("${catalogId}"). Run the scaffolded\n` +
        "`npx tsx scripts/publish-ui-catalog.mjs` — under a loader, not bare node,\n" +
        "because it imports your JSX — or pass --ui-manifest <file> here to emit a\n" +
        "single bundle carrying both halves at once.",
    );
  }

  emit(payload, flag("out"));
  process.exit(0);
}

if (command === "curated") {
  const schema = readSchema(flag("schema"));
  const catalogId = flag("catalog-id");
  if (!catalogId) fail("Missing --catalog-id");
  const endpoint = requireEndpoint();
  // The whole point of the curated compiler is that no one reviewed anything:
  // it approves every field it can place, from a schema, unattended. That is a
  // legitimate way to start and a terrible way to ship, so the confirmation is
  // its own flag with its own words.
  //
  // `--yes` must never satisfy this, and nothing here reads it. A blanket
  // "don't ask me questions" is an answer about prompts; this is an answer
  // about who may read the data, and the two are not the same consent.
  if (!args.includes("--confirm-visitor-safe")) {
    fail(
      "curated needs --confirm-visitor-safe spelled out.\n" +
        "\n" +
        "  It approves visitor access to every field it can place a meaning on, from\n" +
        "  the schema alone, with no review step. Pass the flag only if every such\n" +
        "  field is safe for an unauthenticated visitor to read. `--yes` does not\n" +
        "  satisfy this and never will: it answers prompts, not this question.\n" +
        "\n" +
        "  The reviewed route is `inventory` then `candidate` then `compile`.",
    );
  }
  const authentication = flag("auth") ?? "session";
  if (authentication !== "public" && authentication !== "session") {
    fail('--auth must be "public" or "session"');
  }
  const integer = (name, fallback) => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) fail(`--${name} must be a positive integer`);
    return value;
  };
  const sourceLabel = flag("source-label") ?? catalogId;

  let compiled;
  try {
    compiled = compileCuratedGraphQlCatalog({
      schema,
      catalog: {
        id: catalogId,
        version: "1.0.0",
        description: `Curated reads from ${sourceLabel}.`,
      },
      source: {
        id: `${catalogId}-source`,
        label: sourceLabel,
        description: `The ${sourceLabel} GraphQL API.`,
      },
      policy: {
        authentication,
        maximumRows: integer("rows", 100),
        timeoutMs: integer("timeout", 5_000),
        cacheTtlSeconds: 0,
        ...(flag("page-size") ? { maximumPageSize: integer("page-size") } : {}),
        ...(flag("max-fields") ? { maximumSelectedFields: integer("max-fields") } : {}),
        ...(flag("depth") ? { maximumSelectionDepth: integer("depth") } : {}),
      },
      ...(flag("depth") ? { discoveryMaxDepth: integer("depth") } : {}),
      ...(flag("scalars") ? { scalarMappings: readJson(flag("scalars"), "scalars") } : {}),
      ...(flag("semantic-types")
        ? { semanticTypeOverrides: readJson(flag("semantic-types"), "semantic-types") }
        : {}),
    });
  } catch (error) {
    fail(`Curated compile failed:\n  ${error instanceof Error ? error.message : String(error)}`);
  }

  const payload = publishPayload({
    catalogId,
    compiled,
    schema,
    endpoint,
    credentialId: flag("credential-id"),
    uiManifestPath: flag("ui-manifest"),
  });

  const capabilityCount = compiled.catalog.capabilities.length;
  console.error(
    `\nCurated ${capabilityCount} capabilit${capabilityCount === 1 ? "y" : "ies"} for "${catalogId}", ` +
      `authentication: ${authentication}.`,
  );
  // Omitted, not failed — and the difference matters, because the catalog
  // compiles either way and the missing fields are simply absent from it.
  if (compiled.needsSemanticType.length > 0) {
    console.error(
      `\n${compiled.needsSemanticType.length} field(s) were left out: their meaning could not be\n` +
        "inferred, and this compiler never guesses one. Decide each, then re-run with\n" +
        "--semantic-types <file> keyed exactly as shown:",
    );
    for (const gap of compiled.needsSemanticType.slice(0, 10)) {
      console.error(`  "${gap.key}": ${gap.type}`);
    }
    if (compiled.needsSemanticType.length > 10) {
      console.error(`  ... and ${compiled.needsSemanticType.length - 10} more`);
    }
  }
  reportContractSize(compiled);
  if (!payload.format) {
    console.error(
      "\nCapability half only — pass --ui-manifest <file> for a bundle carrying both.",
    );
  }

  emit(payload, flag("out"));
  process.exit(0);
}

if (command === "publish") {
  const serviceUrl = flag("service-url");
  if (!serviceUrl) fail("Missing --service-url (where your mount is served, absolute)");
  const filePath = flag("file");
  const payload = readJson(filePath, "file");
  const tokenEnv = flag("admin-token-env") ?? "RENDERYES_ADMIN_TOKEN";
  const adminToken = process.env[tokenEnv];
  if (!adminToken) {
    // Env only, never a flag: a token on argv is in the shell history and in
    // `ps` for every user on the box, and this one opens the publish routes.
    fail(
      `${tokenEnv} is not set in this shell.\n` +
        "\n" +
        "  The publish routes are admin-gated. Export the token here — it is not read\n" +
        "  from a file, and it is not accepted as a flag, because an argument is\n" +
        "  visible in shell history and in the process list.\n" +
        `  Use --admin-token-env <NAME> if your variable is called something else.`,
    );
  }

  // The bundle route publishes both halves under one id and pre-checks the
  // upstream allowlist; the plain route is the capability half alone. Which
  // one this is, is a fact about the file, so it is not asked for twice.
  const isBundle = payload.format === "renderyes-review-export";
  const route = isBundle ? "api/review-export" : "api/catalog";
  // Trailing slash before resolving, or the mount prefix's last segment is
  // replaced instead of appended.
  const base = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
  let target;
  try {
    target = new URL(route, base);
  } catch {
    fail(`--service-url "${serviceUrl}" is not an absolute URL (http://… or https://…).`);
  }

  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", "x-renderyes-admin-token": adminToken },
    body: JSON.stringify(payload),
  }).catch((cause) => {
    fail(`Could not reach ${target}: ${cause instanceof Error ? cause.message : String(cause)}`);
  });

  const text = await response.text();
  let summary;
  try {
    summary = JSON.parse(text);
  } catch {
    // An HTML error page here almost always means the mount prefix is wrong,
    // which is invisible if the body is printed raw.
    console.error(
      `Expected JSON from ${target}, got: ${text.slice(0, 120)}…\n` +
        "  That is usually the mount prefix — --service-url must include it.",
    );
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`Publish failed (HTTP ${response.status}): ${summary.error ?? text.slice(0, 200)}`);
    process.exit(1);
  }

  console.log(
    `Published "${summary.catalogId}": ${summary.executableCapabilityCount} executable capabilit` +
      `${summary.executableCapabilityCount === 1 ? "y" : "ies"}.`,
  );
  if (isBundle) {
    console.log(`UI catalog: ${(summary.componentIds ?? []).length} component(s) registered.`);
  } else {
    console.error(
      `\nCapability half only. Nothing renders until a UI catalog is published under\n` +
        `"${summary.catalogId}" — \`npx tsx scripts/publish-ui-catalog.mjs\` does that from\n` +
        "components.",
    );
  }
  process.exit(0);
}

fail(command ? `Unknown command "${command}"` : "No command given");
