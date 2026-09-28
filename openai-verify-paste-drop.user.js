// ==UserScript==
// @name         OpenAI Verify Paste Drop Upload
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      1.1.0
// @description  Paste, drag-drop (incl. images from other tabs), and reveal hidden provenance details (issuer, validation, check time) on OpenAI Verify.
// @author       Minoa
// @license      MIT
// @homepageURL  https://gitlab.com/M1noa/userscripts
// @supportURL   https://gitlab.com/M1noa/userscripts/-/issues
// @match        https://openai.com/research/verify*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // find current file input (react id changes)
    function findInput() {
        return document.querySelector('label.group\\/upload input[type="file"]')
            || document.querySelector('label[class*="upload"] input[type="file"]')
            || document.querySelector('input[type="file"][accept*="image/png"]');
    }

    // feed files into the input so react picks it up
    function feedFiles(files) {
        if (!files || !files.length) return false;
        const input = findInput();
        if (!input) return false;
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    // paste anywhere -> upload image/audio from clipboard
    document.addEventListener('paste', (e) => {
        if (e.target instanceof Element && e.target.closest('input, textarea')) return; // let text fields keep paste
        const cd = e.clipboardData;
        if (!cd) return;
        let files = [...(cd.files || [])];
        if (!files.length && cd.items) { // screenshots often arrive via items only
            files = [...cd.items]
                .filter((it) => it.kind === 'file' && /^(image|audio)\//.test(it.type))
                .map((it) => it.getAsFile())
                .filter(Boolean);
        }
        if (files.length && feedFiles(files)) e.preventDefault();
    }, true);

    // --- cross-tab drag: image dragged from another tab carries no Files,
    // only text/uri-list or html. fetch the url into a File and upload it.
    function hasDropData(dt) {
        const t = [...(dt && dt.types || [])];
        return t.includes('Files') || t.includes('text/uri-list') || t.includes('text/html') || t.includes('text/plain');
    }

    function urlFromDrop(dt) {
        const uri = dt.getData('text/uri-list');
        if (uri) {
            const line = uri.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
            if (line) return line;
        }
        const html = dt.getData('text/html');
        if (html) {
            const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
            if (m) return m[1];
        }
        const txt = (dt.getData('text/plain') || '').trim();
        if (/^https?:\/\/\S+$/i.test(txt)) return txt;
        return null;
    }

    async function urlToFile(url) {
        const r = await fetch(url);
        if (!r.ok) throw 0;
        const b = await r.blob();
        if (!/^(image|audio)\//.test(b.type)) throw 0;
        let name = 'dropped-file';
        try {
            const p = new URL(url, location.href).pathname.split('/').pop();
            if (p) name = decodeURIComponent(p);
        } catch {}
        if (!/\.\w{2,5}$/.test(name)) {
            const ext = (b.type.split('/')[1] || '').split(';')[0].split('+')[0];
            if (ext) name += '.' + ext;
        }
        return new File([b], name, { type: b.type });
    }

    // drop anywhere -> upload instead of navigating
    let dragDepth = 0;
    function dropzone() {
        return document.querySelector('label[class*="upload"]') || findInput();
    }
    function clearOutline() {
        const z = dropzone();
        if (z) z.style.outline = '', z.style.outlineOffset = '';
    }

    document.addEventListener('dragenter', (e) => {
        if (!hasDropData(e.dataTransfer)) return;
        dragDepth++;
        const z = dropzone();
        if (z) z.style.outline = '2px dashed #1a7f37', z.style.outlineOffset = '4px';
    }, true);

    document.addEventListener('dragleave', () => {
        if (--dragDepth <= 0) {
            dragDepth = 0;
            clearOutline();
        }
    }, true);

    document.addEventListener('dragover', (e) => {
        if (hasDropData(e.dataTransfer)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    }, true);

    document.addEventListener('drop', async (e) => {
        dragDepth = 0;
        clearOutline();
        const dt = e.dataTransfer;
        if (!dt || !hasDropData(dt)) return;
        e.preventDefault();
        if (dt.files && dt.files.length) {
            feedFiles(dt.files);
            return;
        }
        const url = urlFromDrop(dt);
        if (!url) return;
        try {
            feedFiles([await urlToFile(url)]);
        } catch {}
    }, true);

    // --- reveal hidden provenance fields: the api returns issuer,
    // validation_state, created_at but the page only renders model +
    // generated_at. append the rest inside the details cards, native style.
    let lastResp = null;
    const origFetch = window.fetch;
    window.fetch = function (url) {
        const p = origFetch.apply(this, arguments);
        try {
            const u = typeof url === 'string' ? url : url && url.url;
            if (u && String(u).includes('provenance_checks')) {
                p.then((r) => {
                    r.clone().json().then((j) => { lastResp = j; }, () => {});
                }, () => {});
            }
        } catch {}
        return p;
    };

    function enhance() {
        if (!lastResp || !Array.isArray(lastResp.results)) return;
        for (const sp of document.querySelectorAll('span')) {
            const t = sp.textContent || '';
            const type = /synthid/i.test(t) ? 'synthid'
                : /content credentials/i.test(t) ? 'c2pa' : null;
            if (!type) continue;
            const card = sp.closest('div.space-y-2');
            if (!card || card.dataset.opvd) continue;
            const r = lastResp.results.find((x) => x.type === type);
            if (!r) continue;
            const lines = [];
            if (r.issuer) lines.push('Issuer: ' + r.issuer);
            if (r.validation_state && r.validation_state !== 'not_present') {
                lines.push('Validation: ' + String(r.validation_state).replace(/_/g, ' '));
            }
            // model + generated_at already shown in header, skip
            for (const line of lines) {
                const p = document.createElement('p');
                p.className = 'text-p2 text-primary-80';
                p.textContent = line;
                card.appendChild(p);
            }
            card.dataset.opvd = '1';
            const box = card.parentElement;
            if (box && !box.dataset.opvd && lastResp.created_at) {
                const d = new Date(lastResp.created_at * 1000);
                if (!isNaN(d)) {
                    const p = document.createElement('p');
                    p.className = 'text-p2 text-primary-60';
                    p.textContent = 'Checked: ' + d.toLocaleString(undefined, {
                        year: 'numeric', month: 'short', day: 'numeric',
                        hour: 'numeric', minute: '2-digit',
                    });
                    box.appendChild(p);
                    box.dataset.opvd = '1';
                }
            }
        }
    }

    new MutationObserver(enhance).observe(document.documentElement, { childList: true, subtree: true });
    enhance();
})();
