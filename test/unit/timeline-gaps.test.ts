/**
 * Unit tests for the overflow overlay geometry (`web/ui/panes/timeline-gaps.ts`):
 * gap placement on the canvas, merging of overlapping gaps, hidden cores, the
 * minimum width, window clipping, and hit-testing by x.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { TraceGap } from "../../src/trace/index.js";
import { GAP_HIT_TOL_PX, GAP_MIN_PX, gapRects, gapsAtX } from "../../web/ui/panes/timeline-gaps.js";

/** A gap on `coreId` from `start` to `end`, with overridable bookkeeping. */
function gap(coreId: number, start: number, end: number, over: Partial<TraceGap> = {}): TraceGap {
  return { coreId, start, end, eventIndex: 0, dropCount: 0, lost: 0, ...over };
}

/** Sorts gaps the way the model does: by start, then by core. */
function sorted(gaps: TraceGap[]): TraceGap[] {
  return [...gaps].sort((a, b) => a.start - b.start || a.coreId - b.coreId);
}

describe("gapRects", () => {
  // A 100 px plot over 1 s, so one pixel is 10 ms; the gutter starts the plot at x = 20.
  const map = (gaps: TraceGap[], hidden?: Set<number>) => gapRects(sorted(gaps), 0, 1, 120, 20, GAP_MIN_PX, hidden);

  it("places a gap on the canvas", () => {
    const rects = map([gap(0, 0.3, 0.4)]);
    assert.deepEqual(rects.map((r) => [r.x0, r.x1, r.cores]), [[50, 60, [0]]]);
    assert.equal(rects[0]!.spans.length, 1);
  });

  it("merges gaps that overlap or touch into one rectangle", () => {
    // Identical intervals on both cores paint once.
    const same = map([gap(0, 0.3, 0.4), gap(1, 0.3, 0.4)]);
    assert.deepEqual(same.map((r) => [r.x0, r.x1, r.cores]), [[50, 60, [0, 1]]]);
    assert.equal(same[0]!.spans.length, 2);

    // Partial overlap spans the union; touching gaps join as well.
    const partial = map([gap(1, 0.3, 0.45), gap(0, 0.4, 0.5), gap(0, 0.5, 0.55)]);
    assert.deepEqual(partial.map((r) => [r.x0, r.x1, r.cores]), [[50, 75, [0, 1]]]);

    // Gaps apart stay apart, left to right.
    const apart = map([gap(1, 0.6, 0.7), gap(0, 0.3, 0.4)]);
    assert.deepEqual(apart.map((r) => [r.x0, r.x1, r.cores]), [[50, 60, [0]], [80, 90, [1]]]);
  });

  it("leaves out the gaps on a switched-off core", () => {
    const gaps = [gap(0, 0.3, 0.4), gap(1, 0.3, 0.4), gap(1, 0.6, 0.7)];
    const one = map(gaps, new Set([1]));
    assert.deepEqual(one.map((r) => [r.x0, r.x1, r.cores]), [[50, 60, [0]]]);
    assert.deepEqual(map(gaps, new Set([0, 1])), []);
  });

  it("widens a gap narrower than the minimum, including a zero-length one", () => {
    const rects = map([gap(0, 0.3, 0.3), gap(1, 0.6, 0.605)]);
    assert.deepEqual(rects.map((r) => [r.x0, r.x1]), [[50, 50 + GAP_MIN_PX], [80, 80 + GAP_MIN_PX]]);
    // A zero-length gap next to a real one merges into it.
    const merged = map([gap(0, 0.3, 0.3), gap(1, 0.3, 0.4)]);
    assert.deepEqual(merged.map((r) => [r.x0, r.x1, r.cores]), [[50, 60, [0, 1]]]);
  });

  it("clips to the window and the plot area", () => {
    // Straddling the left edge: clipped at the gutter.
    assert.deepEqual(map([gap(0, -0.1, 0.1)]).map((r) => [r.x0, r.x1]), [[20, 30]]);
    // Straddling the right edge: clipped at the canvas width.
    assert.deepEqual(map([gap(0, 0.95, 1.2)]).map((r) => [r.x0, r.x1]), [[115, 120]]);
    // A zero-length gap at the right edge widens leftwards rather than past the plot.
    assert.deepEqual(map([gap(0, 1, 1)]).map((r) => [r.x0, r.x1]), [[120 - GAP_MIN_PX, 120]]);
    // Fully outside on either side: nothing.
    assert.deepEqual(map([gap(0, -0.5, -0.1), gap(0, 1.1, 1.2)]), []);
    // Covering the whole window: the whole plot.
    assert.deepEqual(map([gap(0, -1, 2)]).map((r) => [r.x0, r.x1]), [[20, 120]]);
  });

  it("returns nothing for a degenerate window or plot", () => {
    assert.deepEqual(gapRects([gap(0, 0.3, 0.4)], 1, 1, 120, 20), []);
    assert.deepEqual(gapRects([gap(0, 0.3, 0.4)], 0, 1, 20, 20), []);
    assert.deepEqual(gapRects([], 0, 1, 120, 20), []);
  });
});

describe("gapsAtX", () => {
  const rects = gapRects(
    sorted([gap(0, 0.3, 0.4, { eventIndex: 3 }), gap(1, 0.35, 0.5, { eventIndex: 5 }), gap(1, 0.7, 0.7, { eventIndex: 9 })]),
    0,
    1,
    120,
    20,
  );

  it("reports only the gaps whose own band is under x, not the whole merged rectangle", () => {
    assert.deepEqual(gapsAtX(rects, 52).map((s) => s.gap.eventIndex), [3]);
    assert.deepEqual(gapsAtX(rects, 58).map((s) => s.gap.eventIndex), [3, 5]);
    assert.deepEqual(gapsAtX(rects, 68).map((s) => s.gap.eventIndex), [5]);
  });

  it("allows the hit tolerance either side, so a minimum-width band can be hovered", () => {
    // The zero-length gap at x = 90 is painted GAP_MIN_PX wide.
    assert.deepEqual(gapsAtX(rects, 90 + GAP_MIN_PX + GAP_HIT_TOL_PX).map((s) => s.gap.eventIndex), [9]);
    assert.deepEqual(gapsAtX(rects, 90 - GAP_HIT_TOL_PX).map((s) => s.gap.eventIndex), [9]);
    assert.deepEqual(gapsAtX(rects, 90 - GAP_HIT_TOL_PX - 0.5), []);
    assert.deepEqual(gapsAtX(rects, 90, 0).map((s) => s.gap.eventIndex), [9]);
  });

  it("reports nothing away from every gap", () => {
    assert.deepEqual(gapsAtX(rects, 20), []);
    assert.deepEqual(gapsAtX(rects, 110), []);
  });
});
