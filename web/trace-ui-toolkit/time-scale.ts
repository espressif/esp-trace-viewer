/**
 * Maps trace timestamps to pixel coordinates across time-aligned canvas panes.
 *
 * An application-owned {@link TimeScale} instance coordinates zoom and pan transformations across all time-aligned panes. It maintains domain bounds, a mutable view window `[t0, t1]`, and a plot coordinate system spanning from {@link offsetPx} (gutter inset) to {@link widthPx}.
 *
 * The class maps numeric axis coordinates to pixels without assuming specific time units. Member names use seconds by default, but callers can supply values in any consistent numerical domain unit.
 *
 * All transformations clamp the view window within the trace domain and enforce a minimum duration of {@link minSpan}, ensuring consistent bidirectional mapping between timestamps and pixel coordinates.
 */

export interface TimeScaleInit {
  /** Start of the data domain, in seconds. */
  domainStart: number;
  /** End of the data domain, in seconds. */
  domainEnd: number;
  /** Total canvas width in CSS pixels. Defaults to 1. */
  widthPx?: number;
  /** Minimum visible time span in seconds (maximum zoom limit). Defaults to 1e-9. */
  minSpan?: number;
}

export class TimeScale {
  /** Start of the data domain, in seconds. */
  domainStart: number;
  /** End of the data domain, in seconds. */
  domainEnd: number;
  /** Minimum visible time span in seconds. */
  readonly minSpan: number;

  /** Left timestamp of the visible window, in seconds. */
  private viewT0: number;
  /** Right timestamp of the visible window, in seconds. */
  private viewT1: number;
  /** Total canvas width in CSS pixels. */
  private width: number;
  /** Left gutter offset in CSS pixels. */
  private offset: number;

  constructor(init: TimeScaleInit) {
    this.domainStart = init.domainStart;
    this.domainEnd = Math.max(init.domainEnd, init.domainStart);
    this.minSpan = init.minSpan ?? 1e-9;
    this.width = Math.max(1, init.widthPx ?? 1);
    this.offset = 0;
    this.viewT0 = this.domainStart;
    this.viewT1 = this.domainEnd > this.domainStart ? this.domainEnd : this.domainStart + this.minSpan;
  }

  /** Left timestamp of the visible window, in seconds. */
  get t0(): number {
    return this.viewT0;
  }

  /** Right timestamp of the visible window, in seconds. */
  get t1(): number {
    return this.viewT1;
  }

  /** Total canvas width in CSS pixels, including the left gutter offset. */
  get widthPx(): number {
    return this.width;
  }

  /** Left gutter offset in CSS pixels where window timestamp `t0` is mapped. */
  get offsetPx(): number {
    return this.offset;
  }

  /** Width of the active plot area in pixels (`widthPx` minus `offsetPx`). */
  get plotWidthPx(): number {
    return Math.max(1, this.width - this.offset);
  }

  /** Duration of the visible window in seconds (always ≥ {@link minSpan}). */
  get spanSeconds(): number {
    return this.viewT1 - this.viewT0;
  }

  /** Duration of the complete domain in seconds. */
  get domainSpan(): number {
    return this.domainEnd - this.domainStart;
  }

  /** Duration represented by one pixel across the active plot area. */
  get secondsPerPixel(): number {
    return this.spanSeconds / this.plotWidthPx;
  }

  /** Returns true when the visible window covers the complete domain. */
  get isFullyZoomedOut(): boolean {
    return this.viewT0 <= this.domainStart && this.viewT1 >= this.domainEnd;
  }

  /** Updates the domain bounds and clamps the current visible window into the updated range. */
  setDomain(domainStart: number, domainEnd: number): void {
    this.domainStart = domainStart;
    this.domainEnd = Math.max(domainEnd, domainStart);
    this.setWindow(this.viewT0, this.viewT1);
  }

  /** Updates the total canvas width in CSS pixels. */
  setWidthPx(px: number): void {
    this.width = Math.max(1, px);
  }

  /** Updates the left gutter offset in CSS pixels, clamped to `[0, widthPx)`. */
  setOffsetPx(px: number): void {
    this.offset = Math.min(Math.max(0, px), this.width - 1);
  }

