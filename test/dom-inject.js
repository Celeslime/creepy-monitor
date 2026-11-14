const fs = require('fs');
const { JSDOM } = require('jsdom');

// 把 IIFE 改造成可导出的纯函数模块，跳过 setInterval / tick / fetch
let src = fs.readFileSync(require('./lib/harness').SCRIPT, 'utf8');
src = src.replace('(function () {', 'var API=(function(){');
src = src.replace(/window.addEventListener\('hashchange'[\s\S]*$/, 'return {inject, describe}; })();');
const { inject, describe } = new Function(src + '; return API;')();

const html = `<!doctype html><div id="m-record"><ul>
  <li><span data-res-id="111"></span><div class="tops"><span class="bg" style="width:100%"></span></div></li>
  <li><span data-res-id="222"></span><div class="tops"><span class="bg" style="width:50%"></span></div></li>
  <li><span data-res-id="333"></span><div class="tops"><span class="bg" style="width:40%"></span><span class="times f-ff2">19次</span></div></li>
</ul></div>`;

const dom = new JSDOM(html);
const doc = dom.window.document;

const map = new Map([
  ['111', { score: 100, playCount: 49 }],
  ['222', { score: 50, playCount: 24 }],
  ['333', { score: 40, playCount: 19 }],
]);
const ds = { map, scale: { M: 2, countOf: new Map([[100, 2]]) } };

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '  ' + extra));
  if (!cond) fail++;
};

const lis = i => doc.querySelectorAll('#m-record li')[i];
const tops = i => lis(i).querySelector('.tops');

// --- 第一轮：111 有新增，222 无新增，333 走本人主页分支（官方已显示次数）---
inject(doc, ds, { counts: { 111: 3, 333: 2 }, time: '13:05', exact: true });

const t0 = tops(0);
const main = t0.querySelector('.tm-times');
ok(!!main, '插入主 span');
ok(main.className === 'times f-ff2 tm-times', '主 span 保留官方类名', main.className);
ok(main.firstChild.nodeType === 3 && main.firstChild.nodeValue === '49次', '主数字在文本节点里', JSON.stringify(main.textContent));

const dl = main.querySelector('.tm-delta');
ok(!!dl, '增量嵌在主 span 内部');
ok(dl && !dl.classList.contains('times'), '子元素不带 times，避免被绝对定位', dl && dl.className);
ok(dl && dl.textContent === '+3', '子元素文本 +3', dl && dl.textContent);
ok(dl && dl.style.marginLeft === '4px', '子元素内联 margin-left:4px', dl && dl.style.cssText);
ok(dl && dl.style.position === '' && dl.style.right === '', '子元素不再做定位');
ok(dl && /今日新增 3 次（13:05 观测，/.test(dl.title), '子元素 title 带观测时刻与来源', dl && dl.title);
ok(main.title === '播放 49 次（接口返回的真实数据）', '主 span title 不掺增量', main.title);

const t1 = tops(1);
ok(t1.querySelectorAll('.tm-delta').length === 0, '无新增的行不建子元素');

// --- 本人主页：官方节点存在时，复用它的节点挂增量 ---
const t2 = tops(2);
const off = t2.querySelector('.times');
ok(!!off, '官方 span 还在');
ok(!t2.querySelector('.tm-times'), '不再另插一个主 span（不会出现两个数字）');
ok(t2.querySelectorAll('.times').length === 1, '官方 span 没被复制');
ok(off.firstChild.nodeValue === '19次', '官方数字不被我们改写', JSON.stringify(off.firstChild.nodeValue));
const dl2 = off.querySelector('.tm-delta');
ok(!!dl2 && dl2.textContent === '+2', '自己的主页也能拿到今日增量', dl2 && dl2.textContent);
ok(off.textContent === '19次+2', '官方数字 + 增量连在一起', off.textContent);

