/**
 * Unit tests for the Events list row model (`web/ui/panes/events-rows.ts`):
 * event-to-display-row transformation, Detail column formatting of typed parameters,
 * event classification, filter predicates, and visible index calculations.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ElfSymbols } from "../../src/elf/index.js";
import { parseTraceFiles, type TraceEvent } from "../../src/trace/index.js";
import {
  buildVisibleIndices,
  classifyEvent,
  eventMatchesFilters,
  eventToRow,
  filtersActive,
  formatDetail,
  formatParamValue,
  rowsToMarkdown,
} from "../../web/ui/panes/events-rows.js";
import type { Filters } from "../../web/core/store.js";

/** A minimal event with overridable fields, for class/format unit cases. */
function ev(over: Partial<TraceEvent>): TraceEvent {
  return {
    id: 0,
    coreId: 0,
    name: "svNop",
    ts: 0,
    tsDelta: 0,
    plen: 0,
    params: {},
    ctxName: "IDLE0",
    inIrq: false,
    ...over,
  };
}

const noFilter: Filters = { text: "", cores: new Set(), classes: new Set() };

const fixture = (): TraceEvent[] =>
  parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/dualcore.svdat"))]).events;

describe("classifyEvent", () => {
  it("splits predefined events into isr / task / system", () => {
    assert.equal(classifyEvent(ev({ id: 2 })), "isr"); // ISR_ENTER
    assert.equal(classifyEvent(ev({ id: 3 })), "isr"); // ISR_EXIT
    assert.equal(classifyEvent(ev({ id: 18 })), "isr"); // ISR_TO_SCHEDULER
    assert.equal(classifyEvent(ev({ id: 4 })), "task"); // TASK_START_EXEC
    assert.equal(classifyEvent(ev({ id: 17 })), "task"); // IDLE
    assert.equal(classifyEvent(ev({ id: 24 })), "system"); // INIT
    assert.equal(classifyEvent(ev({ id: 14 })), "system"); // SYSDESC
  });

  it("treats anything above the predefined range as an API call", () => {
    assert.equal(classifyEvent(ev({ id: 32 })), "api"); // first OS event id
    assert.equal(classifyEvent(ev({ id: 83 })), "api"); // OS_MUTEX_LockBlocked
    assert.equal(classifyEvent(ev({ id: 1034 })), "api"); // module event
  });
});

describe("formatParamValue / formatDetail", () => {
  it("renders numbers, bigints, strings, and address arrays", () => {
    assert.equal(formatParamValue(5663), "5663");
    assert.equal(formatParamValue(2353025n), "2353025");
    assert.equal(formatParamValue("IP_Task"), "IP_Task");
    assert.equal(formatParamValue([0x4008_1234, 0x10]), "[0x40081234, 0x10]");
  });

  it("joins params as name=value pairs in payload order", () => {
    const e = ev({ id: 9, name: "svTaskInfo", params: { tid: 5663, prio: 152, name: "IP_Task" } });
    assert.equal(formatDetail(e), "tid=5663, prio=152, name=IP_Task");
  });

  it("formats a parameter-less event as the empty string", () => {
    assert.equal(formatDetail(ev({ id: 3, name: "svIsrExit" })), "");
  });

  it("decodes a svDataSample against a registry to its named, unit-bearing reading", () => {
    // 0x4099999A represents IEEE-754 float32 value 4.8 for bus_voltage.
    const sample = ev({ id: 23, name: "svDataSample", params: { data_id: 1, value: 0x4099_999a } });
    const registry = new Map([[1, { name: "bus_voltage", unit: "V", dataType: 2 }]]);
    assert.equal(formatDetail(sample, registry), "bus_voltage = 4.800000 V");
  });

  it("leaves a svDataSample as raw params when no registry / no matching series", () => {
    const sample = ev({ id: 23, name: "svDataSample", params: { data_id: 7, value: 42 } });
    assert.equal(formatDetail(sample), "data_id=7, value=42"); // no registry
    assert.equal(formatDetail(sample, new Map()), "data_id=7, value=42"); // unregistered id
  });

  it("symbolizes code-address arrays through a loaded ELF, leaving scalars alone", () => {
    // A stand-in ElfSymbols: app_main at 0x42000100 (size 0x40), nothing else.
    const symbols = new ElfSymbols(
      [{ value: 0x4200_0100, size: 0x40, name: "app_main" }],
      [],
    );
    // arr_u32 (caller stack) elements resolve; an interior address gets +offset,
    // an unknown address stays bare hex.
    assert.equal(
      formatParamValue([0x4200_0100, 0x4200_0110, 0x1234], symbols),
      "[0x42000100 (app_main), 0x42000110 (app_main+0x10), 0x1234]",
    );
    // Scalar params are never symbolized — a plain count must stay a number even
    // if it happens to look like an address.
    assert.equal(formatParamValue(0x4200_0100, symbols), "1107296512");
    // Without an ELF, arrays format as hexadecimal.
    assert.equal(formatParamValue([0x4200_0100]), "[0x42000100]");
  });

  it("shows a kernel object handle with the name the processor found for it", () => {
    const give = ev({
      id: 41,
      name: "k_sem_give",
      params: { sem: 0x4080_add4 },
      handles: { sem: { addr: 0x4080_add4, name: "threadA_sem" } },
    });
    assert.equal(formatDetail(give), "sem=0x4080add4 (threadA_sem)");
    // A handle the processor found no name for stays a number.
    assert.equal(formatDetail(ev({ ...give, handles: {} })), "sem=1082174932");
  });
});

