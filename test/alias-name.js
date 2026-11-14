// 同名异 id：单曲版 / 专辑版在站内是两个 id，只按 id 对会整行空着
// 实例：169 听 1808235517（2021 单曲），我听 2063210044（专辑 NEGATIVE），同一段 146 秒录音
const fs = require('fs');
const { JSDOM } = require('jsdom');

let src = fs.readFileSync(process.argv[2] || require('./lib/harness').SCRIPT, 'utf8');
src = src.replace('(function () {', 'var API=(function(){');
src = src.replace(/window\.addEventListener\('hashchange'[\s\S]*$/,
    'return {inject, nameKey}; })();');
const { inject, nameKey } = new Function(src + '; return API;')();

const html = `<!doctype html><div id="m-record"><ul>
  <li><span data-res-id="1808235517"></span><div class="tops"><span class="bg" style="width:100%"></span></div></li>
  <li><span data-res-id="999"></span><div class="tops"><span class="bg" style="width:50%"></span></div></li>
</ul></div>`;
const dom = new JSDOM(html);
const doc = dom.window.document;

const ds = {
    map: new Map([
        // 站内是「单曲版」，名字全小写
        ['1808235517', { score: 100, playCount: 11, name: 'i walk this earth all by myself', art: 'EKKSTACY' }],
        // 歌名撞了，但歌手不同 —— 不能认成同一首
        ['999', { score: 50, playCount: 5, name: 'i walk this earth all by myself', art: 'Some Cover Band' }],
    ]),
    scores: [100, 50],
    scale: { M: 4, countOf: new Map() },
};

let fail = 0;
const ok = (cond, label, extra = '') => {
    console.log((cond ? '\u2713' : '\u2717') + ' ' + label + (cond ? '' : '  ' + JSON.stringify(extra)));
    if (!cond) fail++;
};

const lis = i => doc.querySelectorAll('#m-record li')[i];
const nextTick = () => inject(doc, ds, { counts: {}, time: '20:40', exact: true }, { byId, byName });

// 我的周榜：只有专辑版的 id，歌名大小写不同
const albumKey = nameKey({ name: 'I Walk This Earth All By Myself', art: 'EKKSTACY' });
const byName = new Map([[albumKey, 3]]);
let byId = new Map([['2063210044', 3]]);

nextTick();
const mi = lis(0).querySelector('.tm-mine');
ok(!!mi, 'id 对不上、歌名对得上时也挂标签', lis(0).textContent);
ok(mi && mi.textContent === '我听了 3 次', '次数来自同名的那一版', mi && mi.textContent);
ok(mi && /另一版/.test(mi.title), 'tooltip 说明这是另一版', mi && mi.title);
ok(!lis(1).querySelector('.tm-mine'), '同名但歌手不同，不认成同一首', lis(1).textContent);

// id 命中时以 id 为准，不被同名那条盖掉
byId = new Map([['1808235517', 8]]);
byName.set(albumKey, 3);
nextTick();
const mi2 = lis(0).querySelector('.tm-mine');
ok(mi2 && mi2.textContent === '我听了 8 次', 'id 命中优先于同名', mi2 && mi2.textContent);
ok(mi2 && /真实数据/.test(mi2.title), '按 id 命中时 tooltip 不提「另一版」', mi2 && mi2.title);

// 两边都没有：标签清掉
byId = new Map();
byName.clear();
nextTick();
ok(!lis(0).querySelector('.tm-mine'), '都对不上时不留空标签');

// 只有歌名没有歌手：key 仍然稳定，但不会误伤别的歌手（歌手空）
ok(nameKey({ name: '  A  B  ', art: '' }) === 'a b\u0001', '歌名做小写 + 折叠空白', JSON.stringify(nameKey({ name: '  A  B  ', art: '' })));
ok(nameKey({}) === '' && nameKey(null) === '', '缺歌名时返回空 key', nameKey(null));

console.log(fail ? `\n${fail} 条失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
