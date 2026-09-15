/**
 * Unit tests for the `dataplot` lane type (`web/ui/panes/lanes/dataplot-lane.ts`)
 * behind the configurable timeline: the DOM-free surface the canvas host
 * relies on — the per-model series extraction memoised by model identity, the
 * per-lane slice (`build`) that selects this lane's series in source order, the
 * gutter swatch tint, the source summary, and the Add-lane picker. The
 * LTTB/stats math it draws with is unit-tested in `dataplot-rows.test.ts`; the
 * canvas drawing is exercised by the Playwright suite.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseTraceFiles, EVTID, type TraceEvent, type TraceModel } from "../../src/trace/index.js";
import { LaneRegistry } from "../../web/core/lanes/registry.js";
import { DATAPLOT_LANE, type DataPlotSource } from "../../web/core/lanes/types.js";
import { contextColor } from "../../web/core/theme.js";
import { dataPlotLaneType, dataSeriesFor, yRange, type DataPlotBuilt } from "../../web/ui/panes/lanes/dataplot-lane.js";

/** A `svDataSample` event for series `dataId` carrying raw value bits `value`. */
function sample(dataId: number, value: number, ts: number): TraceEvent {
  return {
    id: EVTID.DATA_SAMPLE,
    coreId: 0,
    name: "svDataSample",
    ts,
    tsDelta: 0,
    plen: 0,
    params: { data_id: dataId, value },
    ctxName: "TaskA",
    inIrq: false,
  };
}
function model(events: TraceEvent[]): TraceModel {
  return { traces: [], events, gaps: [] };
}

const build = (m: TraceModel, s: DataPlotSource): DataPlotBuilt => dataPlotLaneType.build!(m, s);

/** The committed single-core demo capture, parsed once for the fixture-backed cases. */
const DEMO = parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/unicore.svdat"))]);

describe("dataSeriesFor (memoisation)", () => {
  it("extracts the series once per model and returns the cached instance", () => {
    const m = model([sample(7, 100, 0), sample(8, 200, 1)]);
    assert.equal(dataSeriesFor(m), dataSeriesFor(m));
  });
});

describe("build (per-lane series slice)", () => {
  const m = model([sample(7, 100, 0), sample(8, 200, 1), sample(7, 101, 2), sample(9, 5, 3)]);

  it("selects only the lane's series, in the source's order", () => {
    const built = build(m, { series: [8, 7] });
    assert.deepEqual(built.series.map((s) => s.id), [8, 7]); // source order, not first-seen
    assert.equal(built.series[1]!.points.length, 2); // series 7 has two samples
  });

  it("ignores series ids the model never sampled", () => {
    const built = build(m, { series: [7, 42] });
    assert.deepEqual(built.series.map((s) => s.id), [7]);
  });

  it("plots a single series for the common one-series-per-lane case", () => {
    assert.deepEqual(build(m, { series: [9] }).series.map((s) => s.id), [9]);
  });
});

describe("yRange (autoscale over the visible window)", () => {
  // 5% padding on each side of the spanned values, as yRange applies.
  const padded = (min: number, max: number) => {
    const pad = (max - min) * 0.05;
    return { min: min - pad, max: max + pad };
  };
  const seriesOf = (m: TraceModel) => build(m, { series: [7] }).series;

  it("covers the interpolated edge value when a sharp transition occurs just off-window", () => {
    // 80 → 20 transition; the high sample (t=0) is outside the [8, 15] window.
    // The entering segment is still drawn (visibleSlice keeps the neighbour), so
    // the range must reach its value at the window edge: valueAt(8) = 32.
    const s = seriesOf(model([sample(7, 80, 0), sample(7, 20, 10), sample(7, 21, 15)]));
    assert.deepEqual(yRange(s, 8, 15), padded(20, 32));
  });

  it("interpolates both window edges between bracketing samples", () => {
    const s = seriesOf(model([sample(7, 10, 0), sample(7, 20, 1), sample(7, 30, 2)]));
    // Window [0.5, 1.5]: in-window sample 20, edges interpolate to 15 and 25.
    assert.deepEqual(yRange(s, 0.5, 1.5), padded(15, 25));
  });

  it("scales to the clamped endpoint value when every sample is outside the window", () => {
    // Series ended before the window; valueAt clamps to the last value (5), so
    // the flat continuation line renders at mid-band instead of the {0, 1} fallback.
    const s = seriesOf(model([sample(7, 5, 0), sample(7, 5, 1)]));
    assert.deepEqual(yRange(s, 10, 20), { min: 4, max: 6 }); // min === max → ±1
  });

  it("falls back to {0, 1} for an empty series list", () => {
    assert.deepEqual(yRange([], 0, 1), { min: 0, max: 1 });
  });
});

