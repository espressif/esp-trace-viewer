/**
 * Unit tests for the lane suppression the CPUs menu drives (`web/core/lanes/core-filter.ts`).
 *
 * A lane goes only when every core it draws from is switched off. Lanes that belong to no core, and tasks
 * that still have a core left to run on, stay.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { coreSuppressedLanes, type CoreLookup } from "../../web/core/lanes/core-filter.js";
import {
  CPULOAD_LANE,
  DATAPLOT_LANE,
  FUNCTRACE_LANE,
  TIMESPAN_LANE,
  type LaneGroup,
  type LaneLayout,
  type LaneLeaf,
  type LaneNode,
} from "../../web/core/lanes/types.js";

function unified(coreId: number): LaneLeaf {
  return { kind: "lane", id: `u:${coreId}`, type: TIMESPAN_LANE, source: { kind: "unified", coreId } };
}
function ctx(key: string): LaneLeaf {
  return { kind: "lane", id: `c:${key}`, type: TIMESPAN_LANE, source: { kind: "context", key } };
}
function cpuLoad(coreId?: number): LaneLeaf {
  return {
    kind: "lane",
    id: coreId === undefined ? "cpu:total" : `cpu:${coreId}`,
    type: CPULOAD_LANE,
    source: coreId === undefined ? { kind: "total" } : { kind: "core", coreId },
  };
}
function plot(id: number): LaneLeaf {
  return { kind: "lane", id: `d:${id}`, type: DATAPLOT_LANE, source: { series: [id] } };
}
function group(id: string, children: LaneNode[]): LaneGroup {
  return { kind: "group", id, label: id, children };
}
function layout(...roots: LaneNode[]): LaneLayout {
  return { version: 1, roots };
}

/** `pinned0` ran on core 0 only, `both` migrated, `never` was never seen running. */
const look: CoreLookup = {
  all: [0, 1],
  cores: (key) => ({ pinned0: [0], pinned1: [1], both: [0, 1] })[key] ?? [],
};

describe("coreSuppressedLanes", () => {
  it("suppresses nothing while every core is switched on", () => {
    const l = layout(unified(0), ctx("pinned0"), cpuLoad(0), plot(1));
    assert.equal(coreSuppressedLanes(l, new Set(), look).size, 0);
  });

  it("drops the lanes belonging to the switched-off core and keeps the rest", () => {
    const l = layout(
      unified(0),
      unified(1),
      group("g", [ctx("pinned0"), ctx("pinned1"), ctx("both")]),
      cpuLoad(0),
      cpuLoad(1),
      cpuLoad(),
      plot(1),
    );
    const off = coreSuppressedLanes(l, new Set([0]), look);
    assert.deepEqual([...off].sort(), ["c:pinned0", "cpu:0", "u:0"]);
  });

  it("keeps a migrating task until the last core it ran on is switched off", () => {
    const l = layout(ctx("both"));
    assert.equal(coreSuppressedLanes(l, new Set([0]), look).size, 0);
    assert.deepEqual([...coreSuppressedLanes(l, new Set([0, 1]), look)], ["c:both"]);
  });

  it("keeps the core-neutral lanes with every core switched off", () => {
    const l = layout(
      unified(0),
      unified(1),
      cpuLoad(),
      plot(1),
      plot(2),
      { kind: "lane", id: "f:both", type: FUNCTRACE_LANE, source: { key: "both" } },
      // A context the reconstruction never saw run belongs to no core either.
      ctx("never"),
    );
    const off = coreSuppressedLanes(l, new Set([0, 1]), look);
    assert.deepEqual([...off].sort(), ["cpu:total", "f:both", "u:0", "u:1"]);
  });
});
