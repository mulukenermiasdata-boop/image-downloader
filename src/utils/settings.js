/**
 * Persistent preferences. chrome.storage.sync when available (settings follow
 * the profile), chrome.storage.local as a fallback.
 */
(function (global) {
  'use strict';
  const IMGDL = (global.IMGDL = global.IMGDL || {});
  if (IMGDL.settings) return;
  const DEFAULTS = IMGDL.C.DEFAULT_SETTINGS;
  const KEY = 'settings';

  function area() {
    const storage = typeof chrome !== 'undefined' && chrome.storage;
    if (!storage) return null;
    return storage.sync || storage.local;
  }

  function clean(raw) {
    const out = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] === undefined || raw[key] === null) continue;
      const fallback = DEFAULTS[key];
      if (typeof fallback === 'number') {
        const value = Number(raw[key]);
        if (Number.isFinite(value)) out[key] = Math.max(0, Math.min(100000, value));
      } else if (typeof fallback === 'boolean') {
        out[key] = Boolean(raw[key]);
      } else {
        out[key] = String(raw[key]);
      }
    }
    out.jpgQuality = Math.max(5, Math.min(100, out.jpgQuality));
    return out;
  }

  async function get() {
    const storage = area();
    if (!storage) return Object.assign({}, DEFAULTS);
    try {
      const stored = await storage.get(KEY);
      return clean(stored && stored[KEY]);
    } catch (_) {
      return Object.assign({}, DEFAULTS);
    }
  }

  // Writes are serialised: two toggles flipped in the same tick would otherwise
  // both read the pre-change value and the second would undo the first.
  let writeChain = Promise.resolve();

  function set(patch) {
    const run = async () => {
      const storage = area();
      const current = await get();
      const next = clean(Object.assign({}, current, patch));
      if (storage) {
        try {
          await storage.set({ [KEY]: next });
        } catch (_) { /* quota or sync unavailable — keep the in-memory values */ }
      }
      return next;
    };
    const result = writeChain.then(run, run);
    writeChain = result.catch(() => {});
    return result;
  }

  async function reset() {
    const storage = area();
    if (storage) {
      try {
        await storage.set({ [KEY]: Object.assign({}, DEFAULTS) });
      } catch (_) { /* ignore */ }
    }
    return Object.assign({}, DEFAULTS);
  }

  function onChange(callback) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return () => {};
    const listener = (changes, areaName) => {
      const expected = chrome.storage.sync ? 'sync' : 'local';
      if (areaName !== expected) return;
      if (!changes[KEY]) return;
      callback(clean(changes[KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  IMGDL.settings = { DEFAULTS, clean, get, onChange, reset, set, KEY };
})(typeof self !== 'undefined' ? self : globalThis);
