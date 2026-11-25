importScripts('shared.js');

/* ---------- state (kept in chrome.storage.session: SW can be killed any time) ---------- */
let queue = Promise.resolve();
const lock = fn => (queue = queue.then(fn, fn));
const get = async (k, d) => (await chrome.storage.session.get(k))[k] ?? d;
const set = (k, v) => chrome.storage.session.set({ [k]: v });
const settings = async () => ({ ...DEFAULT_SETTINGS, ...((await chrome.storage.sync.get('settings')).settings || {}) });

/* ---------- scoring ----------
 ext in URL path        +50      specific model MIME   +60      magic bytes match +55
 octet-stream/binary    +10      URL keyword (each)    +8 (max 24)
 size >= 50 KB          +5       size >= 1 MB          +5 more
 text/html, image/*, js, css, fonts, json-api => rejected (-100)   confidence: >=80 high, >=55 medium, else low */
const KEYWORDS = /(\/|[-_.])(models?|meshes|mesh|assets?|3d|glb|gltf|usdz|scene|objects?|downloads?)(\/|[-_.]|$)/gi;
const REJECT_MIME = /^(text\/(html|css|javascript|plain)|image\/|font\/|video\/|audio\/|application\/(javascript|x-javascript|wasm|font)|application\/json$)/i;

function extOf(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    const m = p.match(/\.([a-z0-9]{2,5})$/);
    return m && FORMATS[m[1]] ? m[1] : null;
  } catch { return null; }
}
const hdr = (h, n) => (h || []).find(x => x.name.toLowerCase() === n)?.value || '';

function filenameFrom(url, headers, format) {
  const cd = hdr(headers, 'content-disposition');
  let name = '';
  let m = cd.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  if (m) { try { name = decodeURIComponent(m[1].trim()); } catch { name = m[1]; } }
  else if ((m = cd.match(/filename\s*=\s*"?([^";]+)"?/i))) name = m[1].trim();
  if (!name) {
    try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch {}
  }
  name = (name || 'model').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  if (format && !/\.[a-z0-9]{2,5}$/i.test(name)) name += '.' + (Object.keys(FORMATS).find(k => FORMATS[k] === format) || 'bin');
  return name;
}

function sniff(bytes, total) {
  const s = (a, b) => String.fromCharCode(...bytes.slice(a, b));
  const head = s(0, Math.min(bytes.length, 512));
  if (s(0, 4) === 'glTF') return 'GLB';
  if (head.startsWith('Kaydara FBX Binary')) return 'FBX';
  if (head.startsWith('ply')) return 'PLY';
  if (head.startsWith('PXR-USDC')) return 'USD';
  if (head.startsWith('BLENDER')) return 'Blend';
  if (head.includes('<COLLADA')) return 'DAE';
  if (head.startsWith('solid') && /facet|endsolid/.test(head)) return 'STL';
  if (head.startsWith('{') && /"asset"\s*:\s*\{\s*"(generator|version)"/.test(head)) return 'glTF';
  if (bytes.length >= 84 && total) {            // binary STL: size == 84 + 50 * triangles
    const n = new DataView(new Uint8Array(bytes).buffer).getUint32(80, true);
    if (n > 0 && 84 + 50 * n === total) return 'STL';
  }
  if (head.startsWith('PK\x03\x04') && /\.usd[a-z]?|\.3dmodel/i.test(head)) return head.includes('3dmodel') ? '3MF' : 'USDZ';
  return null;
}

async function sniffUrl(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-511' }, cache: 'force-cache' });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (REJECT_MIME.test(ct) && !MIME_FORMATS[ct]) { r.body?.cancel(); return null; }
    const total = +(r.headers.get('content-range') || '').split('/')[1] || +r.headers.get('content-length') || 0;
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    while (got < 512) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; }
    reader.cancel().catch(() => {});
    const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
    const format = sniff(buf.slice(0, 512), total);
    return format ? { format, total, ct } : null;
  } catch { return null; }
}

