/**
 * MV3 service worker.
 *
 * Owns: the toolbar action, the side-panel lifecycle, the context menu,
 * on-demand content-script injection, and a per-tab cache of discovered
 * candidates so reopening the panel is instant.
 */
importScripts(
  '/src/utils/constants.js',
  '/src/utils/image-normalizer.js',
  '/src/utils/duplicate-detector.js',
  '/src/utils/filenames.js',
  '/src/utils/settings.js',
  '/src/utils/converter.js',
  '/src/utils/downloader.js'
);

const { C, normalizer: N, dedupe: D, filenames: F, downloader: DL, converter: CV, settings: S } = self.IMGDL;
const MSG = C.MSG;

const CONTENT_FILES = [
  'src/utils/constants.js',
  'src/utils/image-normalizer.js',
  'src/content/scanner.js',
  'src/content/picker.js',
  'src/content/content-script.js'
];

const AUTO_SCRIPT_ID = 'imgdl-auto';

/** tabId -> { pageUrl, pageTitle, candidates: Map<url, candidate>, updatedAt, truncated } */
const tabState = new Map();
let panelPorts = 0;

/* ------------------------------------------------------------------ *
 * Tab cache
 * ------------------------------------------------------------------ */

function stateFor(tabId) {
  let entry = tabState.get(tabId);
  if (!entry) {
    entry = { pageUrl: '', pageTitle: '', candidates: new Map(), updatedAt: 0, truncated: false };
    tabState.set(tabId, entry);
  }
  return entry;
}

function ingest(tabId, payload, frameId) {
  const entry = stateFor(tabId);
  // Only the top frame is allowed to reset the list; subframes only add.
  if (payload.full && !frameId) entry.candidates.clear();
  for (const candidate of payload.candidates || []) {
    const existing = entry.candidates.get(candidate.url);
    if (!existing) {
      entry.candidates.set(candidate.url, candidate);
      continue;
    }
    for (const key of Object.keys(candidate)) {
      const value = candidate[key];
      if (typeof value === 'number') {
        if (value > (existing[key] || 0)) existing[key] = value;
      } else if (value && !existing[key]) {
        existing[key] = value;
      }
    }
  }
  if (!frameId) {
    if (payload.pageUrl) entry.pageUrl = payload.pageUrl;
    if (payload.pageTitle != null) entry.pageTitle = payload.pageTitle;
  }
  entry.truncated = entry.truncated || Boolean(payload.truncated);
  entry.updatedAt = Date.now();
  return entry;
}

function snapshotFor(tabId) {
  const entry = tabState.get(tabId);
  if (!entry) return null;
  return {
    candidates: Array.from(entry.candidates.values()),
    pageUrl: entry.pageUrl,
    pageTitle: entry.pageTitle,
    truncated: entry.truncated,
    updatedAt: entry.updatedAt,
    full: true
  };
}

chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabState.delete(tabId);
    broadcast({ type: MSG.TAB_CHANGED, tabId, reason: 'navigated' });
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  broadcast({ type: MSG.TAB_CHANGED, tabId, reason: 'activated' });
});

function broadcast(message) {
  // Not gated on a live port: after a service-worker restart the panel needs a
  // moment to reconnect, and dropping tab-change events in that window leaves
  // the panel showing the previous tab's images.
  chrome.runtime.sendMessage(message).catch(() => { /* panel not listening */ });
}

/* ------------------------------------------------------------------ *
 * Injection
 * ------------------------------------------------------------------ */

const RESTRICTED = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i;

function isRestricted(url) {
  if (!url) return false;
  if (RESTRICTED.test(url)) return true;
  return /^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/i.test(url);
}

/** Has the user granted this specific image's origin (for reading its bytes)? */
async function hasOriginAccess(url) {
  const pattern = DL.originPattern(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch (_) {
    return false;
  }
}

async function ping(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.PING }, { frameId: 0 });
    return Boolean(response && response.ready);
  } catch (_) {
    return false;
  }
}

/**
 * Make sure the scanner is running in `tabId`.
 * Injection is only possible when the user has invoked the extension for this
 * tab (activeTab) or granted access to all sites.
 */
async function ensureInjected(tabId, options) {
  const opts = options || {};
  if (!opts.force && await ping(tabId)) return { ok: true, injected: false };
  try {
    // Top frame only: activeTab grants access to the tab's own origin, and the
    // extension holds no standing permission for cross-origin frames.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: CONTENT_FILES,
      injectImmediately: true
    });
    return { ok: true, injected: true };
  } catch (error) {
    const message = String((error && error.message) || error);
    return { ok: false, error: message, restricted: isRestrictedFailure(message) };
  }
}

/**
 * Distinguish "Chrome will never let us script this page" from "you just have
 * not invoked the extension on this tab yet".
 *
 * Both produce a message containing "Cannot access" and "Extension manifest",
 * so matching on those alone tells a user on an ordinary page that the page
 * forbids extensions, which is wrong and unactionable. Only a genuinely
 * restricted surface names its scheme in the message, or is the Web Store.
 */
