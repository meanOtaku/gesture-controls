import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASES,
  buildProbeInvocation,
  buildTrackerInvocation,
  findTrackerExecutable,
  ensureTracker,
  runSystem,
  superviseChildren,
  verifyCachedTracker,
  verifySha256,
} from "./run-system.mjs";

test("pins verified Sony Head Tracker release assets for macOS and Windows x64", () => {
  assert.equal(RELEASES.version, "2.2.0");
  assert.match(RELEASES.darwin.url, /v2\.2\.0\/sony-head-tracker-v2\.2\.0-macos-universal\.zip$/);
  assert.equal(RELEASES.darwin.sha256, "9a3d0418a9bda4073a1312ce0622264b6cef7989cd0050a67361e44634eb2d2e");
  assert.equal(RELEASES.darwin.executableSha256, "396897fc98415992c816952fa47ad59b2074a7b69b87ff1991083b94cd9faf93");
  assert.match(RELEASES.win32.url, /v2\.2\.0\/sony-head-tracker-v2\.2\.0-windows-x64\.zip$/);
  assert.equal(RELEASES.win32.sha256, "ff75f6b2bae17535c6ac8a2860129ee2b27e710972423efd64655f9d2488598e");
  assert.equal(RELEASES.win32.executableSha256, "1a6c308e2c02f1039d837311eba81d1f562d0b60ec66e6f71e1b7933f2e46a55");
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

test("finds the stable extracted macOS CLI inside the pinned release directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "sony-launcher-"));
  const executable = join(
    root,
    "sony-head-tracker-v2.2.0-macos-universal",
    "sony-head-tracker-macos",
  );
  await mkdir(join(executable, ".."), { recursive: true });
  await writeFile(executable, "fixture");

  assert.equal(await findTrackerExecutable(root, "darwin"), executable);
});

test("finds the Windows x64 executable in the official archive layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "sony-release-"));
  const executable = join(root, "sony-head-tracker.exe");
  await writeFile(executable, "fixture");
  assert.equal(await findTrackerExecutable(root, "win32"), executable);
});

test("rejects automatic hardware setup on Linux", async () => {
  await assert.rejects(
    ensureTracker({ platform: "linux", override: "" }),
    /unavailable on Linux/i,
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

test("accepts the pinned archive digest and rejects modified downloads", () => {
  const bytes = Buffer.from("verified fixture");
  const digest = "f9adb7d924ed98c558040c910600d7363d749e7d20e8d355626edd53b4fb929f";
  assert.doesNotThrow(() => verifySha256(bytes, digest));
  assert.throws(() => verifySha256(Buffer.from("modified"), digest), /checksum mismatch/i);
});

test("revalidates the completion manifest and executable digest on every cache use", async () => {
  const root = await mkdtemp(join(tmpdir(), "sony-cache-"));
  const executable = join(root, "sony-head-tracker-macos");
  const bytes = Buffer.from("verified cached executable");
  const executableSha256 = "c859d8cfb51534cf22e89ff5269e5a5407a40062144dcbe23838b3d798503c1a";
  const releases = {
    version: "test-version",
    darwin: { sha256: "archive-digest", executableSha256 },
  };
  await writeFile(executable, bytes);
  await writeFile(join(root, ".verified.json"), JSON.stringify({
    version: "test-version",
    archiveSha256: "archive-digest",
    executableSha256,
  }));

  assert.equal(await verifyCachedTracker(root, "darwin", releases), executable);
  await writeFile(executable, "modified");
  assert.equal(await verifyCachedTracker(root, "darwin", releases), null);
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
