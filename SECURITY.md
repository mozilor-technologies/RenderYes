# Security policy

RenderYes is installed **into someone else's backend**, on their security
boundary. That shapes what we consider a vulnerability, and what we don't.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting: the **Report a vulnerability** button under
[Security](https://github.com/mozilor-technologies/RenderYes/security). It opens
a private thread with the maintainers, and is the only reporting route — there is
no email address to fall back to.

Please include the package and version, what an attacker gains, and the
smallest reproduction you have. A host configuration that demonstrates it is
worth more than a description.

**What to expect:** we aim to acknowledge a report within a week. If we
disagree that something is a vulnerability we will say so and explain why,
rather than going quiet.

We ask you to give us a chance to release a fix before disclosing publicly. We
will credit you in the advisory unless you would rather we didn't.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

Only the latest published minor receives fixes. There are no long-term support
branches.

## What is ours, and what is yours

This library sits on a boundary you own, so the split matters.

**Ours — report these:**

- An API where the unsafe thing is easy and the safe thing is hard.
- A default that fails **open**. Every default here should refuse.
- Identity, session data, or credentials reaching the planner or the model.
- A field the host never approved appearing in a response.
- A plan executing against a catalog it was not validated for.
- An upstream URL, response body, header, or credential surfacing in an error
  that reaches a visitor.
- Anything that lets a visitor act on another visitor's saved view.

**Yours — configuration, not a vulnerability:**

- `requireAdmin: () => true`, or an admin check that never rejects.
- An origin in `allowedUpstreamOrigins` that should not be there.
- Approving a capability or field that exposes data you did not intend.
- A host session or permission model that grants more than you meant.

If you are unsure which side something falls on, report it. Deciding that is
our job, not yours.

## Scope

In scope: the published `@renderyes/*` packages and this repository.

Out of scope: vulnerabilities in a host's own application, third-party model
providers, and anything requiring a compromised maintainer account or physical
access.
