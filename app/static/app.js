"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k, d = "") { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  files: [],             // {file, url}
  engine: "auto",
  precision: "high",
  formats: new Set(["xlsx"]),
  result: null,          // server response
  page: 0,
  imgMode: "original",
};

const PRECISION_HINT = {
  fast: "Single pass on the whole page. Quickest.",
  high: "Whole page plus 4 zoomed tiles, so small dots and decimals stay sharp.",
  max: "Whole page, 9 zoomed tiles and a second proof-reading pass. Slowest, most exact.",
};
const FORMAT_LABEL = { xlsx: "Excel", docx: "Word", pdf: "PDF", csv: "CSV", md: "Markdown", txt: "Text", json: "JSON" };

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

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), isErr ? 6000 : 2800);
}

function show(view) {
  for (const v of ["captureView", "scanView", "resultView"]) $("#" + v).classList.toggle("hidden", v !== view);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------------- engines ---------------- */
async function loadEngines() {
  const pill = $("#engineStatus");
  try {
    const r = await fetch("/api/engines");
    const e = await r.json();
    const ai = e.claude.server_key || !!store.get("apiKey");
    pill.className = "pill " + (ai ? "ok" : "warn");
    pill.lastElementChild.textContent = ai ? "AI vision ready" : (e.tesseract.available ? "Offline OCR only" : "No engine available");
    pill.title = ai ? "Handwriting-grade recognition is active." : "Add an Anthropic API key in Settings for handwriting-grade recognition.";
  } catch {
    pill.className = "pill warn";
    pill.lastElementChild.textContent = "Server unreachable";
  }
}

/* ---------------- file intake ---------------- */
const ACCEPT = /^image\//;
function addFiles(list) {
  let added = 0;
  for (const f of list) {
    if (!ACCEPT.test(f.type) && !/\.(jpe?g|png|webp|tiff?|bmp|gif|heic)$/i.test(f.name)) continue;
    state.files.push({ file: f, url: URL.createObjectURL(f) });
    added++;
  }
  if (!added && list.length) toast("Only image files can be scanned.", true);
  renderThumbs();
}

function renderThumbs() {
  const box = $("#thumbs");
  box.replaceChildren();
  state.files.forEach((f, i) => {
    const t = el("div", { class: "thumb", draggable: "true", "data-i": i },
      el("img", { src: f.url, alt: `Page ${i + 1}` }),
      el("span", { class: "num" }, `P${i + 1}`),
      el("button", { class: "rm", title: "Remove", "aria-label": `Remove page ${i + 1}`, onclick: (ev) => {
        ev.stopPropagation();
        URL.revokeObjectURL(f.url);
        state.files.splice(i, 1);
        renderThumbs();
      } }, "×"));
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
  const n = state.files.length;
  $("#thumbHint").classList.toggle("hidden", n < 2);
  $("#scanBtn").disabled = n === 0 || state.formats.size === 0;
  $("#scanLabel").textContent = n === 0 ? "Add a page to start"
    : state.formats.size === 0 ? "Pick an output format"
    : `Scan ${n} page${n > 1 ? "s" : ""} → ${[...state.formats].map((f) => FORMAT_LABEL[f]).join(", ")}`;
}

function initIntake() {
  const dz = $("#dropzone");
  const input = $("#fileInput");
  dz.addEventListener("click", (e) => { if (!e.target.closest("button")) input.click(); });
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  $("#browseBtn").addEventListener("click", () => input.click());
  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  $("#cameraInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => {
    if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); dz.classList.add("drag"); }
  }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, () => dz.classList.remove("drag")));
  dz.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && !$("#captureView").classList.contains("hidden")) { addFiles(files); toast(`Pasted ${files.length} image(s)`); }
  });
  $("#cameraBtn").addEventListener("click", openCamera);
}

