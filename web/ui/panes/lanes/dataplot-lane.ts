/**
 * DataPlot numeric series lane type implemented as a {@link LaneTypeDef}.
 *
 * Each lane plots one or more named series ({@link DataPlotSource.series}) as colored polylines, autoscaled together across the visible time window. The default layout creates one lane per series and adds lanes when new series appear during live capture (see {@link ../../../core/lanes/default-layout.reconcileAuto}). Multiple series can also be combined into a single lane.
 *
 * Samples are extracted once per model and memoized by model identity in {@link dataSeriesFor}. Each polyline is downsampled using largest triangle three buckets (LTTB) to approximately 2x the plot width (see {@link ./../dataplot-rows}). An in-band legend displays each series with its value at the cursor, and the lane draws per-series dots and readout values.
 */

import type { TraceModel } from "../../../../src/trace/index.js";
import { listDataSeries } from "../../../core/data-samples.js";
import type { LaneRenderContext, LaneTypeDef } from "../../../core/lanes/registry.js";
import { DATAPLOT_LANE, type DataPlotSource } from "../../../core/lanes/types.js";
import { contextColor } from "../../../core/theme.js";
import { cssVar } from "../../canvas-util.js";
import { computeStats, extractDataSeries, lttb, mergedSampleTimes, valueAt, visibleSlice, type DataPoint, type DataSeries } from "../dataplot-rows.js";

/** Target downsampled points per plot pixel for LTTB downsampling. */
const POINTS_PER_PX = 2;
/** Vertical inset padding for plot content in CSS pixels. */
const PAD_TOP = 8;
const PAD_BOTTOM = 6;
/** In-band legend horizontal offset and row height in CSS pixels. */
const LEGEND_X = 6;
const LEGEND_ROW_H = 13;
/** Radius of sample marker dots in CSS pixels. */
const SAMPLE_DOT_R = 2;
/** Minimum average spacing in CSS pixels between visible samples required to render sample marker dots. */
const MIN_SAMPLE_SPACING_PX = 8;

/** Built render data for {@link dataPlotLaneType}. */
export interface DataPlotBuilt {
  /** Resolved series plotted by this lane in source order. */
  readonly series: readonly DataSeries[];
}

/** Formats a series display label with optional engineering units. */
function seriesLabel(s: DataSeries): string {
  return s.unit ? `${s.name} (${s.unit})` : s.name;
}

/** Formats a numeric value compactly for axis labels and cursor readouts. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e5 || abs < 1e-3)) return v.toExponential(2);
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

/** Caches DataPlot series extracted per model instance. */
const cache = new WeakMap<TraceModel, DataSeries[]>();

/** Returns shared series list for `model`, populating the cache on first access. */
export function dataSeriesFor(model: TraceModel): DataSeries[] {
  let series = cache.get(model);
  if (!series) {
    series = extractDataSeries(model.events);
    cache.set(model, series);
  }
  return series;
}

/** Resolves series requested by `source` from the shared extraction. */
function sliceFor(model: TraceModel, source: DataPlotSource): DataPlotBuilt {
  const byId = new Map(dataSeriesFor(model).map((s) => [s.id, s]));
  const series: DataSeries[] = [];
  for (const id of source.series) {
    const s = byId.get(id);
    if (s) series.push(s);
  }
  return { series };
}

/**
 * Calculates the y-axis range spanning all series over `[t0, t1]` with padding. Includes interpolated boundary values at `t0` and `t1` so segments entering and exiting the visible window scale proportionally to the plot boundaries.
 */
