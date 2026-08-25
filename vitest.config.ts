import { resolve } from "node:path"
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      electron: resolve("node_modules/electron"),
      "@moirasia/feature-orbis/renderer/panel": resolve("../../packages/feature-orbis/src/renderer/App.tsx"),
      "@moirasia/feature-orbis": resolve("../../packages/feature-orbis/src"),
      "@shared": resolve("src/shared"),
      "@main": resolve("src/main")
    }
  },
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"]
  }
})
