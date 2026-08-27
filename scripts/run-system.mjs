import { access, chmod } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const RELEASE_VERSION = "2.2.0";

export function bundledTrackerPath(prebuildsRoot, platform, arch) {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    const root = join(prebuildsRoot, `sony-head-tracker-v${RELEASE_VERSION}-macos-universal`);
    return join(root, "sony-head-tracker-macos");
  }
  if (platform === "win32" && arch === "x64") {
    return join(
      prebuildsRoot,
      `sony-head-tracker-v${RELEASE_VERSION}-windows-x64`,
      "sony-head-tracker.exe",
    );
  }
  throw new Error(`No bundled Sony Head Tracker is available for ${platform}/${arch}`);
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Keep the root `npm start` contract stable while implementation assets live
// with the Sony compatibility tool they belong to.
const DEFAULT_PREBUILDS_ROOT = join(PROJECT_ROOT, "tools", "sony-head-tracker", "prebuilds");

export function buildTrackerInvocation(executable) {
  return { command: executable, args: ["bridge"] };
}

async function isExecutable(path, platform) {
  try {
    await access(path, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTracker({
  platform = process.platform,
  arch = process.arch,
  override = process.env.SONY_HEAD_TRACKER_BIN,
  prebuildsRoot = DEFAULT_PREBUILDS_ROOT,
} = {}) {
  const executable = override
    ? resolve(override)
    : bundledTrackerPath(prebuildsRoot, platform, arch);

  if (!override && platform === "darwin") await chmod(executable, 0o755).catch(() => {});
  if (!(await isExecutable(executable, platform))) {
    const source = override ? "SONY_HEAD_TRACKER_BIN" : "Bundled Sony Head Tracker CLI bridge";
    throw new Error(`${source} is missing or not executable: ${executable}`);
  }
  return executable;
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
      console.error(`[system] Sony Head Tracker CLI bridge failed to start: ${error.message}`);
      void stop(1);
    });
    tauri.once("error", (error) => {
      console.error(`[system] Tauri failed to start: ${error.message}`);
      void stop(1);
    });
    tracker.once("exit", (code, signal) => {
      if (!stopping) {
        console.error(`[system] Sony Head Tracker CLI bridge stopped (${signal ?? `exit ${code}`})`);
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
  spawnChild = spawn,
} = {}) {
  const executable = await ensure({ platform });
  const trackerSpec = buildTrackerInvocation(executable);
  const tauriSpec = tauriInvocation(platform);
  const detached = platform !== "win32";

  console.log(`[system] Starting Sony Head Tracker v${RELEASE_VERSION} CLI bridge`);
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
  runSystem().catch((error) => {
    console.error(`[system] ${error.message}`);
    process.exitCode = 1;
  });
}
