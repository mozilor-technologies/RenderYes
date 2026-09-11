/**
 * Model-call observability, without a vendor in the package.
 *
 * Two layers, deliberately separate:
 *
 *  1. `ModelCallEvent` + the `onModelCall` config hook. Zero dependencies, no
 *     opinion about where traces go — the same shape as `onComposeMetrics`.
 *     A host can log to stdout, push to its own pipeline, or ignore it.
 *  2. `createOtlpModelObserver`, an OTLP/HTTP+JSON exporter emitting spans
 *     that follow the OpenTelemetry GenAI semantic conventions.
 *
 * Layer 2 has no dependency either — not on an observability SDK, not on
 * `@opentelemetry/api`. OTLP over HTTP with JSON encoding is a POST with a
 * JSON body, so a few dozen lines replace a dependency tree. That matters
 * more than usual here: this package is installed into someone else's
 * backend, and every dependency we add is one they inherit.
 *
 * The vendor-neutrality is real rather than nominal. Langfuse ingests these
 * spans natively at `/api/public/otel/v1/traces`; so does any OTLP collector,
 * which is what routes the same bytes to Datadog, Honeycomb, or Grafana. A
 * host switches backends by changing a URL, not by changing this package or
 * their own code.
 */

/** One logical model call. A planner repair attempt is a separate event. */
export interface ModelCallEvent {
  /** What the call was for. */
  operation: "plan" | "classify";
  /**
   * Shared by every model call in one compose, so a repair loop reads as one
   * trace with three spans rather than three unrelated calls. This is the
   * whole reason the 23-57s latency question was hard to answer from logs.
   */
  traceId: string;
  providerId: string;
  modelId?: string;
  /** 0 on the first attempt; 1+ on planner repair attempts. */
  attempt: number;
  /** Epoch milliseconds when the call started. */
  startedAt: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * HTTP requests this one logical call actually made — 2 when a provider
   * rejected the structured schema and the adapter retried in plain JSON
   * mode. Reported because it is billed but otherwise invisible.
   */
  httpCalls?: number;
  outcome: "ok" | "error";
  /** Present when `outcome` is `"error"`. Redacted of credential shapes. */
  error?: string;
  catalogId?: string;
  /**
   * Prompt and completion text, present only when the host sets
   * `captureModelPrompts: true`.
   *
   * Off by default and never implied by enabling tracing. The prompt is the
   * visitor's own words and the system prompt contains the host's whole
   * catalog — capability descriptions, field names, component inventory. Both
   * are things a host may have promised not to send to a third party, so
   * turning on observability must not quietly start shipping them.
   */
  systemPrompt?: string;
  userPrompt?: string;
  completion?: string;
}

export type ModelCallObserver = (event: ModelCallEvent) => void;

/** 32 lowercase hex characters, as OTLP requires for a trace id. */
export function newTraceId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

/** 16 lowercase hex characters, as OTLP requires for a span id. */
function newSpanId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

type OtlpValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };

function attr(key: string, value: string | number | boolean | undefined) {
  if (value === undefined) return [];
  const otlp: OtlpValue =
    typeof value === "number"
      ? { intValue: String(Math.round(value)) }
      : typeof value === "boolean"
        ? { boolValue: value }
        : { stringValue: value };
  return [{ key, value: otlp }];
}

/**
 * Maps our provider ids onto `gen_ai.system` values the conventions define.
 * An unknown id passes through rather than being dropped: a host running its
 * own provider should still see which one produced a span.
 */
function genAiSystem(providerId: string): string {
  if (providerId === "openai") return "openai";
  if (providerId === "gemini") return "gcp.gemini";
  return providerId;
}

