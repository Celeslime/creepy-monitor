// ==UserScript==
// @name 隔墙有耳 · Creepy Monitor
// @namespace https://github.com/Celeslime/creepy-monitor
// @version 3.2.1
// @description 在用户主页「听歌排行」里补上播放次数：格点反解，并靠周榜差分维护每人每天的听歌增量
// @author Cele
// @match https://music.163.com/*
// @icon https://s1.music.126.net/style/favicon.ico?v20180823
// @homepageURL https://github.com/Celeslime/creepy-monitor
// @supportURL https://github.com/Celeslime/creepy-monitor/issues
// @run-at document-idle
// @grant none
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const CFG = {
        // auto 默认：格点能唯一确定标尺时显示次数，饱和时显示占比
        // count 总是显示反解值（饱和时显示 ≥N次）
        // percent 总是显示占比
        MODE: 'auto',
        DAILY: true, // 是否记录 / 显示今日增量
        ASSUME_TOP_COUNT: 0, // 0 = 不用人为标尺
        BOOT_MS: 200, // 首次注入前的轮询间隔，抢时间
        REFRESH_MS: 600, // 注入成功后的轮询间隔，只用来跟 tab 切换
        CACHE_MS: 60 * 1000,
        MAX_USERS: 60, // 日增量记录的人数上限（超出按最久未访问淘汰）
        DEBUG: false,
    };

    // 站点公式（真实数据 100/100 验证）：score = floor(playCount * 100 / M)，M = 榜首次数
    // M >= 97 时格点步长 <= 1.031，必然覆盖 0..100，反解退化成常数 —— 标尺不可识别
    const SATURATION = 96;
    const STORE_KEY = 'tm_w163_daily_v1';

    const log = (...a) => CFG.DEBUG && console.log('[Creepy Monitor]', ...a);

    /* ================= PURE-START 纯逻辑（可单独跑测试） ================= */

    const pad2 = n => String(n).padStart(2, '0');
    const dayKey = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

    function shiftDay(key, delta) {
        const [y, m, d] = key.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        dt.setDate(dt.getDate() + delta);
        return dayKey(dt);
    }

    function daysBetween(from, to) {
        const [y1, m1, d1] = from.split('-').map(Number);
        const [y2, m2, d2] = to.split('-').map(Number);
        const a = Date.UTC(y1, m1 - 1, d1), b = Date.UTC(y2, m2 - 1, d2);
        return Math.round((b - a) / 86400000);
    }

    // 只保留最近 8 天：today-7 是窗口滑出的补偿项，必须留在手里
    function pruneDays(u, today) {
        const floor = shiftDay(today, -7);
        for (const k of Object.keys(u.days)) if (k < floor) delete u.days[k];
    }

    // 一次观测：u 为该用户的记录，today 为日期串，W 为周榜反解出的 {songId: 本周次数}
    // 返回 { counts, gap, exact } 或 null（首次观测只建基线）
    function applyObservation(u, today, W) {
        if (!u.days) u.days = {};

        if (!u.cur) { // 首次：只存基线，没有差值可算
            u.cur = { day: today, counts: W };
            return null;
        }

        let gap = 0;
        if (u.cur.day !== today) { // 跨天：把上一份快照固化为基线
            gap = daysBetween(u.cur.day, today);
            if (gap !== 1) u.dirty = today; // 漏访会在 7 天内污染差分链条
            u.base = u.cur;
            u.cur = { day: today, counts: W };
        } else { // 同一天重复访问：只刷新当日快照
            u.cur.counts = W;
        }

        if (!u.base) return null;

        const comp = u.days[shiftDay(today, -7)] || null; // 7 天前的日增量
        const counts = {};
        const ids = new Set([...Object.keys(W), ...Object.keys(u.base.counts)]);
        for (const id of ids) {
            const d = (W[id] || 0) - (u.base.counts[id] || 0) + (comp ? (comp[id] || 0) : 0);
            counts[id] = Math.max(0, d); // 掉出榜单导致的负值钳到 0
        }

        u.days[today] = counts;
        pruneDays(u, today);

        // 只有「补偿项在手 + 昨天确实访问过 + 最近 8 天没漏访」才算精确
        const clean = !u.dirty || daysBetween(u.dirty, today) >= 8;
        return { counts, gap, exact: !!comp && gap === 1 && clean };
    }

    function solveScale(scores) {
        const uniq = [...new Set(scores)];
        if (!uniq.length) return null;

        for (let M = 1; M <= 100; M++) {
            const lat = new Set();
            for (let i = 0; i <= M; i++) lat.add(Math.floor(100 * i / M));
            if (!uniq.every(s => lat.has(s))) continue;

            const countOf = new Map();
            for (let i = 0; i <= M; i++) {
                const w = Math.floor(100 * i / M);
                if (!countOf.has(w)) countOf.set(w, i);
            }
            return { M, countOf };
        }
        return null;
    }

    /* ================= PURE-END ================= */

    /* ---------------- 接口层 ---------------- */

    const cache = new Map(); // uid -> { t, week, all }
    const inflight = new Map(); // uid -> Promise，避免同一个 uid 重复请求

    function fetchRecord(uid, type) {
        return fetch(`/api/v1/play/record?uid=${uid}&type=${type}`, { credentials: 'include' })
            .then(r => (r.ok ? r.json() : null))
            .catch(err => { log('接口失败', type, err); return null; });
    }

    function buildDataset(json, key) {
        const arr = json && Array.isArray(json[key]) ? json[key] : null;
        if (!arr || !arr.length) return { map: new Map(), scores: [], scale: null };

        const map = new Map();
        const scores = [];
        for (const it of arr) {
            const id = it.song && it.song.id;
            if (!id) continue;
            const score = Number(it.score) || 0;
            scores.push(score);
            map.set(String(id), { score, playCount: Number(it.playCount) || 0, name: it.song.name });
        }
        return { map, scores, scale: solveScale(scores) };
    }

    async function loadData(uid) {
        const hit = cache.get(uid);
        if (hit && Date.now() - hit.t < CFG.CACHE_MS) return hit;
        if (inflight.has(uid)) return inflight.get(uid); // 预取和注入撞在一起时只发一次请求

        const p = (async () => {
            const [week, all] = await Promise.all([fetchRecord(uid, 1), fetchRecord(uid, 0)]);
            const data = { t: Date.now(), week: buildDataset(week, 'weekData'), all: buildDataset(all, 'allData') };
            if (data.week.map.size || data.all.map.size) cache.set(uid, data);
            return data;
        })();

        inflight.set(uid, p);
        try { return await p; } finally { inflight.delete(uid); }
    }

    /* ---------------- 存储 ---------------- */

    function loadStore() {
        try {
            const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (s && s.users) return s;
        } catch (e) { log('读取存储失败', e); }
        return { v: 1, users: {} };
    }

    function saveStore(s) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); }
        catch (e) { log('写入存储失败', e); }
    }

    // 用周榜反解出「本周每首歌的次数」，再交给 applyObservation 做差分
    function recordDaily(uid, weekDs) {
        if (!CFG.DAILY || !weekDs || !weekDs.scale) return null;
        if (weekDs.scale.M >= SATURATION) return null; // 周榜标尺饱和，次数不可靠，不记录

        const W = {};
        for (const [id, info] of weekDs.map) {
            const c = weekDs.scale.countOf.get(info.score);
            if (c !== undefined) W[id] = c;
        }

        const store = loadStore();
        const u = store.users[uid] || (store.users[uid] = { days: {} });
        u.seen = Date.now();

        const today = dayKey(new Date());
        const res = applyObservation(u, today, W);

        // 人数上限：淘汰最久未访问的
        const uids = Object.keys(store.users);
        if (uids.length > CFG.MAX_USERS) {
            uids.sort((a, b) => (store.users[a].seen || 0) - (store.users[b].seen || 0))
                .slice(0, uids.length - CFG.MAX_USERS)
                .forEach(k => delete store.users[k]);
        }
        saveStore(store);

        if (!res) return { counts: {}, time: new Date().toTimeString().slice(0, 5), exact: false, warm: true };
        return { counts: res.counts, time: new Date().toTimeString().slice(0, 5), exact: res.exact, gap: res.gap };
    }

    /* ---------------- 页面定位 ---------------- */

    function getDoc() {
        if (document.querySelector('#m-record')) return document;
        const fr = document.getElementById('g_iframe');
        const d = fr && fr.contentDocument;
        if (d && d.querySelector('#m-record')) return d;
        return null;
    }

    const pickUid = s => {
        const m = s && /[?&]id=(\d+)/.exec(s);
        return m ? m[1] : null;
    };

    // 不依赖 DOM 的 uid：列表还没渲染时也能先把数据抓回来。
    // 只认 #/user/ 开头的路由，#/song?id= / #/playlist?id= 也带 id，别拿去请求听歌排行
    const hashUid = () => (/\/user(\/|\?|$)/.test(location.hash || '') ? pickUid(location.hash) : null);

    function getUid(doc) {
        return pickUid(doc.location && doc.location.search)
            || pickUid(doc.location && doc.location.hash)
            || hashUid()
            || null;
    }

    /* ---------------- 文案 ---------------- */

    function describe(info, scale, day) {
        let r;

        if (info.playCount > 0) {
            r = { text: `${info.playCount}次`, tip: `播放 ${info.playCount} 次（接口返回的真实数据）` };
        } else {
            const sat = !scale || scale.M >= SATURATION;
            const solved = scale && scale.countOf.has(info.score) ? scale.countOf.get(info.score) : null;

            if (CFG.MODE === 'count' && scale) {
                r = solved !== null && !sat
                    ? { text: `${solved}次`, tip: `格点反解，M=${scale.M}` }
                    : { text: `≥${scale.M}次`, tip: `反解下限 ${scale.M} 次，真实值可能远高于此` };
            } else if (CFG.MODE !== 'percent' && solved !== null && !sat) {
                r = { text: `${solved}次`, tip: `格点反解得到唯一标尺 M=${scale.M}，次数可信` };
            } else if (CFG.ASSUME_TOP_COUNT > 0) {
                const M = CFG.ASSUME_TOP_COUNT;
                const lo = Math.ceil(info.score * M / 100);
                const hi = Math.max(lo, Math.ceil((info.score + 1) * M / 100) - 1);
                r = { text: `≈${Math.round((lo + hi) / 2)}次`, tip: `按榜首=${M}次推算，区间 ${lo}~${hi} 次` };
            } else {
                const low = scale ? `，反解下限 ≥${scale.M} 次但标尺已饱和` : '';
                r = { text: `${info.score}%`, tip: `占榜首播放量的 ${info.score}%${low}` };
            }
        }

        if (day && day.counts) {
            const n = day.counts[info.id] || 0;
            const note = day.exact ? '' : '，含窗口滑出的估算误差';
            r.deltaTip = `今日新增 ${n} 次（${day.time} 观测）${note}`;
            if (day.warm) r.tip += '；今日增量首个观测日，明日开始统计';
            else if (n > 0) r.delta = `+${n}`; // 交给子元素渲染，紧贴数字之后
            else r.tip += `；${r.deltaTip}`;
        }
        return r;
    }

    /* ---------------- 渲染 ---------------- */

    function pickDataset(doc, data) {
        const rows = [...doc.querySelectorAll('#m-record li')];
        const errOf = ds => {
            let sum = 0, n = 0;
            for (const li of rows) {
                const el = li.querySelector('[data-res-id]');
                const bg = li.querySelector('.tops .bg');
                if (!el || !bg) continue;
                const info = ds.map.get(el.getAttribute('data-res-id'));
                const w = parseFloat(bg.style.width);
                if (!info || !Number.isFinite(w)) continue;
                sum += Math.abs(w - info.score); n++;
            }
            return n ? sum / n : Infinity;
        };

        if (!data.week.map.size) return data.all;
        if (!data.all.map.size) return data.week;
        return errOf(data.week) <= errOf(data.all) ? data.week : data.all;
    }

    function inject(doc, ds, day) {
        let hit = 0;
        for (const li of doc.querySelectorAll('#m-record li')) {
            const res = li.querySelector('[data-res-id]');
            const tops = li.querySelector('.tops');
            if (!res || !tops) continue;

            const id = res.getAttribute('data-res-id');
            const info = ds.map.get(id);
            if (!info) continue;
            hit++;

            // 官方已显示次数的行（本人主页）复用它的节点，数字不重复写，只往里挂增量
            const official = tops.querySelector('.times:not(.tm-times):not(.tm-delta)');
            if (official) {
                const stale = tops.querySelector('.tm-times');
                if (stale) stale.remove(); // 官方节点是后来才渲染出来的话，清掉我们早先插的那份
            }

            const { text, tip, delta, deltaTip } = describe(Object.assign({ id }, info), ds.scale, day);

            let el = official || tops.querySelector('.tm-times');
            if (!el) {
                el = doc.createElement('span');
                el.className = 'times f-ff2 tm-times'; // 样式交给站点 CSS
                el.appendChild(doc.createTextNode('')); // 正文单独一个文本节点，给子元素留位置
                tops.appendChild(el);
            }
            // 注意：这里不能写 el.textContent，那会把嵌套的 .tm-delta 一起清掉
            if (!official) {
                let tn = el.firstChild;
                if (!tn || tn.nodeType !== 3) {
                    tn = doc.createTextNode('');
                    el.insertBefore(tn, el.firstChild);
                }
                if (tn.nodeValue !== text) tn.nodeValue = text;
            }
            if (el.title !== tip) el.title = tip;

            // 今日增量嵌在主数字里，跟着文本流紧贴其后，不单独定位
            let dl = el.querySelector('.tm-delta');
            if (delta) {
                if (!dl) {
                    dl = doc.createElement('span');
                    dl.className = 'tm-delta'; // 不带 times，免被绝对定位拽走；字体从父级继承
                    dl.style.cssText = 'margin-left:4px;'; // 唯一的内联样式，只管间距
                    el.appendChild(dl);
                }
                if (dl.textContent !== delta) dl.textContent = delta;
                if (dl.title !== deltaTip) dl.title = deltaTip;
            } else if (dl) {
                dl.remove(); // 今日无新增：不留一个空的尾巴
            }
        }
        return hit;
    }

    /* ---------------- 驱动 ---------------- */

    let busy = false;
    let lastSig = '';
    let hot = true; // 还没画上去过：高频轮询抢首屏
    let timer = 0;

    async function tick() {
        if (busy) return;

        const doc = getDoc();
        const uid = doc ? getUid(doc) : hashUid();
        if (!uid) { lastSig = ''; return; }

        // 列表还没渲染出来：先把两个接口请求发出去，DOM 一到就能立刻画
        if (!doc) { loadData(uid).catch(() => {}); return; }

        const sig = uid + '|' + doc.querySelectorAll('#m-record li').length + '|' +
            (doc.querySelector('#m-record li [data-res-id]') || {}).outerHTML;
        if (sig === lastSig) return;

        busy = true;
        try {
            const data = await loadData(uid); // 预取命中时只是一个微任务，不再等网络
            if (!data.week.map.size && !data.all.map.size) {
                lastSig = sig;
                hot = false; // 这个人没有公开排行，别再高频空转
                return;
            }
            const day = recordDaily(uid, data.week); // 与当前 tab 无关，始终用周榜
            const hit = inject(doc, pickDataset(doc, data), day);
            lastSig = sig; // 标记这一版 DOM 已处理过，sig 一变（列表重渲染 / 切 tab）自然会重跑
            if (hit) hot = false; // 首屏画完就降频，只留余量跟 tab 切换
        } finally {
            busy = false;
        }
    }

    // 单一定时器自续：schedule 每次都清掉上一个，所以并发调用不会叠出两条循环
    function schedule(ms) {
        clearTimeout(timer);
        timer = setTimeout(run, ms);
    }

    async function run() {
        try { await tick(); } catch (e) { log('tick 异常', e); }
        schedule(hot ? CFG.BOOT_MS : CFG.REFRESH_MS);
    }

    function kick() {
        hot = true;
        lastSig = '';
        schedule(0);
    }

    window.addEventListener('hashchange', kick);
    run();
    console.info('[Creepy Monitor] v3.2.1 已加载');
})();
