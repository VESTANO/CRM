import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const djangoTarget = process.env.VITE_DJANGO_URL || "http://127.0.0.1:8001";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/static/frontend/" : "/",
  plugins: [react()],
  build: {
    outDir: "../backend/static/frontend",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: djangoTarget,
        changeOrigin: true,
      },
      "/static": {
        target: djangoTarget,
        changeOrigin: true,
      },
      "/service-worker.js": {
        target: djangoTarget,
        changeOrigin: true,
      },
    },
  },
}));
