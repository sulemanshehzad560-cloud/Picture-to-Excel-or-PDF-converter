// AdMob banner for the Android app, with Google's consent form (UMP) where the law requires it
// (EEA, UK, Switzerland, some US states). One adaptive banner at the bottom of the screen, labelled
// and kept clear of the app's buttons. Nothing is loaded in a browser or before consent allows it.

import config from "../../admob.config.json";
import { isNative } from "./platform.js";

const TEST_PUBLISHER = "ca-app-pub-3940256099942544";
const TEST_BANNER = "ca-app-pub-3940256099942544/9214589741";
let bannerId = config.bannerId;
let testing = bannerId.startsWith(TEST_PUBLISHER);

/**
 * Debug builds (the APK from GitHub, for trying the app) always show Google's test ads, so tapping
 * an ad while testing never counts as an invalid click. Only debug builds contain build-type.json
 * (android/app/src/debug/assets); the Play Store build serves live ads.
 */
async function useTestAdsInDebug() {
  try {
    const r = await fetch("build-type.json", { cache: "no-store" });
    if (r.ok && (await r.json()).debug) { bannerId = TEST_BANNER; testing = true; }
  } catch { /* release build: no file */ }
}

let AdMob = null, shown = false, wanted = true, privacyRequired = false;
const listeners = new Set();

/** True when the user must be able to reopen the consent form ("Ad privacy choices"). */
export const adPrivacyRequired = () => privacyRequired;
export const onAdsChange = (fn) => listeners.add(fn);

function setInset(px) {
  document.documentElement.style.setProperty("--ad-inset", `${px}px`);
  document.body.classList.toggle("has-ad", px > 0);
  listeners.forEach((fn) => fn());
}

/** Call once at start-up. Never throws: ads are optional, the app works without them. */
export async function initAds() {
  if (!isNative || !config.bannerId) return;
  try {
    await useTestAdsInDebug();
    ({ AdMob } = await import("@capacitor-community/admob"));
    let info = await AdMob.requestConsentInfo();
    if (info.isConsentFormAvailable && info.status === "REQUIRED") info = await AdMob.showConsentForm();
    privacyRequired = info.privacyOptionsRequirementStatus === "REQUIRED";
    listeners.forEach((fn) => fn());
    if (!info.canRequestAds) return;
    await AdMob.initialize({ initializeForTesting: testing });
    AdMob.addListener("bannerAdSizeChanged", (size) => setInset(size?.height || 0));
    AdMob.addListener("bannerAdFailedToLoad", () => setInset(0));
    if (wanted) await showBanner();
  } catch (err) {
    console.warn("Ads unavailable:", err?.message || err);
  }
}

async function showBanner() {
  if (!AdMob || shown) return;
  shown = true;
  await AdMob.showBanner({
    adId: bannerId,
    adSize: "ADAPTIVE_BANNER",
    position: "BOTTOM_CENTER",
    margin: 0,
    isTesting: testing,
  });
}

/** Hide the banner on screens where it must not appear (a scan in progress), show it again after. */
export async function setBannerVisible(visible) {
  wanted = visible;
  if (!AdMob) return;
  try {
    if (visible && !shown) await showBanner();
    else if (visible) await AdMob.resumeBanner();
    else if (shown) { await AdMob.hideBanner(); setInset(0); }
  } catch { /* ignore: ads are optional */ }
}

/** "Ad privacy choices": lets the user change their consent at any time. */
export async function showAdPrivacyOptions() {
  if (AdMob) await AdMob.showPrivacyOptionsForm();
}