function isRestrictedFailure(message) {
  if (/(chrome|edge|devtools|view-source|chrome-extension|moz-extension|about):(\/\/)?/i.test(message)) return true;
  return /gallery cannot be scripted|showing error page|chrome-untrusted/i.test(message);
}

/**
 * Left over from an earlier build that could register content scripts on every
 * site. v2.0 has no background scanning at all — the scanner only ever runs on
 * a tab the user invoked — so any registration from a previous install is
 * removed on startup.
 */
async function dropLegacyAutoScript() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT_ID] });
  } catch (_) { /* nothing registered, which is the normal case */ }
}

/* ------------------------------------------------------------------ *
 * Toolbar action
 * ------------------------------------------------------------------ */

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  // Must run before any await, or the user gesture is lost.
  const opening = chrome.sidePanel.open({ tabId: tab.id }).catch(() => {
    if (tab.windowId != null) return chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  });
  opening.then(async () => {
    const result = await ensureInjected(tab.id);
    if (result.ok) {
      chrome.tabs.sendMessage(tab.id, { type: MSG.SCAN, deep: true }, { frameId: 0 })
        .then((payload) => { if (payload) ingest(tab.id, payload, 0); })
        .catch(() => {});
    }
    broadcast({ type: MSG.TAB_CHANGED, tabId: tab.id, reason: 'action' });
  });
});

/* ------------------------------------------------------------------ *
 * Context menu
 * ------------------------------------------------------------------ */

const MENU = {
  ROOT: 'imgdl-root',
  IMAGE: 'imgdl-image',
  BEST: 'imgdl-best',
  JPG: 'imgdl-jpg',
  PNG: 'imgdl-png'
};

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({ id: MENU.ROOT, title: 'Image Downloader', contexts: ['image'] });
    chrome.contextMenus.create({ id: MENU.IMAGE, parentId: MENU.ROOT, title: 'Download image', contexts: ['image'] });
    chrome.contextMenus.create({ id: MENU.BEST, parentId: MENU.ROOT, title: 'Download best quality', contexts: ['image'] });
    chrome.contextMenus.create({ id: MENU.JPG, parentId: MENU.ROOT, title: 'Download as JPG', contexts: ['image'] });
    chrome.contextMenus.create({ id: MENU.PNG, parentId: MENU.ROOT, title: 'Download as PNG', contexts: ['image'] });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  dropLegacyAutoScript();
});
chrome.runtime.onStartup.addListener(() => {
  createMenus();
  dropLegacyAutoScript();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch((error) => flashBadge('!', String(error && error.message || error)));
});

async function handleMenuClick(info, tab) {
  const srcUrl = info.srcUrl;
  if (!srcUrl) return;
  const config = await S.get();
  const tabId = tab && tab.id;

  if (info.menuItemId === MENU.IMAGE) {
    await downloadPlain(srcUrl, config, tab);
    return;
  }
  if (info.menuItemId === MENU.BEST) {
    const best = await resolveBest(tabId, srcUrl);
    await downloadPlain(best.url, config, tab, best);
    return;
  }
  if (info.menuItemId === MENU.JPG || info.menuItemId === MENU.PNG) {
    const target = info.menuItemId === MENU.JPG ? 'jpg' : 'png';
    await downloadConverted(tabId, srcUrl, target, config, tab);
  }
}

/** Ask the page for everything it knows about this image and rank it. */
async function resolveBest(tabId, srcUrl) {
  if (tabId != null) {
    const injected = await ensureInjected(tabId);
    if (injected.ok) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: MSG.GET_ALTERNATES, url: srcUrl });
        if (response && response.candidates && response.candidates.length) {
          const groups = D.groupCandidates(response.candidates, { group: true });
          const match = groups.find((group) =>
            group.candidates.some((candidate) => candidate.url === srcUrl)) || groups[0];
          if (match) {
            return { url: match.best.url, group: match, fallbacks: D.rankCandidates(match).map((c) => c.url) };
          }
        }
      } catch (_) { /* fall through to the plain URL */ }
    }
  }
  return { url: srcUrl, group: null, fallbacks: [srcUrl] };
}

async function downloadPlain(url, config, tab, best) {
  const format = N.guessFormat(url);
  const name = config.naming === 'smart'
    ? F.smartFilename({
      url,
      alt: best && best.group && best.group.alt,
      pageTitle: tab && tab.title,
      width: best && best.group && best.group.width,
      height: best && best.group && best.group.height,
      format
    })
    : F.filenameFromUrl(url, format);
  const path = buildPath(name, config, tab);
  await DL.downloadWithFallback({
    url,
    fallbacks: (best && best.fallbacks || []).filter((candidate) => candidate !== url).slice(0, 3),
    path
  });
}

