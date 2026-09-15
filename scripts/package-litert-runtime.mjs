import { copyFile, cp, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tauriDirectory = join(repositoryRoot, "apps", "desktop", "src-tauri");
const stagingRoot = join(tauriDirectory, "resources", "litert");

const targets = {
  "aarch64-apple-darwin": {
    primaryLibrary: "libLiteRt.dylib",
    extension: ".dylib",
    config: "tauri.litert.unix.conf.json",
  },
  "x86_64-unknown-linux-gnu": {
    primaryLibrary: "libLiteRt.so",
    extension: ".so",
    config: "tauri.litert.unix.conf.json",
  },
  "aarch64-unknown-linux-gnu": {
    primaryLibrary: "libLiteRt.so",
    extension: ".so",
    config: "tauri.litert.unix.conf.json",
  },
  "x86_64-pc-windows-msvc": {
    primaryLibrary: "libLiteRt.dll",
    extension: ".dll",
    config: "tauri.litert.windows.conf.json",
  },
};

function fail(message) {
  process.stderr.write(`LiteRT package not created: ${message}\n`);
  process.exitCode = 1;
}

async function requireDirectory(path, variable) {
  if (!path) {
    throw new Error(`${variable} is required; do not package a feature-enabled build without a reviewed native LiteRT runtime directory.`);
  }
  const resolved = resolve(path);
  let directory;
  try {
    directory = await lstat(resolved);
  } catch {
    throw new Error(`${variable}=${resolved} does not exist.`);
  }
  if (!directory.isDirectory()) {
    throw new Error(`${variable}=${resolved} is not a directory.`);
  }
  return resolved;
}

async function isFile(path) {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function main() {
  const target = process.env.LITERT_RUNTIME_TARGET;
  const spec = targets[target];
  if (!spec) {
    throw new Error(
      `LITERT_RUNTIME_TARGET must be one of: ${Object.keys(targets).join(", ")}. Cross-target guesses are rejected.`,
    );
  }

  const runtimeDirectory = await requireDirectory(process.env.LITERT_RUNTIME_DIR, "LITERT_RUNTIME_DIR");
  const noticeFile = process.env.LITERT_RUNTIME_NOTICE_FILE;
  if (!noticeFile) {
    throw new Error(
      "LITERT_RUNTIME_NOTICE_FILE is required so the native runtime's reviewed license/NOTICE is bundled with the release.",
    );
  }
  const resolvedNotice = resolve(noticeFile);
  if (!(await isFile(resolvedNotice))) {
    throw new Error(`LITERT_RUNTIME_NOTICE_FILE=${resolvedNotice} is not a file.`);
  }

  const primaryLibrary = join(runtimeDirectory, spec.primaryLibrary);
  if (!(await isFile(primaryLibrary))) {
    throw new Error(
      `missing ${spec.primaryLibrary} in ${runtimeDirectory}; the target-native LiteRT runtime is absent, so the package must remain unavailable and inference fail closed.`,
    );
  }

  const targetStage = join(stagingRoot, target);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(targetStage, { recursive: true });

  try {
    const entries = await readdir(runtimeDirectory, { withFileTypes: true });
    const nativeLibraries = entries.filter(
      (entry) => entry.isFile() && entry.name.startsWith("libLiteRt") && entry.name.endsWith(spec.extension),
    );
    for (const entry of nativeLibraries) {
      await cp(join(runtimeDirectory, entry.name), join(targetStage, entry.name), { force: false });
    }
    await copyFile(resolvedNotice, join(targetStage, "NOTICE"));
    await writeFile(
      join(targetStage, "runtime-manifest.json"),
      `${JSON.stringify({ target, primaryLibrary: spec.primaryLibrary, bundledFiles: nativeLibraries.map((entry) => entry.name).sort() }, null, 2)}\n`,
    );

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(
      npm,
      [
        "run",
        "tauri",
        "--workspace",
        "@spatial-gesture/desktop",
        "--",
        "build",
        "--target",
        target,
        "--features",
        "litert-inference",
        "--config",
        spec.config,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          LITERT_LIB_DIR: targetStage,
          LITERT_NO_DOWNLOAD: "1",
          LITERT_RUNTIME_DIR: targetStage,
          LITERT_RUNTIME_TARGET: target,
        },
        stdio: "inherit",
      },
    );
    await new Promise((resolveChild, rejectChild) => {
      child.on("error", rejectChild);
      child.on("exit", (code, signal) => {
        if (code === 0) resolveChild();
        else rejectChild(new Error(`Tauri package command exited with ${signal ?? code}.`));
      });
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error.message));
