// ==UserScript==
// @name         Twitter Polished Media Downloader
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      1.9.8
// @description  Adds a native-looking download button to X/Twitter: highest-quality downloads (works on NSFW-gated posts), reliable multi-file downloads (zipped), selective downloading, link unshortening (removes t.co from focused tweets), and raw tweet/profile data export via the share menu.
// @author       Minoa
// @license      MIT
// @homepageURL  https://gitlab.com/M1noa/userscripts
// @supportURL   https://gitlab.com/M1noa/userscripts/-/issues
// @match        https://twitter.com/*
// @match        https://x.com/*
// @run-at       document-start
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      twitter.com
// @connect      x.com
// @connect      twimg.com
// @connect      video.twimg.com
// @connect      api.vxtwitter.com
// @connect      cdn.syndication.twimg.com
// @require      https://unpkg.com/jszip@3.7.1/dist/jszip.js
// @noframes
// @downloadURL  https://update.greasyfork.org/scripts/586507/Twitter%20Polished%20Media%20Downloader.user.js
// @updateURL    https://update.greasyfork.org/scripts/586507/Twitter%20Polished%20Media%20Downloader.meta.js
// ==/UserScript==

(function () {
  'use strict';

  // --- configuration & state ---
  const BUTTON_CLASS = 'tmd-download-btn';
  const FALLBACK_BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const DEBUG_MODE = true;

  const state = {
    interceptedHeaders: null,
    queryIds: {
      TweetDetail: 'jd3V43oDY9cY7obs1YMfbQ',
      TweetResultByRestId: '2ICDjqPd81tulZcYrtpTuQ',
      UserResultByScreenName: 'gSmsL79uS4b8T-9N2XdQVQ'
    },
    tweetCache: new Map(),
    profileCache: new Map(),
    videoCache: new Map(),
    lastRightClickedTweet: null,
    lastRightClickTime: 0
  };

  function dbg(msg, data = null) {
    if (DEBUG_MODE) {
      if (data) console.log(`[TMD-DEBUG] ${msg}`, data);
      else console.log(`[TMD-DEBUG] ${msg}`);
    }
  }

  // --- stylesheet injection ---
  const style = document.createElement('style');
  style.textContent = `
    @property --tmd-progress {
      syntax: '<number>';
      inherits: false;
      initial-value: 0;
    }

    :root {
      --tmd-theme-color: rgb(29, 155, 240);
      --tmd-hover-bg: rgba(29, 155, 240, 0.1);
      --tmd-icon-color: rgb(113, 118, 123);
    }

    .${BUTTON_CLASS} .css-146c3p1 {
      color: var(--tmd-icon-color) !important;
      transition: color 0.2s ease !important;
    }

    .${BUTTON_CLASS}:hover .css-146c3p1 {
      color: var(--tmd-theme-color) !important;
    }

    .${BUTTON_CLASS}:hover .r-xf4iuw {
      background-color: var(--tmd-hover-bg) !important;
    }

    .${BUTTON_CLASS}.loading svg {
      animation: tmd-pulse 0.8s ease-in-out infinite alternate;
    }
    @keyframes tmd-pulse {
      from { opacity: 0.35; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1.05); }
    }

    .${BUTTON_CLASS} .r-xf4iuw {
      --tmd-progress: 0;
      transition: --tmd-progress 0.2s linear, background-color 0.2s ease, opacity 0.35s ease;
    }

    .${BUTTON_CLASS}.loading .r-xf4iuw {
      opacity: 0.22;
      background-color: transparent !important;
      background-image: conic-gradient(
        var(--tmd-theme-color) 0% calc(var(--tmd-progress) * 1%),
        rgba(113, 118, 123, 0.1) calc(var(--tmd-progress) * 1%) 100%
      );
    }

    .tmd-picker-overlay {
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .tmd-picker-card {
      background: #fff;
      color: #0f1419;
      width: 90%;
      max-width: 420px;
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.3);
    }
    @media (prefers-color-scheme: dark) {
      .tmd-picker-card {
        background: #15202b;
        color: #f7f9f9;
      }
    }
    .tmd-picker-title {
      font-size: 18px;
      font-weight: 800;
      margin-bottom: 12px;
    }
    .tmd-picker-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      max-height: 280px;
      overflow-y: auto;
      margin-bottom: 16px;
      padding-right: 4px;
    }
    .tmd-picker-item {
      position: relative;
      aspect-ratio: 1;
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      border: 2px solid transparent;
    }
    .tmd-picker-item.selected {
      border-color: var(--tmd-theme-color);
    }
    .tmd-picker-item img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .tmd-picker-checkbox {
      position: absolute;
      top: 6px;
      left: 6px;
      width: 18px;
      height: 18px;
      accent-color: var(--tmd-theme-color);
    }
    .tmd-picker-badge {
      position: absolute;
      bottom: 6px;
      right: 6px;
      background: rgba(0,0,0,0.7);
      color: #fff;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: bold;
    }
    .tmd-picker-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    .tmd-picker-btn {
      padding: 8px 16px;
      border-radius: 9999px;
      font-size: 14px;
      font-weight: 700;
      border: none;
      cursor: pointer;
    }
    .tmd-picker-btn.cancel {
      background: rgba(0,0,0,0.05);
      color: inherit;
    }
    @media (prefers-color-scheme: dark) {
      .tmd-picker-btn.cancel { background: rgba(255,255,255,0.1); }
    }
    .tmd-picker-btn.confirm {
      background: var(--tmd-theme-color);
      color: #fff;
    }
  `;
  document.head.appendChild(style);

  function log(msg) {
    console.log(`[TMD] ${msg}`);
  }

  function getTweetIdFromUrl() {
    const match = window.location.pathname.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  function updateThemeColors() {
    const verifiedIcon = document.querySelector('svg[data-testid="icon-verified"]');
    const homeIcon = document.querySelector('a[href="/home"] svg');
    const targetElement = verifiedIcon || homeIcon;
    if (targetElement) {
      const color = window.getComputedStyle(targetElement).color;
      if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'rgb(255, 255, 255)') {
        document.documentElement.style.setProperty('--tmd-theme-color', color);
        const match = color.match(/\d+/g);
        if (match && match.length >= 3) {
          document.documentElement.style.setProperty('--tmd-hover-bg', `rgba(${match[0]}, ${match[1]}, ${match[2]}, 0.1)`);
        }
      }
    }
  }

  function updateDownloadProgress(btn, percent) {
    const hoverBgCircle = btn.querySelector('.r-xf4iuw');
    if (hoverBgCircle) {
      hoverBgCircle.style.setProperty('--tmd-progress', Math.max(0, Math.min(100, percent)));
    }
  }

  function initNetworkInterceptor() {
    const origFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';

      if (url.includes('/graphql/')) {
        const headers = args[1]?.headers;
        if (headers) {
          const rawHeaders = headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;
          if (rawHeaders['authorization']) {
            state.interceptedHeaders = { ...rawHeaders };
            dbg('Captured authorization headers');
          }
        }

        const matches = url.match(/\/i\/api\/graphql\/([A-Za-z0-9_-]{15,25})\/([^?]+)/);
        if (matches) {
          const [, hash, queryName] = matches;
          if (Object.prototype.hasOwnProperty.call(state.queryIds, queryName)) {
            state.queryIds[queryName] = hash;
            dbg(`Live query-id update for ${queryName}: ${hash}`);
          }
        }
      }

      const response = await origFetch.apply(this, args);

      if (url.includes('/graphql/') && response.ok) {
        try {
          const clone = response.clone();
          clone.text().then(text => parseAndCacheRawData(text));
        } catch (e) {
          dbg('Failed cloning fetch response stream', e);
        }
      }
      return response;
    };

    const origOpen = unsafeWindow.XMLHttpRequest.prototype.open;
    const origSend = unsafeWindow.XMLHttpRequest.prototype.send;
    unsafeWindow.XMLHttpRequest.prototype.open = function (method, url) {
      this._url = url;
      return origOpen.apply(this, arguments);
    };
    unsafeWindow.XMLHttpRequest.prototype.send = function () {
      if (typeof this._url === 'string' && this._url.includes('/graphql/')) {
        this.addEventListener('load', function () {
          try {
            parseAndCacheRawData(this.responseText);
          } catch (e) {
            dbg('Failed to read XHR text stream', e);
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  function getScreenName(userObj) {
    return userObj?.core?.screen_name ?? userObj?.legacy?.screen_name ?? null;
  }

  function extractMediaFromLegacy(legacy) {
    const result = { videos: [], images: [], thumbs: [] };
    const mediaList = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
    mediaList.forEach(m => {
      if (m.type === 'photo') {
        const url = m.media_url_https + '?name=orig';
        if (!result.images.includes(url)) result.images.push(url);
      } else if (m.type === 'video' || m.type === 'animated_gif') {
        const variants = m.video_info?.variants || [];
        const best = variants
          .filter(v => v.content_type === 'video/mp4')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (best?.url) {
          const cleanUrl = best.url.split('?')[0];
          if (!result.videos.includes(cleanUrl)) {
            result.videos.push(cleanUrl);
            result.thumbs.push(m.media_url_https);
          }
        }
      }
    });
    return result;
  }

  function extractMediaFromTweetObj(tweetObj) {
    return extractMediaFromLegacy(tweetObj?.legacy);
  }

  function parseAndCacheRawData(responseText) {
    try {
      const data = JSON.parse(responseText);

      const cacheTweetObj = (tweetObj) => {
        if (!tweetObj || !tweetObj.legacy) return;
        const tweetId = tweetObj.legacy.id_str ?? tweetObj.rest_id;
        if (!tweetId) return;

        state.tweetCache.set(tweetId, { core: tweetObj, ts: Date.now() });
        dbg(`Cached raw tweet data for ID: ${tweetId}`);

        const extracted = extractMediaFromTweetObj(tweetObj);
        if (extracted.videos.length > 0) {
          state.videoCache.set(tweetId, { urls: extracted.videos, thumbs: extracted.thumbs, ts: Date.now() });
        }

        const author = tweetObj.core?.user_results?.result;
        const authorScreenName = getScreenName(author);
        if (author && authorScreenName) {
          state.profileCache.set(authorScreenName, author);
          dbg(`Cached raw profile data for user: ${authorScreenName}`);
        }

        const quotedObj = tweetObj.quoted_status_result?.result;
        if (quotedObj && quotedObj.legacy) {
          const quotedId = quotedObj.legacy.id_str ?? quotedObj.rest_id;
          if (quotedId) {
            state.tweetCache.set(quotedId, { core: quotedObj, ts: Date.now() });
            const quotedAuthor = quotedObj.core?.user_results?.result;
            const quotedScreenName = getScreenName(quotedAuthor);
            if (quotedAuthor && quotedScreenName) state.profileCache.set(quotedScreenName, quotedAuthor);
          }
        }
      };

      const search = (obj) => {
        if (!obj || typeof obj !== 'object') return;

        const tweetObj = obj.tweet_results?.result ?? obj.tweetResult?.result;
        if (tweetObj) cacheTweetObj(tweetObj);

        if (obj.__typename === 'User') {
          const screenName = getScreenName(obj);
          if (screenName) {
            state.profileCache.set(screenName, obj);
            dbg(`Cached raw profile data for user: ${screenName}`);
          }
        }

        for (const k in obj) {
          if (obj[k] && typeof obj[k] === 'object') search(obj[k]);
        }
      };
      search(data);
    } catch (_) {}
  }

  function isInsideQuoteTweet(el, articleEl) {
    let current = el.parentElement;
    while (current && current !== articleEl) {
      const testId = current.getAttribute('data-testid');
      if (testId === 'quoteTweet' || testId === 'testCondensedMedia') {
        return true;
      }
      if (current.tagName === 'DIV' && (current.classList.contains('r-adacv') || current.getAttribute('role') === 'link')) {
        if (current.querySelector('time') || current.querySelector('[data-testid="User-Name"]')) {
          return true;
        }
      }
      current = current.parentElement;
    }
    return false;
  }

  function isMediaOfMainTweet(mediaEl, articleEl) {
    return !isInsideQuoteTweet(mediaEl, articleEl);
  }

  function gmFetchJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        headers: headers,
        onload: res => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: err => reject(err)
      });
    });
  }

  function fetchBlob(url, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Fetch timed out for ${url}`));
        }
      }, timeoutMs);

      fetch(url, { mode: 'cors' })
        .then(res => {
          if (res.ok) return res.blob();
          throw new Error(`Standard fetch failed with status ${res.status}`);
        })
        .then(blob => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(blob);
          }
        })
        .catch(err => {
          dbg(`Standard fetch bypassed. Trying GM_xmlhttpRequest for: ${url} (${err.message})`);
          if (resolved) return;

          try {
            GM_xmlhttpRequest({
              method: 'GET',
              url: url,
              responseType: 'blob',
              onload: res => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                if (res.status === 200) {
                  resolve(res.response);
                } else {
                  reject(new Error(`GM_xmlhttpRequest HTTP ${res.status}`));
                }
              },
              onerror: error => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                reject(error);
              }
            });
          } catch (gmErr) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              reject(gmErr);
            }
          }
        });
    });
  }

  async function fetchAuthenticatedGql(endpointName, variables, features = {}) {
    const defaultFeatures = {
      articles_preview_enabled: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      freedom_of_speech_not_reach_fetch_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      view_counts_everywhere_api_enabled: true
    };

    const ct0 = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] ?? '';
    const bearer = state.interceptedHeaders?.['authorization'] ?? FALLBACK_BEARER;
    const queryHash = state.queryIds[endpointName];

    const url = `https://${location.hostname}/i/api/graphql/${queryHash}/${endpointName}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify({ ...defaultFeatures, ...features }))}`;

    const headers = {
      authorization: bearer,
      'content-type': 'application/json',
      'x-twitter-active-user': 'yes',
      'x-csrf-token': ct0
    };

    dbg(`Running authenticated same-origin fetch for ${endpointName}...`);
    const res = await unsafeWindow.fetch(url, { headers, credentials: 'include' });
    if (!res.ok) throw new Error(`Authenticated fetch failed: HTTP ${res.status}`);
    return await res.json();
  }

  async function resolveTweetMedia(tweetId, article) {
    dbg(`resolveTweetMedia: starting for tweetId ${tweetId}`);

    const cachedTweet = state.tweetCache.get(tweetId);
    if (cachedTweet && Date.now() - cachedTweet.ts < 300000) {
      const extracted = extractMediaFromTweetObj(cachedTweet.core);
      dbg(`resolveTweetMedia: cache hit for ${tweetId}`, extracted);
      if (extracted.videos.length > 0 || extracted.images.length > 0) return extracted;
    }

    try {
      const variables = { focalTweetId: tweetId, with_rux_injections: false, includePromotedContent: true, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true };
      const res = await fetchAuthenticatedGql('TweetDetail', variables);
      parseAndCacheRawData(JSON.stringify(res));
      const updated = state.tweetCache.get(tweetId);
      if (updated) {
        const extracted = extractMediaFromTweetObj(updated.core);
        dbg(`resolveTweetMedia: tier 1 (TweetDetail) result for ${tweetId}`, extracted);
        if (extracted.videos.length > 0 || extracted.images.length > 0) return extracted;
      }
    } catch (e) {
      dbg('resolveTweetMedia: tier 1 (TweetDetail) error', e);
    }

    try {
      const ct0 = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] ?? '';
      const gt = document.cookie.match(/(?:^|;\s*)gt=([^;]+)/)?.[1] ?? '';
      const bearer = state.interceptedHeaders?.['authorization'] ?? FALLBACK_BEARER;

      const variables = { tweetId, with_rux_injections: false, includePromotedContent: true, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true, withV2Timeline: true };
      const features = { articles_preview_enabled: true, c9s_tweet_anatomy_moderator_badge_enabled: true, freedom_of_speech_not_reach_fetch_enabled: true, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, longform_notetweets_inline_media_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true, view_counts_everywhere_api_enabled: true };

      const url = `https://${location.hostname}/i/api/graphql/${state.queryIds.TweetResultByRestId}/TweetResultByRestId?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
      const headers = { authorization: bearer, 'x-twitter-active-user': 'yes' };
      if (ct0) headers['x-csrf-token'] = ct0;
      if (gt) headers['x-guest-token'] = gt;

      const res = await gmFetchJson(url, headers);
      const tweetObj = res.data?.tweetResult?.result?.tweet ?? res.data?.tweetResult?.result;
      if (tweetObj) {
        state.tweetCache.set(tweetId, { core: tweetObj, ts: Date.now() });
        const extracted = extractMediaFromTweetObj(tweetObj);
        dbg(`resolveTweetMedia: tier 2 (TweetResultByRestId) result for ${tweetId}`, extracted);
        if (extracted.videos.length > 0 || extracted.images.length > 0) return extracted;
      }
    } catch (e) {
      dbg('resolveTweetMedia: tier 2 (TweetResultByRestId) error', e);
    }

    try {
      const res = await gmFetchJson(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=x`);
      if (res) {
        const result = { videos: [], images: [], thumbs: [] };
        if (res.photos) {
          res.photos.forEach(p => result.images.push(p.url + '?name=orig'));
        }
        if (res.video) {
          const variants = res.video.variants || [];
          const best = variants
            .filter(v => v.content_type === 'video/mp4')
            .sort((a, b) => (b.bitrate - a.bitrate))[0];
          if (best?.url) {
            result.videos.push(best.url.split('?')[0]);
            result.thumbs.push(res.video.poster);
          }
        }
        if (result.videos.length > 0 || result.images.length > 0) return result;
      }
    } catch (_) {}

    try {
      dbg('Falling back to api.vxtwitter.com...');
      const res = await gmFetchJson(`https://api.vxtwitter.com/v1/tweet/${tweetId}`);
      if (res && res.media_extended) {
        const result = { videos: [], images: [], thumbs: [] };
        res.media_extended.forEach(m => {
          if (m.type === 'image') {
            result.images.push(m.url + '?name=orig');
          } else if (m.type === 'video' || m.type === 'gif') {
            result.videos.push(m.url);
            result.thumbs.push(m.thumbnail_url);
          }
        });
        if (result.videos.length > 0 || result.images.length > 0) {
          return result;
        }
      }
    } catch (_) {}

    if (article) {
      const result = { videos: [], images: [], thumbs: [] };
      article.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach(img => {
        if (isMediaOfMainTweet(img, article)) {
          const cleanUrl = img.src.split('?')[0] + '?name=orig';
          if (!result.images.includes(cleanUrl)) result.images.push(cleanUrl);
        }
      });
      if (result.images.length > 0) {
        return result;
      }
    }

    return null;
  }

  function unshortenTweetLinks(article, tweetId) {
    const cached = state.tweetCache.get(tweetId);
    if (!cached) return;

    const legacy = cached.core?.legacy ?? cached.core?.tweet?.legacy;
    const urlsMetadata = legacy?.entities?.urls || [];
    if (urlsMetadata.length === 0) return;

    const textContainer = article.querySelector('[data-testid="tweetText"]');
    if (!textContainer) return;

    const anchors = textContainer.querySelectorAll('a[href^="https://t.co/"]');
    anchors.forEach(a => {
      const match = urlsMetadata.find(meta => meta.url === a.href);
      if (match) {
        a.href = match.expanded_url;
        if (a.textContent.includes('…') || a.textContent.startsWith('t.co/')) {
          a.textContent = match.display_url;
        }
      }
    });
  }

  function showGalleryPicker(mediaItems, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'tmd-picker-overlay';

    const card = document.createElement('div');
    card.className = 'tmd-picker-card';

    const title = document.createElement('div');
    title.className = 'tmd-picker-title';
    title.textContent = 'Select Files to Download';

    const grid = document.createElement('div');
    grid.className = 'tmd-picker-grid';

    const selectedSet = new Set(mediaItems.map((_, i) => i));

    mediaItems.forEach((item, index) => {
      const container = document.createElement('div');
      container.className = 'tmd-picker-item selected';

      const img = document.createElement('img');
      img.src = item.thumb;
      img.alt = '';
      img.loading = 'lazy';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'tmd-picker-checkbox';
      chk.checked = true;

      container.appendChild(img);
      container.appendChild(chk);

      if (item.type === 'video') {
        const badge = document.createElement('span');
        badge.className = 'tmd-picker-badge';
        badge.textContent = 'MP4';
        container.appendChild(badge);
      }

      container.addEventListener('click', (e) => {
        if (e.target === chk) return;
        chk.checked = !chk.checked;
        triggerToggle();
      });

      chk.addEventListener('change', () => {
        triggerToggle();
      });

      function triggerToggle() {
        if (chk.checked) {
          selectedSet.add(index);
          container.classList.add('selected');
        } else {
          selectedSet.delete(index);
          container.classList.remove('selected');
        }
      }

      grid.appendChild(container);
    });

    const actions = document.createElement('div');
    actions.className = 'tmd-picker-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'tmd-picker-btn cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'tmd-picker-btn confirm';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', () => {
      overlay.remove();
      const chosen = mediaItems.filter((_, i) => selectedSet.has(i));
      if (chosen.length > 0) onConfirm(chosen);
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    card.appendChild(title);
    card.appendChild(grid);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  async function fetchAllBlobsWithProgress(items, btn, startPct, endPct) {
    const results = [];
    const total = items.length;
    for (let i = 0; i < total; i++) {
      const item = items[i];
      try {
        dbg(`Processing resource ${i + 1}/${total}: ${item.url}`);
        const blob = await fetchBlob(item.url);
        results.push({ item, blob });
      } catch (e) {
        dbg(`Failed to complete download pipeline for ${item.url}`, e);
      }
      const currentProgress = startPct + Math.round(((i + 1) / total) * (endPct - startPct));
      updateDownloadProgress(btn, currentProgress);
    }
    return results;
  }

  function fallbackAnchorSave(blob, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 150);
  }

  function saveFile(blob, filename, originalUrl) {
    return new Promise((resolve) => {
      if (typeof GM_download === 'function' && originalUrl) {
        dbg(`Routing download via GM_download: ${filename}`);
        GM_download({
          url: originalUrl,
          name: filename,
          onload: () => resolve(true),
          onerror: (err) => {
            dbg(`GM_download failed, applying DOM anchor fallback: ${err.error || err.message}`);
            fallbackAnchorSave(blob, filename);
            resolve(true);
          }
        });
      } else {
        fallbackAnchorSave(blob, filename);
        resolve(true);
      }
    });
  }

  function getJSZip() {
    if (typeof JSZip !== 'undefined') return JSZip;
    if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.JSZip !== 'undefined') return unsafeWindow.JSZip;
    return null;
  }

  async function downloadLocal(items, tweetId, btn) {
    if (items.length === 0) return;
    log(`Downloading ${items.length} file(s) locally...`);

    updateDownloadProgress(btn, 5);
    const blobs = await fetchAllBlobsWithProgress(items, btn, 5, 80);

    if (blobs.length === 0) {
      dbg('downloadLocal: all item fetch requests returned empty');
      updateDownloadProgress(btn, 0);
      return;
    }

    updateDownloadProgress(btn, 85);

    if (blobs.length === 1) {
      const { item, blob } = blobs[0];
      const filename = `twitter_${tweetId}_${Date.now()}.${item.ext}`;
      await saveFile(blob, filename, item.url);
      updateDownloadProgress(btn, 100);
      setTimeout(() => updateDownloadProgress(btn, 0), 1000);
      return;
    }

    const JSZipLib = getJSZip();
    if (JSZipLib) {
      try {
        dbg('Compiling assets into local ZIP output...');
        const zip = new JSZipLib();
        blobs.forEach(({ item, blob }, i) => {
          if (blob) {
            zip.file(`media_${i + 1}.${item.ext}`, blob);
          }
        });

        const zipPromise = zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('ZIP compilation timeout exceeded')), 4000)
        );

        updateDownloadProgress(btn, 90);
        const content = await Promise.race([zipPromise, timeoutPromise]);
        updateDownloadProgress(btn, 95);

        fallbackAnchorSave(content, `twitter_${tweetId}_media.zip`);
        updateDownloadProgress(btn, 100);
        setTimeout(() => updateDownloadProgress(btn, 0), 1000);
        return;
      } catch (err) {
        dbg('downloadLocal: zip construction failed or timed out. Falling back to sequential save...', err);
      }
    } else {
      dbg('downloadLocal: JSZip library not loaded in this scope. Falling back to sequential save...');
    }

    for (let i = 0; i < blobs.length; i++) {
      const { item, blob } = blobs[i];
      const stepProgress = 80 + Math.round(((i + 1) / blobs.length) * 20);
      updateDownloadProgress(btn, stepProgress);

      const filename = `twitter_${tweetId}_${i + 1}.${item.ext}`;
      await saveFile(blob, filename, item.url);
      if (i < blobs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    }
    updateDownloadProgress(btn, 100);
    setTimeout(() => updateDownloadProgress(btn, 0), 1000);
  }

  function getTweetId(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');

    for (const a of links) {
      if (a.querySelector('time') && !isInsideQuoteTweet(a, article)) {
        const match = a.href.match(/\/status\/(\d+)/);
        if (match) return match[1];
      }
    }

    for (const a of links) {
      if (!isInsideQuoteTweet(a, article)) {
        const match = a.href.match(/\/status\/(\d+)/);
        if (match) return match[1];
      }
    }

    return null;
  }

  async function runActionPipeline(tweetId, article, btn) {
    if (btn.classList.contains('loading')) return;
    updateDownloadProgress(btn, 0);
    btn.classList.add('loading');
    updateDownloadProgress(btn, 5);
    dbg(`runActionPipeline: invoked for tweetId ${tweetId}`);

    try {
      const resolved = await resolveTweetMedia(tweetId, article);
      dbg(`runActionPipeline: resolved media for ${tweetId}`, resolved);
      if (!resolved || (resolved.videos.length === 0 && resolved.images.length === 0)) {
        btn.classList.remove('loading');
        updateDownloadProgress(btn, 0);
        return;
      }

      const mediaItems = [];
      resolved.videos.forEach((v, idx) => {
        mediaItems.push({ type: 'video', url: v, thumb: resolved.thumbs[idx] || v, ext: 'mp4' });
      });
      resolved.images.forEach(img => {
        mediaItems.push({ type: 'image', url: img, thumb: img.replace('name=orig', 'name=small'), ext: 'jpg' });
      });
      dbg(`runActionPipeline: built ${mediaItems.length} media item(s) for ${tweetId}`, mediaItems);

      if (mediaItems.length > 1) {
        btn.classList.remove('loading');
        showGalleryPicker(mediaItems, async (chosenItems) => {
          btn.classList.add('loading');
          await downloadLocal(chosenItems, tweetId, btn);
          btn.classList.remove('loading');
        });
      } else {
        await downloadLocal(mediaItems, tweetId, btn);
        btn.classList.remove('loading');
      }
    } catch (err) {
      btn.classList.remove('loading');
      updateDownloadProgress(btn, 0);
    }
  }

  function injectDownloadButton(article, optRow) {
    const actionRow = optRow || article?.querySelector('div[role="group"]');
    if (!actionRow || actionRow.querySelector(`.${BUTTON_CLASS}`)) return;

    const tweetId = getTweetId(article || document.body) || getTweetIdFromUrl();
    if (!tweetId) return;

    const shareContainer = actionRow.querySelector('div[style*="justify-content: inherit; display: inline-grid;"]') || actionRow.lastElementChild;
    if (!shareContainer) return;

    const clone = shareContainer.cloneNode(true);
    const btn = clone.querySelector('button');
    if (!btn) return;

    btn.removeAttribute('aria-haspopup');
    btn.removeAttribute('aria-expanded');
    btn.setAttribute('aria-label', 'Download media');
    btn.classList.add(BUTTON_CLASS);

    const svgPath = btn.querySelector('svg path');
    if (svgPath) {
      svgPath.setAttribute('d', 'M12 16.41l-5.7-5.7 1.41-1.42L11 12.18V3h2v9.18l3.29-3.3 1.41 1.42zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z');
    }

    const textWrapper = btn.querySelector('[data-testid="app-text-transition-container"]');
    if (textWrapper) textWrapper.remove();

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await runActionPipeline(tweetId, article, btn);
    });

    shareContainer.parentNode.insertBefore(clone, shareContainer.nextSibling);
  }

  function listenToRightClick() {
    const handleCapture = (target) => {
      const mediaParent = target.closest('video, img, [data-testid="videoPlayer"], [data-testid="tweetPhoto"]');
      if (mediaParent) {
        const article = target.closest('article[data-testid="tweet"]') || target.closest('main[role="main"]');
        if (article) {
          state.lastRightClickedTweet = article;
          state.lastRightClickTime = Date.now();
        }
      }
    };

    document.addEventListener('contextmenu', (e) => handleCapture(e.target), true);
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) handleCapture(e.target);
    }, true);
  }

  function listenToShareButtonClick() {
    document.addEventListener('click', (e) => {
      const shareBtn = e.target.closest('[data-testid="share"]');
      if (!shareBtn || shareBtn.classList.contains(BUTTON_CLASS)) return;
      const article = shareBtn.closest('article[data-testid="tweet"]') || shareBtn.closest('main[role="main"]');
      if (article) {
        state.lastRightClickedTweet = article;
        state.lastRightClickTime = Date.now();
      }
    }, true);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      log('Raw JSON copied to clipboard.');
    } catch (err) {
      dbg('Clipboard access blocked', err);
      alert('Failed writing payload to clipboard. Please check console.');
    }
  }

  function handleContextMenuInjection(node) {
    const menuContainer = node.querySelector('.css-175oi2r.r-kemksi.r-z2wwpe.r-qo02w8.r-bgc8nv.r-1udh08x.r-u8s1d')
      || node.querySelector('[data-testid="Dropdown"]')
      || node.querySelector('[role="menu"]')
      || node;
    if (!menuContainer || menuContainer.querySelector('[data-tmd-ctx]')) return;

    const items = menuContainer.querySelectorAll('[role="menuitem"]');
    if (items.length === 0) return;

    const rowHtml = (label) => `
      <div class="css-175oi2r r-16y2uox r-1wbh5a2">
        <div dir="ltr" class="css-146c3p1 r-bcqeeo r-1ttztb7 r-qvutc0 r-37j5jr r-a023e6 r-rjixqe r-b88u0q" style="color: rgb(231, 233, 234);">
          <span class="css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3">${label}</span>
        </div>
      </div>
    `;
    const makeRow = (label) => {
      const row = document.createElement('div');
      row.role = 'menuitem';
      row.tabIndex = 0;
      row.className = 'css-175oi2r r-18u37iz r-1mmae3n r-3pj75a r-13qz1uu r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
      row.setAttribute('data-tmd-ctx', 'true');
      row.innerHTML = rowHtml(label);
      return row;
    };

    const hasFreshTweetContext = !!state.lastRightClickedTweet && (Date.now() - state.lastRightClickTime < 4000);
    const isProfileMenu = !hasFreshTweetContext && !!document.querySelector('[data-testid="userActions"]');

    if (isProfileMenu) {
      const screenName = window.location.pathname.split('/')[1];
      if (!screenName) return;

      const profileRow = makeRow('Copy Raw Profile Data');
      profileRow.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        let rawData = state.profileCache.get(screenName);
        if (!rawData) {
          try {
            const variables = { screen_name: screenName, withSafetyModeUserFields: true };
            const res = await fetchAuthenticatedGql('UserResultByScreenName', variables);
            rawData = res.data?.user?.result ?? res.data?.user_result?.result ?? res.data?.userResult?.result;
            if (rawData) state.profileCache.set(screenName, rawData);
          } catch (err) {
            dbg('Error retrieving on-demand GQL profile results', err);
          }
        }

        if (rawData) copyToClipboard(JSON.stringify(rawData, null, 2));
        else alert('Could not fetch GQL schema details for this user profile.');
        document.body.click();
      });

      menuContainer.appendChild(profileRow);
      return;
    }

    if (hasFreshTweetContext) {
      const article = state.lastRightClickedTweet;
      const tweetId = getTweetId(article) || getTweetIdFromUrl();
      if (!tweetId) return;

      const downloadRow = makeRow('Download Media');
      downloadRow.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nativeBtn = article?.querySelector(`.${BUTTON_CLASS}`);
        await runActionPipeline(tweetId, article, nativeBtn || downloadRow);
        document.body.click();
      });
      menuContainer.appendChild(downloadRow);

      const tweetRow = makeRow('Copy Raw Tweet Data');
      tweetRow.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        let rawData = state.tweetCache.get(tweetId)?.core;
        if (!rawData) {
          try {
            const variables = { tweetId, with_rux_injections: false, includePromotedContent: true, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true, withV2Timeline: true };
            const res = await fetchAuthenticatedGql('TweetResultByRestId', variables);
            rawData = res.data?.tweetResult?.result?.tweet ?? res.data?.tweetResult?.result;
            if (rawData) state.tweetCache.set(tweetId, { core: rawData, ts: Date.now() });
          } catch (err) {
            dbg('Error retrieving on-demand GQL tweet results', err);
          }
        }

        if (rawData) copyToClipboard(JSON.stringify(rawData, null, 2));
        else alert('Could not fetch GQL schema details for this tweet.');
        document.body.click();
      });
      menuContainer.appendChild(tweetRow);
    }
  }

  function registerManagerMenu() {
    if (typeof GM_registerMenuCommand !== 'undefined') {
      GM_registerMenuCommand('Download Active Post Media', async () => {
        const tweetId = getTweetIdFromUrl();
        if (tweetId) {
          log(`Manager menu command activated for ID: ${tweetId}`);
          const mainArea = document.querySelector('article[data-testid="tweet"]') || document.querySelector('main[role="main"]');
          const mockBtn = document.createElement('div');
          document.body.appendChild(mockBtn);
          await runActionPipeline(tweetId, mainArea, mockBtn);
          mockBtn.remove();
        } else {
          alert('No active media timeline context detected on this page.');
        }
      });
    }
  }

  function scanTimeline() {
    updateThemeColors();

    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach(article => {
      const tweetId = getTweetId(article);
      if (tweetId) unshortenTweetLinks(article, tweetId);

      const hasMedia = article.querySelector('img[src*="/media/"]') ||
                       article.querySelector('video') ||
                       article.querySelector('[data-testid="videoComponent"]');
      if (hasMedia) {
        const mainMedia = article.querySelector('img[src*="/media/"], video, [data-testid="videoComponent"]');
        if (mainMedia && isMediaOfMainTweet(mainMedia, article)) {
          injectDownloadButton(article);
        }
      }
    });

    const path = window.location.pathname;
    if (path.includes('/photo/') || path.includes('/video/') || path.includes('/mediaViewer')) {
      const tweetId = getTweetIdFromUrl();
      if (tweetId) {
        const dialogs = document.querySelectorAll('div[aria-modal="true"], div[role="dialog"]');

        dialogs.forEach(dialog => {
          const actionRows = dialog.querySelectorAll('div[role="group"]');
          actionRows.forEach(actionRow => {
            if (actionRow && !actionRow.querySelector(`.${BUTTON_CLASS}`)) {
              const mainArea = dialog || document.querySelector('main[role="main"]') || document.body;
              injectDownloadButton(mainArea, actionRow);
            }
          });
        });

        const actionRows = document.querySelectorAll('div[role="group"]');
        actionRows.forEach(actionRow => {
          const isMediaLayout = actionRow.closest('main[role="main"]') && (path.includes('/photo/') || path.includes('/video/') || path.includes('/mediaViewer'));
          if (isMediaLayout && !actionRow.querySelector(`.${BUTTON_CLASS}`)) {
            const mainArea = document.querySelector('main[role="main"]') || document.body;
            injectDownloadButton(mainArea, actionRow);
          }
        });
      }
    }
  }

  initNetworkInterceptor();
  listenToRightClick();
  listenToShareButtonClick();
  registerManagerMenu();

  const observer = new MutationObserver((mutations) => {
    scanTimeline();
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.getAttribute('role') === 'menu' || node.querySelector('[role="menuitem"]')) {
            handleContextMenuInjection(node);
          }
        }
      });
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('load', () => scanTimeline());
})();