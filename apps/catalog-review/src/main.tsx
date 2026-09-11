import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  compileApprovedOpenApiCatalog,
  createOpenApiCatalogInventory,
  listOpenApiGetOperations,
  listOpenApiOperations,
} from "@renderyes/capability-catalog/openapi";
import type {
  OpenApiCatalogDecisions,
  OpenApiCatalogInventory,
  OpenApiCatalogReviewOptions,
  OpenApiGetOperation,
  OpenApiOperationCandidate,
  OpenApiOperationInventory,
} from "@renderyes/capability-catalog/openapi";
import type { ResultShape } from "@renderyes/capability-catalog";
import type { ReviewableItem } from "@renderyes/capability-catalog/review";
import { GraphQlReviewApp } from "./graphql-panel.js";
import {
  effectLabel,
  requestOperationClassifications,
  type ClassificationState,
} from "./operation-classification.js";
import { sampleOpenApiDocument } from "./sample.js";
import "./styles.css";

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

type CatalogConfiguration = {
  catalogId: string;
  catalogVersion: string;
  catalogDescription: string;
  sourceId: string;
  sourceLabel: string;
  sourceDescription: string;
  sourceCanonicalUrl: string;
};
type OperationConfiguration = {
  capabilityId: string;
  purpose: string;
  dataTypeId: string;
  dataTypeDescription: string;
  resultShape: ResultShape;
  requiredSessionKeys: string;
};
type OperationGroup = {
  id: string;
  label: string;
  operations: OpenApiOperationCandidate[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
function documentTitle(document: unknown): string {
  const info = asRecord(asRecord(document)?.info);
  return typeof info?.title === "string" ? info.title : "OpenAPI";
}
function operationKey(
  operation: Pick<OpenApiOperationCandidate, "path" | "method" | "operationId">,
): string {
  return `${operation.path}:${operation.operationId ?? operation.method}`;
}
function candidateKey(operation: OpenApiOperationCandidate): string {
  return operation.classificationInput.operationKey;
}
function groupFor(operation: OpenApiOperationCandidate): { id: string; label: string } {
  if (operation.tags[0])
    return { id: `tag:${operation.tags[0]}`, label: operation.tags[0] };
  const segments = operation.path.split("/").filter(Boolean);
  const index = segments[0] === "api" && segments[1]?.match(/^v\d+$/) ? 2 : 0;
  const value = segments[index] ?? "Other";
  return {
    id: `path:${value}`,
    label: value
      .replaceAll("-", " ")
      .replace(/\b\w/g, (character) => character.toUpperCase()),
  };
}
function groupedOperations(operations: OpenApiOperationCandidate[]): OperationGroup[] {
  const groups = new Map<string, OperationGroup>();
  operations.forEach((operation) => {
    const group = groupFor(operation);
    const existing = groups.get(group.id);
    if (existing) existing.operations.push(operation);
    else groups.set(group.id, { ...group, operations: [operation] });
  });
  return [...groups.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}
function initialCatalogConfiguration(document: unknown): CatalogConfiguration {
  const title = documentTitle(document);
  return {
    catalogId: `${slug(title, "openapi")}-catalog`,
    catalogVersion: "1.0.0",
    catalogDescription: `Approved capabilities from ${title}.`,
    sourceId: `${slug(title, "openapi")}-source`,
    sourceLabel: title,
    sourceDescription: "",
    sourceCanonicalUrl: "",
  };
}
function initialOperationConfiguration(
  operation: OpenApiOperationCandidate,
): OperationConfiguration {
  const operationName = operation.operationId ?? operation.path;
  const dataTypeId = slug(
    operationName.replace(/^(list|get|search|find|create|update|delete)/i, ""),
    "record",
  );
  return {
    capabilityId: `${dataTypeId}.query`,
    purpose: operation.summary ?? operation.description ?? "",
    dataTypeId,
    dataTypeDescription: `A record returned by ${operationName}.`,
    resultShape: "collection",
    requiredSessionKeys: "",
  };
}
function parseOpenApiJson(text: string): unknown {
  if (!text.trim()) throw new Error("Paste an OpenAPI JSON document first");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      "Could not parse JSON. This first review tool accepts OpenAPI 3.x JSON files only.",
    );
  }
}
function createOptions(
  document: unknown,
  catalog: CatalogConfiguration,
  entries: Array<{
    operation: Pick<OpenApiOperationCandidate, "operationId" | "path" | "method">;
    config: OperationConfiguration;
  }>,
): OpenApiCatalogReviewOptions {
  return {
    document,
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
      ...(catalog.sourceCanonicalUrl.trim()
        ? { canonicalUrl: catalog.sourceCanonicalUrl.trim() }
        : {}),
    },
    operations: entries.map(({ operation, config }) => {
      const sessionKeys = config.requiredSessionKeys
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const purpose = config.purpose.trim();
      const dataTypeDescription = config.dataTypeDescription.trim();
      return {
        ...(operation.operationId
          ? { operationId: operation.operationId, method: operation.method }
          : { path: operation.path, method: operation.method }),
        capabilityId: config.capabilityId.trim(),
        ...(purpose ? { purpose } : {}),
        dataTypeId: config.dataTypeId.trim(),
        ...(dataTypeDescription ? { dataTypeDescription } : {}),
        resultShape: config.resultShape,
        ...(sessionKeys.length ? { requiredSessionKeys: sessionKeys } : {}),
        // No policy here any more. Reviewing is where the access decision gets
        // made, so it belongs on the approval, not on the review input — and it
        // used to be *derived* here from whether the reviewer happened to type a
        // session key, which is not a decision anybody made.
      };
    }),
  };
}
const SENSITIVE_OR_INTERNAL_NAME =
  /(?:password|passcode|secret|token|api[_-]?key|authorization|cookie|session|credential|ssn|social|email|phone|address|payment|card|bank|salary|cost|profit|internal|admin|audit|debug|trace|raw)/i;

