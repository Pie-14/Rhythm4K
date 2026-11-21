/*
 * 渲染冒烟测试：用假 canvas 完整跑一遍 draw()，
 * 检查 lazer 风格的版式坐标是否落在设计值上，以及有没有 NaN。
 * node tests/test_render.js
 */
const path = require('path');
const core = require(path.join(__dirname, '..', 'www', 'js', 'core.js'));

globalThis.M4K = globalThis.M4K || {};
require(path.join(__dirname, '..', 'www', 'js', 'demo.js'));
require(path.join(__dirname, '..', 'www', 'js', 'render.js'));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

/* ---------------- 假 canvas ---------------- */
class FakeGradient {
  constructor() { this.stops = []; }
  addColorStop(o, c) { this.stops.push([o, c]); }
}

class FakeCtx {
  constructor() {
    this.ops = [];
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.font = '10px sans-serif';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.globalAlpha = 1;
  }
  _rec(name, args, meta) { this.ops.push({ name, args: Array.prototype.slice.call(args), meta: meta || {} }); }
  setTransform() {}
  save() { this._rec('save', []); }
  restore() { this._rec('restore', []); }
  translate(x, y) { this._rec('translate', [x, y]); }
  beginPath() {}
  closePath() {}
  moveTo(x, y) { this._rec('moveTo', [x, y]); }
  lineTo(x, y) { this._rec('lineTo', [x, y]); }
  quadraticCurveTo(a, b, c, d) { this._rec('quadraticCurveTo', [a, b, c, d]); }
  arc(x, y, r, s, e) { this._rec('arc', [x, y, r, s, e], { fill: this.fillStyle }); }
  fill() {}
  stroke() {}
  clearRect() {}
  fillRect(x, y, w, h) { this._rec('fillRect', [x, y, w, h], { fill: this.fillStyle }); }
  fillText(t, x, y) { this._rec('fillText', [t, x, y], { fill: this.fillStyle }); }
  drawImage(m, x, y, w, h) { this._rec('drawImage', [x, y, w, h]); }
  createLinearGradient() { return new FakeGradient(); }
  createRadialGradient() { return new FakeGradient(); }
}

class FakeCanvas {
  constructor(w, h) {
    this.clientWidth = w;
    this.clientHeight = h;
    this.width = 0;
    this.height = 0;
    this.ctx = new FakeCtx();
  }
  getContext() { return this.ctx; }
  getBoundingClientRect() {
    return {
      left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight,
      width: this.clientWidth, height: this.clientHeight,
    };
  }
}

globalThis.devicePixelRatio = 1;
globalThis.performance = globalThis.performance || { now: () => Date.now() };

function badNumbers(ops) {
  const bad = [];
  for (const op of ops) {
    for (const a of op.args) {
      if (typeof a === 'number' && !isFinite(a)) bad.push({ op: op.name, args: op.args });
    }
  }
  return bad;
}

function near(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 0.01 : tol); }
function findRect(ops, pred) { return ops.filter(o => o.name === 'fillRect' && pred(o)); }
function findMove(ops, x, y) {
  return ops.filter(o => o.name === 'moveTo' && near(o.args[0], x) && near(o.args[1], y));
}

/* ---------------- 1. 菜单空场 ---------------- */
{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.draw({ engine: null, songTime: 0, keysDown: [false, false, false, false], scrollMs: 700, chart: null });
  check('空场无 NaN', badNumbers(canvas.ctx.ops).length === 0, badNumbers(canvas.ctx.ops));
  check('空场有绘制', canvas.ctx.ops.length > 5, canvas.ctx.ops.length);
  check('1080p 缩放 = 1', near(r.scale, 1, 1e-9), r.scale);
}

/* ---------------- 2. 布局常量 ---------------- */
const demo = globalThis.M4K.demo.build();
const chart = core.parseOsu(demo.text);

{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);

  check('4K 轨道宽 100', r.laneW === 100, r.laneW);
  check('4K 轨道总宽 412', r.fieldW === 4 * 100 + 3 * 4, r.fieldW);
  check('轨道水平居中', near(r.fieldX + r.fieldW / 2, 960, 0.001), r.fieldX);
  check('判定线 y=900', r.judgeY === 900, r.judgeY);
  check('轨道延伸到屏幕底部', r.stageBottom === 1080, r.stageBottom);
  check('4K 四列色相', JSON.stringify(r.hues) === JSON.stringify([46, 24, 344, 288]), r.hues);
}

