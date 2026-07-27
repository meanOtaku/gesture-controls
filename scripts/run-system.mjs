import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const RELEASE_VERSION = "2.2.0";
const RELEASE_BASE =
  `https://github.com/NicholasSlattery/sony-head-tracker/releases/download/v${RELEASE_VERSION}`;

export const RELEASES = Object.freeze({
  version: RELEASE_VERSION,
  darwin: Object.freeze({
    url: `${RELEASE_BASE}/sony-head-tracker-v${RELEASE_VERSION}-macos-universal.zip`,
    sha256: "9a3d0418a9bda4073a1312ce0622264b6cef7989cd0050a67361e44634eb2d2e",
    executableSha256: "396897fc98415992c816952fa47ad59b2074a7b69b87ff1991083b94cd9faf93",
  }),
  win32: Object.freeze({
    url: `${RELEASE_BASE}/sony-head-tracker-v${RELEASE_VERSION}-windows-x64.zip`,
    sha256: "ff75f6b2bae17535c6ac8a2860129ee2b27e710972423efd64655f9d2488598e",
    executableSha256: "1a6c308e2c02f1039d837311eba81d1f562d0b60ec66e6f71e1b7933f2e46a55",
  }),
});

export function verifySha256(bytes, expected) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Sony Head Tracker checksum mismatch: expected ${expected}, received ${actual}`);
  }
}

export function buildTrackerInvocation(executable) {
  return { command: executable, args: ["bridge", "--port", "4242"] };
}

export function buildProbeInvocation(executable) {
  return { command: executable, args: ["probe"] };
}

async function isExecutable(path, platform) {
  try {
    await access(path, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findTrackerExecutable(root, platform) {
  const candidates = platform === "darwin"
    ? [
        join(
          root,
          `sony-head-tracker-v${RELEASE_VERSION}-macos-universal`,
          "sony-head-tracker-macos",
        ),
        join(root, "sony-head-tracker-macos"),
      ]
    : platform === "win32"
      ? [join(root, "sony-head-tracker.exe")]
      : [];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function verifyCachedTracker(root, platform, releases = RELEASES) {
  const release = releases[platform];
  const executable = await findTrackerExecutable(root, platform);
  if (!release || !executable) return null;

  try {
    const manifest = JSON.parse(await readFile(join(root, ".verified.json"), "utf8"));
    if (
      manifest.version !== releases.version
      || manifest.archiveSha256 !== release.sha256
      || manifest.executableSha256 !== release.executableSha256
      || await sha256File(executable) !== release.executableSha256
    ) {
      return null;
    }
    return executable;
  } catch {
    return null;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function extractArchive(archive, destination, platform) {
  if (platform === "darwin") {
    await runCommand("/usr/bin/ditto", ["-x", "-k", archive, destination]);
    return;
  }
  if (platform === "win32") {
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const escapedArchive = archive.replaceAll("'", "''");
    const escapedDestination = destination.replaceAll("'", "''");
    await runCommand(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
    ]);
    return;
  }
  throw new Error("Automatic Sony Head Tracker setup supports macOS and Windows x64 only");
}

async function downloadRelease(release) {
  console.log(`[system] Downloading Sony Head Tracker v${RELEASE_VERSION}...`);
  const response = await fetch(release.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Sony Head Tracker download failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  verifySha256(bytes, release.sha256);
  return bytes;
}

async function acquireInstallLock(toolsRoot) {
  const lockRoot = `${toolsRoot}.lock`;
  await mkdir(dirname(toolsRoot), { recursive: true });
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      await mkdir(lockRoot);
      await writeFile(join(lockRoot, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      return async () => rm(lockRoot, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(join(lockRoot, "owner.json"), "utf8"));
        process.kill(owner.pid, 0);
      } catch (ownerError) {
        if (ownerError?.code === "ESRCH") {
          await rm(lockRoot, { recursive: true, force: true });
          continue;
        }
        if (ownerError?.code === "ENOENT" || ownerError instanceof SyntaxError) {
          const lockStats = await stat(lockRoot).catch(() => null);
          if (!lockStats) continue;
          const ageMs = Date.now() - lockStats.mtimeMs;
          if (ageMs > 10_000) {
            await rm(lockRoot, { recursive: true, force: true });
            continue;
          }
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error("Timed out waiting for Sony Head Tracker setup lock");
}

export async function ensureTracker({
  platform = process.platform,
  override = process.env.SONY_HEAD_TRACKER_BIN,
  toolsRoot = resolve(".tools", "sony-head-tracker", `v${RELEASE_VERSION}`),
} = {}) {
  if (override) {
    const executable = resolve(override);
    if (!(await isExecutable(executable, platform))) {
      throw new Error(`SONY_HEAD_TRACKER_BIN is not executable: ${executable}`);
    }
    return executable;
  }

  const release = RELEASES[platform];
  if (!release) {
    throw new Error(
      "Direct Sony tracking is unavailable on Linux. Use the UDP sample sender or set SONY_HEAD_TRACKER_BIN.",
    );
  }

  const existing = await verifyCachedTracker(toolsRoot, platform);
  if (existing) {
    if (platform === "darwin") await chmod(existing, 0o755);
    if (!(await isExecutable(existing, platform))) {
      throw new Error(`Cached Sony Head Tracker is not executable: ${existing}`);
    }
    return existing;
  }

  const releaseLock = await acquireInstallLock(toolsRoot);
  try {
    const concurrentInstall = await verifyCachedTracker(toolsRoot, platform);
    if (concurrentInstall) {
      if (platform === "darwin") await chmod(concurrentInstall, 0o755);
      return concurrentInstall;
    }

    await rm(toolsRoot, { recursive: true, force: true });
    await mkdir(dirname(toolsRoot), { recursive: true });
    const stagingRoot = await mkdtemp(`${toolsRoot}.install-`);
    const archive = join(stagingRoot, `sony-head-tracker-v${RELEASE_VERSION}.zip`);

    try {
    const bytes = await downloadRelease(release);
    await writeFile(archive, bytes, { mode: 0o600 });
    await extractArchive(archive, stagingRoot, platform);
    await rm(archive, { force: true });

    const executable = await findTrackerExecutable(stagingRoot, platform);
    if (!executable) {
      throw new Error("Downloaded Sony Head Tracker archive did not contain the expected executable");
    }
    if (platform === "darwin") await chmod(executable, 0o755);
    if (await sha256File(executable) !== release.executableSha256) {
      throw new Error("Downloaded Sony Head Tracker executable checksum mismatch");
    }
    if (!(await isExecutable(executable, platform))) {
      throw new Error(`Downloaded Sony Head Tracker is not executable: ${executable}`);
    }

    await writeFile(join(stagingRoot, ".verified.json"), JSON.stringify({
      version: RELEASE_VERSION,
      archiveSha256: release.sha256,
      executableSha256: release.executableSha256,
    }), { mode: 0o600 });

      try {
        await rename(stagingRoot, toolsRoot);
        const installed = await verifyCachedTracker(toolsRoot, platform);
        if (!installed) throw new Error("Installed Sony Head Tracker failed cache verification");
        return installed;
      } catch (error) {
        const winner = await verifyCachedTracker(toolsRoot, platform);
        if (winner) return winner;
        throw error;
      }
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  } finally {
    await releaseLock();
  }
}

function tauriInvocation(platform) {
  if (platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "npm run tauri -- dev"],
    };
  }
  return { command: "npm", args: ["run", "tauri", "--", "dev"] };
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return !processGroupExists(pid);
}

async function terminate(child, platform) {
  if (!child?.pid) return;
  if (platform === "win32") {
    try {
      await runCommand("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"]);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        console.error(`[system] Failed to terminate Windows process tree ${child.pid}: ${error.message}`);
        throw error;
      }
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill("SIGTERM");
  }

  if (await waitForProcessGroupExit(child.pid, 5_000)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill("SIGKILL");
  }
  if (!(await waitForProcessGroupExit(child.pid, 1_000))) {
    throw new Error(`Process group ${child.pid} remained alive after SIGKILL`);
  }
}

export function superviseChildren({
  tracker,
  tauri,
  platform,
  host = process,
  terminateChild = terminate,
}) {
  return new Promise((resolveCompletion) => {
    let stopping = false;

    const stop = async (code) => {
      if (stopping) return;
      stopping = true;
      host.removeListener("SIGINT", onSigint);
      host.removeListener("SIGTERM", onSigterm);
      const cleanup = await Promise.allSettled([
        terminateChild(tauri, platform),
        terminateChild(tracker, platform),
      ]);
      for (const outcome of cleanup) {
        if (outcome.status === "rejected") {
          console.error(`[system] Process cleanup failed: ${outcome.reason?.message ?? outcome.reason}`);
        }
      }
      host.exitCode = code;
      resolveCompletion(code);
    };

    const onSigint = () => void stop(130);
    const onSigterm = () => void stop(143);
    host.once("SIGINT", onSigint);
    host.once("SIGTERM", onSigterm);

    tracker.once("error", (error) => {
      console.error(`[system] Sony Head Tracker failed to start: ${error.message}`);
      void stop(1);
    });
    tauri.once("error", (error) => {
      console.error(`[system] Tauri failed to start: ${error.message}`);
      void stop(1);
    });
    tracker.once("exit", (code, signal) => {
      if (!stopping) {
        console.error(`[system] Sony Head Tracker stopped (${signal ?? `exit ${code}`})`);
        void stop(code || 1);
      }
    });
    tauri.once("exit", (code) => {
      if (!stopping) void stop(code ?? 1);
    });
  });
}

export async function runSystem({
  platform = process.platform,
  ensure = ensureTracker,
  run = runCommand,
  spawnChild = spawn,
} = {}) {
  const executable = await ensure({ platform });
  const probeSpec = buildProbeInvocation(executable);
  const trackerSpec = buildTrackerInvocation(executable);
  const tauriSpec = tauriInvocation(platform);
  const detached = platform !== "win32";

  console.log("[system] Checking for a verified Sony head-tracker sensor");
  try {
    await run(probeSpec.command, probeSpec.args);
  } catch (error) {
    throw new Error(
      `Sony tracker preflight failed; Tauri was not started: ${error.message}`,
      { cause: error },
    );
  }

  console.log(`[system] Starting external Sony Head Tracker v${RELEASE_VERSION}`);
  const tracker = spawnChild(trackerSpec.command, trackerSpec.args, {
    stdio: "inherit",
    detached,
  });
  console.log("[system] Starting Spatial Gesture Control");
  const tauri = spawnChild(tauriSpec.command, tauriSpec.args, {
    stdio: "inherit",
    detached,
  });

  await superviseChildren({ tracker, tauri, platform });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  const action = process.argv.includes("--setup-only")
    ? ensureTracker().then((executable) => {
        console.log(`[system] Verified Sony Head Tracker: ${executable}`);
      })
    : runSystem();
  action.catch((error) => {
    console.error(`[system] ${error.message}`);
    process.exitCode = 1;
  });
}
