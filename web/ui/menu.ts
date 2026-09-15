/**
 * Menu bar dropdown component that opens a popup menu on trigger interaction.
 *
 * Rebuilds the item list on each open to reflect live store state. Supports checkable rows, accelerator labels, separators, and disabled rows. Dismisses on outside pointer interaction or Escape. Keyboard accessible via Enter, Space, and Escape.
 *
 * The popup is positioned against the viewport rather than the trigger, and clamped to stay inside it. A menu
 * bar dropdown is laid out inside a pane that clips its overflow — the Events/Logs dock does — and triggers
 * near the window's right edge would otherwise open a popup that is half cut off and half off-screen.
 */

import { clear, el } from "../trace-ui-toolkit/ui/dom.js";

/** A dropdown menu item or separator. */
export interface MenuItem {
  /** Non-interactive separator. When true, other item fields are ignored. */
  separator?: boolean;
  /** Row text. */
  label?: string;
  /** Accelerator hint text (display only). */
  accel?: string;
  /** Display a leading checkmark and mark the row as checked. */
  checked?: boolean;
  /** Render the row as disabled and non-interactive. */
  disabled?: boolean;
  /** Test identifier attribute for testing hooks. */
  testid?: string;
  /** Callback invoked when the row is selected. */
  onSelect?: () => void;
}

/** Mounted dropdown handle containing wrapper element and programmatic close method. */
export interface DropdownHandle {
  /** The wrapper (trigger + popup) to insert into the menu bar. */
  el: HTMLElement;
  /** Close the popup if open. */
  close(): void;
}

export function createDropdown(opts: {
  /** Trigger text displayed in the menu bar. */
  label: string;
  /** Test identifier attribute for the trigger element. */
  testid?: string;
  /** Item factory invoked on each open to provide current menu state. */
  items: () => MenuItem[];
}): DropdownHandle {
  const trigger = el("span", {
    class: "menu-item menu-trigger",
    role: "button",
    tabindex: 0,
    "aria-haspopup": "true",
    "aria-expanded": "false",
    text: opts.label,
    ...(opts.testid ? { "data-testid": opts.testid } : {}),
  });
  const popup = el("div", { class: "menu-popup", role: "menu" });
  popup.hidden = true;
  const wrap = el("div", { class: "menu-wrap" }, [trigger, popup]);

  let open = false;

  const onDocDown = (e: Event): void => {
    if (!wrap.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      close();
      trigger.focus();
    }
  };

  function close(): void {
    if (!open) return;
    open = false;
    popup.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
  }

  /** Gap between the popup and the trigger, and the smallest margin it keeps to the window edge, in px. */
  const GAP = 4;
  const MARGIN = 6;

  /** Place the open popup below its trigger, nudged back inside the window when it would overhang. */
  const place = (): void => {
    const r = trigger.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = popup;
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - w - MARGIN));
    // Flip above the trigger rather than run off the bottom of the window.
    const below = r.bottom + GAP;
    const top = below + h + MARGIN <= window.innerHeight ? below : Math.max(MARGIN, r.top - GAP - h);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  };

  const build = (): void => {
    clear(popup);
    for (const it of opts.items()) {
      if (it.separator) {
        popup.append(el("div", { class: "menu-sep", role: "separator" }));
        continue;
      }
      popup.append(
        el(
          "button",
          {
            class: `menu-row${it.checked ? " is-checked" : ""}`,
            type: "button",
            role: "menuitemcheckbox",
            "aria-checked": it.checked ? "true" : "false",
            ...(it.disabled ? { disabled: true } : {}),
            ...(it.testid ? { "data-testid": it.testid } : {}),
            onclick: () => {
              close();
              it.onSelect?.();
            },
          },
          [
            el("span", { class: "menu-check", text: it.checked ? "✓" : "" }),
            el("span", { class: "menu-label", text: it.label ?? "" }),
            el("span", { class: "menu-accel", text: it.accel ?? "" }),
          ],
        ),
      );
    }
  };

  const openMenu = (): void => {
    if (open) return;
    open = true;
    build();
    popup.hidden = false;
    // Placement has to measure the popup, so it runs after the rows are in and the popup is laid out.
    place();
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    // A resize relays the bar the trigger sits in, leaving the popup pointing at nothing.
    window.addEventListener("resize", close);
  };

  trigger.addEventListener("click", () => (open ? close() : openMenu()));
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open ? close() : openMenu();
    }
  });

  return { el: wrap, close };
}
