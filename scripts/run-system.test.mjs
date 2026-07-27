import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildProbeInvocation,
  buildTrackerInvocation,
  bundledTrackerPath,
  ensureTracker,
  runSystem,
  superviseChildren,
} from "./run-system.mjs";

test("selects the committed Sony Head Tracker prebuild for each supported host", () => {
  const prebuilds = join("repo", "assets", "pre-builds");
  assert.equal(
    bundledTrackerPath(prebuilds, "darwin", "arm64"),
    join(
      prebuilds,
      "sony-head-tracker-v2.2.0-macos-universal",
      "sony-head-tracker-macos",
    ),
  );
  assert.equal(
    bundledTrackerPath(prebuilds, "darwin", "x64"),
    join(
      prebuilds,
      "sony-head-tracker-v2.2.0-macos-universal",
      "sony-head-tracker-macos",
    ),
  );
  assert.equal(
    bundledTrackerPath(prebuilds, "win32", "x64"),
    join(
      prebuilds,
      "sony-head-tracker-v2.2.0-windows-x64",
      "sony-head-tracker.exe",
    ),
  );
});

test("repository contains usable prebuilds for every supported host", async () => {
  const macos = await ensureTracker({ platform: "darwin", arch: "arm64", override: "" });
  const windows = await ensureTracker({ platform: "win32", arch: "x64", override: "" });
  assert.match(
    macos.replaceAll("\\", "/"),
    /sony-head-tracker-v2\.2\.0-macos-universal\/sony-head-tracker-macos$/,
  );
  assert.match(
    windows.replaceAll("\\", "/"),
    /sony-head-tracker-v2\.2\.0-windows-x64\/sony-head-tracker\.exe$/,
  );
});

test("uses the committed prebuild without downloading or copying it", async () => {
  const prebuildsRoot = await mkdtemp(join(tmpdir(), "sony-prebuilds-"));
  const executable = bundledTrackerPath(prebuildsRoot, "darwin", "arm64");
  await mkdir(join(executable, ".."), { recursive: true });
  await writeFile(executable, "fixture", { mode: 0o755 });

  assert.equal(
    await ensureTracker({
      platform: "darwin",
      arch: "arm64",
      override: "",
      prebuildsRoot,
    }),
    executable,
  );
});

test("launches the external tracker bridge on the JSON compatibility port", () => {
  assert.deepEqual(buildTrackerInvocation("/tmp/sony tracker"), {
    command: "/tmp/sony tracker",
    args: ["bridge", "--port", "4242"],
  });
});

test("probes for verified hardware before starting either application", () => {
  assert.deepEqual(buildProbeInvocation("/path with spaces/tracker"), {
    command: "/path with spaces/tracker",
    args: ["probe"],
  });
});

test("rejects hosts without a bundled tracker build", async () => {
  await assert.rejects(
    ensureTracker({ platform: "linux", arch: "x64", override: "" }),
    /no bundled Sony Head Tracker.*linux\/x64/i,
  );
});

test("a failed probe prevents both long-lived processes from spawning", async () => {
  const events = [];
  await assert.rejects(
    runSystem({
      platform: "darwin",
      ensure: async () => "/tmp/tracker with spaces",
      run: async (command, args) => {
        events.push([command, ...args]);
        throw new Error("probe: no verified device");
      },
      spawnChild: () => {
        events.push("spawned");
        throw new Error("should not spawn");
      },
    }),
    /probe: no verified device/,
  );
  assert.deepEqual(events, [["/tmp/tracker with spaces", "probe"]]);
});

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test("an app exit stops the tracker and forwards the app exit code", async () => {
  const tracker = fakeChild();
  const tauri = fakeChild();
  const host = new EventEmitter();
  host.exitCode = null;
  const stopped = [];
  const completion = superviseChildren({
    tracker,
    tauri,
    platform: "darwin",
    host,
    terminateChild: async (child) => stopped.push(child),
  });

  tauri.emit("exit", 7, null);
  assert.equal(await completion, 7);
  assert.deepEqual(stopped, [tauri, tracker]);
  assert.equal(host.exitCode, 7);
});

test("a tracker failure stops Tauri and reports failure", async () => {
  const tracker = fakeChild();
  const tauri = fakeChild();
  const host = new EventEmitter();
  host.exitCode = null;
  const stopped = [];
  const completion = superviseChildren({
    tracker,
    tauri,
    platform: "win32",
    host,
    terminateChild: async (child) => stopped.push(child),
  });

  tracker.emit("exit", 2, null);
  assert.equal(await completion, 2);
  assert.deepEqual(stopped, [tauri, tracker]);
});

test("Ctrl+C cleans up both process trees", async () => {
  const tracker = fakeChild();
  const tauri = fakeChild();
  const host = new EventEmitter();
  host.exitCode = null;
  const stopped = [];
  const completion = superviseChildren({
    tracker,
    tauri,
    platform: "darwin",
    host,
    terminateChild: async (child) => stopped.push(child),
  });

  host.emit("SIGINT");
  assert.equal(await completion, 130);
  assert.deepEqual(stopped, [tauri, tracker]);
});

test("a cleanup error cannot prevent the launcher from completing shutdown", async () => {
  const tracker = fakeChild();
  const tauri = fakeChild();
  const host = new EventEmitter();
  host.exitCode = null;
  let attempts = 0;
  const completion = superviseChildren({
    tracker,
    tauri,
    platform: "darwin",
    host,
    terminateChild: async () => {
      attempts += 1;
      throw new Error("fixture cleanup failure");
    },
  });

  host.emit("SIGTERM");
  assert.equal(await completion, 143);
  assert.equal(attempts, 2);
});
