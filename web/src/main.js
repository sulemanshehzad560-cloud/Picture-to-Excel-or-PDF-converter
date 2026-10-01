import "@fontsource-variable/inter";
import "./styles.css";

import { exportDocument, FORMATS } from "./export/index.js";
import { drawList, hasLayout, pageModel } from "./export/replica.js";
import { adPrivacyRequired, initAds, onAdsChange, setBannerVisible, showAdPrivacyOptions } from "./ads.js";
import { deleteScan, listScans, saveScan } from "./history.js";
import { initNativeChrome, isNative, nativeCamera, saveFile, setNativeTheme } from "./platform.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k, d = "") { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  files: [], // {file, url, rotation, fromPdf}
  engine: "device",
  precision: "high",
  formats: new Set(["xlsx"]),
  layout: "page", // "page": Excel/Word/PDF copy the scanned page; "data": tables and fields only
  docMode: "page", // result view: "page" copy, "edit" blocks, "original" photo (phones)
  theme: "system",
  result: null, // {id, document, pages: [{page, steps, seconds, enhanced_preview, original}], seconds, engine_label}
  page: 0,
  imgMode: "original",
  serverAI: false,
  scanning: false,
};

const PRECISION_HINT = {
  fast: "One pass. Quickest, fine for neat writing and print.",
  high: "Straightens the page, double-checks every doubtful word and fixes misread digits.",
  max: "Also zooms in to catch tiny marks and re-reads doubtful words at a second scale. Slowest.",
};
const LAYOUT_HINT = {
  page: "Each page comes back looking like the paper: same places, sizes, shading and lines.",
  data: "Just the data: each table on its own sheet, fields and text in a clean list.",
};
const FORMAT_INFO = {
  xlsx: "Spreadsheet: tables become real cells",
  docx: "Editable document with the same layout",
  pdf: "The page as scanned, ready to print or send",
  csv: "Raw table data for any spreadsheet",
  md: "Text and tables for notes apps",
  txt: "Plain text",
  json: "Structured data for developers",
};
const STEP_LABEL = {
  prepare: "Finding and flattening the page",
  detect: "Locating every line of text",
  tiles: "Zooming in for small marks",
  recognize: "Reading handwriting and print",
  reread: "Double-checking doubtful words",
  layout: "Rebuilding tables, forms and layout",
};
const RING = 2 * Math.PI * 52;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(c));
  return node;
}
const SVG = "http://www.w3.org/2000/svg";
function icon(name, cls = "i") {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("class", cls);
  const u = document.createElementNS(SVG, "use");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), isErr ? 6000 : 3200);
}

const VIEWS = ["captureView", "scanView", "resultView", "historyView", "settingsView"];
const TAB_OF = { captureView: "captureView", scanView: "captureView", resultView: "captureView", historyView: "historyView", settingsView: "settingsView" };

function show(view) {
  for (const v of VIEWS) $("#" + v).classList.toggle("hidden", v !== view);
  $$(".nav-item").forEach((b) => b.classList.toggle("on", b.dataset.tab === TAB_OF[view]));
  // While a scan runs the screen is all progress: no navigation, no ad.
  $(".nav").classList.toggle("hidden", view === "scanView");
  setBannerVisible(view !== "scanView");
  if (view === "historyView") renderFiles();
  if (view === "captureView") renderRecent();
  window.scrollTo({ top: 0 });
}

/* ---------------- OCR worker ---------------- */
const worker = new Worker(new URL("./ocr/worker.js", import.meta.url), { type: "module" });
const pending = new Map();
let engineReady = false;
let jobSeq = 0;

worker.onmessage = ({ data }) => {
  if (data.type === "ready") {
    engineReady = true;
    setStatus("ok", `Engine ready${data.threads > 1 ? ` · ${data.threads} cores` : ""}`);
    return;
  }
  const job = pending.get(data.id);
  if (!job) {
    if (data.type === "error") setStatus("warn", "Engine failed to load");
    return;
  }
  if (data.type === "progress") job.onStep(data.step);
  else if (data.type === "result") { pending.delete(data.id); job.resolve(data); }
  else if (data.type === "error") { pending.delete(data.id); job.reject(new Error(data.message)); }
};
worker.postMessage({ type: "init", base: new URL(import.meta.env.BASE_URL, location.href).href });

function recognize(file, onStep) {
  const id = ++jobSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onStep });
    worker.postMessage({
      type: "recognize", id, blob: file.file, rotation: file.rotation,
      precision: state.precision, flatten: $("#flatten").checked,
    });
  });
}

