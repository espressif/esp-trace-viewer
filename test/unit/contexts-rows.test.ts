/**
 * Unit tests for the Contexts data layer (`web/ui/panes/contexts-rows.ts`):
 * interval to run-time aggregation (count, frequency, last, min, max, total,
 * and run-time percentage), full-trace and visible-window ranges, context classification,
 * `svTaskInfo` and `svStackInfo` detail extraction, sorting, and cell formatters.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { EVTID } from "../../src/trace/events.js";
import { parseTraceFiles, type TraceEvent } from "../../src/trace/index.js";
import { groupThousands } from "../../web/core/format.js";
import {
  aggregateContexts,
  aggregateIntervals,
  classifyContextType,
  collectContextInfo,
  formatCores,
  formatFrequency,
  formatPercent,
  formatPriority,
  formatStackSize,
  sortStats,
  type ContextStats,
} from "../../web/ui/panes/contexts-rows.js";
import { reconstructTimeline, type RunInterval } from "../../web/ui/panes/timeline-rows.js";

/** A hand-built interval (key/coreId/isr default as in the timeline tests). */
function iv(start: number, end: number, over: Partial<RunInterval> = {}): RunInterval {
  return { start, end, key: "K", coreId: 0, isr: false, eventIndex: 0, ...over };
}

describe("aggregateIntervals", () => {
  const ints = [iv(0, 2), iv(3, 5), iv(5, 6)];

  it("counts runs and computes total/min/max/last over the full range", () => {
    const a = aggregateIntervals(ints, 0, 6);
    assert.deepEqual(a, { runCount: 3, total: 5, min: 1, max: 2, maxStart: 0, last: 1 });
  });

  it("clips runs straddling the window edges and drops those outside", () => {
    // [0,2]→[1,2]=1, [3,5]→[3,4]=1, [5,6] starts at/after t1 → excluded.
    const a = aggregateIntervals(ints, 1, 4);
    assert.deepEqual(a, { runCount: 2, total: 2, min: 1, max: 1, maxStart: 1, last: 1 });
  });

  it("returns zeros when the window misses every run", () => {
    assert.deepEqual(aggregateIntervals(ints, 10, 20), {
      runCount: 0,
      total: 0,
      min: 0,
      max: 0,
      maxStart: 0,
      last: 0,
    });
  });

  it("takes the most recent surviving run as `last`", () => {
    const a = aggregateIntervals([iv(0, 1), iv(2, 5)], 0, 10);
    assert.equal(a.last, 3); // duration of the last (ascending) interval
  });

  it("reports where the longest run starts, clipped to the range", () => {
    assert.equal(aggregateIntervals([iv(0, 1), iv(2, 5), iv(6, 7)], 0, 10).maxStart, 2);
    // A run that starts before the range is measured, and reported, from the range edge.
    assert.equal(aggregateIntervals([iv(-4, 5)], 0, 10).maxStart, 0);
    assert.equal(aggregateIntervals([], 0, 10).maxStart, 0);
  });
});

describe("aggregateContexts", () => {
  it("derives frequency and run-time percentages from the range span", () => {
    const byContext = new Map([["A", [iv(0, 2, { key: "A" }), iv(5, 7, { key: "A" })]]]);
    const labels = new Map([["A", "TaskA"]]);
    const [s] = aggregateContexts(byContext, labels, { t0: 0, t1: 10 });
    assert.equal(s!.label, "TaskA");
    assert.equal(s!.runCount, 2);
    assert.equal(s!.totalRunTime, 4);
    assert.equal(s!.frequency, 0.2); // 2 runs / 10 s
    assert.equal(s!.minRunTime, 2);
    assert.equal(s!.maxRunTime, 2);
    assert.equal(s!.avgRunTime, 2);
    assert.equal(s!.pctTotal, 40); // 4 s of run time in a 10 s range
  });

  it("reports every core a context's runs were recorded on, ascending", () => {
    const migrating = new Map([
      ["A", [iv(0, 1, { key: "A", coreId: 1 }), iv(2, 3, { key: "A", coreId: 0 })]],
    ]);
    assert.deepEqual(aggregateContexts(migrating, new Map(), { t0: 0, t1: 10 })[0]!.cores, [0, 1]);
  });

  it("falls back to the key as the label and an empty info object", () => {
    const [s] = aggregateContexts(new Map([["X", [iv(0, 1, { key: "X" })]]]), new Map(), {
      t0: 0,
      t1: 1,
    });
    assert.equal(s!.label, "X");
    assert.deepEqual(s!.info, {});
  });

  it("yields a zeroed row (no NaN) for a context absent from the range", () => {
    const [s] = aggregateContexts(new Map([["A", [iv(8, 9, { key: "A" })]]]), new Map(), {
      t0: 0,
      t1: 4,
    });
    assert.equal(s!.runCount, 0);
    assert.equal(s!.frequency, 0);
    assert.equal(s!.avgRunTime, 0);
    assert.equal(s!.pctTotal, 0);
  });
});

