// ==UserScript==
// @name         Twitter Auto Unmute Videos
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      0.2.1
// @description  Automatically unmute all videos on Twitter/X.
// @author       Minoa
// @license      MIT
// @homepageURL  https://gitlab.com/M1noa/userscripts
// @supportURL   https://gitlab.com/M1noa/userscripts/-/issues
// @match        https://twitter.com/*
// @match        https://x.com/*
// @grant        none
// @downloadURL  https://update.greasyfork.org/scripts/488635/Twitter%20Auto%20Unmute%20Videos.user.js
// @updateURL    https://update.greasyfork.org/scripts/488635/Twitter%20Auto%20Unmute%20Videos.meta.js
// ==/UserScript==

(function() {
    'use strict';

    function unmuteVideos() {
        let videos = document.querySelectorAll('video');
        videos.forEach(video => {
            video.muted = false;
        });
    }

    // Check for video elements every second and unmute them
    setInterval(unmuteVideos, 1000);
})();