function setStatus(kind, text) {
  const pill = $("#engineStatus");
  pill.className = `status ${kind}`;
  pill.lastElementChild.textContent = text;
  $("#aboutLine").textContent = `On-device handwriting and document scanner · ${text}`;
}

async function detectServerAI() {
  if (isNative) return;
  try {
    const r = await fetch("api/engines", { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return;
    const e = await r.json();
    state.serverAI = !!e.claude?.server_key;
    $("#engineField").classList.toggle("hidden", !state.serverAI);
  } catch { /* static hosting or the Android app: on-device only */ }
}

/* ---------------- intake ---------------- */
const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isImage = (f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|bmp|gif|tiff?|heic|avif)$/i.test(f.name);

async function addFiles(list) {
  const incoming = [...list];
  let added = 0, failed = false;
  for (const f of incoming) {
    if (isPdf(f)) {
      try {
        toast(`Opening ${f.name}…`);
        const { pdfToImages } = await import("./pdfpages.js");
        const pages = await pdfToImages(f, (n, total) => toast(`Reading PDF page ${n} of ${total}…`));
        for (const p of pages) state.files.push({ file: p, url: URL.createObjectURL(p), rotation: 0, fromPdf: true });
        added += pages.length;
      } catch (err) {
        failed = true;
        console.error("PDF open failed", err);
        toast(`Could not open ${f.name}: ${err.message}`, true);
      }
    } else if (isImage(f)) {
      state.files.push({ file: f, url: URL.createObjectURL(f), rotation: 0 });
      added++;
    }
  }
  // (A PDF that failed to open has already said why.)
  if (!added && incoming.length && !failed) toast("Only images and PDFs can be scanned.", true);
  if (added) toast(`${added} page${added > 1 ? "s" : ""} added`);
  renderThumbs();
}

function renderThumbs() {
  const box = $("#thumbs");
  box.replaceChildren();
  state.files.forEach((f, i) => {
    const img = el("img", { src: f.url, alt: `Page ${i + 1}` });
    img.style.transform = `rotate(${f.rotation}deg)`;
    const t = el("div", { class: "thumb", draggable: "true" },
      img,
      el("span", { class: "num" }, String(i + 1)),
      f.fromPdf ? el("span", { class: "pdf-badge" }, "PDF") : null,
      el("button", { class: "rot", title: "Rotate", "aria-label": `Rotate page ${i + 1}`, onclick: (ev) => {
        ev.stopPropagation();
        f.rotation = (f.rotation + 90) % 360;
        img.style.transform = `rotate(${f.rotation}deg)`;
      } }, icon("rotate")),
      el("button", { class: "rm", title: "Remove", "aria-label": `Remove page ${i + 1}`, onclick: (ev) => {
        ev.stopPropagation();
        URL.revokeObjectURL(f.url);
        state.files.splice(i, 1);
        renderThumbs();
      } }, icon("x")));
    t.addEventListener("dragstart", (ev) => { t.classList.add("dragging"); ev.dataTransfer.setData("text/x-page", String(i)); });
    t.addEventListener("dragend", () => t.classList.remove("dragging"));
    t.addEventListener("dragover", (ev) => { if (ev.dataTransfer.types.includes("text/x-page")) ev.preventDefault(); });
    t.addEventListener("drop", (ev) => {
      const from = Number(ev.dataTransfer.getData("text/x-page"));
      if (Number.isNaN(from)) return;
      ev.preventDefault(); ev.stopPropagation();
      const [moved] = state.files.splice(from, 1);
      state.files.splice(i, 0, moved);
      renderThumbs();
    });
    box.append(t);
  });
  if (state.files.length) {
    box.append(el("button", { class: "thumb add", "aria-label": "Add more pages", onclick: () => $("#fileInput").click() }, icon("plus")));
  }
  const n = state.files.length;
  $("#tray").classList.toggle("hidden", n < 1);
  $("#pageCount").textContent = String(n);
  $("#scanBtn").disabled = n === 0 || state.formats.size === 0;
  $("#scanLabel").textContent = n === 0 ? "Add a page to start"
    : state.formats.size === 0 ? "Pick an export format"
    : `Scan ${n} page${n > 1 ? "s" : ""} → ${[...state.formats].map((f) => FORMATS[f].label).join(", ")}`;
}

function initIntake() {
  const dz = $("#dropzone");
  const input = $("#fileInput"), pdfInput = $("#pdfInput");
  dz.addEventListener("keydown", (e) => { if (e.target === dz && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); input.click(); } });
  $("#browseBtn").addEventListener("click", () => input.click());
  $("#pdfBtn").addEventListener("click", () => pdfInput.click());
  for (const inp of [input, pdfInput]) inp.addEventListener("change", () => { addFiles(inp.files); inp.value = ""; });
  ["dragenter", "dragover"].forEach((t) => document.addEventListener(t, (e) => {
    if (e.dataTransfer?.types.includes("Files") && !$("#captureView").classList.contains("hidden")) { e.preventDefault(); dz.classList.add("drag"); }
  }));
  ["dragleave", "drop"].forEach((t) => document.addEventListener(t, () => dz.classList.remove("drag")));
  document.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files.length && !$("#captureView").classList.contains("hidden")) { e.preventDefault(); addFiles(e.dataTransfer.files); }
  });
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && !$("#captureView").classList.contains("hidden")) addFiles(files);
  });
  $("#cameraBtn").addEventListener("click", openCamera);
  $("#clearPages").addEventListener("click", () => {
    state.files.forEach((f) => URL.revokeObjectURL(f.url));
    state.files = [];
    renderThumbs();
  });
}

