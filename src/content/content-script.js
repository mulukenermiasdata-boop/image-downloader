/**
 * Content-script entry point: wires the scanner + picker to the extension,
 * and keeps results fresh with a debounced MutationObserver.
 *
 * Injected on demand (activeTab) or registered dynamically once the user grants
 * access to all sites. Safe to inject repeatedly.
 */
(function (global) {
  'use strict';
  const IMGDL = global.IMGDL;
  if (!IMGDL || !IMGDL.scanner) return;

  const C = IMGDL.C;
  const MSG = C.MSG;
  const scanner = IMGDL.scanner;
  const picker = IMGDL.picker;

  // Re-injection (second toolbar click, tab re-activated) just triggers a scan.
  if (global.__imgdlContentReady) {
    scheduleScan({ deep: false, immediate: true });
    return;
  }
  global.__imgdlContentReady = true;

  let lastSentRevision = 0;
  let debounceTimer = 0;
  let maxWaitTimer = 0;
  let disconnected = false;

  /* ------------------------------------------------------------------ *
   * Talking to the extension
   * ------------------------------------------------------------------ */

  function send(message) {
    if (disconnected) return;
    try {
      chrome.runtime.sendMessage(message, () => {
        // Nobody listening (panel closed) is normal; swallow the error.
        void chrome.runtime.lastError;
      });
    } catch (_) {
      // Extension context invalidated (reload/update) — stop trying.
      disconnected = true;
      cleanup();
    }
  }

  function publish(payload) {
    if (!payload) return;
    lastSentRevision = payload.revision;
    send({ type: MSG.CANDIDATES, payload });
  }

  function publishDelta() {
    const payload = scanner.snapshot(false, lastSentRevision);
    if (!payload.candidates.length) return;
    publish(payload);
  }

  /* ------------------------------------------------------------------ *
   * Scan scheduling
   * ------------------------------------------------------------------ */

  function runScan(options) {
    return scanner.scan(options).then((payload) => {
      lastSentRevision = payload.revision;
      publish(payload);
      return payload;
    }).catch((error) => {
      send({ type: MSG.CANDIDATES, payload: { candidates: [], full: true, error: String(error && error.message || error) } });
      return null;
    });
  }

  /**
   * Debounced so an infinite-scroll page that appends 200 nodes a second still
   * only costs one scan per ~350ms, with a hard ceiling of one per 1.5s.
   */
  function scheduleScan(options) {
    const opts = options || {};
    if (opts.immediate) {
      clearTimers();
      runScan(opts);
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      clearTimers();
      runScan(opts);
    }, C.LIMITS.SCAN_DEBOUNCE_MS);
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        clearTimers();
        runScan(opts);
      }, C.LIMITS.SCAN_DEBOUNCE_MS * 4);
    }
  }

  function clearTimers() {
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    debounceTimer = 0;
    maxWaitTimer = 0;
  }

  /* ------------------------------------------------------------------ *
   * Watching the page
   * ------------------------------------------------------------------ */

  const WATCHED_ATTRS = ['src', 'srcset', 'style', 'href', 'poster', 'class']
    .concat(C.LAZY_URL_ATTRS)
    .concat(C.LAZY_SRCSET_ATTRS);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') { scheduleScan({}); return; }
      if (record.addedNodes && record.addedNodes.length) { scheduleScan({}); return; }
    }
  });

  function observe() {
    try {
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: WATCHED_ATTRS
      });
    } catch (_) { /* document not ready */ }
  }

  // Lazy images have no dimensions until they load; catch that moment cheaply.
  function onLoadCapture(event) {
    const target = event.target;
    if (!target || target.tagName !== 'IMG' || !target.naturalWidth) return;
    const url = target.currentSrc || target.src;
    if (!url) return;
    scanner.add({
      url,
      source: C.SOURCE.CURRENT_SRC,
      width: target.naturalWidth,
      height: target.naturalHeight,
      nodeKey: scanner.nodeKeyFor(target),
      alt: target.getAttribute('alt') || ''
    });
    scheduleDelta();
  }

  let deltaTimer = 0;
  function scheduleDelta() {
    clearTimeout(deltaTimer);
    deltaTimer = setTimeout(publishDelta, C.LIMITS.SCAN_DEBOUNCE_MS);
  }

  function cleanup() {
    clearTimers();
    clearTimeout(deltaTimer);
    try { observer.disconnect(); } catch (_) { /* already gone */ }
    document.removeEventListener('load', onLoadCapture, true);
    if (picker && picker.isActive()) picker.stop('cleanup');
  }

  /* ------------------------------------------------------------------ *
   * Message handling
   * ------------------------------------------------------------------ */

  /**
   * The side panel holds a port open for as long as Pick Mode is on. Closing
   * the panel (or reloading the extension) destroys it without any chance to
   * send a message, so the port dropping is the only reliable signal that the
   * overlay, the crosshair cursor and the capturing listeners must come off
   * the page again.
   */
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'imgdl-pick') return;
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (picker && picker.isActive()) picker.stop('panel-closed');
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;

    switch (message.type) {
      case MSG.PING:
        sendResponse({ ok: true, ready: true, pageUrl: location.href, pageTitle: document.title });
        return false;

      case MSG.SCAN:
        runScan({ deep: Boolean(message.deep) }).then((payload) => {
          sendResponse(payload || { candidates: [], full: true });
        });
        return true;

      case MSG.MEASURE:
        scanner.measure(message.urls || []).then((result) => {
          sendResponse(result);
          scheduleDelta();
        }).catch(() => sendResponse({ measured: [] }));
        return true;

      case MSG.GET_ALTERNATES:
        sendResponse(scanner.alternatesFor(message.url));
        return false;

      case MSG.FETCH_BYTES:
        scanner.fetchBytes(message.url)
          .then((result) => sendResponse({ ok: true, result }))
          .catch((error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
        return true;

      case MSG.PICK_START:
        if (picker) {
          picker.start({
            selected: message.selected || [],
            onPick: (pick) => send({ type: MSG.PICKED, payload: pick }),
            onEnd: (reason) => send({ type: MSG.PICK_ENDED, payload: { reason } })
          });
          scheduleDelta();
        }
        sendResponse({ ok: Boolean(picker) });
        return false;

      case MSG.PICK_STOP:
        if (picker) picker.stop('panel');
        sendResponse({ ok: true });
        return false;

      default:
        return undefined;
    }
  });

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  document.addEventListener('load', onLoadCapture, true);
  // Only tear down for a real teardown. A bfcache freeze also fires pagehide,
  // and cleaning up there would leave a restored page with a dead observer.
  window.addEventListener('pagehide', (event) => { if (!event.persisted) cleanup(); });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    document.addEventListener('load', onLoadCapture, true);
    observe();
    scheduleScan({ deep: true, immediate: true });
  });
  observe();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleScan({ deep: true, immediate: true }), { once: true });
  } else {
    scheduleScan({ deep: true, immediate: true });
  }
  // Catch late-arriving above-the-fold images without polling.
  window.addEventListener('load', () => scheduleScan({ deep: true }), { once: true });
})(typeof self !== 'undefined' ? self : globalThis);
