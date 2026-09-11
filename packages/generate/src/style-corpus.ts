import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename, dirname, normalize } from "node:path";
import type { SiteManifest } from "@renderyes/site-sdk";
import type { CapabilitySlice } from "./inputs.js";

/**
 * What the model gets shown of the host's styling, and how it is chosen.
 *
 * The corpus exists because "match the host's look" is unenforceable without
 * evidence of what the host's look *is*, and the two failure modes are known:
 * a whole-stylesheet dump blows the budget with utility noise, and a bare
 * tailwind.config (13 lines on one real host) says nothing at all. So assembly is
 * a priority list of the artifacts that actually demonstrate the idiom, cut
 * off at a hard byte budget.
 */
export type StyleSystem = "shadcn" | "tailwind" | "plain-css";

export type HostConvention = "folder" | "listed";

export interface StyleCorpusPiece {
  kind: "bespoke-view" | "theme" | "house-component" | "stylesheet" | "override";
  /** Path relative to the host directory (or absolute for overrides outside it). */
  path: string;
  content: string;
}

export interface StyleCorpus {
  system: StyleSystem;
  pieces: StyleCorpusPiece[];
  /**
   * True when the corpus demonstrates design tokens (a `--iv-starter-*` or
   * other custom-property block, a shadcn/tailwind theme). The verifier's
   * zero-hex gate only applies when this is true — failing a host that has
   * no tokens for using a color would leave it no legal way to have one.
   */
  hasTokens: boolean;
  /** Concatenated stylesheet text, for the class-exists gate in plain-CSS mode. */
  stylesheetText: string;
  totalBytes: number;
}

export const STYLE_CORPUS_BUDGET_BYTES = 25 * 1024;

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".next",
  ".turbo",
  "coverage",
]);
const MAX_SCANNED_FILES = 600;
const MAX_FILE_BYTES = 256 * 1024;
const CODE_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"]);

export interface HostFile {
  path: string;
  relativePath: string;
  content: string;
}

/** Bounded recursive walk. Returns code + css + json files, skipping build output. */
export function listHostFiles(hostDir: string): HostFile[] {
  const files: HostFile[] = [];
  const queue: string[] = [hostDir];
  while (queue.length > 0 && files.length < MAX_SCANNED_FILES) {
    const directory = queue.shift();
    if (!directory) break;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
          queue.push(join(directory, entry.name));
        }
        continue;
      }
      const extension = extname(entry.name);
      if (
        !CODE_EXTENSIONS.has(extension) &&
        extension !== ".css" &&
        entry.name !== "components.json" &&
        !/^tailwind\.config\.(js|cjs|mjs|ts)$/.test(entry.name)
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      let size;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      let content;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      files.push({ path, relativePath: relative(hostDir, path), content });
      if (files.length >= MAX_SCANNED_FILES) break;
    }
  }
  return files;
}

export function detectStyleSystem(hostDir: string): StyleSystem {
  if (existsSync(join(hostDir, "components.json"))) return "shadcn";
  for (const suffix of ["js", "cjs", "mjs", "ts"]) {
    if (existsSync(join(hostDir, `tailwind.config.${suffix}`))) return "tailwind";
  }
  return "plain-css";
}

/**
 * Folder-convention hosts have `*.view.*` files; listed-convention hosts have
 * inline `defineHostComponent` blocks and no views folder. Checked in that
 * order because a host mid-migration (both present) should get the cheap
 * emission — a new file — not a patch.
 */
export function detectConvention(hostDir: string, files?: HostFile[]): HostConvention {
  const hostFiles = files ?? listHostFiles(hostDir);
  const hasViewFiles = hostFiles.some((file) =>
    /\.view\.(tsx|ts|jsx|js|mjs)$/.test(file.relativePath),
  );
  if (hasViewFiles) return "folder";
  const hasListedBlocks = hostFiles.some((file) =>
    file.content.includes("defineHostComponent("),
  );
  return hasListedBlocks ? "listed" : "folder";
}