/* ---------------- 3. 轨道 / 受体 / 按键块 ---------------- */
{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);
  canvas.ctx.ops.length = 0;
  r.draw({ engine: null, songTime: 0, keysDown: [false, false, false, false], scrollMs: 700, chart });
  const ops = canvas.ctx.ops;

  // 列渐变底（通到底）
  const lanes = findRect(ops, o => o.args[1] === 0 && o.args[3] === 1080 && o.args[2] === r.laneW);
  check('4 条列渐变通到底', lanes.length === 4, lanes.length);

  // 列间细缝
  const gaps = findRect(ops, o => o.args[1] === 0 && o.args[3] === 1080 && o.args[2] === r.gap);
  check('3 条列间缝', gaps.length === 3, gaps.length);

  // 判定靶区：和音符同尺寸的圆角块（填充 + 描边 = 2 次 moveTo）
  let receptors = 0;
  for (let i = 0; i < 4; i++) {
    const x = r.fieldX + i * (r.laneW + r.gap) + r.noteInset;
    if (findMove(ops, x + 10, 900 - r.noteH / 2).length === 2) receptors++;
  }
  check('4 个音符形状判定区', receptors === 4, receptors);

  // 按键块
  const padTop = 900 + r.noteH / 2 + 16;
  const padInset = Math.round(r.laneW * 0.1);
  let pads = 0;
  for (let i = 0; i < 4; i++) {
    const x = r.fieldX + i * (r.laneW + r.gap) + padInset;
    if (findMove(ops, x + 10, padTop).length >= 1) pads++;
  }
  check('4 个按键块', pads === 4, pads);

  // 每个按键块三个圆点
  const dots = ops.filter(o => o.name === 'arc' && near(o.args[2], 3.2));
  check('按键块共 12 个圆点', dots.length === 12, dots.length);
}

/* ---------------- 4. 音符 ---------------- */
{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);

  const engine = new core.Engine(chart);
  const t = 1600 + 400 * 10;
  for (let i = 0; i < 60 && chart.notes[i].time < t; i++) {
    engine.press(chart.notes[i].col, chart.notes[i].time);
  }
  engine.update(t);

  canvas.ctx.ops.length = 0;
  r.draw({ engine, songTime: t, keysDown: [true, false, true, false], scrollMs: 700, chart, keyLabels: ['D', 'F', 'J', 'K'] });
  const ops = canvas.ctx.ops;

  check('绘制无 NaN', badNumbers(ops).length === 0, badNumbers(ops).slice(0, 3));

  const upcoming = engine.notes.find(n => n.time > t + 100 && n.state === 'pending' && !n.isHold);
  check('存在未判定的普通音符', !!upcoming);

  const x = r.fieldX + upcoming.col * (r.laneW + r.gap);
  const nh = r.noteH;
  const inset = r.noteInset;
  const nw = r.laneW - inset * 2;
  const nx = x + inset;
  const cx = nx + nw / 2;
  const top = r.yFor(upcoming.time) - nh / 2;
  const chevSize = Math.max(8, Math.round(nw * 0.12));

  // 尺寸锁定：更高更窄
  check('4K 音符高 36', nh === 36, nh);
  check('4K 音符宽 94（几乎同轨道）', nw === 94, nw);
  check('4K 音符左右各留 3', inset === 3, inset);

  // 向下箭头
  const chevY = top + nh * 0.4 - chevSize * 0.45;
  check('音符有向下箭头', findMove(ops, cx - chevSize, chevY).length === 1, {
    wantX: (cx - chevSize).toFixed(2), wantY: chevY.toFixed(2),
    got: findMove(ops, cx - chevSize, chevY).length,
  });

  // 白色底条 roundRect(nx+8, top+nh-12, nw-16, 6, 3)
  check('音符有白色底条', findMove(ops, nx + 11, top + nh - 12).length === 1, {
    wantX: (nx + 11).toFixed(2), wantY: (top + nh - 12).toFixed(2),
  });

  // 圆角音符本体 roundRect(nx, top, nw, nh, 10) → moveTo(nx+10, top)
  check('音符本体圆角矩形', findMove(ops, nx + 10, top).length === 1);

  // HUD
  const texts = ops.filter(o => o.name === 'fillText');
  check('有分数文本', texts.some(o => /^[\d,]+$/.test(String(o.args[0]))));
  // 连击挪到左下角（y≈930），不再挡住轨道中央
  check('连击数字在左下角', texts.some(o => /^\d+$/.test(String(o.args[0])) &&
    o.args[1] < 200 && o.args[2] > 900 && o.args[2] < 960),
    texts.filter(o => /^\d+$/.test(String(o.args[0]))).map(o => [o.args[1], o.args[2]]));
  check('有 COMBO 标签', texts.some(o => String(o.args[0]) === 'COMBO'));
  check('分数 7 位补零显示', texts.some(o => /^\d{7}$/.test(String(o.args[0]))),
    texts.filter(o => /^\d+$/.test(String(o.args[0]))).map(o => String(o.args[0])));
  check('不再显示满分分母', !texts.some(o => String(o.args[0]).indexOf('1000000') >= 0));
  check('有准确率百分比', texts.some(o => /%$/.test(String(o.args[0]))));
  check('有准确率标签', texts.some(o => String(o.args[0]) === '准确率'));
  check('有时间文本', texts.some(o => /^\d+:\d\d$/.test(String(o.args[0]))));

  // 底部进度条 roundRect(40, 1036, 1840, 6, 3) → moveTo(43, 1036)
  check('底部进度条', findMove(ops, 43, 1036).length >= 1, findMove(ops, 43, 1036).length);

  // 左上分数面板 roundRect(36, 28, 430, 118, 20) → moveTo(56, 28)
  check('分数不再套面板', findMove(ops, 56, 28).length === 0, findMove(ops, 56, 28).length);
}

