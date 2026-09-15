/**
 * Unit tests for lane-tree reducers (`web/core/lanes/controller.ts`):
 * node lookup and tree traversal, insertion and removal, reordering and move operations,
 * height and visibility mutation, grouping and ungrouping, and JSON serialization round-tripping.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  addNode,
  allNodes,
  findNode,
  groupNodes,
  moveBefore,
  moveNode,
  removeNode,
  resetHeight,
  setCollapsed,
  setHeight,
  setLabel,
  setSource,
  showAll,
  toggleHidden,
  ungroup,
  uniqueId,
} from "../../web/trace-ui-toolkit/lanes/controller.js";
import { DEFAULT_LANE_METRICS } from "../../web/trace-ui-toolkit/lanes/layout-engine.js";
import {
  serializeLayout,
  parseLayout,
  type LaneGroup,
  type LaneLayout,
  type LaneLeaf,
  type LaneNode,
} from "../../web/core/lanes/types.js";

function lane(id: string, over: Partial<LaneLeaf> = {}): LaneLeaf {
  return { kind: "lane", id, type: "timespan", source: { kind: "context", key: id }, ...over };
}
function group(id: string, children: LaneNode[], over: Partial<LaneGroup> = {}): LaneGroup {
  return { kind: "group", id, label: id, children, ...over };
}
function layout(...roots: LaneNode[]): LaneLayout {
  return { version: 1, roots };
}

const ids = (l: LaneLayout): string[] => l.roots.map((n) => n.id);
const childIds = (l: LaneLayout, gid: string): string[] =>
  (findNode(l, gid)!.node as LaneGroup).children.map((c) => c.id);

/** Run `op`, asserting it left `before` byte-for-byte untouched (purity guard). */
function assertPure(before: LaneLayout, op: () => LaneLayout): LaneLayout {
  const snapshot = JSON.parse(JSON.stringify(before));
  const after = op();
  assert.deepEqual(before, snapshot, "input layout must not be mutated");
  return after;
}

describe("lookup helpers", () => {
  const l = layout(lane("a"), group("g", [lane("x"), lane("y")]));

  it("findNode locates a node with its parent, siblings and index", () => {
    const root = findNode(l, "a")!;
    assert.equal(root.parent, null);
    assert.equal(root.index, 0);

    const nested = findNode(l, "y")!;
    assert.equal(nested.parent!.id, "g");
    assert.equal(nested.index, 1);

    assert.equal(findNode(l, "missing"), null);
  });

  it("allNodes lists every node in pre-order", () => {
    assert.deepEqual(allNodes(l).map((n) => n.id), ["a", "g", "x", "y"]);
  });

  it("uniqueId returns the desired id, or a suffixed one if taken", () => {
    assert.equal(uniqueId(l, "free"), "free");
    assert.equal(uniqueId(l, "a"), "a-2");
    assert.equal(uniqueId(layout(lane("a"), lane("a-2")), "a"), "a-3");
  });
});

describe("addNode / removeNode", () => {
  it("inserts into the roots at an index and appends by default", () => {
    const l = layout(lane("a"), lane("b"));
    assert.deepEqual(ids(addNode(l, null, lane("c"), 1)), ["a", "c", "b"]);
    assert.deepEqual(ids(addNode(l, null, lane("c"))), ["a", "b", "c"]);
  });

  it("inserts into a group's children", () => {
    const l = layout(group("g", [lane("x")]));
    const next = assertPure(l, () => addNode(l, "g", lane("y"), 0));
    assert.deepEqual(childIds(next, "g"), ["y", "x"]);
  });

  it("removes a nested node and is a no-op (same ref) for a missing id", () => {
    const l = layout(group("g", [lane("x"), lane("y")]));
    assert.deepEqual(childIds(removeNode(l, "x"), "g"), ["y"]);
    assert.equal(removeNode(l, "nope"), l);
  });
});

describe("moveNode", () => {
  it("reorders within the roots (index is post-removal)", () => {
    const l = layout(lane("a"), lane("b"), lane("c"));
    assert.deepEqual(ids(moveNode(l, "a", null, 2)), ["b", "c", "a"]);
    assert.deepEqual(ids(moveNode(l, "c", null, 0)), ["c", "a", "b"]);
  });

  it("moves a node into a group", () => {
    const l = layout(group("g", [lane("x"), lane("y")]), lane("z"));
    const next = assertPure(l, () => moveNode(l, "z", "g", 1));
    assert.deepEqual(ids(next), ["g"]);
    assert.deepEqual(childIds(next, "g"), ["x", "z", "y"]);
  });

  it("refuses to nest a group inside its own subtree", () => {
    const l = layout(group("g1", [group("g2", [lane("x")])]));
    assert.equal(moveNode(l, "g1", "g2", 0), l); // no-op, same ref
  });

  it("is a no-op for a missing node", () => {
    const l = layout(lane("a"));
    assert.equal(moveNode(l, "nope", null, 0), l);
  });
});

