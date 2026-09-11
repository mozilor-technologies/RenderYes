import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Invariants about the chrome's CSS that no rendering test can see.
 *
 * jsdom computes no layout and applies no stylesheet, so the browser-journey
 * suite cannot notice two files defining the same class differently — which is
 * exactly what happened when the dialog and a composed view's panels both used
 * `.renderyes-panel`. The dialog's rules are concatenated last, so every
 * panel inside a dialog would have taken `position: fixed` and the dialog's own
 * background. Latent while the launcher was a separate implementation that
 * never rendered panels; live the moment a whole page went inside it.
 */
const FILES = ["chrome.ts", "clarification.tsx", "panels.tsx", "page.tsx", "trigger.tsx"];

function source(name) {
  return readFileSync(resolve(process.cwd(), "src", name), "utf8");
}

/**
 * The CSS only: the template literals assigned to a `*_STYLES` constant.
 *
 * Scanning whole files matched JavaScript that happens to contain a brace —
 * `...(index > 0 ?` was reported as an unnamespaced selector — so the CSS has
 * to be isolated before any of it is parsed as CSS.
 */
function styleSheets(text) {
  return [...text.matchAll(/(?:STYLES|_CSS)\s*=\s*`([\s\S]*?)`;/g)].map((m) =>
    // `${OTHER_STYLES}` composes sheets; those are parsed under their own file,
    // and left in they read as a selector named "$".
    m[1].replace(/\$\{[^}]*\}/g, ""),
  );
}

/**
 * Every selector a file writes a rule for, normalized on whitespace.
 *
 * Keyed by the full selector rather than by class name, because a more specific
 * selector overriding a general one is deliberate — the dialog restyles
 * `.renderyes-workspace` inside itself on purpose. What is never deliberate
 * is two files writing the *same* selector, where the later file silently wins.
 */
function ruledSelectors(text) {
  const found = new Set();
  for (const sheet of styleSheets(text)) {
    for (const match of sheet.matchAll(/(^|\n)\s*([^\n{}]*?)\s*\{/g)) {
      const selector = match[2].trim();
      if (!selector || selector.startsWith("/*") || selector.startsWith("@")) continue;
      for (const one of selector.split(",")) {
        const normalized = one.trim().replace(/\s+/g, " ");
        if (normalized) found.add(normalized);
      }
    }
  }
  return found;
}

test("no two chrome files write rules for the same class", () => {
  const owners = new Map();
  for (const file of FILES) {
    for (const selector of ruledSelectors(source(file))) {
      const existing = owners.get(selector);
      if (existing) existing.push(file);
      else owners.set(selector, [file]);
    }
  }
  const shared = [...owners.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(
    shared,
    [],
    `These selectors are written by more than one file, and the later file ` +
      `silently wins: ${shared
        .map(([selector, files]) => `"${selector}" (${files.join(", ")})`)
        .join("; ")}. Give one of them its own name.`,
  );
});

test("every chrome rule is namespaced, which is what makes host-mode injection safe", () => {
  // Host mode puts these rules in document.head. An unnamespaced rule would
  // match the host's own elements, which is the leak the old inline-style
  // fallbacks existed to avoid.
  for (const file of FILES) {
    for (const selector of ruledSelectors(source(file))) {
      // `:host` only ever matches a shadow root's own host element, so it can
      // never reach the document; everything else must be namespaced.
      if (selector.startsWith(":host")) continue;
      assert.ok(
        selector.startsWith(".renderyes-scope"),
        `${file}: "${selector}" is not under .renderyes-scope, so injecting it ` +
          `into document.head in host mode could restyle the host's own page.`,
      );
    }
  }
});
