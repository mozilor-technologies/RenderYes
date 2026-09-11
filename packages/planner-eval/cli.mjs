#!/usr/bin/env node
/**
 * Runs an eval suite against a real model and writes a baseline.
 *
 * The harness, the checks, and the baseline diff all existed; nothing could
 * invoke them, so no measurement had ever been taken. This is that missing
 * entry point and nothing more — every decision it makes is delegated to the
 * library so the CLI stays a thin argument parser.
 *
 * Usage:
 *   node cli.mjs --catalog <publish.json> --cases <cases.json> [options]
 *
 *   --catalog   A capability catalog publish payload, as exported by the
 *               review UI (the `{catalog, bindings, ...}` envelope or a bare
 *               catalog — both are accepted).
 *   --cases     JSON array of EvalCase objects (see cases/*.cases.json).
 *   --site      Optional site manifest JSON. Omitted, a minimal site is
 *               generated with one component per data type, which is enough to
 *               measure capability selection but not component selection.
 *   --runs      Times each case runs. Default 3.
 *   --provider  openai | gemini | mock. Default openai.
 *   --model     Overrides the provider's default model.
 *   --out       Where to write the baseline. Default eval-baseline.json.
 *   --compare   An existing baseline to diff against; prints the flip table.
 *   --failures  Where to dump failing-case detail. Default eval-failures.json.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createPlannerManifest } from "@renderyes/capability-catalog";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
  defineSiteFromManifest,
} from "@renderyes/site-sdk";
import { createModelPlanProvider } from "@renderyes/server";
import {
  compareToBaseline,
  formatBaselineComparison,
  formatEvalReport,
  runEvalSuite,
  toBaseline,
} from "./dist/index.js";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    args[key] = next && !next.startsWith("--") ? ((index += 1), next) : "true";
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.catalog || !args.cases) {
  console.error("Required: --catalog <publish.json> --cases <cases.json>");
  process.exit(2);
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

// The review UI exports a publish envelope; a hand-written fixture is often
// just the catalog. Accept either rather than making the caller unwrap it.
const catalogFile = await readJson(args.catalog);
const catalog = catalogFile.catalog ?? catalogFile;
const cases = await readJson(args.cases);
const plannerManifest = createPlannerManifest(catalog);

/**
 * A component per data type, so every capability has somewhere to render.
 *
 * This measures capability selection honestly and component selection barely
 * at all — with one candidate per type there is no choice to get wrong. Pass
 * `--site` with the host's real manifest to measure both. Stated here because
 * a number that looks like component accuracy but isn't would be worse than
 * no number.
 */
function generateSite() {
  const components = plannerManifest.dataTypes.map((dataType) =>
    defineComponent({
      id: `${dataType.id}View`,
      version: "1.0.0",
      description: `Renders ${dataType.id}.`,
      props: defineProps({ title: field.string({ default: dataType.id }) }),
      renderer: { component: `${dataType.id}View`, props: { data: { path: "/data" } } },
      dataSlots: {
        data: {
          accepts: [
            {
              dataTypeId: dataType.id,
              shapes: ["entity", "collection", "metric", "time-series", "search-results"],
            },
          ],
        },
      },
    }),
  );
  return defineSite({
    id: catalog.id,
    name: catalog.id,
    version: "1.0.0",
    catalogId: `${catalog.id}:eval`,
    components,
    surfaces: [
      defineSurface({
        id: "main",
        description: "Evaluation surface.",
        componentIds: components.map((component) => component.id),
        maxComponents: 6,
      }),
    ],
  });
}

// A `--site` manifest arrives as JSON and must be rebuilt; a generated one
// is already a RegisteredSite, so round-tripping it would only lose fidelity.
const site = args.site
  ? defineSiteFromManifest(await readJson(args.site))
  : generateSite();

const providerId = args.provider ?? "openai";
const DEFAULT_MODELS = { openai: "gpt-5.6", gemini: "gemini-3.6-flash" };
const model = args.model ?? DEFAULT_MODELS[providerId] ?? "mock";

const provider =
  providerId === "mock"
    ? {
        id: "mock",
        async generatePlan() {
          return {
            modelId: "mock",
            value: { status: "unsupported", reason: "mock provider" },
          };
        },
      }
    : createModelPlanProvider({
        id: providerId,
        apiKeyEnv: providerId === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY",
        model,
      });

const runs = Number(args.runs ?? 3);
console.error(
  `running ${cases.length} cases x ${runs} runs against ${providerId}:${model}` +
    ` (${plannerManifest.capabilities.length} capabilities)`,
);

const report = await runEvalSuite({
  site,
  plannerManifest,
  surfaceId: "main",
  cases,
  provider,
  runs,
});

console.log(formatEvalReport(report));

const modelIdentity = { providerId, modelId: model };
const outPath = args.out ?? "eval-baseline.json";
await writeFile(
  outPath,
  JSON.stringify(toBaseline(report, modelIdentity), null, 2) + "\n",
);
console.error(`baseline -> ${outPath}`);

// One file with everything a human needs to judge a failure, so the judgement
// calls take a minute each instead of ten spent re-running things by hand.
const failures = report.cases
  .filter((caseReport) => caseReport.passRate < 1)
  .map((caseReport) => ({
    id: caseReport.id,
    prompt: caseReport.prompt,
    passRate: caseReport.passRate,
    firstAttemptValidRate: caseReport.firstAttemptValidRate,
    meanRepairCount: caseReport.meanRepairCount,
    failureBuckets: caseReport.failureBuckets,
    checks: caseReport.checks,
    unstable: caseReport.unstable,
  }));
if (failures.length > 0) {
  const failurePath = args.failures ?? "eval-failures.json";
  await writeFile(failurePath, JSON.stringify(failures, null, 2) + "\n");
  console.error(`${failures.length} failing cases -> ${failurePath}`);
}

if (args.compare) {
  const previous = await readJson(args.compare);
  const comparison = compareToBaseline(report, previous, { model: modelIdentity });
  console.log("");
  console.log(formatBaselineComparison(comparison, runs));
  // A model mismatch is a setup error, not a result: exiting non-zero stops a
  // script from treating the diff as a verdict.
  if (comparison.modelMismatch) process.exit(3);
}
