# Publishing OmniScan on Google Play

## 1. One-time setup
1. Create a Google Play developer account (one-time US$25): https://play.google.com/console
2. Add the signing secret to this GitHub repository (see the README, "Signing"): one secret,
   `OMNISCAN_UPLOAD_PASSWORD`.
3. Run **Actions → Build Android app → Run workflow** on `main`. The GitHub Release it creates
   contains `OmniScan-1.0.N.aab` (for Play) and `OmniScan-1.0.N.apk` (to install directly).
4. **AdMob** (https://apps.admob.com): add an app (Android, not yet listed is fine, package
   `com.sulemanshehzad.omniscan`), create one **Banner** ad unit, and put both IDs in
   `admob.config.json`. Until then only Google's test ads are shown. In AdMob, also set up
   **Privacy & messaging → GDPR** (European regulations) and publish the message, so the consent
   form appears for EEA/UK users. Once the app is live on Play, link it in AdMob (App settings →
   App store details) and add `app-ads.txt` to your developer website if you have one.

## 2. Create the app in Play Console
- App name: **OmniScan: Handwriting to Excel**
- Default language: English
- App or game: App · Free or paid: Free
- Upload `OmniScan-1.0.N.aab` under **Test and release → Production** (or start with
  **Internal testing** to try it on your own phone first). Keep **Play App Signing** on (the default).

## 3. Store listing (suggested text)
**Short description (80 chars max)**
> Scan handwriting & documents to Excel, Word or PDF. Offline, private, precise.

**Full description**
> OmniScan reads any page, even messy handwriting, and turns it into a real Excel sheet, Word
> document or clean PDF.
>
> • Handwriting that other scanners give up on: notes, ledgers, forms, receipts and order lists
> • Tables become real spreadsheet cells, with numbers kept exactly as written (0.750 stays 0.750)
> • Form fields become Label/Value columns; lists, headings and checkboxes are kept
> • Every doubtful reading is highlighted so you can check it; tap to fix before exporting
> • Export to Excel (.xlsx), Word (.docx), PDF, CSV, Markdown, text or JSON, and share anywhere
> • Scan several pages at once, from the camera, the gallery or a scanned PDF
> • Straightens photos taken at an angle and removes shadows automatically
> • Private: your documents are processed on your phone and never uploaded. No account needed.
> • Free, supported by a small banner ad

- App icon: `assets/icon-only.png` (resize to 512×512)
- Feature graphic (1024×500) and at least 2 phone screenshots: take them on your phone.
- Category: **Productivity** · Tags: Document scanner, OCR, Spreadsheet

## 4. App content answers
- **Privacy policy URL**:
  `https://github.com/sulemanshehzad560-cloud/Picture-to-Excel-or-PDF-converter/blob/main/PRIVACY.md`
- **Ads**: **Yes, my app contains ads.**
- **Advertising ID**: **Yes**, the app uses the advertising ID. Purpose: **Advertising or
  marketing** (and **Analytics**, as used by AdMob).
- **Data safety**:
  - Data collected **and shared** (automatically, by the Google Mobile Ads SDK, for ads):
    **Device or other IDs** (advertising ID), **Approximate location**, **App interactions**,
    **Diagnostics** (crash logs, performance). Purposes: Advertising or marketing, Analytics,
    Fraud prevention, security and compliance. Collection is required for ads; encrypted in transit.
  - **Photos, files and documents**: **not collected** (processed on the device only).
  - No account, so no personal info (name, e-mail) is collected.
  - Data deletion: users can reset their advertising ID in their phone's settings.
- **Target audience**: 18+ (or 13+). Do not include children under 13: the app shows personalised ads.
- **Content rating**: complete the questionnaire. Utility app, no user-generated sharing, no violence → "Everyone".
- **Government / financial / health features**: None.

## 5. Updates
Every push to `main` builds a new release with a higher version code. Upload the new `.aab`
to Play Console to ship the update.
