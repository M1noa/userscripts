// ==UserScript==
// @name            no anti-devtools
// @namespace       https://minoa.cat/
// @version         1.1.0
// @description     kills every known method of devtools detection and blocking. window size spoofing, debugger traps, toString getter traps, timing attacks, keyboard/contextmenu blocking, console method abuse, redirect interception, eval-based loops, and more.
// @author          minoa
// @license         MIT
// @homepageURL     https://greasyfork.org/scripts/no-anti-devtools
// @supportURL      https://github.com/M2noa/no-anti-devtools/issues
// @match           *://*/*
// @exclude         *://*.google.com/*
// @exclude         *://*.google.co.uk/*
// @exclude         *://*.google.ca/*
// @exclude         *://*.google.com.au/*
// @exclude         *://*.googleapis.com/*
// @exclude         *://*.gstatic.com/*
// @exclude         *://*.youtube.com/*
// @exclude         *://*.facebook.com/*
// @exclude         *://*.instagram.com/*
// @exclude         *://*.twitter.com/*
// @exclude         *://*.x.com/*
// @exclude         *://*.microsoft.com/*
// @exclude         *://*.live.com/*
// @exclude         *://*.outlook.com/*
// @exclude         *://*.office.com/*
// @exclude         *://*.apple.com/*
// @exclude         *://*.icloud.com/*
// @exclude         *://*.github.com/*
// @exclude         *://*.gitlab.com/*
// @exclude         *://*.paypal.com/*
// @exclude         *://*.stripe.com/*
// @exclude         *://*.amazon.com/*
// @exclude         *://*.twitch.tv/*
// @exclude         *://*.discord.com/*
// @exclude         *://*.cloudflare.com/*
// @grant           unsafeWindow
// @run-at          document-start
// @downloadURL https://update.greasyfork.org/scripts/570732/no%20anti-devtools.user.js
// @updateURL https://update.greasyfork.org/scripts/570732/no%20anti-devtools.meta.js
// ==/UserScript==

