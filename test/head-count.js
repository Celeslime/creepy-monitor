const fs = require('fs');
const { JSDOM } = require('jsdom');

let src = fs.readFileSync(require('./lib/harness').SCRIPT, 'utf8');
src = src.replace('(function () {', 'var API=(function(){');
src = src.replace(/window\.addEventListener\('hashchange'[\s\S]*$/, 'return {inject, recordHead, parseCount, headCount, renderHead}; })();');
const API = new Function(src + '; return API;')();

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '  ' + extra));
  if (!cond) fail++;
};

// 真实结构，取自页面上复制出来的 #rHeader
const RHEADER = `<div class="u-title u-title-1 f-cb m-record-title" id="rHeader">
<h3><span class="f-ff2 s-fc3">听歌排行</span></h3>
<h4>累积听歌3751首</h4>
<span class="n-iconpoint"><a class="icon" href="javascript:void(0)"></a></span>
<div class="nav f-cb"><span id="songsall">所有时间</span><i></i><span id="songsweek" class="z-sel">最近一周</span></div>
</div>`;

/* ---------- parseCount ---------- */
ok(API.parseCount('累积听歌3751首') === 3751, '原样读出来');
ok(API.parseCount('累积听歌1,234首') === 1234, '千分位逗号');
ok(API.parseCount('累积听歌1.2万首') === 12000, '万为单位');
ok(API.parseCount('累积听歌0首') === 0, '0 不是 null');
ok(API.parseCount('听歌排行') === null, '没有数字返回 null');

/* ---------- recordHead ---------- */
{
  const u = { days: {} };
  ok(API.recordHead(u, '2026-11-06', 3751) === null, '头一天没有增量');
  ok(u.head.base === 3751 && u.head.day === '2026-11-06', '头一天只立基线');

  const same = API.recordHead(u, '2026-11-06', 3758);
  ok(same && same.d === 7, '同日再看：增量相对基线', JSON.stringify(same));

  const back = API.recordHead(u, '2026-11-06', 3751);
  ok(back && back.d === 7, '同日读到更小的值不拽低基线', JSON.stringify(back));

  const next = API.recordHead(u, '2026-11-07', 3760);
  ok(next && next.d === 2 && next.gap === 1, '跨一天：差值 + gap=1', JSON.stringify(next));
  ok(u.head.base === 3758, '基线换成昨天最后一次看到的值');

  const jump = API.recordHead(u, '2026-11-10', 3780);
  ok(jump && jump.d === 20 && jump.gap === 3, '隔三天：差值合并 + gap=3', JSON.stringify(jump));

  const down = API.recordHead(u, '2026-11-11', 5);
  ok(down === null, '计数倒退不报增量');
  ok(u.head.base === 5, '倒退时重立基线');

  ok(API.recordHead({ days: {} }, '2026-11-06', null) === null, '页头没渲染出来就当没有');
}

/* ---------- DOM ---------- */
const dom = new JSDOM(`<!doctype html>${RHEADER}
<div id="m-record"><ul>
  <li><span data-res-id="111"></span><div class="tops"><span class="bg" style="width:100%"></span></div></li>
</ul></div>`);
const doc = dom.window.document;
const h4 = doc.querySelector('#rHeader h4');

ok(API.headCount(doc) === 3751, '从 #rHeader h4 读到 3751', String(API.headCount(doc)));

API.renderHead(doc, { n: 3760, d: 9, gap: 1 });
const s = h4.querySelector('.tm-head');
ok(s && s.textContent === '+9', '+9 挂在 h4 里面', s && s.outerHTML);
ok(h4.textContent === '累积听歌3751首+9', '和原句连着读', JSON.stringify(h4.textContent));
ok(/今天第一次听到 9 首/.test(s.title), '悬停写清楚口径', s && s.title);
ok(API.headCount(doc) === 3751, '自己插的尾巴不会被当成累计数', String(API.headCount(doc)));

API.renderHead(doc, { n: 3760, d: 9, gap: 3 });
ok(/距上次记录 3 天/.test(h4.querySelector('.tm-head').title), '跨多天时说明跨度');

API.renderHead(doc, { n: 3760, d: 0, gap: 1 });
ok(!h4.querySelector('.tm-head') && h4.textContent === '累积听歌3751首', '没有新增就还原');

// 没有 #rHeader 的页面（新版播放器 / 未公开）什么都不做
const plain = new JSDOM('<!doctype html><div id="m-record"></div>').window.document;
API.renderHead(plain, { n: 1, d: 1, gap: 1 });
ok(!plain.querySelector('.tm-head') && API.headCount(plain) === null, '页头不存在时安静跳过');

// inject 会把 day.head 一路带到页面上
const ds = { map: new Map([['111', { score: 100, playCount: 5 }]]), scale: { M: 5, countOf: new Map([[100, 5]]) } };
API.inject(doc, ds, { counts: {}, head: { n: 3765, d: 14, gap: 1 } }, null, false);
ok(h4.querySelector('.tm-head').textContent === '+14', 'inject 用 day.head 渲染');

console.log(fail ? `\n${fail} 条失败` : '\n全部通过');
process.exitCode = fail ? 1 : 0;
