import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@moirasia/desktop-shell"] })],
    resolve: { alias: { "@shared": resolve("src/shared"), "@main": resolve("src/main") } },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "scan-worker": resolve("src/main/scan-worker.ts")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": resolve("src/shared"), "@main": resolve("src/main") } },
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" }
      }
    }
  },
  renderer: {
    root: resolve("src/renderer"),
    resolve: { alias: { "@shared": resolve("src/shared"), "@main": resolve("src/main") }, dedupe: ["react", "react-dom"] },
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      include: [
        "@moirasia/ui-react > recharts",
        "@moirasia/ui-react > recharts > use-sync-external-store/shim/with-selector"
      ]
    },
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } }
  }
})
