/**
 * On/off toolbar button with a leading state tick.
 *
 * Every toggle in the shell — the lane group quick filters, the Lanes panel, Events/Logs, Overview, the dock's Context filter — shows the same thing when it is on, so that "on" reads the same wherever it appears rather than meaning a tick in one place and a filled button in another.
 */

import { el } from "../trace-ui-toolkit/ui/dom.js";

export interface ToggleButtonOptions {
  /** Button text. */
  label: string;
  /** Test identifier attribute. */
  testid?: string;
  /** Tooltip text. */
  title?: string;
  /** Invoked on click. The caller flips the state and calls {@link ToggleButtonHandle.setOn}. */
  onClick: () => void;
}

export interface ToggleButtonHandle {
  /** The button element. */
  el: HTMLElement;
  /** Reflect the current state. */
  setOn(on: boolean): void;
  /** Replace the tooltip. */
  setTitle(title: string): void;
}

export function toggleButton(opts: ToggleButtonOptions): ToggleButtonHandle {
  const tick = el("span", { class: "tb-tick", "aria-hidden": "true" });
  const button = el(
    "button",
    {
      class: "tb-btn tb-toggle",
      type: "button",
      ...(opts.testid ? { "data-testid": opts.testid } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      onclick: () => opts.onClick(),
    },
    [tick, el("span", { text: opts.label })],
  );

  return {
    el: button,
    setOn(on: boolean): void {
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
      tick.textContent = on ? "✓" : "−";
    },
    setTitle(title: string): void {
      button.title = title;
    },
  };
}
