# Image Downloader

**Find every image on a webpage, automatically group duplicates, and download the highest-quality original.**

A Manifest V3 Chrome extension. No account, no backend, no analytics, no remote code — every byte
of processing happens in your browser.

---

## What makes it different

Most image extensions dump every `<img src>` into a list. This one recognises that a single
picture is usually served at four or five different sizes:

```
image-150x150.jpg
image-400x400.jpg
image-1200x1200.jpg
image-2400x2400.jpg
```

…and collapses them into **one card** that reports `4 versions found`, shows `2400 × 2400`, and
downloads `image-2400x2400.jpg` when you press Download.

It never invents URLs. Every candidate comes from something the page or the browser already
knows: markup, `srcset`, `<picture>`, lazy-load attributes, linked originals, CSS backgrounds,
Open Graph tags, inline SVG, resizing-proxy URLs, and the resource-timing log of what actually
loaded.

---

## Install (unpacked)

1. `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this folder
4. Click the toolbar icon on any page — the side panel opens and scans immediately

Requires Chrome 116+ (`chrome.sidePanel.open`).

To build a Web Store package: `npm run package` → `dist/image-downloader-2.0.0.zip`
(contains only `manifest.json`, `src/` and `icons/`).

---

## How "best quality" is decided

One shared, deterministic, side-effect-free function — `getBestCandidate(imageGroup)` in
[`src/utils/duplicate-detector.js`](src/utils/duplicate-detector.js) — is used by the side panel,
the context menu and the tests, so they can never disagree.

Candidates are compared on, in order:

| # | Criterion | Why |
|---|-----------|-----|
| 1 | not a placeholder | a measured 1×1 blur-up GIF must not outrank the photo it stands in for |
| 2 | **pixel area (width × height)** | the primary metric |
| 3 | originality of the URL | `/original/photo.jpg` beats `photo.jpg?w=1200` at equal size |
| 4 | dimension confidence | measured beats inferred |
| 5 | file size | at equal pixels, more bytes means less compression |
| 6 | format rank | `svg` > `png` > `avif` > `webp` > `jpg` > `gif` |
| 7 | URL length, then URL | pure tie-breakers, so the result is fully deterministic |

**Dimensions** come from three places, tracked with a confidence level:

- `naturalWidth/naturalHeight` of an image the browser has loaded (confidence 3)
- a size the URL itself states — `-1024x768`, `?w=800&h=600`, `/w_1600,h_900/`, `1600w` in a
  `srcset` (confidence 2)
- one known dimension completed using the group's aspect ratio (confidence 1)

That last rule is what makes the feature work. A page typically renders the 600px thumbnail and
only *mentions* the 2400px original in a `srcset`. Because every variant of one picture shares an
aspect ratio, a `2400w` descriptor can be compared against a measured 600×600 on equal terms —
and wins. A candidate with **no** size evidence at all scores an area of 0 and can never beat one
with real dimensions, exactly as the spec requires.

Sizes still unknown after all that are measured on demand: when a card scrolls into view, the
content script loads that one URL in the page context and reports `naturalWidth`. Only visible
cards, capped at 4 concurrent loads.

---

## How duplicates are grouped

Two candidates join the same group when **either** holds:

1. **Their identity keys match.** The key is the URL with everything that describes a
   *rendering* rather than an *identity* stripped out: resize query parameters, cache busters and
   signed-URL noise, CDN transform path segments (Cloudinary `w_800,h_600`, Cloudflare
   `/cdn-cgi/image/…`, Thumbor `/fit-in/300x300/`), filename size suffixes (`-1024x768`, `-800w`,
   `@2x`, `-scaled`, `_large`), `www.` and numbered CDN shards, and the file extension (so
   `photo.jpg` and `photo.webp` group).

2. **They were found on the same DOM element.** `src` + `data-src` + every `srcset` entry + the
   `<a href>` wrapping the thumbnail all describe one picture.

### Guardrails against wrong merges

Over-merging is worse than under-merging, so:

- Query parameters that aren't on the known "resize/cache" list are **preserved** — `?id=1` and
  `?id=2` stay apart.
- A filename with no information of its own (`1.jpg`, `image.png`) **keeps its extension** as a
  discriminator.
- A bare trailing number (`product-2400.jpg`) is far too weak to group on by itself, so a
  numeric family is only merged when the numbers behave like a size ladder: at least two of
  them, the largest ≥ 1.5× the smallest, measured aspect ratios in agreement, and either a
  number that matches a measured dimension or a long (3+) or steep (2×) ladder.
  This is what makes `product-200 … product-2400` collapse while `DSC_1234`, `DSC_1235`,
  `DSC_1236` correctly stay three separate photos.
- Years are never read as dimensions (`holiday-2019.jpg` ≠ `holiday-2020.jpg`).

If a page still gets it wrong, **Group duplicates** can be switched off in the filter panel.

---

## Permissions

The extension ships with the smallest set that works:

| Permission | Used for |
|---|---|
| `activeTab` | keeps the click path working if a user narrows site access in Chrome |
| `scripting` | inject the scanner into that tab on demand |
| `sidePanel` | the main UI |
| `downloads` | save files |
| `contextMenus` | the right-click menu |
| `storage` | your settings |

Plus one host permission, declared **optional** and never granted at install:

```json
"optional_host_permissions": ["http://*/*", "https://*/*"]
```

Installing grants **no** site access. The extension reads a page only after you click its toolbar
icon, and that access is revoked again the moment the tab navigates.

Because that makes the side panel go blank as you browse, the panel offers exactly one opt-in: a
**"Scan every page automatically"** button in its empty state, which calls
`chrome.permissions.request` for the pattern above. It buys three things:

- **the panel following you**, instead of emptying on every navigation and tab switch
- **reading image bytes**, which conversion and ZIP need, and which lets the extension confirm
  that an "original" really is the format its URL claims — CDNs routinely serve AVIF from a
  `.jpg` path
- nothing else. Pages are read only while the side panel is open. There is no background
  scanning and no registered content script.

Declaring it optional rather than required is deliberate: the install prompt stays clean, and an
update cannot force-disable existing users the way a new *required* host permission does.

Exactly one call site may prompt (`grantAllSites` in the side panel), it always requests the same
declared pattern, and neither the service worker nor the options page ever prompts — all asserted
by the test suite. It is scoped to `http`/`https` rather than `<all_urls>`, so `file://` and other
schemes are excluded.

