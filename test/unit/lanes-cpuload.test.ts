/**
 * Unit tests for the `cpuload` lane type (`web/ui/panes/lanes/cpuload-lane.ts`):
 * per-model mip-chain caching, per-bin aggregation across cores, idle-excluding
 * stack generation, source descriptions, lane picker options, and LaneRegistry integration.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseTraceFiles, type TraceEvent, type TraceModel } from "../../src/trace/index.js";
import { LaneRegistry } from "../../web/core/lanes/registry.js";
import { CPULOAD_LANE, type CpuLoadSource } from "../../web/core/lanes/types.js";
import {
  aggregateBins,
  cpuLoadDataFor,
  cpuLoadLaneType,
  stackedContexts,
} from "../../web/ui/panes/lanes/cpuload-lane.js";

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

describe("cpuLoadDataFor (memoisation)", () => {
  it("builds the mip-chain once per model and returns the cached instance", () => {
    const m = model([ev({ ctxName: "TaskA", ts: 0 }), ev({ ctxName: "IDLE0", ts: 1 })]);
    assert.equal(cpuLoadDataFor(m), cpuLoadDataFor(m));
  });

  it("build returns the same cached data regardless of source (cores chosen at draw)", () => {
    const m = model([ev({ ctxName: "TaskA", ts: 0 }), ev({ ctxName: "IDLE0", ts: 1 })]);
    const a = cpuLoadLaneType.build!(m, { kind: "total" });
    const b = cpuLoadLaneType.build!(m, { kind: "core", coreId: 0 });
    assert.equal(a, b);
    assert.equal(a, cpuLoadDataFor(m));
  });
});

describe("stackedContexts (idle is never stacked)", () => {
  it("keeps every context in mip order but excludes idle ones", () => {
    const data = cpuLoadDataFor(
      model([
        ev({ ctxName: "TaskA", ts: 0 }),
        ev({ ctxName: "IDLE0", ts: 1 }),
        ev({ ctxName: "TaskB", ts: 2 }),
        ev({ ctxName: "TaskB", ts: 3 }),
      ]),
    );
    const keys = stackedContexts(data).map((s) => s.key);
    assert.ok(keys.includes("TaskA") && keys.includes("TaskB"));
    assert.ok(!keys.some((k) => /idle/i.test(k)));
  });
});

describe("aggregateBins (total averages utilisation across cores)", () => {
  it("a busy-on-each-core window sums to ≤ 1 across the two contexts", () => {
    // core0 runs TaskA over [0,10]; core1 runs TaskB over [0,10]; trailing time
    // after each core's last event is unattributed. Total over the whole window
    // averages the two cores, so TaskA≈TaskB≈0.5 and the bin sums to ≈1.
    const data = cpuLoadDataFor(
      model([
        ev({ coreId: 0, ctxName: "TaskA", ts: 0 }),
        ev({ coreId: 0, ctxName: "IDLE0", ts: 10 }),
        ev({ coreId: 1, ctxName: "TaskB", ts: 0 }),
        ev({ coreId: 1, ctxName: "IDLE1", ts: 10 }),
      ]),
    );
    const coarsest = data.levels.length - 1; // a single bin over the domain
    const bins = aggregateBins(data, coarsest, data.domainStart, data.domainEnd, data.cores);
    assert.equal(bins.length, 1);
    const taskA = data.ctxIndex.get("TaskA")!;
    const taskB = data.ctxIndex.get("TaskB")!;
    assert.ok(Math.abs(bins[0]!.util[taskA]! - 0.5) < 0.05, `TaskA ~0.5, got ${bins[0]!.util[taskA]}`);
    assert.ok(Math.abs(bins[0]!.util[taskB]! - 0.5) < 0.05, `TaskB ~0.5, got ${bins[0]!.util[taskB]}`);
    assert.ok(bins[0]!.total <= 1 + 1e-9);
  });

  it("a single-core source reads the mip directly (no averaging)", () => {
    const data = cpuLoadDataFor(
      model([
        ev({ coreId: 0, ctxName: "TaskA", ts: 0 }),
        ev({ coreId: 0, ctxName: "IDLE0", ts: 10 }),
        ev({ coreId: 1, ctxName: "TaskB", ts: 0 }),
        ev({ coreId: 1, ctxName: "IDLE1", ts: 10 }),
      ]),
    );
    const coarsest = data.levels.length - 1;
    const bins = aggregateBins(data, coarsest, data.domainStart, data.domainEnd, [0]);
    const taskA = data.ctxIndex.get("TaskA")!;
    assert.ok(Math.abs(bins[0]!.util[taskA]! - 1) < 0.05, `core0 TaskA ~1, got ${bins[0]!.util[taskA]}`);
  });
});

describe("describe / sourceOptions", () => {
  it("summarises the source, noting all-cores only when multi-core", () => {
    const single = model([ev({ coreId: 0, ctxName: "TaskA" })]);
    const multi = model([ev({ coreId: 0, ctxName: "A" }), ev({ coreId: 1, ctxName: "B" })]);
    assert.equal(cpuLoadLaneType.describe({ kind: "total" }, single), "CPU load");
    assert.equal(cpuLoadLaneType.describe({ kind: "total" }, multi), "CPU load · all cores");
    assert.equal(cpuLoadLaneType.describe({ kind: "core", coreId: 1 }, multi), "CPU load · core 1");
  });

  it("offers just a total for a single-core trace, plus per-core for multi-core", () => {
    const single = cpuLoadLaneType.sourceOptions!(model([ev({ coreId: 0, ctxName: "TaskA" })]));
    assert.deepEqual(single.map((o) => o.label), ["CPU Load"]);
    assert.deepEqual(single[0]!.source as CpuLoadSource, { kind: "total" });

    const multi = cpuLoadLaneType.sourceOptions!(
      model([ev({ coreId: 0, ctxName: "A" }), ev({ coreId: 1, ctxName: "B" })]),
    );
    assert.deepEqual(multi.map((o) => o.label), ["CPU Load (total)", "CPU Load (core 0)", "CPU Load (core 1)"]);
  });
});

describe("registry integration", () => {
  it("registers under its type id with the right default height", () => {
    const reg = new LaneRegistry();
    reg.register(cpuLoadLaneType);
    assert.equal(reg.get(CPULOAD_LANE), cpuLoadLaneType);
    assert.equal(reg.defaultHeight(CPULOAD_LANE), 64);
  });
});

describe("committed fixtures", () => {
  it("builds real bins for the dual-core demo trace", () => {
    const m = parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/dualcore.svdat"))]);
    const data = cpuLoadDataFor(m);
    assert.deepEqual(data.cores, [0, 1]);
    assert.ok(stackedContexts(data).length > 0, "has stackable (non-idle) contexts");
    const bins = aggregateBins(data, data.levels.length - 1, data.domainStart, data.domainEnd, data.cores);
    assert.ok(bins.length > 0);
    assert.ok(bins.every((b) => b.total <= 1 + 1e-9));
  });

  it("offers a total plus a per-core lane for the dual-core P4 trace", () => {
    const m = parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/p4-mcore.svdat"))]);
    const opts = cpuLoadLaneType.sourceOptions!(m).map((o) => o.label);
    assert.ok(opts.includes("CPU Load (total)"));
    assert.ok(opts.includes("CPU Load (core 0)") && opts.includes("CPU Load (core 1)"));
  });
});
