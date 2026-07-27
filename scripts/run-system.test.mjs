import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTrackerInvocation,
  bundledTrackerPath,
  ensureTracker,
  runSystem,
  superviseChildren,
} from "./run-system.mjs";

test("selects the committed Sony Head Tracker UI for each supported host", () => {
  const prebuilds = join("repo", "assets", "pre-builds");
  const macos = join(
    prebuilds,
    "sony-head-tracker-v2.2.0-macos-universal",
    "SonyHeadTracker.app",
    "Contents",
    "MacOS",
    "SonyHeadTracker",
  );
  assert.equal(bundledTrackerPath(prebuilds, "darwin", "arm64"), macos);
  assert.equal(bundledTrackerPath(prebuilds, "darwin", "x64"), macos);

  const windows = join(
    prebuilds,
    "sony-head-tracker-v2.2.0-windows-x64",
    "sony-head-tracker.exe",
  );
  assert.equal(bundledTrackerPath(prebuilds, "win32", "x64"), windows);
});

test("repository contains usable UI prebuilds for every supported host", async () => {
  const macos = await ensureTracker({ platform: "darwin", arch: "arm64", override: "" });
  const windows = await ensureTracker({ platform: "win32", arch: "x64", override: "" });
  assert.match(
    macos.replaceAll("\\", "/"),
    /sony-head-tracker-v2\.2\.0-macos-universal\/SonyHeadTracker\.app\/Contents\/MacOS\/SonyHeadTracker$/,
  );
  assert.match(
    windows.replaceAll("\\", "/"),
    /sony-head-tracker-v2\.2\.0-windows-x64\/sony-head-tracker\.exe$/,
  );
});

test("uses the committed UI prebuild without downloading or copying it", async () => {
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

test("accepts a Sony UI override path containing spaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "Sony Tracker UI "));
  const executable = join(root, "SonyHeadTracker UI");
  await writeFile(executable, "fixture", { mode: 0o755 });

  assert.equal(
    await ensureTracker({ platform: "darwin", override: executable }),
    executable,
  );
});

test("launches the Sony Head Tracker UI without CLI bridge arguments", () => {
  assert.deepEqual(buildTrackerInvocation("/tmp/SonyHeadTracker UI"), {
    command: "/tmp/SonyHeadTracker UI",
    args: [],
  });
});

test("starts the bundled UI directly before Tauri", async () => {
  const events = [];
  let spawnCount = 0;

  await runSystem({
    platform: "darwin",
    ensure: async () => "/tmp/SonyHeadTracker UI",
    spawnChild: (command, args) => {
      events.push(["spawn", command, ...args]);
      const child = fakeChild();
      spawnCount += 1;
      if (spawnCount === 2) queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  assert.deepEqual(events, [
    ["spawn", "/tmp/SonyHeadTracker UI"],
    ["spawn", "npm", "run", "tauri", "--", "dev"],
  ]);
});

test("starts the bundled Windows UI without CLI arguments", async () => {
  const events = [];
  let spawnCount = 0;

  await runSystem({
    platform: "win32",
    ensure: async () => "C:\\prebuilds\\sony-head-tracker.exe",
    spawnChild: (command, args) => {
      events.push([command, ...args]);
      const child = fakeChild();
      spawnCount += 1;
      if (spawnCount === 2) queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  assert.deepEqual(events[0], ["C:\\prebuilds\\sony-head-tracker.exe"]);
  assert.equal(events[1][0], process.env.ComSpec ?? "cmd.exe");
});

test("rejects hosts without a bundled tracker build", async () => {
  await assert.rejects(
    ensureTracker({ platform: "linux", arch: "x64", override: "" }),
    /no bundled Sony Head Tracker.*linux\/x64/i,
  );
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