;(function (w) {
  'use strict'

  // --- domain blocklist (runtime safety net) ---
  // @exclude handles most cases, but some managers handle wildcards differently.
  // this catches anything that slips through.

  const BLOCKED_DOMAINS = [
    // google
    'google.com', 'google.co.uk', 'google.ca', 'google.com.au',
    'googleapis.com', 'gstatic.com', 'accounts.google.com',
    'youtube.com',
    // meta
    'facebook.com', 'instagram.com', 'threads.net',
    // twitter / x
    'twitter.com', 'x.com',
    // microsoft
    'microsoft.com', 'live.com', 'outlook.com', 'office.com',
    'microsoftonline.com', 'azure.com',
    // apple
    'apple.com', 'icloud.com',
    // dev platforms
    'github.com', 'gitlab.com',
    // payments
    'paypal.com', 'stripe.com',
    // shopping
    'amazon.com',
    // social / comms
    'twitch.tv', 'discord.com',
    // infra
    'cloudflare.com',
  ]

  function isBlockedDomain() {
    const host = w.location.hostname
    return BLOCKED_DOMAINS.some(d => host === d || host.endsWith('.' + d))
  }

  if (isBlockedDomain()) return

  // all overrides target unsafeWindow (the page's real window context)
  // @run-at document-start means we get in before any page scripts execute

  // --- 1. window size spoofing ---
  // sites compare outerWidth/Height vs innerWidth/Height to detect docked devtools.
  // returning inner values makes the difference always zero.

  try {
    Object.defineProperty(w, 'outerWidth',  { get: () => w.innerWidth,  configurable: true })
    Object.defineProperty(w, 'outerHeight', { get: () => w.innerHeight, configurable: true })
  } catch (e) {}

  // --- 2. keyboard shortcut unblocking ---
  // sites add keydown listeners that preventDefault on F12, ctrl+shift+i/j/c,
  // ctrl+u, ctrl+s etc. we re-add our own capture-phase listener that
  // stopImmediatePropagation()s after restoring the default, so the site's
  // listener never fires. runs at capture so we win the race.

  const DEVTOOLS_KEYS = new Set(['F12', 'I', 'J', 'C', 'U', 'S', 'K', 'P'])

  function isDevtoolsShortcut(e) {
    if (e.key === 'F12') return true
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && DEVTOOLS_KEYS.has(e.key.toUpperCase())) return true
    if ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U')) return true
    return false
  }

  w.addEventListener('keydown', function (e) {
    if (isDevtoolsShortcut(e)) {
      e.stopImmediatePropagation()
      // do not call preventDefault - we want the browser to actually open devtools
    }
  }, true)

  // --- 3. context menu unblocking ---
  // sites add contextmenu listeners with preventDefault to kill right-click.
  // we intercept in capture phase and restore it.

  w.addEventListener('contextmenu', function (e) {
    e.stopImmediatePropagation()
  }, true)

  // --- 4. console method protection ---
  // several attacks abuse console methods:
  //   - console.clear() spam in tight loops to measure timing
  //   - console.log(element_with_getter) to fire a getter when devtools is open
  //   - console.profile()/profileEnd() timing attack
  //   - console.table() used by some detection libs
  // we no-op the dangerous ones while keeping log/warn/error functional.
  // we also preserve a reference to the real ones so the page's own logging
  // still works if anything calls through our shim (they just read .log etc).

  try {
    const con = w.console
    const noop = () => {}

    // no-op methods that detection scripts abuse but real app code rarely needs
    con.clear         = noop
    con.profile       = noop
    con.profileEnd    = noop
    con.table         = noop  // used by some detectors for timing

    // the toString/getter trap fires when devtools evaluates a logged object.
    // we wrap console.log/dir/warn/error/info so that if any argument has a
    // custom getter on .id or .stack, we strip the object out rather than
    // letting devtools evaluate it and trigger the trap.
    const dangerous = ['log', 'dir', 'warn', 'error', 'info', 'debug']
    dangerous.forEach(method => {
      const orig = con[method].bind(con)
      con[method] = function (...args) {
        const safe = args.filter(a => {
          if (a === null || typeof a !== 'object') return true
          try {
            // if .id or .stack have a custom getter, drop the argument
            const idDesc    = Object.getOwnPropertyDescriptor(a, 'id')
            const stackDesc = Object.getOwnPropertyDescriptor(a, 'stack')
            if (idDesc    && typeof idDesc.get    === 'function') return false
            if (stackDesc && typeof stackDesc.get === 'function') return false
          } catch (e) {}
          return true
        })
        if (safe.length) orig(...safe)
      }
    })
  } catch (e) {}

  // --- 5. Object.defineProperty interception ---
  // the id/stack getter trap is set up on dom elements and Error objects.
  // we intercept Object.defineProperty so that any attempt to define a getter
  // on .id or .stack of a non-plain object gets neutralized.
  // we also catch attempts to define devtools-detection getters on window itself.

  const _defineProperty = Object.defineProperty.bind(Object)

  try {
    Object.defineProperty(Object, 'defineProperty', {
      value: function patchedDefineProperty(obj, prop, descriptor) {
        // block getter traps on element .id (the image/div devtools trick)
        if (
          descriptor &&
          typeof descriptor.get === 'function' &&
          (prop === 'id' || prop === 'stack') &&
          obj !== w &&                    // don't block legit window property defs
          obj !== Object.prototype
        ) {
          // replace the getter with a harmless one returning undefined
          descriptor = Object.assign({}, descriptor, { get: () => undefined, set: undefined })
        }
        return _defineProperty(obj, prop, descriptor)
      },
      writable:     true,
      configurable: true,
      enumerable:   false,
    })
  } catch (e) {}

  // --- 6. debugger trap neutralization ---
  // three forms of debugger traps exist:
  //   a) direct `debugger` keyword in a loop / setInterval
  //   b) eval('debugger') or new Function('debugger')() in a loop
  //   c) .constructor('debugger').call() - the obfuscated variant
  // for (a): just disable all breakpoints in devtools (ctrl+f8 in chrome).
  //          we can't kill the keyword itself from JS - that's a browser thing.
  //          what we CAN do is kill the setInterval/setTimeout that drives it.
  // for (b/c): wrap eval and Function so debugger-only calls become no-ops.

  const _eval     = w.eval
  const _Function = w.Function

  const debuggerOnlyRe = /^\s*debugger\s*;?\s*$/

  try {
    w.eval = function safeEval(code) {
      if (typeof code === 'string' && debuggerOnlyRe.test(code)) return undefined
      return _eval.call(w, code)
    }
    // make it look native
    w.eval.toString = () => 'function eval() { [native code] }'
  } catch (e) {}

  try {
    w.Function = function safeFunction(...args) {
      const body = args[args.length - 1]
      if (typeof body === 'string') {
        // strip lone debugger statements from function bodies
        args[args.length - 1] = body.replace(/\bdebugger\b/g, '')
      }
      return _Function(...args)
    }
    // preserve static methods (Function.prototype etc)
    Object.setPrototypeOf(w.Function, _Function)
    w.Function.prototype = _Function.prototype
    w.Function.toString  = () => 'function Function() { [native code] }'
  } catch (e) {}

  // --- 7. setInterval / setTimeout detection loop killing ---
  // the most common detection pattern is a tight setInterval that either:
  //   - runs debugger repeatedly
  //   - checks window size repeatedly
  //   - runs performance.now() timing checks
  //   - logs elements to fire getter traps
  // we wrap both timer functions. intervals/timeouts whose stringified callback
  // contains 'debugger' are dropped. we also track intervals that fire under
  // 1000ms and look like detection (contain known signatures) and neutralize them.

  const _setInterval = w.setInterval
  const _setTimeout  = w.setTimeout
  const _clearInterval = w.clearInterval

  // known strings found in detection loop callbacks
  const DETECTION_SIGS = [
    'debugger',
    'outerWidth', 'outerHeight',        // size check
    'devtools', 'DevTools',             // explicit check
    'firebug', 'Firebug',
    'console.profile', 'profileEnd',    // profile timing
    'performance.now',                  // timing attack
    'DisableDevtool', 'disable-devtool',
  ]

  function looksLikeDetection(fn) {
    if (typeof fn !== 'function') return false
    try {
      const src = _Function.prototype.toString.call(fn)
      return DETECTION_SIGS.some(sig => src.includes(sig))
    } catch (e) {
      return false
    }
  }

  try {
    w.setInterval = function safeSetInterval(fn, delay, ...rest) {
      if (looksLikeDetection(fn)) {
        // return a valid handle so clearInterval doesn't throw, but never fire
        return _setInterval(() => {}, 99999999)
      }
      return _setInterval(fn, delay, ...rest)
    }
    w.setInterval.toString = () => 'function setInterval() { [native code] }'
  } catch (e) {}

  try {
    w.setTimeout = function safeSetTimeout(fn, delay, ...rest) {
      if (looksLikeDetection(fn)) {
        return _setTimeout(() => {}, 99999999)
      }
      return _setTimeout(fn, delay, ...rest)
    }
    w.setTimeout.toString = () => 'function setTimeout() { [native code] }'
  } catch (e) {}

  // --- 8. location / navigation redirect interception ---
  // detection scripts redirect via location.href, location.replace,
  // location.reload, and document.write after detecting devtools.
  // we wrap them - if called from a script context that looks like detection
  // (i.e. no user gesture in the call stack, or the target looks like an error page)
  // we block it. simple heuristic: if reload/replace/write is called while
  // devtools would realistically be open, block it. since we're already bypassing
  // detection, these should never be reached anyway, but belt-and-suspenders.

  const _reload  = w.location.reload.bind(w.location)
  const _replace = w.location.replace.bind(w.location)

  // error page patterns used by common detection libs
  const ERROR_PAGE_RE = /(?:404|blocked|disabled|error|403|detect|devtool)/i

  try {
    Object.defineProperty(w.location, 'reload', {
      get: () => function safeReload() {
        // only allow reload if there was an actual user gesture recently
        // since detection-triggered reloads happen from a setInterval, they
        // won't have a transient user activation
        if (w.navigator.userActivation && w.navigator.userActivation.isActive) {
          _reload()
        }
        // else: silently swallow
      },
      configurable: true,
    })
  } catch (e) {}

  try {
    Object.defineProperty(w.location, 'replace', {
      get: () => function safeReplace(url) {
        if (typeof url === 'string' && ERROR_PAGE_RE.test(url)) return
        _replace(url)
      },
      configurable: true,
    })
  } catch (e) {}

  // document.write is used by some detection scripts to wipe the page
  try {
    const _docWrite = document.write.bind(document)
    document.write = function safeWrite(...args) {
      // only allow document.write during the initial page load
      if (document.readyState === 'loading') return _docWrite(...args)
      // after load, a document.write() would nuke the dom - block it
    }
  } catch (e) {}

  // --- 9. alert / confirm / prompt neutralization ---
  // some detection scripts pop an alert then redirect. since we block the
  // redirect anyway, the alert is just noise. we don't unconditionally no-op
  // these because that would break legit sites. we only intercept them if
  // the message looks like an anti-devtools message.

  const ALERT_BLOCK_RE = /devtools?|inspect|developer\s*tools?|f12|debug/i

  const _alert   = w.alert.bind(w)
  const _confirm = w.confirm.bind(w)

  try {
    w.alert = function safeAlert(msg) {
      if (typeof msg === 'string' && ALERT_BLOCK_RE.test(msg)) return
      _alert(msg)
    }
    w.alert.toString = () => 'function alert() { [native code] }'
  } catch (e) {}

  try {
    w.confirm = function safeConfirm(msg) {
      if (typeof msg === 'string' && ALERT_BLOCK_RE.test(msg)) return true
      return _confirm(msg)
    }
    w.confirm.toString = () => 'function confirm() { [native code] }'
  } catch (e) {}

  // --- 10. firebug / third-party debug lib spoofing ---
  // some old detectors check window.console.firebug or window._firebug.
  // newer ones check for eruda, vconsole, weinre etc.
  // define them as undefined so presence checks return falsy.

  const DEBUGLIB_NAMES = [
    'firebug', '_firebug',
    'eruda', '__eruda',
    'vConsole', 'VConsole',
    'weinre', '__weinre',
    'remoteDebugger',
  ]

  DEBUGLIB_NAMES.forEach(name => {
    try {
      if (w[name] !== undefined) return  // already exists (user has it), don't mask
      Object.defineProperty(w, name, {
        get: () => undefined,
        set: (v) => { /* allow set so eruda can still init if user wants it */ },
        configurable: true,
      })
    } catch (e) {}
  })

  // mask console.firebug specifically (a legacy firefox detection vector)
  try {
    if (w.console && w.console.firebug) {
      Object.defineProperty(w.console, 'firebug', { get: () => undefined, configurable: true })
    }
  } catch (e) {}

  // --- 11. performance.now() timing attack mitigation ---
  // timing attacks measure how long console.log or a debugger statement takes.
  // we add a small random jitter to performance.now() to make timing comparisons
  // unreliable, without breaking legitimate uses (the jitter is <1ms).

  const _perfNow = w.performance.now.bind(w.performance)

  try {
    w.performance.now = function safePerfNow() {
      // sub-millisecond jitter - invisible to real perf measurements,
      // but enough to throw off timing-based detection thresholds
      return _perfNow() + (Math.random() * 0.5)
    }
    w.performance.now.toString = () => 'function now() { [native code] }'
  } catch (e) {}

  // --- 12. toString / regex detection bypass ---
  // some detectors use (/regex/).toString() or Date.toString() on custom
  // objects to get a formatted string that looks different when devtools
  // pretty-prints it. we protect RegExp.prototype.toString from being
  // overridden by page scripts.

  try {
    const _reToString = RegExp.prototype.toString
    Object.defineProperty(RegExp.prototype, 'toString', {
      get: () => _reToString,
      set: () => {},  // silently block overrides
      configurable: false,
    })
  } catch (e) {}

  try {
    const _fnToString = Function.prototype.toString
    Object.defineProperty(Function.prototype, 'toString', {
      get: () => _fnToString,
      set: () => {},
      configurable: false,
    })
  } catch (e) {}

  // --- 13. text selection and drag unblocking ---
  // some sites also disable text selection, copy/cut/paste, and drag as part
  // of their "protection" stack. restore all of these.

  // override the selectstart/copy/cut/dragstart block pattern
  const UNBLOCK_EVENTS = ['selectstart', 'copy', 'cut', 'dragstart', 'paste']
  UNBLOCK_EVENTS.forEach(type => {
    w.addEventListener(type, e => e.stopImmediatePropagation(), true)
  })

  // also undo any css user-select:none set via body.style
  // done after DOMContentLoaded since body doesn't exist yet at document-start
  w.addEventListener('DOMContentLoaded', () => {
    try {
      if (document.body) {
        document.body.style.userSelect    = ''
        document.body.style.webkitUserSelect = ''
      }
    } catch (e) {}
  })

  // --- 14. disable-devtool library kill switch ---
  // if the page loads the popular 'disable-devtool' npm library, it exposes
  // a global DisableDevtool with an isSuspend flag. flipping it stops the lib.
  // we also watch for it being defined and immediately suspend it.

  try {
    if (w.DisableDevtool) {
      w.DisableDevtool.isSuspend = true
    }

    // intercept when it gets defined after us via script tag
    let _ddt = undefined
    Object.defineProperty(w, 'DisableDevtool', {
      get: () => _ddt,
      set: (lib) => {
        _ddt = lib
        if (_ddt && typeof _ddt === 'object') {
          _ddt.isSuspend = true
          if (typeof _ddt.stop === 'function') try { _ddt.stop() } catch (e) {}
        }
      },
      configurable: true,
    })
  } catch (e) {}

  // --- done ---
  // what this can't fully stop (requires patched browser):
  //   - source map request detection (devtools fetches .map files on open)
  //   - cdp-level detection (only relevant for automation, not manual devtools)
  //   - the debugger keyword itself if breakpoints aren't disabled in devtools
  //     (just hit ctrl+f8 / "deactivate breakpoints" in chrome)

})(unsafeWindow)