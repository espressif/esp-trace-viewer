/**
 * Inline function-trace disclosure glyph shared by the timeline gutter canvas and the lanes editor DOM.
 *
 * The glyph represents a call tree where outermost calls appear at the bottom and callees stack upward, matching timeline vertical ordering conventions.
 */

/** Defines a bar of the glyph in a 12x8 pixel coordinate space with the origin at the top left. */
export interface GlyphBar {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Glyph dimensions in CSS pixels. */
export const GLYPH_W = 12;
export const GLYPH_H = 8;

/** Bar geometries comprising a base bar, two intermediate bars, and one top bar. */
export const GLYPH_BARS: readonly GlyphBar[] = [
  { x: 0, y: 6, w: 12, h: 2 },
  { x: 0, y: 3, w: 5, h: 2 },
  { x: 7, y: 3, w: 5, h: 2 },
  { x: 8, y: 0, w: 3, h: 2 },
];

/** Draws the glyph onto a canvas with its top-left corner at `(x, y)` using current fill style. */
export function drawGlyph(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  for (const b of GLYPH_BARS) ctx.fillRect(x + b.x, y + b.y, b.w, b.h);
}

/** Creates the glyph as an inline SVG element styled with `currentColor`. */
export function glyphSvg(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${GLYPH_W} ${GLYPH_H}`);
  svg.setAttribute("width", String(GLYPH_W));
  svg.setAttribute("height", String(GLYPH_H));
  svg.setAttribute("aria-hidden", "true");
  for (const b of GLYPH_BARS) {
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", String(b.x));
    rect.setAttribute("y", String(b.y));
    rect.setAttribute("width", String(b.w));
    rect.setAttribute("height", String(b.h));
    rect.setAttribute("fill", "currentColor");
    svg.append(rect);
  }
  return svg;
}
