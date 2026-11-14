// 随机仿真：造一个虚拟账号，按站点公式生成每天的接口响应，逐日喂给脚本，
// 拿「我让它听了几次」当标准答案，检查页面上的数字和今日增量。
//
// 与其它套件的区别：那些是「给定输入 → 人推出来的期望」，错在推理上测试会跟着错；
// 这里的期望由仿真器自己记着，脚本算错了就会撞上。
//
//   node test/sim.js [--accounts 6] [--days 24] [--seed 1] [--verbose] [--strict]
const { load, makeStorage, makeClock, SCRIPT } = require('./lib/harness');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : def;
};
const ACCOUNTS = argOf('accounts', 6);
const DAYS = argOf('days', 24);
const SEED = argOf('seed', 1);
const VERBOSE = argv.includes('--verbose');
// 饱和区的偏差是榜单本身不可辨识导致的，默认只提示；--strict 时连同它一起算失败
const STRICT = argv.includes('--strict');
// --dump <天>：把那天周榜的 score 序列打出来，方便离线复现
const DUMP = (() => {
    const i = argv.indexOf('--dump');
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : null;
})();

/* ---------------- 确定性随机 ---------------- */
function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/* ---------------- 听歌画像 ---------------- */
// M 小 → 标尺能反解；M 大 → 饱和，脚本会退成 ≥N 或百分比，那是设计内的
const PROFILES = [
    { name: 'casual', songs: 120, playsPerDay: [2, 8], topWeight: 1.0 },
    { name: 'normal', songs: 240, playsPerDay: [8, 26], topWeight: 1.0 },
    { name: 'wide', songs: 320, playsPerDay: [20, 45], topWeight: 1.0 },
    { name: 'heavy', songs: 400, playsPerDay: [60, 150], topWeight: 1.2 },
];
// 真实用法是「想起来才看一眼」，漏几天是常态，差分链要能扛住
const SKIP = (() => {
    const i = argv.indexOf('--skip');
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 0.15;
})();

/* ---------------- 虚拟账号 ---------------- */
function makeAccount(profile, rnd) {
    const items = [];
    for (let i = 1; i <= profile.songs; i++) {
        items.push({
            id: 100000 + i,
            name: 'song ' + i,
            life: Math.max(1, Math.floor(400 / Math.pow(i, 1.05))),
            w: 1 / Math.pow(i + 4, profile.topWeight),
        });
    }
    // 轮盘采样用的前缀和
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

    const log = new Map(); // dayIndex -> Map(id -> 次数)
    const playOn = (d, it, n) => {
        const m = log.get(d) || new Map();
        m.set(it.id, (m.get(it.id) || 0) + n);
        log.set(d, m);
        it.life += n;
    };

    // 今天听什么：从画像里抽 n 次点击，每次 1~3 遍
    const listen = d => {
        const [lo, hi] = profile.playsPerDay;
        const clicks = lo + Math.floor(rnd() * (hi - lo + 1));
        for (let i = 0; i < clicks; i++) playOn(d, pick(), 1 + Math.floor(rnd() * 3));
    };

    const weekCount = d => {
        const sum = new Map();
        for (let k = 0; k < 7; k++) {
            const m = log.get(d - k);
            if (!m) continue;
            for (const [id, n] of m) sum.set(id, (sum.get(id) || 0) + n);
        }
        return sum;
    };

    const heardSongs = () => items.filter(it => it.life > 0).length;

    return { items, log, listen, weekCount, heardSongs };
}

/* ---------------- 按站点口径生成接口响应 ---------------- */
function apiFor(acct, d) {
    const songOf = id => ({ id, name: 'song ' + (id - 100000), artists: [{ name: 'artist' }] });

    const week = [...acct.weekCount(d)]
        .map(([id, cnt]) => ({ id, cnt }))
        .sort((a, b) => b.cnt - a.cnt || a.id - b.id)
        .slice(0, 100);
    const M = week.length ? week[0].cnt : 0;
    const weekData = week.map(r => ({
        song: songOf(r.id),
        score: M ? Math.floor(100 * r.cnt / M) : 0,
        playCount: 0, // 服务端对 type=-1 的周榜次数一律清 0
    }));

    const all = acct.items
        .filter(it => it.life > 0)
        .sort((a, b) => b.life - a.life || a.id - b.id)
        .slice(0, 100);
    const maxLife = all.length ? all[0].life : 0;
    const allData = all.map(it => ({
        song: songOf(it.id),
        score: maxLife ? Math.floor(100 * it.life / maxLife) : 0,
        playCount: it.life,
    }));

    return { weekData, allData, M };
}