/* ---------------- live camera ---------------- */
let camStream = null, camShots = 0;
async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { $("#cameraInput").click(); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false,
    });
  } catch {
    $("#cameraInput").click();  // permission denied or no camera: fall back to the OS picker/camera
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
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    c.toBlob((blob) => {
      addFiles([new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" })]);
      camShots++;
      $("#camCount").textContent = `${camShots} captured`;
      $(".cam-wrap").animate([{ filter: "brightness(3)" }, { filter: "none" }], 250);
    }, "image/jpeg", 0.95);
  });
}

/* ---------------- controls ---------------- */
function initControls() {
  $$(".seg").forEach((seg) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $$("button", seg).forEach((x) => x.classList.toggle("on", x === b));
    const name = seg.dataset.name;
    state[name === "imgmode" ? "imgMode" : name] = b.dataset.value;
    if (name === "precision") { $("#precisionHint").textContent = PRECISION_HINT[b.dataset.value]; store.set("precision", b.dataset.value); }
    if (name === "engine") store.set("engine", b.dataset.value);
    if (name === "imgmode") renderViewer();
  }));
  for (const [name, key] of [["engine", "engine"], ["precision", "precision"]]) {
    const saved = store.get(key);
    if (saved) $(`.seg[data-name=${name}] button[data-value=${saved}]`)?.click();
  }
  $("#precisionHint").textContent = PRECISION_HINT[state.precision];

  const savedFormats = store.get("formats");
  if (savedFormats) state.formats = new Set(savedFormats.split(",").filter((f) => FORMAT_LABEL[f]));
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

  $("#settingsBtn").addEventListener("click", () => {
    $("#apiKey").value = store.get("apiKey");
    $("#fileName").value = store.get("fileName");
    $("#settingsDlg").showModal();
  });
  $("#saveSettings").addEventListener("click", () => {
    store.set("apiKey", $("#apiKey").value.trim());
    store.set("fileName", $("#fileName").value.trim());
    loadEngines();
    toast("Settings saved");
  });
  $("#scanBtn").addEventListener("click", runScan);
  $("#newScanBtn").addEventListener("click", () => show("captureView"));
  $("#copyBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(docText(state.result.document)); toast("Text copied"); }
    catch { toast("Clipboard is blocked in this browser", true); }
  });
  $("#viewerImg").addEventListener("click", () => $("#viewerImg").classList.toggle("zoom"));
}

/* ---------------- scanning ---------------- */
async function runScan() {
  const files = state.files;
  show("scanView");
  $("#scanImg").src = files[0].url;
  $("#scanCount").textContent = files.length > 1 ? `${files.length} pages` : "";
  const steps = [
    "Uploading pages",
    $("#enhance").checked ? "Flattening page & removing shadows" : "Reading raw image",
    "Correcting skew, boosting faint ink",
    state.precision === "fast" ? "Reading the page" : "Zooming into tiles for fine detail",
    "Recognising text & handwriting",
    "Rebuilding tables, forms & layout",
    ...(state.precision === "max" ? ["Proof-reading every character"] : []),
    "Scoring confidence",
  ];
  const list = $("#scanSteps");
  list.replaceChildren(...steps.map((s) => el("li", {}, s)));
  const items = $$("li", list);
  let idx = 0;
  const advance = () => {
    items.forEach((li, i) => { li.className = i < idx ? "done" : i === idx ? "active" : ""; });
    $("#progressBar").style.width = `${Math.min(95, (idx / steps.length) * 100)}%`;
  };
  advance();
  const t0 = performance.now();
  // Real work happens server-side in one request, so step through the log on a
  // time curve that slows down near the end instead of pretending to know progress.
  const expected = { fast: 12, high: 30, max: 75 }[state.precision] * Math.max(1, Math.ceil(files.length / 4));
  const ticker = setInterval(() => {
    const secs = (performance.now() - t0) / 1000;
    $("#scanTimer").textContent = `${secs.toFixed(1)} s`;
    const target = Math.floor((1 - Math.exp(-secs / (expected / 2.2))) * (steps.length - 1));
    if (target > idx) { idx = target; advance(); }
    if (files.length > 1) $("#scanImg").src = files[Math.floor(secs / 2.5) % files.length].url;
  }, 200);

  const fd = new FormData();
  files.forEach((f) => fd.append("files", f.file, f.file.name));
  fd.append("engine", state.engine);
  fd.append("precision", state.precision);
  fd.append("enhance", $("#enhance").checked ? "true" : "false");
  const headers = {};
  const key = store.get("apiKey");
  if (key) headers["X-Anthropic-Key"] = key;

  try {
    const r = await fetch("/api/extract", { method: "POST", body: fd, headers });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || `Server error ${r.status}`);
    idx = steps.length; advance();
    $("#progressBar").style.width = "100%";
    state.result = body;
    state.page = 0;
    await new Promise((res) => setTimeout(res, 350));
    renderResult();
    show("resultView");
    downloadAll();
  } catch (err) {
    toast(err.message, true);
    show("captureView");
  } finally {
    clearInterval(ticker);
  }
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

