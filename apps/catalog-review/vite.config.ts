import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // The review UI publishes an approved catalog to the host's own RenderYes
    // service rather than only downloading files. Proxying keeps that a
    // same-origin request, so the host needs no CORS allowance for this app.
    //
    // 4173 is a leftover from `apps/demo-finance-site`, which served on that
    // port and no longer exists. Point this at wherever your host actually
    // listens — `@renderyes/server` hosts commonly use 4200 — or set
    // RENDERYES_HOST_URL.
    proxy: {
      "/api": process.env.RENDERYES_HOST_URL ?? "http://127.0.0.1:4173",
    },
  },
});