/* ---------------- camera ---------------- */
let camStream = null, camShots = 0;
async function openCamera() {
  if (isNative) {
    try { addFiles(await nativeCamera()); } catch (err) {
      if (!/cancel/i.test(err?.message || "")) toast(`Camera: ${err.message}`, true);
    }
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) { $("#fileInput").click(); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false,
    });
  } catch {
    $("#fileInput").click();
    return;
  }
  camShots = 0;
  $("#camCount").textContent = "0 captured";
  $("#camVideo").srcObject = camStream;
  $("#cameraDlg").showModal();
}
function closeCamera() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  $("#cameraDlg").close();
}
function initCamera() {
  $("#camClose").addEventListener("click", closeCamera);
  $("#cameraDlg").addEventListener("cancel", closeCamera);
  $("#camShoot").addEventListener("click", () => {
    const v = $("#camVideo");
    if (!v.videoWidth) return;
    const c = el("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    c.toBlob((blob) => {
      addFiles([new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" })]);
      camShots++;
      $("#camCount").textContent = `${camShots} captured`;
      $(".cam-wrap").animate([{ filter: "brightness(3)" }, { filter: "none" }], 250);
    }, "image/jpeg", 0.95);
  });
}

/* ---------------- settings & controls ---------------- */
function applyTheme() {
  const t = state.theme;
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  setNativeTheme(dark);
}

/** Set a choice everywhere it is shown (the same setting appears on Home, in Settings, in Export). */
function setChoice(name, value, { save = true } = {}) {
  $$(`.seg[data-name=${name}]`).forEach((seg) => $$("button", seg).forEach((x) => x.classList.toggle("on", x.dataset.value === value)));
  if (name === "imgmode") { state.imgMode = value; renderViewer(); return; }
  if (name === "docMode") { state.docMode = value; renderDoc(); return; }
  state[name] = value;
  if (save) store.set(name, value);
  if (name === "precision") { $("#precisionHint").textContent = PRECISION_HINT[value]; $("#precisionHint2").textContent = PRECISION_HINT[value]; }
  if (name === "layout") $("#layoutHint").textContent = LAYOUT_HINT[value];
  if (name === "theme") applyTheme();
}

function initControls() {
  $$(".seg").forEach((seg) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) setChoice(seg.dataset.name, b.dataset.value);
  }));
  for (const name of ["layout", "precision", "theme"]) setChoice(name, store.get(name, state[name]), { save: false });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);

  for (const id of ["flatten", "autoExport"]) {
    const box = $("#" + id);
    const saved = store.get(id);
    if (saved) box.checked = saved === "1";
    box.addEventListener("change", () => store.set(id, box.checked ? "1" : "0"));
  }

  const savedFormats = store.get("formats");
  if (savedFormats) state.formats = new Set(savedFormats.split(",").filter((f) => FORMATS[f]));
  $$(".fmt").forEach((b) => {
    b.classList.toggle("on", state.formats.has(b.dataset.fmt));
    b.addEventListener("click", () => {
      const f = b.dataset.fmt;
      state.formats.has(f) ? state.formats.delete(f) : state.formats.add(f);
      b.classList.toggle("on", state.formats.has(f));
      store.set("formats", [...state.formats].join(","));
      renderThumbs();
    });
  });

  $$(".nav-item").forEach((b) => b.addEventListener("click", () => {
    if (state.scanning) return;
    // "Scan" returns to the open result if there is one being worked on, else to the home screen.
    show(b.dataset.tab);
  }));
  $("#seeAllBtn").addEventListener("click", () => show("historyView"));
  $("#scanBtn").addEventListener("click", runScan);
  $("#newScanBtn").addEventListener("click", () => show("captureView"));
  $("#copyBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(docText(state.result.document)); toast("Text copied"); }
    catch { toast("Clipboard is blocked here", true); }
  });
  $("#zoomBtn").addEventListener("click", () => $("#viewerImg").classList.toggle("zoom"));
  $("#viewerImg").addEventListener("click", () => $("#viewerImg").classList.toggle("zoom"));
  $("#exportBtn").addEventListener("click", openExport);
  $("#exportClose").addEventListener("click", () => $("#exportDlg").close());
  $("#exportDlg").addEventListener("click", (e) => { if (e.target === $("#exportDlg")) $("#exportDlg").close(); });
  $("#reviewBtn").addEventListener("click", reviewNext);
  $("#docTitle").addEventListener("input", (e) => {
    state.result.document.title = e.target.value.trim() || null;
    scheduleHistorySave();
  });
  $("#fileSearch").addEventListener("input", () => renderFiles());
  $("#clearHistoryBtn").addEventListener("click", async () => {
    const scans = await listScans();
    if (!scans.length) { toast("There are no recent scans"); return; }
    if (!confirm(`Delete all ${scans.length} recent scans from this device?`)) return;
    for (const s of scans) await deleteScan(s.id);
    toast("Recent scans deleted");
    renderRecent();
  });
}

