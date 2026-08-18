// ==UserScript==
// @name         Fandom Wiki Sanitizer
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      3.0.1
// @description  Strips Fandom branding, ads, popups, and trackers. Blocks all tracking network requests (fetch, XHR, sendBeacon). Redirects minecraft.fandom.com to minecraft.wiki.
// @author       Minoa
// @license      MIT
// @homepageURL  https://gitlab.com/M1noa/userscripts
// @supportURL   https://gitlab.com/M1noa/userscripts/-/issues
// @match        *://*.fandom.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        unsafeWindow
// @downloadURL  https://update.greasyfork.org/scripts/571712/Fandom%20Wiki%20Sanitizer.user.js
// @updateURL    https://update.greasyfork.org/scripts/571712/Fandom%20Wiki%20Sanitizer.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // use unsafeWindow when available so prototype patches affect the real page
    // context, not just the userscript sandbox
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // =========================================================================
    // 1. MINECRAFT WIKI REDIRECT
    // =========================================================================

    if (win.location.hostname === 'minecraft.fandom.com') {
        const m = win.location.pathname.match(/^\/wiki\/(.+)/);
        win.location.replace(
            m ? `https://minecraft.wiki/w/${m[1]}${win.location.search}${win.location.hash}`
              : 'https://minecraft.wiki'
        );
        return;
    }

    // =========================================================================
    // 2. BLOCKED DOMAINS & PATTERNS
    //
    // blocking strategy:
    //   - BLOCKED_DOMAINS:   exact hostname or any subdomain thereof
    //   - BLOCKED_URL_PARTS: substring match against the full url string
    //     (catches path segments like /__track/, /beacon/, /pixel/, etc.
    //      regardless of which domain serves them)
    //
    // this two-layer approach means a new fandom subdomain or cdn change
    // still gets caught if the path contains a known tracking segment.
    // =========================================================================

    const BLOCKED_DOMAINS = [
        // fandom internal telemetry
        'beacon.wikia-services.com',
        'services.fandom.com',
        'tracking.fandom.com',
        // analytics
        'scorecardresearch.com',
        'quantserve.com',
        'quantcount.com',
        'crazyegg.com',
        'brandmetrics.com',
        // ad serving & bidding
        'doubleclick.net',
        'googlesyndication.com',
        'googletagservices.com',
        'googletagmanager.com',
        'amazon-adsystem.com',
        'rubiconproject.com',
        'pubmatic.com',
        'openx.net',
        'gumgum.com',
        'adsrvr.org',
        '3lift.com',
        'kargo.com',
        'media.net',
        'servenobid.com',
        '1rx.io',
        'cpx.to',
        'yellowblue.io',
        'seedtag.com',
        'onetag-sys.com',
        'sharethrough.com',
        'smartadserver.com',
        'taboola.com',
        'outbrain.com',
        // identity & fingerprinting
        'id5-sync.com',
        'crwdcntrl.net',
        'adsafeprotected.com',
        'btloader.com',
        'btmessage.com',
        'lijit.com',
        'audigent.com',
        'bounceexchange.com',
        // consent management (they already gave themselves consent)
        'cookielaw.org',
        'onetrust.com',
        'privacymanager.io',
        // video ad players
        'anyclip.com',
        'player.anyclip.com',
        'jwplayer.com',
        'cdn.jwplayer.com',
    ];

    // path/filename substrings — catches tracking endpoints and bundles
    // regardless of the hosting domain
    const BLOCKED_URL_PARTS = [
        '/__track/',
        '/beacon/',
        '/telemetry',
        '/analytics',
        '/tracking',
        '/tracker',
        '/heartbeat',
        '/pixel',
        '/fingerprint',
        '/prebid',
        'gpt.js',
        'pubads',
        'ad-engine',
        'adtech',
        'SwitchTheme',
        'PreferencesHelper',
    ];

    /**
     * returns true if the url should be blocked
     * checks domain list first (O(n) but n is small), then path substrings
     * @param {string} url
     * @returns {boolean}
     */
    const isBlocked = (url) => {
        if (!url || typeof url !== 'string') return false;
        let hostname = '';
        let fullUrl = url;
        try {
            const p = new URL(url, win.location.href);
            hostname = p.hostname;
            fullUrl  = p.href;
        } catch (_) {
            // relative or malformed url — fall through to substring match only
        }
        if (hostname && BLOCKED_DOMAINS.some(d =>
            hostname === d || hostname.endsWith('.' + d)
        )) return true;
        const lower = fullUrl.toLowerCase();
        return BLOCKED_URL_PARTS.some(part => lower.includes(part.toLowerCase()));
    };

    // =========================================================================
    // 3. CONSOLE SPAM SUPPRESSION
    // locked with Object.defineProperty so fandom can't restore the originals
    // =========================================================================

    const NOISE_PATTERNS = [
        'silverSurfer', 'pathfinder',
        '[gsi_logger]', '[audigent]', '[fandomcmp]',
        'jw player', 'anyclip',
        'resourceloader', 'nielsen log',
        'attestation check for shared storage',
        'cors -- failed to access iframe window',
        'cookie consent', 'prebid',
        'gpt.js', 'pubads', 'ad-engine',
        'fandomtracking', '__track',
        'switchtheme', 'preferenceshelper',
        'heartbeat', 'beacon',
    ];

    const safeStr = (a) => {
        if (typeof a === 'string') return a.toLowerCase();
        if (a == null) return '';
        try { return JSON.stringify(a).toLowerCase(); } catch (_) { return String(a).toLowerCase(); }
    };

    const isNoisy = (...args) =>
        args.some(a => NOISE_PATTERNS.some(p => safeStr(a).includes(p)));

    ['log', 'warn', 'error', 'info', 'debug'].forEach(method => {
        const orig = win.console[method].bind(win.console);
        const patched = (...args) => { if (!isNoisy(...args)) orig(...args); };
        try {
            Object.defineProperty(win.console, method, {
                get: () => patched,
                set: () => {},      // discard any attempt to restore originals
                configurable: false,
                enumerable: true,
            });
        } catch (_) {
            win.console[method] = patched;
        }
    });

    // =========================================================================
    // 4. FETCH INTERCEPTION
    // returns a fake empty 200 so callers don't throw on a rejected promise
    // =========================================================================

    const _origFetch = win.fetch.bind(win);
    const fakeOk = () =>
        Promise.resolve(new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } }));

    const guardedFetch = (input, init) => {
        const url = (input instanceof Request) ? input.url : String(input);
        return isBlocked(url) ? fakeOk() : _origFetch(input, init);
    };

    try {
        Object.defineProperty(win, 'fetch', {
            get: () => guardedFetch,
            set: () => {},
            configurable: false,
        });
    } catch (_) { win.fetch = guardedFetch; }

    // =========================================================================
    // 5. XMLHTTPREQUEST INTERCEPTION
    // =========================================================================

    const _XHROpen = win.XMLHttpRequest.prototype.open;
    const _XHRSend = win.XMLHttpRequest.prototype.send;
    const _blockedXhr = new WeakSet();

    win.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (isBlocked(String(url))) { _blockedXhr.add(this); return; }
        return _XHROpen.call(this, method, url, ...rest);
    };

    win.XMLHttpRequest.prototype.send = function (...args) {
        if (_blockedXhr.has(this)) { try { this.abort(); } catch (_) {} return; }
        return _XHRSend.apply(this, args);
    };

    // =========================================================================
    // 6. NAVIGATOR.SENDBEACON INTERCEPTION
    //
    // this is the api that was letting requests slip through.
    // sendBeacon is specifically designed for fire-and-forget tracking pings —
    // it bypasses fetch and xhr overrides entirely.
    // return false (the spec's "failed to queue" signal) for blocked urls.
    // =========================================================================

    if (win.navigator && typeof win.navigator.sendBeacon === 'function') {
        const _origBeacon = win.navigator.sendBeacon.bind(win.navigator);
        const guardedBeacon = (url, data) => {
            if (isBlocked(String(url))) return false; // silently drop
            return _origBeacon(url, data);
        };
        try {
            // sendBeacon lives on the Navigator prototype
            Object.defineProperty(win.Navigator.prototype, 'sendBeacon', {
                get: () => guardedBeacon,
                set: () => {},
                configurable: false,
            });
        } catch (_) {
            // fallback: patch the instance directly
            try { win.navigator.sendBeacon = guardedBeacon; } catch (_) {}
        }
    }

    // =========================================================================
    // 7. DYNAMIC SCRIPT INJECTION BLOCKING
    // intercepts appendChild / insertBefore synchronously — the network
    // request never fires because we discard the node before it's attached
    // =========================================================================

    const isBlockedScript = (node) => {
        if (!node || (node.tagName || '').toUpperCase() !== 'SCRIPT') return false;
        const src = node.src || node.getAttribute?.('src') || '';
        return !!src && isBlocked(src);
    };

    const _appendChild  = win.Node.prototype.appendChild;
    const _insertBefore = win.Node.prototype.insertBefore;

    win.Node.prototype.appendChild = function (node) {
        if (isBlockedScript(node)) return node;
        return _appendChild.call(this, node);
    };

    win.Node.prototype.insertBefore = function (node, ref) {
        if (isBlockedScript(node)) return node;
        return _insertBefore.call(this, node, ref);
    };

    // =========================================================================
    // 8. CSS — hide ads, branding, popups, video players
    // =========================================================================

    const HIDE_CSS = `
        /* popups / modals / consent */
        #age-gate,
        .AgeGateDialog-module_modal__huX7o,
        .Modal_overlay__7pQwi,
        #onetrust-consent-sdk,
        #onetrust-banner-sdk,
        #onetrust-pc-sdk,
        .onetrust-pc-dark-filter,
        .marketing-notifications,
        .banner-notifications-placeholder,
        .wds-banner-notification__container,
        #onetap_google_intermediate_iframe,
        .highlight__sticky-container,
        #highlight-portal-modal-container
        { display: none !important; }

        /* ads */
        fandom-ad,
        .top_leaderboard-odyssey-wrapper,
        .bottom-ads-container,
        .incontent_leaderboard,
        #WikiaAdInContentPlaceHolder,
        #rail-boxad-wrapper,
        #floor_adhesion_wrapper,
        .ae-translatable-label,
        .ad-slot-placeholder
        { display: none !important; }

        /* video players */
        fandom-video-ad,
        .ac-lre-player,
        .ac-player-wrapper,
        .acw,
        #incontent_player_container,
        #featured-video__player-container,
        .featured-video-player-container
        { display: none !important; }

        /* fandom chrome */
        .global-top-navigation,
        #global-top-navigation,
        .global-explore-navigation,
        #global-explore-navigation,
        .fandom-sticky-header,
        #community-navigation,
        fandom-community-header,
        .fandom-community-header__background,
        .global-footer,
        .page-footer__trfc-147,
        .page-footer,
        .page-side-tools
        { display: none !important; }

        /* right rail — preserve toc if it lives there */
        .page__right-rail,
        #WikiaRail,
        .rail-module:not(#toc)
        { display: none !important; }

        /* layout reset — fill the space left by removed nav */
        :root {
            --desktop-global-navigation-width: 0px !important;
            --left-panel-spacing:              0px !important;
        }
        .main-container,
        .page,
        .resizable-container {
            margin-left:  0 !important;
            margin-top:   0 !important;
            padding-left: 0 !important;
            padding-top:  0 !important;
            max-width: 100% !important;
        }
    `;

    if (typeof GM_addStyle === 'function') {
        GM_addStyle(HIDE_CSS);
    } else {
        const s = document.createElement('style');
        s.textContent = HIDE_CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    // =========================================================================
    // 9. DOM MUTATIONOBSERVER — purge dynamically injected elements
    // =========================================================================

    const NUKE_SELECTORS = [
        '#age-gate', '.AgeGateDialog-module_modal__huX7o', '.Modal_overlay__7pQwi',
        '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#onetrust-pc-sdk',
        '.onetrust-pc-dark-filter', '.marketing-notifications',
        '.banner-notifications-placeholder', '.wds-banner-notification__container',
        '.highlight__sticky-container', '#highlight-portal-modal-container',
        'fandom-ad', 'fandom-video-ad', 'fandom-community-header',
        '.top_leaderboard-odyssey-wrapper', '.bottom-ads-container',
        '.incontent_leaderboard', '#WikiaAdInContentPlaceHolder',
        '#rail-boxad-wrapper', '#floor_adhesion_wrapper', '.ad-slot-placeholder',
        '.ac-lre-player', '.ac-player-wrapper', '.acw',
        '#incontent_player_container', '#featured-video__player-container',
        '.featured-video-player-container',
        '.global-top-navigation', '#global-top-navigation',
        '.global-explore-navigation', '#global-explore-navigation',
        '.fandom-sticky-header', '#community-navigation',
        '.fandom-community-header__background',
        '.global-footer', '.page-footer', '.page-footer__trfc-147',
        '.page-side-tools', '.page__right-rail', '#WikiaRail',
    ];

    const BLOCKED_IFRAME_SUBSTRINGS = [
        'smartlock', 'doubleclick', 'anyclip', 'jwplayer', 'onetrust', '__track',
    ];

    const nuke = (el) => { try { el?.parentNode?.removeChild(el); } catch (_) {} };

    const sweepSubtree = (root) => {
        if (!root || root.nodeType !== Node.ELEMENT_NODE) return;

        NUKE_SELECTORS.forEach(sel => {
            try {
                if (root.matches?.(sel)) { nuke(root); return; }
                root.querySelectorAll?.(sel).forEach(nuke);
            } catch (_) {}
        });

        // blocked iframes
        const killIframe = (el) => {
            if (el.tagName !== 'IFRAME') return;
            const src = el.src || el.getAttribute?.('src') || '';
            if (BLOCKED_IFRAME_SUBSTRINGS.some(p => src.includes(p)) || isBlocked(src)) nuke(el);
        };
        killIframe(root);
        root.querySelectorAll?.('iframe').forEach(killIframe);

        // fallback script removal (belt-and-suspenders behind the appendChild override)
        root.querySelectorAll?.('script[src]').forEach(s => { if (isBlocked(s.src)) nuke(s); });
    };

    document.addEventListener('DOMContentLoaded', () => {
        if (document.body) sweepSubtree(document.body);
    }, { once: true });

    new MutationObserver(mutations => {
        for (const { addedNodes } of mutations)
            addedNodes.forEach(node => sweepSubtree(node));
    }).observe(document.documentElement, { childList: true, subtree: true });

    // =========================================================================
    // 10. PAGE TITLE CLEANUP
    // strips " | Fandom", " - Fandom", " — Fandom", or " - <n> Wiki"
    // also handles spa navigation where fandom rewrites the title after load
    // =========================================================================

    const TITLE_RE = /\s*[|\-\u2013\u2014]\s*(Fandom|.+?\s+Wiki)\s*$/i;

    const cleanTitle = () => {
        const cleaned = document.title.replace(TITLE_RE, '').trim();
        if (cleaned && cleaned !== document.title) document.title = cleaned;
    };

    const watchTitle = () => {
        cleanTitle();
        const titleEl = document.querySelector('title');
        if (titleEl) {
            new MutationObserver(cleanTitle).observe(titleEl, {
                childList: true, characterData: true, subtree: true,
            });
        }
    };

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', watchTitle, { once: true })
        : watchTitle();

})();