import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { listViewFiles } from "../src/ingest-fs.js";

/**
 * `ingestViewDirectory` imports the view files itself, and that import resolves
 * under this package rather than under the caller. A host whose build step can
 * load `.view.tsx` — it runs under `tsx`, `vite-node`, a bundler — may still be
 * unable to make our import do the same: with no `"type": "module"` in the
 * nearest manifest (the default state of a Vite app) Node infers CommonJS for
 * `.tsx`, `require()`s an ESM-only package, and fails on the package. The folder
 * was readable and unusable, and the only remedy was editing the host's tree.
 *
 * `listViewFiles` is the seam that removes the dependency on our loader.
 */
describe("listViewFiles", () => {
  const directory = mkdtempSync(join(tmpdir(), "renderyes-views-"));
  writeFileSync(join(directory, "ticket-table.view.tsx"), "");
  writeFileSync(join(directory, "alpha.view.tsx"), "");
  writeFileSync(join(directory, "helpers.ts"), "");
  writeFileSync(join(directory, "README.md"), "");

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("returns the view files, sorted, and nothing else", () => {
    const files = listViewFiles(pathToFileURL(`${directory}/`));

    expect(files.map((file) => file.href.split("/").pop())).toEqual([
      "alpha.view.tsx",
      "ticket-table.view.tsx",
    ]);
  });

  it("accepts a plain path as well as a URL", () => {
    expect(listViewFiles(directory)).toHaveLength(2);
  });

  it("honours a custom pattern", () => {
    expect(listViewFiles(directory, { pattern: /\.ts$/ }).map((file) =>
      file.href.split("/").pop(),
    )).toEqual(["helpers.ts"]);
  });

  it("names the folder when it cannot be read", () => {
    expect(() => listViewFiles(join(directory, "missing"))).toThrow(
      /Could not read the views directory/,
    );
  });
});