/* ---------------- scanning ---------------- */
function imageDataToUrl(img, type = "image/jpeg", quality = 0.85) {
  const c = el("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d").putImageData(img, 0, 0);
  return c.toDataURL(type, quality);
}

async function thumbFromFile(file, rotation, max = 480) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const swap = rotation === 90 || rotation === 270;
  const c = el("canvas");
  c.width = swap ? h : w;
  c.height = swap ? w : h;
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.8);
}

function setProgress(frac) {
  const f = Math.max(0, Math.min(1, frac));
  $("#progressRing").style.strokeDashoffset = String(RING * (1 - f));
  $("#progressPct").textContent = `${Math.round(f * 100)}%`;
}

async function runScan() {
  const files = [...state.files];
  state.scanning = true;
  show("scanView");
  setProgress(0);
  const t0 = performance.now();
  const ticker = setInterval(() => { $("#scanTimer").textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
  const pages = [], blocksByPage = [], sizes = [];
  try {
    if (state.engine === "server" && state.serverAI) {
      await runServerScan(files, pages, blocksByPage);
    } else {
      if (!engineReady) setStatus("", "Loading engine…");
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        $("#scanImg").src = f.url;
        $("#scanImg").style.transform = `rotate(${f.rotation}deg)`;
        $("#scanCount").textContent = files.length > 1 ? `Page ${i + 1} of ${files.length}` : "Reading";
        const order = ["prepare", "detect", ...(state.precision === "max" ? ["tiles"] : []), "recognize",
          ...(state.precision !== "fast" ? ["reread"] : []), "layout"];
        const list = $("#scanSteps");
        list.replaceChildren(...order.map((s) => el("li", { "data-step": s }, STEP_LABEL[s])));
        const mark = (step) => {
          const idx = order.indexOf(step);
          $$("li", list).forEach((li, k) => { li.className = k < idx ? "done" : k === idx ? "active" : ""; });
          setProgress((i + Math.max(0, idx) / order.length) / files.length);
        };
        mark("prepare");
        const pt0 = performance.now();
        const res = await recognize(f, mark);
        $$("li", list).forEach((li) => { li.className = "done"; });
        blocksByPage.push(res.blocks);
        sizes[i] = res.size;
        pages.push({
          page: i + 1,
          steps: res.steps,
          seconds: +((performance.now() - pt0) / 1000).toFixed(1),
          enhanced_preview: imageDataToUrl(res.preview),
        });
      }
    }
    setProgress(1);
    const document_ = { title: null, pages: blocksByPage.map((blocks, i) => ({ page_number: i + 1, blocks, notes: null, ...(sizes[i] || {}) })) };
    const headed = blocksByPage.flat().find((b) => b.type === "heading");
    document_.title = headed?.text?.split("\n")[0].slice(0, 80) || null;
    state.result = {
      id: `scan-${Date.now()}`,
      document: document_,
      pages: pages.map((p, i) => ({ ...p, original: files[i]?.url, rotation: files[i]?.rotation || 0 })),
      seconds: +((performance.now() - t0) / 1000).toFixed(1),
      engine_label: state.engine === "server" ? "AI vision" : "On-device",
    };
    state.page = 0;
    state.imgMode = "original";
    state.scanning = false;
    openResult();
    persist(files);
    if ($("#autoExport").checked) await downloadAll();
  } catch (err) {
    state.scanning = false;
    toast(err.message, true);
    show("captureView");
  } finally {
    state.scanning = false;
    clearInterval(ticker);
  }
}

async function runServerScan(files, pages, blocksByPage) {
  $("#scanImg").src = files[0].url;
  $("#scanSteps").replaceChildren(el("li", { class: "active" }, "AI vision is reading the pages"));
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f.file, f.file.name));
  fd.append("engine", "claude");
  fd.append("precision", state.precision);
  fd.append("enhance", $("#flatten").checked ? "true" : "false");
  const r = await fetch("api/extract", { method: "POST", body: fd });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `Server error ${r.status}`);
  body.document.pages.forEach((p, i) => {
    blocksByPage.push(p.blocks);
    pages.push({ ...body.pages[i] });
  });
}

