import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

/**
 * MediaPipe's WebAssembly runtime is a few tens of megabytes and comes from node_modules, so it is served from there in
 * development and copied into the build, instead of being committed. The hand model itself (a small file the runtime
 * needs at a known address) lives in public/mediapipe. Everything is loaded from the app's own origin: the app works
 * offline and never reaches a CDN.
 */
const MEDIAPIPE_WASM_FILES = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];
const MEDIAPIPE_URL = "/mediapipe/wasm/";

function mediapipeWasm(): Plugin {
  const dir = path.resolve(__dirname, "../../node_modules/@mediapipe/tasks-vision/wasm");
  const localDir = path.resolve(__dirname, "node_modules/@mediapipe/tasks-vision/wasm");
  const source = () => (fs.existsSync(localDir) ? localDir : dir);
  return {
    name: "mediapipe-wasm",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = request.url?.startsWith(MEDIAPIPE_URL) ? request.url.slice(MEDIAPIPE_URL.length).split("?")[0] : null;
        if (!name || !MEDIAPIPE_WASM_FILES.includes(name)) return next();
        response.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        fs.createReadStream(path.join(source(), name)).pipe(response);
      });
    },
    generateBundle() {
      for (const name of MEDIAPIPE_WASM_FILES) {
        this.emitFile({ type: "asset", fileName: `mediapipe/wasm/${name}`, source: fs.readFileSync(path.join(source(), name)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mediapipeWasm()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: { environment: "jsdom", setupFiles: "./src/test/setup.ts" },
});