describe("describe / accentColor", () => {
  const m = model([sample(7, 100, 0), sample(8, 200, 1)]);

  it("summarises a lane's series by name, joining several", () => {
    assert.equal(dataPlotLaneType.describe({ series: [7] }, m), "Data 0x7");
    assert.equal(dataPlotLaneType.describe({ series: [7, 8] }, m), "Data 0x7, Data 0x8");
    assert.equal(dataPlotLaneType.describe({ series: [] }, m), "no series");
  });

  it("tints a single-series lane with that series' hue; multi-series uses the host default", () => {
    assert.equal(dataPlotLaneType.accentColor!({ series: [7] }), contextColor("series:7"));
    assert.equal(dataPlotLaneType.accentColor!({ series: [7, 8] }), null);
  });
});

describe("sourceOptions (the Add-lane picker)", () => {
  it("offers one lane per series, in first-sampled order", () => {
    const opts = dataPlotLaneType.sourceOptions!(model([sample(8, 1, 0), sample(7, 1, 1), sample(8, 2, 2)]));
    assert.deepEqual(opts.map((o) => (o.source as DataPlotSource).series), [[8], [7]]);
    assert.deepEqual(opts.map((o) => o.label), ["Data 0x8", "Data 0x7"]);
  });
});

describe("cursorReadout (hover value-at-cursor)", () => {
  const rc = (cursorTime: number | null): { cursorTime: number | null } => ({ cursorTime });
  const readout = (m: TraceModel, s: DataPlotSource, cursorTime: number | null): readonly string[] | null =>
    // The lane only reads `cursorTime` off the render context; the rest is unused here.
    dataPlotLaneType.cursorReadout!(rc(cursorTime) as never, build(m, s), s);

  const m = model([sample(7, 100, 0), sample(7, 200, 2), sample(8, 5, 0), sample(8, 9, 2)]);

  it("returns null when there is no cursor", () => {
    assert.equal(readout(m, { series: [7] }, null), null);
  });

  it("reads each series' interpolated value at the cursor", () => {
    // Series 7: 100→200 over t=0..2, so t=1 interpolates to 150.
    assert.deepEqual(readout(m, { series: [7] }, 1), ["Data 0x7 = 150"]);
  });

  it("lists every series of a multi-series lane, in source order", () => {
    assert.deepEqual(readout(m, { series: [8, 7] }, 0), ["Data 0x8 = 5", "Data 0x7 = 100"]);
  });

  it("appends the unit when the series is registered with one", () => {
    const tempId = dataSeriesFor(DEMO).find((s) => s.name === "temp")!.id;
    const line = dataPlotLaneType.cursorReadout!(rc(0) as never, build(DEMO, { series: [tempId] }), { series: [tempId] });
    assert.ok(line && line[0]!.startsWith("temp (C) = "), `got ${line?.[0]}`);
  });
});

describe("registry integration", () => {
  it("registers under its type id with the right default height", () => {
    const reg = new LaneRegistry();
    reg.register(dataPlotLaneType);
    assert.equal(reg.get(DATAPLOT_LANE), dataPlotLaneType);
    assert.equal(reg.defaultHeight(DATAPLOT_LANE), 80);
  });
});

describe("committed DataPlot fixture", () => {
  it("enumerates every named series in the Add-lane picker", () => {
    const labels = dataPlotLaneType.sourceOptions!(DEMO).map((o) => o.label);
    // The single-core demo registers seven FLOAT series, each labelled name (unit).
    assert.deepEqual(
      labels.map((l) => l.replace(/ \(.*\)$/, "")).sort(),
      ["cpu0_load", "filtered", "heap_free", "raw", "temp", "throttle", "timer_jitter"],
    );
  });

  it("builds a real series slice with decoded float samples", () => {
    const series = dataSeriesFor(DEMO);
    const tempId = series.find((s) => s.name === "temp")!.id;
    const built = build(DEMO, { series: [tempId] });
    assert.equal(built.series.length, 1);
    assert.ok(built.series[0]!.points.length > 0, "temp has samples");
    assert.equal(built.series[0]!.unit, "C");
  });
});
