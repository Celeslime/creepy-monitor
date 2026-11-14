// 测这次重构：resolveWeek 的决策结果，以及 sig 指纹能否发现「注入被重画冲掉」
const fs = require('fs');
const { JSDOM } = require('jsdom');

let src = fs.readFileSync(require('./lib/harness').SCRIPT, 'utf8');
src = src.replace('(function () {', 'var API=(function(){');
src = src.replace(/window\.addEventListener\('hashchange'[\s\S]*$/,
  'return {resolveWeek, sigOf, solveScale, shiftDay}; })();');
const P = new Function(src + '; return API;')();

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '\u2713' : '\u2717') + ' ' + label + (cond ? '' : '  ' + JSON.stringify(extra)));
  if (!cond) fail++;
};

const TODAY = '2026-11-05';

// 造一份能反解出 M 的周榜：次数 1..M，score 用站点公式
function freeWeek(M) {
  const map = new Map();
  const scores = [];
  for (let i = 1; i <= M; i++) {
    const s = Math.floor(100 * i / M);
    scores.push(s);
    map.set('s' + i, { score: s, playCount: 0, name: 'n' + i });
  }
  return { map, scores, scale: P.solveScale(scores) };
}

// 1) 不饱和：格点反解给出唯一标尺，逐首次数就是它的名次
const w1 = freeWeek(49);
const keep = w1.scale;
const r1 = P.resolveWeek(w1, null, { days: {} }, TODAY);
ok(r1.scale.M === 49, '反解 49 次榜，标尺解出 49', r1.scale.M);
ok(r1.sc && r1.sc.lo === 49 && r1.sc.hi === 49, '当天标尺记成 49~49', r1.sc);
ok(r1.wk.s49 === 49 && r1.wk.s1 === 1, '第 1 和第 49 名的次数都还原', [r1.wk.s1, r1.wk.s49]);
ok(r1.width === 0 && r1.bound === 0, '不饱和时没有误差半径和下界', [r1.width, r1.bound]);
ok(w1.scale === keep && !('pin' in w1.scale), '没改传进来的数据集对象', Object.keys(w1.scale));

// 2) 饱和但有锚：榜首终身 112 次，最近 7 天累加 110 次
const wk2 = {
  map: new Map([['top', { score: 100, playCount: 0, name: 'T' }]]),
  scores: [100],
  scale: null,
};
const all2 = { map: new Map([['top', { score: 100, playCount: 112, name: 'T' }]]) };
const u2 = { days: { [TODAY]: { top: 60 }, [P.shiftDay(TODAY, -1)]: { top: 50 } } };
const r2 = P.resolveWeek(wk2, all2, u2, TODAY);
ok(r2.sc && r2.sc.lo === 110 && r2.sc.hi === 112, '锚定把标尺夹进 110~112', r2.sc);
ok(!!r2.scale.anchor && r2.scale.M >= 110 && r2.scale.M <= 112, '锚定后的 M 落在区间内', r2.scale);
ok(r2.wk.top === r2.scale.M, '榜首的次数就是 M 本身', [r2.wk.top, r2.scale.M]);
// width 是「次数的误差半径」。锚定区间 110~112 宽 2，次数就有 ±1 的不确定，
// 这正是标成 1 而不是 0 的原因（v3.8 之前这里写死 0，等于声称比证据更准）
ok(r2.width === 1, '锚定区间宽 2，误差半径记作 1', r2.width);

// 3) 没有周榜数据：不该崩，也不该给出标尺
const r3 = P.resolveWeek({ map: new Map(), scores: [], scale: null }, null, { days: {} }, TODAY);
ok(r3.wk === null && r3.sc === null, '空周榜不给次数也不给标尺', r3);

// 4) sig 指纹：列表被重画回原样时，前三个特征一致，只有注入痕迹能识别
const HTML_PAINTED = `<ul>
  <li><span data-res-id="111"></span><div class="tops"><span class="bg" style="width:100%"></span><span class="times f-ff2 tm-times">49次</span></div></li>
  <li><span data-res-id="222"></span><div class="tops"><span class="bg" style="width:50%"></span></div></li>
</ul>`;
const HTML_BARE = `<ul>
  <li><span data-res-id="111"></span><div class="tops"><span class="bg" style="width:100%"></span></div></li>
  <li><span data-res-id="222"></span><div class="tops"><span class="bg" style="width:50%"></span></div></li>
</ul>`;

const dom = new JSDOM('<!doctype html><div id="m-record"></div>');
const doc = dom.window.document;
doc.querySelector('#m-record').innerHTML = HTML_PAINTED;
const painted = P.sigOf(doc, '42');
ok(P.sigOf(doc, '42') === painted, 'DOM 没动，指纹不变');

doc.querySelector('#m-record').innerHTML = HTML_BARE;
const bare = P.sigOf(doc, '42');
ok(bare !== painted, '重画后指纹变了，会重新注入');
ok(bare.indexOf('|0|') > 0 && painted.indexOf('|1|') > 0, '差别就在注入标记那一位', [painted, bare]);

doc.querySelector('#m-record').innerHTML = HTML_PAINTED;
ok(P.sigOf(doc, '42') === painted, '重画回同一版，指纹也回到同一值');

console.log(fail ? `\n${fail} 条失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
