/**
 * Unit tests for the `timespan` lane type (`web/ui/panes/lanes/timespan-lane.ts`):
 * per-model reconstruction caching, per-source slice generation, gutter swatch tint,
 * source descriptions, Add-lane picker options, and LaneRegistry integration.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { EVTID } from "../../src/trace/events.js";
import { parseTraceFiles, type TraceEvent, type TraceModel } from "../../src/trace/index.js";
import { LaneRegistry, type LaneRenderContext, type LaneTarget } from "../../web/core/lanes/registry.js";
import { TimeScale } from "../../web/trace-ui-toolkit/time-scale.js";
import { TIMESPAN_LANE, type TimespanSource } from "../../web/core/lanes/types.js";
import { contextColor } from "../../web/core/theme.js";
import {
  inlineFuncTraceMode,
  timelineDataFor,
  timespanLaneType,
  type TimespanBuilt,
} from "../../web/ui/panes/lanes/timespan-lane.js";

function ev(over: Partial<TraceEvent>): TraceEvent {
  return {
    id: 0,
    coreId: 0,
    name: "svNop",
    ts: 0,
    tsDelta: 0,
    plen: 0,
    params: {},
    ctxName: "TaskA",
    inIrq: false,
    ...over,
  };
}
function model(events: TraceEvent[]): TraceModel {
  return { traces: [], events, gaps: [] };
}

const build = (m: TraceModel, s: TimespanSource): TimespanBuilt => timespanLaneType.build!(m, s);

describe("timelineDataFor (memoisation)", () => {
  it("reconstructs once per model and returns the cached instance", () => {
    const m = model([ev({ ctxName: "TaskA", ts: 0 }), ev({ ctxName: "TaskB", ts: 1 })]);
    assert.equal(timelineDataFor(m), timelineDataFor(m)); // same reference → not recomputed
  });

  it("a build slice is backed by the cached arrays (no per-lane rescan)", () => {
    const m = model([ev({ ctxName: "TaskA", ts: 0 }), ev({ ctxName: "TaskB", ts: 1 })]);
    const a = build(m, { kind: "context", key: "TaskA" });
    const b = build(m, { kind: "context", key: "TaskA" });
    assert.equal(a.intervals, b.intervals); // same array instance
  });
});

describe("build (unified track across an overflow gap)", () => {
  it("leaves nothing to draw or hit-test where the target dropped events", () => {
    const m = model([
      ev({ ctxName: "TaskA", ts: 0 }),
      ev({ ctxName: "TaskA", ts: 2 }),
      ev({ id: EVTID.OVERFLOW, name: "svOverflow", ts: 5, params: { drop_cnt: 1 }, ctxName: "None" }),
      ev({ ctxName: "TaskB", ts: 7 }),
      ev({ ctxName: "TaskB", ts: 10 }), // domain end
    ]);
    // The reconstruction keeps a "None" boundary interval on the track...
    assert.ok(timelineDataFor(m).unifiedByCore.get(0)!.some((iv) => iv.key === "None"));
    // ...but the lane's slice carries only runs, so the gap is neither painted nor a hover target.
    const built = build(m, { kind: "unified", coreId: 0 });
    assert.deepEqual(
      built.intervals.map((iv) => [iv.start, iv.end, iv.key]),
      [
        [0, 2, "TaskA"],
        [7, 10, "TaskB"],
      ],
    );
  });
});

describe("build (per-source slice)", () => {
  const m = model([
    ev({ coreId: 0, ctxName: "TaskA", ts: 0, id: 100 }), // API mark inside TaskA
    ev({ coreId: 0, ctxName: "IDLE0", ts: 2 }),
  ]);

  it("slices a context's run intervals and in-run marks", () => {
    const a = build(m, { kind: "context", key: "TaskA" });
    assert.deepEqual(a.intervals.map((r) => [r.start, r.end]), [[0, 2]]);
    assert.equal(a.marks.length, 1);
    assert.equal(a.marks[0]!.log, false); // id 100 → API call
  });

  it("slices a core's Unified track (every context that ran on it)", () => {
    const u = build(m, { kind: "unified", coreId: 0 });
    assert.deepEqual(u.intervals.map((r) => r.key), ["TaskA", "IDLE0"]);
  });

  it("returns empty arrays for an unknown context or core", () => {
    assert.deepEqual(build(m, { kind: "context", key: "Nope" }).intervals, []);
    assert.deepEqual(build(m, { kind: "unified", coreId: 9 }).marks, []);
  });
});

describe("describe / accentColor", () => {
  it("summarises the source for the config panel", () => {
    assert.equal(timespanLaneType.describe({ kind: "unified", coreId: 1 }, null), "Unified · core 1");
    assert.equal(timespanLaneType.describe({ kind: "context", key: "IP_Task" }, null), "IP_Task");
  });

  it("tints a context lane with its context hue and leaves Unified to the host", () => {
    assert.equal(timespanLaneType.accentColor!({ kind: "context", key: "IP_Task" }), contextColor("IP_Task"));
    assert.equal(timespanLaneType.accentColor!({ kind: "unified", coreId: 0 }), null);
  });
});

describe("sourceOptions (the Add-lane picker)", () => {
  const options = (m: TraceModel) => timespanLaneType.sourceOptions!(m);

  it("offers a single plain Unified track for a single-core trace", () => {
    const opts = options(model([ev({ coreId: 0, ctxName: "TaskA" }), ev({ coreId: 0, ctxName: "IDLE0" })]));
    const unified = opts.filter((o) => o.source.kind === "unified");
    assert.deepEqual(
      unified.map((o) => [o.label, o.source]),
      [["Unified", { kind: "unified", coreId: 0 }]],
    );
    // Plus a context option per context (None is excluded by deriveLanes).
    const contexts = opts.filter((o) => o.source.kind === "context").map((o) => o.label);
    assert.deepEqual([...contexts].sort(), ["IDLE0", "TaskA"]);
  });

  it("offers one core-labelled Unified track per core for a multi-core trace", () => {
    const opts = options(
      model([ev({ coreId: 0, ctxName: "TaskA" }), ev({ coreId: 1, ctxName: "TaskB" })]),
    );
    const unified = opts.filter((o) => o.source.kind === "unified");
    assert.deepEqual(unified.map((o) => o.label), ["Unified (core 0)", "Unified (core 1)"]);
  });
});

describe("registry integration", () => {
  it("registers under its type id with the right default height", () => {
    const reg = new LaneRegistry();
    reg.register(timespanLaneType);
    assert.equal(reg.get(TIMESPAN_LANE), timespanLaneType);
    assert.equal(reg.defaultHeight(TIMESPAN_LANE), 22);
  });
});

describe("inline function trace", () => {
  /** One instrumented call nested two deep inside `dsp`, plus a bare `httpd`. */
  const fn = (name: "function_enter" | "function_exit", ts: number, func: number): TraceEvent =>
    ev({ id: 512, name, ts, plen: 8, params: { func, call_site: func }, ctxName: "dsp" });
  const traced = (): TraceModel =>
    model([
      ev({ ctxName: "dsp", ts: 0 }),
      fn("function_enter", 1, 0x4008_0000),
      fn("function_enter", 2, 0x4008_0100),
      fn("function_exit", 3, 0x4008_0100),
      fn("function_exit", 4, 0x4008_0000),
      ev({ ctxName: "httpd", ts: 5 }),
    ]);
  const lane = (source: TimespanSource) => ({ kind: "lane" as const, id: "l", type: TIMESPAN_LANE, source });

  it("defaults an instrumented context to the in-bar preview and everything else to off", () => {
    const m = traced();
    assert.equal(inlineFuncTraceMode(m, { kind: "context", key: "dsp" }), "peek");
    assert.equal(inlineFuncTraceMode(m, { kind: "context", key: "httpd" }), "off");
    assert.equal(inlineFuncTraceMode(m, { kind: "unified", coreId: 0 }), "off");
    assert.equal(inlineFuncTraceMode(null, { kind: "context", key: "dsp" }), "off");
  });

  it("honours an explicit mode on the source", () => {
    const m = traced();
    assert.equal(inlineFuncTraceMode(m, { kind: "context", key: "dsp", funcTrace: "expanded" }), "expanded");
    assert.equal(inlineFuncTraceMode(m, { kind: "context", key: "dsp", funcTrace: "peek" }), "peek");
  });

  it("recovers from a persisted mode the trace cannot honour", () => {
    const m = traced();
    // Expanded for a context this trace never instrumented: a plain lane, no
    // disclosure — and no tall empty flame graph to escape from.
    assert.equal(inlineFuncTraceMode(m, { kind: "context", key: "httpd", funcTrace: "expanded" }), "off");
    // A stored "off" on an instrumented context still offers the preview, so the
    // disclosure stays reachable.
    assert.equal(inlineFuncTraceMode(m, { kind: "context", key: "dsp", funcTrace: "off" }), "peek");
  });

  it("slices the context's frames into the build, uninstrumented lanes get none", () => {
    const m = traced();
    assert.equal(build(m, { kind: "context", key: "dsp" }).frames.length, 2);
    assert.equal(build(m, { kind: "context", key: "dsp" }).funcTrace, "peek");
    assert.deepEqual(build(m, { kind: "context", key: "httpd" }).frames, []);
    assert.equal(build(m, { kind: "unified", coreId: 0 }).funcTrace, "off");
  });

  it("sizes an expanded lane by the trace's nesting depth, others by the plain row", () => {
    const reg = new LaneRegistry();
    reg.register(timespanLaneType);
    const m = traced();
    const peek = reg.defaultHeightForNode(lane({ kind: "context", key: "dsp" }), m);
    const expanded = reg.defaultHeightForNode(lane({ kind: "context", key: "dsp", funcTrace: "expanded" }), m);
    assert.equal(peek, 22);
    // The 14 px activity strip plus one 12+1 px row per nesting level (two here).
    assert.equal(expanded, 14 + 2 * 13 + 1);
    // Without a model there is no depth to size by, so the plain row wins.
    assert.equal(reg.defaultHeightForNode(lane({ kind: "context", key: "dsp", funcTrace: "expanded" }), null), 22);
    // Likewise for a context that recorded nothing to stack.
    assert.equal(reg.defaultHeightForNode(lane({ kind: "context", key: "httpd", funcTrace: "expanded" }), m), 22);
  });

  /**
   * A render context for the DOM-free half of the lane: `hitTest` never touches
   * the canvas, so a bare 2D context stand-in is enough to exercise the band
   * geometry. 100 px wide over 0…10 s, so 1 s is 10 px.
   */
  const rc = (height: number): LaneRenderContext => {
    const timeScale = new TimeScale({ domainStart: 0, domainEnd: 10, widthPx: 100 });
    timeScale.setWindow(0, 10);
    return {
      ctx: null as unknown as CanvasRenderingContext2D,
      top: 0,
      height,
      gutterWidth: 0,
      widthPx: 100,
      timeScale,
      hiddenClasses: new Set(),
      hiddenCores: new Set(),
      cursorTime: null,
    };
  };

  const hit = (built: TimespanBuilt, x: number, y: number, height = 41): LaneTarget | null =>
    timespanLaneType.hitTest!(x, y, rc(height), built, { kind: "context", key: "dsp" });

  /** The `[start, end]` of a hit that must be a span. */
  const span = (h: LaneTarget | null): [number, number] => {
    assert.equal(h?.kind, "span");
    assert.ok(h?.start !== undefined && h.end !== undefined, "a span target carries an extent");
    return [h.start, h.end];
  };

  it("hit-tests an expanded flame graph at the depth it drew each row", () => {
    const built = build(traced(), { kind: "context", key: "dsp", funcTrace: "expanded" });
    assert.equal(built.funcTrace, "expanded");
    // A 41 px band: the 14 px activity strip from y 27, the depth-0 row at
    // y 14…25 and the depth-1 row at y 1…12 above it. The call at 1…4 s is
    // depth 0, its callee at 2…3 s is depth 1; x = 25 px is t = 2.5 s, inside
    // both. Every scanline of a row resolves to that row, its edges included.
    assert.deepEqual(span(hit(built, 25, 20)), [1, 4]);
    assert.deepEqual(span(hit(built, 25, 25)), [1, 4]);
    assert.deepEqual(span(hit(built, 25, 14)), [1, 4]);
    assert.deepEqual(span(hit(built, 25, 12)), [2, 3]);
    assert.deepEqual(span(hit(built, 25, 1)), [2, 3]);
    // Above the rows that fit in the band there is nothing to hit.
    assert.equal(hit(built, 25, 0), null);
  });

  it("finds no frame where the flame graph is masked away", () => {
    // dsp runs 0…5 s, is preempted 5…8 s, runs again from 8 s; the depth-0 call
    // stays open across the gap, so its frame spans it — but nothing is drawn
    // there, and nothing may be hit there either.
    const m = model([
      ev({ ctxName: "dsp", ts: 0 }),
      fn("function_enter", 1, 0x4008_0000),
      ev({ ctxName: "httpd", ts: 5 }),
      ev({ ctxName: "dsp", ts: 8 }),
      fn("function_exit", 9, 0x4008_0000),
    ]);
    const built = build(m, { kind: "context", key: "dsp", funcTrace: "expanded" });
    assert.equal(built.frames.length, 1);
    assert.deepEqual(span(hit(built, 25, 20)), [1, 9]); // t = 2.5 s: running
    assert.equal(hit(built, 65, 20), null); // t = 6.5 s: preempted
  });

  it("names the expanded state in the config-panel summary", () => {
    assert.equal(timespanLaneType.describe({ kind: "context", key: "dsp" }, null), "dsp");
    assert.equal(
      timespanLaneType.describe({ kind: "context", key: "dsp", funcTrace: "expanded" }, null),
      "dsp · flame graph",
    );
  });
});

