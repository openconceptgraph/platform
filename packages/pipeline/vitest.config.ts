import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // Shares the test database with the other packages' suites, which turbo runs separately.
    fileParallelism: false,
  },
});
