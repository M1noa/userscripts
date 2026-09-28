// ==UserScript==
// @name         Glitch Spam
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      0.4.0
// @description  Spam "charlie kirk gets shot in the kneck XY" via the chat UI on enterglitch.com every 100ms.
// @author       Minoa
// @license      MIT
// @homepageURL  https://gitlab.com/M1noa/userscripts
// @supportURL   https://gitlab.com/M1noa/userscripts/-/issues
// @match        https://enterglitch.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const rand = () => CHARS[Math.floor(Math.random() * CHARS.length)];

    function spam() {
        const form = document.querySelector('form.flex.shrink-0.gap-2');
        const input = form && form.querySelector('input[name="message"]');
        const send = form && form.querySelector('button[type="submit"]');
        if (!form || !input || !send) return setTimeout(spam, 100);

        let msg = 'charlie kirk gets shot in the kneck ' + rand() + rand();
        if (Math.random() < 0.25) msg += ' https://minoa.cat';

        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, msg);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        send.click();

        setTimeout(spam, 100);
    }

    spam();
})();