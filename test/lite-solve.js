// 完整版和 lite 各抄了一份纯函数（solveScale / solve），迟早会漂。
// 这里喂同一批榜单，要求两边解出的标尺和「附近还有没有别的解释」判断完全一致。
const fs = require('fs');
const path = require('path');
const { SCRIPT, load, reporter } = require('./lib/harness');

const LITE = path.join(path.dirname(SCRIPT), 'creepy-monitor-lite.user.js');
let src = fs.readFileSync(LITE, 'utf8');
src = src.replace('(function () {', 'var API=(function(){');
src = src.replace(/let busy = false;[\s\S]*$/, 'return {solve}; })();');
const L = new Function(src + '; return API;')();

const P = load('{solveScale, nearFit}');
const r = reporter();

// 次数 1..M 全进榜的完整榜单，标尺必然可解，是两版最该对齐的地方
const fullWeek = M => {
    const scores = [];
    for (let i = 1; i <= M; i++) scores.push(Math.floor(100 * i / M));
    return scores;
};

let mDiff = [];
let looseDiff = [];
for (let M = 1; M <= 95; M++) {
    const scores = fullWeek(M);
    const uniq = [...new Set(scores)];
    const a = P.solveScale(scores);
    const b = L.solve(scores);
    if (!a || !b || a.M !== b.M) mDiff.push([M, a && a.M, b && b.M]);
    // 完整版用的是去重后的分数，lite 用原序列，fitsScale 只关心有没有 miss，结果应当一样
    if (b && b.loose !== !!P.nearFit(uniq, a.M)) looseDiff.push([M, !!P.nearFit(uniq, a.M), b.loose]);
}

r.ok(mDiff.length === 0, '完整榜 1~95，两版解出的标尺全部一致', mDiff.slice(0, 3));
r.ok(looseDiff.length === 0, '两版对「附近还有没有别的解」判断一致', looseDiff.slice(0, 3));

// 截断榜（只取 top100）也要对齐：这是真实站点的形态
const cutWeek = M => {
    const scores = [];
    for (let i = M; i >= 1 && scores.length < 100; i--) scores.push(Math.floor(100 * i / M));
    return scores;
};
let cutDiff = [];
for (const M of [40, 60, 80, 90, 100, 120, 200]) {
    const scores = cutWeek(M);
    const uniq = [...new Set(scores)];
    const a = P.solveScale(scores);
    const b = L.solve(scores);
    if (!a || !b || a.M !== b.M) cutDiff.push([M, a && a.M, b && b.M]);
    else if (b.loose !== !!P.nearFit(uniq, a.M)) cutDiff.push([M, 'loose', !!P.nearFit(uniq, a.M), b.loose]);
}
r.ok(cutDiff.length === 0, '截断榜（top100）两版一致', cutDiff);

r.done();
