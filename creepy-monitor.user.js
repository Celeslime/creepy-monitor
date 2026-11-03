// ==UserScript==
// @name 隔墙有耳 · Creepy Monitor
// @namespace https://github.com/Celeslime/creepy-monitor
// @version 3.5.1
// @description 在用户主页「听歌排行」里补上真实播放次数，并靠周榜差分维护每人每天的听歌增量
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
        SHOW_MINE: true, // 他人主页上附注「我最近一周听过几次」
        ASSUME_TOP_COUNT: 0, // 0 = 不用人为标尺
        BOOT_MS: 200, // 首次注入前的轮询间隔，抢时间
        REFRESH_MS: 600, // 注入成功后的轮询间隔，只用来跟 tab 切换
        CACHE_MS: 5 * 60 * 1000, // 排行数据缓存；切 tab、反复进出同一主页都不再发请求
        MINE_DELAY_MS: 600, // 首屏画上后等多久再取「我听了 N 次」，避开网页自己的排行请求
        MIN_GAP_MS: 300, // 两个接口请求之间的最小间隔，避免和网页自身请求挤在一起
        FAIL_BACKOFF_MS: 60 * 1000, // 接口失败后多久内不再重试
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

    // 一次观测：wk 是周榜反解出的 {songId: 本周次数}，al 是全时间榜的 {songId: 真实累计次数}
    // 两份差分合并成一张增量表：真值优先，反解只补真值鞭长莫及的行
    // 返回 { counts, fromAll, gap, exact } 或 null（首次观测只建基线）
    function applyObservation(u, today, wk, al) {
        if (!u.days) u.days = {};

        const now = { day: today, week: wk, all: al };
        if (!u.cur) { // 首次：只存基线，没有差值可算
            u.cur = now;
            return null;
        }

        let gap = 0;
        if (u.cur.day !== today) { // 跨天：把上一份快照固化为基线
            gap = daysBetween(u.cur.day, today);
            if (gap !== 1) u.dirty = today; // 漏访会在 7 天内污染差分链条
            u.base = u.cur;
            u.cur = now;
        } else { // 同一天重复访问：只刷新当日快照
            u.cur.week = wk;
            u.cur.all = al;
        }

        if (!u.base) return null;

        const baseWeek = u.base.week || {};
        const baseAll = u.base.all || {};
        const coldAll = !Object.keys(baseAll).length; // 全时间基线还没建立（升级 / 首次）
        const comp = u.days[shiftDay(today, -7)] || null; // 7 天前的日增量
        const counts = {};
        const fromAll = new Set();
        const newIds = new Set(); // 今天新进榜、没有基线的歌

        // 1) 全时间榜：两边都在榜才有差分可言。新进榜的歌不知道之前累计多少，
        // 拿 0 当基线会把它一生的播放量都算成今天听的，直接跳过
        for (const id of Object.keys(al)) {
            if (!(id in baseAll)) {
                if (!coldAll) newIds.add(id);
                continue;
            }
            counts[id] = Math.max(0, al[id] - baseAll[id]);
            fromAll.add(id);
        }

        // 2) 周榜：补上不在全时间 top100 的歌。周榜是 7 天滑动窗口，
        // 7 天前那天的增量已滑出，必须加回来
        for (const id of Object.keys(wk)) {
            if (!(id in baseWeek)) {
                if (!coldAll) newIds.add(id); // 昨天不在周榜，今天的累计里混着前几天的播放
                continue;
            }
            if (id in counts) continue;
            const d = wk[id] - baseWeek[id] + (comp ? (comp[id] || 0) : 0);
            counts[id] = Math.max(0, d); // 掉出榜单导致的负值钳到 0
        }

        u.days[today] = counts;
        pruneDays(u, today);

        // 只有「补偿项在手 + 昨天确实访问过 + 最近 8 天没漏访」才算精确
        const clean = !u.dirty || daysBetween(u.dirty, today) >= 8;
        return { counts, fromAll, newIds, coldAll, gap, exact: !!comp && gap === 1 && clean };
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
    const failUntil = new Map(); // uid -> 重试时间，失败后退避，避免反复追打接口
    const inflight = new Map(); // uid -> Promise，避免同一个 uid 重复请求

    // 所有接口请求都走这里：串行 + 最小间隔。
    // 网页自己在同一时刻也要请求排行，三个请求并发容易被限流，把页面那一条挤掉
    let lastReqAt = 0;
    let chain = Promise.resolve();

    function request(url) {
        const run = async () => {
            const wait = CFG.MIN_GAP_MS - (Date.now() - lastReqAt);
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            lastReqAt = Date.now();
            const r = await fetch(url, { credentials: 'include' });
            return r.ok ? r.json() : null;
        };
        const p = chain.then(run, run);
        chain = p.catch(() => {});
        return p;
    }

    function fetchRecord(uid, type) {
        return request(`/api/v1/play/record?uid=${uid}&type=${type}`)
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
        if ((failUntil.get(uid) || 0) > Date.now()) return null; // 刚失败过，别继续追打接口
        if (inflight.has(uid)) return inflight.get(uid); // 预取和注入撞在一起时只发一次请求

        const p = (async () => {
            // type=-1 一次带回 allData 与 weekData，替掉原先 type=0 + type=1 的两次请求
            const j = await fetchRecord(uid, -1);
            if (!j) {
                failUntil.set(uid, Date.now() + CFG.FAIL_BACKOFF_MS);
                return null;
            }
            const data = { t: Date.now(), week: buildDataset(j, 'weekData'), all: buildDataset(j, 'allData') };
            if (data.week.map.size || data.all.map.size) cache.set(uid, data);
            failUntil.delete(uid);
            return data;
        })();

        inflight.set(uid, p);
        try { return await p; } finally { inflight.delete(uid); }
    }

    /* ---- 我自己：登录者 uid 与「最近一周听过几次」 ---- */

    const me = { asked: false, uid: null };
    let mineMap = null; // songId -> 我最近一周的真实次数
    let mineAt = 0;

    // 未登录时接口返回 account: null，不会抛错
    async function getMe() {
        if (me.asked) return me.uid;
        me.asked = true;
        try {
            const j = await request('/api/nuser/account/get');
            const id = j && ((j.profile && j.profile.userId) || (j.account && j.account.id));
            me.uid = id ? String(id) : null;
        } catch (e) { log('取登录用户失败', e); }
        return me.uid;
    }

    // 本人账号的 playCount 是接口给的真值，不需要反解，也不受标尺饱和影响。
    // 只要最近一周，不拉「全部时间」，省掉一次请求
    async function loadMine() {
        const hit = await getMe();
        if (!hit) return null;

        const cached = cache.get(hit);
        const weekDs = cached && Date.now() - cached.t < CFG.CACHE_MS
            ? cached.week
            : buildDataset(await fetchRecord(hit, 1), 'weekData');

        const map = new Map();
        for (const [id, info] of weekDs.map) if (info.playCount > 0) map.set(id, info.playCount);
        mineMap = map.size ? map : null;
        mineAt = Date.now();
        return mineMap;
    }

    /* ---------------- 存储 ---------------- */

    // v3.4 之前快照只有一个 counts（周榜反解），升级后拆成 week / all。
    // 旧数据当场翻译成 week，全时间那半从今天开始积累，不丢历史
    function migrate(u) {
        for (const k of ['cur', 'base']) {
            const s = u[k];
            if (s && s.counts && !s.week) {
                s.week = s.counts;
                s.all = {};
                delete s.counts;
            }
        }
        return u;
    }

    function loadStore() {
        try {
            const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (s && s.users) {
                for (const k of Object.keys(s.users)) migrate(s.users[k]);
                s.v = 2; // 迁移完成后标记，下次读不再当旧格式
                return s;
            }
        } catch (e) { log('读取存储失败', e); }
        return { v: 2, users: {} };
    }

    function saveStore(s) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); }
        catch (e) { log('写入存储失败', e); }
    }

    // 两份数据各取所长，交给 applyObservation 合并：
    // 周榜反解覆盖「最近一周」tab，全时间真值覆盖「所有时间」tab，一份增量表两个 tab 通用
    function recordDaily(uid, weekDs, allDs) {
        if (!CFG.DAILY) return null;

        // 周榜只有 score，标尺饱和时这一份整份丢掉，只留全时间真值
        let wk = null;
        if (weekDs && weekDs.scale && weekDs.scale.M < SATURATION) {
            wk = {};
            for (const [id, info] of weekDs.map) {
                const c = weekDs.scale.countOf.get(info.score);
                if (c !== undefined) wk[id] = c;
            }
        }

        // 全时间榜的 playCount 是服务端给的绝对值，不依赖任何标尺
        const al = {};
        if (allDs) for (const [id, info] of allDs.map) if (info.playCount > 0) al[id] = info.playCount;
        if (!wk && !Object.keys(al).length) return null;

        const store = loadStore();
        const u = store.users[uid] || (store.users[uid] = { days: {} });
        u.seen = Date.now();

        const today = dayKey(new Date());
        const res = applyObservation(u, today, wk || {}, al);

        // 人数上限：淘汰最久未访问的
        const uids = Object.keys(store.users);
        if (uids.length > CFG.MAX_USERS) {
            uids.sort((a, b) => (store.users[a].seen || 0) - (store.users[b].seen || 0))
                .slice(0, uids.length - CFG.MAX_USERS)
                .forEach(k => delete store.users[k]);
        }
        saveStore(store);

        const time = new Date().toTimeString().slice(0, 5);
        if (!res) return { counts: {}, time, exact: false, warm: true };
        return {
            counts: res.counts, fromAll: res.fromAll, newIds: res.newIds, coldAll: res.coldAll,
            time, exact: res.exact, gap: res.gap,
        };
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
            if (day.warm) {
                r.tip += '；今日增量首个观测日，明日开始统计';
            } else if (n > 0) {
                const truth = day.fromAll && day.fromAll.has(info.id);
                const src = truth
                    ? (day.gap === 1 ? '全时间榜真值差分' : `全时间榜真值差分但跨了 ${day.gap} 天`)
                    : (day.exact ? '周榜反解差分' : '周榜反解差分，含窗口滑出的估算误差');
                r.delta = `+${n}`; // 交给子元素渲染，紧贴数字之后
                r.deltaTip = `今日新增 ${n} 次（${day.time} 观测，${src}）`;
            } else if (day.newIds && day.newIds.has(info.id)) {
                r.tip += '；今天新进榜，昨天没有基线，算不出今日增量';
            } else if (day.coldAll) {
                r.tip += '；全时间榜基线今天才建立，明天起这一页才有增量';
            } else {
                r.tip += `；今日无新增（${day.time} 观测）`;
            }
        }
        return r;
    }

    /* ---------------- 渲染 ---------------- */

    // 「我听了 N 次」：原版 .times 的镜像，只是贴到右端。
    // 原版 pt_profile_ranking.css 里：
    // .tops{position:relative;height:38px;line-height:38px}
    // .tops span.times{position:absolute;left:10px;height:38px;line-height:38px;color:#666}
    // 所以这里也不写 font-size / font-family，交给 .f-ff2 与继承，字号才和左边的数字一致
    const MINE_CSS = 'position:absolute; right:10px; top:0; z-index:2; color:#666;';

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

    function inject(doc, ds, day, mine, self) {
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

            // 我最近一周听过这首歌几次：接口对我本人返回的是真数，不是估算。
            // 只是贴在右端的一行普通文字，和原版 .times 一起构成左右对称
            const my = !self && mine ? mine.get(id) || 0 : 0;
            let mi = tops.querySelector('.tm-mine');
            if (my > 0) {
                if (!mi) {
                    mi = doc.createElement('span');
                    mi.className = 'f-ff2 tm-mine'; // f-ff2 是原版数字用的字体类
                    mi.style.cssText = MINE_CSS;
                    // 挂在 .tops 里（原版就是 relative + 38px 高），定位以它为参照
                    const win = doc.defaultView || window;
                    if (win.getComputedStyle(tops).position === 'static') tops.style.position = 'relative';
                    tops.appendChild(mi);
                }
                const myText = `我听了 ${my} 次`;
                const myTip = `你最近 7 天听了这首歌 ${my} 次，取自本人账号接口的真实数据`;
                if (mi.textContent !== myText) mi.textContent = myText;
                if (mi.title !== myTip) mi.title = myTip;
            } else if (mi) {
                mi.remove();
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

        // 列表还没渲染出来：先把接口请求发出去，DOM 一到就能立刻画
        if (!doc) { loadData(uid).catch(() => {}); return; }

        const sig = uid + '|' + doc.querySelectorAll('#m-record li').length + '|' +
            (doc.querySelector('#m-record li [data-res-id]') || {}).outerHTML;
        if (sig === lastSig) return;

        busy = true;
        try {
            const data = await loadData(uid); // 预取命中时只是一个微任务，不再等网络
            if (!data) return; // 接口失败或退避中：保持现状，下一轮再来
            if (!data.week.map.size && !data.all.map.size) {
                lastSig = sig;
                hot = false; // 这个人没有公开排行，别再高频空转
                return;
            }
            const day = recordDaily(uid, data.week, data.all); // 两份都喂，与当前 tab 无关
            // 自己的主页不需要「我听了 N 次」，那栏本来就显示真实次数
            const hit = inject(doc, pickDataset(doc, data), day, mineMap, uid === me.uid);
            lastSig = sig; // 标记这一版 DOM 已处理过，sig 一变（列表重渲染 / 切 tab）自然会重跑
            if (hit) hot = false; // 首屏画完就降频，只留余量跟 tab 切换

            // 首屏已经画上了，才轮到「我的次数」出场，不和排行请求抢带宽
            if (hit && CFG.SHOW_MINE) scheduleMine();
        } finally {
            busy = false;
        }
    }

    // 只在用户主页才需要「我听了 N 次」。
    // 不跟首屏抢：等别人次数画完、网页自己的排行请求也发出去之后，再取我自己的两份数据
    let mineScheduled = false;

    function scheduleMine() {
        if (!CFG.SHOW_MINE || mineScheduled) return;
        mineScheduled = true;
        setTimeout(() => {
            getMe()
                .then(id => {
                    if (!id || id === hashUid()) return null; // 自己的主页不必拉自己的周榜
                    return loadMine().then(() => {
                        if (!mineMap) return;
                        lastSig = ''; // 我的次数到了，重画一遍
                        schedule(0);
                    });
                })
                .catch(e => log('预取我的次数失败', e));
        }, CFG.MINE_DELAY_MS);
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
        if (!mineMap) mineScheduled = false; // 换了页面，允许再取一次我的次数
        schedule(0);
    }

    window.addEventListener('hashchange', kick);
    run();
    console.info('[Creepy Monitor] v3.5.1 已加载');
})();
