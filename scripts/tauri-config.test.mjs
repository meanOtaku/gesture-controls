import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url);
const cargoUrl = new URL("../apps/desktop/src-tauri/Cargo.toml", import.meta.url);
const libSourceUrl = new URL("../apps/desktop/src-tauri/src/lib.rs", import.meta.url);
const overlaySourceUrl = new URL("../apps/desktop/src-tauri/src/overlay.rs", import.meta.url);

// Extracts a fn's full body by brace-counting rather than matching a specific
// line-ending/indentation shape, so the assertions survive reformatting and
// CRLF checkouts (e.g. Windows CI) instead of being coupled to exact source text.
function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  const braceStart = source.indexOf("{", start);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

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

test("commits refreshed show state only after fallible window operations succeed", async () => {
  const overlaySource = await readFile(overlaySourceUrl, "utf8");
  const showBody = extractFunctionBody(overlaySource, "fn show(");

  assert.ok(showBody, "the overlay show implementation exists");
  assert.ok(
    showBody.indexOf(".lock()") < showBody.indexOf("available_volume"),
    "show must serialize its native volume read with overlay mutations",
  );
  assert.ok(
    showBody.indexOf("commit_visibility_after") < showBody.indexOf("state.volume ="),
    "show must not mutate volume before prepare, position, and native show have succeeded",
  );
  const volumeCommit = showBody.indexOf("state.volume =");
  const generationAfterVolume = showBody.indexOf("state_generation.fetch_add", volumeCommit);
  assert.ok(
    volumeCommit < generationAfterVolume,
    "show must invalidate admitted refreshes after committing its volume",
  );
});

test("every way out of the app releases the watch transports before exiting", async () => {
  const libSource = await readFile(libSourceUrl, "utf8");

  // Closing the main window defers to the shared graceful exit instead of ending the process.
  assert.match(
    libSource,
    /on_window_event[\s\S]*label\(\)\s*==\s*MAIN_WINDOW[\s\S]*CloseRequested[\s\S]*prevent_close\(\)[\s\S]*exit_gracefully\(/,
    "the main window close request must go through the graceful exit",
  );
  // The graceful exit stops both transports (disconnecting Bluetooth) and only then exits.
  assert.match(
    libSource,
    /fn exit_gracefully[\s\S]*WatchBridgeServer[\s\S]*server\.stop_ble\(\)\.await[\s\S]*server\.stop\(\)\.await[\s\S]*handle\.exit\(0\)/,
    "the graceful exit must stop the watch bridge before terminating Tauri",
  );
  // Terminal and launcher signals take the same path, and so does Cmd+Q.
  assert.match(libSource, /TerminationSignals::register\(\)[\s\S]*exit_gracefully\(/);
  assert.match(
    libSource,
    /RunEvent::ExitRequested[\s\S]*prevent_exit\(\)[\s\S]*exit_gracefully\(/,
    "a quit request must be held until the transports are released",
  );
});

test("wires keyboard adjustments and live refresh to the platform volume controller", async () => {
  const [libSource, overlaySource] = await Promise.all([
    readFile(libSourceUrl, "utf8"),
    readFile(overlaySourceUrl, "utf8"),
  ]);

  assert.match(libSource, /manage\(overlay::VolumeRuntime::default\(\)\)/);
  assert.match(libSource, /overlay::adjust_system_volume/);
  assert.match(libSource, /overlay::refresh_system_volume/);
  assert.match(
    overlaySource,
    /pub fn adjust_system_volume[\s\S]*runtime\.adjust_system_volume/,
    "the Tauri adjustment command must delegate through the serialized overlay runtime",
  );
  assert.match(
    overlaySource,
    /pub async fn refresh_system_volume[\s\S]*runtime\.refresh_system_volume/,
    "the refresh command must delegate through the serialized overlay runtime",
  );
  assert.match(
    overlaySource,
    /pub async fn refresh_system_volume[\s\S]*compare_exchange[\s\S]*state_generation[\s\S]*\};[\s\S]*spawn_blocking/,
    "refresh admission must be gated and overlay state scoped before a blocking task is spawned",
  );
  assert.match(
    overlaySource,
    /fn refresh_system_volume[\s\S]*available_volume[\s\S]*state_generation/,
    "refresh must validate its generation after reading native volume",
  );
  // The adjustment is split into three steps so the overlay state lock is never
  // held across the blocking native call (a hung audio adapter must not stall
  // hide/release): a gate that bumps the generation, the native call, and a
  // publish that commits state. The invariants asserted are unchanged.
  const adjustBody = extractFunctionBody(overlaySource, "fn adjust_system_volume(");
  const gateBody = extractFunctionBody(overlaySource, "fn require_visible_for_write(");
  const publishBody = extractFunctionBody(overlaySource, "fn publish_native_write(");
  assert.ok(adjustBody, "the overlay adjustment implementation exists");
  assert.ok(gateBody, "the pre-write gate exists");
  assert.ok(publishBody, "the post-write publish exists");

  assert.ok(
    gateBody.includes("state_generation.fetch_add"),
    "the gate must invalidate older refreshes",
  );
  assert.ok(
    !gateBody.includes("adjust_native_volume") && !gateBody.includes("set_native_volume"),
    "the gate must not perform native I/O",
  );
  assert.ok(
    adjustBody.indexOf("require_visible_for_write") < adjustBody.indexOf("adjust_native_volume"),
    "an adjustment attempt must invalidate older refreshes before native I/O can partially succeed",
  );
  assert.ok(
    adjustBody.indexOf("adjust_native_volume") < adjustBody.indexOf("publish_native_write"),
    "adjustment state must commit only after native I/O has returned",
  );
  assert.ok(
    !publishBody.includes("adjust_native_volume") && !publishBody.includes("set_native_volume"),
    "publishing state must never perform native I/O",
  );
  assert.ok(
    publishBody.indexOf("Ok(volume_percent)") !== -1 &&
      publishBody.indexOf("Ok(volume_percent)") < publishBody.indexOf("state.volume ="),
    "state.volume is only assigned on the success arm",
  );
  for (const signature of ["fn release_matching(", "fn hide("]) {
    const body = extractFunctionBody(overlaySource, signature);
    assert.ok(body, `${signature} exists`);
    assert.ok(
      !body.includes("native_write_lock"),
      `${signature} must not take the native write lock, or a hung audio adapter would stall cancellation`,
    );
  }
});
