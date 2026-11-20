// 精细化仿真：被观察者按小时听歌，观察者每隔若干小时才刷新一次。
//
// 和 sim.js 的区别只在时间轴。那边一天听一次、一天看一次，等价于假设
// 「每次观测都正好隔 24 小时、而且落在同一个钟点」。真实用法不是这样 ——
// 想起来才点开，可能在 09:00，也可能在 23:50。
//
// 周榜是最近 168 小时的滚动窗口（2026-11-17 确认），脚本用 days[today-7] 补偿滑出去的
// 那一块。补偿成立的前提是「两次观测正好隔 24 小时、而且落在同一个钟点」—— 滚动窗口下
// 滚出去的是 168 小时前那一段，观测钟点一偏，那一段就跟着偏。脚本判「隔了几天」用的是
// 日历天（gap）：23:50 和次日 00:10 只差 20 分钟，gap 也是 1。这份仿真就是来量这个缝。
//
// --window 保留两档，day 只作对照（自然日窗口下补偿项跟观测钟点无关）：
// rolling 最近 168 小时（真滑动，站点的实际口径）
// day 最近 7 个自然日（按日期切）
//
// v3.8.2 起跨度跟 7 天前那格对不上的行不再出数，这里单独统计「被藏起来」的行数 ——
// 只看平均误差会被隐藏掉的行骗：藏得越多，剩下的行越准。
//
// 四条硬账（不加 --strict 也判失败）：
// allWrong：全时间榜的真值差分，任何情况下都该分毫不差
// shrink：同日重访、周榜没算出来时，把上午已经算好的行弄丢了
// badGap：同日重访的悬停写「跨了 0 天」
// leak：今天的榜里都没有这首，页面上却还挂着正数（补行补过头了）
// 另有两条只报数不判失败：flip（同一天两次观测之间没听、数字却变了）、supp（被藏起来的行）。
//
// --clump 让听歌成簇（一天只在一两个时段听）。匀着听时每首歌每小时最多滑出 1 次，
// 撞不到真实那种「一整坨一起滑出 168 小时窗口」——真实那份存储里 11-13 早上 20
// 分钟里 typhoon 听了 9 次。
//
// node test/sim-hourly.js [--accounts 4] [--days 24] [--every 6] [--jitter 0.6]
// [--window rolling|day] [--clump] [--seed 1] [--verbose]
const { load, makeStorage, makeClock } = require('./lib/harness');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : def;
};
const strOf = (name, def) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ACCOUNTS = argOf('accounts', 4);
const DAYS = argOf('days', 24);
const SEED = argOf('seed', 1);
const EVERY = argOf('every', 6); // 平均几小时看一次
const JITTER = argOf('jitter', 0.6); // 间隔的抖动幅度，0 表示恒定间隔
const WINDOW = strOf('window', 'rolling');
const VERBOSE = argv.includes('--verbose');
// --lag <小时>：服务端记录延迟，榜单只反映 N 小时前的状态
const LAG = argOf('lag', 0);
// --script <路径>：换一份脚本实现跑同一批观测（A/B 实验用）
const SCRIPT_PATH = strOf('script', '');
// --debug <天数>：只把第 N 天那几次观测里偏差最大的几行打出来
const DEBUG_DAY = argOf('debug', 0);
// --trace：逐次打印观测（时间、基线、gap、是否精确），排查时序问题用
const TRACE = argv.includes('--trace');
// --clump：听歌成簇（一天只在一两个时段听），而不是匀在整天里。真实用户就是
// 这样：真实那份存储里 11-13 早上 20 分钟里 typhoon 听了 9 次、雪落成盐 14 次，
// 168 小时窗口边界扫过那一段时是一整坨一起滑出去。匀着听的仿真碰不到这个，
// 每首歌每小时滑出量最多 1，误差看起来总是「差一格」。
const CLUMP = argv.includes('--clump');

if (WINDOW !== 'rolling' && WINDOW !== 'day') {
    console.error('--window 只认 rolling 或 day');
    process.exit(2);
}

