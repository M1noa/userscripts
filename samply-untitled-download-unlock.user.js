// ==UserScript==
// @name         samply & untitled download unlocker
// @version      1.5
// @description  makes the export/download button appear on all albums no matter what, so you can save them for archival purposes. works on samply.app and untitled.stream.
// @author       minoa
// @license      mit
// @match        https://samply.app/*
// @match        https://untitled.stream/*
// @run-at       document-start
// @grant        none
// @noframes
// @namespace    https://greasyfork.org/en/users/1268587-minoa
// @downloadURL https://update.greasyfork.org/scripts/575043/samply%20%20untitled%20download%20unlocker.user.js
// @updateURL https://update.greasyfork.org/scripts/575043/samply%20%20untitled%20download%20unlocker.meta.js
// ==/UserScript==

(function () {
  'use strict';

  const tag = 'album-unlock';
  const debug = (...args) => console.debug(`[${tag}]`, ...args);
  const warn = (...args) => console.warn(`[${tag}]`, ...args);

  const host = location.hostname;

  // ------------------------------------------------------------------
  // samply.app — flip the client-side allowdownloads flag in the pinia
  // "player" store so candownload() returns true and the download button
  // renders. the app then fetches the real file via its own already-authed
  // firebase storage call; storage rules still authorize server-side.
  // ------------------------------------------------------------------
  function initSamply() {
    const pollMs = 750;

    function getStore() {
      try {
        const el = document.querySelector('#app');
        const app = el && el.__vue_app__;
        if (!app) return null;
        const pinia = app.config && app.config.globalProperties && app.config.globalProperties.$pinia;
        if (!pinia || !pinia._s) return null;
        // store id "player" matches defineStore("player", ...) in usePlayerStore.*.js
        return pinia._s.get('player') || null;
      } catch (e) {
        warn('samply: getstore failed', e);
        return null;
      }
    }

    function unlock() {
      let store;
      try {
        store = getStore();
      } catch (e) {
        warn('samply: unlock threw before store', e);
        return false;
      }
      if (!store) return false;

      const doc = store.playerDocumentData;
      if (!doc) return false;

      let touched = false;

      // gate 1: allowdownloads. makes the player-allow-download plan check pass and the button render.
      if (doc.config) {
        if (doc.config.allowDownloads !== true) {
          doc.config.allowDownloads = true;
          touched = true;
        }
      } else {
        doc.config = { allowDownloads: true };
        touched = true;
      }

      // gate 2: if downloads are locked behind a paywall (payment.download), drop the lock locally
      // so candownload()'s !lockdownloadbehindpayment term passes. storage rules still authorize
      // the actual getdownloadurl call server-side.
      if (doc.accessLockType === 'payment.download' && doc.accessLockActive !== false) {
        doc.accessLockActive = false;
        touched = true;
      }

      if (touched) {
        const extras = doc.accessLockType === 'payment.download' ? ' (+ paywall dropped)' : '';
        debug('samply: flipped allowdownloads=true' + extras);
      }
      return touched;
    }

    let interval = null;
    function start() {
      if (interval) return;
      interval = setInterval(unlock, pollMs);
      debug('samply: active - polling for player store');
    }
    function stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    }

    // wait for dom ready before trying to access #app, then poll because
    // firestore onsnapshot overwrites the doc object on changes.
    try {
      if (document.readyState !== 'loading') {
        unlock();
      } else {
        document.addEventListener('DOMContentLoaded', unlock, { once: true });
      }
    } catch (e) {
      warn('samply: initial unlock threw', e);
    }

    start();
    window.addEventListener('pagehide', stop, { once: true });
  }

  // ------------------------------------------------------------------
  // untitled.stream — trap the initial remix context injection and patch
  // fetched api responses so download/edit/move permission flags are
  // permissive. fixes the ui on direct page load and the zip export flow.
  // ------------------------------------------------------------------
  function initUntitled() {
    // deeply traverse and patch any object to force permissive access.
    function deepPatch(obj, seen) {
      if (!obj || typeof obj !== 'object') return false;
      if (!seen) seen = new WeakSet();
      if (seen.has(obj)) return false;
      seen.add(obj);

      let patched = false;

      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          if (deepPatch(obj[i], seen)) patched = true;
        }
        return patched;
      }

      // flip specific permission flags to true if they exist.
      const keysToTrue = [
        'downloadable',
        'can_download_project',
        'can_download_track',
        'editable',
        'edit_toggle',
        'can_move',
        'can_move_into',
        'can_leave',
        'can_mute'
      ];
      for (const key of keysToTrue) {
        if (key in obj && obj[key] !== true) {
          obj[key] = true;
          patched = true;
        }
      }

      if ('access_role' in obj && obj.access_role !== 'owner') {
        obj.access_role = 'owner';
        patched = true;
      }
      if ('access_type' in obj && obj.access_type !== 'public') {
        obj.access_type = 'public';
        patched = true;
      }

      // recursively check all own children.
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (deepPatch(obj[key], seen)) patched = true;
        }
      }

      return patched;
    }

    // intercept initial remix context injection (fixes ui on direct page load).
    // must run at document-start before the app assigns window.__remixContext.
    let rawContext;
    try {
      Object.defineProperty(window, '__remixContext', {
        get: () => rawContext,
        set: (val) => {
          try {
            if (deepPatch(val)) debug('untitled: patched initial remix context');
          } catch (e) {
            warn('untitled: remix context patch threw', e);
          }
          rawContext = val;
        },
        configurable: true
      });
    } catch (e) {
      warn('untitled: failed to define __remixContext trap', e);
    }

    // intercept all fetch requests to catch background api calls (fixes zip export).
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);

      // only intercept successful json responses to save performance.
      const contentType = res.headers.get('content-type');
      if (!res.ok || !contentType || !contentType.includes('application/json')) {
        return res;
      }

      try {
        const clone = res.clone();
        const json = await clone.json();
        if (deepPatch(json)) {
          const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || 'unknown';
          debug('untitled: patched fetch response for', url);
          return new Response(JSON.stringify(json), {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers
          });
        }
      } catch (e) {
        // ignore parse errors and fall through to the original response.
      }

      return res;
    };

    debug('untitled: active - remix context trap and fetch interception installed');
  }

  // ------------------------------------------------------------------
  // dispatch by host so each site's logic stays isolated.
  // ------------------------------------------------------------------
  try {
    if (host === 'samply.app' || host.endsWith('.samply.app')) {
      initSamply();
    } else if (host === 'untitled.stream' || host.endsWith('.untitled.stream')) {
      initUntitled();
    }
  } catch (e) {
    warn('top-level init threw', e);
  }
})();
