---
"@renderyes/core": minor
"@renderyes/server": minor
"@renderyes/react": minor
---

Pasted prompts: a configurable length ceiling and the visitor's website address, read by code.

- **Server:** `ViewServerConfig.maxPromptLength` raises or lowers the prompt ceiling (default
  `MAX_PROMPT_LENGTH`, 2000 characters). It is checked at construction and enforced before any
  provider is called, on the batch and streamed routes alike. An over-limit prompt throws
  `PromptTooLongError`: a `400` with `kind: "prompt-too-long"`, or a `RUN_ERROR` of that kind.
- **Server:** `ViewServerConfig.promptExtraction: { websiteAddress: true | { ignoreHosts } }`
  returns the one website a prompt names as `extracted.websiteAddress` on a successful compose
  or reopen, and on `RUN_FINISHED`. Off by default. It is never in the plan, props, the planner
  contract, `onComposeMetrics` or `onModelCall`.
- **Core:** `extractWebsiteAddress` and `normalizeWebsiteAddress`: deterministic, origin only,
  `http(s)` only, no credentials, email addresses, IP literals or `localhost`, and nothing when
  two sites are named. `RUN_FINISHED` gains an optional `extracted`.
- **React:** `useViewCompose().extracted` holds the value for a host's handover link, re-checked
  on arrival. A fresh compose or reopen replaces it, a revision naming no site keeps it, and
  `reset` clears it. A new `errorKind`, `"prompt-too-long"`, tells the visitor to shorten a paste
  instead of saying the failure is not about their question.

See "Pasted text, prompt length, and values read from a prompt" in `docs/PRODUCT.md` and
`docs/INTEGRATION.md` §2.3.