function isSafeDefaultParameter(
  parameter: OpenApiOperationInventory["availableVisitorParameters"][number],
): boolean {
  const evidence = `${parameter.transportName} ${parameter.description ?? ""}`;
  // Path values commonly address an arbitrary record, and must remain an
  // explicit host decision even in an otherwise read-only capability.
  return parameter.location !== "path" && !SENSITIVE_OR_INTERNAL_NAME.test(evidence);
}

function isSafeDefaultOutput(
  field: OpenApiOperationInventory["availableOutputFields"][number],
): boolean {
  const evidence = `${field.id} ${field.label} ${field.description ?? ""}`;
  // Unknown fields are frequently nested/raw payloads. Do not expose one just
  // because the endpoint itself was classified as a read.
  return field.semanticType !== "unknown" && !SENSITIVE_OR_INTERNAL_NAME.test(evidence);
}

function newApproval(draft: OpenApiCatalogInventory): OpenApiCatalogDecisions {
  return {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    operations: draft.operations.map((operation) => ({
      capabilityId: operation.capabilityId,
      approvedVisitorParameters: operation.availableVisitorParameters
        .filter(isSafeDefaultParameter)
        .map((parameter) => parameter.id),
      approvedOutputFields: operation.availableOutputFields
        .filter(isSafeDefaultOutput)
        .map((field) => field.id),
      // Fail closed, and never inferred. `session` means the host's own
      // authentication and permission checks run; `public` skips both. A
      // reviewer who genuinely wants an open capability changes it deliberately,
      // which is the same default the GraphQL panel starts from.
      policy: { authentication: "session" as const },
    })),
  };
}
function approvalFor(approval: OpenApiCatalogDecisions, capabilityId: string) {
  const current = approval.operations.find(
    (operation) => operation.capabilityId === capabilityId,
  );
  if (!current) throw new Error(`Missing approval state for ${capabilityId}`);
  return current;
}
function updateApproval(
  approval: OpenApiCatalogDecisions,
  capabilityId: string,
  collection: "approvedVisitorParameters" | "approvedOutputFields",
  itemId: string,
): OpenApiCatalogDecisions {
  return {
    ...approval,
    operations: approval.operations.map((operation) =>
      operation.capabilityId !== capabilityId
        ? operation
        : {
            ...operation,
            [collection]: operation[collection].includes(itemId)
              ? operation[collection].filter((item) => item !== itemId)
              : [...operation[collection], itemId],
          },
    ),
  };
}
function setApprovalAuthentication(
  approval: OpenApiCatalogDecisions,
  capabilityId: string,
  authentication: "public" | "session",
): OpenApiCatalogDecisions {
  return {
    ...approval,
    operations: approval.operations.map((operation) =>
      operation.capabilityId !== capabilityId
        ? operation
        : { ...operation, policy: { ...operation.policy, authentication } },
    ),
  };
}
function reviewableParameters(
  operation: OpenApiOperationInventory,
  approval: OpenApiCatalogDecisions,
): ReviewableItem[] {
  const selected = approvalFor(
    approval,
    operation.capabilityId,
  ).approvedVisitorParameters;
  return operation.availableVisitorParameters.map((parameter) => ({
    id: parameter.id,
    label: `${parameter.label}${parameter.location === "body" ? " (POST body)" : ""}${parameter.required ? " (required)" : ""}`,
    approved: selected.includes(parameter.id),
    ...(parameter.description ? { description: parameter.description } : {}),
  }));
}
function reviewableFields(
  operation: OpenApiOperationInventory,
  approval: OpenApiCatalogDecisions,
): ReviewableItem[] {
  const selected = approvalFor(approval, operation.capabilityId).approvedOutputFields;
  return operation.availableOutputFields.map((field) => ({
    id: field.id,
    label: `${field.label} · ${field.semanticType}`,
    approved: selected.includes(field.id),
    availableForApproval: !selected.includes(field.id),
    ...(field.description ? { description: field.description } : {}),
  }));
}
function ApprovalList({
  items,
  onToggle,
  empty,
  kind,
}: {
  items: ReviewableItem[];
  onToggle: (id: string) => void;
  empty: string;
  kind: "parameter" | "field";
}) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <ul className="approval-list">
      {items.map((item) => (
        <li key={item.id} className={item.approved ? "approved" : "not-approved"}>
          <label>
            <input
              type="checkbox"
              aria-label={`Approve ${kind} ${item.label}`}
              checked={item.approved}
              onChange={() => onToggle(item.id)}
            />
            <span>
              <strong>{item.label}</strong>
              <code>{item.id}</code>
              {item.availableForApproval ? (
                <em>candidate — excluded until you approve it</em>
              ) : null}
              {item.description ? <small>{item.description}</small> : null}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

const OPENAPI_DRAFT_KEY = "renderyes.open-api-review-draft.v1";

type StoredOpenApiDraft = {
  documentInput: unknown;
  documentLabel: string;
  catalogConfig: CatalogConfiguration;
  operationConfigs: Record<string, OperationConfiguration>;
  selectedKeys: string[];
  upstreamBaseUrl: string;
};

function loadStoredOpenApiDraft(): StoredOpenApiDraft | undefined {
  try {
    const value = window.localStorage.getItem(OPENAPI_DRAFT_KEY);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as Partial<StoredOpenApiDraft>;
    if (!parsed.documentInput || !parsed.catalogConfig || !parsed.operationConfigs)
      return undefined;
    listOpenApiOperations(parsed.documentInput);
    return parsed as StoredOpenApiDraft;
  } catch {
    return undefined;
  }
}

/** A compact, task-oriented successor to the original detailed review screen. */
function OpenApiReviewAppV2() {
  const [documentInput, setDocumentInput] = useState<unknown>();
  const [documentLabel, setDocumentLabel] = useState("");
  const [pasteValue, setPasteValue] = useState("");
  const [loadError, setLoadError] = useState("");
  const [catalogConfig, setCatalogConfig] = useState<CatalogConfiguration>();
  const [operationConfigs, setOperationConfigs] = useState<
    Record<string, OperationConfiguration>
  >({});
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [expandedKey, setExpandedKey] = useState<string>();
  const [reviewDraft, setReviewDraft] = useState<OpenApiCatalogInventory>();
  const [approval, setApproval] = useState<OpenApiCatalogDecisions>();
  const [selectedCapabilityId, setSelectedCapabilityId] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [upstreamBaseUrl, setUpstreamBaseUrl] = useState("");
  const [publishState, setPublishState] = useState<
    | { status: "idle" }
    | { status: "publishing" }
    | { status: "published"; summary: Record<string, unknown> }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [classificationState, setClassificationState] = useState<ClassificationState>({
    status: "idle",
  });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<
    "all" | "selected" | "read" | "attention" | "post"
  >("all");
  const [rememberDraft, setRememberDraft] = useState(false);
  const [hasStoredDraft, setHasStoredDraft] = useState(() =>
    Boolean(loadStoredOpenApiDraft()),
  );
  const [reviewStep, setReviewStep] = useState<"choose" | "approve" | "publish">(
    "choose",
  );

  const candidates = useMemo(
    () => (documentInput ? listOpenApiOperations(documentInput) : []),
    [documentInput],
  );
  const visibleCandidates = useMemo(
    () =>
      candidates.filter((operation) => {
        const classification =
          classificationState.status === "ready"
            ? classificationState.byOperationKey[candidateKey(operation)]
            : undefined;
        const matchesText =
          `${operation.summary ?? ""} ${operation.operationId ?? ""} ${operation.path} ${operation.tags.join(" ")}`
            .toLowerCase()
            .includes(query.trim().toLowerCase());
        if (!matchesText) return false;
        if (filter === "selected") return selectedKeys.includes(operationKey(operation));
        if (filter === "read") return classification?.effect === "read-only-query";
        if (filter === "attention")
          return (
            operation.support.status === "unsupported" ||
            classification?.effect !== "read-only-query"
          );
        if (filter === "post") return operation.method === "post";
        return true;
      }),
    [candidates, classificationState, filter, query, selectedKeys],
  );
  const groups = useMemo(() => groupedOperations(visibleCandidates), [visibleCandidates]);
  const selectedOperations = candidates.filter((operation) =>
    selectedKeys.includes(operationKey(operation)),
  );
  const compilation = useMemo(() => {
    if (!documentInput || !reviewDraft || !approval) return undefined;
    try {
      return {
        result: compileApprovedOpenApiCatalog(documentInput, reviewDraft, approval),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Could not compile approval",
      };
    }
  }, [approval, documentInput, reviewDraft]);
  const selectedReview =
    reviewDraft?.operations.find(
      (operation) => operation.capabilityId === selectedCapabilityId,
    ) ?? reviewDraft?.operations[0];
  const approvedFieldCount =
    approval?.operations.reduce(
      (count, item) => count + item.approvedOutputFields.length,
      0,
    ) ?? 0;

  const resetReview = () => {
    setReviewDraft(undefined);
    setApproval(undefined);
    setSelectedCapabilityId("");
    setReviewError("");
    setPublishState({ status: "idle" });
    setReviewStep("choose");
  };
  const classify = async (items: OpenApiOperationCandidate[]) => {
    if (!items.length) return;
    setClassificationState({ status: "classifying", completed: 0, total: items.length });
    try {
      const ready = await requestOperationClassifications(
        items.map((item) => item.classificationInput),
        (progress) => setClassificationState({ status: "classifying", ...progress }),
      );
      setClassificationState(ready);
      const suggestions = items
        .filter(
          (item) =>
            item.support.status === "supported" &&
            ready.byOperationKey[candidateKey(item)]?.effect === "read-only-query",
        )
        .map(operationKey);
      setSelectedKeys((current) => [...new Set([...current, ...suggestions])]);
    } catch (error) {
      setClassificationState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not classify operations",
      });
    }
  };
  const loadDocument = (value: unknown, label: string) => {
    try {
      const discovered = listOpenApiOperations(value);
      if (!discovered.length)
        throw new Error("No GET or POST operations were found in this OpenAPI document.");
      setDocumentInput(value);
      setDocumentLabel(label);
      setCatalogConfig(initialCatalogConfiguration(value));
      setOperationConfigs(
        Object.fromEntries(
          discovered.map((item) => [
            operationKey(item),
            initialOperationConfiguration(item),
          ]),
        ),
      );
      setSelectedKeys([]);
      setExpandedKey(undefined);
      setLoadError("");
      resetReview();
      void classify(discovered);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Could not read OpenAPI document",
      );
    }
  };
  const restoreDraft = () => {
    const stored = loadStoredOpenApiDraft();
    if (!stored) {
      setHasStoredDraft(false);
      return;
    }
    setDocumentInput(stored.documentInput);
    setDocumentLabel(stored.documentLabel);
    setCatalogConfig(stored.catalogConfig);
    setOperationConfigs(stored.operationConfigs);
    setSelectedKeys(stored.selectedKeys);
    setUpstreamBaseUrl(stored.upstreamBaseUrl);
    setRememberDraft(true);
    resetReview();
    void classify(listOpenApiOperations(stored.documentInput));
  };
  const clearStoredDraft = () => {
    window.localStorage.removeItem(OPENAPI_DRAFT_KEY);
    setHasStoredDraft(false);
    setRememberDraft(false);
  };
  useEffect(() => {
    if (!rememberDraft || !documentInput || !catalogConfig) return;
    const draft: StoredOpenApiDraft = {
      documentInput,
      documentLabel,
      catalogConfig,
      operationConfigs,
      selectedKeys,
      upstreamBaseUrl,
    };
    window.localStorage.setItem(OPENAPI_DRAFT_KEY, JSON.stringify(draft));
    setHasStoredDraft(true);
  }, [
    catalogConfig,
    documentInput,
    documentLabel,
    operationConfigs,
    rememberDraft,
    selectedKeys,
    upstreamBaseUrl,
  ]);

  const updateOperation = <Key extends keyof OperationConfiguration>(
    key: string,
    field: Key,
    value: OperationConfiguration[Key],
  ) => {
    setOperationConfigs((current) => ({
      ...current,
      [key]: { ...current[key]!, [field]: value },
    }));
    resetReview();
  };
  const updateCatalog = <Key extends keyof CatalogConfiguration>(
    key: Key,
    value: CatalogConfiguration[Key],
  ) => {
    setCatalogConfig((current) => (current ? { ...current, [key]: value } : current));
    resetReview();
  };
  const canChoose = (operation: OpenApiOperationCandidate) =>
    classificationState.status === "ready" &&
    operation.support.status === "supported" &&
    classificationState.byOperationKey[candidateKey(operation)]?.effect ===
      "read-only-query";
  const toggleOperation = (operation: OpenApiOperationCandidate) => {
    if (!canChoose(operation)) return;
    const key = operationKey(operation);
    setSelectedKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
    resetReview();
  };
  const selectSuggestedReads = () => {
    if (classificationState.status !== "ready") return;
    const keys = candidates.filter((item) => canChoose(item)).map(operationKey);
    setSelectedKeys((current) => [...new Set([...current, ...keys])]);
  };
  const startReview = () => {
    if (!documentInput || !catalogConfig) return;
    if (!selectedOperations.length) {
      setReviewError("Select at least one supported read operation before continuing.");
      return;
    }
    try {
      const draft = createOpenApiCatalogInventory(
        createOptions(
          documentInput,
          catalogConfig,
          selectedOperations.map((operation) => ({
            operation,
            config: operationConfigs[operationKey(operation)]!,
          })),
        ),
      );
      setReviewDraft(draft);
      setApproval(newApproval(draft));
      setSelectedCapabilityId(draft.operations[0]?.capabilityId ?? "");
      setReviewError("");
      setReviewStep("approve");
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "Could not create review");
    }
  };
  const publish = async () => {
    if (!compilation?.result) return;
    setPublishState({ status: "publishing" });
    try {
      const response = await fetch("/api/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          catalog: compilation.result.catalog,
          bindings: Object.fromEntries(compilation.result.bindings),
          ...(upstreamBaseUrl.trim() ? { baseUrl: upstreamBaseUrl.trim() } : {}),
        }),
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
    <main className="review-v2">
      <header className="hero compact-hero">
        <div>
          <p className="eyebrow">RenderYes · host onboarding</p>
          <h1>Approve your data surface</h1>
          <p className="lede">
            Choose the read-only data a visitor view may use. Nothing is exposed until you
            publish it.
          </p>
        </div>
      </header>
      <section className="load-panel compact-load" aria-labelledby="load-heading">
        <details open={!documentInput}>
          <summary>
            <span>
              <strong>
                {documentInput ? documentLabel : "Connect an OpenAPI source"}
              </strong>
              <small>
                {documentInput
                  ? `${candidates.length} operations discovered`
                  : "Upload or paste an OpenAPI 3.x JSON document"}
              </small>
            </span>
          </summary>
          <div className="load-details">
            <h2 id="load-heading">Connect an OpenAPI source</h2>
            <p>
              The schema stays in this browser unless you explicitly choose to remember a
              draft. Only compact operation metadata is sent to the configured classifier.
            </p>
            <div className="load-actions">
              <label className="file-button">
                Choose OpenAPI JSON
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={async (event: ChangeEvent<HTMLInputElement>) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      loadDocument(parseOpenApiJson(await file.text()), file.name);
                    } catch (error) {
                      setLoadError(
                        error instanceof Error
                          ? error.message
                          : "Could not read selected file",
                      );
                    } finally {
                      event.target.value = "";
                    }
                  }}
                />
              </label>
              <button
                onClick={() =>
                  loadDocument(sampleOpenApiDocument, "Built-in sample (Poster API)")
                }
              >
                Load sample
              </button>
            </div>
            <label className="paste-label">
              Or paste OpenAPI JSON
              <textarea
                value={pasteValue}
                onChange={(event) => setPasteValue(event.target.value)}
                rows={4}
              />
            </label>
            <button
              className="primary"
              onClick={() => {
                try {
                  loadDocument(parseOpenApiJson(pasteValue), "Pasted OpenAPI JSON");
                } catch (error) {
                  setLoadError(
                    error instanceof Error ? error.message : "Could not parse JSON",
                  );
                }
              }}
            >
              Parse source
            </button>
            {loadError ? (
              <p className="form-error" role="alert">
                {loadError}
              </p>
            ) : null}
          </div>
        </details>
        {hasStoredDraft && !documentInput ? (
          <button className="restore-draft" onClick={restoreDraft}>
            Restore saved local draft
          </button>
        ) : null}
      </section>
      {!documentInput || !catalogConfig ? null : (
        <>
          <section className="workflow-bar" aria-label="Onboarding progress">
            <button
              className={reviewStep === "choose" ? "active" : ""}
              onClick={() => setReviewStep("choose")}
            >
              1. Choose operations
            </button>
            <button
              className={reviewStep === "approve" ? "active" : ""}
              disabled={!reviewDraft}
              onClick={() => setReviewStep("approve")}
            >
              2. Approve data
            </button>
            <button
              className={reviewStep === "publish" ? "active" : ""}
              disabled={!compilation?.result}
              onClick={() => setReviewStep("publish")}
            >
              3. Publish
            </button>
          </section>
          {reviewStep === "choose" ? (
            <>
              <section
                className="configure-panel triage-panel"
                aria-labelledby="inventory-heading"
              >
                <div className="step-heading">
                  <div>
                    <p className="eyebrow">Step 1</p>
                    <h2 id="inventory-heading">Choose operations</h2>
                    <p>
                      After upload, RenderYes automatically analyzes every operation
                      from compact schema metadata. Supported read-only operations,
                      including read-only POST searches, are selected by default. Nothing
                      is exposed until you approve fields and publish.
                    </p>
                    {classificationState.status === "ready" ? (
                      <p
                        className={`classifier-status ${classificationState.usedLiveModel ? "live" : "fallback"}`}
                      >
                        {classificationState.usedLiveModel
                          ? "Analysis complete · live model suggestions are cached when the schema is unchanged"
                          : "Analysis unavailable · transport-based fallback labels only"}
                      </p>
                    ) : null}
                    {classificationState.status === "classifying" ? (
                      <p className="classifier-status">
                        Analyzing {classificationState.completed} of{" "}
                        {classificationState.total} operations automatically…
                      </p>
                    ) : null}
                    {classificationState.status === "error" ? (
                      <p className="form-error">{classificationState.message}</p>
                    ) : null}
                  </div>
                  <aside className="approval-cart">
                    <strong>{selectedOperations.length} chosen</strong>
                    <span>
                      {candidates.length} discovered ·{" "}
                      {candidates.filter((item) => item.method === "post").length} POST
                      operations reviewed
                    </span>
                    <button
                      onClick={() => void classify(candidates)}
                      disabled={classificationState.status === "classifying"}
                    >
                      {classificationState.status === "classifying"
                        ? `Analyzing ${classificationState.completed}/${classificationState.total}`
                        : "Re-run analysis"}
                    </button>
                    <button
                      onClick={selectSuggestedReads}
                      disabled={classificationState.status !== "ready"}
                    >
                      Choose all suggested reads
                    </button>
                    <button className="primary" onClick={startReview}>
                      Review chosen data
                    </button>
                    {reviewError ? (
                      <small className="form-error" role="alert">
                        {reviewError}
                      </small>
                    ) : null}
                    <small>
                      Next: approve the exact fields and visitor filters that may appear
                      in generated views.
                    </small>
                  </aside>
                </div>
                <div className="operation-tools">
                  <input
                    aria-label="Search operations"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search routes, tags or names"
                  />
                  <div role="group" aria-label="Operation filters">
                    {(["all", "selected", "read", "attention", "post"] as const).map(
                      (item) => (
                        <button
                          key={item}
                          className={filter === item ? "active" : ""}
                          onClick={() => setFilter(item)}
                        >
                          {item === "attention"
                            ? "Needs review"
                            : item === "read"
                              ? "Likely reads"
                              : item === "post"
                                ? "POST"
                                : item[0].toUpperCase() + item.slice(1)}
                        </button>
                      ),
                    )}
                  </div>
                </div>
                <details className="catalog-settings">
                  <summary>
                    Catalog settings{" "}
                    <span>Generated defaults — change only if needed</span>
                  </summary>
                  <div className="catalog-form">
                    <label>
                      Catalog ID
                      <input
                        value={catalogConfig.catalogId}
                        onChange={(event) =>
                          updateCatalog("catalogId", event.target.value)
                        }
                      />
                    </label>
                    <label>
                      Catalog version
                      <input
                        value={catalogConfig.catalogVersion}
                        onChange={(event) =>
                          updateCatalog("catalogVersion", event.target.value)
                        }
                      />
                    </label>
                    <label className="wide">
                      Catalog description
                      <input
                        value={catalogConfig.catalogDescription}
                        onChange={(event) =>
                          updateCatalog("catalogDescription", event.target.value)
                        }
                      />
                    </label>
                    <label>
                      Source ID
                      <input
                        value={catalogConfig.sourceId}
                        onChange={(event) =>
                          updateCatalog("sourceId", event.target.value)
                        }
                      />
                    </label>
                    <label>
                      Source label
                      <input
                        value={catalogConfig.sourceLabel}
                        onChange={(event) =>
                          updateCatalog("sourceLabel", event.target.value)
                        }
                      />
                    </label>
                    <label className="wide">
                      Source description <span>(optional)</span>
                      <input
                        value={catalogConfig.sourceDescription}
                        onChange={(event) =>
                          updateCatalog("sourceDescription", event.target.value)
                        }
                      />
                    </label>
                  </div>
                </details>
                <div className="group-list">
                  {groups.map((group) => (
                    <section className="operation-group" key={group.id}>
                      <div className="group-header">
                        <div>
                          <h3>{group.label}</h3>
                          <p>
                            {group.operations.length} matching operation
                            {group.operations.length === 1 ? "" : "s"}
                          </p>
                        </div>
                      </div>
                      <div className="operation-list">
                        {group.operations.map((operation) => {
                          const key = operationKey(operation);
                          const selected = selectedKeys.includes(key);
                          const expanded = expandedKey === key;
                          const config = operationConfigs[key];
                          const classification =
                            classificationState.status === "ready"
                              ? classificationState.byOperationKey[
                                  candidateKey(operation)
                                ]
                              : undefined;
                          const selectableNow = canChoose(operation);
                          const blocked =
                            operation.support.status === "unsupported"
                              ? (operation.support.reason ??
                                "Response schema cannot be reviewed.")
                              : classificationState.status !== "ready"
                                ? "Analysis is still running."
                                : classification?.effect !== "read-only-query"
                                  ? "Only operations classified as read-only can be included in this read-only catalog."
                                  : undefined;
                          return (
                            <article
                              className={`operation-row ${selected ? "included" : ""}`}
                              key={key}
                            >
                              <div className="operation-main">
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    disabled={!selectableNow}
                                    title={blocked}
                                    onChange={() => toggleOperation(operation)}
                                  />
                                  <span>
                                    <strong>
                                      {operation.summary ??
                                        operation.operationId ??
                                        operation.path}
                                    </strong>
                                    <code>
                                      {operation.method.toUpperCase()} {operation.path}
                                    </code>
                                  </span>
                                </label>
                                <div className="operation-badges">
                                  <span className={`badge ${operation.support.status}`}>
                                    {operation.support.status === "supported"
                                      ? "Schema understood"
                                      : "Unsupported"}
                                  </span>
                                  {classification ? (
                                    <span
                                      className={`badge ${classification.source === "fallback" ? "effect-fallback" : `effect-${classification.effect}`}`}
                                    >
                                      {classification.source === "fallback"
                                        ? `${operation.method.toUpperCase()} fallback`
                                        : effectLabel(classification.effect)}
                                    </span>
                                  ) : null}
                                  {classification?.riskSignals.length ? (
                                    <span className="badge risk-signal">
                                      {classification.riskSignals.length} review notes
                                    </span>
                                  ) : null}
                                  {operation.method === "post" && selectableNow ? (
                                    <span className="badge supported">
                                      Read-only POST
                                    </span>
                                  ) : null}
                                </div>
                                {blocked ? (
                                  <small className="support-reason">{blocked}</small>
                                ) : null}
                                {classification ? (
                                  <details className="classification-details">
                                    <summary>Why this suggestion?</summary>
                                    <p>{classification.reason}</p>
                                    <p>
                                      {classification.riskSignals.length
                                        ? `Review notes: ${classification.riskSignals.join(", ")}`
                                        : "No additional review notes."}
                                    </p>
                                  </details>
                                ) : null}
                                <button
                                  className="configure-button"
                                  disabled={!config}
                                  onClick={() =>
                                    setExpandedKey(expanded ? undefined : key)
                                  }
                                >
                                  {expanded ? "Close details" : "Details"}
                                </button>
                              </div>
                              {expanded && config ? (
                                <div className="inline-config">
                                  <label className="wide">
                                    Business purpose
                                    <input
                                      value={config.purpose}
                                      onChange={(event) =>
                                        updateOperation(
                                          key,
                                          "purpose",
                                          event.target.value,
                                        )
                                      }
                                    />
                                  </label>
                                  <details className="advanced-config">
                                    <summary>Advanced operation settings</summary>
                                    <div className="form-grid">
                                      <label>
                                        Capability ID
                                        <input
                                          value={config.capabilityId}
                                          onChange={(event) =>
                                            updateOperation(
                                              key,
                                              "capabilityId",
                                              event.target.value,
                                            )
                                          }
                                        />
                                      </label>
                                      <label>
                                        Data type ID
                                        <input
                                          value={config.dataTypeId}
                                          onChange={(event) =>
                                            updateOperation(
                                              key,
                                              "dataTypeId",
                                              event.target.value,
                                            )
                                          }
                                        />
                                      </label>
                                      <label>
                                        Result shape
                                        <select
                                          value={config.resultShape}
                                          onChange={(event) =>
                                            updateOperation(
                                              key,
                                              "resultShape",
                                              event.target.value as ResultShape,
                                            )
                                          }
                                        >
                                          {resultShapes.map((shape) => (
                                            <option key={shape} value={shape}>
                                              {shape}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                      <label className="wide">
                                        Server session keys
                                        <input
                                          value={config.requiredSessionKeys}
                                          onChange={(event) =>
                                            updateOperation(
                                              key,
                                              "requiredSessionKeys",
                                              event.target.value,
                                            )
                                          }
                                          placeholder="viewerId, tenantId"
                                        />
                                      </label>
                                    </div>
                                  </details>
                                </div>
                              ) : null}
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
                {reviewError ? <p className="form-error">{reviewError}</p> : null}
              </section>
              <section className="draft-controls">
                <label>
                  <input
                    type="checkbox"
                    checked={rememberDraft}
                    onChange={(event) => setRememberDraft(event.target.checked)}
                  />{" "}
                  Remember this draft in this browser
                </label>
                <small>
                  Stores the OpenAPI document and approval choices locally on this device.
                  No token is stored.
                </small>
                {hasStoredDraft ? (
                  <button onClick={clearStoredDraft}>Clear saved draft</button>
                ) : null}
              </section>
            </>
          ) : null}
          {reviewStep !== "choose" && reviewDraft && approval && selectedReview ? (
            <>
              <section className="summary" aria-label="Approval progress">
                <div>
                  <span>Selected operations</span>
                  <strong>{reviewDraft.operations.length}</strong>
                </div>
                <div>
                  <span>Approved fields</span>
                  <strong>{approvedFieldCount}</strong>
                  <small>At least one per operation is required.</small>
                </div>
                <div className={compilation?.result ? "ready" : "blocked"}>
                  <span>Ready to publish</span>
                  <strong>{compilation?.result ? "Yes" : "Not yet"}</strong>
                  <small>
                    {compilation?.result
                      ? "All selected data is approved."
                      : "Approve data fields below."}
                  </small>
                </div>
              </section>
              <section className="data-approval" hidden={reviewStep !== "approve"}>
                <nav aria-label="Selected operations">
                  <p className="nav-label">Step 2 · approve data</p>
                  {reviewDraft.operations.map((operation) => (
                    <button
                      key={operation.capabilityId}
                      className={
                        operation.capabilityId === selectedReview.capabilityId
                          ? "active"
                          : ""
                      }
                      onClick={() => setSelectedCapabilityId(operation.capabilityId)}
                    >
                      <span>{operation.purpose}</span>
                      <small>
                        {
                          approvalFor(approval, operation.capabilityId)
                            .approvedOutputFields.length
                        }{" "}
                        fields approved
                      </small>
                    </button>
                  ))}
                </nav>
                <section className="review-panel">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">
                        {selectedReview.method} {selectedReview.path}
                      </p>
                      <h2>{selectedReview.purpose}</h2>
                      <p>
                        Conservative defaults are selected for ordinary filters and
                        display-safe typed fields. Remove anything your visitor views
                        should not use; add only the exceptions you need.
                      </p>
                    </div>
                  </div>
                  <section className="review-section">
                    <div className="section-copy">
                      <h3>Visitor filters</h3>
                      <p>
                        Safe query and POST-body filters are selected by default. Path
                        identifiers and sensitive-looking inputs remain unchecked.
                      </p>
                    </div>
                    <ApprovalList
                      items={reviewableParameters(selectedReview, approval)}
                      onToggle={(id) =>
                        setApproval((current) =>
                          current
                            ? updateApproval(
                                current,
                                selectedReview.capabilityId,
                                "approvedVisitorParameters",
                                id,
                              )
                            : current,
                        )
                      }
                      empty="This operation has no visitor-controlled parameters."
                      kind="parameter"
                    />
                  </section>
                  <section className="review-section">
                    <div className="section-copy">
                      <h3>Who may read this</h3>
                      <p>
                        <strong>Signed-in visitors only</strong> runs your
                        authentication and permission checks on every request.{" "}
                        <strong>Anyone</strong> skips both — the capability answers
                        any caller that reaches your server.
                      </p>
                      <p className="form-hint">
                        This used to be inferred from whether you happened to name
                        a session key, so a capability nobody had decided about
                        behaved exactly like one deliberately opened. It is now a
                        decision, and it is recorded in the approval file.
                      </p>
                    </div>
                    <label className="field">
                      <span>Access</span>
                      <select
                        value={
                          approvalFor(approval, selectedReview.capabilityId).policy
                            .authentication
                        }
                        onChange={(event) => {
                          const next =
                            event.target.value === "public" ? "public" : "session";
                          setApproval((current) =>
                            current
                              ? setApprovalAuthentication(
                                  current,
                                  selectedReview.capabilityId,
                                  next,
                                )
                              : current,
                          );
                        }}
                      >
                        <option value="session">Signed-in visitors only</option>
                        <option value="public">Anyone (no checks)</option>
                      </select>
                    </label>
                  </section>
                  {selectedReview.serverOnlyKeys.length ? (
                    <section className="review-section locked-section">
                      <div className="section-copy">
                        <h3>Trusted server context</h3>
                        <p>
                          Host-owned values injected by the server, never by the model or
                          browser.
                        </p>
                      </div>
                      <div className="locked-keys">
                        {selectedReview.serverOnlyKeys.map((key) => (
                          <span key={key}>🔒 {key}</span>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  <section className="review-section">
                    <div className="section-copy">
                      <h3>Fields allowed in visitor views</h3>
                      <p>
                        Typed display fields are selected by default. Internal,
                        sensitive-looking, and unknown/nested fields remain unchecked.
                      </p>
                    </div>
                    <ApprovalList
                      items={reviewableFields(selectedReview, approval)}
                      onToggle={(id) =>
                        setApproval((current) =>
                          current
                            ? updateApproval(
                                current,
                                selectedReview.capabilityId,
                                "approvedOutputFields",
                                id,
                              )
                            : current,
                        )
                      }
                      empty="No reviewable output fields."
                      kind="field"
                    />
                  </section>
                </section>
              </section>
              {reviewStep === "approve" ? (
                <section className="publish-panel">
                  <div>
                    <p className="eyebrow">Next</p>
                    <h2>Continue to publishing</h2>
                    <p>
                      Confirm the approved data surface, then add server-only connection
                      settings.
                    </p>
                  </div>
                  {compilation?.result ? (
                    <button className="primary" onClick={() => setReviewStep("publish")}>
                      Continue to publish
                    </button>
                  ) : (
                    <p className="muted">
                      Approve at least one allowed output field for every selected
                      operation.
                    </p>
                  )}
                  <button onClick={() => setReviewStep("choose")}>
                    Back to operations
                  </button>
                </section>
              ) : null}
              <section className="publish-panel" hidden={reviewStep !== "publish"}>
                <div>
                  <p className="eyebrow">Step 3 · publish</p>
                  <h2>Register the approved catalog</h2>
                  <p>
                    The endpoint and token name remain server-side. The planner receives
                    neither.
                  </p>
                </div>
                {compilation?.error ? (
                  <p className="form-error">{compilation.error}</p>
                ) : null}
                {compilation?.result ? (
                  <>
                    <details>
                      <summary>Connection settings</summary>
                      <label className="paste-label">
                        Upstream base URL
                        <input
                          value={upstreamBaseUrl}
                          onChange={(event) => setUpstreamBaseUrl(event.target.value)}
                          placeholder="http://127.0.0.1:8000"
                        />
                      </label>
                    </details>
                    <button
                      className="primary"
                      disabled={publishState.status === "publishing"}
                      onClick={publish}
                    >
                      {publishState.status === "publishing"
                        ? "Publishing…"
                        : "Publish approved catalog"}
                    </button>
                  </>
                ) : (
                  <p className="muted">
                    Complete the required field approvals to enable publishing.
                  </p>
                )}
                {publishState.status === "error" ? (
                  <p className="form-error">{publishState.message}</p>
                ) : null}
                {publishState.status === "published" ? (
                  <p className="success-message">
                    Published {String(publishState.summary.catalogId)} with{" "}
                    {String(publishState.summary.executableCapabilityCount)} executable
                    capabilities.
                  </p>
                ) : null}
              </section>
            </>
          ) : null}
        </>
      )}
    </main>
  );
}

function App() {
  const [mode, setMode] = useState<"openapi" | "graphql">("graphql");
  return (
    <>
      <nav className="source-mode" aria-label="Catalog source">
        <strong>Catalog source</strong>
        <button
          className={mode === "graphql" ? "active" : ""}
          onClick={() => setMode("graphql")}
        >
          GraphQL
        </button>
        <button
          className={mode === "openapi" ? "active" : ""}
          onClick={() => setMode("openapi")}
        >
          OpenAPI
        </button>
      </nav>
      <div hidden={mode !== "graphql"}>
        <GraphQlReviewApp />
      </div>
      <div hidden={mode !== "openapi"}>
        <OpenApiReviewAppV2 />
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
