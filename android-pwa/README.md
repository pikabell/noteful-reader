# Noteful Reader for Android (PWA)

An installable, **read-only** Android app for your Noteful notebooks. It syncs
`.noteful` files from Google Drive and then works **fully offline**: parsing,
PDF rendering and handwriting rendering all happen on the device. No Linux
server is needed.

It is a Progressive Web App — open it in Chrome on Android and choose
**Install app** / **Add to Home screen**. It then launches like a normal app
with its own icon and full-screen window.

## One-time Google setup

The app asks Google for **read-only Drive access** (`drive.readonly`), so you
need your own OAuth client ID. Google does not allow anonymous apps to access
Drive.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. Enable **Google Drive API** (APIs & Services → Library).
3. Configure the **OAuth consent screen**. Add your own Google account as a
   **Test user** if the app stays in "Testing" mode.
4. Create credentials → **OAuth client ID** → application type **Web application**.
   Add the URL where you host this folder to **Authorized JavaScript origins**
   (e.g. `https://<your-name>.github.io`). For local testing also add
   `http://localhost:8123`.
5. Copy the client ID into [`js/config.js`](js/config.js):

   ```js
   GOOGLE_CLIENT_ID: '1234567890-abcdefgh.apps.googleusercontent.com'
   ```

Optionally set `DRIVE_FOLDER_ID` in the same file to limit sync to one Drive
folder. Leave it empty to sync every `.noteful` file in your Drive.

## Hosting / installing on Android

The app must be served over HTTPS (or `localhost`) for Google sign-in and
service workers to work. The simplest option is GitHub Pages:

1. Push this repository to GitHub.
2. Settings → Pages → Source: **Deploy from a branch** → `main` → `/root`.
3. Open `https://<your-username>.github.io/noteful-reader/android-pwa/` in
   Chrome on your Android device.
4. Chrome menu → **Install app** (or **Add to Home screen**).

For local testing on the same machine:

```bash
cd android-pwa
python3 -m http.server 8123
# open http://localhost:8123 in Chrome
```

## How sync works

- **Sync Drive** signs you in with Google and lists all `.noteful` files.
- Files are downloaded into **IndexedDB** on your device. The service worker
  caches the app itself, so both app and notebooks are available offline.
- Each file's Drive `md5Checksum` and size are stored; re-syncing only downloads
  files that actually changed.
- Nothing is ever uploaded or written back to Google Drive — the app is read-only.

## Reader controls

- Tap a notebook to open it. Use the arrow buttons or swipe/scroll through pages.
- **`2 pages`** toggles a side-by-side book spread.
- Zoom with `+` / `−` and `Fit`.
- `Sign out` revokes the token; already-cached notebooks stay readable.

## What is bundled

- `js/noteful.js` — strict parser of the `.noteful` binary container, ported
  from the desktop reader. Verified to produce identical titles, page counts,
  stroke counts and object counts to the Python implementation on real files.
- `js/render.js` — SVG compositor for PDF backgrounds, handwriting, shapes,
  images and text.
- `js/pdf.js` + `js/pdf.worker.js` — PDF.js 3.11 (bundled locally; no CDN).
- `manifest.webmanifest`, `sw.js`, icons — installable/offline support.

## Limitations

- Read-only: no editing, no writing back to Drive.
- Google sign-in uses an OAuth client ID you must configure yourself.
- Very large notebooks use device memory for the decoded page and rasterized
  PDF cache; the cache is cleared when you reopen a notebook.
