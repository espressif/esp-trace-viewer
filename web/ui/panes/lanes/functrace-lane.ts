/**
 * Function trace lane type rendering compiler-instrumented call trees within the configurable timeline.
 *
 * Each lane renders nested `function_enter` and `function_exit` frames for a single execution context on the shared time axis. Depth 0 represents the outermost call at the top of the band, with callees stacked below. Frames are colored by function identity and labeled with ELF symbol names or raw hexadecimal addresses. Frame trees are reconstructed once per model and cached by model identity in {@link funcTraceDataFor}.
 */

import type { TraceModel } from "../../../../src/trace/index.js";
import { deriveDomain } from "../../../core/open-files.js";
import { contextColor } from "../../../core/theme.js";
import type { LaneRenderContext, LaneTarget, LaneTypeDef } from "../../../core/lanes/registry.js";
import { FUNCTRACE_LANE, type FuncTraceSource } from "../../../core/lanes/types.js";
import { cssVar } from "../../canvas-util.js";
import {
  buildFuncTraceData,
  frameAt,
  funcTraceContexts,
  stackAtTime,
  type FuncFrame,
  type FuncTraceData,
} from "../functrace-rows.js";

/** Height of one call nesting level row in CSS pixels. */
const ROW_H = 14;
/** Vertical gap between rows and top band inset in CSS pixels. */
const ROW_GAP = 1;
/** Minimum frame width in CSS pixels required to render text labels. */
const LABEL_MIN_PX = 24;

/** Built render data for {@link funcTraceLaneType}. */
export interface FuncTraceBuilt {
  /** Closed frames for this context, sorted by start timestamp. */
  readonly frames: readonly FuncFrame[];
  /** Resolves code addresses to ELF symbol names or hexadecimal strings. */
  readonly nameOf: (addr: number) => string;
}

/** Caches reconstructed per-context frames keyed by model identity. */
const cache = new WeakMap<TraceModel, FuncTraceData>();

/** Returns shared {@link FuncTraceData} for `model`, reconstructing frames on first access. */
export function funcTraceDataFor(model: TraceModel): FuncTraceData {
  let data = cache.get(model);
  if (!data) {
    data = buildFuncTraceData(model.events, deriveDomain(model).end);
    cache.set(model, data);
  }
  return data;
}

/** Returns frames for context `key` in `model`, or an empty array if uninstrumented. */
export function funcTraceFrames(model: TraceModel, key: string): readonly FuncFrame[] {
  return funcTraceDataFor(model).framesByContext.get(key) ?? [];
}

/** Creates a memoized address-to-symbol resolver using the loaded ELF image. */
function makeNameOf(model: TraceModel): (addr: number) => string {
  const memo = new Map<number, string>();
  return (addr: number): string => {
    let name = memo.get(addr);
    if (name === undefined) {
      name = model.elf?.lookup(addr)?.name ?? `0x${(addr >>> 0).toString(16)}`;
      memo.set(addr, name);
    }
    return name;
  };
}

/** Draws the flame graph into the lane band, clipped to the plot area. */
function draw(rc: LaneRenderContext, built: FuncTraceBuilt): void {
  if (!built.frames.length || rc.height <= 0) return;
  const { ctx, timeScale, gutterWidth, widthPx } = rc;
  const plotW = widthPx - gutterWidth;
  if (plotW <= 0) return;
  const { t0, t1 } = timeScale;
  const maxRows = Math.floor(rc.height / (ROW_H + ROW_GAP));

  ctx.save();
  ctx.beginPath();
  ctx.rect(gutterWidth, rc.top, plotW, rc.height);
  ctx.clip();
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const labelColor = cssVar("--lane-text", "rgba(20,20,20,0.9)");

  for (const f of built.frames) {
    if (f.end <= t0 || f.start >= t1) continue;
    if (f.depth >= maxRows) continue;
    const x0 = Math.max(timeScale.timeToX(f.start), gutterWidth);
    const x1 = timeScale.timeToX(f.end);
    const w = Math.max(1, x1 - x0);
    const y = rc.top + ROW_GAP + f.depth * (ROW_H + ROW_GAP);
    const name = built.nameOf(f.func);
    ctx.fillStyle = contextColor(name, 0.85);
    ctx.fillRect(x0, y, w, ROW_H);
    if (w >= LABEL_MIN_PX) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 2, y, w - 4, ROW_H);
      ctx.clip();
      ctx.fillStyle = labelColor;
      ctx.fillText(name, x0 + 3, y + ROW_H / 2 + 0.5);
      ctx.restore();
    }
  }
  ctx.restore();
}

/** Finds the frame at local coordinate `(x, y)` for hit testing and tooltips. */
function hitTest(x: number, y: number, rc: LaneRenderContext, built: FuncTraceBuilt): LaneTarget | null {
  if (x < rc.gutterWidth) return null;
  const depth = Math.floor((y - rc.top - ROW_GAP) / (ROW_H + ROW_GAP));
  if (depth < 0) return null;
  const f = frameAt(built.frames, rc.timeScale.xToTime(x), depth);
  if (!f) return null;
  return {
    kind: "span",
    key: built.nameOf(f.func),
    isr: false,
    eventIndex: f.eventIndex,
    start: f.start,
    end: f.end,
  };
}

/**
 * Function trace lane type definition. The build step extracts context frames from the model cache; draw renders depth-stacked rectangles; hitTest identifies the hovered frame; cursorReadout returns the active call stack at the cursor timestamp.
 */
export const funcTraceLaneType: LaneTypeDef<FuncTraceSource, FuncTraceBuilt> = {
  type: FUNCTRACE_LANE,
  displayName: "Function trace",
  defaultHeight: 96,
  describe(source) {
    return `Flame graph · ${source.key}`;
  },
  accentColor(source) {
    // Matches the context color used by the corresponding timespan lane.
    return contextColor(source.key);
  },
  sourceOptions(model) {
    return funcTraceContexts(funcTraceDataFor(model)).map((key) => ({
      source: { key } as FuncTraceSource,
      label: `Function Trace (${key})`,
    }));
  },
  build(model, source) {
    return {
      frames: funcTraceDataFor(model).framesByContext.get(source.key) ?? [],
      nameOf: makeNameOf(model),
    };
  },
  draw(rc, built) {
    draw(rc, built);
  },
  hitTest(x, y, rc, built) {
    return hitTest(x, y, rc, built);
  },
  cursorReadout(rc, built) {
    if (rc.cursorTime === null || !built.frames.length) return null;
    const stack = stackAtTime(built.frames, rc.cursorTime);
    if (!stack.length) return null;
    return stack.map((f, i) => `${"  ".repeat(i)}${built.nameOf(f.func)}`);
  },
};
