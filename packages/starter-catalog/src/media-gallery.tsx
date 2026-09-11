import type { FC } from "react";
import { defineHostComponent, defineProps, field } from "@renderyes/react";
import type { RegisteredHostComponent } from "@renderyes/react";
import type { ComponentDataAcceptance } from "@renderyes/site-sdk";
import {
  activationFor,
  clickableStyle,
  createParts,
  formatValue,
  isImageUrl,
  isRecord,
  resolveFieldValue,
  StateShell,
  type SlotCompanions,
  type StarterComponentOptions,
} from "./shared.js";

/**
 * An image gallery over a media collection.
 *
 * `media-collection` has been a declarable result shape since the catalog
 * grew shapes, and no starter component accepted it — a host declaring a
 * picture library truthfully got `unrenderable: true` in every coverage
 * report, while the card grid mis-served it (cards are records that happen to
 * carry an image; a gallery is images that happen to carry records).
 *
 * A row that carries no usable image URL is skipped rather than rendered as
 * an empty frame — a gallery's promise is pictures, and a broken-image tile
 * misreports the library. Skipping is disclosed through the standard
 * completeness line rather than silently, via the caller's own row count.
 */
export interface MediaGalleryOptions extends StarterComponentOptions {
  /** Field holding the image URL. Default "url". */
  urlKey?: string;
  /** Field holding the image's alt text. Default "alt". */
  altKey?: string;
  /**
   * Field shown as the visible caption under each image. Defaults to the alt
   * text, which every accessible media library already carries.
   */
  captionKey?: string;
  accepts?: readonly ComponentDataAcceptance[];
  /** Host-owned URL for an image (full view, source page). Never model-set. */
  getImageHref?: (item: Record<string, unknown>) => string | undefined;
  /** SPA alternative to `getImageHref` navigation. */
  onImageActivate?: (item: Record<string, unknown>, href?: string) => void;
}

export interface MediaGalleryViewProps extends SlotCompanions {
  heading?: string;
  items?: readonly unknown[] | null;
}

export function createMediaGalleryView(
  options: MediaGalleryOptions = {},
): FC<MediaGalleryViewProps> {
  const parts = createParts(options);
  const urlKey = options.urlKey ?? "url";
  const altKey = options.altKey ?? "alt";
  const captionKey = options.captionKey ?? altKey;
  const imageActivation = {
    getHref: options.getImageHref,
    onActivate: options.onImageActivate,
  };

  return function StarterMediaGalleryView({ heading, items, ...companions }) {
    const rows = (Array.isArray(items) ? items : []).filter(isRecord);
    const pictures = rows.filter((row) => isImageUrl(resolveFieldValue(row, urlKey)));

    return (
      <StateShell
        heading={heading}
        hasData={pictures.length > 0}
        parts={parts}
        messages={options.messages}
        hideProvenance={options.hideProvenance}
        {...companions}
      >
        <div className={parts.cls("gallery")} style={parts.sty("gallery")}>
          {pictures.map((row, index) => {
            const activation = activationFor(row, imageActivation);
            const alt = resolveFieldValue(row, altKey);
            const caption = resolveFieldValue(row, captionKey);
            return (
              <figure
                key={index}
                className={
                  parts.cls("galleryItem") + (activation ? " iv-starter-clickable" : "")
                }
                style={
                  activation && !options.unstyled
                    ? { ...parts.sty("galleryItem"), ...clickableStyle }
                    : parts.sty("galleryItem")
                }
                {...activation?.props}
              >
                <img
                  src={resolveFieldValue(row, urlKey) as string}
                  alt={typeof alt === "string" ? alt : ""}
                  loading="lazy"
                  className={parts.cls("galleryImage")}
                  style={parts.sty("galleryImage")}
                />
                {caption ? (
                  <figcaption
                    className={parts.cls("galleryCaption")}
                    style={parts.sty("galleryCaption")}
                  >
                    {formatValue(caption)}
                  </figcaption>
                ) : null}
              </figure>
            );
          })}
        </div>
      </StateShell>
    );
  };
}

export function createMediaGallery(
  options: MediaGalleryOptions = {},
): RegisteredHostComponent {
  return defineHostComponent({
    id: options.id ?? "StarterMediaGallery",
    version: options.version ?? "1.0.0",
    description:
      options.description ??
      "Image gallery for a media collection — photographs, illustrations, or any picture library, shown as a grid of images with their captions. Prefer this over cards or a table whenever the records ARE the pictures.",
    props: defineProps({
      heading: field.string({
        default: options.defaultHeading ?? "Gallery",
        description:
          "Heading shown above the gallery. Restate what the pictures are of, in the visitor's own words.",
      }),
    }),
    dataSlots: {
      items: {
        accepts: options.accepts ?? [{ shape: "media-collection" }, { shape: "collection" }],
      },
    },
    component: createMediaGalleryView(options),
  });
}
