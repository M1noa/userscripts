// ==UserScript==
// @name         VidFast Pro Adblocker & Popunder Remover
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Blocks click ads, popunders, and anti-adblock on vidfast.pro
// @author       Minoa
// @license      MIT
// @match        *://vidfast.pro/*
// @match        *://*.vidfast.pro/*
// @run-at       document-start
// @grant        none
// @downloadURL https://update.greasyfork.org/scripts/574316/VidFast%20Pro%20Adblocker%20%20Popunder%20Remover.user.js
// @updateURL https://update.greasyfork.org/scripts/574316/VidFast%20Pro%20Adblocker%20%20Popunder%20Remover.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // 1. Bypass anti-adblock by spoofing offsetHeight on ad elements
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        get: function() {
            if (this.className && typeof this.className === 'string' && this.className.includes('ad_slot')) {
                return 1;
            }
            return originalOffsetHeight.get.call(this);
        },
        enumerable: originalOffsetHeight.enumerable,
        configurable: originalOffsetHeight.configurable
    });

    // 2. Block popunder click listeners injected on the document
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = new Proxy(originalAddEventListener, {
        apply: function(target, thisArg, args) {
            const [type, listener] = args;
            if (type === 'mousedown' || type === 'click' || type === 'mouseup' || type === 'touchstart') {
                const listenerStr = typeof listener === 'function' ? listener.toString() : '';
                if (listenerStr.includes('shown_at') ||
                    listenerStr.includes('unloaded_at') ||
                    listenerStr.includes('ad_slot') ||
                    (listenerStr.includes('localStorage') && listenerStr.includes('setItem'))) {
                    return;
                }
            }
            return Reflect.apply(target, thisArg, args);
        }
    });

    // 3. Block window.open popups
    window.open = new Proxy(window.open, {
        apply: function() {
            return { closed: false, focus: () => {}, close: () => {} };
        }
    });

    // 4. Block hidden form submissions used as a popunder fallback
    HTMLFormElement.prototype.submit = new Proxy(HTMLFormElement.prototype.submit, {
        apply: function(target, thisArg, args) {
            if (thisArg.target === '_blank' && (thisArg.style.display === 'none' || thisArg.style.opacity === '0' || thisArg.style.position === 'absolute')) {
                return;
            }
            return Reflect.apply(target, thisArg, args);
        }
    });

    // 5. Block dynamic ad script injection via strict domain whitelist
    const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    const trustedDomains = [
        'vidfast.pro',
        'googletagmanager.com',
        'google-analytics.com',
        'cloudflareinsights.com',
        'tmdb.org'
    ];

    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        set: function(val) {
            if (val) {
                try {
                    const url = new URL(val, window.location.href);
                    if (!trustedDomains.some(domain => url.hostname.endsWith(domain))) {
                        return;
                    }
                } catch (e) {}
            }
            return originalSrcDescriptor.set.call(this, val);
        },
        get: originalSrcDescriptor.get
    });

})();