/* ---------------- 确定性随机 ---------------- */
function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function poisson(lambda, rnd) {
    if (lambda <= 0) return 0;
    if (lambda > 40) { // 正态近似，免得循环太长
        const g = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
        return Math.max(0, Math.round(lambda + g * Math.sqrt(lambda)));
    }
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rnd(); } while (p > L);
    return k - 1;
}

/* ---------------- 听歌画像 ---------------- */
const PROFILES = [
    { name: 'casual', songs: 120, playsPerDay: [2, 8], topWeight: 1.0 },
    { name: 'normal', songs: 240, playsPerDay: [8, 26], topWeight: 1.0 },
    { name: 'wide', songs: 320, playsPerDay: [20, 45], topWeight: 1.0 },
    { name: 'heavy', songs: 400, playsPerDay: [60, 150], topWeight: 1.2 },
];

// 一天里的听歌分布：早晚通勤、午休、晚上最集中
const DIURNAL = [
    0.3, 0.15, 0.1, 0.1, 0.1, 0.2, 0.4, 0.7, 0.9, 1.0, 1.0, 1.0,
    1.1, 1.0, 0.9, 0.9, 1.0, 1.2, 1.4, 1.6, 1.7, 1.6, 1.2, 0.6,
];
const DSUM = DIURNAL.reduce((a, b) => a + b, 0);

const WARMUP_DAYS = 8; // 前 8 天不观测，只为把 7 天窗口填满
const H0 = new Date(2026, 9, 24, 0, 0, 0); // 本地时间，与 harness 的假时钟同一口径

const isoAt = h => {
    const d = new Date(H0.getTime() + h * 3600000);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + 'T' + p(d.getHours()) + ':00:00';
};

/* ---------------- 虚拟账号 ---------------- */
function makeAccount(profile, rnd) {
    const items = [];
    for (let i = 1; i <= profile.songs; i++) {
        items.push({
            id: 100000 + i,
            life: Math.max(1, Math.floor(400 / Math.pow(i, 1.05))),
            w: 1 / Math.pow(i + 4, profile.topWeight),
        });
    }
    let acc = 0;
    const cum = items.map(it => (acc += it.w));
    const pick = () => {
        const r = rnd() * acc;
        let lo = 0, hi = cum.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cum[mid] < r) lo = mid + 1; else hi = mid;
        }
        return items[lo];
    };

    const log = new Map(); // 小时 -> Map(id -> 次数)
    let through = -1;
    let dayTarget = 0, targetDay = -1;

    // 逐小时推进，保证时间轴严格有序（周榜窗口要靠它算）
    let sessHours = null;
    const ensure = upto => {
        for (let h = through + 1; h <= upto; h++) {
            const d = Math.floor(h / 24);
            if (d !== targetDay) {
                targetDay = d;
                const [lo, hi] = profile.playsPerDay;
                dayTarget = lo + rnd() * (hi - lo);
                sessHours = null;
                if (CLUMP) {
                    // 这一天只在一两个时段听，每段 1~3 小时。开始时刻按通勤/晚间曲线抽
                    const n = 1 + Math.floor(rnd() * 2);
                    sessHours = new Set();
                    for (let s = 0; s < n; s++) {
                        const r = rnd() * DSUM;
                        let acc2 = 0, start = 0;
                        for (let k = 0; k < 24; k++) { acc2 += DIURNAL[k]; if (acc2 >= r) { start = k; break; } }
                        const len = 1 + Math.floor(rnd() * 3);
                        for (let k = 0; k < len; k++) sessHours.add((start + k) % 24);
                    }
                }
            }
            let clicks;
            if (CLUMP) {
                clicks = sessHours.has(h % 24)
                    ? poisson(dayTarget / sessHours.size, rnd)
                    : 0;
            } else {
                clicks = poisson(dayTarget * DIURNAL[h % 24] / DSUM, rnd);
            }
            const m = new Map();
            for (let i = 0; i < clicks; i++) {
                const it = pick();
                const n = 1 + Math.floor(rnd() * 3); // 一次点击可能连放几遍
                m.set(it.id, (m.get(it.id) || 0) + n);
                it.life += n;
            }
            if (m.size) log.set(h, m);
            through = h;
        }
    };

    // from..to 两个小时内听了几次（含两端）
    const sumHours = (from, to) => {
        const s = new Map();
        for (let h = Math.max(0, from); h <= to; h++) {
            const m = log.get(h);
            if (!m) continue;
            for (const [id, n] of m) s.set(id, (s.get(id) || 0) + n);
        }
        return s;
    };

    // 周榜窗口：rolling = 最近 168 小时；day = 最近 7 个自然日（含今天）
    const weekWindow = (t, model) => {
        const start = model === 'rolling' ? t - 167 : (t - t % 24) - 144;
        return sumHours(start, t);
    };

    return { items, ensure, sumHours, weekWindow };
}