async function persist(files) {
  const r = state.result;
  try {
    const thumb = await thumbFromFile(files[0].file, files[0].rotation);
    await saveScan({
      id: r.id, created: Date.now(), title: r.document.title || defaultName(),
      pageCount: r.pages.length, thumb, document: r.document,
      pages: r.pages.map(({ original, ...p }) => p), // original blobs are session-only; the enhanced preview is kept
    });
  } catch { /* history is best-effort */ }
}

/* ---------------- results ---------------- */
function countUncertain(doc) {
  let n = 0;
  for (const p of doc.pages) for (const b of p.blocks) {
    if (b.type === "table") n += (b.rows || []).flat().filter((c) => c.uncertain).length;
    else if (b.type === "key_value") n += (b.pairs || []).filter((kv) => kv.uncertain).length;
    else if (b.uncertain) n++;
  }
  return n;
}

function docText(doc) {
  const lines = [];
  for (const p of doc.pages) for (const b of p.blocks) {
    if (b.type === "table") lines.push((b.rows || []).map((r) => r.map((c) => c.text).join("\t")).join("\n"));
    else if (b.type === "list") lines.push((b.items || []).map((x, i) => (b.ordered ? `${i + 1}. ` : "• ") + x).join("\n"));
    else if (b.type === "key_value") lines.push((b.pairs || []).map((kv) => `${kv.key}: ${kv.value}`).join("\n"));
    else if (b.type === "checkbox") lines.push(`[${b.checked ? "x" : " "}] ${b.text || ""}`);
    else lines.push(b.text || "");
  }
  return lines.join("\n\n");
}

function openResult() {
  const doc = state.result.document;
  state.docMode = doc.pages.some(hasLayout) ? "page" : "edit";
  setChoice("docMode", state.docMode);
  $("#docTitle").value = doc.title || "";
  $("#docTitle").placeholder = defaultName();
  renderResult();
  show("resultView");
}

function renderResult() {
  const { document: doc, pages, seconds, engine_label } = state.result;
  const tables = doc.pages.reduce((n, p) => n + p.blocks.filter((b) => b.type === "table").length, 0);
  const unc = countUncertain(doc);
  const chip = (ic, text, cls = "", attrs = {}) => el("span", { class: `chip ${cls}`, ...attrs }, icon(ic), text);
  $("#stats").replaceChildren(
    chip("files", `${pages.length} page${pages.length === 1 ? "" : "s"}`),
    chip("table", `${tables} table${tables === 1 ? "" : "s"}`),
    unc ? chip("alert", `${unc} to check`, "warn", { role: "button", onclick: reviewNext }) : chip("check", "All readings confident", "ok"),
    chip("bolt", `${seconds}s · ${engine_label}`),
  );
  $("#reviewBtn").classList.toggle("hidden", !unc);
  $("#reviewBtn").classList.toggle("has-review", !!unc);
  $("#reviewBtn span").textContent = `Review ${unc}`;
  $("#pageTabs").replaceChildren(...(pages.length > 1 ? pages.map((p, i) =>
    el("button", { class: i === state.page ? "on" : "", onclick: () => { state.page = i; renderResult(); } }, `Page ${p.page}`)) : []));
  const page = doc.pages[state.page];
  $("#docModeSeg").querySelector('[data-value="page"]').classList.toggle("hidden", !hasLayout(page));
  const hasOriginal = !!pages[state.page]?.original;
  $(".seg[data-name=imgmode]").classList.toggle("hidden", !hasOriginal);
  if (!hasOriginal) state.imgMode = "enhanced";
  renderViewer();
  renderDoc();
}

function renderViewer() {
  if (!state.result) return;
  const info = state.result.pages[state.page];
  const img = $("#resultImg");
  const original = state.imgMode === "original" && info.original;
  img.src = original ? info.original : info.enhanced_preview;
  img.style.transform = original && info.rotation ? `rotate(${info.rotation}deg)` : "";
  $("#pageSteps").textContent = info.steps?.length ? "✓ " + info.steps.join(" · ") : "";
}

