/**
 * Chrome API stand-in for the side-panel preview harness.
 * Development only — never shipped with the extension.
 *
 * It feeds the panel a realistic candidate list (the exact shape content
 * scripts emit) served by tools/serve.mjs, so grouping, measuring, filtering,
 * rendering and the download pipeline all run for real.
 */
(function () {
  'use strict';
  const origin = location.origin;
  const img = (name) => `${origin}/mock/img/${name}`;

  // Raw candidates exactly as src/content/scanner.js would report them.
  const CANDIDATES = [
    // Spec section 27: four size variants as four separate <img> elements,
    // only the 600px one has actually loaded.
    { url: img('product-200.jpg'), source: 'img', domOrder: 0, bytes: 14880, alt: 'Nike Air Max black, side view' },
    { url: img('product-600.jpg'), source: 'currentSrc', domOrder: 1, width: 600, height: 600, bytes: 48210, alt: 'Nike Air Max black, side view' },
    { url: img('product-1200.jpg'), source: 'img', domOrder: 2, bytes: 186340, alt: 'Nike Air Max black, side view' },
    { url: img('product-2400.jpg'), source: 'img', domOrder: 3, bytes: 741220, alt: 'Nike Air Max black, side view' },

    // WordPress-style responsive set on one element.
    { url: img('golden-gate-bridge-fog-480x320.jpg'), source: 'srcset', nodeKey: 'n1', hintWidth: 480, domOrder: 4, alt: 'Golden Gate bridge in fog' },
    { url: img('golden-gate-bridge-fog-1024x683.jpg'), source: 'currentSrc', nodeKey: 'n1', width: 1024, height: 683, bytes: 214003, domOrder: 4, alt: 'Golden Gate bridge in fog' },
    { url: img('golden-gate-bridge-fog-2048x1365.jpg'), source: 'srcset', nodeKey: 'n1', hintWidth: 2048, domOrder: 4, bytes: 612940, alt: 'Golden Gate bridge in fog' },
    { url: img('golden-gate-bridge-fog.jpg'), source: 'link', nodeKey: 'n1', domOrder: 4, alt: 'Golden Gate bridge in fog' },

    // Blur-up placeholder + the real lazy-loaded photo, same element.
    { url: 'data:image/gif;base64,R0lGODlhAQABAIAAAMLCwgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', source: 'img', nodeKey: 'n2', width: 1, height: 1, domOrder: 5 },
    { url: img('mountain-lake-1600x1067.jpg'), source: 'lazy', nodeKey: 'n2', domOrder: 5, bytes: 418700, alt: 'Mountain lake at sunrise' },

    // Vector + raster of the same logo.
    { url: img('acme-logo-512x512.png'), source: 'img', nodeKey: 'n3', width: 512, height: 512, bytes: 18442, domOrder: 6, alt: 'Acme logo' },
    { url: img('acme-logo.svg'), source: 'link', nodeKey: 'n3', domOrder: 6, bytes: 5120, alt: 'Acme logo' },

    // Assorted singles.
    { url: img('team-photo-1280x853.jpg'), source: 'img', width: 1280, height: 853, bytes: 320441, domOrder: 7, alt: 'The team at the summit' },
    { url: img('loading-spinner-300x300.gif'), source: 'img', width: 300, height: 300, bytes: 9114, domOrder: 8, alt: 'Loading' },
    { url: img('icon-cart-64x64.png'), source: 'css', width: 64, height: 64, domOrder: 9 },
    { url: img('tracking-pixel-1x1.png'), source: 'img', width: 1, height: 1, domOrder: 10 },
    { url: img('hero-illustration.svg'), source: 'img', width: 900, height: 500, domOrder: 11, bytes: 24310, alt: 'Product illustration' },
    { url: img('opaque-7c99e9a1.jpg') + '?w=800&q=75', source: 'img', hintWidth: 800, domOrder: 12, bytes: 132400, alt: 'Studio shot' },
    { url: img('screenshot-dashboard-1920x1080.png'), source: 'img', width: 1920, height: 1080, bytes: 884210, domOrder: 13, alt: 'Dashboard screenshot' },
    { url: img('portrait-800x1200.jpg'), source: 'img', width: 800, height: 1200, bytes: 190553, domOrder: 14, alt: 'Portrait of a founder' },
    { url: img('DSC_1234.jpg'), source: 'img', width: 900, height: 600, domOrder: 15, bytes: 208650, alt: 'Gallery shot one' },
    { url: img('DSC_1235.jpg'), source: 'img', width: 900, height: 600, domOrder: 16, bytes: 197420, alt: 'Gallery shot two' },
    { url: img('DSC_1236.jpg'), source: 'img', width: 900, height: 600, domOrder: 17, bytes: 214880, alt: 'Gallery shot three' }
  ];

  const PAGE = { url: 'https://example.com/products/air-max', title: 'Air Max — Acme Store' };
  // ?granted=1 starts with all-sites already accepted, before the panel boots.
  const PRE_GRANTED = new URLSearchParams(location.search).get('granted') === '1';
  const listeners = [];
  const permissionListeners = { added: [], removed: [] };
  let granted = false;
  const store = {};

  function later(value) {
    return new Promise((resolve) => setTimeout(() => resolve(value), 30));
  }

  const MSG = {
    GET_TAB_STATE: 'imgdl:get-tab-state',
    ENSURE_INJECTED: 'imgdl:ensure-injected',
    SCAN: 'imgdl:scan',
    MEASURE: 'imgdl:measure',
    FETCH_BYTES: 'imgdl:fetch-bytes',
    PICK_START: 'imgdl:pick-start',
    PICK_STOP: 'imgdl:pick-stop'
  };

  function snapshot() {
    return {
      candidates: CANDIDATES.map((candidate) => Object.assign({
        width: 0, height: 0, hintWidth: 0, hintHeight: 0, displayWidth: 0, displayHeight: 0,
        bytes: 0, alt: '', title: '', nodeKey: '', svgSource: '', format: ''
      }, candidate)),
      full: true,
      pageUrl: PAGE.url,
      pageTitle: PAGE.title,
      truncated: false
    };
  }

  function measure(urls) {
    return Promise.all((urls || []).map((url) => new Promise((resolve) => {
      const image = new Image();
      const finish = (width, height) => resolve({ url, width, height });
      image.onload = () => finish(image.naturalWidth, image.naturalHeight);
      image.onerror = () => finish(0, 0);
      image.src = url;
    }))).then((measured) => ({ measured: measured.filter((entry) => entry.width) }));
  }

  window.chrome = {
    runtime: {
      lastError: undefined,
      id: 'preview',
      connect: () => ({ onDisconnect: { addListener() {} }, disconnect() {} }),
      openOptionsPage: () => window.open('../../src/options/options.html', '_blank'),
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1)
      },
      sendMessage: (message) => {
        if (message.type === MSG.GET_TAB_STATE) {
          // ?state=restricted|empty|needs-invoke exercises the non-happy paths.
          const state = new URLSearchParams(location.search).get('state');
          if (state === 'restricted') {
            return later({ ok: false, tabId: 1, restricted: true, pageUrl: 'chrome://settings', pageTitle: 'Settings' });
          }
          // Lets a test simulate a re-check failing after images already loaded.
          if (window.__forceNeedsInvoke) {
            return later({ ok: false, tabId: 1, needsInvoke: true, error: 'Cannot access contents of the page.', pageUrl: PAGE.url, pageTitle: PAGE.title });
          }
          if (state === 'needs-invoke') {
            return later({ ok: false, tabId: 1, needsInvoke: true, error: 'Cannot access contents of the page.', pageUrl: PAGE.url, pageTitle: PAGE.title });
          }
          if (state === 'empty') {
            return later({ ok: true, tabId: 1, snapshot: { candidates: [], full: true, pageUrl: PAGE.url, pageTitle: PAGE.title }, pageUrl: PAGE.url, pageTitle: PAGE.title });
          }
          return later({ ok: true, tabId: 1, snapshot: snapshot(), pageUrl: PAGE.url, pageTitle: PAGE.title });
        }
        if (message.type === MSG.ENSURE_INJECTED) {
          const state = new URLSearchParams(location.search).get('state');
          if (state === 'restricted') return later({ ok: false, restricted: true });
          if (state === 'needs-invoke' || window.__forceNeedsInvoke) {
            return later({ ok: false, needsInvoke: true, error: 'Cannot access contents of the page.' });
          }
          return later({ ok: true, injected: false });
        }
        return later({ ok: true });
      }
    },
    tabs: {
      sendMessage: (tabId, message) => {
        if (message.type === MSG.SCAN) return later(snapshot());
        if (message.type === MSG.MEASURE) return measure(message.urls);
        if (message.type === MSG.FETCH_BYTES) {
          return fetch(message.url)
            .then((response) => response.blob())
            .then((blob) => new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve({
                ok: true,
                result: { base64: String(reader.result).split(',')[1], type: blob.type, size: blob.size }
              });
              reader.readAsDataURL(blob);
            }));
        }
        if (message.type === MSG.PICK_START || message.type === MSG.PICK_STOP) return later({ ok: true });
        return later({});
      },
      query: () => later([{ id: 1, url: PAGE.url, title: PAGE.title }]),
      get: () => later({ id: 1, url: PAGE.url, title: PAGE.title }),
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} }
    },
    storage: {
      sync: {
        get: (key) => later(key in store ? { [key]: store[key] } : {}),
        set: (patch) => { Object.assign(store, patch); return later(); }
      },
      // sessionStorage has the same lifetime semantics as chrome.storage.session:
      // survives a panel reopen, gone when the browser session ends.
      session: {
        get: (key) => {
          const raw = sessionStorage.getItem('imgdl:' + key);
          return later(raw == null ? {} : { [key]: JSON.parse(raw) });
        },
        set: (patch) => {
          for (const k of Object.keys(patch)) sessionStorage.setItem('imgdl:' + k, JSON.stringify(patch[k]));
          return later();
        },
        remove: (key) => { sessionStorage.removeItem('imgdl:' + key); return later(); }
      },
      onChanged: { addListener() {}, removeListener() {} }
    },
    permissions: {
      // Per-origin model, so tests can assert exactly what was asked for.
      _granted: new Set(PRE_GRANTED ? ['http://*/*', 'https://*/*'] : []),
      _requests: [],
      _allow: true,
      contains: (details) => {
        const origins = (details && details.origins) || [];
        if (granted) return later(true);
        return later(origins.length > 0 && origins.every((o) => chrome.permissions._granted.has(o)));
      },
      request: (details) => {
        const origins = (details && details.origins) || [];
        chrome.permissions._requests.push(origins.slice());
        if (!chrome.permissions._allow) return later(false);
        if (origins.includes('<all_urls>')) granted = true;
        for (const origin of origins) chrome.permissions._granted.add(origin);
        permissionListeners.added.forEach((fn) => fn());
        return later(true);
      },
      remove: (details) => {
        const origins = (details && details.origins) || [];
        if (origins.includes('<all_urls>')) granted = false;
        for (const origin of origins) chrome.permissions._granted.delete(origin);
        permissionListeners.removed.forEach((fn) => fn());
        return later(true);
      },
      onAdded: { addListener: (fn) => permissionListeners.added.push(fn) },
      onRemoved: { addListener: (fn) => permissionListeners.removed.push(fn) }
    },
    downloads: {
      _log: [],
      _nextId: 1,
      onChanged: { _fns: [], addListener(fn) { this._fns.push(fn); }, removeListener(fn) { this._fns.splice(this._fns.indexOf(fn), 1); } },
      download(options, callback) {
        const id = chrome.downloads._nextId++;
        chrome.downloads._log.push({ id, url: options.url, filename: options.filename });
        console.log('[mock download]', id, options.filename, '<-', String(options.url).slice(0, 120));
        setTimeout(() => callback(id), 5);
        setTimeout(() => {
          for (const fn of chrome.downloads.onChanged._fns.slice()) fn({ id, state: { current: 'complete' } });
        }, 40);
      }
    }
  };

  window.__mockDownloads = () => chrome.downloads._log;

  /** Deliver a runtime message to the panel exactly as the service worker would. */
  window.__deliver = (message) => {
    for (const listener of listeners.slice()) listener(message, {}, () => {});
  };
  window.__deliverCandidates = (candidates, opts) => window.__deliver({
    type: 'imgdl:candidates',
    tabId: 1,
    frameId: 0,
    payload: Object.assign({
      candidates: candidates.map((c) => Object.assign({
        width: 0, height: 0, hintWidth: 0, hintHeight: 0, displayWidth: 0, displayHeight: 0,
        bytes: 0, alt: '', title: '', nodeKey: '', svgSource: '', format: '', source: 'img', domOrder: 0
      }, c)),
      full: false,
      pageUrl: PAGE.url,
      pageTitle: PAGE.title
    }, opts || {})
  });
})();
