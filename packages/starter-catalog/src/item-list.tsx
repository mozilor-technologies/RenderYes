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

export interface ItemListOptions extends StarterComponentOptions {
  /** Key used as each item's title line. Defaults to the first plain-string field. */
  titleKey?: string;
  /** Fields shown as the meta line under each title. Defaults to the next few scalars. */
  metaFields?: readonly FieldSpec[];
  /** Cap for derived meta fields. Default 3. */
  maxMetaFields?: number;
  /** Format derived meta fields by key. */
  formats?: import("./shared.js").FieldFormats;
  accepts?: readonly ComponentDataAcceptance[];
  /**
   * Field whose value is an image URL, rendered as a small thumbnail beside
   * each item. Defaults to auto-detection; pass `false` to never show one.
   */
  imageKey?: string | false;
  /**
   * Host-owned URL for an item. Items it returns a string for become
   * clickable (mouse and keyboard). The model never sees or influences
   * these URLs.
   */
  getItemHref?: (item: Record<string, unknown>) => string | undefined;
  /** SPA alternative to `getItemHref` navigation: push through your router instead. */
  onItemActivate?: (item: Record<string, unknown>, href?: string) => void;
}

export interface ItemListViewProps extends SlotCompanions {
  heading?: string;
  items?: readonly unknown[] | null;
}

export function createItemListView(options: ItemListOptions = {}): FC<ItemListViewProps> {
  const parts = createParts(options);
  const maxMetaFields = options.maxMetaFields ?? 3;
  const itemActivation = {
    getHref: options.getItemHref,
    onActivate: options.onItemActivate,
  };

  return function StarterItemListView({ heading, items, ...companions }) {
    const list = (Array.isArray(items) ? items : []).filter(isRecord);
    const titleKey = options.titleKey ?? deriveTitleKey(list);
    const imageKey =
      options.imageKey === false ? undefined : (options.imageKey ?? deriveImageKey(list));
    // The image's alt-text sibling belongs on the <img>, not in the meta line.
    const altKey = imageAltKey(imageKey);
    const metaFields = applyFormats(
      options.metaFields && options.metaFields.length > 0
        ? [...options.metaFields]
        : deriveScalarFields(list, titleKey, maxMetaFields, [imageKey, altKey]),
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
        <ul className={parts.cls("list")} style={parts.sty("list")}>
          {list.map((row, index) => {
            const activation = activationFor(row, itemActivation);
            const meta = metaFields
              .map((spec) => `${spec.label ?? humanize(spec.key)}: ${renderField(spec, row)}`)
              .join(" · ");
            return (
              <li
                key={index}
                className={
                  parts.cls("listItem") + (activation ? " iv-starter-clickable" : "")
                }
                style={
                  activation && !options.unstyled
                    ? { ...parts.sty("listItem"), ...clickableStyle }
                    : parts.sty("listItem")
                }
                {...activation?.props}
              >
                {imageKey && isImageUrl(resolveFieldValue(row, imageKey)) ? (
                  <img
                    src={resolveFieldValue(row, imageKey) as string}
                    alt={
                      (altKey && typeof resolveFieldValue(row, altKey) === "string"
                        ? (resolveFieldValue(row, altKey) as string)
                        : undefined) ??
                      (titleKey ? formatValue(resolveFieldValue(row, titleKey)) : "")
                    }
                    loading="lazy"
                    className={parts.cls("itemThumb")}
                    style={parts.sty("itemThumb")}
                  />
                ) : null}
                <div className={parts.cls("itemContent")} style={parts.sty("itemContent")}>
                  <p className={parts.cls("itemTitle")} style={parts.sty("itemTitle")}>
                    {titleKey ? formatValue(resolveFieldValue(row, titleKey)) : `Item ${index + 1}`}
                  </p>
                  {meta ? (
                    <p className={parts.cls("itemMeta")} style={parts.sty("itemMeta")}>
                      {meta}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </StateShell>
    );
  };
}

/**
 * A vertical list over any approved collection — for text-heavy records
 * (activity, comments, notes) where a table is too rigid and cards waste
 * space.
 */
export function createItemList(options: ItemListOptions = {}): RegisteredHostComponent {
  return defineHostComponent({
    id: options.id ?? "StarterItemList",
    version: options.version ?? "1.0.0",
    description:
      options.description ??
      "Vertical list of records, one title line plus supporting details per item. Use for activity feeds, recent events, comments, notes, and other reading-oriented lists.",
    props: defineProps({
      heading: field.string({
        default: options.defaultHeading ?? "Items",
        description:
          "Heading shown above the component. Restate the visitor's request in their own words — not the data type's internal name.",
      }),
    }),
    dataSlots: {
      items: { accepts: options.accepts ?? [{ shape: "collection" }, { shape: "search-results" }] },
    },
    component: createItemListView(options),
  });
}
