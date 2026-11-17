import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Many suites spawn git or the built CLI. On Windows runners those
    // subprocesses regularly need more than vitest's 5 second default, which
    // turned unrelated pull requests red with "Test timed out in 5000ms".
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