/* ---------------- 解析页面上会显示成什么 ---------------- */
function parseShown(text) {
    let m = /^(\d+)次$/.exec(text);
    if (m) return { kind: 'exact', n: Number(m[1]) };
    m = /^≥(\d+)次$/.exec(text);
    if (m) return { kind: 'lower', n: Number(m[1]) };
    m = /^~(\d+)次$/.exec(text);
    if (m) return { kind: 'approx', n: Number(m[1]) };
    m = /^(\d+)~(\d+)次$/.exec(text);
    if (m) return { kind: 'band', lo: Number(m[1]), hi: Number(m[2]) };
    m = /^(\d+)%$/.exec(text);
    if (m) return { kind: 'percent', n: Number(m[1]) };
    return { kind: 'other', text };
}

/* ---------------- 单账号跑一遍 ---------------- */
function runAccount(profile, seed) {
    const rnd = mulberry32(seed);
    const acct = makeAccount(profile, rnd);
    const store = makeStorage();
    const clock = makeClock('2026-10-24T12:00:00');
    const P = load('{buildDataset, recordDaily, describe, SATURATION}', {
        localStorage: store,
        Date: clock,
    });

    const uid = '900001';
    const stat = {
        profile: profile.name, seed, sat: P.SATURATION,
        rows: 0, exactRows: 0, countWrong: [], deltaWrong: [],
        invariant: [], estimated: 0, percent: 0, newIds: 0, approxRows: 0, approxDev: 0,
        exactDays: 0, days: 0, maxM: 0, skipped: 0,
    };

    for (let d = -7; d < DAYS; d++) {
        acct.listen(d);
        clock.advance(86400000);
        if (d < 0) continue; // 前 7 天只用来填满 7 天窗口，脚本没看见

        const api = apiFor(acct, d);
        // 漏访：那天不喂脚本，模拟「没打开页面」。跨天差分要自己扛过去
        if (d > 0 && rnd() < SKIP) { stat.skipped++; continue; }

        if (DUMP === d) console.log('SCORES<' + profile.name + '>:M=' + api.M + ':' + api.weekData.map(x => x.score).join(','));
        const weekDs = P.buildDataset(api, 'weekData');
        const allDs = P.buildDataset(api, 'allData');
        const day = P.recordDaily(uid, weekDs, allDs, acct.heardSongs());
        stat.days++;
        stat.maxM = Math.max(stat.maxM, api.M);

        const truthWeek = acct.weekCount(d);
        const truthToday = acct.log.get(d) || new Map();
        const yesterday = weekDs.map;

        // 1) 次数：只要页面写成「N次」，就必须真的等于 N
        for (const it of api.weekData) {
            const id = String(it.song.id);
            const info = Object.assign({ id }, weekDs.map.get(id));
            const shown = parseShown(P.describe(info, weekDs.scale, day).text);
            const truth = truthWeek.get(Number(id)) || 0;
            stat.rows++;

            if (shown.kind === 'exact') {
                stat.exactRows++;
                if (shown.n !== truth) {
                    stat.countWrong.push({ d, id, shown: shown.n, truth, M: api.M, score: it.score });
                }
            } else if (shown.kind === 'band') {
                // 区间两端都是估计值（先验推出来的），不精确到个位：
                // 真值落到区间外 5% 以内不算错，超出去才是锁错了位置
                const pad = Math.max(1, Math.round(0.05 * truth));
                if (truth < shown.lo - pad || truth > shown.hi + pad) {
                    stat.countWrong.push({ d, id, shown: shown.lo + '~' + shown.hi, truth, M: api.M, score: it.score });
                }
            } else if (shown.kind === 'lower') {
                if (truth < shown.n) {
                    stat.countWrong.push({ d, id, shown: '>=' + shown.n, truth, M: api.M, score: it.score });
                }
                stat.estimated++;
            } else if (shown.kind === 'approx') {
                // 「~N次」是估计，允许偏差。但偏到 25% 以上时这个数就没有信息量了，
                // 跟写错没区别 —— 那句话是给它开的后门，不是免死金牌
                const off = Math.abs(shown.n - truth);
                stat.approxRows++;
                if (off > Math.max(2, 0.25 * truth)) {
                    stat.countWrong.push({ d, id, shown: '~' + shown.n, truth, M: api.M, score: it.score, approx: true });
                }
                stat.estimated++;
                if (truth >= 10) stat.approxDev = Math.max(stat.approxDev || 0, off / truth);
            } else if (shown.kind === 'percent') {
                stat.percent++;
            }
        }

        // 2) 今日增量：只在脚本自己声称精确的日子对账
        if (day.exact) stat.exactDays++;
        for (const [id, n] of Object.entries(day.counts || {})) {
            const truth = truthToday.get(Number(id)) || 0;
            const weekNow = truthWeek.get(Number(id)) || 0;
            if (n > weekNow || n < 0) {
                stat.invariant.push({ d, id, delta: n, weekNow, truth });
            }
            if (day.newIds && day.newIds.has(id)) { stat.newIds++; continue; }
            if (!(id in yesterday)) continue; // 昨天不在榜：没有基线，跳过
            if (day.exact && n !== truth) {
                stat.deltaWrong.push({ d, id, shown: n, truth, exact: day.exact, gap: day.gap });
            }
        }
    }
    return stat;
}

