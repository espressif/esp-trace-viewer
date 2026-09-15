/**
 * Unit tests for the DataPlot data layer (`web/ui/panes/dataplot-rows.ts`):
 * named-series extraction from data-sample and name-resource events, LTTB
 * downsampling (endpoint and extremum preservation and determinism), per-window
 * min/max/avg statistics, and interpolated value-at-time calculations.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { SYSVIEW_DATA_TYPE, EVTID, type TraceEvent } from "../../src/trace/index.js";
import {
  computeStats,
  extractDataSeries,
  hasDataSamples,
  lttb,
  mergedSampleTimes,
  valueAt,
  visibleSlice,
  type DataPoint,
} from "../../web/ui/panes/dataplot-rows.js";

/** A data-sample event carrying (data_id, raw 32-bit value) at time `ts`. */
function sample(ts: number, dataId: number, value: number): TraceEvent {
  return {
    id: EVTID.DATA_SAMPLE,
    ts,
    params: { data_id: dataId, value: value >>> 0 },
  } as unknown as TraceEvent;
}

/** Converts a number to its IEEE-754 float32 representation as a uint32. */
const _f32 = new DataView(new ArrayBuffer(4));
function floatBits(v: number): number {
  _f32.setFloat32(0, v, true);
  return _f32.getUint32(0, true);
}

/** A name-resource event binding `resId` to `name`. */
function nameRes(resId: number, name: string): TraceEvent {
  return {
    id: EVTID.NAME_RESOURCE,
    ts: 0,
    params: { res_id: resId, name },
  } as unknown as TraceEvent;
}

/** A svRegisterData (EVTID_EX) registration event. */
function registerData(
  id: number,
  name: string,
  dataType: number,
  unit?: string,
): TraceEvent {
  return {
    id: EVTID.EX,
    name: "svRegisterData",
    ts: 0,
    params: { data_id: id, name, data_type: dataType, ...(unit ? { unit } : {}) },
  } as unknown as TraceEvent;
}

/** A flat ramp of `n` points `(i, i)` for downsampling tests. */
function ramp(n: number): DataPoint[] {
  return Array.from({ length: n }, (_, i) => ({ t: i, v: i }));
}

describe("extractDataSeries", () => {
  it("groups samples by data id and resolves names from name-resource events", () => {
    const series = extractDataSeries([
      nameRes(1, "Temperature"),
      nameRes(2, "Voltage"),
      sample(0, 1, 250),
      sample(0, 2, 10),
      sample(1, 1, 260),
      sample(1, 2, 20),
    ]);
    assert.equal(series.length, 2);
    const temp = series.find((s) => s.id === 1)!;
    assert.equal(temp.name, "Temperature");
    assert.equal(temp.key, "series:1");
    assert.deepEqual(temp.points, [{ t: 0, v: 250 }, { t: 1, v: 260 }]);
    assert.equal(series.find((s) => s.id === 2)!.name, "Voltage");
  });

  it("resolves a name registered after the first sample", () => {
    // The name resource can arrive late; a two-pass scan binds it regardless of order.
    const series = extractDataSeries([sample(0, 5, 1), nameRes(5, "Late")]);
    assert.equal(series[0]!.name, "Late");
  });

  it("falls back to a hex Data label for an unnamed series", () => {
    const series = extractDataSeries([sample(0, 0x2a, 99)]);
    assert.equal(series[0]!.name, "Data 0x2a");
  });

  it("keeps series in first-seen order and points ascending in time", () => {
    const series = extractDataSeries([
      sample(0, 9, 1),
      sample(0, 3, 1),
      sample(2, 9, 3),
      sample(1, 9, 2), // out of order on purpose
    ]);
    assert.deepEqual(series.map((s) => s.id), [9, 3]);
    assert.deepEqual(series[0]!.points.map((p) => p.t), [0, 1, 2]);
  });
});

