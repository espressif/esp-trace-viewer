/**
 * Unit tests for Timeline geometry and data representation (`web/ui/panes/timeline-rows.ts`):
 * event stream to run intervals, visible-window interval queries,
 * per-pixel coalescing, and time-to-interval hit testing.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { EVTID } from "../../src/trace/events.js";
import { parseTraceFiles, type TraceEvent } from "../../src/trace/index.js";
import {
  coalesceToPixels,
  firstEndAfter,
  firstStartAtOrAfter,
  intervalAtTime,
  marksInRange,
  nearestMarkIndex,
  reconstructTimeline,
  visibleRange,
  type EventMark,
  type ReadyInterval,
  type RunInterval,
} from "../../web/ui/panes/timeline-rows.js";

/** A minimal event with overridable fields. */
function ev(over: Partial<TraceEvent>): TraceEvent {
  return {
    id: 0,
    coreId: 0,
    name: "svNop",
    ts: 0,
    tsDelta: 0,
    plen: 0,
    params: {},
    ctxName: "TaskA",
    inIrq: false,
    ...over,
  };
}

/** A hand-built interval, for the window/LOD/hit-test cases. */
function iv(start: number, end: number, over: Partial<RunInterval> = {}): RunInterval {
  return { start, end, key: "K", coreId: 0, isr: false, eventIndex: 0, ...over };
}

describe("reconstructTimeline", () => {
  it("coalesces successive same-context events into one run", () => {
    const events = [
      ev({ ctxName: "TaskA", ts: 0 }),
      ev({ ctxName: "TaskA", ts: 1 }),
      ev({ ctxName: "TaskA", ts: 2 }),
    ];
    const { byContext } = reconstructTimeline(events, 10);
    const a = byContext.get("TaskA")!;
    assert.equal(a.length, 1);
    assert.deepEqual([a[0]!.start, a[0]!.end], [0, 10]); // single run to the domain end
    assert.equal(a[0]!.eventIndex, 0); // opened by the first event
  });

  it("ends a run at the first event of a different context", () => {
    const events = [
      ev({ ctxName: "TaskA", ts: 0 }),
      ev({ ctxName: "TaskB", ts: 3 }),
      ev({ ctxName: "TaskA", ts: 7 }),
    ];
    const { byContext } = reconstructTimeline(events, 10);
    assert.deepEqual(
      byContext.get("TaskA")!.map((r) => [r.start, r.end]),
      [[0, 3], [7, 10]],
    );
    assert.deepEqual(
      byContext.get("TaskB")!.map((r) => [r.start, r.end]),
      [[3, 7]],
    );
  });

  it("reconstructs each core independently and tracks them separately", () => {
    const events = [
      ev({ coreId: 0, ctxName: "A0", ts: 0 }),
      ev({ coreId: 1, ctxName: "B1", ts: 1 }), // core 1 activity must not cut A0 short
      ev({ coreId: 0, ctxName: "A0", ts: 2 }),
      ev({ coreId: 1, ctxName: "C1", ts: 4 }),
    ];
    const data = reconstructTimeline(events, 8);
    assert.deepEqual(data.cores, [0, 1]);
    assert.deepEqual(
      data.byContext.get("A0")!.map((r) => [r.start, r.end]),
      [[0, 8]], // unbroken across the whole window despite core-1 switches
    );
    assert.deepEqual(
      data.byContext.get("B1")!.map((r) => [r.start, r.end]),
      [[1, 4]],
    );
    assert.equal(data.unifiedByCore.get(1)!.length, 2);
  });

  it("keeps the unknown context on the Unified track but off the lanes", () => {
    const events = [ev({ ctxName: "None", ts: 0 }), ev({ ctxName: "TaskA", ts: 2 })];
    const data = reconstructTimeline(events, 5);
    assert.equal(data.byContext.has("None"), false);
    assert.equal(data.unifiedByCore.get(0)!.length, 2); // None run + TaskA run
  });

  it("produces ascending, non-overlapping intervals per lane", () => {
    const events = [
      ev({ ctxName: "A", ts: 0 }),
      ev({ ctxName: "B", ts: 1 }),
      ev({ ctxName: "A", ts: 2 }),
      ev({ ctxName: "B", ts: 3 }),
    ];
    const uni = reconstructTimeline(events, 4).unifiedByCore.get(0)!;
    for (let i = 1; i < uni.length; i++) {
      assert.ok(uni[i]!.start >= uni[i - 1]!.end, "non-overlapping and ascending");
    }
  });
});

