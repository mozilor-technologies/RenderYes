/**
 * A PantryQL-shaped fixture: the catalog, review-export bundle, and scripted
 * model envelopes the end-to-end tests run against. Shaped after the real
 * reference host (ShoppingItem/Recipe, identifier/date/quantity+unit/money/status/
 * boolean semantic types) because that is the host the live acceptance run
 * will target — the mock should exercise the same field treatments.
 */
import { createPlannerManifest } from "@renderyes/capability-catalog";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  toSiteManifest,
} from "@renderyes/site-sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const PLAIN_HOST_DIR = join(FIXTURES_DIR, "plain-host");
export const LISTED_HOST_DIR = join(FIXTURES_DIR, "listed-host");
export const SHADCN_HOST_DIR = join(FIXTURES_DIR, "shadcn-host");
export const TAILWIND_HOST_DIR = join(FIXTURES_DIR, "tailwind-host");

export function buildCatalog() {
  return {
    schemaVersion: "1.0",
    id: "pantryql",
    version: "1.0.0",
    description: "Approved reads from PantryQL.",
    dataTypes: [
      {
        id: "ShoppingItem",
        version: "1.0.0",
        description: "One item on the visitor's pantry shopping list.",
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              recipeId: { type: "string" },
              name: { type: "string" },
              quantity: { type: "number" },
              expiresOn: { type: "string" },
              status: { type: "string", enum: ["needed", "low", "stocked"] },
              purchased: { type: "boolean" },
              price: { type: "number" },
              nutrition: {
                type: "object",
                properties: { calories: { type: "number" } },
              },
            },
          },
        },
        fields: {
          id: { label: "Item id", semanticType: "identifier" },
          recipeId: { label: "Recipe id", semanticType: "identifier" },
          name: { label: "Item name", semanticType: "text" },
          quantity: { label: "Quantity", semanticType: "quantity", unit: "g" },
          expiresOn: {
            label: "Expires on",
            semanticType: "date",
            description: "The day this item expires.",
          },
          status: { label: "Stock status", semanticType: "status" },
          purchased: { label: "Purchased", semanticType: "boolean" },
          price: { label: "Price", semanticType: "money", currency: "USD" },
          "nutrition.calories": {
            label: "Calories",
            semanticType: "quantity",
            unit: "kcal",
          },
        },
        matchKey: "id",
      },
      {
        id: "Recipe",
        version: "1.0.0",
        description: "One recipe the visitor can cook.",
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              imageUrl: { type: "string" },
              totalTimeMinutes: { type: "number" },
              updatedAt: { type: "string" },
            },
          },
        },
        fields: {
          id: { label: "Recipe id", semanticType: "identifier" },
          title: { label: "Recipe title", semanticType: "text" },
          imageUrl: { label: "Photo", semanticType: "image-url" },
          totalTimeMinutes: {
            label: "Total time",
            semanticType: "quantity",
            unit: "min",
          },
          updatedAt: { label: "Updated", semanticType: "date-time" },
        },
        matchKey: "id",
      },
    ],
    sources: [{ id: "pantry-source", label: "PantryQL" }],
    capabilities: [
      {
        id: "pantry.items.list",
        version: "1.0.0",
        purpose: "List the items on the visitor's pantry shopping list.",
        kind: "query",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "array" },
        output: { dataTypeId: "ShoppingItem", shape: "collection" },
        requiredSessionKeys: [],
        sourceIds: ["pantry-source"],
        policy: { authentication: "session", maximumRows: 100 },
      },
      {
        id: "pantry.recipes.list",
        version: "1.0.0",
        purpose: "List recipes the visitor can cook from their pantry.",
        kind: "query",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "array" },
        output: { dataTypeId: "Recipe", shape: "collection" },
        requiredSessionKeys: [],
        sourceIds: ["pantry-source"],
        policy: { authentication: "session", maximumRows: 50 },
      },
    ],
    relationships: [
      {
        id: "recipe-shopping-items",
        description: "The shopping items a recipe still needs.",
        from: { dataTypeId: "Recipe", field: "id" },
        to: { dataTypeId: "ShoppingItem", field: "recipeId" },
        cardinality: "one-to-many",
      },
    ],
  };
}

/** The host's already-registered UI: one generic table, like a starter-catalog host. */
export function buildUiManifest() {
  const genericTable = defineComponent({
    id: "GenericTable",
    version: "1.0.0",
    description: "Renders any collection as a table, one row per record.",
    props: defineProps({}),
    renderer: { component: "GenericTable", props: { rows: { path: "/rows" } } },
    dataSlots: { rows: { accepts: [{ shape: "collection" }] } },
  });
  const site = defineSite({
    id: "pantryql",
    name: "PantryQL",
    version: "1.0.0",
    catalogId: "pantryql",
    components: [genericTable],
    surfaces: [
      defineSurface({
        id: "main",
        description: "The pantry workspace surface.",
        componentIds: ["GenericTable"],
      }),
    ],
  });
  return toSiteManifest(site);
}