function renderResult() {
  const { document: doc, pages, seconds, engine_label } = state.result;
  const blocks = doc.pages.reduce((n, p) => n + p.blocks.length, 0);
  const tables = doc.pages.reduce((n, p) => n + p.blocks.filter((b) => b.type === "table").length, 0);
  const unc = countUncertain(doc);
  const stat = (v, label, cls = "") => el("div", { class: "stat " + cls }, el("b", {}, String(v)), el("span", {}, label));
  $("#stats").replaceChildren(
    stat(pages.length, pages.length === 1 ? "page" : "pages"),
    stat(blocks, "blocks"),
    stat(tables, tables === 1 ? "table" : "tables"),
    stat(unc, "to verify", unc ? "warn" : "good"),
    stat(`${seconds}s`, engine_label.split(" (")[0]),
  );
  $("#dlGroup").replaceChildren(...Object.keys(FORMAT_LABEL).map((f) =>
    el("button", { class: "btn " + (state.formats.has(f) ? "primary" : "ghost"), onclick: () => download(f) }, `⬇ ${FORMAT_LABEL[f]}`)));
  $("#pageTabs").replaceChildren(...(pages.length > 1 ? pages.map((p, i) =>
    el("button", { class: i === state.page ? "on" : "", onclick: () => { state.page = i; renderResult(); } }, `Page ${p.page}`)) : []));
  renderViewer();
  renderDoc();
}

function renderViewer() {
  if (!state.result) return;
  const info = state.result.pages[state.page];
  $("#resultImg").src = state.imgMode === "enhanced" ? info.enhanced_preview : state.files[state.page]?.url || info.enhanced_preview;
  $("#pageSteps").textContent = info.steps.length ? "✓ " + info.steps.join(" · ") : "";
}

/** Bind a contenteditable node to a property so edits flow into downloads. */
function editable(tag, obj, key, attrs = {}) {
  const node = el(tag, { ...attrs, contenteditable: "plaintext-only", spellcheck: "false" }, obj[key] || "");
  if (node.contentEditable !== "plaintext-only") node.contentEditable = "true";
  node.addEventListener("input", () => { obj[key] = node.innerText.replace(/\n$/, ""); });
  return node;
}

function renderDoc() {
  const page = state.result.document.pages[state.page];
  const view = $("#docView");
  view.replaceChildren();
  if (!page.blocks.length) {
    view.append(el("p", { class: "empty" }, "No text was found on this page."));
    return;
  }
  for (const b of page.blocks) view.append(renderBlock(b));
  if (page.notes) view.append(el("div", { class: "note" }, "Scanner note: " + page.notes));
}

