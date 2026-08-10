/**
 * Duplicate detection + "which of these is the best version?".
 *
 * Pure functions only — no DOM, no chrome APIs — so the ranking rules can be
 * unit tested (see test/run-tests.mjs).
 */
(function (global) {
  'use strict';
  const IMGDL = (global.IMGDL = global.IMGDL || {});
  if (IMGDL.dedupe) return;
  const C = IMGDL.C;
  const N = IMGDL.normalizer;

  /** A vector image has no fixed pixel count; inside a group it always wins. */
  const VECTOR_AREA = 1e9;

  /* ------------------------------------------------------------------ *
   * Candidate metrics
   * ------------------------------------------------------------------ */

  /**
   * Aspect ratio (w/h) for a group, taken from the most trustworthy member.
   * Variants of one image share a ratio, which lets us compare a measured
   * 300x300 thumbnail against a "2400w" srcset entry on equal terms.
   */
  function groupAspectRatio(candidates) {
    let best = 0;
    let bestArea = 0;
    for (const candidate of candidates) {
      const w = candidate.width | 0;
      const h = candidate.height | 0;
      if (w > 0 && h > 0 && w * h > bestArea) {
        bestArea = w * h;
        best = w / h;
      }
    }
    if (best) return best;
    for (const candidate of candidates) {
      const w = candidate.hintWidth | 0;
      const h = candidate.hintHeight | 0;
      if (w > 0 && h > 0 && w * h > bestArea) {
        bestArea = w * h;
        best = w / h;
      }
    }
    if (best) return best;
    for (const candidate of candidates) {
      const w = candidate.displayWidth | 0;
      const h = candidate.displayHeight | 0;
      if (w > 0 && h > 0 && w * h > bestArea) {
        bestArea = w * h;
        best = w / h;
      }
    }
    return best;
  }

  /**
   * Resolve a candidate's effective pixel dimensions.
   *
   * confidence: 3 measured, 2 both dimensions hinted by the URL/srcset,
   *             1 one dimension known and completed via the group ratio,
   *             0 nothing is known.
   * A confidence of 0 yields area 0, so an unknown candidate can never beat a
   * candidate with real dimensions.
   */
  function effectiveDimensions(candidate, ratio) {
    const mw = candidate.width | 0;
    const mh = candidate.height | 0;
    if (mw > 0 && mh > 0) return { width: mw, height: mh, confidence: 3 };

    const hw = candidate.hintWidth | 0;
    const hh = candidate.hintHeight | 0;
    if (hw > 0 && hh > 0) return { width: hw, height: hh, confidence: 2 };

    const knownW = mw || hw;
    const knownH = mh || hh;
    if (knownW > 0 && ratio > 0) {
      return { width: knownW, height: Math.round(knownW / ratio), confidence: 1 };
    }
    if (knownH > 0 && ratio > 0) {
      return { width: Math.round(knownH * ratio), height: knownH, confidence: 1 };
    }
    if (knownW > 0) return { width: knownW, height: 0, confidence: 1 };
    if (knownH > 0) return { width: 0, height: knownH, confidence: 1 };
    return { width: 0, height: 0, confidence: 0 };
  }

  function formatRank(format) {
    const rank = C.FORMAT_QUALITY_RANK[format || 'unknown'];
    return typeof rank === 'number' ? rank : 0;
  }

  /** Primary score: pixel area. Exposed for tests and for debugging. */
  function scoreCandidate(candidate, ratio) {
    const dims = effectiveDimensions(candidate, ratio || 0);
    if ((candidate.format || N.guessFormat(candidate.url)) === 'svg') {
      return Math.max(dims.width * dims.height, VECTOR_AREA);
    }
    return dims.width * dims.height;
  }

  /**
   * Blur-up placeholders and spacer GIFs have a real, measured size — a tiny
   * one — which would otherwise let them outrank the not-yet-loaded photo they
   * stand in for. They lose to anything else in the group.
   */
  function isPlaceholder(candidate, dims) {
    if (/^data:/i.test(candidate.url || '') && (candidate.url || '').length < 1024) return true;
    return dims.confidence >= 3 && dims.width * dims.height > 0 && dims.width * dims.height <= 144;
  }

  function metricsFor(candidate, ratio, index) {
    const dims = effectiveDimensions(candidate, ratio);
    const format = candidate.format || N.guessFormat(candidate.url);
    const isVector = format === 'svg';
    const area = isVector
      ? Math.max(dims.width * dims.height, VECTOR_AREA)
      : dims.width * dims.height;
    return {
      placeholder: isPlaceholder(candidate, dims) ? 1 : 0,
      area,
      originality: typeof candidate.originality === 'number'
        ? candidate.originality
        : N.originalityScore(candidate.url),
      confidence: dims.confidence,
      bytes: candidate.bytes | 0,
      formatRank: formatRank(format),
      urlLength: (candidate.url || '').length,
      url: candidate.url || '',
      index,
      width: dims.width,
      height: dims.height
    };
  }

  /** Ascending comparator: the smaller result is the better candidate. */
  function compareMetrics(a, b) {
    if (a.placeholder !== b.placeholder) return a.placeholder - b.placeholder;
    if (a.area !== b.area) return b.area - a.area;             // biggest picture
    if (a.originality !== b.originality) return b.originality - a.originality;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.bytes !== b.bytes) return b.bytes - a.bytes;         // heavier = less compressed
    if (a.formatRank !== b.formatRank) return b.formatRank - a.formatRank;
    if (a.urlLength !== b.urlLength) return a.urlLength - b.urlLength;
    if (a.url !== b.url) return a.url < b.url ? -1 : 1;
    return a.index - b.index;
  }

  /**
   * THE shared "best version" rule.
   *
   * @param {{candidates: Array}|Array} imageGroup
   * @returns {Object|null} the winning candidate object (same reference as input)
   */
  function getBestCandidate(imageGroup) {
    const candidates = Array.isArray(imageGroup)
      ? imageGroup
      : (imageGroup && imageGroup.candidates) || [];
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    const ratio = groupAspectRatio(candidates);
    let best = candidates[0];
    let bestMetrics = metricsFor(candidates[0], ratio, 0);
    for (let i = 1; i < candidates.length; i++) {
      const metrics = metricsFor(candidates[i], ratio, i);
      if (compareMetrics(metrics, bestMetrics) < 0) {
        best = candidates[i];
        bestMetrics = metrics;
      }
    }
    return best;
  }

  /** Candidates ordered best-first — used for download fallbacks. */
  function rankCandidates(imageGroup) {
    const candidates = Array.isArray(imageGroup)
      ? imageGroup.slice()
      : ((imageGroup && imageGroup.candidates) || []).slice();
    const ratio = groupAspectRatio(candidates);
    return candidates
      .map((candidate, index) => ({ candidate, metrics: metricsFor(candidate, ratio, index) }))
      .sort((a, b) => compareMetrics(a.metrics, b.metrics))
      .map((entry) => entry.candidate);
  }

  /* ------------------------------------------------------------------ *
   * Grouping
   * ------------------------------------------------------------------ */

  function mergeCandidate(target, extra) {
    if (extra.width > target.width) { target.width = extra.width; target.height = extra.height; }
    if (!target.hintWidth && extra.hintWidth) target.hintWidth = extra.hintWidth;
    if (!target.hintHeight && extra.hintHeight) target.hintHeight = extra.hintHeight;
    if (!target.bytes && extra.bytes) target.bytes = extra.bytes;
    if (!target.alt && extra.alt) target.alt = extra.alt;
    if (!target.title && extra.title) target.title = extra.title;
    if (!target.displayWidth && extra.displayWidth) {
      target.displayWidth = extra.displayWidth;
      target.displayHeight = extra.displayHeight;
    }
    if (extra.domOrder != null && (target.domOrder == null || extra.domOrder < target.domOrder)) {
      target.domOrder = extra.domOrder;
    }
    if (extra.nodeKey && !target.nodeKeys.includes(extra.nodeKey)) target.nodeKeys.push(extra.nodeKey);
    if (Array.isArray(extra.nodeKeys)) {
      for (const key of extra.nodeKeys) if (!target.nodeKeys.includes(key)) target.nodeKeys.push(key);
    }
    if (extra.source && !target.sources.includes(extra.source)) target.sources.push(extra.source);
    if (extra.format && extra.format !== 'unknown') target.format = extra.format;
    if (extra.svgSource && !target.svgSource) target.svgSource = extra.svgSource;
    return target;
  }

  /** Normalise + collapse byte-identical URLs. Always runs, even when grouping is off. */
  function prepareCandidates(rawCandidates) {
    const byUrl = new Map();
    let order = 0;
    for (const raw of rawCandidates || []) {
      if (!raw || !raw.url) continue;
      const url = raw.url;
      const existing = byUrl.get(url);
      const normalized = {
        url,
        source: raw.source || C.SOURCE.IMG,
        sources: [raw.source || C.SOURCE.IMG],
        width: Math.max(0, raw.width | 0),
        height: Math.max(0, raw.height | 0),
        hintWidth: Math.max(0, raw.hintWidth | 0),
        hintHeight: Math.max(0, raw.hintHeight | 0),
        displayWidth: Math.max(0, raw.displayWidth | 0),
        displayHeight: Math.max(0, raw.displayHeight | 0),
        bytes: Math.max(0, raw.bytes | 0),
        alt: raw.alt || '',
        title: raw.title || '',
        nodeKey: raw.nodeKey || '',
        nodeKeys: raw.nodeKey ? [raw.nodeKey] : (raw.nodeKeys || []).slice(),
        domOrder: raw.domOrder != null ? raw.domOrder : order,
        format: raw.format || N.guessFormat(url),
        svgSource: raw.svgSource || '',
        pageUrl: raw.pageUrl || ''
      };
      order++;

      if (!normalized.hintWidth && !normalized.hintHeight) {
        const hint = N.dimensionsFromUrl(url);
        if (hint.confidence) {
          normalized.hintWidth = hint.width;
          normalized.hintHeight = hint.height;
        }
      }
      normalized.identity = N.identityKey(url);
      normalized.originality = N.originalityScore(url);
      const variant = N.numericVariant(url);
      normalized.familyKey = variant ? variant.familyKey : normalized.identity;
      normalized.familyNumber = variant ? variant.number : 0;

      if (existing) mergeCandidate(existing, normalized);
      else byUrl.set(url, normalized);
    }
    return Array.from(byUrl.values());
  }

  /* Union-find over candidate indices. */
  function makeUnionFind(size) {
    const parent = new Array(size);
    for (let i = 0; i < size; i++) parent[i] = i;
    function find(i) {
      let root = i;
      while (parent[root] !== root) root = parent[root];
      while (parent[i] !== root) { const next = parent[i]; parent[i] = root; i = next; }
      return root;
    }
    function union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
    return { find, union };
  }

  /**
   * Group prepared candidates into image groups.
   *
   * Two candidates end up together when either
   *   (a) their identity keys match (same picture, different size/format), or
   *   (b) they were found on the same DOM element (src + data-src + srcset +
   *       the <a> wrapping the thumbnail all describe one picture).
   *
   * @param {Array} rawCandidates
   * @param {{group?: boolean, preferBest?: boolean}} [options]
   *        preferBest:false keeps whatever the page actually rendered instead
   *        of upgrading to the largest variant.
   * @returns {Array} groups
   */
  function groupCandidates(rawCandidates, options) {
    const opts = options || {};
    const grouping = opts.group !== false;
    const candidates = prepareCandidates(rawCandidates);
    if (!candidates.length) return [];

    const uf = makeUnionFind(candidates.length);
    if (grouping) {
      const byIdentity = new Map();
      const byNode = new Map();
      candidates.forEach((candidate, index) => {
        const identity = candidate.identity;
        if (identity) {
          if (byIdentity.has(identity)) uf.union(byIdentity.get(identity), index);
          else byIdentity.set(identity, index);
        }
        for (const nodeKey of candidate.nodeKeys) {
          if (byNode.has(nodeKey)) uf.union(byNode.get(nodeKey), index);
          else byNode.set(nodeKey, index);
        }
      });
      mergeNumericFamilies(candidates, uf);
    }

    const buckets = new Map();
    candidates.forEach((candidate, index) => {
      const root = grouping ? uf.find(index) : index;
      if (!buckets.has(root)) buckets.set(root, []);
      buckets.get(root).push(candidate);
    });

    const groups = [];
    for (const members of buckets.values()) {
      groups.push(buildGroup(members, opts));
    }
    groups.sort((a, b) => a.domOrder - b.domOrder);
    return groups;
  }

  /** The variant the page actually put on screen. */
  function displayedCandidate(members) {
    const withSource = (source) => members.find((member) => (member.sources || []).includes(source));
    return withSource(C.SOURCE.CURRENT_SRC) || withSource(C.SOURCE.IMG) || members[0];
  }

  /**
   * `product-200.jpg` … `product-2400.jpg` are almost certainly one picture,
   * but `DSC_1234.jpg` … `DSC_1236.jpg` are almost certainly three pictures.
   * Both look identical to a filename matcher, so a family is only merged when
   * the numbers behave like a size ladder:
   *
   *   - at least two members with a plausible size number,
   *   - the largest is at least 1.5x the smallest (a size ladder spans sizes,
   *     a burst of camera filenames does not),
   *   - measured aspect ratios agree, and
   *   - either a number matches a measured dimension, or the ladder is long
   *     (3+ steps) or steep (2x+).
   */
  function mergeNumericFamilies(candidates, uf) {
    const families = new Map();
    candidates.forEach((candidate, index) => {
      const key = candidate.familyKey;
      if (!key) return;
      if (!families.has(key)) families.set(key, []);
      families.get(key).push(index);
    });

    for (const indices of families.values()) {
      if (indices.length < 2) continue;
      const numbered = indices.filter((i) => candidates[i].familyNumber > 0);
      if (numbered.length < 2) continue;

      const numbers = numbered.map((i) => candidates[i].familyNumber);
      const distinct = new Set(numbers);
      if (distinct.size < 2) continue;

      const min = Math.min.apply(null, numbers);
      const max = Math.max.apply(null, numbers);
      if (min <= 0 || max / min < 1.5) continue;
      if (!consistentAspectRatio(indices.map((i) => candidates[i]))) continue;

      const numberMatchesMeasurement = numbered.some((i) => {
        const candidate = candidates[i];
        const n = candidate.familyNumber;
        return near(n, candidate.width) || near(n, candidate.height);
      });
      if (!numberMatchesMeasurement && numbered.length < 3 && max / min < 2) continue;

      for (let k = 1; k < indices.length; k++) uf.union(indices[0], indices[k]);
      // The suffix now counts as a width hint, which is what lets an
      // unloaded `-2400` variant outrank the 600px one actually on screen.
      for (const i of numbered) {
        const candidate = candidates[i];
        if (!candidate.width && !candidate.hintWidth) candidate.hintWidth = candidate.familyNumber;
      }
    }
  }

  function near(a, b) {
    if (!a || !b) return false;
    return Math.abs(a - b) <= Math.max(2, a * 0.02);
  }

  function consistentAspectRatio(members) {
    const ratios = members
      .filter((m) => m.width > 0 && m.height > 0)
      .map((m) => m.width / m.height);
    if (ratios.length < 2) return true;
    const min = Math.min.apply(null, ratios);
    const max = Math.max.apply(null, ratios);
    return max / min <= 1.05;
  }

  function buildGroup(members, options) {
    const ratio = groupAspectRatio(members);
    const best = (options && options.preferBest === false)
      ? displayedCandidate(members)
      : getBestCandidate(members);
    const dims = effectiveDimensions(best, ratio);
    const group = {
      id: best.identity + '|' + members.length + '|' + N.stableHash(best.url),
      key: best.identity,
      candidates: members,
      best,
      versions: members.length,
      url: best.url,
      width: dims.width,
      height: dims.height,
      measured: dims.confidence >= 3,
      dimensionConfidence: dims.confidence,
      area: dims.width * dims.height,
      // Only the winning candidate's size: showing a sibling's byte count next
      // to the 2400px version would be a plain lie about what you get.
      bytes: best.bytes || 0,
      knownBytes: maxBytes(members),
      format: best.format || N.guessFormat(best.url),
      alt: firstTruthy(members, 'alt'),
      title: firstTruthy(members, 'title'),
      domOrder: Math.min.apply(null, members.map((m) => (m.domOrder != null ? m.domOrder : 1e9))),
      host: N.hostOf(best.url),
      svgSource: best.svgSource || firstTruthy(members, 'svgSource'),
      sources: unionSources(members)
    };
    group.category = N.classify({
      url: group.url,
      format: group.format,
      width: group.width,
      height: group.height,
      displayWidth: best.displayWidth,
      displayHeight: best.displayHeight
    });
    group.thumbUrl = pickThumbnail(members, best);
    return group;
  }

  /**
   * Rendering the 2400px original into a 150px card is wasteful, so prefer a
   * small-but-real variant for the thumbnail while still downloading the best.
   */
  function pickThumbnail(members, best) {
    let chosen = null;
    let chosenArea = Infinity;
    for (const candidate of members) {
      if (/^data:/i.test(candidate.url) && candidate.url.length < 256) continue; // blur placeholder
      const w = candidate.width || candidate.hintWidth || 0;
      const h = candidate.height || candidate.hintHeight || 0;
      const area = w * h;
      if (!area) continue;
      if (w < 64 && h < 64) continue;
      if (area < chosenArea) { chosenArea = area; chosen = candidate; }
    }
    return chosen ? chosen.url : best.url;
  }

  function maxBytes(members) {
    let max = 0;
    for (const member of members) if (member.bytes > max) max = member.bytes;
    return max;
  }

  function firstTruthy(members, field) {
    for (const member of members) if (member[field]) return member[field];
    return '';
  }

  function unionSources(members) {
    const set = [];
    for (const member of members) {
      for (const source of member.sources || []) if (!set.includes(source)) set.push(source);
    }
    return set;
  }

  IMGDL.dedupe = {
    VECTOR_AREA,
    buildGroup,
    compareMetrics,
    displayedCandidate,
    effectiveDimensions,
    getBestCandidate,
    groupAspectRatio,
    groupCandidates,
    isPlaceholder,
    mergeNumericFamilies,
    metricsFor,
    prepareCandidates,
    rankCandidates,
    scoreCandidate
  };
})(typeof self !== 'undefined' ? self : globalThis);
