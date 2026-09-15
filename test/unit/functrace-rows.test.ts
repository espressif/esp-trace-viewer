/**
 * Tests for function-trace flame-graph reconstruction:
 * per-context enter/exit pairing into depth-stacked frames, tolerance of
 * truncated captures, and default-layout reconciliation.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { TraceEvent, TraceModel } from "../../src/trace/index.js";
import {
  buildFuncTraceData,
  frameAt,
  funcTraceContexts,
  stackAtTime,
} from "../../web/ui/panes/functrace-rows.js";
import { buildDefaultLayout, reconcileAuto, FUNCTRACE_GROUP_ID } from "../../web/core/lanes/default-layout.js";
import { FUNCTRACE_LANE, isGroup, type FuncTraceSource } from "../../web/core/lanes/types.js";

/** A minimal decoded func-trace event. */
function ev(
  name: "function_enter" | "function_exit",
  ts: number,
  func: number,
  ctxName = "main",
  coreId = 0,
): TraceEvent {
  return {
    id: 512,
    coreId,
    name,
    ts,
    tsDelta: 0,
    plen: 8,
    params: { func, call_site: func + 0x100 },
    ctxName,
    inIrq: false,
  };
}

const A = 0x40080000;
const B = 0x40080100;
const C = 0x40080200;

describe("buildFuncTraceData", () => {
  it("pairs nested enters/exits into depth-stacked frames", () => {
    // Nested calls: A calling B, and B calling C twice.
    const data = buildFuncTraceData(
      [
        ev("function_enter", 1, A),
        ev("function_enter", 2, B),
        ev("function_enter", 3, C),
        ev("function_exit", 4, C),
        ev("function_enter", 5, C),
        ev("function_exit", 6, C),
        ev("function_exit", 7, B),
        ev("function_exit", 8, A),
      ],
      10,
    );
    const frames = data.framesByContext.get("main")!;
    assert.equal(frames.length, 4);
    assert.deepEqual(
      frames.map((f) => [f.func, f.depth, f.start, f.end]),
      [
        [A, 0, 1, 8],
        [B, 1, 2, 7],
        [C, 2, 3, 4],
        [C, 2, 5, 6],
      ],
    );
    assert.equal(data.maxDepthByContext.get("main"), 2);
    // eventIndex points at the frame's enter event.
    assert.equal(frames[0]!.eventIndex, 0);
    assert.equal(frames[3]!.eventIndex, 4);
  });

  it("isolates call stacks across contexts during preemption", () => {
    // taskA enters A, gets preempted; taskB runs B fully; taskA exits A.
    const data = buildFuncTraceData(
      [
        ev("function_enter", 1, A, "taskA"),
        ev("function_enter", 2, B, "taskB"),
        ev("function_exit", 3, B, "taskB"),
        ev("function_exit", 4, A, "taskA"),
      ],
      10,
    );
    assert.deepEqual(funcTraceContexts(data), ["taskA", "taskB"]);
    const a = data.framesByContext.get("taskA")!;
    const b = data.framesByContext.get("taskB")!;
    // B is depth 0 in its own task — not nested under taskA's open frame.
    assert.deepEqual(a.map((f) => [f.func, f.depth]), [[A, 0]]);
    assert.deepEqual(b.map((f) => [f.func, f.depth]), [[B, 0]]);
  });

  it("tracks a task across cores during SMP migration", () => {
    const data = buildFuncTraceData(
      [ev("function_enter", 1, A, "worker", 0), ev("function_exit", 2, A, "worker", 1)],
      10,
    );
    const frames = data.framesByContext.get("worker")!;
    assert.deepEqual(frames.map((f) => [f.func, f.start, f.end]), [[A, 1, 2]]);
  });

  it("drops an exit whose enter predates the capture", () => {
    const data = buildFuncTraceData([ev("function_exit", 1, A)], 10);
    assert.equal(data.framesByContext.size, 0);
  });

  it("closes open frames at the domain end when capture terminates mid-call", () => {
    const data = buildFuncTraceData(
      [ev("function_enter", 1, A), ev("function_enter", 2, B)],
      10,
    );
    const frames = data.framesByContext.get("main")!;
    assert.deepEqual(
      frames.map((f) => [f.func, f.depth, f.end]),
      [
        [A, 0, 10],
        [B, 1, 10],
      ],
    );
  });

  it("closes down to matching frame when intermediate enter events are missing", () => {
    // When B's exit event is missing, A exiting closes both frames.
    const data = buildFuncTraceData(
      [ev("function_enter", 1, A), ev("function_enter", 2, B), ev("function_exit", 5, A)],
      10,
    );
    const frames = data.framesByContext.get("main")!;
    assert.deepEqual(
      frames.map((f) => [f.func, f.depth, f.end]),
      [
        [A, 0, 5],
        [B, 1, 5],
      ],
    );
  });
});

