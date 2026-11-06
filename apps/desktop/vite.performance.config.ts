import { defineConfig } from "vitest/config";

// Separate process with one worker: wall-clock budgets do not belong in the parallel UI suite.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.performance.ts"], fileParallelism: false, maxWorkers: 1 },
});
