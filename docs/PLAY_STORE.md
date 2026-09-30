# Publishing OmniScan on Google Play

## 1. One-time setup
1. Create a Google Play developer account (one-time US$25): https://play.google.com/console
2. Add the four signing secrets to this GitHub repository (see the README, "Signing").
3. Run **Actions → Build Android app → Run workflow** on `main`. The GitHub Release it creates
   contains `OmniScan-1.0.N.aab` (for Play) and `OmniScan-1.0.N.apk` (to install directly).

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
> • 100% on-device: works offline, no account, no ads, nothing is uploaded

- App icon: `assets/icon-only.png` (resize to 512×512)
- Feature graphic (1024×500) and at least 2 phone screenshots: take them on your phone.
- Category: **Productivity** · Tags: Document scanner, OCR, Spreadsheet

## 4. App content answers
- **Privacy policy URL**:
  `https://github.com/sulemanshehzad560-cloud/Picture-to-Excel-or-PDF-converter/blob/main/PRIVACY.md`
- **Ads**: No ads.
- **Data safety**: *No data collected* and *no data shared*. The app has no internet permission;
  all processing is on-device.
- **Target audience**: 18+ (or 13+; the app has no content concerns).
- **Content rating**: complete the questionnaire. Utility app, no user-generated sharing, no violence → "Everyone".
- **Government / financial / health features**: None.

## 5. Updates
Every push to `main` builds a new release with a higher version code. Upload the new `.aab`
to Play Console to ship the update.
