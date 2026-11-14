// 反解出「能解释这份榜单的最小标尺」，不等于解出了真实标尺。
// 这一组测 v3.8.0 加的那道判据：M0 之后 10% 以内还有别的标尺也能解释，就不能写次数。
//
// 正例取自仿真的 heavy 画像第 4 天（真值 127，反解 89，逐首差 30%）。
// 反例是完整榜：次数 1..M 全部进榜时，最近的另一个可行标尺至少差 19%。
const { load, reporter } = require('./lib/harness');

const P = load('{solveScale, nearFit, countMapOf, describe, fitsScale, DENSE, AMBIGUOUS}');
const r = reporter();

// 真值 127 的周榜，前 100 首的 score
const REAL127 = [
    100, 69, 58, 48, 44, 42, 41, 37, 25, 25, 21, 20, 17, 15, 15, 15, 15, 14, 14, 14,
    14, 13, 12, 11, 11, 11, 11, 10, 10, 10, 10, 10, 10, 10, 8, 8, 8, 8, 8, 8,
    7, 7, 7, 7, 7, 7, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4,
    4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2,
];

// 次数 1..M 全进榜：最规矩的榜单，反解就是真值
function fullWeek(M) {
    const scores = [];
    for (let i = 1; i <= M; i++) scores.push(Math.floor(100 * i / M));
    return scores;
}

// 1) 真值 127 的榜，反解只能给 89，而且 94 也能解释它
{
    const uniq = [...new Set(REAL127)];
    const s = P.solveScale(REAL127);
    r.ok(s.M === 89, '真值 127 的榜反解出 89', s.M);
    r.ok(P.fitsScale(uniq, 127), '127 当然也能解释这份榜单（证明 89 只是个下界）', null);
    r.ok(P.nearFit(uniq, 89) === 94, '89 往后 10% 内就找到 94，说明这不是唯一解', P.nearFit(uniq, 89));

    // describe 应该退回百分比：把 89 当次数写出来就是编
    const scale = { M: 89, countOf: P.countMapOf(89), loose: true, why: 'solve' };
    const d = P.describe({ id: '1', score: 100 }, scale, null);
    r.ok(d.text === '100%', '判为不可辨识时只给占比', d.text);
    r.ok(/89/.test(d.tip), '悬停里仍交代最小可行标尺是多少', d.tip);
}

// 2) 完整榜：附近没有第二种解释，照常写次数
{
    for (const M of [10, 27, 49, 80]) {
        const scores = fullWeek(M);
        const uniq = [...new Set(scores)];
        const s = P.solveScale(scores);
        r.ok(s.M === M, '完整榜 ' + M + ' 反解正确', s.M);
        r.ok(P.nearFit(uniq, s.M) === null || P.nearFit(uniq, s.M) - s.M > s.M * 0.1,
            '完整榜 ' + M + ' 附近没有更近的解', P.nearFit(uniq, s.M));

        const scale = { M: s.M, countOf: s.countOf, loose: false, why: 'solve' };
        const d = P.describe({ id: '1', score: 100 }, scale, null);
        r.ok(d.text === M + '次', '完整榜 ' + M + ' 仍然写次数', d.text);
    }
}

// 3) 两条判据同时生效：格点已经粗到 DENSE 以上时，即使附近没有别的解也不算数
{
    const scale = { M: P.DENSE, countOf: P.countMapOf(P.DENSE), loose: false, why: 'lower' };
    const d = P.describe({ id: '1', score: 100 }, scale, null);
    r.ok(d.text.endsWith('%'), 'M 顶到 DENSE 就不写次数了', d.text);
}

// 4) 锚定过的标尺不受这两条限制：它不是反解猜的，是榜首终身次数夹出来的
{
    const scale = {
        M: 110, countOf: P.countMapOf(110), loose: true, why: 'lock:anchor',
        anchor: { lo: 110, hi: 112 },
    };
    const d = P.describe({ id: '1', score: 100 }, scale, null);
    r.ok(d.text === '110次', '锚定的标尺照常写次数', d.text);
}

r.ok(P.AMBIGUOUS === 0.1 && P.DENSE === 91, '两个常量没被随手改掉', [P.AMBIGUOUS, P.DENSE]);

r.done();
