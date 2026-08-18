// ==UserScript==
// @name         Web Speed Controller
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      2.0.1
// @description  Control the speed of website timers, animations, videos, and Date.now.
// @author       Minoa
// @license      MIT
// @homepageURL  https://gitlab.com/M1noa/userscripts
// @supportURL   https://gitlab.com/M1noa/userscripts/-/issues
// @match        *://*/*
// @grant        none
// @downloadURL  https://update.greasyfork.org/scripts/527158/Web%20Speed%20Controller.user.js
// @updateURL    https://update.greasyfork.org/scripts/527158/Web%20Speed%20Controller.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // ─── UI ────────────────────────────────────────────────────────────────────

    const controls = document.createElement('div');
    controls.style.cssText = `
        position: fixed;
        top: 13px;
        right: 18px;
        background: rgba(15, 23, 42, 0.25);
        padding: 4px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        z-index: 9999999;
        display: flex;
        gap: 4px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        align-items: center;
        transition: all 0.3s ease;
        width: 45px;
        overflow: hidden;
    `;

    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.value = '1';
    input.style.cssText = `
        width: 22px;
        height: 22px;
        background: rgba(30, 41, 59, 0.3);
        border: 1px solid rgba(148, 163, 184, 0.1);
        color: rgba(226, 232, 240, 0.6);
        border-radius: 6px;
        padding: 2px;
        font-size: 12px;
        font-weight: 500;
        text-align: center;
        outline: none;
        transition: all 0.3s ease;
        -moz-appearance: textfield;
        cursor: pointer;
    `;

    const toggleButton = document.createElement('button');
    toggleButton.textContent = 'Enable';
    toggleButton.style.cssText = `
        background: #3b82f6;
        color: #ffffff;
        border: none;
        border-radius: 8px;
        width: 90px;
        height: 36px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 8px 16px;
        white-space: nowrap;
    `;

    let isExpanded = false;
    let isEnabled = false;

    controls.addEventListener('mouseenter', () => {
        if (!isExpanded) {
            controls.style.background = 'rgba(15, 23, 42, 0.45)';
            input.style.color = 'rgba(226, 232, 240, 0.8)';
        }
    });
    controls.addEventListener('mouseleave', () => {
        if (!isExpanded) {
            controls.style.background = 'rgba(15, 23, 42, 0.25)';
            input.style.color = 'rgba(226, 232, 240, 0.6)';
        }
    });

    function expandControls() {
        if (isExpanded) return;
        controls.style.cssText += `
            width: auto;
            padding: 16px;
            background: rgba(15, 23, 42, 0.85);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            border-radius: 12px;
            gap: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.1);
        `;
        input.style.cssText += `
            width: 70px;
            height: 36px;
            padding: 4px 8px;
            font-size: 14px;
            background: rgba(30, 41, 59, 0.8);
            border-radius: 8px;
            border: 2px solid rgba(148, 163, 184, 0.2);
            color: #e2e8f0;
        `;
        toggleButton.style.display = 'flex';
        isExpanded = true;
    }

    input.addEventListener('focus', () => {
        expandControls();
        input.style.borderColor = '#3b82f6';
        input.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.3)';
    });
    input.addEventListener('blur', () => {
        input.style.borderColor = 'rgba(148, 163, 184, 0.2)';
        input.style.boxShadow = 'none';
        input.value = Math.max(1, Math.round(parseFloat(input.value)) || 1);
    });
    input.addEventListener('input', () => {
        input.value = Math.round(parseFloat(input.value));
    });
    input.addEventListener('keydown', (e) => {
        const v = parseInt(input.value) || 1;
        if (e.key === 'ArrowUp') { e.preventDefault(); input.value = v + 1; if (isEnabled) applySpeed(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); input.value = Math.max(1, v - 1); if (isEnabled) applySpeed(); }
    });

    toggleButton.addEventListener('mouseover', () => {
        toggleButton.style.background = isEnabled ? '#dc2626' : '#2563eb';
        toggleButton.style.transform = 'translateY(-1px)';
    });
    toggleButton.addEventListener('mouseout', () => {
        toggleButton.style.background = isEnabled ? '#ef4444' : '#3b82f6';
        toggleButton.style.transform = 'translateY(0)';
    });
    toggleButton.addEventListener('click', () => {
        isEnabled = !isEnabled;
        toggleButton.textContent = isEnabled ? 'Disable' : 'Enable';
        toggleButton.style.background = isEnabled ? '#ef4444' : '#3b82f6';
        if (isEnabled) applySpeed();
        else restoreAll();
    });
    input.addEventListener('change', () => { if (isEnabled) applySpeed(); });

    controls.appendChild(input);
    controls.appendChild(toggleButton);
    document.body.appendChild(controls);

    // ─── Core ──────────────────────────────────────────────────────────────────

    const orig = {
        setTimeout:           window.setTimeout.bind(window),
        setInterval:          window.setInterval.bind(window),
        clearTimeout:         window.clearTimeout.bind(window),
        clearInterval:        window.clearInterval.bind(window),
        requestAnimationFrame: window.requestAnimationFrame.bind(window),
        dateNow:              Date.now.bind(Date),
        Date:                 Date,
        perfNow:              performance.now.bind(performance),
    };

    let speed = 1;
    // Wall-clock anchor for Date/performance warping
    let warpRealBase  = orig.dateNow();
    let warpVirtBase  = orig.dateNow();
    let perfRealBase  = orig.perfNow();
    let perfVirtBase  = orig.perfNow();

    // ── 1. setTimeout / setInterval ───────────────────────────────────────────
    function patchTimers() {
        window.setTimeout = (cb, delay, ...args) =>
            orig.setTimeout(cb, (delay || 0) / speed, ...args);
        window.setInterval = (cb, delay, ...args) =>
            orig.setInterval(cb, (delay || 0) / speed, ...args);
    }

    // ── 2. requestAnimationFrame ──────────────────────────────────────────────
    function patchRAF() {
        window.requestAnimationFrame = (cb) =>
            orig.requestAnimationFrame((ts) => cb(ts * speed));
    }

    // ── 3. Date.now / new Date() ──────────────────────────────────────────────
    function virtualNow() {
        const elapsed = orig.dateNow() - warpRealBase;
        return warpVirtBase + elapsed * speed;
    }

    function patchDate() {
        function FakeDate(...args) {
            if (args.length === 0) return new orig.Date(virtualNow());
            return new orig.Date(...args);
        }
        FakeDate.prototype      = orig.Date.prototype;
        FakeDate.now            = virtualNow;
        FakeDate.parse          = orig.Date.parse;
        FakeDate.UTC            = orig.Date.UTC;
        window.Date             = FakeDate;
    }

    // ── 4. performance.now() ──────────────────────────────────────────────────
    function patchPerformance() {
        const desc = Object.getOwnPropertyDescriptor(Performance.prototype, 'now');
        Object.defineProperty(performance, 'now', {
            value: function() {
                const elapsed = orig.perfNow() - perfRealBase;
                return perfVirtBase + elapsed * speed;
            },
            configurable: true,
            writable: true,
        });
    }

    // ── 5. Videos / audio (<video> and <audio>) ───────────────────────────────
    function applyMediaSpeed() {
        document.querySelectorAll('video, audio').forEach(el => {
            el.playbackRate = speed;
        });
    }

    // Watch for new media elements added after patch
    let mediaObserver = null;
    function watchNewMedia() {
        if (mediaObserver) return;
        mediaObserver = new MutationObserver((mutations) => {
            if (!isEnabled) return;
            for (const m of mutations) {
                m.addedNodes.forEach(node => {
                    if (node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO') {
                        node.playbackRate = speed;
                    }
                    if (node.querySelectorAll) {
                        node.querySelectorAll('video, audio').forEach(el => {
                            el.playbackRate = speed;
                        });
                    }
                });
            }
        });
        mediaObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    // Also patch the play() method so any newly-played element gets the right rate
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
        if (isEnabled) this.playbackRate = speed;
        return origPlay.call(this);
    };

    // ── 6. CSS / Web Animations ───────────────────────────────────────────────
    function applyAnimationSpeed() {
        // Web Animations API — covers CSS animations & transitions that are
        // represented as Animation objects (Chrome/Firefox/Edge)
        if (document.getAnimations) {
            document.getAnimations().forEach(anim => {
                anim.playbackRate = speed;
            });
        }

        // document.timeline.currentTime is read-only in most browsers, but
        // individual Animation.playbackRate is the right lever above.
        // As a fallback, inject a <style> that overrides animation/transition
        // durations on every element via a CSS custom property trick.
        applyAnimationCSS();
    }

    let animStyleEl = null;
    function applyAnimationCSS() {
        if (!animStyleEl) {
            animStyleEl = document.createElement('style');
            animStyleEl.id = '__wsc_anim__';
            document.head.appendChild(animStyleEl);
        }
        // Divide all declared durations by the speed factor.
        // This targets elements that don't use the Web Animations API.
        animStyleEl.textContent = `
            *, *::before, *::after {
                animation-duration:        calc(var(--wsc-dur, 1s) / ${speed}) !important;
                animation-delay:           calc(var(--wsc-del, 0s) / ${speed}) !important;
                transition-duration:       calc(var(--wsc-tdur, 0s) / ${speed}) !important;
                transition-delay:          calc(var(--wsc-tdel, 0s) / ${speed}) !important;
            }
        `;
        // Note: because most sites set literal values (not --wsc-* vars) this
        // override is imperfect for CSS-defined durations, but the Web Animations
        // playbackRate above covers the vast majority of animated content.
    }

    function removeAnimationCSS() {
        if (animStyleEl) {
            animStyleEl.textContent = '';
        }
    }

    // Re-apply Web Animations playbackRate on new animations (MutationObserver
    // doesn't catch new Animation objects, but we can poll lightly)
    let animPoller = null;
    function startAnimPoller() {
        if (animPoller) return;
        animPoller = orig.setInterval(() => {
            if (!isEnabled || !document.getAnimations) return;
            document.getAnimations().forEach(anim => {
                if (anim.playbackRate !== speed) anim.playbackRate = speed;
            });
        }, 200);
    }
    function stopAnimPoller() {
        if (animPoller) { orig.clearInterval(animPoller); animPoller = null; }
    }

    // ─── Apply / Restore ───────────────────────────────────────────────────────

    function applySpeed() {
        speed = Math.max(1, parseInt(input.value) || 1);

        // Reset time warp anchors so there's no jump
        warpRealBase = orig.dateNow();
        warpVirtBase = orig.dateNow();
        perfRealBase = orig.perfNow();
        perfVirtBase = orig.perfNow();

        patchTimers();
        patchRAF();
        patchDate();
        patchPerformance();
        applyMediaSpeed();
        watchNewMedia();
        applyAnimationSpeed();
        startAnimPoller();
    }

    function restoreAll() {
        window.setTimeout           = orig.setTimeout;
        window.setInterval          = orig.setInterval;
        window.requestAnimationFrame = orig.requestAnimationFrame;
        window.Date                 = orig.Date;
        Object.defineProperty(performance, 'now', {
            value: orig.perfNow, configurable: true, writable: true
        });

        // Restore media
        document.querySelectorAll('video, audio').forEach(el => {
            el.playbackRate = 1;
        });

        // Restore animations
        if (document.getAnimations) {
            document.getAnimations().forEach(anim => { anim.playbackRate = 1; });
        }
        removeAnimationCSS();
        stopAnimPoller();

        if (mediaObserver) { mediaObserver.disconnect(); mediaObserver = null; }

        speed = 1;
    }

})();