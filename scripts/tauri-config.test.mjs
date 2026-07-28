import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url);
const cargoUrl = new URL("../apps/desktop/src-tauri/Cargo.toml", import.meta.url);

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