function renderBlock(b) {
  const wrap = el("div", { class: "blk" }, el("span", { class: "tag" }, b.type.replace("_", " ")));
  const unc = b.uncertain ? " unc" : "";
  switch (b.type) {
    case "heading":
      wrap.append(editable("h" + Math.min(3, Math.max(1, b.level || 1)), b, "text", { class: unc.trim() }));
      break;
    case "list": {
      const list = el(b.ordered ? "ol" : "ul");
      (b.items || []).forEach((_, i) => list.append(editable("li", b.items, i, { class: unc.trim() })));
      wrap.append(list);
      break;
    }
    case "table":
      wrap.append(renderTable(b));
      break;
    case "key_value": {
      const kv = el("div", { class: "kv" });
      for (const p of b.pairs || []) {
        kv.append(editable("div", p, "key", { class: "k" + (p.uncertain ? " unc" : "") }),
                  editable("div", p, "value", { class: p.uncertain ? "unc" : "" }));
      }
      wrap.append(kv);
      break;
    }
    case "checkbox": {
      const box = el("input", { type: "checkbox" });
      box.checked = !!b.checked;
      box.addEventListener("change", () => { b.checked = box.checked; });
      wrap.append(el("label", { class: "chk" }, box, editable("span", b, "text", { class: unc.trim() })));
      break;
    }
    case "signature":
    case "figure":
      wrap.append(el("p", { class: "fig" }, b.type === "signature" ? "✍ Signature: " : "▣ ", editable("span", b, "text")));
      break;
    default:
      wrap.append(editable("p", b, "text", { class: unc.trim() }));
  }
  return wrap;
}

function renderTable(b) {
  const frag = el("div");
  const draw = () => {
    const table = el("table");
    (b.rows || []).forEach((row, r) => {
      const tr = el("tr", { class: r < (b.header_rows || 0) ? "hdr" : "" });
      row.forEach((cell) => tr.append(editable("td", cell, "text", { class: cell.uncertain ? "unc" : "", title: cell.uncertain ? "Low-confidence reading" : "" })));
      table.append(tr);
    });
    const width = b.rows?.[0]?.length || 1;
    const blank = () => ({ text: "", uncertain: false });
    const tools = el("div", { class: "tbl-tools" },
      el("button", { onclick: () => { b.rows.push(Array.from({ length: width }, blank)); draw(); } }, "+ row"),
      el("button", { onclick: () => { b.rows.forEach((r) => r.push(blank())); draw(); } }, "+ column"),
      el("button", { onclick: () => { if (b.rows.length > 1) { b.rows.pop(); draw(); } } }, "− row"),
      el("button", { onclick: () => { if (width > 1) { b.rows.forEach((r) => r.pop()); draw(); } } }, "− column"),
      el("button", { onclick: () => { b.header_rows = (b.header_rows || 0) ? 0 : 1; draw(); } }, "toggle header"),
      el("button", { onclick: () => { b.rows.flat().forEach((c) => { c.uncertain = false; }); b.uncertain = false; draw(); } }, "mark verified"));
    frag.replaceChildren(el("div", { class: "tbl-wrap" }, table), tools);
  };
  if (!b.rows?.length) b.rows = [[{ text: "", uncertain: false }]];
  draw();
  return frag;
}

async function download(fmt) {
  const name = store.get("fileName") || state.result.document.title || "scan";
  try {
    const r = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: state.result.document, format: fmt, filename: name }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `Export failed (${r.status})`);
    const blob = await r.blob();
    const cd = r.headers.get("Content-Disposition") || "";
    const fname = /filename="([^"]+)"/.exec(cd)?.[1] || `scan.${fmt}`;
    const a = el("a", { href: URL.createObjectURL(blob), download: fname });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (err) {
    toast(err.message, true);
  }
}

async function downloadAll() {
  for (const f of state.formats) await download(f);
  toast(`Ready: ${[...state.formats].map((f) => FORMAT_LABEL[f]).join(", ")} downloaded. Edit below and re-download any time.`);
}

initIntake();
initCamera();
initControls();
renderThumbs();
loadEngines();
