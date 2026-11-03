// ==UserScript==
// @name 隔墙有耳 · Creepy Monitor
// @namespace https://github.com/Celeslime/creepy-monitor
// @version 3.6.0
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
    const SAT_MAX = 2000; // 饱和标尺的搜索上界：一周 2000 次以上就不再猜了
    const SAT_SLACK = 0.05; // 锁定的区间宽于 5% 就不算锁定，只报下界
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
        // 拿 0 当基线会把它一生的播放量都算成今天听的（几百次），只能跳过
        for (const id of Object.keys(al)) {
            if (!(id in baseAll)) continue;
            counts[id] = Math.max(0, al[id] - baseAll[id]);
            fromAll.add(id);
        }

        // 2) 周榜：补上不在全时间 top100 的歌。周榜是 7 天滑动窗口，
        // 7 天前那天的增量已滑出，必须加回来
        for (const id of Object.keys(wk)) {
            if (id in counts) continue;
            if (!(id in baseWeek)) {
                // 昨天不在榜：本周累计里可能混着前几天的播放，拿它当今日增量是**上限**。
                // 但新进榜大多是「今天才开始听」，多数时候就等于当日值，所以照给
                newIds.add(id);
                counts[id] = wk[id];
                continue;
            }
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

    // score 对应的次数区间：s = floor(100c/M)，解出 c ∈ [⌈s·M/100⌉, ⌈(s+1)·M/100⌉ − 1]
    function bandOf(score, lo, hi) {
        const a = Math.ceil(score * lo / 100);
        const b = Math.ceil((score + 1) * hi / 100) - 1;
        return [a, Math.max(a, b)];
    }

    // 硬下界。播放次数不会倒退：今天次数 ≥ 昨天次数 − 已滑出窗口的那天。
    // 于是 c ≥ prior 且 s = floor(100c/M) ⟹ M > 100·prior/(s+1)，逐首取最大。
    // prior 先减 1，兜住差分链条上 ±1 的踩点误差
    function hardBound(pairs, minM) {
        let hard = minM;
        for (const p of pairs) {
            const c = Math.max(1, p.prior - 1);
            hard = Math.max(hard, Math.floor(100 * c / (p.score + 1)) + 1);
        }
        return hard;
    }

    // 软区间。周榜只给 score = floor(100c/M)，M ≥ 97 时格点铺满 0..100，
    // 单看一份榜单根本无从反解。但没动过的那批歌，prior 就是它的本周真实次数，
    // 于是「谁的 prior 能倒出自己的 score」成了筛子，扫一遍就能把 M 卡成窄区间
    function pinScale(pairs, start) {
        let best = -1, lo = start, hi = start;
        for (let M = start; M <= SAT_MAX; M++) {
            let hit = 0;
            for (const p of pairs) if (Math.floor(100 * p.prior / M) === p.score) hit++;
            if (hit > best) { best = hit; lo = hi = M; }
            else if (hit === best) hi = M;
        }

        // 大半对不上：今天这批歌基本都在涨，prior 已经不是次数了
        if (best < Math.max(3, pairs.length * 0.6)) return { lo: start, hi: null, agree: best };
        if (hi >= SAT_MAX) return { lo, hi: null, agree: best }; // 极值落在搜索上界，只能说到这儿
        return { lo, hi, agree: best };
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

    // 用上一次的快照给周榜标尺定界。返回 null 表示没有先验可用；
    // { hard } 表示只拿到下界；{ hard, lo, hi, counts, band } 表示把 M 卡进了窄区间
    function pinWeek(u, weekDs, today, exactM) {
        const base = u.cur; // 上次访问留下的快照（applyObservation 之后才会推进成 base）
        if (!base || !base.week || !Object.keys(base.week).length) return null;
        const gap = daysBetween(base.day, today);
        if (gap > 1) return null; // 中间漏了天，滑出量算不全

        // 跨了一天才有「滑出窗口」这回事；同一天重访时快照已经是今天的窗口，
        // 再扣滑出量和误差半径就会每刷一次往里缩一格
        const drop = gap === 1 ? (u.days[shiftDay(today, -7)] || {}) : {};
        const slack = gap === 1 ? (base.w || 0) : 0;
        const prior = new Map();
        const pairs = [];
        for (const [id, info] of weekDs.map) {
            if (!(id in base.week)) continue; // 新进榜：没有基线，不参与定界
            const p = base.week[id] - (drop[id] || 0) - slack;
            if (p <= 0) continue;
            prior.set(id, p);
            pairs.push({ score: info.score, prior: p });
        }
        if (!pairs.length) return null;

        const sat = exactM === null || exactM >= SATURATION;
        const hard = hardBound(pairs, sat ? SATURATION : 1);
        // 下界都越过搜索上界了，说明先验本身离谱 —— 宁可不说话
        if (hard > SAT_MAX) return null;
        // 精确反解没被下界证伪，就没必要再折腾
        if (!sat && exactM >= hard) return { hard, ok: true };

        const pin = pinScale(pairs, hard);
        if (pin.hi === null || pin.hi - pin.lo > Math.max(3, pin.lo * SAT_SLACK)) {
            return { hard, lo: pin.lo, agree: pin.agree }; // 只定住下界
        }

        // 每首歌的次数：先验落在区间里就取先验（那就是「今天没动」），否则取中点
        const counts = new Map();
        const band = new Map();
        for (const [id, info] of weekDs.map) {
            // 榜首的次数按定义就是 M 本身，不用再进格点
            const [a, b] = info.score === 100 ? [pin.lo, pin.hi] : bandOf(info.score, pin.lo, pin.hi);
            const p = prior.get(id);
            counts.set(id, p !== undefined && p >= a && p <= b ? p : Math.round((a + b) / 2));
            band.set(id, [a, b]);
        }
        return { hard, lo: pin.lo, hi: pin.hi, counts, band, agree: pin.agree };
    }

    // 两份数据各取所长，交给 applyObservation 合并：
    // 周榜反解覆盖「最近一周」tab，全时间真值覆盖「所有时间」tab，一份增量表两个 tab 通用
    function recordDaily(uid, weekDs, allDs) {
        if (!CFG.DAILY) return null;

        const store = loadStore();
        const u = store.users[uid] || (store.users[uid] = { days: {} });
        const today = dayKey(new Date());

        const exactM = weekDs && weekDs.scale ? weekDs.scale.M : null;
        const exactOk = exactM !== null && exactM < SATURATION;
        const pin = weekDs && weekDs.map.size ? pinWeek(u, weekDs, today, exactM) : null;
        // 精确解落在锁定区间里就信精确解；落在外面说明它被下界证伪了
        const usePin = !!(pin && pin.counts && !(exactOk && exactM >= pin.lo && exactM <= pin.hi));

        let wk = null;
        let width = 0; // 这份次数的误差半径，0 表示精确反解
        let bound = pin && !usePin && pin.hard > (exactOk ? exactM : 0) ? pin.hard : 0;

        if (usePin) {
            wk = {};
            for (const [id, c] of pin.counts) wk[id] = c;
            width = Math.ceil((pin.hi - pin.lo) / 2); // 区间退化成一点时 width=0，当作精确值
            weekDs.scale = weekDs.scale || { M: SATURATION, countOf: new Map() };
        } else if (exactOk) {
            wk = {};
            for (const [id, info] of weekDs.map) {
                const c = weekDs.scale.countOf.get(info.score);
                if (c !== undefined) wk[id] = c;
            }
        }
        if (weekDs && weekDs.scale) weekDs.scale.pin = usePin ? pin : null; // 交给 describe 渲染

        // 全时间榜的 playCount 是服务端给的绝对值，不依赖任何标尺
        const al = {};
        if (allDs) for (const [id, info] of allDs.map) if (info.playCount > 0) al[id] = info.playCount;
        if (!wk && !Object.keys(al).length) return null;

        u.seen = Date.now();
        const res = applyObservation(u, today, wk || {}, al);
        if (width && u.cur) u.cur.w = width; // 估算快照的误差半径，明天当先验要打折

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
            time, exact: res.exact, gap: res.gap, est: width, bound,
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
        const bound = day && day.bound; // 饱和标尺卡出来的下界

        if (info.playCount > 0) {
            r = { text: `${info.playCount}次`, tip: `播放 ${info.playCount} 次（接口返回的真实数据）` };
        } else {
            const sat = !scale || scale.M >= SATURATION;
            const solved = scale && scale.countOf.has(info.score) ? scale.countOf.get(info.score) : null;
            const pin = scale && scale.pin; // 饱和标尺被历史次数锁定时的区间估计
            const pinned = pin && pin.counts ? pin.counts.get(info.id) : undefined;

            if (CFG.MODE !== 'percent' && pinned !== undefined) {
                const [a, b] = pin.band.get(info.id);
                const range = pin.lo === pin.hi ? `M=${pin.lo}` : `M=${pin.lo}~${pin.hi}`;
                r = a === b
                    ? { text: `${a}次`, tip: `标尺按上一次的记录锁在 ${range}，这一行的次数唯一` }
                    : { text: `~${pinned}次`, tip: `标尺按上一次的记录锁在 ${range}，这一行落在 ${a}~${b} 次` };
            } else if (CFG.MODE === 'count' && scale) {
                r = solved !== null && !sat
                    ? { text: `${solved}次`, tip: `格点反解，M=${scale.M}` }
                    : { text: `≥${bound || scale.M}次`, tip: `标尺饱和，只定得住下界，真实值可能远高于此` };
            } else if (CFG.MODE !== 'percent' && solved !== null && !sat) {
                r = {
                    text: `${solved}次`,
                    tip: bound
                        ? `格点反解给出 M=${scale.M}，但历史次数显示至少 ${bound} 次，这个标尺偏小了`
                        : `格点反解得到唯一标尺 M=${scale.M}，次数可信`,
                };
            } else if (CFG.ASSUME_TOP_COUNT > 0) {
                const M = CFG.ASSUME_TOP_COUNT;
                const lo = Math.ceil(info.score * M / 100);
                const hi = Math.max(lo, Math.ceil((info.score + 1) * M / 100) - 1);
                r = { text: `~${Math.round((lo + hi) / 2)}次`, tip: `按榜首=${M}次推算，区间 ${lo}~${hi} 次` };
            } else {
                const low = bound
                    ? `；榜首本周至少 ${bound} 次（靠昨天的次数卡出来的下界）`
                    : (scale ? `，反解下限 ≥${scale.M} 次但标尺已饱和` : '');
                r = { text: `${info.score}%`, tip: `占榜首播放量的 ${info.score}%${low}` };
            }
        }

        if (day && day.counts) {
            const n = day.counts[info.id] || 0;
            if (day.warm) {
                r.tip += '；今日增量首个观测日，明日开始统计';
            } else if (n > 0 && day.newIds && day.newIds.has(info.id)) {
                // 新进榜：本周累计当上限。多数时候这首歌就是今天才开始听的，值恰好等于当日
                r.delta = `+${n}`;
                r.deltaTip = `今天新进榜，本周累计 ${n} 次（今日上限，可能含前几天的播放）`;
            } else if (n > 0) {
                const truth = day.fromAll && day.fromAll.has(info.id);
                const src = truth
                    ? (day.gap === 1 ? '全时间榜真值差分' : `全时间榜真值差分但跨了 ${day.gap} 天`)
                    : day.est
                        ? `周榜标尺靠历史次数锁定，误差 ±${day.est} 次`
                        : (day.exact ? '周榜反解差分' : '周榜反解差分，含窗口滑出的估算误差');
                r.delta = `+${n}`; // 交给子元素渲染，紧贴数字之后
                r.deltaTip = `今日新增 ${n} 次（${day.time} 观测，${src}）`;
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
    console.info('[Creepy Monitor] v3.6.0 已加载');
})();
