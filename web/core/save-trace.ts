/**
 * Exports loaded trace buffers as `.svdat` files for download.
 *
 * Preserves raw source buffers so opened files download in their original state. Active lane layouts can be embedded into the textual header prior to export via {@link ./lanes/svdat-embed.embedLayoutInHeader}, preserving event stream payloads and compatibility with other `.svdat` readers.
 *
 * {@link saveTargets} associates buffers with valid filenames, and {@link downloadTrace} triggers browser file downloads.
 */

import { el } from "../trace-ui-toolkit/ui/dom.js";

/** Export target containing raw file bytes and destination filename. */
export interface SaveTarget {
  bytes: Uint8Array;
  name: string;
}

/**
 * Associate buffers with filenames, applying fallback names and ensuring a `.svdat` file extension.
 */
export function saveTargets(buffers: Uint8Array[], names: string[] = []): SaveTarget[] {
  return buffers.map((bytes, i) => {
    const fallback = buffers.length > 1 ? `trace-${i}.svdat` : "trace.svdat";
    const raw = names[i]?.trim() || fallback;
    const name = raw.toLowerCase().endsWith(".svdat") ? raw : `${raw}.svdat`;
    return { bytes, name };
  });
}

/**
 * Trigger browser file downloads for all specified trace buffers.
 */
export function downloadTrace(buffers: Uint8Array[], names: string[] = []): void {
  for (const { bytes, name } of saveTargets(buffers, names)) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
    const a = el("a", { href: url, download: name, class: "visually-hidden" });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}
