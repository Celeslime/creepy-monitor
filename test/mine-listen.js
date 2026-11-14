// 「我听了 N 次」的取数路径
// 回归点：3.5.0 把排行请求合并成 type=-1 后，loadMine 复用那份缓存
// （weekData 的 playCount 被服务端清 0），看过自己主页再切到别人主页就静默失效
const fs = require('fs');

let src = fs.readFileSync(process.argv[2] || require('./lib/harness').SCRIPT, 'utf8');
src = src.replace('(function () {', 'var API=(function(){');
src = src.replace(/window\.addEventListener\('hashchange'[\s\S]*$/,
    'return {loadMine, loadData, getMe, CFG, cache, state:() => ({mineMap, mineAt})}; })();');

const calls = [];
const weekTrue = [
    { song: { id: 1, name: 'a' }, score: 100, playCount: 7 },
    { song: { id: 2, name: 'b' }, score: 42, playCount: 3 },
    { song: { id: 3, name: 'c' }, score: 0, playCount: 0 },
];
// type=-1 的 weekData：playCount 一律 0，只有 score 是真的
const weekZero = weekTrue.map(x => ({ song: x.song, score: x.score, playCount: 0 }));

global.fetch = async (url) => {
    calls.push(url);
    if (url.includes('/api/nuser/account/get')) {
        return { ok: true, json: async () => ({ code: 200, account: { id: 111 }, profile: { userId: 111 } }) };
    }
    const type = (url.match(/type=(-?\d+)/) || [])[1];
    const body = type === '-1'
        ? { code: 200, weekData: weekZero, allData: [{ song: { id: 9, name: 'z' }, score: 1, playCount: 400 }] }
        : { code: 200, weekData: weekTrue };
    return { ok: true, json: async () => body };
};

const P = new Function('localStorage', src + '; return API;')({ getItem: () => null, setItem() {} });
P.CFG.MIN_GAP_MS = 0;
P.CFG.CACHE_MS = 5 * 60 * 1000;

let fail = 0;
const ok = (cond, label, extra = '') => {
    console.log((cond ? '\u2713' : '\u2717') + ' ' + label + (cond ? '' : '  ' + JSON.stringify(extra)));
    if (!cond) fail++;
};

(async () => {
    // 先看自己主页：排行走 type=-1，缓存里存下「playCount 全 0」的周榜
    const data = await P.loadData('111');
    ok(data && data.week.map.size === 3, 'type=-1 的周榜进了缓存', data && data.week.map.size);
    ok([...data.week.map.values()].every(x => x.playCount === 0), '缓存里的 playCount 全是 0', [...data.week.map.values()]);
    ok(P.cache.has('111'), '本人 uid 已有缓存条目');

    // 再切到别人主页：loadMine 必须无视这份缓存，自己走 type=1
    calls.length = 0;
    const mine = await P.loadMine();
    ok(calls.some(u => u.includes('type=1')), '「我听了 N 次」发的是 type=1', calls);
    ok(!calls.some(u => u.includes('type=-1')), '没有再打一次 type=-1', calls);
    ok(mine && mine.byId.get('1') === 7 && mine.byId.get('2') === 3, '拿到本人的真实次数', mine && [...mine.byId]);
    ok(mine && !mine.byId.has('3'), 'playCount=0 的歌不进表', mine && [...mine.byId]);

    // 5 分钟内重访不再发请求
    calls.length = 0;
    const again = await P.loadMine();
    ok(again === mine && calls.length === 0, '缓存期内复用 mineMap，不重复请求', calls);

    console.log(fail ? `\n${fail} 条失败` : '\n全部通过');
    process.exit(fail ? 1 : 0);
})();