describe("in-run API/log marks", () => {
  // id 100 is above the predefined range → an API call; id 26 is svPrint → a log.
  // id 0 (svNop) is a system event → produces no mark.
  it("collects API and log marks per context and per core, not other events", () => {
    const events = [
      ev({ ctxName: "TaskA", coreId: 0, ts: 0, id: 0 }), // system: opens the run, no mark
      ev({ ctxName: "TaskA", coreId: 0, ts: 1, id: 100 }), // API call inside TaskA
      ev({ ctxName: "TaskA", coreId: 0, ts: 2, id: 26 }), // log line inside TaskA
      ev({ ctxName: "TaskB", coreId: 0, ts: 3, id: 100 }), // API call inside TaskB
    ];
    const { marksByContext, marksByCore } = reconstructTimeline(events, 5);
    assert.deepEqual(
      marksByContext.get("TaskA")!.map((m) => [m.t, m.log, m.eventIndex]),
      [[1, false, 1], [2, true, 2]],
    );
    assert.deepEqual(
      marksByContext.get("TaskB")!.map((m) => [m.t, m.log]),
      [[3, false]],
    );
    // The Unified (per-core) track carries every API/log on the core, in order.
    assert.deepEqual(
      marksByCore.get(0)!.map((m) => m.t),
      [1, 2, 3],
    );
  });

  it("keeps marks off the unknown context but still on the core's Unified track", () => {
    const events = [ev({ ctxName: "None", ts: 0, id: 100 }), ev({ ctxName: "TaskA", ts: 1, id: 100 })];
    const { marksByContext, marksByCore } = reconstructTimeline(events, 2);
    assert.equal(marksByContext.has("None"), false);
    assert.deepEqual(marksByCore.get(0)!.map((m) => m.t), [0, 1]);
  });

  it("marksInRange returns exactly the marks inside [t0, t1]", () => {
    const marks: EventMark[] = [0, 1, 2, 3, 4].map((t) => ({ t, log: false, eventIndex: t, coreId: 0 }));
    const { lo, hi } = marksInRange(marks, 1, 3); // t in [1,3): indices 1,2
    assert.deepEqual(marks.slice(lo, hi).map((m) => m.t), [1, 2]);
    // A window that misses every mark is empty.
    const miss = marksInRange(marks, 10, 20);
    assert.equal(miss.hi - miss.lo, 0);
  });

  it("nearestMarkIndex finds the mark closest in time to t (the notch hit-test)", () => {
    const marks: EventMark[] = [0, 10, 20, 30].map((t) => ({ t, log: false, eventIndex: t, coreId: 0 }));
    assert.equal(nearestMarkIndex(marks, -5), 0); // before the first → first
    assert.equal(nearestMarkIndex(marks, 11), 1); // closest to 10
    assert.equal(nearestMarkIndex(marks, 16), 2); // closest to 20
    assert.equal(nearestMarkIndex(marks, 100), 3); // after the last → last
    // A tie (exactly between two marks) resolves to the earlier one.
    assert.equal(nearestMarkIndex(marks, 15), 1);
    // Empty input has no answer.
    assert.equal(nearestMarkIndex([], 0), -1);
  });
});

describe("visible-window binary search", () => {
  const ints = [iv(0, 1), iv(1, 2), iv(2, 3), iv(3, 4), iv(4, 5)];

  it("firstEndAfter finds the first interval reaching past t", () => {
    assert.equal(firstEndAfter(ints, -1), 0);
    assert.equal(firstEndAfter(ints, 2.5), 2); // [2,3] is the first ending after 2.5
    assert.equal(firstEndAfter(ints, 5), ints.length); // nothing ends after the last end
  });

  it("firstStartAtOrAfter finds the first interval starting at/after t", () => {
    assert.equal(firstStartAtOrAfter(ints, 0), 0);
    assert.equal(firstStartAtOrAfter(ints, 2.5), 3);
    assert.equal(firstStartAtOrAfter(ints, 10), ints.length);
  });

  it("visibleRange returns exactly the intersecting slice", () => {
    const { lo, hi } = visibleRange(ints, 1.5, 3.5);
    // intervals [1,2],[2,3],[3,4] intersect [1.5,3.5] → indices 1..3
    assert.deepEqual([lo, hi], [1, 4]);
    assert.deepEqual(ints.slice(lo, hi).map((r) => [r.start, r.end]), [[1, 2], [2, 3], [3, 4]]);
  });

  it("visibleRange is empty when the window misses every interval", () => {
    const { lo, hi } = visibleRange(ints, 10, 20);
    assert.equal(hi - lo, 0);
  });
});

