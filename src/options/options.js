/** Options page: a thin view over chrome.storage + the optional host permission. */
(function () {
  'use strict';
  const S = window.IMGDL.settings;

  const FIELDS = {
    minWidth: 'number',
    minHeight: 'number',
    hideTiny: 'boolean',
    groupDuplicates: 'boolean',
    preferHighestQuality: 'boolean',
    measureUnknown: 'boolean',
    format: 'string',
    jpgQuality: 'number',
    naming: 'string',
    downloadFolder: 'string',
    folderPerPage: 'boolean',
    zip: 'boolean'
  };

  const $ = (id) => document.getElementById(id);
  let savedTimer = 0;

  init();

  async function init() {
    const settings = await S.get();
    for (const [key, type] of Object.entries(FIELDS)) {
      const input = $(key);
      if (!input) continue;
      if (type === 'boolean') input.checked = Boolean(settings[key]);
      else input.value = settings[key];
      input.addEventListener('change', () => persist(key, type));
      if (input.type === 'range') input.addEventListener('input', syncQuality);
    }
    syncQuality();

    $('reset').addEventListener('click', async () => {
      const defaults = await S.reset();
      for (const [key, type] of Object.entries(FIELDS)) {
        const input = $(key);
        if (!input) continue;
        if (type === 'boolean') input.checked = Boolean(defaults[key]);
        else input.value = defaults[key];
      }
      syncQuality();
      flashSaved('Reset');
    });
  }

  async function persist(key, type) {
    const input = $(key);
    let value;
    if (type === 'boolean') value = input.checked;
    else if (type === 'number') value = Number(input.value);
    else value = input.value;

    if (type === 'number' && !Number.isFinite(value)) return;
    const next = await S.set({ [key]: value });
    if (type === 'number') input.value = next[key];
    if (type === 'string') input.value = next[key];
    syncQuality();
    flashSaved('Saved');
  }

  function syncQuality() {
    const out = $('jpgQualityOut');
    if (out) out.textContent = $('jpgQuality').value;
    const disabled = $('format').value === 'original' || $('format').value === 'png';
    $('jpgQuality').disabled = disabled;
    $('jpgQuality').closest('.row').style.opacity = disabled ? '.5' : '1';
  }

  function flashSaved(label) {
    const node = $('saved');
    node.textContent = label;
    node.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { node.hidden = true; }, 1400);
  }
})();
