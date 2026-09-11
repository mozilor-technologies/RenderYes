import { defineConfig } from "vitest/config";

// Explicit local config so this package does not inherit the pre-consolidation
// root vitest.config.ts still present in the parent directory, which pins an
// older vite, forces jsdom, and requires a test/setup.ts that does not exist here.
export default defineConfig({
  test: {
    // `.tsx` is included because the browser-journey tests render real
    // components: the defects they exist to catch (a second submission
    // throwing, an unstable prop looping, a shadow root appearing or not) are
    // only observable once something is actually mounted.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Needed by @testing-library/react. The registration tests are pure and
    // do not care, but a DOM costs little and one environment beats per-file
    // overrides.
    environment: "jsdom",
  },
});
