import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = resolve(root, "apps/desktop/src-tauri");
const configPath = resolve(tauriDir, "tauri.conf.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const icons = config.bundle?.icon;

if (!Array.isArray(icons) || icons.length === 0) {
  throw new Error("tauri.conf.json bundle.icon must explicitly list desktop icons");
}

for (const icon of icons) {
  const iconPath = resolve(tauriDir, icon);
  if (!existsSync(iconPath)) {
    throw new Error(`configured Tauri icon does not exist: ${icon}`);
  }
}

for (const extension of [".png", ".ico", ".icns"]) {
  if (!icons.some((icon) => extname(icon).toLowerCase() === extension)) {
    throw new Error(`tauri.conf.json bundle.icon must include a ${extension} icon`);
  }
}

console.log(`validated ${icons.length} configured Tauri desktop icons`);
