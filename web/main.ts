/**
 * Browser entry point.
 *
 * Mounts the application shell and loads any fixture named in the URL `?fixture=` parameter. Fixture configurations and loaders are defined in {@link ./core/fixtures}.
 *
 * When starting without a fixture parameter, the application displays the welcome modal unless disabled by user preference.
 */

import { mountApp } from "./app.js";
import { loadFixture } from "./core/fixtures.js";
import { configureLayoutStorage } from "./trace-ui-toolkit/layout-store.js";

// Configure storage key for persisting splitter positions and pane collapse states.
configureLayoutStorage({ key: "trace-viewer.layout.v1" });

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app root");
  const app = mountApp(root);

  const params = new URLSearchParams(location.search);
  const fixture = params.get("fixture");
  if (fixture) await loadFixture(app, fixture);
  // Display the welcome modal on startup when no fixture is loaded, unless disabled by user preference.
  else app.maybeShowWelcome();
}

void main();
