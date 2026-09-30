import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Cross-origin isolation lets ONNX Runtime use several CPU threads (SharedArrayBuffer).
// The Android app adds the same headers natively (MainActivity.java).
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  root: "web",
  resolve: {
    alias: {
      // Non-bundled ORT build: its worker threads load the small ort-wasm-*.mjs from web/public/ort
      // instead of re-importing our whole OCR worker chunk (which deadlocks multi-threaded init).
      "onnxruntime-web/wasm": fileURLToPath(new URL("node_modules/onnxruntime-web/dist/ort.wasm.min.mjs", import.meta.url)),
    },
  },
  base: "./", // relative paths: works in the Android app, on any static host and under /app on the Python server
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 16000, // OpenCV.js is one ~13 MB module by design
  },
  worker: { format: "es" },
  server: { headers: isolation },
  preview: { headers: isolation },
});
