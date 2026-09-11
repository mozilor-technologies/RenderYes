import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import CodeBlock from "@theme/CodeBlock";
import Layout from "@theme/Layout";
import clsx from "clsx";
import type { ReactNode } from "react";

import styles from "./index.module.css";

/**
 * The landing page restates the README rather than inventing a second pitch.
 * Anything claimed here has to be true of the shipped packages, same as a
 * document under docs/ — the README is the source these words come from.
 */

const PIPELINE = `"Show me the politics coverage, and how many stories we've published"

   ▼  planner (AI, constrained)              ▼  executor (plain code)
   Plan { posts.list · filter · sort }   →   your <StoryList />, your styles,
        { posts.count }                       your auth, your rows`;

const BACKEND = `import { createViewServer, createViewHttpHandler } from "@renderyes/server";

const server = createViewServer({
  resolveSession: (request) => verifyYourOwnSessionCookie(request),
  host: {
    isAuthenticated: (session) => Boolean(session.userId),
    hasPermission: (session, permission) => session.permissions.has(permission),
    getSessionValue: (session, key) => session[key],
  },
  allowedUpstreamOrigins: ["https://api.example.com"],
});

const handler = createViewHttpHandler(server, {
  requireAdmin: (request) => yourOwnAdminCheck(request), // required, no default
});`;

const FRONTEND = `import { ViewProvider, ViewLauncher } from "@renderyes/react";

<ViewProvider config={{ serviceUrl: "", catalogId: "your-site", components }}>
  {/* your existing app, untouched */}
  <ViewLauncher label="Ask" />
</ViewProvider>;`;

type Guarantee = { title: string; body: ReactNode };

const GUARANTEES: Guarantee[] = [
  {
    title: "Your components, not generated ones",
    body: (
      <>
        A composed view is your markup and your CSS, because it is literally your
        components — registered up front, chosen by the planner, rendered by
        ordinary code. Nothing arrives as generated JSX.
      </>
    ),
  },
  {
    title: "Read-only, approved field by field",
    body: (
      <>
        Capabilities are declared and approved before the planner sees them.
        Identity and session keys are supplied server-side by the executor and
        stripped from the manifest the model reads.
      </>
    ),
  },
  {
    title: "A durable artifact in the middle",
    body: (
      <>
        The <code>Plan</code> is validated, versioned JSON. It can be saved,
        revisited, refined, and shared, because it is data rather than a
        transcript of a conversation.
      </>
    ),
  },
  {
    title: "Fails closed",
    body: (
      <>
        An empty upstream allowlist rejects every destination.{" "}
        <code>requireAdmin</code> has no default. Looking a plan up by id is an
        authorization decision, and it will not let you skip it quietly.
      </>
    ),
  },
];

function Hero() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={styles.hero}>
      <div className="container">
        <h1 className={styles.heroTitle}>{siteConfig.title}</h1>
        <p className={styles.heroTagline}>{siteConfig.tagline}</p>
        <p className={styles.heroBody}>
          A visitor types what they actually came for. A constrained planner turns
          it into a validated <code>Plan</code>. Then deterministic code fetches
          the data <em>you</em> approved and renders it with your React
          components.
        </p>
        <p className={styles.heroBody}>
          No model key in the browser. No data leaving your infrastructure to be
          rendered. Nothing composed that you did not approve field by field.
        </p>
        <div className={styles.heroButtons}>
          <Link className="button button--primary button--lg" to="/docs/QUICKSTART">
            Quickstart
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/docs/ARCHITECTURE"
          >
            How it works
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="Intent-to-interface for sites you already run"
      description="A visitor describes what they need; a constrained planner produces a validated Plan; deterministic code resolves approved data and renders it through your own React components."
    >
      <Hero />
      <main>
        <section className={styles.section}>
          <div className="container">
            <CodeBlock language="text" className={styles.pipeline}>
              {PIPELINE}
            </CodeBlock>
            <p className={styles.note}>
              The model chooses <em>what to show</em>. It never sees a row, never
              holds a credential, and never sets an identity parameter — those are
              declared in your catalog and injected server-side. The blast radius
              of a bad generation is a layout you can undo, not data you cannot
              un-leak.
            </p>
          </div>
        </section>

        <section className={clsx(styles.section, styles.sectionAlt)}>
          <div className="container">
            <h2 className={styles.sectionTitle}>What you get</h2>
            <div className="row">
              {GUARANTEES.map((guarantee) => (
                <div key={guarantee.title} className="col col--6">
                  <div className={styles.card}>
                    <h3 className={styles.cardTitle}>{guarantee.title}</h3>
                    <p className={styles.cardBody}>{guarantee.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className="container">
            <h2 className={styles.sectionTitle}>Two packages</h2>
            <p className={styles.note}>
              One for your backend, one for your frontend. Everything else arrives
              transitively, pinned to the same release.
            </p>
            <CodeBlock language="bash">
              {`npm install @renderyes/server   # your API
npm install @renderyes/react    # your app`}
            </CodeBlock>
            <div className="row">
              <div className="col col--6">
                <h3 className={styles.cardTitle}>Backend</h3>
                <p className={styles.cardBody}>
                  Mount one handler. It owns its own routes.
                </p>
                <CodeBlock language="ts">{BACKEND}</CodeBlock>
              </div>
              <div className="col col--6">
                <h3 className={styles.cardTitle}>Frontend</h3>
                <p className={styles.cardBody}>
                  Wrap your app. It stays exactly as it was.
                </p>
                <CodeBlock language="tsx">{FRONTEND}</CodeBlock>
              </div>
            </div>
            <p className={styles.note}>
              The <Link to="/docs/QUICKSTART">Quickstart</Link> is the shortest
              path from an empty <code>node_modules</code> to a composed view. RenderYes is a library suite, not an application: there is no
              site to boot and look at, you install it into an app you already
              have.
            </p>
          </div>
        </section>
      </main>
    </Layout>
  );
}
