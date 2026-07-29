import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url);
const cargoUrl = new URL("../apps/desktop/src-tauri/Cargo.toml", import.meta.url);
const libSourceUrl = new URL("../apps/desktop/src-tauri/src/lib.rs", import.meta.url);
const overlaySourceUrl = new URL("../apps/desktop/src-tauri/src/overlay.rs", import.meta.url);

test("defines a hidden transparent non-focusable always-on-top overlay window", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const overlay = config.app.windows.find((window) => window.label === "overlay");

  assert.ok(overlay, "overlay window is configured");
  assert.equal(overlay.url, "index.html?window=overlay");
  assert.equal(overlay.transparent, true);
  assert.equal(overlay.decorations, false);
  assert.equal(overlay.alwaysOnTop, true);
  assert.equal(overlay.visible, false);
  assert.equal(overlay.focus, false);
  assert.equal(overlay.resizable, false);
  assert.equal(overlay.skipTaskbar, true);
  assert.equal(config.app.macOSPrivateApi, true, "macOS transparency support is enabled");

  const cargoManifest = await readFile(cargoUrl, "utf8");
  assert.match(cargoManifest, /tauri\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*"macos-private-api"/,
    "the matching Tauri Cargo feature is enabled");
});

test("positions the volume overlay at the active screen's top-right before showing it", async () => {
  const overlaySource = await readFile(overlaySourceUrl, "utf8");

  assert.match(
    overlaySource,
    /fn show[\s\S]*position_window_at_top_right\([^)]+\)\?[\s\S]*window\.show\(\)/,
    "showing the overlay must first position it at the active screen's top-right",
  );
});

test("closing the main UI exits Tauri even while the hidden overlay window exists", async () => {
  const libSource = await readFile(libSourceUrl, "utf8");

  assert.match(
    libSource,
    /on_window_event[\s\S]*label\(\)\s*==\s*MAIN_WINDOW[\s\S]*CloseRequested[\s\S]*app_handle\(\)\.exit\(0\)/,
    "the main window close request must terminate the full Tauri process",
  );
});

test("wires keyboard adjustments to the platform volume controller", async () => {
  const [libSource, overlaySource] = await Promise.all([
    readFile(libSourceUrl, "utf8"),
    readFile(overlaySourceUrl, "utf8"),
  ]);

  assert.match(libSource, /manage\(overlay::VolumeRuntime::default\(\)\)/);
  assert.match(libSource, /overlay::adjust_system_volume/);
  assert.match(
    overlaySource,
    /pub fn adjust_system_volume[\s\S]*runtime\.adjust_system_volume/,
    "the Tauri command must delegate through the serialized overlay runtime",
  );
});
