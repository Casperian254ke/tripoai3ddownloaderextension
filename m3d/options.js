(async () => {
  const cfg = { ...DEFAULT_SETTINGS, ...((await chrome.storage.sync.get('settings')).settings || {}) };
  const box = document.getElementById('formats');
  FORMAT_LIST.forEach(f => {
    const l = document.createElement('label'); l.className = 'f'; l.style.display = 'inline-block';
    l.innerHTML = `<input type="checkbox" data-f="${f}"> ${f}`;
    l.firstChild.checked = !cfg.disabledFormats.includes(f); box.append(l);
  });
  ['floatingButton', 'sniffMagic', 'keepHistory'].forEach(k => document.getElementById(k).checked = cfg[k]);
  document.getElementById('minScore').value = cfg.minScore;
  document.getElementById('managerTemplate').value = cfg.managerTemplate;
  document.getElementById('save').onclick = async () => {
    const s = {
      disabledFormats: [...box.querySelectorAll('input')].filter(i => !i.checked).map(i => i.dataset.f),
      minScore: +document.getElementById('minScore').value || 40,
      managerTemplate: document.getElementById('managerTemplate').value.trim()
    };
    ['floatingButton', 'sniffMagic', 'keepHistory'].forEach(k => s[k] = document.getElementById(k).checked);
    await chrome.storage.sync.set({ settings: s });
    document.getElementById('ok').textContent = 'Saved ✓';
  };
})();
