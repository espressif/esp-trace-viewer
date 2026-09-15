/**
 * Persist a {@link LaneLayout} inside a `.svdat` file.
 *
 * Embeds layout configuration in the file's textual header as a base64 comment line:
 *
 * ```
 * ; trace-lanes <base64(JSON)>
 * ```
 *
 * Other `.svdat` readers scan comment lines (`#` or `;`) only for known header keys and ignore unrecognized comment lines. Base64 encoding avoids separator collisions with commas, semicolons, and newlines.
 *
 * {@link embedLayoutInHeader} modifies only the textual header before the initial sync sequence, leaving binary event payloads unchanged. In multicore files, `; Offset CoreN` values remain valid because offsets are measured relative to the first sync sequence.
 */

import { SYNC_LEN } from "../../../src/trace/events.js";
import { type LaneLayout, parseLayout, serializeLayout } from "./types.js";

/** Header comment prefix for embedded layout data. Version metadata resides in the JSON payload. */
const MARKER = "; trace-lanes ";

/** Regular expression matching layout marker comments and capturing base64 payload. */
const MARKER_RE = /^;\s*trace-lanes\s+(\S+)/;

/** Return true if line is a header separator (`;`). */
const isSeparator = (line: string): boolean => line.trim() === ";";

/**
 * Find the byte offset of the initial zero-byte sync sequence (length {@link SYNC_LEN}), or -1 if absent. Textual header content precedes this offset.
 */
function findSync(data: Uint8Array): number {
  let run = 0;
  for (let i = 0; i < data.byteLength; i++) {
    run = data[i] === 0 ? run + 1 : 0;
    if (run === SYNC_LEN) return i - SYNC_LEN + 1;
  }
  return -1;
}

/** Encode UTF-8 text to base64. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Decode base64 to UTF-8 text, returning `null` on invalid input. */
function decodeBase64(b64: string): string | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Embed the {@link LaneLayout} into trace file bytes as a `; trace-lanes` header comment line before the closing separator.
 *
 * Drops existing layout marker lines before insertion. Preserves binary event payloads. Returns original bytes unchanged if the file lacks a sync sequence or closing separator.
 */
export function embedLayoutInHeader(bytes: Uint8Array, layout: LaneLayout): Uint8Array {
  const sync = findSync(bytes);
  if (sync < 0) return bytes;

  const headerText = new TextDecoder().decode(bytes.subarray(0, sync));
  const tail = bytes.subarray(sync);

  const lines = headerText.split("\n").filter((line) => !MARKER_RE.test(line));
  // Insert before the closing separator within the comment block.
  let closeIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isSeparator(lines[i]!)) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return bytes;

  // Preserve surrounding line ending conventions (CRLF or LF).
  const crlf = lines[closeIdx]!.endsWith("\r");
  lines.splice(closeIdx, 0, `${MARKER}${encodeBase64(serializeLayout(layout))}${crlf ? "\r" : ""}`);

  const newHeader = new TextEncoder().encode(lines.join("\n"));
  const out = new Uint8Array(newHeader.byteLength + tail.byteLength);
  out.set(newHeader, 0);
  out.set(tail, newHeader.byteLength);
  return out;
}

/**
 * Extract an embedded {@link LaneLayout} from the trace header comment.
 *
 * Returns `null` if missing, invalid, or unrecognized, allowing fallback to {@link ./default-layout.buildDefaultLayout}.
 */
export function extractLayoutFromHeader(bytes: Uint8Array): LaneLayout | null {
  // Limit scan to header text preceding the binary sync sequence.
  const sync = findSync(bytes);
  const end = sync < 0 ? Math.min(bytes.byteLength, 8192) : sync;
  const headerText = new TextDecoder().decode(bytes.subarray(0, end));
  for (const line of headerText.split("\n")) {
    const m = MARKER_RE.exec(line);
    if (!m) continue;
    const json = decodeBase64(m[1]!);
    const layout = json === null ? null : parseLayout(json);
    if (layout) return layout;
  }
  return null;
}
