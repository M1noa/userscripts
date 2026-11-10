// ==UserScript==
// @name         AI Blocklist Link Tint
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      1.0.2
// @description  Tints links to sites on the Huge AI Blocklist slightly yellow with a small warning icon and tooltip, instead of hiding them. The list is fetched once a month and cached.
// @author       Minoa
// @license      MIT
// @homepageURL  https://gitlab.com/M1noa/userscripts
// @supportURL   https://gitlab.com/M1noa/userscripts/-/issues
// @match        *://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

/*
  the uBlock list removes AI sites from search results. this keeps the links
  and marks them instead: the link keeps its own colour and is pulled slightly
  towards warning yellow, with a small triangle at the end of its text. hover
  or focus shows a tooltip, and screen readers get the same text through
  aria-describedby.

  the list is 3600+ uBlock cosmetic filters of the form
    duckduckgo.com,bing.com##a[href*="openart.ai"]:upward(li):remove()
  so only the quoted href value matters. a bare domain ("openart.ai") means
  the whole site is listed; a domain plus a path ("bing.com/images/create")
  only matches links into that section, which keeps search engines and big
  platforms from lighting up entirely.

  links that stay on the site you are already on are skipped: on claude.ai a
  link to claude.ai/settings or docs.claude.ai is not worth a warning, so the
  current host and its parent/subdomains are never tinted.
*/

