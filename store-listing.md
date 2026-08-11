# Chrome Web Store listing copy

Paste-ready text for the dashboard. Not part of the extension package.

---

## Summary (132 char limit, pulled from manifest)

```
Find every image on a page, group duplicate sizes, and download the highest-quality original.
```

Already correct. No change needed.

---

## Description

**Paste everything in the single code block below into the Description field. All
of it, in one go.**

The only part that is temporary is the "WHAT'S NEW IN 2.0" section at the top. It
exists because this is an update to a published item and returning users deserve to
know the interface changed. Delete just that section in a few weeks; everything
below it is permanent.

(Existing users are NOT force-disabled by this update, because the new site access
is optional rather than required. That is why the block says nothing about
re-approving permissions.)

```
WHAT'S NEW IN 2.0

Version 2 is a complete rebuild. The old right-click menu is still there, but the
main interface is now a side panel that opens beside the page you are viewing.

Nothing changes about what the extension can access until you choose otherwise.
It still reads a page only when you click its icon. If you want the panel to keep
up as you browse, there is a one-time button inside it that asks for access to all
sites. It is optional and the extension works fully without it.


Image Downloader finds every image on a page, groups the different sizes of the same
picture together, and downloads the highest-quality original.

Most image downloaders dump every image tag into a list, so you end up saving the
150-pixel thumbnail while the 2400-pixel original sits right there in the page source.
This one looks at every version a page offers and picks the best one for you.


HOW IT WORKS

Click the toolbar icon and a side panel opens beside the page. It scans automatically
and shows every image as a thumbnail grid with real dimensions, format and file size.
Keep scrolling and clicking around; the panel stays open and keeps up with you.

When a page serves the same picture at four sizes:

    product-200.jpg
    product-600.jpg
    product-1200.jpg
    product-2400.jpg

you get one card that reads "4 versions found, 2400 x 2400" instead of four confusing
entries. Press Download and you get product-2400.jpg.


WHAT IT FINDS

Ordinary images, responsive srcset and picture sources, lazy-loaded images, CSS
background images, inline SVG, the full-size original linked behind a thumbnail, Open
Graph images, and images added to the page after it finished loading.


FEATURES

- Automatic duplicate grouping with best-version detection
- Live grid that updates as a page loads more images, plus a manual Rescan
- Search by filename, URL, domain or alt text
- Filter by minimum width and height, format, orientation, and type
- Sort by largest, smallest, file size or page order
- Multi-select, select all, invert, and shift-click ranges
- Pick Mode: click images directly on the page to select them
- Right-click menu: download image, download best quality, download as JPG or PNG
- Optional conversion to JPG, PNG or WebP, done locally on your own machine
- Optional ZIP download for a whole batch, packaged in your browser
- Smart filenames built from alt text and page context
- Honest file extensions: if a .jpg address actually serves AVIF, you get a .avif file
- Tracking pixels, spacers and tiny icons hidden by default
- Light and dark mode


PERMISSIONS, IN PLAIN ENGLISH

Installing asks for no access to your websites at all. Image Downloader reads a page
only after you click its toolbar icon, using Chrome's activeTab permission.

That access ends whenever you navigate or switch tabs, so the panel offers a one-time
"Scan every page automatically" button. Accepting it grants access to all sites, which
is used for exactly three things:

1. Keeping the side panel working as you switch tabs and follow links, instead of it
   going blank every time you click something.
2. Converting an image, or packaging a batch into a ZIP, which means reading the
   image data.
3. Checking what an image really is by reading its first few bytes, so files are
   saved with the extension that matches their actual contents.

Declining it stops nothing from working. Pages are read only
while the side panel is open. There is no background scanning and no content script
running on sites you are not actively using.

To undo it, right-click the extension icon and choose "This can read and change site
data".


PRIVACY

Everything happens inside your browser. No account, no sign-in, no analytics, no
tracking, no external servers, no remote code. Page addresses, image addresses and
image data are never transmitted anywhere. Conversion and ZIP packaging run locally
using your browser's own image support.
```

---

## Privacy tab (required before you can submit)

### Single purpose

```
Image Downloader lets a user find the images on the web page they are viewing and save
them to their computer, choosing the highest-resolution version of each image.
```

### Permission justifications

**activeTab**
```
Used to read the current page when the user opens the extension from the toolbar icon.
This is the fallback path for users who restrict the extension's site access in Chrome,
so it keeps working on a per-click basis.
```

