/*
 * 命名空间一致性检查：node tests/test_namespace.js
 *
 * 防的是这类 bug：库把 API 挂成 M4K.analyze，而 app.js 读 M4K.autochart.analyze，
 * 浏览器里就是 "Cannot read properties of undefined"，但 Node 测试里手动拼装
 * 全局对象会把问题掩盖掉。
 *
 * 做法：按 index.html 里的顺序，在没有 module 的上下文里跑一遍所有库
 * （等价于浏览器的 <script> 加载），然后静态扫 app.js 里用到的每个 M4K.xxx。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'www', 'index.html'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

/* index.html 里的脚本顺序 */
const srcs = [];
const re = /<script src="([^"]+)"><\/script>/g;
let m;
while ((m = re.exec(html))) srcs.push(m[1]);

check('index.html 有脚本引用', srcs.length >= 5, srcs.length);
check('core.js 最先加载', /core\.js$/.test(srcs[0]), srcs[0]);
check('app.js 最后加载', /app\.js$/.test(srcs[srcs.length - 1]), srcs[srcs.length - 1]);

/* www/js 下每个文件都应该被引入，别漏 */
const allJs = fs.readdirSync(path.join(root, 'www', 'js')).filter(f => f.endsWith('.js'));
for (const f of allJs) {
  check(f + ' 已被 index.html 引入', srcs.some(s => s.endsWith('/' + f)), srcs);
}

/* 按浏览器的方式加载（vm 里没有 module 绑定 → 走挂到 globalThis 的分支） */
globalThis.M4K = undefined;
for (const src of srcs) {
  if (/app\.js$/.test(src)) continue; // app.js 会跑 init()，需要 DOM，跳过
  const file = path.join(root, 'www', src.replace(/\//g, path.sep));
  const code = fs.readFileSync(file, 'utf8');
  vm.runInThisContext(code, { filename: src });
}

check('M4K 已被建立', !!globalThis.M4K);

/* app.js 里用到的每个 M4K.xxx 都必须真的存在 */
const appSrc = fs.readFileSync(path.join(root, 'www', 'js', 'app.js'), 'utf8');
const used = new Set();
const useRe = /M4K\.([A-Za-z_$][\w$]*)/g;
while ((m = useRe.exec(appSrc))) used.add(m[1]);

check('app.js 确实引用了 M4K 的成员', used.size > 0, used.size);
for (const name of used) {
  check('M4K.' + name + ' 存在', globalThis.M4K[name] !== undefined, typeof globalThis.M4K[name]);
}

/* 自动生成相关：这两个必须挂在 M4K.autochart 下面 */
check('M4K.autochart 是对象', typeof globalThis.M4K.autochart === 'object');
if (globalThis.M4K.autochart) {
  check('M4K.autochart.analyze 是函数', typeof globalThis.M4K.autochart.analyze === 'function');
  check('M4K.autochart.generate 是函数', typeof globalThis.M4K.autochart.generate === 'function');
  check('M4K.autochart.toOsu 是函数', typeof globalThis.M4K.autochart.toOsu === 'function');
}

/* 同类的：这些也必须是命名空间而不是平铺 */
check('M4K.demo 挂成命名空间', typeof globalThis.M4K.demo === 'object');
check('M4K.autochart 没有被平铺成 M4K.analyze', globalThis.M4K.analyze === undefined);

console.log('');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