With nothing granted the extension is fully functional: `chrome.downloads` fetches URLs itself, so
originals download without the extension ever reading their bytes. Byte-dependent features degrade
in order — the panel checks `chrome.permissions.contains` per origin, falls back to asking the
page, then to a plain URL download.

---

## Architecture

```
image-downloader/
├── manifest.json                  MV3, service worker, no host permissions
├── icons/                         generated by tools/make-icons.mjs
└── src/
    ├── background/service-worker.js   action, side panel, context menu, per-tab cache, injection
    ├── content/
    │   ├── scanner.js                 image discovery, measuring, byte access
    │   ├── picker.js                  Pick Mode overlay (self-cleaning)
    │   └── content-script.js          messaging + debounced MutationObserver
    ├── sidepanel/                     the UI: group → filter → sort → render → download
    ├── options/                       persistent settings + the optional permission toggle
    └── utils/
        ├── constants.js               message types, defaults, limits
        ├── image-normalizer.js        formats, srcset, CSS urls, size hints, proxies, identity keys
        ├── duplicate-detector.js      grouping + getBestCandidate  ← the heart of the product
        ├── filenames.js               sanitising, original + smart names
        ├── downloader.js              download planning + execution with fallback
        ├── converter.js               canvas conversion (WebP/PNG/JPG/AVIF→…)
        ├── zip.js                     dependency-free ZIP writer
        └── settings.js                chrome.storage wrapper
```