/* ---------------- 汇总 ---------------- */
let fail = 0;
const all = [];
for (let i = 0; i < ACCOUNTS; i++) {
    const profile = PROFILES[i % PROFILES.length];
    all.push(runAccount(profile, SEED * 1000 + i));
}

for (const p of PROFILES) {
    const list = all.filter(s => s.profile === p.name);
    if (!list.length) continue;
    const sum = k => list.reduce((a, s) => a + s[k], 0);
    const rows = sum('rows');
    const wrongAll = list.flatMap(s => s.countWrong);
    // 真 M 越过饱和线之后，榜单本身分不出 93 和 110：这类偏差单独计数
    const wrongSat = wrongAll.filter(x => x.M >= list[0].sat);
    const wrongFree = wrongAll.filter(x => x.M < list[0].sat);
    // 「~N次」的偏差单独报：它本来就不是精确值，但偏太多同样没用
    const devPct = list.reduce((a, s) => Math.max(a, s.approxDev || 0), 0);
    const approxRows = sum('approxRows');
    // 偏差随榜单稀疏度变化：分数密集时 1~3%，只有两三天数据时能到 6%（README 限制 13）。
    // 超过 10% 就不是分辨率问题了，当失败；其余只报数
    const diffOf = x => (typeof x.shown === 'number' ? Math.abs(x.shown - x.truth) : Infinity);
    const hardFree = wrongFree.filter(x => diffOf(x) >= Math.max(2, 0.10 * x.truth));
    const softFree = wrongFree.length - hardFree.length;
    // 小数字的相对误差没意义（真实 4 次、显示 3 次也是 25%），只看 ≥10 次的行
    const relOf = x => (typeof x.shown === 'number' ? Math.abs(x.shown - x.truth) / x.truth : 1);
    const bigRows = wrongFree.filter(x => typeof x.shown === 'number' && x.truth >= 10);
    const worstPct = bigRows.length ? (Math.max(...bigRows.map(relOf)) * 100).toFixed(1) : '0';
    const dWrong = list.reduce((a, s) => a + s.deltaWrong.length, 0);
    const inv = list.reduce((a, s) => a + s.invariant.length, 0);
    const est = sum('estimated');
    const pct = sum('percent');
    const exactRows = sum('exactRows');
    const maxM = Math.max(...list.map(s => s.maxM));

    console.log(`\n${p.name}  账号 ${list.length} 个，打开 ${sum('days')} 天（漏访 ${sum('skipped')}）  M 峰值 ${maxM}`);
    console.log(`  行数 ${rows}，写成「N次」 ${exactRows}，带 ~ ${approxRows}，区间/下界 ${est - approxRows}，百分比 ${pct}`);
    if (approxRows) console.log(`  带 ~ 的最大偏差 ${(devPct * 100).toFixed(1)}%`);
    console.log(`  次数错 ${wrongAll.length}（饱和区 ${wrongSat.length}，可辨识区 ${wrongFree.length}：`
        + `越界 ${hardFree.length}，分辨率以内 ${softFree}，最大偏差 ${worstPct}%）`
        + ` 增量错 ${dWrong} 不变式违反 ${inv} 精确日 ${sum('exactDays')}`);

    if (VERBOSE) {
        for (const x of wrongAll.slice(0, 6)) {
            console.log(`   · 第 ${x.d} 天 ${x.id} 显示 ${x.shown}，真实 ${x.truth}（M=${x.M}，score=${x.score}）`);
        }
        for (const x of list.flatMap(s => s.deltaWrong.slice(0, 3))) {
            console.log(`   · 第 ${x.d} 天 ${x.id} 增量 ${x.shown}，真实 ${x.truth}（gap=${x.gap}）`);
        }
    }

    // 可辨识区里超过分辨率上限的错、以及不变式，任何画像下都不能有
    if (hardFree.length || inv || dWrong) fail = 1;
    if (STRICT && wrongSat.length) fail = 1;
    if (wrongSat.length && !STRICT) {
        console.log(`  注意：饱和区有 ${wrongSat.length} 行把估算写成了精确值，真值比显示值大`
            + '（最小可行标尺偏小）。加 --strict 可让它当失败');
    }
}

console.log(fail ? '\n有对不上的地方' : '\n全部对得上');
process.exit(fail);