/** Bind an editable node to obj[key] so edits flow into downloads. */
function editable(tag, obj, key, attrs = {}) {
  const node = el(tag, { ...attrs, contenteditable: "plaintext-only", spellcheck: "false" }, obj[key] || "");
  if (node.contentEditable !== "plaintext-only") node.contentEditable = "true";
  node.addEventListener("input", () => { obj[key] = node.innerText.replace(/\n$/, ""); scheduleHistorySave(); });
  return node;
}

let saveTimer;
function scheduleHistorySave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const r = state.result;
    const existing = (await listScans()).find((s) => s.id === r.id);
    if (existing) await saveScan({ ...existing, title: r.document.title || existing.title, document: r.document });
  }, 800);
}

function renderDoc() {
  if (!state.result) return;
  const page = state.result.document.pages[state.page];
  const view = $("#docView");
  const grid = $(".grid-result");
  grid.classList.toggle("show-original", state.docMode === "original");
  view.replaceChildren();
  if (!page.blocks.length) {
    view.append(el("p", { class: "empty" }, icon("info"), "No text was found on this page. Try rotating it, or turn off “Find and flatten the page” in Settings."));
    return;
  }
  if (state.docMode === "page" && hasLayout(page)) {
    view.append(renderPageCopy(page), el("p", { class: "muted small" }, "This is how Excel, Word and PDF will look. Tap Edit to correct anything."));
    return;
  }
  view.append(el("div", { class: "legend muted small" },
    el("span", {}, el("i", { class: "sw unc" }), "Low-confidence reading"),
    el("span", {}, "Tap any text or cell to edit it. Exports include your edits.")));
  for (const b of page.blocks) view.append(renderBlock(b));
  if (page.notes) view.append(el("div", { class: "note" }, "Scanner note: " + page.notes));
}

/** Jump to the next doubtful reading (switching to Edit and to its page as needed). */
function reviewNext() {
  if (!state.result) return;
  if (state.docMode !== "edit") setChoice("docMode", "edit");
  let marks = $$("#docView .blk .unc");
  if (!marks.length) {
    const pages = state.result.document.pages;
    for (let k = 1; k <= pages.length; k++) {
      const p = (state.page + k) % pages.length;
      if (countUncertain({ pages: [pages[p]] })) { state.page = p; renderResult(); break; }
    }
    marks = $$("#docView .blk .unc");
    if (!marks.length) { toast("Nothing left to check"); return; }
  }
  reviewNext.i = ((reviewNext.i ?? -1) + 1) % marks.length;
  const m = marks[reviewNext.i];
  $$("#docView .focus-ring").forEach((x) => x.classList.remove("focus-ring"));
  m.classList.add("focus-ring");
  m.scrollIntoView({ behavior: "smooth", block: "center" });
  m.focus({ preventScroll: true });
}

/** The page copy, drawn from the same model the Excel / Word / PDF exporters use. */
function renderPageCopy(page) {
  const d = drawList(pageModel(page));
  const pct = (v, of) => `${(v / of) * 100}%`;
  const sheet = el("div", { class: "page-copy", style: `aspect-ratio: ${d.w} / ${d.h}` });
  for (const f of d.fills) {
    sheet.append(el("i", { class: "pc-fill", style: `left:${pct(f.x0, d.w)};top:${pct(f.y0, d.h)};width:${pct(f.x1 - f.x0, d.w)};height:${pct(f.y1 - f.y0, d.h)};background:#${f.fill}` }));
  }
  for (const r of d.rules) {
    const vertical = r.x0 === r.x1;
    sheet.append(el("i", { class: "pc-rule", style: vertical
      ? `left:${pct(r.x0, d.w)};top:${pct(r.y0, d.h)};height:${pct(r.y1 - r.y0, d.h)};width:1px`
      : `left:${pct(r.x0, d.w)};top:${pct(r.y0, d.h)};width:${pct(r.x1 - r.x0, d.w)};height:1px` }));
  }
  for (const t of d.texts) {
    if (!t.text.trim()) continue;
    const pad = t.inCell ? 0.25 * (t.fontPx || 10) : 0;
    sheet.append(el("span", {
      class: "pc-text" + (t.uncertain ? " unc" : "") + (t.struck ? " struck" : ""),
      style: `left:${pct(t.x0 + pad, d.w)};top:${pct(t.y0, d.h)};width:${pct(t.x1 - t.x0 - 2 * pad, d.w)};height:${pct(t.y1 - t.y0, d.h)};`
        + `font-size:${((t.fontPx || t.lineH * 0.72) / d.w) * 100}cqw;justify-content:${t.align === "right" ? "flex-end" : t.align === "center" ? "center" : "flex-start"};`
        + `${t.bold ? "font-weight:700;" : ""}color:#${t.color || "000000"}`,
    }, t.text));
  }
  return el("div", { class: "page-copy-wrap" }, sheet);
}

