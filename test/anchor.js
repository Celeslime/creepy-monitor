// 标尺的硬上界：榜首的终身次数（榜首不在全时间榜时用榜尾值）
// 这一组测的是 v3.7.1 修的坑：一把放大的尺子能靠「还能解释榜单」一路传下去
const fs = require('fs');

let src = fs.readFileSync(process.argv[2] || require('./lib/harness').SCRIPT, 'utf8');
src = src.replace('(function () {', 'var API=(function(){');
src = src.replace(/window\.addEventListener\('hashchange'[\s\S]*$/,
  'return {resolveWeek, anchorM, solveScale, pinWeek, fitsScale, shiftDay}; })();');
const P = new Function('localStorage', src + '; return API;')({ getItem: () => null, setItem() {} });

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '\u2713' : '\u2717') + ' ' + label + (cond ? '' : '  ' + JSON.stringify(extra)));
  if (!cond) fail++;
};

const TODAY = '2026-11-12';
const SCORES = [100, 60, 42, 35, 28, 21, 17, 14, 10, 7, 3];

// w0 是榜首（score=100，本周次数 = M），w1.. 依次排下去
function week(scores = SCORES) {
  const map = new Map();
  scores.forEach((s, i) => map.set('w' + i, { score: s, playCount: 0, name: 'w' + i }));
  return { map, scores: scores.slice(), scale: P.solveScale(scores) };
}

// 全时间榜：满 100 条，从 397 降到 56，故意不含 w0
function allList(n = 100, bottom = 56) {
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const c = Math.round(bottom + (397 - bottom) * (n - 1 - i) / Math.max(1, n - 1));
    map.set('a' + i, { score: 0, playCount: c });
  }
  return { map, scores: [], scale: null };
}

// 昨天用的是一把 175 的尺子
function state(weekCounts = { w0: 175, w1: 105, w2: 74, w3: 62, w4: 49 }) {
  return { days: {}, cur: { day: '2026-11-11', week: weekCounts, all: {}, sc: { lo: 175, hi: 175 } } };
}

const MIN = P.solveScale(SCORES).M;

// 1) 榜首不在全时间榜里：缺席 ⇒ 终身 < 榜尾 56，175 必须被否掉
{
  const w = week();
  const a = allList();
  const u = state();
  const an = P.anchorM(u, a, w, TODAY);
  ok(an && an.hi === 56 && an.known === false, '榜满 100 条、榜首缺席时锚出上界 56', an);

  const r = P.resolveWeek(w, a, u, TODAY);
  ok(r.scale.M === MIN && r.scale.M <= 56, '标尺回落到反解最小值，不再沿用 175', [r.scale.M, MIN]);
  ok(r.wk.w0 <= 56, '榜首次数被压到 56 以内', r.wk.w0);
  const over = Object.entries(r.wk).filter(([, c]) => c > 56).map(([id, c]) => id + '=' + c);
  ok(over.length === 0, '没有一首歌的次数超过榜尾（本周 ≤ 终身）', over);
  ok(r.bound === 0, '越界的先验不许再报下界', r.bound);
}

// 2) 榜首在榜里、终身正好 175，且今天反解饱和（榜单里出现 score=0，
//    说明 M>100 却定不出准确值）：只能靠沿用的旧尺子，别误杀
{
  const w = week([100, 0]);
  const a = allList();
  a.map.set('w0', { score: 100, playCount: 175 });
  const u = state();
  const an = P.anchorM(u, a, w, TODAY);
  ok(an && an.hi === 175 && an.known === true, '榜首在榜里时用它的终身次数当上界', an);
  ok(P.solveScale([100, 0]).M >= 96, '这组分数反解饱和，格点认不出次数', P.solveScale([100, 0]).M);
  const r = P.resolveWeek(w, a, u, TODAY);
  ok(r.scale.M === 175, '反解饱和时沿用旧尺子', r.scale.M);
  ok(r.wk.w0 === 175, '榜首次数没被误压', r.wk.w0);
}

// 2b) 反解能定住标尺时，旧值也自洽（56 ≤ 上界 56）也不许沿用 ——
//     上一把尺子错了就再也纠不回来，56 那个坑就是这么来的
{
  const w = week();
  const a = allList();
  const u = { days: {}, cur: { day: TODAY, week: { w0: 56 }, all: {}, sc: { lo: 56, hi: 56 } } };
  const r = P.resolveWeek(w, a, u, TODAY);
  ok(r.scale.M === MIN, '旧值 56 也自洽，但反解更硬：换成反解最小值', [r.scale.M, MIN]);
  ok(r.wk.w0 === MIN && MIN <= 56, '榜首次数回到反解值，不被 56 锁住', r.wk.w0);
}

// 3) 榜首在榜里但终身只有 90：175 越界，必须换成小的
{
  const w = week();
  const a = allList();
  a.map.set('w0', { score: 100, playCount: 90 });
  const u = state();
  const r = P.resolveWeek(w, a, u, TODAY);
  ok(r.scale.M <= 90, '标尺不超过榜首的终身次数', r.scale.M);
  ok(r.wk.w0 <= 90, '榜首次数不超过终身次数', r.wk.w0);
}

// 4) 榜不满 100 条：缺席说明不了什么，不能拿它当上界
{
  const w = week([100, 0]);
  const a = allList(50, 30);
  const u = state();
  const an = P.anchorM(u, a, w, TODAY);
  ok(an === null, '榜不满员时锚不出来，不硬套上界', an);
  const r = P.resolveWeek(w, a, u, TODAY);
  ok(r.scale.M === 175, '没有上界、反解又饱和时沿用旧尺子（不引入新行为）', r.scale.M);
}

// 5) 先验推出的下界越过上界：整条先验链作废，不 pin
{
  const w = week();
  const a = allList();
  const u = state();
  const pin = P.pinWeek(u, w, TODAY, 28, 56);
  ok(pin === null, '下界 967 越过上界 56，pinWeek 直接放弃', pin);
}

// 6) 反解已经给出小于饱和线的标尺：直接用，锚定（days 那一串历史估算）不许顶它
{
  const w = week([100, 50, 20]);
  const a = allList();
  a.map.set('w0', { score: 100, playCount: 40 });
  const u = { days: {}, cur: { day: '2026-11-11', week: {}, all: {}, sc: { lo: 39, hi: 39 } } };
  for (const [k, n] of [6, 5, 5, 5, 5, 6, 5].entries()) u.days[P.shiftDay(TODAY, -k)] = { w0: n };
  const an = P.anchorM(u, a, w, TODAY);
  ok(an && an.lo === 37 && an.hi === 40, '锚定区间 37~40（够窄，会被采信）', an);
  ok(P.solveScale([100, 50, 20]).M === 10, '反解给 10，远小于饱和线', P.solveScale([100, 50, 20]));
  const r = P.resolveWeek(w, a, u, TODAY);
  ok(r.scale.M === 10, '反解可用时直接用反解，不被锚定顶到 38', r.scale.M);
}

console.log(fail ? `\n${fail} 条失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