**No bundler and no remote code.** Every file is a classic script that attaches itself to a single
`IMGDL` namespace, which lets the *same* file be loaded by all three worlds:

- service worker → `importScripts('/src/utils/…')`
- extension pages → `<script src="../utils/…">`
- content scripts → `chrome.scripting.executeScript({ files: [...] })`

So the grouping and ranking rules exist in exactly one place, and the tests exercise the same
bytes that ship.

### Data flow

```
content script            service worker              side panel
─────────────             ──────────────              ──────────
scan / observe   ──────►  cache per tab      ──────►  group → filter → sort → render
measure on demand ◄─────  route messages     ◄──────  request scan / measure / bytes
fetch bytes (page origin)                             convert · zip · chrome.downloads
```

The content script only ever emits **raw candidates**. All grouping happens in the panel, so
toggling *Group duplicates* is instant and never needs a rescan.

### Performance

- `document.images` is read directly (complete and cheap even at 10 000 nodes); the full element
  walk for CSS backgrounds is chunked with a 900 ms budget and yields to `requestIdleCallback`.
- Light scans only inspect computed styles of elements never seen before; the **Rescan** button
  does a deep pass.
- `MutationObserver` is debounced to 350 ms with a 1.4 s ceiling, filtered to relevant attributes.
- Cards render 60 at a time, thumbnails load through an `IntersectionObserver`, and the
  **smallest** variant in a group is used for the thumbnail while the largest is downloaded.
- Hard caps: 6 000 candidates, 20 000 elements walked, 4 concurrent measures, 4 concurrent
  downloads.

---

## Testing

```bash
npm test
```

122 assertions covering the pure logic with no Chrome required — format detection, `srcset`
parsing, CSS URL extraction, dimension hints, proxy unwrapping, identity keys (both the merges
that must happen and the ones that must not), `getBestCandidate` ordering and determinism, the
spec's acceptance test, filenames, download planning, the ZIP writer's CRC and structure, and
settings coercion.

There is also a browser harness that runs the **real** panel and the **real** scanner:

```bash
npm run preview     # http://localhost:5599
```

- `/test/preview/index.html` — the actual side panel against a mocked Chrome API and a
  synthetic page of 23 candidates. Used to verify grouping counts, filters, search, selection,
  the versions sheet, and all three download paths (direct URL, canvas conversion, ZIP).
- `/test/preview/scan-test.html` — a page containing every discovery source, with 25 assertions
  run against `src/content/scanner.js` in a real DOM.

The ZIP writer's output has additionally been verified by opening it with .NET's
`System.IO.Compression.ZipArchive` (nested paths, UTF-8 filenames, timestamps, content).

---

## Deliberate deviations from the spec

- **Download options are a persistent "Options" sheet next to the download button**, rather than
  a menu that interrupts every download. The spec's own summary flow is "user clicks Download →
  done", and defaults (original format, original filenames) are the common case; forcing a
  second click on every batch would work against that.
- **`getBestCandidate` treats a URL-stated size as a real dimension**, not an unknown. The spec
  says candidates with unknown dimensions must not beat known large images — that still holds
  exactly, for candidates with no size evidence of any kind. Without this, the killer feature
  could not work, since the largest variant is usually the one the browser never loaded.
- **A store-method (uncompressed) ZIP.** Images are already compressed; deflate would cost CPU
  for roughly nothing. Archives above 4 GB are rejected with a clear message rather than
  silently producing a corrupt file.

## Not built (per spec §28)

No accounts, cloud storage, subscriptions, AI APIs, image editing, screenshots, reverse image
search, social integrations, onboarding or telemetry.

---

## Privacy

Private by design — images never leave your browser. Page URLs, image URLs, image contents and
browsing history are never transmitted anywhere. There is no network code in this extension other
than fetching image bytes from the site you are already on, and only when you ask it to convert
or zip them.
