/**
 * Timespan lane type rendering task, ISR, and scheduler activity as a {@link LaneTypeDef}.
 *
 * A lane's {@link TimespanSource} selects either an execution context's run intervals or a core's unified execution track. Event sequences are converted into run intervals and in-run marks once per model and cached by model identity in {@link timelineDataFor}. The lane slices this cached data during {@link TimespanLaneType.build} and uses {@link coalesceToPixels} to keep rendering cost proportional to canvas pixel width.
 *
 * Rendering draws into a variable-height band on the shared time axis ({@link LaneRenderContext}). Gutter controls are rendered by the host container, and lane colors are resolved via {@link TimespanLaneType.accentColor}.
 *
 * Execution contexts with compiler-instrumented calls also render inline function traces within the lane band.
 */

import type { TraceModel } from "../../../../src/trace/index.js";
import type { EventClass } from "../../../core/event-class.js";
import { deriveDomain, deriveLanes } from "../../../core/open-files.js";
import { contextBorderColor, contextColor } from "../../../core/theme.js";
import type { LaneRenderContext, LaneTarget, LaneTypeDef } from "../../../core/lanes/registry.js";
import { TIMESPAN_LANE, type FuncTraceInline, type TimespanSource } from "../../../core/lanes/types.js";
import { cssVar } from "../../canvas-util.js";
import { frameAt, stackAtTime, type FuncFrame } from "../functrace-rows.js";
import { funcTraceDataFor, funcTraceFrames } from "./functrace-lane.js";
import {
  coalesceToPixels,
  intervalAtTime,
  marksInRange,
  nearestMarkIndex,
  reconstructTimeline,
  visibleRange,
  type EventMark,
  type PixelBar,
  type ReadyInterval,
  type RunInterval,
  type TimelineData,
} from "../timeline-rows.js";

/** Vertical inset padding for bars within the band, shared with context-switch connector lines. */
export const BAR_PAD = 3;
/** Minimum bar width in CSS pixels required to render an outline border. */
const BORDER_MIN_BAR_PX = 3;
/** Base width and height of in-run mark notches in CSS pixels. */
const MARK_W = 6;
const MARK_H = 5;
/** Hit-test tolerance radius around mark triangles in CSS pixels. */
const MARK_HIT_TOL = 3;
/** Minimum horizontal spacing in CSS pixels between adjacent rendered mark notches. */
const MARK_MIN_GAP_PX = 3;
/** Maximum visible mark threshold above which mark rendering is skipped for performance. */
const MARK_LOD_MAX = 400;

// ── Inline function traces ───────────────────────────────────────────────────
// Execution contexts with compiler-instrumented calls render function call trees directly inside the lane. Two display modes are supported via TimespanSource.funcTrace:
// peek: The lane maintains its default height and paints coarse depth stripes inside run rectangles.
// expanded: The lane expands vertically, placing an activity strip along the bottom and a stacked call tree above it.
// Both modes stack calls upward from the bottom: outermost calls are at the bottom, with callees stacked above them.

/** Height in CSS pixels of the activity strip below an expanded call tree. */
export const STRIP_H = 14;
/** Row height in CSS pixels of an expanded call tree level. */
const FLAME_ROW_H = 12;
/** Vertical gap in CSS pixels between expanded call tree rows. */
const FLAME_ROW_GAP = 1;
/** Minimum frame width in CSS pixels required to render text labels in expanded call trees. */
const FLAME_LABEL_MIN_PX = 26;
/** Fraction of run bar height reserved for context color in peek mode. */
const PEEK_RESERVE = 0.4;
/** Maximum height in CSS pixels reserved for context color in peek mode. */
const PEEK_RESERVE_MAX = 6;
/** Maximum number of depth stripes rendered in peek mode. */
const PEEK_MAX_ROWS = 4;
/** Minimum height in CSS pixels for a peek mode depth stripe. */
const PEEK_MIN_ROW_H = 1.5;
/** Maximum rows allocated during automatic height calculation for expanded call trees. */
const FLAME_MAX_ROWS = 12;
/** Vertical pitch in CSS pixels of an expanded call tree row including gap. */
const FLAME_PITCH = FLAME_ROW_H + FLAME_ROW_GAP;

