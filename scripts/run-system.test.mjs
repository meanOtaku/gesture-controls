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
  superviseChildren,
  verifySha256,
} from "./run-system.mjs";

test("pins verified Sony Head Tracker release assets for macOS and Windows", () => {
  assert.equal(RELEASES.version, "2.2.0");
  assert.match(RELEASES.darwin.url, /v2\.2\.0\/sony-head-tracker-v2\.2\.0-macos-universal\.zip$/);
  assert.equal(RELEASES.darwin.sha256, "9a3d0418a9bda4073a1312ce0622264b6cef7989cd0050a67361e44634eb2d2e");
  assert.match(RELEASES.win32.url, /v2\.2\.0\/sony-head-tracker-v2\.2\.0-windows-x64\.zip$/);
  assert.equal(RELEASES.win32.sha256, "ff75f6b2bae17535c6ac8a2860129ee2b27e710972423efd64655f9d2488598e");
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

test("accepts the pinned archive digest and rejects modified downloads", () => {
  const bytes = Buffer.from("verified fixture");
  const digest = "f9adb7d924ed98c558040c910600d7363d749e7d20e8d355626edd53b4fb929f";
  assert.doesNotThrow(() => verifySha256(bytes, digest));
  assert.throws(() => verifySha256(Buffer.from("modified"), digest), /checksum mismatch/i);
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