describe("coalesceToPixels (LOD bound)", () => {
  it("reduces N overlapping slices to at most the pixel-column count", () => {
    // 1000 tiny runs packed into a 100 px window → at most ~100 bars out.
    const many: RunInterval[] = [];
    for (let i = 0; i < 1000; i++) many.push(iv(i / 1000, (i + 0.5) / 1000, { eventIndex: i }));
    const bars = coalesceToPixels(many, 0, 1, 100);
    assert.ok(bars.length <= 101, `bounded by pixel columns, got ${bars.length}`);
    assert.ok(bars.length > 0);
    // Every source interval is accounted for in some bar.
    const total = bars.reduce((n, b) => n + b.count, 0);
    assert.equal(total, 1000);
  });

  it("leaves out the runs recorded on a switched-off core", () => {
    // One migrating task, alternating cores: 0, 1, 0, 1 across a 40 px window.
    const runs: RunInterval[] = [
      iv(0, 10, { coreId: 0, eventIndex: 0 }),
      iv(10, 20, { coreId: 1, eventIndex: 1 }),
      iv(20, 30, { coreId: 0, eventIndex: 2 }),
      iv(30, 40, { coreId: 1, eventIndex: 3 }),
    ];
    assert.deepEqual(coalesceToPixels(runs, 0, 40, 40).map((b) => b.eventIndex), [0, 1, 2, 3]);

    // Core 0 switched off leaves the core 1 runs where they were, gaps and all.
    const one = coalesceToPixels(runs, 0, 40, 40, 0, 1, new Set([0]));
    assert.deepEqual(one.map((b) => b.eventIndex), [1, 3]);
    assert.deepEqual(one.map((b) => [b.x0, b.x1]), [[10, 20], [30, 40]]);

    // Both cores off leaves nothing to draw.
    assert.deepEqual(coalesceToPixels(runs, 0, 40, 40, 0, 1, new Set([0, 1])), []);
  });

  it("keeps touching runs on a gapless track as distinct, per-column bars", () => {
    // The Unified "what is running now" lane tiles the trace gaplessly: each
    // run's start equals the previous run's end. Coalescing must still paint each
    // pixel column with the context running there, not collapse the whole lane
    // into one bar coloured by (and labelled with) the first visible run.
    const gapless: RunInterval[] = [
      iv(0, 10, { key: "A", eventIndex: 0 }),
      iv(10, 20, { key: "B", eventIndex: 1 }),
      iv(20, 30, { key: "C", eventIndex: 2 }),
    ];
    // Window [0,30] across 30 px → each 10-px run is its own bar.
    const bars = coalesceToPixels(gapless, 0, 30, 30);
    assert.deepEqual(bars.map((b) => b.key), ["A", "B", "C"]);
    assert.deepEqual(bars.map((b) => b.eventIndex), [0, 1, 2]);

    // Panning the window must not change a region's colour: B still owns the
    // pixels it covers regardless of which run is first in view.
    const panned = coalesceToPixels(gapless, 5, 35, 30);
    assert.deepEqual(panned.map((b) => b.key), ["A", "B", "C"]);
  });

  it("colours a column by the context that holds the most time in it", () => {
    // A gapless track where a 10 us ISR fires every 1 ms and the idle task holds
    // everything else. Over a 1 s window on 100 px, one column is 10 ms — ~10
    // ticks — so idle owns >99 % of every column and must colour all of them.
    const track: RunInterval[] = [];
    let e = 0;
    for (let ms = 0; ms < 1000; ms++) {
      track.push(iv(ms / 1000, (ms + 0.99) / 1000, { key: "IDLE", eventIndex: e++ }));
      track.push(iv((ms + 0.99) / 1000, (ms + 1) / 1000, { key: "ISR", isr: true, eventIndex: e++ }));
    }
    const bars = coalesceToPixels(track, 0, 1, 100);
    assert.ok(bars.length <= 101, `bounded by pixel columns, got ${bars.length}`);
    // Taking the first coalesced interval instead let the boundary-crossing ISR
    // open a bar that then swallowed the whole following column, painting the
    // lane in the interrupt's colour.
    assert.deepEqual([...new Set(bars.map((b) => b.key))], ["IDLE"]);
    assert.ok(bars.every((b) => !b.isr));
  });

  it("weights by real time, not by the widened width of sub-pixel runs", () => {
    // One 1 s window across 1 px: everything below shares a single column. The
    // long run holds 96 % of it, the two slivers 2 % each — but each sliver is
    // widened to `minBarPx`, so weighting the widened widths would make all
    // three equal and hand the column to whichever came first.
    const bars = coalesceToPixels(
      [
        iv(0, 0.02, { key: "SLIVER_A", eventIndex: 1 }),
        iv(0.02, 0.98, { key: "LONG", eventIndex: 2 }),
        iv(0.98, 1, { key: "SLIVER_B", eventIndex: 3 }),
      ],
      0,
      1,
      1,
    );
    assert.equal(bars.length, 1);
    assert.equal(bars[0]!.key, "LONG");
    assert.equal(bars[0]!.eventIndex, 2);
  });

  it("sums a context's separate runs within a bar before comparing", () => {
    // Again one column. "OTHER" runs first and has the single longest run (40 %),
    // but "WINNER" holds 55 % across two runs, so it owns the column: dominance
    // is per context, not per run.
    const bars = coalesceToPixels(
      [
        iv(0, 0.4, { key: "OTHER", eventIndex: 6 }),
        iv(0.4, 0.7, { key: "WINNER", eventIndex: 7 }),
        iv(0.7, 0.75, { key: "SMALL", eventIndex: 8 }),
        iv(0.75, 1, { key: "WINNER", eventIndex: 9 }),
      ],
      0,
      1,
      1,
    );
    assert.equal(bars.length, 1);
    assert.equal(bars[0]!.key, "WINNER");
    // The winning context's *first* run in the bar backs the tooltip/marker.
    assert.equal(bars[0]!.eventIndex, 7);
  });

  it("maps interval times to pixels and clamps to the window", () => {
    const bars = coalesceToPixels([iv(-1, 0.5), iv(2, 5)], 0, 4, 400);
    // First run starts before the window → clamped to x0=0; ends at 0.5/4*400=50.
    assert.equal(bars[0]!.x0, 0);
    assert.ok(Math.abs(bars[0]!.x1 - 50) < 1e-9);
    // Second run ends past the window → clamped to widthPx.
    assert.equal(bars[bars.length - 1]!.x1, 400);
  });

  it("widens a sub-pixel run to at least minBarPx and keeps its event", () => {
    const bars = coalesceToPixels([iv(0.5, 0.5001, { eventIndex: 42 })], 0, 1, 100, 0, 2);
    assert.equal(bars.length, 1);
    assert.ok(bars[0]!.x1 - bars[0]!.x0 >= 2);
    assert.equal(bars[0]!.eventIndex, 42);
  });

  it("offsets the plot area so t0 begins past the gutter, not at x=0", () => {
    // Window [0,1] across a 132 px gutter + 100 px plot: t0→132, midpoint→182,
    // t1→232. Nothing is mapped into the gutter the lane labels overlay.
    const half = coalesceToPixels([iv(0, 0.5)], 0, 1, 232, 132);
    assert.equal(half[0]!.x0, 132, "t0 maps to the plot-area left edge");
    assert.ok(Math.abs(half[0]!.x1 - 182) < 1e-9, "midpoint halfway across the plot");
    const full = coalesceToPixels([iv(0, 1)], 0, 1, 232, 132);
    assert.equal(full[0]!.x0, 132);
    assert.equal(full[0]!.x1, 232, "t1 maps to the canvas right edge");
  });

  it("clamps an interval that starts before t0 to the plot-area left edge", () => {
    const bars = coalesceToPixels([iv(-1, 0.5)], 0, 4, 432, 32);
    // Starts before the window → clamped to the offset; ends at 32+0.5/4*400=82.
    assert.equal(bars[0]!.x0, 32);
    assert.ok(Math.abs(bars[0]!.x1 - 82) < 1e-9);
  });

  it("returns nothing for a degenerate window or an empty plot area", () => {
    assert.deepEqual(coalesceToPixels([iv(0, 1)], 1, 1, 100), []);
    assert.deepEqual(coalesceToPixels([iv(0, 1)], 0, 1, 0), []);
    assert.deepEqual(coalesceToPixels([iv(0, 1)], 0, 1, 100, 100), []);
  });
});

