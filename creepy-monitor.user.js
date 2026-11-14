// ==UserScript==
// @name 隔墙有耳 · Creepy Monitor
// @namespace https://github.com/Celeslime/creepy-monitor
// @version 3.8.0
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
    // 格点步长 100/M 就是「一格百分比对应几次播放」。M 越大格子越粗，
    // 同一份榜单能被越多个 M 解释 —— 反解给出的「最小可行值」就越可能只是巧合。
    // 步长 1.1（M=91）是实测的转折点：再往上，sim 里那些 M=91~95 的账号
    // 会被系统性地低估 10~20%，而这个区间的榜单本身确实区分不开
    const GRAIN = 1.1;
    const DENSE = Math.ceil(100 / GRAIN); // 91，反解的「稀疏线」
    // M0 之后这么近的地方还有别的标尺也能解释榜单，就说不上「解出来了」
    const AMBIGUOUS = 0.1;
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
    // 两次观测是不是同一把尺子：两个区间有交集就算。缺一边的信息时不做判断，
    // 按老行为走（旧存储没有 sc 字段，升级当天不该整页哑掉）
    function sameScale(a, b) {
        if (!a || !b) return true;
        const ahi = a.hi === null ? Infinity : a.hi;
        const bhi = b.hi === null ? Infinity : b.hi;
        // 留 5% 的余地：榜首多听了两三首不该让整页增量作废
        const tol = Math.max(2, 0.05 * Math.max(a.lo, b.lo));
        return a.lo <= bhi + tol && b.lo <= ahi + tol;
    }

    function applyObservation(u, today, wk, al, sc) {
        if (!u.days) u.days = {};

        const now = { day: today, week: wk, all: al };
        if (sc) now.sc = sc;
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
            if (sc) u.cur.sc = sc;
        }

        if (!u.base) return null;

        // 标尺换了，周榜这份快照是不是同一把尺子量出来的，得看那天的次数定没定死。
        // 旧存储没有 sc 字段，就拿昨天快照里的最大值（榜首次数）当它的标尺，
        // 并把它当成「定没定死不可知」，保守处理
        let baseSc = u.base.sc;
        let basePoint = false; // 那天的次数是不是唯一确定（区间退化成一个点）
        if (!baseSc) {
            const bw = u.base.week || {};
            const ks = Object.keys(bw);
            if (ks.length) {
                let mx = 0;
                for (const k of ks) if (bw[k] > mx) mx = bw[k];
                baseSc = { lo: mx, hi: mx };
            }
        } else {
            basePoint = baseSc.hi !== null && baseSc.hi === baseSc.lo;
        }
        const todayPoint = !!(sc && sc.hi !== null && sc.hi === sc.lo);

        // 标尺变了不等于两天不可比。区间退化成一个点，说明那天是精确反解，
        // 每首歌的次数就是真实次数本身 —— 榜首今天多听了 7 次把 M 从 29 顶到 36，
        // 别人的次数并不因此改变，相减依然成立，只是那一格可能差一次。
        // 只有靠先验锁在一段区间里的标尺（lo≠hi）才真的不能比
        const same = !sc || !baseSc || sameScale(baseSc, sc);
        const moved = !same && !(todayPoint && basePoint);
        if (moved) u.dirty = today; // 这天没记增量，7 天后的滑窗补偿会缺这一块，标出来
        const shift = !same && !moved; // 跨了两把尺子相减：值照给，但这天不算精确

        const baseWeek = u.base.week || {};
        const baseAll = u.base.all || {};
        const coldAll = !Object.keys(baseAll).length; // 全时间基线还没建立（升级 / 首次）
        const coldWeek = !Object.keys(baseWeek).length; // 周榜基线还没建立（那天标尺没解出来）
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
        // 7 天前那天的增量已滑出，必须加回来。标尺换了、或昨天整份没解出来，就整段跳过
        if (!moved && !coldWeek) {
            for (const id of Object.keys(wk)) {
                if (id in counts) continue;
                if (!(id in baseWeek)) {
                    // 昨天不在榜：本周累计里可能混着前几天的播放，拿它当今日增量是**上限**。
                    // 但新进榜大多是「今天才开始听」，多数时候就等于当日值，所以照给
                    newIds.add(id);
                    counts[id] = wk[id];
                    continue;
                }
                // 昨天的窗口一定包含 7 天前那一天，所以昨天的累计不可能小于
                // 那天的增量。小于就说明昨天的反解偏小了（标尺粗，2 次和 3 次
                // 落在同一个 score 上），这时拿那天的增量当它的下界，否则补偿项
                // 会被整个加回来，算出「本周 2 次、今日 +3」这种自相矛盾的值
                const c7 = comp ? (comp[id] || 0) : 0;
                const d = wk[id] - Math.max(baseWeek[id], c7) + c7;
                counts[id] = Math.max(0, d); // 掉出榜单导致的负值钳到 0
            }
        }

        u.days[today] = counts;
        pruneDays(u, today);

        // 只有「补偿项在手 + 昨天确实访问过 + 最近 8 天没漏访」才算精确
        const clean = !u.dirty || daysBetween(u.dirty, today) >= 8;
        return {
            counts, fromAll, newIds, coldAll, coldWeek, gap,
            exact: !!comp && gap === 1 && clean && !shift,
            scaleMoved: moved, scaleShift: shift, prevScale: moved || shift ? baseSc : null,
            scale: sc || null,
        };
    }

    // 页头「累积听歌 N 首」是注册以来听过多少首不同的歌，按歌曲计、不按次数，
    // 服务端只增不减。所以跨天相减就是「这期间第一次听到的歌」有几首。
    // 它和排行那套差分是两条独立的线：排行只给 top100，这条不挑歌。
    // 接口里同一个数叫 listenSongs（/api/v1/user/detail），用来核对语义
    function recordHead(u, today, n) {
        if (!Number.isFinite(n)) return null; // 页头还没渲染出来，不拿旧值充数
        const prev = u.head;
        if (!prev) { // 头一天只有基线，没有增量
            u.head = { day: today, base: n, n };
            return null;
        }
        if (prev.day === today) { // 同一天再看：计数会涨，增量跟着涨
            if (n > prev.n) prev.n = n; // 同一版页面不会倒退，读到更小的值就当它没动
            const d = prev.n - prev.base;
            return d > 0 ? { n: prev.n, d, gap: prev.since ? daysBetween(prev.since, today) : 1 } : null;
        }
        // 跨天：上次记下的值成了今天的基线
        u.head = { day: today, base: prev.n, n, since: prev.day };
        const d = n - prev.n;
        if (d <= 0) { // 这个数不会倒退，出现负的说明解析口径变了，就地重立基线
            u.head.base = n;
            return null;
        }
        return { n, d, gap: daysBetween(prev.day, today) };
    }

    // 某个 M 下，score → 次数 的反查表。格点从 1 起：能进榜就说明本周至少听过一次，
    // 0 次不在解空间里。这条约束会顺带定死一件事 —— score=0 只可能由 M ≥ 101 产生
    function countMapOf(M) {
        const countOf = new Map();
        for (let i = 1; i <= M; i++) {
            const s = Math.floor(100 * i / M);
            if (!countOf.has(s)) countOf.set(s, i);
        }
        return countOf;
    }

    // M 是否能让每个 score 都命中。等价于存在 i ∈ [1,M] 使 floor(100i/M)=s，
    // 即 ceil(s·M/100) ≤ i ≤ ceil((s+1)·M/100)−1 且 i 落在 1..M 内
    function fitsScale(uniq, M) {
        return uniq.every(s => {
            const a = Math.max(1, Math.ceil(s * M / 100));
            const b = Math.min(M, Math.ceil((s + 1) * M / 100) - 1);
            return a <= b;
        });
    }

    // 周榜只给 score = floor(100c/M)。取最小可行 M —— 可行集通常是一段连续区间
    // [M, ∞)，所以这个值只是个下界，真实标尺可能大得多
    function solveScale(scores) {
        const uniq = [...new Set(scores)];
        if (!uniq.length) return null;

        for (let M = 1; M <= SAT_MAX; M++) {
            if (!fitsScale(uniq, M)) continue;
            return { M, countOf: countMapOf(M) };
        }
        return null;
    }

    // M0 往后 10% 以内，还有没有别的标尺也能解释同一份榜单？
    // 有，说明 M0 不是唯一解释 —— 榜单在这个尺度上分不出 89 和 127，
    // 那个「最小可行值」只是碰巧最小，写次数就是编。
    // 完整榜（每首都进榜）时最近的另一个标尺至少差 19%，截断稀疏榜却常常只差 1%，
    // 10% 这条线就是实测出来的分界（见 test/sim.js 的饱和区统计）
    function nearFit(uniq, M0) {
        const top = Math.min(SAT_MAX, Math.ceil(M0 * (1 + AMBIGUOUS)));
        for (let M = M0 + 1; M <= top; M++) if (fitsScale(uniq, M)) return M;
        return null;
    }

    // score 对应的次数区间：s = floor(100c/M)，解出 c ∈ [⌈s·M/100⌉, ⌈(s+1)·M/100⌉ − 1]
    // 下界从 1 起：能进榜就说明本周至少听过一次，score=0 不等于 0 次
    function bandOf(score, lo, hi) {
        const a = Math.max(1, Math.ceil(score * lo / 100));
        const b = Math.ceil((score + 1) * hi / 100) - 1;
        return [a, Math.max(a, b)];
    }

    // 次数区间的显示：窄区间写开比「~中点」信息多，宽区间才缩成约数
    function spanOf(a, b, mid) {
        if (a === b) return `${a}次`;
        if (b - a > 2) return `~${mid}次`;
        return `${a}~${b}次`;
    }

    // 标尺的写法，用在悬停里说明「换了哪把尺子」
    function fmtScale(s) {
        if (!s) return '未知';
        if (s.hi === null) return `≥${s.lo}`;
        return s.lo === s.hi ? `${s.lo}` : `${s.lo}~${s.hi}`;
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
    // 于是「谁的 prior 能倒出自己的 score」成了筛子，扫一遍就能把 M 卡成窄区间。
    // 命中数可能有几处并列的高点（一批歌今天没动、另一批昨天就估偏了），
    // 只认其中最长的一段连续区间 —— 把不相邻的高点连起来会得到一个假的很宽的区间，
    // 白白扔掉本来能锁定的那次机会
    function pinScale(pairs, start, end) {
        const top = Math.min(SAT_MAX, end || SAT_MAX);
        let best = 0;
        let runFrom = -1; // 当前这段连续命中的起点
        let lo = start, hi = start; // 目前最长的那段
        for (let M = start; M <= top; M++) {
            let hit = 0;
            for (const p of pairs) if (Math.floor(100 * p.prior / M) === p.score) hit++;
            if (hit > best) {
                best = hit;
                runFrom = M;
                lo = hi = M;
            } else if (hit > 0 && hit === best) {
                if (runFrom < 0) runFrom = M;
                if (M - runFrom > hi - lo) { lo = runFrom; hi = M; }
            } else {
                runFrom = -1;
            }
        }

        // 大半对不上：今天这批歌基本都在涨，prior 已经不是次数了
        if (best < Math.max(3, pairs.length * 0.6)) return { lo: start, hi: null, agree: best };
        if (hi >= top) return { lo, hi: null, agree: best }; // 极值落在搜索上界，只能说到这儿
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
            map.set(String(id), {
                score,
                playCount: Number(it.playCount) || 0,
                name: it.song.name,
                art: it.song.artists && it.song.artists[0] ? it.song.artists[0].name : '',
            });
        }
        return { map, scores, scale: solveScale(scores) };
    }

    // 同一场录音常常挂着好几个 id：单曲版、专辑版各算一个，标题大小写还不一定一样。
    // 「我听了 N 次」只按 id 对就会整行空着 —— 169 的 1808235517 是 2021 年的单曲，
    // 我这边听的是专辑 NEGATIVE 里的 2063210044，同一段 146 秒的录音，两个 id。
    // 所以另外留一份「歌名 + 首位歌手」的索引当后手，id 对不上时才查它
    function nameKey(info) {
        if (!info || !info.name) return '';
        const n = String(info.name).toLowerCase().replace(/\s+/g, ' ').trim();
        if (!n) return '';
        const a = info.art ? String(info.art).toLowerCase().trim() : '';
        return n + '\u0001' + a;
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
    let mineMap = null; // { byId, byName }：我最近一周的真实次数，byName 兜同名异 id
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
    // 只要最近一周，不拉「全部时间」，省掉一次请求。
    // 注意不能复用 loadData 的缓存：那份走 type=-1，weekData 的 playCount 被
    // 服务端清成 0（只有 score 是真数），拿来当「我听了 N 次」会一首歌都取不到。
    // 3.5.0 把排行请求合并成 -1 之后，这条复用曾经让功能在看过自己主页后静默失效
    async function loadMine() {
        const hit = await getMe();
        if (!hit) return null;
        if (mineMap && Date.now() - mineAt < CFG.CACHE_MS) return mineMap;

        const weekDs = buildDataset(await fetchRecord(hit, 1), 'weekData');

        const byId = new Map();
        const byName = new Map();
        for (const [id, info] of weekDs.map) {
            if (!(info.playCount > 0)) continue;
            byId.set(id, info.playCount);
            const k = nameKey(info);
            if (k) byName.set(k, info.playCount);
        }
        if (!byId.size && weekDs.map.size) log('本人的 playCount 也是 0：服务端可能改了口径');
        mineMap = byId.size ? { byId, byName } : null;
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

    // 周榜榜首那首歌，本周次数就是 M。它同时可能躺在全时间榜里：
    // 上界 = 那首歌的终身累计（本周次数不可能超过它）
    // 下界 = days 里最近 7 天的累加（每天听了多少，本来就在记）
    // 这两条都不依赖任何标尺，能打破「标尺错了 → 先验也跟着错」的循环
    // 榜只发 100 条。榜首不在里面同样是信息：满员时缺席就意味着它的终身次数
    // 不到榜尾，这个上界照样能把一把放大的尺子证伪
    function anchorM(u, allDs, weekDs, today) {
        if (!allDs || !weekDs || !weekDs.map.size) return null;
        let topId = null;
        for (const [id, info] of weekDs.map) {
            if (info.score === 100) { topId = id; break; }
        }
        if (!topId) return null;

        const life = allDs.map.get(topId);
        let hi = null;
        if (life && life.playCount) hi = life.playCount;
        else if (allDs.map.size >= 100) {
            // 榜满 100 条还没有它：终身次数不会超过榜尾。并列时榜尾可能也等于
            // 这个数，所以按 <= 取上界，不往下扣 1
            for (const info of allDs.map.values()) {
                if (hi === null || info.playCount < hi) hi = info.playCount;
            }
        }
        if (!hi) return null; // 榜不满员，缺席什么都说明不了

        let lo = 0;
        for (let k = 0; k < 7; k++) {
            const d = u.days && u.days[shiftDay(today, -k)];
            if (d) lo += (d[topId] || 0);
        }
        return { lo: Math.min(lo, hi), hi, topId, known: !!(life && life.playCount) };
    }

    // 用上一次的快照给周榜标尺定界。返回 null 表示没有先验可用；
    // 否则给出 { hard, prior, range, agree }：
    // hard 是先验推出来的下界（播放不倒退，M 不可能比它小）；
    // prior 是每首歌「今天没动的话应该是几次」，挑值时优先用它；
    // range 是把 M 卡进的窄区间，null 表示只定住了下界。
    // capHi 是「本周次数不可能超过」的硬上界（榜首的终身次数 / 榜尾值）
    function pinWeek(u, weekDs, today, exactM, capHi) {
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
        // 饱和的门槛至少是 SATURATION；反解已经给出更大的下界（比如榜单里有 score=0，
        // 说明 M ≥ 101）就直接从那个值起扫，别从 96 白白往下探
        const from = sat ? Math.max(SATURATION, exactM || 0) : 1;
        const hard = hardBound(pairs, from);
        // 下界都越过搜索上界了，说明先验本身离谱 —— 宁可不说话
        if (hard > SAT_MAX) return null;
        // 先验推出来的下界越过硬上界：错的是先验，不是上界。
        // 再往下 pin 只会把上一把错尺子钉得更死，干脆整条链作废
        if (capHi !== null && hard > capHi) return null;
        // 精确反解没被下界证伪，就没必要再折腾
        if (!sat && exactM >= hard) return { hard, prior, range: null, agree: 0 };

        const pin = pinScale(pairs, hard, capHi === null ? SAT_MAX : capHi);
        if (pin.hi === null || pin.hi - pin.lo > Math.max(3, pin.lo * SAT_SLACK)) {
            return { hard, prior, range: null, agree: pin.agree }; // 只定住下界
        }
        // 命中段的两端都是估出来的（prior 本身带 ±1 的踩点误差），往里收着用会把
        // 真值关在门外 —— 两端各留 1 次余量，显示成区间而不是一个点
        return {
            hard, prior, agree: pin.agree,
            range: [Math.max(1, pin.lo - 1), pin.hi + 1],
        };
    }

    // 每首歌的次数：给定标尺区间 [lo, hi]，逐行取带内最合理的值。
    // 先验落在带里就用先验（那就是「今天没动」），否则取带中点；带只剩一个点就是它本身。
    // 榜首的次数按定义就是 M，不用进格点
    function countsFor(weekDs, lo, hi, M, prior) {
        const counts = new Map();
        const band = new Map();
        for (const [id, info] of weekDs.map) {
            if (info.score === 100) {
                counts.set(id, M);
                band.set(id, [lo, hi]);
                continue;
            }
            const [a, b] = bandOf(info.score, lo, hi);
            const p = prior ? prior.get(id) : undefined;
            counts.set(id, p !== undefined && p >= a && p <= b ? p : (a === b ? a : Math.round((a + b) / 2)));
            band.set(id, [a, b]);
        }
        return { counts, band };
    }

    // 这次观测该用哪把尺子、每首歌算几次、拿什么当「当天标尺」记下来。
    // 只读两份数据集和昨天的状态，不碰存储，测试可以直接喂构造出来的对象。
    // 返回的 scale 由调用方挂回 weekDs.scale —— describe 从那里取展示依据。
    //
    // 整体做法：每条证据只说明「M 必须落在哪一段」，最后求交，不再一条条改别人的结论。
    // 格点反解给出 [M0, ∞)：硬下界，真实标尺一定让每个 score 都能命中；
    // 榜首终身累计给出 [1, cap]：硬上界，本周次数不可能超过它的终身累计；
    // 最近 7 天累加给出 [lo, ∞)：软下界，来自 days 里那串历史估算；
    // 播放不倒退给出 [hard, ∞)：软下界；
    // prior 命中段给出 [lo, hi]：软区间，没动过的那批歌 prior 就是本周次数。
    // 硬证据互相矛盾就整条放弃；软证据与硬结论冲突时丢掉它，而不是反过来改硬结论。
    // 以后再加一条证据，就是多交一个区间，不用回头调顺序
    function resolveWeek(weekDs, allDs, u, today) {
        const empty = { scale: null, wk: null, sc: null, width: 0, bound: 0 };
        if (!weekDs || !weekDs.map.size) return empty;

        const uniq = [...new Set(weekDs.scores)];
        const M0 = weekDs.scale ? weekDs.scale.M : null; // 格点反解的最小可行标尺
        const anchor = anchorM(u, allDs, weekDs, today);
        const cap = anchor ? anchor.hi : null;

        // 硬交集：两条都不依赖历史估算。打架说明这份观测本身对不上，宁可不说话
        let box = [M0 === null ? 1 : M0, cap === null ? Infinity : cap];
        if (box[0] > box[1]) return empty;

        const pin = pinWeek(u, weekDs, today, M0, cap);
        const prior = pin ? pin.prior : null;
        const prevM = u.cur && u.cur.sc ? u.cur.sc.lo : null;

        let M = M0;
        let lo = box[0], hi = box[1];
        let width = 0, bound = 0, path = '', lockBy = '', loose = false;

        // ① 反解在饱和线以下：格点够细，最小可行值就是它，不必找别的解释。
        // 这一步必须最先生效 —— 上一把尺子错了，先验也会跟着错，
        // 让它去顶反解就再也纠不回来（3.7.1 那个 175 次就是这么来的）
        if (M0 !== null && M0 < SATURATION) {
            M = M0; lo = hi = M0; path = 'solve';
            // 先验反过来证伪了反解（历史次数显示榜首至少听了这么多），
            // 那就只把这个下界说出来，不改数字
            if (pin && pin.hard > M0) bound = pin.hard;
            // 附近还有别的标尺能解释这份榜单时，M0 就只是「碰巧最小的那个」
            loose = !!nearFit(uniq, M0);
        }

        // ② 反解不可辨识：看历史先验能不能把区间收窄到 5% 以内。
        // 候选按「具体程度」排：命中段最硬（它同时用上了每一首歌），
        // 锚定次之，纯下界最后
        if (!path) {
            const cand = [];
            if (pin && pin.range) cand.push({ name: 'pin', box: pin.range });
            if (anchor) cand.push({ name: 'anchor', box: [Math.max(1, anchor.lo), anchor.hi] });
            if (pin && pin.hard > box[0]) cand.push({ name: 'prior', box: [pin.hard, box[1]] });
            for (const c of cand) {
                const a = Math.max(box[0], c.box[0]);
                const b = Math.min(box[1], c.box[1]);
                if (a > b) continue; // 与硬证据冲突，丢掉这条
                if (b === Infinity) continue; // 只有下界，收窄不了
                if (b - a > Math.max(3, a * SAT_SLACK)) continue; // 太宽，不算锁定
                lo = a; hi = b; M = a;
                width = Math.ceil((hi - lo) / 2);
                path = 'lock'; lockBy = c.name;
                break;
            }
        }

        // ③ 还是定不下来：沿用上次那把尺子。它只能在这个区间里挑值 ——
        // 过了上界就作废，也不许改写 ① 的结论
        if (!path) {
            const ok = prevM !== null && prevM >= box[0]
                && (box[1] === Infinity || prevM <= box[1]) && fitsScale(uniq, prevM);
            if (ok) {
                M = prevM; lo = prevM; hi = Infinity; path = 'prev';
            }
        }

        // ④ 什么都没有：拿反解下界当点估计，并说清楚它只是下界
        if (!path) {
            M = box[0]; lo = M; hi = Infinity; path = 'lower';
            if (pin && pin.hard > M) bound = pin.hard;
        }

        let wk = null, keptPin = null;
        if (path === 'lock') {
            // 区间里逐首挑值，先验优先
            const { counts, band } = countsFor(weekDs, lo, hi, M, prior);
            wk = {};
            for (const [id, c] of counts) wk[id] = c;
            keptPin = { lo, hi, counts, band };
        } else {
            // 点估计：按反解查表。两天用同一把尺子时差分仍然成立，
            // 只是尺度整体可能缩水，所以照样存下来，明天才有东西可比
            const countOf = countMapOf(M);
            wk = {};
            for (const [id, info] of weekDs.map) {
                const c = countOf.get(info.score);
                if (c !== undefined) wk[id] = c;
            }
        }

        // 记下这次用的是哪把尺子，明天要比对：换了尺子的两天不能相减
        const sc = hi === Infinity ? { lo: M, hi: null } : { lo, hi };

        // pin 和 anchor 只挂在 scale 上给 describe 用。拷一份，别改到传进来的数据集。
        // anchor 只在它真正参与了锁定的时候才挂 —— 否则 describe 会以为这个 M 是
        // 被榜首终身次数夹出来的，把「只是下界」的估计当成精确值显示
        const scale = Object.assign({}, weekDs.scale || {}, {
            M,
            countOf: countMapOf(M),
            pin: keptPin,
            anchor: lockBy === 'anchor' ? { lo: anchor.lo, hi: anchor.hi } : undefined,
            loose, // 这个 M 只是众多解释里最小的那个，不能当精确值用
            why: path + (lockBy ? ':' + lockBy : ''), // 走了哪条路，出问题时看这个
        });
        return { scale, wk, sc, width, bound };
    }

    // 两份数据各取所长，交给 applyObservation 合并：
    // 周榜反解覆盖「最近一周」tab，全时间真值覆盖「所有时间」tab，一份增量表两个 tab 通用
    function recordDaily(uid, weekDs, allDs, headN) {
        if (!CFG.DAILY) return null;

        const store = loadStore();
        const u = store.users[uid] || (store.users[uid] = { days: {} });
        const today = dayKey(new Date());
        const head = recordHead(u, today, headN); // 页头那个计数和标尺无关，先记下

        const r = weekDs && weekDs.map.size ? resolveWeek(weekDs, allDs, u, today) : null;
        if (r && r.scale) weekDs.scale = r.scale; // describe 从这里取展示依据

        // 全时间榜的 playCount 是服务端给的绝对值，不依赖任何标尺
        const al = {};
        if (allDs) for (const [id, info] of allDs.map) if (info.playCount > 0) al[id] = info.playCount;
        const wk = r ? r.wk : null;
        if (!wk && !Object.keys(al).length) {
            // 排行这边没东西可算（榜单空 / 接口没回来），页头那个计数照样要落盘
            saveStore(store);
            return { counts: {}, warm: true, head };
        }

        u.seen = Date.now();
        const res = applyObservation(u, today, wk || {}, al, r ? r.sc : null);
        if (r && r.width && u.cur) u.cur.w = r.width; // 估算快照的误差半径，明天当先验要打折

        // 人数上限：淘汰最久未访问的
        const uids = Object.keys(store.users);
        if (uids.length > CFG.MAX_USERS) {
            uids.sort((a, b) => (store.users[a].seen || 0) - (store.users[b].seen || 0))
                .slice(0, uids.length - CFG.MAX_USERS)
                .forEach(k => delete store.users[k]);
        }
        saveStore(store);

        const time = new Date().toTimeString().slice(0, 5);
        if (!res) return { counts: {}, time, exact: false, warm: true, head };
        return {
            counts: res.counts, fromAll: res.fromAll, newIds: res.newIds,
            coldAll: res.coldAll, coldWeek: res.coldWeek, head,
            time, exact: res.exact, gap: res.gap, est: r ? r.width : 0, bound: r ? r.bound : 0,
            scaleMoved: res.scaleMoved, scaleShift: res.scaleShift,
            prevScale: res.prevScale, scale: r ? r.sc : null,
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

    // 页头写的是「累积听歌3751首」，也可能带千分位或缩成万
    function parseCount(s) {
        const m = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(万)?/.exec(s || '');
        if (!m) return null;
        return Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1e4 : 1));
    }

    // 页头那个数。自己插的尾巴在文本末尾，第一个数字永远是站点的
    const headCount = doc => {
        const el = doc.querySelector('#rHeader h4');
        return el ? parseCount(el.textContent) : null;
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
            // 标尺可信的两条路：被锚住的（榜首终身次数 + 最近 7 天累加夹出来的，
            // 不靠反解猜），或者格点够细、附近也没有第二种解释。除此之外一律按占比显示，
            // 这时写次数就是编
            const sat = !scale || (!scale.anchor && (scale.M >= DENSE || !!scale.loose));
            const solved = scale && scale.countOf.has(info.score) ? scale.countOf.get(info.score) : null;
            const pin = scale && scale.pin; // 标尺被历史次数锁定时的区间估计
            const pinned = pin && pin.counts ? pin.counts.get(info.id) : undefined;

            if (CFG.MODE !== 'percent' && pinned !== undefined) {
                const [a, b] = pin.band.get(info.id);
                const range = pin.lo === pin.hi ? `M=${pin.lo}` : `M=${pin.lo}~${pin.hi}`;
                r = a === b
                    ? { text: `${a}次`, tip: `标尺按上一次的记录锁在 ${range}，这一行的次数唯一` }
                    : { text: spanOf(a, b, pinned), tip: `标尺按上一次的记录锁在 ${range}，这一行落在 ${a}~${b} 次` };
            } else if (CFG.MODE === 'count' && scale) {
                r = solved !== null && !sat
                    ? { text: `${solved}次`, tip: `格点反解，M=${scale.M}` }
                    : { text: `≥${bound || scale.M}次`, tip: `标尺太粗，只定得住下界，真实值可能远高于此` };
            } else if (CFG.MODE !== 'percent' && solved !== null && !sat) {
                r = {
                    text: `${solved}次`,
                    tip: scale.anchor
                        ? `榜首在全时间榜里有 ${scale.anchor.hi} 次累计，最近 7 天累计 ${scale.anchor.lo}~${scale.anchor.hi} 次`
                            + `，标尺锁在 M=${scale.M}`
                        : (bound
                            ? `格点反解给出 M=${scale.M}，但历史次数显示至少 ${bound} 次，这个标尺偏小了`
                            // 榜单只能把 M 卡到 1% 上下，说「唯一」是过头了
                            : `格点反解的最小可行标尺 M=${scale.M}，次数按它推算，误差在 1% 上下`),
                };
            } else if (CFG.ASSUME_TOP_COUNT > 0) {
                const M = CFG.ASSUME_TOP_COUNT;
                const lo = Math.max(1, Math.ceil(info.score * M / 100));
                const hi = Math.max(lo, Math.ceil((info.score + 1) * M / 100) - 1);
                r = { text: `~${Math.round((lo + hi) / 2)}次`, tip: `按榜首=${M}次推算，区间 ${lo}~${hi} 次` };
            } else {
                const low = bound
                    ? `；榜首本周至少 ${bound} 次（靠昨天的次数卡出来的下界）`
                    : (scale ? `，反解只能确定榜首 ≥${scale.M} 次` : '');
                // 占比不误导，但信息量低。把「按最小可行标尺推的话是多少」放进悬停，
                // 想深究的人能看到数，不想深究的人不会被一个可能偏小的数骗到
                const est = solved !== null && scale && !scale.anchor
                    ? `；若按最小可行标尺 M=${scale.M} 推算约 ${solved} 次，但更大的标尺同样解释得通`
                    : '';
                r = { text: `${info.score}%`, tip: `占榜首播放量的 ${info.score}%${low}${est}` };
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
                let src;
                if (truth) src = day.gap === 1 ? '全时间榜真值差分' : `全时间榜真值差分但跨了 ${day.gap} 天`;
                else if (day.scaleShift) src = `周榜反解差分，标尺从 ${fmtScale(day.prevScale)} 变成 ${fmtScale(day.scale)}，可能差一格`;
                else if (day.est) src = `周榜标尺靠历史次数锁定，误差 ±${day.est} 次`;
                else src = day.exact ? '周榜反解差分' : '周榜反解差分，含窗口滑出的估算误差';
                r.delta = `+${n}`; // 交给子元素渲染，紧贴数字之后
                r.deltaTip = `今日新增 ${n} 次（${day.time} 观测，${src}）`;
            } else if (day.scaleMoved) {
                r.tip += `；周榜标尺从 ${fmtScale(day.prevScale)} 变成 ${fmtScale(day.scale)}`
                    + '，两天的次数都只锁在区间里，相减没有意义，这天的周榜增量先不记';
            } else if (day.coldWeek) {
                r.tip += '；周榜基线今天才建立（昨天的标尺没解出来），明天起这一页才有增量';
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

    // 「今天新听了几首」挂在页头那行后面。不碰站点的文字，只在 h4 内部末尾追加一个 span，
    // 字号字体全继承，所以和「累积听歌3751首」是一句话读下来
    function renderHead(doc, head) {
        const el = doc.querySelector('#rHeader h4');
        if (!el) return; // 新版播放器没有这个页头，或者页面还没渲染出来：安静跳过
        let s = el.querySelector('.tm-head');
        if (!head || !head.d) {
            if (s) s.remove(); // 今天没有新歌：还原成站点原本的样子
            return;
        }
        if (!s) {
            s = doc.createElement('span');
            s.className = 'tm-head';
            s.style.cssText = 'margin-left:4px;'; // 只有间距，字体从 h4 继承
            el.appendChild(s);
        }
        const text = `+${head.d}`;
        const tip = head.gap > 1
            ? `距上次记录 ${head.gap} 天，这 ${head.gap} 天一共新听 ${head.d} 首；累计听过 ${head.n} 首（本地记录）`
            : `今天第一次听到 ${head.d} 首；累计听过 ${head.n} 首（本地记录，跨天才算得出）`;
        if (s.textContent !== text) s.textContent = text;
        if (s.title !== tip) s.title = tip;
    }

    function inject(doc, ds, day, mine, self) {
        let hit = 0;
        renderHead(doc, day && day.head);
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
            let my = 0;
            let byName = false;
            if (!self && mine) {
                my = mine.byId.get(id) || 0;
                if (!my) { // 同一段录音的另一个版本：歌名一样、id 不同
                    const k = nameKey(info);
                    if (k) my = mine.byName.get(k) || 0;
                    byName = my > 0;
                }
            }
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
                const myTip = byName
                    ? `你最近 7 天听了这首歌 ${my} 次。站内是另一版（单曲 / 专辑），ID 不同，这里按歌名认的`
                    : `你最近 7 天听了这首歌 ${my} 次，取自本人账号接口的真实数据`;
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

    // 「这一版列表处理过没有」的指纹。除了 uid、行数、首行内容，还要看我插的节点
    // 还在不在：列表被重渲染回原样时前三个特征一模一样，只看它们会误判成已处理，
    // 已经画上去的数字被冲掉之后再也补不回来
    function sigOf(doc, uid) {
        const first = doc.querySelector('#m-record li [data-res-id]');
        const stamped = doc.querySelector('#m-record .tm-times, #m-record .tm-delta, #m-record .tm-mine');
        return uid + '|' + doc.querySelectorAll('#m-record li').length + '|'
            + (stamped ? '1' : '0') + '|' + (first ? first.outerHTML : '');
    }

    async function tick() {
        if (busy) return;

        const doc = getDoc();
        const uid = doc ? getUid(doc) : hashUid();
        if (!uid) { lastSig = ''; return; }

        // 列表还没渲染出来：先把接口请求发出去，DOM 一到就能立刻画
        if (!doc) { loadData(uid).catch(() => {}); return; }

        const sig = sigOf(doc, uid);
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
            // 页头那个「累积听歌 N 首」不在列表里，顺手读一下，读不到就是 null
            const day = recordDaily(uid, data.week, data.all, headCount(doc)); // 两份都喂，与当前 tab 无关
            // 自己的主页不需要「我听了 N 次」，那栏本来就显示真实次数
            const hit = inject(doc, pickDataset(doc, data), day, mineMap, uid === me.uid);
            // 画完再取一次指纹：这时才带上「已注入」的标记，下一轮不会重复跑
            lastSig = sigOf(doc, uid);
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
    console.info('[Creepy Monitor] v3.8.0 已加载');
})();
