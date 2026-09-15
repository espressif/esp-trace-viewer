/**
 * The `Export ▾` dropdown, built the same way wherever it appears.
 *
 * Each surface that can export something mounts one of these in its own toolbar — the Events/Logs dock
 * header, the Statistics controls, the Timeline controls bar — and supplies the {@link ExportTarget}s it
 * can write. The menu turns each target into one row per file format, so a surface names what it holds and
 * this module decides how the rows are worded, what the file is called and how it reaches the disk.
 *
 * A target's table is taken at the moment the row is chosen, not when the menu opens, so the export is a
 * snapshot of what the surface is showing right then: the same scope, filters and sort order.
 */

import {
  EXPORT_FORMATS,
  downloadText,
  exportFileName,
  serializeTable,
  type TableData,
} from "../core/export.js";
import type { Store } from "../core/store.js";
import { createDropdown, type DropdownHandle, type MenuItem } from "./menu.js";

/** One thing a surface can export. */
export interface ExportTarget {
  /** Noun naming the rows, used in the menu row: `Events as CSV`. */
  label: string;
  /** Filename slug: `dual-core-events.csv`. */
  slug: string;
  /** What the surface is showing, taken when the row is chosen. */
  table: () => TableData;
}

export interface ExportMenuOptions {
  /** Test identifier for the trigger. */
  testid: string;
  /** Trigger text. Defaults to `Export`. */
  label?: string;
  /** The tables on offer, in menu order. Re-read on each open so the menu follows the surface's state. */
  targets: () => readonly ExportTarget[];
  /** Rows placed above the table rows — the timeline's image, for instance. */
  extra?: () => MenuItem[];
}

export function createExportMenu(store: Store, opts: ExportMenuOptions): DropdownHandle {
  return createDropdown({
    label: opts.label ?? "Export",
    testid: opts.testid,
    items: (): MenuItem[] => {
      // Nothing loaded means nothing to write. The rows stay visible and disabled, as the File menu's do.
      const disabled = store.get().model === null;
      const rows: MenuItem[] = [];
      for (const extra of opts.extra?.() ?? []) {
        rows.push({ ...extra, disabled: disabled || !!extra.disabled });
      }
      for (const target of opts.targets()) {
        if (rows.length) rows.push({ separator: true });
        for (const fmt of EXPORT_FORMATS) {
          rows.push({
            label: `${target.label} as ${fmt.label}`,
            testid: `export-${target.slug}-${fmt.id}`,
            disabled,
            onSelect: () => {
              const name = exportFileName(store.get().sourceNames, target.slug, fmt.ext);
              downloadText(name, serializeTable(target.table(), fmt.id), fmt.mime);
            },
          });
        }
      }
      return rows.length ? rows : [{ label: "Nothing to export", disabled: true }];
    },
  });
}
