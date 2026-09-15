/**
 * Global keyboard shortcuts for zoom and pan on the shared time axis.
 *
 * `+` and `-` step the zoom level, `0` fits the recording to the viewport, and `←` / `→` pan by a fraction of the window. Zoom steps center on the cursor timestamp if active, or on the window midpoint. Dispatches operations through {@link ../core/zoom}.
 *
 * Shortcuts are registered on `document` and ignored when modifier keys are pressed or when focus is inside text inputs.
 */

import type { Store } from "../core/store.js";
import type { TimeScale } from "../trace-ui-toolkit/time-scale.js";
import { PAN_STEP_FRAC, panByFraction, zoomIn, zoomOut, zoomToFit } from "../core/zoom.js";

export interface ZoomKeysHandle {
  /** Remove the global key listener. */
  dispose(): void;
}

export function installZoomKeys(store: Store, timeScale: TimeScale): ZoomKeysHandle {
  const onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return; // Ignore browser or OS modifier shortcuts.
    const center = store.get().cursorTime; // Center zoom on cursor timestamp when present.
    switch (e.key) {
      case "+":
      case "=": // Unshifted key for '+' on US keyboards.
        e.preventDefault();
        zoomIn(store, timeScale, center);
        break;
      case "-":
      case "_":
        e.preventDefault();
        zoomOut(store, timeScale, center);
        break;
      case "0":
        e.preventDefault();
        zoomToFit(store, timeScale);
        break;
      case "ArrowLeft":
        e.preventDefault();
        panByFraction(store, timeScale, -PAN_STEP_FRAC);
        break;
      case "ArrowRight":
        e.preventDefault();
        panByFraction(store, timeScale, PAN_STEP_FRAC);
        break;
      default:
        return;
    }
  };
  document.addEventListener("keydown", onKey);
  return { dispose: () => document.removeEventListener("keydown", onKey) };
}
