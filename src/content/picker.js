/**
 * Pick Mode: an element-inspector for images.
 *
 * Everything it injects (one overlay node, one <style>, a handful of capturing
 * listeners) is removed again by stop(), so the page is left exactly as found.
 */
(function (global) {
  'use strict';
  const IMGDL = (global.IMGDL = global.IMGDL || {});
  if (IMGDL.picker) return;
  const N = IMGDL.normalizer;
  const C = IMGDL.C;

  const STYLE_ID = 'imgdl-picker-style';
  const CURSOR_CLASS = 'imgdl-picking';

  const state = {
    active: false,
    overlay: null,
    label: null,
    styleEl: null,
    target: null,
    picked: new Set(),
    onPick: null,
    onEnd: null,
    raf: 0,
    pointer: { x: 0, y: 0 }
  };

  const CSS = `
.${CURSOR_CLASS}, .${CURSOR_CLASS} * { cursor: crosshair !important; }
#imgdl-picker-overlay {
  position: fixed; inset: 0 auto auto 0; z-index: 2147483647; pointer-events: none;
  border: 2px solid #3b82f6; border-radius: 4px; box-sizing: border-box;
  background: rgba(59,130,246,.14); box-shadow: 0 0 0 9999px rgba(15,23,42,.18);
  transition: transform .06s linear, width .06s linear, height .06s linear;
  will-change: transform, width, height; display: none;
}
#imgdl-picker-overlay[data-picked="1"] { border-color: #10b981; background: rgba(16,185,129,.16); }
#imgdl-picker-label {
  position: absolute; left: 0; top: -26px; white-space: nowrap;
  font: 600 11px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #fff; background: #3b82f6; padding: 5px 7px; border-radius: 4px;
  letter-spacing: .01em; box-shadow: 0 1px 3px rgba(0,0,0,.35);
}
#imgdl-picker-overlay[data-picked="1"] #imgdl-picker-label { background: #10b981; }
#imgdl-picker-hint {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  z-index: 2147483647; pointer-events: none;
  font: 500 12px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #fff; background: rgba(15,23,42,.92); padding: 8px 14px; border-radius: 999px;
  box-shadow: 0 4px 16px rgba(0,0,0,.3);
}`;

  /* ------------------------------------------------------------------ */

  function ensureDom() {
    if (state.overlay) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.documentElement.appendChild(style);
    state.styleEl = style;

    const overlay = document.createElement('div');
    overlay.id = 'imgdl-picker-overlay';
    const label = document.createElement('div');
    label.id = 'imgdl-picker-label';
    overlay.appendChild(label);
    document.documentElement.appendChild(overlay);

    const hint = document.createElement('div');
    hint.id = 'imgdl-picker-hint';
    hint.textContent = 'Click images to select · Esc to exit';
    document.documentElement.appendChild(hint);

    state.overlay = overlay;
    state.label = label;
    state.hint = hint;
    document.documentElement.classList.add(CURSOR_CLASS);
  }

  function teardownDom() {
    document.documentElement.classList.remove(CURSOR_CLASS);
    for (const node of [state.overlay, state.styleEl, state.hint]) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    state.overlay = state.label = state.styleEl = state.hint = null;
  }

  /* ------------------------------------------------------------------ */

  /** Resolve the pointer position to an image-bearing element. */
  function imageAt(x, y) {
    const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
    for (const element of stack) {
      if (!element || element === state.overlay || element === state.hint) continue;
      const found = describe(element);
      if (found) return found;
    }
    return null;
  }

  function describe(element) {
    if (!element || !element.tagName) return null;
    const tag = element.tagName;

    if (tag === 'IMG') {
      const url = element.currentSrc || element.getAttribute('src') || '';
      const absolute = N.absoluteUrl(url, document.baseURI);
      if (!absolute) return null;
      return {
        element,
        url: absolute,
        width: element.naturalWidth || Math.round(element.getBoundingClientRect().width),
        height: element.naturalHeight || Math.round(element.getBoundingClientRect().height),
        alt: element.getAttribute('alt') || ''
      };
    }

    if (tag === 'svg' && !element.ownerSVGElement) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16) return null;
      return { element, url: '', inlineSvg: true, width: Math.round(rect.width), height: Math.round(rect.height), alt: '' };
    }

    let style;
    try {
      style = getComputedStyle(element);
    } catch (_) {
      return null;
    }
    const urls = N.extractCssUrls(style && style.backgroundImage);
    if (urls.length) {
      const absolute = N.absoluteUrl(urls[urls.length - 1], document.baseURI);
      if (!absolute) return null;
      const rect = element.getBoundingClientRect();
      return { element, url: absolute, width: Math.round(rect.width), height: Math.round(rect.height), alt: '', background: true };
    }
    return null;
  }

  function paint() {
    state.raf = 0;
    const found = imageAt(state.pointer.x, state.pointer.y);
    if (!found) {
      state.target = null;
      if (state.overlay) state.overlay.style.display = 'none';
      return;
    }
    state.target = found;
    const rect = found.element.getBoundingClientRect();
    const overlay = state.overlay;
    overlay.style.display = 'block';
    overlay.style.width = Math.max(rect.width, 4) + 'px';
    overlay.style.height = Math.max(rect.height, 4) + 'px';
    overlay.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
    const identity = found.url || 'inline-svg';
    const isPicked = state.picked.has(identity);
    overlay.setAttribute('data-picked', isPicked ? '1' : '0');
    const size = found.width && found.height ? `${found.width} × ${found.height}` : 'unknown size';
    state.label.textContent = (isPicked ? '✓ Selected · ' : '') + size;
    state.label.style.top = rect.top < 30 ? '4px' : '-26px';
  }

  function schedulePaint() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(paint);
  }

  /* ------------------------------------------------------------------ */

  function onPointerMove(event) {
    state.pointer.x = event.clientX;
    state.pointer.y = event.clientY;
    schedulePaint();
  }

  function onScroll() { schedulePaint(); }

  function onClick(event) {
    if (!state.target) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();

    const found = state.target;
    let url = found.url;

    if (found.inlineSvg) {
      const order = 4000000;
      IMGDL.scanner && IMGDL.scanner.add({
        url: serializeSvg(found.element),
        source: C.SOURCE.SVG_INLINE,
        nodeKey: IMGDL.scanner.nodeKeyFor(found.element),
        width: found.width,
        height: found.height,
        domOrder: order,
        svgSource: 'inline'
      });
      url = serializeSvg(found.element);
    }
    if (!url) return;

    const wasPicked = state.picked.has(url);
    if (wasPicked) state.picked.delete(url);
    else state.picked.add(url);

    // Make sure the panel knows about this image even if the scanner missed it.
    if (IMGDL.scanner && !found.inlineSvg) {
      IMGDL.scanner.add({
        url,
        source: C.SOURCE.PICKED,
        nodeKey: IMGDL.scanner.nodeKeyFor(found.element),
        width: found.width || 0,
        height: found.height || 0,
        alt: found.alt || '',
        domOrder: 4000000
      });
    }

    if (state.onPick) state.onPick({ url, selected: !wasPicked, width: found.width, height: found.height });
    schedulePaint();
  }

  function serializeSvg(svg) {
    try {
      let markup = new XMLSerializer().serializeToString(svg);
      if (!/\sxmlns=/.test(markup)) {
        markup = markup.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    } catch (_) {
      return '';
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stop('escape');
    }
  }

  function onBlockedEvent(event) {
    // Stop the page reacting to the pointer while picking.
    if (event.type === 'mousedown' || event.type === 'mouseup' || event.type === 'auxclick') {
      if (state.target) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  }

  const LISTENERS = [
    ['mousemove', onPointerMove, true],
    ['mouseover', onPointerMove, true],
    ['scroll', onScroll, true],
    ['click', onClick, true],
    ['mousedown', onBlockedEvent, true],
    ['mouseup', onBlockedEvent, true],
    ['auxclick', onBlockedEvent, true],
    ['keydown', onKeyDown, true]
  ];

  function start(options) {
    if (state.active) return;
    state.active = true;
    state.onPick = (options && options.onPick) || null;
    state.onEnd = (options && options.onEnd) || null;
    state.picked = new Set((options && options.selected) || []);
    ensureDom();
    for (const [type, handler, capture] of LISTENERS) {
      window.addEventListener(type, handler, capture);
    }
    window.addEventListener('resize', onScroll, true);
    schedulePaint();
  }

  function stop(reason) {
    if (!state.active) return;
    state.active = false;
    for (const [type, handler, capture] of LISTENERS) {
      window.removeEventListener(type, handler, capture);
    }
    window.removeEventListener('resize', onScroll, true);
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.target = null;
    teardownDom();
    const callback = state.onEnd;
    state.onEnd = state.onPick = null;
    if (callback) callback(reason || 'stopped');
  }

  IMGDL.picker = { start, stop, isActive: () => state.active, state };
})(typeof self !== 'undefined' ? self : globalThis);