  /** Maps a domain timestamp in seconds to an x-coordinate in `[offsetPx, widthPx]` pixel space. */
  timeToX(t: number): number {
    return this.offset + ((t - this.viewT0) / this.spanSeconds) * this.plotWidthPx;
  }

  /** Maps a pixel x-coordinate back to a domain timestamp in seconds. Inverse of {@link timeToX}. */
  xToTime(x: number): number {
    return this.viewT0 + ((x - this.offset) / this.plotWidthPx) * this.spanSeconds;
  }

  /**
   * Sets the visible time window, clamped to domain bounds and bounded below by {@link minSpan}.
   * Inverted or degenerate intervals expand to `minSpan` centered on their midpoint.
   */
  setWindow(t0: number, t1: number): void {
    let lo = Math.min(t0, t1);
    let hi = Math.max(t0, t1);
    if (hi - lo < this.minSpan) {
      const mid = (lo + hi) / 2;
      lo = mid - this.minSpan / 2;
      hi = mid + this.minSpan / 2;
    }
    // Clamp window within domain bounds while preserving at least minSpan duration.
    const span = Math.min(hi - lo, Math.max(this.domainSpan, this.minSpan));
    if (lo < this.domainStart) {
      lo = this.domainStart;
      hi = lo + span;
    }
    if (hi > this.domainEnd) {
      hi = this.domainEnd;
      lo = hi - span;
    }
    if (lo < this.domainStart) lo = this.domainStart;
    this.viewT0 = lo;
    this.viewT1 = hi;
  }

  /** Resets the visible window to cover the complete domain. */
  zoomToFit(): void {
    this.setWindow(this.domainStart, this.domainEnd);
  }

  /** Shifts the visible window by a pixel offset. Positive values shift content forward in time. */
  panByPixels(dxPixels: number): void {
    const dt = dxPixels * this.secondsPerPixel;
    this.setWindow(this.viewT0 + dt, this.viewT1 + dt);
  }

  /**
   * Scales the visible window around a fixed pixel anchor coordinate.
   * Factors less than 1 zoom in; factors greater than 1 zoom out. The domain timestamp at `anchorX` remains stationary.
   */
  zoomAt(anchorX: number, factor: number): void {
    const anchorTime = this.xToTime(anchorX);
    const frac = (anchorX - this.offset) / this.plotWidthPx;
    const newSpan = clamp(this.spanSeconds * factor, this.minSpan, Math.max(this.domainSpan, this.minSpan));
    const lo = anchorTime - frac * newSpan;
    this.setWindow(lo, lo + newSpan);
  }

  /** Sets the visible window to `spanSeconds` centered on `centerTime`. */
  zoomToSpan(spanSeconds: number, centerTime = (this.viewT0 + this.viewT1) / 2): void {
    const span = clamp(spanSeconds, this.minSpan, Math.max(this.domainSpan, this.minSpan));
    this.setWindow(centerTime - span / 2, centerTime + span / 2);
  }

  /**
   * Scales the visible window duration by `factor` while preserving the relative position of `centerTime`.
   *
   * Factors less than 1 zoom in; factors greater than 1 zoom out. Defaults to centering on the window midpoint. Coordinates outside the visible window clamp to the nearest boundary.
   */
  zoomByFactor(factor: number, centerTime = (this.viewT0 + this.viewT1) / 2): void {
    const span = this.spanSeconds;
    const frac = clamp(span > 0 ? (centerTime - this.viewT0) / span : 0.5, 0, 1);
    const newSpan = clamp(span * factor, this.minSpan, Math.max(this.domainSpan, this.minSpan));
    const lo = centerTime - frac * newSpan;
    this.setWindow(lo, lo + newSpan);
  }

  /**
   * Zooms the visible window to interval `[t0, t1]`, adding fractional padding `paddingFrac` on each side.
   */
  zoomToSelection(t0: number, t1: number, paddingFrac = 0.05): void {
    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1);
    const pad = (hi - lo) * paddingFrac;
    this.setWindow(lo - pad, hi + pad);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
