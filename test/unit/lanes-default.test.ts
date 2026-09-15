/**
 * Unit tests for the default lane layout and streaming layout reconciliation
 * (`web/core/lanes/default-layout.ts`): per-core Unified tracks, auto-populating
 * System, Interrupts, Tasks and Idle groups, and idempotent reconciliation when new contexts stream in.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseTraceFiles, EVTID, type TraceEvent, type TraceModel } from "../../src/trace/index.js";
import {
  buildDefaultLayout,
  CPULOAD_GROUP_ID,
  DATA_GROUP_ID,
  IDLE_GROUP_ID,
  INTERRUPTS_GROUP_ID,
  reconcileAuto,
  SYSTEM_GROUP_ID,
  TASKS_GROUP_ID,
} from "../../web/core/lanes/default-layout.js";
import { removeNode } from "../../web/trace-ui-toolkit/lanes/controller.js";
import {
  CPULOAD_LANE,
  DATAPLOT_LANE,
  TIMESPAN_LANE,
  type DataPlotSource,
  type LaneGroup,
  type LaneLeaf,
  type TimespanSource,
} from "../../web/core/lanes/types.js";

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

/** A minimal model from a list of events (no per-core trace tables needed here). */
function model(events: TraceEvent[]): TraceModel {
  return { traces: [], events, gaps: [] };
}

/** A `svDataSample` event for series `dataId` (drives the data-plot lanes). */
function sample(dataId: number, value: number, ts: number): TraceEvent {
  return ev({ id: EVTID.DATA_SAMPLE, name: "svDataSample", ts, params: { data_id: dataId, value } });
}

const groupById = (layout: { roots: readonly unknown[] }, id: string): LaneGroup =>
  layout.roots.find((n): n is LaneGroup => (n as LaneGroup).id === id)!;
const tasksGroup = (layout: { roots: readonly unknown[] }): LaneGroup => groupById(layout, TASKS_GROUP_ID);
const interruptsGroup = (layout: { roots: readonly unknown[] }): LaneGroup => groupById(layout, INTERRUPTS_GROUP_ID);
const systemGroup = (layout: { roots: readonly unknown[] }): LaneGroup => groupById(layout, SYSTEM_GROUP_ID);
const idleGroup = (layout: { roots: readonly unknown[] }): LaneGroup => groupById(layout, IDLE_GROUP_ID);

describe("buildDefaultLayout", () => {
  it("lays out one Unified track over per-context lanes grouped by kind", () => {
    const layout = buildDefaultLayout(
      model([ev({ ctxName: "TaskA", ts: 0 }), ev({ ctxName: "IDLE0", ts: 1 })]),
    );

    // Single core → exactly one Unified (timespan) root, labelled plainly.
    const unified = layout.roots.filter((n): n is LaneLeaf => n.kind === "lane" && n.type === TIMESPAN_LANE);
    assert.equal(unified.length, 1);
    assert.equal(unified[0]!.label, "Unified");
    assert.deepEqual(unified[0]!.source, { kind: "unified", coreId: 0 } satisfies TimespanSource);

    // Each group holds a timespan lane per context of its own kind, auto-populated.
    const tasks = tasksGroup(layout);
    assert.equal(tasks.auto?.rule, "context-per-core");
    const keys = tasks.children.map((c) => (c as LaneLeaf).source as TimespanSource);
    assert.ok(keys.every((s) => s.kind === "context"));
    assert.deepEqual(tasks.children.map((c) => c.id), ["c:TaskA"]);
    assert.ok(tasks.children.every((c) => c.kind === "lane" && c.type === TIMESPAN_LANE));

    // Idle sits in its own group below the tasks.
    assert.deepEqual(idleGroup(layout).children.map((c) => c.id), ["c:IDLE0"]);
  });

  it("labels per-core Unified tracks when the trace has multiple cores", () => {
    const layout = buildDefaultLayout(
      model([
        ev({ coreId: 0, ctxName: "A0", ts: 0 }),
        ev({ coreId: 1, ctxName: "B1", ts: 1 }),
      ]),
    );
    const unified = layout.roots.filter((n): n is LaneLeaf => n.kind === "lane" && n.type === TIMESPAN_LANE);
    assert.deepEqual(unified.map((l) => l.label), ["Unified (core 0)", "Unified (core 1)"]);
    assert.deepEqual(unified.map((l) => l.id), ["u:0", "u:1"]);
  });

  it("splits contexts into System, Interrupts, Tasks and Idle groups", () => {
    const layout = buildDefaultLayout(
      model([
        ev({ ctxName: "IDLE0", ts: 0 }),
        ev({ ctxName: "TaskA", ts: 1 }),
        ev({ ctxName: "IRQ_timer", ts: 2, inIrq: true }),
        ev({ ctxName: "Scheduler0", ts: 3 }),
        // The OS's own interrupts group with the scheduler, not with the peripheral ISRs.
        ev({ ctxName: "SysTick", ts: 4, inIrq: true }),
        ev({ ctxName: "SYSTIMER_TARGET0", ts: 5, inIrq: true }),
        ev({ ctxName: "CPU_FROM_CPU_0", ts: 6, inIrq: true }),
      ]),
    );
    assert.equal(systemGroup(layout).label, "Sys");
    assert.equal(interruptsGroup(layout).label, "IRQ");
    assert.equal(tasksGroup(layout).label, "Task");
    assert.equal(idleGroup(layout).label, "Idle");

    assert.deepEqual(systemGroup(layout).children.map((c) => c.id).sort(), [
      "c:CPU_FROM_CPU_0",
      "c:SYSTIMER_TARGET0",
      "c:Scheduler0",
      "c:SysTick",
    ]);
    assert.deepEqual(interruptsGroup(layout).children.map((c) => c.id), ["c:IRQ_timer"]);
    assert.deepEqual(tasksGroup(layout).children.map((c) => c.id), ["c:TaskA"]);
    assert.deepEqual(idleGroup(layout).children.map((c) => c.id), ["c:IDLE0"]);

    // The groups appear in stacking order, with idle below the tasks it displaces.
    const order = layout.roots.map((n) => n.id);
    assert.ok(
      order.indexOf(SYSTEM_GROUP_ID) < order.indexOf(INTERRUPTS_GROUP_ID) &&
        order.indexOf(INTERRUPTS_GROUP_ID) < order.indexOf(TASKS_GROUP_ID) &&
        order.indexOf(TASKS_GROUP_ID) < order.indexOf(IDLE_GROUP_ID),
    );

    // Each group auto-populates only its own role.
    assert.deepEqual(systemGroup(layout).auto, { rule: "context-per-core", roles: ["system"] });
    assert.deepEqual(interruptsGroup(layout).auto, { rule: "context-per-core", roles: ["interrupt"] });
    assert.deepEqual(tasksGroup(layout).auto, { rule: "context-per-core", roles: ["task"] });
    assert.deepEqual(idleGroup(layout).auto, { rule: "context-per-core", roles: ["idle"] });
  });
});