/* ---------------- 5. 长条 ---------------- */
{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);
  const engine = new core.Engine(chart);
  const holdNote = chart.notes.find(n => n.isHold);
  engine.press(holdNote.col, holdNote.time);
  check('长条已进入 holding', engine.notes[holdNote.id].state === 'holding');

  canvas.ctx.ops.length = 0;
  r.draw({ engine, songTime: holdNote.time + 50, keysDown: [false, true, false, false], scrollMs: 700, chart });
  const ops = canvas.ctx.ops;

  const x = r.fieldX + holdNote.col * (r.laneW + r.gap);
  const nx = x + r.noteInset;
  // 按住时头部贴在判定线：top = 900 - nh/2
  // 判定靶区(2) + 音符头(1) 共 3 次，说明头部正好压在靶区上
  check('按住时音符头正好压在判定区上', findMove(ops, nx + 10, 900 - r.noteH / 2).length === 3, {
    got: findMove(ops, nx + 10, 900 - r.noteH / 2).length,
  });
  // 长条尾巴有白色端帽
  const tailY = r.yFor(holdNote.end);
  check('长条有尾端白帽', findMove(ops, nx + 8.5, tailY - 4).length === 1, {
    wantY: (tailY - 4).toFixed(2),
  });
}

/* ---------------- 5a. 长条在整个按住期间都必须可见 ---------------- */
{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);
  const engine = new core.Engine(chart);
  const holdNote = chart.notes.find(n => n.isHold);
  engine.press(holdNote.col, holdNote.time);

  const x = r.fieldX + holdNote.col * (r.laneW + r.gap);
  const nx = x + r.noteInset;
  const holdMs = holdNote.end - holdNote.time;

  let missing = null;
  for (let el = 0; el <= holdMs - 10; el += 25) {
    const t = holdNote.time + el;
    engine.update(t);
    canvas.ctx.ops.length = 0;
    r.draw({ engine, songTime: t, keysDown: [false, false, false, false], scrollMs: 700, chart });

    // 身体 roundRect(nx, top, nw, h, 7) 的第一个 moveTo 在 (nx+7, top)
    const bodies = canvas.ctx.ops.filter(o =>
      o.name === 'moveTo' && Math.abs(o.args[0] - (nx + 7)) < 0.01 && o.args[1] < 1100);
    if (!bodies.length) { missing = { el, t }; break; }
  }
  check('长条按住期间每一帧都存在', !missing, missing);
}