// --- 第二轮：幂等，重复调用不重复插入 ---
inject(doc, ds, { counts: { 111: 3, 333: 2 }, time: '13:05', exact: true });
ok(tops(0).querySelectorAll('.tm-times').length === 1, '重复调用不重复插主 span');
ok(tops(0).querySelectorAll('.tm-delta').length === 1, '重复调用不重复插子元素');
ok(tops(2).querySelectorAll('.tm-delta').length === 1, '本人主页子元素也不重复');

// --- 我的次数：只在他人主页传 map 时出现 ---
const mine = { byId: new Map([['111', 5]]), byName: new Map() }; // {byId,byName}：3.7.3 起多了同名兜底
inject(doc, ds, { counts: { 111: 3, 333: 2 }, time: '13:05', exact: true }, mine);
const mi = lis(0).querySelector('.tm-mine');
ok(!!mi, '我听过时挂上 .tm-mine');
ok(mi && mi.textContent === '我听了 5 次', '文本为「我听了 5 次」', mi && mi.textContent);
ok(mi && mi.parentNode === tops(0), '标签挂在 .tops 里，与 .times 同级', mi && mi.parentNode.className);
ok(mi && mi.classList.contains('f-ff2'), '带上原版字体类 f-ff2', mi && mi.className);
ok(mi && mi.style.fontSize === '', '不写死字号，交给继承', mi && mi.style.fontSize);
ok(mi && mi.style.fontFamily === '', '不写死字体，交给 f-ff2', mi && mi.style.fontFamily);
ok(mi && mi.style.color === 'rgb(102, 102, 102)', '文字色取原版 .times 的 #666', mi && mi.style.color);
ok(mi && mi.style.position === 'absolute' && mi.style.right === '10px', '绝对定位靠右', mi && mi.style.cssText);
ok(mi && mi.children.length === 0, '只是一段纯文本，没有子元素', mi && mi.children.length);
ok(mi && mi.style.position === 'absolute' && mi.style.right === '10px', '绝对定位贴右端', mi && mi.style.cssText);
ok(mi && mi.style.top === '0px', '从行顶开始，靠继承的 38px 行高居中', mi && mi.style.top);
ok(mi && mi.style.borderRadius === '' && mi.style.backgroundColor === '', '不加圆角与底色', mi && mi.style.cssText);
ok(mi && /最近 7 天听了这首歌 5 次/.test(mi.title), 'tooltip 说明口径是最近 7 天', mi && mi.title);
ok(tops(0).style.position === 'relative', '.tops 作为定位参照');
ok(tops(0).querySelector('.tm-times').textContent === '49次+3', '主数字这段文本没被标签污染', tops(0).querySelector('.tm-times').textContent);
ok(lis(0).textContent === '49次+3我听了 5 次', '两者分处行两端', lis(0).textContent);
ok(lis(1).querySelectorAll('.tm-mine').length === 0, '没听过的行不出现标签');
ok(lis(2).querySelectorAll('.tm-mine').length === 0, '本人主页不出现标签');

// 幂等 + 刷新
inject(doc, ds, { counts: { 111: 3, 333: 2 }, time: '13:05', exact: true }, { byId: new Map([['111', 9]]), byName: new Map() });
ok(lis(0).querySelectorAll('.tm-mine').length === 1, '我的次数不重复插入');
ok(lis(0).querySelector('.tm-mine').textContent === '我听了 9 次', '次数变化时就地更新', lis(0).querySelector('.tm-mine').textContent);

// 听完后归零：标签移除
inject(doc, ds, { counts: { 111: 3, 333: 2 }, time: '13:05', exact: true }, { byId: new Map(), byName: new Map() });
ok(lis(0).querySelectorAll('.tm-mine').length === 0, '我的次数消失后清掉标签');
ok(tops(0).textContent === '49次+3', '清掉后其余数字不受影响', tops(0).textContent);

