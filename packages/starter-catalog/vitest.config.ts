import { defineConfig } from "vitest/config";

// Explicit local config for the same reason as @renderyes/react: the
// pre-consolidation root vitest.config.ts pins an older vite and requires a
// setup file that does not exist here.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "jsdom",
  },
});
