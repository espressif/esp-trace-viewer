/**
 * CPU-load data aggregation layer.
 *
 * Reconstructs per-core execution intervals from timestamp-ordered events and pre-aggregates them into a power-of-two mip-chain of time bins over the full trace domain. Each level stores running durations per bin, per core, and per context. Coarser levels sum pairs of adjacent finer bins. Render passes select the appropriate level based on zoom scale and read visible bins in O(visible bins) time.
 */

import { EVTID } from "../../../src/trace/events.js";
import type { TraceEvent } from "../../../src/trace/index.js";

/** Largest finest-level bin count; bounds the precomputed mip memory. */
const MAX_FINE_BINS = 8192;
/** Minimum bin count for the coarsest mip level. */
const MIN_LEVEL_BINS = 1;

/** One mip level: a uniform binning of the whole domain. */
export interface MipLevel {
  /** Number of bins spanning the whole domain at this level. */
  binCount: number;
  /** Bin width in seconds (`domainSpan / binCount`). */
  binWidth: number;
  /**
   * Dense running seconds, row-major as
   * `bins[(bin * numCores + coreIdx) * numContexts + ctxIdx]`.
   */
  bins: Float64Array;
}

/** Pre-aggregated CPU-load data for a loaded model. */
export interface CpuLoadData {
  domainStart: number;
  domainEnd: number;
  /** Number of cores (≥ 1). */
  numCores: number;
  /** Sorted core ids, so a band index ↔ core id mapping is stable. */
  cores: number[];
  /** Context name by index, in first-seen order (matches the lane order). */
  contexts: string[];
  /** Context name → index into {@link contexts}. */
  ctxIndex: Map<string, number>;
  /** Mip levels, finest first (`levels[0]` has the most bins). */
  levels: MipLevel[];
}

/** One visible bin's per-context utilisation for a single core. */
export interface CpuBin {
  /** Bin start/end in seconds. */
  start: number;
  end: number;
  /** Per-context utilisation fraction (0..1), length `contexts.length`. */
  util: Float64Array;
  /** Total utilisation (sum of {@link util}); ≤ 1 (+ float epsilon). */
  total: number;
}

/** Smallest power of two ≥ `n`, clamped to `[lo, hi]` (lo/hi powers of two). */
function clampPow2(n: number, lo: number, hi: number): number {
  let p = lo;
  while (p < n && p < hi) p *= 2;
  return Math.min(p, hi);
}

/**
 * Add execution interval `[s, e)` for `(coreIdx, ctxIdx)` into the finest level, splitting across bin boundaries.
 */
function addInterval(
  bins: Float64Array,
  binCount: number,
  binWidth: number,
  domainStart: number,
  numCores: number,
  numCtx: number,
  coreIdx: number,
  ctxIdx: number,
  s: number,
  e: number,
): void {
  if (binWidth <= 0 || e <= s) return;
  let bin = Math.floor((s - domainStart) / binWidth);
  if (bin < 0) bin = 0;
  let t = Math.max(s, domainStart);
  while (t < e && bin < binCount) {
    const binEnd = domainStart + (bin + 1) * binWidth;
    const segEnd = Math.min(e, binEnd);
    const overlap = segEnd - t;
    if (overlap > 0) bins[(bin * numCores + coreIdx) * numCtx + ctxIdx]! += overlap;
    t = binEnd;
    bin++;
  }
}

/**
 * Build per-core and per-context mip-chain from trace events.
 *
 * Gaps between consecutive same-core events are attributed to the context active at the earlier event. An `svOverflow` event marks the end of an interval in which the target dropped events, so the interval it closes is attributed to nothing, and neither is the one it opens: the pre-gap context is forgotten until the next event on the core carries a context of its own.
 */
