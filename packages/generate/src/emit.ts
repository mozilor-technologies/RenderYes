import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defineComponent,
  defineProps,
  field,
  type ComponentDataSlot,
  type FieldDefinition,
  type SiteComponentDefinition,
} from "@renderyes/site-sdk";
import type { GenerateEnvelope, GenerateSpec } from "./prompt.js";
import type { CapabilitySlice } from "./inputs.js";
import type { HostConvention, HostFile } from "./style-corpus.js";
import { listHostFiles } from "./style-corpus.js";
import { renderPreviewHtml } from "./preview.js";
import type { VerificationReport } from "./verify-report.js";

/** A refusal is not a failure to generate — it is the tool declining to. Exit code 2, never 1. */
export class GenerateRefusalError extends Error {}

export function assertNoIdCollision(spec: GenerateSpec, slice: CapabilitySlice): void {
  if (slice.existingComponentIds.includes(spec.id)) {
    throw new GenerateRefusalError(
      `Refusing to emit "${spec.id}": a component with that id is already registered. ` +
        "Regenerating an existing component would silently shadow the reviewed one — " +
        "pick a new id (--id) or retire the old component first.",
    );
  }
}

export function propsRecordFromSpec(
  specProps: GenerateSpec["props"],
): Record<string, FieldDefinition> {
  const record: Record<string, FieldDefinition> = {};
  for (const [name, prop] of Object.entries(specProps ?? {})) {
    const shared = {
      ...(prop.required !== undefined ? { required: prop.required } : {}),
    };
    switch (prop.type) {
      case "string":
        record[name] = field.string({
          ...shared,
          ...(typeof prop.default === "string" ? { default: prop.default } : {}),
        });
        break;
      case "number":
        record[name] = field.number({
          ...shared,
          ...(typeof prop.default === "number" ? { default: prop.default } : {}),
        });
        break;
      case "boolean":
        record[name] = field.boolean({
          ...shared,
          ...(typeof prop.default === "boolean" ? { default: prop.default } : {}),
        });
        break;
      case "enum":
        record[name] = field.enum(prop.values ?? [], {
          ...shared,
          ...(typeof prop.default === "string" ? { default: prop.default } : {}),
        });
        break;
      case "stringArray":
        record[name] = field.stringArray({
          ...shared,
          ...(Array.isArray(prop.default) ? { default: prop.default } : {}),
        });
        break;
    }
  }
  return record;
}

/**
 * Derives the server-side twin from the client spec — the same derivation
 * `defineHostComponent` performs (packages/react/src/define-host-component.tsx),
 * including the single-slot companion paths. The twin is NEVER model-written:
 * deriving it from the spec is what makes the drift the hand-maintained twins
 * warn about structurally impossible.
 */