// 自己的主页：即使手里有我的周榜，也整块隐藏
inject(doc, ds, { counts: { 111: 3, 333: 2 }, time: '13:05', exact: true }, mine, true);
ok(lis(0).querySelectorAll('.tm-mine').length === 0, '自己的主页不显示「我听了 N 次」');
ok(tops(0).querySelector('.tm-times').textContent === '49次+3', '自己主页只保留次数与增量', tops(0).textContent);

// --- 第三轮：增量归零，子元素移除且主数字不被清空（textContent 陷阱）---
inject(doc, ds, { counts: { 111: 0, 333: 0 }, time: '14:00', exact: true });
const m3 = tops(0).querySelector('.tm-times');
ok(m3.querySelectorAll('.tm-delta').length === 0, '归零后子元素被移除');
ok(m3.firstChild.nodeValue === '49次', '移除子元素后主数字仍在（未被 textContent 清空）', JSON.stringify(m3.textContent));
ok(/今日无新增/.test(m3.title), '归零信息回落到主 span 的 title', m3.title);
ok(tops(2).querySelectorAll('.tm-delta').length === 0, '本人主页归零后也清掉');

// --- 第四轮：再次出现增量，能重新挂上 ---
inject(doc, ds, { counts: { 111: 5 }, time: '15:00', exact: false });
const m4 = tops(0).querySelector('.tm-times');
ok(m4.querySelectorAll('.tm-delta').length === 1, '增量回来后重新挂上子元素');
ok(m4.textContent === '49次+5', '文本拼接正确', m4.textContent);
ok(/含窗口滑出的估算误差/.test(m4.querySelector('.tm-delta').title), '非精确链路在子元素 title 里标注');

// --- 第五轮：官方的 li 被站点重建（我们的 tm-times 残留在旧节点上）---
const t2b = tops(2);
t2b.insertAdjacentHTML('beforeend', '<span class="times f-ff2 tm-times">19次</span>'); // 模拟残留
inject(doc, ds, { counts: { 333: 1 }, time: '16:00', exact: true });
ok(tops(2).querySelectorAll('.tm-times').length === 0, '官方节点出现后清掉残留的主 span');
ok(tops(2).querySelectorAll('.times').length === 1, '只剩官方的那个数字');

// --- 第六轮：增量口径文案要分清是真值差分还是反解差分 ---
{
  const truth = describe({ id: '111', score: 100, playCount: 49 }, null,
    { counts: { 111: 3 }, fromAll: new Set(['111']), time: '13:05', exact: true });
  ok(/全时间榜真值差分/.test(truth.deltaTip), '真值来源写成「全时间榜真值差分」', truth.deltaTip);

  const est = describe({ id: '111', score: 100, playCount: 49 }, null,
    { counts: { 111: 3 }, fromAll: new Set(), time: '13:05', exact: false });
  ok(/周榜反解差分，含窗口滑出的估算误差/.test(est.deltaTip), '反解来源带估算提示', est.deltaTip);

  // 新进榜：照样给 +n，但口径写成「今日上限」
  const fresh = describe({ id: '111', score: 100, playCount: 49 }, null,
    { counts: { 111: 38 }, newIds: new Set(['111']), time: '13:05', exact: false });
  ok(fresh.delta === '+38', '新进榜照样显示 +n', fresh.delta);
  ok(/今天新进榜，本周累计 38 次（今日上限/.test(fresh.deltaTip), '口径标成今日上限', fresh.deltaTip);

  // 升级当天：全时间基线为空，说清楚而不是静默
  const cold = describe({ id: '111', score: 100, playCount: 49 }, null,
    { counts: {}, coldAll: true, time: '13:05', exact: false });
  ok(/全时间榜基线今天才建立/.test(cold.tip), '冷启动给出基线提示', cold.tip);
  ok(!cold.delta, '冷启动不编造数字');
}

console.log('\n最终结构：');
console.log(tops(0).innerHTML.replace(/></g, '>\n  <'));
console.log(tops(2).innerHTML.replace(/></g, '>\n  <'));
process.exit(fail ? 1 : 0);