async function evaluate(d) {
  const ct = hdr(d.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
  const ext = extOf(d.url);
  const reasons = [];
  let score = 0, format = null;
  if (REJECT_MIME.test(ct) && !MIME_FORMATS[ct]) return null;
  if (MIME_FORMATS[ct]) { score += 60; format = MIME_FORMATS[ct]; reasons.push('MIME ' + ct); }
  if (ext) { score += 50; format = format || FORMATS[ext]; reasons.push('extension .' + ext); }
  if (/octet-stream|binary/.test(ct)) { score += 10; reasons.push('binary content-type'); }
  const kw = (new URL(d.url).pathname.match(KEYWORDS) || []).length;
  if (kw) { score += Math.min(24, kw * 8); reasons.push('URL keywords'); }
  const size = +hdr(d.responseHeaders, 'content-length') || +(hdr(d.responseHeaders, 'content-range').split('/')[1]) || 0;
  if (size >= 50e3) score += 5;
  if (size >= 1e6) score += 5;

  const cfg = await settings();
  if (cfg.sniffMagic && score >= 10 && score < 90 && !/^(model|application\/sla)/.test(ct) ) {
    const magic = await sniffUrl(d.url);
    if (magic) { score += 55; format = magic.format; reasons.push('magic bytes → ' + magic.format); }
  }
  if (!format || score < cfg.minScore) return null;
  if (cfg.disabledFormats.includes(format)) return null;
  return { score, format, reasons, size, mime: ct };
}

/* ---------- storage helpers ---------- */
const key = t => 'tab' + t;
async function addModel(tabId, m) {
  return lock(async () => {
    const list = await get(key(tabId), []);
    const id = m.url.split('#')[0];
    const i = list.findIndex(x => x.id === id);
    if (i >= 0) { if (m.score > list[i].score) list[i] = { ...list[i], ...m, id }; else return; }
    else list.push({ ...m, id, time: Date.now() });
    await set(key(tabId), list);
    refreshBadge(tabId, list.length);
    chrome.tabs.sendMessage(tabId, { type: 'modelsChanged' }).catch(() => {});
  });
}
function refreshBadge(tabId, n) {
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#6d5efc' });
}
const STATIC = /\.(js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|map|html?)(\?|#|$)/i;
async function probe(tabId, items) {
  const cfg = await settings();
  const known = new Set((await get(key(tabId), [])).map(m => m.id));
  const todo = items.filter(i => i.url.startsWith('http') && !STATIC.test(i.url) && !known.has(i.url.split('#')[0])).slice(0, 60);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  for (let i = 0; i < todo.length; i += 6) {            // 6 at a time
    await Promise.all(todo.slice(i, i + 6).map(async it => {
      const r = await sniffUrl(it.url);
      if (!r || cfg.disabledFormats.includes(r.format)) return;
      await addModel(tabId, { url: it.url, filename: filenameFrom(it.url, [], r.format), format: r.format, size: r.total || it.size || 0,
        mime: r.ct, score: 75, confidence: 'medium', reasons: ['rescan: magic bytes → ' + r.format], source: 'rescan', page: tab?.url || '' });
    }));
  }
}
const confidence = s => (s >= 80 ? 'high' : s >= 55 ? 'medium' : 'low');

/* ---------- network monitoring ---------- */
chrome.webRequest.onBeforeRequest.addListener(d => {
  if (d.tabId < 0) return;
  lock(async () => { await set(key(d.tabId), []); await set('recent' + d.tabId, []); refreshBadge(d.tabId, 0); });
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.webRequest.onHeadersReceived.addListener(async d => {
  if (d.tabId < 0 || d.type === 'main_frame' && !extOf(d.url)) return;   // tabId -1 = our own sniff fetches
  if (d.statusCode < 200 || d.statusCode >= 300) return;
  if (!['xmlhttprequest', 'other', 'media', 'object', 'sub_frame', 'main_frame', 'script'].includes(d.type) && !extOf(d.url)) return;

  // Network inspector buffer (non-static requests only)
  const ct = hdr(d.responseHeaders, 'content-type').split(';')[0].toLowerCase();
  if (!REJECT_MIME.test(ct) || /json/.test(ct) === false && !/^(text|image|font)/.test(ct)) {
    lock(async () => {
      const r = await get('recent' + d.tabId, []);
      if (!r.some(x => x.url === d.url)) r.unshift({ url: d.url, mime: ct, size: +hdr(d.responseHeaders, 'content-length') || 0, type: d.type });
      await set('recent' + d.tabId, r.slice(0, 80));
    });
  }
  const res = await evaluate(d);
  if (!res) return;
  const tab = await chrome.tabs.get(d.tabId).catch(() => null);
  addModel(d.tabId, {
    url: d.url, filename: filenameFrom(d.url, d.responseHeaders, res.format),
    format: res.format, size: res.size, mime: res.mime, score: res.score,
    confidence: confidence(res.score), reasons: res.reasons, source: 'network', page: tab?.url || d.initiator || ''
  });
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

chrome.tabs.onRemoved.addListener(t => lock(async () => chrome.storage.session.remove([key(t), 'recent' + t])));

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const tabId = msg.tabId ?? sender.tab?.id;
    switch (msg.type) {
      case 'getModels': return reply({ models: await get(key(tabId), []) });
      case 'getRecent': return reply({ recent: await get('recent' + tabId, []) });
      case 'dom': {          // links found by the content script
        const cfg = await settings();
        for (const u of msg.urls) {
          const ext = extOf(u);
          if (!ext) continue;
          const format = FORMATS[ext];
          if (cfg.disabledFormats.includes(format)) continue;
          await addModel(tabId, { url: u, filename: filenameFrom(u, [], format), format, size: 0, mime: '',
            score: 55, confidence: 'medium', reasons: ['link in page (.' + ext + ')'], source: 'dom', page: sender.tab?.url || '' });
        }
        return reply({ ok: true });
      }
      case 'flag': {         // manual flag from inspector
        const r = msg.item;
        const format = msg.format || MIME_FORMATS[r.mime] || FORMATS[extOf(r.url)] || 'Unknown';
        await addModel(tabId, { url: r.url, filename: filenameFrom(r.url, [], format), format, size: r.size || 0,
          mime: r.mime, score: 100, confidence: 'high', reasons: ['flagged manually'], source: 'manual', page: '' });
        return reply({ ok: true });
      }
      case 'download': {
        const m = msg.model;
        const id = await chrome.downloads.download({ url: m.url, filename: m.filename, saveAs: !!msg.saveAs });
        const cfg = await settings();
        if (cfg.keepHistory) {
          const h = (await chrome.storage.local.get('history')).history || [];
          h.unshift({ url: m.url, filename: m.filename, format: m.format, time: Date.now() });
          await chrome.storage.local.set({ history: h.slice(0, 200) });
        }
        return reply({ id });
      }
      case 'probe': { await probe(tabId, msg.urls.map(url => ({ url }))); return reply({ ok: true }); }
      case 'rescan': {       // re-check everything seen on this tab by signature, ignoring thresholds
        const before = (await get(key(tabId), [])).length;
        await probe(tabId, await get('recent' + tabId, []));
        await new Promise(r => setTimeout(r, 400));
        return reply({ added: (await get(key(tabId), [])).length - before });
      }
      case 'clearRecent': {
        await lock(async () => {
          await set('recent' + tabId, []);
          if (msg.models) { await set(key(tabId), []); refreshBadge(tabId, 0); }
        });
        if (msg.models) chrome.tabs.sendMessage(tabId, { type: 'modelsChanged' }).catch(() => {});
        return reply({ ok: true });
      }
      case 'settings': return reply(await settings());
    }
  })().catch(e => reply({ error: String(e) }));
  return true;
});

// MeshKit donor extension: platform integrations, conversion, and texture upscaling.
importScripts('static/background/index.js');
