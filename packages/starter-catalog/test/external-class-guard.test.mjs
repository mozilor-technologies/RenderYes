import assert from "node:assert/strict";
import test from "node:test";
import { createParts } from "../dist/shared.js";
import { shadcnStarterTheme } from "../dist/shadcn-theme.js";

/**
 * The condition behind the shadow-root warning.
 *
 * `shadcnStarterTheme()` sets `unstyled` and a table of Tailwind utilities —
 * correct in `renderMode: "host"`, silently fatal in the default `"isolated"`,
 * where the host's stylesheet does not cross the boundary so the classes match
 * nothing and `unstyled` has already discarded the styles that would have
 * carried the component. An install reported exactly that as "a finished-looking
 * frame around raw <table> elements".
 */

test("a component relying on host classes says so, and a self-styled one does not", () => {
  // The preset: the case that needs the warning.
  assert.equal(createParts(shadcnStarterTheme()).reliesOnExternalClasses, true);

  // Default: styles its own markup, so a shadow root is fine.
  assert.equal(createParts({}).reliesOnExternalClasses, false);

  // `unstyled` with no classes is a deliberate blank slate, not a trap — the
  // host has taken responsibility and named no external stylesheet.
  assert.equal(createParts({ unstyled: true }).reliesOnExternalClasses, false);

  // Classes *alongside* the built-in styles are additive and work anywhere.
  assert.equal(
    createParts({ classNames: { root: "my-card" } }).reliesOnExternalClasses,
    false,
  );
});

test("the preset still switches the built-in styles off, which is why it needs the guard", () => {
  const parts = createParts(shadcnStarterTheme());
  assert.equal(parts.sty("root"), undefined, "unstyled drops the inline styles");
  assert.match(parts.cls("root"), /iv-starter-root/, "and keeps a stable hook");
  assert.match(parts.cls("root"), /bg-card/, "plus the host's own utilities");
});

test("the default keeps its own styles, and inherits the host's typography", () => {
  const root = createParts({}).sty("root");
  // Inherit-first: the host's typeface and text size, not ours. These used to
  // be `ui-sans-serif` and a hard 14px, which is what made a composed view read
  // as foreign on a page that had already chosen both.
  assert.match(String(root.fontFamily), /inherit/);
  assert.match(String(root.fontSize), /inherit/);
});