describe("dual-core demo capture", () => {
  const m = (): TraceModel =>
    parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/dualcore.svdat"))]);

  it("builds real intervals for the Unified track and a known context", () => {
    const model0 = m();
    const uni = build(model0, { kind: "unified", coreId: 0 });
    assert.ok(uni.intervals.length > 1);

    const tcpip = build(model0, { kind: "context", key: "tcpip" });
    assert.ok(tcpip.intervals.length > 0, "tcpip has runs");
    assert.ok(tcpip.marks.length > 0, "tcpip has in-run API/log marks");
  });

  it("enumerates one Unified track and a context per lane for the Add-lane picker", () => {
    const opts = timespanLaneType.sourceOptions!(m());
    const unified = opts.filter((o) => o.source.kind === "unified");
    assert.deepEqual(unified.map((o) => o.label), ["Unified (core 0)", "Unified (core 1)"]);
    const tcpip = opts.find((o) => o.source.kind === "context" && o.source.key === "tcpip");
    assert.ok(tcpip, "tcpip is offered as a context source");
  });
});

describe("multi-core P4 fixture", () => {
  const m = (): TraceModel =>
    parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/p4-mcore.svdat"))]);

  it("offers one Unified track per core in the Add-lane picker", () => {
    const unified = timespanLaneType.sourceOptions!(m()).filter((o) => o.source.kind === "unified");
    assert.deepEqual(unified.map((o) => o.label), ["Unified (core 0)", "Unified (core 1)"]);
  });
});
