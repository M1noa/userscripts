// ==UserScript==
// @name         Google Docs Copy Unlock
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      1.0.0
// @description  Copy anything from a Google Doc even when the owner disabled copying. Rebuilds the selection (or the whole document) as plain text and HTML.
// @author       Minoa
// @license      MIT
// @homepageURL  https://gitlab.com/M1noa/userscripts
// @supportURL   https://gitlab.com/M1noa/userscripts/-/issues
// @match        https://docs.google.com/document/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // docs still ships the full body as plain text in its bootstrap: DOCS_modelChunk
    // is a list of {ty:"is", ibi:<offset>, s:"<text>"} insert chunks. no gating touches it.
    let modelText = null;

    function readModelText() {
        if (modelText !== null) return modelText;
        const chunks = [];
        for (const s of document.querySelectorAll('script')) {
            const t = s.textContent;
            if (!t || t.indexOf('DOCS_modelChunk') === -1) continue;
            const re = /DOCS_modelChunk\s*=\s*\{/g;
            let m;
            while ((m = re.exec(t))) {
                const start = m.index + m[0].length - 1;
                let depth = 0, end = start;
                for (let i = start; i < t.length; i++) {
                    if (t[i] === '{') depth++;
                    else if (t[i] === '}' && --depth === 0) { end = i + 1; break; }
                }
                try {
                    const payload = JSON.parse(t.slice(start, end));
                    for (const c of payload.chunk || []) {
                        if (c.ty === 'is' && typeof c.s === 'string') {
                            chunks.push([c.ibi || 0, c.s]);
                        }
                    }
                } catch (e) {
                    // one bad chunk shouldn't kill the rest
                }
            }
        }
        if (!chunks.length) return (modelText = '');
        // chunks arrive in order but offsets are authoritative; join by offset
        chunks.sort((a, b) => a[0] - b[0]);
        modelText = chunks.map(c => c[1]).join('');
        return modelText;
    }

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function toHtml(text) {
        return text
            .split(/\n{2,}/)
            .map(para => para.trim())
            .filter(Boolean)
            .map(para => '<p>' + escapeHtml(para).replace(/\n/g, '<br>') + '</p>')
            .join('\n');
    }

    // the visible selection: docs paints to canvas, but when a text layer exists this is exact
    function selectedText() {
        const sel = window.getSelection();
        const t = sel ? String(sel).replace(/​/g, '') : '';
        return t.trim() ? t : '';
    }

    function payload() {
        const sel = selectedText();
        if (sel) return sel;
        return readModelText();
    }

    // run before docs' own handler so it can't overwrite or clear what we set
    function onCopy(e) {
        const text = payload();
        if (!text) return;
        if (!e.clipboardData) return;
        e.clipboardData.setData('text/plain', text);
        e.clipboardData.setData('text/html', toHtml(text));
        e.preventDefault();
        e.stopImmediatePropagation();
    }

    // capture on window fires ahead of the document/appview listeners
    window.addEventListener('copy', onCopy, true);
    window.addEventListener('cut', onCopy, true);

    // docs blocks the native context menu copy in some modes; offer an explicit escape hatch
    function copyAll() {
        const text = readModelText();
        if (!text) return false;
        return navigator.clipboard.writeText(text).then(
            () => true,
            () => false
        );
    }

    // ctrl/cmd+shift+c copies the entire document regardless of selection
    window.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
            e.preventDefault();
            e.stopImmediatePropagation();
            copyAll();
        }
    }, true);

    // small affordance so the escape hatch is discoverable
    function addButton() {
        if (document.getElementById('gdcu-copyall')) return;
        const b = document.createElement('button');
        b.id = 'gdcu-copyall';
        b.textContent = 'Copy entire document';
        b.title = 'Copies the whole document text to the clipboard';
        b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;' +
            'padding:8px 12px;font:13px/1.2 system-ui,sans-serif;cursor:pointer;' +
            'background:#1a73e8;color:#fff;border:0;border-radius:4px;opacity:.85;';
        b.addEventListener('click', async () => {
            const ok = await copyAll();
            b.textContent = ok ? 'Copied' : 'Copy failed';
            setTimeout(() => { b.textContent = 'Copy entire document'; }, 1500);
        });
        document.body.appendChild(b);
    }

    const observer = new MutationObserver(() => {
        if (document.body) addButton();
    });
    observer.observe(document.documentElement, { childList: true, subtree: false });
    addButton();
})();
