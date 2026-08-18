// ==UserScript==
// @name         PiP Anywhere
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      2.1.2
// @description  Click the PiP button in your userscript manager menu for PiP with custom controls on any site: seek bar, buffer indicator, volume, speed, skip, keyboard shortcuts, auto-hide HUD. Falls back to legacy PiP on unsupported browsers.
// @author       Minoa
// @license      MIT
// @homepageURL  https://gitlab.com/M1noa/userscripts
// @supportURL   https://gitlab.com/M1noa/userscripts/-/issues
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// @downloadURL  https://update.greasyfork.org/scripts/570730/pip%20anywhere.user.js
// @updateURL    https://update.greasyfork.org/scripts/570730/pip%20anywhere.meta.js
// ==/UserScript==

;(function () {
  'use strict'

  // whether document pip is available in this browser (chrome 116+)
  const DPIP_SUPPORTED = 'documentPictureInPicture' in window

  // speed steps to cycle through
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4]

  // storage key
  const KEY_MODE = 'pip_mode'

  // --- persistent mode preference ---
  // 'advanced' = document pip with custom hud
  // 'basic'    = native video.requestPictureInPicture()
  // if dpip isnt supported we always use basic regardless

  let mode = GM_getValue(KEY_MODE, 'advanced')

  // menu command handles so we can re-register on toggle
  let menuPipId    = null
  let menuToggleId = null

  // --- session state ---

  let pinned    = null  // video locked for this page session
  let pipWin    = null  // documentPictureInPicture window reference
  let rafId     = null  // requestAnimationFrame handle for progress loop
  let hideTimer = null  // auto-hide timeout handle

  // saved dom position so we can restore the video element after pip closes
  let savedParent = null
  let savedNext   = null
  let savedStyles = null

  // --- video discovery ---

  function getVideos() {
    return Array.from(document.querySelectorAll('video')).filter(
      v => v.readyState > 0 && v.offsetParent !== null
    )
  }

  function getPlaying() {
    return getVideos().filter(v => !v.paused && !v.ended)
  }

  function elementCenter(el) {
    const r = el.getBoundingClientRect()
    return [r.left + r.width / 2, r.top + r.height / 2]
  }

  function closestToPoint(mx, my, list) {
    let best = null
    let bd   = Infinity
    for (const v of list) {
      const [cx, cy] = elementCenter(v)
      const d = Math.hypot(cx - mx, cy - my)
      if (d < bd) { bd = d; best = v }
    }
    return best
  }

  // --- utils ---

  function fmtTime(s) {
    s = Math.floor(s || 0)
    const h   = Math.floor(s / 3600)
    const m   = Math.floor((s % 3600) / 60)
    const sec = s % 60
    if (h > 0) {
      return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
    }
    return m + ':' + String(sec).padStart(2, '0')
  }

  function makeSvg(path, size) {
    size = size || 16
    return (
      '<svg width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="currentColor">' + path + '</svg>'
    )
  }

  const ICON = {
    play:  makeSvg('<path d="M8 5v14l11-7z"/>'),
    pause: makeSvg('<path d="M6 19h4V5H6zm8-14v14h4V5z"/>'),
    mute:  makeSvg('<path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 18l1.98 2L21 18.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'),
    vol:   makeSvg('<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>'),
    back:  makeSvg('<path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/>'),
    fwd:   makeSvg('<path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/>'),
    close: makeSvg('<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>')
  }

  // --- selection mode ---
  // when multiple videos are playing, outline the closest one to the mouse
  // and let the user click to confirm which one to pip

  let selecting  = false
  let selHovered = null

  function enterSelectMode(candidates, cb) {
    if (selecting) return
    selecting = true

    const prevCursor = document.documentElement.style.cursor
    document.documentElement.style.cursor = 'crosshair'

    function hl(v) {
      v.style.setProperty('outline', '2px solid #0af', 'important')
      v.style.setProperty('outline-offset', '-2px', 'important')
    }
    function unhl(v) {
      if (!v) return
      v.style.removeProperty('outline')
      v.style.removeProperty('outline-offset')
    }
    function onMove(e) {
      const next = closestToPoint(e.clientX, e.clientY, candidates)
      if (next === selHovered) return
      unhl(selHovered)
      selHovered = next
      if (selHovered) hl(selHovered)
    }
    function onKey(e) {
      if (e.key === 'Escape') cleanup()
    }
    function onClick(e) {
      e.stopPropagation()
      e.preventDefault()
      const target = selHovered
      cleanup()
      cb(target)
    }
    function cleanup() {
      selecting = false
      unhl(selHovered)
      selHovered = null
      document.documentElement.style.cursor = prevCursor
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey)
  }

  // --- styles injected into the document pip window ---

  const HUD_CSS = [
    '* { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; }',
    'body {',
    '  background: #000; width: 100vw; height: 100vh;',
    '  overflow: hidden; display: flex;',
    '  align-items: center; justify-content: center;',
    '}',
    '#wrap { position: relative; width: 100%; height: 100%; }',
    'video {',
    '  width: 100% !important; height: 100% !important;',
    '  max-width: 100% !important; max-height: 100% !important;',
    '  object-fit: contain; display: block;',
    '}',
    '#hud {',
    '  position: absolute; bottom: 0; left: 0; right: 0;',
    '  padding: 36px 12px 10px;',
    '  background: linear-gradient(transparent, rgba(0,0,0,0.85));',
    '  transition: opacity 0.2s ease;',
    '}',
    '#hud.hidden { opacity: 0; pointer-events: none; }',
    '#prog-wrap {',
    '  position: relative; height: 4px;',
    '  background: rgba(255,255,255,0.18); border-radius: 2px;',
    '  margin-bottom: 9px; cursor: pointer;',
    '  transition: height 0.12s, margin-bottom 0.12s;',
    '}',
    '#prog-wrap:hover { height: 6px; margin-bottom: 7px; }',
    '#buf {',
    '  position: absolute; left: 0; top: 0; height: 100%;',
    '  background: rgba(255,255,255,0.22); border-radius: 2px; pointer-events: none;',
    '}',
    '#fill {',
    '  position: absolute; left: 0; top: 0; height: 100%;',
    '  background: #0af; border-radius: 2px; pointer-events: none;',
    '}',
    '#prog-thumb {',
    '  position: absolute; top: 50%; transform: translate(-50%, -50%);',
    '  width: 12px; height: 12px; background: #fff; border-radius: 50%;',
    '  pointer-events: none; opacity: 0; transition: opacity 0.15s;',
    '}',
    '#prog-wrap:hover #prog-thumb { opacity: 1; }',
    '#prog-tip {',
    '  position: absolute; bottom: 14px; transform: translateX(-50%);',
    '  background: rgba(0,0,0,0.75); color: #fff;',
    '  font-size: 10px; font-family: ui-monospace, monospace;',
    '  padding: 2px 5px; border-radius: 3px;',
    '  pointer-events: none; white-space: nowrap;',
    '  opacity: 0; transition: opacity 0.1s;',
    '}',
    '#prog-wrap:hover #prog-tip { opacity: 1; }',
    '#btns { display: flex; align-items: center; gap: 3px; }',
    'button {',
    '  background: none; border: none; color: #fff; cursor: pointer;',
    '  padding: 4px 6px; border-radius: 4px; line-height: 1;',
    '  opacity: 0.82; transition: opacity 0.12s, background 0.12s; flex-shrink: 0;',
    '}',
    'button:hover  { opacity: 1; background: rgba(255,255,255,0.12); }',
    'button:active { background: rgba(255,255,255,0.2); }',
    '#time {',
    '  font-size: 11px; color: rgba(255,255,255,0.78);',
    '  white-space: nowrap; padding: 0 4px;',
    '  font-family: ui-monospace, monospace;',
    '}',
    '.spacer { flex: 1; }',
    '#vol-wrap { display: flex; align-items: center; gap: 4px; }',
    'input[type=range] {',
    '  -webkit-appearance: none; appearance: none;',
    '  width: 64px; height: 3px;',
    '  background: rgba(255,255,255,0.28); border-radius: 2px;',
    '  outline: none; cursor: pointer;',
    '}',
    'input[type=range]::-webkit-slider-thumb {',
    '  -webkit-appearance: none; appearance: none;',
    '  width: 11px; height: 11px; background: #fff; border-radius: 50%;',
    '}',
    '#speed-btn {',
    '  font-variant-numeric: tabular-nums;',
    '  min-width: 36px; text-align: center; font-size: 11px;',
    '}',
    'svg { display: block; }',
  ].join('\n')

  // --- build and wire up the hud inside the pip window ---

  function buildHud(doc, video) {
    const wrap = doc.createElement('div')
    wrap.id = 'wrap'

    const hud = doc.createElement('div')
    hud.id = 'hud'
    hud.innerHTML = [
      '<div id="prog-wrap">',
        '<div id="buf"></div>',
        '<div id="fill"></div>',
        '<div id="prog-thumb"></div>',
        '<div id="prog-tip">0:00</div>',
      '</div>',
      '<div id="btns">',
        '<button id="btn-back"  title="back 10s">'      + ICON.back  + '</button>',
        '<button id="btn-pp"    title="play / pause">'  + (video.paused ? ICON.play : ICON.pause) + '</button>',
        '<button id="btn-fwd"   title="forward 10s">'   + ICON.fwd   + '</button>',
        '<span id="time">' + fmtTime(video.currentTime) + ' / ' + fmtTime(video.duration) + '</span>',
        '<div class="spacer"></div>',
        '<div id="vol-wrap">',
          '<button id="btn-mute" title="mute">' + (video.muted ? ICON.mute : ICON.vol) + '</button>',
          '<input type="range" id="vol-slider" min="0" max="1" step="0.02" value="' + video.volume + '">',
        '</div>',
        '<button id="speed-btn" title="cycle speed">' + video.playbackRate + 'x</button>',
        '<button id="btn-close" title="close pip">'   + ICON.close + '</button>',
      '</div>',
    ].join('')

    wrap.appendChild(video)
    wrap.appendChild(hud)
    doc.body.appendChild(wrap)

    const elPp      = hud.querySelector('#btn-pp')
    const elBack    = hud.querySelector('#btn-back')
    const elFwd     = hud.querySelector('#btn-fwd')
    const elMute    = hud.querySelector('#btn-mute')
    const elVolSldr = hud.querySelector('#vol-slider')
    const elSpeed   = hud.querySelector('#speed-btn')
    const elClose   = hud.querySelector('#btn-close')
    const elFill    = hud.querySelector('#fill')
    const elBuf     = hud.querySelector('#buf')
    const elThumb   = hud.querySelector('#prog-thumb')
    const elTip     = hud.querySelector('#prog-tip')
    const elProgW   = hud.querySelector('#prog-wrap')
    const elTime    = hud.querySelector('#time')

    // raf loop - syncs seek bar, buffer, time, and button icon states
    function tick() {
      if (!video || video.readyState < 1) {
        rafId = requestAnimationFrame(tick)
        return
      }
      const dur = video.duration || 0
      const pct = dur ? Math.min(1, video.currentTime / dur) : 0
      const pctStr = (pct * 100).toFixed(3) + '%'

      elFill.style.width  = pctStr
      elThumb.style.left  = pctStr
      elTime.textContent  = fmtTime(video.currentTime) + ' / ' + fmtTime(dur)

      if (video.buffered.length && dur) {
        elBuf.style.width =
          (video.buffered.end(video.buffered.length - 1) / dur * 100).toFixed(3) + '%'
      }

      elPp.innerHTML   = video.paused ? ICON.play : ICON.pause
      elMute.innerHTML = (video.muted || video.volume === 0) ? ICON.mute : ICON.vol

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    // play/pause
    elPp.addEventListener('click', () => video.paused ? video.play() : video.pause())

    // skip buttons
    elBack.addEventListener('click', () => {
      video.currentTime = Math.max(0, video.currentTime - 10)
    })
    elFwd.addEventListener('click', () => {
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 10)
    })

    // mute toggle
    elMute.addEventListener('click', () => {
      video.muted     = !video.muted
      elVolSldr.value = video.muted ? 0 : video.volume
    })

    // volume slider
    elVolSldr.addEventListener('input', () => {
      video.volume = parseFloat(elVolSldr.value)
      video.muted  = video.volume === 0
    })

    // speed cycle
    elSpeed.addEventListener('click', () => {
      const cur               = SPEEDS.indexOf(video.playbackRate)
      const next              = SPEEDS[(cur + 1) % SPEEDS.length]
      video.playbackRate      = next
      elSpeed.textContent     = next + 'x'
    })

    // seek bar - click to jump, drag to scrub
    let scrubbing = false

    function seekFromEvent(e) {
      const r   = elProgW.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
      video.currentTime = pct * (video.duration || 0)
    }

    // tooltip on hover showing time at cursor position
    elProgW.addEventListener('mousemove', e => {
      const r         = elProgW.getBoundingClientRect()
      const pct       = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
      elTip.textContent = fmtTime(pct * (video.duration || 0))
      elTip.style.left  = (pct * 100).toFixed(3) + '%'
    })

    elProgW.addEventListener('mousedown', e => { scrubbing = true; seekFromEvent(e) })
    doc.addEventListener('mousemove',     e => { if (scrubbing) seekFromEvent(e) })
    doc.addEventListener('mouseup',       ()  => { scrubbing = false })

    // close button
    elClose.addEventListener('click', () => pipWin && pipWin.close())

    // auto-hide hud after 3s of no mouse activity
    function showHud() {
      hud.classList.remove('hidden')
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => { hud.classList.add('hidden') }, 3000)
    }
    doc.addEventListener('mousemove', showHud)
    doc.addEventListener('click',     showHud)
    showHud()

    // keyboard shortcuts when pip window has focus
    doc.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const dur = video.duration || 0

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          video.paused ? video.play() : video.pause()
          break
        case 'ArrowLeft':
        case 'j':
          video.currentTime = Math.max(0, video.currentTime - 10)
          break
        case 'ArrowRight':
        case 'l':
          video.currentTime = Math.min(dur, video.currentTime + 10)
          break
        case 'ArrowUp':
          e.preventDefault()
          video.volume    = Math.min(1, +(video.volume + 0.1).toFixed(2))
          elVolSldr.value = video.volume
          break
        case 'ArrowDown':
          e.preventDefault()
          video.volume    = Math.max(0, +(video.volume - 0.1).toFixed(2))
          elVolSldr.value = video.volume
          break
        case 'm':
          video.muted = !video.muted
          break
        case 'Home':
          e.preventDefault()
          video.currentTime = 0
          break
        case 'End':
          e.preventDefault()
          video.currentTime = dur
          break
        case '>':
        case '.': {
          const ni            = Math.min(SPEEDS.length - 1, SPEEDS.indexOf(video.playbackRate) + 1)
          video.playbackRate  = SPEEDS[ni]
          elSpeed.textContent = SPEEDS[ni] + 'x'
          break
        }
        case '<':
        case ',': {
          const ni            = Math.max(0, SPEEDS.indexOf(video.playbackRate) - 1)
          video.playbackRate  = SPEEDS[ni]
          elSpeed.textContent = SPEEDS[ni] + 'x'
          break
        }
        // 0-9 to jump to 0%-90% through the video (youtube-style)
        case '0': case '1': case '2': case '3': case '4':
        case '5': case '6': case '7': case '8': case '9':
          video.currentTime = dur * (parseInt(e.key, 10) / 10)
          break
      }
      showHud()
    })
  }

  // --- document pip (advanced mode) ---

  async function openDocumentPip(video) {
    if (pipWin) { pipWin.close(); pipWin = null }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture().catch(() => {})
    }

    // remember the video's original dom position for restoration on close
    savedParent = video.parentNode
    savedNext   = video.nextSibling
    savedStyles = {
      width:     video.style.width,
      height:    video.style.height,
      position:  video.style.position,
      maxWidth:  video.style.maxWidth,
      maxHeight: video.style.maxHeight,
    }

    pinned = video

    // size window to match video aspect ratio
    const vw   = video.videoWidth  || 640
    const vh   = video.videoHeight || 360
    const winH = 360
    const winW = Math.round(winH * (vw / vh))

    let win
    try {
      win = await window.documentPictureInPicture.requestWindow({
        width:                  winW,
        height:                 winH,
        disallowReturnToOpener: false,
      })
    } catch (err) {
      // browser denied or csp blocked - fall back to legacy
      console.warn('[pip-anywhere] document pip failed, falling back to legacy:', err)
      openLegacyPip(video)
      return
    }

    pipWin = win

    const style       = win.document.createElement('style')
    style.textContent = HUD_CSS
    win.document.head.appendChild(style)

    buildHud(win.document, video)

    // restore video to its original dom position when the pip window closes.
    // wrapped in tiered try/catch because sites like cineby mutate the player
    // dom while pip is open, leaving savedParent/savedNext in stale states.
    win.addEventListener('pagehide', () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null }
      clearTimeout(hideTimer)
      pipWin = null

      if (savedStyles) Object.assign(video.style, savedStyles)

      try {
        // tier 1: ideal - put it back exactly where it was
        if (savedParent && savedParent.isConnected) {
          if (savedNext && savedNext.isConnected && savedNext.parentNode === savedParent) {
            savedParent.insertBefore(video, savedNext)
          } else {
            savedParent.appendChild(video)
          }
        } else {
          // tier 2: parent is gone - try to find a new home via a fresh query
          // sites that rebuild the player will have a new container in the dom
          const newParent = document.querySelector(
            'video') ? null : document.body
          if (newParent) newParent.appendChild(video)
          // if a fresh video already exists in the dom the site recreated the
          // player itself, so we just let the element sit detached - it'll be
          // garbage collected and the site's player is already working fine
        }
      } catch (e) {
        // tier 3: something still went wrong (race, shadow dom, etc.)
        // swallow silently - the site will handle its own player state
        try { document.body.appendChild(video) } catch (_) {}
      }

      savedParent = savedNext = savedStyles = null
    })
  }

  // --- legacy pip (basic mode / dpip not supported) ---

  async function openLegacyPip(video) {
    pinned = video
    if (document.pictureInPictureElement === video) return
    await video.requestPictureInPicture().catch(() => {})
  }

  // --- dispatch to the right pip implementation ---

  function openPip(video) {
    if (mode === 'advanced' && DPIP_SUPPORTED) {
      openDocumentPip(video)
    } else {
      openLegacyPip(video)
    }
  }

  // --- main pip action ---

  async function triggerPip() {
    // reuse pinned video for the rest of the session
    if (pinned && document.body.contains(pinned)) {
      openPip(pinned)
      return
    }

    const all = getVideos()
    if (!all.length) return

    if (all.length === 1) { openPip(all[0]); return }

    const active = getPlaying()
    if (active.length === 1) { openPip(active[0]); return }
    if (active.length > 1)  { enterSelectMode(active, openPip); return }

    // nothing playing - pick the biggest visible video, probably the main player
    const biggest = all.reduce((a, b) => {
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      return ra.width * ra.height >= rb.width * rb.height ? a : b
    })
    openPip(biggest)
  }

  // --- menu command labels ---

  function pipLabel() {
    if (!DPIP_SUPPORTED) return 'PiP'
    return mode === 'advanced' ? 'PiP  [Advanced]' : 'PiP  [Basic]'
  }

  function toggleLabel() {
    // only show the toggle if the browser actually supports document pip
    if (!DPIP_SUPPORTED) return null
    return mode === 'advanced' ? 'Switch to Basic PiP' : 'Switch to Advanced PiP'
  }

  function registerMenuCommands() {
    if (menuPipId    != null) { try { GM_unregisterMenuCommand(menuPipId)    } catch (e) {} }
    if (menuToggleId != null) { try { GM_unregisterMenuCommand(menuToggleId) } catch (e) {} }

    menuPipId = GM_registerMenuCommand(pipLabel(), triggerPip)

    const label = toggleLabel()
    if (label) menuToggleId = GM_registerMenuCommand(label, toggleMode)
  }

  function toggleMode() {
    mode = mode === 'advanced' ? 'basic' : 'advanced'
    GM_setValue(KEY_MODE, mode)
    registerMenuCommands()
  }

  // boot
  registerMenuCommands()
})()