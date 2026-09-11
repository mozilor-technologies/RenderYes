import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { transform } from "esbuild";
import { createElement, type FC } from "react";
import { renderToString } from "react-dom/server";
import { ingestViews, type RegisteredHostComponent } from "@renderyes/react";
import {
  defineSite,
  defineSiteFromManifest,
  defineSurface,
  matchCatalogToComponents,
  type SiteComponentDefinition,
  type SiteManifest,
} from "@renderyes/site-sdk";
import type { PlannerManifest } from "@renderyes/capability-catalog";
import type { GenerateEnvelope } from "./prompt.js";
import type { CapabilitySlice } from "./inputs.js";
import type { StyleCorpus } from "./style-corpus.js";
import { buildStateFixtures } from "./sample-rows.js";
import { deriveTwinDefinition } from "./emit.js";
import type {
  RenderedStateName,
  VerificationCheck,
  VerificationReport,
} from "./verify-report.js";

/**
 * The six mechanical checks. Every one returns `{name, pass, detail}` and the
 * failing details are fed back to the model verbatim by the repair loop — so
 * each detail is written to be actionable by a model, not just readable by a
 * human.
 *
 * Check 2 deliberately *is* `defineHostComponent` (via `ingestViews`): its
 * thrown errors are the registration contract, and re-implementing them here
 * would create a second contract that drifts from the real one.
 */

const NOT_RUN = "not run — an earlier check this depends on failed";

interface ImportedDraft {
  module: Record<string, unknown>;
  cleanup: () => Promise<void>;
}

/**
 * Bare specifiers in the draft resolve against THIS package (which depends on
 * `@renderyes/react` and react for exactly this reason), because the file is
 * imported from a temp directory where nothing resolves. Relative imports are
 * rejected outright: a generated view is required to be self-contained.
 */
