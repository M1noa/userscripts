// ==UserScript==
// @name         Yinseji Downloader
// @namespace    https://minoa.cat
// @description Downloads videos (AES-128 encrypted HLS) and images from yinseji.com profiles
// @author       Minoa
// @version      3.0.0
// @license      MIT
// @match        https://yinseji.com/*
// @match        https://www.yinseji.com/*
// @run-at       document-end
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      yinseji.com
// @connect      api.yinseji.com
// @connect      s3.yinseji.com
// @connect      *
// @noframes
// @downloadURL https://update.sleazyfork.org/scripts/586531/Yinseji%20Downloader.user.js
// @updateURL https://update.sleazyfork.org/scripts/586531/Yinseji%20Downloader.meta.js
// ==/UserScript==

(function () {
  'use strict';

  // --- config keys ---
  const POST_BUTTON_CLASS = 'tmd-yinseji-orange-btn';
  const PROFILE_BUTTON_CLASS = 'tmd-profile-dl-btn';

  // --- logger ---
  function log(msg) {
    console.log(`[Yinseji Downloader] ${msg}`);
  }

  // --- parse file extension securely ---
  function getFileExtension(url) {
    const cleanUrl = url.split('?')[0];
    const ext = cleanUrl.split('.').pop().toLowerCase();
    if (ext === 'm3u8' || ext === 'm3u') return 'ts';
    return ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext) ? ext : 'jpg';
  }

  // --- resolve safe filename with extension ---
  function getSafeFilename(file, index) {
    let name = file.name || `file_${index + 1}`;
    if (!name.includes('.')) {
      let ext = 'jpg';
      if (file.mimeType) {
        const mimeParts = file.mimeType.split('/');
        if (mimeParts.length > 1) {
          ext = mimeParts[1] === 'mov' ? 'mov' : mimeParts[1];
        }
      } else if (file.url) {
        ext = getFileExtension(file.url);
      }
      name = `${name}.${ext}`;
    }
    return name;
  }

  // --- XMLHttp request wrappers ---
  function fetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'blob',
        withCredentials: true,
        headers: {
          'Accept': '*/*',
          'Origin': window.location.origin,
          'Referer': window.location.href,
          'User-Agent': navigator.userAgent
        },
        onload: res => {
          if (res.status === 200) resolve(res.response);
          else reject(new Error(`HTTP status ${res.status}`));
        },
        onerror: err => reject(err)
      });
    });
  }

  function fetchText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        withCredentials: true,
        headers: {
          'Accept': '*/*',
          'Origin': window.location.origin,
          'Referer': window.location.href,
          'User-Agent': navigator.userAgent
        },
        onload: res => {
          if (res.status === 200) resolve(res.responseText);
          else reject(new Error(`HTTP status ${res.status}`));
        },
        onerror: err => reject(err)
      });
    });
  }

  // --- fetch array buffer (for AES key) ---
  function fetchArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        withCredentials: true,
        headers: {
          'Accept': '*/*',
          'Origin': window.location.origin,
          'Referer': window.location.href,
          'User-Agent': navigator.userAgent
        },
        onload: res => {
          if (res.status === 200) resolve(res.response);
          else reject(new Error(`HTTP status ${res.status}`));
        },
        onerror: err => reject(err)
      });
    });
  }

  // --- fetch json via GM_xmlhttpRequest ---
  function fetchJsonGM(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'json',
        withCredentials: true,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Origin': window.location.origin,
          'Referer': window.location.href,
          'User-Agent': navigator.userAgent
        },
        onload: res => {
          if (res.status === 200) resolve(res.response);
          else reject(new Error(`HTTP status ${res.status}`));
        },
        onerror: err => reject(err)
      });
    });
  }

  // --- fetch json using page context to bypass CORS/Referrer blocks ---
  function nativeFetchJson(url) {
    return new Promise((resolve, reject) => {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow.fetch) {
        log(`Executing context fetch on: ${url}`);
        unsafeWindow.fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json, text/plain, */*' }
        })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          return res.json();
        })
        .then(data => resolve(data))
        .catch(err => reject(err));
      } else {
        reject(new Error("Active page context does not expose standard fetch API."));
      }
    });
  }

  // --- save blob directly via dynamic link ---
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // --- parse username from active URL path ---
  function getUsernameFromUrl() {
    const path = window.location.pathname;
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    if (['en', 'zh', 'ja', 'ko'].includes(parts[0])) {
      return parts[1] && !['feed', 'creators', 'post', 'videos', 'settings', 'wallet', 'auth'].includes(parts[1]) ? parts[1] : null;
    }
    return !['feed', 'creators', 'settings', 'wallet', 'auth'].includes(parts[0]) ? parts[0] : null;
  }

  // --- parse tweet ID from active URL ---
  function getTweetIdFromUrl() {
    const match = window.location.pathname.match(/\/post\/(post-\d+)/);
    return match ? match[1] : null;
  }

  // --- HLS manifest segment downloader & assembler ---
  async function downloadHlsStream(playlistUrl, outputName, progressCallback) {
    log(`Resolving HLS Playlist: ${playlistUrl}`);
    const baseDir = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);

    const playlistText = await fetchText(playlistUrl);
    const lines = playlistText.split('\n').map(line => line.trim());

    // check if master playlist points to variants
    const isMaster = lines.some(line => line.includes('#EXT-X-STREAM-INF'));
    if (isMaster) {
      let highestVariantUrl = '';
      let maxBandwidth = 0;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
          const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
          const actualNextLine = lines[i + 1];
          if (actualNextLine && !actualNextLine.startsWith('#') && bw > maxBandwidth) {
            maxBandwidth = bw;
            highestVariantUrl = actualNextLine;
          }
        }
      }

      if (highestVariantUrl) {
        const resolvedVariantUrl = highestVariantUrl.startsWith('http') ? highestVariantUrl : baseDir + highestVariantUrl;
        return downloadHlsStream(resolvedVariantUrl, outputName, progressCallback);
      }
    }

    // parse individual segments
    const segmentUrls = [];
    lines.forEach(line => {
      if (line && !line.startsWith('#')) {
        const resolvedSegment = line.startsWith('http') ? line : baseDir + line;
        segmentUrls.push(resolvedSegment);
      }
    });

    if (segmentUrls.length === 0) {
      throw new Error("No media segments located inside HLS manifest.");
    }

    log(`Downloading ${segmentUrls.length} segments for ${outputName}...`);
    const segmentsData = [];

    for (let i = 0; i < segmentUrls.length; i++) {
      if (progressCallback) {
        progressCallback(Math.round((i / segmentUrls.length) * 100));
      }
      const blob = await fetchBlob(segmentUrls[i]);
      const arrayBuffer = await blob.arrayBuffer();
      segmentsData.push(new Uint8Array(arrayBuffer));
    }

    // concatenate segments
    const totalLength = segmentsData.reduce((acc, val) => acc + val.length, 0);
    const mergedArray = new Uint8Array(totalLength);
    let offset = 0;
    for (const item of segmentsData) {
      mergedArray.set(item, offset);
      offset += item.length;
    }

    const mergedBlob = new Blob([mergedArray], { type: 'video/mp2t' });
    saveBlob(mergedBlob, `${outputName}.ts`);
  }

  // --- download AES-128 encrypted HLS stream via playback-info API ---
  async function downloadEncryptedHls(fileId, outputName, progressCallback) {
    log(`Fetching playback info for file: ${fileId}`);
    const pbInfo = await fetchJsonGM(`https://api.yinseji.com/v1/video/playback-info?vid=${fileId}`);
    const manifestUrl = pbInfo?.data?.hls?.manifestUrl;
    if (!manifestUrl) throw new Error('No manifest URL in playback info response');

    log(`Fetching HLS manifest: ${manifestUrl}`);
    const playlistText = await fetchText(manifestUrl);
    const lines = playlistText.split('\n').map(l => l.trim());

    // Parse AES-128 key info from #EXT-X-KEY
    let keyUrl = null;
    let ivHex = null;
    const keyLine = lines.find(l => l.startsWith('#EXT-X-KEY'));
    if (keyLine) {
      const uriMatch = keyLine.match(/URI="([^"]+)"/);
      const ivMatch = keyLine.match(/IV=0x([0-9a-fA-F]+)/);
      keyUrl = uriMatch ? uriMatch[1] : null;
      ivHex = ivMatch ? ivMatch[1] : null;
    }

    // Parse segment URLs
    const segmentUrls = [];
    lines.forEach(line => {
      if (line && !line.startsWith('#')) {
        segmentUrls.push(line.startsWith('http') ? line : manifestUrl.replace(/[^/]+$/, '') + line);
      }
    });

    if (segmentUrls.length === 0) throw new Error('No segments found in manifest');
    log(`Found ${segmentUrls.length} segments (encrypted: ${!!keyUrl})`);

    // Fetch AES key if encrypted
    let aesKey = null;
    let ivBytes = null;
    if (keyUrl) {
      log('Fetching AES-128 decryption key');
      const keyBuf = await fetchArrayBuffer(keyUrl);
      aesKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
      if (ivHex) {
        ivBytes = new Uint8Array(ivHex.match(/.{2}/g).map(b => parseInt(b, 16)));
      }
    }

    // Download and decrypt segments
    const segments = [];
    for (let i = 0; i < segmentUrls.length; i++) {
      if (progressCallback) progressCallback(Math.round((i / segmentUrls.length) * 100));
      const blob = await fetchBlob(segmentUrls[i]);
      let buf = await blob.arrayBuffer();

      if (aesKey) {
        let iv = ivBytes;
        if (!iv) {
          iv = new Uint8Array(16);
          new DataView(iv.buffer).setUint32(12, i);
        }
        buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, buf);
      }

      segments.push(new Uint8Array(buf));
    }

    // Concatenate decrypted segments
    const totalLen = segments.reduce((a, s) => a + s.length, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const s of segments) { merged.set(s, off); off += s.length; }

    log(`Saving assembled video: ${outputName} (${(totalLen / 1048576).toFixed(1)} MB)`);
    saveBlob(new Blob([merged], { type: 'video/mp2t' }), outputName);
  }

  // --- execute direct browser download or HLS assembly for a list of items ---
  async function downloadFilesList(allFiles, username, btn) {
    log(`Initializing queue download of ${allFiles.length} file(s)...`);

    for (let i = 0; i < allFiles.length; i++) {
      if (btn) btn.textContent = `Downloading (${i + 1}/${allFiles.length})...`;

      const file = allFiles[i];
      const cleanName = file.filename.replace(/[\/\\\?\%\*\:\|\\"<>\r\n]/g, '_');

      if (file.hlsVid) {
        // Encrypted HLS via playback-info API
        const tsName = cleanName.replace(/\.[a-z0-9]+$/i, '') + '.ts';
        try {
          log(`Downloading encrypted HLS video (vid: ${file.hlsVid}) as: ${tsName}`);
          await downloadEncryptedHls(file.hlsVid, tsName, (pct) => {
            if (btn) btn.textContent = `Decrypting stream (${i + 1}/${allFiles.length}) ${pct}%...`;
          });
        } catch (e) {
          log(`Encrypted HLS download failed for ${file.hlsVid}: ${e.message}`);
        }
      } else {
      const isHls = file.url.includes('.m3u8') || file.url.includes('/master.m3u8') || file.url.includes('.m3u') || file.url.includes('.m4s');

      if (isHls) {
        try {
          const tsFilename = cleanName.replace(/\.[a-z0-9]+$/i, '') + '.ts';
          log(`Target identified as HLS Stream: ${file.url}. Assembling as: ${tsFilename}`);
          await downloadHlsStream(file.url, tsFilename, (pct) => {
            if (btn) btn.textContent = `Assembling stream (${i + 1}/${allFiles.length}) ${pct}%...`;
          });
        } catch (e) {
          log(`HLS stream assembly failed for ${file.url}: ${e.message}. Downloading raw manifest.`);
          GM_download({
            url: file.url,
            name: cleanName,
            saveAs: false
          });
        }
      } else {
        log(`Downloading standard static file: ${cleanName}`);
        await new Promise((resolve) => {
          GM_download({
            url: file.url,
            name: cleanName,
            saveAs: false,
            onload: () => {
              log(`Completed download: ${cleanName}`);
              resolve();
            },
            onerror: (err) => {
              log(`XHR download retry initiated for ${cleanName} due to browser block: ${err.error}`);
              fetchBlob(file.url).then(blob => {
                saveBlob(blob, cleanName);
                resolve();
              }).catch(() => {
                log(`Failed to retrieve file payload: ${file.url}`);
                resolve();
              });
            }
          });
        });
      }
      }
    }
  }

  // --- extract URLs helper from HTML block ---
  function extractUrlsFromHtml(htmlText) {
    const urls = new Set();
    const regex = /"url"\s*:\s*"([^"]+)"/g;
    let match;
    while ((match = regex.exec(htmlText)) !== null) {
      let url = match[1].replace(/\\/g, '');
      if (url.startsWith('http') && (url.includes('yinseji.com') || url.includes('aws4_request'))) {
        if (!url.includes('/avatars/') && !url.includes('/profile-')) {
          urls.add(url);
        }
      }
    }
    return Array.from(urls);
  }

  // --- parse media links directly from active page ---
  function getMediaUrls() {
    return extractUrlsFromHtml(document.documentElement.innerHTML);
  }

  // --- execute post downloader ---
  async function triggerDownload(urls, btn) {
    if (urls.length === 0) {
      alert("No media assets found on this page.");
      return;
    }

    if (btn) {
      btn.style.opacity = '0.5';
      btn.style.pointerEvents = 'none';
      btn.textContent = 'Downloading...';
    }

    const title = document.querySelector('h1')?.textContent?.trim() || 'yinseji_post';
    const cleanTitle = title.replace(/[\/\\\?\%\*\:\|\\"<>\r\n]/g, '_');

    const formattedList = urls.map((url, idx) => {
      const ext = getFileExtension(url);
      return {
        url: url,
        filename: `${cleanTitle}_file_${idx + 1}.${ext}`
      };
    });

    await downloadFilesList(formattedList, 'post', btn);

    if (btn) {
      btn.style.opacity = '';
      btn.style.pointerEvents = '';
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" x2="12" y1="15" y2="3"></line></svg>
        Download All Files (${urls.length})
      `;
    }
  }

  // --- creator profile archiving engine ---
  async function archiveCreatorProfile(username, btn) {
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    btn.style.opacity = '0.5';
    btn.textContent = 'Fetching API...';

    try {
      log(`Querying Yinseji feed API for user: ${username}`);
      const res = await nativeFetchJson(`https://api.yinseji.com/user/feeds/search/${username}?offset=0&limit=10000`);

      const feeds = res?.data?.data || [];
      log(`API returned successfully. Status: ${res?.status}. Found ${feeds.length} posts.`);

      if (feeds.length === 0) {
        alert("No feeds or media files found on this creator's profile.");
        resetButton();
        return;
      }

      const allFiles = [];
      feeds.forEach((feed, feedIdx) => {
        const post = feed.post || feed;
        if (post.files && Array.isArray(post.files)) {
          post.files.forEach((file, fileIdx) => {
            if (file.url) {
              const safeName = getSafeFilename(file, allFiles.length);
              log(`Mapping target asset: ${safeName}`);
              allFiles.push({
                url: file.url.replace(/\\/g, ''),
                filename: `${username}_${safeName}`
              });
            } else if (file.hlsManifestKey && file._id) {
              const baseName = (file.name || `video_${allFiles.length}`).replace(/\.[^.]+$/, '');
              log(`Mapping encrypted HLS video: ${baseName}.ts (vid: ${file._id})`);
              allFiles.push({
                hlsVid: file._id,
                filename: `${username}_${baseName}.ts`
              });
            }
          });
        }
      });

      if (allFiles.length === 0) {
        alert("No unlocked files could be parsed from this profile's feed API.");
        resetButton();
        return;
      }

      // sequentially download everything individually inside browser download manager
      await downloadFilesList(allFiles, username, btn);

      // download raw JSON metadata representation
      log(`Saving feed metadata archive: ${username}.feed.json`);
      const feedBlob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      saveBlob(feedBlob, `${username}.feed.json`);

    } catch (err) {
      log(`Profile archiving process failed: ${err.message}`);
      alert(`Profile archiving failed: ${err.message}`);
    } finally {
      resetButton();
    }

    function resetButton() {
      btn.classList.remove('loading');
      btn.style.opacity = '';
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" x2="12" y1="15" y2="3"></line></svg>
        Download All Posts
      `;
    }
  }

  // --- inject download buttons ---
  function injectBtn() {
    // 1. Handle regular post pages
    const article = document.querySelector('article');
    if (article && !article.querySelector(`.${POST_BUTTON_CLASS}`)) {
      const targetRow = article.querySelector('.mt-6.flex.items-center') || article.lastElementChild;
      if (targetRow) {
        const urls = getMediaUrls();
        if (urls.length > 0) {
          const downloadBtn = document.createElement('button');
          downloadBtn.className = `${POST_BUTTON_CLASS} inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-11 rounded-md px-8 w-full mt-4 bg-orange-600 hover:bg-orange-500 text-white shadow-sm`;
          downloadBtn.style.cssText = 'background-color: #ea580c !important; color: #ffffff !important; border: none !important; cursor: pointer; display: flex; margin-bottom: 16px;';

          downloadBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" x2="12" y1="15" y2="3"></line></svg>
            Download All Files (${urls.length})
          `;

          downloadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerDownload(urls, downloadBtn);
          });

          targetRow.parentNode.insertBefore(downloadBtn, targetRow);
        }
      }
    }

    // 2. Handle creator profile pages (Add prominent Orange Profile Downloader Button next to Subscribe)
    const profileActions = document.querySelector('.container .flex.flex-wrap.items-center.gap-2.pb-2');
    if (profileActions && !profileActions.querySelector(`.${PROFILE_BUTTON_CLASS}`)) {
      const username = getUsernameFromUrl();
      if (username) {
        const profileBtn = document.createElement('button');
        profileBtn.className = `${PROFILE_BUTTON_CLASS} inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white shadow-sm`;
        profileBtn.style.cssText = 'background-color: #ea580c !important; color: #ffffff !important; border: none !important; cursor: pointer; display: flex; font-weight: bold;';
        profileBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" x2="12" y1="15" y2="3"></line></svg>
          Download All Posts
        `;

        profileBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          archiveCreatorProfile(username, profileBtn);
        });

        profileActions.appendChild(profileBtn);
      }
    }
  }

  // --- register menu command for userscript managers ---
  function registerManagerMenu() {
    if (typeof GM_registerMenuCommand !== 'undefined') {
      GM_registerMenuCommand("Download Post Media", async () => {
        const urls = getMediaUrls();
        const activeBtn = document.querySelector(`.${POST_BUTTON_CLASS}`);
        await triggerDownload(urls, activeBtn);
      });
    }
  }

  // --- observer initialization ---
  const observer = new MutationObserver(() => injectBtn());
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('load', () => injectBtn());
  registerManagerMenu();
})();