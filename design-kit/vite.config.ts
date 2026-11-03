// Builds the design kit (src/design-kit) into one classic script for the
// Claude Design system: `window.Dawg`, over the page's React 18.
// `npm run design:build` runs this, then design-kit/build.mjs.
import path from "path";
import { defineConfig } from "vite";

const root = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  root,
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(root, "src") },
      { find: /^react\/jsx(-dev)?-runtime$/, replacement: path.resolve(import.meta.dirname, "jsx-runtime.js") },
    ],
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [
    {
      // No worker files in a one-script bundle: waveforms draw on the main
      // thread (wave-tiles.ts falls back to that when a worker can't start).
      name: "no-workers",
      transform(code, id) {
        if (!id.endsWith("wave-tiles.ts")) return null;
        return code.replace(/new Worker\(new URL\("\.\/wave-worker\.ts", import\.meta\.url\), \{ type: "module" \}\)/, '(() => { throw new Error("no workers"); })()');
      },
    },
  ],
  build: {
    target: "es2020",
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    copyPublicDir: false,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(root, "src/design-kit/index.ts"),
      name: "Dawg",
      formats: ["iife"],
      fileName: () => "bundle.js",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react-dom/client"],
      output: { globals: { react: "React", "react-dom": "ReactDOM", "react-dom/client": "ReactDOM" } },
    },
  },
});
