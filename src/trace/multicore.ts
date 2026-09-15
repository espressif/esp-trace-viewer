/**
 * Multi-core SVDAT splitting.
 *
 * Combined SMP captures store concatenated per-core event streams preceded by
 * a textual header containing `; Offset CoreN` byte offsets relative to the
 * first synchronization sequence. {@link splitSeggerMulticore} partitions the
 * stream into individual single-core SVDAT buffers by prepending the shared
 * textual header to each core's stream slice.
 *
 * The shared header is reused directly without appending extra synchronization
 * bytes, avoiding spurious NOP events.
 */

import { SYNC_LEN } from "./events.js";

const CORE0_MARKER = "; Offset Core0";
const CORE1_MARKER = "; Offset Core1";
/** Matches a `; Offset Core<n> <byte>` header line, extracting core index and offset. */
const OFFSET_RE = /^;\s*Offset Core(\d+)\s+(\d+)\b/;

/**
 * Decodes the textual header preceding the first synchronization sequence.
 */
function headerText(data: Uint8Array): string {
  const sync = findSync(data);
  const end = sync === -1 ? data.byteLength : sync;
  return new TextDecoder("utf-8", { fatal: false }).decode(data.subarray(0, end));
}

/** Tests whether `data` is a combined SEGGER multi-core capture. */
export function isSeggerMulticore(data: Uint8Array): boolean {
  const h = headerText(data);
  return h.includes(CORE0_MARKER) && h.includes(CORE1_MARKER);
}

/** Finds the byte offset of the first run of {@link SYNC_LEN} zero bytes, or -1 if absent. */
function findSync(data: Uint8Array): number {
  let run = 0;
  for (let i = 0; i < data.byteLength; i++) {
    run = data[i] === 0 ? run + 1 : 0;
    if (run === SYNC_LEN) return i - SYNC_LEN + 1;
  }
  return -1;
}

/** Extracts per-core byte offsets indexed by core ID (`Core0` -> 0, `Core1` -> 1). */
function parseOffsets(header: string): number[] {
  const offsets: number[] = [];
  for (const line of header.split("\n")) {
    const m = OFFSET_RE.exec(line.trim());
    if (m) offsets[Number(m[1])] = Number(m[2]);
  }
  return offsets;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Splits a combined SEGGER multi-core capture into per-core SVDAT buffers.
 * Returns `null` if `data` is not a valid multi-core stream or has an incomplete offset table.
 *
 * Each core's byte range spans `[firstSync + offsetN, firstSync + offset(N+1))`
 * (with the final core extending to EOF) and begins with its own synchronization sequence.
 * Prepending the shared header produces standalone single-core streams parseable by {@link parseCoreStream}.
 */
export function splitSeggerMulticore(data: Uint8Array): Uint8Array[] | null {
  if (!isSeggerMulticore(data)) return null;

  const syncStart = findSync(data);
  if (syncStart === -1) return null;

  const offsets = parseOffsets(headerText(data));
  // Require a contiguous Core0..Core(N-1) table (at least two cores).
  if (offsets.length < 2 || offsets.some((o) => o === undefined || Number.isNaN(o))) {
    return null;
  }

  // Prepend the shared textual header to each core's stream slice to produce standalone SVDAT buffers.
  const header = data.subarray(0, syncStart);
  const cores: Uint8Array[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = syncStart + offsets[i]!;
    const end = i + 1 < offsets.length ? syncStart + offsets[i + 1]! : data.byteLength;
    cores.push(concat(header, data.subarray(start, end)));
  }
  return cores;
}