/* ---------------- 按站点口径生成接口响应 ---------------- */
function apiAt(acct, t, model) {
    const songOf = id => ({ id, name: 'song ' + (id - 100000), artists: [{ name: 'artist' }] });

    const week = [...acct.weekWindow(t, model)]
        .map(([id, cnt]) => ({ id, cnt }))
        .sort((a, b) => b.cnt - a.cnt || a.id - b.id)
        .slice(0, 100);
    const M = week.length ? week[0].cnt : 0;
    const weekData = week.map(r => ({
        song: songOf(r.id),
        score: M ? Math.floor(100 * r.cnt / M) : 0,
        playCount: 0, // 服务端对 type=-1 的周榜次数一律清 0
    }));

    const top = acct.items
        .filter(it => it.life > 0)
        .sort((a, b) => b.life - a.life || a.id - b.id)
        .slice(0, 100);
    const maxLife = top.length ? top[0].life : 0;
    const allData = top.map(it => ({
        song: songOf(it.id),
        score: maxLife ? Math.floor(100 * it.life / maxLife) : 0,
        playCount: it.life,
    }));

    return { weekData, allData, M };
}

/* ---------------- 单账号跑一遍 ---------------- */
function runAccount(profile, seed) {
    const rnd = mulberry32(seed);
    const acct = makeAccount(profile, rnd);
    const store = makeStorage();
    const clock = makeClock(isoAt(0));
    const P = load('{buildDataset, recordDaily, loadStore, shiftDay, dayKey}', {
        localStorage: store,
        Date: clock,
        script: SCRIPT_PATH || undefined,
    });

    const uid = '900001';
    const lastHour = (WARMUP_DAYS + DAYS) * 24;
    const stat = {
        profile: profile.name, seed,
        obs: 0, sameDay: 0, crossDay: 0, exactObs: 0, warm: 0,
        weekRows: 0, weekErrSum: 0, weekErrMax: 0, weekErrAbs: [], exactWrong: 0,
        allWrong: 0, inv: 0, newIds: 0, newIdOver: 0, exactWrongAbs: 0,
        compErrSum: 0, compErrAbs: [], compMissing: 0,
        moved: 0, shrink: 0, totalDrop: 0, badGap: 0,
        exactDrift: 0, exactDriftWrong: 0, exactSameWrong: 0,
        wrongElapsed: [], rightElapsed: [], signedErr: 0, signedRows: 0, exactSpan: [],
        exactRows: [],
        // 按「7 天前那一段到底有没有听」拆开：补偿只在有听的那批行上起作用
        dropPos: 0, dropPosErr: 0, dropPosSigned: 0, dropZero: 0, dropZeroErr: 0,
        supp: 0, suppObs: 0, // 补偿对不上、按「宁可不给数」藏起来的行
        flip: 0, flipComp: 0, // 同一天两次观测之间「没听却变了」的显示行
        leak: 0, // 两张榜里都没有、页面上却还挂着正数的行
        flipBig: 0, // 其中变化幅度 ≥3 次的（量化漂一格是 ±1，成坨滑出才会更大）
    };

    let hour = WARMUP_DAYS * 24 + Math.floor(rnd() * 24); // 随机起始钟点
    let lastObs = null, lastDay = null, baseHour = null, prevIds = null, prevSame = null;
    // 每天实际是哪一小时看的。滚动窗口下补偿项要跟这两天同一钟点才对得上，
    // 同日重访以后一次为准（days[day] 也是后一次覆盖的）。
    const obsHour = {};
    const dbg = [];

    while (hour <= lastHour) {
        acct.ensure(hour);
        clock.set(isoAt(hour));

        const day = Math.floor(hour / 24);
        if (lastDay !== null && day !== lastDay) baseHour = lastObs;
        lastObs = hour;
        lastDay = day;
        obsHour[day] = hour;

        const api = apiAt(acct, hour - LAG, WINDOW);
        const weekDs = P.buildDataset(api, 'weekData');
        const allDs = P.buildDataset(api, 'allData');
        const res = P.recordDaily(uid, weekDs, allDs, acct.items.filter(i => i.life > 0).length);

        stat.obs++;
        if (TRACE) console.log(`  t${hour}(d${day} h${hour % 24}) base=${baseHour} span=${baseHour === null ? '-' : hour - baseHour}h gap=${res.gap} baseGap=${res.baseGap} exact=${res.exact} warm=${!!res.warm}`);
        if (res.gap === 0) stat.sameDay++; else stat.crossDay++;
        if (res.warm) { stat.warm++; hour += nextStep(rnd); continue; }
        if (res.exact) { stat.exactObs++; if (baseHour !== null) stat.exactSpan.push(Math.abs((hour - baseHour) - 24)); }
        if (res.scaleMoved) stat.moved++;
        // 同日重访时悬停用的是 baseGap：要是它退化成 0，文案会写成「跨了 0 天」。
        // 只判「不该是 0」—— 中间漏过一天时 baseGap 本来就是 2
        if (res.gap === 0 && !(res.baseGap >= 1)) stat.badGap++;
        // 同一天里，后一次观测的增量表比前一次少行 —— 页面上有人的 +n 会凭空消失。
        // v3.8.2 起有两种消失是合法的：这首已经滑出周榜（这周 0 次），或者补偿
        // 对不上被主动藏起来。真正的 bug 只剩一种：周榜压根没算出来，补行却没把
        // 上午已经算好的行留下来 —— 那才是最早期整表覆盖的毛病
        if (res.gap === 0 && prevIds) {
            const wkRows = weekDs && weekDs.map ? weekDs.map.size : 0;
            if (wkRows === 0) {
                for (const id of prevIds) {
                    if (id in res.counts) continue;
                    stat.shrink++;
                    stat.totalDrop++;
                }
            }
        }
        prevIds = Object.keys(res.counts || {});
        if (res.uncertain && res.uncertain.size) { stat.supp += res.uncertain.size; stat.suppObs++; }
        // 「补行」越界的硬账：今天这两张榜里都没有这首，页面上却还挂着正数 ——
        // 那只能是同一天重访时从上午那份补回来的旧值。周榜没算出来的那几次不算
        // （那时候补行是设计内的），所以只在周榜确实拿到行时判
        if (res.gap === 0 && !res.scaleMoved && !res.coldWeek && weekDs && weekDs.map.size > 0) {
            for (const [id, n] of Object.entries(res.counts || {})) {
                if (n > 0 && !weekDs.map.has(id) && !allDs.map.has(id)) stat.leak++;
            }
        }

        // 真值：从上一次立基线那次观测到现在，这首歌听了几次
        const truth = baseHour === null ? new Map() : acct.sumHours(baseHour + 1, hour);
        // 补偿项本该是多少：两次观测之间真正滑出窗口的那一段
        const dropTrue = baseHour === null ? new Map() : acct.sumHours(baseHour - 167, hour - 168);
        const todayKey = P.dayKey(new Date());
        const uNow = P.loadStore().users[uid] || {};
        const bc = uNow.base && uNow.base.sc, nc = res.scale;
        const drift = !!(bc && nc && (bc.lo !== nc.lo || bc.hi !== nc.hi));
        const days = P.loadStore().users[uid].days || {};
        const comp = days[P.shiftDay(todayKey, -7)] || {};

        // 同一天两次观测之间，这首歌一次都没再听（真值没动），页面上的数字却变了 ——
        // 用户就是这么发现问题的：28 分钟里 tyhoon 的 +28 自己掉成 +20。变化的来源
        // 只可能是标尺重解或者补偿项，两者都不该在「没听」时改动一个数。
        // 逐行比上一次观测：真值相同而显示不同，记一次 flip
        if (res.gap === 0 && prevSame) {
            for (const [id, n] of Object.entries(res.counts || {})) {
                if (!(id in prevSame.counts)) continue;
                if (prevSame.counts[id] === n) continue;
                if ((truth.get(Number(id)) || 0) !== prevSame.truth[id]) continue; // 真听了，变了正常
                stat.flip++;
                if (Math.abs(prevSame.counts[id] - n) >= 3) stat.flipBig++;
                if ((comp[id] || 0) > 0) stat.flipComp++;
            }
        }
        if (res.gap === 0) {
            const snap = {};
            for (const id of Object.keys(res.counts || {})) snap[id] = truth.get(Number(id)) || 0;
            prevSame = { counts: { ...res.counts }, truth: snap };
        } else {
            prevSame = null; // 跨天了，基线换了一个，不能跟昨天的数比
        }

        for (const [id, n] of Object.entries(res.counts || {})) {
            const t = truth.get(Number(id)) || 0;

            if (res.newIds && res.newIds.has(id)) {
                stat.newIds++;
                stat.newIdOver += Math.max(0, n - t);
                continue;
            }
            if (res.fromAll.has(id)) {
                // 全时间榜真值差分：不论隔多久、标尺怎么变，都应该分毫不差
                if (n !== t) stat.allWrong++;
                continue;
            }

            if (DEBUG_DAY && day === DEBUG_DAY && !res.fromAll.has(id)) {
                dbg.push({ h: hour, id, n, t, c7: comp[id] || 0, drop: dropTrue.get(Number(id)) || 0 });
            }

            stat.weekRows++;
            const err = n - t;
            const drop = dropTrue.get(Number(id)) || 0;
            if (drop > 0) {
                stat.dropPos++;
                stat.dropPosErr += Math.abs(err);
                stat.dropPosSigned += err;
            } else {
                stat.dropZero++;
                stat.dropZeroErr += Math.abs(err);
            }
            stat.weekErrSum += Math.abs(err);
            stat.weekErrMax = Math.max(stat.weekErrMax, Math.abs(err));
            stat.weekErrAbs.push(Math.abs(err));
            if (res.exact) {
                if (drift) stat.exactDrift++;
                stat.signedErr += err; stat.signedRows++;
                const c7h = obsHour[day - 7];
                stat.exactRows.push({
                    align: c7h === undefined ? null : Math.abs(c7h - (hour - 168)),
                    err,
                });
                if (err === 0) stat.rightElapsed.push(Math.abs((hour - baseHour) - 24));
                if (err !== 0) {
                    stat.exactWrong++;
                    stat.exactWrongAbs += Math.abs(err);
                    if (drift) stat.exactDriftWrong++; else stat.exactSameWrong++;
                    stat.wrongElapsed.push(Math.abs((hour - baseHour) - 24));
                }
            }

            if (!(id in comp)) stat.compMissing++;
            else {
                const ce = comp[id] - (dropTrue.get(Number(id)) || 0);
                stat.compErrSum += Math.abs(ce);
                stat.compErrAbs.push(Math.abs(ce));
            }
        }

        hour += nextStep(rnd);
    }

    if (DEBUG_DAY && dbg.length) {
        const bad = dbg.filter(x => x.n !== x.t).sort((a, b) => Math.abs(b.n - b.t) - Math.abs(a.n - a.t));
        const withComp = dbg.filter(x => x.c7 > 0).sort((a, b) => Math.abs(b.c7 - b.drop) - Math.abs(a.c7 - a.drop));
        console.log(`  [debug] 第 ${DEBUG_DAY} 天：${dbg.length} 行，错 ${bad.length} 行，补偿非零 ${withComp.length} 行`);
        for (const x of bad.slice(0, 6)) {
            console.log(`    h${x.h} ${x.id} 算 ${x.n} 真 ${x.t} ｜ 补偿用了 ${x.c7}，该用 ${x.drop}`);
        }
        for (const x of withComp.slice(0, 6)) {
            console.log(`    h${x.h} ${x.id} 算 ${x.n} 真 ${x.t} ｜ 补偿用了 ${x.c7}，该用 ${x.drop}`);
        }
    }

    return stat;
}

