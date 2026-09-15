/**
 * Unit tests for the shared DataPlot sample decoder (`web/core/data-samples.ts`):
 * building the `data_id → registration` registry from a model's events,
 * interpreting a raw 32-bit value per its series' type, and formatting the named
 * unit-bearing Detail string the Events list and timeline tooltip show.
 *
 * DOM-free and run under `tsx --test`. Synthetic cases verify U32, I32,
 * and FLOAT decoding. Fixture cases verify decoding against `unicore.svdat`.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  parseTraceFiles,
  SYSVIEW_DATA_TYPE,
  EVTID,
  SYSVIEW_EVTID_EX,
  type TraceEvent,
} from "../../src/trace/index.js";
import {
  buildDataSampleRegistry,
  formatDataSample,
  formatSampleValue,
  interpretSampleValue,
} from "../../web/core/data-samples.js";

/** A minimal event with overridable fields. */
function ev(over: Partial<TraceEvent>): TraceEvent {
  return {
    id: 0,
    coreId: 0,
    name: "svNop",
    ts: 0,
    tsDelta: 0,
    plen: 0,
    params: {},
    ctxName: "None",
    inIrq: false,
    ...over,
  };
}

/** A synthetic svRegisterData event for `data_id`. */
function reg(dataId: number, name: string, dataType: number, unit: string): TraceEvent {
  return ev({
    id: EVTID.EX,
    name: "svRegisterData",
    params: { sub_id: SYSVIEW_EVTID_EX.REGISTER_DATA, data_id: dataId, name, data_type: dataType, unit },
  });
}

/** Converts a number to its IEEE-754 float32 representation as a uint32. */
function floatBits(v: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, v, true);
  return view.getUint32(0, true);
}

const fixture = (): TraceEvent[] =>
  parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/unicore.svdat"))]).events;

describe("interpretSampleValue", () => {
  it("reads a U32 bit-pattern as an unsigned integer", () => {
    assert.equal(interpretSampleValue(0xffff_ffff, SYSVIEW_DATA_TYPE.U32), 0xffff_ffff);
    assert.equal(interpretSampleValue(42, SYSVIEW_DATA_TYPE.U32), 42);
  });

  it("sign-extends an I32 bit-pattern", () => {
    assert.equal(interpretSampleValue(0xffff_ffff, SYSVIEW_DATA_TYPE.I32), -1);
    assert.equal(interpretSampleValue(0xffff_fff6, SYSVIEW_DATA_TYPE.I32), -10);
  });

  it("reinterprets a FLOAT bit-pattern as IEEE-754", () => {
    // 0x4099999A represents IEEE-754 float32 value 4.8 for bus_voltage.
    assert.ok(Math.abs(interpretSampleValue(0x4099_999a, SYSVIEW_DATA_TYPE.FLOAT) - 4.8) < 1e-5);
    assert.equal(interpretSampleValue(floatBits(-1.5), SYSVIEW_DATA_TYPE.FLOAT), -1.5);
  });
});

describe("formatSampleValue", () => {
  it("renders floats with six decimals and a unit", () => {
    assert.equal(formatSampleValue(4.8, SYSVIEW_DATA_TYPE.FLOAT, "V"), "4.800000 V");
  });

  it("renders integers verbatim", () => {
    assert.equal(formatSampleValue(120, SYSVIEW_DATA_TYPE.U32, "mV"), "120 mV");
    assert.equal(formatSampleValue(-20, SYSVIEW_DATA_TYPE.I32, "ppm"), "-20 ppm");
  });

  it("omits the unit when none is registered", () => {
    assert.equal(formatSampleValue(7, SYSVIEW_DATA_TYPE.U32), "7");
  });
});

describe("buildDataSampleRegistry", () => {
  it("collects name, value type, and unit from svRegisterData", () => {
    const registry = buildDataSampleRegistry([
      reg(1, "bus_voltage", SYSVIEW_DATA_TYPE.FLOAT, "V"),
      reg(2, "shunt_current", SYSVIEW_DATA_TYPE.FLOAT, "A"),
    ]);
    assert.deepEqual(registry.get(1), {
      name: "bus_voltage",
      unit: "V",
      dataType: SYSVIEW_DATA_TYPE.FLOAT,
    });
    assert.equal(registry.get(2)!.name, "shunt_current");
  });

  it("falls back to svNameResource for the name but never overrides a registration", () => {
    const registry = buildDataSampleRegistry([
      ev({ id: EVTID.NAME_RESOURCE, name: "svNameResource", params: { res_id: 5, name: "FromName" } }),
      reg(1, "FromReg", SYSVIEW_DATA_TYPE.U32, "x"),
      ev({ id: EVTID.NAME_RESOURCE, name: "svNameResource", params: { res_id: 1, name: "Ignored" } }),
    ]);
    assert.equal(registry.get(5)!.name, "FromName");
    assert.equal(registry.get(1)!.name, "FromReg"); // svRegisterData wins
  });

  it("leaves ids that were never registered out of the registry", () => {
    const registry = buildDataSampleRegistry([
      ev({ id: EVTID.DATA_SAMPLE, name: "svDataSample", params: { data_id: 9, value: 1 } }),
    ]);
    assert.equal(registry.has(9), false);
  });
});

describe("formatDataSample", () => {
  it("decodes a registered float sample to name = value unit", () => {
    const registry = buildDataSampleRegistry([reg(1, "bus_voltage", SYSVIEW_DATA_TYPE.FLOAT, "V")]);
    assert.equal(formatDataSample(registry.get(1)!, 1, 0x4099_999a), "bus_voltage = 4.800000 V");
  });

  it("falls back to Data 0x<id> for a registration without a name", () => {
    assert.equal(
      formatDataSample({ dataType: SYSVIEW_DATA_TYPE.U32 }, 0x2a, 7),
      "Data 0x2a = 7",
    );
  });
});

describe("DataPlot fixture decoding", () => {
  it("decodes the single-core demo's registered FLOAT series", () => {
    const events = fixture();
    const registry = buildDataSampleRegistry(events);

    // The demo registers seven FLOAT series; three of them, with their units.
    assert.equal(registry.get(1)!.name, "raw");
    assert.equal(registry.get(1)!.unit, "mV");
    assert.equal(registry.get(1)!.dataType, SYSVIEW_DATA_TYPE.FLOAT);
    assert.equal(registry.get(4)!.name, "temp");
    assert.equal(registry.get(4)!.unit, "C");
    assert.equal(registry.get(4)!.dataType, SYSVIEW_DATA_TYPE.FLOAT);
    assert.equal(registry.get(8)!.name, "timer_jitter");
    assert.equal(registry.get(8)!.unit, "us");
    assert.equal(registry.get(8)!.dataType, SYSVIEW_DATA_TYPE.FLOAT);

    // The first sample of each series formats to a decoded float reading.
    const first = (id: number): TraceEvent =>
      events.find((e) => e.id === EVTID.DATA_SAMPLE && e.params["data_id"] === id)!;

    const raw = formatDataSample(registry.get(1)!, 1, first(1).params["value"] as number);
    assert.match(raw, /^raw = -?\d+\.\d{6} mV$/); // signed float, six decimals
    const temp = formatDataSample(registry.get(4)!, 4, first(4).params["value"] as number);
    assert.match(temp, /^temp = \d+\.\d{6} C$/);
  });
});
