#!/usr/bin/env node
/**
 * The contracts, as JSON Schema, on disk and in the tarball.
 *
 * Every one of these already exists as a Zod schema — but Zod is a runtime
 * object reachable only from JavaScript that imported this package. Anything
 * else validating an artifact (a CI step, a language that is not TypeScript, a
 * coding agent asked to write a decisions file) had to infer the shape from
 * `.d.ts` or from an example, and inference gets `additionalProperties` exactly
 * backwards: these are strict objects, so a plausible-looking extra key is a
 * hard failure rather than a harmless addition.
 *
 * Generated rather than hand-written, and generated at build time rather than
 * committed, so a schema that drifts from its Zod definition is not a state
 * this repository can be in.
 *
 * No inventory schema here, and that is not an oversight: the inventory is a
 * TypeScript interface with no Zod definition, because nothing ever parses one
 * from untrusted input — it is produced by this package and consumed by it.
 * Emitting a hand-written schema for it would be the drift this script exists
 * to prevent.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CapabilityCatalogSchema, ReviewExportEnvelopeSchema } from "../dist/index.js";
import { GraphQlCatalogDecisionsSchema } from "../dist/graphql.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "schemas");
mkdirSync(outDir, { recursive: true });

const SCHEMAS = [
  {
    file: "graphql-decisions.schema.json",
    schema: GraphQlCatalogDecisionsSchema,
    title: "RenderYes GraphQL decisions",
    description:
      "What a visitor may read from a GraphQL source: approved fields and " +
      "arguments, identity mapping, row and time limits. The file a host owns " +
      "and edits. Produced by `renderyes-catalog candidate`, consumed by `compile`.",
  },
  {
    file: "capability-catalog.schema.json",
    schema: CapabilityCatalogSchema,
    title: "RenderYes capability catalog",
    description:
      "A compiled catalog, as published to POST /api/catalog. Derived from an " +
      "inventory and a decisions file; rebuild it rather than editing it.",
  },
  {
    file: "review-export.schema.json",
    schema: ReviewExportEnvelopeSchema,
    title: "RenderYes review export",
    description:
      "Both halves of a catalog — capability and UI — under one id, as published " +
      "to POST /api/review-export. Envelope only: the catalog and manifest inside " +
      "are re-validated by the publish path.",
  },
];

for (const entry of SCHEMAS) {
  // `io: "input"` because these describe what a host *writes*, where optional
  // fields are genuinely absent. The output variant would mark defaults as
  // required and reject a perfectly good hand-written file.
  const json = z.toJSONSchema(entry.schema, { io: "input" });
  writeFileSync(
    join(outDir, entry.file),
    `${JSON.stringify({ ...json, title: entry.title, description: entry.description }, null, 2)}\n`,
  );
  console.log(`schemas/${entry.file}`);
}
