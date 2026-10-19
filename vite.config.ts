import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The dev server proxies /api to the Node server started by `npm run dev:api`.
const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    // Fonts stay real files: the security policy (font-src 'self') blocks data: fonts, which Vite would otherwise
    // inline when a font subset is tiny. Everything else keeps Vite's default inlining rule.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
  },
  worker: {
    format: "es",
  },
  test: {
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["tests/unit/setup.ts"],
    // The PDF engines are CPU-heavy; keep workers modest so timing-sensitive tests stay stable.
    pool: "forks",
  },
});
