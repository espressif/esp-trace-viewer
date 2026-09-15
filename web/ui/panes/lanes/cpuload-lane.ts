/**
 * CPU load lane type implementing a stacked utilization histogram as a {@link LaneTypeDef}.
 *
 * This lane displays stacked CPU utilization per time bin across all cores (`total`) or for an individual core. Each bin renders as a vertical bar stacked from the baseline with a color-coded segment per executing context. Idle tasks are omitted so that idle time appears as empty space above the stacked segments.
 *
 * Multi-resolution mip data from {@link ../cpu-load-rows} is constructed once per model and cached by model identity in {@link cpuLoadDataFor}. Rendering queries only bins intersecting the visible window in O(visible bins) time. For multi-core configurations, total load averages utilization across cores so maximum aggregate load normalizes to 1.0.
 */

import type { TraceModel } from "../../../../src/trace/index.js";
import { deriveDomain } from "../../../core/open-files.js";
import type { LaneRenderContext, LaneTypeDef } from "../../../core/lanes/registry.js";
import { CPULOAD_LANE, type CpuLoadSource } from "../../../core/lanes/types.js";
import { contextColor } from "../../../core/theme.js";
import { cssVar } from "../../canvas-util.js";
import {
  buildCpuLoadData,
  queryCpuLoadBins,
  selectMipLevel,
  type CpuBin,
  type CpuLoadData,
} from "../cpu-load-rows.js";

/** Target pixel width per bin in plot coordinates. */
const TARGET_BIN_PX = 6;
const MIN_BINS = 8;
const MAX_BINS = 600;
/** Regular expression identifying idle context names. */
const IDLE_RE = /^idle/i;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Context identifier and name mapping for stacked bar rendering. */
interface StackedContext {
  ctx: number;
  key: string;
}

/**
 * Caches CPU-load multi-resolution data keyed by model identity.
 */
const cache = new WeakMap<TraceModel, CpuLoadData>();

/** Returns shared {@link CpuLoadData} for `model`, populating the cache on first access. */
export function cpuLoadDataFor(model: TraceModel): CpuLoadData {
  let data = cache.get(model);
  if (!data) {
    const domain = deriveDomain(model);
    data = buildCpuLoadData(model.events, domain.start, domain.end);
    cache.set(model, data);
  }
  return data;
}

/** Returns non-idle contexts present in `data`. */
export function stackedContexts(data: CpuLoadData): StackedContext[] {
  const out: StackedContext[] = [];
  data.contexts.forEach((key, ctx) => {
    if (!IDLE_RE.test(key)) out.push({ ctx, key });
  });
  return out;
}

/**
 * Returns the cores a lane plots: all cores for total, or the named core if present, minus the cores switched
 * off in the CPUs menu. A total lane left with one core plots that core rather than an average over nothing.
 */
function coresOf(data: CpuLoadData, source: CpuLoadSource, hiddenCores: ReadonlySet<number>): number[] {
  const cores = source.kind === "total" ? data.cores : data.cores.filter((c) => c === source.coreId);
  return cores.filter((c) => !hiddenCores.has(c));
}

/** Calculates desired bin count across a plot of `plotPx` width. */
function targetBins(plotPx: number): number {
  return clamp(Math.round(plotPx / TARGET_BIN_PX), MIN_BINS, MAX_BINS);
}

/**
 * Returns visible bins for `cores` as per-context utilization fractions. A single core reads the mip directly; total averages the per-context utilization across cores so a fully busy bin across every core sums to at most 1.
 */
export function aggregateBins(
  data: CpuLoadData,
  level: number,
  t0: number,
  t1: number,
  cores: readonly number[],
): CpuBin[] {
  if (cores.length === 1) return queryCpuLoadBins(data, level, t0, t1, cores[0]!);
  const perCore = cores.map((c) => queryCpuLoadBins(data, level, t0, t1, c));
  const count = perCore[0]?.length ?? 0;
  const out: CpuBin[] = [];
  for (let b = 0; b < count; b++) {
    const first = perCore[0]![b]!;
    const util = new Float64Array(first.util.length);
    for (const bins of perCore) {
      const bin = bins[b];
      if (!bin) continue;
      for (let k = 0; k < util.length; k++) util[k]! += bin.util[k]!;
    }
    let total = 0;
    for (let k = 0; k < util.length; k++) {
      util[k]! /= cores.length;
      total += util[k]!;
    }
    out.push({ start: first.start, end: first.end, util, total });
  }
  return out;
}

