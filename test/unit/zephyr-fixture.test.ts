/**
 * Tests over the bundled Zephyr demo capture (test/fixtures/traces/zephyr.svdat), recorded from
 * Zephyr's tracing sample. They check that a Zephyr stream selects the Zephyr event table, that
 * every event the sample produces decodes, and that the ELF provides names for the kernel objects
 * the events refer to.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseElfSymbols } from "../../src/elf/index.js";
import { parseTraceFiles } from "../../src/trace/index.js";
import { classifyEvent } from "../../web/core/event-class.js";
import { formatDetail } from "../../web/ui/panes/events-rows.js";

const elf = parseElfSymbols(new Uint8Array(readFileSync("test/fixtures/traces/zephyr.elf")));
const model = parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/zephyr.svdat"))], { elf });

describe("Zephyr demo capture", () => {
  it("is a single-core Zephyr stream with the sample's threads and interrupt names", () => {
    assert.equal(model.traces.length, 1);
    const trace = model.traces[0]!;
    assert.equal(trace.sysInfo?.ramBase, 0x4080_0000);
    assert.deepEqual([...trace.tasks.values()].sort(), ["sysworkq", "thread_a", "thread_b"]);
    assert.deepEqual([...trace.irqs.entries()].sort(), [[18, "gpio_esp32_isr"], [21, "sys_timer_isr"]]);
  });

  it("decodes every event the sample produces", () => {
    const undecoded = model.events.filter((e) => e.name.startsWith("svEvent_"));
    assert.deepEqual(undecoded, []);
    const names = new Set(model.events.map((e) => e.name));
    for (const n of ["k_mutex_lock", "k_mutex_unlock", "k_timer_start", "k_timer_expiry", "k_work_submit", "k_sem_give", "named_event", "svEndCall"]) {
      assert.ok(names.has(n), `${n} decoded`);
    }
  });

  it("resolves svEndCall to the API that returned and classifies it as an API event", () => {
    const end = model.events.find((e) => e.name === "svEndCall" && e.params["call"] === "k_thread_sleep_ticks")!;
    assert.deepEqual(end.params, { call: "k_thread_sleep_ticks", ret: 0 });
    assert.equal(classifyEvent(end), "api");
  });

  it("shows the sample's kernel objects with their ELF symbol names", () => {
    const give = model.events.find((e) => e.name === "k_sem_give")!;
    assert.match(formatDetail(give), /^sem=0x4080[0-9a-f]{4} \(thread[AB]_sem\)$/);
    const lock = model.events.find((e) => e.name === "k_mutex_lock")!;
    assert.match(formatDetail(lock), /^mutex=0x4080[0-9a-f]{4} \(demo_mutex\), timeout=/);
    const exec = model.events.find((e) => e.name === "svTaskStartExec" && e.ctxName === "thread_b")!;
    assert.equal(formatDetail(exec), `tid=0x4080e660 (threadB_data)`);
  });
});
