/**
 * Geometry for the timeline's overflow overlay.
 *
 * A {@link TraceGap} is an interval on one core where the target dropped events. The timeline paints every visible gap as a hatched band across all lanes, the way the SEGGER SystemView desktop app does. The helpers here turn the model's gap list into the pixel rectangles to paint, hit-test them for the tooltip and click, and build the hatch tile; the pane does the drawing.
 *
 * Timestamps map onto `[offsetPx, widthPx]` the way {@link ../../core/time-scale.TimeScale.timeToX} does, mirroring {@link ./timeline-rows.coalesceToPixels}.
 */

import type { TraceGap } from "../../../src/trace/index.js";

/** Shared empty set standing in for "no core is switched off". */
const EMPTY_CORES: ReadonlySet<number> = new Set<number>();

/** Narrowest a gap is painted, in CSS px, so a gap shorter than a pixel still shows. */
export const GAP_MIN_PX = 2;

/** Pixels either side of a painted gap that still count as hovering it, so a {@link GAP_MIN_PX} band can be hit. */
export const GAP_HIT_TOL_PX = 2;

/** One gap placed on the canvas. */
export interface GapSpan {
  /** Left edge, in CSS px from the canvas origin. */
  x0: number;
  /** Right edge, in CSS px; at least {@link GAP_MIN_PX} past `x0`. */
  x1: number;
  gap: TraceGap;
}

/** A rectangle to paint: the union of the visible gaps that overlap or touch on screen. */
export interface GapRect {
  /** Left edge, in CSS px from the canvas origin. */
  x0: number;
  /** Right edge, in CSS px. */
  x1: number;
  /** Cores with a gap inside the rectangle, ascending. */
  cores: number[];
  /** The gaps merged into the rectangle, in model order. */
  spans: GapSpan[];
}

/**
 * Places the gaps intersecting `[t0, t1]` on a canvas and merges the ones that overlap or touch into one rectangle each, so gaps on different cores over the same interval paint once rather than stacking their alpha.
 *
 * Gaps are clipped to `[offsetPx, widthPx]` and widened to `minWidthPx` when narrower, so a zero-length gap still gets a band. Gaps on a core listed in `hiddenCores` are left out. Rectangles come back left to right.
 */
export function gapRects(
  gaps: readonly TraceGap[],
  t0: number,
  t1: number,
  widthPx: number,
  offsetPx = 0,
  minWidthPx = GAP_MIN_PX,
  hiddenCores: ReadonlySet<number> = EMPTY_CORES,
): GapRect[] {
  const out: GapRect[] = [];
  const span = t1 - t0;
  const plotW = widthPx - offsetPx;
  if (span <= 0 || plotW <= 0) return out;
  const sx = plotW / span;

  let cur: GapRect | null = null;
  // Gaps are sorted by start, so once one starts past the window the rest do too.
  for (const gap of gaps) {
    if (gap.start > t1) break;
    if (gap.end < t0 || hiddenCores.has(gap.coreId)) continue;
    let x0 = offsetPx + (gap.start - t0) * sx;
    let x1 = offsetPx + (gap.end - t0) * sx;
    if (x0 < offsetPx) x0 = offsetPx;
    if (x1 > widthPx) x1 = widthPx;
    if (x1 < x0) continue;
    if (x1 - x0 < minWidthPx) {
      // Widen leftwards at the right edge, so the band stays inside the plot.
      x1 = Math.min(widthPx, x0 + minWidthPx);
      x0 = Math.max(offsetPx, x1 - minWidthPx);
    }

    const placed: GapSpan = { x0, x1, gap };
    if (cur && x0 <= cur.x1) {
      if (x1 > cur.x1) cur.x1 = x1;
      if (!cur.cores.includes(gap.coreId)) cur.cores.push(gap.coreId);
      cur.spans.push(placed);
    } else {
      cur = { x0, x1, cores: [gap.coreId], spans: [placed] };
      out.push(cur);
    }
  }
  for (const r of out) r.cores.sort((a, b) => a - b);
  return out;
}

/**
 * The gaps under canvas x-coordinate `x`, allowing `tolerancePx` either side of each painted band, in model order. Empty when `x` is over no gap.
 */
export function gapsAtX(rects: readonly GapRect[], x: number, tolerancePx = GAP_HIT_TOL_PX): GapSpan[] {
  const out: GapSpan[] = [];
  for (const r of rects) {
    if (x < r.x0 - tolerancePx || x > r.x1 + tolerancePx) continue;
    for (const s of r.spans) if (x >= s.x0 - tolerancePx && x <= s.x1 + tolerancePx) out.push(s);
  }
  return out;
}

/** Side of the square hatch tile, in CSS px. */
const HATCH_TILE_PX = 8;

/**
 * Builds a repeating 45° hatch as a canvas pattern in `color`, or `null` when the browser gives no pattern.
 *
 * The tile is drawn on an offscreen canvas of `HATCH_TILE_PX × dpr` device pixels and the pattern is then scaled back down by `dpr`, so under the frame's device-pixel transform the tile spans {@link HATCH_TILE_PX} CSS px and its lines land on whole device pixels, at any ratio the frame is drawn at: the screen's, or the raised one an image export uses. Three parallel strokes per tile — the diagonal and the two corner-crossing halves — make the tile seamless.
 */
export function hatchPattern(ctx: CanvasRenderingContext2D, dpr: number, color: string): CanvasPattern | null {
  const tile = document.createElement("canvas");
  const t = HATCH_TILE_PX;
  tile.width = Math.max(1, Math.round(t * dpr));
  tile.height = tile.width;
  const tc = tile.getContext("2d");
  if (!tc) return null;
  tc.scale(tile.width / t, tile.height / t);
  tc.strokeStyle = color;
  tc.lineWidth = 1;
  tc.lineCap = "square";
  tc.beginPath();
  tc.moveTo(0, t);
  tc.lineTo(t, 0);
  tc.moveTo(-t / 2, t / 2);
  tc.lineTo(t / 2, -t / 2);
  tc.moveTo(t / 2, t * 1.5);
  tc.lineTo(t * 1.5, t / 2);
  tc.stroke();
  const pattern = ctx.createPattern(tile, "repeat");
  if (pattern && typeof DOMMatrix !== "undefined") {
    pattern.setTransform(new DOMMatrix().scale(t / tile.width));
  }
  return pattern;
}
