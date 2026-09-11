import type { FC } from "react";
import { defineHostComponent, defineProps, field } from "@renderyes/react";
import type { RegisteredHostComponent } from "@renderyes/react";
import type { ComponentDataAcceptance } from "@renderyes/site-sdk";
import {
  applyFormats,
  collapseMoneyEntries,
  createParts,
  humanize,
  isIdentifierKey,
  isObjectArray,
  isRecord,
  renderFieldNode,
  scalarLeafEntries,
  StateShell,
  summarizeObjectArray,
  type FieldSpec,
  type SlotCompanions,
  type StarterComponentOptions,
} from "./shared.js";

export interface DetailPanelOptions extends StarterComponentOptions {
  /** Which entity fields to show, in order. Defaults to every scalar field. */
  fields?: readonly FieldSpec[];
  /** Format derived fields by key. */
  formats?: import("./shared.js").FieldFormats;
  accepts?: readonly ComponentDataAcceptance[];
}

export interface DetailPanelViewProps extends SlotCompanions {
  heading?: string;
  entity?: unknown;
}

function isDisplayableLeaf(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) &&
      value.every((item) => typeof item === "string" || typeof item === "number"))
  );
}

function scalarFields(entity: Record<string, unknown>): FieldSpec[] {
  // An array of objects renders as a one-line summary rather than vanishing:
  // it is still a collection (`createRecordWithLines` renders it in full),
  // but a fetched field must appear or be reported, never silently dropped.
  const specs = Object.entries(entity)
    .filter(([, value]) => isDisplayableLeaf(value) || isObjectArray(value))
    .map(([key, value]) =>
      isObjectArray(value) ? { key, format: summarizeObjectArray } : { key },
    );
  // Unlike a title, tile, or axis, a detail panel showing one record in full
  // is the one place an identifier belongs — it is how a visitor cites the
  // record back to support. So id-named fields stay, but sink below the
  // human-readable ones (the catalog leads with them; a person doesn't) and
  // render muted.
  return [
    ...specs.filter((spec) => !isIdentifierKey(spec.key)),
    ...specs.filter((spec) => isIdentifierKey(spec.key)),
  ];
}

/**
 * A nested object rendered as its own titled group.
 *
 * The panel used to keep top-level scalars and drop everything else, which on a
 * real entity is about half the fields: a Shopify order carries roughly forty
 * scalars, twenty single nested objects, and fifteen lists. An approved field
 * like `shippingAddress.city` therefore could not appear at all — the owner had
 * approved it, the payload contained it, and the renderer had no way to name it.
 *
 * One group per top-level object; *leaves* inside a group reach full depth.
 * The first fix here stopped at one level, which re-created the same bug one
 * hop down: a Relay-shaped `total.gross.amount` left the "Total" group with no
 * displayable field, so the group vanished and the money with it. Depth in a
 * label is carried by the label itself ("Gross · Amount"), and an owner who
 * wants less passes an explicit `fields` list.
 *
 * Arrays of objects appear as one summary row each (count plus the first few
 * item titles), never as dotted `lines.0.sku` rows: the full table is
 * `createRecordWithLines`'s job, but a fetched field must render something —
 * silently dropping it left "which countries does each zone cover?" answered
 * with nothing at all.
 */
interface FieldGroup {
  title: string;
  fields: readonly FieldSpec[];
}

function nestedGroups(entity: Record<string, unknown>): FieldGroup[] {
  return Object.entries(entity)
    .filter(([, value]) => isRecord(value))
    .map(([key, value]) => ({
      title: humanize(key),
      // Dotted, so the value resolves through the same path the approval
      // used. Money leaves reassemble after prefixing — the currency lookup
      // resolves against the whole entity, like the render does — and the
      // group's own key is stripped from the label it derives, so "Total"
      // heads "Gross", not "Total · Gross".
      fields: collapseMoneyEntries(
        scalarLeafEntries(value as Record<string, unknown>, {
          scalarArrays: true,
          objectArrays: true,
        }).map((spec) => ({ ...spec, key: `${key}.${spec.key}` })),
        [entity],
        { stripLabelPrefix: key },
      ),
    }))
    .filter((group) => group.fields.length > 0);
}