/* ---------------- 5b. 断掉的长条：变暗但仍在 ---------------- */
{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);
  const engine = new core.Engine(chart);
  const holdNote = chart.notes.find(n => n.isHold);
  engine.press(holdNote.col, holdNote.time);
  engine.release(holdNote.col, holdNote.time + 60); // 提前松手
  check('断掉后仍在 brokenHolds', engine.brokenHolds.length === 1);

  canvas.ctx.ops.length = 0;
  r.draw({ engine, songTime: holdNote.time + 200, keysDown: [false, false, false, false], scrollMs: 700, chart });
  const ops = canvas.ctx.ops;

  const x = r.fieldX + holdNote.col * (r.laneW + r.gap);
  const nx = x + r.noteInset;
  const tailY = r.yFor(holdNote.end);
  // 身体是 roundRect(nx, top, nw, h, 7) → moveTo(nx + 7, top)，top = tailY
  check('断掉的长条仍然画出剩余部分', findMove(ops, nx + 7, tailY).length >= 1, {
    wantX: (nx + 7).toFixed(1), wantY: tailY.toFixed(1),
    got: findMove(ops, nx + 7, tailY).length,
  });
  // 头已经不在了：判定线上的音符头不应再出现
  check('断掉后不再画音符头', findMove(ops, nx + 10, 900 - r.noteH / 2).length <= 2,
    findMove(ops, nx + 10, 900 - r.noteH / 2).length);
}

/* ---------------- 5c. 竖屏（手机）布局 ---------------- */
{
  const canvas = new FakeCanvas(1080, 1920);
  const r = new globalThis.M4K.Renderer(canvas);
  const beforeW = r.W;
  r.setOrientation('portrait');

  check('竖屏切换后逻辑尺寸 1080×1920', r.W === 1080 && r.H === 1920, [r.W, r.H]);
  check('横屏时是 1920×1080', beforeW === 1920, beforeW);
  check('竖屏轨道居中', Math.abs(r.fieldX - (1080 - r.fieldW) / 2) < 1.5, {
    fieldX: r.fieldX, fieldW: r.fieldW,
  });
  check('竖屏判定线在下方 78%', Math.abs(r.judgeY - 1920 * 0.78) < 2, r.judgeY);
  check('竖屏轨道不超出画布', r.fieldX >= 0 && r.fieldX + r.fieldW <= 1080, {
    left: r.fieldX, right: r.fieldX + r.fieldW, W: r.W,
  });

  // 底部按钮点中哪条轨道
  const y = r.judgeY + 120;
  check('点第 1 轨中心 → 0', r.laneAt(r.fieldX + r.laneW / 2, y) === 0);
  check('点第 4 轨中心 → 3',
    r.laneAt(r.fieldX + 3 * (r.laneW + r.gap) + r.laneW / 2, y) === 3);
  check('点左侧空白 → -1', r.laneAt(r.fieldX - 40, y) === -1);
  check('点右侧空白 → -1', r.laneAt(r.fieldX + r.fieldW + 40, y) === -1);
  // 整条竖条都算（手机手指不需要精确到底部按钮）
  check('整条轨道都能点（顶部也算）', r.laneAt(r.fieldX + 10, 40) === 0);
  check('判定线上方很远处也能点', r.laneAt(r.fieldX + 10, r.judgeY - r.noteH * 5) === 0);
  check('画布下方之外不算', r.laneAt(r.fieldX + 10, r.H + 5) === -1);

  // 坐标换算：画布 CSS 尺寸 = 逻辑尺寸时应当一比一
  canvas.clientWidth = 1080;
  canvas.clientHeight = 1920;
  canvas.width = 1080;
  canvas.height = 1920;
  r.resize();
  const p = r.logicalPoint(200, 300);
  check('逻辑坐标换算（无缩放）', Math.abs(p.x - 200) < 2 && Math.abs(p.y - 300) < 2, p);

  // 竖屏也要能正常画一帧
  r.setChart(chart);
  const engine = new core.Engine(chart);
  const st = { engine, songTime: chart.notes[0].time, keysDown: [false, false, false, false], scrollMs: 700, chart };
  let threw = null;
  try { r.draw(st); } catch (e) { threw = e.message; }
  check('竖屏绘制不报错', threw === null, threw);

  // 切回横屏
  r.setOrientation('landscape');
  check('切回横屏恢复 1920×1080', r.W === 1920 && r.H === 1080, [r.W, r.H]);
  check('切回横屏判定线回 900', Math.abs(r.judgeY - 900) < 2, r.judgeY);
}

/* ---------------- 5d. 默认背景是动态的 ---------------- */
{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);
  const engine = new core.Engine(chart);
  const st = { engine, songTime: 0, keysDown: [false, false, false, false], scrollMs: 700, chart, media: null };

  canvas.ctx.ops.length = 0;
  r.draw(st);
  const ops1 = canvas.ctx.ops.slice();
  const translate1 = ops1.filter(o => o.name === 'translate').map(o => o.args[0].toFixed(3));
  check('默认背景画了光晕（有 translate 位移）', translate1.length >= 2, translate1);

  // 时间推进后再画一帧，位移应当变化
  r.bgT = 0;
  r._lastNow = 1;
  canvas.ctx.ops.length = 0;
  r.draw(st);
  const t0 = canvas.ctx.ops.filter(o => o.name === 'translate').map(o => o.args[0].toFixed(3));
  r.bgT = 5;
  r._lastNow = 1;
  canvas.ctx.ops.length = 0;
  r.draw(st);
  const t5 = canvas.ctx.ops.filter(o => o.name === 'translate').map(o => o.args[0].toFixed(3));
  check('背景光晕会随时间移动', JSON.stringify(t0) !== JSON.stringify(t5), { t0, t5 });
}

