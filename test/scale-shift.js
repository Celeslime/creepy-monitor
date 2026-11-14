// 标尺跳变那天还该不该算增量：两点都是精确反解就能相减，宽区间才整段跳过
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

const TODAY = '2026-11-14';
const BASE = '2026-11-13';
const D7 = P.shiftDay(TODAY, -7);

function run(opt) {
  const u = {
    cur: { day: opt.baseDay || BASE, week: opt.baseWeek, all: opt.baseAll || {}, sc: opt.baseSc },
    days: { [D7]: opt.comp || {} },
  };
  if (opt.base) u.base = opt.base;
  const res = P.applyObservation(u, TODAY, opt.weekNow, opt.allNow || {}, opt.sc);
  return { u, res };
}

// 1) 169 今天的样子：榜首从 29 次涨到 36 次，标尺跟着跳，但两天都是精确反解
let { u, res } = run({
  baseWeek: { a: 29, b: 9 },
  weekNow: { a: 36, b: 10 },
  baseSc: { lo: 29, hi: 29 },
  sc: { lo: 36, hi: 36 },
});
ok(res && res.counts.a === 7, '标尺 29→36 仍照常相减，榜首 +7', res && res.counts.a);
ok(res && res.counts.b === 1, '同一天另一首 +1', res && res.counts.b);
ok(res && res.scaleShift === true, '标记成跨尺子相减', res && res.scaleShift);
ok(res && res.scaleMoved === false, '不算「标尺变了就整段丢」', res && res.scaleMoved);
ok(res && res.exact === false, '跨尺子的这天不算精确', res && res.exact);
ok(u.dirty === undefined, '不写 dirty，后面 8 天还该是精确的', u.dirty);

// 2) 昨天那把尺子只锁在区间里（lo≠hi）：次数本身不唯一，不能相减
({ u, res } = run({
  baseWeek: { a: 100, b: 20 },
  weekNow: { a: 36, b: 10 },
  baseSc: { lo: 100, hi: 160 },
  sc: { lo: 36, hi: 36 },
}));
ok(res && res.counts.a === undefined, '昨天是宽区间时整段跳过，不给周榜增量', res && res.counts);
ok(res && res.scaleMoved === true, '这种天才算标尺变了', res && res.scaleMoved);
ok(u.dirty === TODAY, '宽区间跳过的那天要标 dirty', u.dirty);

// 3) 今天是宽区间（饱和靠先验锁住）：同理跳过
({ u, res } = run({
  baseWeek: { a: 40 },
  weekNow: { a: 45 },
  baseSc: { lo: 40, hi: 40 },
  sc: { lo: 60, hi: 90 },
}));
ok(res && res.counts.a === undefined, '今天是宽区间时也跳过', res && res.counts);

// 4) 标尺没变（都在 5% 容差内）：不标跨尺子，也不影响精确性
({ u, res } = run({
  baseWeek: { a: 29 },
  weekNow: { a: 30 },
  baseSc: { lo: 29, hi: 29 },
  sc: { lo: 30, hi: 30 },
}));
ok(res && res.counts.a === 1, '29→30 在容差内照常 +1', res && res.counts.a);
ok(res && res.scaleShift === false, '容差内不算跨尺子', res && res.scaleShift);

// 5) 旧存储没有 sc：保守起见仍按「标尺变了就跳过」走
({ u, res } = run({
  baseWeek: { a: 29 },
  weekNow: { a: 36 },
  baseSc: undefined,
  sc: { lo: 36, hi: 36 },
}));
ok(res && res.counts.a === undefined, '旧存储没有 sc 时不冒进', res && res.counts);
ok(res && res.scaleMoved === true, '旧存储按标尺变了处理', res && res.scaleMoved);

// 6) 全时间榜有真值的歌不受标尺影响，仍然走真值差分
({ u, res } = run({
  baseWeek: { a: 29 },
  weekNow: { a: 36 },
  baseAll: { a: 500 },
  allNow: { a: 500 },
  baseSc: { lo: 29, hi: 29 },
  sc: { lo: 36, hi: 36 },
}));
ok(res && res.counts.a === 0, '全时间榜两边都在且没动，真值差分给 0', res && res.counts.a);
ok(res && res.fromAll.has('a'), '这首归到真值来源', res && [...res.fromAll]);

// 7) 同一天重访：base 还是昨天，快照已是今天的，标尺不变，不该算跨尺子
({ u, res } = run({
  baseDay: TODAY,
  baseWeek: { a: 36 },
  weekNow: { a: 36 },
  baseSc: { lo: 36, hi: 36 },
  sc: { lo: 36, hi: 36 },
  base: { day: BASE, week: { a: 36 }, all: {}, sc: { lo: 36, hi: 36 } },
}));
ok(res && res.scaleShift === false, '同日重访不算跨尺子', res && res.scaleShift);
ok(res && res.counts.a === 0, '同日重访 36-36=0', res && res.counts.a);

console.log(fail ? '\n' + fail + ' 条失败' : '\n全部通过');
process.exit(fail ? 1 : 0);
