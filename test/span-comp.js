// 补偿项的跨度闸门（v3.8.2）。
//
// 补偿项 `days[today-7]` 是「那一格当时跨了多久」的量，不是「一整天」的量。
// 一天看好几次的人，零点后第一次刷新的跨度可能只有十几分钟，按整天补等于把
// 7 天前那一整天听的全搬过来（真实数据里 typhoon 就这样冒出 +28）。
// 现在的规则：跨度对不上就不出数，c7=0 的行除外（没听过就滑不出东西）。
//
// 约定：a 只出现在全时间榜（真值差分），b 只出现在周榜（反解差分）。
const { load, makeStorage, makeClock, reporter } = require('./lib/harness');

const clock = makeClock('2026-10-24T22:00:00');
const P = load('{applyObservation}', { localStorage: makeStorage(), Date: clock });
const r = reporter();

const SC = { lo: 20, hi: 20 };

// 昨天 22:00 建基线，7 天前（10-18）那格 b 听了 28 次
function setup(comp) {
    clock.set('2026-10-24T22:00:00');
    const u = { days: { '2026-10-18': comp || { b: 28 } } };
    P.applyObservation(u, '2026-10-24', { a: 10, b: 7 }, { a: 100 }, SC);
    return u;
}

// 1) 跨度 8 小时、7 天前听过这首：不给数，也不落盘
{
    const u = setup();
    clock.set('2026-10-25T06:00:00');
    const res = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(res.compSpanOk === false, '跨度 8 小时对不上整天的补偿', res.compSpanOk);
    r.ok(res.uncertain.has('b'), '7 天前听过的那行被标成「说不出」', [...res.uncertain].join(','));
    r.ok(!('b' in res.counts), '这行干脆没有数字，不是给一个 +28', res.counts.b);
    r.ok(res.counts.a === 1, '全时间榜真值差分不受影响，照给', res.counts.a);
    r.ok(u.bad['2026-10-25'] === 1, '这一格标记为「缺补偿」，7 天后不能再当补偿用', u.bad['2026-10-25']);
    r.ok(u.spans['2026-10-25'] === 8, '记下这格实际跨了 8 小时', u.spans['2026-10-25']);
}

// 2) 跨度正好 24 小时：照常补
{
    const u = setup({ b: 5 });
    clock.set('2026-10-25T22:00:00');
    const res = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(res.compSpanOk === true, '跨度 24 小时，补偿可用', res.compSpanOk);
    r.ok(res.counts.b === 7, '9-7+5，滑出的 5 次要加回来', res.counts.b);
    r.ok(res.uncertain.size === 0, '没有行被藏起来', res.uncertain.size);
    r.ok(!(u.bad && u.bad['2026-10-25']), '这一格不标 dirty 补偿', u.bad && u.bad['2026-10-25']);
}

// 3) 跨度对不上，但 7 天前根本没听这首：0 乘多少都是 0，照给
{
    const u = setup({ x: 5 });
    clock.set('2026-10-25T06:00:00');
    const res = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(res.compSpanOk === false, '补偿仍然不可用', res.compSpanOk);
    r.ok(res.counts.b === 2, '这首 7 天前没听过，滑出量必然是 0，增量照给', res.counts.b);
    r.ok(!res.uncertain.has('b'), '它不该被藏', [...res.uncertain].join(','));
}

// 4) 7 天前那格缺过行：不在表里的，说不清是「没听」还是「当时没算出来」
{
    const u = setup({});
    u.bad = { '2026-10-18': 1 };
    clock.set('2026-10-25T22:00:00');
    const res = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(res.compSpanOk === true, '宽度本身是对的', res.compSpanOk);
    r.ok(res.uncertain.has('b'), '可它不在那一格里，不能说它是 0', [...res.uncertain].join(','));
}

// 4b) 7 天前那格缺过行，但这首恰好在里面：值本身是对的，照用
{
    const u = setup({ b: 5 });
    u.bad = { '2026-10-18': 1 };
    clock.set('2026-10-25T22:00:00');
    const res = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(res.counts.b === 7, '在表里就是算过的值，照样 9-7+5', res.counts.b);
    r.ok(!res.uncertain.has('b'), '不藏它', [...res.uncertain].join(','));
}

