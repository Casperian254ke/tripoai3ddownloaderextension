(() => {
  const isTop = window.top === window;
  const send = m => chrome.runtime.sendMessage(m).catch(() => null);
  const EXT = /\.(glb|gltf|fbx|obj|stl|usdz|usd|usda|usdc|dae|3mf|ply|blend|3ds|x3d|wrl|vrm|step|stp|iges|igs|splat|spz)(?:$|[?#])/i;
  const ATTRS = ['src', 'href', 'data-src', 'data-model', 'data-url', 'data-glb', 'gltf-model', 'ios-src'];
  const norm = u => { try { const x = new URL(u, location.href); x.hash = ''; return x.href; } catch { return u; } };

  /* ---------- detection: links, viewer elements, already-loaded resources ---------- */
  const scan = () => {
    const urls = new Set();
    document.querySelectorAll(ATTRS.map(a => `[${a}]`).join(',')).forEach(e => ATTRS.forEach(a => {
      const v = e.getAttribute(a); if (v && EXT.test(v)) urls.add(norm(v));
    }));
    try { performance.getEntriesByType('resource').forEach(r => EXT.test(r.name) && urls.add(norm(r.name))); } catch {}
    if (urls.size) send({ type: 'dom', urls: [...urls] });
  };
  scan();
  new MutationObserver(() => { clearTimeout(scan.t); scan.t = setTimeout(scan, 1200); })
    .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ATTRS });
  setInterval(scan, 5000);

  // Rescan on demand (all frames): re-scan DOM + report XHR/fetch/other resources for signature probing
  chrome.runtime.onMessage.addListener(m => {
    if (m.type !== 'rescan') return;
    scan();
    try {
      const urls = performance.getEntriesByType('resource')
        .filter(r => /^(fetch|xmlhttprequest|other)$/.test(r.initiatorType)).map(r => norm(r.name));
      if (urls.length) send({ type: 'probe', urls: [...new Set(urls)].slice(-80) });
    } catch {}
  });

  if (!isTop) return;

  /* ---------- preview lookup: find the element that uses a model URL ---------- */
  function findEl(url) {
    const t = norm(url);
    for (const e of document.querySelectorAll(ATTRS.map(a => `[${a}]`).join(','))) {
      for (const a of ATTRS) { const v = e.getAttribute(a); if (v && norm(v) === t) return e; }
    }
    let tail = ''; try { tail = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch {}
    if (tail.length >= 6) {                       // loose match: filename appears in any attribute
      let n = 0;
      for (const e of document.querySelectorAll('*')) {
        if (++n > 6000) break;
        for (const at of e.attributes) if (at.value.length < 2000 && at.value.includes(tail)) return e;
      }
    }
    return null;
  }
  const big = e => { const r = e.getBoundingClientRect(); return r.width >= 64 && r.height >= 64; };
  function previewOf(node) {
    if (node.tagName === 'MODEL-VIEWER' && node.getAttribute('poster')) return { img: norm(node.getAttribute('poster')) };
    if (node.tagName === 'IMG' && node.currentSrc && big(node)) return { img: node.currentSrc };
    if (node.tagName === 'VIDEO' && node.poster) return { img: node.poster };
    if (/^(MODEL-VIEWER|CANVAS)$/.test(node.tagName) && big(node)) {
      const r = node.getBoundingClientRect();
      const x = Math.max(0, r.left), y = Math.max(0, r.top);
      const w = Math.min(innerWidth, r.right) - x, h = Math.min(innerHeight, r.bottom) - y;
      if (w >= 48 && h >= 48) return { rect: { x, y, w, h }, vw: innerWidth };
    }
    const bg = getComputedStyle(node).backgroundImage.match(/url\("?([^")]+)"?\)/);
    if (bg && big(node)) return { img: norm(bg[1]) };
    return null;
  }
  function getPreview(url) {
    let el = findEl(url);
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      const self = previewOf(el); if (self) return self;
      const kids = [...el.querySelectorAll('model-viewer,canvas,img,video')].filter(big);
      kids.sort((a, b) => (b.tagName === 'IMG') - (a.tagName === 'IMG'));     // prefer plain images
      for (const k of kids) { const p = previewOf(k); if (p) return p; }
    }
    return null;
  }
  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (m.type === 'getPreview') { reply(getPreview(m.url) || {}); }
  });

  /* ---------- floating panel ---------- */
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host{font:13px system-ui,sans-serif}button{font:inherit;cursor:pointer}
    .fab{background:#6d5efc;color:#fff;border:0;border-radius:24px;padding:10px 14px;box-shadow:0 4px 16px #0005}
    .panel{display:none;position:absolute;right:0;bottom:48px;width:320px;max-height:320px;overflow:auto;background:#1b1b24;color:#eee;border-radius:12px;padding:8px;box-shadow:0 8px 30px #0008}
    .panel.open{display:block}.row{display:flex;gap:8px;align-items:center;padding:6px;border-bottom:1px solid #333}
    .row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row b{background:#6d5efc;border-radius:4px;padding:1px 5px;font-size:11px}
    .row button{background:#2d2d3b;color:#fff;border:0;border-radius:6px;padding:4px 8px}</style><div class="panel"></div><button class="fab" hidden></button>`;
  const fab = root.querySelector('.fab'), panel = root.querySelector('.panel');
  fab.onclick = () => panel.classList.toggle('open');
  document.documentElement.appendChild(host);
  async function refresh() {
    const cfg = await send({ type: 'settings' });
    const { models = [] } = (await send({ type: 'getModels' })) || {};
    fab.hidden = !(cfg?.floatingButton && models.length);
    fab.textContent = `⬇ ${models.length} 3D model${models.length === 1 ? '' : 's'}`;
    panel.replaceChildren();
    models.forEach(m => {
      const row = document.createElement('div'); row.className = 'row';
      const tag = document.createElement('b'); tag.textContent = m.format;
      const nm = document.createElement('span'); nm.textContent = m.filename; nm.title = m.url;
      const bt = document.createElement('button'); bt.textContent = 'Download';
      bt.onclick = () => send({ type: 'download', model: m });
      row.append(tag, nm, bt); panel.appendChild(row);
    });
  }
  chrome.runtime.onMessage.addListener(m => m.type === 'modelsChanged' && refresh());
  refresh();
})();
