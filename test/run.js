// 跑全部套件：每个文件一个子进程，互不干扰；有 ✗ 就整体退出码非 0
const { execFile } = require('child_process');
const path = require('path');

const DIR = __dirname;
const SUITES = [
    'dom-inject',
    'window-slide',
    'scale-decide',
    'scale-shift',
    'revisit',
    'anchor',
    'head-count',
    'mine-listen',
    'alias-name',
    'e2e-redraw',
    'replay-169',
    'scale-ambiguous',
    'lite-solve',
];

const runOne = name => new Promise(resolve => {
    execFile(process.execPath, [path.join(DIR, name + '.js')], { encoding: 'utf8' }, (err, out, errOut) => {
        const text = out + errOut;
        resolve({
            name,
            pass: (text.match(/\u2713/g) || []).length,
            fail: (text.match(/\u2717/g) || []).length,
            code: err ? err.code || 1 : 0,
            bad: text.split('\n').filter(l => l.includes('\u2717')),
        });
    });
});

(async () => {
    let totalPass = 0;
    let totalFail = 0;
    const broken = [];
    for (const name of SUITES) {
        const r = await runOne(name);
        totalPass += r.pass;
        totalFail += r.fail;
        const mark = r.fail || r.code ? '\u2717' : '\u2713';
        console.log(`${mark} ${name.padEnd(14)} ${String(r.pass).padStart(3)} 条`);
        if (r.fail || r.code) broken.push(r);
    }

    if (broken.length) {
        console.log('');
        for (const r of broken) {
            console.log(`— ${r.name} —`);
            for (const line of r.bad.slice(0, 12)) console.log('  ' + line.trim());
            if (!r.bad.length) console.log('  进程异常退出，退出码 ' + r.code);
        }
    }

    console.log(`\n合计 ${totalPass} 条通过，${totalFail} 条失败`);
    process.exit(totalFail || broken.length ? 1 : 0);
})();
