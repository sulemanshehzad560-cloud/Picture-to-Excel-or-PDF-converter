// Turn an uploaded PDF (e.g. from a phone scanner app) into one image per page.

const RENDER_LONG_SIDE = 3000; // enough pixels for small handwriting and decimal points

export async function pdfToImages(file, onPage = () => {}) {
  // The legacy build: the modern one needs JavaScript features (Map.getOrInsertComputed) that
  // Android WebViews and many browsers do not have yet, and fails on every PDF there.
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const files = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: RENDER_LONG_SIDE / Math.max(base.width, base.height) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    files.push(new File([blob], `${file.name.replace(/\.pdf$/i, "")}-p${n}.png`, { type: "image/png" }));
    onPage(n, pdf.numPages);
    page.cleanup();
  }
  await pdf.destroy();
  return files;
}