describe("moveBefore (drag-and-drop primitive)", () => {
  it("drops a node immediately above the target in the target's parent", () => {
    const l = layout(lane("a"), lane("b"), lane("c"));
    assert.deepEqual(ids(moveBefore(l, "c", "a")), ["c", "a", "b"]);
    assert.deepEqual(ids(moveBefore(l, "a", "c")), ["b", "a", "c"]);
  });

  it("moves a root node in just above a target inside a group", () => {
    const l = layout(group("g", [lane("x"), lane("y")]), lane("z"));
    const next = assertPure(l, () => moveBefore(l, "z", "y"));
    assert.deepEqual(ids(next), ["g"]);
    assert.deepEqual(childIds(next, "g"), ["x", "z", "y"]);
  });

  it("is a no-op for same id, missing id, or dropping into its own subtree", () => {
    const l = layout(group("g", [lane("x")]), lane("a"));
    assert.equal(moveBefore(l, "a", "a"), l);
    assert.equal(moveBefore(l, "a", "nope"), l);
    assert.equal(moveBefore(l, "g", "x"), l); // x is inside g
  });
});

describe("showAll", () => {
  it("clears every hidden flag (lanes and groups, at any depth)", () => {
    const l = layout(lane("a", { hidden: true }), group("g", [lane("x", { hidden: true })], { hidden: true }));
    const next = assertPure(l, () => showAll(l));
    assert.equal(findNode(next, "a")!.node.hidden, false);
    assert.equal(findNode(next, "g")!.node.hidden, false);
    assert.equal(findNode(next, "x")!.node.hidden, false);
  });

  it("is a no-op (same ref) when nothing is hidden", () => {
    const l = layout(lane("a"), group("g", [lane("x")]));
    assert.equal(showAll(l), l);
  });
});

describe("field edits", () => {
  it("setHeight sets and clamps a lane's height, ignoring groups", () => {
    const l = layout(lane("a"), group("g", []));
    assert.equal((findNode(setHeight(l, "a", 40), "a")!.node as LaneLeaf).height, 40);
    // Below the floor → clamped to the engine minimum.
    assert.equal(
      (findNode(setHeight(l, "a", 2), "a")!.node as LaneLeaf).height,
      DEFAULT_LANE_METRICS.minLaneHeight,
    );
    // A group id keeps the tree equivalent (no height on groups).
    assert.deepEqual(setHeight(l, "g", 40), l);
  });

  it("resetHeight clears a lane's explicit height (back to the type default)", () => {
    const l = setHeight(layout(lane("a"), group("g", [])), "a", 40);
    const reset = resetHeight(l, "a");
    assert.equal((findNode(reset, "a")!.node as LaneLeaf).height, undefined);
    assert.ok(!("height" in (findNode(reset, "a")!.node as LaneLeaf))); // field removed, not undefined
    // A lane with no override, or a group id, is returned unchanged in shape.
    assert.equal((findNode(resetHeight(reset, "a"), "a")!.node as LaneLeaf).height, undefined);
    assert.deepEqual(resetHeight(l, "g"), l);
  });

  it("toggleHidden toggles or sets the flag", () => {
    const l = layout(lane("a"));
    assert.equal((findNode(toggleHidden(l, "a"), "a")!.node).hidden, true);
    assert.equal((findNode(toggleHidden(l, "a", false), "a")!.node).hidden, false);
  });

  it("setCollapsed toggles a group and ignores lanes", () => {
    const l = layout(group("g", [lane("x")]), lane("a"));
    assert.equal((findNode(setCollapsed(l, "g"), "g")!.node as LaneGroup).collapsed, true);
    assert.deepEqual(setCollapsed(l, "a"), l); // lane id → equivalent tree
  });

  it("setSource and setLabel replace a lane's config and label", () => {
    const l = layout(lane("a"));
    const src = { kind: "unified", coreId: 1 };
    assert.deepEqual((findNode(setSource(l, "a", src), "a")!.node as LaneLeaf).source, src);
    assert.equal((findNode(setLabel(l, "a", "Hi"), "a")!.node).label, "Hi");
  });
});

describe("groupNodes / ungroup", () => {
  it("wraps sibling nodes into a new group at the first one's position", () => {
    const l = layout(lane("a"), lane("b"), lane("c"), lane("d"));
    const next = assertPure(l, () => groupNodes(l, ["b", "c"], { id: "g", label: "G" }));
    assert.deepEqual(ids(next), ["a", "g", "d"]);
    assert.deepEqual(childIds(next, "g"), ["b", "c"]);
  });

  it("preserves sibling order inside the new group regardless of id order", () => {
    const l = layout(lane("a"), lane("b"), lane("c"));
    const next = groupNodes(l, ["c", "a"], { id: "g", label: "G" });
    // The group is placed at the index of the earliest selected node ('a'), with children in sibling order.
    assert.deepEqual(ids(next), ["g", "b"]);
    assert.deepEqual(childIds(next, "g"), ["a", "c"]);
  });

  it("ungroup splices a group's children back into its place", () => {
    const l = layout(lane("a"), group("g", [lane("x"), lane("y")]), lane("b"));
    const next = assertPure(l, () => ungroup(l, "g"));
    assert.deepEqual(ids(next), ["a", "x", "y", "b"]);
  });

  it("ungroup is a no-op for a lane id", () => {
    const l = layout(lane("a"));
    assert.equal(ungroup(l, "a"), l);
  });
});

describe("serializability", () => {
  it("a layout after several edits round-trips through JSON unchanged", () => {
    let l = layout(lane("a"), lane("b"), lane("c"));
    l = groupNodes(l, ["b", "c"], { id: "g", label: "G", collapsed: true });
    l = setHeight(l, "a", 36);
    l = toggleHidden(l, "b");
    l = moveNode(l, "a", "g", 0);
    assert.deepEqual(parseLayout(serializeLayout(l)), l);
  });
});
