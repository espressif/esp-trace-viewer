/**
 * Unit tests for lane tree selectors.
 *
 * Tests tree-order traversal, effective visibility inheritance across ancestor
 * groups, and hidden lane count calculations.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { anyHidden, contextLanes, hiddenLaneCount } from "../../web/core/lanes/selectors.js";
import type { LaneGroup, LaneLayout, LaneLeaf, LaneNode } from "../../web/core/lanes/types.js";

function unified(id: string, coreId: number): LaneLeaf {
  return { kind: "lane", id, type: "timespan", source: { kind: "unified", coreId } };
}
function ctx(key: string, over: Partial<LaneLeaf> = {}): LaneLeaf {
  return { kind: "lane", id: `c:${key}`, type: "timespan", source: { kind: "context", key }, ...over };
}
function group(id: string, children: LaneNode[], over: Partial<LaneGroup> = {}): LaneGroup {
  return { kind: "group", id, label: id, children, ...over };
}
function layout(...roots: LaneNode[]): LaneLayout {
  return { version: 1, roots };
}

describe("contextLanes", () => {
  it("lists context lanes in tree order and excludes the Unified track", () => {
    const l = layout(unified("u:0", 0), group("g", [ctx("TaskA"), ctx("IDLE0")]));
    assert.deepEqual(
      contextLanes(l).map((c) => c.key),
      ["TaskA", "IDLE0"],
    );
  });

  it("marks a lane hidden if it, or any ancestor group, is hidden", () => {
    const l = layout(
      group("g1", [ctx("A"), ctx("B", { hidden: true })]),
      group("g2", [ctx("C")], { hidden: true }), // Ancestor group hidden marks child hidden
    );
    assert.deepEqual(
      contextLanes(l).map((c) => [c.key, c.hidden]),
      [["A", false], ["B", true], ["C", true]],
    );
  });

  it("ignores group collapse (a display-only state)", () => {
    const l = layout(group("g", [ctx("A")], { collapsed: true }));
    assert.equal(contextLanes(l)[0]!.hidden, false);
  });

  it("falls back to the context key when a lane has no label", () => {
    const l = layout(ctx("Worker"), ctx("Named", { label: "My Lane" }));
    assert.deepEqual(
      contextLanes(l).map((c) => c.label),
      ["Worker", "My Lane"],
    );
  });
});

describe("anyHidden / hiddenLaneCount", () => {
  it("anyHidden reports whether any node carries a hidden flag", () => {
    assert.equal(anyHidden(layout(ctx("A"), ctx("B"))), false);
    assert.equal(anyHidden(layout(ctx("A", { hidden: true }))), true);
    assert.equal(anyHidden(layout(group("g", [ctx("A")], { hidden: true }))), true);
  });

  it("hiddenLaneCount counts leaf lanes hidden by themselves or an ancestor", () => {
    const l = layout(
      ctx("A"),
      ctx("B", { hidden: true }),
      group("g", [ctx("C"), ctx("D")], { hidden: true }), // Both children count as hidden
    );
    assert.equal(hiddenLaneCount(l), 3);
  });
});
