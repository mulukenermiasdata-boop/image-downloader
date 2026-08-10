/**
 * Side panel application.
 *
 * Owns the view state: raw candidates in, grouped + filtered + sorted cards out.
 * All grouping/ranking logic lives in src/utils/duplicate-detector.js so the
 * panel, the service worker and the tests all agree on what "best" means.
 */
(function () {
  'use strict';
  const { C, normalizer: N, dedupe: D, filenames: F, downloader: DL, converter: CV, zip: ZIP, settings: S } = window.IMGDL;
  const MSG = C.MSG;

  const $ = (id) => document.getElementById(id);

  const el = {
    count: $('count'),
    search: $('search'),
    tabs: $('tabs'),
    sort: $('sort'),
    filters: $('filters'),
    filtersBtn: $('btn-filters'),
    filtersDot: $('filters-dot'),
    minWidth: $('min-width'),
    minHeight: $('min-height'),
    filterFormat: $('filter-format'),
    filterOrientation: $('filter-orientation'),
    optHideTiny: $('opt-hide-tiny'),
    optGroup: $('opt-group'),
    optPrefer: $('opt-prefer'),
    grid: $('grid'),
    body: $('body'),
    sentinel: $('sentinel'),
    state: $('state'),
    selCount: $('sel-count'),
    download: $('btn-download'),
    dlOptionsBtn: $('btn-dl-options'),
    dlOptions: $('dl-options'),
    dlFormat: $('dl-format'),
    dlNaming: $('dl-naming'),
    dlQuality: $('dl-quality'),
    dlQualityOut: $('dl-quality-out'),
    qualityGroup: $('quality-group'),
    dlFolder: $('dl-folder'),
    dlZip: $('dl-zip'),
    dlNote: $('dl-note'),
    versions: $('versions'),
    versionsList: $('versions-list'),
    versionsTitle: $('versions-title'),
    scrim: $('scrim'),
    toast: $('toast'),
    pick: $('btn-pick'),
    rescan: $('btn-rescan'),
    settings: $('btn-settings'),
    progress: $('progress'),
    progressFill: $('progress-fill'),
    progressText: $('progress-text')
  };

  const app = {
    tabId: null,
    pageUrl: '',
    pageTitle: '',
    candidates: new Map(),
    groups: [],
    filtered: [],
    selected: new Set(),
    settings: Object.assign({}, C.DEFAULT_SETTINGS),
    filters: { search: '', category: 'all', format: '', orientation: '' },
    rendered: 0,
    lastAnchor: -1,
    status: 'loading',
    statusDetail: '',
    truncated: false,
    pickMode: false,
    downloading: false,
    allSites: false
  };

  const cardPool = new Map();
  const measureRequested = new Set();
  const measureQueue = new Set();
  let measureTimer = 0;
  let refreshTimer = 0;
  let thumbFallbackTimer = 0;
  let ioReported = false;
  let pickPort = null;

  /* ================================================================== *
   * Boot
   * ================================================================== */

  init();

  async function init() {
    keepPortAlive();
    app.settings = await S.get();
    await refreshAllSitesState();
    applySettingsToUi();
    bindEvents();
    setStatus('loading');
    await loadTab();
  }

  /**
   * The service worker uses this port to know a panel is listening. It dies
   * whenever the worker is recycled, so reconnect instead of going silent.
   */
  function keepPortAlive() {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'imgdl-panel' });
    } catch (_) {
      setTimeout(keepPortAlive, 2000);
      return;
    }
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      setTimeout(keepPortAlive, 500);
    });
  }

  async function loadTab(tabId) {
    setBusy(true);
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: MSG.GET_TAB_STATE, tabId });
    } catch (error) {
      setBusy(false);
      setStatus('error', 'The extension could not reach the page.');
      return;
    }
    setBusy(false);
    if (!response) { setStatus('error', 'No response from the extension.'); return; }

    if (response.tabId != null && response.tabId !== app.tabId) {
      app.candidates.clear();
      app.selected.clear();
      cardPool.clear();
      measureRequested.clear();
    }
    app.tabId = response.tabId != null ? response.tabId : app.tabId;
    app.pageUrl = response.pageUrl || '';
    app.pageTitle = response.pageTitle || '';

    if (response.restricted) { setStatus('restricted'); refresh(); return; }
    if (response.snapshot) ingest(response.snapshot, true);
    // Only a panel with nothing to show should offer the "press the icon"
    // state; never trade a populated grid for it.
    if (!response.ok && response.needsInvoke && !app.candidates.size) {
      setStatus('needs-invoke');
    }
    refresh();
  }

  /* ================================================================== *
   * Data in
   * ================================================================== */

  function ingest(payload, replace) {
    if (!payload) return;
    if (replace && payload.full) app.candidates.clear();
    for (const candidate of payload.candidates || []) {
      const existing = app.candidates.get(candidate.url);
      if (!existing) { app.candidates.set(candidate.url, candidate); continue; }
      for (const key of Object.keys(candidate)) {
        const value = candidate[key];
        if (typeof value === 'number') {
          if (value > (existing[key] || 0)) existing[key] = value;
        } else if (value && !existing[key]) {
          existing[key] = value;
        }
      }
    }
    if (payload.truncated) app.truncated = true;
    if (payload.pageUrl) app.pageUrl = payload.pageUrl;
    if (payload.pageTitle) app.pageTitle = payload.pageTitle;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case MSG.CANDIDATES:
        if (message.tabId != null && message.tabId !== app.tabId) return;
        ingest(message.payload, false);
        scheduleRefresh();
        break;
      case MSG.TAB_CHANGED:
        if (message.reason === 'navigated' && message.tabId !== app.tabId) return;
        loadTab(message.reason === 'activated' ? message.tabId : undefined);
        break;
      case MSG.PICKED:
        if (message.tabId != null && message.tabId !== app.tabId) return;
        onPicked(message.payload);
        break;
      case MSG.PICK_ENDED:
        setPickMode(false, true);
        break;
      default:
        break;
    }
  });

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  }

  /* ================================================================== *
   * Grouping, filtering, sorting
   * ================================================================== */

  function refresh() {
    clearTimeout(refreshTimer);
    const raw = Array.from(app.candidates.values());
    app.groups = D.groupCandidates(raw, {
      group: app.settings.groupDuplicates,
      preferBest: app.settings.preferHighestQuality
    });
    for (const group of app.groups) group.stableId = stableId(group);
    app.filtered = sortGroups(app.groups.filter(matchesFilters));

    // Having images to show always wins. Without this, a transient failure to
    // re-inject would leave the panel stuck on an empty state while the header
    // and footer still counted the images it was refusing to draw.
    if (app.groups.length && app.status !== 'restricted') {
      setStatus('ready');
    } else if (app.status === 'loading' || app.status === 'ready' || app.status === 'empty' ||
      app.status === 'empty-filtered') {
      setStatus(app.candidates.size ? 'empty-filtered' : 'empty');
    }
    renderList();
    updateCounts();
  }

  function stableId(group) {
    let min = group.candidates[0].url;
    for (const candidate of group.candidates) if (candidate.url < min) min = candidate.url;
    return min;
  }

  function matchesFilters(group) {
    const s = app.settings;
    const f = app.filters;

    if (f.category !== 'all' && group.category !== f.category) return false;
    if (f.format && group.format !== f.format) return false;

    if (f.orientation && group.width && group.height) {
      const ratio = group.width / group.height;
      if (f.orientation === 'landscape' && ratio <= 1.05) return false;
      if (f.orientation === 'portrait' && ratio >= 0.95) return false;
      if (f.orientation === 'square' && (ratio < 0.95 || ratio > 1.05)) return false;
    }

    if (s.hideTiny) {
      if (N.isLikelyTracker(group.best)) return false;
      // Unknown sizes are kept: we do not hide what we cannot measure.
      if (group.width && group.width < s.minWidth) return false;
      if (group.height && group.height < s.minHeight) return false;
    }

    if (f.search) {
      const needle = f.search;
      const haystack = group.searchText || (group.searchText = buildSearchText(group));
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }

  function buildSearchText(group) {
    const parts = [group.alt, group.title, group.host];
    for (const candidate of group.candidates) {
      parts.push(candidate.url);
      parts.push(F.filenameFromUrl(candidate.url, candidate.format));
    }
    return parts.join(' ').toLowerCase();
  }

  function sortGroups(groups) {
    const mode = app.settings.sort;
    const list = groups.slice();
    list.sort((a, b) => {
      if (mode === 'page') return a.domOrder - b.domOrder || compareUrl(a, b);
      if (mode === 'filesize') return (b.bytes || 0) - (a.bytes || 0) || b.area - a.area || compareUrl(a, b);
      if (mode === 'smallest') {
        const aa = a.area || Infinity;
        const bb = b.area || Infinity;
        return aa - bb || compareUrl(a, b);
      }
      return b.area - a.area || compareUrl(a, b);
    });
    return list;
  }

  function compareUrl(a, b) {
    return a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0;
  }

  /* ================================================================== *
   * Rendering
   * ================================================================== */

  const io = new IntersectionObserver(onIntersect, { root: el.body, rootMargin: '300px 0px' });
  const sentinelIo = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) renderMore();
  }, { root: el.body, rootMargin: '400px 0px' });
  sentinelIo.observe(el.sentinel);

  function renderList() {
    app.rendered = Math.min(Math.max(app.rendered, C.LIMITS.RENDER_CHUNK), app.filtered.length);
    const fragment = document.createDocumentFragment();
    const seen = new Set();

    for (let i = 0; i < app.rendered; i++) {
      const group = app.filtered[i];
      seen.add(group.stableId);
      fragment.appendChild(updateCard(group, i));
    }

    // Drop cards that scrolled out of the data set entirely.
    for (const [key, node] of cardPool) {
      if (!seen.has(key)) {
        const img = node.querySelector('img');
        if (img) io.unobserve(img);
        cardPool.delete(key);
      }
    }

    el.grid.replaceChildren(fragment);
    el.grid.hidden = app.filtered.length === 0;
    scheduleThumbFallback();
  }

  /**
   * IntersectionObserver only reports while the panel is compositing frames.
   * If it stays silent, load the first screenful directly rather than leaving
   * the user staring at an empty grid.
   */
  function scheduleThumbFallback() {
    clearTimeout(thumbFallbackTimer);
    thumbFallbackTimer = setTimeout(() => {
      if (ioReported) return;
      for (const card of Array.from(el.grid.children).slice(0, C.LIMITS.RENDER_CHUNK)) {
        const img = card._img;
        if (img && !img.getAttribute('src') && img.dataset.src) {
          io.unobserve(img);
          img.src = img.dataset.src;
        }
        if (card._group) queueMeasure(card._group);
      }
    }, 700);
  }

  function renderMore() {
    if (app.rendered >= app.filtered.length) return;
    const next = Math.min(app.rendered + C.LIMITS.RENDER_CHUNK, app.filtered.length);
    const fragment = document.createDocumentFragment();
    for (let i = app.rendered; i < next; i++) fragment.appendChild(updateCard(app.filtered[i], i));
    app.rendered = next;
    el.grid.appendChild(fragment);
  }

  function updateCard(group, index) {
    let card = cardPool.get(group.stableId);
    if (!card) {
      card = buildCard();
      cardPool.set(group.stableId, card);
    }
    card.dataset.index = String(index);
    card.dataset.key = group.stableId;
    card._group = group;

    const selected = isSelected(group);
    card.classList.toggle('is-selected', selected);
    card.setAttribute('aria-selected', selected ? 'true' : 'false');

    const img = card._img;
    const thumbUrl = group.thumbUrl || group.url;
    if (img.dataset.src !== thumbUrl) {
      img.dataset.src = thumbUrl;
      img.classList.remove('is-loaded');
      card._thumb.classList.remove('is-broken');
      if (img.src) img.removeAttribute('src');
      io.observe(img);
    }
    img.alt = group.alt || '';

    card._dims.textContent = '';
    const dims = document.createElement('span');
    if (group.width && group.height) {
      dims.textContent = `${group.width} × ${group.height}`;
      if (group.dimensionConfidence < 3) dims.className = 'approx';
    } else {
      dims.textContent = 'Size unknown';
      dims.className = 'approx';
    }
    const fmt = document.createElement('span');
    fmt.className = 'fmt';
    fmt.textContent = group.format === 'unknown' ? '' : group.format;
    card._dims.append(dims, fmt);

    card._sub.textContent = '';
    // Cards are reused across refreshes, so clear the badge before re-adding it.
    if (card._best) { card._best.remove(); card._best = null; }
    if (group.versions > 1) {
      const best = document.createElement('span');
      best.className = 'badge-best';
      best.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .9 7.6 4l3.4.5-2.5 2.4.6 3.4L6 8.7 2.9 10.3l.6-3.4L1 4.5 4.4 4z"/></svg>Best';
      card._thumb.appendChild(best);
      card._best = best;

      const versions = document.createElement('button');
      versions.type = 'button';
      versions.className = 'versions';
      versions.textContent = `${group.versions} versions`;
      versions.title = 'Show every version found';
      card._sub.appendChild(versions);
    }

    const detail = document.createElement('span');
    detail.className = 'host';
    detail.textContent = group.bytes ? formatBytes(group.bytes) : group.host;
    detail.title = group.host;
    card._sub.appendChild(detail);

    card.title = group.best.url;
    return card;
  }

  function buildCard() {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'option');

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    img.decoding = 'async';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer-when-downgrade';
    img.addEventListener('load', () => img.classList.add('is-loaded'));
    img.addEventListener('error', () => thumb.classList.add('is-broken'));
    thumb.appendChild(img);

    const check = document.createElement('div');
    check.className = 'check';
    check.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-6.5"/></svg>';
    thumb.appendChild(check);

    const quick = document.createElement('button');
    quick.type = 'button';
    quick.className = 'quick-dl';
    quick.title = 'Download this image';
    quick.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.7 7.4 8 10.7l3.3-3.3M3 13h10"/></svg>';
    thumb.appendChild(quick);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const dims = document.createElement('div');
    dims.className = 'dims';
    const sub = document.createElement('div');
    sub.className = 'sub';
    meta.append(dims, sub);

    card.append(thumb, meta);
    card._img = img;
    card._thumb = thumb;
    card._dims = dims;
    card._sub = sub;
    return card;
  }

  function onIntersect(entries) {
    ioReported = true;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      io.unobserve(img);
      if (img.dataset.src) img.src = img.dataset.src;
      const card = img.closest('.card');
      if (card && card._group) queueMeasure(card._group);
    }
  }

  /* ================================================================== *
   * Measuring unknown dimensions
   * ================================================================== */

  function queueMeasure(group) {
    if (!app.settings.measureUnknown || app.tabId == null) return;
    if (group.dimensionConfidence >= 3 && group.width) return;
    const ranked = D.rankCandidates(group).slice(0, 2);
    for (const candidate of ranked) {
      if (candidate.width && candidate.height) continue;
      if (/^data:/i.test(candidate.url)) continue;
      if (measureRequested.has(candidate.url)) continue;
      measureRequested.add(candidate.url);
      measureQueue.add(candidate.url);
    }
    if (!measureQueue.size) return;
    clearTimeout(measureTimer);
    measureTimer = setTimeout(flushMeasure, 120);
  }

  async function flushMeasure() {
    const urls = Array.from(measureQueue).slice(0, 24);
    for (const url of urls) measureQueue.delete(url);
    if (!urls.length) return;
    try {
      const response = await chrome.tabs.sendMessage(app.tabId, { type: MSG.MEASURE, urls }, { frameId: 0 });
      let changed = false;
      for (const result of (response && response.measured) || []) {
        const candidate = app.candidates.get(result.url);
        if (candidate && result.width > (candidate.width || 0)) {
          candidate.width = result.width;
          candidate.height = result.height;
          changed = true;
        }
      }
      if (changed) scheduleRefresh();
    } catch (_) { /* page went away */ }
    if (measureQueue.size) {
      clearTimeout(measureTimer);
      measureTimer = setTimeout(flushMeasure, 120);
    }
  }

  /* ================================================================== *
   * Selection
   * ================================================================== */

  function isSelected(group) {
    for (const candidate of group.candidates) if (app.selected.has(candidate.url)) return true;
    return false;
  }

  function setSelected(group, on) {
    for (const candidate of group.candidates) {
      if (on) app.selected.add(candidate.url);
      else app.selected.delete(candidate.url);
    }
  }

  function selectedGroups() {
    return app.groups.filter(isSelected);
  }

  function updateSelectionUi() {
    for (const card of el.grid.children) {
      if (!card._group) continue;
      const on = isSelected(card._group);
      card.classList.toggle('is-selected', on);
      card.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    updateCounts();
  }

  function updateCounts() {
    const total = app.groups.length;
    const shown = app.filtered.length;
    const selected = selectedGroups().length;

    if (app.status === 'loading') {
      el.count.textContent = 'Finding images…';
    } else if (!total) {
      el.count.textContent = 'No images found';
    } else if (shown !== total) {
      el.count.textContent = `${shown} of ${total} images`;
    } else {
      el.count.textContent = `${total} image${total === 1 ? '' : 's'} found` + (app.truncated ? ' (limit reached)' : '');
    }

    el.selCount.textContent = '';
    if (selected) {
      const strong = document.createElement('strong');
      strong.textContent = String(selected);
      el.selCount.append(strong, ' selected');
    } else {
      el.selCount.textContent = shown
        ? `${shown} image${shown === 1 ? '' : 's'} ready`
        : 'No images selected';
    }

    el.download.textContent = selected ? `Download Selected` : 'Download All';
    el.download.disabled = app.downloading || (!selected && !shown);
  }

  /* ================================================================== *
   * Events
   * ================================================================== */

  function bindEvents() {
    el.grid.addEventListener('click', (event) => {
      const card = event.target.closest('.card');
      if (!card || !card._group) return;

      if (event.target.closest('.versions')) {
        event.stopPropagation();
        openVersions(card._group);
        return;
      }
      if (event.target.closest('.quick-dl')) {
        event.stopPropagation();
        downloadGroups([card._group], { single: true });
        return;
      }

      const index = Number(card.dataset.index);
      if (event.shiftKey && app.lastAnchor >= 0) {
        const [from, to] = app.lastAnchor < index ? [app.lastAnchor, index] : [index, app.lastAnchor];
        const on = !isSelected(card._group);
        for (let i = from; i <= to; i++) if (app.filtered[i]) setSelected(app.filtered[i], on);
      } else {
        setSelected(card._group, !isSelected(card._group));
        app.lastAnchor = index;
      }
      updateSelectionUi();
    });

    el.grid.addEventListener('keydown', (event) => {
      const card = event.target.closest('.card');
      if (!card || !card._group) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setSelected(card._group, !isSelected(card._group));
        app.lastAnchor = Number(card.dataset.index);
        updateSelectionUi();
      }
    });

    el.search.addEventListener('input', debounce(() => {
      app.filters.search = el.search.value.trim().toLowerCase();
      app.rendered = 0;
      refresh();
    }, 120));

    el.tabs.addEventListener('click', (event) => {
      const tab = event.target.closest('.tab');
      if (!tab) return;
      for (const node of el.tabs.children) node.classList.toggle('is-active', node === tab);
      app.filters.category = tab.dataset.cat;
      app.rendered = 0;
      refresh();
    });

    el.sort.addEventListener('change', () => save({ sort: el.sort.value }));

    el.filtersBtn.addEventListener('click', () => {
      const open = el.filters.hidden;
      el.filters.hidden = !open;
      el.filtersBtn.setAttribute('aria-expanded', String(open));
    });

    el.minWidth.addEventListener('change', () => save({ minWidth: clampInt(el.minWidth.value, 0, 20000) }));
    el.minHeight.addEventListener('change', () => save({ minHeight: clampInt(el.minHeight.value, 0, 20000) }));
    el.filterFormat.addEventListener('change', () => { app.filters.format = el.filterFormat.value; app.rendered = 0; refresh(); });
    el.filterOrientation.addEventListener('change', () => { app.filters.orientation = el.filterOrientation.value; app.rendered = 0; refresh(); });
    el.optHideTiny.addEventListener('change', () => save({ hideTiny: el.optHideTiny.checked }));
    el.optGroup.addEventListener('change', () => save({ groupDuplicates: el.optGroup.checked }));
    el.optPrefer.addEventListener('change', () => save({ preferHighestQuality: el.optPrefer.checked }));

    el.grid.addEventListener('dblclick', (event) => {
      const card = event.target.closest('.card');
      if (card && card._group) openVersions(card._group);
    });

    $('btn-select-all').addEventListener('click', () => {
      for (const group of app.filtered) setSelected(group, true);
      updateSelectionUi();
    });
    $('btn-select-none').addEventListener('click', () => {
      app.selected.clear();
      updateSelectionUi();
    });
    $('btn-invert').addEventListener('click', () => {
      for (const group of app.filtered) setSelected(group, !isSelected(group));
      updateSelectionUi();
    });

    el.rescan.addEventListener('click', rescan);
    el.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
    el.pick.addEventListener('click', () => setPickMode(!app.pickMode));

    el.dlOptionsBtn.addEventListener('click', () => toggleSheet(el.dlOptions, el.dlOptions.hidden));
    $('btn-close-options').addEventListener('click', () => toggleSheet(el.dlOptions, false));
    $('btn-close-versions').addEventListener('click', () => toggleSheet(el.versions, false));
    el.scrim.addEventListener('click', closeSheets);

    el.dlFormat.addEventListener('change', (event) => {
      if (event.target.name !== 'dlformat') return;
      save({ format: event.target.value });
    });
    el.dlNaming.addEventListener('change', (event) => {
      if (event.target.name !== 'dlnaming') return;
      save({ naming: event.target.value });
    });
    el.dlQuality.addEventListener('input', () => { el.dlQualityOut.textContent = el.dlQuality.value; });
    el.dlQuality.addEventListener('change', () => save({ jpgQuality: clampInt(el.dlQuality.value, 10, 100) }));
    el.dlFolder.addEventListener('change', () => save({ folderPerPage: el.dlFolder.checked }));
    el.dlZip.addEventListener('change', () => save({ zip: el.dlZip.checked }));

    el.download.addEventListener('click', () => {
      const targets = selectedGroups();
      void downloadGroups(targets.length ? targets : app.filtered, {});
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!el.dlOptions.hidden || !el.versions.hidden) { closeSheets(); return; }
        if (app.pickMode) setPickMode(false);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && event.target === document.body) {
        event.preventDefault();
        for (const group of app.filtered) setSelected(group, true);
        updateSelectionUi();
      }
    });

    S.onChange((next) => {
      app.settings = next;
      applySettingsToUi();
      app.rendered = 0;
      refresh();
    });

    // Focus moves between the page and the panel constantly. Re-running the
    // whole inject-and-scan handshake each time is both wasteful and risky, so
    // only react when the user genuinely switched to a different tab.
    window.addEventListener('focus', () => { void retargetIfTabChanged(); });
  }

  async function retargetIfTabChanged() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab && tab.id != null && tab.id !== app.tabId) await loadTab(tab.id);
    } catch (_) { /* nothing to re-target */ }
  }

  async function rescan() {
    if (app.tabId == null) { void loadTab(); return; }
    el.rescan.classList.add('is-spinning');
    setBusy(true);
    try {
      const injected = await chrome.runtime.sendMessage({ type: MSG.ENSURE_INJECTED, tabId: app.tabId });
      if (!injected || !injected.ok) {
        if (injected && injected.restricted) { setStatus('restricted'); return; }
        // Retrying is worth a try (a slow or half-loaded page recovers), but
        // when Chrome really has not granted access only invoking the
        // extension itself can fix it — a panel click is not an invocation.
        toast('Chrome has not granted access to this page. Start Image Downloader from its toolbar icon, or press Alt+Shift+I.', true);
        if (!app.candidates.size) setStatus('needs-invoke');
        return;
      }
      measureRequested.clear();
      const payload = await chrome.tabs.sendMessage(app.tabId, { type: MSG.SCAN, deep: true }, { frameId: 0 });
      if (payload) {
        app.candidates.clear();
        ingest(payload, true);
        app.rendered = 0;
        if (app.status !== 'ready') setStatus('ready');
        refresh();
      }
    } catch (error) {
      toast('Could not rescan this page.', true);
    } finally {
      el.rescan.classList.remove('is-spinning');
      setBusy(false);
    }
  }

  /* ================================================================== *
   * Pick mode
   * ================================================================== */

  async function setPickMode(on, fromPage) {
    if (app.tabId == null) return;
    app.pickMode = on;
    el.pick.setAttribute('aria-pressed', String(on));
    if (fromPage) {
      if (!on) closePickPort();
      return;
    }
    try {
      if (on) {
        await chrome.runtime.sendMessage({ type: MSG.ENSURE_INJECTED, tabId: app.tabId });
        await chrome.tabs.sendMessage(app.tabId, {
          type: MSG.PICK_START,
          selected: Array.from(app.selected)
        }, { frameId: 0 });
        openPickPort();
        toast('Pick mode on — click images on the page. Esc to exit.');
      } else {
        closePickPort();
        await chrome.tabs.sendMessage(app.tabId, { type: MSG.PICK_STOP }, { frameId: 0 });
      }
    } catch (_) {
      closePickPort();
      app.pickMode = false;
      el.pick.setAttribute('aria-pressed', 'false');
      toast('Pick mode is not available on this page.', true);
    }
  }

  /**
   * A port whose only job is to die with the panel: the content script tears
   * Pick Mode down when it disconnects, so closing the side panel can never
   * strand an overlay on the page.
   */
  function openPickPort() {
    closePickPort();
    try {
      pickPort = chrome.tabs.connect(app.tabId, { name: 'imgdl-pick', frameId: 0 });
      pickPort.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        pickPort = null;
      });
    } catch (_) {
      pickPort = null;
    }
  }

  function closePickPort() {
    if (!pickPort) return;
    try { pickPort.disconnect(); } catch (_) { /* already gone */ }
    pickPort = null;
  }

  function onPicked(pick) {
    if (!pick || !pick.url) return;
    if (pick.selected) app.selected.add(pick.url);
    else app.selected.delete(pick.url);
    scheduleRefresh();
    updateSelectionUi();
  }

  /* ================================================================== *
   * Downloads
   * ================================================================== */

  async function downloadGroups(groups, options) {
    if (!groups.length || app.downloading) return;
    const opts = options || {};
    const config = Object.assign({}, app.settings, opts.single ? { zip: false } : null);
    // The extension holds http/https access, so image bytes are readable
    // without prompting for anything. If a user has narrowed site access with
    // Chrome's own control, fetchBlob falls back to the page and then to a
    // plain URL download, so nothing here needs to ask.
    const plan = DL.planDownloads(groups, config, { title: app.pageTitle, url: app.pageUrl });

    setDownloading(true, plan.length);

    try {
      if (config.zip) await downloadAsZip(plan, config);
      else await downloadIndividually(plan, config);
    } catch (error) {
      toast(errorText(error), true);
    } finally {
      setDownloading(false);
    }
  }

  async function downloadIndividually(plan, config) {
    let done = 0;
    let failed = 0;
    // Names are settled in-process so a corrected extension cannot collide
    // with another file in the same batch.
    const usedPaths = new Set();
    const results = await DL.runQueue(plan, async (task) => {
      try {
        if (CV.needsConversion(task.sourceFormat, config.format)) {
          await downloadConverted(task, config);
        } else if (await canReadBytes(task.url)) {
          await downloadVerifiedOriginal(task, usedPaths, config);
        } else if (/^(blob|data):/i.test(task.url)) {
          // A page-created blob: URL belongs to the page's origin, so the
          // downloads API cannot resolve it from here; a data: URL for a
          // serialised inline SVG can be long enough to be refused. Both are
          // safe once the bytes live in an extension-owned blob.
          await downloadViaBytes(task);
        } else {
          await DL.downloadWithFallback(task);
        }
      } finally {
        done++;
        setProgress(done, plan.length);
      }
    }, C.LIMITS.DOWNLOAD_CONCURRENCY);

    for (const result of results) if (!result.ok) failed++;
    if (failed) toast(`${plan.length - failed} of ${plan.length} downloaded — ${failed} failed.`, true);
    else toast(`${plan.length} image${plan.length === 1 ? '' : 's'} downloaded.`);
  }

  /**
   * "Original format", but with the filename checked against reality.
   *
   * A CDN happily serves AVIF from a ".jpg" URL, and chrome.downloads would
   * save it under that false name because it fetches the URL itself and we
   * never see the bytes. So fetch once, sniff, fix the extension, and hand
   * Chrome the exact same bytes — no decode, no re-encode.
   */
  async function downloadVerifiedOriginal(task, usedPaths, config) {
    let blob;
    try {
      blob = await fetchBlob(task.url, task.fallbacks);
    } catch (_) {
      // Blocked by CORS, 403, offline… never let verification cost a download.
      await DL.downloadWithFallback(task);
      return;
    }
    const header = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const detected = N.detectImageFormat(header, blob.type);

    // The plan trusted the URL's extension when it decided no conversion was
    // needed. Now that the real format is known, a ".png" URL serving AVIF
    // still owes the user the PNG they asked for.
    const target = config && config.format;
    if (detected.extension && CV.needsConversion(detected.extension, target)) {
      const converted = await CV.convertBlob(blob, target, config.jpgQuality);
      await downloadBlob(converted, uniqueCorrectedPath(task.path, target, usedPaths));
      return;
    }

    // `blob` is passed through untouched, so the saved bytes are identical.
    await downloadBlob(blob, uniqueCorrectedPath(task.path, detected.extension, usedPaths));
  }

  function uniqueCorrectedPath(path, extension, usedPaths) {
    const corrected = extension ? F.pathWithExtension(path, extension) : path;
    return usedPaths ? F.uniquePath(corrected, usedPaths) : corrected;
  }

  /** Re-host bytes we cannot hand to chrome.downloads by URL. */
  async function downloadViaBytes(task) {
    const blob = await fetchBlob(task.url, task.fallbacks);
    let path = task.path;
    // The source URL carried no extension; take it from the actual MIME type.
    if (!/\.[a-z0-9]{2,5}$/i.test(path)) {
      const format = N.guessFormat('', blob.type);
      if (format !== 'unknown') path = F.ensureExtension(path, format);
    }
    await downloadBlob(blob, path);
  }

  async function downloadConverted(task, config) {
    const blob = await fetchBlob(task.url, task.fallbacks);
    const converted = await CV.convertBlob(blob, config.format, config.jpgQuality);
    await downloadBlob(converted, task.path);
  }

  async function downloadAsZip(plan, config) {
    const files = [];
    const used = new Set();
    let done = 0;
    let failed = 0;

    await DL.runQueue(plan, async (task) => {
      try {
        let blob = await fetchBlob(task.url, task.fallbacks);
        let converted = false;
        if (CV.needsConversion(task.sourceFormat, config.format)) {
          blob = await CV.convertBlob(blob, config.format, config.jpgQuality);
          converted = true;
        }
        // Store the bytes exactly as received; only the name is corrected.
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const detected = converted ? null : N.detectImageFormat(bytes, blob.type);
        const name = DL.archiveEntryName(task.filename, detected, { converted });
        files.push({ name: F.uniquify(name, used), data: bytes });
      } catch (_) {
        failed++;
      } finally {
        done++;
        setProgress(done, plan.length, 'Collecting');
      }
    }, 3);

    if (!files.length) {
      throw new Error('None of the selected images could be read.' + (app.allSites ? ''
        : ' Turn on "Scan every page automatically" to let it read images hosted on other sites.'));
    }
    setProgress(plan.length, plan.length, 'Packaging');
    // Deterministic order so the archive matches what the panel showed.
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const archive = ZIP.createZip(files);
    // Always hand Chrome an explicit sanitised name ending in .zip — never let
    // the blob URL, the page title or content sniffing decide the extension.
    const zipFilename = F.archiveName(app.pageTitle, app.pageUrl);
    let zipPath = F.joinPath(config.downloadFolder, zipFilename);
    if (!/\.zip$/i.test(zipPath)) zipPath += '.zip';
    await downloadBlob(archive, zipPath);
    toast(failed
      ? `Zipped ${files.length} images — ${failed} could not be read.`
      : `Zipped ${files.length} image${files.length === 1 ? '' : 's'}.`, Boolean(failed));
  }

  /** Read image bytes: extension context when permitted, otherwise the page. */
  async function fetchBlob(url, fallbacks) {
    const urls = [url].concat(fallbacks || []);
    let lastError = null;
    for (const candidate of urls) {
      try {
        if (/^data:/i.test(candidate)) {
          const response = await fetch(candidate);
          return await response.blob();
        }
        // A blob: URL is scoped to the origin that made it, so only the page
        // can read it — never try the extension context first.
        if (/^blob:/i.test(candidate)) {
          if (app.tabId == null) throw new Error('No page available to read this image from.');
          const result = await chrome.tabs.sendMessage(app.tabId, { type: MSG.FETCH_BYTES, url: candidate }, { frameId: 0 });
          if (!result || !result.ok) throw new Error((result && result.error) || 'Blocked by the site.');
          return base64ToBlob(result.result.base64, result.result.type);
        }
        if (await hasOriginPermission(candidate)) {
          const response = await fetch(candidate, { credentials: 'omit' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return await response.blob();
        }
        if (app.tabId == null) throw new Error('No page available to read from.');
        const result = await chrome.tabs.sendMessage(app.tabId, { type: MSG.FETCH_BYTES, url: candidate }, { frameId: 0 });
        if (!result || !result.ok) throw new Error((result && result.error) || 'Blocked by the site.');
        return base64ToBlob(result.result.base64, result.result.type);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Could not read the image.');
  }

  function base64ToBlob(base64, type) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: type || 'application/octet-stream' });
  }

  function downloadBlob(blob, path) {
    const url = URL.createObjectURL(blob);
    // Release once Chrome has finished with the URL, on success or failure,
    // so a long session cannot accumulate object URLs.
    const release = () => setTimeout(() => URL.revokeObjectURL(url), 2000);
    return DL.downloadOnce({ url, filename: path, conflictAction: 'uniquify' })
      .then((id) => { release(); return id; }, (error) => { release(); throw error; });
  }

  /* ---- origin-scoped permissions (never <all_urls>) ---------------------- */

  function pageOriginPattern() {
    try {
      return new URL(app.pageUrl).origin + '/*';
    } catch (_) {
      return '';
    }
  }

  const ALL_SITES = ['http://*/*', 'https://*/*'];

  async function refreshAllSitesState() {
    try {
      app.allSites = await chrome.permissions.contains({ origins: ALL_SITES });
    } catch (_) {
      app.allSites = false;
    }
  }

  /**
   * The single opt-in. Declared optional rather than required so installing
   * shows no host warning and existing users are never force-disabled by an
   * update; anyone who wants the panel to keep up as they browse grants it here.
   * Must be the first await in its handler or the user gesture is lost.
   */
  async function grantAllSites() {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: ALL_SITES });
    } catch (_) {
      granted = false;
    }
    if (!granted) {
      toast('No problem. You can still scan any page from the toolbar icon.');
      return;
    }
    app.allSites = true;
    originGrants.clear();
    toast('Image Downloader will now scan pages as you browse.');
    await loadTab(app.tabId);
    await rescan();
  }

  const originGrants = new Map();

  /** Can the extension itself fetch this URL right now? */
  async function hasOriginPermission(url) {
    const pattern = DL.originPattern(url);
    if (!pattern) return false;
    if (originGrants.has(pattern)) return originGrants.get(pattern);
    let granted = false;
    try {
      granted = await chrome.permissions.contains({ origins: [pattern] });
    } catch (_) {
      granted = false;
    }
    originGrants.set(pattern, granted);
    return granted;
  }

  /**
   * True when the bytes are reachable without another prompt: either the
   * extension holds the origin, or the image is same-origin with the page and
   * the content script can fetch it for us.
   */
  async function canReadBytes(url) {
    if (!/^https?:/i.test(url)) return false;
    const pattern = DL.originPattern(url);
    if (pattern && pattern === pageOriginPattern()) return true;
    return hasOriginPermission(url);
  }


  function setDownloading(on, total) {
    app.downloading = on;
    el.progress.hidden = !on;
    el.download.disabled = on;
    if (on) setProgress(0, total || 1);
    updateCounts();
  }

  function setProgress(done, total, label) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    el.progressFill.style.width = pct + '%';
    el.progressText.textContent = `${label || 'Downloading'} ${done}/${total}`;
  }

  /* ================================================================== *
   * Versions sheet
   * ================================================================== */

  function openVersions(group) {
    const ranked = D.rankCandidates(group);
    const ratio = D.groupAspectRatio(group.candidates);
    el.versionsTitle.textContent = `${group.versions} versions found`;
    el.versionsList.textContent = '';

    for (const candidate of ranked) {
      const dims = D.effectiveDimensions(candidate, ratio);
      const item = document.createElement('li');
      if (candidate === group.best) item.classList.add('is-best');

      const main = document.createElement('div');
      main.className = 'v-main';
      const size = document.createElement('span');
      size.className = 'v-dims';
      size.textContent = dims.width && dims.height
        ? `${dims.width} × ${dims.height}${dims.confidence < 3 ? ' (estimated)' : ''}`
        : 'Size unknown';
      if (candidate.bytes) size.textContent += ` · ${formatBytes(candidate.bytes)}`;
      const url = document.createElement('span');
      url.className = 'v-url';
      url.textContent = candidate.url;
      url.title = candidate.url;
      main.append(size, url);

      if (candidate === group.best) {
        const tag = document.createElement('span');
        tag.className = 'v-tag';
        tag.textContent = 'Best';
        main.appendChild(tag);
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Download';
      button.addEventListener('click', () => {
        void downloadGroups([{
          id: candidate.url,
          candidates: [candidate],
          best: candidate,
          versions: 1,
          url: candidate.url,
          width: dims.width,
          height: dims.height,
          format: candidate.format,
          alt: group.alt,
          title: group.title,
          bytes: candidate.bytes,
          host: group.host,
          svgSource: candidate.svgSource
        }], { single: true });
        toggleSheet(el.versions, false);
      });

      item.append(main, button);
      el.versionsList.appendChild(item);
    }
    toggleSheet(el.versions, true);
  }

  /* ================================================================== *
   * Chrome-facing helpers + view plumbing
   * ================================================================== */

  function applySettingsToUi() {
    const s = app.settings;
    el.sort.value = s.sort;
    el.minWidth.value = s.minWidth;
    el.minHeight.value = s.minHeight;
    el.optHideTiny.checked = s.hideTiny;
    el.optGroup.checked = s.groupDuplicates;
    el.optPrefer.checked = s.preferHighestQuality;
    el.dlQuality.value = s.jpgQuality;
    el.dlQualityOut.textContent = s.jpgQuality;
    el.dlFolder.checked = s.folderPerPage;
    el.dlZip.checked = s.zip;
    for (const input of el.dlFormat.querySelectorAll('input')) input.checked = input.value === s.format;
    for (const input of el.dlNaming.querySelectorAll('input')) input.checked = input.value === s.naming;
    el.qualityGroup.hidden = s.format === 'original' || s.format === 'png';
    el.filtersDot.hidden = s.minWidth === C.DEFAULT_SETTINGS.minWidth &&
      s.minHeight === C.DEFAULT_SETTINGS.minHeight &&
      s.hideTiny === C.DEFAULT_SETTINGS.hideTiny &&
      s.groupDuplicates === C.DEFAULT_SETTINGS.groupDuplicates;
    el.dlNote.textContent = s.format === 'original' && !s.zip
      ? 'Originals are saved exactly as the site serves them — nothing is re-encoded.'
      : 'Converting and zipping happens entirely on your machine. Nothing is uploaded.';
    el.dlNote.classList.remove('is-warn');
  }

  /**
   * Apply immediately, persist in the background — a toggle must be in effect
   * by the time the user's next click lands, not one storage round trip later.
   */
  function save(patch) {
    app.settings = S.clean(Object.assign({}, app.settings, patch));
    applySettingsToUi();
    app.rendered = 0;
    refresh();
    // Fire and forget: the in-memory value is authoritative for this session,
    // so a slow write can never roll the UI back to a stale state.
    return S.set(patch);
  }

  function setBusy(on) {
    el.count.classList.toggle('is-busy', on);
  }

  function setStatus(status, detail) {
    app.status = status;
    app.statusDetail = detail || '';
    const node = el.state;
    node.textContent = '';
    node.hidden = false;
    el.grid.hidden = true;

    const add = (tag, text, className) => {
      const child = document.createElement(tag);
      child.textContent = text;
      if (className) child.className = className;
      node.appendChild(child);
      return child;
    };

    switch (status) {
      case 'loading': {
        node.textContent = '';
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton';
        for (let i = 0; i < 9; i++) skeleton.appendChild(document.createElement('i'));
        node.appendChild(skeleton);
        node.style.padding = '0';
        return;
      }
      case 'ready':
        node.hidden = true;
        el.grid.hidden = false;
        node.style.padding = '';
        return;
      case 'empty':
        node.style.padding = '';
        add('strong', 'No downloadable images found.');
        add('p', 'Try scrolling the page to load more, then press Rescan.');
        addAction(node, 'Rescan', rescan);
        return;
      case 'empty-filtered':
        node.style.padding = '';
        add('strong', 'No images match these filters.');
        add('p', 'Clear the search or lower the minimum size to see more.');
        addAction(node, 'Reset filters', resetFilters);
        return;
      case 'restricted':
        node.style.padding = '';
        add('strong', 'This page does not allow extensions to inspect its content.');
        add('p', 'Chrome blocks extensions on internal pages and the Chrome Web Store. Open a normal web page and try again.');
        return;
      case 'needs-invoke':
        node.style.padding = '';
        add('strong', 'This page has not been scanned yet.');
        add('p', 'Click the Image Downloader icon in the toolbar, or press Alt+Shift+I.');
        if (!app.allSites) {
          addAction(node, 'Scan every page automatically', grantAllSites);
          add('p', 'Grants access to all sites so the panel keeps up as you browse. Undo it any time by right-clicking the extension icon.', 'hint');
        }
        return;
      case 'error':
      default:
        node.style.padding = '';
        add('strong', 'Something went wrong.');
        add('p', detail || 'Try reloading the page.');
        addAction(node, 'Try again', rescan);
    }
  }

  function addAction(node, label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.textContent = label;
    button.addEventListener('click', handler);
    node.appendChild(button);
  }

  function resetFilters() {
    el.search.value = '';
    app.filters = { search: '', category: 'all', format: '', orientation: '' };
    el.filterFormat.value = '';
    el.filterOrientation.value = '';
    for (const node of el.tabs.children) node.classList.toggle('is-active', node.dataset.cat === 'all');
    void save({ minWidth: 0, minHeight: 0, hideTiny: false });
  }

  function toggleSheet(sheet, open) {
    if (open) {
      el.dlOptions.hidden = sheet !== el.dlOptions;
      el.versions.hidden = sheet !== el.versions;
      el.scrim.hidden = false;
    } else {
      sheet.hidden = true;
      el.scrim.hidden = el.dlOptions.hidden && el.versions.hidden ? true : false;
    }
    el.dlOptionsBtn.setAttribute('aria-expanded', String(!el.dlOptions.hidden));
  }

  function closeSheets() {
    el.dlOptions.hidden = true;
    el.versions.hidden = true;
    el.scrim.hidden = true;
    el.dlOptionsBtn.setAttribute('aria-expanded', 'false');
  }

  let toastTimer = 0;
  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    el.toast.classList.toggle('is-error', Boolean(isError));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, isError ? 6000 : 3000);
  }

  function errorText(error) {
    const message = String((error && error.message) || error || 'Download failed.');
    if (/user cancel/i.test(message)) return 'Download cancelled.';
    return message;
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function clampInt(value, min, max) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function debounce(fn, wait) {
    let timer = 0;
    return function debounced() {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  }
})();
