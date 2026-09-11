/**
 * Adapts the fetch-standard handler to `node:http`.
 *
 * Separate entry point (`@renderyes/server/node`) because this is the one
 * file in the package that imports Node types. Keeping it out of the main entry
 * means a Workers or Deno host never pulls `@types/node` in, and never sees
 * Node's ambient globals widen types it does not have.
 *
 * Deliberately not a framework adapter. Express, Fastify, and Koa all accept a
 * `(req, res)` function, so this covers them too via
 * `app.use(toNodeHandler(handler))` — but only if the framework's own body
 * parser has not already consumed the stream. See `readBody`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Builds a fetch `Request` from a node:http request.
 *
 * The URL needs an absolute base because `Request` requires one, and
 * `request.url` from node:http is path-only. The `Host` header supplies it —
 * and is safe here because nothing downstream authenticates or redirects on
 * the basis of it; the handler reads only `pathname` and `searchParams`.
 */
function toFetchRequest(request: IncomingMessage): Request {
  const host = request.headers.host ?? "localhost";
  const scheme = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
  const url = new URL(request.url ?? "/", `${scheme}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    // `set-cookie` is the only header Node gives as an array. Joining the rest
    // with ", " is what the HTTP spec says a repeated header means.
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }

  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(url, {
    method,
    headers,
    ...(hasBody
      ? {
          // Streamed rather than buffered, so the handler's own size cap can
          // reject an oversized body without this adapter having first read all
          // of it into memory — which would make that cap decorative.
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              request.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
              request.on("end", () => controller.close());
              request.on("error", (error) => controller.error(error));
            },
            cancel() {
              request.destroy();
            },
          }),
          // Required by undici whenever `body` is a stream, and has no meaning
          // beyond that here.
          duplex: "half",
        }
      : {}),
  } as RequestInit);
}

/**
 * Wraps a fetch handler as a `node:http` request listener.
 *
 * ```ts
 * import { createServer } from "node:http";
 * createServer(toNodeHandler(createViewHttpHandler(server, { requireAdmin }))).listen(4200);
 * ```
 *
 * Mounting under a framework that has already parsed the body (Express with
 * `express.json()`) will hang: the stream this reads from is empty by then, so
 * the handler sees no body. Mount this *before* any body parser, or scope the
 * parser to other paths.
 */
export function toNodeHandler(
  handler: (request: Request) => Promise<Response>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void (async () => {
      try {
        const fetchResponse = await handler(toFetchRequest(request));

        const headers: Record<string, string | string[]> = {};
        fetchResponse.headers.forEach((value, key) => {
          headers[key] = value;
        });
        // `Headers.forEach` collapses repeated `set-cookie` into one
        // comma-joined string, which browsers then parse as a single malformed
        // cookie. `getSetCookie` is the only way back to the individual values.
        const setCookie = fetchResponse.headers.getSetCookie?.() ?? [];
        if (setCookie.length > 0) headers["set-cookie"] = setCookie;

        response.writeHead(fetchResponse.status, headers);
        if (fetchResponse.body) {
          const reader = fetchResponse.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            response.write(value);
          }
        }
        response.end();
      } catch (error) {
        // Reaching here means the handler itself threw, which it is written not
        // to — every expected failure already becomes a Response. So this is a
        // real fault, and the body says nothing about it.
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        }
        response.end(JSON.stringify({ ok: false, error: "Internal error." }));
        console.error("RenderYes handler failed:", error);
      }
    })();
  };
}
