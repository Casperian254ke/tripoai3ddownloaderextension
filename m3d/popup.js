const $ = s => document.querySelector(s);
let tabId, cfg;
const toast = t => { const e = $('#toast'); e.textContent = t; e.classList.add('show'); setTimeout(() => e.classList.remove('show'), 2200); };
const fmtSize = n => !n ? 'size unknown' : n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1e3) + ' KB';
const send = m => chrome.runtime.sendMessage({ ...m, tabId });
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const btn = (txt, fn, p) => { const b = el('button', 'b' + (p ? ' p' : ''), txt); b.onclick = fn; return b; };
const copy = async t => { await navigator.clipboard.writeText(t); toast('Copied'); };

function sendToManager(m) {
  if (cfg.managerTemplate) chrome.tabs.create({ url: cfg.managerTemplate.replace('{url}', encodeURIComponent(m.url)).replace('{rawurl}', m.url) });
  copy(m.url).then(() => toast('URL copied â€“ paste/auto-capture in IDM, FDM, JDownloaderâ€¦'));
}
const cmd = m => `aria2c -x16 -s16 --referer="${m.page || m.url}" -o "${m.filename}" "${m.url}"`;

/* ---------- previews: page image -> page screenshot crop -> live 3D render -> unavailable ---------- */
let shotP = null;
const screenshot = () => shotP ||= chrome.tabs.captureVisibleTab(undefined, { format: 'jpeg', quality: 75 }).catch(() => null);
function loadImg(src) { return new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; }); }
async function cropShot(rect, vw) {
  const data = await screenshot(); if (!data) return null;
  const img = await loadImg(data); if (!img) return null;
  const k = img.width / vw, c = document.createElement('canvas');
  const S = 240, sc = Math.min(S / (rect.w * k), S / (rect.h * k));
  c.width = Math.round(rect.w * k * sc); c.height = Math.round(rect.h * k * sc);
  c.getContext('2d').drawImage(img, rect.x * k, rect.y * k, rect.w * k, rect.h * k, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}
let chain3d = Promise.resolve();
function render3D(m, box) {
  chain3d = chain3d.then(() => new Promise(done => {
    if (!customElements.get('model-viewer')) { unavailable(box); return done(); }
    const mv = document.createElement('model-viewer');
    mv.setAttribute('src', m.url); mv.setAttribute('camera-controls', ''); mv.setAttribute('auto-rotate', '');
    mv.setAttribute('interaction-prompt', 'none'); mv.setAttribute('shadow-intensity', '0'); mv.setAttribute('loading', 'eager');
    box.replaceChildren(el('span', null, 'Loading 3Dâ€¦'), mv); mv.style.visibility = 'hidden';
    const fin = ok => { clearTimeout(t); if (ok) { box.firstChild.remove(); mv.style.visibility = ''; box.append(el('span', 'lbl', '3D')); } else unavailable(box); done(); };
    const t = setTimeout(() => fin(false), 30000);
    mv.addEventListener('load', () => fin(true)); mv.addEventListener('error', () => fin(false));
  }));
}
const unavailable = box => box.replaceChildren(el('span', null, '[preview unavailable]'));
async function showImg(box, src, label) {
  const i = await loadImg(src); if (!i) return false;
  box.replaceChildren(i); if (label) box.append(el('span', 'lbl', label)); return true;
}
async function loadPreview(m, box) {
  let info = null;
  try { info = await chrome.tabs.sendMessage(tabId, { type: 'getPreview', url: m.url }); } catch {}
  if (info?.img && await showImg(box, info.img)) return;
  if (info?.rect) { const d = await cropShot(info.rect, info.vw); if (d && await showImg(box, d, 'page')) return; }
  if (/^(GLB|glTF)$/.test(m.format) && (!m.size || m.size <= 60e6)) return render3D(m, box);
  unavailable(box);
}

const cards = new Map();
async function renderModels() {
  const { models = [] } = await send({ type: 'getModels' });
  $('#count').textContent = models.length;
  const box = $('#models');
  if (!models.length && !cards.size) { box.replaceChildren(el('div', 'empty', 'No 3D models detected on this page yet.\nTry interacting with the viewer.')); return; }
  if (models.length && !cards.size) box.replaceChildren();
  models.sort((a, b) => b.score - a.score).forEach(m => {
    if (cards.has(m.id)) return;
    const c = el('div', 'card m'), pv = el('div', 'pv', 'Loading previewâ€¦'), info = el('div', 'info'), top = el('div', 'top');
    top.append(el('span', 'fmt', m.format), el('span', 'name', m.filename));
    info.append(top, el('div', 'meta', `${fmtSize(m.size)} Â· ${m.confidence} (${m.score})`), el('div', 'meta url', m.url));
    const b = el('div', 'btns');
    b.append(btn('Download', () => send({ type: 'download', model: m }).then(() => toast('Downloading ' + m.filename)), true),
      btn('Save asâ€¦', () => send({ type: 'download', model: m, saveAs: true })),
      btn('Blender / Convert', () => chrome.tabs.create({ url: chrome.runtime.getURL('blender.html') + '?url=' + encodeURIComponent(m.url) + '&name=' + encodeURIComponent(m.filename) + '&format=' + encodeURIComponent(m.format) })),
      btn('Copy URL', () => copy(m.url)),
      btn('Manager', () => sendToManager(m)),
      btn('aria2c', () => copy(cmd(m))));
    info.append(b); c.append(pv, info); box.append(c); cards.set(m.id, c);
    loadPreview(m, pv);
  });
}

async function renderInspector() {
  const { recent = [] } = await send({ type: 'getRecent' });
  const box = $('#inspector'); box.replaceChildren();
  const resetModels = () => { cards.clear(); $('#models').replaceChildren(); $('#count').textContent = 0; };
  const bar = el('div', 'btns');
  bar.append(
    btn('Clear log', async () => { await send({ type: 'clearRecent' }); renderInspector(); toast('Log cleared'); }),
    btn('Clear log + detected', async () => { await send({ type: 'clearRecent', models: true }); resetModels(); renderInspector(); toast('Cleared'); }),
    btn('Clear & reload page', async () => { await send({ type: 'clearRecent', models: true }); resetModels(); await chrome.tabs.reload(tabId); toast('Reloading â€“ recapturingâ€¦'); }, true));
  bar.style.marginBottom = '10px';
  box.append(bar, el('div', 'meta', recent.length + ' request(s) logged'));
  if (!recent.length) return box.append(el('div', 'empty', 'No XHR/fetch/other requests recorded.'));
  recent.forEach(r => {
    const c = el('div', 'card');
    c.append(el('div', 'meta', `${r.type} Â· ${r.mime || '?'} Â· ${fmtSize(r.size)}`), el('div', 'meta', r.url));
    const b = el('div', 'btns');
    const sel = el('select'); sel.append(...FORMAT_LIST.map(f => new Option(f, f)));
    b.append(sel, btn('Flag as 3D model', async () => { await send({ type: 'flag', item: r, format: sel.value }); toast('Flagged'); renderModels(); }));
    c.append(b); box.append(c);
  });
}

async function renderHistory() {
  const h = (await chrome.storage.local.get('history')).history || [];
  const box = $('#history'); box.replaceChildren();
  if (!h.length) return box.append(el('div', 'empty', 'No downloads yet.'));
  box.append(btn('Clear history', async () => { await chrome.storage.local.remove('history'); renderHistory(); }));
  h.slice(0, 50).forEach(x => { const c = el('div', 'card'); c.append(el('div', 'name', x.filename), el('div', 'meta', new Date(x.time).toLocaleString() + ' Â· ' + x.url)); box.append(c); });
}

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  ['models', 'inspector', 'history'].forEach(id => $('#' + id).hidden = id !== t.dataset.t);
  ({ models: renderModels, inspector: renderInspector, history: renderHistory })[t.dataset.t]();
});
$('#rescan').onclick = async () => {
  const b = $('#rescan'); b.disabled = true; b.textContent = 'âŸ³ Scanningâ€¦';
  chrome.tabs.sendMessage(tabId, { type: 'rescan' }).catch(() => {});      // content scripts in all frames
  await new Promise(r => setTimeout(r, 900));
  const r = await send({ type: 'rescan' });                                 // probe everything already logged
  await renderModels();
  b.disabled = false; b.textContent = 'âŸ³ Rescan';
  toast(r?.added > 0 ? `Found ${r.added} new model(s)` : 'Rescan done â€“ nothing new');
};
$('#settings').onclick = () => chrome.runtime.openOptionsPage();

(async () => {
  [{ id: tabId }] = await chrome.tabs.query({ active: true, currentWindow: true });
  cfg = await send({ type: 'settings' });
  renderModels();
  setInterval(() => { if (!$('#models').hidden) renderModels(); }, 2000);
  setInterval(() => { if (!$('#inspector').hidden && !document.querySelector('#inspector select:focus')) renderInspector(); }, 3000);
})();

document.querySelector('#meshkit').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('meshkit.html') });

