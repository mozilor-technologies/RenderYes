#!/usr/bin/env node
/**
 * Thin launcher. Everything it does is in `src/cli.ts`, because a bin file is
 * unreachable by the test suite and the type checker — logic that lives here
 * is logic nothing verifies.
 */
import { runCli } from "../dist/cli.js";

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