/** `.tsx` when the host compiles TypeScript, `.jsx` otherwise. */
export function detectFileExtension(hostDir: string): ".tsx" | ".jsx" {
  return existsSync(join(hostDir, "tsconfig.json")) ? ".tsx" : ".jsx";
}

function extractRootTokenBlocks(css: string): string {
  const blocks: string[] = [];
  const pattern = /:root[^{]*\{[^}]*\}/g;
  for (const match of css.match(pattern) ?? []) {
    if (match.includes("--")) blocks.push(match);
  }
  return blocks.join("\n\n");
}

const TRIM_NOTICE =
  "\n/* trimmed by @renderyes/generate to fit the style-corpus budget */";

/** Trims a stylesheet to `budget` bytes at a rule boundary, stating the cut. */
function trimStylesheet(css: string, budget: number): string {
  if (Buffer.byteLength(css, "utf8") <= budget) return css;
  // The notice counts against the budget too — a trim that itself overflows
  // the budget would defeat the reason the budget exists.
  const target = Math.max(0, budget - Buffer.byteLength(TRIM_NOTICE, "utf8"));
  let cut = css.slice(0, target);
  const lastRuleEnd = cut.lastIndexOf("}");
  if (lastRuleEnd > 0) cut = cut.slice(0, lastRuleEnd + 1);
  return `${cut}${TRIM_NOTICE}`;
}

function pieceBytes(piece: StyleCorpusPiece): number {
  return Buffer.byteLength(piece.content, "utf8");
}

/**
 * Data-plumbing markers: a file that creates the view server, publishes the
 * catalog, or hand-writes `defineComponent` twins names every field of every
 * data type without demonstrating one pixel of the house style. The first
 * live acceptance run picked exactly such a file (renderyes-service.mjs)
 * as its "house component"; these are never style evidence.
 */
const PLUMBING_PATTERN = /createViewServer|publishReviewedCatalog|\bdefineComponent\(/;

const COMPONENTS_DIR_PATTERN = /(^|[\\/])components[\\/]/;

/** A presentation file: .jsx/.tsx that actually contains JSX. */
function looksLikePresentation(file: HostFile): boolean {
  return /\.(jsx|tsx)$/.test(file.relativePath) && /<[A-Za-z]/.test(file.content);
}

/**
 * Tier-1 fallback for the --schema/--decisions door, which carries no
 * uiManifest and therefore cannot match registered ids: listed hosts declare
 * their bespoke views inline via `defineHostComponent({ ..., component: X })`.
 * Follow each `component:` identifier to the file that defines it — its
 * relative import when there is one, the registration file itself when the
 * component is defined alongside the block.
 */
export function discoverPilotBespokeViews(files: readonly HostFile[]): HostFile[] {
  const byRelativePath = new Map(files.map((file) => [normalize(file.relativePath), file]));
  const resolveImport = (from: HostFile, specifier: string): HostFile | undefined => {
    const base = normalize(join(dirname(from.relativePath), specifier));
    const candidates = [
      base,
      ...[".jsx", ".tsx", ".js", ".ts", ".mjs"].flatMap((ext) => [
        `${base}${ext}`,
        normalize(join(base, `index${ext}`)),
      ]),
    ];
    for (const candidate of candidates) {
      const hit = byRelativePath.get(candidate);
      if (hit) return hit;
    }
    return undefined;
  };

  const found: HostFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.content.includes("defineHostComponent(")) continue;
    for (const match of file.content.matchAll(/component:\s*([A-Za-z_$][\w$]*)/g)) {
      const name = match[1];
      if (!name) continue;
      const importMatch = new RegExp(
        `import\\s+(?:\\{[^}]*\\b${name}\\b[^}]*\\}|${name})\\s+from\\s+['"](\\.[^'"]+)['"]`,
      ).exec(file.content);
      const target = importMatch?.[1]
        ? resolveImport(file, importMatch[1])
        : new RegExp(`\\b(?:function|const)\\s+${name}\\b`).test(file.content)
          ? file
          : undefined;
      if (target && !seen.has(target.relativePath)) {
        seen.add(target.relativePath);
        found.push(target);
      }
    }
  }
  return found;
}

