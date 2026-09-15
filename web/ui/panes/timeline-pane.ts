/**
 * Timeline pane displaying configurable canvas timeline lanes.
 *
 * This pane renders the {@link LaneLayout} stored in the state store: an ordered hierarchy of typed, resizable lanes and collapsible groups flattened into vertical {@link LaneBand}s by {@link ../../core/lanes/layout-engine}. For each band, the host queries {@link LaneRegistry} and dispatches `build`, `draw`, and `hitTest` operations to the registered lane type. When bands exceed pane height, the lane area scrolls vertically beneath a fixed time ruler.
 *
 * The pane can also render itself at a multiple of its on-screen resolution, for the image export — see {@link TimelinePaneHandle.snapshot}.
 *
 * The host manages common timeline infrastructure across lane types: the shared {@link TimeScale} coordinate space, the time ruler, background grid, cursor and reference delta annotations, left gutter chrome (color swatch, label, and resize grip), vertical scrollbar, hover tooltips, and click-to-select interaction (updating `cursorTime` and `selectedEventIndex`). Lane hierarchy editing (adding, removing, reordering, hiding, and regrouping) is handled in the Lanes configuration panel and gutter controls via pure {@link ../../core/lanes/controller} reducers.
 */

import type { TraceEvent, TraceModel } from "../../../src/trace/index.js";
import { formatDuration, formatTime, roundToResolution } from "../../core/format.js";
import { resetHeight, setHeight, setSource } from "../../trace-ui-toolkit/lanes/controller.js";
import { bandAtContentY, clampScrollTop, layoutBands, type LaneBand, type LaneMetrics } from "../../trace-ui-toolkit/lanes/layout-engine.js";
import { laneMetrics, type LaneRenderContext, type LaneTarget } from "../../core/lanes/registry.js";
import { hiddenLaneCount } from "../../core/lanes/selectors.js";
import { CPULOAD_LANE, TIMESPAN_LANE, type CpuLoadSource, type LaneLayout, type LaneLeaf, type TimespanSource } from "../../core/lanes/types.js";
import { snapToNearestTime } from "../../core/navigate.js";
import { measureReferences, type DeltaSpan } from "../../core/references.js";
import { focusedContext } from "../../core/selection.js";
import { contextColor } from "../../core/theme.js";
import { publishWindow } from "../../core/zoom.js";
import { beginFrame, cssVar, drawReferenceLines, drawTimeGrid } from "../canvas-util.js";
import { el } from "../../trace-ui-toolkit/ui/dom.js";
import { Pane } from "../../trace-ui-toolkit/ui/pane.js";
import { buildDataSampleRegistry, type DataSampleMeta } from "../../core/data-samples.js";
import { formatDetail } from "./events-rows.js";
import { gapRects, gapsAtX, hatchPattern, type GapRect, type GapSpan } from "./timeline-gaps.js";
import { marksInRange, visibleRange } from "./timeline-rows.js";
import { BAR_PAD, inlineFuncTraceMode, timelineDataFor } from "./lanes/timespan-lane.js";
import { funcTraceDataFor } from "./lanes/functrace-lane.js";
import { suppressedLanes } from "./lanes/suppression.js";
import { drawGlyph, GLYPH_H, GLYPH_W } from "./lanes/functrace-glyph.js";
import type { PaneContext, PaneHandle } from "./types.js";

/** The timeline pane's handle: a {@link PaneHandle} that can also render itself into an off-screen bitmap. */
export interface TimelinePaneHandle extends PaneHandle {
  /**
   * Draw the timeline into a detached canvas at `scale` times the resolution it is drawn at on screen, or
   * `null` when the pane is not laid out. The picture is the same one on screen — same window, same lanes,
   * same type sizes — with `scale` times as many pixels across it.
   */
  snapshot(scale: number): HTMLCanvasElement | null;
}

/** Top time-ruler band height, in CSS px. */
const RULER_H = 23;
/** Left lane-gutter width (labels + controls), in CSS px. */
const GUTTER_W = 190;
/** Width of the gutter's leading category column, in CSS px. */
const TYPE_COL_W = 36;
/** Width of the gutter's trailing core column, in CSS px. */
const CORE_COL_W = 22;
/** Height of the capture overview strip above the ruler, in CSS px. */
const OVERVIEW_H = 25;
/** Buckets the capture overview summarises the whole trace into. */
const OVERVIEW_BINS = 480;
/** Narrowest the overview's visible-window marker is drawn, in CSS px. */
const OVERVIEW_MARKER_MIN_W = 3;
/** Bottom-edge grip height for the lane resize handle, in CSS px. */
const RESIZE_GRIP = 4;
/** Vertical scrollbar track width, in CSS px. */
const SCROLLBAR_W = 6;
/** Pixels of pointer travel before a press becomes a drag (vs. a click). */
const DRAG_SLOP = 4;
/** Distance threshold in CSS pixels between pointer and cursor line to display cursor value readout. */
const CURSOR_READOUT_NEAR_PX = 24;
/** Distance threshold in CSS pixels within which a click snaps the cursor to an event timestamp. */
const CURSOR_SNAP_PX = 12;
/** Fallback lane height in CSS pixels, used before a density is known. */
const LANE_H = 20;
/** Maximum unified intervals per core before context-switch connectors are hidden. */
const SWITCH_LOD_MAX = 200;
/** Top offset of the first reference delta annotation band in CSS pixels, below the ruler. */
const DELTA_BAND_OFFSET = 9;
/** Vertical spacing between stacked delta annotation bands in CSS pixels. */
const DELTA_BAND_GAP = 14;

/** Returns the timespan source of a lane band, or `null` for other band types. */
function timespanSource(band: LaneBand): TimespanSource | null {
  const n = band.node;
  return n.kind === "lane" && n.type === TIMESPAN_LANE ? (n.source as TimespanSource) : null;
}

/** Width of the gutter's inline function-trace disclosure hit zone, in CSS px. */
const FT_TOGGLE_W = GLYPH_W + 8;

