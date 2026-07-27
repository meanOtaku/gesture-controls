import { createHash } from "node:crypto";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
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
  }),
  win32: Object.freeze({
    url: `${RELEASE_BASE}/sony-head-tracker-v${RELEASE_VERSION}-windows-x64.zip`,
    sha256: "ff75f6b2bae17535c6ac8a2860129ee2b27e710972423efd64655f9d2488598e",
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
  throw new Error("Automatic Sony Head Tracker setup supports macOS and Windows only");
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

  const existing = await findTrackerExecutable(toolsRoot, platform);
  if (existing) {
    if (platform === "darwin") await chmod(existing, 0o755);
    if (!(await isExecutable(existing, platform))) {
      throw new Error(`Cached Sony Head Tracker is not executable: ${existing}`);
    }
    return existing;
  }

  const release = RELEASES[platform];
  if (!release) {
    throw new Error(
      "Direct Sony tracking is unavailable on Linux. Use the UDP sample sender or set SONY_HEAD_TRACKER_BIN.",
    );
  }

  await mkdir(toolsRoot, { recursive: true });
  const archive = join(toolsRoot, `sony-head-tracker-v${RELEASE_VERSION}.zip`);
  const bytes = await downloadRelease(release);
  await writeFile(archive, bytes, { mode: 0o600 });
  try {
    await extractArchive(archive, toolsRoot, platform);
  } finally {
    await rm(archive, { force: true });
  }

  const executable = await findTrackerExecutable(toolsRoot, platform);
  if (!executable) throw new Error("Downloaded Sony Head Tracker archive did not contain the expected executable");
  if (platform === "darwin") await chmod(executable, 0o755);
  if (!(await isExecutable(executable, platform))) {
    throw new Error(`Downloaded Sony Head Tracker is not executable: ${executable}`);
  }
  return executable;
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

async function terminate(child, platform) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32") {
    await runCommand("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"]).catch(() => {});
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
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
      await Promise.all([
        terminateChild(tauri, platform),
        terminateChild(tracker, platform),
      ]);
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

export async function runSystem() {
  const platform = process.platform;
  const executable = await ensureTracker({ platform });
  const probeSpec = buildProbeInvocation(executable);
  const trackerSpec = buildTrackerInvocation(executable);
  const tauriSpec = tauriInvocation(platform);
  const detached = platform !== "win32";

  console.log("[system] Checking for a verified Sony head-tracker sensor");
  try {
    await runCommand(probeSpec.command, probeSpec.args);
  } catch {
    throw new Error(
      "Sony tracker preflight failed. Review the probe diagnostics above; Tauri was not started.",
    );
  }

  console.log(`[system] Starting external Sony Head Tracker v${RELEASE_VERSION}`);
  const tracker = spawn(trackerSpec.command, trackerSpec.args, {
    stdio: "inherit",
    detached,
  });
  console.log("[system] Starting Spatial Gesture Control");
  const tauri = spawn(tauriSpec.command, tauriSpec.args, {
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