export function deriveTwinDefinition(spec: GenerateSpec): SiteComponentDefinition {
  const slotNames = Object.keys(spec.dataSlots);
  const hasOneDataSlot = slotNames.length === 1;
  const paths: Record<string, string> = {
    ...Object.fromEntries(slotNames.map((slotName) => [slotName, `/${slotName}`])),
    ...(hasOneDataSlot
      ? {
          state: "/state",
          errorMessage: "/errorMessage",
          sources: "/sources",
          asOf: "/asOf",
          staleAt: "/staleAt",
          completeness: "/completeness",
          records: "/records",
        }
      : {}),
  };
  return defineComponent({
    id: spec.id,
    version: spec.version ?? "1.0.0",
    description: spec.description,
    props: defineProps(propsRecordFromSpec(spec.props)),
    renderer: {
      component: spec.id,
      props: {
        ...(spec.accessibility ? { accessibility: spec.accessibility } : {}),
        ...Object.fromEntries(
          Object.entries(paths).map(([key, path]) => [key, { path }]),
        ),
      },
    },
    dataSlots: spec.dataSlots as unknown as Readonly<Record<string, ComponentDataSlot>>,
  });
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function renderFieldCall(prop: NonNullable<GenerateSpec["props"]>[string]): string {
  const options: string[] = [];
  if (prop.default !== undefined)
    options.push(`default: ${JSON.stringify(prop.default)}`);
  if (prop.required !== undefined)
    options.push(`required: ${JSON.stringify(prop.required)}`);
  const optionsLiteral = options.length > 0 ? `{ ${options.join(", ")} }` : "";
  if (prop.type === "enum") {
    const values = JSON.stringify(prop.values ?? []);
    return optionsLiteral
      ? `field.enum(${values}, ${optionsLiteral})`
      : `field.enum(${values})`;
  }
  return `field.${prop.type}(${optionsLiteral})`;
}

/**
 * The twin as literal `.mjs` source, in the exact idiom of a listed host's
 * hand-written `component-defs.mjs`: only the slot paths are declared, and
 * `defineComponent` derives the companion paths — identically on both sides,
 * which is what the twin-equality check proves.
 */
export function renderTwinModule(spec: GenerateSpec): string {
  const name = `${lowerFirst(spec.id)}Definition`;
  const propsEntries = Object.entries(spec.props ?? {})
    .map(([propName, prop]) => `    ${propName}: ${renderFieldCall(prop)},`)
    .join("\n");
  const propsLiteral = propsEntries
    ? `defineProps({\n${propsEntries}\n  })`
    : "defineProps({})";
  const slotPaths = Object.keys(spec.dataSlots)
    .map((slotName) => `      ${slotName}: { path: "/${slotName}" },`)
    .join("\n");
  const accessibility = spec.accessibility
    ? `      accessibility: ${JSON.stringify(spec.accessibility)},\n`
    : "";
  const dataSlots = JSON.stringify(spec.dataSlots, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join("\n");
  return `/**
 * Server-side twin of ${spec.id}.view — GENERATED by @renderyes/generate,
 * derived from the client spec. Do not edit by hand: regenerate instead, or
 * this file and the client registration will drift.
 */
import { defineComponent, defineProps, field } from "@renderyes/site-sdk";

export const ${name} = defineComponent({
  id: ${JSON.stringify(spec.id)},
  version: ${JSON.stringify(spec.version ?? "1.0.0")},
  description: ${JSON.stringify(spec.description)},
  props: ${propsLiteral},
  renderer: {
    component: ${JSON.stringify(spec.id)},
    props: {
${accessibility}${slotPaths}
    },
  },
  dataSlots: ${dataSlots},
});
`;
}

/* ------------------------------------------------------------------ */
/* Unified diff construction                                           */
/* ------------------------------------------------------------------ */

export interface Insertion {
  /** Number of old lines before the insertion point (0 = top of file). */
  afterLine: number;
  lines: string[];
}

/**
 * A git-apply-able unified diff for insert-only edits. Written directly from
 * the known insertion points rather than re-derived by a diff algorithm,
 * because an algorithm can legally anchor an inserted line to the wrong copy
 * of a duplicated neighbour — and this patch is applied to a file the host
 * owns, where "legally different" means "inserted into the wrong block".
 */
export function unifiedDiffForFile(
  relativePath: string,
  oldText: string,
  insertions: readonly Insertion[],
): string {
  const oldLines = oldText.split("\n");
  if (oldLines[oldLines.length - 1] === "") oldLines.pop();
  const sorted = [...insertions].sort((a, b) => a.afterLine - b.afterLine);

  const CONTEXT = 3;
  interface Range {
    start: number;
    end: number;
    inserts: Insertion[];
  }
  const ranges: Range[] = [];
  for (const insertion of sorted) {
    const start = Math.max(0, insertion.afterLine - CONTEXT);
    const end = Math.min(oldLines.length, insertion.afterLine + CONTEXT);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      previous.inserts.push(insertion);
    } else {
      ranges.push({ start, end, inserts: [insertion] });
    }
  }

  let offset = 0;
  const hunks: string[] = [];
  for (const range of ranges) {
    const body: string[] = [];
    let inserted = 0;
    for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
      for (const insertion of range.inserts) {
        if (insertion.afterLine === lineIndex) {
          for (const line of insertion.lines) {
            body.push(`+${line}`);
            inserted += 1;
          }
        }
      }
      if (lineIndex < range.end) {
        body.push(` ${oldLines[lineIndex]}`);
      }
    }
    const oldCount = range.end - range.start;
    const header = `@@ -${range.start + 1},${oldCount} +${range.start + 1 + offset},${
      oldCount + inserted
    } @@`;
    hunks.push([header, ...body].join("\n"));
    offset += inserted;
  }

  return [`--- a/${relativePath}`, `+++ b/${relativePath}`, ...hunks].join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* Listed-convention anchors                                            */
/* ------------------------------------------------------------------ */

/** Index of the matching close character, skipping strings, templates, and comments. */
function findBalancedEnd(source: string, openIndex: number): number {
  const open = source[openIndex];
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
    } else if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 1;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  throw new Error(`Unbalanced ${open} at index ${openIndex}`);
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function lastLineMatching(source: string, pattern: RegExp): number {
  const lines = source.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && pattern.test(line)) return index + 1;
  }
  return 0;
}