export function createTimelinePane(ctx: PaneContext): TimelinePaneHandle {
  // The workspace is the timeline; a pane header naming it again would only cost a row of pixels.
  const pane = new Pane({ id: "timeline", title: "Timeline", canvas: true, chrome: false, collapsible: false });
  const { store, timeScale, scheduler, registry } = ctx;
  const canvas = pane.canvas!;

  // Shared lane registry configured in the application shell.
  const baseMetrics = laneMetrics(
    registry,
    { groupHeaderHeight: 0, minLaneHeight: 14 },
    () => model,
  );
  // Activity lanes follow the Lanes panel's density setting. CPU load and data plots keep their own taller defaults, since a curve needs the vertical room a strip of run rectangles does not, and a lane that sizes itself from its content — an expanded flame graph — keeps the height it asks for.
  const metrics: LaneMetrics = {
    ...baseMetrics,
    defaultHeight: (node) =>
      registry.sourceHeightForNode(node, model) ??
      (node.type === TIMESPAN_LANE ? store.get().laneDensity : baseMetrics.defaultHeight(node)),
  };

  let events: TraceEvent[] = [];
  let model: TraceModel | null = null;
  // True when the capture has more than one core, which is what earns the gutter's core column.
  let multiCore = false;
  // Maps data_id to series metadata for decoding svDataSample tooltips. Rebuilt when model changes.
  let dataSamples: Map<number, DataSampleMeta> = new Map();
  // Ascending event timestamps cached for delta measurement.
  let eventTimes: number[] = [];
  /** Vertical scroll offset of the lane area, in content px (clamped on use). */
  let scrollTop = 0;
  let lastFrameMs = 0;
  /** Device pixel ratio the next draw runs at, or null to follow the screen's. Raised by {@link snapshot}. */
  let renderDpr: number | null = null;
  /** Id of the lane whose bottom-edge resize grip the pointer is hovering, or null. */
  let hoverGripId: string | null = null;

  const tooltip = el("div", { class: "tl-tooltip", "data-testid": "timeline-tooltip" });
  tooltip.style.display = "none";
  pane.body.append(tooltip);

  const layout = (): LaneLayout => store.get().laneLayout;

  /**
   * Returns function trace disclosure state for a lane band, or `null` if the context has no function trace data.
   */
  const funcTraceToggle = (band: LaneBand): { expanded: boolean } | null => {
    const src = band.kind === "lane" ? timespanSource(band) : null;
    if (!src) return null;
    const mode = inlineFuncTraceMode(model, src);
    return mode === "off" ? null : { expanded: mode === "expanded" };
  };

  /** Width the gutter's trailing core column takes, which is nothing on a single-core capture. */
  const coreWidth = (): number => (multiCore ? CORE_COL_W : 0);

  /** Left edge of the inline function-trace disclosure glyph, just inside the core column. */
  const funcTraceToggleX = (): number => GUTTER_W - coreWidth() - GLYPH_W - 4;

  /**
   * Returns true if coordinates `(x, y)` fall within a band's inline function-trace disclosure button.
   */
  const overFuncTraceToggle = (x: number, y: number, band: LaneBand, g: Geom): boolean =>
    x >= funcTraceToggleX() - 4 &&
    x < funcTraceToggleX() + FT_TOGGLE_W &&
    y - bandTop(band, g) < rowHeight() &&
    !!funcTraceToggle(band);

  // ---- geometry -------------------------------------------------------------

  interface Geom {
    cssWidth: number;
    cssHeight: number;
    viewportH: number;
    scrollTop: number;
    bands: readonly LaneBand[];
    contentHeight: number;
    /** Height of the fixed chrome above the lanes: the overview strip, when shown, plus the ruler. */
    chromeH: number;
  }

  /** Flatten the layout and resolve the (clamped) scroll for the current size. */
  const geometry = (cssWidth = canvas.clientWidth, cssHeight = canvas.clientHeight): Geom => {
    const { bands, contentHeight } = layoutBands(layout(), metrics, suppressedLanes(store.get()));
    const chromeH = overviewHeight() + RULER_H;
    const viewportH = Math.max(0, cssHeight - chromeH);
    scrollTop = clampScrollTop(scrollTop, contentHeight, viewportH);
    return { cssWidth, cssHeight, viewportH, scrollTop, bands, contentHeight, chromeH };
  };

  /** Height the overview strip occupies, or 0 when it is switched off. */
  const overviewHeight = (): number => (store.get().overview ? OVERVIEW_H : 0);

  /**
   * Height of one activity row at the current density.
   *
   * Chrome anchored to the top of a band — the label, the disclosure glyph — measures against this rather than the band's own height, so a lane grown taller than a row keeps its controls on the first row.
   */
  const rowHeight = (): number => store.get().laneDensity || LANE_H;

  /** Canvas-space top edge of a band (content top shifted by the ruler and scroll). */
  const bandTop = (band: LaneBand, g: Geom): number => g.chromeH + band.top - g.scrollTop;

  /** Whether a band is at least partly inside the lane viewport. */
  const onScreen = (band: LaneBand, g: Geom): boolean => {
    const top = bandTop(band, g);
    return top < g.cssHeight && top + band.height > g.chromeH;
  };

  /** Returns the lane band at canvas Y coordinate `y`, or `null` if outside the lane area. */
  const bandAtY = (y: number, g: Geom): LaneBand | null =>
    y < g.chromeH ? null : bandAtContentY(g.bands, y - g.chromeH + g.scrollTop);

  /**
   * Returns the lane band whose bottom resize grip contains `(x, y)`, or `null`. Grips are located along the gutter's bottom edge to avoid overlapping plot marks.
   */
  const gripAt = (x: number, y: number, g: Geom): LaneBand | null => {
    if (y < g.chromeH || x >= GUTTER_W) return null;
    const band = bandAtY(y, g);
    return band && band.kind === "lane" && y >= bandTop(band, g) + band.height - RESIZE_GRIP ? band : null;
  };

  /** Creates a {@link LaneRenderContext} for a band at canvas Y coordinate `top`. */
  const rcFor = (band: LaneBand, top: number, c2d: CanvasRenderingContext2D, widthPx: number): LaneRenderContext => ({
    ctx: c2d,
    top,
    height: band.height,
    gutterWidth: GUTTER_W,
    widthPx,
    timeScale,
    hiddenClasses: store.get().filters.classes,
    hiddenCores: store.get().filters.cores,
    cursorTime: store.get().cursorTime,
  });

  // ---- rendering ------------------------------------------------------------

  const drawable = {
    draw(): void {
      const t = performance.now();
      const frame = beginFrame(canvas, renderDpr ?? undefined);
      if (!frame) return;
      const { ctx: c2d, cssWidth, cssHeight } = frame;
      timeScale.setWidthPx(cssWidth);
      // Align time scale offset with the right edge of the gutter.
      timeScale.setOffsetPx(GUTTER_W);
      const g = geometry(cssWidth, cssHeight);
      const focused = focusedContext(store.get());

      const stripe = cssVar("--lane-stripe", "rgba(128,128,128,0.06)");
      const laneText = cssVar("--lane-text", "rgba(180,180,180,0.95)");
      const selected = cssVar("--selected", "rgba(47,111,237,0.16)");

      // Clip lane rendering below the fixed time ruler.
      c2d.save();
      c2d.beginPath();
      c2d.rect(0, g.chromeH, cssWidth, cssHeight - g.chromeH);
      c2d.clip();

      // Render alternating background stripes and selection highlights.
      let laneParity = 0;
      for (const band of g.bands) {
        if (!onScreen(band, g)) {
          if (band.kind === "lane") laneParity++;
          continue;
        }
        const top = bandTop(band, g);
        {
          const src = timespanSource(band);
          if (src?.kind === "context" && src.key === focused) {
            c2d.fillStyle = selected;
            c2d.fillRect(0, top, cssWidth, band.height);
          } else if (laneParity % 2 === 1) {
            c2d.fillStyle = stripe;
            c2d.fillRect(0, top, cssWidth, band.height);
          }
          laneParity++;
        }
      }

      // Background time grid aligned with ruler ticks.
      drawTimeGrid(frame, timeScale);

      // Dispatch lane content rendering to registered lane handlers.
      for (const band of g.bands) {
        if (band.node.kind !== "lane" || !onScreen(band, g) || !model) continue;
        const def = registry.get(band.node.type);
        if (!def?.draw || !def.build) continue;
        const source = band.node.source;
        const built = def.build(model, source);
        def.draw(rcFor(band, bandTop(band, g), c2d, cssWidth), built, source);
      }

      drawSwitchConnectors(c2d, g);

      drawGaps(c2d, g, frame.dpr);

      drawGutter(c2d, g, laneText, selected, focused);

      // Render resize highlight when hovering a lane's bottom grip.
      if (hoverGripId !== null) {
        const band = g.bands.find((b) => b.id === hoverGripId);
        if (band && onScreen(band, g)) {
          const edgeY = bandTop(band, g) + band.height;
          c2d.fillStyle = cssVar("--accent", "#2f6fed");
          c2d.fillRect(0, edgeY - 1, GUTTER_W, 2);
        }
      }
      c2d.restore(); // End lane-area clip.

      // Render vertical cursor line at selected cursor time.
      const cursor = store.get().cursorTime;
      if (cursor !== null && cursor >= timeScale.t0 && cursor <= timeScale.t1) {
        const x = Math.round(timeScale.timeToX(cursor)) + 0.5;
        c2d.save();
        c2d.strokeStyle = cssVar("--cursor-line", "rgba(255,80,80,0.9)");
        c2d.lineWidth = 1;
        c2d.beginPath();
        c2d.moveTo(x, g.chromeH);
        c2d.lineTo(x, cssHeight);
        c2d.stroke();
        c2d.restore();
      }

      // Render reference markers and on-canvas delta annotations.
      const refs = store.get().references;
      drawReferenceLines(frame, timeScale, refs, g.chromeH);
      drawReferenceDeltas(c2d, refs, cursor, g.chromeH);

      drawOverview(c2d, g);
      drawRuler(frame, g.chromeH - RULER_H);
      drawScrollbar(c2d, g);

      lastFrameMs = performance.now() - t;
    },
  };

  /** Vertical line segment representing a context-switch connector from `y0` to `y1` at horizontal position `x`. */
  interface SwitchSegment {
    x: number;
    y0: number;
    y1: number;
  }

  /**
   * Collects visible context-switch connector segments across lane bands. Consecutive execution intervals on each core connect the outgoing context's bar edge to the incoming context's bar edge. Connectors are omitted when contexts lack visible lanes, share a band, are filtered out by class, or exceed the level-of-detail threshold.
   */
  const collectSwitches = (g: Geom): SwitchSegment[] => {
    const out: SwitchSegment[] = [];
    if (!model) return out;
    const hidden = store.get().filters.classes;
    const bandFor = new Map<string, LaneBand>();
    for (const band of g.bands) {
      const src = timespanSource(band);
      if (src?.kind === "context" && !bandFor.has(src.key)) bandFor.set(src.key, band);
    }
    if (bandFor.size < 2) return out;

    /** Returns the Y coordinate of a band's top bar edge. */
    const barTop = (band: LaneBand): number => bandTop(band, g) + BAR_PAD;
    const barBottom = (band: LaneBand): number => bandTop(band, g) + band.height - BAR_PAD;

    for (const intervals of timelineDataFor(model).unifiedByCore.values()) {
      const { lo, hi } = visibleRange(intervals, timeScale.t0, timeScale.t1);
      if (hi - lo > SWITCH_LOD_MAX) continue;
      for (let i = Math.max(lo, 1); i <= hi && i < intervals.length; i++) {
        const a = intervals[i - 1]!;
        const b = intervals[i]!;
        const x = timeScale.timeToX(b.start);
        if (x < GUTTER_W || x > g.cssWidth) continue;
        if (hidden.has(a.isr ? "isr" : "task") || hidden.has(b.isr ? "isr" : "task")) continue;
        const bandA = bandFor.get(a.key);
        const bandB = bandFor.get(b.key);
        if (!bandA || !bandB || bandA.id === bandB.id) continue;
        const px = Math.round(x) + 0.5;
        if (bandTop(bandA, g) < bandTop(bandB, g)) {
          out.push({ x: px, y0: barBottom(bandA), y1: barTop(bandB) });
        } else {
          out.push({ x: px, y0: barBottom(bandB), y1: barTop(bandA) });
        }
      }
    }
    return out;
  };

  /** Draws visible context-switch connector segments. */
  const drawSwitchConnectors = (c2d: CanvasRenderingContext2D, g: Geom): void => {
    const segments = collectSwitches(g);
    if (!segments.length) return;
    c2d.save();
    c2d.strokeStyle = cssVar("--tl-switch-line", "rgba(60,68,82,0.55)");
    c2d.lineWidth = 1;
    c2d.beginPath();
    for (const seg of segments) {
      if (seg.y1 <= seg.y0) continue; // Bars touch or overlap.
      c2d.moveTo(seg.x, seg.y0);
      c2d.lineTo(seg.x, seg.y1);
    }
    c2d.stroke();
    c2d.restore();
  };

  /** The overflow gaps in the visible window as rectangles to paint, with the switched-off cores left out. */
  const visibleGapRects = (g: Geom): GapRect[] =>
    model
      ? gapRects(model.gaps, timeScale.t0, timeScale.t1, g.cssWidth, GUTTER_W, undefined, store.get().filters.cores)
      : [];

  /** The hatch tile last built, kept while the ratio and colour it was built for hold. */
  let hatch: { key: string; pattern: CanvasPattern | null } | null = null;

  /**
   * Paints the overflow gaps as hatched bands down the whole lane area, the way the SystemView desktop app marks
   * them: a faint fill, a diagonal hatch, and a hairline at either edge. Runs inside the lane-area clip.
   */
  const drawGaps = (c2d: CanvasRenderingContext2D, g: Geom, dpr: number): void => {
    const rects = visibleGapRects(g);
    if (!rects.length) return;
    const fill = cssVar("--tl-gap-fill", "rgba(192,57,43,0.09)");
    const hatchColor = cssVar("--tl-gap-hatch", "rgba(192,57,43,0.38)");
    const edge = cssVar("--tl-gap-edge", "rgba(192,57,43,0.7)");
    const key = `${dpr}|${hatchColor}`;
    if (hatch?.key !== key) hatch = { key, pattern: hatchPattern(c2d, dpr, hatchColor) };

    const top = g.chromeH;
    const h = g.cssHeight - g.chromeH;
    c2d.save();
    for (const r of rects) {
      const w = r.x1 - r.x0;
      c2d.fillStyle = fill;
      c2d.fillRect(r.x0, top, w, h);
      if (hatch.pattern) {
        c2d.fillStyle = hatch.pattern;
        c2d.fillRect(r.x0, top, w, h);
      }
    }
    c2d.strokeStyle = edge;
    c2d.lineWidth = 1;
    c2d.beginPath();
    for (const r of rects) {
      const xa = Math.round(r.x0) + 0.5;
      const xb = Math.max(xa, Math.round(r.x1) - 0.5);
      c2d.moveTo(xa, top);
      c2d.lineTo(xa, top + h);
      c2d.moveTo(xb, top);
      c2d.lineTo(xb, top + h);
    }
    c2d.stroke();
    c2d.restore();
  };

  /** The gaps under plot coordinates `(x, y)`, or none when the point is outside the lane area or over no gap. */
  const gapsAt = (x: number, y: number, g: Geom): GapSpan[] =>
    x < GUTTER_W || y < g.chromeH ? [] : gapsAtX(visibleGapRects(g), x);

  /** Shows the overflow readout for the gaps under the pointer: one heading per gap, with its loss and its length. */
  const showGapTooltip = (spans: readonly GapSpan[], x: number, y: number): void => {
    const rows: HTMLElement[] = [];
    // The target keeps one drop counter for every core, so gaps carrying the same count are one episode that each core reported; the loss is read out once, the extent once per core.
    const episodes = new Map<number, GapSpan[]>();
    for (const s of spans) {
      const group = episodes.get(s.gap.dropCount);
      if (group) group.push(s);
      else episodes.set(s.gap.dropCount, [s]);
    }
    for (const group of episodes.values()) {
      const cores = [...new Set(group.map((s) => s.gap.coreId))].sort((a, b) => a - b);
      const label = cores.length > 1 ? `cores ${cores.join(", ")}` : `core ${cores[0]}`;
      rows.push(el("div", { class: "tl-tt-head", text: `Overflow on ${label}` }));
      rows.push(el("div", { class: "tl-tt-detail", text: `${group[0]!.gap.lost} events lost` }));
      for (const { gap } of group) {
        const extent = `Δ ${formatDuration(gap.end - gap.start)}`;
        rows.push(el("div", { class: "tl-tt-delta", text: cores.length > 1 ? `${extent} on core ${gap.coreId}` : extent }));
      }
    }
    tooltip.replaceChildren(...rows);
    placeTooltip(x, y);
  };

  /**
   * Category code shown once at the top of each lane group: the group's own name, upper-cased and cut to
   * what the 36 px column holds. The label costs one column rather than a row of its own.
   *
   * The default groups are named to survive the cut — Sys, IRQ, Task, Idle, Load, Data, Func — so renaming
   * one in the Lanes panel changes what the gutter reads, and a longer name is truncated rather than
   * silently mapped to something else.
   */
  const CATEGORY_CODE_LEN = 4;

  /** Category code for a band that opens a group, or for a root-level core track. */
  const categoryCode = (band: LaneBand): string | null => {
    if (band.groupLabel !== undefined) return band.groupLabel.slice(0, CATEGORY_CODE_LEN).toUpperCase();
    // Unified per-core tracks sit at the root with no group above them.
    const src = timespanSource(band);
    return src?.kind === "unified" && band.top === 0 ? "CORE" : null;
  };

  /**
   * Cores a lane's context was seen running on, as a display string.
   *
   * A task that migrates reports every core it ran on, so `0/1` rather than a single home core. Lanes with no core of their own — data plots — report nothing, and on a single-core capture the column says nothing at all: every lane would read `0`.
   */
  const coreLabel = (band: LaneBand): string | null => {
    if (!multiCore) return null;
    const src = timespanSource(band);
    if (src?.kind === "unified") return String(src.coreId);
    if (src?.kind === "context" && model) {
      const cores = timelineDataFor(model).coresByContext.get(src.key);
      return cores?.length ? cores.join("/") : null;
    }
    if (band.node.kind === "lane" && band.node.type === CPULOAD_LANE) {
      const cpu = band.node.source as CpuLoadSource;
      return cpu.kind === "core" ? String(cpu.coreId) : null;
    }
    return null;
  };

  /** Renders gutter background, borders, category codes, labels, swatches, core IDs, and toggles. */
  const drawGutter = (
    c2d: CanvasRenderingContext2D,
    g: Geom,
    laneText: string,
    selected: string,
    focused: string | null,
  ): void => {
    c2d.fillStyle = cssVar("--header", "#2b3038");
    c2d.fillRect(0, g.chromeH, GUTTER_W, g.cssHeight - g.chromeH);
    c2d.strokeStyle = cssVar("--border", "rgba(128,128,128,0.4)");
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(GUTTER_W + 0.5, g.chromeH);
    c2d.lineTo(GUTTER_W + 0.5, g.cssHeight);
    c2d.stroke();

    c2d.textBaseline = "middle";
    for (const band of g.bands) {
      if (!onScreen(band, g)) continue;
      const top = bandTop(band, g);
      // Anchor label text near the top for lanes taller than a default row.
      const mid = top + Math.min(band.height / 2, rowHeight() / 2);

      const src = timespanSource(band);
      if (src?.kind === "context" && src.key === focused) {
        c2d.fillStyle = selected;
        c2d.fillRect(0, top, GUTTER_W, band.height);
      }

      // A group's name rides on its first lane, in the leading column.
      const code = categoryCode(band);
      if (code) {
        c2d.font = "9px ui-monospace, monospace";
        c2d.fillStyle = laneText;
        c2d.globalAlpha = 0.65;
        c2d.fillText(code, 6, mid + 0.5);
        c2d.globalAlpha = 1;
        // A rule across the gutter marks where one category gives way to the next.
        c2d.strokeStyle = cssVar("--border", "rgba(128,128,128,0.4)");
        c2d.beginPath();
        c2d.moveTo(0, top + 0.5);
        c2d.lineTo(GUTTER_W, top + 0.5);
        c2d.stroke();
      }

      c2d.font = "11px system-ui, sans-serif";
      // Render colored swatch for single-color lanes, or an outline swatch for aggregate/multi-series lanes.
      const def = band.node.kind === "lane" ? registry.get(band.node.type) : undefined;
      const accent = band.node.kind === "lane" ? (def?.accentColor?.(band.node.source) ?? null) : null;
      if (accent) {
        c2d.fillStyle = accent;
        c2d.fillRect(TYPE_COL_W, mid - 4, 8, 8);
      } else {
        c2d.strokeStyle = laneText;
        c2d.lineWidth = 1;
        c2d.strokeRect(TYPE_COL_W + 0.5, mid - 3.5, 7, 7);
      }

      // The core column is right-aligned, with the function-trace disclosure just inside it.
      const core = coreLabel(band);
      const ft = funcTraceToggle(band);
      const nameLeft = TYPE_COL_W + 14;
      const nameRight = GUTTER_W - coreWidth() - (ft ? GLYPH_W + 8 : 4);

      c2d.fillStyle = laneText;
      c2d.save();
      c2d.beginPath();
      c2d.rect(nameLeft, top, Math.max(0, nameRight - nameLeft), band.height);
      c2d.clip();
      c2d.fillText((band.node as LaneLeaf).label ?? (src?.kind === "context" ? src.key : "Unified"), nameLeft, mid + 0.5);
      c2d.restore();

      if (ft) drawFuncTraceToggle(c2d, funcTraceToggleX(), mid, ft.expanded);

      if (core !== null) {
        c2d.font = "9px ui-monospace, monospace";
        c2d.globalAlpha = 0.7;
        c2d.textAlign = "right";
        c2d.fillText(core, GUTTER_W - 6, mid + 0.5);
        c2d.textAlign = "left";
        c2d.globalAlpha = 1;
      }
    }
  };

  /**
   * Draws the function trace disclosure glyph, styled with the accent color when expanded.
   */
  const drawFuncTraceToggle = (
    c2d: CanvasRenderingContext2D,
    x: number,
    mid: number,
    expanded: boolean,
  ): void => {
    c2d.save();
    c2d.fillStyle = expanded
      ? cssVar("--accent", "#2f6fed")
      : cssVar("--lane-text", "rgba(180,180,180,0.55)");
    c2d.globalAlpha = expanded ? 1 : 0.6;
    drawGlyph(c2d, x, Math.round(mid - GLYPH_H / 2));
    c2d.restore();
  };

  /** Draws the vertical scrollbar thumb when content exceeds viewport height. */
  const drawScrollbar = (c2d: CanvasRenderingContext2D, g: Geom): void => {
    if (g.contentHeight <= g.viewportH || g.viewportH <= 0) return;
    const trackX = g.cssWidth - SCROLLBAR_W;
    const thumbH = Math.max(20, (g.viewportH / g.contentHeight) * g.viewportH);
    const thumbY = g.chromeH + (g.scrollTop / g.contentHeight) * g.viewportH;
    c2d.fillStyle = cssVar("--scrollbar-thumb", "rgba(128,128,128,0.45)");
    c2d.fillRect(trackX + 1, thumbY, SCROLLBAR_W - 2, thumbH);
  };

  /** Draws on-canvas delta measurement annotations between reference markers. */
  const drawReferenceDeltas = (
    c2d: CanvasRenderingContext2D,
    refs: ReadonlyArray<{ time: number }>,
    cursor: number | null,
    chromeH: number,
  ): void => {
    if (refs.length < 1) return;
    const m = measureReferences(refs as { id: number; time: number }[], cursor, eventTimes);
    if (!m.spans.length && !m.toCursor) return;

    const refColor = cssVar("--reference-line", "rgba(214,138,16,0.95)");
    const cursorColor = cssVar("--cursor-line", "rgba(230,70,70,0.9)");
    const bg = cssVar("--header", "#2b3038");

    c2d.save();
    c2d.font = "10px system-ui, sans-serif";
    c2d.textBaseline = "middle";
    const bandY = chromeH + DELTA_BAND_OFFSET;
    for (const span of m.spans) drawDeltaBar(c2d, span, bandY, refColor, bg);
    if (m.toCursor) drawDeltaBar(c2d, m.toCursor, bandY + DELTA_BAND_GAP, cursorColor, bg);
    c2d.restore();
  };

  /** Draws a delta measurement bar and centered label at band coordinate `y`. */
  const drawDeltaBar = (c2d: CanvasRenderingContext2D, span: DeltaSpan, y: number, color: string, bg: string): void => {
    const right = timeScale.widthPx;
    const xa = Math.min(Math.max(timeScale.timeToX(span.from), GUTTER_W), right);
    const xb = Math.min(Math.max(timeScale.timeToX(span.to), GUTTER_W), right);
    if (xb - xa < 2) return;

    c2d.strokeStyle = color;
    c2d.fillStyle = color;
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(xa, y);
    c2d.lineTo(xb, y);
    c2d.moveTo(xa + 0.5, y - 3);
    c2d.lineTo(xa + 0.5, y + 3);
    c2d.moveTo(xb - 0.5, y - 3);
    c2d.lineTo(xb - 0.5, y + 3);
    c2d.stroke();

    const label = `Δ ${formatDuration(span.dt)}`;
    const w = c2d.measureText(label).width;
    const cx = (xa + xb) / 2;
    c2d.fillStyle = bg;
    c2d.globalAlpha = 0.85;
    c2d.fillRect(cx - w / 2 - 3, y - 6, w + 6, 12);
    c2d.globalAlpha = 1;
    c2d.fillStyle = color;
    c2d.textAlign = "center";
    c2d.fillText(label, cx, y);
    c2d.textAlign = "left";
  };

  /**
   * Event density across the whole capture, one bucket per {@link OVERVIEW_BINS} slice of the domain.
   *
   * Rebuilt only when the model changes. One pass over the event stream at load is cheap next to the parse that produced it, and it lets the strip redraw during a pan without touching the events again.
   */
  let overviewBins: Float32Array | null = null;

  /** Recompute the capture overview's density buckets for the loaded model. */
  const rebuildOverview = (): void => {
    const { start, end } = store.get().domain;
    if (!events.length || !(end > start)) {
      overviewBins = null;
      return;
    }
    const bins = new Float32Array(OVERVIEW_BINS);
    const scale = OVERVIEW_BINS / (end - start);
    for (const e of events) {
      const i = Math.min(OVERVIEW_BINS - 1, Math.max(0, Math.floor((e.ts - start) * scale)));
      bins[i]! += 1;
    }
    // Normalise to the busiest bucket so the curve fills the strip whatever the capture rate.
    let peak = 0;
    for (const v of bins) if (v > peak) peak = v;
    if (peak > 0) for (let i = 0; i < bins.length; i++) bins[i]! /= peak;
    overviewBins = bins;
  };

  /**
   * Draws the capture overview: the whole trace as a density curve, with a marker showing where the visible window sits inside it.
   *
   * The marker keeps a minimum width because a short window inside a long capture is otherwise narrower than a pixel.
   */
  const drawOverview = (c2d: CanvasRenderingContext2D, g: Geom): void => {
    if (!store.get().overview) return;
    const { start, end } = store.get().domain;
    c2d.save();
    c2d.fillStyle = cssVar("--panel-2", "#20242a");
    c2d.fillRect(0, 0, g.cssWidth, OVERVIEW_H);
    c2d.strokeStyle = cssVar("--border", "rgba(128,128,128,0.4)");
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(0, OVERVIEW_H + 0.5);
    c2d.lineTo(g.cssWidth, OVERVIEW_H + 0.5);
    c2d.moveTo(GUTTER_W + 0.5, 0);
    c2d.lineTo(GUTTER_W + 0.5, OVERVIEW_H);
    c2d.stroke();

    const plotW = g.cssWidth - GUTTER_W;
    if (overviewBins && plotW > 0 && end > start) {
      c2d.strokeStyle = cssVar("--accent", "#5a8dff");
      c2d.globalAlpha = 0.75;
      c2d.beginPath();
      for (let i = 0; i < overviewBins.length; i++) {
        const x = GUTTER_W + (i / (overviewBins.length - 1)) * plotW;
        const y = OVERVIEW_H - 3 - overviewBins[i]! * (OVERVIEW_H - 7);
        if (i === 0) c2d.moveTo(x, y);
        else c2d.lineTo(x, y);
      }
      c2d.stroke();
      c2d.globalAlpha = 1;

      // Where the target dropped events, so a gap can be found from anywhere in the capture.
      if (model?.gaps.length) {
        c2d.fillStyle = cssVar("--tl-gap-edge", "rgba(192,57,43,0.7)");
        for (const r of gapRects(model.gaps, start, end, g.cssWidth, GUTTER_W, 1, store.get().filters.cores)) {
          c2d.fillRect(r.x0, 1, r.x1 - r.x0, OVERVIEW_H - 2);
        }
      }

      // Where the visible window sits in the capture.
      const span = end - start;
      const x0 = GUTTER_W + ((timeScale.t0 - start) / span) * plotW;
      const x1 = GUTTER_W + ((timeScale.t1 - start) / span) * plotW;
      const w = Math.max(OVERVIEW_MARKER_MIN_W, x1 - x0);
      c2d.fillStyle = cssVar("--accent", "#5a8dff");
      c2d.globalAlpha = 0.3;
      c2d.fillRect(x0, 0, w, OVERVIEW_H);
      c2d.globalAlpha = 1;
      c2d.strokeStyle = cssVar("--accent", "#5a8dff");
      c2d.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(OVERVIEW_MARKER_MIN_W, Math.round(w)), OVERVIEW_H - 1);
    }
    c2d.restore();
  };

  /**
   * Draws the fixed time ruler with adaptive tick intervals and time labels.
   *
   * `y0` is the ruler's top edge, which the capture overview pushes down when it is shown.
   */
  const drawRuler = (frame: { ctx: CanvasRenderingContext2D; cssWidth: number }, y0: number): void => {
    const c2d = frame.ctx;
    const bottom = y0 + RULER_H;
    c2d.save();
    c2d.fillStyle = cssVar("--header", "#2b3038");
    c2d.fillRect(0, y0, frame.cssWidth, RULER_H);
    c2d.strokeStyle = cssVar("--border", "rgba(128,128,128,0.4)");
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(0, bottom + 0.5);
    c2d.lineTo(frame.cssWidth, bottom + 0.5);
    c2d.stroke();

    const step = niceStep(timeScale.secondsPerPixel * 90);
    if (step > 0) {
      c2d.fillStyle = cssVar("--grid-text", "rgba(128,128,128,0.9)");
      c2d.strokeStyle = cssVar("--grid-line", "rgba(128,128,128,0.25)");
      c2d.font = "10px system-ui, sans-serif";
      c2d.textBaseline = "middle";
      const res = store.get().timeResolution;
      const first = Math.ceil(timeScale.t0 / step) * step;
      for (let tt = first, n = 0; tt <= timeScale.t1 && n < 1000; tt += step, n++) {
        const x = Math.round(timeScale.timeToX(tt)) + 0.5;
        c2d.beginPath();
        c2d.moveTo(x, bottom - 4);
        c2d.lineTo(x, bottom);
        c2d.stroke();
        c2d.fillText(rulerLabel(roundToResolution(tt, res), step), x + 3, y0 + RULER_H / 2);
      }
    }
    c2d.restore();
  };

  // ---- hit-testing & tooltip ------------------------------------------------

  /** Returns hit-test information for plot coordinates `(x, y)`, or `null` if none match. */
  const plotHit = (x: number, y: number): LaneTarget | null => {
    if (x < GUTTER_W || !model) return null;
    const g = geometry();
    const band = bandAtY(y, g);
    if (!band || band.node.kind !== "lane") return null;
    const def = registry.get(band.node.type);
    if (!def?.hitTest || !def.build) return null;
    const source = band.node.source;
    const built = def.build(model, source);
    const rc = rcFor(band, bandTop(band, g), canvas.getContext("2d")!, g.cssWidth);
    return def.hitTest(x, y, rc, built, source);
  };

  /**
   * Renders the readout for a hovered element. When a lane supplies a custom readout
   * via {@link LaneTarget.title} and {@link LaneTarget.lines}, the host renders it
   * directly; otherwise the heading is derived from the element's event. Spanned elements
   * include a duration readout.
   */
  const showTooltip = (hit: LaneTarget, x: number, y: number): void => {
    const rows: HTMLElement[] = [];
    const spanned = hit.start !== undefined && hit.end !== undefined;
    if (hit.title !== undefined) {
      rows.push(el("div", { class: "tl-tt-head", text: hit.title }));
      for (const line of hit.lines ?? []) rows.push(el("div", { class: "tl-tt-detail", text: line }));
    } else if (spanned) {
      // Heading shows the opening event ID and the context name.
      rows.push(
        el("div", { class: "tl-tt-head", text: `#${hit.eventIndex + 1} ${hit.key ?? ""}${hit.isr ? " (ISR)" : ""}` }),
      );
    } else {
      const e = events[hit.eventIndex];
      const detail = e ? formatDetail(e, dataSamples, model?.elf) : "";
      rows.push(el("div", { class: "tl-tt-head", text: `#${hit.eventIndex + 1} ${e?.name ?? ""}` }));
      if (detail) rows.push(el("div", { class: "tl-tt-detail", text: detail }));
      rows.push(el("div", { class: "tl-tt-delta", text: formatTime(e?.ts ?? 0, store.get().timeResolution) }));
    }
    if (spanned) {
      rows.push(el("div", { class: "tl-tt-delta", text: `Δ ${formatDuration(hit.end! - hit.start!)}` }));
    }
    tooltip.replaceChildren(...rows);
    placeTooltip(x, y);
  };

  /** Positions the tooltip relative to coordinates `(x, y)`, flipping horizontally if near the edge. */
  const placeTooltip = (x: number, y: number): void => {
    tooltip.style.display = "block";
    const bw = pane.body.clientWidth;
    const left = x + 14 + tooltip.offsetWidth > bw ? x - 14 - tooltip.offsetWidth : x + 14;
    tooltip.style.left = `${Math.max(0, left)}px`;
    tooltip.style.top = `${y + 14}px`;
  };

  /**
   * Returns per-series value readouts at the cursor position when hovering near the cursor line within a supported lane.
   */
  const cursorReadoutAt = (x: number, y: number): readonly string[] | null => {
    if (x < GUTTER_W || !model) return null;
    const cursor = store.get().cursorTime;
    if (cursor === null || cursor < timeScale.t0 || cursor > timeScale.t1) return null;
    if (Math.abs(x - timeScale.timeToX(cursor)) > CURSOR_READOUT_NEAR_PX) return null;
    const g = geometry();
    const band = bandAtY(y, g);
    if (!band || band.node.kind !== "lane") return null;
    const def = registry.get(band.node.type);
    if (!def?.cursorReadout || !def.build) return null;
    const source = band.node.source;
    const built = def.build(model, source);
    const rc = rcFor(band, bandTop(band, g), canvas.getContext("2d")!, g.cssWidth);
    return def.cursorReadout(rc, built, source);
  };

  const showCursorReadout = (lines: readonly string[], x: number, y: number): void => {
    const cursor = store.get().cursorTime ?? 0;
    tooltip.replaceChildren(
      el("div", { class: "tl-tt-head", text: formatTime(cursor, store.get().timeResolution) }),
      ...lines.map((line) => el("div", { class: "tl-tt-detail", text: line })),
    );
    placeTooltip(x, y);
  };

  const hideTooltip = (): void => {
    tooltip.style.display = "none";
  };

  /** Returns the event index associated with a hit result. */
  const hitEventIndex = (hit: LaneTarget): number => hit.eventIndex;

  /**
   * Returns candidate timestamps for cursor snapping at vertical coordinate `y`. Queries lane snap times if defined, falling back to all event timestamps.
   */
  const snapDomainAt = (y: number): readonly number[] => {
    if (model) {
      const band = bandAtY(y, geometry());
      if (band && band.node.kind === "lane") {
        const def = registry.get(band.node.type);
        if (def?.snapTimes && def.build) {
          const times = def.snapTimes(def.build(model, band.node.source), band.node.source);
          if (times) return times;
        }
      }
    }
    return eventTimes;
  };

  // ---- pointer interaction --------------------------------------------------

  const local = (e: MouseEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  interface Press {
    x: number;
    y: number;
    lastX: number;
    area: "plot" | "gutter" | "ruler" | "scrollbar" | "overview";
    mode: "idle" | "pan" | "resize" | "scroll";
    bandId: string | null;
    startScroll: number;
    startHeight: number;
    dragging: boolean;
  }
  let press: Press | null = null;

  const publishView = (): void => {
    publishWindow(store, timeScale);
    scheduler.requestDraw();
  };

  /** True when `(x, y)` is over the capture overview's density curve rather than its gutter stub. */
  const overOverview = (x: number, y: number): boolean =>
    store.get().overview && y < OVERVIEW_H && x >= GUTTER_W;

  /**
   * Move the visible window to the capture time under `x` in the overview strip, keeping its span.
   *
   * The window centres on the point pressed, so a click on the overview goes there at the zoom already in
   * use rather than changing it. `zoomToSpan` clamps at the ends of the capture.
   */
  const overviewSeek = (x: number, cssWidth: number): void => {
    const { start, end } = store.get().domain;
    const plotW = cssWidth - GUTTER_W;
    if (plotW <= 0 || end <= start) return;
    const frac = Math.min(1, Math.max(0, (x - GUTTER_W) / plotW));
    timeScale.zoomToSpan(timeScale.spanSeconds, start + frac * (end - start));
    publishView();
  };

  /**
   * Toggles a context lane between collapsed in-bar preview and expanded flame graph, resetting custom height.
   */
  const toggleInlineFuncTrace = (band: LaneBand): void => {
    const src = timespanSource(band);
    if (src?.kind !== "context") return;
    const next = inlineFuncTraceMode(model, src) === "expanded" ? "peek" : "expanded";
    store.set({
      laneLayout: resetHeight(setSource(layout(), band.id, { ...src, funcTrace: next }), band.id),
    });
  };

  canvas.addEventListener("pointerdown", (e) => {
    const { x, y } = local(e);
    const g = geometry();
    hideTooltip();

    let area: Press["area"] = "ruler";
    let mode: Press["mode"] = "idle";
    let bandId: string | null = null;
    let startHeight = 0;

    const grip = gripAt(x, y, g);
    if (x >= g.cssWidth - SCROLLBAR_W && y >= g.chromeH && g.contentHeight > g.viewportH) {
      area = "scrollbar";
      mode = "scroll";
    } else if (grip) {
      area = "gutter";
      mode = "resize";
      bandId = grip.id;
      startHeight = grip.height;
    } else if (x < GUTTER_W && y >= g.chromeH) {
      area = "gutter";
      bandId = bandAtY(y, g)?.id ?? null;
    } else if (y >= g.chromeH && x >= GUTTER_W) {
      area = "plot";
    } else if (overOverview(x, y)) {
      // Seek on press rather than on release, so a click lands immediately and a drag scrubs.
      area = "overview";
      overviewSeek(x, g.cssWidth);
    }

    press = { x, y, lastX: x, area, mode, bandId, startScroll: g.scrollTop, startHeight, dragging: false };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    const { x, y } = local(e);
    if (press) {
      if (!press.dragging && Math.abs(x - press.x) + Math.abs(y - press.y) > DRAG_SLOP) press.dragging = true;

      if (press.mode === "scroll") {
        const g = geometry();
        scrollTop = press.startScroll + (y - press.y) * (g.contentHeight / Math.max(1, g.viewportH));
        scheduler.requestDraw();
      } else if (press.mode === "resize" && press.bandId) {
        store.set({ laneLayout: setHeight(layout(), press.bandId, press.startHeight + (y - press.y), metrics) });
      } else if (press.area === "overview") {
        overviewSeek(x, geometry().cssWidth);
      } else if (press.dragging && (press.area === "plot" || press.area === "ruler")) {
        timeScale.panByPixels(press.lastX - x);
        publishView();
      }
      press.lastX = x;
      return;
    }
    // Update hover styling and cursor for the lane resize grip.
    const g = geometry();
    const grip = gripAt(x, y, g);
    const gripId = grip?.id ?? null;
    if (gripId !== hoverGripId) {
      hoverGripId = gripId;
      canvas.style.cursor = gripId ? "row-resize" : "";
      scheduler.requestDraw();
    }
    if (grip) {
      hideTooltip();
      return;
    }
    // Show pointer cursor over the overview strip and the inline function trace disclosure button.
    const gutterBand = x < GUTTER_W && y >= g.chromeH ? bandAtY(y, g) : null;
    const clickable = overOverview(x, y) || !!(gutterBand && overFuncTraceToggle(x, y, gutterBand, g));
    canvas.style.cursor = clickable ? "pointer" : "";
    if (overOverview(x, y)) {
      hideTooltip();
      return;
    }
    if (x < GUTTER_W && y >= g.chromeH) {
      hideTooltip();
      return;
    }
    const hit = plotHit(x, y);
    if (hit) {
      showTooltip(hit, x, y);
      return;
    }
    // Under an overflow gap the lanes are blank; the gap itself has a readout.
    const gaps = gapsAt(x, y, g);
    if (gaps.length) {
      showGapTooltip(gaps, x, y);
      return;
    }
    // Display value readout when hovering near the cursor line in a supported lane.
    const readout = cursorReadoutAt(x, y);
    if (readout) showCursorReadout(readout, x, y);
    else hideTooltip();
  });

  // Double-clicking a resize grip resets the lane height to its default value.
  canvas.addEventListener("dblclick", (e) => {
    const { x, y } = local(e);
    const grip = gripAt(x, y, geometry());
    if (grip) {
      e.preventDefault();
      store.set({ laneLayout: resetHeight(layout(), grip.id) });
    }
  });

  const endPress = (e: PointerEvent): void => {
    if (!press) return;
    const p = press;
    press = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (p.mode === "scroll" || p.mode === "resize" || p.area === "overview") return;

    const { x, y } = local(e);
    const g = geometry();

    if (p.area === "gutter") {
      const band = bandAtY(y, g);
      // Toggle inline function trace expansion when clicking the disclosure glyph.
      if (band && !p.dragging && overFuncTraceToggle(x, y, band, g)) {
        toggleInlineFuncTrace(band);
        return;
      }
      return;
    }

    if (!p.dragging && x >= GUTTER_W) {
      // Move cursor to click position, snapping to the nearest event or sample timestamp within the snap radius.
      const patch: { cursorTime: number; selectedEventIndex?: number; selectedContext?: null } = {
        cursorTime: snapToNearestTime(snapDomainAt(y), timeScale.xToTime(x), CURSOR_SNAP_PX * timeScale.secondsPerPixel),
      };
      const hit = plotHit(x, y);
      if (hit) {
        patch.selectedEventIndex = hitEventIndex(hit);
        patch.selectedContext = null;
      } else {
        // A click on an overflow gap selects its overflow packet, so the Events list scrolls to it. Where gaps on several cores overlap, the earliest packet wins.
        const gaps = gapsAt(x, y, g);
        if (gaps.length) {
          patch.selectedEventIndex = Math.min(...gaps.map((s) => s.gap.eventIndex));
          patch.selectedContext = null;
        }
      }
      store.set(patch);
    }
  };
  canvas.addEventListener("pointerup", endPress);
  canvas.addEventListener("pointercancel", endPress);
  canvas.addEventListener("pointerleave", () => {
    hideTooltip();
    if (hoverGripId !== null) {
      hoverGripId = null;
      canvas.style.cursor = "";
      scheduler.requestDraw();
    }
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      const g = geometry();
      // Shift-wheel or horizontal wheel scrolls lanes vertically; vertical wheel zooms the time window.
      if (e.shiftKey && g.contentHeight > g.viewportH) {
        e.preventDefault();
        scrollTop = g.scrollTop + (e.deltaY || e.deltaX);
        scheduler.requestDraw();
        return;
      }
      if (!events.length) return;
      e.preventDefault();
      const { x } = local(e);
      // Zoom factor scales with wheel delta magnitude. Trackpad gestures yield small smooth deltas, while discrete wheel notches apply standard steps.
      const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      timeScale.zoomAt(Math.max(GUTTER_W, x), Math.pow(2, Math.max(-300, Math.min(300, px)) / 480));
      publishView();
    },
    { passive: false },
  );

  // ---- wiring ---------------------------------------------------------------

  const rebuild = (): void => {
    const s = store.get();
    model = s.model;
    events = s.model?.events ?? [];
    dataSamples = buildDataSampleRegistry(events);
    eventTimes = events.map((ev) => ev.ts);
    multiCore = (s.model?.traces.length ?? 0) > 1;
    rebuildOverview();
  };

  /** Scrolls and centers the timeline window around the selected event timestamp if off-screen. */
  const revealSelected = (): void => {
    const i = store.get().selectedEventIndex;
    const e = i === null ? undefined : events[i];
    if (e && (e.ts < timeScale.t0 || e.ts > timeScale.t1)) {
      timeScale.zoomToSpan(timeScale.spanSeconds, e.ts);
      publishWindow(store, timeScale);
    }
    scheduler.requestDraw(drawable);
  };

  scheduler.add(drawable);
  pane.onResize(() => scheduler.requestDraw(drawable));
  store.select(["model", "domain"], () => {
    rebuild();
    scheduler.requestDraw(drawable);
  });
  store.select(["laneLayout", "groupsOff", "laneDensity", "overview"], () => scheduler.requestDraw(drawable));
  store.select(["selectedEventIndex"], revealSelected);
  store.select(["view", "cursorTime", "references", "selectedContext", "filters", "timeResolution"], () =>
    scheduler.requestDraw(drawable),
  );
  rebuild();

  // ---- test introspection ---------------------------------------------------
  // Introspection interface for tests. Exposes layout geometry, lane bands, hit-testing, and mark probes.
  const introspect = () => {
    const g = geometry();
    const laneBands = g.bands.filter((b) => b.kind === "lane");
    const contextBands = laneBands.filter((b) => timespanSource(b)?.kind === "context");
    const unifiedBands = laneBands.filter((b) => timespanSource(b)?.kind === "unified");
    const centerY = (b: LaneBand): number => bandTop(b, g) + b.height / 2;

    return {
      visibleWindow: { t0: timeScale.t0, t1: timeScale.t1 },
      widthPx: timeScale.widthPx,
      secondsPerPixel: timeScale.secondsPerPixel,
      timeAtX: (x: number) => timeScale.xToTime(x),
      rulerHeight: RULER_H,
      // Height of the capture overview strip along the top, or 0 when it is switched off.
      overviewHeight: overviewHeight(),
      // Canvas y of the first lane row: the ruler, plus the overview strip when it is shown.
      contentTop: g.chromeH,
      laneHeight: rowHeight(),
      gutterWidth: GUTTER_W,
      // Vertical layout: band geometry, scroll offset, and viewport metrics for headless test assertions.
      scrollTop: g.scrollTop,
      contentHeight: g.contentHeight,
      viewportHeight: g.viewportH,
      bands: g.bands.map((b) => ({
        id: b.id,
        kind: b.kind,
        type: b.node.kind === "lane" ? b.node.type : "group",
        depth: b.depth,
        top: b.top,
        height: b.height,
        centerY: centerY(b),
        label: b.node.kind === "group" ? b.node.label : ((b.node as LaneLeaf).label ?? ""),
        collapsed: b.node.kind === "group" ? !!b.node.collapsed : false,
        // The group a band opens, when the group's label rides on this lane rather than a header row.
        groupId: b.groupId ?? null,
        groupLabel: b.groupLabel ?? null,
        source: timespanSource(b),
      })),
      bandCenterY: (id: string): number | null => {
        const b = g.bands.find((bb) => bb.id === id);
        return b ? centerY(b) : null;
      },
      unifiedCount: unifiedBands.length,
      lanes: contextBands.map((b) => {
        const src = timespanSource(b)!;
        return { key: src.kind === "context" ? src.key : "", label: (b.node as LaneLeaf).label ?? "" };
      }),
      hiddenClasses: [...store.get().filters.classes],
      focusedContext: focusedContext(store.get()),
      laneAtY: (y: number): { index: number; key: string; label: string } | null => {
        const band = bandAtY(y, g);
        if (!band || band.kind !== "lane") return null;
        const src = timespanSource(band);
        if (src?.kind !== "context") return null;
        return { index: contextBands.indexOf(band), key: src.key, label: (band.node as LaneLeaf).label ?? "" };
      },
      hitTest: (x: number, y: number) => {
        const h = plotHit(x, y);
        if (!h) return null;
        const key = h.key ?? events[h.eventIndex]?.ctxName ?? "";
        return { kind: h.kind, key };
      },
      eventAt: (x: number, y: number) => {
        const h = plotHit(x, y);
        if (!h) return null;
        const index = hitEventIndex(h);
        const e = events[index];
        return { index, name: e?.name ?? "", key: h.key ?? e?.ctxName ?? "", kind: h.kind };
      },
      // Ready interval counts and connector segment counts for headless test assertions.
      readyCount: (key: string): number =>
        model ? (timelineDataFor(model).readyByContext.get(key)?.length ?? 0) : 0,
      switchConnectorCount: (): number => collectSwitches(g).filter((seg) => seg.y1 > seg.y0).length,
      // The overflow bands painted across the lanes, in CSS px, with the cores each one covers.
      gapRects: (): { x0: number; x1: number; cores: number[] }[] =>
        visibleGapRects(g).map((r) => ({ x0: r.x0, x1: r.x1, cores: r.cores })),
      // First visible mark notch for tooltip tests.
      markProbe: (): { x: number; y: number; index: number; name: string } | null => {
        if (!model) return null;
        const data = timelineDataFor(model);
        for (const b of laneBands) {
          if (!onScreen(b, g)) continue;
          const src = timespanSource(b);
          if (!src) continue;
          const marks = src.kind === "unified" ? data.marksByCore.get(src.coreId) : data.marksByContext.get(src.key);
          if (!marks?.length) continue;
          const { lo, hi } = marksInRange(marks, timeScale.t0, timeScale.t1);
          for (let k = lo; k < hi; k++) {
            const m = marks[k]!;
            const x = timeScale.timeToX(m.t);
            if (x < GUTTER_W) continue;
            const e = events[m.eventIndex];
            return { x, y: bandTop(b, g) + b.height - 4, index: m.eventIndex, name: e?.name ?? "" };
          }
        }
        return null;
      },
      markCount: (key: string): number =>
        model ? (timelineDataFor(model).marksByContext.get(key)?.length ?? 0) : 0,
      // Cursor snap parameters and sample timestamps for click tests.
      cursorSnapPx: CURSOR_SNAP_PX,
      eventTimeAt: (index: number): number | null => eventTimes[index] ?? null,
      snapTimesAt: (y: number): number[] => [...snapDomainAt(y)],
      // Function trace depth, frame count, and disclosure state for a context.
      funcTraceProbe: (key: string) => {
        if (!model) return null;
        const data = funcTraceDataFor(model);
        const frames = data.framesByContext.get(key);
        if (!frames?.length) return null;
        const band = g.bands.find((b) => {
          const s = timespanSource(b);
          return s?.kind === "context" && s.key === key;
        });
        const src = band ? timespanSource(band) : null;
        return {
          count: frames.length,
          maxDepth: data.maxDepthByContext.get(key) ?? 0,
          mode: src ? inlineFuncTraceMode(model, src) : "off",
          bandId: band?.id ?? null,
          bandHeight: band?.height ?? 0,
        };
      },
      hiddenLaneCount: hiddenLaneCount(layout()),
      // Canvas x of the inline function-trace disclosure glyph.
      funcTraceToggleX: funcTraceToggleX(),
      references: () => measureReferences(store.get().references, store.get().cursorTime, eventTimes),
      lastFrameMs: () => lastFrameMs,
    };
  };

  /**
   * Render into a detached canvas at `scale` times the on-screen resolution.
   *
   * The live canvas is the only thing the renderer knows how to draw into, so it is enlarged, redrawn,
   * copied off and put back inside one synchronous block — the browser never paints an intermediate state.
   * Enlarging the backing store alone would widen the frame in CSS terms and redistribute the layout, so
   * the ratio passed to {@link beginFrame} is raised by the same factor, leaving the CSS size untouched.
   */
  const snapshot = (scale: number): HTMLCanvasElement | null => {
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return null;
    const width = canvas.width;
    const height = canvas.height;
    const out = document.createElement("canvas");
    out.width = Math.round(width * scale);
    out.height = Math.round(height * scale);
    const outCtx = out.getContext("2d");
    if (!outCtx) return null;
    // The ratio the live canvas is already drawn at, which the export multiplies rather than replaces.
    const dpr = width / canvas.clientWidth;
    canvas.width = out.width;
    canvas.height = out.height;
    renderDpr = dpr * scale;
    try {
      drawable.draw();
      outCtx.drawImage(canvas, 0, 0);
    } finally {
      renderDpr = null;
      canvas.width = width;
      canvas.height = height;
      drawable.draw();
    }
    return out;
  };

  return { pane, drawable, introspect, snapshot };
}

/** Rounds a raw step up to a 1, 2, or 5 x 10^n value. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * pow;
}

const RULER_UNITS: [number, string][] = [
  [1, "s"],
  [1e-3, "ms"],
  [1e-6, "µs"],
  [1e-9, "ns"],
];

/** Formats an absolute timestamp such that adjacent ruler ticks remain distinct. */
function rulerLabel(t: number, step: number): string {
  const mag = Math.max(Math.abs(t), step);
  const [scale, suffix] = RULER_UNITS.find(([s]) => mag >= s * (1 - 1e-9)) ?? [1e-9, "ns"];
  const decimals = Math.min(9, Math.max(3, Math.ceil(Math.log10(scale / step))));
  return `${(t / scale).toFixed(decimals)} ${suffix}`;
}