export function buildReviewExportBundle() {
  const catalog = buildCatalog();
  return {
    format: "renderyes-review-export",
    formatVersion: 1,
    catalogId: "pantryql",
    bindingKind: "graphql",
    capability: {
      catalog,
      plannerManifest: createPlannerManifest(catalog),
      bindings: {
        "pantry.items.list": {
          capabilityId: "pantry.items.list",
          requiredOutputFields: ["id"],
        },
        "pantry.recipes.list": {
          capabilityId: "pantry.recipes.list",
          requiredOutputFields: ["id"],
        },
      },
      schema: "type Query { pantryItems: [String!]! }",
      endpoint: "http://localhost:4000/graphql",
    },
    ui: { manifest: buildUiManifest() },
    requirements: { upstreamOrigins: ["http://localhost:4000"] },
  };
}

const GOOD_SPEC = {
  id: "PantryShoppingList",
  version: "1.0.0",
  description:
    "Displays the visitor's pantry shopping list as cards grouped by purchase status — " +
    "the view for any request about what still needs buying.",
  props: { title: { type: "string", default: "Shopping list" } },
  dataSlots: {
    items: { accepts: [{ dataTypeId: "ShoppingItem", shapes: ["collection"] }] },
  },
  accessibility: {
    label: "Shopping list",
    description: "Pantry shopping items grouped by purchase status.",
  },
};

function componentFile({ itemHeading }) {
  return `import { defineView, field } from "@renderyes/react";

export const spec = defineView({
  id: "PantryShoppingList",
  version: "1.0.0",
  description:
    "Displays the visitor's pantry shopping list as cards grouped by purchase status — " +
    "the view for any request about what still needs buying.",
  props: { title: field.string({ default: "Shopping list" }) },
  dataSlots: {
    items: { accepts: [{ dataTypeId: "ShoppingItem", shapes: ["collection"] }] },
  },
  accessibility: {
    label: "Shopping list",
    description: "Pantry shopping items grouped by purchase status.",
  },
});

function formatExpiry(value) {
  if (typeof value !== "string" || value === "") return "\\u2014";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "\\u2014";
  const days = Math.round((date.getTime() - Date.now()) / 86400000);
  const formatted = date.toLocaleDateString();
  if (days < 0) return formatted + " (expired)";
  if (days <= 3) return formatted + " (expires soon)";
  return formatted;
}

const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

export default function PantryShoppingList({
  title,
  items,
  state,
  errorMessage,
  sources,
  completeness,
}) {
  if (state === "error") {
    return <p role="alert" className="pantry-error">{errorMessage ?? "This data could not be loaded."}</p>;
  }
  const rows = Array.isArray(items) ? items : [];
  if (state === "empty" || rows.length === 0) {
    return <p className="pantry-empty">Nothing on the shopping list right now.</p>;
  }
  // recipeId is deliberately not rendered: it is an identifier for joining, not information.
  const groups = [
    { label: "To buy", rows: rows.filter((row) => !row?.purchased) },
    { label: "Purchased", rows: rows.filter((row) => Boolean(row?.purchased)) },
  ];
  return (
    <section className="pantry-list" aria-label="Shopping list">
      <h2 className="pantry-heading">{title ?? "Shopping list"}</h2>
      {sources && sources.length === 0 ? (
        <p className="pantry-note">Not attributed to a source - treat these items as unverified.</p>
      ) : null}
      {completeness && completeness.complete === false ? (
        <p className="pantry-note">
          Showing the first {completeness.rowCount} of {completeness.totalRows} items.
        </p>
      ) : null}
      {groups.map(({ label, rows: group }) =>
        group.length === 0 ? null : (
          <div key={label}>
            <h3 className="pantry-subheading">{label}</h3>
            <ul className="pantry-items">
              {group.map((row, index) => (
                <li key={typeof row?.id === "string" ? row.id : index} className="pantry-item">
                  ${itemHeading}
                  <span className="pantry-quantity">
                    {typeof row?.quantity === "number" ? row.quantity + " g" : "\\u2014"}
                  </span>
                  <span className="pantry-status">{row?.status ?? "unknown"}</span>
                  <span className="pantry-price">
                    {typeof row?.price === "number" ? money.format(row.price) : "\\u2014"}
                  </span>
                  <span className="pantry-expiry">{formatExpiry(row?.expiresOn)}</span>
                  <span className="pantry-quantity">
                    {typeof row?.nutrition?.calories === "number"
                      ? row.nutrition.calories + " kcal"
                      : "\\u2014"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </section>
  );
}
`;
}

/** The gold-standard draft: every mechanical check passes. */
export function goodEnvelope() {
  return {
    componentFile: componentFile({
      itemHeading: `<span className="pantry-name">{row?.name ?? "\\u2014"}</span>`,
    }),
    spec: GOOD_SPEC,
    notes: [
      "Grouped by the purchased boolean; status rendered as a text badge.",
      "recipeId deliberately omitted: identifier used only for joins.",
    ],
  };
}

/**
 * The deliberately flawed first draft: identical except it titles each item
 * with the identifier — the exact "p_9" failure the generator exists to kill.
 */
export function flawedEnvelope() {
  return {
    componentFile: componentFile({
      itemHeading: `<h4 className="pantry-name">{row?.id}</h4>`,
    }),
    spec: GOOD_SPEC,
    notes: [],
  };
}