function rewriteImports(code: string): string {
  return code.replace(
    /(\bfrom\s+|\bimport\s+)(["'])([^"']+)\2/g,
    (whole, prefix: string, quote: string, specifier: string) => {
      if (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier.startsWith("/") ||
        specifier.startsWith("node:") ||
        specifier.startsWith("file:") ||
        specifier.startsWith("data:")
      ) {
        return whole;
      }
      try {
        const resolved = import.meta.resolve(specifier);
        return `${prefix}${quote}${resolved}${quote}`;
      } catch {
        return whole;
      }
    },
  );
}

async function importDraftModule(
  source: string,
  fileExtension: ".tsx" | ".jsx",
): Promise<ImportedDraft> {
  if (/(?:^|\n)\s*import[^\n]*["'](\.\.?\/)/.test(source)) {
    throw new Error(
      "The view file must be self-contained: it imports a relative module, which cannot exist next to a generated file.",
    );
  }
  const transformed = await transform(source, {
    loader: fileExtension === ".tsx" ? "tsx" : "jsx",
    format: "esm",
    jsx: "automatic",
    target: "es2022",
  });
  const directory = await mkdtemp(join(tmpdir(), "renderyes-generate-"));
  const filePath = join(directory, `draft-${randomUUID()}.mjs`);
  await writeFile(filePath, rewriteImports(transformed.code));
  const module = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  return {
    module,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** First differing path between two JSON-safe values, or undefined when equal. */
function firstDifference(a: unknown, b: unknown, path = "$"): string | undefined {
  if (Object.is(a, b)) return undefined;
  if (typeof a !== typeof b) return `${path} (${typeof a} vs ${typeof b})`;
  if (typeof a !== "object" || a === null || b === null) {
    return `${path} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path} (array vs object)`;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b as object)])].sort();
  for (const key of keys) {
    const difference = firstDifference(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${path}.${key}`,
    );
    if (difference) return difference;
  }
  return undefined;
}

/** The JSON-safe projection twin equality compares. Props compare by their JSON Schema. */
function definitionProjection(definition: SiteComponentDefinition): unknown {
  return JSON.parse(
    JSON.stringify({
      id: definition.id,
      version: definition.version,
      description: definition.description,
      renderer: definition.renderer,
      dataSlots: definition.dataSlots,
      propsSchema: definition.props.jsonSchema,
    }),
  );
}

const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  {
    pattern: /\bfetch\s*\(/,
    label: "fetch() — views take data through props, never fetch",
  },
  { pattern: /\bXMLHttpRequest\b/, label: "XMLHttpRequest" },
  { pattern: /\bWebSocket\b/, label: "WebSocket" },
  { pattern: /\bwindow\s*[.[]/, label: "window global" },
  { pattern: /\bdocument\s*[.[]/, label: "document global" },
  { pattern: /\blocalStorage\b/, label: "localStorage" },
  { pattern: /\bsessionStorage\b/, label: "sessionStorage" },
  { pattern: /import\.meta/, label: "import.meta" },
  { pattern: /\bprocess\.env\b/, label: "process.env" },
  { pattern: /\brequire\s*\(/, label: "require()" },
];

const INTERACTIVE_ELEMENT = /<\s*(button|input|select|textarea|form)\b/i;
const HEX_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;
const HEADING_CONTENT = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;

function extractClassNames(source: string): string[] {
  const classes = new Set<string>();
  for (const match of source.matchAll(
    /className\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*"([^"]+)"\s*\}|\{\s*'([^']+)'\s*\})/g,
  )) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    for (const token of value.split(/\s+/)) {
      if (token) classes.add(token);
    }
  }
  return [...classes];
}

/**
 * The same rows with every leaf value changed, used to prove the draft binds
 * data rather than merely rendering.
 *
 * Matching sample values against the HTML would be the obvious test and is the
 * wrong one: a component that formats — money as `$1,234.50`, an ISO date as
 * `15 Jan 2026` — binds correctly and contains none of its inputs verbatim.
 * Rendering twice and requiring the output to differ asks the question the
 * assertion is actually about, and asks it whatever the formatting.
 *
 * ISO-like strings shift by a day rather than taking a suffix, because
 * `new Date("2026-01-15-2")` is `Invalid Date` — which renders identically for
 * both row sets and would report a binding failure that is not one.
 */
function variedValue(value: unknown): unknown {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed) && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return new Date(parsed + 86_400_000).toISOString().slice(0, value.length);
    }
    return `${value} (2)`;
  }
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (Array.isArray(value)) return value.map(variedValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, variedValue(v)]),
    );
  }
  return value;
}

function variedRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  // The row *count* is held constant on purpose. Varying it would let the
  // failure this exists for walk straight through: the draft that shipped this
  // rendered one row per record with every cell an em dash, so its output did
  // depend on how many rows arrived — just not on anything in them. Same count,
  // different values, is the question worth asking: do field values reach the
  // screen at all?
  return rows.map((row) => variedValue(row) as Record<string, unknown>);
}

function identifierSampleValues(
  slice: CapabilitySlice,
  sampleRows: Record<string, unknown>[],
): string[] {
  const identifierPaths = Object.entries(slice.dataType.fields)
    .filter(([, descriptor]) => descriptor.semanticType === "identifier")
    .map(([path]) => path);
  const values = new Set<string>();
  for (const row of sampleRows) {
    for (const path of identifierPaths) {
      let cursor: unknown = row;
      for (const segment of path.split(".")) {
        cursor =
          typeof cursor === "object" && cursor !== null
            ? (cursor as Record<string, unknown>)[segment]
            : undefined;
      }
      if (typeof cursor === "string") values.add(cursor);
    }
  }
  return [...values];
}

export interface VerifyDraftOptions {
  envelope: GenerateEnvelope;
  slice: CapabilitySlice;
  plannerManifest: PlannerManifest;
  uiManifest?: SiteManifest;
  corpus: StyleCorpus;
  fileExtension: ".tsx" | ".jsx";
  sampleRows: Record<string, unknown>[];
}

export async function verifyDraft(
  options: VerifyDraftOptions,
): Promise<VerificationReport> {
  const checks: VerificationCheck[] = [];
  // Every state that renders without throwing, kept for the preview artifact —
  // a failing draft with even one rendered state is still worth looking at.
  const outputs = new Map<RenderedStateName, string>();
  const source = options.envelope.componentFile;
  const spec = options.envelope.spec;

  // 1. esbuild parse — the cheapest possible "is this even a component file".
  let parsed = false;
  try {
    await transform(source, {
      loader: options.fileExtension === ".tsx" ? "tsx" : "jsx",
      jsx: "automatic",
    });
    parsed = true;
    checks.push({ name: "esbuild-parse", pass: true, detail: "source parses" });
  } catch (error) {
    checks.push({
      name: "esbuild-parse",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 2. Import + defineHostComponent (via ingestViews): the real registration
  //    contract, thrown errors and all.
  let registered: RegisteredHostComponent | undefined;
  let draftModule: Record<string, unknown> | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  if (!parsed) {
    checks.push({ name: "define-host-component", pass: false, detail: NOT_RUN });
  } else {
    try {
      const imported = await importDraftModule(source, options.fileExtension);
      draftModule = imported.module;
      cleanup = imported.cleanup;
      const fileName = `${spec.id}.view${options.fileExtension}`;
      const [first] = ingestViews({ [fileName]: imported.module });
      if (!first) throw new Error(`${fileName} registered no component`);
      registered = first;
      checks.push({
        name: "define-host-component",
        pass: true,
        detail: `registered "${registered.definition.id}" without contract violations`,
      });
    } catch (error) {
      checks.push({
        name: "define-host-component",
        pass: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    // 3. Twin equality: the envelope's spec (which the server twin is derived
    //    from) must register the exact same semantic contract as the file.
    let twin: SiteComponentDefinition | undefined;
    if (!registered) {
      checks.push({ name: "twin-equality", pass: false, detail: NOT_RUN });
      try {
        twin = deriveTwinDefinition(spec);
      } catch {
        twin = undefined;
      }
    } else {
      try {
        twin = deriveTwinDefinition(spec);
        const difference = firstDifference(
          definitionProjection(twin),
          definitionProjection(registered.definition),
        );
        checks.push(
          difference
            ? {
                name: "twin-equality",
                pass: false,
                detail: `envelope spec and the file's defineView disagree at ${difference} — make the JSON spec exactly mirror the file`,
              }
            : {
                name: "twin-equality",
                pass: true,
                detail: "derived server twin matches the file's contract",
              },
        );
      } catch (error) {
        checks.push({
          name: "twin-equality",
          pass: false,
          detail: `deriving the server twin from the spec failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    // 4. Coverage delta: with the new definition registered, the coverage
    //    matcher (the same one plan validation uses) must offer this
    //    component for the capability's (dataTypeId, shape).
    if (!twin) {
      checks.push({ name: "coverage-delta", pass: false, detail: NOT_RUN });
    } else {
      try {
        const baseComponents = options.uiManifest
          ? defineSiteFromManifest(options.uiManifest).components
          : [];
        const components = [...baseComponents, twin];
        const site = defineSite({
          id: "generate-coverage-check",
          name: "generate coverage check",
          version: "1.0.0",
          catalogId: options.plannerManifest.catalogId,
          components,
          surfaces: [
            defineSurface({
              id: "main",
              description: "Coverage-delta check surface.",
              componentIds: components.map((component) => component.id),
            }),
          ],
        });
        const coverage = matchCatalogToComponents(options.plannerManifest, site);
        const target = coverage.find(
          (row) =>
            row.dataTypeId === options.slice.capability.output.dataTypeId &&
            row.shape === options.slice.capability.output.shape,
        );
        if (!target) {
          checks.push({
            name: "coverage-delta",
            pass: false,
            detail: `the catalog produces no (${options.slice.capability.output.dataTypeId}, ${options.slice.capability.output.shape}) — capability mismatch`,
          });
        } else if (target.matchingComponentIds.includes(twin.id)) {
          checks.push({
            name: "coverage-delta",
            pass: true,
            detail: `${twin.id} now renders (${target.dataTypeId}, ${target.shape})`,
          });
        } else {
          checks.push({
            name: "coverage-delta",
            pass: false,
            detail: `${twin.id} does not accept (${target.dataTypeId}, ${target.shape}) — fix the dataSlots acceptance to accept exactly this data type and shape`,
          });
        }
      } catch (error) {
        checks.push({
          name: "coverage-delta",
          pass: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 5. Render smoke: mount the real component under the four fixture states.
    const component = draftModule?.default;
    if (typeof component !== "function") {
      checks.push({ name: "render-smoke", pass: false, detail: NOT_RUN });
    } else {
      const failures: string[] = [];
      const slotNames = Object.keys(spec.dataSlots);
      const primarySlot = slotNames[0] ?? "data";
      const propDefaults: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(spec.props ?? {})) {
        if (prop.default !== undefined) propDefaults[name] = prop.default;
      }
      const fixtures = buildStateFixtures({
        rows: options.sampleRows,
        shape: options.slice.capability.output.shape,
        sourceId: options.slice.capability.sourceIds[0] ?? "fixture-source",
      });
      for (const fixture of fixtures) {
        const props: Record<string, unknown> = {
          ...propDefaults,
          ...Object.fromEntries(slotNames.map((name) => [name, null])),
          [primarySlot]: fixture.slotValue,
          ...fixture.companions,
        };
        try {
          outputs.set(
            fixture.name,
            renderToString(createElement(component as FC, props)),
          );
        } catch (error) {
          failures.push(
            `rendering the "${fixture.name}" state threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (failures.length === 0 && new Set(outputs.values()).size !== outputs.size) {
        const collisions = [...outputs.entries()]
          .filter(
            ([, html], _, all) => all.filter(([, other]) => other === html).length > 1,
          )
          .map(([name]) => name);
        failures.push(
          `these states render identical output: ${collisions.join(", ")} — each state must be visibly distinct (error message, empty message, truncation notice)`,
        );
      }

      // Rubric gates over the same mount.
      const readyHtml = outputs.get("ready") ?? "";

      // The draft must render its data, not merely render. Six checks once
      // passed a component calling `field(row, path)` — `field` is an object of
      // prop builders and is not callable — whose own `readField` try/catch
      // swallowed the throw, so every cell showed an em dash over ten rows.
      // Every state rendered, and distinctly, so nothing here failed; the states
      // were empty of data and no assertion asked. This one does.
      if (failures.length === 0 && options.sampleRows.length > 0) {
        const variedFixture = buildStateFixtures({
          rows: variedRows(options.sampleRows),
          shape: options.slice.capability.output.shape,
          sourceId: options.slice.capability.sourceIds[0] ?? "fixture-source",
        }).find((fixture) => fixture.name === "ready");
        if (variedFixture) {
          try {
            const variedHtml = renderToString(
              createElement(component as FC, {
                ...propDefaults,
                ...Object.fromEntries(slotNames.map((name) => [name, null])),
                [primarySlot]: variedFixture.slotValue,
                ...variedFixture.companions,
              }),
            );
            if (variedHtml === readyHtml) {
              failures.push(
                "the ready state renders identical output for two different row sets — " +
                  "nothing on screen comes from the data. Check that each value is read " +
                  "from the row (a helper that throws inside a try/catch renders the " +
                  "empty placeholder for every cell and looks like a working component)",
              );
            }
          } catch (error) {
            failures.push(
              `rendering the ready state over a second row set threw: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
      const identifiers = identifierSampleValues(options.slice, options.sampleRows);
      for (const match of readyHtml.matchAll(HEADING_CONTENT)) {
        const heading = match[1] ?? "";
        const offending = identifiers.find((value) => heading.includes(value));
        if (offending) {
          failures.push(
            `a heading renders the identifier value "${offending}" — identifiers are keys, never titles; use a text field for the heading`,
          );
          break;
        }
      }
      const interactive = INTERACTIVE_ELEMENT.exec(source);
      if (interactive) {
        failures.push(
          `read-only rule: remove the <${interactive[1]}> element — indicators, not controls`,
        );
      }
      if (options.corpus.hasTokens && HEX_COLOR.test(source)) {
        failures.push(
          "hard-coded hex color found — the host has design tokens; use them instead",
        );
      }
      if (
        options.corpus.system === "plain-css" &&
        options.corpus.stylesheetText.length > 0
      ) {
        const missing = extractClassNames(source).filter(
          (className) => !options.corpus.stylesheetText.includes(`.${className}`),
        );
        if (missing.length > 0) {
          failures.push(
            `these classNames do not exist in the host stylesheet: ${missing.join(", ")} — use classes the corpus defines`,
          );
        }
      }
      checks.push(
        failures.length > 0
          ? { name: "render-smoke", pass: false, detail: failures.join("; ") }
          : {
              name: "render-smoke",
              pass: true,
              detail:
                "ready/empty/error/truncated all render, distinctly; rubric gates hold",
            },
      );
    }

    // 6. Authoring-rules lint over the raw source.
    {
      const violations = FORBIDDEN_PATTERNS.filter((entry) =>
        entry.pattern.test(source),
      ).map((entry) => entry.label);
      const warnings: string[] = [];
      for (const companion of ["state", "sources", "completeness"] as const) {
        if (!new RegExp(`\\b${companion}\\b`).test(source)) {
          warnings.push(
            `warning: the component never reads \`${companion}\` — see AUTHORING_VIEWS.md, "not optional to handle"`,
          );
        }
      }
      checks.push(
        violations.length > 0
          ? {
              name: "authoring-lint",
              pass: false,
              detail: `forbidden in a view: ${violations.join("; ")}`,
            }
          : {
              name: "authoring-lint",
              pass: true,
              detail:
                warnings.length > 0
                  ? warnings.join("; ")
                  : "no authoring-rule violations",
            },
      );
    }
  } finally {
    await cleanup?.();
  }

  return {
    pass: checks.every((check) => check.pass),
    checks,
    renderedStates: Object.fromEntries(outputs) as Partial<
      Record<RenderedStateName, string>
    >,
  };
}