// 5) 漏了一天：跨度 48 小时，一天的补偿对不上两天的滑出
{
    clock.set('2026-10-23T22:00:00');
    const u = { days: { '2026-10-18': { b: 5 } } };
    P.applyObservation(u, '2026-10-23', { a: 10, b: 7 }, { a: 100 }, SC);
    clock.set('2026-10-25T22:00:00');
    const res = P.applyObservation(u, '2026-10-25', { a: 12, b: 9 }, { a: 102 }, SC);
    r.ok(res.gap === 2, '中间漏了一天', res.gap);
    r.ok(res.spanH > 40, '这次跨了 48 小时', res.spanH);
    r.ok(res.uncertain.has('b'), '补偿只有一天的量，对不上就藏起来', [...res.uncertain].join(','));
    r.ok(res.counts.a === 2, '全时间那半是真值差分，照给', res.counts.a);
}

// 6) 旧存储（没有 spans）：按「那格是一整天」算，跨度不对照样拦
{
    clock.set('2026-10-24T22:00:00');
    const u = { days: { '2026-10-18': { b: 28 } } };
    P.applyObservation(u, '2026-10-24', { a: 10, b: 7 }, { a: 100 }, SC);
    clock.set('2026-10-25T09:00:00');
    const res = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(res.compSpan === 24, '没有跨度记录时按 24 小时算', res.compSpan);
    r.ok(res.uncertain.has('b'), '11 小时也拦得住', [...res.uncertain].join(','));
}

// 7) 同一天晚上刷到跨度 24 小时：上午藏起来的那行会自己回来
{
    const u = setup({ b: 5 });
    clock.set('2026-10-25T06:00:00');
    const morning = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(morning.uncertain.has('b'), '早上先藏起来', [...morning.uncertain].join(','));

    clock.set('2026-10-25T22:00:00');
    const night = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(night.counts.b === 7, '到晚上跨度够了，这行有数了', night.counts.b);
    r.ok(night.uncertain.size === 0, '也不再藏', night.uncertain.size);
    r.ok(u.spans['2026-10-25'] === 24, '格子里的跨度跟着更新到 24 小时', u.spans['2026-10-25']);
    r.ok(!(u.bad && u.bad['2026-10-25']), '缺补偿的标记也撤了', u.bad && u.bad['2026-10-25']);
}

// 8) 跨度记录跟着 days 一起裁掉，不让 localStorage 长胖
{
    const u = setup();
    u.spans = { '2026-10-01': 24, '2026-10-18': 24 };
    u.bad = { '2026-10-01': 1 };
    clock.set('2026-10-25T22:00:00');
    P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(!('2026-10-01' in u.spans), '8 天前的跨度删掉', Object.keys(u.spans).join(','));
    r.ok(!('2026-10-01' in u.bad), '8 天前的缺补偿标记也删掉', Object.keys(u.bad).join(','));
    r.ok('2026-10-18' in u.spans, '今天的补偿那格还在', Object.keys(u.spans).join(','));
}

// 9) 同一天第二次观测、周榜算出来了：不拿上午的旧行补
//
// 补行原本是为了「后一次整段没算出周榜」，可它没有前提就会干两件坏事：把闸门
// 刚藏起来的行补回来（等于闸门白装），以及把已经滑出榜单的歌挂在那儿不走
// （周榜里没有 = 这周 0 次）。真实快照里两个都撞到了。
{
    const u = setup({ b: 5 });
    clock.set('2026-10-25T06:00:00');
    P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    u.days['2026-10-25'].b = 4; // 上午那行（闸门装上之前算出来的）

    clock.set('2026-10-25T09:00:00');
    const res = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(res.uncertain.has('b'), '跨度还是对不上，这行仍然说不出', [...res.uncertain].join(','));
    r.ok(!('b' in res.counts), '周榜算出来了，就不拿上午的旧值把它补回来', res.counts.b);
}
{
    const u = setup({ b: 5 });
    clock.set('2026-10-25T22:00:00');
    const morn = P.applyObservation(u, '2026-10-25', { a: 11, b: 9 }, { a: 101 }, SC);
    r.ok(morn.counts.b === 7, '上午算出 b 听了 7 次', morn.counts.b);

    clock.set('2026-10-25T23:00:00');
    const later = P.applyObservation(u, '2026-10-25', { a: 12, c: 9 }, { a: 102 }, SC);
    r.ok(!('b' in later.counts), '下午 b 已滑出周榜（这周 0 次），不该还挂着 7', later.counts.b);
    r.ok(later.counts.c === 9, '新进榜的歌照旧给上限估计', later.counts.c);
}

r.done();
