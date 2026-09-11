import {
  isListResultShape,
  type PlannerCapability,
  type PlannerManifest,
} from "./compile.js";

/**
 * The model-facing data-planning contract.
 *
 * Lives here rather than in `@renderyes/data-runtime` because it is a pure
 * projection of the planner-safe manifest — no execution, no session, no
 * rows — and because the catalog CLI needs the same estimator the server
 * reports as `contractBytes`: two estimators drift, and the drift shows up as
 * a token budget discovered after publish instead of before approval.
 * `@renderyes/data-runtime` re-exports everything below unchanged.
 */
export interface DataPlanningContract {
  systemPrompt: string;
  jsonSchema: Record<string, unknown>;
}

/**
 * Row ceiling applied when a capability declares no `maximumRows` of its own.
 *
 * A capability without that constraint was previously unbounded: the planner's
 * `limit` had a `minimum` and no `maximum`, so `limit: 1000000` was a legal
 * plan and the only thing standing between a prompt and a full table scan was
 * the upstream's own patience. A default ceiling makes the unconstrained case
 * merely large instead of unlimited. A capability that legitimately serves
 * more declares `maximumRows` and overrides this.
 */
export const DEFAULT_MAX_ROWS = 1_000;

const VALUE_FILTER_OPERATORS = [
  "eq",
  "not-eq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "contains",
  "starts-with",
  "ends-with",
  "in",
  "not-in",
] as const;

const NULL_FILTER_OPERATORS = ["is-null", "is-not-null"] as const;

/** Semantic types whose values are true numbers and can be summed/averaged. */
export const NUMERIC_SEMANTIC_TYPES: ReadonlySet<string> = new Set([
  "money",
  "quantity",
  "percentage",
]);

/**
 * Builds the model-facing contract exclusively from a planner-safe manifest.
 * Each capability becomes a closed schema variant, so the model can choose
 * approved params and supported query operations without seeing server data.
 */