/** Draws the stacked histogram into the lane band, clipped to the plot area. */
function draw(rc: LaneRenderContext, data: CpuLoadData, source: CpuLoadSource): void {
  const cores = coresOf(data, source, rc.hiddenCores);
  if (!cores.length || rc.height <= 0) return;
  const { ctx, timeScale, gutterWidth, widthPx } = rc;
  const plotW = widthPx - gutterWidth;
  if (plotW <= 0) return;

  const level = selectMipLevel(data, timeScale.spanSeconds, targetBins(plotW));
  const stack = stackedContexts(data);
  const bottom = rc.top + rc.height;

  ctx.save();
  ctx.beginPath();
  ctx.rect(gutterWidth, rc.top, plotW, rc.height);
  ctx.clip();
  for (const bin of aggregateBins(data, level, timeScale.t0, timeScale.t1, cores)) {
    const x0 = timeScale.timeToX(bin.start);
    const w = Math.max(1, timeScale.timeToX(bin.end) - x0);
    let y = bottom;
    for (const s of stack) {
      const u = bin.util[s.ctx]!;
      if (u <= 0) continue;
      const h = u * rc.height;
      ctx.fillStyle = contextColor(s.key);
      ctx.fillRect(x0, y - h, w, Math.max(1, h));
      y -= h;
    }
  }
  // Draw a baseline along the bottom edge.
  ctx.strokeStyle = cssVar("--border", "rgba(128,128,128,0.4)");
  ctx.beginPath();
  ctx.moveTo(gutterWidth, Math.round(bottom) - 0.5);
  ctx.lineTo(widthPx, Math.round(bottom) - 0.5);
  ctx.stroke();
  ctx.restore();
}

/**
 * Returns the load readout at the cursor bin: the total plus each contributing task's share sorted from largest to smallest. Reads the same mip level used during rendering so readout values match rendered bars.
 */
function cursorReadout(rc: LaneRenderContext, data: CpuLoadData, source: CpuLoadSource): string[] | null {
  const cursor = rc.cursorTime;
  if (cursor === null) return null;
  const cores = coresOf(data, source, rc.hiddenCores);
  const plotW = rc.widthPx - rc.gutterWidth;
  if (!cores.length || plotW <= 0) return null;
  const level = selectMipLevel(data, rc.timeScale.spanSeconds, targetBins(plotW));
  const bin = aggregateBins(data, level, cursor, cursor, cores)[0];
  if (!bin) return null;
  const pct = (u: number): string => `${(u * 100).toFixed(1)}%`;
  const parts = stackedContexts(data)
    .map((s) => ({ key: s.key, u: bin.util[s.ctx]! }))
    .filter((p) => p.u > 0)
    .sort((a, b) => b.u - a.u);
  const load = parts.reduce((sum, p) => sum + p.u, 0);
  return [`Load = ${pct(load)}`, ...parts.map((p) => `${p.key} = ${pct(p.u)}`)];
}

/**
 * CPU load lane type definition. The build step returns the shared memoized mip-chain; draw renders stacked visible bins; cursorReadout returns the load breakdown at the cursor bin.
 */
export const cpuLoadLaneType: LaneTypeDef<CpuLoadSource, CpuLoadData> = {
  type: CPULOAD_LANE,
  displayName: "CPU load",
  defaultHeight: 64,
  describe(source, model) {
    if (source.kind === "core") return `CPU load · core ${source.coreId}`;
    const multi = model ? new Set(model.events.map((e) => e.coreId)).size > 1 : false;
    return multi ? "CPU load · all cores" : "CPU load";
  },
  sourceOptions(model) {
    const cores = cpuLoadDataFor(model).cores;
    const multi = cores.length > 1;
    const opts = [{ source: { kind: "total" } as CpuLoadSource, label: multi ? "CPU Load (total)" : "CPU Load" }];
    if (multi) {
      for (const c of cores) {
        opts.push({ source: { kind: "core", coreId: c } as CpuLoadSource, label: `CPU Load (core ${c})` });
      }
    }
    return opts;
  },
  build(model) {
    return cpuLoadDataFor(model);
  },
  draw(rc, data, source) {
    draw(rc, data, source);
  },
  cursorReadout(rc, data, source) {
    return cursorReadout(rc, data, source);
  },
};
