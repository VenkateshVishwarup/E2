import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Built to the repository root rather than beside the package.
  //
  // Vercel's framework detection recognises Vite and applies its default output
  // directory, `dist` at the root — which overrode `outputDirectory` in
  // vercel.json and failed the deploy with "No Output Directory named dist".
  // Emitting where every reading of the config agrees removes the question
  // rather than answering it.
  build: { outDir: "../../dist", emptyOutDir: true },
  // Overridable so a second console can be pointed at a second API — which is
  // how this gets verified without disturbing whatever is already on :3000.
  server: {
    proxy: {
      "/api": process.env.API_ORIGIN ?? "http://localhost:3000",
      "/health": process.env.API_ORIGIN ?? "http://localhost:3000",
    },
  },
});
