// Vite setup for the admin web UI.
// In development (npm run dev) the UI runs on http://127.0.0.1:5173 and forwards
// /admin/api requests to the gateway's admin port. For real use, `npm run build`
// puts the finished files in ui/dist, and the gateway serves them on port 8090.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/admin/api": { target: "http://127.0.0.1:8090" },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});