(function () {
  'use strict';

  // ── config ────────────────────────────────────────────────────────────────

  const LIST_URL = 'https://raw.githubusercontent.com/laylavish/uBlockOrigin-HUGE-AI-Blocklist/main/list.txt';
  const CACHE_KEY = 'ai-tint-list-v1';
  const REFRESH_MS = 30 * 24 * 60 * 60 * 1000; // one month
  const TINT_HUE = 45;                         // yellow, in degrees
  const TINT_SAT_FLOOR = 0.62;                 // so grey/black links still read as yellow
  const TINT_LIGHT_FLOOR = 0.34;
  const TINT_LIGHT_CEIL = 0.72;
  const ANIM_MS = 320;
  const ICON_CLASS = 'ai-tint-icon';
  const DESC_CLASS = 'ai-tint-desc';
  const TIP_ID = 'ai-tint-tip';
  const DESC_ID = 'ai-tint-desc';
  const DESC_TEXT = 'This site is listed in the Huge AI Blocklist because it hosts AI-generated content.';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── storage ───────────────────────────────────────────────────────────────

  const store = {
    get(key) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, '') || '';
      } catch (e) {}
      try { return localStorage.getItem(key) || ''; } catch (e) {}
      return '';
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(key, value); return true; }
      } catch (e) {}
      try { localStorage.setItem(key, value); return true; } catch (e) {}
      return false;
    },
  };

  function readCache() {
    const raw = store.get(CACHE_KEY);
    if (!raw) return null;
    try {
      const entry = JSON.parse(raw);
      if (!entry || typeof entry.text !== 'string' || !entry.text) return null;
      return { ts: Number(entry.ts) || 0, text: entry.text };
    } catch (e) {
      return null;
    }
  }

  function writeCache(text) {
    store.set(CACHE_KEY, JSON.stringify({ ts: Date.now(), text: text }));
  }

  function fetchText(url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          timeout: 20000,
          onload: function (res) {
            if (res.status >= 200 && res.status < 300 && res.responseText) resolve(res.responseText);
            else reject(new Error('HTTP ' + res.status));
          },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timeout')); },
        });
        return;
      }
      fetch(url, { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        })
        .then(resolve, reject);
    });
  }

  // ── list parsing ──────────────────────────────────────────────────────────

  // "openart.ai"            -> whole site
  // "bing.com/images/create" -> only that path prefix
  function normalizeEntry(value) {
    let v = String(value).trim().toLowerCase();
    if (!v) return null;
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
    v = v.replace(/^\*\.?/, '');                  // wildcard
    v = v.replace(/^www\./, '');
    v = v.split('#')[0].split('?')[0];
    const slash = v.indexOf('/');
    let host = slash === -1 ? v : v.slice(0, slash);
    let path = slash === -1 ? '' : v.slice(slash);
    host = host.replace(/:\d+$/, '').replace(/^\^+|^\.+|\.+$|\^+$/g, '');
    path = path.replace(/\/+$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
    return { host: host, path: path };
  }

  function parseList(text) {
    const index = new Map(); // host -> null (whole site) | [path prefixes]
    const selector = /a\[href\s*[*^$~|]?=\s*"([^"]*)"\]/g;
    const lines = String(text).split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line[0] === '!' || line[0] === '\uFEFF') continue;
      if (line.indexOf('#@#') !== -1) continue; // exception rule
      const marker = line.indexOf('##');
      if (marker === -1) continue;
      const rule = line.slice(marker + 2);

      selector.lastIndex = 0;
      let match;
      while ((match = selector.exec(rule))) {
        const entry = normalizeEntry(match[1]);
        if (!entry) continue;
        if (index.get(entry.host) === null) continue; // whole site already listed
        if (!entry.path) {
          index.set(entry.host, null);
          continue;
        }
        let paths = index.get(entry.host);
        if (!paths) {
          paths = [];
          index.set(entry.host, paths);
        }
        if (paths.indexOf(entry.path) === -1) paths.push(entry.path);
      }
    }

    return index;
  }

  // "same site" = the link's host is the page's host, a subdomain of it, or a
  // parent of it, so internal navigation never gets flagged
  function isSameSite(hostname, currentHostname) {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
    const here = String(currentHostname || '').toLowerCase().replace(/^www\./, '');
    if (!host || !here) return false;
    if (host === here) return true;
    return host.slice(-(here.length + 1)) === '.' + here ||
      here.slice(-(host.length + 1)) === '.' + host;
  }

  function isListed(hostname, pathname) {
    let host = String(hostname).toLowerCase();
    if (host.indexOf('www.') === 0) host = host.slice(4);
    const path = String(pathname || '/').toLowerCase();
    const labels = host.split('.');

    // walk the label suffixes: a.b.example.com -> a.b.example.com, b.example.com, example.com
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = i === 0 ? host : labels.slice(i).join('.');
      if (!index.has(candidate)) continue;
      const paths = index.get(candidate);
      if (!paths) return true;
      for (let j = 0; j < paths.length; j++) {
        const rule = paths[j];
        if (path.indexOf(rule) !== 0) continue;
        const rest = path.slice(rule.length);
        if (!rest || rest[0] === '/') return true; // "x.com/ai" matches "/ai" and "/ai/page", not "/air-fryer"
      }
    }
    return false;
  }

  // ── colour helpers ────────────────────────────────────────────────────────

  let canvasCtx = null;

  function toRgb(value) {
    if (!value) return null;
    const m = String(value).match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i);
    if (m) {
      let alpha = m[4] === undefined ? 1 : m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [Number(m[1]), Number(m[2]), Number(m[3]), Math.max(0, Math.min(1, alpha))];
    }
    // oklch(), color(display-p3 …) and friends: let a canvas normalise it
    try {
      if (!canvasCtx) {
        const canvas = document.createElement('canvas');
        canvasCtx = canvas.getContext ? canvas.getContext('2d') : null;
      }
      if (!canvasCtx) return null;
      canvasCtx.fillStyle = '#000000';
      canvasCtx.fillStyle = value;
      const hex = canvasCtx.fillStyle;
      if (/^#[0-9a-f]{6}$/i.test(hex)) {
        return [
          parseInt(hex.slice(1, 3), 16),
          parseInt(hex.slice(3, 5), 16),
          parseInt(hex.slice(5, 7), 16),
          1,
        ];
      }
    } catch (e) {}
    return null;
  }

  function rgbaString(rgb) {
    return 'rgba(' + Math.round(rgb[0]) + ', ' + Math.round(rgb[1]) + ', ' + Math.round(rgb[2]) + ', ' + rgb[3] + ')';
  }

  // the tint keeps the link's own lightness and saturation and only turns the
  // hue yellow, so a dark blue link becomes a dark gold instead of a muddy mix
  function tintColor(rgb) {
    const r = rgb[0] / 255;
    const g = rgb[1] / 255;
    const b = rgb[2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let lightness = (max + min) / 2;
    let saturation = 0;
    if (delta > 0) saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    saturation = Math.max(saturation, TINT_SAT_FLOOR);
    lightness = Math.min(TINT_LIGHT_CEIL, Math.max(TINT_LIGHT_FLOOR, lightness));

    const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const hp = TINT_HUE / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = lightness - c / 2;
    let out;
    if (hp < 1) out = [c, x, 0];
    else if (hp < 2) out = [x, c, 0];
    else if (hp < 3) out = [0, c, x];
    else if (hp < 4) out = [0, x, c];
    else if (hp < 5) out = [x, 0, c];
    else out = [c, 0, x];

    return [
      (out[0] + m) * 255,
      (out[1] + m) * 255,
      (out[2] + m) * 255,
      rgb[3],
    ];
  }

  function sameColor(a, b) {
    return a && b &&
      Math.abs(a[0] - b[0]) < 2 &&
      Math.abs(a[1] - b[1]) < 2 &&
      Math.abs(a[2] - b[2]) < 2 &&
      Math.abs(a[3] - b[3]) < 0.05;
  }

  function setStyle(el, prop, value) {
    try { el.style.setProperty(prop, value, 'important'); } catch (e) {}
  }

  // ── ui ────────────────────────────────────────────────────────────────────

  const CSS = [
    '.' + ICON_CLASS + '{display:inline-block!important;width:.82em!important;height:.82em!important;',
    'margin-inline-start:.28em!important;vertical-align:-.05em!important;opacity:.8;',
    'flex:0 0 auto;pointer-events:none!important;}',
    '.' + DESC_CLASS + '{position:absolute!important;width:1px!important;height:1px!important;',
    'margin:-1px!important;padding:0!important;border:0!important;overflow:hidden!important;',
    'clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;}',
    '#' + TIP_ID + '{position:fixed;left:0;top:0;z-index:2147483647;',
    'transform:translate(-9999px,-9999px);display:block;box-sizing:border-box;max-width:280px;',
    'padding:6px 9px;border-radius:7px;text-align:start;white-space:normal;',
    'font:400 12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
    'background:#fff;background:Canvas;color:#17171a;color:CanvasText;',
    'border:1px solid rgba(120,120,128,.34);box-shadow:0 4px 14px rgba(0,0,0,.16);',
    'opacity:0;pointer-events:none;transition:opacity .12s ease;}',
    '#' + TIP_ID + '[data-show="1"]{opacity:1;}',
    '#' + TIP_ID + ' b{display:block;font-weight:600;font-size:12px;}',
    '#' + TIP_ID + ' span{display:block;font-size:11.5px;opacity:.7;}',
  ].join('');

  let tipEl = null;
  let uiReady = false;

  function installUI() {
    if (uiReady) return;
    uiReady = true;
    const root = document.head || document.documentElement;

    const style = document.createElement('style');
    style.id = 'ai-tint-style';
    style.textContent = CSS;
    root.appendChild(style);

    const desc = document.createElement('span');
    desc.id = DESC_ID;
    desc.className = DESC_CLASS;
    desc.textContent = DESC_TEXT;
    document.documentElement.appendChild(desc);

    tipEl = document.createElement('div');
    tipEl.id = TIP_ID;
    tipEl.setAttribute('role', 'tooltip');
    tipEl.setAttribute('aria-hidden', 'true');
    tipEl.dataset.show = '0';
    const title = document.createElement('b');
    title.textContent = 'AI-listed site';
    const sub = document.createElement('span');
    sub.textContent = 'Listed in the Huge AI Blocklist';
    tipEl.appendChild(title);
    tipEl.appendChild(sub);
    document.documentElement.appendChild(tipEl);
  }

  function showTip(anchor) {
    const state = STATE.get(anchor);
    if (!state || !tipEl) return;
    const box = (state.icon || anchor).getBoundingClientRect();
    const width = tipEl.offsetWidth;
    const height = tipEl.offsetHeight;
    let left = box.left + box.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = box.top - height - 9;
    if (top < 8) top = box.bottom + 9;
    tipEl.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
    tipEl.dataset.show = '1';
  }

  function hideTip() {
    if (tipEl) tipEl.dataset.show = '0';
  }

  function makeIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', ICON_CLASS);

    const triangle = document.createElementNS(SVG_NS, 'path');
    triangle.setAttribute('d', 'M8 2.4 14.4 13.4H1.6Z');
    triangle.setAttribute('fill', 'none');
    triangle.setAttribute('stroke', 'currentColor');
    triangle.setAttribute('stroke-width', '1.25');
    triangle.setAttribute('stroke-linejoin', 'round');

    const stem = document.createElementNS(SVG_NS, 'path');
    stem.setAttribute('d', 'M8 6.1v3.3');
    stem.setAttribute('stroke', 'currentColor');
    stem.setAttribute('stroke-width', '1.25');
    stem.setAttribute('stroke-linecap', 'round');
    stem.setAttribute('fill', 'none');

    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', '8');
    dot.setAttribute('cy', '11.5');
    dot.setAttribute('r', '.78');
    dot.setAttribute('fill', 'currentColor');

    svg.appendChild(triangle);
    svg.appendChild(stem);
    svg.appendChild(dot);
    return svg;
  }

  // ── tinting ───────────────────────────────────────────────────────────────

  const STATE = new WeakMap(); // anchor -> { icon, prevDesc, enter, leave }

  function tint(anchor) {
    const computed = getComputedStyle(anchor);
    const base = toRgb(computed.color);
    if (!base || base[3] === 0) return; // invisible link, nothing to tint

    const fill = toRgb(computed.webkitTextFillColor || '');
    const tintFill = fill && fill[3] > 0 && !sameColor(fill, base);
    const target = rgbaString(tintColor(base));
    const fillTarget = tintFill ? rgbaString(tintColor(fill)) : '';

    const icon = makeIcon();
    anchor.appendChild(icon);

    const prevDesc = anchor.getAttribute('aria-describedby');
    anchor.setAttribute('aria-describedby', prevDesc ? prevDesc + ' ' + DESC_ID : DESC_ID);

    const enter = function () { showTip(anchor); };
    const leave = function () { hideTip(); };
    anchor.addEventListener('mouseenter', enter);
    anchor.addEventListener('mouseleave', leave);
    anchor.addEventListener('focus', enter);
    anchor.addEventListener('blur', leave);

    STATE.set(anchor, { icon: icon, prevDesc: prevDesc, enter: enter, leave: leave });

    // start from the colour the link already has, then slide to the tint, so
    // the link animates from its own colour instead of snapping to yellow
    setStyle(anchor, 'transition', 'color ' + ANIM_MS + 'ms ease, -webkit-text-fill-color ' + ANIM_MS + 'ms ease');
    setStyle(anchor, 'color', rgbaString(base));
    if (tintFill) setStyle(anchor, '-webkit-text-fill-color', rgbaString(fill));

    let applied = false;
    const settle = function () {
      if (applied || !STATE.has(anchor)) return;
      applied = true;
      setStyle(anchor, 'color', target);
      if (fillTarget) setStyle(anchor, '-webkit-text-fill-color', fillTarget);
    };
    requestAnimationFrame(function () {
      requestAnimationFrame(settle);
    });
    // rAF is paused in background tabs; make sure the tint still lands
    setTimeout(settle, 1200);
  }

  function untint(anchor) {
    const state = STATE.get(anchor);
    if (!state) return;
    STATE.delete(anchor);
    hideTip();
    if (state.enter) {
      anchor.removeEventListener('mouseenter', state.enter);
      anchor.removeEventListener('mouseleave', state.leave);
      anchor.removeEventListener('focus', state.enter);
      anchor.removeEventListener('blur', state.leave);
    }
    ['color', '-webkit-text-fill-color', 'transition'].forEach(function (prop) {
      try { anchor.style.removeProperty(prop); } catch (e) {}
    });
    if (state.icon && state.icon.parentNode) state.icon.parentNode.removeChild(state.icon);
    if (state.prevDesc) anchor.setAttribute('aria-describedby', state.prevDesc);
    else anchor.removeAttribute('aria-describedby');
  }

  function tune(anchor) {
    if (!anchor || anchor.nodeType !== 1) return;
    const href = anchor.getAttribute('href');
    let url = null;
    if (href) {
      try { url = new URL(anchor.href, location.href); } catch (e) {}
    }
    const listed = !!url && /^https?:$/.test(url.protocol) &&
      !isSameSite(url.hostname, location.hostname) &&
      isListed(url.hostname, url.pathname);
    if (!listed) {
      untint(anchor);
      return;
    }
    if (!STATE.has(anchor)) tint(anchor);
  }

  // ── scanning ──────────────────────────────────────────────────────────────

  const queue = new Set();
  let scheduled = false;

  function flush() {
    scheduled = false;
    const batch = Array.from(queue);
    queue.clear();
    for (let i = 0; i < batch.length; i++) tune(batch[i]);
  }

  function enqueue(anchor) {
    queue.add(anchor);
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.nodeType === 1 && root.matches('a[href]')) enqueue(root);
    const links = root.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i++) enqueue(links[i]);
  }

  let started = false;

  function start() {
    if (!started) {
      started = true;
      installUI();
      document.addEventListener('scroll', hideTip, true);
      window.addEventListener('blur', hideTip);
      new MutationObserver(function (records) {
        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          if (record.type === 'attributes') {
            const target = record.target;
            if (target && target.nodeType === 1 && target.matches('a[href]')) enqueue(target);
            continue;
          }
          for (let j = 0; j < record.addedNodes.length; j++) {
            const node = record.addedNodes[j];
            if (node && node.nodeType === 1) scan(node);
          }
        }
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href'],
      });
    }
    scan(document.body || document.documentElement);
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  let index = new Map();

  function ingest(text) {
    const parsed = parseList(text);
    if (!parsed.size) return false;
    index = parsed;
    start();
    return true;
  }

  function main() {
    const cached = readCache();
    if (cached) ingest(cached.text);
    if (cached && Date.now() - cached.ts < REFRESH_MS) return;

    fetchText(LIST_URL).then(function (text) {
      if (parseList(text).size < 100) throw new Error('unexpected list contents');
      writeCache(text);
      ingest(text);
    }).catch(function (error) {
      if (!cached) console.warn('[AI link tint] blocklist unavailable:', error && error.message ? error.message : error);
    });
  }

  main();
})();
