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
  build: {
    // Keep stable runtime engines independently cacheable from fast-moving
    // editor code. Vite 8/Rolldown's codeSplitting API replaces manualChunks.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-runtime",
              test: /node_modules\/.pnpm\/(?:react|react-dom|scheduler)@/,
            },
            {
              name: "effect-runtime",
              test: /node_modules\/.pnpm\/effect@/,
            },
            {
              name: "canvaskit-runtime",
              test: /node_modules\/.pnpm\/canvaskit-wasm@/,
            },
          ],
        },
      },
    },
  },
});
