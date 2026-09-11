import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ingestViews } from "./define-view.js";
import type { RegisteredHostComponent } from "./define-host-component.js";

/**
 * Ingesting a views folder outside the browser.
 *
 * A host has two places that need to know which components exist: the app,
 * which renders them, and the build step that publishes the UI catalog to the
 * RenderYes server. The app enumerates the folder with its bundler
 * (`import.meta.glob` under Vite); a build script has no bundler and has to walk
 * the filesystem. Without this, one of the two ends up hand-listing every
 * component — and a folder convention where you still maintain a list isn't a
 * folder convention.
 *
 * A separate entry point (`@renderyes/react/ingest-fs`) because it imports
 * `node:fs`, which must never reach a browser bundle. Nothing in the main entry
 * point references this file, so a bundler following the `.` export never sees
 * it. The cost is that `@types/node` is now in this package's compile, which
 * widens the ambient types for the browser code too — if a `node:` API ever
 * appears in a file under `.`, TypeScript will no longer be the thing that
 * catches it.
 *
 * The importing runtime has to be able to load whatever the files are written
 * in — for `.view.tsx` that means running the script under `tsx`, `vite-node`,
 * or an equivalent loader. It fails loudly rather than skipping a file it can't
 * import, for the same reason `ingestViews` does: a component silently missing
 * from the catalog looks exactly like a planner that chose not to use it.
 */

const DEFAULT_PATTERN = /\.view\.(tsx|ts|jsx|js|mjs)$/;

export interface IngestViewDirectoryOptions {
  /** Which filenames count as view files. Defaults to `*.view.{tsx,ts,jsx,js,mjs}`. */
  pattern?: RegExp;
}

/**
 * The folder's view files, sorted, without importing any of them.
 *
 * `ingestViewDirectory` performs its own `import()`, and that import runs under
 * *this package's* resolution, not the caller's. A host whose build step can
 * load `.view.tsx` — because it runs under `tsx`, `vite-node`, a bundler, or a
 * registered loader — may still be unable to make this package's import do the
 * same, and then a folder it can read is a folder it cannot ingest.
 *
 * So the enumeration is available on its own. A caller imports the files
 * whatever way already works for it and passes the record to `ingestViews`,
 * which is the same seam the browser path uses with `import.meta.glob`:
 *
 * ```ts
 * const files = listViewFiles(new URL("./views/", import.meta.url));
 * const modules = Object.fromEntries(
 *   await Promise.all(files.map(async (file) => [file.href, await import(file.href)])),
 * );
 * const components = ingestViews(modules);
 * ```
 */
export function listViewFiles(
  directory: string | URL,
  options: IngestViewDirectoryOptions = {},
): URL[] {
  const pattern = options.pattern ?? DEFAULT_PATTERN;
  const directoryUrl = typeof directory === "string" ? pathToFileURL(`${directory}/`) : directory;

  let entries: string[];
  try {
    entries = readdirSync(directoryUrl);
  } catch (cause) {
    throw new Error(
      `Could not read the views directory ${directoryUrl.href}. ` +
        "Point it at the folder holding the `*.view.tsx` files.",
      { cause },
    );
  }

  return entries
    .filter((entry) => pattern.test(entry))
    .sort()
    .map((entry) => new URL(entry, directoryUrl));
}

export async function ingestViewDirectory(
  directory: string | URL,
  options: IngestViewDirectoryOptions = {},
): Promise<RegisteredHostComponent[]> {
  const files = listViewFiles(directory, options);
  const modules: Record<string, unknown> = {};
  for (const fileUrl of files) {
    const file = fileUrl.href.slice(fileUrl.href.lastIndexOf("/") + 1);
    try {
      modules[file] = await import(fileUrl.href);
    } catch (cause) {
      throw new Error(importFailureMessage(file, cause), { cause });
    }
  }

  return ingestViews(modules);
}

/**
 * Node reports the CommonJS case in two ways, neither of which names the cause.
 * A `.tsx` file under a package with no `"type": "module"` — the default state
 * of a Vite app — is inferred as CommonJS, so the `import()` above becomes a
 * `require()` of an ESM-only package and fails on the *package*, not on the view
 * file. Advising a loader there is worse than saying nothing: the host is
 * usually already running one, so the advice reads as "what you are doing is not
 * what you are doing" and sends them to look in the wrong place.
 */
function importFailureMessage(file: string, cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code;
  const detail = cause instanceof Error ? cause.message : String(cause);
  const looksCommonJs =
    code === "ERR_UNKNOWN_FILE_EXTENSION" ||
    code === "ERR_REQUIRE_ESM" ||
    /No "exports" main defined|require\(\) of ES Module/i.test(detail);

  if (looksCommonJs) {
    return (
      `Could not import the view file ${file}: Node resolved it as CommonJS. ` +
      "Add `{\"type\": \"module\"}` to the nearest package.json above the views folder " +
      "(a Vite app has none by default, so `.tsx` there is inferred as CommonJS), or " +
      "enumerate with `listViewFiles` and import the files yourself. Running under a " +
      "loader such as `tsx` does not fix this on its own — the resolution is decided " +
      "by the package manifest, not by the loader."
    );
  }
  return (
    `Could not import the view file ${file}. If it is TypeScript or JSX, run this ` +
    "script under a loader that handles it (for example `tsx`)."
  );
}