describe("eventToRow", () => {
  it("projects an event to its display strings with a 1-based index", () => {
    const e = ev({
      id: 4,
      name: "svTaskStartExec",
      coreId: 1,
      ts: 0,
      ctxName: "IP_Task",
      params: { tid: 5663 },
    });
    const row = eventToRow(e, 25);
    assert.equal(row.num, "26");
    assert.equal(row.core, "1");
    assert.equal(row.ctx, "IP_Task");
    assert.equal(row.name, "svTaskStartExec");
    assert.equal(row.detail, "tid=5663");
    assert.equal(row.cls, "task");
    assert.equal(row.ts, "0 s");
  });
});

describe("rowsToMarkdown", () => {
  it("renders the selected rows as a GitHub-flavoured markdown table", () => {
    const rows = [
      eventToRow(ev({ id: 4, name: "svTaskStartExec", coreId: 1, ctxName: "IP_Task", params: { tid: 5663 } }), 25),
      eventToRow(ev({ id: 3, name: "svIsrExit", coreId: 0, ctxName: "IDLE0" }), 26),
    ];
    assert.equal(
      rowsToMarkdown(rows),
      [
        "| # | Time | Core | Context | Event | Detail |",
        "| --- | --- | --- | --- | --- | --- |",
        "| 26 | 0 s | 1 | IP_Task | svTaskStartExec | tid=5663 |",
        "| 27 | 0 s | 0 | IDLE0 | svIsrExit |  |",
      ].join("\n"),
    );
  });

  it("escapes pipes and collapses newlines so the table stays well-formed", () => {
    const row = eventToRow(ev({ name: "a|b", ctxName: "c\nd", params: {} }), 0);
    const md = rowsToMarkdown([row]);
    const dataLine = md.split("\n")[2]!;
    assert.equal(dataLine, "| 1 | 0 s | 0 | c d | a\\|b |  |");
  });

  it("returns the empty string for an empty selection", () => {
    assert.equal(rowsToMarkdown([]), "");
  });
});

describe("filters", () => {
  it("filtersActive ignores an all-empty filter", () => {
    assert.equal(filtersActive(noFilter), false);
    assert.equal(filtersActive({ text: "  ", cores: new Set(), classes: new Set() }), false);
    assert.equal(filtersActive({ text: "isr", cores: new Set(), classes: new Set() }), true);
    assert.equal(filtersActive({ text: "", cores: new Set([1]), classes: new Set() }), true);
  });

  it("drops events from a switched-off core and matches name/context text case-insensitively", () => {
    const e = ev({ name: "OS_MUTEX_Unlock", ctxName: "IP_Task", coreId: 0 });
    assert.equal(eventMatchesFilters(e, { text: "mutex", cores: new Set(), classes: new Set() }), true);
    assert.equal(eventMatchesFilters(e, { text: "ip_task", cores: new Set(), classes: new Set() }), true);
    assert.equal(eventMatchesFilters(e, { text: "queue", cores: new Set(), classes: new Set() }), false);
    // `cores` holds the cores switched off, so core 1 being off leaves this core 0 event alone.
    assert.equal(eventMatchesFilters(e, { text: "", cores: new Set([1]), classes: new Set() }), true);
    assert.equal(eventMatchesFilters(e, { text: "", cores: new Set([0]), classes: new Set() }), false);
  });
});

describe("buildVisibleIndices", () => {
  it("returns null (identity) when no filter is active", () => {
    const events = [ev({}), ev({})];
    assert.equal(buildVisibleIndices(events, noFilter), null);
  });

  it("returns the ascending subset of matching indices when filtered", () => {
    const events = [
      ev({ name: "svIdle", coreId: 0 }),
      ev({ name: "OS_MUTEX_Unlock", coreId: 0 }),
      ev({ name: "svIdle", coreId: 1 }),
      ev({ name: "OS_MUTEX_Lock", coreId: 1 }),
    ];
    const idx = buildVisibleIndices(events, { text: "mutex", cores: new Set(), classes: new Set() });
    assert.ok(idx);
    assert.deepEqual([...idx!], [1, 3]);
  });
});

describe("dual-core demo capture", () => {
  it("formats known rows the way the parser decoded them", () => {
    const events = fixture();
    assert.equal(events.length, 164703);

    // svInit (index 1): a system-class event with four numeric params.
    const init = eventToRow(events[1]!, 1);
    assert.equal(init.name, "svInit");
    assert.equal(init.cls, "system");
    assert.equal(
      init.detail,
      "sys_freq=1000000, cpu_freq=320000000, ram_base=1073741824, id_shift=0",
    );

    // svTaskStartExec (index 372): task class, the running context is ipc0.
    const start = eventToRow(events[372]!, 372);
    assert.equal(start.num, "373");
    assert.equal(start.name, "svTaskStartExec");
    assert.equal(start.cls, "task");
    assert.equal(start.ctx, "ipc0");
    assert.equal(start.detail, "tid=4009914260");

    // xQueueGenericReceive (index 384): an API call.
    assert.equal(classifyEvent(events[384]!), "api");
  });

  it("filtering by an event name keeps the order and yields a real subset", () => {
    const events = fixture();
    const idx = buildVisibleIndices(events, { text: "xQueue", cores: new Set(), classes: new Set() });
    assert.ok(idx);
    assert.ok(idx!.length > 0 && idx!.length < events.length);
    // Ascending and every selected event really matches.
    for (let i = 1; i < idx!.length; i++) assert.ok(idx![i]! > idx![i - 1]!);
    for (const i of idx!) assert.match(events[i]!.name, /xQueue/i);
  });
});