/* ---------------- 6. 背景图（cover + 压暗） ---------------- */
{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);

  const img = { naturalWidth: 1000, naturalHeight: 1000 };
  canvas.ctx.ops.length = 0;
  r.draw({ engine: null, songTime: 0, keysDown: [], scrollMs: 700, chart, media: img, bgDim: 0.7 });
  const ops = canvas.ctx.ops;

  const draws = ops.filter(o => o.name === 'drawImage');
  check('背景图被绘制', draws.length === 1, draws.length);
  if (draws.length) {
    check('按 cover 放大到 1920', near(draws[0].args[2], 1920, 0.01), draws[0].args[2]);
    check('垂直居中裁切', near(draws[0].args[1], -420, 0.01), draws[0].args[1]);
  }
  const dim = findRect(ops, o => o.args[2] === 1920 && o.args[3] === 1080 &&
    String(o.meta.fill).replace(/\s/g, '') === 'rgba(0,0,0,0.7)');
  check('按 70% 压暗', dim.length === 1, dim.length);
}

/* ---------------- 7. 没有背景时不画图 ---------------- */
{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);
  r.draw({ engine: null, songTime: 0, keysDown: [], scrollMs: 700, chart, media: null });
  check('无背景时不调用 drawImage', canvas.ctx.ops.filter(o => o.name === 'drawImage').length === 0);
}

/* ---------------- 8. hit error 条 ---------------- */
{
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);
  r.reset();
  r.addHit(30, { color: '#ffffff' });
  r.addHit(-90, { color: '#ff5f74' });
  canvas.ctx.ops.length = 0;
  r.draw({ engine: null, songTime: 0, keysDown: [], scrollMs: 700, chart });

  const barX = 1920 - 72;
  const ticks = findRect(canvas.ctx.ops, o => o.args[2] === 10 && o.args[3] === 3);
  check('两次打击两根刻度', ticks.length === 2, ticks.length);
  // 竖排：早/晚映射到上下，30ms 在中心线下 46px
  const wantY = 550 + (30 / 150) * 230 - 1.5;
  check('刻度在右侧竖排', ticks.some(t => near(t.args[0], barX - 5) && near(t.args[1], wantY)),
    { wantX: barX - 5, wantY, got: ticks.map(t => [t.args[0], t.args[1]]) });

  r.reset();
  check('reset 清空偏差记录', r.hits.length === 0);
}

/* ---------------- 9. 7K 与缩放 ---------------- */
{
  const fake7 = { keyCount: 7, notes: chart.notes, meta: chart.meta };
  const canvas = new FakeCanvas(1920, 1080);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(fake7);
  check('7K 轨道宽 84', r.laneW === 84, r.laneW);
  check('7K 总宽 7*84+6*4', r.fieldW === 7 * 84 + 6 * 4, r.fieldW);
  check('7K 七列色相', r.hues.length === 7, r.hues.length);
  r.draw({ engine: null, songTime: 0, keysDown: new Array(7).fill(false), scrollMs: 700, chart: fake7 });
  check('7K 无 NaN', badNumbers(canvas.ctx.ops).length === 0);
}
{
  const canvas = new FakeCanvas(1280, 720);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);
  check('16:9 缩放到 1280', near(r.scale, 1280 / 1920, 1e-9), r.scale);
  r.draw({ engine: null, songTime: 0, keysDown: [], scrollMs: 700, chart });
  check('小窗无 NaN', badNumbers(canvas.ctx.ops).length === 0);
}
{
  const canvas = new FakeCanvas(1600, 1200);
  const r = new globalThis.M4K.Renderer(canvas);
  r.setChart(chart);
  check('4:3 按宽度缩放', near(r.scale, 1600 / 1920, 1e-9), r.scale);
  check('留上下黑边', r.oy > 0 && r.ox === 0, { ox: r.ox, oy: r.oy });
}

console.log('');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
