/* Noteful Reader for Android (installable PWA).
 * - Google Drive sync with OAuth (drive.readonly)
 * - Offline cache in IndexedDB
 * - Local .noteful parsing and rendering (no server required)
 */
(function () {
  'use strict';
  const NF = window.Noteful;
  const NR = window.NotefulRender;
  const CFG = window.NOTEFUL_CONFIG || {};
  const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

  const $ = id => document.getElementById(id);
  const statusEl = $('status'), readerStatus = $('readerStatus');
  let db = null, accessToken = null, tokenClient = null;
  let notebooks = [], current = null;
  let page = 0, spread = false, scale = null;

  function setStatus(msg) { statusEl.textContent = msg || ''; }
  function setReaderStatus(msg) { readerStatus.textContent = msg || ''; }

  /* ---------- IndexedDB ---------- */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('noteful-reader', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function dbPut(rec) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(rec);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }
  function dbGet(id) {
    return new Promise((resolve, reject) => {
      const req = db.transaction('files').objectStore('files').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  function dbAll() {
    return new Promise((resolve, reject) => {
      const req = db.transaction('files').objectStore('files').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /* ---------- Google Drive ---------- */
  function initGoogle() {
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
      setStatus('Google sign-in is offline; showing locally cached notebooks.');
      return;
    }
    if (!CFG.GOOGLE_CLIENT_ID || CFG.GOOGLE_CLIENT_ID.indexOf('YOUR_') === 0) {
      setStatus('Add your Google OAuth client ID in js/config.js to enable Drive sync.');
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: resp => {
        if (resp && resp.error) { setStatus('Google sign-in failed: ' + resp.error); return; }
        accessToken = resp.access_token;
        syncDrive();
      }
    });
    setStatus('Notebooks cached on this device: ' + notebooks.length + '. Tap Sync Drive to update.');
  }
  function requestToken() {
    if (!tokenClient) { setStatus('Google sign-in is not configured yet.'); return; }
    setStatus('Opening Google sign-in…');
    tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  }
  async function api(url, options) {
    const opts = Object.assign({}, options, {
      headers: Object.assign({ Authorization: 'Bearer ' + accessToken }, (options && options.headers) || {})
    });
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error('Drive request failed: HTTP ' + res.status);
    return res;
  }
  async function driveList() {
    const files = [];
    let token = '';
    do {
      const q = ["trashed = false", "name contains '.noteful'"];
      if (CFG.DRIVE_FOLDER_ID) q.push("'" + CFG.DRIVE_FOLDER_ID + "' in parents");
      const url = 'https://www.googleapis.com/drive/v3/files?pageSize=1000' +
        '&fields=' + encodeURIComponent('nextPageToken,files(id,name,size,md5Checksum,modifiedTime)') +
        '&q=' + encodeURIComponent(q.join(' and ')) +
        (token ? '&pageToken=' + encodeURIComponent(token) : '');
      const json = await (await api(url)).json();
      files.push.apply(files, json.files || []);
      token = json.nextPageToken || '';
    } while (token);
    return files;
  }
  async function driveDownload(id) {
    const res = await api('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media');
    return res.arrayBuffer();
  }
  async function syncDrive() {
    if (!accessToken) { requestToken(); return; }
    try {
      setStatus('Listing notebooks in Google Drive…');
      const files = await driveList();
      let updated = 0, kept = 0;
      for (const f of files) {
        const cached = await dbGet(f.id);
        if (cached && cached.md5 && cached.md5 === f.md5Checksum &&
            cached.size === Number(f.size || cached.size)) { kept++; continue; }
        setStatus('Downloading ' + f.name + '…');
        const buf = await driveDownload(f.id);
        await dbPut({
          id: f.id, name: f.name, size: buf.byteLength,
          md5: f.md5Checksum || '', modifiedTime: f.modifiedTime || '', data: buf
        });
        updated++;
      }
      await renderLibrary();
      setStatus('Drive synced: ' + updated + ' updated, ' + kept + ' unchanged (' + files.length + ' total).');
    } catch (e) {
      setStatus('Sync failed: ' + (e.message || e));
    }
  }

  /* ---------- Library ---------- */
  async function renderLibrary() {
    notebooks = await dbAll();
    notebooks.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    renderCards();
  }
  function renderCards() {
    const q = ($('search').value || '').toLowerCase().trim();
    const list = notebooks.filter(n => !q || n.name.toLowerCase().indexOf(q) >= 0);
    const host = $('cards');
    host.innerHTML = '';
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'status';
      d.textContent = notebooks.length ? 'No notebooks match that filter.' : 'No notebooks yet — tap Sync Drive to download your Noteful files.';
      host.appendChild(d);
      return;
    }
    for (const n of list) {
      const card = document.createElement('div');
      card.className = 'card';
      const name = document.createElement('div');
      name.className = 'name'; name.textContent = n.name.replace(/\.noteful$/i, '');
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<span>' + (n.size / 1048576).toFixed(1) + ' MB</span><span class="dot">● cached</span>';
      card.appendChild(name); card.appendChild(meta);
      card.onclick = () => openNotebook(n.id);
      host.appendChild(card);
    }
  }

  /* ---------- Reader ---------- */
  const pdfCache = new Map();
  const docCache = new Map();
  async function pdfImage(block, pageIndex) {
    const key = block.offset + '|' + pageIndex;
    if (pdfCache.has(key)) return pdfCache.get(key);
    if (pdfCache.size > 60) pdfCache.clear();
    const bytes = current.data.slice(block.offset, block.offset + block.size);
    let doc = docCache.get(block.offset);
    if (!doc) {
      doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      docCache.set(block.offset, doc);
    }
    const n = Math.max(0, Math.min(doc.numPages - 1, Number(pageIndex) || 0));
    const pdfPage = await doc.getPage(n + 1);
    const viewport = pdfPage.getViewport({ scale: 11 / 6 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    await pdfPage.render({ canvasContext: ctx, viewport: viewport }).promise;
    const url = canvas.toDataURL('image/png');
    pdfCache.set(key, url);
    return url;
  }

  async function openNotebook(id) {
    setStatus('Opening notebook…');
    try {
      const rec = await dbGet(id);
      if (!rec) throw new Error('Notebook not found in local cache');
      const data = new Uint8Array(rec.data);
      const report = NF.parse(data);
      const summary = NF.semanticSummary(report);
      current = { rec: rec, data: data, report: report, summary: summary };
      pdfCache.clear(); docCache.clear();
      $('docTitle').textContent = summary.title || rec.name.replace(/\.noteful$/i, '');
      $('pageTotal').textContent = ' / ' + summary.pages.length.toLocaleString();
      $('library').classList.add('hidden');
      $('reader').classList.remove('hidden');
      showPage(0, true);
    } catch (e) {
      setStatus('Could not open notebook: ' + (e.message || e));
    }
  }

  function align(p) { return spread ? p - (p % 2) : p; }
  function step() { return spread ? 2 : 1; }
  function applyScale() {
    if (!scale) return;
    const svgs = $('pageWrap').querySelectorAll('svg');
    svgs.forEach(svg => {
      const vb = svg.getAttribute('viewBox').split(' ').map(Number);
      svg.style.width = (vb[2] * scale) + 'px';
      svg.style.height = 'auto';
    });
  }
  function fit() {
    const svgs = $('pageWrap').querySelectorAll('svg');
    if (!svgs.length) return;
    const stage = $('stage');
    const pad = 24, gap = 12;
    const availW = stage.clientWidth - pad - (svgs.length > 1 ? gap : 0);
    let natW = 0, natH = 0;
    svgs.forEach(svg => {
      const vb = svg.getAttribute('viewBox').split(' ').map(Number);
      natW += vb[2]; natH = Math.max(natH, vb[3]);
    });
    scale = Math.min(availW / natW, (stage.clientHeight - pad) / natH, 2);
    applyScale();
  }
  function zoom(mult) {
    if (!scale) fit();
    scale = Math.max(.15, Math.min(6, scale * mult));
    applyScale();
  }
  function updateCounter() {
    $('pageNo').value = page + 1;
    $('pageRange').textContent = (spread && page + 1 < current.summary.pages.length) ? '–' + (page + 2) : '';
    $('spreadBtn').textContent = spread ? '2 pages' : '1 page';
    $('spreadBtn').classList.toggle('on', spread);
  }
  async function showPage(p, force) {
    if (!current) return;
    const total = current.summary.pages.length;
    const target = Math.max(0, Math.min(total - 1, align(p)));
    if (!force && target === page && $('pageWrap').children.length) return;
    page = target;
    setReaderStatus('Rendering page ' + (page + 1) + ' of ' + total + '…');
    try {
      const indices = [page];
      if (spread && page + 1 < total) indices.push(page + 1);
      const svgs = await Promise.all(indices.map(i => NR.renderPage(
        current.report, current.summary, current.data, i, pdfImage)));
      const wrap = $('pageWrap');
      wrap.innerHTML = svgs.map(s => s.svg).join('');
      updateCounter();
      if (scale) applyScale(); else fit();
      const warns = svgs.reduce((a, s) => a.concat(s.stats.warnings), []);
      setReaderStatus(warns.length ? warns.slice(0, 2).join(' | ') : '');
    } catch (e) {
      setReaderStatus('Could not render page: ' + (e.message || e));
    }
  }
  function toggleSpread() {
    spread = !spread;
    scale = null;
    showPage(page, true);
  }
  function goLibrary() {
    current = null;
    $('reader').classList.add('hidden');
    $('library').classList.remove('hidden');
    setStatus('Notebooks cached on this device: ' + notebooks.length + '.');
  }

  /* ---------- Events ---------- */
  $('syncBtn').onclick = syncDrive;
  $('signOutBtn').onclick = () => {
    if (accessToken && typeof google !== 'undefined' && google.accounts && google.accounts.oauth2)
      google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null;
    setStatus('Signed out. Locally cached notebooks remain readable.');
  };
  $('search').addEventListener('input', renderCards);
  $('backBtn').onclick = goLibrary;
  $('firstBtn').onclick = () => showPage(0);
  $('prevBtn').onclick = () => showPage(page - step());
  $('nextBtn').onclick = () => showPage(page + step());
  $('lastBtn').onclick = () => showPage(current ? current.summary.pages.length - 1 : 0);
  $('spreadBtn').onclick = toggleSpread;
  $('zoomIn').onclick = () => zoom(1.25);
  $('zoomOut').onclick = () => zoom(1 / 1.25);
  $('fitBtn').onclick = fit;
  $('pageNo').addEventListener('change', () => {
    const n = parseInt($('pageNo').value, 10);
    if (!isNaN(n)) showPage(n - 1); else updateCounter();
  });
  window.addEventListener('resize', fit);
  document.addEventListener('keydown', e => {
    if (current && !$('reader').classList.contains('hidden')) {
      if (document.activeElement === $('pageNo')) return;
      if (e.key === 'ArrowRight') { showPage(page + step()); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { showPage(page - step()); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') { zoom(1.25); e.preventDefault(); }
      else if (e.key === '-') { zoom(1 / 1.25); e.preventDefault(); }
      else if (e.key === '0') { fit(); e.preventDefault(); }
      else if (e.key === '2') { toggleSpread(); e.preventDefault(); }
    }
  });

  if (typeof pdfjsLib !== 'undefined') pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/pdf.worker.js';

  (async function init() {
    db = await openDB();
    await renderLibrary();
    initGoogle();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  })();
})();
