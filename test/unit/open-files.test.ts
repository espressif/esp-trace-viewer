/**
 * Unit tests for store-facing trace loading (`web/core/open-files.ts`),
 * specifically initial timeline lane ordering in `deriveLanes`.
 * Verifies priority stacking (ISRs on top, tasks ordered by priority,
 * idle contexts at the bottom, and first-seen tie-breaking) and context
 * classification (`web/core/context-type.ts`).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { EVTID } from "../../src/trace/events.js";
import type { TraceEvent, TraceModel } from "../../src/trace/index.js";
import { parseTraceFiles } from "../../src/trace/index.js";
import { classifyContext, CONTEXT_TYPE_ORDER } from "../../web/core/context-type.js";
import { deriveLanes } from "../../web/core/open-files.js";

/** A minimal tagged event (only the fields `deriveLanes` reads). */
function ev(ctxName: string, over: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: 0,
    coreId: 0,
    name: "",
    ts: 0,
    tsDelta: 0,
    plen: 0,
    params: {},
    ctxName,
    inIrq: false,
    ...over,
  };
}

/** A `svTaskInfo` event announcing a task's priority. */
function taskInfo(tid: number, prio: number, ctxName: string): TraceEvent {
  return ev(ctxName, { id: EVTID.TASK_INFO, params: { tid, prio } });
}

/** Wrap events into a one-core model, with the given tid→name task table. */
function model(events: TraceEvent[], tasks: Map<number, string> = new Map()): TraceModel {
  return {
    traces: [{ coreId: 0, header: [], sysInfo: null, tasks, irqs: new Map(), tsOrigin: 0, elfSha256: null, events }],
    events,
    gaps: [],
  };
}

const keys = (m: TraceModel): string[] => deriveLanes(m).map((l) => l.key);

describe("classifyContext", () => {
  it("classifies IDLE* as Idle (case-insensitive)", () => {
    assert.equal(classifyContext("IDLE0", false), "Idle");
    assert.equal(classifyContext("idle1", false), "Idle");
  });
  it("classifies Scheduler* as Scheduler (case-insensitive)", () => {
    assert.equal(classifyContext("Scheduler0", false), "Scheduler");
    assert.equal(classifyContext("scheduler1", false), "Scheduler");
  });
  it("classifies a context that ran in an interrupt as ISR", () => {
    assert.equal(classifyContext("SysTick", true), "ISR");
  });
  it("classifies IRQ/ISR-shaped names as ISR even without an interrupt run", () => {
    assert.equal(classifyContext("IRQ_oncore0", false), "ISR");
    assert.equal(classifyContext("isr_handler", false), "ISR");
  });
  it("classifies everything else as a Task", () => {
    assert.equal(classifyContext("IP_Task", false), "Task");
  });
  it("ranks the types interrupts → scheduler → tasks → idle", () => {
    assert.ok(CONTEXT_TYPE_ORDER.ISR < CONTEXT_TYPE_ORDER.Scheduler);
    assert.ok(CONTEXT_TYPE_ORDER.Scheduler < CONTEXT_TYPE_ORDER.Task);
    assert.ok(CONTEXT_TYPE_ORDER.Task < CONTEXT_TYPE_ORDER.Idle);
  });
});

describe("deriveLanes", () => {
  it("skips the unknown 'None' context", () => {
    assert.deepEqual(keys(model([ev("None"), ev("None")])), []);
  });

  it("stacks ISRs on top, tasks in the middle, idle at the bottom", () => {
    const m = model([
      ev("IDLE0"),
      ev("TaskA"),
      ev("SysTick", { inIrq: true }),
    ]);
    assert.deepEqual(keys(m), ["SysTick", "TaskA", "IDLE0"]);
  });

  it("orders tasks by scheduling priority, highest first", () => {
    const tasks = new Map([
      [1, "Low"],
      [2, "High"],
      [3, "Mid"],
    ]);
    const m = model(
      [
        ev("Low"),
        ev("High"),
        ev("Mid"),
        taskInfo(1, 5, "Low"),
        taskInfo(2, 20, "High"),
        taskInfo(3, 10, "Mid"),
      ],
      tasks,
    );
    assert.deepEqual(keys(m), ["High", "Mid", "Low"]);
  });

  it("ranks a task with a known priority above one without", () => {
    const m = model([ev("NoPrio"), ev("HasPrio"), taskInfo(7, 3, "HasPrio")], new Map([[7, "HasPrio"]]));
    assert.deepEqual(keys(m), ["HasPrio", "NoPrio"]);
  });

  it("keeps first-seen order for contexts of equal rank", () => {
    // Two ISRs, neither with a priority — first-seen wins.
    const m = model([ev("B", { inIrq: true }), ev("A", { inIrq: true })]);
    assert.deepEqual(keys(m), ["B", "A"]);
  });

  it("treats a context as an ISR if it ran in an interrupt even once", () => {
    const m = model([ev("Maybe"), ev("Maybe", { inIrq: true }), ev("Plain")]);
    // "Maybe" ran in an IRQ at least once → ISR (top); "Plain" stays a Task.
    assert.deepEqual(keys(m), ["Maybe", "Plain"]);
  });

  it("marks every derived lane visible", () => {
    assert.ok(deriveLanes(model([ev("X")])).every((l) => l.visible));
  });
});

describe("deriveLanes on real fixtures", () => {
  const load = (...paths: string[]): TraceModel =>
    parseTraceFiles(paths.map((p) => new Uint8Array(readFileSync(p))));

  it("orders the dual-core demo trace ISRs → scheduler → tasks-by-priority → idle", () => {
    const m = load("test/fixtures/traces/dualcore.svdat");
    assert.deepEqual(keys(m), [
      // ISRs first, in first-seen order.
      "SYSTIMER_TARGET0",
      "CPU_FROM_CPU_0",
      "SYSTIMER_TARGET1",
      "CPU_FROM_CPU_1",
      "SysTick",
      "TIMERGRP0_T0",
      "SYSTIMER_TARGET2",
      "SBD",
      // Synthesized scheduler spans are ordered between ISRs and tasks.
      "Scheduler0",
      "Scheduler1",
      // Then tasks by descending scheduling priority.
      "ipc0", // prio 24
      "ipc1",
      "esp_timer", // prio 22
      "sys_evt", // prio 20
      "tcpip", // prio 18
      "emac_rx", // prio 15
      "control", // prio 12
      "sensor",
      "dsp", // prio 5
      "httpd",
      "trace_ctrl",
      "main", // prio 1
      // Both idle contexts placed at the bottom.
      "IDLE0",
      "IDLE1",
    ]);
  });

  it("places both idle contexts at the bottom of the multi-core P4 trace", () => {
    const lanes = keys(load("test/fixtures/traces/p4-mcore.svdat"));
    // Both per-core idle contexts are placed at the bottom.
    assert.deepEqual([...lanes.slice(-2)].sort(), ["IDLE0", "IDLE1"]);
    // Allocator tasks (priority 5) are ordered above main, and all are ordered above idle contexts.
    assert.deepEqual(
      lanes.filter((k) => ["alloc0", "alloc1", "alloc2", "main"].includes(k)),
      ["alloc0", "alloc1", "alloc2", "main"],
    );
  });
});
