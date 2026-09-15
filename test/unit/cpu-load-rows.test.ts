/**
 * Unit tests for the CPU-load data layer (`web/ui/panes/cpu-load-rows.ts`):
 * run-interval binning, mip-chain reduction, per-bin utilization (<= 100%),
 * and window span to mip level selection.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { EVTID } from "../../src/trace/events.js";
import type { TraceEvent } from "../../src/trace/index.js";
import {
  buildCpuLoadData,
  queryCpuLoadBins,
  selectMipLevel,
} from "../../web/ui/panes/cpu-load-rows.js";

/** Minimal event — only the fields the data layer reads. */
function ev(coreId: number, ts: number, ctxName: string, id = 0): TraceEvent {
  return { id, coreId, ts, ctxName } as unknown as TraceEvent;
}

describe("buildCpuLoadData — run-interval binning", () => {
  it("attributes each gap to the context active at the earlier event", () => {
    // 4 events ⇒ 4 fine bins of width 1 over [0, 4].
    const events = [ev(0, 0, "A"), ev(0, 1, "B"), ev(0, 2, "A"), ev(0, 3, "A")];
    const data = buildCpuLoadData(events, 0, 4);
    assert.equal(data.levels[0]!.binCount, 4);
    assert.equal(data.levels[0]!.binWidth, 1);
    assert.deepEqual(data.contexts, ["A", "B"]);

    const bins = queryCpuLoadBins(data, 0, 0, 4, 0);
    assert.equal(bins.length, 4);
    const a = data.ctxIndex.get("A")!;
    const b = data.ctxIndex.get("B")!;
    assert.equal(bins[0]!.util[a], 1); // [0,1) ran A
    assert.equal(bins[1]!.util[b], 1); // [1,2) ran B
    assert.equal(bins[2]!.util[a], 1); // [2,3) ran A
    assert.equal(bins[3]!.total, 0); // nothing after the last event
  });

  it("splits an interval that crosses a bin boundary", () => {
    const events = [ev(0, 0, "A"), ev(0, 1.5, "B"), ev(0, 2, "A"), ev(0, 3, "A")];
    const data = buildCpuLoadData(events, 0, 4); // bin width 1
    const a = data.ctxIndex.get("A")!;
    const bins = queryCpuLoadBins(data, 0, 0, 4, 0);
    assert.equal(bins[0]!.util[a], 1); // [0,1) fully A
    assert.ok(Math.abs(bins[1]!.util[a]! - 0.5) < 1e-12); // [1,1.5) is A
  });

  it("keeps every per-bin total at or below 100 %", () => {
    const events = [
      ev(0, 0, "A"), ev(0, 0.3, "B"), ev(0, 0.9, "IDLE0"),
      ev(0, 1.7, "A"), ev(0, 2.1, "B"), ev(0, 3.6, "A"), ev(0, 4, "A"),
    ];
    const data = buildCpuLoadData(events, 0, 4);
    for (let level = 0; level < data.levels.length; level++) {
      for (const bin of queryCpuLoadBins(data, level, 0, 4, 0)) {
        assert.ok(bin.total <= 1 + 1e-9, `bin total ${bin.total} ≤ 1 at level ${level}`);
      }
    }
  });
});

describe("buildCpuLoadData — overflow gaps", () => {
  it("attributes nothing to the interval closed by an overflow nor to the one it opens", () => {
    // 5 events ⇒ 8 fine bins of width 0.5 over [0, 4].
    const events = [
      ev(0, 0, "A"),
      ev(0, 1, "A"), // last event before the gap
      ev(0, 2, "None", EVTID.OVERFLOW), // events lost in [1, 2]
      ev(0, 3, "B"), // first event after the gap
      ev(0, 4, "B"),
    ];
    const data = buildCpuLoadData(events, 0, 4);
    assert.deepEqual(data.contexts, ["A", "B"]);
    const a = data.ctxIndex.get("A")!;
    const b = data.ctxIndex.get("B")!;
    const bins = queryCpuLoadBins(data, 0, 0, 4, 0);
    assert.equal(bins.length, 8);
    assert.equal(bins[0]!.util[a], 1); // [0, 1) ran A
    assert.equal(bins[1]!.util[a], 1);
    for (let i = 2; i < 6; i++) assert.equal(bins[i]!.total, 0, `bin ${i} in [1, 3) is unattributed`);
    assert.equal(bins[6]!.util[b], 1); // [3, 4) ran B
    assert.equal(bins[7]!.util[b], 1);
  });
});