describe("intervalAtTime (hit-test)", () => {
  const ints = [iv(0, 2), iv(3, 5), iv(5, 6)];

  it("finds the covering interval (start inclusive, end exclusive)", () => {
    assert.deepEqual(intervalAtTime(ints, 0)!.end, 2);
    assert.deepEqual(intervalAtTime(ints, 1.9)!.end, 2);
    assert.deepEqual(intervalAtTime(ints, 4)!.start, 3);
    assert.deepEqual(intervalAtTime(ints, 5)!.end, 6); // boundary belongs to the next run
  });

  it("returns null in a gap or outside the runs", () => {
    assert.equal(intervalAtTime(ints, 2.5), null); // gap between [0,2] and [3,5]
    assert.equal(intervalAtTime(ints, -1), null);
    assert.equal(intervalAtTime(ints, 6), null); // past the last end
  });
});


describe("reconstructTimeline: overflow gaps", () => {
  /** An `svOverflow` event on `coreId` at `ts`, tagged with no context as the processor does. */
  const overflowEv = (ts: number, coreId = 0): TraceEvent =>
    ev({ id: EVTID.OVERFLOW, name: "svOverflow", ts, coreId, params: { drop_cnt: 1 }, ctxName: "None" });

  it("ends the pre-gap run at the previous event and leaves the gap to no context lane", () => {
    const events = [
      ev({ ctxName: "TaskA", ts: 0 }),
      ev({ ctxName: "TaskA", ts: 2 }), // last event before the gap
      overflowEv(5), // events lost in [2, 5]
      ev({ ctxName: "TaskB", ts: 7 }),
    ];
    const { byContext, unifiedByCore } = reconstructTimeline(events, 10);
    assert.deepEqual(byContext.get("TaskA")!.map((r) => [r.start, r.end]), [[0, 2]]);
    assert.deepEqual(byContext.get("TaskB")!.map((r) => [r.start, r.end]), [[7, 10]]);
    assert.equal(byContext.has("None"), false);
    // The unified track keeps a "None" interval from the last pre-gap event to the first
    // post-gap run, so consumers see a boundary rather than a switch from TaskA to TaskB.
    assert.deepEqual(
      unifiedByCore.get(0)!.map((r) => [r.start, r.end, r.key, r.eventIndex]),
      [
        [0, 2, "TaskA", 0],
        [2, 7, "None", 2],
        [7, 10, "TaskB", 3],
      ],
    );
  });

  it("opens the unknown interval at the overflow when it is the first event on the core", () => {
    const events = [overflowEv(1), ev({ ctxName: "TaskA", ts: 3 })];
    const { unifiedByCore, byContext } = reconstructTimeline(events, 10);
    assert.deepEqual(
      unifiedByCore.get(0)!.map((r) => [r.start, r.end, r.key]),
      [
        [1, 3, "None"],
        [3, 10, "TaskA"],
      ],
    );
    assert.deepEqual(byContext.get("TaskA")!.map((r) => [r.start, r.end]), [[3, 10]]);
  });

  it("keeps the other core's runs intact across a gap on one core", () => {
    const events = [
      ev({ coreId: 0, ctxName: "TaskA", ts: 0 }),
      ev({ coreId: 1, ctxName: "TaskB", ts: 0 }),
      ev({ coreId: 0, ctxName: "TaskA", ts: 2 }),
      overflowEv(5, 0),
      ev({ coreId: 1, ctxName: "TaskB", ts: 6 }),
      ev({ coreId: 0, ctxName: "TaskA", ts: 8 }),
    ];
    const { byContext } = reconstructTimeline(events, 10);
    assert.deepEqual(byContext.get("TaskB")!.map((r) => [r.start, r.end]), [[0, 10]]);
    assert.deepEqual(
      byContext.get("TaskA")!.map((r) => [r.start, r.end]),
      [
        [0, 2],
        [8, 10],
      ],
    );
  });

  describe("ready intervals", () => {
    const NAMES = new Map([[1, "TaskA"]]);
    const readyEv = (ts: number, coreId = 0): TraceEvent =>
      ev({ id: EVTID.TASK_START_READY, name: "svTaskStartReady", ts, coreId, params: { tid: 1 }, ctxName: "TaskB" });

    it("cuts an open ready interval at the start of a gap on the same core", () => {
      const events = [
        ev({ ctxName: "TaskB", ts: 0 }),
        readyEv(2),
        ev({ ctxName: "TaskB", ts: 4 }), // last event before the gap
        overflowEv(6),
        ev({ ctxName: "TaskA", ts: 8 }),
      ];
      const { readyByContext } = reconstructTimeline(events, 10, NAMES);
      assert.deepEqual(readyByContext.get("TaskA")!.map((r) => [r.start, r.end]), [[2, 4]]);
    });

    it("keeps a ready interval that opens at the very event a gap starts from", () => {
      // The ready edge is a recorded event, so the task was ready from there; the gap
      // that starts at the same instant on the other core does not cut it to nothing.
      const events = [
        ev({ coreId: 0, ctxName: "TaskB", ts: 0 }),
        ev({ coreId: 1, ctxName: "TaskC", ts: 0 }),
        ev({ coreId: 1, ctxName: "TaskC", ts: 4 }),
        readyEv(4),
        overflowEv(6, 1),
        ev({ coreId: 0, ctxName: "TaskA", ts: 8 }),
      ];
      const { readyByContext } = reconstructTimeline(events, 10, NAMES);
      assert.deepEqual(readyByContext.get("TaskA")!.map((r) => [r.start, r.end]), [[4, 8]]);
    });

    it("cuts an open ready interval at the start of a gap on another core", () => {
      // Ready state is per task, not per core: once any core lost events, whether the
      // task stayed ready is unknown.
      const events = [
        ev({ coreId: 0, ctxName: "TaskB", ts: 0 }),
        ev({ coreId: 1, ctxName: "TaskC", ts: 0 }),
        readyEv(2),
        ev({ coreId: 1, ctxName: "TaskC", ts: 3 }),
        overflowEv(6, 1),
        ev({ coreId: 0, ctxName: "TaskA", ts: 8 }),
      ];
      const { readyByContext } = reconstructTimeline(events, 10, NAMES);
      assert.deepEqual(readyByContext.get("TaskA")!.map((r) => [r.start, r.end]), [[2, 3]]);
    });

    it("does not synthesise a preemption ready interval across a gap", () => {
      const events = [
        ev({ ctxName: "TaskA", ts: 0 }),
        ev({ ctxName: "TaskA", ts: 3 }),
        overflowEv(5), // TaskA's run ends at 3; what happened next is unknown
        ev({ ctxName: "TaskB", ts: 7 }),
        ev({ ctxName: "TaskA", ts: 9 }),
      ];
      const { readyByContext } = reconstructTimeline(events, 10, NAMES);
      assert.equal(readyByContext.has("TaskA"), false);
    });
  });
});

