/**
 * The Node-only entry point: `@renderyes/server/node`.
 *
 * Split out so the main entry stays runtime-agnostic. Everything here imports
 * `node:*`, and a Cloudflare Workers or Deno host that resolved it would either
 * fail to build or silently pull Node's ambient globals into their type
 * checking.
 */
export { toNodeHandler } from "./http-node.js";
export { createFileCatalogStore } from "./catalogs-fs.js";
export { createFileViewStore } from "./views-fs.js";