function renderBlock(b) {
  const wrap = el("div", { class: "blk" }, el("span", { class: "tag" }, b.type.replace("_", " ")));
  const unc = b.uncertain ? "unc" : "";
  switch (b.type) {
    case "heading":
      wrap.append(editable("h" + Math.min(3, Math.max(1, b.level || 1)), b, "text", { class: unc }));
      break;
    case "list": {
      const list = el(b.ordered ? "ol" : "ul");
      (b.items || []).forEach((_, i) => list.append(editable("li", b.items, i, { class: unc })));
      wrap.append(list);
      break;
    }
    case "table":
      wrap.append(renderTable(b));
      break;
    case "key_value": {
      const kv = el("div", { class: "kv" });
      for (const p of b.pairs || []) {
        kv.append(editable("div", p, "key", { class: "k" + (p.uncertain ? " unc" : "") }), editable("div", p, "value", { class: p.uncertain ? "unc" : "" }));
      }
      wrap.append(kv);
      break;
    }
    case "checkbox": {
      const box = el("input", { type: "checkbox" });
      box.checked = !!b.checked;
      box.addEventListener("change", () => { b.checked = box.checked; scheduleHistorySave(); });
      wrap.append(el("label", { class: "chk" }, box, editable("span", b, "text", { class: unc })));
      break;
    }
    case "signature":
    case "figure":
      wrap.append(el("p", { class: "fig" }, b.type === "signature" ? "✍ Signature: " : "▣ ", editable("span", b, "text")));
      break;
    default:
      wrap.append(editable("p", b, "text", { class: unc }));
  }
  return wrap;
}

function renderTable(b) {
  const frag = el("div");
  const draw = () => {
    const table = el("table");
    (b.rows || []).forEach((row, r) => {
      const tr = el("tr", { class: r < (b.header_rows || 0) ? "hdr" : "" });
      row.forEach((cell) => tr.append(editable("td", cell, "text", {
        class: [cell.uncertain ? "unc" : "", cell.struck ? "struck" : ""].join(" ").trim(),
        title: [cell.uncertain ? "Low-confidence reading" : "", cell.struck ? "Crossed out on the original" : ""].filter(Boolean).join(" · "),
      })));
      table.append(tr);
    });
    const width = b.rows?.[0]?.length || 1;
    const blank = () => ({ text: "", uncertain: false });
    const edit = (fn) => () => { fn(); draw(); renderResultChips(); scheduleHistorySave(); };
    const tools = el("div", { class: "tbl-tools" },
      el("button", { onclick: edit(() => b.rows.push(Array.from({ length: width }, blank))) }, "+ Row"),
      el("button", { onclick: edit(() => b.rows.forEach((r) => r.push(blank()))) }, "+ Column"),
      el("button", { onclick: edit(() => { if (b.rows.length > 1) b.rows.pop(); }) }, "− Row"),
      el("button", { onclick: edit(() => { if (width > 1) b.rows.forEach((r) => r.pop()); }) }, "− Column"),
      el("button", { onclick: edit(() => { b.header_rows = b.header_rows ? 0 : 1; }) }, "Header row"),
      el("button", { onclick: edit(() => { b.rows.flat().forEach((c) => { c.uncertain = false; }); b.uncertain = false; }) }, "✓ Mark checked"));
    frag.replaceChildren(el("div", { class: "tbl-wrap" }, table), tools);
  };
  if (!b.rows?.length) b.rows = [[{ text: "", uncertain: false }]];
  draw();
  return frag;
}

function renderResultChips() {
  const keep = state.docMode;
  renderResult();
  state.docMode = keep;
}

