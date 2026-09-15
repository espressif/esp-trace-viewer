import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { verifyElfHash } from "../../src/elf/index.js";

// ELF-to-trace hash matching. The trace carries a truncated lowercase hex
// SHA-256 (esp_sysview `ELF_SHA256=...`, default 9 characters); the viewer
// hashes the loaded ELF and compares prefixes.

const FULL = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("verifyElfHash", () => {
  it("matches a truncated trace prefix against the full digest", () => {
    assert.equal(verifyElfHash("ba7816bf8", FULL), "match"); // 9-char default
    assert.equal(verifyElfHash(FULL, FULL), "match"); // full-length
  });

  it("is case-insensitive and trims whitespace", () => {
    assert.equal(verifyElfHash("BA7816BF8", FULL), "match");
    assert.equal(verifyElfHash("  ba7816bf8  ", FULL), "match");
  });

  it("flags a differing prefix as a mismatch", () => {
    assert.equal(verifyElfHash("ba7816bf9", FULL), "mismatch");
    assert.equal(verifyElfHash("deadbeef", FULL), "mismatch");
  });

  it("reports unknown when the trace carries no hash", () => {
    assert.equal(verifyElfHash(null, FULL), "unknown");
    assert.equal(verifyElfHash(undefined, FULL), "unknown");
    assert.equal(verifyElfHash("", FULL), "unknown");
    assert.equal(verifyElfHash("   ", FULL), "unknown");
  });
});
