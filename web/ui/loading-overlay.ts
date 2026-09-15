/**
 * Loading overlay with backdrop, spinner, stage label, and optional progress bar.
 *
 * Handles two operation profiles:
 * - Downloads stream byte updates into {@link LoadingOverlayHandle.setProgress} to update a determinate progress bar.
 * - Parsing executes synchronously on the main thread. {@link LoadingOverlayHandle.show} resolves after the label paints (via double `requestAnimationFrame`) so callers can await paint completion before initiating synchronous processing.
 */

import { el } from "../trace-ui-toolkit/ui/dom.js";

/** A mounted loading overlay: the element plus show/hide control. */
export interface LoadingOverlayHandle {
  /** The overlay element to place at the app root. */
  el: HTMLElement;
  /**
   * Show the overlay with the given stage label and clear previous progress bar state. Resolves after the label paints to prevent subsequent synchronous work from blocking the paint.
   */
  show(label: string): Promise<void>;
  /**
   * Update download progress for the current stage. Displays a determinate progress bar and percentage when total is positive.
   */
  setProgress(received: number, total: number): void;
  /** Hide the overlay. */
  hide(): void;
}

/** Resolve after the next frame paints via double requestAnimationFrame. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function createLoadingOverlay(): LoadingOverlayHandle {
  const label = el("span", { "data-testid": "loading-label" });
  const pct = el("span", { class: "loading-pct", "data-testid": "loading-pct" });
  // Progress bar element, hidden during stages without byte metrics.
  const bar = el("progress", {
    class: "welcome-flash-bar loading-bar",
    "data-testid": "loading-bar",
  }) as HTMLProgressElement;
  bar.hidden = true;
  const overlay = el(
    "div",
    { class: "loading-overlay", "data-testid": "loading-overlay" },
    [
      el("div", { class: "loading-dialog", role: "alert", "aria-busy": "true" }, [
        el("div", { class: "loading-status" }, [
          el("span", { class: "welcome-spinner", "aria-hidden": "true" }),
          label,
          pct,
        ]),
        bar,
      ]),
    ],
  );
  overlay.hidden = true;

  return {
    el: overlay,
    async show(text: string): Promise<void> {
      label.textContent = text;
      pct.textContent = "";
      bar.hidden = true;
      bar.removeAttribute("value"); // Reset to indeterminate state.
      overlay.hidden = false;
      await nextPaint();
    },
    setProgress(received: number, total: number): void {
      if (overlay.hidden || total <= 0) return;
      bar.hidden = false;
      bar.max = total;
      // Clamp received bytes to total to prevent progress overflow.
      bar.value = Math.min(received, total);
      pct.textContent = `${Math.round((bar.value / total) * 100)}%`;
    },
    hide(): void {
      overlay.hidden = true;
    },
  };
}
