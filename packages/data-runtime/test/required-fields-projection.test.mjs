import assert from "node:assert/strict";
import test from "node:test";
import { applyValidatedQuery } from "../dist/query.js";
import { executeDataRequest } from "../dist/index.js";
import { hashCapabilityCatalog } from "@renderyes/capability-catalog";

/**
 * A field the host declared required survives the plan's projection.
 *
 * `requiredOutputFields` in the GraphQL decisions forces a field into the
 * *fetch* selection, and that half always worked. Nothing carried it further,
 * so a plan that narrowed `query.project` dropped the field one layer later —
 * fetched, then discarded before the component saw it.
 *
 * Found on a live install: a component wrapping `next/image` needs intrinsic
 * width and height, they were approved and required, and `next/image` threw
 * because the projection had removed them. The host's only lever for "this
 * component cannot render without this field" did not reach the component.
 *
 * The projection now unions them in, which is what the fetch selection has
 * always done with the same list: the planner asked for a subset, the host said
 * these are never optional, and the union satisfies both.
 */

const rows = [
  { id: 1, title: "A", meta: { image: { url: "/a.png", width: 800, height: 600 } } },
];
const required = ["meta.image.url", "meta.image.width", "meta.image.height"];

test("a narrowed projection drops what nothing declared required", () => {
  const projected = applyValidatedQuery(rows, { project: ["id", "title"] });
  assert.deepEqual(projected, [{ id: 1, title: "A" }]);
});

test("a declared required field survives a narrower projection", () => {
  const projected = applyValidatedQuery(rows, { project: ["id", "title"] }, required);
  assert.deepEqual(projected, [
    { id: 1, title: "A", meta: { image: { url: "/a.png", width: 800, height: 600 } } },
  ]);
});

test("a projection that already asked for the field is unchanged", () => {
  const project = ["id", "meta.image.url"];
  assert.deepEqual(
    applyValidatedQuery(rows, { project }, ["meta.image.url"]),
    applyValidatedQuery(rows, { project }),
  );
});

test("no projection at all is left alone", () => {
  assert.deepEqual(applyValidatedQuery(rows, {}, required), rows);
});


/**
 * The wiring, not just the helper.
 *
 * `applyValidatedQuery` honouring the argument proves nothing if the executor
 * never passes it. That exact gap let an earlier mutation through, so this
 * drives the whole path: a capability declaring `supports.requiredFields`, a
 * plan projecting around them, and the fields still present in the result.
 */
const article = {
  id: 1,
  title: "A",
  meta: { image: { url: "/a.png", width: 800, height: 600 } },
};

const catalog = {
  schemaVersion: "1.0",
  id: "required-fields",
  version: "1.0.0",
  description: "Projection must keep what the host declared required.",
  dataTypes: [
    {
      id: "article",
      version: "1.0.0",
      description: "One article.",
      schema: { type: "object" },
      fields: {
        id: { label: "Id", semanticType: "identifier" },
        title: { label: "Title", semanticType: "text" },
        "meta.image.url": { label: "Image", semanticType: "image-url" },
        "meta.image.width": { label: "Width", semanticType: "quantity" },
        "meta.image.height": { label: "Height", semanticType: "quantity" },
      },
    },
  ],
  sources: [{ id: "cms", label: "CMS" }],
  capabilities: [
    {
      id: "articles.list",
      version: "1.0.0",
      purpose: "List articles for a reader.",
      kind: "query",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "array" },
      output: { dataTypeId: "article", shape: "collection" },
      requiredSessionKeys: [],
      sourceIds: ["cms"],
      supports: {
        requiredFields: ["meta.image.url", "meta.image.width", "meta.image.height"],
      },
      policy: { authentication: "public", maximumRows: 20, timeoutMs: 100 },
    },
  ],
  relationships: [],
};

function runExecutor(query) {
  return executeDataRequest({
    request: { requestId: "r1", capabilityId: "articles.list", params: {}, query },
    dataCatalog: {
      id: catalog.id,
      version: catalog.version,
      hash: hashCapabilityCatalog(catalog),
    },
    catalog,
    runtimes: new Map([
      [
        "articles.list",
        {
          capabilityId: "articles.list",
          inputSchema: { parse: (value) => value },
          outputSchema: { parse: (value) => value },
          async execute() {
            return {
              ok: true,
              data: [article],
              provenance: {
                sources: [{ sourceId: "cms" }],
                freshness: { asOf: "2026-09-01T00:00:00Z" },
              },
            };
          },
        },
      ],
    ]),
    session: {},
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
  });
}

test("the executor passes the capability's required fields to the projection", async () => {
  const result = await runExecutor({ project: ["id", "title"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [article]);
});
