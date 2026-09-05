import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Overridable so a second console can be pointed at a second API — which is
  // how this gets verified without disturbing whatever is already on :3000.
  server: {
    proxy: {
      "/api": process.env.API_ORIGIN ?? "http://localhost:3000",
      "/health": process.env.API_ORIGIN ?? "http://localhost:3000",
    },
  },
});