/** Built render data for {@link timespanLaneType}. */
export interface TimespanBuilt {
  /** Run intervals backing this lane. */
  readonly intervals: readonly RunInterval[];
  /** In-run API and log marks. */
  readonly marks: readonly EventMark[];
  /** Ready-to-run intervals for context lanes. */
  readonly ready: readonly ReadyInterval[];
  /** Function trace frames for this context. */
  readonly frames: readonly FuncFrame[];
  /** Render mode for inline function traces. */
  readonly funcTrace: FuncTraceInline;
  /** Resolves code addresses to ELF symbol names or hexadecimal strings. */
  readonly nameOf: (addr: number) => string;
}

/** Resolves effective inline function trace mode for `source` based on frame availability. */
function modeOf(source: TimespanSource, hasFrames: boolean): FuncTraceInline {
  if (source.kind !== "context" || !hasFrames) return "off";
  return source.funcTrace === "expanded" ? "expanded" : "peek";
}

/** Returns the effective inline function trace mode for `source` against `model`. */
export function inlineFuncTraceMode(model: TraceModel | null, source: TimespanSource): FuncTraceInline {
  if (!model || source.kind !== "context") return "off";
  return modeOf(source, funcTraceFrames(model, source.key).length > 0);
}

/** Returns height of the expanded call tree region in CSS pixels, or 0 when collapsed. */
function flameHeight(rc: LaneRenderContext, built: TimespanBuilt): number {
  return built.funcTrace === "expanded" ? Math.max(0, rc.height - STRIP_H) : 0;
}

/** Returns height of the activity strip region in CSS pixels. */
function stripHeight(rc: LaneRenderContext, built: TimespanBuilt): number {
  return built.funcTrace === "expanded" ? Math.min(rc.height, STRIP_H) : rc.height;
}

/** Returns top y-coordinate of the activity strip. */
function stripTop(rc: LaneRenderContext, built: TimespanBuilt): number {
  return rc.top + rc.height - stripHeight(rc, built);
}

/** Caches reconstructed timeline data keyed by model identity. */
const cache = new WeakMap<TraceModel, TimelineData>();

/** Returns shared {@link TimelineData} for `model`, reconstructing it on first access. */
export function timelineDataFor(model: TraceModel): TimelineData {
  let data = cache.get(model);
  if (!data) {
    const taskNames = new Map<number, string>();
    for (const t of model.traces) for (const [tid, name] of t.tasks) taskNames.set(tid, name);
    data = reconstructTimeline(model.events, deriveDomain(model).end, taskNames);
    cache.set(model, data);
  }
  return data;
}

