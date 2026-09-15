/**
 * DataPlot series processing and decimation layer.
 *
 * Extracts named numeric series from `svDataSample` and `svNameResource` events. Implements Largest-Triangle-Three-Buckets (LTTB) downsampling for responsive multi-scale line rendering, window-scoped summary statistics (min/max/avg), and linear interpolation for cursor readouts.
 */

import { SYSVIEW_DATA_TYPE, EVTID, type TraceEvent } from "../../../src/trace/index.js";
import { buildDataSampleRegistry, interpretSampleValue } from "../../core/data-samples.js";

/** One numeric sample: a trace time (seconds) and its value. */
export interface DataPoint {
  /** Sample time in seconds. */
  t: number;
  /** Sampled value (already interpreted per the series' registered type). */
  v: number;
}

/** A named numeric series: all samples of one registered DataPlot data id. */
export interface DataSeries {
  /** The DataPlot data id this series was registered/sampled under. */
  id: number;
  /** Stable key for colour + visibility (`series:<id>`). */
  key: string;
  /** Resolved series name (svRegisterData → svNameResource → `Data 0x..`). */
  name: string;
  /** Engineering unit from svRegisterData (e.g. `°C`), or `""` if none. */
  unit: string;
  /** Samples in ascending time order. */
  points: DataPoint[];
}

/** Summary statistics of a series over a time window. */
export interface SeriesStats {
  /** Smallest value in the window (`NaN` when the window holds no samples). */
  min: number;
  /** Largest value in the window (`NaN` when empty). */
  max: number;
  /** Mean value over the window (`NaN` when empty). */
  avg: number;
  /** Number of samples inside the window. */
  count: number;
}

/**
 * Determine whether trace events include at least one valid `svDataSample`.
 */
export function hasDataSamples(events: readonly TraceEvent[]): boolean {
  return events.some(
    (e) =>
      e.id === EVTID.DATA_SAMPLE &&
      e.params["data_id"] !== undefined &&
      e.params["value"] !== undefined,
  );
}

/**
 * Extract named numeric series from trace events. Collects metadata via {@link buildDataSampleRegistry} and interprets sample values according to registered data types.
 */
export function extractDataSeries(events: readonly TraceEvent[]): DataSeries[] {
  const registry = buildDataSampleRegistry(events);
  const dataTypeOf = (id: number): number => registry.get(id)?.dataType ?? SYSVIEW_DATA_TYPE.U32;

  const byId = new Map<number, DataSeries>();
  const order: DataSeries[] = [];
  for (const e of events) {
    if (e.id !== EVTID.DATA_SAMPLE) continue;
    const dataId = e.params["data_id"] as number | undefined;
    const bits = e.params["value"] as number | undefined;
    if (dataId === undefined || bits === undefined) continue;
    let series = byId.get(dataId);
    if (!series) {
      const m = registry.get(dataId);
      series = {
        id: dataId,
        key: `series:${dataId}`,
        name: m?.name ?? `Data 0x${dataId.toString(16)}`,
        unit: m?.unit ?? "",
        points: [],
      };
      byId.set(dataId, series);
      order.push(series);
    }
    series.points.push({ t: e.ts, v: interpretSampleValue(bits, dataTypeOf(dataId)) });
  }

  // Sort samples ascending by timestamp.
  for (const s of order) s.points.sort((a, b) => a.t - b.t);
  return order;
}

/**
 * Downsample time series points to `threshold` points using the Largest-Triangle-Three-Buckets (LTTB) algorithm. Preserves endpoints and significant peaks and valleys.
 */
export function lttb(points: readonly DataPoint[], threshold: number): DataPoint[] {
  const n = points.length;
  if (threshold >= n || threshold <= 0) return points.slice();
  if (threshold === 1) return [points[0]!];
  if (threshold === 2) return [points[0]!, points[n - 1]!];

  const sampled: DataPoint[] = [points[0]!]; // Preserve the first point.
  // Buckets span interior points; first and last points occupy separate endpoints.
  const bucketSize = (n - 2) / (threshold - 2);
  let a = 0; // index of the last point that was selected

  for (let i = 0; i < threshold - 2; i++) {
    // Compute average coordinates for the next bucket.
    let avgX = 0;
    let avgY = 0;
    let avgStart = Math.floor((i + 1) * bucketSize) + 1;
    let avgEnd = Math.floor((i + 2) * bucketSize) + 1;
    if (avgEnd > n) avgEnd = n;
    const avgCount = avgEnd - avgStart;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += points[j]!.t;
      avgY += points[j]!.v;
    }
    avgX /= avgCount;
    avgY /= avgCount;

    // Select point in current bucket maximizing triangle area with point a and next bucket average.
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;
    const ax = points[a]!.t;
    const ay = points[a]!.v;
    let maxArea = -1;
    let chosen = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs((ax - avgX) * (points[j]!.v - ay) - (ax - points[j]!.t) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        chosen = j;
      }
    }
    sampled.push(points[chosen]!);
    a = chosen;
  }

  sampled.push(points[n - 1]!); // Preserve the last point.
  return sampled;
}

/**
 * Returns the index of the first sample at or after time `t` using binary search. Returns `points.length` when `t` exceeds the last sample.
 */
function lowerBound(points: readonly DataPoint[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Calculates min, max, and average values for samples in `[t0, t1]`. Returns `NaN` metrics with count 0 when the window contains no samples.
 */
export function computeStats(points: readonly DataPoint[], t0: number, t1: number): SeriesStats {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let i = lowerBound(points, t0); i < points.length; i++) {
    const p = points[i]!;
    if (p.t > t1) break;
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
    sum += p.v;
    count++;
  }
  if (count === 0) return { min: NaN, max: NaN, avg: NaN, count: 0 };
  return { min, max, avg: sum / count, count };
}

/**
 * Returns samples intersecting the visible window `[t0, t1]` plus one bounding sample on each side. Preserves boundary slopes when downsampling via LTTB.
 */
export function visibleSlice(points: readonly DataPoint[], t0: number, t1: number): DataPoint[] {
  const n = points.length;
  if (n === 0) return [];
  let lo = lowerBound(points, t0);
  if (lo > 0) lo--; // Include adjacent sample before window.
  let hi = lowerBound(points, t1); // First sample at or after t1.
  if (hi < n) hi++; // Include adjacent sample after window.
  return points.slice(lo, hi);
}

/**
 * Returns ascending timestamps across all series samples for cursor snapping.
 */
export function mergedSampleTimes(series: readonly DataSeries[]): number[] {
  if (series.length === 1) return series[0]!.points.map((p) => p.t);
  const all: number[] = [];
  for (const s of series) for (const p of s.points) all.push(p.t);
  return all.sort((a, b) => a - b);
}

/**
 * Linearly interpolates series value at timestamp `t` between neighboring samples. Returns exact value at sample timestamps and clamps to endpoint values outside sampled bounds.
 */
export function valueAt(points: readonly DataPoint[], t: number): number | null {
  const n = points.length;
  if (n === 0) return null;
  if (t <= points[0]!.t) return points[0]!.v;
  if (t >= points[n - 1]!.t) return points[n - 1]!.v;
  const i = lowerBound(points, t); // Index with points[i].t >= t and i >= 1.
  const hi = points[i]!;
  if (hi.t === t) return hi.v;
  const lo = points[i - 1]!;
  const span = hi.t - lo.t;
  if (span <= 0) return hi.v;
  return lo.v + ((hi.v - lo.v) * (t - lo.t)) / span;
}