function nextStep(rnd) {
    return Math.max(1, Math.round(EVERY * (1 - JITTER + 2 * JITTER * rnd())));
}

/* ---------------- 汇总 ---------------- */
const pctOf = (a, p) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

const all = [];
for (let i = 0; i < ACCOUNTS; i++) {
    all.push(runAccount(PROFILES[i % PROFILES.length], SEED * 1000 + i));
}

let fail = 0;
console.log(`窗口 ${WINDOW}，平均每 ${EVERY} 小时看一次（抖动 ±${Math.round(JITTER * 100)}%），${DAYS} 天`
    + (LAG ? `，记录延迟 ${LAG}h` : '') + (SCRIPT_PATH ? `，脚本 ${SCRIPT_PATH}` : ''));
for (const p of PROFILES) {
    const list = all.filter(s => s.profile === p.name);
    if (!list.length) continue;
    const sum = k => list.reduce((a, s) => a + s[k], 0);
    const errs = list.flatMap(s => s.weekErrAbs);
    const comp = list.flatMap(s => s.compErrAbs);
    const rows = sum('weekRows') || 1;

    console.log(`\n${p.name}`);
    console.log(`  观测 ${sum('obs')} 次（同日重访 ${sum('sameDay')}，跨天 ${sum('crossDay')}，声称精确 ${sum('exactObs')}）`);
    console.log(`  周榜行 ${sum('weekRows')}，平均绝对误差 ${(sum('weekErrSum') / rows).toFixed(2)}`
        + `，中位 ${pctOf(errs, 0.5)}，P90 ${pctOf(errs, 0.9)}，最大 ${Math.max(...list.map(s => s.weekErrMax))}`);
    console.log(`  补偿项本身的误差：平均 ${(sum('compErrSum') / (comp.length || 1)).toFixed(2)}`
        + `，P90 ${pctOf(comp, 0.9)}，最大 ${comp.length ? Math.max(...comp) : 0}`
        + `（${sum('compMissing')} 行没有补偿项）`);
    console.log(`  声称精确却算错 ${sum('exactWrong')} 行（累计偏 ${sum('exactWrongAbs')} 次）；全时间差分错 ${sum('allWrong')} 行`);
    console.log(`    其中标尺数值真的变了 ${sum('exactDriftWrong')}/${sum('exactDrift')} 行，标尺一模一样却错 ${sum('exactSameWrong')} 行`);
    const we = list.flatMap(s => s.wrongElapsed), re = list.flatMap(s => s.rightElapsed);
    const es = list.flatMap(s => s.exactSpan);
    if (es.length) console.log(`    声称精确的间隔偏离 24h：中位 ${pctOf(es, 0.5)}h，P90 ${pctOf(es, 0.9)}h，最大 ${Math.max(...es)}h`);
    // 补偿项的对齐：7 天前那次观测跟「现在减 168 小时」差几小时
    const ab = list.flatMap(s => s.exactRows).filter(x => x.align !== null);
    if (ab.length) {
        const rate = g => {
            const a = ab.filter(g);
            return a.length ? `${a.filter(x => x.err !== 0).length}/${a.length}（${(100 * a.filter(x => x.err !== 0).length / a.length).toFixed(1)}%）` : '-';
        };
        console.log(`    补偿对齐（7 天前那次观测的钟点）：0h ${ab.filter(x => x.align === 0).length} 行，`
            + `≤3h ${ab.filter(x => x.align > 0 && x.align <= 3).length} 行，>3h ${ab.filter(x => x.align > 3).length} 行`);
        console.log(`    错行率：对齐 0h ${rate(x => x.align === 0)}，≤3h ${rate(x => x.align > 0 && x.align <= 3)}，`
            + `>3h ${rate(x => x.align > 3)}`);
        const ae = ab.filter(x => x.err !== 0).map(x => Math.abs(x.err));
        if (ae.length) console.log(`    错行幅度：中位 ${pctOf(ae, 0.5)} 次，P90 ${pctOf(ae, 0.9)} 次，最大 ${Math.max(...ae)} 次`);
    }
    const sr = sum('signedRows') || 1;
    const dp = sum('dropPos'), dz = sum('dropZero');
    if (dp || dz) {
        console.log(`  按 7 天前有没有听拆开：`
            + `有听 ${dp} 行（平均差 ${(sum('dropPosErr') / (dp || 1)).toFixed(2)}，带符号 ${(sum('dropPosSigned') / (dp || 1)).toFixed(2)}），`
            + `没听 ${dz} 行（平均差 ${(sum('dropZeroErr') / (dz || 1)).toFixed(2)}）`);
    }
    if (sum('signedRows')) console.log(`    「精确」行的带符号平均误差 ${(sum('signedErr') / sr).toFixed(3)} 次`);
    if (we.length) console.log(`    错的那些：距 24 小时 ${pctOf(we, 0.5)}h（中位），${pctOf(we, 0.9)}h（P90）`);
    if (re.length) console.log(`    对的那些：距 24 小时 ${pctOf(re, 0.5)}h（中位），${pctOf(re, 0.9)}h（P90）`);
    console.log(`  标尺被判不可比 ${sum('moved')} 次；同日重访时丢了行 ${sum('shrink')} 次（合计少了 ${sum('totalDrop')} 行）`
        + `；跨天数写错 ${sum('badGap')} 次；补行越界 ${sum('leak')} 行`);
    if (sum('newIds')) console.log(`  新进榜 ${sum('newIds')} 行，合计虚高 ${sum('newIdOver')} 次`);
    if (sum('flip')) console.log(`  同一天里「没听却变了」的显示 ${sum('flip')} 行（${sum('flipBig')} 行幅度 ≥3 次，${sum('flipComp')} 行的补偿项非零）`);
    if (sum('supp')) {
        const vis = sum('weekRows') + sum('supp');
        console.log(`  补偿对不上、没出数 ${sum('supp')} 行（占周榜行 ${(100 * sum('supp') / vis).toFixed(1)}%，`
            + `${sum('suppObs')}/${sum('obs')} 次观测里有行被藏起来）`);
    }
    if (VERBOSE && errs.length) console.log(`   · 最大误差来自 seed ${list.reduce((a, s) => (s.weekErrMax > a.weekErrMax ? s : a)).seed}`);
    if (sum('allWrong')) fail = 1; // 真值差分永远不该错
    if (sum('shrink') || sum('badGap')) fail = 1; // 同一天重访不该丢行，跨天数也不该是 0
    if (sum('leak')) fail = 1; // 今天的榜里没有的数，不该还挂在页面上
}

{
    const sum = k => all.reduce((a, s) => a + s[k], 0);
    const rows = sum('weekRows') || 1;
    console.log(`\n合计：观测 ${sum('obs')} 次，周榜行 ${sum('weekRows')}`
        + `，平均绝对误差 ${(sum('weekErrSum') / rows).toFixed(2)}`
        + `，声称精确却算错 ${sum('exactWrong')} 行`);
    if (sum('supp')) {
        const vis = sum('weekRows') + sum('supp');
        console.log(`  另有 ${sum('supp')} 行因补偿对不上没出数（占周榜行 ${(100 * sum('supp') / vis).toFixed(1)}%），`
            + `${sum('suppObs')}/${sum('obs')} 次观测里有行被藏起来`);
    }
}
console.log(fail ? '\n有对不上的地方' : '\n真值差分这条硬账对得上');
process.exit(fail);