describe("classifyContextType", () => {
  it("classifies IDLE contexts as Idle", () => {
    assert.equal(classifyContextType("IDLE0", [iv(0, 1)]), "Idle");
  });
  it("classifies interrupt runs as ISR", () => {
    assert.equal(classifyContextType("SysTick", [iv(0, 1, { isr: true })]), "ISR");
    assert.equal(classifyContextType("IRQ_oncore0", []), "ISR");
  });
  it("classifies everything else as Task", () => {
    assert.equal(classifyContextType("IP_Task", [iv(0, 1)]), "Task");
  });
});

describe("sortStats", () => {
  const mk = (label: string, runCount: number): ContextStats => ({
    key: label,
    label,
    type: "Task",
    cores: [0],
    info: {},
    runCount,
    frequency: 0,
    lastRunTime: 0,
    minRunTime: 0,
    maxRunTime: 0,
    maxRunStart: 0,
    avgRunTime: 0,
    totalRunTime: 0,
    pctTotal: 0,
  });
  const rows = [mk("B", 5), mk("A", 30), mk("C", 1)];

  it("sorts numeric columns ascending and descending", () => {
    assert.deepEqual(sortStats(rows, "runCount", -1).map((r) => r.runCount), [30, 5, 1]);
    assert.deepEqual(sortStats(rows, "runCount", 1).map((r) => r.runCount), [1, 5, 30]);
  });

  it("sorts the label column lexically and does not mutate the input", () => {
    assert.deepEqual(sortStats(rows, "label", 1).map((r) => r.label), ["A", "B", "C"]);
    assert.deepEqual(rows.map((r) => r.label), ["B", "A", "C"]); // original order intact
  });
});

describe("formatters", () => {
  it("formats frequency with an SI suffix", () => {
    assert.equal(formatFrequency(0), "0 Hz");
    assert.equal(formatFrequency(135.6), "135.600 Hz");
    assert.equal(formatFrequency(1000), "1.000 kHz");
    assert.equal(formatFrequency(2_500_000), "2.500 MHz");
  });

  it("formats percentages with two decimals", () => {
    assert.equal(formatPercent(12.345), "12.35 %");
    assert.equal(formatPercent(0), "0.00 %");
  });

  it("formats priority and stack size, an em dash when the capture never said", () => {
    assert.equal(formatPriority({}), "\u2014");
    assert.equal(formatPriority({ priority: 152 }), "152");
    assert.equal(formatStackSize({}), "\u2014");
    assert.equal(formatStackSize({ stackSize: 1280 }), groupThousands(1280) + " B");
    // Captures report small negative sizes, which decode as values just under 2^32. Nobody has a
    // two-gigabyte task stack, so those read as "no answer" rather than as a number.
    assert.equal(formatStackSize({ stackSize: 0xffffe894 }), "\u2014");
    assert.equal(formatStackSize({ stackSize: 2 ** 31 - 1 }), groupThousands(2 ** 31 - 1) + " B");
  });

  it("formats the cores a context ran on, joined for a task that migrated", () => {
    assert.equal(formatCores([]), "\u2014");
    assert.equal(formatCores([1]), "1");
    assert.equal(formatCores([0, 1]), "0/1");
  });
});

