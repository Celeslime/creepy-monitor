// 端到端：列表被重画回原样（行数、首行都没变，只有注入的节点没了）时，
// 脚本必须重新补上次数。改动前 sig 只看 uid/行数/首行，会误判成已处理而不再补。
const fs = require('fs');
const { JSDOM } = require('jsdom');

const target = process.argv[2] || require('./lib/harness').SCRIPT;

const week = [
  { song: { id: 1000, name: 'a' }, score: 100, playCount: 0 },
  { song: { id: 1001, name: 'b' }, score: 50, playCount: 0 },
  { song: { id: 1002, name: 'c' }, score: 20, playCount: 0 },
];

const row = it => `<li><span data-res-id="${it.song.id}"></span><div class="tops">`
  + `<span class="bg" style="width:${it.score}%"></span></div></li>`;
const BARE = `<ul>${week.map(row).join('')}</ul>`;

const dom = new JSDOM(`<!doctype html><html><body><div id="m-record">${BARE}</div></body></html>`,
  { url: 'https://music.163.com/user/record?id=100&type=1' });
const { window } = dom;
window.localStorage.setItem('tm_w163_daily_v1', JSON.stringify({ v: 2, users: {} }));
global.window = window;
global.document = window.document;
global.location = window.location;
global.localStorage = window.localStorage;
global.fetch = async () => ({ ok: true, json: async () => ({ weekData: week, allData: [] }) });

new Function(fs.readFileSync(target, 'utf8'))();

const painted = () => window.document.querySelectorAll('#m-record .tm-times').length;

setTimeout(() => {
  const first = painted();
  console.log('首轮补上的行数:', first);
  if (!first) { console.log('✗ 首轮就没画上，后面无法进行'); process.exit(1); }

  // 模拟网易云重画：整段换回没有注入节点的版本，行数与首行内容完全一致
  window.document.querySelector('#m-record').innerHTML = BARE;
  console.log('重画后立刻:', painted());

  setTimeout(() => {
    const back = painted();
    console.log('等一轮轮询后:', back);
    console.log(back === first ? '✓ 重画后自动补回来了' : '✗ 数字被冲掉后再也没补');
    process.exit(back === first ? 0 : 1);
  }, 1600);
}, 400);
