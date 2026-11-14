// 测试共用件：把 userscript 的 IIFE 改造成可导出的模块，
// 顺手提供假 localStorage、可拨的时钟，以及统一的结果输出
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'creepy-monitor.user.js');

// 脚本尾巴是 setInterval / tick / console.info，测试里不需要，从 hashchange 处截断
function load(exportsExpr, opts = {}) {
    let src = fs.readFileSync(opts.script || SCRIPT, 'utf8');
    src = src.replace('(function () {', 'var API=(function(){');
    src = src.replace(/window\.addEventListener\('hashchange'[\s\S]*$/,
        'return ' + exportsExpr + '; })();');

    // 用形参遮蔽同名全局：脚本内部引用 localStorage / Date 时拿到的就是这里传的
    const names = [];
    const vals = [];
    if (opts.localStorage) { names.push('localStorage'); vals.push(opts.localStorage); }
    if (opts.Date) { names.push('Date'); vals.push(opts.Date); }
    return new Function(...names, src + '; return API;')(...vals);
}

// 最小可用的 localStorage：只实现脚本用到的三个方法
function makeStorage() {
    const data = new Map();
    return {
        getItem: k => (data.has(String(k)) ? data.get(String(k)) : null),
        setItem: (k, v) => data.set(k, String(v)),
        removeItem: k => data.delete(String(k)),
        dump: () => Object.fromEntries(data),
    };
}

// 可拨的日期：脚本用 dayKey(new Date()) 判断「今天」，仿真必须能一天一天往前推
function makeClock(startISO) {
    const Real = Date;
    let now = new Real(startISO).getTime();
    class FakeDate extends Real {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    FakeDate.set = iso => { now = new Real(iso).getTime(); };
    FakeDate.advance = ms => { now += ms; };
    return FakeDate;
}

function reporter() {
    let fail = 0;
    let pass = 0;
    return {
        ok(cond, label, extra) {
            const tail = cond || extra === undefined ? '' : ' ' + JSON.stringify(extra);
            console.log((cond ? '\u2713' : '\u2717') + ' ' + label + tail);
            if (cond) pass++;
            else fail++;
        },
        done() {
            console.log(fail ? '\n' + fail + ' 条失败' : '\n全部通过（' + pass + ' 条）');
            process.exit(fail ? 1 : 0);
        },
        get fail() { return fail; },
    };
}

module.exports = { ROOT, SCRIPT, load, makeStorage, makeClock, reporter };