export interface RegistrationFiles {
  clientPath: string;
  clientSource: string;
  serverPath?: string;
  serverSource?: string;
}

/**
 * Locates a listed host's two registration surfaces: the file with the
 * `defineHostComponent` blocks (client) and the file with the
 * `componentDefinitions` array (server, absent for hosts that publish some
 * other way — the patch then covers the client side only, and says so).
 */
export function findRegistrationFiles(
  hostDir: string,
  files?: HostFile[],
): RegistrationFiles | undefined {
  const hostFiles = files ?? listHostFiles(hostDir);
  const client = hostFiles
    .map((file) => ({
      file,
      count: file.content.split("defineHostComponent(").length - 1,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)[0];
  if (!client) return undefined;
  const server = hostFiles.find(
    (file) =>
      file !== client.file &&
      /\bcomponentDefinitions\b\s*=?\s*\[?/.test(file.content) &&
      file.content.includes("componentDefinitions"),
  );
  return {
    clientPath: client.file.relativePath,
    clientSource: client.file.content,
    ...(server ? { serverPath: server.relativePath, serverSource: server.content } : {}),
  };
}

export interface RegistrationPatchResult {
  patch: string;
  notes: string[];
}

export function buildRegistrationPatch(options: {
  registration: RegistrationFiles;
  spec: GenerateSpec;
  viewFileName: string;
  twinFileName: string;
}): RegistrationPatchResult {
  const { registration, spec } = options;
  const lc = lowerFirst(spec.id);
  const notes: string[] = [];
  const diffs: string[] = [];

  // Client side: import the view module, register it through `ingestViews`
  // (the same public path the folder convention uses), and add it to the
  // components array.
  {
    const source = registration.clientSource;
    const insertions: Insertion[] = [];
    const lastImport = lastLineMatching(source, /^import\b/);
    const importLines = [`import * as ${lc}Module from "./${options.viewFileName}";`];
    if (!source.includes("ingestViews")) {
      importLines.unshift(`import { ingestViews } from "@renderyes/react";`);
    }
    insertions.push({ afterLine: lastImport, lines: importLines });

    const lastBlockStart = source.lastIndexOf("defineHostComponent(");
    if (lastBlockStart === -1) {
      throw new Error(
        `${registration.clientPath} has no defineHostComponent block to anchor on`,
      );
    }
    const openParen = source.indexOf("(", lastBlockStart);
    const closeParen = findBalancedEnd(source, openParen);
    const endOfStatementLine = lineNumberAt(source, closeParen);
    insertions.push({
      afterLine: endOfStatementLine,
      lines: [
        "",
        `const [${lc}Registration] = ingestViews({`,
        `  "./${options.viewFileName}": ${lc}Module,`,
        "});",
      ],
    });

    const arrayMatch = /components\s*[:=]\s*\[/.exec(source);
    if (arrayMatch) {
      const openBracket = source.indexOf("[", arrayMatch.index);
      const closeBracket = findBalancedEnd(source, openBracket);
      const closingLine = lineNumberAt(source, closeBracket);
      const lines = source.split("\n");
      const closingText = lines[closingLine - 1] ?? "";
      const indent = `${closingText.match(/^\s*/)?.[0] ?? ""}  `;
      insertions.push({
        afterLine: closingLine - 1,
        lines: [`${indent}${lc}Registration,`],
      });
    } else {
      notes.push(
        `${registration.clientPath}: no components array found — add ${lc}Registration to your registration list by hand.`,
      );
    }
    diffs.push(unifiedDiffForFile(registration.clientPath, source, insertions));
  }

  // Server side: import the derived twin and add it to componentDefinitions.
  if (registration.serverPath && registration.serverSource) {
    const source = registration.serverSource;
    const insertions: Insertion[] = [];
    const lastImport = lastLineMatching(source, /^import\b/);
    insertions.push({
      afterLine: lastImport,
      lines: [`import { ${lc}Definition } from "./${options.twinFileName}";`],
    });
    const arrayMatch = /componentDefinitions\s*=\s*\[/.exec(source);
    if (arrayMatch) {
      const openBracket = source.indexOf("[", arrayMatch.index);
      const closeBracket = findBalancedEnd(source, openBracket);
      const closingLine = lineNumberAt(source, closeBracket);
      const lines = source.split("\n");
      const closingText = lines[closingLine - 1] ?? "";
      const indent = `${closingText.match(/^\s*/)?.[0] ?? ""}  `;
      insertions.push({
        afterLine: closingLine - 1,
        lines: [`${indent}${lc}Definition,`],
      });
    } else {
      notes.push(
        `${registration.serverPath}: no componentDefinitions array literal found — register ${lc}Definition by hand.`,
      );
    }
    diffs.push(unifiedDiffForFile(registration.serverPath, source, insertions));
  } else {
    notes.push(
      "No server-side componentDefinitions file found — the patch covers the client side only; " +
        "publish the derived twin (see the .component.mjs artifact) through your publish path.",
    );
  }

  return { patch: diffs.join(""), notes };
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

export interface EmittedArtifact {
  name: string;
  content: string;
}

export function renderVerificationReport(options: {
  spec: GenerateSpec;
  slice: CapabilitySlice;
  report: VerificationReport;
  convention: HostConvention;
  styleSystem: string;
  rounds: number;
  notes: readonly string[];
}): string {
  const rows = options.report.checks
    .map(
      (check) =>
        `| ${check.name} | ${check.pass ? "pass" : "FAIL"} | ${check.detail.replace(/\n/g, " ").replace(/\|/g, "\\|")} |`,
    )
    .join("\n");
  const notes =
    options.notes.length > 0
      ? options.notes.map((note) => `- ${note}`).join("\n")
      : "- (none)";
  return `# ${options.spec.id} — verification report

Generated for capability \`${options.slice.capability.id}\` (data type \`${options.slice.dataType.id}\`,
shape \`${options.slice.capability.output.shape}\`) — ${options.rounds} generation round(s),
convention \`${options.convention}\`, style system \`${options.styleSystem}\`.

**Overall: ${options.report.pass ? "PASS" : "FAIL — review before registering"}**

| Check | Result | Detail |
| --- | --- | --- |
${rows}

## Model notes for the reviewer

${notes}

## Before registering

1. Read the component file — the machine proposes, you veto.
2. Open preview.html — the four synthesized states, rendered under the host stylesheet.
3. Register it like hand-written code; the model is never re-called at build.
`;
}

export interface BuildArtifactsOptions {
  envelope: GenerateEnvelope;
  slice: CapabilitySlice;
  convention: HostConvention;
  fileExtension: ".tsx" | ".jsx";
  report: VerificationReport;
  sampleRows: Record<string, unknown>[];
  rounds: number;
  hostDir?: string;
  registrationFiles?: RegistrationFiles;
  styleSystem: string;
  /** The host stylesheet text the preview artifact inlines (corpus.stylesheetText). */
  stylesheetText: string;
}

export function buildArtifacts(options: BuildArtifactsOptions): EmittedArtifact[] {
  const spec = options.envelope.spec;
  assertNoIdCollision(spec, options.slice);

  const viewFileName = `${spec.id}.view${options.fileExtension}`;
  const artifacts: EmittedArtifact[] = [
    { name: viewFileName, content: options.envelope.componentFile },
  ];
  const reportNotes = [...options.envelope.notes];

  // What this file is, and what it is not. `defineView` exports a spec and a
  // default component; a `components` array wants *registrations*, and the
  // publish step refuses the other kind outright. Both are supported and
  // `ingestViews` is what turns one into the other — a fact that lived only in
  // the refusal, which a host reads after the mistake rather than before.
  reportNotes.push(
    options.convention === "listed"
      ? `${viewFileName} declares its contract with defineView, which is not a registration ` +
        `on its own. registration.patch does the pairing — it imports the file and passes it ` +
        `through ingestViews before adding it to your components array.`
      : `${viewFileName} declares its contract with defineView, which is not a registration ` +
        `on its own. Whatever enumerates your views folder turns it into one: ingestViews over ` +
        `a bundler glob in the browser, ingestViewDirectory from @renderyes/react/ingest-fs ` +
        `in Node. Adding it to a components array directly is refused, because a spec carries ` +
        `no renderer.`,
  );

  if (options.convention === "listed") {
    const twinFileName = `${spec.id}.component.mjs`;
    artifacts.push({ name: twinFileName, content: renderTwinModule(spec) });
    const registration =
      options.registrationFiles ??
      (options.hostDir ? findRegistrationFiles(options.hostDir) : undefined);
    if (registration) {
      const { patch, notes } = buildRegistrationPatch({
        registration,
        spec,
        viewFileName,
        twinFileName,
      });
      artifacts.push({ name: "registration.patch", content: patch });
      reportNotes.push(...notes);
    } else {
      reportNotes.push(
        "Listed convention requested but no defineHostComponent registration file was found — no registration.patch emitted.",
      );
    }
  }

  artifacts.push({
    name: "verification-report.md",
    content: renderVerificationReport({
      spec,
      slice: options.slice,
      report: options.report,
      convention: options.convention,
      styleSystem: options.styleSystem,
      rounds: options.rounds,
      notes: reportNotes,
    }),
  });
  // The preview is a standard artifact whenever there is anything to show:
  // on a failing draft even a single rendered state is review evidence, and
  // "look at the states" must never require the reviewer to build a page.
  const renderedStates = options.report.renderedStates ?? {};
  if (Object.keys(renderedStates).length > 0) {
    artifacts.push({
      name: "preview.html",
      content: renderPreviewHtml({
        componentId: spec.id,
        stylesheetText: options.stylesheetText,
        states: renderedStates,
      }),
    });
  }
  artifacts.push({
    name: "sample-rows.json",
    content: `${JSON.stringify(options.sampleRows, null, 2)}\n`,
  });
  return artifacts;
}

export interface BuildInvalidEnvelopeArtifactsOptions {
  /** The id the run asked for — no valid spec exists to read one from. */
  componentId: string;
  slice: CapabilitySlice;
  attempts: readonly {
    round: number;
    envelopeIssues?: string[];
    rawValue?: unknown;
  }[];
}

/**
 * The artifacts for the worst case: every round returned JSON that failed the
 * envelope zod schema, so there is no component file and no spec to emit. The
 * design rule is "always emit, marked failing, for review" — the last live run
 * proved why: its round 2 was ONE key away from valid and was discarded
 * unseen. This emits the raw model output plus the exact zod issues
 * (draft-invalid.json) and a verification report whose envelope-schema check
 * is marked failed.
 */
export function buildInvalidEnvelopeArtifacts(
  options: BuildInvalidEnvelopeArtifactsOptions,
): EmittedArtifact[] {
  const lastAttempt = options.attempts[options.attempts.length - 1];
  const rows = options.attempts
    .map(
      (attempt) =>
        `| round ${attempt.round} envelope-schema | FAIL | ${(attempt.envelopeIssues ?? [])
          .join("; ")
          .replace(/\n/g, " ")
          .replace(/\|/g, "\\|")} |`,
    )
    .join("\n");
  const report = `# ${options.componentId} — verification report

Generated for capability \`${options.slice.capability.id}\` (data type \`${options.slice.dataType.id}\`,
shape \`${options.slice.capability.output.shape}\`) — ${options.attempts.length} generation round(s).

**Overall: FAIL — no round produced a schema-valid envelope; nothing registerable was emitted**

| Check | Result | Detail |
| --- | --- | --- |
${rows}

The raw model output of the final round and the per-round zod issues are in
\`draft-invalid.json\`. Review it: near-misses are often one key from valid,
and the next run can be steered with a better --id, corpus, or prompt.
`;
  const invalidDraft = {
    reason:
      "Every generation round returned JSON that does not match the envelope schema.",
    componentId: options.componentId,
    capabilityId: options.slice.capability.id,
    rounds: options.attempts.map((attempt) => ({
      round: attempt.round,
      envelopeIssues: attempt.envelopeIssues ?? [],
    })),
    lastRawModelOutput: lastAttempt?.rawValue ?? null,
  };
  return [
    { name: "draft-invalid.json", content: `${JSON.stringify(invalidDraft, null, 2)}\n` },
    { name: "verification-report.md", content: report },
  ];
}

/**
 * Writes artifacts into `outDir`, refusing to overwrite anything that exists
 * unless told to — the same posture as `renderyes-catalog`: a tool that
 * silently rewrites the artifact under review is one mistyped path from
 * destroying it.
 */
export function writeArtifacts(
  artifacts: readonly EmittedArtifact[],
  outDir: string,
  overwrite: boolean,
): string[] {
  mkdirSync(outDir, { recursive: true });
  const collisions = artifacts
    .map((artifact) => join(outDir, artifact.name))
    .filter((path) => existsSync(path));
  if (collisions.length > 0 && !overwrite) {
    throw new GenerateRefusalError(
      `Refusing to overwrite existing file(s):\n  ${collisions.join("\n  ")}\nPass --write to overwrite.`,
    );
  }
  const written: string[] = [];
  for (const artifact of artifacts) {
    const path = join(outDir, artifact.name);
    writeFileSync(path, artifact.content);
    written.push(path);
  }
  return written;
}