export interface AssembleStyleCorpusOptions {
  hostDir: string;
  slice: CapabilitySlice;
  uiManifest?: SiteManifest;
  /** Explicit corpus files. Given, they replace automatic assembly entirely. */
  overrideFiles?: readonly string[];
}

export function assembleStyleCorpus(options: AssembleStyleCorpusOptions): StyleCorpus {
  const system = detectStyleSystem(options.hostDir);

  if (options.overrideFiles && options.overrideFiles.length > 0) {
    const pieces: StyleCorpusPiece[] = [];
    let remaining = STYLE_CORPUS_BUDGET_BYTES;
    for (const path of options.overrideFiles) {
      const content = readFileSync(path, "utf8");
      const piece: StyleCorpusPiece = {
        kind: "override",
        path,
        content:
          Buffer.byteLength(content, "utf8") > remaining
            ? trimStylesheet(content, remaining)
            : content,
      };
      if (remaining <= 0) break;
      pieces.push(piece);
      remaining -= pieceBytes(piece);
    }
    return finishCorpus(system, pieces);
  }

  const files = listHostFiles(options.hostDir);
  const pieces: StyleCorpusPiece[] = [];
  let remaining = STYLE_CORPUS_BUDGET_BYTES;

  const push = (piece: StyleCorpusPiece): boolean => {
    if (remaining <= 0) return false;
    const sized =
      pieceBytes(piece) > remaining
        ? { ...piece, content: trimStylesheet(piece.content, remaining) }
        : piece;
    pieces.push(sized);
    remaining -= pieceBytes(sized);
    return remaining > 0;
  };

  const fieldNames = Object.keys(options.slice.dataType.fields).map(
    (path) => path.split(".").pop() ?? path,
  );
  const fieldHits = (file: HostFile): number =>
    fieldNames.filter((name) => file.content.includes(name)).length;

  // 1. Registered bespoke views (≤ 2, whole files): the strongest possible
  //    evidence — real components the host reviewed and registered. Ranked so
  //    a view of the same data type comes first. Without a uiManifest (the
  //    --schema/--decisions door carries none), fall back to the components
  //    that listed hosts register via defineHostComponent — those are
  //    reviewed house views too, just declared differently.
  const registeredIds = options.uiManifest?.components.map((c) => c.id) ?? [];
  let viewFiles = files
    .filter(
      (file) =>
        /\.view\.(tsx|ts|jsx|js|mjs)$/.test(file.relativePath) &&
        registeredIds.some(
          (id) =>
            file.content.includes(`id: "${id}"`) || file.content.includes(`id: '${id}'`),
        ),
    )
    .sort((a, b) => {
      const target = options.slice.dataType.id;
      return Number(b.content.includes(target)) - Number(a.content.includes(target));
    })
    .slice(0, 2);
  if (viewFiles.length === 0) {
    viewFiles = discoverPilotBespokeViews(files)
      .sort((a, b) => fieldHits(b) - fieldHits(a))
      .slice(0, 2);
  }
  for (const file of viewFiles) {
    push({ kind: "bespoke-view", path: file.relativePath, content: file.content });
  }

  // 2. Theme artifact, most-specific first.
  let themed = false;
  const classNamesFile = files.find(
    (file) =>
      CODE_EXTENSIONS.has(extname(file.relativePath)) &&
      /\bclassNames\b\s*[:=]/.test(file.content) &&
      !viewFiles.includes(file),
  );
  if (classNamesFile) {
    themed = push({
      kind: "theme",
      path: classNamesFile.relativePath,
      content: classNamesFile.content,
    });
  } else {
    const tokenCss = files
      .filter((file) => file.relativePath.endsWith(".css"))
      .map((file) => ({ file, tokens: extractRootTokenBlocks(file.content) }))
      .find((entry) => entry.tokens.length > 0);
    if (tokenCss) {
      themed = push({
        kind: "theme",
        path: tokenCss.file.relativePath,
        content: tokenCss.tokens,
      });
    } else if (system === "shadcn") {
      const componentsJson = files.find(
        (file) => basename(file.relativePath) === "components.json",
      );
      const uiFile = files.find(
        (file) =>
          /(^|\/)ui\//.test(file.relativePath) &&
          CODE_EXTENSIONS.has(extname(file.relativePath)),
      );
      if (componentsJson) {
        themed = push({
          kind: "theme",
          path: componentsJson.relativePath,
          content: componentsJson.content,
        });
      }
      if (uiFile) {
        themed =
          push({ kind: "theme", path: uiFile.relativePath, content: uiFile.content }) ||
          themed;
      }
    } else if (system === "tailwind") {
      const config = files.find((file) =>
        /^tailwind\.config\.(js|cjs|mjs|ts)$/.test(basename(file.relativePath)),
      );
      if (config) {
        themed = push({
          kind: "theme",
          path: config.relativePath,
          content: config.content,
        });
      }
    }
  }
  void themed;

  // 3. One house component that renders the same data type — recognized by it
  //    naming the type's fields, since a host component has no reason to know
  //    the catalog's dataTypeId. Field-name hits alone favour data plumbing
  //    (a service file names every field), so plumbing files are excluded,
  //    candidates are confined to the components directory when the host has
  //    one, and files that actually contain JSX outrank the rest.
  const hasComponentsDir = files.some(
    (file) =>
      COMPONENTS_DIR_PATTERN.test(file.relativePath) &&
      CODE_EXTENSIONS.has(extname(file.relativePath)),
  );
  const houseComponent = files
    .filter(
      (file) =>
        CODE_EXTENSIONS.has(extname(file.relativePath)) &&
        !pieces.some((piece) => piece.path === file.relativePath) &&
        !/\.view\./.test(file.relativePath) &&
        !PLUMBING_PATTERN.test(file.content) &&
        (!hasComponentsDir || COMPONENTS_DIR_PATTERN.test(file.relativePath)),
    )
    .map((file) => ({ file, hits: fieldHits(file) }))
    .filter((entry) => entry.hits >= 2)
    .sort(
      (a, b) =>
        Number(looksLikePresentation(b.file)) - Number(looksLikePresentation(a.file)) ||
        b.hits - a.hits,
    )[0];
  if (houseComponent) {
    push({
      kind: "house-component",
      path: houseComponent.file.relativePath,
      content: houseComponent.file.content,
    });
  }

  // 4. Trimmed stylesheet, filling whatever budget is left.
  const stylesheet = files
    .filter((file) => file.relativePath.endsWith(".css"))
    .sort((a, b) => b.content.length - a.content.length)[0];
  if (stylesheet && remaining > 0) {
    push({
      kind: "stylesheet",
      path: stylesheet.relativePath,
      content: trimStylesheet(stylesheet.content, remaining),
    });
  }

  return finishCorpus(system, pieces);
}

function finishCorpus(system: StyleSystem, pieces: StyleCorpusPiece[]): StyleCorpus {
  const stylesheetText = pieces
    .filter((piece) => piece.path.endsWith(".css") || piece.kind === "stylesheet")
    .map((piece) => piece.content)
    .join("\n");
  const allText = pieces.map((piece) => piece.content).join("\n");
  const hasTokens =
    system !== "plain-css" ||
    allText.includes("--iv-starter-") ||
    /:root[^{]*\{[^}]*--/.test(allText) ||
    /\bclassNames\b\s*[:=]/.test(allText);
  return {
    system,
    pieces,
    hasTokens,
    stylesheetText,
    totalBytes: pieces.reduce((sum, piece) => sum + pieceBytes(piece), 0),
  };
}
