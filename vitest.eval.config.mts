// Module 5: runs the golden-set eval (evals/*.eval.ts), not the unit tests.
// It calls the real model, so it needs GOOGLE_GENERATIVE_AI_API_KEY, and
// LANGFUSE_* to send the scores to Langfuse.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    setupFiles: ["./evals/setup.ts"],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    reporters: ["default"],
  },
});
