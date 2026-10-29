// ==UserScript==
// @name         网易云音乐听歌次数
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  为了掌握某人具体听歌次数，于2020/05/11写了这个js脚本
// @author       矰
// @match        https://music.163.com/
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const IFRAME_SELECTOR = '#g_iframe';
    const RECORD_SELECTOR = '#m-record';

    let observer = null;
    let processing = false;

    function getIframeDoc(iframe) {
        try {
            return iframe.contentDocument || iframe.contentWindow.document;
        } catch (e) {
            return null;
        }
    }

    function parsePercent(str) {
        const num = parseFloat(str);
        return Number.isFinite(num) ? Math.round(num) : null;
    }

    function estimateTimes(percentList) {
        const valid = percentList.filter(p => p !== null && p >= 0 && p <= 100);
        if (!valid.length) return null;

        const unique = [...new Set(valid)];
        if (unique.length === 1 && unique[0] === 100) return null;

        let startN = 1;
        const last = valid[valid.length - 1];
        if (last > 0) {
            startN = Math.max(1, Math.floor(100 / (last + 1)));
        }

        const maxN = 1000; // 安全上限
        for (let n = startN; n <= maxN; n++) {
            const simulated = new Set();
            for (let i = 0; i <= n; i++) {
                simulated.add(Math.floor(100 * i / n));
            }
            let ok = true;
            for (const p of unique) {
                if (!simulated.has(p)) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                const map = new Map();
                for (const p of simulated) {
                    map.set(p, Math.round(p * n / 100));
                }
                return { n, map };
            }
        }
        return null;
    }

    function process(iframeDoc) {
        if (processing) return;
        processing = true;

        try {
            const record = iframeDoc.querySelector(RECORD_SELECTOR);
            if (!record) return;

            const items = record.querySelectorAll('.j-flag li .tops');
            if (!items.length) return;

            // 先移除旧的 .times
            items.forEach(item => {
                const old = item.querySelector('.times');
                if (old) old.remove();
            });

            const percentList = [];
            items.forEach(item => {
                const bg = item.querySelector('.bg');
                if (bg && bg.style && bg.style.width) {
                    percentList.push(parsePercent(bg.style.width));
                } else {
                    percentList.push(null);
                }
            });

            const result = estimateTimes(percentList);
            if (!result) return;

            items.forEach((item, idx) => {
                const p = percentList[idx];
                if (p === null) return;
                const count = result.map.get(p);
                if (count !== undefined) {
                    const span = document.createElement('span');
                    span.className = 'times f-ff2';
                    span.textContent = `${count}次`;
                    item.appendChild(span);
                }
            });
        } finally {
            processing = false;
        }
    }

    function startObserve(iframeDoc) {
        const record = iframeDoc.querySelector(RECORD_SELECTOR);
        if (!record) return;

        if (observer) observer.disconnect();

        observer = new MutationObserver(() => {
            // 防抖，避免循环触发
            if (!processing) {
                setTimeout(() => process(iframeDoc), 100);
            }
        });

        observer.observe(record, {
            childList: true,
            subtree: true,
            attributes: true
        });
    }

    function init() {
        const iframe = document.querySelector(IFRAME_SELECTOR);
        if (!iframe) return;

        const tryProcess = () => {
            const doc = getIframeDoc(iframe);
            if (doc && doc.querySelector(RECORD_SELECTOR)) {
                process(doc);
                startObserve(doc);
            }
        };

        // iframe 可能已经加载完成
        const doc = getIframeDoc(iframe);
        if (doc && doc.readyState === 'complete') {
            tryProcess();
        } else {
            iframe.addEventListener('load', tryProcess, { once: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
