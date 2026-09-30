// Everything that differs between the Android app (Capacitor) and a plain browser.

import { Capacitor } from "@capacitor/core";

export const isNative = Capacitor.isNativePlatform();

function toBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/** Take photos with the native camera app (full sensor resolution, auto-focus). Returns Files. */
export async function nativeCamera() {
  const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
  const photo = await Camera.getPhoto({
    source: CameraSource.Camera,
    resultType: CameraResultType.Uri,
    quality: 95,
    correctOrientation: true,
    saveToGallery: false,
  });
  const blob = await (await fetch(photo.webPath)).blob();
  return [new File([blob], `camera-${Date.now()}.${photo.format || "jpg"}`, { type: blob.type || "image/jpeg" })];
}

/**
 * Save an exported file. Android: writes to Documents/OmniScan when allowed, and always offers
 * the share sheet (open in Excel/Word, save to Drive, send by WhatsApp or e-mail...).
 * Browser: a normal download.
 */
export async function saveFile({ bytes, mime, filename }, { share = true } = {}) {
  if (!isNative) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { where: "Downloads" };
  }
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const data = toBase64(bytes);
  let savedTo = null;
  try {
    await Filesystem.writeFile({ path: `OmniScan/${filename}`, data, directory: Directory.Documents, recursive: true });
    savedTo = `Documents/OmniScan/${filename}`;
  } catch {
    /* scoped storage may refuse; the share sheet below still lets the user keep the file */
  }
  if (share || !savedTo) {
    const cached = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
    const { Share } = await import("@capacitor/share");
    try {
      await Share.share({ title: filename, files: [cached.uri], dialogTitle: `Open or save ${filename}` });
    } catch {
      /* user closed the share sheet */
    }
  }
  return { where: savedTo || "the app you chose" };
}

export async function initNativeChrome() {
  if (!isNative) return;
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: "#05070d" });
  } catch { /* not available on every device */ }
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch { /* ignore */ }
}