/* ---------------- export ---------------- */
/** "OmniScan 2026-10-01 0955": unique per scan, so a new scan never overwrites an earlier file. */
function defaultName() {
  const t = Number(String(state.result?.id || "").replace(/\D/g, "")) || Date.now();
  const d = new Date(t), p = (n) => String(n).padStart(2, "0");
  return `OmniScan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

function openExport() {
  const list = $("#dlGroup");
  list.replaceChildren(...Object.keys(FORMATS).map((f) => {
    const item = el("button", { class: "export-item", "data-fmt": f },
      el("span", { class: `fmt-ic ${{ xlsx: "x", docx: "w", pdf: "p", csv: "c", md: "m", txt: "t", json: "j" }[f]}` }, { xlsx: "XLS", docx: "DOC", pdf: "PDF", csv: "CSV", md: "MD", txt: "TXT", json: "{ }" }[f]),
      el("div", {}, el("b", {}, FORMATS[f].label), el("small", {}, FORMAT_INFO[f])),
      icon(isNative ? "share" : "chev"));
    item.addEventListener("click", async () => {
      item.classList.add("busy");
      await download(f);
      item.classList.remove("busy");
    });
    return item;
  }));
  $("#exportDlg").showModal();
}

async function download(fmt, { share = true } = {}) {
  try {
    const file = await exportDocument(state.result.document, fmt, state.result.document.title || defaultName(), { layout: state.layout });
    const { where } = await saveFile(file, { share });
    if (!isNative) return;
    toast(`${file.filename} saved to ${where}`);
  } catch (err) {
    toast(`Export failed: ${err.message}`, true);
  }
}

async function downloadAll() {
  const fmts = [...state.formats];
  if (isNative && fmts.length > 1) {
    // One share sheet per file would be noisy: save all, share only the first.
    for (const [i, f] of fmts.entries()) await download(f, { share: i === 0 });
  } else {
    for (const f of fmts) await download(f);
  }
  if (!isNative) toast(`Saved: ${fmts.map((f) => FORMATS[f].label).join(", ")}. Edit and export again any time.`);
}

/* ---------------- files ---------------- */
function fileRow(s, { actions = true } = {}) {
  const date = new Date(s.created).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const row = el("div", { class: "file", role: "button", tabindex: "0", onclick: () => reopen(s), onkeydown: (e) => { if (e.key === "Enter") reopen(s); } },
    el("img", { src: s.thumb, alt: "" }),
    el("div", { class: "file-meta" }, el("b", {}, s.title), el("small", {}, `${date} · ${s.pageCount} page${s.pageCount > 1 ? "s" : ""}`)));
  if (actions) {
    row.append(el("div", { class: "file-actions" },
      el("button", { class: "icon-btn small", title: "Rename", "aria-label": "Rename scan", onclick: async (ev) => {
        ev.stopPropagation();
        const name = prompt("Rename scan", s.title);
        if (!name?.trim()) return;
        s.title = name.trim();
        s.document = { ...s.document, title: s.title };
        await saveScan(s);
        renderFiles();
      } }, icon("edit")),
      el("button", { class: "icon-btn small", title: "Delete", "aria-label": "Delete scan", onclick: async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete “${s.title}”?`)) return;
        await deleteScan(s.id);
        renderFiles();
      } }, icon("trash"))));
  }
  return row;
}

const emptyFiles = (text) => el("div", { class: "empty" }, icon("files"), text);

async function renderFiles() {
  const q = $("#fileSearch").value.trim().toLowerCase();
  const scans = (await listScans()).filter((s) => !q || s.title.toLowerCase().includes(q) || docText(s.document).toLowerCase().includes(q));
  $("#historyList").replaceChildren(...(scans.length ? scans.map((s) => fileRow(s))
    : [emptyFiles(q ? "No scans match your search." : "No scans yet. Your scans will appear here, stored on this device only.")]));
}

async function renderRecent() {
  const scans = (await listScans()).slice(0, 4);
  $("#recentList").replaceChildren(...(scans.length ? scans.map((s) => fileRow(s, { actions: false }))
    : [emptyFiles("Your recent scans will appear here.")]));
  $("#seeAllBtn").classList.toggle("hidden", !scans.length);
}

function reopen(scan) {
  state.result = {
    id: scan.id,
    document: scan.document,
    pages: scan.pages,
    seconds: scan.pages.reduce((s, p) => s + (p.seconds || 0), 0).toFixed(1),
    engine_label: "From Files",
  };
  if (!state.result.document.title && scan.title) state.result.document.title = scan.title;
  state.page = 0;
  state.imgMode = "enhanced";
  openResult();
}

/* ---------------- boot ---------------- */
// The Android shell adds cross-origin isolation headers from its first response on; if the very
// first page load raced ahead of that, reload once so the OCR engine gets all CPU cores.
if (isNative && !self.crossOriginIsolated) {
  try {
    if (!sessionStorage.getItem("isolationReload")) {
      sessionStorage.setItem("isolationReload", "1");
      location.reload();
    }
  } catch { /* storage blocked: run single-threaded */ }
}
initNativeChrome();
initIntake();
initCamera();
initControls();
onAdsChange(() => $("#adPrivacyBtn").classList.toggle("hidden", !adPrivacyRequired()));
$("#adPrivacyBtn").addEventListener("click", () => showAdPrivacyOptions().catch(() => toast("Ad privacy choices are unavailable offline", true)));
initAds();
detectServerAI();
renderThumbs();
renderRecent();
