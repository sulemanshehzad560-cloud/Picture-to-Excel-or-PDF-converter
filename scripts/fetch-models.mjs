// Downloads the on-device OCR models into web/public/models/ and copies the ONNX Runtime
// WebAssembly files into web/public/ort/ (served as-is so its worker threads can load them).
//
// Models: PaddleOCR PP-OCRv6 (Apache-2.0), as redistributed in the RapidOCR wheel on PyPI.
// Every file is pinned by SHA-256 (the same hashes RapidOCR publishes), so a build can never
// silently pick up different weights. Re-running is a no-op once files are present and valid.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = join(root, "web/public/models");
const ortDir = join(root, "web/public/ort");
const ORT_FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

const WHEEL = {
  url: "https://files.pythonhosted.org/packages/55/ed/0ee9b9281986974be9d2406ae0134c8d7c91d2fc613f16ffda9701eeda6f/rapidocr-3.9.2-py3-none-any.whl",
  sha256: "04d6b8d151f823d930bd91910555f57bea897c0c44fa6794267b94cf9c1ef9a0",
};
const MODELS = {
  "det.onnx": { src: "rapidocr/models/PP-OCRv6_det_small.onnx", sha256: "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f" },
  "rec.onnx": { src: "rapidocr/models/PP-OCRv6_rec_small.onnx", sha256: "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884" },
  "cls.onnx": { src: "rapidocr/models/ch_ppocr_mobile_v2.0_cls_mobile.onnx", sha256: "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c" },
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const valid = (path, hash) => existsSync(path) && sha256(readFileSync(path)) === hash;

/** Read a top-level string metadata entry (ModelProto.metadata_props, field 14) from an ONNX file. */
export function onnxMetadata(buf, wanted) {
  let pos = 0;
  const varint = () => {
    let result = 0n, shift = 0n;
    for (;;) {
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  };
  while (pos < buf.length) {
    const key = Number(varint());
    const field = key >> 3, wire = key & 7;
    if (wire === 0) { varint(); continue; }
    if (wire === 1) { pos += 8; continue; }
    if (wire === 5) { pos += 4; continue; }
    if (wire !== 2) throw new Error(`unexpected wire type ${wire}`);
    const len = Number(varint());
    const start = pos;
    pos += len;
    if (field !== 14) continue;
    // StringStringEntryProto { key = 1; value = 2; }
    let k = null, v = null;
    const inner = buf.subarray(start, start + len);
    const sub = { buf: inner, pos: 0 };
    const subVarint = () => {
      let result = 0, shift = 0;
      for (;;) {
        const b = sub.buf[sub.pos++];
        result += (b & 0x7f) * 2 ** shift;
        if (!(b & 0x80)) return result;
        shift += 7;
      }
    };
    while (sub.pos < inner.length) {
      const t = subVarint();
      const l = subVarint();
      const s = new TextDecoder().decode(inner.subarray(sub.pos, sub.pos + l));
      sub.pos += l;
      if (t >> 3 === 1) k = s; else if (t >> 3 === 2) v = s;
    }
    if (k === wanted) return v;
  }
  return null;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(ortDir, { recursive: true });

  const missing = Object.entries(MODELS).filter(([name, m]) => !valid(join(modelsDir, name), m.sha256));
  if (missing.length) {
    console.log("Downloading PP-OCRv6 models (RapidOCR 3.9.2 wheel from PyPI)...");
    const wheel = await download(WHEEL.url);
    if (sha256(wheel) !== WHEEL.sha256) throw new Error("wheel checksum mismatch");
    const zip = await JSZip.loadAsync(wheel);
    for (const [name, m] of missing) {
      const data = Buffer.from(await zip.file(m.src).async("uint8array"));
      if (sha256(data) !== m.sha256) throw new Error(`${name} checksum mismatch`);
      writeFileSync(join(modelsDir, name), data);
      console.log(`  ${name} ${(data.length / 1e6).toFixed(1)} MB ✓`);
    }
  }

  const dictPath = join(modelsDir, "rec_dict.txt");
  if (!existsSync(dictPath)) {
    const chars = onnxMetadata(readFileSync(join(modelsDir, "rec.onnx")), "character");
    if (!chars) throw new Error("rec.onnx has no embedded character dictionary");
    writeFileSync(dictPath, chars);
    console.log(`  rec_dict.txt ${chars.split("\n").length} characters ✓`);
  }

  for (const f of ORT_FILES) {
    const src = join(root, "node_modules/onnxruntime-web/dist", f);
    const dst = join(ortDir, f);
    if (!existsSync(dst) || sha256(readFileSync(src)) !== sha256(readFileSync(dst))) copyFileSync(src, dst);
  }
  console.log("Models and runtime ready in web/public/");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
