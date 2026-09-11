import { useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  compileApprovedGraphQlCatalog,
  compileCuratedGraphQlCatalog,
  createGraphQlCatalogInventory,
  listGraphQlQueries,
  type GraphQlCatalogDecisions,
  type CuratedGraphQlCatalogResult,
  type CuratedSemanticTypeGap,
  type CompiledGraphQlCatalog,
  type GraphQlQueryCandidate,
  type GraphQlScalarMapping,
} from "@renderyes/capability-catalog/graphql";
import { buildGraphQlReviewExport } from "@renderyes/capability-catalog";
import type {
  FieldDescriptor,
  OperationClassificationInput,
  ResultShape,
  SemanticType,
} from "@renderyes/capability-catalog";
import { defineSite, defineSurface, toSiteManifest } from "@renderyes/site-sdk";
import {
  createCardGrid,
  createDataTable,
  createDetailPanel,
  createLineChartDefinition,
  createMetricCard,
} from "@renderyes/starter-catalog";
import {
  effectLabel,
  requestOperationClassifications,
  type ClassificationState,
} from "./operation-classification.js";

const sampleGraphQlSchema = /* GraphQL */ `
  type Category {
    id: ID!
    name: String!
  }

  type Product {
    id: ID!
    name: String!
    image: String
    price: Float!
    stock: Int!
    category: Category!
    internalCost: Float!
  }

  type Query {
    "Products available to the current tenant."
    products(minStock: Int, maxStock: Int, tenantId: ID!): [Product!]!
    product(id: ID!, tenantId: ID!): Product
  }

  type Mutation {
    updateStock(id: ID!, stock: Int!): Product!
  }
`;

const sampleCuratedGraphQlSchema = /* GraphQL */ `
  type Ticket {
    id: ID!
    title: String!
    status: String!
    createdAt: String!
  }

  type Query {
    "Find tickets already scoped to the signed-in visitor by the host resolver."
    tickets(status: String, limit: Int): [Ticket!]!
  }

  type Mutation {
    closeTicket(id: ID!): Ticket!
  }
`;

const resultShapes: readonly ResultShape[] = [
  "collection",
  "entity",
  "search-results",
  "metric",
  "time-series",
  "hierarchy",
  "document",
  "media-collection",
  "comparison",
];

const semanticTypes: readonly SemanticType[] = [
  "unknown",
  "identifier",
  "text",
  "rich-text",
  "image-url",
  "url",
  "money",
  "quantity",
  "percentage",
  "date",
  "date-time",
  "status",
  "boolean",
  "location",
];

type ArgumentMode = "excluded" | "visitor" | "identity";

interface QueryConfiguration {
  capabilityId: string;
  purpose: string;
  dataTypeId: string;
  dataTypeDescription: string;
  resultShape: ResultShape;
  matchKey: string;
  argumentModes: Record<string, ArgumentMode>;
  identityKeys: Record<string, string>;
  approvedFields: string[];
  requiredFields: string[];
  semanticOverrides: Record<string, SemanticType>;
  authentication: "public" | "session";
  permissions: string;
  maximumRows: number;
  maximumPageSize: number;
  excludeEnumValues: string;
  timeoutMs: number;
  cacheTtlSeconds: number;
  maximumSelectionDepth: number;
  maximumSelectedFields: number;
  freshnessMaximumAgeSeconds: number;
  scalarMappings: string;
}

interface CatalogConfiguration {
  catalogId: string;
  catalogVersion: string;
  catalogDescription: string;
  sourceId: string;
  sourceLabel: string;
  sourceDescription: string;
}

function slug(value: string, fallback: string): string {
  return (
    value
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

function defaultQueryConfiguration(query: GraphQlQueryCandidate): QueryConfiguration {
  const dataTypeId = slug(
    query.fieldName.replace(/^(list|get|search|find)/i, ""),
    "record",
  );
  return {
    capabilityId: `${dataTypeId}.query`,
    purpose: query.description ?? "",
    dataTypeId,
    dataTypeDescription: `Approved data returned by ${query.coordinate}.`,
    resultShape: query.suggestedResultShape,
    matchKey: query.outputFields.some((field) => field.path === "id") ? "id" : "",
    argumentModes: Object.fromEntries(
      query.arguments.map((argument) => [argument.name, "excluded" as const]),
    ),
    identityKeys: {},
    approvedFields: [],
    requiredFields: [],
    semanticOverrides: Object.fromEntries(
      query.outputFields.map((field) => [field.path, field.semanticType]),
    ),
    authentication: "public",
    permissions: "",
    maximumRows: 100,
    // 0 means "do not declare one", so the compile keeps its own default.
    maximumPageSize: 0,
    excludeEnumValues: "",
    timeoutMs: 5_000,
    cacheTtlSeconds: 0,
    maximumSelectionDepth: 4,
    maximumSelectedFields: 30,
    freshnessMaximumAgeSeconds: 300,
    scalarMappings: "{}",
  };
}

function parseSchemaInput(text: string): string | Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste GraphQL SDL or introspection JSON first");
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("GraphQL introspection JSON must be an object");
    }
    return parsed as Record<string, unknown>;
  }
  return text;
}

function parseCommaList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function parseScalarMappings(value: string): Record<string, GraphQlScalarMapping> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Custom scalar mappings must be a JSON object");
  }
  return parsed as Record<string, GraphQlScalarMapping>;
}

