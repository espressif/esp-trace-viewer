/**
 * Unit tests for `web/core/lanes/reveal.ts`: undoing everything that keeps one context's lane off the
 * timeline, which is what a click on the Statistics table's Max run figure does on the way to that run.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { findContextLane, revealContextLane } from "../../web/core/lanes/reveal.js";
import type { Filters } from "../../web/core/store.js";
import { TIMESPAN_LANE, type LaneGroup, type LaneLayout, type LaneLeaf, type LaneNode } from "../../web/core/lanes/types.js";

function ctx(key: string, over: Partial<LaneLeaf> = {}): LaneLeaf {
  return { kind: "lane", id: `c:${key}`, type: TIMESPAN_LANE, source: { kind: "context", key }, ...over };
}
function group(id: string, children: LaneNode[], over: Partial<LaneGroup> = {}): LaneGroup {
  return { kind: "group", id, label: id, children, ...over };
}
function layout(...roots: LaneNode[]): LaneLayout {
  return { version: 1, roots };
}
function filters(over: Partial<Filters> = {}): Filters {
  return { text: "", cores: new Set(), classes: new Set(), ...over };
}

describe("findContextLane", () => {
  it("finds a lane nested in a group, and reports nothing for a context with no lane", () => {
    const l = layout(group("g:tasks", [ctx("tcpip")]));
    assert.equal(findContextLane(l, "tcpip"), "c:tcpip");
    assert.equal(findContextLane(l, "httpd"), null);
  });
});

describe("revealContextLane", () => {
  it("clears the hidden flag on the lane and on the groups above it", () => {
    const l = layout(group("g:tasks", [ctx("tcpip", { hidden: true })], { hidden: true }));
    const r = revealContextLane(l, new Set(), filters(), "tcpip", [0])!;
    const g = r.laneLayout.roots[0] as LaneGroup;
    assert.equal(g.hidden, false);
    assert.equal(g.children[0]!.hidden, false);
  });

  it("switches the quick filter covering the lane's group back on", () => {
    const l = layout(group("g:tasks", [ctx("tcpip")]));
    const r = revealContextLane(l, new Set(["g:tasks", "g:data"]), filters(), "tcpip", [0])!;
    assert.deepEqual([...r.groupsOff], ["g:data"]); // only the group in the way is switched back on
  });

  it("switches the context's cores back on only when every one of them is off", () => {
    const l = layout(ctx("tcpip"));

    // Both cores off leaves the lane with nothing to draw, so both come back.
    const rescued = revealContextLane(l, new Set(), filters({ cores: new Set([0, 1]) }), "tcpip", [0, 1])!;
    assert.equal(rescued.filters.cores.size, 0);

    // One core still on means the lane is drawn already; the other core stays off.
    const kept = revealContextLane(l, new Set(), filters({ cores: new Set([0]) }), "tcpip", [0, 1])!;
    assert.deepEqual([...kept.filters.cores], [0]);
  });

  it("reports nothing for a context the layout has no lane for", () => {
    assert.equal(revealContextLane(layout(ctx("tcpip")), new Set(), filters(), "httpd", [0]), null);
  });
});
