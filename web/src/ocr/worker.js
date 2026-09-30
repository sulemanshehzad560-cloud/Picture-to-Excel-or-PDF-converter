// OCR Web Worker: owns OpenCV.js, ONNX Runtime and the models so the UI never freezes.
//
// in : {type:"init", base} | {type:"recognize", id, blob, rotation, precision, flatten}
// out: {type:"ready", threads} | {type:"progress", id, step} | {type:"result", id, ...} | {type:"error", id, message}

import cvModule from "@techstark/opencv-js";
import * as ort from "onnxruntime-web/wasm";
import { recognizePage } from "./engine.js";
import { PPOCR } from "./ppocr.js";

const MAX_DECODE = 3600;
let BASE = null; // app root URL, sent by the page with "init" (models and runtime live under it)

let envPromise;

async function loadCv() {
  if (cvModule instanceof Promise) return await cvModule;
  if (cvModule.Mat) return cvModule;
  await new Promise((resolve) => { cvModule.onRuntimeInitialized = resolve; });
  return cvModule;
}

function init() {
  envPromise ??= (async () => {
    const threads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.wasmPaths = new URL("ort/", BASE).href;
    const load = async (name) => {
      const res = await fetch(new URL(`models/${name}`, BASE));
      if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    };
    const [cv, ocr] = await Promise.all([loadCv(), PPOCR.create(ort, load)]);
    return { cv, ocr, threads };
  })();
  return envPromise;
}

/** Decode with EXIF orientation, apply the user's rotation, cap the size, return ImageData. */
async function decode(blob, rotation = 0) {
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_DECODE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const quarter = ((rotation % 360) + 360) % 360;
  const swap = quarter === 90 || quarter === 270;
  const canvas = new OffscreenCanvas(swap ? h : w, swap ? w : h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height); // transparent PNGs -> white paper
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((quarter * Math.PI) / 180);
  ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === "init") {
      BASE = msg.base;
      const env = await init();
      self.postMessage({ type: "ready", threads: env.threads });
      return;
    }
    if (msg.type === "recognize") {
      const env = await init();
      const image = await decode(msg.blob, msg.rotation);
      const res = await recognizePage(env, image, {
        precision: msg.precision,
        flatten: msg.flatten,
        onStep: (step) => self.postMessage({ type: "progress", id: msg.id, step }),
      });
      const preview = new ImageData(res.preview.data, res.preview.width, res.preview.height);
      self.postMessage({ type: "result", id: msg.id, blocks: res.blocks, steps: res.steps, ms: res.ms, preview }, [preview.data.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: err?.message || String(err) });
  }
};