export function yRange(series: readonly DataSeries[], t0: number, t1: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    const st = computeStats(s.points, t0, t1);
    if (st.count > 0) {
      if (st.min < min) min = st.min;
      if (st.max > max) max = st.max;
    }
    for (const t of [t0, t1]) {
      const v = valueAt(s.points, t);
      if (v === null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * 0.05;
  return { min: min - pad, max: max + pad };
}

/** Draws gridlines, downsampled polylines, cursor indicators, and legend. */
function draw(rc: LaneRenderContext, built: DataPlotBuilt): void {
  const { ctx, timeScale, gutterWidth, widthPx } = rc;
  const plotW = widthPx - gutterWidth;
  if (plotW <= 0 || rc.height <= 0 || !built.series.length) return;

  const innerTop = rc.top + PAD_TOP;
  const innerH = rc.height - PAD_TOP - PAD_BOTTOM;
  if (innerH <= 0) return;
  const { min, max } = yRange(built.series, timeScale.t0, timeScale.t1);
  const span = max - min || 1;
  const valueToY = (v: number): number => innerTop + (1 - (v - min) / span) * innerH;

  ctx.save();
  ctx.beginPath();
  ctx.rect(gutterWidth, rc.top, plotW, rc.height);
  ctx.clip();

  // Draw top, middle, and bottom gridlines with edge value labels.
  ctx.strokeStyle = cssVar("--grid-line", "rgba(128,128,128,0.25)");
  ctx.fillStyle = cssVar("--grid-text", "rgba(128,128,128,0.9)");
  ctx.font = "9px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (let i = 0; i <= 2; i++) {
    const v = max - ((max - min) * i) / 2;
    const y = Math.round(valueToY(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(gutterWidth, y);
    ctx.lineTo(widthPx, y);
    ctx.stroke();
    if (i !== 1) ctx.fillText(fmt(v), widthPx - 3, clampY(y, innerTop, innerTop + innerH));
  }
  ctx.textAlign = "left";

  // Draw one downsampled polyline per series over the visible window, adding sample dots if spacing permits.
  const target = Math.max(2, Math.round(plotW * POINTS_PER_PX));
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  for (const s of built.series) {
    if (s.points.length < 1) continue;
    const vis = visibleSlice(s.points, timeScale.t0, timeScale.t1);
    if (!vis.length) continue;
    const color = contextColor(s.key);
    ctx.strokeStyle = color;
    ctx.beginPath();
    let started = false;
    for (const p of lttb(vis, target)) {
      const x = timeScale.timeToX(p.t);
      const y = valueToY(p.v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    drawSampleDots(rc, vis, valueToY, plotW, color);
  }

  // Draw per-series marker dots at the cursor position.
  const cursor = rc.cursorTime;
  if (cursor !== null && cursor >= timeScale.t0 && cursor <= timeScale.t1) {
    for (const s of built.series) {
      const v = valueAt(s.points, cursor);
      if (v === null) continue;
      ctx.fillStyle = contextColor(s.key);
      ctx.beginPath();
      ctx.arc(timeScale.timeToX(cursor), valueToY(v), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Draw an in-band legend for multi-series lanes showing series swatches, names, and cursor values.
  if (built.series.length > 1) {
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    built.series.forEach((s, i) => {
      const mid = rc.top + PAD_TOP + i * LEGEND_ROW_H + LEGEND_ROW_H / 2;
      if (mid > rc.top + rc.height) return;
      const x = gutterWidth + LEGEND_X;
      ctx.fillStyle = contextColor(s.key);
      ctx.fillRect(x, mid - 4, 8, 8);
      const cur = cursor !== null ? valueAt(s.points, cursor) : null;
      const name = seriesLabel(s);
      const label = cur === null ? name : `${name} = ${fmt(cur)}`;
      ctx.fillStyle = cssVar("--lane-text", "rgba(180,180,180,0.95)");
      ctx.fillText(label, x + 12, mid + 0.5);
    });
  }
  ctx.restore();
}

/**
 * Renders sample marker dots inside the visible window when average sample spacing is at least {@link MIN_SAMPLE_SPACING_PX}.
 */
function drawSampleDots(
  rc: LaneRenderContext,
  vis: readonly DataPoint[],
  valueToY: (v: number) => number,
  plotW: number,
  color: string,
): void {
  const { ctx, timeScale } = rc;
  const { t0, t1 } = timeScale;
  let inWindow = 0;
  for (const p of vis) if (p.t >= t0 && p.t <= t1) inWindow++;
  if (inWindow < 2 || plotW / inWindow < MIN_SAMPLE_SPACING_PX) return;
  ctx.fillStyle = color;
  for (const p of vis) {
    if (p.t < t0 || p.t > t1) continue;
    ctx.beginPath();
    ctx.arc(timeScale.timeToX(p.t), valueToY(p.v), SAMPLE_DOT_R, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Clamps y label coordinates to remain within visible plot bounds. */
function clampY(y: number, lo: number, hi: number): number {
  return y < lo + 5 ? lo + 5 : y > hi - 5 ? hi - 5 : y;
}

/**
 * DataPlot lane type definition. The build step resolves series from the shared model cache, draw renders autoscaled polylines, and cursorReadout provides numeric values at the cursor position.
 */
export const dataPlotLaneType: LaneTypeDef<DataPlotSource, DataPlotBuilt> = {
  type: DATAPLOT_LANE,
  displayName: "Data plot",
  defaultHeight: 80,
  describe(source, model) {
    if (!source.series.length) return "no series";
    const names = model ? new Map(listDataSeries(model.events).map((s) => [s.id, s.name])) : new Map<number, string>();
    return source.series.map((id) => names.get(id) ?? `Data 0x${id.toString(16)}`).join(", ");
  },
  accentColor(source) {
    // Single-series lanes use deterministic series color; multi-series lanes use default gutter styling.
    return source.series.length === 1 ? contextColor(`series:${source.series[0]}`) : null;
  },
  sourceOptions(model) {
    // Generate one addable lane option per series ordered by first sample time.
    return listDataSeries(model.events).map((s) => ({
      source: { series: [s.id] } as DataPlotSource,
      label: s.unit ? `${s.name} (${s.unit})` : s.name,
    }));
  },
  build(model, source) {
    return sliceFor(model, source);
  },
  draw(rc, built, _source) {
    draw(rc, built);
  },
  cursorReadout(rc, built) {
    const cursor = rc.cursorTime;
    if (cursor === null) return null;
    const lines: string[] = [];
    for (const s of built.series) {
      const v = valueAt(s.points, cursor);
      if (v === null) continue;
      lines.push(`${seriesLabel(s)} = ${fmt(v)}`);
    }
    return lines.length ? lines : null;
  },
  snapTimes(built) {
    // Sample timestamps for cursor snap.
    return mergedSampleTimes(built.series);
  },
};