export function createDetailPanelView(
  options: DetailPanelOptions = {},
): FC<DetailPanelViewProps> {
  const parts = createParts(options);

  return function StarterDetailPanelView({ heading, entity, ...companions }) {
    const record = isRecord(entity) ? entity : undefined;
    const explicit = options.fields && options.fields.length > 0;
    // Sinking and muting only applies to *derived* fields: a host that
    // explicitly lists an id field has said it matters, and we take its word.
    const derived = !explicit;
    const fields = applyFormats(
      explicit
        ? [...options.fields!]
        : record
          ? collapseMoneyEntries(scalarFields(record), [record])
          : [],
      options.formats,
    );
    // Only derived. An explicit `fields` list is the owner saying exactly what to
    // show, in order — adding groups underneath it would override that.
    const groups =
      explicit || !record
        ? []
        : nestedGroups(record).map((group) => ({
            ...group,
            fields: applyFormats(group.fields, options.formats),
          }));

    return (
      <StateShell
        heading={heading}
        hasData={Boolean(record && (fields.length > 0 || groups.length > 0))}
        parts={parts}
        messages={options.messages}
        hideProvenance={options.hideProvenance}
        {...companions}
      >
        <dl className={parts.cls("body")} style={{ margin: 0 }}>
          {record
            ? fields.map((spec) => {
                const mutedId = derived && isIdentifierKey(spec.key);
                return (
                  <div
                    key={spec.key}
                    className={parts.cls("fieldRow")}
                    style={parts.sty("fieldRow")}
                  >
                    <dt className={parts.cls("fieldLabel")} style={parts.sty("fieldLabel")}>
                      {spec.label ?? humanize(spec.key)}
                    </dt>
                    <dd
                      className={parts.cls("fieldValue")}
                      style={
                        mutedId && !options.unstyled
                          ? {
                              margin: 0,
                              ...parts.sty("fieldValue"),
                              color: "var(--iv-starter-muted, #6b7280)",
                            }
                          : { margin: 0, ...parts.sty("fieldValue") }
                      }
                    >
                      {renderFieldNode(spec, record, parts)}
                    </dd>
                  </div>
                );
              })
            : null}
        </dl>
        {record
          ? groups.map((group) => (
              <section key={group.title}>
                {/* A heading, not a dotted prefix on every row: an address reads
                    as an address, and the group is what makes twenty nested
                    objects legible instead of forty ambiguous rows. */}
                <h4
                  className={parts.cls("groupTitle")}
                  style={{ margin: "12px 0 4px", fontSize: 13, ...parts.sty("groupTitle") }}
                >
                  {group.title}
                </h4>
                <dl className={parts.cls("body")} style={{ margin: 0 }}>
                  {group.fields.map((spec) => (
                    <div
                      key={spec.key}
                      className={parts.cls("fieldRow")}
                      style={parts.sty("fieldRow")}
                    >
                      <dt
                        className={parts.cls("fieldLabel")}
                        style={parts.sty("fieldLabel")}
                      >
                        {/* Inside a titled group the group's own prefix is
                            already stated — label the path after it. The rest
                            stays: under "Total", `gross.amount` and
                            `net.amount` labelled by leaf alone would both
                            read "Amount". */}
                        {spec.label ?? humanize(spec.key.split(".").slice(1).join("."))}
                      </dt>
                      <dd
                        className={parts.cls("fieldValue")}
                        style={{ margin: 0, ...parts.sty("fieldValue") }}
                      >
                        {renderFieldNode(spec, record, parts)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))
          : null}
      </StateShell>
    );
  };
}

/**
 * Labeled field rows over one approved entity. Accepts by shape, for
 * showing a single record in full.
 */
export function createDetailPanel(options: DetailPanelOptions = {}): RegisteredHostComponent {
  return defineHostComponent({
    id: options.id ?? "StarterDetailPanel",
    version: options.version ?? "1.0.0",
    description:
      options.description ??
      "Detail panel for a single record. Renders one entity's fields as labeled rows. Use to show one item in full.",
    props: defineProps({
      heading: field.string({
        default: options.defaultHeading ?? "Details",
        description:
          "Heading shown above the component. Restate the visitor's request in their own words — not the data type's internal name.",
      }),
    }),
    dataSlots: {
      entity: { accepts: options.accepts ?? [{ shape: "entity" }] },
    },
    component: createDetailPanelView(options),
  });
}