export function buildCpuLoadData(
  events: readonly TraceEvent[],
  domainStart: number,
  domainEnd: number,
): CpuLoadData {
  const ctxIndex = new Map<string, number>();
  const contexts: string[] = [];
  const coreSet = new Set<number>();
  for (const e of events) {
    coreSet.add(e.coreId);
    if (e.ctxName !== "None" && !ctxIndex.has(e.ctxName)) {
      ctxIndex.set(e.ctxName, contexts.length);
      contexts.push(e.ctxName);
    }
  }
  const cores = [...coreSet].sort((a, b) => a - b);
  const numCores = Math.max(1, cores.length);
  const coreIndex = new Map<number, number>();
  cores.forEach((c, i) => coreIndex.set(c, i));
  const numCtx = Math.max(1, contexts.length);

  const span = Math.max(domainEnd - domainStart, Number.MIN_VALUE);
  const fineBins = clampPow2(events.length, 1, MAX_FINE_BINS);
  const fineWidth = span / fineBins;
  const fine = new Float64Array(fineBins * numCores * numCtx);

  const lastTs = new Map<number, number>();
  const lastCtx = new Map<number, number>();
  for (const e of events) {
    const prevTs = lastTs.get(e.coreId);
    const prevCtx = lastCtx.get(e.coreId);
    const overflow = e.id === EVTID.OVERFLOW;
    if (prevTs !== undefined && prevCtx !== undefined && e.ts > prevTs && !overflow) {
      addInterval(fine, fineBins, fineWidth, domainStart, numCores, numCtx,
        coreIndex.get(e.coreId)!, prevCtx, prevTs, e.ts);
    }
    lastTs.set(e.coreId, e.ts);
    if (overflow) lastCtx.delete(e.coreId);
    else if (e.ctxName !== "None") lastCtx.set(e.coreId, ctxIndex.get(e.ctxName)!);
  }

  const levels: MipLevel[] = [{ binCount: fineBins, binWidth: fineWidth, bins: fine }];
  const stride = numCores * numCtx;
  let prev = levels[0]!;
  while (prev.binCount > MIN_LEVEL_BINS && prev.binCount % 2 === 0) {
    const binCount = prev.binCount / 2;
    const bins = new Float64Array(binCount * stride);
    for (let b = 0; b < binCount; b++) {
      const src0 = 2 * b * stride;
      const src1 = (2 * b + 1) * stride;
      const dst = b * stride;
      for (let k = 0; k < stride; k++) bins[dst + k] = prev.bins[src0 + k]! + prev.bins[src1 + k]!;
    }
    const level: MipLevel = { binCount, binWidth: span / binCount, bins };
    levels.push(level);
    prev = level;
  }

  return { domainStart, domainEnd, numCores, cores, contexts, ctxIndex, levels };
}

/**
 * Select the finest mip level containing at most `targetBins` across a window of `spanSeconds`. Returns index into `data.levels`.
 */
export function selectMipLevel(data: CpuLoadData, spanSeconds: number, targetBins: number): number {
  const want = spanSeconds / Math.max(1, targetBins);
  for (let i = 0; i < data.levels.length; i++) {
    if (data.levels[i]!.binWidth >= want) return i;
  }
  return data.levels.length - 1;
}

/**
 * Query bins at `level` intersecting `[t0, t1]` for the specified core as per-context utilization fractions.
 */
export function queryCpuLoadBins(
  data: CpuLoadData,
  level: number,
  t0: number,
  t1: number,
  core: number,
): CpuBin[] {
  const lvl = data.levels[level];
  const out: CpuBin[] = [];
  const coreIdx = data.cores.indexOf(core);
  if (!lvl || coreIdx < 0 || lvl.binWidth <= 0) return out;
  const numCtx = Math.max(1, data.contexts.length);
  const bw = lvl.binWidth;
  let first = Math.floor((t0 - data.domainStart) / bw);
  let last = Math.floor((t1 - data.domainStart) / bw);
  if (first < 0) first = 0;
  if (last > lvl.binCount - 1) last = lvl.binCount - 1;
  for (let b = first; b <= last; b++) {
    const base = (b * data.numCores + coreIdx) * numCtx;
    const util = new Float64Array(numCtx);
    let total = 0;
    for (let c = 0; c < numCtx; c++) {
      const u = lvl.bins[base + c]! / bw;
      util[c] = u;
      total += u;
    }
    out.push({ start: data.domainStart + b * bw, end: data.domainStart + (b + 1) * bw, util, total });
  }
  return out;
}
