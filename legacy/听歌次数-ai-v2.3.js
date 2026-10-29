// ==UserScript==
// @name         听歌次数-AI
// @namespace    http://tampermonkey.net/
// @version      2.3.0
// @description  try to take over the world!
// @author       You
// @match        https://music.163.com/*
// @icon         https://s1.music.126.net/style/favicon.ico?v20180823
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function main(iframeDoc) {
        const list = iframeDoc.querySelectorAll('#m-record .j-flag li .tops .bg');
        if (!list.length) return;

        const times = [];
        for (const item of list) {
            const w = Math.round(parseFloat(item.style.width));
            if (Number.isFinite(w)) times.push(w);
        }
        if (!times.length) return;

        // 反推：最小 maxNum 让所有宽度都能被 floor(100*i/maxNum) 覆盖
        let maxNum = 1, synList;
        for (; maxNum <= 100; maxNum++) {
            synList = [];
            for (let i = 0; i <= maxNum; i++) synList.push(Math.floor(100 * i / maxNum));
            if (times.every(t => synList.includes(t))) break;
        }
        if (maxNum > 100) return;

        // 逐项处理，不重复插入
        const topsList = iframeDoc.querySelectorAll('#m-record .j-flag li .tops');
        for (const tops of topsList) {
            if (tops.querySelector('.times')) continue;
            const bg = tops.querySelector('.bg');
            if (!bg) continue;
            const w = Math.round(parseFloat(bg.style.width));
            const idx = synList.indexOf(w);
            if (idx < 0) continue;
            // insertAdjacentHTML 替代 innerHTML +=，避免重建 .bg 打断监听
            tops.insertAdjacentHTML('beforeend', `<span class="times f-ff2">${idx}次</span>`);
        }
    }

    function attach() {
        const iframe = document.getElementById('g_iframe');
        if (!iframe) return false;

        let observer = null;
        const bind = () => {
            const doc = iframe.contentDocument;
            if (!doc) return;
            const rank = doc.querySelector('#m-record');
            if (!rank) return;

            main(doc);
            if (observer) observer.disconnect();
            // 关键：监听子树的 style 变化（.bg 的宽度），而不是 #m-record 自身
            observer = new MutationObserver(() => main(doc));
            observer.observe(rank, { subtree: true, attributes: true, attributeFilter: ['style'], childList: true });
        };

        iframe.addEventListener('load', bind);
        bind();                  // iframe 可能早已加载完，load 不会再触发
        setInterval(bind, 1000); // 兜底：切页 / 首次渲染晚于 load
        return true;
    }

    if (!attach()) {
        const t = setInterval(() => { if (attach()) clearInterval(t); }, 300);
    }
})();