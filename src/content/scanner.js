/**
 * Page-side image discovery.
 *
 * Runs in the content-script isolated world. Collects every image URL the
 * browser already knows about — markup, srcset, lazy-load attributes, CSS
 * backgrounds, inline SVG, resource timing — and never invents URLs.
 */
(function (global) {
  'use strict';
  const IMGDL = (global.IMGDL = global.IMGDL || {});
  if (IMGDL.scanner) return;
  const C = IMGDL.C;
  const N = IMGDL.normalizer;
  const { SOURCE, LIMITS } = C;

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  const nodeKeys = new WeakMap();
  const backgroundChecked = new WeakSet();
  let nodeCounter = 0;

  const state = {
    candidates: new Map(),   // url -> candidate
    byNode: new Map(),       // nodeKey -> Set<url>
    revision: 0,
    scanning: false,
    scanQueued: null
  };

  function nodeKeyFor(element) {
    if (!element) return '';
    let key = nodeKeys.get(element);
    if (!key) {
      key = 'n' + ++nodeCounter;
      nodeKeys.set(element, key);
    }
    return key;
  }

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /* ------------------------------------------------------------------ *
   * Candidate store
   * ------------------------------------------------------------------ */

  function add(input) {
    const url = N.absoluteUrl(input.url, document.baseURI);
    if (!url) return null;
    if (state.candidates.size >= LIMITS.MAX_CANDIDATES && !state.candidates.has(url)) return null;
    // Huge inline data URLs would bloat every message; keep them only when small.
    if (/^data:/i.test(url) && url.length > LIMITS.MAX_INLINE_SVG_BYTES) return null;

    let candidate = state.candidates.get(url);
    if (!candidate) {
      candidate = {
        url,
        source: input.source || SOURCE.IMG,
        width: 0,
        height: 0,
        hintWidth: 0,
        hintHeight: 0,
        displayWidth: 0,
        displayHeight: 0,
        bytes: 0,
        alt: '',
        title: '',
        nodeKey: '',
        domOrder: input.domOrder != null ? input.domOrder : state.candidates.size,
        format: N.guessFormat(url),
        svgSource: '',
        rev: 0
      };
      state.candidates.set(url, candidate);
      changed(candidate);
    }

    let dirty = false;
    if (input.width > candidate.width) {
      candidate.width = input.width | 0;
      candidate.height = input.height | 0;
      dirty = true;
    }
    for (const field of ['hintWidth', 'hintHeight', 'displayWidth', 'displayHeight', 'bytes']) {
      if (input[field] > (candidate[field] || 0)) { candidate[field] = input[field] | 0; dirty = true; }
    }
    for (const field of ['alt', 'title', 'svgSource']) {
      if (input[field] && !candidate[field]) { candidate[field] = String(input[field]).slice(0, 300); dirty = true; }
    }
    if (input.nodeKey && candidate.nodeKey !== input.nodeKey) {
      if (!candidate.nodeKey) { candidate.nodeKey = input.nodeKey; dirty = true; }
      let bucket = state.byNode.get(input.nodeKey);
      if (!bucket) { bucket = new Set(); state.byNode.set(input.nodeKey, bucket); }
      bucket.add(url);
    }
    if (input.domOrder != null && input.domOrder < candidate.domOrder) {
      candidate.domOrder = input.domOrder;
      dirty = true;
    }
    if (dirty) changed(candidate);
    return candidate;
  }

  function changed(candidate) {
    candidate.rev = ++state.revision;
  }

  /* ------------------------------------------------------------------ *
   * Collectors
   * ------------------------------------------------------------------ */

  function descriptorHint(entry, displayWidth) {
    if (entry.w) return entry.w;
    if (entry.d && displayWidth) return Math.round(displayWidth * entry.d);
    return 0;
  }

  function addSrcset(value, context) {
    if (!value) return;
    for (const entry of N.parseSrcset(value)) {
      add({
        url: entry.url,
        source: context.source || SOURCE.SRCSET,
        hintWidth: descriptorHint(entry, context.displayWidth),
        nodeKey: context.nodeKey,
        alt: context.alt,
        title: context.title,
        domOrder: context.domOrder
      });
    }
  }

  function fromImg(img, order) {
    const nodeKey = nodeKeyFor(img);
    let displayWidth = 0;
    let displayHeight = 0;
    try {
      const rect = img.getBoundingClientRect();
      displayWidth = Math.round(rect.width);
      displayHeight = Math.round(rect.height);
    } catch (_) { /* detached node */ }

    const context = {
      nodeKey,
      domOrder: order,
      alt: img.getAttribute('alt') || '',
      title: img.getAttribute('title') || '',
      displayWidth,
      displayHeight
    };

    const measured = img.complete && img.naturalWidth > 0
      ? { width: img.naturalWidth, height: img.naturalHeight }
      : { width: 0, height: 0 };

    const currentSrc = img.currentSrc || '';
    const rawSrc = img.getAttribute('src') || '';

    if (rawSrc) {
      add(Object.assign({ url: rawSrc, source: SOURCE.IMG }, context,
        currentSrc && currentSrc !== N.absoluteUrl(rawSrc, document.baseURI) ? {} : measured));
    }
    if (currentSrc) {
      add(Object.assign({ url: currentSrc, source: SOURCE.CURRENT_SRC }, context, measured));
    }

    addSrcset(img.getAttribute('srcset'), context);

    const picture = img.parentElement && img.parentElement.tagName === 'PICTURE'
      ? img.parentElement
      : (img.closest ? img.closest('picture') : null);
    if (picture) {
      for (const source of picture.querySelectorAll('source')) {
        addSrcset(source.getAttribute('srcset'), Object.assign({}, context, { source: SOURCE.PICTURE }));
        addSrcset(source.getAttribute('data-srcset'), Object.assign({}, context, { source: SOURCE.PICTURE }));
        const src = source.getAttribute('src');
        if (src) add(Object.assign({ url: src, source: SOURCE.PICTURE }, context));
      }
    }

    collectLazyAttributes(img, context);

    // A thumbnail wrapped in a link to the full-size file is the classic
    // gallery pattern; tie the link to the same element so they group.
    const anchor = img.closest ? img.closest('a[href]') : null;
    if (anchor) {
      const href = anchor.getAttribute('href');
      const absolute = N.absoluteUrl(href, document.baseURI);
      if (absolute && N.looksLikeImageUrl(absolute)) {
        add(Object.assign({}, context, { url: absolute, source: SOURCE.LINK }));
      }
    }

    // Recover the original behind a resizing proxy — the URL is right there in
    // the markup, so this is not URL guessing.
    for (const url of [currentSrc, rawSrc]) {
      if (!url) continue;
      const inner = N.unwrapProxy(N.absoluteUrl(url, document.baseURI));
      if (inner) add(Object.assign({}, context, { url: inner, source: SOURCE.UNWRAPPED }));
    }
  }

  function collectLazyAttributes(element, context) {
    for (const attr of C.LAZY_URL_ATTRS) {
      const value = element.getAttribute && element.getAttribute(attr);
      if (!value) continue;
      if (/^\s*(?:url\()/i.test(value)) {
        for (const url of N.extractCssUrls(value)) {
          add(Object.assign({}, context, { url, source: SOURCE.LAZY }));
        }
      } else if (value.includes(',') && /\s\d+[wx]\s*(,|$)/.test(value)) {
        addSrcset(value, Object.assign({}, context, { source: SOURCE.LAZY }));
      } else {
        add(Object.assign({}, context, { url: value, source: SOURCE.LAZY }));
      }
    }
    for (const attr of C.LAZY_SRCSET_ATTRS) {
      const value = element.getAttribute && element.getAttribute(attr);
      if (value) addSrcset(value, Object.assign({}, context, { source: SOURCE.LAZY }));
    }
  }

  function fromBackground(element, order) {
    let style;
    try {
      style = getComputedStyle(element);
    } catch (_) {
      return;
    }
    if (!style) return;
    const values = [style.backgroundImage, style.borderImageSource, style.maskImage];
    let rect = null;
    for (const value of values) {
      if (!value || value === 'none') continue;
      const urls = N.extractCssUrls(value);
      if (!urls.length) continue;
      if (!rect) {
        try { rect = element.getBoundingClientRect(); } catch (_) { rect = { width: 0, height: 0 }; }
      }
      const nodeKey = nodeKeyFor(element);
      for (const url of urls) {
        add({
          url,
          source: SOURCE.CSS,
          nodeKey,
          domOrder: order,
          displayWidth: Math.round(rect.width),
          displayHeight: Math.round(rect.height),
          title: element.getAttribute && (element.getAttribute('aria-label') || '') || ''
        });
      }
    }
  }

  function fromInlineSvg(svg, order) {
    if (!svg || svg.ownerSVGElement) return; // nested <svg>
    if (svg.closest && svg.closest('symbol, defs, clipPath, mask')) return;
    let rect;
    try {
      rect = svg.getBoundingClientRect();
    } catch (_) {
      return;
    }
    if (rect.width < 24 || rect.height < 24) return;

    let markup;
    try {
      markup = new XMLSerializer().serializeToString(svg);
    } catch (_) {
      return;
    }
    if (!markup || markup.length > LIMITS.MAX_INLINE_SVG_BYTES) return;
    if (!/\sxmlns=/.test(markup)) {
      markup = markup.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    if (!/\swidth=/.test(markup)) {
      markup = markup.replace(/^<svg/i, `<svg width="${Math.round(rect.width)}" height="${Math.round(rect.height)}"`);
    }

    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    if (url.length > LIMITS.MAX_INLINE_SVG_BYTES) return;
    add({
      url,
      source: SOURCE.SVG_INLINE,
      nodeKey: nodeKeyFor(svg),
      domOrder: order,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      displayWidth: Math.round(rect.width),
      displayHeight: Math.round(rect.height),
      title: (svg.querySelector('title') && svg.querySelector('title').textContent) || '',
      svgSource: 'inline'
    });
  }

  function fromMisc(element, order) {
    const tag = element.tagName;
    if (tag === 'A') {
      const href = element.getAttribute('href');
      const absolute = N.absoluteUrl(href, document.baseURI);
      if (absolute && N.looksLikeImageUrl(absolute)) {
        const inner = element.querySelector && element.querySelector('img');
        add({
          url: absolute,
          source: SOURCE.LINK,
          nodeKey: inner ? nodeKeyFor(inner) : nodeKeyFor(element),
          domOrder: order,
          title: element.getAttribute('title') || ''
        });
      }
      return;
    }
    if (tag === 'IMAGE' || (tag === 'image' && element.namespaceURI)) {
      const href = element.getAttribute('href') || element.getAttribute('xlink:href');
      if (href) add({ url: href, source: SOURCE.SVG_USE, nodeKey: nodeKeyFor(element), domOrder: order });
      return;
    }
    if (tag === 'OBJECT' || tag === 'EMBED') {
      const src = element.getAttribute('data') || element.getAttribute('src');
      const type = element.getAttribute('type') || '';
      const absolute = N.absoluteUrl(src, document.baseURI);
      if (absolute && (/^image\//i.test(type) || N.looksLikeImageUrl(absolute))) {
        add({ url: absolute, source: SOURCE.IMG, nodeKey: nodeKeyFor(element), domOrder: order });
      }
      return;
    }
    if (tag === 'VIDEO') {
      const poster = element.getAttribute('poster');
      if (poster) add({ url: poster, source: SOURCE.IMG, nodeKey: nodeKeyFor(element), domOrder: order });
      return;
    }
    if (tag === 'INPUT' && element.getAttribute('type') === 'image') {
      const src = element.getAttribute('src');
      if (src) add({ url: src, source: SOURCE.IMG, nodeKey: nodeKeyFor(element), domOrder: order });
    }
  }

  function collectMeta() {
    const selectors = [
      'meta[property="og:image"]', 'meta[property="og:image:url"]',
      'meta[property="og:image:secure_url"]', 'meta[name="og:image"]',
      'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]',
      'link[rel="image_src"]'
    ];
    let index = 0;
    for (const meta of document.querySelectorAll(selectors.join(','))) {
      const url = meta.getAttribute('content') || meta.getAttribute('href');
      if (url) add({ url, source: SOURCE.META, domOrder: 3000000 + index++ });
    }
    let preloadIndex = 0;
    for (const link of document.querySelectorAll('link[rel="preload"][as="image"], link[rel="prefetch"][as="image"]')) {
      const href = link.getAttribute('href');
      if (href) add({ url: href, source: SOURCE.PRELOAD, domOrder: 3100000 + preloadIndex++ });
      addSrcset(link.getAttribute('imagesrcset'), {
        source: SOURCE.PRELOAD,
        domOrder: 3100000 + preloadIndex++
      });
    }
  }

  /**
   * Resource timing tells us what the browser *actually* loaded — including
   * images injected by scripts and never attached to the DOM — plus real byte
   * sizes when the server allows timing access.
   */
  function collectPerformance() {
    if (typeof performance === 'undefined' || !performance.getEntriesByType) return;
    let entries;
    try {
      entries = performance.getEntriesByType('resource');
    } catch (_) {
      return;
    }
    let index = 0;
    for (const entry of entries) {
      const isImage = entry.initiatorType === 'img' ||
        ((entry.initiatorType === 'css' || entry.initiatorType === 'link' || entry.initiatorType === 'other') &&
          N.looksLikeImageUrl(entry.name));
      if (!isImage) continue;
      const bytes = entry.encodedBodySize || entry.transferSize || 0;
      const existing = state.candidates.get(entry.name);
      if (existing) {
        if (bytes > existing.bytes) { existing.bytes = bytes; changed(existing); }
      } else if (N.looksLikeImageUrl(entry.name) || entry.initiatorType === 'img') {
        add({ url: entry.name, source: SOURCE.NETWORK, bytes, domOrder: 2000000 + index++ });
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Scan driver
   * ------------------------------------------------------------------ */

  function idle() {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 200 });
      else setTimeout(resolve, 0);
    });
  }

  /**
   * @param {{deep?: boolean}} [options] deep re-checks computed styles for every
   *        element (used by the Rescan button); light scans only look at
   *        elements whose backgrounds have never been inspected.
   */
  async function scan(options) {
    const opts = options || {};
    if (state.scanning) {
      state.scanQueued = opts;
      return snapshot(false);
    }
    state.scanning = true;
    try {
      const deep = Boolean(opts.deep);

      // <img> first: document.images is complete and cheap even on huge pages.
      const images = document.images || [];
      for (let i = 0; i < images.length; i++) {
        try { fromImg(images[i], i); } catch (_) { /* keep scanning */ }
      }

      // Everything else needs an element walk, which we chunk and time-box.
      const elements = document.querySelectorAll('*');
      const total = Math.min(elements.length, LIMITS.MAX_ELEMENTS_SCANNED);
      let start = now();
      for (let i = 0; i < total; i++) {
        const element = elements[i];
        try {
          const tag = element.tagName;
          if (tag === 'A' || tag === 'OBJECT' || tag === 'EMBED' || tag === 'VIDEO' || tag === 'INPUT') {
            fromMisc(element, 1000000 + i);
          } else if (tag === 'svg') {
            fromInlineSvg(element, 1000000 + i);
          } else if (tag === 'image') {
            fromMisc(element, 1000000 + i);
          }
          if (tag !== 'IMG' && (deep || !backgroundChecked.has(element))) {
            backgroundChecked.add(element);
            fromBackground(element, 1000000 + i);
          }
        } catch (_) { /* keep scanning */ }

        if ((i & 63) === 0 && now() - start > LIMITS.MAX_SCAN_MS) {
          await idle();
          start = now();
        }
      }

      collectMeta();
      collectPerformance();
      return snapshot(true);
    } finally {
      state.scanning = false;
      if (state.scanQueued) {
        const queued = state.scanQueued;
        state.scanQueued = null;
        setTimeout(() => scan(queued).then(emit).catch(() => {}), 0);
      }
    }
  }

  /** Full or incremental payload for the side panel. */
  function snapshot(full, sinceRev) {
    const since = full ? 0 : (sinceRev || 0);
    const candidates = [];
    for (const candidate of state.candidates.values()) {
      if (candidate.rev > since) candidates.push(serialize(candidate));
    }
    return {
      candidates,
      full: Boolean(full),
      revision: state.revision,
      total: state.candidates.size,
      pageUrl: location.href,
      pageTitle: document.title || '',
      truncated: state.candidates.size >= LIMITS.MAX_CANDIDATES
    };
  }

  function serialize(candidate) {
    return {
      url: candidate.url,
      source: candidate.source,
      width: candidate.width,
      height: candidate.height,
      hintWidth: candidate.hintWidth,
      hintHeight: candidate.hintHeight,
      displayWidth: candidate.displayWidth,
      displayHeight: candidate.displayHeight,
      bytes: candidate.bytes,
      alt: candidate.alt,
      title: candidate.title,
      nodeKey: candidate.nodeKey,
      domOrder: candidate.domOrder,
      format: candidate.format,
      svgSource: candidate.svgSource
    };
  }

  let emitter = null;
  function onEmit(callback) { emitter = callback; }
  function emit(payload) { if (emitter && payload) emitter(payload); }

  /* ------------------------------------------------------------------ *
   * Measuring unknown sizes
   * ------------------------------------------------------------------ */

  const measureCache = new Map();
  let measureActive = 0;
  const measureQueue = [];

  function measureOne(url) {
    if (measureCache.has(url)) return Promise.resolve(measureCache.get(url));
    return new Promise((resolve) => {
      measureQueue.push({ url, resolve });
      pumpMeasure();
    });
  }

  function pumpMeasure() {
    while (measureActive < LIMITS.MEASURE_CONCURRENCY && measureQueue.length) {
      const job = measureQueue.shift();
      measureActive++;
      const image = new Image();
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        measureActive--;
        measureCache.set(job.url, result);
        image.onload = image.onerror = null;
        image.src = '';
        job.resolve(result);
        pumpMeasure();
      };
      const timer = setTimeout(() => finish({ url: job.url, width: 0, height: 0, error: 'timeout' }),
        LIMITS.MEASURE_TIMEOUT_MS);
      image.onload = () => {
        clearTimeout(timer);
        finish({ url: job.url, width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
      };
      image.onerror = () => {
        clearTimeout(timer);
        finish({ url: job.url, width: 0, height: 0, error: 'load-failed' });
      };
      try {
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer-when-downgrade';
        image.src = job.url;
      } catch (_) {
        clearTimeout(timer);
        finish({ url: job.url, width: 0, height: 0, error: 'bad-url' });
      }
    }
  }

  /**
   * Load the given URLs in the page context purely to read naturalWidth.
   * Only ever called for images the panel is actually showing.
   */
  async function measure(urls) {
    const list = (urls || []).slice(0, 60);
    const results = await Promise.all(list.map(measureOne));
    const updated = [];
    for (const result of results) {
      if (!result.width || !result.height) continue;
      const candidate = state.candidates.get(result.url);
      if (candidate && result.width > candidate.width) {
        candidate.width = result.width;
        candidate.height = result.height;
        changed(candidate);
      }
      updated.push(result);
    }
    return { measured: updated };
  }

  /* ------------------------------------------------------------------ *
   * Alternates for the context menu
   * ------------------------------------------------------------------ */

  /** Every candidate that plausibly belongs to the same picture as `url`. */
  function alternatesFor(rawUrl) {
    const url = N.absoluteUrl(rawUrl, document.baseURI);
    const out = new Map();
    const seed = state.candidates.get(url);
    const identity = N.identityKey(url);

    const push = (candidate) => { if (candidate) out.set(candidate.url, serialize(candidate)); };

    if (seed) {
      push(seed);
      const keys = new Set();
      if (seed.nodeKey) keys.add(seed.nodeKey);
      for (const [nodeKey, urls] of state.byNode) if (urls.has(url)) keys.add(nodeKey);
      for (const nodeKey of keys) {
        const urls = state.byNode.get(nodeKey);
        if (urls) for (const other of urls) push(state.candidates.get(other));
      }
    } else {
      // Right-clicked an image we never indexed (e.g. inside a canvas overlay).
      out.set(url, {
        url, source: SOURCE.IMG, width: 0, height: 0, hintWidth: 0, hintHeight: 0,
        displayWidth: 0, displayHeight: 0, bytes: 0, alt: '', title: '', nodeKey: '',
        domOrder: 0, format: N.guessFormat(url), svgSource: ''
      });
    }

    for (const candidate of state.candidates.values()) {
      if (N.identityKey(candidate.url) === identity) push(candidate);
    }

    // Also try to read the element under the pointer for extra srcset entries.
    return { candidates: Array.from(out.values()), pageUrl: location.href, pageTitle: document.title };
  }

  /* ------------------------------------------------------------------ *
   * Byte access (same-origin / CORS-permitting hosts only)
   * ------------------------------------------------------------------ */

  async function fetchBytes(url) {
    const response = await fetch(url, { credentials: 'include', mode: 'cors' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    if (blob.size > LIMITS.MAX_FETCH_BYTES) throw new Error('Image is too large to process.');
    const buffer = await blob.arrayBuffer();
    return { base64: toBase64(new Uint8Array(buffer)), type: blob.type, size: blob.size };
  }

  function toBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  IMGDL.scanner = {
    add,
    alternatesFor,
    fetchBytes,
    measure,
    nodeKeyFor,
    onEmit,
    scan,
    snapshot,
    state
  };
})(typeof self !== 'undefined' ? self : globalThis);
