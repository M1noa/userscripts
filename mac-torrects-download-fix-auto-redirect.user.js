// ==UserScript==
// @name         TorrentMac Download Fix & Auto-Redirect
// @namespace    https://gitlab.com/M1noa/userscripts
// @version      1.0.1
// @description  Decode the base64 link parameter on torrentmac.net and redirect to the destination.
// @author       Minoa
// @license      MIT
// @homepageURL  https://gitlab.com/M1noa/userscripts
// @supportURL   https://gitlab.com/M1noa/userscripts/-/issues
// @match        https://www.torrentmac.net/downloads/?link=*
// @grant        none
// @downloadURL  https://update.greasyfork.org/scripts/525566/Mac%20Torrects%20Download%20fixauto%20redirect.user.js
// @updateURL    https://update.greasyfork.org/scripts/525566/Mac%20Torrects%20Download%20fixauto%20redirect.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // Function to get URL parameters
    function getUrlParameter(name) {
        name = name.replace(/[\[]/, '\\[').replace(/[\]]/, '\\]');
        const regex = new RegExp('[\\?&]' + name + '=([^&#]*)');
        const results = regex.exec(location.search);
        return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
    }

    // Function to decode Base64
    function decodeBase64(str) {
        try {
            return atob(str);
        } catch (e) {
            console.error('Invalid Base64 string');
            return null;
        }
    }

    // Main function
    function processUrl() {
        const linkParam = getUrlParameter('link');

        if (linkParam) {
            const decodedUrl = decodeBase64(linkParam);

            if (decodedUrl) {
                // Validate URL before redirecting
                try {
                    const url = new URL(decodedUrl);
                    // Only redirect to known safe domains
                    if (url.hostname.includes('mediafire.com')) {
                        window.location.href = decodedUrl;
                    }
                } catch (e) {
                    console.error('Invalid URL format');
                }
            }
        }
    }

    // Run the script
    processUrl();
})();