import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // canvaskit-wasm ships CJS; pre-bundling gives it ESM interop in dev.
  optimizeDeps: {
    include: ["canvaskit-wasm"],
  },
  server: {
    port: 5174,
  },
});
