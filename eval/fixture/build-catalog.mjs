/**
 * Emits the finance fixture catalog as JSON for the eval CLI.
 *
 * The catalog is authored as a module because the JSON is repetitive and
 * hand-editing several hundred lines of it invites the kind of typo that
 * quietly changes what a baseline measured.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { financeCatalog } from "./finance-catalog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "finance-catalog.json");
await writeFile(out, JSON.stringify(financeCatalog, null, 2) + "\n");
console.log(
  `${out}\n${financeCatalog.capabilities.length} capabilities · ` +
    `${financeCatalog.dataTypes.length} data types · ` +
    `${financeCatalog.relationships.length} relationships`,
);
