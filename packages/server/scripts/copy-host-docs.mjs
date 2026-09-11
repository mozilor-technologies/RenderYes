/**
 * Copies the host guides into the packages that need them, at pack time.
 *
 * `docs/` lives at the repo root and belongs to no package, so `files`
 * arrays — which only reach inside a package — could never include it. A
 * registry consumer got READMEs and `.d.ts` and never saw the guides, while the
 * READMEs told them to read guides "in the source repository". For a private
 * registry that is nearly true and still unhelpful.
 *
 * Run from `prepack`, not `prepare`: this must happen when the maintainer packs,
 * never on a consumer's install. A library has no business running scripts on
 * someone else's machine.
 *
 * Two failure modes this guards, both quiet otherwise: a doc gets renamed and
 * the copy ships nothing, and the quiet one: `files: ["docs"]` with an empty or
 * stale `docs/` ships a package whose own README points at documentation that is
 * not in it.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "../../..");
const source = resolve(workspace, "docs");

const FORGE_DOCS_URL =
  "https://github.com/mozilor-technologies/RenderYes/blob/main/docs/";

/**
 * Guides no package ships, on purpose: `ARCHITECTURE.md` is design rationale
 * and `PRODUCT.md` states what the product refuses to be. Rewriting a link to
 * one into an absolute URL would let a shipped guide send an integrating host
 * to a maintainer document, so these fail the copy instead.
 */
const REPOSITORY_ONLY_DOCS = ["ARCHITECTURE.md", "PRODUCT.md"];

/**
 * Which guides each package ships, decided by what someone installing *that*
 * package has to do — not by completeness.
 *
 * A frontend developer installs `react` and has to register components; they do
 * not need the backend wiring guide. They do need a reference for what they
 * mount, so `API.md` — largely `ViewProvider` config and the `useViewCompose`
 * return shape — and `TROUBLESHOOTING.md`, whose symptoms include blank charts
 * and a component the planner never picks, are in both sets.
 *
 * A backend developer installs `server` and needs all of it.
 * `capability-catalog` is installed for its CLI and its compile step, so it
 * carries the catalog-authoring guide and the example schema those examples are
 * written against.
 *
 * `EXAMPLE_HOST.md` is in every set because every guide's examples are written
 * against it, and a guide whose example host is undefined in the same tarball
 * sends the reader somewhere they cannot reach.
 *
 * Deliberately left out of every set: ARCHITECTURE.md, which is design
 * rationale rather than integration instruction, and PRODUCT.md, which states
 * what the product is and refuses to be — repository context, not something a
 * host needs open while wiring the service in.
 */
export const PACKAGE_HOST_DOCS = {
  server: [
    "QUICKSTART.md",
    "INTEGRATION.md",
    "AUTHORING_VIEWS.md",
    "CATALOG.md",
    "BUILD_A_HOST.md",
    "API.md",
    "TROUBLESHOOTING.md",
    "HOST_INTEGRATION_STEPS.md",
    "EXAMPLE_HOST.md",
  ],
  react: [
    "AUTHORING_VIEWS.md",
    "API.md",
    "TROUBLESHOOTING.md",
    "HOST_INTEGRATION_STEPS.md",
    "EXAMPLE_HOST.md",
  ],
  "capability-catalog": ["CATALOG.md", "EXAMPLE_HOST.md"],
};

/** Back-compat for callers that only ever meant the server's set. */
export const SHIPPED_HOST_DOCS = PACKAGE_HOST_DOCS.server;

/**
 * Links to a doc outside the shipped set, which would dangle in the tarball.
 *
 * An absolute URL is never dangling — it resolves from anywhere, which is the
 * point of writing one. A shipped guide that has to reach a repository-only
 * file (CONTRIBUTING.md, say) links to it on the forge rather than by a
 * relative path that only works inside a clone.
 */
export function danglingDocLinks(markdown, shipped = SHIPPED_HOST_DOCS) {
  const linked = [...markdown.matchAll(/\]\(([^)]+\.md)[^)]*\)/g)].map((match) => match[1]);
  return linked.filter((href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
    const name = href.replace(/^\.\//, "");
    return !shipped.includes(name);
  });
}

/**
 * A guide is written once and shipped to packages whose sets differ, so the same
 * relative link is correct in one tarball and dangling in another: `API.md`
 * sits beside `INTEGRATION.md` in `server` and alone in `react`.
 *
 * The source keeps the relative link — right in a clone, and right in the one
 * tarball carrying both files — and the copy for a package missing the target
 * gets an absolute URL. An absolute URL resolves from anywhere at the cost of
 * needing a network, which is why it is the fallback and not the default.
 */
export function rewriteCrossSetLinks(markdown, shipped) {
  const rewritten = [];
  const next = markdown.replace(
    /\]\((?!\w+:)([^)#\s]+\.md)([^)]*)\)/g,
    (whole, href, fragment) => {
      const name = href.replace(/^\.\//, "");
      if (shipped.includes(name)) return whole;
      // Only same-directory names can be rewritten: prefixing a path that
      // climbs out of docs/ would produce a URL that resolves nowhere.
      if (name.includes("/")) return whole;
      // A repository-only doc is left relative so the dangling check rejects it.
      if (REPOSITORY_ONLY_DOCS.includes(name)) return whole;
      rewritten.push(name);
      return `](${FORGE_DOCS_URL}${name}${fragment})`;
    },
  );
  return { markdown: next, rewritten };
}

export async function copyHostDocs(packageName) {
  const shipped = PACKAGE_HOST_DOCS[packageName];
  if (!shipped) throw new Error(`No host-doc set is declared for "${packageName}".`);
  const target = resolve(workspace, "packages", packageName, "docs");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const name of shipped) {
    const from = resolve(source, name);
    // Read rather than copy: the bytes shipped are the rewritten ones, and the
    // link check has to run on exactly those.
    const original = await readFile(from, "utf8");
    const { markdown, rewritten } = rewriteCrossSetLinks(original, shipped);
    for (const href of rewritten) {
      const exists = await readFile(resolve(source, href), "utf8").then(
        () => true,
        () => false,
      );
      if (!exists) {
        throw new Error(
          `${name} links to ${href}, which is neither in @renderyes/${packageName}'s set nor in ` +
            "docs/. A shipped doc must not point at a file that does not exist.",
        );
      }
    }
    const dangling = danglingDocLinks(markdown, shipped);
    if (dangling.length > 0) {
      throw new Error(
        `${name} still links to ${dangling.join(", ")} after rewriting, which ` +
          `@renderyes/${packageName} does not ship.`,
      );
    }
    await writeFile(resolve(target, name), markdown);
  }
  return shipped.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const packageName = process.argv[2] ?? "server";
  const count = await copyHostDocs(packageName);
  process.stdout.write(`Copied ${count} host guides into packages/${packageName}/docs/\n`);
}
