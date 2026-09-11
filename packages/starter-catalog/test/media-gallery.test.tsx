import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMediaGalleryView } from "../src/media-gallery.js";

afterEach(cleanup);

/**
 * The media gallery closes the shape gap: `media-collection` was declarable
 * and unrenderable. Its one behavioral rule beyond rendering: a row without a
 * usable image URL is skipped, never shown as an empty frame — a gallery's
 * promise is pictures.
 */

const LIBRARY = [
  { id: 1, url: "/api/media/file/bt-1.jpg", alt: "Runners at dawn" },
  { id: 2, url: "/api/media/file/bt-2.jpg", alt: "Floodlit stadium" },
  // A document, not a picture: must be skipped, not framed.
  { id: 3, url: "/api/media/file/annual-report.pdf", alt: "Annual report" },
];

describe("media gallery", () => {
  it("renders each picture with its alt text and caption", () => {
    const View = createMediaGalleryView();
    render(<View items={LIBRARY} state="ready" />);
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0]!.getAttribute("src")).toBe("/api/media/file/bt-1.jpg");
    expect(images[0]!.getAttribute("alt")).toBe("Runners at dawn");
    // Caption defaults to the alt text — visible, not only assistive.
    expect(screen.getAllByText("Floodlit stadium").length).toBeGreaterThan(0);
  });

  it("skips rows without a usable image URL rather than framing them broken", () => {
    const View = createMediaGalleryView();
    const { container } = render(
      <View items={[{ id: 9, alt: "no url at all" }, ...LIBRARY]} state="ready" />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });

  it("renders no frames at all when nothing in the slot is a picture", () => {
    // Matching the other starters: `state` is the executor's verdict, and a
    // ready-but-unusable slot renders empty rather than second-guessing it.
    const View = createMediaGalleryView();
    const { container } = render(<View items={[{ id: 9, alt: "nope" }]} state="ready" />);
    expect(container.querySelectorAll("img, figure")).toHaveLength(0);
  });

  it("renders the executor's empty state as the standard message", () => {
    const View = createMediaGalleryView();
    render(<View items={[]} state="empty" />);
    expect(screen.getByText("No matching records.")).toBeTruthy();
  });
});
