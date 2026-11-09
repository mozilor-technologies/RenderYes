/**
 * Reads a website address out of a visitor's text with deterministic code.
 *
 * Visitors paste: a developer's note, a forwarded email. The text often names
 * the visitor's own site ("Store is candlecraft.example on Shopify"), and a
 * site's handover ("Continue to setup") is more useful when it carries it. The
 * address is read here, by code, and never by a model: the model may read the
 * prompt to plan, but nothing it writes is taken as this value (see "Pasted
 * text, prompt length, and values read from a prompt" in `docs/PRODUCT.md`).
 *
 * What comes out is deliberately narrow:
 *
 * - The origin only, `https://host[:port]`. A path, query or fragment can carry
 *   anything (a session token, a reset link, text written to steer a model),
 *   so none of it is kept.
 * - `http:` or `https:` only. `javascript:`, `data:`, `file:` and every other
 *   scheme yield nothing.
 * - No credentials, and no email address: a token with an `@` in it is
 *   skipped, whether it is `ravi@candlecraft.example` or
 *   `https://user:pass@host`.
 * - No IP literal, `localhost` or single-label host. A visitor's website has a
 *   name.
 * - More than one distinct site named means none is returned. The code does
 *   not guess which one the visitor meant. A host with and without `www.`, or
 *   with `http:` and `https:`, is one site, reported as first written.
 *
 * A bare domain (`candlecraft.example`) is read as `https:`. Reserved names
 * such as `.example` and `.test` are accepted on purpose: there is no TLD
 * allowlist, because a site's own name is not ours to vet, and a stale list
 * would reject real addresses. The checks are structural instead.
 *
 * Pure and dependency-free so the server and a browser run the same code.
 */

/**
 * Values read out of a visitor's prompt by deterministic code, as a compose
 * result and its stream's `RUN_FINISHED` carry them. Never written by a model.
 */
export interface ExtractedValues {
  /** The one website the prompt names, as an origin: `https://candlecraft.example`. */
  websiteAddress?: string;
}

/** Options for `extractWebsiteAddress`. */
export interface WebsiteAddressOptions {
  /**
   * Hosts that are never the visitor's own site, typically the publisher's own
   * domain ("I read on cookieyes.com that…"). Matched exactly, ignoring case
   * and a leading `www.`; a subdomain is a different site and is not ignored.
   */
  ignoreHosts?: readonly string[];
}

/**
 * The one website address the text names, as a normalised origin, or
 * undefined when it names none, or more than one.
 */
export function extractWebsiteAddress(
  text: string,
  options: WebsiteAddressOptions = {},
): string | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const ignored = new Set((options.ignoreHosts ?? []).map(comparableHost));
  // Keyed by host without `www.` and by port, so "candlecraft.example" and
  // "https://www.candlecraft.example/shop" in one note are one site, reported
  // as written first.
  const found = new Map<string, string>();
  for (const token of text.split(/\s+/)) {
    const origin = originOfToken(token);
    if (!origin) continue;
    const url = new URL(origin);
    const host = comparableHost(url.hostname);
    if (ignored.has(host)) continue;
    const site = `${host}:${url.port}`;
    if (!found.has(site)) found.set(site, origin);
    if (found.size > 1) return undefined;
  }
  return found.values().next().value;
}

/**
 * Validates one value that should already be a website address, returning its
 * normalised origin or undefined. For a value that crossed a wire: a client
 * re-checks what a server sent rather than trusting the transport.
 */
export function normalizeWebsiteAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || /\s/.test(value)) return undefined;
  return originOfToken(value);
}

/** Wrapping a prompt puts around an address: quotes, brackets, markdown. */
const LEADING_WRAPPERS = /^[\s"'`“”‘’<([{*_]+/u;
const TRAILING_WRAPPERS = /[\s"'`“”‘’>)\]}*_.,;:!?]+$/u;
const POSSESSIVE = /['’]s$/iu;
/** A scheme-qualified address anywhere in a token, such as inside `[site](https://…)`. */
const SCHEMED = /([a-z][a-z0-9+.-]*):\/\//i;
/** A token that opens with a scheme and no `//`: `javascript:…`, `mailto:…`, `data:…`. */
const SCHEME_ONLY = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
/** A bare domain, optionally with a port and a path: `candlecraft.example/shop`. */
const BARE_DOMAIN =
  /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)+(?::\d{1,5})?(?:[/?#]\S*)?$/u;
/**
 * File extensions that read as a top-level domain in prose: `Node.js`,
 * `index.html`, `config.json`. Applied only to bare tokens; an address written
 * with `https://` is taken as written.
 */
const FILE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "json",
  "html",
  "htm",
  "css",
  "scss",
  "md",
  "txt",
  "csv",
  "xml",
  "yml",
  "yaml",
  "toml",
  "ini",
  "env",
  "log",
  "py",
  "rb",
  "php",
  "java",
  "go",
  "rs",
  "sh",
  "sql",
  "lock",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "ico",
  "mp4",
  "mp3",
  "zip",
  "exe",
]);
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

function originOfToken(raw: string): string | undefined {
  if (raw.includes("@")) return undefined;
  let token = raw.replace(LEADING_WRAPPERS, "").replace(TRAILING_WRAPPERS, "");
  token = token.replace(POSSESSIVE, "").replace(TRAILING_WRAPPERS, "");
  if (!token) return undefined;

  const schemed = SCHEMED.exec(token);
  let candidate: string;
  let bare = false;
  if (schemed) {
    const scheme = schemed[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") return undefined;
    // Anything before the scheme (`[site](`, `href=`) is wrapping, not address.
    candidate = token.slice(schemed.index).replace(TRAILING_WRAPPERS, "");
  } else {
    if (SCHEME_ONLY.test(token)) return undefined;
    if (!BARE_DOMAIN.test(token)) return undefined;
    candidate = `https://${token}`;
    bare = true;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  const host = url.hostname;
  if (!acceptableHost(host)) return undefined;
  if (bare && !plausibleBareTld(token)) return undefined;
  return url.origin;
}

function acceptableHost(host: string): boolean {
  if (!host || host.length > MAX_HOST_LENGTH) return false;
  // An IPv6 literal keeps its brackets in `hostname`.
  if (host.startsWith("[")) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (labels.some((label) => label.length === 0 || label.length > MAX_LABEL_LENGTH))
    return false;
  const tld = labels[labels.length - 1];
  // The WHATWG parser reads a host whose last label is numeric as IPv4
  // (`127.1`, `0x7f.0.0.1` become `127.0.0.1`); every such host ends in digits.
  if (/^\d+$/.test(tld)) return false;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return false;
  if (tld === "localhost" || tld === "local") return false;
  return true;
}

/**
 * Prose puts dots between words a domain never would: `it.Then`, `Node.js`.
 * A bare token's last label must be written in one case, as people write
 * domains (`candlecraft.example`, `CANDLECRAFT.EXAMPLE`), and must not be a
 * file extension.
 */
function plausibleBareTld(token: string): boolean {
  const host = token.split(/[:/?#]/)[0];
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (tld !== tld.toLowerCase() && tld !== tld.toUpperCase()) return false;
  return !FILE_EXTENSIONS.has(tld.toLowerCase());
}

function comparableHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}
