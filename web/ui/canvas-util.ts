/**
 * Canvas-2D helpers shared across timeline, CPU-load, and dataplot panes. Renders a shared time grid aligned with {@link TimeScale}.
 */

import { formatDuration } from "../core/format.js";
import type { ReferenceMarker } from "../core/store.js";
import type { TimeScale } from "../trace-ui-toolkit/time-scale.js";

/** A drawing context plus the CSS-pixel size and device-pixel ratio of a canvas. */
export interface CanvasFrame {
  ctx: CanvasRenderingContext2D;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

/**
 * Begin a frame on `canvas`: clear it and scale context for CSS pixels and device pixel ratio. Returns null if the canvas has no backing store, is not laid out, or lacks a 2D context.
 *
 * `dpr` overrides the device pixel ratio the frame is drawn at. An image export raises it and enlarges the
 * backing store to match, which multiplies the pixels without moving anything: the CSS size the frame
 * reports back stays the same, so the layout, the type sizes and the pixel coalescing are all unchanged.
 */
export function beginFrame(
  canvas: HTMLCanvasElement,
  dpr = globalThis.devicePixelRatio || 1,
): CanvasFrame | null {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
  // Collapsed or unattached panes maintain a 1x1 backing store without a CSS layout. Drawing with zero client dimensions would inject an invalid width into the shared TimeScale and corrupt coordinate mapping.
  if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return null;
  const cssWidth = canvas.width / dpr;
  const cssHeight = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return { ctx, cssWidth, cssHeight, dpr };
}

/** Read a CSS custom property from the document root. */
export function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Draw evenly spaced vertical time gridlines with optional duration labels across the frame, aligned to the shared {@link TimeScale}. Returns the number of gridlines drawn.
 */
export function drawTimeGrid(frame: CanvasFrame, ts: TimeScale, opts: { labels?: boolean } = {}): number {
  const { ctx, cssWidth, cssHeight } = frame;
  const line = cssVar("--grid-line", "rgba(128,128,128,0.25)");
  const text = cssVar("--grid-text", "rgba(128,128,128,0.9)");

  const targetPx = 100; // Target gridline spacing in pixels.
  const approx = ts.secondsPerPixel * targetPx;
  const step = niceStep(approx);
  if (step <= 0) return 0;

  ctx.save();
  ctx.strokeStyle = line;
  ctx.fillStyle = text;
  ctx.lineWidth = 1;
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "top";

  let count = 0;
  const first = Math.ceil(ts.t0 / step) * step;
  for (let t = first; t <= ts.t1; t += step) {
    const x = Math.round(ts.timeToX(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssHeight);
    ctx.stroke();
    if (opts.labels) ctx.fillText(formatDuration(t), x + 3, 2);
    count++;
    if (count > 1000) break; // Guard against degenerate step sizes.
  }
  ctx.restore();
  return count;
}

/**
 * Draw reference markers as dashed vertical lines from `topY` to the bottom of the frame, aligned to the shared {@link TimeScale}. Markers outside the visible viewport are omitted. Returns the number of lines drawn.
 */
export function drawReferenceLines(
  frame: CanvasFrame,
  ts: TimeScale,
  references: readonly ReferenceMarker[],
  topY = 0,
): number {
  if (!references.length) return 0;
  const { ctx, cssHeight } = frame;
  ctx.save();
  ctx.strokeStyle = cssVar("--reference-line", "rgba(240, 170, 40, 0.95)");
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  let count = 0;
  for (const r of references) {
    if (r.time < ts.t0 || r.time > ts.t1) continue;
    const x = Math.round(ts.timeToX(r.time)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, cssHeight);
    ctx.stroke();
    count++;
  }
  ctx.restore();
  return count;
}

/** Round a raw step up to a 1, 2, or 5 multiple of 10ⁿ. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * pow;
}
