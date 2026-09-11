import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";

/**
 * One flat config for the whole workspace, rather than per-package configs.
 *
 * Deliberately narrow: this is the first lint setup here, so it enforces the
 * rules that catch real defects and leaves style to Prettier. A large rule
 * set landed all at once would produce thousands of findings nobody triages,
 * which is how lint gets disabled.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      // The documentation site is not a workspace package and has its own
      // toolchain — linting it from here would check Docusaurus's React against
      // the libraries' rules. `website/pnpm typecheck` covers it instead.
      "website/**",
    ],
  },

  ...tseslint.configs.recommended,

  {
    plugins: { "import-x": importX },
    settings: {
      // `no-cycle` has to actually resolve specifiers to walk the graph, and
      // errors out without a resolver. The node resolver is enough here:
      // every cross-package import goes through a workspace package name
      // that pnpm has already symlinked into node_modules.
      "import-x/resolver-next": [importX.createNodeResolver()],
    },
    rules: {
      // The real reason to add lint to an 8-package workspace: a dependency
      // cycle between packages breaks the build graph in ways that are very
      // hard to diagnose from the resulting error.
      "import-x/no-cycle": ["error", { maxDepth: Infinity }],
      "import-x/no-self-import": "error",

      // Unused values are usually a half-finished edit. `_`-prefixed args are
      // the documented way to say "required by signature, intentionally unused".
      //
      // RATCHET: this should be "error". It is "warn" only because lint was
      // introduced after the fact and there is a small pre-existing backlog
      // (6 findings at the time of writing, several in files under concurrent
      // edit). Clear the backlog, then flip this to "error" — a warning
      // nobody flips is a rule nobody enforces.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // `any` is load-bearing in a few places (erased session types in
      // site-sdk's DataSourceDefinition, A2UI's component prop bridge), so
      // this warns rather than errors — visible without blocking CI.
      "@typescript-eslint/no-explicit-any": "warn",

      // Catches `if (await x)` style mistakes around the many async
      // boundaries in the executor and planner.
      "no-return-await": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },

  // Tests are .mjs against built `dist/`, so type-aware rules don't apply and
  // fixtures legitimately use loose shapes.
  {
    files: ["**/test/**/*.mjs", "**/*.test.mjs"],
    ...tseslint.configs.disableTypeChecked,
    rules: {},
  },
);
