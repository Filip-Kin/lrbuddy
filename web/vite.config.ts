import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const api = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    // WEB_DIST lets parallel agents build into separate directories.
    outDir: process.env.WEB_DIST ?? fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      "/trpc": { target: api, changeOrigin: false },
      "/auth": api,
      "/j/": api,
      "/health": api,
    },
  },
});