export function createDataPlanningContract(
  manifest: PlannerManifest,
): DataPlanningContract {
  const capabilitySchemas = manifest.capabilities.map((capability) => {
    const dataType = manifest.dataTypes.find(
      (candidate) => candidate.id === capability.output.dataTypeId,
    );
    const projectionFields = Object.keys(dataType?.fields ?? {});
    const queryProperties: Record<string, unknown> = {};
    // `filter`/`groupBy`/`aggregates`/`sort`/`offset`/`limit` only mean
    // anything against a list — `applyValidatedQuery` (data-runtime/query.ts)
    // throws "List query requires a collection result" the instant any of
    // them is set against a single-object result, and the executor turns that
    // throw into `INVALID_QUERY`. Offering `limit` on every capability
    // regardless of shape means the planner has a schema-legal way to make a
    // non-list request fail every time — confirmed on a real run against
    // `getOpenSummary`.
    //
    // The planner-safe manifest carries `output.shape` — a semantic label —
    // not the output JSON Schema, so there is no direct `type === "array"`
    // check available here. `collection`/`search-results`/`media-collection`
    // are root arrays in every case checked. `time-series` looks list-like by
    // name but isn't, in this runtime: the classifier assigns it an *object*
    // of parallel arrays (`{dates: [...], created: [...]}`), so `Array.isArray`
    // is false and it needs the same guard as `entity`. `hierarchy`/
    // `comparison` are genuinely ambiguous with no real capability to check
    // against yet, so they default to non-list: that direction only costs an
    // optional query feature, where guessing list-shaped wrongly reproduces
    // the exact hard failure this guard exists to prevent.
    const isListShaped = isListResultShape(capability.output.shape);

    // `sourceFilterFields` wins where it exists: it names the fields whose
    // narrowing reaches the whole collection, and the planner cannot tell the
    // difference from the field names alone. The wider `filterFields` stays the
    // runtime's permission list, so a refinement the host triggers itself is
    // unaffected by this narrowing.
    const plannableFilterFields = capability.supports?.sourceFilterFields?.length
      ? capability.supports.sourceFilterFields
      : capability.supports?.filterFields;
    if (isListShaped && plannableFilterFields?.length) {
      queryProperties.filter = filterGroupSchema(plannableFilterFields);
    }
    if (isListShaped && capability.supports?.groupFields?.length) {
      queryProperties.groupBy = {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { enum: capability.supports.groupFields },
      };
    }
    if (isListShaped && capability.supports?.aggregates?.length) {
      const numericFields = projectionFields.filter((field) =>
        NUMERIC_SEMANTIC_TYPES.has(
          (dataType?.fields as Record<string, { semanticType?: string }> | undefined)?.[
            field
          ]?.semanticType ?? "",
        ),
      );
      queryProperties.aggregates = {
        type: "array",
        minItems: 1,
        maxItems: 16,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "as"],
          properties: {
            op: { enum: capability.supports.aggregates },
            ...(numericFields.length ? { field: { enum: numericFields } } : {}),
            as: { type: "string", minLength: 1 },
          },
        },
      };
    }
    if (isListShaped && capability.supports?.sortFields?.length) {
      queryProperties.sort = {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "direction"],
          properties: {
            field: { enum: capability.supports.sortFields },
            direction: { enum: ["asc", "desc"] },
          },
        },
      };
    }
    if (projectionFields.length) {
      queryProperties.project = {
        type: "array",
        minItems: 1,
        maxItems: Math.min(64, projectionFields.length),
        uniqueItems: true,
        items: { enum: projectionFields },
      };
    }
    if (isListShaped && capability.supports?.pagination) {
      queryProperties.offset = { type: "integer", minimum: 0 };
    }
    // `project` is deliberately excluded from this guard — `projectRow`
    // (data-runtime/query.ts) works against a single object as much as a
    // list, so it's the one query property genuinely safe to offer regardless
    // of shape.
    if (isListShaped) {
      queryProperties.limit = {
        type: "integer",
        minimum: 1,
        // The same effective ceiling `validateDataRequestQuery` enforces:
        // min of the row budget and any transport page cap the input schema
        // states, so the model is never invited to ask for a limit one page
        // can never hold.
        maximum: effectiveLimitCeiling(capability),
      };
    }

    return {
      type: "object",
      additionalProperties: false,
      required: ["requestId", "capabilityId", "params"],
      properties: {
        requestId: { type: "string", minLength: 1 },
        capabilityId: { const: capability.id },
        params: capability.inputSchema,
        query: {
          type: "object",
          additionalProperties: false,
          properties: queryProperties,
        },
      },
    };
  });

  const plannerCapabilities = manifest.capabilities.map((capability) => {
    const dataType = manifest.dataTypes.find(
      (candidate) => candidate.id === capability.output.dataTypeId,
    );
    return {
      id: capability.id,
      purpose: capability.purpose,
      // Which data type and shape this produces is what decides where it can
      // bind, and no part of the schema below states it.
      output: capability.output,
      // `supports` used to be included whole, and `constraints` with it — but
      // filterFields, sortFields, groupFields, aggregates, pagination and
      // maximumRows are all already expressed in `queryProperties` above as
      // enums and bounds, so the model was reading them twice and paying for
      // them twice. `setOperations` is the one exception: the composition
      // schema (in `@renderyes/planner`) advertises a single global operation
      // enum, so *which* capability supports a given operation exists nowhere
      // in the schema and has to be stated here. `constraints.authentication`
      // is dropped outright: the model never sets identity, so it
      // cannot act on it.
      ...(capability.supports?.setOperations?.length
        ? { setOperations: capability.supports.setOperations }
        : {}),
      // The other exception, for the same reason as `setOperations`: the
      // params schema shows an argument's shape but cannot say *when* it runs.
      // These are the approved params the source applies over the whole
      // dataset before the fetch — the distinction the source-narrowing rule
      // in the prompt turns on, and one JSON Schema has no vocabulary for.
      ...(capability.supports?.sourceNarrowingArguments?.length
        ? { sourceNarrowingArguments: capability.supports.sourceNarrowingArguments }
        : {}),
      // This is catalog metadata, not resolved business data. It gives a
      // planner stable semantic names (and small declared enums) instead of
      // forcing it to infer each customer's raw sentinel values.
      fields: plannerFieldMetadata(dataType),
    };
  });

  return {
    systemPrompt: [
      "Select only owner-approved data capabilities and declarative query operations.",
      "Return JSON matching the supplied schema.",
      // Two stages, stated as two facts, because the model cannot see the
      // fetch boundary from the schema alone: params run at the source over
      // the whole dataset; the query block runs afterwards on this server
      // over only the rows one fetch returned. Advertising both without the
      // distinction produced plans that filtered one page and presented the
      // survivors as the answer.
      "Params are applied by the data source itself and narrow over the whole dataset before anything is fetched. The query block runs afterwards, on this server, over only the rows one fetch returned.",
      "Prefer source narrowing: when a capability's sourceNarrowingArguments can express the visitor's constraint, put it in params. query.filter narrows no more than the fetched page — it is the fallback for constraints no approved param expresses, and a page-narrowed result is reported incomplete. Sorting, projection, and limits stay in query.",
      // The null rule exists because its absence nulled out every "running
      // now" promotion: endDate >= today read null (= no end date) as "not
      // running". Null failing comparisons is the predictable half; the
      // planner owns the other half, because only intent says whether an
      // absent value means unbounded.
      'A null field value fails every comparison operator. When absence plausibly means unbounded or open-ended — an end date, an expiry, a cap — include an explicit is-null branch: combine "any" of the comparison and {operator: "is-null"} on that field.',
      // Aggregation is the operation models least connect to visitor
      // language: "how many X per Y" was refused as unsupported by a plan
      // whose capability advertised groupBy + count, because nothing said
      // the two were the same question. Emitted only when some capability
      // actually supports aggregates, so it can never talk a model into an
      // operation the validator would reject.
      ...(manifest.capabilities.some(
        (capability) => capability.supports?.aggregates?.length,
      )
        ? [
            'Counting and summary questions ("how many per …", "total/average by …") ARE supported wherever a capability declares groupBy and aggregates: group by the category field and aggregate — do not refuse them as unsupported.',
          ]
        : []),
      "Treat approved field descriptions and small declared allowedValues as owner-defined semantic meaning; do not infer null or missing-value semantics from a different field.",
      "Never include identity, permissions, credentials, endpoints, renderer paths, executable code, or resolved rows.",
      `Capability catalog: ${manifest.catalogId}@${manifest.catalogVersion} (${manifest.catalogHash}).`,
      `Approved capabilities: ${JSON.stringify(plannerCapabilities)}`,
    ].join("\n"),
    jsonSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["dataRequests"],
      properties: {
        dataRequests: {
          type: "array",
          items: capabilitySchemas.length ? { anyOf: capabilitySchemas } : false,
        },
      },
    },
  };
}