describe("reconcileAuto", () => {
  const base = model([ev({ ctxName: "TaskA", ts: 0 }), ev({ ctxName: "IDLE0", ts: 1 })]);

  it("is a no-op (same reference) when every context already has a lane", () => {
    const layout = buildDefaultLayout(base);
    assert.equal(reconcileAuto(layout, base), layout);
  });

  it("appends a lane for a context that streams in later", () => {
    const layout = buildDefaultLayout(base);
    const grown = model([...base.events, ev({ ctxName: "TaskNew", ts: 2 })]);

    const next = reconcileAuto(layout, grown);
    assert.notEqual(next, layout); // changed → new object
    const ids = tasksGroup(next).children.map((c) => c.id);
    assert.ok(ids.includes("c:TaskNew"));
    // Existing lanes keep their order; the newcomer is appended.
    assert.equal(ids[ids.length - 1], "c:TaskNew");

    // Running it again with the same model changes nothing.
    assert.equal(reconcileAuto(next, grown), next);
  });

  it("re-adds a context the user removed (documented v1 add-only behavior)", () => {
    const layout = buildDefaultLayout(base);
    const pruned = removeNode(layout, "c:TaskA");
    assert.ok(!tasksGroup(pruned).children.some((c) => c.id === "c:TaskA"));

    const restored = reconcileAuto(pruned, base);
    assert.ok(tasksGroup(restored).children.some((c) => c.id === "c:TaskA"));
  });

  it("routes a newly-streamed context into the group matching its kind", () => {
    const layout = buildDefaultLayout(base); // TaskA + IDLE0 → Tasks; Interrupts empty
    assert.equal(interruptsGroup(layout).children.length, 0);

    const grown = model([
      ...base.events,
      ev({ ctxName: "IRQ_new", ts: 2, inIrq: true }),
      ev({ ctxName: "TaskNew", ts: 3 }),
    ]);
    const next = reconcileAuto(layout, grown);

    // The ISR joins Interrupts, the task joins Tasks.
    assert.ok(interruptsGroup(next).children.some((c) => c.id === "c:IRQ_new"));
    assert.ok(!tasksGroup(next).children.some((c) => c.id === "c:IRQ_new"));
    assert.ok(tasksGroup(next).children.some((c) => c.id === "c:TaskNew"));
  });
});