describe("hasDataSamples", () => {
  it("is true when the stream carries a data sample", () => {
    assert.equal(hasDataSamples([nameRes(1, "Temperature"), sample(0, 1, 250)]), true);
  });

  it("is false for a stream with no data-sample events", () => {
    assert.equal(hasDataSamples([nameRes(1, "Temperature")]), false);
    assert.equal(hasDataSamples([]), false);
  });

  it("agrees with extractDataSeries on whether any series exists", () => {
    const withData = [registerData(1, "U", SYSVIEW_DATA_TYPE.U32), sample(0, 1, 7)];
    const without = [nameRes(2, "Voltage")];
    assert.equal(hasDataSamples(withData), extractDataSeries(withData).length > 0);
    assert.equal(hasDataSamples(without), extractDataSeries(without).length > 0);
  });
});

describe("extractDataSeries — typed values from svRegisterData", () => {
  it("takes name/unit from svRegisterData over svNameResource", () => {
    const series = extractDataSeries([
      nameRes(2, "FromNameResource"),
      registerData(2, "Voltage", SYSVIEW_DATA_TYPE.U32, "mV"),
      sample(0, 2, 3300),
    ]);
    assert.equal(series[0]!.name, "Voltage");
    assert.equal(series[0]!.unit, "mV");
  });

  it("reads U32 samples as unsigned integers", () => {
    const series = extractDataSeries([
      registerData(1, "U", SYSVIEW_DATA_TYPE.U32),
      sample(0, 1, 0xffffffff),
    ]);
    assert.equal(series[0]!.points[0]!.v, 0xffffffff); // 4294967295, not -1
  });

  it("sign-extends I32 samples", () => {
    const series = extractDataSeries([
      registerData(3, "Drift", SYSVIEW_DATA_TYPE.I32, "ppm"),
      sample(0, 3, -7 >>> 0), // raw 0xFFFFFFF9 on the wire
      sample(1, 3, 5),
    ]);
    assert.deepEqual(series[0]!.points.map((p) => p.v), [-7, 5]);
  });

  it("reinterprets FLOAT sample bits as IEEE-754 floats", () => {
    const series = extractDataSeries([
      registerData(1, "Temp", SYSVIEW_DATA_TYPE.FLOAT, "°C"),
      sample(0, 1, floatBits(25.5)),
      sample(1, 1, floatBits(-1.25)),
    ]);
    const vs = series[0]!.points.map((p) => p.v);
    assert.ok(Math.abs(vs[0]! - 25.5) < 1e-6);
    assert.ok(Math.abs(vs[1]! - -1.25) < 1e-6);
  });

  it("defaults an unregistered series to U32 with an empty unit", () => {
    const series = extractDataSeries([sample(0, 1, 42)]);
    assert.equal(series[0]!.unit, "");
    assert.equal(series[0]!.points[0]!.v, 42);
  });
});

describe("lttb downsampling", () => {
  it("returns the input unchanged when the threshold is not smaller", () => {
    const pts = ramp(5);
    assert.deepEqual(lttb(pts, 5), pts);
    assert.deepEqual(lttb(pts, 10), pts);
  });

  it("preserves the first and last points exactly", () => {
    const pts = ramp(100);
    const out = lttb(pts, 10);
    assert.equal(out.length, 10);
    assert.deepEqual(out[0], pts[0]);
    assert.deepEqual(out[out.length - 1], pts[99]);
  });

  it("preserves a sharp extremum (the largest-area point survives)", () => {
    // A flat line with one spike: LTTB maximizes triangle area, preserving the spike in output.
    const pts: DataPoint[] = ramp(60).map((p) => ({ t: p.t, v: 0 }));
    pts[30] = { t: 30, v: 1000 };
    const out = lttb(pts, 12);
    assert.ok(out.some((p) => p.t === 30 && p.v === 1000), "spike preserved");
  });

  it("is deterministic (same input → same output)", () => {
    const pts = ramp(200).map((p) => ({ t: p.t, v: Math.sin(p.t / 7) }));
    assert.deepEqual(lttb(pts, 25), lttb(pts, 25));
  });

  it("handles degenerate thresholds (0/1/2)", () => {
    const pts = ramp(10);
    assert.deepEqual(lttb(pts, 0), pts); // 0 ⇒ unchanged copy
    assert.deepEqual(lttb(pts, 1), [pts[0]]);
    assert.deepEqual(lttb(pts, 2), [pts[0], pts[9]]);
  });
});

