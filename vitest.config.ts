import { defineConfig } from "vitest/config";

// Dedicated config so unit tests do not boot the PWA / pages plugins that
// vite.config.ts registers for the real build.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    reporters: ["default"],
  },
});
