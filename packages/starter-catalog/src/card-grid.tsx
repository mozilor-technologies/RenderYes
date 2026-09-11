import type { FC } from "react";
import { defineHostComponent, defineProps, field } from "@renderyes/react";
import type { RegisteredHostComponent } from "@renderyes/react";
import type { ComponentDataAcceptance } from "@renderyes/site-sdk";
import {
  activationFor,
  applyFormats,
  clickableStyle,
  createParts,
  deriveImageKey,
  deriveScalarFields,
  imageAltKey,
  deriveTitleKey,
  formatValue,
  humanize,
  isImageUrl,
  isRecord,
  renderField,
  resolveFieldValue,
  StateShell,
  type FieldSpec,
  type SlotCompanions,
  type StarterComponentOptions,
} from "./shared.js";

export interface CardGridOptions extends StarterComponentOptions {
  /** Key used as each card's title. Defaults to the first plain-string field. */
  titleKey?: string;
  /** Fields shown inside each card. Defaults to the next few scalar fields. */
  bodyFields?: readonly FieldSpec[];
  /** Cap for derived body fields. Default 4. */
  maxBodyFields?: number;
  /** Format derived body fields by key. */
  formats?: import("./shared.js").FieldFormats;
  accepts?: readonly ComponentDataAcceptance[];
  /**
   * Field whose value is an image URL, rendered as the card's picture.
   * Defaults to auto-detection (the first field whose value looks like an
   * image URL); pass `false` to never show images.
   */
  imageKey?: string | false;
  /**
   * Host-owned URL for a card, e.g. `(item) => "#/recipes/" + item.id`.
   * Cards it returns a string for become clickable (mouse and keyboard).
   * The model never sees or influences these URLs.
   */
  getCardHref?: (item: Record<string, unknown>) => string | undefined;
  /** SPA alternative to `getCardHref` navigation: push through your router instead. */
  onCardActivate?: (item: Record<string, unknown>, href?: string) => void;
}

export interface CardGridViewProps extends SlotCompanions {
  heading?: string;
  items?: readonly unknown[] | null;
}

export function createCardGridView(options: CardGridOptions = {}): FC<CardGridViewProps> {
  const parts = createParts(options);
  const maxBodyFields = options.maxBodyFields ?? 4;
  const cardActivation = {
    getHref: options.getCardHref,
    onActivate: options.onCardActivate,
  };

  return function StarterCardGridView({ heading, items, ...companions }) {
    const list = (Array.isArray(items) ? items : []).filter(isRecord);
    const titleKey = options.titleKey ?? deriveTitleKey(list);
    const imageKey =
      options.imageKey === false ? undefined : (options.imageKey ?? deriveImageKey(list));
    // The image's alt-text sibling belongs on the <img>, not in the body copy.
    const altKey = imageAltKey(imageKey);
    const bodyFields = applyFormats(
      options.bodyFields && options.bodyFields.length > 0
        ? [...options.bodyFields]
        : deriveScalarFields(list, titleKey, maxBodyFields, [imageKey, altKey]),
      options.formats,
    );

    return (
      <StateShell
        heading={heading}
        hasData={list.length > 0}
        parts={parts}
        messages={options.messages}
        hideProvenance={options.hideProvenance}
        {...companions}
      >
        <div className={parts.cls("grid")} style={parts.sty("grid")}>
          {list.map((row, index) => {
            const activation = activationFor(row, cardActivation);
            return (
              <article
                key={index}
                className={parts.cls("card") + (activation ? " iv-starter-clickable" : "")}
                style={
                  activation && !options.unstyled
                    ? { ...parts.sty("card"), ...clickableStyle }
                    : parts.sty("card")
                }
                {...activation?.props}
              >
                {imageKey && isImageUrl(resolveFieldValue(row, imageKey)) ? (
                  <img
                    src={resolveFieldValue(row, imageKey) as string}
                    // The catalog's own alt text when the row carries it —
                    // that field describes the image; the title describes the
                    // record, and only stands in when no alt was approved.
                    alt={
                      (altKey && typeof resolveFieldValue(row, altKey) === "string"
                        ? (resolveFieldValue(row, altKey) as string)
                        : undefined) ??
                      (titleKey ? formatValue(resolveFieldValue(row, titleKey)) : "")
                    }
                    loading="lazy"
                    className={parts.cls("cardImage")}
                    style={parts.sty("cardImage")}
                  />
                ) : null}
                <h4 className={parts.cls("cardTitle")} style={parts.sty("cardTitle")}>
                  {titleKey ? formatValue(resolveFieldValue(row, titleKey)) : `Item ${index + 1}`}
                </h4>
                {bodyFields.map((spec) => (
                  <p
                    key={spec.key}
                    className={parts.cls("cardBody")}
                    style={parts.sty("cardBody")}
                  >
                    {(spec.label ?? humanize(spec.key)) + ": " + renderField(spec, row)}
                  </p>
                ))}
              </article>
            );
          })}
        </div>
      </StateShell>
    );
  };
}

/**
 * A browsable card grid over any approved collection — the softer
 * alternative to the data table when rows are few or fields are sparse.
 */
export function createCardGrid(options: CardGridOptions = {}): RegisteredHostComponent {
  return defineHostComponent({
    id: options.id ?? "StarterCardGrid",
    version: options.version ?? "1.0.0",
    description:
      options.description ??
      "Card grid for a collection. Renders each record as a card with a title and a few supporting fields. Use for browsable lists where a table is too dense.",
    props: defineProps({
      heading: field.string({
        default: options.defaultHeading ?? "Items",
        description:
          "Heading shown above the component. Restate the visitor's request in their own words — not the data type's internal name.",
      }),
    }),
    dataSlots: {
      items: { accepts: options.accepts ?? [{ shape: "collection" }] },
    },
    component: createCardGridView(options),
  });
}