describe("CPU-load and Data lanes", () => {
  it("adds a CPU Load group with one per-core lane below the activity groups", () => {
    const layout = buildDefaultLayout(model([ev({ ctxName: "TaskA", ts: 0 }), ev({ ctxName: "IDLE0", ts: 1 })]));
    const cpu = groupById(layout, CPULOAD_GROUP_ID);
    assert.equal(cpu.label, "Load");
    // Single core → one lane, labelled plainly, sourced from that core.
    assert.deepEqual(cpu.children.map((c) => c.id), ["cpu:0"]);
    const lane = cpu.children[0] as LaneLeaf;
    assert.equal(lane.type, CPULOAD_LANE);
    assert.equal(lane.label, "CPU Load");
    assert.deepEqual(lane.source, { kind: "core", coreId: 0 });
    // It is ordered below the Interrupts and Tasks groups.
    const idx = layout.roots.findIndex((n) => n.id === CPULOAD_GROUP_ID);
    assert.ok(idx > layout.roots.findIndex((n) => n.id === TASKS_GROUP_ID));
  });

  it("gives a multi-core trace one CPU-load lane per core, core-labelled", () => {
    const layout = buildDefaultLayout(
      model([ev({ coreId: 0, ctxName: "A0", ts: 0 }), ev({ coreId: 1, ctxName: "B1", ts: 1 })]),
    );
    const cpu = groupById(layout, CPULOAD_GROUP_ID);
    assert.deepEqual(cpu.children.map((c) => c.id), ["cpu:0", "cpu:1"]);
    assert.deepEqual(cpu.children.map((c) => (c as LaneLeaf).label), ["CPU Load (core 0)", "CPU Load (core 1)"]);
    assert.deepEqual((cpu.children[1] as LaneLeaf).source, { kind: "core", coreId: 1 });
  });

  it("omits the Data group when the trace has no data samples", () => {
    const layout = buildDefaultLayout(model([ev({ ctxName: "TaskA", ts: 0 })]));
    assert.ok(!layout.roots.some((n) => n.id === DATA_GROUP_ID));
  });

  it("builds a Data group with one data-plot lane per series", () => {
    const layout = buildDefaultLayout(
      model([ev({ ctxName: "TaskA", ts: 0 }), sample(7, 100, 1), sample(8, 200, 2), sample(7, 101, 3)]),
    );
    const data = groupById(layout, DATA_GROUP_ID);
    assert.equal(data.auto?.rule, "series-per-lane");
    // One lane per distinct series, in first-sampled order; no duplicate for 7.
    assert.deepEqual(data.children.map((c) => c.id), ["d:7", "d:8"]);
    assert.ok(data.children.every((c) => c.kind === "lane" && c.type === DATAPLOT_LANE));
    assert.deepEqual((data.children[0] as LaneLeaf).source as DataPlotSource, { series: [7] });
  });
});

describe("reconcileAuto — data-plot series", () => {
  it("appends a data-plot lane when a new series streams in", () => {
    const base = model([ev({ ctxName: "TaskA", ts: 0 }), sample(7, 100, 1)]);
    const layout = buildDefaultLayout(base);
    const grown = model([...base.events, sample(8, 200, 2)]);

    const next = reconcileAuto(layout, grown);
    assert.notEqual(next, layout);
    assert.deepEqual(groupById(next, DATA_GROUP_ID).children.map((c) => c.id), ["d:7", "d:8"]);
    assert.equal(reconcileAuto(next, grown), next); // idempotent
  });

  it("grows a Data group at the root when the trace had none", () => {
    const base = model([ev({ ctxName: "TaskA", ts: 0 })]);
    const layout = buildDefaultLayout(base);
    assert.ok(!layout.roots.some((n) => n.id === DATA_GROUP_ID));

    const next = reconcileAuto(layout, model([...base.events, sample(5, 42, 1)]));
    assert.notEqual(next, layout);
    assert.deepEqual(groupById(next, DATA_GROUP_ID).children.map((c) => c.id), ["d:5"]);
  });

  it("is a no-op (same reference) when every series already has a lane", () => {
    const m = model([ev({ ctxName: "TaskA", ts: 0 }), sample(7, 100, 1)]);
    const layout = buildDefaultLayout(m);
    assert.equal(reconcileAuto(layout, m), layout);
  });
});

describe("committed fixtures", () => {
  const parse = (name: string): TraceModel =>
    parseTraceFiles([new Uint8Array(readFileSync(`test/fixtures/traces/${name}.svdat`))]);

  const unifiedCount = (m: TraceModel): number =>
    buildDefaultLayout(m).roots.filter((n) => n.kind === "lane" && n.type === TIMESPAN_LANE).length;

  const distinctCores = (m: TraceModel): number => new Set(m.events.map((e) => e.coreId)).size;

  it("gives the dual-core demo trace one Unified track per core", () => {
    const m = parse("dualcore");
    assert.equal(distinctCores(m), 2);
    assert.equal(unifiedCount(m), 2);
    // The Tasks group is populated from the real contexts.
    assert.ok(tasksGroup(buildDefaultLayout(m)).children.length > 0);
  });

  it("gives the multi-core P4 trace one Unified track per core", () => {
    const m = parse("p4-mcore");
    const cores = distinctCores(m);
    assert.ok(cores > 1, `expected a multi-core fixture, got ${cores}`);
    assert.equal(unifiedCount(m), cores);
  });
});
