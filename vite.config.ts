import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 5177,
    strictPort: true,
    watch: {
      ignored: ["**/target/**", "**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
  },
});
