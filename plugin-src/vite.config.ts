import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// UXP loads index.html from disk: relative asset paths, a single classic script,
// and host modules (uxp, photoshop, the addon) left to UXP's require().
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: false,
    target: "es2020",
    minify: false,
    sourcemap: "inline",
    modulePreload: false,
    rollupOptions: {
      external: ["uxp", "photoshop", /\.uxpaddon$/],
      output: { format: "iife", entryFileNames: "index.js", assetFileNames: "[name][extname]" }
    }
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" }
} as any);
