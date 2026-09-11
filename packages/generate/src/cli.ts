import { readFileSync } from "node:fs";
import {
  loadDataContractFromDecisions,
  loadDataContractFromExport,
  type DataContract,
} from "./inputs.js";
import {
  createGenerateModelProvider,
  createScriptedGenerateProvider,
  type GenerateModelProvider,
} from "./provider.js";
import { generateComponent } from "./generate.js";
import { GenerateRefusalError, writeArtifacts } from "./emit.js";
import type { HostConvention } from "./style-corpus.js";

/**
 * Argument handling in the exact shape of `renderyes-catalog`
 * (capability-catalog/bin/catalog.mjs): reports to stderr, artifacts to
 * stdout unless `--out`, writes gated behind `--write`, exit codes for CI.
 *
 * Exit codes: 0 = generated and every mechanical check passed;
 * 1 = artifacts emitted but verification is failing (review the report);
 * 2 = usage error or refusal (nothing generated / nothing written).
 */
const USAGE = `Usage:
  renderyes-generate component --capability <id>
      ( --export <review-export.json>
      | --schema <schema.graphql> --decisions <decisions.json>
          [--inventory <inventory.json> | --catalog-id <id> [--source-label <label>] [--queries a,b] [--depth <n>] [--scalars <file>]] )
      [--host-dir <dir>]            root of the host project (default: cwd)
      [--style <file>]...           explicit style-corpus files (replaces detection)
      [--convention auto|folder|listed]
      [--id <ComponentId>]          component id (default: derived from the data type)
      [--provider openai|gemini|mock]  (default: openai)
      [--model <model>] [--api-key-env <NAME>] [--base-url <url>]
      [--timeout <seconds>]         ceiling per model call (default: 480 —
                                    whole-component drafts routinely exceed the
                                    provider's generic 60s default)
      [--mock-file <file>]          JSON array of scripted envelopes (provider: mock)
      [--rounds <n>]                repair rounds after the first draft (default: 2)
      [--out <dir>]                 write artifacts here instead of stdout
      [--write]                     allow --out to overwrite existing files`;