**optional host permissions (http://*/*, https://*/*)**
```
This is declared as an optional host permission. It is not granted at install and is
never requested automatically. The side panel shows a single "Scan every page
automatically" button which the user may accept or ignore, and the extension is fully
functional without it.

When granted it is used for three things. First, the side panel continues reading the
page as the user switches tabs and navigates, instead of being empty on every new page,
because activeTab is revoked on navigation. Second, converting an image to JPG/PNG/WebP
and packaging images into a ZIP both require reading the image data, which is a
cross-origin read because images are usually served from a CDN. Third, the extension
reads the first bytes of an image to detect its real format, so a file served as AVIF
from a .jpg address is saved with the correct extension.

Pages are read only while the side panel is open. There is no background scanning and
no registered content script. No data leaves the browser.
```

**scripting**
```
Used to inject the image-scanning content script into the page the user is viewing when
the side panel is open. No script is registered to run in the background.
```

**downloads**
```
Used to save the selected images to the user's computer via chrome.downloads.
```

**contextMenus**
```
Used to add a right-click menu on images with four actions: download image, download
best quality, download as JPG, download as PNG.
```

**sidePanel**
```
The extension's entire user interface is a side panel.
```

**storage**
```
Used to remember the user's own preferences: minimum image size, grouping and filter
toggles, sort order, output format, quality, filename style and download folder. No
browsing data is stored.
```

### Test instructions

The dashboard scopes this field to login, authentication and required setup. This
extension has none, so it is optional. Filling it anyway costs nothing and points
the reviewer straight at the one flow that is easy to miss. The detailed rationale
already lives in the permission justifications above, so keep this short.

```
No login, authentication, test account or setup is required. The extension is
fully functional immediately after installation and no feature is gated behind
an account.

Core flow: open any image-heavy page, click the Image Downloader toolbar icon,
and the side panel lists the images found. Cards labelled "N versions" are
grouped duplicates; clicking that link shows every size the page offers for that
one picture, with the chosen one marked "Best".

One flow is easy to miss. The extension has no host access at install and reads a
page only after its toolbar icon is clicked. The optional "Scan every page
automatically" button, which is the only place in the codebase that calls
chrome.permissions.request, appears in the side panel when you open the panel and
then switch to a tab you have not clicked the icon on. Declining it leaves the
extension fully functional.

The full source for this version is public:
https://github.com/mulukenermiasdata-boop/image-downloader
```

### Remote code

```
No, I am not using remote code.
```

Every file that runs is bundled in the package. There is no eval, no remotely hosted
script, no CDN, and the extension declares a strict CSP of `script-src 'self'`.

### Data usage

Tick nothing. Then confirm all three declarations:

- Not being sold to third parties
- Not being used or transferred for purposes unrelated to the single purpose
- Not being used or transferred to determine creditworthiness or for lending

---

## Promo video (YouTube)

### Title

```
Image Downloader for Chrome: Find Every Image, Save the Best
```

Alternates:

```
Stop Saving Thumbnails: Image Downloader for Chrome
Image Downloader for Chrome: Get the Full-Size Original
```

Keep the extension name in the title. People searching the store name are the
audience most likely to install.

### Description

```
Most image downloaders hand you the 150-pixel thumbnail while the 2400-pixel
original is sitting right there in the page. Image Downloader finds every
version a page offers and saves the best one.

Click the toolbar icon and a side panel opens beside the page. It scans
automatically and shows every image with its real dimensions, format and file
size. When a page serves the same picture at four sizes, you get one card that
reads "4 versions found, 2400 x 2400" instead of four confusing entries. Press
Download and you get the 2400 pixel file.

WHAT IT FINDS
- Ordinary images, responsive srcset and picture sources
- Lazy-loaded images and CSS background images
- Inline SVG, and the full-size original linked behind a thumbnail
- Open Graph images, and images added after the page finished loading
- JPG, PNG, WebP, AVIF, GIF and SVG

ALSO INCLUDED
- Search and filter by size, format, orientation and type
- Multi-select, select all, invert selection
- Pick Mode: click images directly on the page to select them
- Right-click menu, including "Download best quality"
- Optional conversion to JPG, PNG or WebP, done locally on your machine
- Optional ZIP download for a whole batch
- Honest file extensions: a .jpg address serving AVIF is saved as .avif

Everything runs inside your browser. No account, no analytics, no servers and
no remote code. Image data never leaves your machine.

Install free from the Chrome Web Store:
[STORE LINK]

CHAPTERS
0:00 The problem with image downloaders
0:00 Scanning a page
0:00 Grouped versions and best quality
0:00 Filters, search and Pick Mode
0:00 Downloading
```

Fill in the chapter timestamps once the video is cut, or delete the chapter
block. YouTube only renders chapters if the first one is 0:00 and there are at
least three of them.

### Tags

```
image downloader, chrome extension, download images, save images, bulk image
download, full size images, webp, avif, image grabber
```

### Notes

- Keep it under 60 seconds. Store visitors are deciding, not learning.
- The video must show this extension actually running. A video of something
  else is a listing mismatch and a rejection risk.
- Set it to Public or Unlisted. Private videos will not play on the listing.
- No music with a copyright claim, or the video can be blocked in some regions
  and the listing embed breaks.

---

## Asset checklist

| Asset | Status | Spec |
|---|---|---|
| Store icon | **replace** with the new `icons/icon128.png` | 128x128, artwork inset ~16px |
| Screenshot | **REQUIRED, missing** | 1280x800 or 640x400, 24-bit PNG (no alpha) or JPEG |
| Small promo tile | optional | 440x280 |
| Marquee promo tile | optional, needed for featuring | 1400x560 |
| Promo video | present | must show this extension actually running |
| Support URL | empty | strongly recommended |

### Screenshot notes

The screen recording is not usable as-is. It shows a username, an account credit
balance, around forty open tabs and a "Finish update" button. Capture fresh in a clean
Chrome profile with only this extension installed, on a neutral image-heavy page.

Good shots, in order of value:

1. The side panel next to a gallery, showing a card with the "Best" badge and
   "4 versions found". That is the whole product in one image.
2. The filter panel open, showing size and format controls.
3. The versions sheet for one image, listing every size found.
4. Pick Mode active, with the blue outline over an image on the page.
5. The download options sheet.

Export as PNG, then flatten to 24-bit (no alpha) or the upload is rejected.
