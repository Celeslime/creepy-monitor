// 真实快照回放：2026-11-14 那次「整页增量消失」的现场（uid 已从 fixture 里去掉）。
// 那天榜首从 29 次涨到 36 次，标尺跟着跳，旧逻辑把周榜增量整段丢掉；
// 全时间榜又逐条没动（他听的是榜外歌），于是 100 行全是 0。
// 现在这条快照变成回归语料：改了标尺或差分逻辑，这里必须仍然算出同样的数。
const fs = require('fs');
const path = require('path');
const { load, reporter } = require('./lib/harness');

const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'snapshot-169.json'), 'utf8'));
const P = load('{applyObservation, shiftDay}');
const { ok, done } = reporter();

const TODAY = '2026-11-14';

// 把存储倒回当天第一次观测之前：cur 是昨天那份，days 里删掉今天
const u = {
    cur: JSON.parse(JSON.stringify(snap.base)),
    days: Object.assign({}, snap.days),
};
delete u.days[TODAY];

const res = P.applyObservation(u, TODAY, snap.cur.week, snap.cur.all, snap.cur.sc);

ok(snap.base.sc.lo === 29 && snap.cur.sc.lo === 36, '现场：标尺从 29 跳到 36', [snap.base.sc, snap.cur.sc]);
ok(res.scaleMoved === false, '标尺跳了但不该整段丢', res.scaleMoved);
ok(res.scaleShift === true, '记成「跨尺子相减」', res.scaleShift);
ok(res.exact === false, '跨尺子的这天不算精确', res.exact);
ok(u.dirty === undefined, '不写 dirty，后面 8 天还能回到精确', u.dirty);

const got = Object.keys(res.counts)
    .filter(id => res.counts[id] > 0)
    .map(id => [id, res.counts[id]])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

const want = [
    ['3349977890', 8],
    ['2726071125', 7],
    ['1804847470', 2],
    ['1436117704', 1],
    ['2715165492', 1],
    ['2747376758', 1],
];
ok(JSON.stringify(got) === JSON.stringify(want), '六行角标与当天真实增量一致', { got, want });
ok(got.length === 6 && got.reduce((a, r) => a + r[1], 0) === 20, '合计 6 行 +20 次', got);

// 全时间榜逐条没动：真值差分给出 0，不能被周榜的估算盖掉
ok(res.fromAll.size > 0, '有歌走的是全时间真值差分', [...res.fromAll].slice(0, 5));
ok(res.counts['1947385901'] === undefined || res.counts['1947385901'] === 0,
    '终身次数没动的那首仍为 0（周榜会误判成 +1）', res.counts['1947385901']);

done();