function plannerFieldMetadata(
  dataType: PlannerManifest["dataTypes"][number] | undefined,
): Record<string, Record<string, unknown>> {
  if (!dataType) return {};
  return Object.fromEntries(
    Object.entries(dataType.fields).map(([fieldId, descriptor]) => {
      const allowedValues = declaredFieldEnumValues(dataType, fieldId);
      return [
        fieldId,
        {
          label: descriptor.label,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          semanticType: descriptor.semanticType,
          ...(allowedValues ? { allowedValues } : {}),
        },
      ];
    }),
  );
}

/**
 * The small declared enum for one data-type field, when its schema states one.
 *
 * Exported because query validation in `@renderyes/data-runtime` must
 * enforce exactly the list the model was shown here — two independently
 * computed lists is how an allowed value gets rejected or a rejected one
 * allowed.
 */
export function declaredFieldEnumValues(
  dataType: PlannerManifest["dataTypes"][number],
  fieldId: string,
): Array<string | number | boolean | null> | undefined {
  return readSmallPrimitiveEnum(readFieldSchema(dataType.schema, fieldId));
}

function readFieldSchema(
  schema: Record<string, unknown>,
  fieldId: string,
): Record<string, unknown> | undefined {
  const properties = schema.properties;
  if (!isPlainRecord(properties)) return undefined;
  const field = properties[fieldId];
  return isPlainRecord(field) ? field : undefined;
}

function readSmallPrimitiveEnum(
  schema: Record<string, unknown> | undefined,
): Array<string | number | boolean | null> | undefined {
  const values = schema?.enum;
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    return undefined;
  }
  return values.every(
    (value) =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
  )
    ? values
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one ceiling a `query.limit` is validated against and advertised as.
 *
 * Two ceilings exist and used to disagree: `policy.maximumRows` (the row
 * budget) and the transport page cap the compiled contract states on a
 * connection's paging argument (`first`/`last`), usually much smaller. A limit
 * validated only against the row budget accepted 101–1000 against an upstream
 * whose one page can never hold them — accepted, and unsatisfiable. The
 * effective ceiling is the minimum of whichever are declared.
 */
export function effectiveLimitCeiling(
  capability: Pick<PlannerCapability, "constraints" | "inputSchema">,
): number {
  const declared = capability.constraints.maximumRows ?? DEFAULT_MAX_ROWS;
  const pageCap = pagingArgumentCap(capability.inputSchema);
  return pageCap !== undefined ? Math.min(declared, pageCap) : declared;
}

/**
 * Reads the transport page cap out of a compiled capability input schema.
 *
 * The cap is a fact about one binding's transport, so the catalog carries it
 * only where the planner already sees it: as the `maximum` the contract puts
 * on a Relay connection's paging argument. Absent for capabilities that page
 * differently or not at all.
 */
export function pagingArgumentCap(inputSchema: unknown): number | undefined {
  if (!isPlainRecord(inputSchema) || !isPlainRecord(inputSchema.properties)) {
    return undefined;
  }
  let cap: number | undefined;
  for (const argument of ["first", "last"]) {
    const property = inputSchema.properties[argument];
    if (!isPlainRecord(property)) continue;
    const maximum = property.maximum;
    if (typeof maximum === "number" && Number.isInteger(maximum) && maximum > 0) {
      cap = cap === undefined ? maximum : Math.min(cap, maximum);
    }
  }
  return cap;
}

function conditionSchema(fields: string[]): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["field", "operator", "value"],
        properties: {
          field: { enum: fields },
          operator: { enum: VALUE_FILTER_OPERATORS },
          value: {},
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["field", "operator"],
        properties: {
          field: { enum: fields },
          operator: { enum: NULL_FILTER_OPERATORS },
        },
      },
    ],
  };
}

/**
 * Recursive filter group schema. `depth` bounds the inlined nesting the model
 * may author (deeper trees are still accepted up to the core depth budget). A
 * node is a leaf condition or a nested group.
 */
function filterGroupSchema(fields: string[], depth = 3): Record<string, unknown> {
  const items =
    depth > 0
      ? { oneOf: [conditionSchema(fields), filterGroupSchema(fields, depth - 1)] }
      : conditionSchema(fields);
  return {
    type: "object",
    additionalProperties: false,
    required: ["combine", "conditions"],
    properties: {
      combine: { enum: ["all", "any", "none"] },
      conditions: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items,
      },
    },
  };
}
