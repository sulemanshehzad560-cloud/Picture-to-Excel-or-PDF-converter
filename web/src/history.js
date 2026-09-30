// Recent scans, kept on this device only (IndexedDB), so a result can be reopened and re-exported.

const DB = "omniscan", STORE = "scans", KEEP = 40;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

/** {id, created, title, pages, thumb (data URL), document, previews: [data URL]} */
export async function saveScan(scan) {
  try {
    await tx("readwrite", (s) => s.put(scan));
    const all = await listScans();
    for (const old of all.slice(KEEP)) await tx("readwrite", (s) => s.delete(old.id));
  } catch { /* storage full or blocked (private mode): history is a convenience, never fatal */ }
}

export async function listScans() {
  try {
    const all = await tx("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.created - a.created);
  } catch {
    return [];
  }
}

export async function deleteScan(id) {
  try { await tx("readwrite", (s) => s.delete(id)); } catch { /* ignore */ }
}