function toggle(values: readonly string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function classificationInputForQuery(
  query: GraphQlQueryCandidate,
): OperationClassificationInput {
  return {
    operationKey: `graphql:${query.coordinate}`,
    protocol: "graphql",
    coordinate: query.coordinate,
    operationName: query.fieldName,
    ...(query.description ? { description: query.description } : {}),
    tags: ["Query"],
    inputShape: query.arguments.map((argument) => ({
      name: argument.name,
      type: argument.type,
      required: argument.required,
      ...(argument.description ? { description: argument.description } : {}),
    })),
    outputShape: query.outputFields.map((field) => ({
      path: field.path,
      type: field.type,
      ...(field.description ? { description: field.description } : {}),
    })),
  };
}

function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const BUILTIN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

/** `[Foo!]!` → `Foo`. Leaf field and argument types arrive already stringified. */
function namedTypeName(type: string): string {
  return type.replace(/[[\]!]/g, "");
}

/**
 * Custom scalars reachable from the curated surface. The compiler refuses to
 * invent a JSON Schema for a scalar it does not recognize — rightly, since only
 * the host knows whether `JSON` means "arbitrary map" or something specific —
 * so onboarding cannot proceed until each one is declared. Enums are unaffected
 * (they compile from their own values) but may appear in this list; a mapping
 * for one is ignored rather than harmful.
 */
function customScalarNames(queries: readonly GraphQlQueryCandidate[]): string[] {
  const names = new Set<string>();
  for (const query of queries) {
    for (const field of query.outputFields) names.add(namedTypeName(field.type));
    for (const argument of query.arguments) names.add(namedTypeName(argument.type));
  }
  return [...names].filter((name) => !BUILTIN_SCALARS.has(name)).sort();
}

/** One capability's outcome from `POST /api/catalog/probe`. */
interface ProbeEntry {
  capabilityId: string;
  status: "ok" | "degraded" | "failed" | "skipped";
  reason?: string;
  rowCount?: number;
  degradedFields?: string[];
  upstreamCredential?: "enforced" | "not-required" | "unknown";
}

/**
 * Executes every published capability once and reports what the upstream
 * actually did.
 *
 * This is the step between "publish succeeded" and "a visitor sees a view", and
 * it was unreachable: the endpoint has existed since the probe was written and
 * nothing in this app called it, so the only way to find out that an approved
 * capability does not work was to type a prompt and get an empty view.
 *
 * A schema can lie. Saleor declares `ProductVariant.revenue`'s `period`
 * argument optional and its resolver requires it, so the field passes
 * discovery, passes approval, publishes cleanly, and then errors on every row
 * in front of a visitor. No static analysis catches a resolver contradicting
 * its own SDL; one cheap execution per capability does, while the host is still
 * sitting here.
 */
function CatalogProbePanel({
  catalogId,
  publishToken,
}: {
  catalogId: string;
  publishToken: string;
}) {
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "running" }
    | { status: "done"; results: ProbeEntry[] }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const run = async () => {
    setState({ status: "running" });
    try {
      const response = await fetch("/api/catalog/probe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(publishToken.trim()
            ? { "x-renderyes-admin-token": publishToken.trim() }
            : {}),
        },
        body: JSON.stringify({ catalogId }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Probe failed (${response.status})`,
        );
      }
      setState({
        status: "done",
        results: Array.isArray(payload.results) ? (payload.results as ProbeEntry[]) : [],
      });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Probe failed",
      });
    }
  };

  const results = state.status === "done" ? state.results : [];
  const broken = results.filter(
    (entry) => entry.status === "failed" || entry.status === "degraded",
  );
  const unguarded = results.filter(
    (entry) => entry.upstreamCredential === "not-required",
  );

  return (
    <div className="probe-panel">
      <button onClick={run} disabled={state.status === "running"}>
        {state.status === "running" ? "Probing…" : "Probe every capability"}
      </button>
      <p className="form-hint">
        Runs each published capability once against the live endpoint, and repeats
        it with your server's upstream credential withheld. One row is requested
        per collection.
      </p>

      {state.status === "error" ? (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      ) : null}

      {state.status === "done" ? (
        <>
          <p className={broken.length > 0 ? "form-error" : "success-message"}>
            {broken.length > 0
              ? `${broken.length} of ${results.length} capabilities do not work as approved.`
              : `All ${results.length} capabilities answered.`}
          </p>
          {unguarded.length > 0 ? (
            <p className="form-error" role="alert">
              {unguarded.length} capabilit{unguarded.length === 1 ? "y" : "ies"} answered
              without your server&rsquo;s credential. Whatever this catalog records
              about authentication, the upstream is not enforcing it —{" "}
              {unguarded.map((entry) => entry.capabilityId).join(", ")}.
            </p>
          ) : null}
          <ul className="probe-results">
            {results.map((entry) => (
              <li key={entry.capabilityId} data-status={entry.status}>
                <strong>{entry.capabilityId}</strong> <span>{entry.status}</span>
                {entry.rowCount !== undefined ? (
                  <span> · {entry.rowCount} row(s)</span>
                ) : null}
                {entry.upstreamCredential === "not-required" ? (
                  <span> · no credential required</span>
                ) : null}
                {entry.reason ? <p>{entry.reason}</p> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function CuratedGraphQlOnboarding({
  onUseDetailedReview,
}: {
  onUseDetailedReview: () => void;
}) {
  const [schemaInput, setSchemaInput] = useState<string | Record<string, unknown>>();
  const [pasteValue, setPasteValue] = useState("");
  const [loadError, setLoadError] = useState("");
  const [scalarMappings, setScalarMappings] = useState("{}");
  const [catalogId, setCatalogId] = useState("host-curated-graphql");
  const [sourceLabel, setSourceLabel] = useState("Host GraphQL API");
  const [endpoint, setEndpoint] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [publishToken, setPublishToken] = useState("");
  const [authentication, setAuthentication] = useState<"public" | "session">("session");
  // 1000, matching `DEFAULT_MAX_ROWS` in `@renderyes/data-runtime` — the
  // ceiling a capability that declares nothing already gets.
  //
  // This one number does two jobs: it bounds what a plan may request, and it is
  // asserted against what the upstream actually returns, so a result exceeding
  // it is rejected outright rather than truncated. Rejection is right — a
  // capability that should return twelve rows returning fifty thousand means a
  // filter or a tenant scope failed, and showing the first hundred of those
  // would be presenting someone else's data as this visitor's.
  //
  // But the curated flow asks nothing per capability, so any value here is a
  // guess about every operation in the API at once. At 100 it was a false
  // assertion rather than a tight one: `getPeakLoadHeatmap` returns 24 hours ×
  // 7 days = 168 rows by construction, so that capability could never succeed.
  // A generous bound leaves the assertion catching genuinely absurd responses;
  // an owner wanting a tight per-capability limit sets it in detailed review,
  // where they are answering per-capability questions anyway.
  const [maximumRows, setMaximumRows] = useState(1000);
  const [freshnessMaximumAgeSeconds, setFreshnessMaximumAgeSeconds] = useState(300);
  // How deep into a row discovery walks. Frozen at 4 here and 6 in detailed
  // review, which made a whole class of field silently unreachable: a Relay
  // wrapper spends two levels, so a money amount one hop inside a row landed
  // beyond the budget and the host approved `total.currency` with no amount.
  // The exclusion ledger now names what a stop cost, so this is the control
  // that acts on it.
  const [discoveryDepth, setDiscoveryDepth] = useState(4);
  const [compiled, setCompiled] = useState<CuratedGraphQlCatalogResult>();
  const [compileError, setCompileError] = useState("");
  // The needs-review queue. `gaps` is the stable row list (captured whenever a
  // decision-free compile runs); `semanticDecisions` holds the host's answers,
  // keyed by the gap's coordinate path. Decided fields stay listed so a
  // decision can be revisited, which is why rows render from `gaps` rather
  // than from the shrinking `needsSemanticType` of the latest compile.
  const [gaps, setGaps] = useState<CuratedSemanticTypeGap[]>([]);
  const [semanticDecisions, setSemanticDecisions] = useState<
    Record<string, SemanticType>
  >({});
  const [suggestions, setSuggestions] = useState<
    Record<string, { semanticType: SemanticType; confidence: number; reason: string }>
  >({});
  const [suggestState, setSuggestState] = useState<
    { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready" }
  >({ status: "idle" });
  const [confirmed, setConfirmed] = useState(false);
  const [publishState, setPublishState] = useState<
    | { status: "idle" }
    | { status: "publishing" }
    | { status: "published"; summary: Record<string, unknown> }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const queries = useMemo(() => {
    if (!schemaInput) return [];
    try {
      return listGraphQlQueries(schemaInput, { maximumDiscoveryDepth: discoveryDepth });
    } catch {
      return [];
    }
  }, [schemaInput, discoveryDepth]);
  const supportedQueries = queries.filter(
    (query) => query.support.status === "supported",
  );
  const customScalars = useMemo(() => customScalarNames(queries), [queries]);

  const loadSchema = (input: string | Record<string, unknown>) => {
    try {
      const discovered = listGraphQlQueries(input, { maximumDiscoveryDepth: discoveryDepth });
      if (!discovered.length) throw new Error("No root Query fields were found");
      setSchemaInput(input);
      // Keep the textarea showing what is actually loaded.
      //
      // "Load curated sample" set the schema and left the textarea empty, so the
      // obvious next click — "Read schema", the primary button right under it —
      // parsed an empty string and errored. Two controls that looked like one
      // flow, and the second one broke the first.
      //
      // Only for SDL: an introspection document is megabytes, and putting that
      // in a textarea is its own kind of broken.
      if (typeof input === "string") setPasteValue(input);
      // Prefilled as unconstrained so the common case is one glance and a
      // click, not authoring JSON Schema from scratch. An unconstrained schema
      // is the honest default for a passthrough scalar; a host that knows more
      // can narrow it here before compiling.
      const detected = customScalarNames(discovered);
      setScalarMappings(
        detected.length
          ? JSON.stringify(
              Object.fromEntries(detected.map((name) => [name, { schema: {} }])),
              null,
              2,
            )
          : "{}",
      );
      setLoadError("");
      setCompiled(undefined);
      setCompileError("");
      setGaps([]);
      setSemanticDecisions({});
      setSuggestions({});
      setSuggestState({ status: "idle" });
      setPublishState({ status: "idle" });
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Could not read GraphQL schema",
      );
    }
  };

  const compile = (decisions: Record<string, SemanticType> = semanticDecisions) => {
    if (!schemaInput || !confirmed) return;
    try {
      // Only forward decisions for rows still in the queue: a schema or
      // scalar-mapping edit can invalidate old keys, and a stale key is a
      // compile error by design.
      const applicable = gaps.length
        ? Object.fromEntries(
            Object.entries(decisions).filter(([key]) =>
              gaps.some((gap) => gap.key === key),
            ),
          )
        : decisions;
      const result = compileCuratedGraphQlCatalog({
        scalarMappings: parseScalarMappings(scalarMappings),
        schema: schemaInput,
        catalog: {
          id: catalogId.trim(),
          version: "1.0.0",
          description: "Capabilities compiled from the host-curated GraphQL API.",
        },
        source: {
          id: `${catalogId.trim()}-source`,
          label: sourceLabel.trim(),
          description: "Host-curated GraphQL source.",
        },
        policy: {
          authentication,
          maximumRows,
          timeoutMs: 5_000,
          freshnessMaximumAgeSeconds,
          maximumSelectionDepth: discoveryDepth,
          maximumSelectedFields: 100,
        },
        discoveryMaxDepth: discoveryDepth,
        ...(Object.keys(applicable).length
          ? { semanticTypeOverrides: applicable }
          : {}),
      });
      setCompiled(result);
      if (Object.keys(applicable).length === 0) setGaps(result.needsSemanticType);
      setCompileError("");
    } catch (error) {
      setCompiled(undefined);
      setCompileError(
        error instanceof Error ? error.message : "Could not compile curated GraphQL API",
      );
    }
  };

  const decideSemanticType = (key: string, value: string) => {
    const next = { ...semanticDecisions };
    if (value === "") delete next[key];
    else next[key] = value as SemanticType;
    setSemanticDecisions(next);
    compile(next);
  };

  const requestSuggestions = async () => {
    if (!gaps.length) return;
    setSuggestState({ status: "loading" });
    try {
      const response = await fetch("/api/semantic-suggestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fields: gaps.map((gap) => ({
            key: gap.key,
            label: gap.label,
            type: gap.type,
            ...(gap.description ? { description: gap.description } : {}),
            fieldName: gap.fieldName,
          })),
        }),
      });
      const payload = (await response.json()) as {
        suggestions?: { key: string; semanticType: SemanticType; confidence: number; reason: string }[];
        usedLiveModel?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
      if (!payload.usedLiveModel) {
        throw new Error(
          "The host has no live model provider configured; decide the fields manually.",
        );
      }
      setSuggestions(
        Object.fromEntries((payload.suggestions ?? []).map((entry) => [entry.key, entry])),
      );
      setSuggestState({ status: "ready" });
    } catch (error) {
      setSuggestState({
        status: "error",
        message: error instanceof Error ? error.message : "Suggestion request failed",
      });
    }
  };

  const acceptAllSuggestions = () => {
    const next = { ...semanticDecisions };
    for (const [key, suggestion] of Object.entries(suggestions)) {
      if (!next[key]) next[key] = suggestion.semanticType;
    }
    setSemanticDecisions(next);
    compile(next);
  };

  // The UI catalog half of the export. Starter components by default: they
  // accept data by shape, so they are valid for any catalog, and a host can
  // republish its own UI catalog under the same id later.
  const buildExport = () => {
    if (!compiled || !schemaInput) return undefined;
    // One renderer per shape `inferResultShape` can produce, so the bootstrap
    // demonstrates the pipeline over every capability rather than half of them.
    // `entity` was the gap that mattered — it is the commonest shape a real
    // schema yields, so publishing without a renderer for it reported most of a
    // new host's approved capabilities as `unrenderableDataTypes`, which reads
    // as "you did something wrong" rather than "this starter set is partial".
    //
    // The chart arrives as a *definition*: the rendering variants live in
    // `@renderyes/starter-catalog/charts` and pull in recharts, which a
    // browser tool that only needs the contract has no reason to bundle.
    const definitions = [
      createMetricCard().definition,
      createDataTable().definition,
      createCardGrid().definition,
      createDetailPanel().definition,
      createLineChartDefinition(),
    ];
    const uiManifest = toSiteManifest(
      defineSite({
        id: catalogId.trim(),
        name: sourceLabel.trim() || catalogId.trim(),
        version: "1.0.0",
        catalogId: `https://localhost/renderyes/${catalogId.trim()}.json`,
        components: definitions,
        surfaces: [
          defineSurface({
            id: "main",
            description: "Curated onboarding surface.",
            componentIds: definitions.map((definition) => definition.id),
          }),
        ],
      }),
    ) as unknown as Record<string, unknown>;
    return buildGraphQlReviewExport({
      catalogId: catalogId.trim(),
      compiled,
      schema: schemaInput,
      endpoint: endpoint.trim(),
      ...(credentialId.trim() ? { credentialId: credentialId.trim() } : {}),
      uiManifest,
    });
  };

  const downloadExport = () => {
    const bundle = buildExport();
    if (bundle) downloadJson(bundle, `${catalogId.trim()}.review-export.json`);
  };

  const publish = async () => {
    if (!compiled || !schemaInput || !endpoint.trim()) return;
    setPublishState({ status: "publishing" });
    try {
      const response = await fetch("/api/review-export", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(publishToken.trim()
            ? { "x-renderyes-admin-token": publishToken.trim() }
            : {}),
        },
        body: JSON.stringify(buildExport()),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Publish failed (${response.status})`,
        );
      setPublishState({ status: "published", summary: payload });
    } catch (error) {
      setPublishState({
        status: "error",
        message: error instanceof Error ? error.message : "Publish failed",
      });
    }
  };

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">RenderYes · GraphQL onboarding</p>
          <h1>Connect a curated GraphQL API</h1>
          <p className="lede">
            Use this when the API already exposes only visitor-safe read data. RenderYes
            will compile its whole Query surface; there is no field checklist.
          </p>
        </div>
        <button onClick={onUseDetailedReview}>Use detailed review instead</button>
      </header>

      <section className="load-panel">
        <div>
          <p className="eyebrow">Step 1</p>
          <h2>Load the schema</h2>
          <p>
            Paste SDL or upload introspection JSON. The browser reads metadata only; API
            credentials stay on the host server.
          </p>
        </div>
        <div className="load-actions">
          <label className="file-button">
            Choose schema file
            <input
              type="file"
              accept=".graphql,.gql,.json,text/plain,application/json"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) {
                  const text = await file.text();
                  loadSchema(parseSchemaInput(text));
                }
                event.target.value = "";
              }}
            />
          </label>
          <button onClick={() => loadSchema(sampleCuratedGraphQlSchema)}>
            Load curated sample
          </button>
        </div>
        <label className="paste-label">
          Or paste SDL / introspection JSON
          <textarea
            value={pasteValue}
            onChange={(event) => setPasteValue(event.target.value)}
            rows={7}
            placeholder="type Query { tickets(limit: Int): [Ticket!]! }"
          />
        </label>
        <button
          className="primary parse-button"
          disabled={pasteValue.trim().length === 0}
          onClick={() => {
            // Guarded as well as disabled: the message is what a reviewer needs
            // if they ever reach it, and a parse error about an empty document
            // says nothing about what to do.
            if (pasteValue.trim().length === 0) {
              setLoadError(
                "Nothing to read — paste SDL or introspection JSON above, choose a " +
                  "file, or load the curated sample.",
              );
              return;
            }
            try {
              loadSchema(parseSchemaInput(pasteValue));
            } catch (error) {
              setLoadError(
                error instanceof Error ? error.message : "Could not parse schema",
              );
            }
          }}
        >
          Read schema
        </button>
        {loadError ? (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        ) : null}
      </section>

      {schemaInput ? (
        <>
          <section className="configure-panel curated-summary">
            <p className="eyebrow">Step 2</p>
            <h2>Confirm the data surface</h2>
            <div className="curated-stats">
              <strong>{supportedQueries.length} visitor capabilities</strong>
              <span>{queries.length} Query fields discovered</span>
              <span>Mutations and subscriptions are never included</span>
            </div>
            <p>
              Every visible query and understood field will be available to the planner.
              Identity and tenant scope must be enforced in your GraphQL
              resolver/session—not passed as a query argument.
            </p>
            <div className="catalog-form">
              <label>
                Catalog ID
                <input
                  value={catalogId}
                  onChange={(event) => {
                    setCatalogId(event.target.value);
                    setCompiled(undefined);
                  }}
                />
              </label>
              <label>
                Source label
                <input
                  value={sourceLabel}
                  onChange={(event) => {
                    setSourceLabel(event.target.value);
                    setCompiled(undefined);
                  }}
                />
              </label>
              <label>
                Authentication
                <select
                  value={authentication}
                  onChange={(event) => {
                    setAuthentication(event.target.value as "public" | "session");
                    setCompiled(undefined);
                  }}
                >
                  <option value="session">Existing host session</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <label>
                Maximum rows
                <input
                  type="number"
                  min="1"
                  value={maximumRows}
                  onChange={(event) => {
                    setMaximumRows(Number(event.target.value));
                    setCompiled(undefined);
                  }}
                />
              </label>
              <label>
                Freshness maximum age (seconds)
                <input
                  type="number"
                  min="0"
                  value={freshnessMaximumAgeSeconds}
                  onChange={(event) => {
                    setFreshnessMaximumAgeSeconds(Number(event.target.value));
                    setCompiled(undefined);
                  }}
                />
              </label>
              <label>
                Field discovery depth
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={discoveryDepth}
                  onChange={(event) => {
                    setDiscoveryDepth(Number(event.target.value));
                    setCompiled(undefined);
                  }}
                />
                <span>
                  How far into a row to look. A Relay connection spends none of
                  this — paths are row-relative — but a money value nested two
                  objects deep needs 3. The discovery notes below name every
                  field a stop here put out of reach.
                </span>
              </label>
            </div>
            {customScalars.length ? (
              <label className="paste-label">
                Custom scalar mappings (JSON)
                <span>
                  {" "}
                  — {customScalars.join(", ")}{" "}
                  {customScalars.length === 1 ? "is not a" : "are not"} built-in GraphQL{" "}
                  {customScalars.length === 1 ? "scalar" : "scalars"}, so{" "}
                  {customScalars.length === 1 ? "its" : "their"} JSON Schema must come
                  from you. Prefilled as unconstrained; narrow it if you know more.
                </span>
                <textarea
                  rows={Math.min(3 + customScalars.length * 3, 12)}
                  value={scalarMappings}
                  onChange={(event) => {
                    setScalarMappings(event.target.value);
                    setCompiled(undefined);
                  }}
                />
              </label>
            ) : null}
            <label className="curated-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              I confirm this API exposes only visitor-safe read data and resolver/session
              code enforces access scope.
            </label>
            <details>
              <summary>Inspect derived capabilities</summary>
              <ul>
                {queries.map((query) => (
                  <li key={query.coordinate}>
                    <strong>{query.coordinate}</strong> · {query.arguments.length}{" "}
                    arguments · {query.outputFields.length} discovered fields{" "}
                    {query.support.status === "unsupported"
                      ? `— ${query.support.reason}`
                      : ""}
                  </li>
                ))}
              </ul>
            </details>
            <button className="primary" disabled={!confirmed} onClick={() => compile()}>
              Compile curated catalog
            </button>
            {compileError ? (
              <p className="form-error" role="alert">
                {compileError}
              </p>
            ) : null}
          </section>

          {compiled ? (
            <section className="export-panel graphql-export">
              <p className="eyebrow">Step 3</p>
              <h2>Publish the approved schema version</h2>
              <p>
                {compiled.catalog.capabilities.length} capabilities are ready. The schema
                fingerprint is bound into every server-only binding.
              </p>
              {gaps.length ? (
                <section className="semantic-review">
                  <h3>
                    {compiled.needsSemanticType.length
                      ? `${compiled.needsSemanticType.length} field${
                          compiled.needsSemanticType.length === 1 ? "" : "s"
                        } awaiting a decision`
                      : "All exposed fields decided"}
                  </h3>
                  <p className="hint">
                    These numbers are exposed by the API, but nothing says what
                    they mean — a count, a percentage, money. Pick a meaning to
                    include a field; leave one undecided to keep it out of the
                    catalog. Nothing is guessed.
                  </p>
                  <div className="suggest-actions">
                    <button
                      type="button"
                      disabled={suggestState.status === "loading"}
                      onClick={requestSuggestions}
                    >
                      {suggestState.status === "loading"
                        ? "Asking the model…"
                        : "Suggest with AI"}
                    </button>
                    {suggestState.status === "ready" &&
                    Object.keys(suggestions).length ? (
                      <button type="button" onClick={acceptAllSuggestions}>
                        Accept all suggestions
                      </button>
                    ) : null}
                    {suggestState.status === "ready" ? (
                      <span className="hint">
                        Suggestions are advisory — nothing enters the catalog
                        until you accept it.
                      </span>
                    ) : null}
                    {suggestState.status === "error" ? (
                      <span className="form-error">{suggestState.message}</span>
                    ) : null}
                  </div>
                  <ul className="semantic-review-list">
                    {gaps.map((gap) => (
                      <li key={gap.key}>
                        <code>{gap.key}</code> <span className="type-chip">{gap.type}</span>
                        {gap.description ? <em> — {gap.description}</em> : null}
                        {suggestions[gap.key] &&
                        semanticDecisions[gap.key] !== suggestions[gap.key].semanticType ? (
                          <span
                            className="ai-suggestion"
                            title={suggestions[gap.key].reason}
                          >
                            AI: {suggestions[gap.key].semanticType} (
                            {Math.round(suggestions[gap.key].confidence * 100)}%)
                            <button
                              type="button"
                              onClick={() =>
                                decideSemanticType(
                                  gap.key,
                                  suggestions[gap.key].semanticType,
                                )
                              }
                            >
                              Accept
                            </button>
                          </span>
                        ) : null}
                        <select
                          aria-label={`Semantic type for ${gap.key}`}
                          value={semanticDecisions[gap.key] ?? ""}
                          onChange={(event) =>
                            decideSemanticType(gap.key, event.target.value)
                          }
                        >
                          <option value="">Leave out</option>
                          <option value="quantity">Quantity / count</option>
                          <option value="percentage">Percentage / ratio</option>
                          <option value="money">Money</option>
                          <option value="date">Date</option>
                          <option value="date-time">Date-time</option>
                          <option value="identifier">Identifier</option>
                          <option value="status">Status</option>
                          <option value="text">Plain text</option>
                          <option value="url">URL</option>
                          <option value="image-url">Image URL</option>
                          <option value="boolean">Yes / no</option>
                          <option value="location">Location</option>
                        </select>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {compiled.issues.length ? (
                <details>
                  <summary>
                    {compiled.issues.length} discovery note
                    {compiled.issues.length === 1 ? "" : "s"}
                  </summary>
                  <ul>
                    {compiled.issues.map((issue) => (
                      <li key={`${issue.path}:${issue.message}`}>
                        {issue.path}: {issue.message}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <div className="export-actions">
                <button
                  onClick={() =>
                    downloadJson(compiled.catalog, "capability-catalog.json")
                  }
                >
                  Download catalog
                </button>
                <button
                  onClick={() =>
                    downloadJson(compiled.plannerManifest, "planner-manifest.json")
                  }
                >
                  Download planner manifest
                </button>
                <button disabled={!endpoint.trim()} onClick={downloadExport}>
                  Download export bundle
                </button>
              </div>
              <label className="paste-label">
                GraphQL endpoint (required)
                <input
                  type="url"
                  value={endpoint}
                  onChange={(event) => {
                    setEndpoint(event.target.value);
                    setPublishState({ status: "idle" });
                  }}
                  placeholder="http://127.0.0.1:4000/graphql"
                />
              </label>
              <label className="paste-label">
                {/*
                  * Not a secret, and the field says so — it is a key into the
                  * host's own `upstreamCredentials`, resolved server-side. It is
                  * the only way to publish a catalog whose upstream needs a
                  * credential, and the headless `compile --credential-id` had it
                  * while this door did not.
                  */}
                Upstream credential id (optional)
                <input
                  type="text"
                  value={credentialId}
                  onChange={(event) => {
                    setCredentialId(event.target.value);
                    setPublishState({ status: "idle" });
                  }}
                  placeholder="a key into the host's upstreamCredentials — never a secret"
                />
              </label>
              <label className="paste-label">
                Publish token (sent as x-renderyes-admin-token, if the host requires one)
                <input
                  type="password"
                  value={publishToken}
                  onChange={(event) => {
                    setPublishToken(event.target.value);
                    setPublishState({ status: "idle" });
                  }}
                  placeholder="leave empty if the host allows unauthenticated publish"
                />
              </label>
              <button
                className="primary"
                disabled={!endpoint.trim() || publishState.status === "publishing"}
                onClick={publish}
              >
                {publishState.status === "publishing" ? "Publishing…" : "Publish to host"}
              </button>
              {/*
                Says why the button is dead. The endpoint starts empty while the
                placeholder shows a complete, plausible URL, so the field reads
                as already filled — you click Publish, the button is disabled,
                and absolutely nothing happens or is said. Every other failure
                in this panel explains itself; this one was silent, which makes
                it look like the publish itself is broken.
              */}
              {!endpoint.trim() ? (
                <p className="form-hint">
                  Enter the GraphQL endpoint above to publish. The greyed-out text in the
                  field is an example, not a value.
                </p>
              ) : null}
              {publishState.status === "error" ? (
                <p className="form-error" role="alert">
                  {publishState.message}
                </p>
              ) : null}
              {publishState.status === "published" ? (
                <>
                  <p className="success-message">
                    Published {String(publishState.summary.catalogId)} with{" "}
                    {String(publishState.summary.executableCapabilityCount)} executable
                    capabilities
                    {Array.isArray(publishState.summary.componentIds)
                      ? ` and ${publishState.summary.componentIds.length} UI components`
                      : ""}
                    .
                  </p>
                  <CatalogProbePanel
                    catalogId={String(publishState.summary.catalogId)}
                    publishToken={publishToken}
                  />
                </>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

export function GraphQlReviewApp() {
  const [onboardingMode, setOnboardingMode] = useState<
    "curated" | "detailed" | undefined
  >();
  const [schemaInput, setSchemaInput] = useState<string | Record<string, unknown>>();
  const [schemaLabel, setSchemaLabel] = useState("");
  const [pasteValue, setPasteValue] = useState("");
  const [loadError, setLoadError] = useState("");
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [selectedFieldName, setSelectedFieldName] = useState("");
  const [queryConfigurations, setQueryConfigurations] = useState<
    Record<string, QueryConfiguration>
  >({});
  const [catalog, setCatalog] = useState<CatalogConfiguration>({
    catalogId: "host-graphql-catalog",
    catalogVersion: "1.0.0",
    catalogDescription: "Host-approved GraphQL capabilities.",
    sourceId: "host-graphql",
    sourceLabel: "Host GraphQL API",
    sourceDescription: "Host-owned GraphQL data source.",
  });
  const [compileResult, setCompileResult] = useState<CompiledGraphQlCatalog>();
  const [approvalResult, setApprovalResult] = useState<GraphQlCatalogDecisions>();
  const [compileError, setCompileError] = useState("");
  /**
   * Narrowing a list you cannot see.
   *
   * 95 root queries on this schema, 213 on Saleor, and about 14 rows fit on a
   * laptop — so a reviewer sees 15% of the list and has no way to reach a
   * capability by name. Scrolling eight screens looking for `Query.Posts` is
   * not navigation.
   */
  const [queryFilter, setQueryFilter] = useState("");
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [graphqlEndpoint, setGraphqlEndpoint] = useState("");
  const [graphqlCredentialId, setGraphqlCredentialId] = useState("");
  const [publishState, setPublishState] = useState<
    | { status: "idle" }
    | { status: "publishing" }
    | { status: "published"; summary: Record<string, unknown> }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [classificationState, setClassificationState] = useState<ClassificationState>({
    status: "idle",
  });
  // See the curated flow's copy of this: 6 was as arbitrary as 4, and a field
  // beyond it did not appear as unavailable, it simply did not appear.
  const [discoveryDepth, setDiscoveryDepth] = useState(6);
  /**
   * AI field-selection proposals, per root query field, per path.
   *
   * A real API makes this list long — Saleor's `Order` carries about sixty
   * fields — and a reviewer reads every one. The proposals pre-tick a starting
   * point from the capability's stated purpose.
   *
   * Every row stays on screen and every proposal is additive: applying them
   * ticks boxes and never unticks one, so a decision the reviewer already made
   * cannot be overridden by a model. That is the same propose-never-filter rule
   * the server enforces, restated where a person can see it.
   */
  const [fieldProposals, setFieldProposals] = useState<
    Record<string, Record<string, { propose: boolean; confidence: number; reason: string }>>
  >({});
  const [proposalState, setProposalState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready" }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const queries = useMemo(() => {
    if (!schemaInput) return [];
    try {
      return listGraphQlQueries(schemaInput, { maximumDiscoveryDepth: discoveryDepth });
    } catch {
      return [];
    }
  }, [schemaInput, discoveryDepth]);
  const selectedQuery =
    queries.find((query) => query.fieldName === selectedFieldName) ??
    queries.find((query) => selectedFields.includes(query.fieldName));
  const selectedConfiguration = selectedQuery
    ? queryConfigurations[selectedQuery.fieldName]
    : undefined;

  /**
   * What the list actually shows.
   *
   * Matches the field name, the coordinate and the description, because a
   * reviewer looking for "posts" may be thinking of any of the three. Filtering
   * never changes what is approved — it changes what is on screen — so a hidden
   * capability keeps its decision, and the counts below always describe the
   * whole schema rather than the current view.
   */
  const visibleQueries = useMemo(() => {
    const needle = queryFilter.trim().toLowerCase();
    return queries.filter((query) => {
      if (approvedOnly && !selectedFields.includes(query.fieldName)) return false;
      if (!needle) return true;
      return (
        query.fieldName.toLowerCase().includes(needle) ||
        query.coordinate.toLowerCase().includes(needle) ||
        (query.description ?? "").toLowerCase().includes(needle)
      );
    });
  }, [queries, queryFilter, approvedOnly, selectedFields]);

  /**
   * Bring the editor to the reviewer, because it is not where they clicked.
   *
   * The capability list and the editor are siblings: the editor renders after
   * the *entire* list. On a schema with 86 root queries — Saleor's — pressing
   * Configure on the third one opens a panel several screens below the fold,
   * with nothing on screen changing. It reads as a dead button, and the next
   * thing a reviewer does is press it again.
   *
   * Keyed on `fieldName` rather than on the click, so it also fires when the
   * selection changes for any other reason and the panel is off-screen.
   */
  const editorRef = useRef<HTMLElement | null>(null);
  const editingFieldName = selectedQuery?.fieldName;
  /**
   * Bring the editor into view only when it is not already there.
   *
   * Called from the Configure button and nowhere else. It used to run from an
   * effect on the selection, which meant *ticking a checkbox* scrolled the
   * reviewer to the bottom of the page — and ticking checkboxes is how you
   * triage a 95-item list, so every approval threw away your place. That was
   * worse than the button appearing to do nothing.
   *
   * A no-op in the two-column layout, where the editor is always on screen.
   * Earns its keep only in the stacked one, below the breakpoint.
   */
  const revealEditor = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const box = editor.getBoundingClientRect();
    if (box.top >= 0 && box.top < window.innerHeight) return;
    editor.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Both counts are reported, because their difference is the thing a reviewer
  // has to understand: the model answered for some fields and proposed a subset
  // of those. A field it never mentioned is unanswered, not rejected.
  const selectedProposals = selectedQuery
    ? (fieldProposals[selectedQuery.fieldName] ?? {})
    : {};
  const answeredCount = Object.keys(selectedProposals).length;
  const proposedCount = Object.values(selectedProposals).filter(
    (proposal) => proposal.propose,
  ).length;

  const resetCompilation = () => {
    setCompileResult(undefined);
    setApprovalResult(undefined);
    setCompileError("");
    setPublishState({ status: "idle" });
  };

  const classifyQueries = async (candidates: GraphQlQueryCandidate[]) => {
    setClassificationState({
      status: "classifying",
      completed: 0,
      total: candidates.length,
    });
    try {
      const ready = await requestOperationClassifications(
        candidates.map(classificationInputForQuery),
        (progress) => setClassificationState({ status: "classifying", ...progress }),
      );
      setClassificationState(ready);
      setSelectedFields((current) => [
        ...new Set([
          ...current,
          ...candidates
            .filter(
              (query) =>
                query.support.status === "supported" &&
                ready.byOperationKey[`graphql:${query.coordinate}`]?.suggestedSelection,
            )
            .map((query) => query.fieldName),
        ]),
      ]);
    } catch (error) {
      setClassificationState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not classify queries",
      });
    }
  };

  const loadSchema = (input: string | Record<string, unknown>, label: string) => {
    try {
      const discovered = listGraphQlQueries(input, { maximumDiscoveryDepth: discoveryDepth });
      if (!discovered.length) throw new Error("No root Query fields were found");
      setSchemaInput(input);
      setSchemaLabel(label);
      setSelectedFields([]);
      setSelectedFieldName("");
      setQueryConfigurations(
        Object.fromEntries(
          discovered.map((query) => [query.fieldName, defaultQueryConfiguration(query)]),
        ),
      );
      setLoadError("");
      resetCompilation();
      void classifyQueries(discovered);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Could not read GraphQL schema",
      );
    }
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      loadSchema(parseSchemaInput(await file.text()), file.name);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Could not read selected file",
      );
    } finally {
      event.target.value = "";
    }
  };

  const updateQuery = <Key extends keyof QueryConfiguration>(
    fieldName: string,
    key: Key,
    value: QueryConfiguration[Key],
  ) => {
    setQueryConfigurations((current) => ({
      ...current,
      [fieldName]: { ...current[fieldName]!, [key]: value },
    }));
    resetCompilation();
  };

  /**
   * Asks the host's model which of this query's fields a visitor-facing view
   * would use.
   *
   * Degrades to nothing rather than to name patterns: with no provider
   * configured the server answers `usedLiveModel: false` and this says so. A
   * fallback rule like "fields ending in Id are internal" is a guess about one
   * API's naming conventions, and it fails invisibly — it looks right on the
   * schema it was written against.
   */
  const requestFieldProposals = async (query: GraphQlQueryCandidate) => {
    const config = queryConfigurations[query.fieldName];
    if (!config) return;
    setProposalState({ status: "loading" });
    try {
      const response = await fetch("/api/field-proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: {
            capabilityId: config.capabilityId,
            purpose: config.purpose || `Data returned by ${query.coordinate}.`,
            resultShape: config.resultShape,
            ...(config.dataTypeDescription
              ? { dataTypeDescription: config.dataTypeDescription }
              : {}),
          },
          fields: query.outputFields.map((field) => ({
            path: field.path,
            label: field.label,
            type: field.type,
            semanticType: config.semanticOverrides[field.path] ?? field.semanticType,
            ...(field.description ? { description: field.description } : {}),
            ...(field.deprecated ? { deprecated: true } : {}),
          })),
        }),
      });
      const payload = (await response.json()) as {
        proposals?: { path: string; propose: boolean; confidence: number; reason: string }[];
        usedLiveModel?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? `Request failed (${response.status})`);
      }
      if (!payload.usedLiveModel) {
        throw new Error(
          "The host has no live model provider configured; choose the fields manually.",
        );
      }
      setFieldProposals((current) => ({
        ...current,
        [query.fieldName]: Object.fromEntries(
          (payload.proposals ?? []).map((entry) => [entry.path, entry]),
        ),
      }));
      setProposalState({ status: "ready" });
    } catch (error) {
      setProposalState({
        status: "error",
        message: error instanceof Error ? error.message : "Field proposal request failed",
      });
    }
  };

  /**
   * Ticks every proposed field, and unticks nothing.
   *
   * The union is the point. A model that returns `propose: false` for something
   * the reviewer already approved must not undo that: the reviewer is the one
   * approving visitor access, and a control that silently reverses their
   * decisions would make this screen a suggestion box rather than a review.
   */
  const applyFieldProposals = (query: GraphQlQueryCandidate) => {
    const proposals = fieldProposals[query.fieldName];
    const config = queryConfigurations[query.fieldName];
    if (!proposals || !config) return;
    const proposed = Object.entries(proposals)
      .filter(([, proposal]) => proposal.propose)
      .map(([path]) => path);
    updateQuery(query.fieldName, "approvedFields", [
      ...new Set([...config.approvedFields, ...proposed]),
    ]);
  };

  const toggleQuery = (query: GraphQlQueryCandidate) => {
    if (query.support.status !== "supported") return;
    setSelectedFields((current) => toggle(current, query.fieldName));
    setSelectedFieldName(query.fieldName);
    resetCompilation();
  };

  const compile = () => {
    if (!schemaInput) return;
    try {
      const included = queries.filter((query) =>
        selectedFields.includes(query.fieldName),
      );
      if (!included.length) throw new Error("Include at least one supported query");
      const selections = included.map((query) => {
        const config = queryConfigurations[query.fieldName]!;
        const fields: Record<string, FieldDescriptor> = Object.fromEntries(
          query.outputFields.map((field) => [
            field.path,
            {
              label: field.label,
              ...(field.description ? { description: field.description } : {}),
              semanticType: config.semanticOverrides[field.path] ?? field.semanticType,
            },
          ]),
        );
        const scalarMappings = parseScalarMappings(config.scalarMappings);
        return {
          fieldName: query.fieldName,
          capabilityId: config.capabilityId.trim(),
          ...(config.purpose.trim() ? { purpose: config.purpose.trim() } : {}),
          dataTypeId: config.dataTypeId.trim(),
          dataTypeDescription: config.dataTypeDescription.trim(),
          resultShape: config.resultShape,
          ...(config.matchKey.trim() ? { matchKey: config.matchKey.trim() } : {}),
          fields,
          scalarMappings,
        };
      });
      const draft = createGraphQlCatalogInventory({
        schema: schemaInput,
        catalog: {
          id: catalog.catalogId.trim(),
          version: catalog.catalogVersion.trim(),
          description: catalog.catalogDescription.trim(),
        },
        source: {
          id: catalog.sourceId.trim(),
          label: catalog.sourceLabel.trim(),
          ...(catalog.sourceDescription.trim()
            ? { description: catalog.sourceDescription.trim() }
            : {}),
        },
        queries: selections,
        discoveryMaxDepth: discoveryDepth,
      });
      const approval: GraphQlCatalogDecisions = {
        schemaVersion: "1.0",
        reviewSourceHash: draft.reviewSourceHash,
        queries: included.map((query) => {
          const config = queryConfigurations[query.fieldName]!;
          const identityArguments = Object.fromEntries(
            query.arguments
              .filter((argument) => config.argumentModes[argument.name] === "identity")
              .map((argument) => [
                argument.name,
                config.identityKeys[argument.name]?.trim() || argument.name,
              ]),
          );
          const requiredPermissions = parseCommaList(config.permissions);
          return {
            capabilityId: config.capabilityId.trim(),
            approvedVisitorArguments: query.arguments
              .filter((argument) => config.argumentModes[argument.name] === "visitor")
              .map((argument) => argument.name),
            identityArguments,
            approvedOutputFields: config.approvedFields,
            requiredOutputFields: config.requiredFields,
            ...(() => {
              // A raw JSON field rather than a picker, and deliberately: the
              // keys are dotted paths into an *approved argument's* input type
              // (`"sortBy.field"`), and a control that guessed them would offer
              // paths the compile then rejects. The compile validates every key
              // and value — a key matching no enum, a value the enum does not
              // declare, or an exclusion that empties an enum all refuse — so
              // this carries the reviewer's text and lets that check speak.
              const raw = config.excludeEnumValues.trim();
              if (!raw) return {};
              try {
                return { excludeEnumValues: JSON.parse(raw) as Record<string, string[]> };
              } catch (cause) {
                // Named, because the bare parser message ("Unexpected token }")
                // says nothing about which of several JSON fields on this page
                // it came from.
                throw new Error(
                  `Withhold enum values for ${config.capabilityId} is not valid JSON: ` +
                    `${cause instanceof Error ? cause.message : String(cause)}`,
                );
              }
            })(),
            policy: {
              authentication: config.authentication,
              ...(requiredPermissions.length ? { requiredPermissions } : {}),
              maximumRows: config.maximumRows,
              ...(config.maximumPageSize > 0
                ? { maximumPageSize: config.maximumPageSize }
                : {}),
              timeoutMs: config.timeoutMs,
              cacheTtlSeconds: config.cacheTtlSeconds,
            },
            limits: {
              maximumSelectionDepth: config.maximumSelectionDepth,
              maximumSelectedFields: config.maximumSelectedFields,
              freshnessMaximumAgeSeconds: config.freshnessMaximumAgeSeconds,
            },
          };
        }),
      };
      setCompileResult(compileApprovedGraphQlCatalog(schemaInput, draft, approval));
      setApprovalResult(approval);
      setCompileError("");
    } catch (error) {
      setCompileResult(undefined);
      setApprovalResult(undefined);
      setCompileError(
        error instanceof Error ? error.message : "Could not compile GraphQL approval",
      );
    }
  };

  const publish = async () => {
    if (!compileResult || !schemaInput) return;
    if (!graphqlEndpoint.trim()) {
      setPublishState({
        status: "error",
        message: "Enter the reviewed GraphQL endpoint",
      });
      return;
    }
    setPublishState({ status: "publishing" });
    try {
      const response = await fetch("/api/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bindingKind: "graphql",
          catalog: compileResult.catalog,
          bindings: Object.fromEntries(compileResult.bindings),
          schema: schemaInput,
          endpoint: graphqlEndpoint.trim(),
          ...(graphqlCredentialId.trim()
            ? { credentialId: graphqlCredentialId.trim() }
            : {}),
        }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Publish failed (${response.status})`,
        );
      }
      setPublishState({ status: "published", summary: payload });
    } catch (error) {
      setPublishState({
        status: "error",
        message: error instanceof Error ? error.message : "Publish failed",
      });
    }
  };

  if (!onboardingMode) {
    return (
      <main>
        <header className="hero">
          <div>
            <p className="eyebrow">RenderYes · GraphQL onboarding</p>
            <h1>How was this GraphQL API prepared?</h1>
            <p className="lede">
              Choose the shortest safe route. Both options compile into the same
              capability catalog and trusted runtime bindings.
            </p>
          </div>
        </header>
        <section className="mode-choice-panel">
          <button
            className="mode-choice primary"
            onClick={() => setOnboardingMode("curated")}
          >
            <strong>Curated GraphQL API</strong>
            <span>
              This endpoint intentionally exposes only visitor-safe read data. Confirm
              shared limits once and publish the whole Query surface.
            </span>
          </button>
          <button className="mode-choice" onClick={() => setOnboardingMode("detailed")}>
            <strong>Review an existing GraphQL API</strong>
            <span>
              Select queries, arguments, fields, identity mappings, permissions, and
              limits individually for a broad or internal schema.
            </span>
          </button>
        </section>
      </main>
    );
  }

  if (onboardingMode === "curated") {
    return (
      <CuratedGraphQlOnboarding
        onUseDetailedReview={() => setOnboardingMode("detailed")}
      />
    );
  }

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">RenderYes · local developer tool</p>
          <h1>GraphQL Catalog Review</h1>
          <p className="lede">
            Discover a schema, then let the host approve every query, argument, field,
            identity mapping, permission and operational limit.
          </p>
        </div>
        <div className="local-note">
          <strong>Local review</strong>
          <span>
            Schema metadata may be sent to the host-configured model; credentials and
            records are not.
          </span>
        </div>
        <button onClick={() => setOnboardingMode(undefined)}>
          Choose onboarding mode
        </button>
      </header>

      <section className="load-panel">
        <div>
          <p className="eyebrow">Step 1</p>
          <h2>Load the GraphQL schema</h2>
          <p>
            Use SDL or introspection JSON. Discovery proposes candidates and never grants
            planner access automatically.
          </p>
          <label className="depth-control">
            Field discovery depth
            <input
              type="number"
              min="1"
              max="12"
              value={discoveryDepth}
              onChange={(event) => setDiscoveryDepth(Number(event.target.value))}
            />
            <span>
              Reload the schema after changing this. Each query&rsquo;s discovery
              notes name the fields a stop here put out of reach.
            </span>
          </label>
        </div>
        <div className="load-actions">
          <label className="file-button">
            Choose schema file
            <input
              type="file"
              accept=".graphql,.gql,.json,text/plain,application/json"
              onChange={onFileChange}
            />
          </label>
          <button
            onClick={() => loadSchema(sampleGraphQlSchema, "Built-in product schema")}
          >
            Load sample
          </button>
        </div>
        <label className="paste-label">
          Or paste SDL or introspection JSON
          <textarea
            value={pasteValue}
            onChange={(event) => setPasteValue(event.target.value)}
            placeholder="type Query { products: [Product!]! }"
            rows={7}
          />
        </label>
        <button
          className="primary parse-button"
          onClick={() => {
            try {
              loadSchema(parseSchemaInput(pasteValue), "Pasted GraphQL schema");
            } catch (error) {
              setLoadError(
                error instanceof Error ? error.message : "Could not parse schema",
              );
            }
          }}
        >
          Parse locally
        </button>
        {loadError ? (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        ) : null}
        {schemaInput ? (
          <p className="success-message">
            Loaded: {schemaLabel} · {queries.length} root Query field
            {queries.length === 1 ? "" : "s"}
          </p>
        ) : null}
      </section>

      {schemaInput ? (
        <>
          {/*
            * List and editor side by side, and the editor stays put.
            *
            * They were siblings, so the editor rendered after the *entire*
            * list — 7,000px down on a 95-query schema. Scrolling to it was a
            * patch on the wrong thing: it made ticking a checkbox yank the
            * reviewer off the list they were triaging, which is worse than the
            * button appearing to do nothing. Nothing here scrolls now, because
            * nothing needs to.
            */}
          <div className="review-workspace">
          <section className="configure-panel">
            <div className="step-heading">
              <div>
                <p className="eyebrow">Step 2</p>
                <h2>Approve the graph surface</h2>
                <p>
                  Unsupported queries remain visible for explanation but cannot be
                  included.
                </p>
              </div>
              <aside className="approval-cart">
                <strong>{selectedFields.length} selected</strong>
                <span>
                  {queries.filter((query) => query.support.status === "supported").length}{" "}
                  technically supported
                </span>
                <button
                  onClick={() => void classifyQueries(queries)}
                  disabled={classificationState.status === "classifying"}
                >
                  {classificationState.status === "classifying"
                    ? "Classifying…"
                    : "Classify again"}
                </button>
                <button className="primary" onClick={compile}>
                  Compile approval
                </button>
              </aside>
            </div>

            {/*
              * Sticky, because it is useless where you cannot reach it: about
              * 14 of 95 rows fit on a laptop, so the top of the list is
              * off-screen for most of the time a reviewer spends in it.
              */}
            <div className="list-toolbar">
              <input
                type="search"
                className="list-filter"
                value={queryFilter}
                onChange={(event) => setQueryFilter(event.target.value)}
                placeholder={`Filter ${queries.length} queries by name or description`}
                aria-label="Filter queries"
              />
              <label className="list-toggle">
                <input
                  type="checkbox"
                  checked={approvedOnly}
                  onChange={(event) => setApprovedOnly(event.target.checked)}
                />
                <span>Approved only</span>
              </label>
              <p className="list-count">
                {/* Always the whole schema, never the filtered view — a count
                    that moved with the filter would be answering a different
                    question from the one a reviewer is asking. */}
                <strong>
                  {selectedFields.length} of {queries.length}
                </strong>{" "}
                approved
                {visibleQueries.length !== queries.length ? (
                  <span> · showing {visibleQueries.length}</span>
                ) : null}
              </p>
            </div>
            {visibleQueries.length === 0 ? (
              <p className="form-hint">
                Nothing matches{queryFilter.trim() ? ` “${queryFilter.trim()}”` : ""}
                {approvedOnly ? " among approved queries" : ""}. Approvals are
                unaffected by the filter.
              </p>
            ) : null}

            {classificationState.status === "error" ? (
              <p className="form-error" role="alert">
                {classificationState.message}
              </p>
            ) : null}
            {classificationState.status === "ready" ? (
              <p className="classification-source">
                {classificationState.usedLiveModel
                  ? "Live model suggestions (cached when unchanged). The host must still approve each query."
                  : "Conservative fallback only — configure a live model on the host."}
              </p>
            ) : null}

            {/*
              * Collapsed, because it is set-once catalog metadata sitting in a
              * navigation column. It cost 274px of a 943px panel, and together with
              * the rest of the header left room for 3 of 95 capability rows.
              */}
            <details className="catalog-form-details">
              <summary>Catalog and source details</summary>
              <div className="catalog-form">
              <label>
                Catalog ID
                <input
                  value={catalog.catalogId}
                  onChange={(event) => {
                    setCatalog({ ...catalog, catalogId: event.target.value });
                    resetCompilation();
                  }}
                />
              </label>
              <label>
                Catalog version
                <input
                  value={catalog.catalogVersion}
                  onChange={(event) => {
                    setCatalog({ ...catalog, catalogVersion: event.target.value });
                    resetCompilation();
                  }}
                />
              </label>
              <label className="wide">
                Catalog description
                <input
                  value={catalog.catalogDescription}
                  onChange={(event) => {
                    setCatalog({ ...catalog, catalogDescription: event.target.value });
                    resetCompilation();
                  }}
                />
              </label>
              <label>
                Source ID
                <input
                  value={catalog.sourceId}
                  onChange={(event) => {
                    setCatalog({ ...catalog, sourceId: event.target.value });
                    resetCompilation();
                  }}
                />
              </label>
              <label>
                Source label
                <input
                  value={catalog.sourceLabel}
                  onChange={(event) => {
                    setCatalog({ ...catalog, sourceLabel: event.target.value });
                    resetCompilation();
                  }}
                />
              </label>
              <label className="wide">
                Source description
                <input
                  value={catalog.sourceDescription}
                  onChange={(event) => {
                    setCatalog({ ...catalog, sourceDescription: event.target.value });
                    resetCompilation();
                  }}
                />
              </label>
            </div>
            </details>

            <div className="operation-list graphql-query-list">
              {visibleQueries.map((query) => {
                const selected = selectedFields.includes(query.fieldName);
                const classification =
                  classificationState.status === "ready"
                    ? classificationState.byOperationKey[`graphql:${query.coordinate}`]
                    : undefined;
                return (
                  <article
                    className={`operation-row ${selected ? "included" : ""} ${
                      // Distinct from `included`: a capability can be approved
                      // without being the one open in the editor, and with the
                      // editor a screen away that difference is invisible.
                      query.fieldName === editingFieldName ? "editing" : ""
                    }`}
                    key={query.coordinate}
                  >
                    <div className="operation-main">
                      <label>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={query.support.status !== "supported"}
                          onChange={() => toggleQuery(query)}
                        />
                        <span>
                          <strong>{query.description ?? query.coordinate}</strong>
                          <code>
                            {query.coordinate}: {query.returnType}
                          </code>
                        </span>
                      </label>
                      <div className="operation-badges">
                        <span className={`badge ${query.support.status}`}>
                          {query.support.status}
                        </span>
                        {classification ? (
                          <span
                            className={`badge ${classification.source === "fallback" ? "effect-fallback" : `effect-${classification.effect}`}`}
                          >
                            {classification.source === "fallback"
                              ? `Fallback · ${Math.round(classification.confidence * 100)}%`
                              : `${effectLabel(classification.effect)} · ${Math.round(classification.confidence * 100)}%`}
                          </span>
                        ) : null}
                      </div>
                      {classification ? (
                        <details className="classification-details">
                          <summary>Why this suggestion?</summary>
                          <p>{classification.reason}</p>
                          {classification.riskSignals.length ? (
                            <p>Signals: {classification.riskSignals.join(", ")}</p>
                          ) : null}
                          <small>Source: {classification.source}</small>
                        </details>
                      ) : null}
                      {query.support.reason ? (
                        <small className="support-reason">{query.support.reason}</small>
                      ) : null}
                      <button
                        className="configure-button"
                        disabled={!selected}
                        onClick={() => {
                          setSelectedFieldName(query.fieldName);
                          revealEditor();
                        }}
                      >
                        {/* No arrow: the editor is below in the stacked layout
                            and to the right in the two-column one, so any
                            direction is wrong half the time. The highlighted
                            row is what says which capability is open. */}
                        {query.fieldName === editingFieldName ? "Editing" : "Configure"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {selectedQuery && selectedConfiguration ? (
            <section className="review-panel graphql-review-panel" ref={editorRef}>
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">
                    {selectedQuery.coordinate}
                    {/* The return trip. Scrolling down to the editor is
                        automatic; scrolling back up past it was not, and on a
                        long schema that is a lot of wheel. */}
                    <button
                      type="button"
                      className="back-to-list"
                      onClick={() =>
                        document
                          .querySelector(".configure-panel")
                          ?.scrollIntoView({ behavior: "smooth", block: "start" })
                      }
                    >
                      ↑ back to the list
                    </button>
                  </p>
                  <h2>Capability, access and query scope</h2>
                  <p>
                    Every setting below is supplied by the host and bound into the
                    approval.
                  </p>
                </div>
                <span className="pill">{selectedQuery.returnType}</span>
              </div>

              <div className="form-grid">
                <label>
                  Capability ID
                  <input
                    value={selectedConfiguration.capabilityId}
                    onChange={(event) =>
                      updateQuery(
                        selectedQuery.fieldName,
                        "capabilityId",
                        event.target.value,
                      )
                    }
                  />
                </label>
                <label>
                  Data type ID
                  <input
                    value={selectedConfiguration.dataTypeId}
                    onChange={(event) =>
                      updateQuery(
                        selectedQuery.fieldName,
                        "dataTypeId",
                        event.target.value,
                      )
                    }
                  />
                </label>
                <label>
                  Result shape
                  <select
                    value={selectedConfiguration.resultShape}
                    onChange={(event) =>
                      updateQuery(
                        selectedQuery.fieldName,
                        "resultShape",
                        event.target.value as ResultShape,
                      )
                    }
                  >
                    {resultShapes.map((shape) => (
                      <option key={shape}>{shape}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Match key
                  <input
                    value={selectedConfiguration.matchKey}
                    onChange={(event) =>
                      updateQuery(selectedQuery.fieldName, "matchKey", event.target.value)
                    }
                    placeholder="id"
                  />
                </label>
                <label className="wide">
                  Planner-facing purpose
                  <input
                    value={selectedConfiguration.purpose}
                    onChange={(event) =>
                      updateQuery(selectedQuery.fieldName, "purpose", event.target.value)
                    }
                  />
                </label>
                <label className="wide">
                  Data type description
                  <input
                    value={selectedConfiguration.dataTypeDescription}
                    onChange={(event) =>
                      updateQuery(
                        selectedQuery.fieldName,
                        "dataTypeDescription",
                        event.target.value,
                      )
                    }
                  />
                </label>
              </div>

              <section className="review-section">
                <div className="section-copy">
                  <h3>Argument ownership</h3>
                  <p>
                    Required arguments must be visitor-controlled or mapped from trusted
                    identity.
                  </p>
                </div>
                <div className="graphql-argument-list">
                  {selectedQuery.arguments.length ? (
                    selectedQuery.arguments.map((argument) => {
                      const mode =
                        selectedConfiguration.argumentModes[argument.name] ?? "excluded";
                      return (
                        <div className="graphql-argument" key={argument.name}>
                          <div>
                            <strong>{argument.name}</strong>
                            <code>{argument.type}</code>
                            {argument.required ? (
                              <span className="badge admin">required</span>
                            ) : null}
                          </div>
                          <select
                            aria-label={`Ownership for ${argument.name}`}
                            value={mode}
                            onChange={(event) => {
                              const nextMode = event.target.value as ArgumentMode;
                              updateQuery(selectedQuery.fieldName, "argumentModes", {
                                ...selectedConfiguration.argumentModes,
                                [argument.name]: nextMode,
                              });
                              if (nextMode === "identity") {
                                updateQuery(
                                  selectedQuery.fieldName,
                                  "authentication",
                                  "session",
                                );
                              }
                            }}
                          >
                            <option value="excluded">Excluded</option>
                            <option value="visitor">Visitor parameter</option>
                            <option value="identity">Trusted identity</option>
                          </select>
                          {mode === "identity" ? (
                            <input
                              aria-label={`Trusted identity key for ${argument.name}`}
                              value={
                                selectedConfiguration.identityKeys[argument.name] ?? ""
                              }
                              placeholder={`Session key, e.g. ${argument.name}`}
                              onChange={(event) =>
                                updateQuery(selectedQuery.fieldName, "identityKeys", {
                                  ...selectedConfiguration.identityKeys,
                                  [argument.name]: event.target.value,
                                })
                              }
                            />
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    <p className="muted">This query has no arguments.</p>
                  )}
                </div>
              </section>

              <section className="review-section">
                <div className="section-copy">
                  <h3>Approved output fields</h3>
                  <p>
                    Only checked leaf fields can appear in a model-proposed structured
                    query.
                  </p>
                  <div className="proposal-actions">
                    <button
                      type="button"
                      disabled={proposalState.status === "loading"}
                      onClick={() => void requestFieldProposals(selectedQuery)}
                    >
                      {proposalState.status === "loading"
                        ? "Asking…"
                        : "Propose fields with AI"}
                    </button>
                    {proposedCount > 0 ? (
                      <button type="button" onClick={() => applyFieldProposals(selectedQuery)}>
                        Tick the {proposedCount} proposed
                      </button>
                    ) : null}
                  </div>
                  {proposalState.status === "error" ? (
                    <p className="form-error" role="alert">
                      {proposalState.message}
                    </p>
                  ) : null}
                  {proposalState.status === "ready" && answeredCount > 0 ? (
                    <p className="form-hint">
                      The model answered for {answeredCount} of{" "}
                      {selectedQuery.outputFields.length} fields and proposed{" "}
                      {proposedCount}. Ticking them adds to your selection and removes
                      nothing; a field it said nothing about is not a rejection.
                    </p>
                  ) : null}
                </div>
                {/*
                  * Bulk controls, because the list below is not a list of five.
                  * A real schema puts hundreds of checkboxes here — Saleor's
                  * `products` alone has over 400 — and the only way to approve
                  * or clear them was one click each. Reviewers did not do that;
                  * they went back to the CLI, or approved nothing and shipped a
                  * catalog that answers less than they meant.
                  *
                  * "Clear" also unticks required fields, which are a subset by
                  * definition: leaving a field required but unapproved compiles
                  * to a catalog that names a field it never selected.
                  */}
                <div className="bulk-actions">
                  <span className="bulk-count">
                    {selectedConfiguration.approvedFields.length} of{" "}
                    {selectedQuery.outputFields.length} approved
                  </span>
                  <button
                    type="button"
                    disabled={
                      selectedConfiguration.approvedFields.length ===
                      selectedQuery.outputFields.length
                    }
                    onClick={() =>
                      updateQuery(
                        selectedQuery.fieldName,
                        "approvedFields",
                        selectedQuery.outputFields.map((field) => field.path),
                      )
                    }
                  >
                    Approve all {selectedQuery.outputFields.length}
                  </button>
                  <button
                    type="button"
                    disabled={selectedConfiguration.approvedFields.length === 0}
                    onClick={() => {
                      updateQuery(selectedQuery.fieldName, "approvedFields", []);
                      updateQuery(selectedQuery.fieldName, "requiredFields", []);
                    }}
                  >
                    Clear
                  </button>
                  <span className="bulk-note">
                    Approving every field is a starting point, not a review — each
                    one is a field a visitor may read.
                  </span>
                </div>
                <ul className="approval-list">
                  {selectedQuery.outputFields.map((field) => {
                    const approved = selectedConfiguration.approvedFields.includes(
                      field.path,
                    );
                    const required = selectedConfiguration.requiredFields.includes(
                      field.path,
                    );
                    return (
                      <li
                        className={approved ? "approved" : "not-approved"}
                        key={field.path}
                      >
                        <label>
                          <input
                            type="checkbox"
                            checked={approved}
                            onChange={() => {
                              updateQuery(
                                selectedQuery.fieldName,
                                "approvedFields",
                                toggle(selectedConfiguration.approvedFields, field.path),
                              );
                              if (required) {
                                updateQuery(
                                  selectedQuery.fieldName,
                                  "requiredFields",
                                  selectedConfiguration.requiredFields.filter(
                                    (entry) => entry !== field.path,
                                  ),
                                );
                              }
                            }}
                          />
                          <span>
                            <strong>{field.label}</strong>
                            <code>
                              {field.path}: {field.type}
                            </code>
                            {field.description ? (
                              <small>{field.description}</small>
                            ) : null}
                            {/*
                              The reason, not just the verdict. A badge saying
                              "include, 92%" is a thing to obey; a badge saying
                              why is a thing to check, which is what a review is
                              for. Shown for rejections too — "the model looked
                              at this and said no" is information the reviewer
                              would otherwise have to infer from silence.
                            */}
                            {selectedProposals[field.path] ? (
                              <span
                                className={
                                  selectedProposals[field.path]!.propose
                                    ? "ai-suggestion"
                                    : "ai-suggestion muted-suggestion"
                                }
                                title={selectedProposals[field.path]!.reason}
                              >
                                AI:{" "}
                                {selectedProposals[field.path]!.propose
                                  ? "include"
                                  : "leave out"}{" "}
                                ({Math.round(
                                  selectedProposals[field.path]!.confidence * 100,
                                )}
                                %)
                              </span>
                            ) : null}
                          </span>
                        </label>
                        <select
                          aria-label={`Semantic type for ${field.path}`}
                          value={
                            selectedConfiguration.semanticOverrides[field.path] ??
                            field.semanticType
                          }
                          onChange={(event) =>
                            updateQuery(selectedQuery.fieldName, "semanticOverrides", {
                              ...selectedConfiguration.semanticOverrides,
                              [field.path]: event.target.value as SemanticType,
                            })
                          }
                        >
                          {semanticTypes.map((semanticType) => (
                            <option key={semanticType}>{semanticType}</option>
                          ))}
                        </select>
                        <label className="required-field">
                          <input
                            type="checkbox"
                            checked={required}
                            disabled={!approved}
                            onChange={() =>
                              updateQuery(
                                selectedQuery.fieldName,
                                "requiredFields",
                                toggle(selectedConfiguration.requiredFields, field.path),
                              )
                            }
                          />
                          Always select
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="review-section">
                <div className="section-copy">
                  <h3>Host security and operating policy</h3>
                  <p>
                    These values are declarations for RenderYes’s trusted server
                    enforcement.
                  </p>
                </div>
                <div className="form-grid">
                  <label>
                    Authentication
                    <select
                      value={selectedConfiguration.authentication}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "authentication",
                          event.target.value as "public" | "session",
                        )
                      }
                    >
                      <option value="public">Public</option>
                      <option value="session">Session</option>
                    </select>
                  </label>
                  <label>
                    Required permissions
                    <input
                      value={selectedConfiguration.permissions}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "permissions",
                          event.target.value,
                        )
                      }
                      placeholder="inventory:read, products:view"
                    />
                  </label>
                  <label>
                    Maximum rows
                    <input
                      type="number"
                      min="1"
                      value={selectedConfiguration.maximumRows}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "maximumRows",
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label className="wide">
                    Withhold enum values (optional)
                    <textarea
                      rows={3}
                      value={selectedConfiguration.excludeEnumValues}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "excludeEnumValues",
                          event.target.value,
                        )
                      }
                      placeholder={'{ "sortBy.field": ["RANK"] }'}
                    />
                    <span className="field-hint">
                      Keyed by dotted path inside an approved argument. The values
                      are stripped from the planner&rsquo;s input schema, so a plan
                      naming one fails validation instead of execution — the remedy
                      for an enum value the API only accepts under conditions the
                      schema cannot express.
                    </span>
                  </label>
                  <label>
                    {/*
                      * Distinct from Maximum rows, and the difference is the one
                      * reviewers get wrong. Maximum rows is how many this system
                      * will hold; this is the largest `first` the *upstream*
                      * accepts on a connection — Saleor and GitHub cap at 100,
                      * Shopify at 250 — and asking for more is rejected outright,
                      * so the two cannot be the same number.
                      */}
                    Upstream page cap
                    <input
                      type="number"
                      min="0"
                      value={selectedConfiguration.maximumPageSize}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "maximumPageSize",
                          Number(event.target.value),
                        )
                      }
                    />
                    <span className="field-hint">
                      0 to leave it undeclared. Execution fetches one page, so this
                      is the effective row ceiling regardless of Maximum rows.
                    </span>
                  </label>
                  <label>
                    Timeout (ms)
                    <input
                      type="number"
                      min="1"
                      value={selectedConfiguration.timeoutMs}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "timeoutMs",
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label>
                    Cache TTL (seconds)
                    <input
                      type="number"
                      min="0"
                      value={selectedConfiguration.cacheTtlSeconds}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "cacheTtlSeconds",
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label>
                    Freshness maximum age (seconds)
                    <input
                      type="number"
                      min="0"
                      value={selectedConfiguration.freshnessMaximumAgeSeconds}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "freshnessMaximumAgeSeconds",
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label>
                    Maximum query depth
                    <input
                      type="number"
                      min="1"
                      max="12"
                      value={selectedConfiguration.maximumSelectionDepth}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "maximumSelectionDepth",
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label>
                    Maximum selected fields
                    <input
                      type="number"
                      min="1"
                      max="500"
                      value={selectedConfiguration.maximumSelectedFields}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "maximumSelectedFields",
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label className="wide">
                    Custom scalar mappings (JSON)
                    <textarea
                      rows={4}
                      value={selectedConfiguration.scalarMappings}
                      onChange={(event) =>
                        updateQuery(
                          selectedQuery.fieldName,
                          "scalarMappings",
                          event.target.value,
                        )
                      }
                      placeholder={
                        '{ "DateTime": { "schema": { "type": "string", "format": "date-time" }, "semanticType": "date-time" } }'
                      }
                    />
                  </label>
                </div>
              </section>
            </section>
          ) : null}
          </div>

          <section className="export-panel graphql-export">
            <p className="eyebrow">Step 3 · compile</p>
            <h2>
              {compileResult
                ? "Approved GraphQL catalog ready"
                : "Compile the reviewed surface"}
            </h2>
            <p>
              The exported approval is fingerprint-bound to the reviewed schema and
              configuration.
            </p>
            <button className="primary" onClick={compile}>
              Compile approval
            </button>
            {compileError ? (
              <p className="form-error" role="alert">
                {compileError}
              </p>
            ) : null}
            {compileResult && approvalResult ? (
              <>
                <div className="export-actions">
                  <button
                    onClick={() =>
                      downloadJson(approvalResult, "graphql-catalog-decisions.json")
                    }
                  >
                    Download decisions
                  </button>
                  <button
                    onClick={() =>
                      downloadJson(compileResult.catalog, "capability-catalog.json")
                    }
                  >
                    Download capability catalog
                  </button>
                  <button
                    onClick={() =>
                      downloadJson(compileResult.plannerManifest, "planner-manifest.json")
                    }
                  >
                    Download planner manifest
                  </button>
                  {/* Server-only: the bindings are what a host runtime needs to
                      actually execute an approved capability. Without them the
                      catalog describes data nobody can fetch. Never ship this
                      file to the browser or to a model. */}
                  <button
                    onClick={() =>
                      downloadJson(
                        Object.fromEntries(compileResult.bindings),
                        "server-bindings.json",
                      )
                    }
                  >
                    Download server bindings
                  </button>
                </div>
                <pre>{JSON.stringify(compileResult.plannerManifest, null, 2)}</pre>
              </>
            ) : null}
          </section>
          {compileResult ? (
            <section
              className="export-panel graphql-export"
              aria-label="Publish GraphQL catalog to host"
            >
              <p className="eyebrow">Step 4 · publish</p>
              <h2>Register with the running host</h2>
              <p>
                Sends the approved catalog, reviewed schema and server-only bindings to
                the local RenderYes host. The host keeps the endpoint and bindings away
                from the planner and resolves credentials from each trusted visitor
                session.
              </p>
              <label className="paste-label">
                GraphQL endpoint
                <span> (the reviewed graph that will execute approved queries)</span>
                <input
                  type="url"
                  value={graphqlEndpoint}
                  onChange={(event) => {
                    setGraphqlEndpoint(event.target.value);
                    setPublishState({ status: "idle" });
                  }}
                  placeholder="http://127.0.0.1:4000/graphql"
                />
              </label>
              <label className="paste-label">
                {/*
                  * Both doors, or it is not parity. The curated flow and the
                  * headless `compile --credential-id` both had this; this one
                  * did not, so a reviewer whose upstream needs a credential
                  * could review here and then had to publish somewhere else.
                  */}
                Upstream credential id
                <span> (optional — a key into the host&rsquo;s upstreamCredentials, never a secret)</span>
                <input
                  type="text"
                  value={graphqlCredentialId}
                  onChange={(event) => {
                    setGraphqlCredentialId(event.target.value);
                    setPublishState({ status: "idle" });
                  }}
                  placeholder="e.g. saleor-service-account"
                />
              </label>
              <div className="export-actions">
                <button
                  className="primary"
                  disabled={publishState.status === "publishing"}
                  onClick={publish}
                >
                  {publishState.status === "publishing"
                    ? "Publishing…"
                    : "Publish to host"}
                </button>
              </div>
              {publishState.status === "error" ? (
                <p className="form-error" role="alert">
                  {publishState.message}
                </p>
              ) : null}
              {publishState.status === "published" ? (
                <>
                  <p className="success-message">
                    Registered {String(publishState.summary.catalogId)} · hash{" "}
                    {String(publishState.summary.catalogHash)} ·{" "}
                    {String(publishState.summary.executableCapabilityCount)}/
                    {String(publishState.summary.capabilityCount)} capabilities
                    executable.
                  </p>
                  <CatalogProbePanel
                    catalogId={String(publishState.summary.catalogId)}
                    publishToken=""
                  />
                  <pre>{JSON.stringify(publishState.summary, null, 2)}</pre>
                </>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
