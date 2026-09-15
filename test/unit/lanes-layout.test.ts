/**
 * Unit tests for the lane layout engine (`web/core/lanes/layout-engine.ts`) and
 * the serializable tree model (`web/core/lanes/types.ts`).
 *
 * Tests tree-to-stacked draw-band flattening (group headers, collapse, hidden
 * subtrees, per-lane heights), vertical scroll clamping, coordinate hit testing,
 * and JSON serialization and cloning for `.svdat` embedding without DOM dependencies.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  bandAtContentY,
  clampLaneHeight,
  clampScrollTop,
  DEFAULT_LANE_METRICS,
  laneHeight,
  layoutBands,
} from "../../web/trace-ui-toolkit/lanes/layout-engine.js";
import {
  cloneLayout,
  isLaneLayout,
  parseLayout,
  serializeLayout,
  type LaneGroup,
  type LaneLayout,
  type LaneLeaf,
  type LaneNode,
} from "../../web/core/lanes/types.js";

const M = DEFAULT_LANE_METRICS; // header 18, minLane 14, default 22

function lane(id: string, over: Partial<LaneLeaf> = {}): LaneLeaf {
  return { kind: "lane", id, type: "timespan", source: { kind: "context", key: id }, ...over };
}
function group(id: string, children: LaneNode[], over: Partial<LaneGroup> = {}): LaneGroup {
  return { kind: "group", id, label: id, children, ...over };
}
function layout(...roots: LaneNode[]): LaneLayout {
  return { version: 1, roots };
}

describe("layoutBands", () => {
  it("stacks root lanes top-to-bottom and sums the content height", () => {
    const { bands, contentHeight } = layoutBands(layout(lane("a"), lane("b")), M);
    assert.deepEqual(bands.map((b) => [b.id, b.kind, b.top, b.height]), [
      ["a", "lane", 0, 22],
      ["b", "lane", 22, 22],
    ]);
    assert.equal(contentHeight, 44);
  });

  it("emits a header for a group and indents its children one depth deeper", () => {
    const { bands, contentHeight } = layoutBands(layout(group("g", [lane("x"), lane("y")])), M);
    assert.deepEqual(
      bands.map((b) => [b.id, b.kind, b.depth, b.top, b.height]),
      [
        ["g", "group-header", 0, 0, 18],
        ["x", "lane", 1, 18, 22],
        ["y", "lane", 1, 40, 22],
      ],
    );
    assert.equal(contentHeight, 62);
  });

  it("keeps a collapsed group's header but omits its children", () => {
    const { bands, contentHeight } = layoutBands(
      layout(group("g", [lane("x"), lane("y")], { collapsed: true }), lane("z")),
      M,
    );
    assert.deepEqual(bands.map((b) => b.id), ["g", "z"]);
    assert.equal(contentHeight, 18 + 22);
  });

  it("skips a hidden node together with its whole subtree", () => {
    const hiddenGroup = group("g", [lane("x")], { hidden: true });
    const { bands } = layoutBands(layout(lane("a"), hiddenGroup, lane("b", { hidden: true }), lane("c")), M);
    assert.deepEqual(bands.map((b) => b.id), ["a", "c"]);
  });

  it("honors an explicit lane height, the type default, and the minimum floor", () => {
    assert.equal(laneHeight(lane("a", { height: 40 }), M), 40);
    assert.equal(laneHeight(lane("a"), M), 22); // M.defaultHeight → 22
    assert.equal(laneHeight(lane("a", { height: 3 }), M), M.minLaneHeight); // floored
  });
});

describe("clampScrollTop", () => {
  it("clamps to [0, contentHeight - viewport] and sets to 0 when everything fits", () => {
    assert.equal(clampScrollTop(50, 300, 100), 50); // within range
    assert.equal(clampScrollTop(-10, 300, 100), 0); // never negative
    assert.equal(clampScrollTop(999, 300, 100), 200); // never past the overflow
    assert.equal(clampScrollTop(40, 80, 100), 0); // content shorter than viewport
  });
});

describe("clampLaneHeight", () => {
  it("rounds to whole pixels and never drops below the floor", () => {
    assert.equal(clampLaneHeight(30.6, M), 31);
    assert.equal(clampLaneHeight(5, M), M.minLaneHeight);
  });
});

describe("bandAtContentY", () => {
  const { bands } = layoutBands(layout(lane("a"), lane("b"), lane("c")), M); // 0..22, 22..44, 44..66

  it("maps a content-space y to its band (top inclusive, bottom exclusive)", () => {
    assert.equal(bandAtContentY(bands, 0)!.id, "a");
    assert.equal(bandAtContentY(bands, 21.9)!.id, "a");
    assert.equal(bandAtContentY(bands, 22)!.id, "b"); // boundary belongs to the next band
    assert.equal(bandAtContentY(bands, 50)!.id, "c");
  });

  it("returns null past the last band", () => {
    assert.equal(bandAtContentY(bands, 66), null);
    assert.equal(bandAtContentY(bands, 999), null);
  });
});

describe("serialize / parse / clone / validate", () => {
  const sample = layout(lane("u:0", { label: "Unified", height: 30 }), group("g", [lane("c:IDLE0")], { collapsed: true }));

  it("round-trips a layout through JSON unchanged", () => {
    const back = parseLayout(serializeLayout(sample));
    assert.deepEqual(back, sample);
  });

  it("parseLayout rejects malformed or invalid schema input", () => {
    assert.equal(parseLayout("not json"), null);
    assert.equal(parseLayout(JSON.stringify({ version: 1 })), null); // no roots
    assert.equal(parseLayout(JSON.stringify({ roots: [] })), null); // no version
    assert.equal(parseLayout(JSON.stringify({ version: 1, roots: [{ id: "x" }] })), null); // bad node
  });

  it("isLaneLayout accepts a valid layout and a bare empty one", () => {
    assert.equal(isLaneLayout(sample), true);
    assert.equal(isLaneLayout({ version: 1, roots: [] }), true);
    assert.equal(isLaneLayout(null), false);
    assert.equal(isLaneLayout({ version: "1", roots: [] }), false);
  });

  it("cloneLayout is a deep, independent copy", () => {
    const copy = cloneLayout(sample);
    assert.deepEqual(copy, sample);
    assert.notEqual(copy.roots, sample.roots); // distinct arrays
    assert.notEqual((copy.roots[1] as LaneGroup).children, (sample.roots[1] as LaneGroup).children);
  });
});
