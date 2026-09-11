import type {
  DataTypeDescriptor,
  FieldDescriptor,
  ResultShape,
} from "@renderyes/capability-catalog";

/**
 * Synthesizes rows from field *descriptors*, never from live data.
 *
 * These rows do two jobs: they go into the prompt (so the model sees what a
 * `quantity` with unit `g` actually looks like) and they feed the render-smoke
 * check's four fixture states. Both jobs need values a human can recognize as
 * the semantic type — an identifier that looks like an opaque key, a
 * percentage that is a ratio, a date that is really a date — because the
 * failure being defended against is precisely a component that renders "p_9"
 * as a title.
 */

const DAY_MS = 86_400_000;
/** Fixed, so fixtures and prompts are reproducible across runs of one process. */
const BASE_TIME = Date.parse("2026-08-01T12:00:00.000Z");

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "item"
  );
}

/** Recursively finds an `enum` for the property whose name ends the dotted path. */
function enumValuesFor(schema: unknown, fieldName: string): string[] | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null) {
    const property = (properties as Record<string, unknown>)[fieldName];
    if (typeof property === "object" && property !== null) {
      const values = (property as Record<string, unknown>).enum;
      if (Array.isArray(values) && values.every((value) => typeof value === "string")) {
        return values as string[];
      }
    }
  }
  for (const value of Object.values(record)) {
    const found = enumValuesFor(value, fieldName);
    if (found) return found;
  }
  return undefined;
}

export function synthesizeSampleValue(
  descriptor: FieldDescriptor,
  path: string,
  rowIndex: number,
  dataType?: DataTypeDescriptor,
): unknown {
  const fieldName = path.split(".").pop() ?? path;
  const slug = slugify(descriptor.label);
  switch (descriptor.semanticType) {
    case "identifier":
      return `x_${rowIndex + 1}`;
    case "text":
      return `${descriptor.label} ${rowIndex + 1}`;
    case "rich-text":
      return `<p>${descriptor.label} ${rowIndex + 1} — <strong>details</strong>.</p>`;
    case "image-url":
      return `https://example.com/images/${slug}-${rowIndex + 1}.png`;
    case "url":
      return `https://example.com/${slug}/${rowIndex + 1}`;
    case "money":
      // A number, not a string: the money treatment is Intl.NumberFormat with
      // the descriptor's currency, and a component gets no chance to do that
      // if the fixture hands it pre-formatted text.
      return [42.5, 7.99, 129][rowIndex % 3];
    case "quantity":
      return [120, 45, 900][rowIndex % 3];
    case "percentage":
      return [0.62, 0.35, 0.91][rowIndex % 3];
    case "date": {
      const daysAhead = [2, 14, -1][rowIndex % 3] ?? 2;
      return new Date(BASE_TIME + daysAhead * DAY_MS).toISOString().slice(0, 10);
    }
    case "date-time": {
      const hoursAgo = [3, 30, 200][rowIndex % 3] ?? 3;
      return new Date(BASE_TIME - hoursAgo * 3_600_000).toISOString();
    }
    case "status": {
      const allowed = (dataType && enumValuesFor(dataType.schema, fieldName)) ?? [
        "active",
        "pending",
        "archived",
      ];
      return allowed[rowIndex % allowed.length];
    }
    case "boolean":
      return rowIndex % 2 === 0;
    case "location":
      return `Aisle ${rowIndex + 3}`;
    case "unknown":
      return `${descriptor.label} ${rowIndex + 1}`;
  }
}

/** Restores a dotted approved path to the nested object shape rows really have. */
function setNested(row: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let cursor = row;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    }
  }
}

export interface SynthesizeSampleRowsOptions {
  dataType: DataTypeDescriptor;
  /** Narrow to these approved paths. Required paths are always included regardless. */
  fieldPaths?: readonly string[];
  requiredOutputFields?: readonly string[];
  rowCount?: number;
}

export function synthesizeSampleRows(
  options: SynthesizeSampleRowsOptions,
): Record<string, unknown>[] {
  const rowCount = options.rowCount ?? 3;
  const paths = new Set<string>(
    options.fieldPaths ?? Object.keys(options.dataType.fields),
  );
  // `requiredOutputFields` are what the executor always includes, so a fixture
  // without them would smoke-test a data shape that can never occur.
  for (const path of options.requiredOutputFields ?? []) paths.add(path);

  const rows: Record<string, unknown>[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row: Record<string, unknown> = {};
    for (const path of paths) {
      const descriptor = options.dataType.fields[path];
      if (!descriptor) continue;
      setNested(
        row,
        path,
        synthesizeSampleValue(descriptor, path, rowIndex, options.dataType),
      );
    }
    rows.push(row);
  }
  return rows;
}

/**
 * One entry per lifecycle state the render-smoke check mounts. Mirrors the
 * executor-written companion props documented in AUTHORING_VIEWS.md — same
 * names, same shapes — because the fixture is standing in for the executor.
 */
export interface StateFixture {
  name: "ready" | "empty" | "error" | "truncated";
  slotValue: unknown;
  companions: Record<string, unknown>;
}

export function buildStateFixtures(options: {
  rows: Record<string, unknown>[];
  shape: ResultShape;
  sourceId?: string;
}): StateFixture[] {
  const sourceId = options.sourceId ?? "fixture-source";
  const asOf = new Date(BASE_TIME).toISOString();
  const collectionLike = options.shape !== "entity" && options.shape !== "metric";
  const readyValue = collectionLike ? options.rows : (options.rows[0] ?? null);
  const base = {
    sources: [sourceId],
    asOf,
    staleAt: "",
    records: [],
  };
  return [
    {
      name: "ready",
      slotValue: readyValue,
      companions: {
        ...base,
        state: "ready",
        completeness: {
          complete: true,
          truncated: false,
          ...(collectionLike ? { rowCount: options.rows.length } : {}),
        },
      },
    },
    {
      name: "empty",
      slotValue: collectionLike ? [] : null,
      companions: {
        ...base,
        state: "empty",
        completeness: {
          complete: true,
          truncated: false,
          ...(collectionLike ? { rowCount: 0 } : {}),
        },
      },
    },
    {
      name: "error",
      slotValue: null,
      companions: {
        state: "error",
        errorMessage: "This data could not be loaded.",
        sources: [],
        asOf: "",
        staleAt: "",
        records: [],
      },
    },
    {
      name: "truncated",
      slotValue: readyValue,
      companions: {
        ...base,
        state: "ready",
        completeness: {
          complete: false,
          truncated: true,
          rowCount: options.rows.length,
          totalRows: options.rows.length + 38,
        },
      },
    },
  ];
}
