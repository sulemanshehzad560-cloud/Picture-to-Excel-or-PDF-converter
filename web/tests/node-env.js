// Shared Node harness: loads OpenCV.js, ONNX Runtime (WASM, same backend as the phone) and the models.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { PNG } from "pngjs";
import { PPOCR } from "../src/ocr/ppocr.js";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

let cached;
export async function loadEnv() {
  if (cached) return cached;
  let cv = require("@techstark/opencv-js");
  if (cv instanceof Promise) cv = await cv;
  else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  ort.env.wasm.numThreads = 1;
  const ocr = await PPOCR.create(ort, async (name) => readFileSync(join(root, "web/public/models", name)));
  cached = { cv, ort, ocr };
  return cached;
}

export function readPng(path) {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

export const samplesDir = join(root, "tests/output/samples");
