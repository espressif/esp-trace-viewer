/**
 * Unit tests for Auto Scroll ("follow tail") window calculations.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { followTail } from "../../web/trace-ui-toolkit/auto-scroll.js";

describe("followTail", () => {
  it("aligns a zoomed-in window's right edge to the domain end, maintaining its span", () => {
    const w = followTail(0, 10, 2, false);
    assert.deepEqual(w, { t0: 8, t1: 10 });
  });

  it("maintains full domain coverage when the domain grows and the view was zoomed out", () => {
    // Initial window covers [0, 5]; domain grows to [0, 12].
    const w = followTail(0, 12, 5, true);
    assert.deepEqual(w, { t0: 0, t1: 12 });
  });

  it("clamps a span wider than the domain to the whole domain", () => {
    const w = followTail(0, 3, 10, false);
    assert.deepEqual(w, { t0: 0, t1: 3 });
  });

  it("respects a non-zero domain start", () => {
    const w = followTail(100, 105, 2, false);
    assert.deepEqual(w, { t0: 103, t1: 105 });
  });

  it("never starts before the domain start", () => {
    const w = followTail(50, 51, 5, false);
    assert.equal(w.t0, 50);
    assert.equal(w.t1, 51);
  });

  it("handles a degenerate (empty) domain", () => {
    const w = followTail(7, 7, 1, false);
    assert.deepEqual(w, { t0: 7, t1: 7 });
  });

  it("treats a zero/negative span as fully zoomed out", () => {
    assert.deepEqual(followTail(0, 4, 0, false), { t0: 0, t1: 4 });
  });
});
