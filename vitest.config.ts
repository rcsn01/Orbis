import { resolve } from "node:path"
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      electron: resolve("node_modules/electron"),
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
