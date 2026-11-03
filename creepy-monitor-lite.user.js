// ==UserScript==
// @name 隔墙有耳 Lite · Creepy Monitor Lite
// @namespace https://github.com/Celeslime/creepy-monitor
// @version 1.0.0
// @description 只做一件事：在用户主页「听歌排行」里补上播放次数
// @author Cele
// @match https://music.163.com/*
// @icon https://s1.music.126.net/style/favicon.ico?v20180823
// @homepageURL https://github.com/Celeslime/creepy-monitor
// @run-at document-idle
// @grant none
// @noframes
// ==/UserScript==

// 完整版（今日增量、我听了 N 次、请求节流）见 creepy-monitor.user.js
(function () {
    'use strict';

    const CACHE_MS = 5 * 60 * 1000; // 同一 uid 的排行数据缓存 5 分钟
    const SATURATION = 96; // 标尺 >= 97 时格点全覆盖，反解退化
    const cache = new Map();

    const pickId = s => ((/[?&]id=(\d+)/.exec(s || '') || [])[1] || null);

    // 排行列表在 #g_iframe 子文档里，两种位置都得找
    function getDoc() {
        const d = document.querySelector('#m-record')
            ? document : (document.getElementById('g_iframe') || {}).contentDocument;
        return d && d.querySelector('#m-record') ? d : null;
    }

    // 周榜只给 score（占榜首的百分比），反推最小标尺 M，使每条 score 都能被 floor(100*i/M) 命中
    function solve(scores) {
        for (let M = 1; M <= 100; M++) {
            const at = new Map();
            // 倒着填，小 i 后写入，取到的就是该 score 的最小次数
            for (let i = M; i >= 0; i--) at.set(Math.floor(100 * i / M), i);
            if (scores.every(s => at.has(s))) return { M, at };
        }
        return null;
    }

    const toMap = arr => new Map((arr || []).filter(it => it.song)
        .map(it => [String(it.song.id), { score: Number(it.score) || 0, count: Number(it.playCount) || 0 }]));

    async function load(uid) {
        const hit = cache.get(uid);
        if (hit && Date.now() - hit.t < CACHE_MS) return hit;
        try {
            const r = await fetch(`/api/v1/play/record?uid=${uid}&type=-1`, { credentials: 'include' });
            if (!r.ok) return null;
            const j = await r.json();
            const data = { t: Date.now(), all: toMap(j.allData), week: toMap(j.weekData) };
            cache.set(uid, data);
            return data;
        } catch (e) { return null; }
    }

    function paint(doc, data) {
        const lis = [...doc.querySelectorAll('#m-record li')];
        if (!lis.length) return;

        const idOf = li => {
            const e = li.querySelector('[data-res-id]');
            return e && e.getAttribute('data-res-id');
        };
        // 当前列表属于哪个标签页：数 id 在哪份数据里命中得多
        const hit = key => lis.filter(li => data[key].has(idOf(li))).length;
        const src = hit('all') >= hit('week') ? data.all : data.week;
        const real = src === data.all; // 全时间榜的 playCount 是服务端真值
        const scale = real ? null : solve([...src.values()].map(v => v.score));
        const sat = !real && (!scale || scale.M >= SATURATION);

        for (const li of lis) {
            const tops = li.querySelector('.tops');
            if (!tops || tops.querySelector('.times')) continue;
            const info = src.get(idOf(li));
            if (!info) continue;

            const text = real ? `${info.count}次` : (sat ? `${info.score}%` : `${scale.at.get(info.score)}次`);
            const el = doc.createElement('span');
            el.className = 'times f-ff2'; // 原版类名，样式由站点 CSS 提供
            el.textContent = text;
            el.title = real ? `播放 ${info.count} 次（接口真值）` : (sat ? '标尺饱和，只能给占比' : '按条形宽度反解');
            tops.appendChild(el);
        }
    }

    // 只认 #/user 路由，歌曲页、歌单页也带 id
    const hashUid = () => (/\/user(\/|\?|$)/.test(location.hash || '') ? pickId(location.hash) : null);

    let busy = false;
    async function tick() {
        if (busy) return;
        const doc = getDoc();
        const uid = (doc && (pickId(doc.location.search) || pickId(doc.location.hash))) || hashUid();
        if (!doc || !uid) return;
        busy = true;
        try {
            const data = await load(uid);
            if (data) paint(doc, data);
        } finally { busy = false; }
    }

    tick();
    setInterval(tick, 700);
})();
