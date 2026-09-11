/**
 * Styling for the built-in chrome — the prompt row, input, submit button, error
 * text and result container that `ViewPage` and `ViewTrigger`'s dialog share.
 *
 * This is now the *only* chrome styling. It used to be one of two: host mode
 * refused the stylesheet for fear of leaking onto the page, so every element
 * also carried an inline approximation of the rule below it. That cost more
 * than it saved — inline styles cannot express `:hover`, `:focus-visible` or a
 * media query, so host mode had no focus rings and no dark mode, and inline
 * styles beat any stylesheet a host wrote, so the chrome was simultaneously
 * less styled and impossible to restyle. 157 lines of duplicate table, kept in
 * sync by hand, with one element (the stale notice) that had been missed.
 *
 * Injecting it in both modes is safe because every selector is namespaced under
 * `.renderyes-scope`: nothing here can match an element outside our own
 * container, which a bare `*` or `input` selector would. `chrome-css.test.mjs`
 * enforces that, and that no two files write the same selector.
 */
/**
 * The chrome's theming surface: nine custom properties, with the palette that
 * used to be hardcoded as their defaults.
 *
 * Custom properties are the mechanism because they are the one thing that
 * crosses a shadow boundary — so a host sets these once and both render modes
 * pick them up, with no adopted stylesheets and no injection machinery. Setting
 * them on `.renderyes-scope` rather than `:root` keeps a host's own page
 * untouched while still letting them override from outside, since their rule on
 * `:root` inherits in.
 *
 * `--iv-font` defaults to `inherit`, which is the change that matters most for
 * looking native. The rule below used to set `font-family` on
 * `.renderyes-scope *` — imposing our typeface on the whole composed view,
 * including the host's own registered components, while their font sat one
 * level up, inheritable and free.
 *
 * The dark palette follows the **page**, not the operating system, which is
 * why it is `light-dark()` and not `@media (prefers-color-scheme: dark)`.
 * That media query asks the visitor's OS, and a host's page is under no
 * obligation to agree with it: a light-only design — most publications, most
 * CMS themes — kept its cream background while our chrome flipped to a dark
 * palette underneath it, painting #e6edf3 text onto a #f3f1ea page at roughly
 * 1.05:1 contrast. Invisible, for every dark-mode visitor, on a site that had
 * done nothing wrong. `light-dark()` resolves against the element's used
 * `color-scheme`, which we inherit from the host, so the chrome now goes dark
 * exactly when the page it sits in does.
 *
 * The consequence to know: a host with a dark design that never declared
 * `color-scheme: dark` now gets the light palette. That is the intended
 * trade. Declaring `color-scheme` is how a page states its scheme to the
 * browser at all — it also fixes form controls and scrollbars — and the new
 * failure is one line for a host to fix, where the old one could only be
 * escaped by overriding all eight tokens.
 */
export const CHROME_TOKEN_DEFAULTS = `
.renderyes-scope {
  --iv-font: inherit;
  --iv-fg: #1f2328;
  --iv-muted: #57606a;
  --iv-surface: #ffffff;
  --iv-surface-subtle: #f6f8fa;
  --iv-border: #dfe3e8;
  --iv-accent: #1f6feb;
  --iv-accent-fg: #ffffff;
  --iv-danger: #b42318;
  --iv-radius: 10px;
  color-scheme: inherit;
  font-family: var(--iv-font);
  color: var(--iv-fg);
}
/* The light values above stand alone so they survive the @supports test being
   false: a browser without light-dark() keeps a readable light palette rather
   than resolving var() to an invalid value and losing the colour entirely. A
   host who sets the tokens explicitly overrides both blocks. */
@supports (color: light-dark(#000, #fff)) {
  .renderyes-scope {
    --iv-fg: light-dark(#1f2328, #e6edf3);
    --iv-muted: light-dark(#57606a, #9198a1);
    --iv-surface: light-dark(#ffffff, #0d1117);
    --iv-surface-subtle: light-dark(#f6f8fa, #161b22);
    --iv-border: light-dark(#dfe3e8, #30363d);
    --iv-accent: light-dark(#1f6feb, #4493f8);
    --iv-accent-fg: light-dark(#ffffff, #0d1117);
    --iv-danger: light-dark(#b42318, #ff7b72);
  }
}
`;

export const SHARED_CHROME_STYLES = `
${CHROME_TOKEN_DEFAULTS}
.renderyes-scope, .renderyes-scope * { box-sizing: border-box; }
.renderyes-scope .renderyes-row { display: flex; gap: 8px; }
/* Colour is set rather than left to inherit: an input does not take the
   scope's colour on its own, since the UA stylesheet gives it fieldtext. So
   whether the visitor's typing was legible depended on whether the host
   happened to ship a form reset. */
.renderyes-scope .renderyes-input { flex: 1; min-height: 42px; padding: 0 12px; border: 1px solid var(--iv-border);
  border-radius: var(--iv-radius); font: inherit; color: var(--iv-fg); background: transparent; }
/* Firefox dims placeholders by default; opacity 1 lets --iv-muted be the one
   thing deciding how faint the prompt reads. */
.renderyes-scope .renderyes-input::placeholder { color: var(--iv-muted); opacity: 1; }
.renderyes-scope .renderyes-input:focus-visible { outline: 2px solid var(--iv-accent); outline-offset: 1px; }
.renderyes-scope .renderyes-send { min-height: 42px; padding: 0 16px; border: 0; border-radius: var(--iv-radius);
  background: var(--iv-accent); color: var(--iv-accent-fg); font-weight: 700; cursor: pointer; }
.renderyes-scope .renderyes-send:focus-visible { outline: 2px solid var(--iv-accent); outline-offset: 2px; }
.renderyes-scope .renderyes-send:disabled { opacity: .6; cursor: wait; }
/* Secondary, deliberately: starting over discards the view on screen, so it
   should not read as the equal of the button that builds one. */
.renderyes-scope .renderyes-start-over { min-height: 42px; padding: 0 14px;
  border: 1px solid var(--iv-border); border-radius: var(--iv-radius); background: transparent;
  color: var(--iv-muted); font-weight: 600; cursor: pointer; }
.renderyes-scope .renderyes-start-over:focus-visible { outline: 2px solid var(--iv-accent); outline-offset: 2px; }
.renderyes-scope .renderyes-start-over:disabled { opacity: .6; cursor: wait; }
.renderyes-scope .renderyes-error { margin: 12px 0 0; color: var(--iv-danger); font-size: 13px; }
.renderyes-scope .renderyes-result { margin-top: 16px; }
.renderyes-scope .renderyes-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.renderyes-scope .renderyes-chips-label { margin: 0; font-size: 13px; color: var(--iv-muted); }
.renderyes-scope .renderyes-chip { border: 1px solid var(--iv-border); background: var(--iv-surface-subtle); color: var(--iv-fg);
  border-radius: 999px; padding: 7px 14px; font-size: 13px; cursor: pointer; }
.renderyes-scope .renderyes-chip:hover { background: #eef1f4; }
.renderyes-scope .renderyes-chip:disabled { opacity: .6; cursor: wait; }
.renderyes-scope .renderyes-refusal { border: 1px solid var(--iv-border); border-radius: 12px;
  padding: 16px; background: #fafbfc; display: grid; gap: 10px; }
.renderyes-scope .renderyes-refusal-title { margin: 0; font-size: 14px; font-weight: 700; color: var(--iv-fg); }
.renderyes-scope .renderyes-refusal-reason { margin: 0; font-size: 14px; color: var(--iv-muted); }
`;