export interface OtlpObserverConfig {
  /**
   * Full OTLP traces endpoint. For Langfuse this is
   * `https://cloud.langfuse.com/api/public/otel/v1/traces` (or the `us.`,
   * `jp.`, or `hipaa.` host, or a self-hosted origin). For anything else it
   * is that backend's own OTLP/HTTP traces URL, or a local collector.
   */
  endpoint: string;
  /**
   * Sent verbatim. Langfuse expects
   * `{ authorization: "Basic " + base64(publicKey + ":" + secretKey) }` and
   * `{ "x-langfuse-ingestion-version": "4" }` for real-time ingestion.
   *
   * Credentials are taken as a value here rather than read from the
   * environment by this module, because a host already resolves its own
   * secrets and should not have to adopt our variable names to do it.
   */
  headers?: Record<string, string>;
  /** `service.name` on the resource. Defaults to `renderyes`. */
  serviceName?: string;
  /** Spans buffered before an early flush. Defaults to 20. */
  maxBatchSize?: number;
  /** Idle milliseconds before flushing a partial batch. Defaults to 2000. */
  flushIntervalMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Called when an export fails. Defaults to a single `console.warn`. */
  onExportError?: (error: unknown) => void;
}

export interface OtlpModelObserver {
  /** Pass to `ViewServerConfig.onModelCall`. */
  observe: ModelCallObserver;
  /** Sends anything buffered. Await before exit so a batch isn't lost. */
  flush: () => Promise<void>;
}

/**
 * Builds an observer that exports GenAI-convention spans over OTLP/HTTP+JSON.
 *
 * Export is fire-and-forget and failure-tolerant by construction: a tracing
 * backend being down, slow, or misconfigured must never fail a compose or
 * delay a visitor. Spans are buffered and flushed on a timer, so a burst of
 * repair attempts costs one request rather than three.
 */
export function createOtlpModelObserver(config: OtlpObserverConfig): OtlpModelObserver {
  const maxBatchSize = config.maxBatchSize ?? 20;
  const flushIntervalMs = config.flushIntervalMs ?? 2_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const onExportError =
    config.onExportError ??
    ((error: unknown) =>
      console.warn(`[renderyes:otel] export failed: ${String(error)}`));

  let buffer: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function send(spans: unknown[]): Promise<void> {
    if (spans.length === 0) return;
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              ...attr("service.name", config.serviceName ?? "renderyes"),
              ...attr("telemetry.sdk.name", "renderyes"),
            ],
          },
          scopeSpans: [{ scope: { name: "@renderyes/server" }, spans }],
        },
      ],
    };
    try {
      const response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...config.headers },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        onExportError(new Error(`OTLP endpoint returned ${response.status}`));
      }
    } catch (cause) {
      onExportError(cause);
    }
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const pending = buffer;
    buffer = [];
    await send(pending);
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushIntervalMs);
    // Never hold the process open for telemetry.
    timer.unref?.();
  }

  return {
    flush,
    observe(event) {
      const startNano = BigInt(Math.round(event.startedAt)) * 1_000_000n;
      const endNano = startNano + BigInt(Math.round(event.durationMs)) * 1_000_000n;
      buffer.push({
        traceId: event.traceId,
        spanId: newSpanId(),
        // `kind: 3` is CLIENT — this process calling out to a model service.
        kind: 3,
        name: `${event.operation} ${event.modelId ?? event.providerId}`,
        startTimeUnixNano: startNano.toString(),
        endTimeUnixNano: endNano.toString(),
        attributes: [
          ...attr("gen_ai.system", genAiSystem(event.providerId)),
          ...attr("gen_ai.operation.name", event.operation === "plan" ? "chat" : "chat"),
          ...attr("gen_ai.request.model", event.modelId),
          ...attr("gen_ai.response.model", event.modelId),
          ...attr("gen_ai.usage.input_tokens", event.inputTokens),
          ...attr("gen_ai.usage.output_tokens", event.outputTokens),
          // Not in the conventions, but the two numbers that explain this
          // system's latency and cost — a repair is a whole extra call, and a
          // schema fallback silently doubles one.
          ...attr("renderyes.attempt", event.attempt),
          ...attr("renderyes.http_calls", event.httpCalls),
          ...attr("renderyes.catalog_id", event.catalogId),
          ...attr(
            "gen_ai.prompt",
            event.systemPrompt
              ? `${event.systemPrompt}\n\n${event.userPrompt ?? ""}`
              : event.userPrompt,
          ),
          ...attr("gen_ai.completion", event.completion),
          ...attr("error.message", event.error),
        ],
        status:
          event.outcome === "ok" ? { code: 1 } : { code: 2, message: event.error ?? "" },
      });
      if (buffer.length >= maxBatchSize) void flush();
      else scheduleFlush();
    },
  };
}