function parseArgs(argv: readonly string[]): {
  command: string | undefined;
  flags: Map<string, string[]>;
  booleans: Set<string>;
} {
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      booleans.add(name);
    } else {
      const existing = flags.get(name) ?? [];
      existing.push(next);
      flags.set(name, existing);
      index += 1;
    }
  }
  return { command, flags, booleans };
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new GenerateRefusalError(
      `Could not read ${label} at ${path}: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}

/** SDL text or an introspection JSON document — both are legal schema inputs. */
function readSchema(path: string): string | Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  if (!text.trimStart().startsWith("{")) return text;
  return JSON.parse(text) as Record<string, unknown>;
}

function loadContract(flags: Map<string, string[]>): DataContract {
  const exportPath = flags.get("export")?.[0];
  if (exportPath) {
    return loadDataContractFromExport(readJson(exportPath, "export bundle"));
  }
  const schemaPath = flags.get("schema")?.[0];
  const decisionsPath = flags.get("decisions")?.[0];
  if (!schemaPath || !decisionsPath) {
    throw new GenerateRefusalError(
      `Provide either --export, or --schema with --decisions.\n\n${USAGE}`,
    );
  }
  const inventoryPath = flags.get("inventory")?.[0];
  const depth = flags.get("depth")?.[0];
  const scalarsPath = flags.get("scalars")?.[0];
  return loadDataContractFromDecisions({
    schema: readSchema(schemaPath),
    approval: readJson(decisionsPath, "decisions"),
    ...(inventoryPath ? { draft: readJson(inventoryPath, "inventory") } : {}),
    ...(flags.get("catalog-id")?.[0] ? { catalogId: flags.get("catalog-id")?.[0] } : {}),
    ...(flags.get("source-label")?.[0]
      ? { sourceLabel: flags.get("source-label")?.[0] }
      : {}),
    ...(flags.get("queries")?.[0]
      ? {
          queries: flags
            .get("queries")![0]!
            .split(",")
            .map((name) => name.trim()),
        }
      : {}),
    ...(depth ? { discoveryDepth: Number(depth) } : {}),
    ...(scalarsPath
      ? {
          scalarMappings: readJson(scalarsPath, "scalars") as Record<
            string,
            { schema: Record<string, unknown> }
          >,
        }
      : {}),
  });
}

/**
 * Default per-model-call ceiling for THIS CLI, in seconds. The provider's own
 * default (DEFAULT_MODEL_TIMEOUT_MS, 60s) was sized for planner calls;
 * drafting a whole component takes several minutes on current models, and the
 * first live acceptance run was killed by exactly that mismatch.
 */
export const DEFAULT_GENERATE_TIMEOUT_SECONDS = 480;

function resolveTimeoutMs(flags: Map<string, string[]>): number {
  const raw = flags.get("timeout")?.[0];
  const seconds = raw === undefined ? DEFAULT_GENERATE_TIMEOUT_SECONDS : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new GenerateRefusalError(`--timeout must be a positive number of seconds, got "${raw}"`);
  }
  return Math.round(seconds * 1000);
}

function buildProvider(flags: Map<string, string[]>): GenerateModelProvider {
  const providerId = flags.get("provider")?.[0] ?? "openai";
  if (providerId === "mock") {
    const mockFile = flags.get("mock-file")?.[0];
    if (!mockFile) {
      throw new GenerateRefusalError("--provider mock requires --mock-file <file>");
    }
    const script = readJson(mockFile, "mock script");
    if (!Array.isArray(script)) {
      throw new GenerateRefusalError(
        "--mock-file must contain a JSON array of envelopes",
      );
    }
    return createScriptedGenerateProvider(script);
  }
  if (providerId !== "openai" && providerId !== "gemini") {
    throw new GenerateRefusalError(`Unknown provider "${providerId}"`);
  }
  return createGenerateModelProvider({
    id: providerId,
    timeoutMs: resolveTimeoutMs(flags),
    ...(flags.get("model")?.[0] ? { model: flags.get("model")?.[0] } : {}),
    ...(flags.get("api-key-env")?.[0]
      ? { apiKeyEnv: flags.get("api-key-env")?.[0] }
      : {}),
    ...(flags.get("base-url")?.[0] ? { baseUrl: flags.get("base-url")?.[0] } : {}),
  });
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const { command, flags, booleans } = parseArgs(argv);
  const report = (line: string) => console.error(line);

  // Asking for help is not an error. `--help` reported "No command given" and
  // exited 2, so the first thing anyone types at this CLI told them they had
  // done something wrong — on stderr, with a failing status a script would trip
  // on. `init` and `catalog` both already answer it properly.
  if (booleans.has("help") || booleans.has("h") || argv.length === 0) {
    console.log(USAGE);
    return 0;
  }
  if (command !== "component") {
    console.error(command ? `Unknown command "${command}"` : "No command given");
    console.error(`\n${USAGE}`);
    return 2;
  }
  const capabilityId = flags.get("capability")?.[0];
  if (!capabilityId) {
    console.error(`Missing --capability\n\n${USAGE}`);
    return 2;
  }

  try {
    const contract = loadContract(flags);
    const provider = buildProvider(flags);
    const conventionFlag = flags.get("convention")?.[0] ?? "auto";
    if (!["auto", "folder", "listed"].includes(conventionFlag)) {
      throw new GenerateRefusalError(`--convention must be auto, folder, or listed`);
    }
    const rounds = flags.get("rounds")?.[0];

    const result = await generateComponent({
      contract,
      capabilityId,
      provider,
      ...(flags.get("host-dir")?.[0] ? { hostDir: flags.get("host-dir")?.[0] } : {}),
      ...(flags.get("style") ? { styleFiles: flags.get("style") } : {}),
      convention: conventionFlag as HostConvention | "auto",
      ...(flags.get("id")?.[0] ? { componentId: flags.get("id")?.[0] } : {}),
      ...(rounds !== undefined ? { maximumRepairRounds: Number(rounds) } : {}),
      log: report,
    });

    const outDir = flags.get("out")?.[0];
    const hasPreview = result.artifacts.some(
      (artifact) => artifact.name === "preview.html",
    );
    if (outDir) {
      const written = writeArtifacts(result.artifacts, outDir, booleans.has("write"));
      report(`\n${written.length} artifact(s) written:`);
      for (const path of written) report(`  ${path}`);
      if (hasPreview) {
        report(
          "\nOpen preview.html in a browser — the rendered states under the host stylesheet, self-contained.",
        );
      }
    } else {
      // Artifacts to stdout as one JSON document, report noise on stderr —
      // pipeable, same as the approval CLI.
      console.log(
        JSON.stringify(
          {
            pass: result.pass,
            rounds: result.rounds,
            artifacts: result.artifacts,
          },
          null,
          2,
        ),
      );
    }

    if (!result.pass) {
      report(
        "\nVerification is FAILING — artifacts were emitted anyway; the verification report marks each failure.",
      );
      return 1;
    }
    report("\nAll mechanical checks passed. Review before registering.");
    return 0;
  } catch (error) {
    if (error instanceof GenerateRefusalError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}