describe("frameAt / stackAtTime", () => {
  const data = buildFuncTraceData(
    [
      ev("function_enter", 1, A),
      ev("function_enter", 2, B),
      ev("function_exit", 4, B),
      ev("function_exit", 5, A),
    ],
    10,
  );
  const frames = data.framesByContext.get("main")!;

  it("finds the frame covering a time at a depth", () => {
    assert.equal(frameAt(frames, 3, 0)!.func, A);
    assert.equal(frameAt(frames, 3, 1)!.func, B);
    assert.equal(frameAt(frames, 4.5, 1), null);
    assert.equal(frameAt(frames, 6, 0), null);
  });

  it("reports the open call stack outermost-first", () => {
    assert.deepEqual(stackAtTime(frames, 3).map((f) => f.func), [A, B]);
    assert.deepEqual(stackAtTime(frames, 4.5).map((f) => f.func), [A]);
    assert.deepEqual(stackAtTime(frames, 8), []);
  });
});

describe("default layout / reconcile with func-trace lanes", () => {
  /** A minimal model from a list of events (matching lanes-default.test.ts). */
  function modelWith(events: TraceEvent[]): TraceModel {
    return { traces: [], events, gaps: [] };
  }

  it("adds a Function Trace group with one lane per instrumented context", () => {
    const model = modelWith([
      ev("function_enter", 1, A, "taskA"),
      ev("function_exit", 2, A, "taskA"),
      ev("function_enter", 3, B, "taskB"),
      ev("function_exit", 4, B, "taskB"),
    ]);
    const layout = buildDefaultLayout(model);
    const group = layout.roots.find((n) => n.id === FUNCTRACE_GROUP_ID);
    assert.ok(group && isGroup(group));
    const keys = group.children.map((c) =>
      c.kind === "lane" ? (c.source as FuncTraceSource).key : null,
    );
    assert.deepEqual(keys, ["taskA", "taskB"]);
    assert.ok(group.children.every((c) => c.kind === "lane" && c.type === FUNCTRACE_LANE));
  });

  it("omits the group for a trace without func-trace events", () => {
    const layout = buildDefaultLayout(modelWith([]));
    assert.equal(layout.roots.find((n) => n.id === FUNCTRACE_GROUP_ID), undefined);
  });

  it("reconcileAuto grows the group as instrumented contexts stream in", () => {
    const before = modelWith([ev("function_enter", 1, A, "taskA")]);
    const layout = buildDefaultLayout(before);
    const after = modelWith([
      ev("function_enter", 1, A, "taskA"),
      ev("function_enter", 2, B, "taskB"),
    ]);
    const grown = reconcileAuto(layout, after);
    const group = grown.roots.find((n) => n.id === FUNCTRACE_GROUP_ID);
    assert.ok(group && isGroup(group));
    assert.deepEqual(
      group.children.map((c) => (c.kind === "lane" ? (c.source as FuncTraceSource).key : null)),
      ["taskA", "taskB"],
    );
    // Idempotent: nothing new → the same object back.
    assert.equal(reconcileAuto(grown, after), grown);
  });

  it("reconcileAuto grows a new group when the layout had none", () => {
    const layout = buildDefaultLayout(modelWith([]));
    const after = modelWith([ev("function_enter", 1, A, "taskA")]);
    const grown = reconcileAuto(layout, after);
    const group = grown.roots.find((n) => n.id === FUNCTRACE_GROUP_ID);
    assert.ok(group && isGroup(group));
    assert.equal(group.children.length, 1);
  });
});
