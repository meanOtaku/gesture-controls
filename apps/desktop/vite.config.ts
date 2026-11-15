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
/** The plain-script build of the library, for the hand worker (a classic worker cannot import modules). */
const MEDIAPIPE_BUNDLE = "vision_bundle.js";
const MEDIAPIPE_BUNDLE_URL = "/mediapipe/vision_bundle.js";

function mediapipeWasm(): Plugin {
  const dir = path.resolve(__dirname, "../../node_modules/@mediapipe/tasks-vision/wasm");
  const localDir = path.resolve(__dirname, "node_modules/@mediapipe/tasks-vision/wasm");
  const source = () => (fs.existsSync(localDir) ? localDir : dir);
  const bundle = () => path.join(path.dirname(source()), MEDIAPIPE_BUNDLE);
  return {
    name: "mediapipe-wasm",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] === MEDIAPIPE_BUNDLE_URL) {
          response.setHeader("Content-Type", "text/javascript");
          return fs.createReadStream(bundle()).pipe(response);
        }
        const name = request.url?.startsWith(MEDIAPIPE_URL) ? request.url.slice(MEDIAPIPE_URL.length).split("?")[0] : null;
        if (!name || !MEDIAPIPE_WASM_FILES.includes(name)) return next();
        response.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        fs.createReadStream(path.join(source(), name)).pipe(response);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: `mediapipe/${MEDIAPIPE_BUNDLE}`, source: fs.readFileSync(bundle()) });
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
  build: {
    rollupOptions: {
      output: {
        /**
         * The libraries every page needs go in chunks of their own, so the app's own code is a small chunk that changes
         * on its own, and no chunk is so large that it slows the first paint while it is parsed.
         */
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
          if (/node_modules\/(motion|motion-dom|motion-utils|framer-motion|number-flow|@number-flow)\//.test(id)) return "vendor-motion";
          if (/node_modules\/(@radix-ui|@floating-ui|radix-ui|sonner|lucide-react|class-variance-authority|clsx|tailwind-merge)\//.test(id)) return "vendor-ui";
          if (/node_modules\/@tauri-apps\//.test(id)) return "vendor-tauri";
          return undefined;
        },
      },
    },
  },
  test: { environment: "jsdom", setupFiles: "./src/test/setup.ts" },
});
