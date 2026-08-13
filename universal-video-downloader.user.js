// ==UserScript==
// @name         Universal Video Downloader
// @namespace    http://tampermonkey.net/
// @version      25.1
// @description  download videos from any site. m3u8/m3u. site-specific extraction. cors fallback. works everywhere.
// @author       Minoa
// @license      MIT
// @match        *://*/*
// @require      https://cdn.jsdelivr.net/npm/m3u8-parser@4.7.1/dist/m3u8-parser.min.js
// @require      https://cdn.jsdelivr.net/npm/@warren-bank/ffmpeg@0.12.10-wasmbinary.3/dist/umd/ffmpeg.js
// @resource     classWorkerURL  https://cdn.jsdelivr.net/npm/@warren-bank/ffmpeg@0.12.10-wasmbinary.3/dist/umd/258.ffmpeg.js
// @resource     coreURL         https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js
// @resource     wasmURL         https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm
// @grant        GM_addStyle
// @grant        GM_getResourceURL
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// @downloadURL https://update.greasyfork.org/scripts/554755/Universal%20Video%20Downloader.user.js
// @updateURL https://update.greasyfork.org/scripts/554755/Universal%20Video%20Downloader.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const LOG = '[uvd]';
    const VER = '25.1';

    // Config & State
    let optBlacklist = GM_getValue('uvs_blacklist', []);
    const host = location.hostname;
    const isBlacklisted = optBlacklist.includes(host);

    if (typeof GM_registerMenuCommand !== 'undefined') {
        if (isBlacklisted) {
            GM_registerMenuCommand("Enable on this site", () => { GM_setValue('uvs_blacklist', optBlacklist.filter(h => h !== host)); location.reload(); });
            return;
        } else {
            GM_registerMenuCommand("Disable on this site", () => { optBlacklist.push(host); GM_setValue('uvs_blacklist', optBlacklist); location.reload(); });
            GM_registerMenuCommand("Settings", () => { setStealth(false); showSettings(); });
        }
    }
    if (isBlacklisted) return;

    const T = { bg: 'rgba(20,20,20,0.75)', modal: 'rgba(20,20,20,0.85)', border: 'rgba(255,255,255,0.1)', text: '#f0f0f0', sub: '#888888', accent: '#c8a96e', success: '#4ade80', error: '#f87171', info: '#60a5fa', warn: '#fbbf24' };
    const VIDEO_EXTS = ['mp4','webm','ogg','mov','avi','mkv','m4v','flv','wmv','ts','mts','m2ts'];
    const CONCURRENCY = 4;
    const MAX_RETRIES = 4;

    const isTwitter = /^(twitter|x)\.com$/.test(host);
    const isYouTube = /^(www\.)?youtube\.com$/.test(host);
    const _win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const _fetch = window.fetch.bind(window);

    // Settings
    let optDebug = GM_getValue('uvs_debug', false);
    let isHidden = GM_getValue('uvs_hidden', false);
    let uiPosition = GM_getValue('uvs_position', 'tl');
    let uiOpacity = GM_getValue('uvs_opacity', 1.0);
    let optScanInterval = GM_getValue('uvs_scan_interval', 6.0);
    let optDefaultAction = GM_getValue('uvs_default_action', 'menu');
    let optShareMode = GM_getValue('uvs_share_mode', 'file');

    // Advanced Settings
    let optMuxHLS = GM_getValue('uvs_mux_hls', true);
    let optRemuxDirect = GM_getValue('uvs_remux_direct', false);
    let optFallbackClip = GM_getValue('uvs_fallback_clip', true);
    let optFallbackDl = GM_getValue('uvs_fallback_dl', true);
    let optFFArgs = GM_getValue('uvs_ff_args', '');
    let optFFExt = GM_getValue('uvs_ff_ext', 'mp4');

    const log = (...args) => { if (optDebug) console.log(`${LOG}`, ...args); };
    const warn = (...args) => { if (optDebug) console.warn(`${LOG}`, ...args); };
    const err = (...args) => console.error(`${LOG}`, ...args);

    log(`v${VER} loaded on ${host}`);

    let _shadowHost = null, _shadow = null, _btn = null, _wrap = null, _dot = null, _toastBox = null, _scanTimer = null;
    let scanCount = 0, currentInterval = optScanInterval * 1000;
    const videos = new Map(), seenM3U8s = new Set(), scannedScripts = new WeakSet(), twitterCache = new Map(), activeToasts = new Map(), activeObjectUrls = new Set();
    let _ffmpeg = null, _ffReady = false, _wasmBuf = null;

    // Power Mode
    async function initPowerMode() {
        try {
            if (navigator.getBattery) {
                const bat = await navigator.getBattery();
                const updatePower = () => { currentInterval = bat.charging ? (optScanInterval * 1000) : (optScanInterval * 1000) * 1.15; log(`power state: ${currentInterval}ms`); };
                updatePower(); bat.addEventListener('chargingchange', updatePower);
            }
        } catch (e) { warn('battery api not supported'); }
    }

    // Utils
    function resolveUrl(base, rel) { try { return new URL(rel, base).href; } catch { return rel; } }
    function getBaseUrl(url) {
        try { const u = new URL(url); ['validfrom', 'validto', 'rate', 'burst', 'ip', 'ipa', 'hash', 'token', 'auth', 'expire', 'expires', 'sig', 'signature', 'e', 'st', 'h', 'mac'].forEach(p => u.searchParams.delete(p)); return u.href; }
        catch { return url.split('?')[0]; }
    }
    function sanitize(s) {
        const clean = (s || 'video').replace(/[\u{1F600}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F300}-\u{1F5FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu, '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 150);
        return clean || 'video';
    }
    function smartName() {
        const og = document.querySelector('meta[property="og:title"]')?.content?.trim(); if (og) return sanitize(og);
        const h1 = document.querySelector('h1')?.textContent?.trim(); if (h1) return sanitize(h1);
        return sanitize(document.title);
    }
    function nameFromUrl(url) { try { const p = new URL(url).pathname; return decodeURIComponent(p.slice(p.lastIndexOf('/') + 1)) || 'video'; } catch { return 'video'; } }
    function fmtBytes(b) { if (!b) return ''; const i = Math.floor(Math.log(b) / Math.log(1024)); return (b / Math.pow(1024, i)).toFixed(1) + ['B','KB','MB','GB'][i]; }
    function fmtDur(s) { if (!s) return ''; return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; }
    function getCookie(n) { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; }
    function isVideoExt(url) { if (!url || /^(blob|data):/i.test(url)) return false; const clean = url.split('?')[0].toLowerCase(); return VIDEO_EXTS.some(e => clean.endsWith('.' + e)); }
    function isM3U(url) { return !!url && /\.m3u8?(\?|$)/i.test(url); }

    // UI Styles & Icons
    const SHADOW_CSS = `
        :host { all: initial !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important; }
        * { box-sizing: border-box; }
        #uvs-wrap { position: fixed !important; width: 48px !important; height: 48px !important; z-index: 2147483647 !important; pointer-events: auto !important; transition: opacity 0.25s ease; }
        #uvs-wrap.hidden { display: none !important; }
        #uvs-wrap.pos-tl { top: 14px; left: 14px; } #uvs-wrap.pos-tr { top: 14px; right: 14px; }
        #uvs-wrap.pos-bl { bottom: 14px; left: 14px; } #uvs-wrap.pos-br { bottom: 14px; right: 14px; }
        #uvs-wrap.pos-cl { top: 50%; left: 14px; transform: translateY(-50%); } #uvs-wrap.pos-cr { top: 50%; right: 14px; transform: translateY(-50%); }
        #uvs-btn { position: absolute !important; top: 4px; left: 4px; width: 40px; height: 40px; border-radius: 50%; background: ${T.bg}; backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); color: ${T.accent}; border: 1px solid ${T.border}; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: transform 0.15s ease, background 0.15s ease; box-shadow: 0 4px 24px rgba(0,0,0,0.5); user-select: none; -webkit-user-select: none; }
        #uvs-btn:hover { transform: scale(1.07); background: rgba(40,40,40,0.85); } #uvs-btn:active { transform: scale(0.92); }
        #uvs-btn svg { width: 17px; height: 17px; fill: currentColor; pointer-events: none; display: block; }

        /* Fixed Progress Ring CSS */
        #uvs-ring-svg { position: absolute !important; top: 0; left: 0; pointer-events: none; }
        #uvs-ring { transform: rotate(-90deg); transform-origin: 50% 50%; stroke-dasharray: 138.2; transition: stroke-dashoffset 0.2s linear, stroke 0.3s ease; stroke: ${T.success}; }
        #uvs-ring.state-dl { stroke: ${T.info}; } #uvs-ring.state-mux { stroke: ${T.warn}; } #uvs-ring.state-done{ stroke: ${T.success}; }
        #uvs-ring.spin { stroke-dasharray: 40 138.2; stroke-dashoffset: 0; animation: uvs-spin 1s linear infinite; transition: stroke 0.3s ease; }
        @keyframes uvs-spin { from { transform: rotate(-90deg); } to { transform: rotate(270deg); } }

        #uvs-count { position: absolute; top: -3px; right: -3px; min-width: 16px; height: 16px; padding: 0 4px; background: ${T.accent}; color: #000; border-radius: 8px; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; letter-spacing: -0.3px; }
        #uvs-dot { position: fixed !important; width: 14px; height: 14px; border-radius: 3px; background: rgba(0,0,0,0.4); border: 1.5px solid rgba(255,255,255,0.25); z-index: 2147483647 !important; cursor: pointer; opacity: 0.45; transition: opacity 0.15s, background 0.15s; display: none; }
        #uvs-dot.pos-tl { top: 8px; left: 8px; } #uvs-dot.pos-tr { top: 8px; right: 8px; } #uvs-dot.pos-bl { bottom: 8px; left: 8px; } #uvs-dot.pos-br { bottom: 8px; right: 8px; } #uvs-dot.pos-cl { top: 50%; left: 8px; transform: translateY(-50%); } #uvs-dot.pos-cr { top: 50%; right: 8px; transform: translateY(-50%); }
        #uvs-dot:hover { opacity: 1; background: ${T.success}; }
        #uvs-toasts { position: fixed !important; display: flex; gap: 8px; z-index: 2147483646 !important; pointer-events: none; max-width: 320px; width: max-content; }
        #uvs-toasts.pos-tl, #uvs-toasts.pos-cl { top: 72px; left: 14px; flex-direction: column; align-items: flex-start; } #uvs-toasts.pos-tr, #uvs-toasts.pos-cr { top: 72px; right: 14px; flex-direction: column; align-items: flex-end; } #uvs-toasts.pos-bl { bottom: 72px; left: 14px; flex-direction: column-reverse; align-items: flex-start; } #uvs-toasts.pos-br { bottom: 72px; right: 14px; flex-direction: column-reverse; align-items: flex-end; }
        .uvs-toast { background: ${T.bg}; backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border: 1px solid ${T.border}; border-radius: 12px; color: ${T.text}; padding: 10px 14px; font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); animation: uvs-toast-in 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275); transition: opacity 0.2s, transform 0.2s; }
        .uvs-toast svg { width: 14px; height: 14px; fill: currentColor; flex-shrink: 0; }
        .uvs-toast.success { border-color: rgba(74,222,128,0.3); color: ${T.success}; } .uvs-toast.error { border-color: rgba(248,113,113,0.3); color: ${T.error}; background: rgba(30,10,10,0.85); } .uvs-toast.warn { border-color: rgba(251,191,36,0.3); color: ${T.warn}; } .uvs-toast.info { border-color: rgba(96,165,250,0.3); color: ${T.info}; }
        .uvs-toast-msg { flex: 1; } .uvs-toast-badge { background: rgba(255,255,255,0.15); padding: 2px 6px; border-radius: 10px; font-size: 10px; font-weight: 700; color: #fff; margin-left: 6px; animation: uvs-pop 0.2s ease; }
        @keyframes uvs-toast-in { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: none; } } @keyframes uvs-pop { 0% { transform: scale(1); } 50% { transform: scale(1.2); } 100% { transform: scale(1); } }
        #uvs-overlay { position: fixed !important; inset: 0 !important; background: rgba(0,0,0,0.5); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 2147483645 !important; display: flex; align-items: center; justify-content: center; opacity: 0; animation: uvs-fade 0.2s forwards; }
        @keyframes uvs-fade { to { opacity: 1; } }
        #uvs-modal { background: ${T.modal}; border: 1px solid ${T.border}; border-radius: 16px; width: 520px; max-width: 92vw; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 24px 64px rgba(0,0,0,0.6); transform: scale(0.95) translateY(10px); animation: uvs-modal-in 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); }
        @keyframes uvs-modal-in { to { transform: scale(1) translateY(0); } }
        .uvs-mhdr { padding: 14px 20px; border-bottom: 1px solid ${T.border}; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
        .uvs-mtitle { font-size: 14px; font-weight: 600; color: ${T.text}; letter-spacing: 0.3px; display: flex; align-items: center; gap: 8px; }
        .uvs-mbtn { background: none; border: none; color: ${T.sub}; cursor: pointer; border-radius: 6px; display: flex; justify-content: center; align-items: center; min-width: 44px; min-height: 44px; transition: all 0.15s; margin: -10px 0; }
        .uvs-mbtn:hover { color: ${T.text}; background: rgba(255,255,255,0.1); } .uvs-mbtn svg { width: 18px; height: 18px; fill: currentColor; display: block; }
        .uvs-hdr-actions { display: flex; gap: 4px; }
        .uvs-list { overflow-y: auto; overscroll-behavior: contain; padding-bottom: 8px; }
        .uvs-group-hdr { padding: 10px 20px 6px 20px; font-size: 11px; font-weight: 700; color: ${T.sub}; text-transform: uppercase; letter-spacing: 1px; background: rgba(0,0,0,0.2); border-bottom: 1px solid rgba(255,255,255,0.02); position: sticky; top: 0; z-index: 2; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
        .uvs-item { padding: 12px 20px; border-bottom: 1px solid rgba(255,255,255,0.03); cursor: pointer; display: flex; align-items: center; gap: 14px; transition: background 0.15s; min-height: 54px; }
        .uvs-item:hover { background: rgba(255,255,255,0.06); } .uvs-item:last-child { border-bottom: none; }
        .uvs-iico { color: ${T.accent}; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; width: 36px; }
        .uvs-iico svg { width: 20px; height: 20px; fill: currentColor; }
        .uvs-imicro { font-size: 9px; font-weight: 800; margin-top: 4px; letter-spacing: 0.5px; opacity: 0.8; font-family: ui-monospace, SFMono-Regular, monospace; }
        .uvs-iinfo { flex: 1; min-width: 0; } .uvs-iname { font-size: 13px; color: ${T.text}; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .uvs-imeta { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
        .uvs-badge { font-size: 10px; padding: 3px 6px; border-radius: 4px; background: rgba(255,255,255,0.08); color: ${T.sub}; font-weight: 600; letter-spacing: 0.2px; white-space: nowrap; }
        .uvs-badge.hd { background: rgba(96,165,250,0.15); color: ${T.info}; } .uvs-badge.sz { background: rgba(74,222,128,0.15); color: ${T.success}; } .uvs-badge.stream { background: rgba(200,169,110,0.15); color: ${T.accent}; } .uvs-badge.src { background: rgba(251,191,36,0.15); color: ${T.warn}; } .uvs-badge.playing{ background: rgba(74,222,128,0.25); color: ${T.success}; border: 1px solid rgba(74,222,128,0.4); }
        .uvs-settings { padding: 16px 20px; overflow-y: auto; } .uvs-s-group { margin-bottom: 20px; } .uvs-s-title { font-size: 11px; font-weight: 700; color: ${T.accent}; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
        .uvs-s-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; } .uvs-s-label { font-size: 13px; color: ${T.text}; display: flex; flex-direction: column; gap: 4px; } .uvs-s-sub { font-size: 11px; color: ${T.sub}; }
        .uvs-input, .uvs-select { background: rgba(0,0,0,0.3); border: 1px solid ${T.border}; border-radius: 6px; color: ${T.text}; padding: 6px 10px; font-size: 13px; outline: none; font-family: inherit; }
        .uvs-input:focus, .uvs-select:focus { border-color: ${T.accent}; } .uvs-input[type="number"] { width: 70px; text-align: center; } .uvs-input[type="text"] { width: 140px; } .uvs-input[type="range"] { accent-color: ${T.accent}; cursor: pointer; }
        .uvs-toggle { position: relative; display: inline-block; width: 36px; height: 20px; } .uvs-toggle input { opacity: 0; width: 0; height: 0; }
        .uvs-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(255,255,255,0.1); transition: .2s; border-radius: 20px; }
        .uvs-slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .2s; border-radius: 50%; }
        input:checked + .uvs-slider { background-color: ${T.success}; } input:checked + .uvs-slider:before { transform: translateX(16px); }
        .uvs-btn-sm { background: rgba(255,255,255,0.1); border: none; color: ${T.text}; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; transition: background 0.15s; font-weight: 500; }
        .uvs-btn-sm:hover { background: rgba(255,255,255,0.2); } .uvs-btn-sm.danger { background: rgba(248,113,113,0.15); color: ${T.error}; } .uvs-btn-sm.danger:hover { background: rgba(248,113,113,0.3); }
    `;

    const LIGHT_CSS = `
        .uvs-tw { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 50%; cursor: pointer; color: rgb(113,118,123); background: transparent; border: none; padding: 0; transition: background 0.15s, color 0.15s; }
        .uvs-tw:hover { background: rgba(29,155,240,0.1); color: rgb(29,155,240); } .uvs-tw svg { width: 18px; height: 18px; fill: currentColor; display: block; }
        .uvs-tw.loading svg { animation: uvs-tw-spin 0.85s linear infinite; stroke-dasharray: 42 96; } .uvs-tw.ok { color: ${T.success}; } .uvs-tw.fail { color: ${T.error}; }
        @keyframes uvs-tw-spin { to { stroke-dashoffset: -138; } }
    `;

    try { GM_addStyle(LIGHT_CSS); } catch (_) { const s = document.createElement('style'); s.textContent = LIGHT_CSS; document.documentElement.appendChild(s); }

    const I = {
        dl: `<svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zm7-16v10.17l-3.59-3.58L7 12l5 5 5-5-1.41-1.41L13 14.17V4h-1z"/></svg>`,
        menu: `<svg viewBox="0 0 24 24"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>`,
        check: `<svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>`,
        cross: `<svg viewBox="0 0 24 24"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>`,
        info: `<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`,
        warn: `<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
        spin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10" opacity="0.2"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>`,
        gear: `<svg viewBox="0 0 24 24"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.06-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.73,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.06,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.43-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.49-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>`,
        back: `<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`
    };

    // Toasts & Progress
    function getToastBox() {
        if (_toastBox && _shadow.contains(_toastBox)) return _toastBox;
        _toastBox = document.createElement('div'); _toastBox.id = 'uvs-toasts'; _toastBox.className = `pos-${uiPosition}`; _shadow.appendChild(_toastBox); return _toastBox;
    }
    function notify(msg, type = 'info', ms = 4000) {
        if (type === 'error') err(msg); else log(`[${type}] ${msg}`);
        if (isHidden) return;
        const box = getToastBox();
        if (activeToasts.has(msg)) {
            const t = activeToasts.get(msg); t.count++; clearTimeout(t.timer);
            let badge = t.el.querySelector('.uvs-toast-badge');
            if (!badge) { badge = document.createElement('span'); badge.className = 'uvs-toast-badge'; t.el.appendChild(badge); }
            badge.textContent = `x${t.count}`; t.el.style.transform = 'scale(1.05)'; setTimeout(() => t.el.style.transform = 'none', 150);
            t.timer = setTimeout(() => removeToast(msg), ms); return;
        }
        const el = document.createElement('div'); el.className = 'uvs-toast ' + type;
        const icon = type === 'success' ? I.check : type === 'error' ? I.cross : type === 'warn' ? I.warn : I.info;
        el.innerHTML = icon + `<span class="uvs-toast-msg">${msg}</span>`; box.appendChild(el);
        const timer = setTimeout(() => removeToast(msg), ms); activeToasts.set(msg, { el, count: 1, timer });
    }
    function removeToast(msg) { const t = activeToasts.get(msg); if (!t) return; t.el.style.opacity = '0'; t.el.style.transform = 'scale(0.9)'; setTimeout(() => { t.el.remove(); activeToasts.delete(msg); }, 250); }
    function reportError(error, ctx = '') {
        const dump = ['uvd v' + VER + ' error', 'page: ' + location.href, 'ctx: ' + ctx, 'err: ' + (error?.message || String(error)), 'stack:\n' + (error?.stack || 'n/a')].join('\n');
        err(`error in [${ctx}]:`, error); notify('error: ' + (error?.message || String(error)).slice(0, 80), 'error', 7000);
        try { GM_setClipboard(dump, 'text'); log(`error copied to clipboard`); } catch (_) { navigator.clipboard?.writeText(dump).catch(() => {}); }
    }

    function setProgress(pct, state = 'dl') {
        if (!_shadow) return;
        const r = _shadow.querySelector('#uvs-ring');
        if (!r) return;

        r.classList.remove('state-dl', 'state-mux', 'state-done');
        r.classList.add('state-' + state);

        if (pct < 0) {
            r.classList.add('spin');
            r.style.strokeDashoffset = '0';
        } else {
            r.classList.remove('spin');
            r.style.strokeDashoffset = String(138.2 - (138.2 * (pct / 100)));
        }
    }
    function clearProgress() {
        if (!_shadow) return;
        const r = _shadow.querySelector('#uvs-ring');
        if (!r) return;

        r.classList.remove('spin', 'state-dl', 'state-mux', 'state-done');
        r.style.strokeDashoffset = '138.2';
    }

    // Registry
    function reg(data) {
        const rawUrl = resolveUrl(location.href, data.url);
        if (/\.(jpe?g|png|gif|webp|svg|ico|woff2?|ttf|css|js|json)(\?|$)/i.test(rawUrl)) return;
        if (/^(blob:|data:)/i.test(rawUrl) && !data.allowBlob) return;
        if (data.type !== 'm3u8' && !isVideoExt(rawUrl) && !data.force) return;

        const baseKey = getBaseUrl(rawUrl);
        if (videos.has(baseKey)) {
            const ex = videos.get(baseKey);
            if (rawUrl.length > ex.url.length || rawUrl.includes('token=')) ex.url = rawUrl;
            if (!ex.width && data.width) ex.width = data.width; if (!ex.height && data.height) ex.height = data.height;
            if (!ex.duration && data.duration) ex.duration = data.duration; if (!ex.size && data.size) ex.size = data.size;
            if (!ex.label && data.label) ex.label = data.label; if (data.isPlaying !== undefined) ex.isPlaying = data.isPlaying;
            return;
        }
        const obj = { url: rawUrl, type: data.type || 'direct', filename: data.filename || nameFromUrl(rawUrl), label: data.label || '', source: data.source || 'unknown', width: data.width || 0, height: data.height || 0, duration: data.duration || 0, size: data.size || 0, ts: Date.now(), manifest: data.manifest || null, isPlaying: !!data.isPlaying };
        videos.set(baseKey, obj); log(`+video [${obj.source}] type=${obj.type} ${baseKey.slice(0, 90)}`); updateBtn();
    }
    function sortedVideos() {
        return Array.from(videos.values()).sort((a, b) => {
            if (a.isPlaying && !b.isPlaying) return -1; if (b.isPlaying && !a.isPlaying) return 1;
            if (a.type === 'm3u8' && b.type !== 'm3u8') return -1; if (b.type === 'm3u8' && a.type !== 'm3u8') return 1;
            const rA = a.width * a.height, rB = b.width * b.height; if (rB !== rA) return rB - rA;
            if (b.size !== a.size) return b.size - a.size; return b.ts - a.ts;
        });
    }

    // Network Hooks
    (function hookNetwork() {
        window.fetch = async function (...args) {
            const res = await _fetch.apply(this, args);
            try {
                const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
                if (isTwitter && /\/TweetDetail|\/TweetResultByRestId|\/HomeTimeline|\/UserTweets|\/SearchTimeline/.test(url)) { res.clone().json().then(parseTwResponse).catch(() => {}); }
                else if (isM3U(url)) { res.clone().text().then(t => handleM3U(url, t)).catch(() => {}); }
                else if (isVideoExt(url)) { reg({ type: 'direct', url, source: 'fetch-hook' }); }
            } catch (_) {} return res;
        };
        const _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            this._uvs = url;
            this.addEventListener('load', function () {
                try {
                    const u = this._uvs; if (!u) return;
                    if (isTwitter && /\/TweetDetail|\/TweetResultByRestId|\/HomeTimeline|\/UserTweets/.test(u)) { try { parseTwResponse(JSON.parse(this.responseText)); } catch (_) {} return; }
                    if (isVideoExt(u)) { reg({ type: 'direct', url: u, source: 'xhr-hook' }); return; }
                    if (isM3U(u)) { const t = (!this.responseType || this.responseType === 'text') ? this.responseText : null; if (t) handleM3U(u, t); else reg({ type: 'm3u8', url: u, source: 'xhr-hook', force: true }); return; }
                    if ((!this.responseType || this.responseType === 'text') && this.responseText?.trimStart().startsWith('#EXTM3U')) { handleM3U(u, this.responseText); }
                } catch (_) {}
            });
            return _open.apply(this, arguments);
        };
    })();

    function handleM3U(rawUrl, text) {
        const url = resolveUrl(location.href, rawUrl);
        if (seenM3U8s.has(url)) return; seenM3U8s.add(url);
        if (!text?.trim().startsWith('#EXTM3U')) return;
        try {
            const parser = new m3u8Parser.Parser(); parser.push(text); parser.end(); const mf = parser.manifest;
            if (mf.playlists?.length) {
                const best = mf.playlists.reduce((a, b) => ((b.attributes?.BANDWIDTH || 0) > (a.attributes?.BANDWIDTH || 0) ? b : a));
                const childUrl = resolveUrl(url, best.uri);
                _fetch(childUrl, { credentials: 'include' }).then(r => r.text()).then(t => handleM3U(childUrl, t)).catch(e => { reg({ type: 'm3u8', url: childUrl, source: 'm3u8-variant', force: true }); });
                return;
            }
            let dur = 0; mf.segments?.forEach(s => dur += s.duration || 0);
            reg({ type: 'm3u8', url, manifest: mf, duration: dur, source: 'm3u8-media', force: true });
        } catch (e) { warn(`m3u8 parse error: ${e.message}`); }
    }

    // Extractors
    function scanDOM() {
        let found = 0;
        document.querySelectorAll('video, audio, source').forEach(el => {
            const src = el.src || el.currentSrc; if (!src || /^(blob|data):/i.test(src)) return;
            const vid = el.tagName === 'VIDEO' ? el : (el.tagName === 'SOURCE' && el.parentElement?.tagName === 'VIDEO') ? el.parentElement : null;
            const isPlaying = vid ? !!(vid.currentTime > 0 && !vid.paused && !vid.ended && vid.readyState > 2) : false;
            reg({ type: 'direct', url: src, source: 'dom', width: vid?.videoWidth || 0, height: vid?.videoHeight || 0, duration: vid?.duration || 0, isPlaying }); found++;
        });
        return found;
    }
    function scanScripts() {
        let found = 0;
        for (const s of document.scripts) {
            if (s.src || scannedScripts.has(s)) continue; const text = s.textContent; if (!text || text.length < 20) { scannedScripts.add(s); continue; } scannedScripts.add(s);
            for (const m of text.matchAll(/["'`](https?:\/\/[^\s"'`<>]{8,}\.(?:mp4|webm|mov|m4v|flv|ogg)(?:\?[^\s"'`<>]*)?)[`'"]/gi)) { reg({ type: 'direct', url: m[1], source: 'script-tag' }); found++; }
            for (const m of text.matchAll(/["'`](https?:\/\/[^\s"'`<>]{8,}\.m3u8?(?:\?[^\s"'`<>]*)?)[`'"]/gi)) { _fetch(m[1], { credentials: 'include' }).then(r => r.text()).then(t => handleM3U(m[1], t)).catch(() => reg({ type: 'm3u8', url: m[1], source: 'script-tag', force: true })); found++; }
        }
        return found;
    }
    function sniffWindow() {
        let found = 0; const w = _win;
        for (const k of ['videoUrl','videoSrc','video_url','streamUrl','playbackUrl','hlsUrl','mediaUrl','contentUrl']) { try { const v = w[k]; if (typeof v === 'string' && v.startsWith('http')) { if (isM3U(v)) { _fetch(v, { credentials: 'include' }).then(r=>r.text()).then(t=>handleM3U(v,t)).catch(()=>{}); } else if (isVideoExt(v)) { reg({ type: 'direct', url: v, source: 'win.' + k }); } found++; } } catch (_) {} }
        try { if (typeof w.jwplayer === 'function') { for (const src of (w.jwplayer()?.getPlaylistItem?.()?.sources || [])) { if (!src.file) continue; if (isM3U(src.file)) { _fetch(src.file, { credentials: 'include' }).then(r=>r.text()).then(t=>handleM3U(src.file,t)).catch(()=>{}); } else { reg({ type: 'direct', url: src.file, source: 'jwplayer' }); } found++; } } } catch (_) {}
        try { if (typeof w.videojs === 'function' && w.videojs.getPlayers) { for (const [id, player] of Object.entries(w.videojs.getPlayers() || {})) { if (!player) continue; const src = player.currentSrc?.(); if (!src || src.startsWith('blob:')) continue; if (isM3U(src)) { _fetch(src, { credentials: 'include' }).then(r=>r.text()).then(t=>handleM3U(src,t)).catch(()=>{}); } else { reg({ type: 'direct', url: src, source: 'videojs.' + id }); } found++; } } } catch (_) {}
        try { for (const k of Object.keys(w)) { try { const v = w[k]; if (v && typeof v === 'object' && typeof v.loadSource === 'function' && v.url) { reg({ type: 'm3u8', url: v.url, source: 'hlsjs.' + k, force: true }); found++; } } catch (_) {} } } catch (_) {}
        return found;
    }
    async function extractPornHub() {
        if (!/pornhub|redtube|tube8|youporn|xtube|pornhubpremium/.test(host)) return;
        const processPHDefs = async (defs) => {
            const mp4Def = defs.find(d => d.format === 'mp4' && d.videoUrl && !d.defaultQuality) || defs.find(d => d.format === 'mp4' && d.videoUrl);
            if (mp4Def) { try { const r = await _fetch(mp4Def.videoUrl, { credentials: 'include' }); const data = await r.json(); for (const item of data) { if (item.videoUrl || item.src) reg({ type: 'direct', url: item.videoUrl || item.src, label: (item.quality || item.label) ? (item.quality || item.label) + 'p' : '', source: 'pornhub', force: true }); } } catch (_) {} }
            const hlsDef = defs.find(d => (d.format === 'hls' || d.format === 'hls_qs') && d.videoUrl);
            if (hlsDef) _fetch(hlsDef.videoUrl, { credentials: 'include' }).then(r => r.text()).then(t => handleM3U(hlsDef.videoUrl, t)).catch(() => {});
        };
        try { for (const k of Object.keys(_win).filter(k => /^flashvars_/.test(k))) { if (_win[k]?.mediaDefinitions) { await processPHDefs(_win[k].mediaDefinitions); return; } } } catch (_) {}
        for (const s of document.scripts) { if (s.src || scannedScripts.has(s)) continue; const m = s.textContent.match(/var\s+flashvars_\w+\s*=\s*(\{[\s\S]+?\})\s*(?:;|\n)/); if (m) { try { const fv = JSON.parse(m[1].replace(/,\s*}/, '}').replace(/,\s*]/g, ']')); if (fv?.mediaDefinitions) { await processPHDefs(fv.mediaDefinitions); return; } } catch (_) {} } }
        for (const s of document.scripts) { if (s.src) continue; const m = s.textContent?.match(/"videoUrl"\s*:\s*"(https:\/\/[^"]+\.json[^"]*)"/); if (m) { try { const r = await _fetch(m[1], { credentials: 'include' }); const data = await r.json(); for (const item of data) { if (item.videoUrl || item.src) reg({ type: 'direct', url: item.videoUrl || item.src, label: (item.quality || item.label) ? (item.quality || item.label) + 'p' : '', source: 'pornhub', force: true }); } } catch (_) {} return; } }
    }
    async function extractXVideos() {
        if (!host.includes('xvideos')) return;
        try { for (const s of document.scripts) { if (s.src) continue; const text = s.textContent; if (!text) continue; const hiMatch = text.match(/setVideoHLS\(['"]([^'"]+)['"]\)/); const lowMatch = text.match(/setVideoUrlLow\(['"]([^'"]+)['"]\)/); const hiMp4 = text.match(/setVideoUrlHigh\(['"]([^'"]+)['"]\)/); if (hiMatch) { _fetch(hiMatch[1], { credentials: 'include' }).then(r=>r.text()).then(t=>handleM3U(hiMatch[1],t)).catch(()=>{}); } if (lowMatch) { reg({ type: 'direct', url: lowMatch[1], label: 'low', source: 'xvideos', force: true }); } if (hiMp4) { reg({ type: 'direct', url: hiMp4[1], label: 'high', source: 'xvideos', force: true }); } } } catch (_) {}
    }
    async function extractVimeo() {
        if (!host.includes('vimeo')) return;
        try { const match = document.head.innerHTML.match(/"progressive":\s*(\[[^\]]+\])/); if (match) { const items = JSON.parse(match[1]); for (const v of items) { if (v.url) { reg({ type: 'direct', url: v.url, label: v.quality, width: v.width, height: v.height, source: 'vimeo', force: true }); } } } } catch (_) {}
    }
    async function extractYouTube() {
        if (!isYouTube) return;
        try {
            const ytData = _win.ytInitialPlayerResponse || (_win.ytplayer && _win.ytplayer.config && JSON.parse(_win.ytplayer.config.args.player_response));
            if (ytData?.streamingData?.formats) {
                for (const f of ytData.streamingData.formats) {
                    if (f.url) reg({ type: 'direct', url: f.url, label: f.qualityLabel || f.quality, width: f.width, height: f.height, source: 'youtube', force: true });
                }
            }
        } catch (_) {}
    }
    function extractMetaTags() {
        let found = 0;
        for (const m of document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[name="og:video"]')) { const url = m.getAttribute('content'); if (url && url.startsWith('http')) { if (isM3U(url)) { _fetch(url, { credentials: 'include' }).then(r=>r.text()).then(t=>handleM3U(url,t)).catch(()=>{}); } else { reg({ type: 'direct', url, source: 'og:video', force: true }); } found++; } }
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) { try { const d = JSON.parse(s.textContent); const url = d.contentUrl || d.embedUrl; if (url && url.startsWith('http')) { reg({ type: 'direct', url, source: 'json-ld', force: true }); found++; } } catch (_) {} }
        return found;
    }
    async function runExtractors() { for (const fn of [extractPornHub, extractXVideos, extractVimeo, extractYouTube, extractMetaTags]) { try { await fn(); } catch (_) {} } }
    function masterScan() {
        if (isHidden) return;
        scanCount++; scanDOM(); scanScripts();
        if (scanCount % 2 === 0) sniffWindow();
        if (scanCount % 3 === 0) runExtractors();
    }

    // Network & Fetch Engine (Integrity Loop)
    async function fetchBlob(url) {
        log(`fetchBlob: ${url.slice(0,100)}`);
        let attempt = 0;
        while (attempt < MAX_RETRIES) {
            try {
                const res = await _fetch(url, { cache: 'force-cache', credentials: 'include' });
                if (!res.ok) throw new Error('http ' + res.status);
                const total = parseInt(res.headers.get('content-length') || '0', 10);
                if (!total) { setProgress(-1, 'dl'); const blob = await res.blob(); setProgress(100, 'dl'); return blob; }

                const reader = res.body.getReader(); const chunks = []; let got = 0;
                while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; setProgress(Math.round(got / total * 100), 'dl'); }

                if (got < total) throw new Error(`Incomplete fetch: ${got}/${total}`);
                setProgress(100, 'dl'); return new Blob(chunks, { type: res.headers.get('content-type') || 'video/mp4' });
            } catch (e) {
                if (attempt === MAX_RETRIES - 1) {
                    if (e.name === 'TypeError' || /cors|failed to fetch|network/i.test(e.message)) { warn(`fetch failed — trying GM_xmlhttpRequest`); return gmBlob(url); }
                    throw e;
                }
                const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
                warn(`fetch failed, retrying in ${delay}ms...`); await new Promise(r => setTimeout(r, delay));
                attempt++;
            }
        }
    }
    function gmBlob(url) {
        return new Promise((resolve, reject) => {
            log(`gmBlob: ${url.slice(0,100)}`);
            GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'blob', anonymous: false,
                headers: { 'Referer': location.href, 'Origin': location.origin, 'Sec-Fetch-Dest': 'video', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site' },
                onload(r) { if (r.status >= 200 && r.status < 300) { setProgress(100, 'dl'); resolve(r.response); } else { reject(new Error('gmxhr http ' + r.status)); } },
                onerror() { reject(new Error('gmxhr network error')); },
                onprogress(p){ if (p.total) setProgress(Math.round(p.loaded / p.total * 100), 'dl'); else setProgress(-1, 'dl'); },
            });
        });
    }

    async function downloadM3U8Video(video) {
        let mf = video.manifest;
        if (!mf) {
            notify('fetching playlist...', 'info');
            try {
                const r = await _fetch(video.url, { cache: 'force-cache', credentials: 'include' }); const text = await r.text();
                const p = new m3u8Parser.Parser(); p.push(text); p.end(); mf = p.manifest;
                if (mf.playlists?.length) {
                    const best = mf.playlists.reduce((a, b) => ((a.attributes?.BANDWIDTH||0) > (b.attributes?.BANDWIDTH||0) ? a : b));
                    const childUrl = resolveUrl(video.url, best.uri);
                    const cr = await _fetch(childUrl, { cache: 'force-cache', credentials: 'include' }); const ct = await cr.text();
                    const cp = new m3u8Parser.Parser(); cp.push(ct); cp.end(); mf = cp.manifest;
                }
            } catch (e) { reportError(e, 'm3u8 on-demand fetch'); throw e; }
        }
        if (!mf?.segments?.length) throw new Error('no segments in manifest');
        notify(`downloading ${mf.segments.length} segments...`, 'info'); setProgress(0, 'dl');

        const results = new Array(mf.segments.length); let idx = 0, done = 0, failed = false;
        const worker = async () => {
            while (idx < mf.segments.length && !failed) {
                const i = idx++; const url = resolveUrl(video.url, mf.segments[i].uri);
                for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                    try {
                        let r;
                        try { r = await _fetch(url, { cache: 'force-cache', credentials: 'include' }); if (!r.ok) throw new Error('http ' + r.status); }
                        catch { r = await new Promise((res, rej) => GM_xmlhttpRequest({ method:'GET', url, responseType:'arraybuffer', anonymous: false, headers: {'Referer': location.href, 'Origin': location.origin}, onload: x => x.status < 300 ? res({ok:true, arrayBuffer:()=>Promise.resolve(x.response)}) : rej(new Error('http '+x.status)), onerror: ()=>rej(new Error('net')) })); }
                        results[i] = await r.arrayBuffer(); break;
                    } catch (e) {
                        if (attempt === MAX_RETRIES - 1) { failed = true; throw e; }
                        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
                        warn(`segment ${i} failed, retrying in ${delay}ms...`); await new Promise(r => setTimeout(r, delay));
                    }
                }
                setProgress(Math.round((++done / mf.segments.length) * 100), 'dl');
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        if (failed) throw new Error('segment download failed after retries');
        notify('stitching segments...', 'info'); return new Blob(results, { type: 'video/mp2t' });
    }

    // FFmpeg Engine
    async function initFFmpeg() {
        if (_ffReady) return _ffmpeg; notify('loading ffmpeg core...', 'info');
        try {
            if (!_wasmBuf) { const r = await _fetch(GM_getResourceURL('wasmURL', false)); _wasmBuf = await r.arrayBuffer(); }
            _ffmpeg = new window.FFmpegWASM.FFmpeg();
            _ffmpeg.on('progress', ({ progress }) => { setProgress(Math.round(progress * 100), 'mux'); });
            await _ffmpeg.load({ classWorkerURL: GM_getResourceURL('classWorkerURL', false), coreURL: GM_getResourceURL('coreURL', false), wasmBinary: _wasmBuf });
            _ffReady = true; notify('ffmpeg ready', 'success'); return _ffmpeg;
        } catch (e) { reportError(e, 'ffmpeg init'); throw e; }
    }
    async function processFFmpeg(inputBlob, name, isHLS) {
        const ff = await initFFmpeg();
        const ext = optFFExt.replace('.', '') || 'mp4';
        const inp = isHLS ? 'in.ts' : 'in.mp4';
        const out = name.replace(/\.[^/.]+$/, "") + '.' + ext;

        notify('processing video...', 'info'); setProgress(-1, 'mux');
        try {
            await ff.writeFile(inp, new Uint8Array(await inputBlob.arrayBuffer()));

            let args = ['-i', inp, '-c', 'copy', '-movflags', 'faststart', out];
            if (optFFArgs.trim() !== '') {
                args = ['-i', inp, ...optFFArgs.trim().split(/\s+/), out];
            }

            await ff.exec(args); const data = await ff.readFile(out);
            ff.deleteFile(inp).catch(()=>{}); ff.deleteFile(out).catch(()=>{});
            setProgress(100, 'done'); return new Blob([data.buffer], { type: `video/${ext}` });
        } catch (e) { reportError(e, 'ffmpeg processing'); throw e; }
    }

    // Output Waterfall
    function triggerDownload(blob, filename) {
        notify('saving to disk...', 'success');
        try {
            const dlUrl = URL.createObjectURL(blob);
            activeObjectUrls.add(dlUrl);
            const a = document.createElement('a'); a.href = dlUrl; a.download = filename;
            document.documentElement.appendChild(a); a.click();
            setTimeout(() => { a.remove(); URL.revokeObjectURL(dlUrl); activeObjectUrls.delete(dlUrl); clearProgress(); }, 3000);
        } catch (e) { reportError(e, 'triggerDownload: ' + filename); clearProgress(); }
    }

    async function handleVideoAction(video, customName = null) {
        const name = customName || video.filename || smartName();
        const ext = optFFExt.replace('.', '') || 'mp4';
        const filename = name.endsWith(`.${ext}`) ? name : name.replace(/\.[^/.]+$/, "") + `.${ext}`;
        const shareUrl = video.url || location.href;

        // 1. Instant Clipboard Backup (Preserves User Gesture)
        if (optFallbackClip) {
            try { if (typeof GM_setClipboard !== 'undefined') GM_setClipboard(shareUrl, 'text'); else navigator.clipboard.writeText(shareUrl); notify('link copied', 'success'); }
            catch (e) { warn('clipboard failed'); }
        }

        // 2. Share URL Mode
        if (optShareMode === 'url') {
            if (navigator.share) {
                try { await navigator.share({ title: filename, url: shareUrl }); notify('shared url', 'success'); return; }
                catch (e) { if (e.name !== 'AbortError') notify('share failed', 'warn'); }
            }
            return; // Exit early if URL mode
        }

        // 3. Fetch Phase
        setProgress(0, 'dl');
        try {
            let blob = null;
            if (video.type === 'm3u8') {
                blob = await downloadM3U8Video(video);
                // Post-Fetch Muxing Check
                if (optMuxHLS) blob = await processFFmpeg(blob, filename, true);
            } else {
                notify('downloading...', 'info');
                blob = await fetchBlob(video.url);
                // Post-Fetch Remuxing Check
                if (optRemuxDirect) blob = await processFFmpeg(blob, filename, false);
            }

            setProgress(100, 'done');

            // 4. Output Waterfall
            let shared = false;
            if (optShareMode === 'file' && navigator.canShare) {
                try {
                    const file = new File([blob], filename, { type: blob.type });
                    if (navigator.canShare({ files: [file] })) {
                        await navigator.share({ title: filename, files: [file] });
                        shared = true; notify('shared file', 'success'); clearProgress();
                    }
                } catch (e) { if (e.name !== 'AbortError') warn('file share failed, falling back', e); }
            }

            if (!shared && optFallbackDl) {
                triggerDownload(blob, filename);
            } else if (!shared) {
                clearProgress();
            }
        } catch (e) { clearProgress(); reportError(e, 'processVideo: ' + video.url); }
    }

    // Twitter Logic
    function parseTwResponse(data) { try { walkTw(data, 0); } catch (_) {} }
    function walkTw(obj, d) {
        if (d > 20 || !obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(x => walkTw(x, d + 1)); return; }
        if (obj.rest_id && obj.legacy?.extended_entities?.media) {
            const vids = [];
            for (const m of obj.legacy.extended_entities.media) {
                if (m.type !== 'video' && m.type !== 'animated_gif') continue;
                const mp4s = (m.video_info?.variants || []).filter(v => v.content_type === 'video/mp4');
                if (!mp4s.length) continue;
                const best = mp4s.reduce((a, b) => (a.bitrate||0) > (b.bitrate||0) ? a : b);
                vids.push({ url: best.url, bitrate: best.bitrate || 0 });
            }
            if (vids.length) { twitterCache.set(obj.rest_id, vids); }
        }
        for (const k of Object.keys(obj)) walkTw(obj[k], d + 1);
    }
    function gmGet(url) {
        return new Promise((res, rej) => {
            GM_xmlhttpRequest({ method: 'GET', url, anonymous: false, headers: { authorization: `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`, 'x-csrf-token': getCookie('ct0'), 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes', 'x-twitter-client-language': 'en', 'content-type': 'application/json' }, responseType: 'json', onload: r => (r.status >= 200 && r.status < 300 && r.response) ? res(r.response) : rej(new Error('http ' + r.status)), onerror: () => rej(new Error('network')) });
        });
    }
    async function fetchTwGraphQL(id) {
        const vars = encodeURIComponent(JSON.stringify({ tweetId: id, withCommunity: false, includePromotedContent: false, withVoice: false }));
        const feat = encodeURIComponent(JSON.stringify({ creator_subscriptions_tweet_preview_api_enabled: true, longform_notetweets_consumption_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true }));
        for (const qid of ['xOhkmRac04YFZmOzU9PJHg','B9_KmbkLhXt6jRwGjJrweg','DJS3BdhUhcaEpZ7B7irJDg']) { try { return await gmGet(`https://x.com/i/api/graphql/${qid}/TweetResultByRestId?variables=${vars}&features=${feat}`); } catch (_) { continue; } }
        throw new Error('all graphql ids failed');
    }
    function extractTwVideos(data) {
        try {
            const r = data?.data?.tweetResult?.result || data; const t = r?.tweet || r; const l = t?.legacy || t; const media = (l?.extended_entities || t?.extended_entities)?.media;
            if (!media) return null; const out = [];
            for (const m of media) {
                if (m.type !== 'video' && m.type !== 'animated_gif') continue;
                const mp4s = (m.video_info?.variants || []).filter(v => v.content_type === 'video/mp4');
                if (!mp4s.length) continue;
                const best = mp4s.reduce((a, b) => (a.bitrate||0) > (b.bitrate||0) ? a : b);
                out.push({ url: best.url, width: m.original_info?.width || 0, height: m.original_info?.height || 0 });
            }
            return out.length ? out : null;
        } catch { return null; }
    }
    function getTweetId(el) {
        const tl = el.querySelector('time')?.closest('a'); if (tl?.href) { const m = tl.href.match(/\/status\/(\d+)/); if (m) return m[1]; }
        for (const a of el.querySelectorAll('a[href*="/status/"]')) { const m = a.href.match(/\/status\/(\d+)/); if (m) return m[1]; }
        return null;
    }
    function getTwUser(el) {
        const art = el.closest('article') || el;
        for (const a of art.querySelectorAll('a[href^="/"]')) { const m = a.href.match(/^https?:\/\/[^/]+\/([A-Za-z0-9_]+)(?:\/|$)/); if (m && !['home','explore','notifications','messages','i','settings','search'].includes(m[1])) return m[1]; }
        return 'user';
    }
    async function downloadTwVideo(btn, tweetId, userId) {
        btn.classList.add('loading'); btn.innerHTML = I.spin;
        try {
            let vids = twitterCache.get(tweetId);
            if (!vids) { try { const data = await Promise.any([ fetchTwGraphQL(tweetId), gmGet(`https://api.twitter.com/1.1/statuses/show.json?id=${tweetId}&tweet_mode=extended&include_entities=true`).then(d => ({ legacy: d })) ]); vids = extractTwVideos(data); } catch (_) { vids = null; } }
            if (!vids?.length) { for (const v of document.querySelectorAll('video')) { const src = v.src || v.currentSrc; if (!src?.includes('video.twimg.com')) continue; const art = v.closest('article[data-testid="tweet"]'); if (art && getTweetId(art) === tweetId) { vids = [{ url: src }]; break; } } }
            if (!vids?.length) throw new Error('no video in tweet ' + tweetId);
            const cleanUrl = vids[0].url.split('?')[0];
            handleVideoAction({ url: cleanUrl, type: 'direct' }, `${userId}_${tweetId}`);
            btn.classList.remove('loading'); btn.classList.add('ok'); btn.innerHTML = I.check;
            setTimeout(() => { btn.classList.remove('ok'); btn.innerHTML = I.dl; }, 2500);
        } catch (e) {
            clearProgress(); reportError(e, 'twitter download ' + tweetId);
            btn.classList.remove('loading'); btn.classList.add('fail'); btn.innerHTML = I.cross;
            setTimeout(() => { btn.classList.remove('fail'); btn.innerHTML = I.dl; }, 3000);
        }
    }
    function hasTweetVideo(tweet) { return !!(tweet.querySelector('div[data-testid="videoPlayer"], video') || tweet.querySelector('img[src*="tweet_video_thumb"], img[src*="ext_tw_video_thumb"], img[src*="amplify_video_thumb"]')); }
    function injectTwButtons() {
        document.querySelectorAll('article[data-testid="tweet"]').forEach(tweet => {
            const bar = tweet.querySelector('div[role="group"]');
            if (!bar || bar.querySelector('.uvs-tw') || !hasTweetVideo(tweet)) return;
            const id = getTweetId(tweet); if (!id) return; const user = getTwUser(tweet);
            const btn = document.createElement('button'); btn.className = 'uvs-tw'; btn.title = 'download video'; btn.innerHTML = I.dl;
            btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (!btn.classList.contains('loading')) downloadTwVideo(btn, id, user); });
            bar.appendChild(btn);
        });
    }

    // UI Construction
    function initShadowDOM() {
        if (_shadowHost && document.documentElement.contains(_shadowHost)) return;
        _shadowHost = document.createElement('div'); _shadowHost.id = 'uvs-host';
        _shadowHost.style.cssText = 'position:fixed; top:0; left:0; width:0; height:0; z-index:2147483647; overflow:visible;';
        _shadow = _shadowHost.attachShadow({ mode: 'closed' });
        const style = document.createElement('style'); style.textContent = SHADOW_CSS; _shadow.appendChild(style);
        document.documentElement.appendChild(_shadowHost);
    }

    function createUI() {
        initShadowDOM(); if (_wrap && _shadow.contains(_wrap)) return;

        _dot = document.createElement('div'); _dot.id = 'uvs-dot'; _dot.className = `pos-${uiPosition}`; _dot.title = 'show downloader (alt+shift+v)';
        _dot.style.display = isHidden ? 'block' : 'none'; _dot.addEventListener('click', () => setStealth(false)); _shadow.appendChild(_dot);

        _wrap = document.createElement('div'); _wrap.id = 'uvs-wrap'; _wrap.className = `pos-${uiPosition}`;
        if (isHidden) _wrap.classList.add('hidden');

        _wrap.style.opacity = uiOpacity;
        _wrap.addEventListener('mouseenter', () => _wrap.style.opacity = '1');
        _wrap.addEventListener('mouseleave', () => _wrap.style.opacity = uiOpacity);

        const rsvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); rsvg.setAttribute('width', '48'); rsvg.setAttribute('height', '48'); rsvg.id = 'uvs-ring-svg';
        const mkCirc = (attrs) => { const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); Object.entries(attrs).forEach(([k,v]) => c.setAttribute(k, v)); return c; };
        rsvg.appendChild(mkCirc({ cx:'24', cy:'24', r:'22', fill:'none', stroke:T.success, 'stroke-width':'2', 'stroke-opacity':'0.15' }));

        const ring = mkCirc({ id:'uvs-ring', cx:'24', cy:'24', r:'22', fill:'none', stroke:T.success, 'stroke-width':'2.5', 'stroke-linecap':'round' });
        ring.style.strokeDashoffset = '138.2';
        rsvg.appendChild(ring); _wrap.appendChild(rsvg);

        _btn = document.createElement('div'); _btn.id = 'uvs-btn'; _btn.innerHTML = I.dl;
        const badge = document.createElement('div'); badge.id = 'uvs-count'; badge.style.display = 'none'; _btn.appendChild(badge);

        let t0 = 0, pressTimer;
        const handleDown = (e) => {
            if (e.button && e.button !== 0) return;
            t0 = Date.now(); _btn.style.transform = 'scale(0.92)';
            pressTimer = setTimeout(() => { _btn.style.transform = 'scale(1.05)'; if ('vibrate' in navigator) navigator.vibrate(50); }, 600);
        };
        const handleUp = (e) => {
            if (!t0) return; const dt = Date.now() - t0; t0 = 0; clearTimeout(pressTimer); _btn.style.transform = '';
            if (dt >= 5000) { setStealth(true); } else if (dt >= 600) { handleForceMenu(); } else { handleClick(); }
        };

        _btn.addEventListener('mousedown', handleDown); _btn.addEventListener('mouseup', handleUp);
        _btn.addEventListener('touchstart', handleDown, { passive: true }); _btn.addEventListener('touchend', handleUp);
        _btn.addEventListener('mouseleave', () => { clearTimeout(pressTimer); t0 = 0; _btn.style.transform = ''; });
        _btn.addEventListener('touchcancel', () => { clearTimeout(pressTimer); t0 = 0; _btn.style.transform = ''; });
        _btn.addEventListener('contextmenu', (e) => { e.preventDefault(); handleForceMenu(); });

        _wrap.appendChild(_btn); _shadow.appendChild(_wrap);
    }

    function guardUI() { if (!_shadowHost || !document.documentElement.contains(_shadowHost) || !_wrap || !_shadow.contains(_wrap)) { _shadowHost = null; _shadow = null; _wrap = null; _btn = null; createUI(); } }

    function updateBtn() {
        guardUI(); if (!_btn) return;
        const n = videos.size; const badge = _shadow.querySelector('#uvs-count');
        if (n > 1) { _btn.innerHTML = I.menu + (badge?.outerHTML || ''); if (badge) { badge.textContent = String(n); badge.style.display = 'flex'; } }
        else { _btn.innerHTML = I.dl + (badge?.outerHTML || ''); if (badge) badge.style.display = 'none'; }
    }

    function setStealth(hide) {
        isHidden = hide !== undefined ? hide : !isHidden; GM_setValue('uvs_hidden', isHidden);
        if (_wrap) _wrap.classList.toggle('hidden', isHidden); if (_dot) _dot.style.display = isHidden ? 'block' : 'none';
        if (!isHidden) notify('downloader shown', 'success');
    }

    window.addEventListener('keydown', e => { if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'v') setStealth(); });

    function handleClick() {
        const vids = sortedVideos(); if (!vids.length) { notify('no videos detected yet', 'warn'); return; }
        if (vids.length === 1) { handleVideoAction(vids[0]); return; }
        if (optDefaultAction === 'play') { const playing = vids.find(v => v.isPlaying); if (playing) { handleVideoAction(playing); return; } }
        else if (optDefaultAction === 'best') { const best = [...vids].sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.size - a.size)[0]; if (best) { handleVideoAction(best); return; } }
        showModal(vids);
    }

    function handleForceMenu() { const vids = sortedVideos(); if (!vids.length) { notify('no videos detected yet', 'warn'); return; } showModal(vids); }

    function showSettings() {
        const existingOverlay = _shadow.querySelector('#uvs-overlay'); if (existingOverlay) existingOverlay.remove();
        const overlay = document.createElement('div'); overlay.id = 'uvs-overlay';
        const modal = document.createElement('div'); modal.id = 'uvs-modal';

        const hdr = document.createElement('div'); hdr.className = 'uvs-mhdr';
        const closeBtn = document.createElement('button'); closeBtn.className = 'uvs-mbtn'; closeBtn.innerHTML = I.cross;
        closeBtn.addEventListener('click', () => overlay.remove());
        const backBtn = document.createElement('button'); backBtn.className = 'uvs-mbtn'; backBtn.innerHTML = I.back;
        backBtn.addEventListener('click', () => { overlay.remove(); if (videos.size > 0) showModal(sortedVideos()); });

        const actions = document.createElement('div'); actions.className = 'uvs-hdr-actions';
        actions.appendChild(backBtn); actions.appendChild(closeBtn);
        hdr.innerHTML = `<span class="uvs-mtitle">${I.gear} Settings</span>`; hdr.appendChild(actions); modal.appendChild(hdr);

        const content = document.createElement('div'); content.className = 'uvs-settings';
        content.innerHTML = `
            <div class="uvs-s-group">
                <div class="uvs-s-title">General</div>
                <div class="uvs-s-row"><div class="uvs-s-label">Scan Interval <span class="uvs-s-sub">Seconds between DOM scans</span></div><input type="number" id="s-interval" class="uvs-input" step="0.1" min="0.5" max="10" value="${optScanInterval}"></div>
                <div class="uvs-s-row"><div class="uvs-s-label">Default Action <span class="uvs-s-sub">When multiple videos are found</span></div><select id="s-action" class="uvs-select"><option value="menu" ${optDefaultAction === 'menu' ? 'selected' : ''}>Open Menu</option><option value="play" ${optDefaultAction === 'play' ? 'selected' : ''}>Auto-DL Playing</option><option value="best" ${optDefaultAction === 'best' ? 'selected' : ''}>Auto-DL Best Quality</option></select></div>
                <div class="uvs-s-row"><div class="uvs-s-label">Share Mode <span class="uvs-s-sub">Share link or downloaded file</span></div><select id="s-share" class="uvs-select"><option value="url" ${optShareMode === 'url' ? 'selected' : ''}>Share URL (Fast)</option><option value="file" ${optShareMode === 'file' ? 'selected' : ''}>Share File (Slow)</option></select></div>
            </div>
            <div class="uvs-s-group">
                <div class="uvs-s-title">Interface</div>
                <div class="uvs-s-row"><div class="uvs-s-label">Button Position</div><select id="s-pos" class="uvs-select"><option value="tl" ${uiPosition === 'tl' ? 'selected' : ''}>Top Left</option><option value="tr" ${uiPosition === 'tr' ? 'selected' : ''}>Top Right</option><option value="cl" ${uiPosition === 'cl' ? 'selected' : ''}>Center Left</option><option value="cr" ${uiPosition === 'cr' ? 'selected' : ''}>Center Right</option><option value="bl" ${uiPosition === 'bl' ? 'selected' : ''}>Bottom Left</option><option value="br" ${uiPosition === 'br' ? 'selected' : ''}>Bottom Right</option></select></div>
                <div class="uvs-s-row"><div class="uvs-s-label">Button Opacity <span class="uvs-s-sub" id="s-op-val">${Math.round(uiOpacity * 100)}%</span></div><input type="range" id="s-opacity" class="uvs-input" min="0" max="1" step="0.05" value="${uiOpacity}"></div>
            </div>
            <div class="uvs-s-group">
                <div class="uvs-s-title">Advanced Engine</div>
                <div class="uvs-s-row"><div class="uvs-s-label">Mux HLS Playlists <span class="uvs-s-sub">Convert .ts segments to MP4</span></div><label class="uvs-toggle"><input type="checkbox" id="s-mux-hls" ${optMuxHLS ? 'checked' : ''}><span class="uvs-slider"></span></label></div>
                <div class="uvs-s-row"><div class="uvs-s-label">Remux Direct MP4s <span class="uvs-s-sub">Fixes broken headers (Slow)</span></div><label class="uvs-toggle"><input type="checkbox" id="s-remux-dir" ${optRemuxDirect ? 'checked' : ''}><span class="uvs-slider"></span></label></div>
                <div class="uvs-s-row"><div class="uvs-s-label">Custom FFmpeg Args <span class="uvs-s-sub">Leave blank for default</span></div><input type="text" id="s-ff-args" class="uvs-input" placeholder="-c copy -movflags faststart" value="${optFFArgs}"></div>
                <div class="uvs-s-row"><div class="uvs-s-label">Output Extension <span class="uvs-s-sub">Default: mp4</span></div><input type="text" id="s-ff-ext" class="uvs-input" style="width:60px; text-align:center;" value="${optFFExt}"></div>
                <div class="uvs-s-row"><div class="uvs-s-label">Fallback: Clipboard <span class="uvs-s-sub">Copy URL if share fails</span></div><label class="uvs-toggle"><input type="checkbox" id="s-fb-clip" ${optFallbackClip ? 'checked' : ''}><span class="uvs-slider"></span></label></div>
                <div class="uvs-s-row"><div class="uvs-s-label">Fallback: Download <span class="uvs-s-sub">Save to disk if share fails</span></div><label class="uvs-toggle"><input type="checkbox" id="s-fb-dl" ${optFallbackDl ? 'checked' : ''}><span class="uvs-slider"></span></label></div>
            </div>
            <div class="uvs-s-group">
                <div class="uvs-s-title">Data & Privacy</div>
                <div class="uvs-s-row"><div class="uvs-s-label">Debug Mode <span class="uvs-s-sub">Print logs to console</span></div><label class="uvs-toggle"><input type="checkbox" id="s-debug" ${optDebug ? 'checked' : ''}><span class="uvs-slider"></span></label></div>
                <div class="uvs-s-row"><div class="uvs-s-label">Blacklist <span class="uvs-s-sub">Disable on ${location.hostname}</span></div><button id="s-bl" class="uvs-btn-sm danger">Blacklist Site</button></div>
                <div class="uvs-s-row"><div class="uvs-s-label">Clear Memory <span class="uvs-s-sub">Free RAM & revoke blobs</span></div><button id="s-clear" class="uvs-btn-sm">Clear Cache</button></div>
            </div>
        `;

        modal.appendChild(content); overlay.appendChild(modal); _shadow.appendChild(overlay);

        content.querySelector('#s-interval').addEventListener('change', (e) => { optScanInterval = parseFloat(e.target.value) || 6.0; GM_setValue('uvs_scan_interval', optScanInterval); currentInterval = optScanInterval * 1000; });
        content.querySelector('#s-action').addEventListener('change', (e) => { optDefaultAction = e.target.value; GM_setValue('uvs_default_action', optDefaultAction); });
        content.querySelector('#s-share').addEventListener('change', (e) => { optShareMode = e.target.value; GM_setValue('uvs_share_mode', optShareMode); });
        content.querySelector('#s-pos').addEventListener('change', (e) => { uiPosition = e.target.value; GM_setValue('uvs_position', uiPosition); _wrap.className = `pos-${uiPosition}`; _dot.className = `pos-${uiPosition}`; if (_toastBox) _toastBox.className = `pos-${uiPosition}`; });
        content.querySelector('#s-opacity').addEventListener('input', (e) => { uiOpacity = parseFloat(e.target.value); content.querySelector('#s-op-val').textContent = `${Math.round(uiOpacity * 100)}%`; _wrap.style.opacity = uiOpacity; GM_setValue('uvs_opacity', uiOpacity); });

        content.querySelector('#s-mux-hls').addEventListener('change', (e) => { optMuxHLS = e.target.checked; GM_setValue('uvs_mux_hls', optMuxHLS); });
        content.querySelector('#s-remux-dir').addEventListener('change', (e) => { optRemuxDirect = e.target.checked; GM_setValue('uvs_remux_direct', optRemuxDirect); });
        content.querySelector('#s-ff-args').addEventListener('change', (e) => { optFFArgs = e.target.value; GM_setValue('uvs_ff_args', optFFArgs); });
        content.querySelector('#s-ff-ext').addEventListener('change', (e) => { optFFExt = e.target.value.replace('.', ''); GM_setValue('uvs_ff_ext', optFFExt); });
        content.querySelector('#s-fb-clip').addEventListener('change', (e) => { optFallbackClip = e.target.checked; GM_setValue('uvs_fallback_clip', optFallbackClip); });
        content.querySelector('#s-fb-dl').addEventListener('change', (e) => { optFallbackDl = e.target.checked; GM_setValue('uvs_fallback_dl', optFallbackDl); });

        content.querySelector('#s-debug').addEventListener('change', (e) => { optDebug = e.target.checked; GM_setValue('uvs_debug', optDebug); });
        content.querySelector('#s-bl').addEventListener('click', () => { optBlacklist.push(location.hostname); GM_setValue('uvs_blacklist', optBlacklist); location.reload(); });
        content.querySelector('#s-clear').addEventListener('click', (e) => { blobCache.clear(); activeObjectUrls.forEach(url => URL.revokeObjectURL(url)); activeObjectUrls.clear(); videos.clear(); updateBtn(); e.target.textContent = 'Cleared!'; setTimeout(() => e.target.textContent = 'Clear Cache', 2000); });

        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    function showModal(vids) {
        const existingOverlay = _shadow.querySelector('#uvs-overlay'); if (existingOverlay) existingOverlay.remove();
        const overlay = document.createElement('div'); overlay.id = 'uvs-overlay';
        const modal = document.createElement('div'); modal.id = 'uvs-modal';

        const hdr = document.createElement('div'); hdr.className = 'uvs-mhdr';
        const closeBtn = document.createElement('button'); closeBtn.className = 'uvs-mbtn'; closeBtn.innerHTML = I.cross;
        closeBtn.addEventListener('click', () => overlay.remove());
        const gearBtn = document.createElement('button'); gearBtn.className = 'uvs-mbtn'; gearBtn.innerHTML = I.gear;
        gearBtn.addEventListener('click', () => { overlay.remove(); showSettings(); });

        const actions = document.createElement('div'); actions.className = 'uvs-hdr-actions';
        actions.appendChild(gearBtn); actions.appendChild(closeBtn);
        hdr.innerHTML = `<span class="uvs-mtitle">select video (${vids.length})</span>`; hdr.appendChild(actions); modal.appendChild(hdr);

        const list = document.createElement('div'); list.className = 'uvs-list';
        const groups = {};
        vids.forEach(v => {
            let res = 0; if (v.height) res = v.height; else if (v.label) { const m = v.label.match(/(\d+)p?/i); if (m) res = parseInt(m[1]); }
            let key = res ? `${res}P` : 'UNKNOWN'; if (v.isPlaying) key = 'NOW PLAYING';
            if (!groups[key]) groups[key] = []; groups[key].push(v);
        });

        const sortedKeys = Object.keys(groups).sort((a, b) => {
            if (a === 'NOW PLAYING') return -1; if (b === 'NOW PLAYING') return 1;
            if (a === 'UNKNOWN') return 1; if (b === 'UNKNOWN') return -1;
            return parseInt(b) - parseInt(a);
        });

        sortedKeys.forEach(key => {
            const groupHdr = document.createElement('div'); groupHdr.className = 'uvs-group-hdr'; groupHdr.textContent = key; list.appendChild(groupHdr);
            groups[key].forEach(v => {
                const item = document.createElement('div'); item.className = 'uvs-item';
                let badges = '';
                if (v.label && key === 'NOW PLAYING') badges += `<span class="uvs-badge src">${v.label}</span>`;
                if (v.source) badges += `<span class="uvs-badge src">${v.source}</span>`;
                if (v.width && v.height && key !== `${v.height}P`) badges += `<span class="uvs-badge ${v.width >= 1280 || v.height >= 720 ? 'hd' : ''}">${v.width}x${v.height}</span>`;
                if (v.duration) badges += `<span class="uvs-badge">${fmtDur(v.duration)}</span>`;
                if (v.size) badges += `<span class="uvs-badge sz">${fmtBytes(v.size)}</span>`;

                const microLabel = v.type === 'm3u8' ? 'HLS' : 'MP4';
                item.innerHTML = `<div class="uvs-iico">${I.dl}<span class="uvs-imicro">${microLabel}</span></div><div class="uvs-iinfo"><div class="uvs-iname" title="${v.url}">${v.filename}</div><div class="uvs-imeta">${badges}</div></div>`;
                item.addEventListener('click', () => { overlay.remove(); handleVideoAction(v); }); list.appendChild(item);
            });
        });

        modal.appendChild(list); overlay.appendChild(modal); _shadow.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    // Initialization
    createUI(); initPowerMode();

    function scheduleNextScan() {
        if (_scanTimer) clearTimeout(_scanTimer);
        _scanTimer = setTimeout(() => {
            const run = () => { masterScan(); scheduleNextScan(); };
            if (window.requestIdleCallback && !isHidden) { requestIdleCallback(run, { timeout: 2000 }); } else { run(); }
        }, currentInterval);
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => { masterScan(); runExtractors(); scheduleNextScan(); }); }
    else { masterScan(); runExtractors(); scheduleNextScan(); }

    const obs = new MutationObserver(() => { if (!isHidden) scanDOM(); guardUI(); if (isTwitter) injectTwButtons(); });
    const bodyWait = setInterval(() => { if (!document.body) return; clearInterval(bodyWait); obs.observe(document.body, { childList: true, subtree: true }); if (isTwitter) injectTwButtons(); }, 50);
    window.addEventListener('load', () => { masterScan(); runExtractors(); });

})();