/** Returns whether a run bar is hidden by the active class filter. */
function barHidden(isr: boolean, hidden: ReadonlySet<EventClass>): boolean {
  if (hidden.size === 0) return false;
  return hidden.has(isr ? "isr" : "task");
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

/** Slices intervals and marks requested by `source` from the shared reconstruction. */
function sliceFor(model: TraceModel, source: TimespanSource): TimespanBuilt {
  const data = timelineDataFor(model);
  if (source.kind === "unified") {
    // A unified track carries `"None"` intervals where the context is unknown, notably where the target dropped events; those are boundaries, not runs, so the lane neither paints nor hit-tests them.
    return {
      intervals: data.paintedByCore.get(source.coreId) ?? [],
      marks: data.marksByCore.get(source.coreId) ?? [],
      ready: [],
      frames: [],
      funcTrace: "off",
      nameOf: (a) => `0x${(a >>> 0).toString(16)}`,
    };
  }
  const frames = funcTraceFrames(model, source.key);
  return {
    intervals: data.byContext.get(source.key) ?? [],
    marks: data.marksByContext.get(source.key) ?? [],
    ready: data.readyByContext.get(source.key) ?? [],
    frames,
    funcTrace: modeOf(source, frames.length > 0),
    nameOf: makeNameOf(model),
  };
}

/**
 * Clips the canvas context to active execution intervals over `[top, top + height)`. Restricts open frame rendering to active execution intervals, excluding preemption gaps. The caller must save canvas state before invoking this helper.
 */
function clipToRuns(
  rc: LaneRenderContext,
  bars: readonly PixelBar[],
  hidden: ReadonlySet<EventClass>,
  top: number,
  height: number,
): void {
  const { ctx } = rc;
  ctx.beginPath();
  for (const b of bars) {
    if (barHidden(b.isr, hidden)) continue;
    const x0 = Math.round(b.x0);
    ctx.rect(x0, top, Math.max(1, Math.round(b.x1) - x0), height);
  }
  ctx.clip();
}

/**
 * Renders in-bar call depth stripes (`peek` mode) across run rectangles in the callee color.
 * Outermost calls are rendered at the bottom with callees stacked above.
 * Frames are coalesced to one stripe per pixel column to bound rendering cost by canvas width.
 */
function drawPeekFlame(
  rc: LaneRenderContext,
  built: TimespanBuilt,
  bars: readonly PixelBar[],
  by: number,
  bh: number,
): void {
  const { ctx, timeScale, gutterWidth, widthPx } = rc;
  const reserve = Math.min(PEEK_RESERVE_MAX, Math.round(bh * PEEK_RESERVE));
  const flameTop = by + reserve;
  const inner = bh - reserve;
  if (inner < PEEK_MIN_ROW_H) return;
  const maxDepth = built.frames.reduce((m, f) => Math.max(m, f.depth), 0);
  const rows = Math.max(1, Math.min(PEEK_MAX_ROWS, maxDepth + 1, Math.floor(inner / PEEK_MIN_ROW_H)));
  const rowH = inner / rows;
  const { t0, t1 } = timeScale;

  ctx.save();
  ctx.beginPath();
  ctx.rect(gutterWidth, by, widthPx - gutterWidth, bh);
  ctx.clip();
  clipToRuns(rc, bars, rc.hiddenClasses, by, bh);
  const lastRight: number[] = new Array(rows).fill(-Infinity);
  for (const f of built.frames) {
    if (f.depth >= rows) continue;
    if (f.end <= t0) continue;
    if (f.start >= t1) break;
    const x0 = Math.max(timeScale.timeToX(f.start), gutterWidth);
    const x1 = Math.min(timeScale.timeToX(f.end), widthPx);
    const w = Math.max(1, x1 - x0);
    if (x0 + w <= lastRight[f.depth]!) continue; // one stripe per column
    lastRight[f.depth] = x0 + w;
    ctx.fillStyle = contextColor(built.nameOf(f.func), 0.95);
    // Deeper frames stack upward with depth 0 at the bottom.
    const y = flameTop + (rows - 1 - f.depth) * rowH;
    ctx.fillRect(x0, y, w, Math.max(1, rowH - 0.5));
  }
  ctx.restore();
}

/** Returns the number of expanded call tree rows that fit in `height` pixels. */
function flameRows(height: number): number {
  return Math.floor(height / FLAME_PITCH);
}

/**
 * Calculates top y-coordinate of an expanded call tree row for `depth`. Depth 0 borders the activity strip and callees stack upward.
 */
function flameRowTop(bottom: number, depth: number): number {
  return bottom - (depth + 1) * FLAME_PITCH;
}

/**
 * Calculates the call tree depth at y-coordinate `y`, inverting {@link flameRowTop}.
 */
function flameDepthAt(bottom: number, y: number): number {
  return Math.floor((bottom - 1 - y) / FLAME_PITCH);
}

/**
 * Renders expanded call tree frames in the region above the activity strip with depth-stacked rectangles and text labels.
 */
function drawExpandedFlame(
  rc: LaneRenderContext,
  built: TimespanBuilt,
  bars: readonly PixelBar[],
  top: number,
  height: number,
): void {
  if (height <= 0 || !built.frames.length) return;
  const { ctx, timeScale, gutterWidth, widthPx } = rc;
  const { t0, t1 } = timeScale;
  const maxRows = flameRows(height);
  if (maxRows < 1) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(gutterWidth, top, widthPx - gutterWidth, height);
  ctx.clip();
  clipToRuns(rc, bars, rc.hiddenClasses, top, height);
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const labelColor = cssVar("--lane-text", "rgba(20,20,20,0.9)");

  for (const f of built.frames) {
    if (f.end <= t0) continue;
    if (f.start >= t1) break;
    if (f.depth >= maxRows) continue;
    const x0 = Math.max(timeScale.timeToX(f.start), gutterWidth);
    const x1 = timeScale.timeToX(f.end);
    const w = Math.max(1, x1 - x0);
    const y = flameRowTop(top + height, f.depth);
    const name = built.nameOf(f.func);
    ctx.fillStyle = contextColor(name, 0.85);
    ctx.fillRect(x0, y, w, FLAME_ROW_H);
    if (w >= FLAME_LABEL_MIN_PX) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 2, y, w - 4, FLAME_ROW_H);
      ctx.clip();
      ctx.fillStyle = labelColor;
      ctx.fillText(name, x0 + 3, y + FLAME_ROW_H / 2 + 0.5);
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * Renders ready intervals, execution bars, and in-run marks within the lane band.
 */
function draw(rc: LaneRenderContext, built: TimespanBuilt): void {
  if (!built.intervals.length && !built.ready.length) return;
  const { ctx, timeScale, gutterWidth, widthPx, hiddenClasses } = rc;
  const { t0, t1 } = timeScale;
  const by = stripTop(rc, built) + BAR_PAD;
  const bh = stripHeight(rc, built) - BAR_PAD * 2;
  if (bh <= 0) return;

  // Snap edges to whole pixels so adjacent bars and context-switch connector lines share border columns.
  const snap = (x: number): number => Math.round(x);

  // Render ready-to-run intervals before execution bars using uniform styling.
  if (built.ready.length && !hiddenClasses.has("task")) {
    ctx.save();
    ctx.fillStyle = cssVar("--tl-ready-fill", "rgba(205,210,232,0.6)");
    ctx.strokeStyle = cssVar("--tl-ready-border", "rgba(122,132,168,0.85)");
    ctx.lineWidth = 1;
    const { lo, hi } = visibleRange(built.ready, t0, t1);
    let lastRight = -Infinity;
    for (let i = lo; i < hi; i++) {
      const rv = built.ready[i]!;
      const x0 = snap(Math.max(timeScale.timeToX(rv.start), gutterWidth));
      const x1 = snap(Math.min(timeScale.timeToX(rv.end), widthPx));
      const w = Math.max(1, x1 - x0);
      if (x0 + w <= lastRight) continue; // sub-pixel LOD: one box per column
      lastRight = x0 + w;
      ctx.fillRect(x0, by, w, bh);
      if (w >= BORDER_MIN_BAR_PX) ctx.strokeRect(x0 + 0.5, by + 0.5, w, bh - 1);
    }
    ctx.restore();
  }

  const bars = coalesceToPixels(built.intervals, t0, t1, widthPx, gutterWidth, 1, rc.hiddenCores);
  ctx.lineWidth = 1;
  for (const b of bars) {
    if (barHidden(b.isr, hiddenClasses)) continue;
    ctx.fillStyle = contextColor(b.key, 0.92);
    const x0 = snap(b.x0);
    const w = Math.max(1, snap(b.x1) - x0);
    ctx.fillRect(x0, by, w, bh);
    // Draw outline border when bar width is at least BORDER_MIN_BAR_PX.
    if (w >= BORDER_MIN_BAR_PX) {
      ctx.strokeStyle = contextBorderColor(b.key, 0.9);
      ctx.strokeRect(x0 + 0.5, by + 0.5, w, bh - 1);
    }
  }

  // Render inline function trace in either peek or expanded mode.
  if (built.frames.length) {
    if (built.funcTrace === "peek") drawPeekFlame(rc, built, bars, by, bh);
    else if (built.funcTrace === "expanded") {
      drawExpandedFlame(rc, built, bars, rc.top, flameHeight(rc, built));
    }
  }

  // Render in-run API and log marks along the bottom of execution bars as triangular notches.
  if (built.marks.length) {
    const { lo, hi } = marksInRange(built.marks, t0, t1);
    if (hi - lo <= MARK_LOD_MAX) {
      const apiMark = cssVar("--tl-api-mark", "rgba(15,18,22,0.62)");
      const logMark = cssVar("--tl-log-mark", "#1769d6");
      const baseY = by + bh;
      const apexY = baseY - MARK_H;
      let lastX = -Infinity;
      for (let k = lo; k < hi; k++) {
        const m = built.marks[k]!;
        if (m.log ? hiddenClasses.has("message") : hiddenClasses.has("api")) continue;
        if (rc.hiddenCores.has(m.coreId)) continue;
        const x = timeScale.timeToX(m.t);
        if (x - lastX < MARK_MIN_GAP_PX) continue;
        lastX = x;
        ctx.fillStyle = m.log ? logMark : apiMark;
        ctx.beginPath();
        ctx.moveTo(x, apexY);
        ctx.lineTo(x - MARK_W / 2, baseY);
        ctx.lineTo(x + MARK_W / 2, baseY);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

/** Hit-tests in-run mark notches within the lane band. */
function markAt(rc: LaneRenderContext, built: TimespanBuilt, x: number, y: number): LaneTarget | null {
  if (!built.marks.length) return null;
  const baseY = stripTop(rc, built) + stripHeight(rc, built) - BAR_PAD;
  if (y < baseY - MARK_H - MARK_HIT_TOL || y > baseY + MARK_HIT_TOL) return null;
  const k = nearestMarkIndex(built.marks, rc.timeScale.xToTime(x));
  if (k < 0) return null;
  const m = built.marks[k]!;
  if (m.log ? rc.hiddenClasses.has("message") : rc.hiddenClasses.has("api")) return null;
  if (rc.hiddenCores.has(m.coreId)) return null;
  if (Math.abs(rc.timeScale.timeToX(m.t) - x) > MARK_W / 2 + MARK_HIT_TOL) return null;
  return { kind: "mark", eventIndex: m.eventIndex };
}

/** Identifies the visual element under local coordinate `(x, y)` for hit testing and tooltips. */
function hitTest(x: number, y: number, rc: LaneRenderContext, built: TimespanBuilt): LaneTarget | null {
  const t = rc.timeScale.xToTime(x);
  // Hit-test expanded call tree frames above the activity strip, masking out preemption gaps.
  const flameBottom = stripTop(rc, built);
  if (built.funcTrace === "expanded" && y < flameBottom && x >= rc.gutterWidth) {
    const depth = flameDepthAt(flameBottom, y);
    const run = intervalAtTime(built.intervals, t);
    const masked = !run || barHidden(run.isr, rc.hiddenClasses) || rc.hiddenCores.has(run.coreId);
    if (depth < 0 || depth >= flameRows(flameHeight(rc, built)) || masked) return null;
    const f = frameAt(built.frames, t, depth);
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
  const mark = markAt(rc, built, x, y);
  if (mark) return mark;
  const ivl = intervalAtTime(built.intervals, t);
  if (ivl && !rc.hiddenCores.has(ivl.coreId)) {
    return { kind: "span", key: ivl.key, isr: ivl.isr, eventIndex: ivl.eventIndex, start: ivl.start, end: ivl.end };
  }
  // Check for ready-to-run intervals when no execution bar is hit.
  if (!rc.hiddenClasses.has("task")) {
    const rv = intervalAtTime(built.ready, t);
    if (rv) {
      return {
        kind: "ready",
        key: rv.key,
        eventIndex: rv.eventIndex,
        start: rv.start,
        end: rv.end,
        title: `${rv.key} ready`,
      };
    }
  }
  return null;
}

/**
 * Timespan lane type definition. The build step slices context data from the model cache; draw renders ready boxes, run bars, marks, and function traces; hitTest resolves hover targets.
 */
export const timespanLaneType: LaneTypeDef<TimespanSource, TimespanBuilt> = {
  type: TIMESPAN_LANE,
  displayName: "Task / ISR activity",
  defaultHeight: 22,
  defaultHeightFor(source, model) {
    // Size expanded lanes according to call nesting depth while keeping default height for standard lanes.
    if (source.kind !== "context" || source.funcTrace !== "expanded") return null;
    const depth = funcTraceDataFor(model).maxDepthByContext.get(source.key);
    if (depth === undefined) return null; // Requested expansion without recorded calls.
    return STRIP_H + Math.min(FLAME_MAX_ROWS, depth + 1) * FLAME_PITCH + FLAME_ROW_GAP;
  },
  describe(source) {
    if (source.kind === "unified") return `Unified · core ${source.coreId}`;
    return source.funcTrace === "expanded" ? `${source.key} · flame graph` : source.key;
  },
  accentColor(source) {
    // Context lanes use deterministic context color; unified tracks use default gutter swatch.
    return source.kind === "context" ? contextColor(source.key) : null;
  },
  sourceOptions(model) {
    // Generate one unified track per core followed by context lanes ordered by priority.
    const cores = [...new Set(model.events.map((e) => e.coreId))].sort((a, b) => a - b);
    const multi = cores.length > 1;
    const unified = cores.map((coreId) => ({
      source: { kind: "unified", coreId } as TimespanSource,
      label: multi ? `Unified (core ${coreId})` : "Unified",
    }));
    const contexts = deriveLanes(model).map((l) => ({
      source: { kind: "context", key: l.key } as TimespanSource,
      label: l.label,
    }));
    return [...unified, ...contexts];
  },
  build(model, source) {
    return sliceFor(model, source);
  },
  draw(rc, built, _source) {
    draw(rc, built);
  },
  hitTest(x, y, rc, built, _source) {
    return hitTest(x, y, rc, built);
  },
  cursorReadout(rc, built) {
    // Expanded lanes return active call stack at the cursor timestamp.
    if (built.funcTrace !== "expanded" || rc.cursorTime === null || !built.frames.length) return null;
    const stack = stackAtTime(built.frames, rc.cursorTime);
    if (!stack.length) return null;
    return stack.map((f, i) => `${"  ".repeat(i)}${built.nameOf(f.func)}`);
  },
};
