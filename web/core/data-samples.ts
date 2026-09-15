/**
 * DataPlot sample decoding for `svDataSample` events.
 *
 * Samples carry a series ID and raw 4-byte payload. Series registration via `svRegisterData` or fallback `svNameResource` specifies the series name, value type (unsigned integer, signed integer, or float), and engineering unit. This module constructs the registry for a model and provides decoding utilities used by both the Events table and DataPlot lanes.
 */

import { SYSVIEW_DATA_TYPE, EVTID, type TraceEvent } from "../../src/trace/index.js";

/** Registration metadata for one DataPlot series, keyed by its `data_id`. */
export interface DataSampleMeta {
  /** Registered series name (`svRegisterData` takes precedence over `svNameResource`). */
  name?: string;
  /** Engineering unit (e.g. `V`, `A`, `°C`), or undefined if none was registered. */
  unit?: string;
  /** Value type encoding for raw 32-bit sample payload. Defaults to `U32`. */
  dataType: number;
}

/**
 * Build the `data_id` to metadata registry from trace events.
 *
 * Scans all events because registration events may occur before or after samples. `svRegisterData` provides series name, data type, and unit; `svNameResource` provides a fallback name without overriding an existing registration name. Sampled series without registration omit registry entries; callers fall back to hex identifiers.
 */
export function buildDataSampleRegistry(
  events: readonly TraceEvent[],
): Map<number, DataSampleMeta> {
  const registry = new Map<number, DataSampleMeta>();
  const metaFor = (id: number): DataSampleMeta => {
    let m = registry.get(id);
    if (!m) {
      m = { dataType: SYSVIEW_DATA_TYPE.U32 };
      registry.set(id, m);
    }
    return m;
  };

  for (const e of events) {
    if (e.id === EVTID.EX && e.name === "svRegisterData") {
      const id = e.params["data_id"] as number | undefined;
      if (id === undefined) continue;
      const m = metaFor(id);
      const name = e.params["name"] as string | undefined;
      if (name) m.name = name;
      const unit = e.params["unit"] as string | undefined;
      if (unit) m.unit = unit;
      const dt = e.params["data_type"] as number | undefined;
      if (dt !== undefined) m.dataType = dt;
    } else if (e.id === EVTID.NAME_RESOURCE) {
      const resId = e.params["res_id"] as number | undefined;
      const name = e.params["name"] as string | undefined;
      if (resId !== undefined && name !== undefined) {
        metaFor(resId).name ??= name; // Preserve name from svRegisterData
      }
    }
  }
  return registry;
}

/** Identifier and display metadata for a DataPlot series. */
export interface DataSeriesId {
  /** The DataPlot data id the series was registered/sampled under. */
  id: number;
  /** Stable key for colour + lane identity (`series:<id>`). */
  key: string;
  /** Resolved series name (svRegisterData → svNameResource → `Data 0x..`). */
  name: string;
  /** Engineering unit from svRegisterData (e.g. `°C`), or `""` if none. */
  unit: string;
}

/**
 * List distinct DataPlot series from trace events in order of first sample.
 *
 * Extracts series identifiers, names, and engineering units without decoding sample payloads. Provides a shared definition of series identity for default layouts and DataPlot lanes. Unregistered series fall back to `Data 0x<id>`.
 */
export function listDataSeries(events: readonly TraceEvent[]): DataSeriesId[] {
  const registry = buildDataSampleRegistry(events);
  const seen = new Set<number>();
  const out: DataSeriesId[] = [];
  for (const e of events) {
    if (e.id !== EVTID.DATA_SAMPLE) continue;
    const id = e.params["data_id"] as number | undefined;
    if (id === undefined || e.params["value"] === undefined || seen.has(id)) continue;
    seen.add(id);
    const m = registry.get(id);
    out.push({ id, key: `series:${id}`, name: m?.name ?? `Data 0x${id.toString(16)}`, unit: m?.unit ?? "" });
  }
  return out;
}

/** Shared DataView for reinterpreting raw 32-bit values as IEEE-754 float32. */
const f32View = new DataView(new ArrayBuffer(4));

/**
 * Interpret a raw 32-bit `svDataSample` payload according to its registered data type.
 *
 * Decodes values as unsigned integer (`U32`), sign-extended integer (`I32`), or single-precision float (`FLOAT`).
 */
export function interpretSampleValue(bits: number, dataType: number): number {
  switch (dataType) {
    case SYSVIEW_DATA_TYPE.I32:
      return bits | 0;
    case SYSVIEW_DATA_TYPE.FLOAT:
      f32View.setUint32(0, bits >>> 0, true);
      return f32View.getFloat32(0, true);
    default:
      return bits >>> 0;
  }
}

/**
 * Format a decoded sample value for display.
 *
 * Floats format with six decimal places; integers format without fractional digits. Appends the registered engineering unit when present.
 */
export function formatSampleValue(value: number, dataType: number, unit?: string): string {
  const num = dataType === SYSVIEW_DATA_TYPE.FLOAT ? value.toFixed(6) : String(value);
  return unit ? `${num} ${unit}` : num;
}

/**
 * Format the detail string for an `svDataSample` event as `<name> = <value> <unit>`.
 *
 * Unnamed series default to `Data 0x<id>`.
 */
export function formatDataSample(meta: DataSampleMeta, dataId: number, bits: number): string {
  const value = interpretSampleValue(bits, meta.dataType);
  const name = meta.name ?? `Data 0x${dataId.toString(16)}`;
  return `${name} = ${formatSampleValue(value, meta.dataType, meta.unit)}`;
}
