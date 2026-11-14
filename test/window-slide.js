// 测滑窗补偿的一致性：昨天的累计不可能小于 7 天前那天的增量
const fs = require('fs');

let src = fs.readFileSync(require('./lib/harness').SCRIPT, 'utf8');
src = src.replace('(function () {', 'var API=(function(){');
src = src.replace(/window\.addEventListener\('hashchange'[\s\S]*$/,
  'return {applyObservation, shiftDay}; })();');
const P = new Function(src + '; return API;')();

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '\u2713' : '\u2717') + ' ' + label + (cond ? '' : '  ' + JSON.stringify(extra)));
  if (!cond) fail++;
};

const TODAY = '2026-11-06';
const D7 = P.shiftDay(TODAY, -7);

function run(baseWeek, weekNow, comp) {
  const u = {
    cur: { day: '2026-11-05', week: baseWeek, all: {} },
    days: comp ? { [D7]: comp } : {},
  };
  const res = P.applyObservation(u, TODAY, weekNow, {}, null);
  return res ? res.counts : null;
}

// 1) 正常：昨天 5，今天 7，7 天前 2 → 今天听了 4
let c = run({ a: 5 }, { a: 7 }, { a: 2 });
ok(c && c.a === 4, '正常差分 7-5+2=4', c);

// 2) 反解偏小：昨天记 2，但 7 天前那天就有 3 次（昨天窗口含那天，矛盾）
//    旧算法 2-2+3=3，会算出「本周 2 次、今日 +3」
c = run({ a: 2 }, { a: 2 }, { a: 3 });
ok(c && c.a === 2, '矛盾时钳到本周累计 2', c);

// 3) 同样的矛盾，今天次数涨了：昨天 2、今天 6、7 天前 3 → 6-3+3=6
c = run({ a: 2 }, { a: 6 }, { a: 3 });
ok(c && c.a === 6, '矛盾时用 7 天前当昨天，6-3+3=6', c);

// 4) 不误伤：昨天的累计远大于补偿项
c = run({ a: 10 }, { a: 12 }, { a: 4 });
ok(c && c.a === 6, '昨天 10 大于补偿 4 时照常 12-10+4=6', c);

// 5) 没有补偿项（7 天前那天没记录）：只做普通差分
c = run({ a: 5 }, { a: 7 }, null);
ok(c && c.a === 2, '无补偿项时退化为 7-5=2', c);

// 6) 增量不会超过本周累计：任何情况下 counts <= today
const cases = [
  [{ a: 1 }, { a: 1 }, { a: 9 }],
  [{ a: 3 }, { a: 4 }, { a: 20 }],
  [{ a: 1 }, { a: 8 }, { a: 7 }],
];
let overflow = null;
for (const [b, w, k] of cases) {
  const got = run(b, w, k);
  if (got.a > w.a) overflow = { b, w, k, got };
}
ok(!overflow, '今日增量不超过本周累计', overflow);

// 7) 全时间榜有真值时走它，不受周榜矛盾影响
{
  const u = {
    cur: { day: '2026-11-05', week: { a: 2 }, all: { a: 100 } },
    days: { [D7]: { a: 3 } },
  };
  const res = P.applyObservation(u, TODAY, { a: 2 }, { a: 105 }, null);
  ok(res && res.counts.a === 5, '全时间真值 105-100=5 优先', res && res.counts.a);
}

console.log(fail ? '\n' + fail + ' 条失败' : '\n全部通过');
process.exit(fail ? 1 : 0);