describe("computeStats over a window", () => {
  const pts: DataPoint[] = [
    { t: 0, v: 10 },
    { t: 1, v: 30 },
    { t: 2, v: 20 },
    { t: 3, v: 50 },
    { t: 4, v: 40 },
  ];

  it("computes min/max/avg/count over the inclusive window", () => {
    const st = computeStats(pts, 1, 3);
    assert.equal(st.count, 3);
    assert.equal(st.min, 20);
    assert.equal(st.max, 50);
    assert.ok(Math.abs(st.avg - (30 + 20 + 50) / 3) < 1e-12);
  });

  it("spans the whole series when the window covers it", () => {
    const st = computeStats(pts, -1, 10);
    assert.equal(st.count, 5);
    assert.equal(st.min, 10);
    assert.equal(st.max, 50);
    assert.equal(st.avg, 30);
  });

  it("returns NaN stats with count 0 for an empty window", () => {
    const st = computeStats(pts, 100, 200);
    assert.equal(st.count, 0);
    assert.ok(Number.isNaN(st.min) && Number.isNaN(st.max) && Number.isNaN(st.avg));
  });
});

describe("mergedSampleTimes (cursor-snap domain)", () => {
  const series = (id: number, ...ts: number[]) =>
    ({ id, key: `series:${id}`, name: `s${id}`, unit: "", points: ts.map((t) => ({ t, v: 0 })) });

  it("returns a single series' times as-is", () => {
    assert.deepEqual(mergedSampleTimes([series(1, 0, 5, 9)]), [0, 5, 9]);
  });

  it("merges several series ascending", () => {
    assert.deepEqual(mergedSampleTimes([series(1, 0, 6), series(2, 3, 9)]), [0, 3, 6, 9]);
  });

  it("is empty for no series", () => {
    assert.deepEqual(mergedSampleTimes([]), []);
  });
});

describe("valueAt (cursor readout)", () => {
  const pts: DataPoint[] = [
    { t: 0, v: 0 },
    { t: 10, v: 100 },
    { t: 20, v: 50 },
  ];

  it("returns the exact value at a sample time", () => {
    assert.equal(valueAt(pts, 0), 0);
    assert.equal(valueAt(pts, 10), 100);
    assert.equal(valueAt(pts, 20), 50);
  });

  it("linearly interpolates between samples", () => {
    assert.equal(valueAt(pts, 5), 50); // midway 0→100
    assert.equal(valueAt(pts, 15), 75); // midway 100→50
  });

  it("clamps to the endpoints outside the sampled range", () => {
    assert.equal(valueAt(pts, -5), 0);
    assert.equal(valueAt(pts, 99), 50);
  });

  it("returns null for an empty series", () => {
    assert.equal(valueAt([], 1), null);
  });
});

describe("visibleSlice (visible-window samples for the line)", () => {
  const pts: DataPoint[] = [
    { t: 0, v: 0 },
    { t: 10, v: 10 },
    { t: 20, v: 20 },
    { t: 30, v: 30 },
    { t: 40, v: 40 },
  ];

  it("includes one neighbour on each side of the window", () => {
    // Window [15, 25] contains t=20; the slice includes t=10 and t=30 to maintain line slope at edges.
    assert.deepEqual(
      visibleSlice(pts, 15, 25).map((p) => p.t),
      [10, 20, 30],
    );
  });

  it("keeps every interior sample plus the bracketing neighbours", () => {
    assert.deepEqual(
      visibleSlice(pts, 12, 38).map((p) => p.t),
      [10, 20, 30, 40],
    );
  });

  it("returns the whole series when the window spans it", () => {
    assert.deepEqual(
      visibleSlice(pts, -5, 100).map((p) => p.t),
      [0, 10, 20, 30, 40],
    );
  });

  it("has no left neighbour to add at the series start", () => {
    assert.deepEqual(
      visibleSlice(pts, 0, 5).map((p) => p.t),
      [0, 10],
    );
  });

  it("has no right neighbour to add at the series end", () => {
    assert.deepEqual(
      visibleSlice(pts, 35, 40).map((p) => p.t),
      [30, 40],
    );
  });

  it("returns empty for an empty series", () => {
    assert.deepEqual(visibleSlice([], 0, 10), []);
  });
});