describe("mip-chain reduction", () => {
  it("conserves running seconds across levels (coarse = sum of fine)", () => {
    const events = [ev(0, 0, "A"), ev(0, 1, "B"), ev(0, 2, "A"), ev(0, 3, "B")];
    const data = buildCpuLoadData(events, 0, 4);
    const seconds = (level: number): number => {
      let s = 0;
      for (const bin of queryCpuLoadBins(data, level, 0, 4, 0)) {
        const bw = data.levels[level]!.binWidth;
        for (const u of bin.util) s += u * bw;
      }
      return s;
    };
    const finest = seconds(0);
    assert.ok(Math.abs(finest - 3) < 1e-9, "3 s of attributed run time"); // [0,3) covered
    for (let level = 1; level < data.levels.length; level++) {
      assert.ok(Math.abs(seconds(level) - finest) < 1e-9, `level ${level} conserves seconds`);
    }
  });

  it("each coarser level halves the bin count and doubles the width", () => {
    const events = Array.from({ length: 8 }, (_, i) => ev(0, i, i % 2 ? "B" : "A"));
    const data = buildCpuLoadData(events, 0, 8);
    assert.equal(data.levels[0]!.binCount, 8);
    for (let i = 1; i < data.levels.length; i++) {
      assert.equal(data.levels[i]!.binCount, data.levels[i - 1]!.binCount / 2);
      assert.ok(Math.abs(data.levels[i]!.binWidth - data.levels[i - 1]!.binWidth * 2) < 1e-12);
    }
    assert.equal(data.levels[data.levels.length - 1]!.binCount, 1);
  });
});

describe("selectMipLevel — resolution by window span", () => {
  it("selects a finer level with narrower bins as the window span decreases", () => {
    const events = Array.from({ length: 8 }, (_, i) => ev(0, i, i % 2 ? "B" : "A"));
    const data = buildCpuLoadData(events, 0, 8); // widths 1,2,4,8
    const target = 4;
    const zoomedOut = selectMipLevel(data, 8, target); // span 8 ⇒ want width 2
    const zoomedIn = selectMipLevel(data, 2, target); // span 2 ⇒ want width 0.5 ⇒ finest
    assert.ok(data.levels[zoomedIn]!.binWidth <= data.levels[zoomedOut]!.binWidth);
    // Never draws more than ~target bars at the chosen level.
    assert.ok(8 / data.levels[zoomedOut]!.binWidth <= target + 1e-9);
  });

  it("clamps to the coarsest level when the window span is large", () => {
    const events = [ev(0, 0, "A"), ev(0, 1, "B")];
    const data = buildCpuLoadData(events, 0, 2);
    assert.equal(selectMipLevel(data, 1e9, 50), data.levels.length - 1);
  });
});

describe("multi-core", () => {
  it("bins each core independently", () => {
    const events = [
      ev(0, 0, "A"), ev(1, 0, "B"),
      ev(0, 1, "A"), ev(1, 1, "B"),
      ev(0, 2, "A"), ev(1, 2, "B"),
      ev(0, 3, "A"), ev(1, 3, "B"),
    ];
    const data = buildCpuLoadData(events, 0, 4);
    assert.deepEqual(data.cores, [0, 1]);
    const a = data.ctxIndex.get("A")!;
    const b = data.ctxIndex.get("B")!;
    const core0 = queryCpuLoadBins(data, 0, 0, 4, 0);
    const core1 = queryCpuLoadBins(data, 0, 0, 4, 1);
    assert.equal(core0[0]!.util[a], 1); // core 0 ran A
    assert.equal(core0[0]!.util[b], 0);
    assert.equal(core1[0]!.util[b], 1); // core 1 ran B
    assert.equal(core1[0]!.util[a], 0);
  });
});