describe("overflow gaps", () => {
  /** A minimal context-tagged event. */
  const ev = (over: Partial<TraceEvent>): TraceEvent => ({
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
  });

  it("excludes the lost interval from a context's run time", () => {
    const events = [
      ev({ ctxName: "TaskA", ts: 0 }),
      ev({ ctxName: "TaskA", ts: 2 }), // last event before the gap
      ev({ id: EVTID.OVERFLOW, name: "svOverflow", ts: 5, params: { drop_cnt: 3 }, ctxName: "None" }),
      ev({ ctxName: "TaskA", ts: 7 }), // TaskA again once tracing resumes
    ];
    const { byContext } = reconstructTimeline(events, 10);
    const stats = aggregateContexts(byContext, new Map(), { t0: 0, t1: 10 });
    assert.equal(stats.length, 1);
    const a = stats[0]!;
    assert.equal(a.key, "TaskA");
    assert.equal(a.runCount, 2); // [0, 2] and [7, 10]; not one run across the gap
    assert.equal(a.totalRunTime, 5); // not 10
    assert.equal(a.pctTotal, 50);
  });
});

describe("dual-core demo capture", () => {
  const load = () =>
    parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/dualcore.svdat"))]);

  it("aggregates real contexts with classification and parser detail", () => {
    const model = load();
    const ev = model.events;
    const domain = { t0: ev[0]!.ts, t1: ev[ev.length - 1]!.ts };
    const { byContext } = reconstructTimeline(ev, domain.t1);
    const info = collectContextInfo(model);
    const labels = new Map([...byContext.keys()].map((k) => [k, k]));
    const stats = aggregateContexts(byContext, labels, domain, info);

    const by = new Map(stats.map((s) => [s.key, s]));
    // Run counts reconstructed from fixture data. IDLE0 counts every
    // idle interval, including transitions via svIdle events. Scheduler0
    // captures scheduler execution between context switches.
    // (21076 before the processor back-filled each core's pre-context events from
    // its own core: a core's startup events used to be tagged with whichever core
    // established a context first, giving core 1 a spurious IDLE0 run.)
    assert.equal(by.get("IDLE0")!.runCount, 21075);
    assert.equal(by.get("SysTick")!.runCount, 9006);
    assert.equal(by.get("tcpip")!.runCount, 1188);
    assert.equal(by.get("Scheduler0")!.runCount, 9561);

    // Classification: idle / interrupt / task / scheduler.
    assert.equal(by.get("IDLE0")!.type, "Idle");
    assert.equal(by.get("SysTick")!.type, "ISR");
    assert.equal(by.get("tcpip")!.type, "Task");
    assert.equal(by.get("Scheduler0")!.type, "Scheduler");

    // svTaskInfo and svStackInfo detail extracted for the tcpip task.
    assert.deepEqual(by.get("tcpip")!.info, {
      handle: 4010265648,
      priority: 18,
      stackBase: 789036588,
      stackSize: 4294963932,
    });
    assert.deepEqual(by.get("IDLE0")!.info, {}); // idle has none

    // Total run time across contexts equals the span duration multiplied by core count.
    const cores = new Set(ev.map((e) => e.coreId)).size;
    const span = domain.t1 - domain.t0;
    const sumTotal = stats.reduce((n, s) => n + s.totalRunTime, 0);
    assert.ok(Math.abs(sumTotal - span * cores) < span * 1e-6, "totals sum to the span per core");
    // Frequency is runs per second over the range.
    const idle = by.get("IDLE0")!;
    assert.ok(Math.abs(idle.frequency - idle.runCount / span) < 1e-9);
  });

  it("the visible-window range narrows the stats vs the whole trace", () => {
    const model = load();
    const ev = model.events;
    const { byContext } = reconstructTimeline(ev, ev[ev.length - 1]!.ts);
    const labels = new Map([...byContext.keys()].map((k) => [k, k]));
    const whole = { t0: ev[0]!.ts, t1: ev[ev.length - 1]!.ts };
    const half = { t0: whole.t0, t1: whole.t0 + (whole.t1 - whole.t0) / 2 };

    const wholeRuns = aggregateContexts(byContext, labels, whole).reduce((n, s) => n + s.runCount, 0);
    const halfStats = aggregateContexts(byContext, labels, half);
    const halfRuns = halfStats.reduce((n, s) => n + s.runCount, 0);
    assert.ok(halfRuns > 0 && halfRuns < wholeRuns, "window has fewer runs than the whole trace");

    // No context can run longer than the window it is measured over.
    const winSpan = half.t1 - half.t0;
    for (const s of halfStats) assert.ok(s.totalRunTime <= winSpan + 1e-9);
  });
});
