import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const djangoTarget = process.env.VITE_DJANGO_URL || "http://127.0.0.1:8001";
const devHost = process.env.VITE_DEV_HOST || "0.0.0.0";
const pagesBuild = process.env.VITE_PAGES_BUILD === "true";

export default defineConfig(({ command, mode }) => {
  const isPagesBuild = mode === "pages" || pagesBuild;
  return ({
  base: command === "build" ? (isPagesBuild ? "/CRM/" : "/static/frontend/") : "/",
  plugins: [react()],
  build: {
    outDir: isPagesBuild ? "dist" : "../backend/static/frontend",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Keep long-lived libraries in stable, cacheable files.  A deployment
        // that changes one CRM screen no longer makes browsers redownload all
        // of React, Supabase, Bootstrap and the application shell.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("xlsx")) return "xlsx";
          if (id.includes("@supabase")) return "supabase";
          if (id.includes("react") || id.includes("scheduler")) return "react";
          if (id.includes("bootstrap")) return "bootstrap";
          if (id.includes("axios")) return "axios";
        },
      },
    },
  },
  server: {
    host: devHost,
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
    },
  },
  });
});