async function downloadConverted(tabId, srcUrl, target, config, tab) {
  const sourceFormat = N.guessFormat(srcUrl);
  if (!CV.needsConversion(sourceFormat, target)) {
    await downloadPlain(srcUrl, config, tab);
    return;
  }
  let bytes;
  try {
    bytes = await readBytes(tabId, srcUrl);
  } catch (error) {
    // Cross-origin images cannot be read without access to that site.
    await downloadPlain(srcUrl, config, tab);
    flashBadge('!', 'Could not read the image bytes to convert it, so the original was downloaded instead. '
      + 'Use the side panel to convert this image — it can ask for access to that image host.');
    return;
  }
  const blob = new Blob([bytes.data], { type: bytes.type || N.mimeForFormat(sourceFormat) });
  const converted = await CV.convertBlob(blob, target, config.jpgQuality);
  const dataUrl = await blobToDataUrl(converted);
  const name = F.ensureExtension(F.filenameFromUrl(srcUrl, sourceFormat), target);
  await DL.downloadOnce({ url: dataUrl, filename: buildPath(name, config, tab), conflictAction: 'uniquify' });
}

function buildPath(name, config, tab) {
  const folders = [];
  if (config.downloadFolder) folders.push(config.downloadFolder);
  if (config.folderPerPage) folders.push(F.folderNameFromPage(tab && tab.title, tab && tab.url));
  return F.joinPath(folders.join('/'), name);
}

/**
 * Read an image's bytes. Prefers the extension context (needs host access);
 * falls back to the page, which works for same-origin and CORS-enabled images.
 */
async function readBytes(tabId, url) {
  if (await hasOriginAccess(url)) {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    return { data: await blob.arrayBuffer(), type: blob.type };
  }
  if (tabId == null) throw new Error('No page to read from.');
  const injected = await ensureInjected(tabId);
  if (!injected.ok) throw new Error(injected.error || 'Cannot access this page.');
  const response = await chrome.tabs.sendMessage(tabId, { type: MSG.FETCH_BYTES, url });
  if (!response || !response.ok) throw new Error((response && response.error) || 'Could not read the image.');
  return { data: base64ToBytes(response.result.base64), type: response.result.type };
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function blobToDataUrl(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
  }
  return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(binary);
}

let badgeTimer = null;
function flashBadge(text, title) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  if (title) chrome.action.setTitle({ title: 'Image Downloader — ' + title });
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Image Downloader' });
  }, 6000);
}

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'imgdl-panel') return;
  panelPorts++;
  port.onDisconnect.addListener(() => { panelPorts = Math.max(0, panelPorts - 1); });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  switch (message.type) {
    case MSG.CANDIDATES: {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) return false;
      ingest(tabId, message.payload || {}, sender.frameId || 0);
      // Forward straight to the panel so updates feel live.
      chrome.runtime.sendMessage({
        type: MSG.CANDIDATES,
        tabId,
        frameId: sender.frameId || 0,
        payload: message.payload
      }).catch(() => {});
      return false;
    }

    case MSG.PICKED:
    case MSG.PICK_ENDED: {
      chrome.runtime.sendMessage({
        type: message.type,
        tabId: sender.tab && sender.tab.id,
        payload: message.payload
      }).catch(() => {});
      return false;
    }

    case MSG.GET_TAB_STATE: {
      getTabState(message.tabId).then(sendResponse);
      return true;
    }

    case MSG.ENSURE_INJECTED: {
      ensureInjected(message.tabId, { force: message.force }).then(sendResponse);
      return true;
    }

    case MSG.OPEN_OPTIONS: {
      chrome.runtime.openOptionsPage();
      return false;
    }

    default:
      return undefined;
  }
});

async function getTabState(requestedTabId) {
  let tabId = requestedTabId;
  let tab = null;
  if (tabId == null) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = active || null;
    tabId = tab && tab.id;
  } else {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (tabId == null) return { ok: false, error: 'no-tab' };

  const url = (tab && tab.url) || '';
  if (url && isRestricted(url)) {
    return { ok: false, tabId, restricted: true, pageUrl: url, pageTitle: (tab && tab.title) || '' };
  }

  const cached = snapshotFor(tabId);
  const injected = await ensureInjected(tabId);
  if (!injected.ok) {
    return {
      ok: Boolean(cached),
      tabId,
      restricted: injected.restricted,
      needsInvoke: !injected.restricted,
      error: injected.error,
      snapshot: cached,
      pageUrl: (cached && cached.pageUrl) || url,
      pageTitle: (cached && cached.pageTitle) || (tab && tab.title) || ''
    };
  }

  if (!cached || !cached.candidates.length) {
    try {
      const payload = await chrome.tabs.sendMessage(tabId, { type: MSG.SCAN, deep: true }, { frameId: 0 });
      if (payload) ingest(tabId, payload, 0);
    } catch (_) { /* page may still be loading; the observer will push later */ }
  }

  const snapshot = snapshotFor(tabId);
  return {
    ok: true,
    tabId,
    snapshot,
    pageUrl: (snapshot && snapshot.pageUrl) || url,
    pageTitle: (snapshot && snapshot.pageTitle) || (tab && tab.title) || ''
  };
}
