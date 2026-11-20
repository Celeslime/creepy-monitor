// 同一天看好几次的时序行为。日粒度仿真（sim.js）看不到这一类，因为那边
// 一天只观测一次、钟点固定。这里的每一条都对应 sim-hourly.js 撞出来的现象。
//
// 约定：a 只出现在全时间榜（真值差分），b 只出现在周榜（反解差分），
// 这样两类来源各自可查。
const { load, makeStorage, makeClock, reporter } = require('./lib/harness');

const clock = makeClock('2026-10-24T22:00:00');
const P = load('{applyObservation}', { localStorage: makeStorage(), Date: clock });
const r = reporter();

const SC = { lo: 20, hi: 20 };

// 昨天 22:00 观测过一次，7 天前那天的增量也在手
function setup(prevTime, prevWeek) {
    clock.set(prevTime);
    const u = { days: { '2026-10-18': { a: 3, b: 2 } } };
    P.applyObservation(u, '2026-10-24', prevWeek || { a: 10, b: 7 }, { a: 100 }, SC);
    return u;
}

// 1) 同一天第二个观测点，基线正好是昨天的同一钟点：该算精确
{
    const u = setup('2026-10-24T22:00:00');
    clock.set('2026-10-25T10:00:00');
    const morning = P.applyObservation(u, '2026-10-25', { a: 11, b: 7 }, { a: 101 }, SC);
    r.ok(morning.gap === 1, '早上那次跨了一天', morning.gap);
    r.ok(morning.exact === false, '但只隔 12 小时，不声称精确', morning.exact);

    clock.set('2026-10-25T22:00:00');
    const night = P.applyObservation(u, '2026-10-25', { a: 12, b: 7 }, { a: 102 }, SC);
    r.ok(night.gap === 0, '晚上那次是同一天重访', night.gap);
    r.ok(night.baseGap === 1, '但它离基线还是跨了一天，悬停不会写「0 天」', night.baseGap);
    r.ok(night.exact === true, '相隔整 24 小时，该算精确', night.exact);
    r.ok(night.counts.a === 2, '全时间真值差分是 2', night.counts.a);
}

// 2) 只隔 20 分钟跨了零点：日历天翻页但补偿项是一整天的量
{
    const u = setup('2026-10-24T23:50:00');
    clock.set('2026-10-25T00:10:00');
    const res = P.applyObservation(u, '2026-10-25', { a: 10, b: 7 }, { a: 101 }, SC);
    r.ok(res.gap === 1, '日历天确实翻了一页', res.gap);
    r.ok(res.exact === false, '只过了 20 分钟，不能按一整天补偿', res.exact);
}

// 3) 同一天第二次没算出周榜：已经算好的行不能被抹掉
{
    const u = setup('2026-10-24T22:00:00');
    clock.set('2026-10-25T22:00:00');
    // b 昨天本周是 7 次，7 天前那 2 次今天滑出窗口，所以今天涨了 9-7+2=4 次
    const first = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(first.counts.b === 4, '晚上那次数出 b 涨了 4 次（含滑窗补偿）', first.counts.b);

    clock.set('2026-10-25T23:00:00');
    const second = P.applyObservation(u, '2026-10-25', {}, { a: 103 }, null);
    r.ok(second.counts.b === 4, '一小时后周榜整段没算出来，前面那行还在', second.counts.b);
    r.ok(u.days['2026-10-25'].b === 4, '落盘的当日增量也没丢', u.days['2026-10-25'].b);
    r.ok(second.counts.a === 3, '全时间那半照常更新成 3', second.counts.a);
}

// 4) 同一天第二次算得更小：以新的为准，不取大值 —— 旧值可能是量化出来的假高
{
    const u = setup('2026-10-24T22:00:00');
    clock.set('2026-10-25T22:00:00');
    P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    clock.set('2026-10-25T23:00:00');
    const second = P.applyObservation(u, '2026-10-25', { a: 11, b: 8 }, { a: 101 }, SC);
    r.ok(second.counts.b === 3, '后一次算出 3 次，以它为准（不取旧的 4）', second.counts.b);
}

// 5) 旧存储没有时间戳：退回只看日历天，不能整页哑掉
{
    clock.set('2026-10-24T22:00:00');
    const u = { days: { '2026-10-18': { a: 3 } } };
    P.applyObservation(u, '2026-10-24', { a: 10 }, { a: 100 }, SC);
    delete u.cur.t; // 模拟 3.8.0 之前存下来的快照
    clock.set('2026-10-25T09:00:00');
    const res = P.applyObservation(u, '2026-10-25', { a: 11 }, { a: 101 }, SC);
    r.ok(res.exact === true, '没有时间戳时按日历天判断，和旧版一致', res.exact);
}

r.done();
