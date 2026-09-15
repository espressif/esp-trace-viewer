/**
 * Writing what a surface is showing out to a file.
 *
 * Each export surface — the Events and Logs lists, the Statistics table, the timeline — hands this module
 * a {@link TableData}: the columns it draws, in the order it draws them, holding the same strings it drew
 * in them. Serialization and the download itself are shared, so a row exported from one surface is spelled
 * and punctuated like a row exported from another.
 *
 * Exports carry display strings rather than raw numbers, so a `.csv` reads the way the table read: `1.234 ms`
 * rather than `0.001234`. The CSV is prefixed with a byte-order mark because these tables are full of `µs`.
 */

import { el } from "../trace-ui-toolkit/ui/dom.js";

/** One column of an exported table. `key` names it in JSON; `label` is the on-screen header. */
export interface ExportColumn {
  key: string;
  label: string;
}

/** A rectangular table of display strings. Every row has one cell per column, in column order. */
export interface TableData {
  columns: readonly ExportColumn[];
  rows: readonly (readonly string[])[];
}

/** File formats every table export offers. */
export type ExportFormat = "csv" | "json" | "md";

/** Menu wording, file extension and media type for one {@link ExportFormat}. */
export interface ExportFormatSpec {
  id: ExportFormat;
  label: string;
  ext: string;
  mime: string;
}

/** The offered formats, in menu order. */
export const EXPORT_FORMATS: readonly ExportFormatSpec[] = [
  { id: "csv", label: "CSV", ext: "csv", mime: "text/csv;charset=utf-8" },
  { id: "json", label: "JSON", ext: "json", mime: "application/json" },
  { id: "md", label: "Markdown", ext: "md", mime: "text/markdown;charset=utf-8" },
];

/**
 * Byte-order mark opening every CSV.
 *
 * Spreadsheets that open a `.csv` without one guess a legacy code page, and these tables are full of `µs`
 * and thin-space thousands separators that the guess gets wrong.
 */
const BOM = "\uFEFF";

/** Quote a CSV field when it holds a delimiter, a quote or a line break, doubling any quotes inside it. */
function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize a table as RFC 4180 CSV with a header row. */
export function toCsv(t: TableData): string {
  const lines = [t.columns.map((c) => csvCell(c.label)).join(",")];
  for (const r of t.rows) lines.push(r.map(csvCell).join(","));
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** Serialize a table as an array of objects keyed by {@link ExportColumn.key}. */
export function toJson(t: TableData): string {
  const objs = t.rows.map((r) =>
    Object.fromEntries(t.columns.map((c, i) => [c.key, r[i] ?? ""])),
  );
  return `${JSON.stringify(objs, null, 2)}\n`;
}

/** Escape pipes, backslashes and line breaks for a GitHub-flavored Markdown table cell. */
function mdCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/** Serialize a table as a GitHub-flavored Markdown table. */
export function toMarkdown(t: TableData): string {
  const header = `| ${t.columns.map((c) => mdCell(c.label)).join(" | ")} |`;
  const sep = `| ${t.columns.map(() => "---").join(" | ")} |`;
  const body = t.rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

/** Serialize a table in the requested format. */
export function serializeTable(t: TableData, fmt: ExportFormat): string {
  if (fmt === "csv") return toCsv(t);
  if (fmt === "json") return toJson(t);
  return toMarkdown(t);
}

/** Hand `blob` to the browser as a download named `name`. */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name, class: "visually-hidden" });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Download `text` as a file named `name`. */
export function downloadText(name: string, text: string, mime: string): void {
  downloadBlob(name, new Blob([text], { type: mime }));
}

/**
 * Download a canvas as a PNG on `background`.
 *
 * The panes clear their canvas rather than filling it, so everything they did not draw on is transparent
 * and a PNG of it would take the colour of whatever it was later shown against — which in the dark theme
 * is the wrong one. Copying onto a filled canvas first gives the file the background it was drawn over.
 *
 * Encoding is asynchronous, so the download starts a moment after the call.
 */
export function downloadCanvasPng(
  canvas: HTMLCanvasElement,
  name: string,
  background: string,
): void {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  out.toBlob((blob) => {
    if (blob) downloadBlob(name, blob);
  }, "image/png");
}

/**
 * Name an export after the capture it came from: `dual-core.svdat` plus `events` plus `csv` gives
 * `dual-core-events.csv`. Falls back to `trace` when nothing is open or the source name is unusable.
 */
export function exportFileName(sourceNames: readonly string[], slug: string, ext: string): string {
  const base =
    (sourceNames[0] ?? "")
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "trace";
  return `${base}-${slug}.${ext}`;
}