describe("ready intervals", () => {
  // tid 1 → TaskA in every case; runs are driven by ctxName switches as usual.
  const NAMES = new Map([[1, "TaskA"]]);
  const readyEv = (ts: number, tid = 1): TraceEvent =>
    ev({ id: EVTID.TASK_START_READY, name: "svTaskStartReady", ts, params: { tid }, ctxName: "TaskB" });
  const stopReadyEv = (ts: number, tid = 1): TraceEvent =>
    ev({ id: EVTID.TASK_STOP_READY, name: "svTaskStopReady", ts, params: { tid, cause: 0 }, ctxName: "TaskB" });

  it("opens at svTaskStartReady and closes at the task's next run start", () => {
    const events = [
      ev({ ctxName: "TaskB", ts: 0 }),
      readyEv(2),
      ev({ ctxName: "TaskA", ts: 5 }), // TaskA starts running
      ev({ ctxName: "TaskB", ts: 8 }),
    ];
    const { readyByContext } = reconstructTimeline(events, 10, NAMES);
    assert.deepEqual(
      readyByContext.get("TaskA")!.map((r) => [r.start, r.end, r.eventIndex]),
      // [2, 5]: explicit ready interval. [8, 10]: TaskB preempts TaskA at t=8 without
      // a stop-ready event, keeping TaskA in the ready state until domain end.
      [
        [2, 5, 1],
        [8, 10, 2],
      ],
    );
  });

  it("synthesises a ready interval when a task is preempted", () => {
    const events = [
      ev({ ctxName: "TaskA", ts: 0 }), // TaskA runs [0, 4]
      ev({ ctxName: "TaskB", ts: 4 }), // preempted: no svTaskStopReady fired
      ev({ ctxName: "TaskA", ts: 7 }), // resumes [7, 10]
    ];
    const { readyByContext } = reconstructTimeline(events, 10, NAMES);
    assert.deepEqual(
      readyByContext.get("TaskA")!.map((r) => [r.start, r.end, r.eventIndex]),
      [[4, 7, 0]],
    );
  });

  it("does not synthesise a ready interval when the run ended by blocking", () => {
    const events = [
      ev({ ctxName: "TaskA", ts: 0 }),
      { ...stopReadyEv(3), ctxName: "TaskA" }, // TaskA blocks inside its run
      ev({ ctxName: "TaskB", ts: 4 }),
      ev({ ctxName: "TaskA", ts: 7 }),
    ];
    const { readyByContext } = reconstructTimeline(events, 10, NAMES);
    assert.equal(readyByContext.has("TaskA"), false);
  });

  it("does not synthesise across a gap holding only ISRs (an interruption)", () => {
    const events = [
      ev({ ctxName: "TaskA", ts: 0 }),
      ev({ ctxName: "SysTick", ts: 4, inIrq: true }), // ISR interrupts TaskA
      ev({ ctxName: "TaskA", ts: 6 }), // …which resumes: it never stopped Running
    ];
    const { readyByContext } = reconstructTimeline(events, 10, NAMES);
    assert.equal(readyByContext.has("TaskA"), false);
  });

  it("treats a later explicit ready as proof the task blocked silently at switch-out", () => {
    // ESP-IDF's port emits no svTaskStopReady: a blocked task's only trace is
    // the svTaskStartReady when it is woken. The gap [4, 7] must then show
    // ready only from that wake-up (6), not from the switch-out (4).
    const events = [
      ev({ ctxName: "TaskA", ts: 0 }),
      ev({ ctxName: "TaskB", ts: 4 }),
      readyEv(6),
      ev({ ctxName: "TaskA", ts: 7 }),
    ];
    const { readyByContext } = reconstructTimeline(events, 10, NAMES);
    assert.deepEqual(
      readyByContext.get("TaskA")!.map((r) => [r.start, r.end]),
      [[6, 7]],
    );
  });

  it("synthesises nothing for contexts outside the task table (ISRs, idle)", () => {
    const events = [
      ev({ ctxName: "SysTick", ts: 0, inIrq: true }),
      ev({ ctxName: "TaskB", ts: 4 }),
      ev({ ctxName: "SysTick", ts: 7, inIrq: true }),
    ];
    const { readyByContext } = reconstructTimeline(events, 10, NAMES);
    assert.equal(readyByContext.size, 0);
  });

  it("closes at svTaskStopReady when the task never gets to run", () => {
    const events = [ev({ ctxName: "TaskB", ts: 0 }), readyEv(2), stopReadyEv(4)];
    const { readyByContext } = reconstructTimeline(events, 10, NAMES);
    assert.deepEqual(
      readyByContext.get("TaskA")!.map((r) => [r.start, r.end]),
      [[2, 4]],
    );
  });

  it("clips an unresolved ready at the domain end", () => {
    const events = [ev({ ctxName: "TaskB", ts: 0 }), readyEv(2)];
    const { readyByContext } = reconstructTimeline(events, 10, NAMES);
    assert.deepEqual(
      readyByContext.get("TaskA")!.map((r) => [r.start, r.end]),
      [[2, 10]],
    );
  });

  it("drops a ready that fires while the task is already running", () => {
    const events = [
      ev({ ctxName: "TaskA", ts: 0 }), // TaskA runs [0, 10]
      // The ready is recorded in TaskA's own context (e.g. a redundant notify).
      { ...readyEv(3), ctxName: "TaskA" },
    ];
    const { readyByContext } = reconstructTimeline(events, 10, NAMES);
    assert.equal(readyByContext.has("TaskA"), false);
  });

  it("keeps the first of overlapping readies (a duplicate edge is dropped)", () => {
    const events = [
      ev({ ctxName: "TaskB", ts: 0 }),
      readyEv(2),
      readyEv(3), // still ready from t=2: redundant
      ev({ ctxName: "TaskA", ts: 6 }),
    ];
    const { readyByContext } = reconstructTimeline(events, 10, NAMES);
    assert.deepEqual(
      readyByContext.get("TaskA")!.map((r) => [r.start, r.end]),
      [[2, 6]],
    );
  });

  it("collects nothing without the task-name tables", () => {
    const events = [ev({ ctxName: "TaskB", ts: 0 }), readyEv(2), ev({ ctxName: "TaskA", ts: 5 })];
    const { readyByContext } = reconstructTimeline(events, 10);
    assert.equal(readyByContext.size, 0);
  });
});

