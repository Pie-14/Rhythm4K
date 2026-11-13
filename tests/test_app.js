/*
 * 界面层端到端测试：init → 载入内置示例曲 → 开始 → 暂停/继续 → 自动打完全曲 → 结算
 * node tests/test_app.js
 */
const path = require('path');
const stub = require(path.join(__dirname, 'dom-stub.js')).install('www/index.html');

/* 组装 M4K 命名空间（浏览器里由 index.html 顺序加载，这里手动按同样顺序来） */
const core = require(path.join(__dirname, '..', 'www', 'js', 'core.js'));
const autochart = require(path.join(__dirname, '..', 'www', 'js', 'autochart.js'));
globalThis.M4K = Object.assign({}, core, { autochart: autochart });
require(path.join(__dirname, '..', 'www', 'js', 'audio.js'));
require(path.join(__dirname, '..', 'www', 'js', 'demo.js'));
require(path.join(__dirname, '..', 'www', 'js', 'render.js'));
require(path.join(__dirname, '..', 'www', 'js', 'app.js'));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

(async function run() {
  const app = globalThis.__rhythm4k;
  check('app 已挂到 window', !!app);

  /* ---------- 1. 启动 ---------- */
  check('init 完成', globalThis.document.body.dataset.boot === 'ok', globalThis.document.body.dataset);
  check('默认在菜单页', !stub.isHidden('screen-menu'));
  check('其它页面隐藏', stub.isHidden('screen-ready') && stub.isHidden('screen-results'));
  check('canvas 拿到上下文', stub.canvasCtx.ops.length >= 0);

  /* ---------- 2. 载入内置示例曲 ---------- */
  stub.click('btnDemo');
  await stub.flush(200);

  check('进入准备页', !stub.isHidden('screen-ready'));
  check('曲名正确', stub.el('readyTitle').textContent === 'Neon Tutorial', stub.el('readyTitle').textContent);
  check('谱面 4K', app.chart.keyCount === 4);
  check('生成了解码后的音频', !!app.audioBuffer && app.audioBuffer.duration > 20, app.audioBuffer && app.audioBuffer.duration);
  const statText = stub.el('readyStats').children.map(c => c.children[1].textContent);
  check('准备页统计已填充', statText.length === 6, statText);
  check('键位显示 DFJK', statText.includes('D F J K'), statText);

  /* ---------- 3. 空格开始 ---------- */
  stub.key('keydown', 'Space');
  await stub.flush(30);
  check('开始后状态为 playing', app.state === 'playing', app.state);
  check('所有页面已隐藏', ['menu', 'ready', 'results', 'pause'].every(s => stub.isHidden('screen-' + s)));
  check('判定引擎已建立', !!app.engine && app.engine.stats.total === app.chart.notes.length);

  /* ---------- 4. 暂停 / 继续 ---------- */
  for (let i = 0; i < 10; i++) { stub.advanceAudio(16.7); stub.step(16.7); }
  const beforePause = app.audio.ctx.currentTime;
  stub.key('keydown', 'Escape');
  await stub.flush(30);
  check('Esc 暂停', app.state === 'pause', app.state);
  check('暂停页显示', !stub.isHidden('screen-pause'));
  check('音频上下文已挂起', app.audio.ctx.state === 'suspended', app.audio.ctx.state);
  stub.advanceAudio(1000);
  check('暂停时音频时钟不前进', app.audio.ctx.currentTime === beforePause, {
    now: app.audio.ctx.currentTime, before: beforePause,
  });
  stub.key('keydown', 'Escape');
  await stub.flush(30);
  check('再按 Esc 继续', app.state === 'playing', app.state);
  check('恢复后音频上下文在跑', app.audio.ctx.state === 'running');

  /* ---------- 5. 自动打完全曲 ---------- */
  let frames = 0;
  const releases = [];
  let pressed = 0;
  let maxCombo = 0;

  while (app.state === 'playing' && frames < 8000) {
    frames++;
    stub.advanceAudio(16.7);
    stub.step(16.7);
    stub.canvasCtx.ops.length = 0;

    const lf = app.lastFrame;
    if (!lf) continue;

    // 先处理该松开的键
    while (releases.length && releases[0].at <= lf.perf) {
      const r = releases.shift();
      stub.key('keyup', r.code, lf.perf);
    }
    // 长条按到尾
    for (const h of app.engine.activeHolds.slice()) {
      if (lf.song >= h.end - 10) stub.key('keyup', app.keyCodes[h.col], lf.perf);
    }
    // 该按的音符
    for (const n of app.engine.notes) {
      if (n.time > lf.song) break;
      if (n.state !== 'pending') continue;
      if (lf.song - n.time > 45) continue;
      stub.key('keydown', app.keyCodes[n.col], lf.perf);
      pressed++;
      if (!n.isHold) releases.push({ at: lf.perf + 30, code: app.keyCodes[n.col] });
    }
    if (app.engine.stats.combo > maxCombo) maxCombo = app.engine.stats.combo;
  }

  check('自动打完了（进入结算）', app.state === 'results', { state: app.state, frames });
  check('没有漏音', app.engine.stats.miss === 0, { miss: app.engine.stats.miss, pressed, total: app.engine.stats.total });
  check('全部音符都有判定', app.engine.stats.judged === app.chart.notes.length, app.engine.stats.judged);
  check('准确率很高', app.engine.stats.accuracy > 0.9, app.engine.stats.accuracy);
  check('连击有累积', maxCombo > 50, maxCombo);
  check('帧数合理（约 27 秒 / 60fps）', frames > 400 && frames < 4000, frames);

  /* ---------- 6. 结算页 ---------- */
  check('结算页显示', !stub.isHidden('screen-results'));
  const grade = stub.el('grade').textContent;
  check('评级已填', ['SS', 'S', 'A', 'B', 'C', 'D'].includes(grade), grade);
  check('分数已填', /^[\d,]+$/.test(stub.el('resultScore').textContent), stub.el('resultScore').textContent);
  check('准确率已填', /%$/.test(stub.el('resultAcc').textContent), stub.el('resultAcc').textContent);
  check('判定明细 6 行', stub.el('resultCounts').children.length === 6, stub.el('resultCounts').children.length);  const counts = stub.el('resultCounts').children.map(c => Number(c.children[1].textContent));
  const sum = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
  check('判定数之和 = 音符总数', sum === app.chart.notes.length, { sum, total: app.chart.notes.length });
  check('结算页保留最后一帧', typeof app.frozenSong === 'number' && app.frozenSong > 20000, app.frozenSong);

  /* ---------- 7. 重试 ---------- */
  stub.click('btnRetry');
  await stub.flush(50);
  check('重试回到 playing', app.state === 'playing', app.state);
  check('重试后分数归零', app.engine.stats.score === 0, app.engine.stats.score);
  check('重试后音频重新开始', !!app.audio.source);

  /* ---------- 8. 设置持久化 ---------- */
  stub.el('setOffset').value = '120';
  stub.fire('setOffset', 'change');
  check('偏移写入内存', app.settings.offset === 120, app.settings.offset);
  check('偏移写入 localStorage', /"offset":120/.test(globalThis.localStorage.getItem('rhythm4k.settings.v2') || ''),
    globalThis.localStorage.getItem('rhythm4k.settings.v2'));

  stub.el('setOffset').value = '9999';
  stub.fire('setOffset', 'change');
  check('偏移被钳制到 300', app.settings.offset === 300, app.settings.offset);

  /* ---------- 9. 背景图 / 视频 ---------- */
  const dbg = globalThis.__rhythm4kDebug;
  check('调试把手存在', !!dbg);

  app.chart.background = 'bg.jpg';
  app.files.set('bg.jpg', { name: 'bg.jpg' });
  dbg.setupMedia();
  check('背景图已建立', !!app.media.image, app.media);
  check('背景图用 blob url', /^blob:stub\//.test(app.media.image && app.media.image.src), app.media.image && app.media.image.src);
  check('object url 已登记', stub.liveUrls.size === 1, stub.liveUrls.size);

  dbg.teardownMedia();
  check('teardown 释放了 url', stub.liveUrls.size === 0, [...stub.liveUrls]);

  // 视频优先
  app.chart.video = 'vid.mp4';
  app.files.set('vid.mp4', { name: 'vid.mp4' });
  dbg.setupMedia();
  check('mp4 走视频', !!app.media.video, Object.keys(app.media));
  check('视频静音', app.media.video && app.media.video.muted === true);
  dbg.teardownMedia();

  // .avi：容器支持，编码不一定 → 先尝试，解码失败再退回背景图
  app.chart.video = 'old.avi';
  app.chart.background = 'bg.jpg';
  app.files.set('old.avi', { name: 'old.avi' });
  dbg.setupMedia();
  check('avi 也会先尝试当视频播', !!app.media.video, !!app.media.video);
  const badVideo = app.media.video;
  (badVideo && badVideo._listeners && badVideo._listeners.error ? badVideo._listeners.error : []).forEach(fn => fn({ type: 'error' }));
  check('解码失败后不再保留视频', !app.media.video, !!app.media.video);
  check('解码失败后退回背景图', !!app.media.image, !!app.media.image);
  dbg.teardownMedia();

  /* ---------- 10. 从音频自动生成谱面 ---------- */
  const fakeAudio = {
    name: 'beat.mp3',
    arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(16)); },
  };
  stub.fire('autoInput', 'change', { target: { files: [fakeAudio], value: '' } });
  await stub.flush(400);

  check('自动生成后进入准备页', !stub.isHidden('screen-ready'), app.state);
  check('谱面标记为自动生成', !!(app.chart && app.chart.auto), app.chart && app.chart.auto);
  check('识别出 150 BPM', !!(app.chart.auto) && Math.abs(app.chart.auto.bpm - 150) < 6,
    app.chart.auto && app.chart.auto.bpm);
  check('生成了足够多的音符', app.chart.notes.length > 10, app.chart.notes.length);
  check('准备页显示自动谱面区块', !stub.el('autoRow').classList.contains('hidden'));
  check('准备页有 BPM 一栏', stub.el('readyStats').children.some(
    c => c.children[0] && c.children[0].textContent === 'BPM'));

  // 换难度重新生成
  const before = app.chart.notes.length;
  stub.el('autoDiffReady').value = 'hard';
  stub.fire('autoDiffReady', 'change', { target: { value: 'hard' } });
  await stub.flush(50);
  check('换难度后重新生成', app.chart.auto && app.chart.auto.difficulty === 'hard', app.chart.auto);
  check('困难版音符不少于普通版', app.chart.notes.length >= before, { before, after: app.chart.notes.length });

  /* ---------- 11. 延迟校准 ---------- */
  stub.click('btnCalib');
  await stub.flush(150);
  check('点校准后进入校准页', !stub.isHidden('screen-calib'), {
    state: app.state,
    calibHidden: stub.isHidden('screen-calib'),
    readyHidden: stub.isHidden('screen-ready'),
  });
  check('状态切到 calib', app.state === 'calib', app.state);

  // 模拟「每小节第四拍、每次都晚 40ms」的敲击
  {
    const c = globalThis.__rhythm4kDebug.calib();
    check('校准状态已建立', !!c, c);
    const ctx = app.audio.ctx;
    // 前两小节是适应期（会被忽略），从第 3 个小节的高音开始敲
    const warmupBars = 2;
    const firstHigh = c.t0 + (warmupBars * c.perBar + (c.perBar - 1)) * c.beat;
    for (let i = 0; i < 8; i++) {
      ctx.currentTime = firstHigh + i * c.barSec + 0.04;
      stub.key('keydown', 'Space');
      await stub.flush(2);
    }
    check('敲满 8 下后完成', c.done === true, c.taps.length);
    check('算出 +40ms 偏差', Math.abs(c.result.offset - 40) <= 3, c.result.offset);

    const before = app.settings.offset;
    stub.click('btnCalibApply');
    await stub.flush(20);
    check('应用后偏移按 −偏差 调整', app.settings.offset === before - 40, {
      before, after: app.settings.offset, measured: c.result.offset,
    });
    check('应用后回到准备页', app.state === 'ready', app.state);
  }

  console.log('');
  console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.log('THREW: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
