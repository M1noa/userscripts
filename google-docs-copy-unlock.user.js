// ==UserScript==
// @name         Google Docs Copy Unlock
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      3.0.0
// @description  Select and copy text from a Google Doc even when the owner disabled copying.
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

    // docs paints the body into <canvas>. there is no text layer, so the native
    // selection has nothing to grab and the copy handler is gated on the docs
    // offline extension. two things needed: a real selectable layer, and a copy
    // path that doesn't go through docs at all.

    let body = '';

    // docs ships the whole document as plain text in its bootstrap:
    // DOCS_modelChunk = {"chunk":[{"ty":"is","ibi":1,"s":"<entire text>"}, ...]}
    // nothing gates it. the global is consumed and nulled during load, so read
    // the inline script instead, and don't cache an empty first pass.
    function readBody() {
        if (body) return body;
        // every 'is' chunk is a slice of the document; ibi orders the slices.
        // keeping only the longest one silently truncates the text.
        const parts = [];
        const take = payload => {
            for (const c of payload.chunk || []) {
                if (c.ty === 'is' && typeof c.s === 'string' && c.s) parts.push([c.ibi || 0, c.s]);
            }
        };
        if (window.DOCS_modelChunk) take(window.DOCS_modelChunk);
        if (!parts.length) {
            for (const s of document.querySelectorAll('script')) {
                const t = s.textContent;
                if (!t || t.indexOf('DOCS_modelChunk') === -1) continue;
                const m = /DOCS_modelChunk\s*=\s*(\{)/.exec(t);
                if (!m) continue;
                const start = m.index + m[0].length - 1;
                let depth = 0, end = start;
                for (let i = start; i < t.length; i++) {
                    if (t[i] === '{') depth++;
                    else if (t[i] === '}' && --depth === 0) { end = i + 1; break; }
                }
                try { take(JSON.parse(t.slice(start, end))); }
                catch (e) { /* a bad chunk shouldn't kill the rest */ }
            }
        }
        body = parts.sort((a, b) => a[0] - b[0]).map(p => p[1]).join('');
        return body;
    }

    function html(text) {
        return text
            .split(/\n{2,}/)
            .map(p => p.trim())
            .filter(Boolean)
            .map(p => '<p>' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>')
            .join('');
    }

    // the native selection, when docs leaves a text layer available
    function selectedText() {
        const sel = window.getSelection();
        const t = sel ? String(sel).replace(/​/g, '') : '';
        return t.trim() ? t : '';
    }

    // docs keeps its selection in the model and never mirrors it into the text
    // iframe, which only holds caret markers. so there is no partial copy: only
    // a real DOM selection (the panel below) or the whole document.
    function frameSelection() {
        const w = textFrame();
        const ce = w && w.document.querySelector('[contenteditable]');
        if (!ce) return '';
        const sel = w.getSelection();
        const t = (sel ? String(sel) : '').replace(/[​ \s]/g, '');
        return t ? String(sel).replace(/[​ ]/g, '').trim() : '';
    }

    // write straight to the clipboard and stop the event before docs sees it
    function onCopy(e) {
        const picked = selectedText() || frameSelection();
        const text = picked || readBody();
        if (!text || !e.clipboardData) return;
        e.clipboardData.setData('text/plain', text);
        e.clipboardData.setData('text/html', html(text));
        e.preventDefault();
        e.stopImmediatePropagation();
        toast(picked ? 'Copied selection' : 'Copied entire document');
    }

    // docs puts focus in a same-origin about:blank iframe and raises copy
    // *there*, not on the top document. the event fires on both the inner
    // document and the inner window, so hook both layers of that frame.
    [window, textFrame()].forEach(hookCopies);
    function textFrame() {
        const f = document.querySelector('.docs-texteventtarget-iframe');
        try { return f && f.contentWindow; } catch (e) { return null; }
    }
    function hookCopies(w) {
        if (!w) return;
        for (const t of [w, w.document]) {
            t.addEventListener('copy', onCopy, true);
            t.addEventListener('cut', onCopy, true);
        }
        // docs cancels every copy event it sees, and a cancelled event commits
        // nothing, so the synchronous path is dead here. the async clipboard
        // still works from a trusted keydown, and this iframe inherits the top
        // document's permissions. that path is what actually lands the text.
        w.document.addEventListener('keydown', e => {
            if (!e.isTrusted || !(e.ctrlKey || e.metaKey) || e.altKey) return;
            const k = e.key.toLowerCase();
            if (k === 'c' && e.shiftKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                forceCopy(readBody()).then(ok => toast(ok ? 'Copied entire document' : 'Copy blocked'));
            } else if (k === 'c') {
                const picked = selectedText() || frameSelection();
                forceCopy(picked || readBody()).then(ok => {
                    if (ok) toast(picked ? 'Copied selection' : 'Copied entire document');
                });
            }
        }, false);
    }

    // last resort: the async clipboard api, for when the sync path is blocked
    async function forceCopy(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            return false;
        }
    }

    window.addEventListener('keydown', e => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const k = e.key.toLowerCase();
        // ctrl+shift+c takes the whole document, plain ctrl+c takes the selection
        if (k === 'c' && e.shiftKey) {
            e.preventDefault();
            e.stopImmediatePropagation();
            forceCopy(readBody()).then(ok => toast(ok ? 'Copied entire document' : 'Copy blocked'));
        } else if (k === 'a' && !e.shiftKey) {
            // let docs do its own select-all, then mirror it into our layer
            setTimeout(() => selectAllInLayer(), 0);
        }
    }, true);

    let toastEl = null;
    function toast(msg) {
        if (!document.body) return;
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
                'z-index:2147483647;padding:8px 14px;border-radius:6px;background:#202124;color:#e8eaed;' +
                'font:13px/1.3 system-ui,sans-serif;pointer-events:none;transition:opacity .2s;';
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = msg;
        toastEl.style.opacity = '1';
        clearTimeout(toastEl._t);
        toastEl._t = setTimeout(() => { toastEl.style.opacity = '0'; }, 1400);
    }

    // markdown needs the document's structure, which the plain-text bootstrap
    // doesn't carry: no heading levels, no list nesting, no bold. docs does ship
    // that structure in the same bootstrap (chunk types 'ae'/'as'), but decoding
    // it is a parser, not a script. so this is plain text with the paragraph
    // breaks preserved. honest, not pretty.
    function toMarkdown(text) {
        return text
            .replace(/\u000b/g, '\n')
            .split(/\n{2,}/)
            .map(p => p.replace(/\s+$/, '').trim())
            .filter(Boolean)
            .join('\n\n') + '\n';
    }
    function save(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
    function docName() {
        const t = (document.title || '').replace(/\s*-\s*Google Docs\s*$/, '').trim();
        return (t || 'document').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    }
    function exportMarkdown() {
        const text = readBody();
        if (!text) { toast('Document text not loaded yet'); return; }
        save(new Blob([toMarkdown(text)], { type: 'text/markdown;charset=utf-8' }), docName() + '.md');
    }
    // pdf by way of the browser's own print dialog: save as pdf, no library.
    // print a bare copy so the docs chrome and this script's ui stay out of it.
    // printing a blank iframe hangs until the frame documents its own ready
    // state, so wait a tick and fall back to printing this window after a delay
    function exportPdf() {
        const text = readBody();
        if (!text) { toast('Document text not loaded yet'); return; }
        const f = document.createElement('iframe');
        f.id = 'gdcu-pdf';
        f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
        document.body.appendChild(f);
        const d = f.contentDocument;
        const style = d.createElement('style');
        style.textContent = 'body{font:12pt/1.55 Georgia,serif;margin:0;color:#000}' +
            'p{margin:0 0 .7em;white-space:pre-wrap}@page{margin:20mm}';
        const wrap = d.createElement('div');
        for (const para of text.replace(/\u000b/g, '\n').split(/\n{2,}/)) {
            if (!para.trim()) continue;
            const p = d.createElement('p');
            p.textContent = para.trim();
            wrap.appendChild(p);
        }
        d.head.appendChild(style);
        d.body.appendChild(wrap);
        setTimeout(() => {
            try {
                f.contentWindow.focus();
                f.contentWindow.print();
            } catch (e) {
                toast('Print blocked, select text and print the panel instead');
            } finally {
                setTimeout(() => f.remove(), 8000);
            }
        }, 250);
    }

    function selectAllInLayer() {
        const layer = document.getElementById('gdcu-layer');
        if (!layer) return;
        const r = document.createRange();
        r.selectNodeContents(layer);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
    }

    // the escape hatch: a panel holding the document text as real nodes, so
    // the browser's own selection and copy work no matter what docs decides.
    function buildPanel() {
        if (document.getElementById('gdcu-panel')) return;

        const btn = document.createElement('button');
        btn.id = 'gdcu-open';
        btn.textContent = 'Select text';
        btn.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;' +
            'padding:7px 12px;font:13px/1.2 system-ui,sans-serif;cursor:pointer;' +
            'background:#1a73e8;color:#fff;border:0;border-radius:4px;';

        const saveBtn = document.createElement('button');
        saveBtn.id = 'gdcu-save';
        saveBtn.textContent = 'Export';
        saveBtn.style.cssText = btn.style.cssText + 'right:118px;background:#3c4043;';

        const menu = document.createElement('div');
        menu.id = 'gdcu-menu';
        menu.style.cssText = 'display:none;position:fixed;right:118px;bottom:52px;z-index:2147483646;' +
            'background:#fff;border:1px solid #dadce0;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.2);' +
            'font:13px/1.2 system-ui,sans-serif;overflow:hidden;';
        const mkItem = (label, fn) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = 'display:block;width:100%;padding:8px 14px;text-align:left;cursor:pointer;' +
                'background:#fff;color:#202124;border:0;font:13px/1.2 system-ui,sans-serif;';
            b.addEventListener('click', () => { menu.style.display = 'none'; fn(); });
            return b;
        };
        menu.append(mkItem('Markdown (.md)', exportMarkdown), mkItem('PDF (print dialog)', exportPdf));

        const panel = document.createElement('div');
        panel.id = 'gdcu-panel';
        panel.style.cssText = 'display:none;position:fixed;inset:5vh 5vw;z-index:2147483647;' +
            'background:#fff;color:#202124;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.4);' +
            'display:none;flex-direction:column;font:15px/1.6 Georgia,serif;';

        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;gap:8px;align-items:center;padding:10px 14px;' +
            'border-bottom:1px solid #dadce0;font:13px/1.2 system-ui,sans-serif;flex:0 0 auto;';
        // docs enforces trusted types: innerHTML throws, so build nodes by hand
        const mkBtn = (id, label) => {
            const b = document.createElement('button');
            b.id = id;
            b.textContent = label;
            b.style.cssText = 'padding:5px 10px;cursor:pointer';
            return b;
        };
        const title = document.createElement('b');
        title.style.flex = '1';
        title.textContent = 'Document text';
        bar.append(title, mkBtn('gdcu-all', 'Select all'), mkBtn('gdcu-copy', 'Copy'), mkBtn('gdcu-close', 'Close'));

        const layer = document.createElement('div');
        layer.id = 'gdcu-layer';
        layer.style.cssText = 'flex:1;overflow:auto;padding:20px 28px;white-space:pre-wrap;' +
            'user-select:text;-webkit-user-select:text;cursor:text;outline:none;';
        layer.tabIndex = 0;

        panel.append(bar, layer);
        document.body.append(btn, saveBtn, menu, panel);

        saveBtn.addEventListener('click', () => {
            menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
        });

        btn.addEventListener('click', () => {
            const text = readBody();
            if (!text) { toast('Document text not loaded yet'); return; }
            layer.textContent = text;
            panel.style.display = 'flex';
            layer.focus();
            selectAllInLayer();
        });
        document.getElementById('gdcu-close').addEventListener('click', () => {
            panel.style.display = 'none';
        });
        document.getElementById('gdcu-all').addEventListener('click', selectAllInLayer);
        document.getElementById('gdcu-copy').addEventListener('click', () => {
            forceCopy(selectedText() || readBody()).then(ok => toast(ok ? 'Copied' : 'Copy blocked'));
        });
        // esc closes it, and the panel swallows ctrl+c so docs never sees it
        panel.addEventListener('keydown', e => {
            if (e.key === 'Escape') { panel.style.display = 'none'; return; }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
                e.stopPropagation();
            }
        }, true);
        layer.addEventListener('copy', onCopy, true);
    }

    // the editor never lets the browser raise a native copy event: it swallows
    // the keys inside a hidden iframe and paints the text into a canvas, so the
    // selection belongs to docs, not the DOM. copy is a command in docs'
    // registry, and the registry's gate (canCopy) is hardcoded true. what blocks
    // it is the disabled flag on each command. every command carries its own
    // keydown handler with the configured keyCode, so the registry is reachable
    // from any listener the editor already registered on the text target.
    // the text iframe may not exist at document-idle; retry until it does
    let hookedFrame = null;
    let hookTries = 0;
    const boot = () => {
        if (!document.body) { requestAnimationFrame(boot); return; }
        buildPanel();
        const w = textFrame();
        if (w && w !== hookedFrame) { hookedFrame = w; hookCopies(w); }
        if (!w && ++hookTries < 40) setTimeout(boot, 250);
    };
    boot();

    // docs re-renders the app view; keep the button alive across that
    new MutationObserver(() => {
        if (document.body && !document.getElementById('gdcu-open')) buildPanel();
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