describe("dual-core demo capture", () => {
  const events = (): TraceEvent[] =>
    parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/dualcore.svdat"))]).events;

  it("reconstructs real lanes that tile the trace without overlap", () => {
    const all = events();
    assert.equal(all.length, 164703);
    const domainEnd = all[all.length - 1]!.ts;
    const data = reconstructTimeline(all, domainEnd);

    assert.deepEqual(data.cores, [0, 1]);

    // tcpip is one of the running contexts and gets real run intervals.
    const tcpip = data.byContext.get("tcpip");
    assert.ok(tcpip && tcpip.length > 0, "tcpip lane reconstructed");

    // The Unified track tiles [firstStart, domainEnd] gaplessly and in order.
    const uni = data.unifiedByCore.get(0)!;
    assert.ok(uni.length > 1);
    assert.equal(uni[uni.length - 1]!.end, domainEnd);
    for (let i = 1; i < uni.length; i++) {
      assert.equal(uni[i]!.start, uni[i - 1]!.end, "contiguous unified track");
    }

    // A windowed, coalesced draw of the whole trace stays within the canvas.
    const bars = coalesceToPixels(uni, uni[0]!.start, domainEnd, 1280);
    assert.ok(bars.length <= 1281);
  });

  it("collects real API/log marks inside tcpip's runs", () => {
    const all = events();
    const data = reconstructTimeline(all, all[all.length - 1]!.ts);
    const marks = data.marksByContext.get("tcpip");
    assert.ok(marks && marks.length > 0, "tcpip has in-run API/log marks");
    // Marks are ascending and each maps back to an API/log event in the stream.
    for (let i = 1; i < marks.length; i++) {
      assert.ok(marks[i]!.t >= marks[i - 1]!.t, "marks are time-ordered");
    }
    // Every per-context mark is also on the core's Unified track.
    assert.ok(data.marksByCore.get(0)!.length >= marks.length);
  });

  it("reconstructs real ready intervals that precede their runs", () => {
    const model = parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/dualcore.svdat"))]);
    const all = model.events;
    const taskNames = new Map<number, string>();
    for (const t of model.traces) for (const [tid, name] of t.tasks) taskNames.set(tid, name);
    const domainEnd = all[all.length - 1]!.ts;
    const data = reconstructTimeline(all, domainEnd, taskNames);

    const child = data.readyByContext.get("sensor");
    assert.ok(child && child.length > 0, "sensor has ready intervals");
    for (let i = 0; i < child.length; i++) {
      const r: ReadyInterval = child[i]!;
      assert.ok(r.end > r.start, "ready intervals are non-empty");
      assert.ok(r.end <= domainEnd, "clipped to the domain");
      if (i > 0) assert.ok(r.start >= child[i - 1]!.end, "ascending and non-overlapping");
      const runs = data.byContext.get("sensor")!;
      // A ready box never overlaps its own task's runs.
      assert.equal(intervalAtTime(runs, r.start), null);
      // Explicit intervals anchor on svTaskStartReady; preemption-synthesized
      // intervals start where the previous run of the task ends.
      if (all[r.eventIndex]!.name !== "svTaskStartReady") {
        assert.ok(
          runs.some((run) => run.end === r.start),
          "synthesised ready starts at a preempted run's end",
        );
      }
    }
    // Scheduling latency in the recording: ready at ~8.978776 s, running at ~8.980199 s.
    const long = child.find((r) => Math.abs(r.start - 8.978776) < 1e-4);
    assert.ok(long, "the 8.9788 s ready interval exists");
    assert.ok(Math.abs(long.end - long.start - 1423e-6) < 5e-6, "≈1.42 ms of scheduling latency");
  });
});
