/*
 * 启动脚本静态检查：node tests/test_launcher_files.js
 *
 * 这两个坑都真实踩过，而且症状都是"双击没反应"，很难查：
 *   1. .bat 用 LF 换行 → cmd 解析异常
 *   2. .bat 里括号块中包含 %ProgramFiles(x86)% 这类变量 → 展开后的 ")" 提前闭合语句块
 *   3. .ps1 没有 UTF-8 BOM → Windows PowerShell 按 ANSI 读，中文变乱码直接语法错误
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

/* ---------------- 启动游戏.bat ---------------- */
const batPath = path.join(root, '启动游戏.bat');
check('启动脚本存在', fs.existsSync(batPath));
if (fs.existsSync(batPath)) {
  const buf = fs.readFileSync(batPath);
  const text = buf.toString('ascii');

  check('不带 BOM', !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf));

  let crlf = 0;
  let lfOnly = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) {
      if (i > 0 && buf[i - 1] === 13) crlf++;
      else lfOnly++;
    }
  }
  check('全部是 CRLF（不能有裸 LF）', lfOnly === 0, { crlf, lfOnly });
  check('确实有换行', crlf > 5, crlf);

  const lines = text.split('\r\n');
  const blockOpen = lines.filter(l => /\)\s*$/.test(l) === false && /\(\s*$/.test(l));
  check('没有括号块（避免 (x86) 提前闭合）', blockOpen.length === 0, blockOpen);

  check('用 goto 做分支', /goto\s+:fallback/.test(text) && /:fallback/.test(text));
  check('找不到页面时有提示', /:nohtml/.test(text) && /pause/.test(text));
  check('路径基于 %~dp0（可移植）', /set\s+"ROOT=%~dp0"/.test(text));
  check('用独立浏览器配置目录', /--user-data-dir=/.test(text));
  check('带无边框全屏', /--start-fullscreen/.test(text));
  check('纯 ASCII（避免控制台编码问题）', /^[\x00-\x7F]*$/.test(text), text.match(/[^\x00-\x7F]/g));
}

/* ---------------- .ps1 需要 UTF-8 BOM ---------------- */
for (const name of ['build.ps1', 'package.ps1', '重建启动方式.ps1']) {
  const p = path.join(root, name);
  if (!fs.existsSync(p)) { check(name + ' 存在', false); continue; }
  const buf = fs.readFileSync(p);
  check(name + ' 带 UTF-8 BOM', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    [buf[0], buf[1], buf[2]]);
}

/* ---------------- 仓库卫生 ---------------- */
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
check('.gitignore 忽略快捷方式', /Rhythm4K\.lnk/.test(gitignore));
check('.gitignore 忽略 exe 产物', /launcher\/Rhythm4K\.exe/.test(gitignore));
check('.gitignore 忽略 dist', /^dist\//m.test(gitignore));

const gitattr = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
check('.gitattributes 强制 bat 用 CRLF', /\*\.bat\s+text\s+eol=crlf/.test(gitattr));

check('LICENSE 存在', fs.existsSync(path.join(root, 'LICENSE')));
check('README 存在', fs.existsSync(path.join(root, 'README.md')));

console.log('');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
