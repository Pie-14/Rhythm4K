/*
 * app.js — 界面流程 / 载入 / 输入 / 主循环
 */
(function () {
  'use strict';

  const M4K = window.M4K;
  const $ = function (id) { return document.getElementById(id); };

  const STORE_KEY = 'rhythm4k.settings.v2';
  const DEFAULTS = { offset: 0, scroll: 700, volume: 85, dim: 55 };
  const SCREENS = ['menu', 'ready', 'pause', 'results', 'loading', 'calib'];

  const app = {
    state: 'menu',
    files: new Map(), // 小写文件名 -> File
    chart: null,
    audioBuffer: null,
    engine: null,
    audio: null,
    renderer: null,
    media: { image: null, video: null, url: null },
    autoAnalysis: null,
    autoName: '',
    keysDown: [],
    keyCodes: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
    lastFrame: null,
    finishingAt: 0,
    debugSong: 0,
    settings: loadSettings(),
  };

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(app.settings));
    } catch (e) {
      /* file:// 下可能被禁，忽略 */
    }
  }

  /* ------------------------------------------------------------------ *
   * 界面
   * ------------------------------------------------------------------ */
  function show(name) {
    for (let i = 0; i < SCREENS.length; i++) {
      const el = $('screen-' + SCREENS[i]);
      if (el) el.classList.toggle('hidden', SCREENS[i] !== name);
    }
  }

  function msg(text) {
    const el = $('menuMsg');
    if (el) el.textContent = text || '';
  }

  function setLoading(text) {
    $('loadingMsg').textContent = text;
    show('loading');
  }

  /* ------------------------------------------------------------------ *
   * 键位布局
   * ------------------------------------------------------------------ */
  function keyCodesFor(keyCount) {
    switch (keyCount) {
      case 4: return ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
      case 5: return ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'];
      case 6: return ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'];
      case 7: return ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'];
      default: {
        const base = ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'];
        const out = [];
        for (let i = 0; i < keyCount; i++) out.push(base[i % base.length]);
        return out;
      }
    }
  }

  function keyLabelsFor(codes) {
    return codes.map(function (c) {
      if (c === 'Space') return '空格';
      return c.replace('Key', '').replace('Digit', '');
    });
  }

  /* ------------------------------------------------------------------ *
   * 载入：谱面 / 音频 / .osz / 文件夹
   * ------------------------------------------------------------------ */
  function collectFiles(fileList) {
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const path = f.webkitRelativePath || f.name || '';
      const name = path.split(/[\\/]/).pop();
      if (name) app.files.set(name.toLowerCase(), f);
    }
  }

  async function onFilesReady() {
    const oszList = [];
    app.files.forEach(function (f, k) {
      if (k.endsWith('.osz')) oszList.push([k, f]);
    });

    for (let i = 0; i < oszList.length; i++) {
      const key = oszList[i][0];
      const file = oszList[i][1];
      try {
        setLoading('解包 ' + file.name + ' …');
        await nextTick();
        const entries = await unzip(await file.arrayBuffer());
        for (let j = 0; j < entries.length; j++) {
          const name = entries[j][0].split(/[\\/]/).pop();
          if (!name) continue;
          if (!/\.(osu|mp3|ogg|wav|m4a|jpg|jpeg|png|bmp|gif|mp4|webm|m4v|mov|mkv|ogv|avi|flv)$/i.test(name)) continue;
          app.files.set(name.toLowerCase(), new File([entries[j][1]], name));
        }
        app.files.delete(key);
      } catch (err) {
        console.warn('osz 解包失败', err);
        show('menu');
        msg('这个 .osz 解包失败：' + err.message + '（可以直接解压后用「选择文件夹」）');
        return;
      }
    }

    refreshChartList();
  }

  function refreshChartList() {
    const list = [];
    app.files.forEach(function (f, k) {
      if (k.endsWith('.osu')) list.push(f);
    });

    const box = $('chartList');
    box.innerHTML = '';
    box.classList.add('hidden');

    if (!list.length) {
      show('menu');
      msg('没有找到 .osu 谱面。拖一个 .osz、.osu 或整个曲目文件夹进来。');
      return;
    }

    if (list.length === 1) {
      loadChartFile(list[0]);
      return;
    }

    show('menu');
    msg('找到 ' + list.length + ' 张谱面，选一张：');
    box.classList.remove('hidden');
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const el = document.createElement('div');
      el.className = 'chart-item';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = f.name.replace(/\.osu$/i, '');
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = '载入';
      el.appendChild(t);
      el.appendChild(m);
      el.addEventListener('click', function () { loadChartFile(f); });
      box.appendChild(el);
    }
  }

  async function loadChartFile(file) {
    setLoading('解析谱面…');
    await nextTick();

    let text;
    try {
      text = await file.text();
    } catch (e) {
      show('menu');
      msg('读取谱面失败：' + e.message);
      return;
    }

    let chart;
    try {
      chart = M4K.parseOsu(text);
    } catch (err) {
      show('menu');
      msg('谱面解析失败：' + err.message);
      return;
    }

    const want = (chart.audioFilename || '').split(/[\\/]/).pop().toLowerCase();
    let audioFile = want ? app.files.get(want) : null;
    if (!audioFile) {
      app.files.forEach(function (f, k) {
        if (!audioFile && /\.(mp3|ogg|wav|m4a)$/i.test(k)) audioFile = f;
      });
    }
    if (!audioFile) {
      show('menu');
      msg('没找到音频文件（谱面里写的是 “' + (chart.audioFilename || '空') + '”）。把 .osu 和音频放同一个文件夹再拖进来。');
      return;
    }

    setLoading('解码音频…');
    await nextTick();
    let buffer;
    try {
      buffer = await app.audio.decode(await audioFile.arrayBuffer());
    } catch (e) {
      show('menu');
      msg('音频解码失败（' + audioFile.name + '）：' + e.message);
      return;
    }

    app.chart = chart;
    app.audioBuffer = buffer;
    enterReady();
  }

  async function loadDemo() {
    setLoading('载入示例曲…');
    await nextTick();
    await app.audio.ensure();

    // 优先用内置的真实音频（www/audio/demo.mp3），读不到就退回程序合成的曲子。
    // file:// 下读本地文件需要 --allow-file-access-from-files，启动器已经带上了。
    let buffer = null;
    try {
      // 注意：file:// 下 fetch 的响应的 status 是 0、ok 是 false，
      // 所以不能判断 res.ok，只能直接读字节再检查长度。
      const res = await fetch('audio/demo.mp3');
      const raw = await res.arrayBuffer();
      if (raw && raw.byteLength > 4096) buffer = await app.audio.decode(raw);
    } catch (e) {
      console.warn('内置音频读取失败，改用合成曲', e);
    }

    if (buffer && M4K.autochart) {
      try {
        setLoading('分析示例曲节拍…');
        await nextTick();
        await new Promise(function (r) { setTimeout(r, 40); });

        const analysis = M4K.autochart.analyze(toMono(buffer), buffer.sampleRate, {});
        const chart = M4K.autochart.generate(analysis, {
          difficulty: 'normal',
          keyCount: 4,
          title: 'End Like This',
          artist: '内置示例曲',
        });
        if (chart && chart.notes.length) {
          // 例曲封面当背景（没有就保持纯色渐变）
          try {
            const imgRes = await fetch('audio/demo.jpg');
            const imgBuf = await imgRes.arrayBuffer();
            if (imgBuf && imgBuf.byteLength > 4096) {
              app.files.set('demo.jpg', new File([imgBuf], 'demo.jpg', { type: 'image/jpeg' }));
              chart.background = 'demo.jpg';
            }
          } catch (e) {
            console.warn('示例曲封面没读到', e);
          }

          app.autoAnalysis = analysis;
          app.autoName = 'End Like This';
          app.chart = chart;
          app.audioBuffer = buffer;
          enterReady();
          return;
        }
      } catch (e) {
        console.warn('示例曲分析失败，改用合成曲', e);
      }
    }

    // 兜底：程序合成的示例曲
    app.demoFallback = true;
    setLoading('合成示例曲…');
    await nextTick();
    const demo = M4K.demo.build();
    app.chart = M4K.parseOsu(demo.text);
    app.audioBuffer = M4K.demo.buildAudio(app.audio.ctx, demo.objects);
    enterReady();
  }

  /* ------------------------------------------------------------------ *
   * 背景媒体（.osz 里的背景图 / 视频）
   * ------------------------------------------------------------------ */
  function teardownMedia() {
    const m = app.media;
    if (m.video) {
      try { m.video.pause(); } catch (e) { /* ignore */ }
      try {
        m.video.removeAttribute('src');
        if (m.video.load) m.video.load();
      } catch (e) { /* ignore */ }
    }
    if (m.flv) {
      try { m.flv.dispose(); } catch (e) { /* ignore */ }
    }
    if (m.url) {
      try { URL.revokeObjectURL(m.url); } catch (e) { /* ignore */ }
    }
    app.media = { image: null, video: null, url: null };
  }

  function loadImageBackdrop(file) {
    if (!file) return;
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      app.media = { image: img, video: null, url: url };
    } catch (e) {
      console.warn('背景图加载失败', e);
    }
  }

  /** 视频放不了时统一退回背景图 */
  function fallbackToImage() {
    const bg = app.bgFile;
    teardownMedia();
    loadImageBackdrop(bg);
  }

  function setupMedia() {
    teardownMedia();
    const chart = app.chart;
    if (!chart) return;

    const base = function (p) {
      return String(p || '').split(/[\\/]/).pop().toLowerCase();
    };
    const bgFile = app.files.get(base(chart.background));
    const vidFile = app.files.get(base(chart.video));

    // FLV（osu 谱面里最多的一种）：浏览器没有解复用器，但里面是 H.264，
    // 所以自己解容器 + WebCodecs 解码，解出来的画面当背景图用。
    if (vidFile && /\.flv$/i.test(vidFile.name) && M4K.FlvPlayer && M4K.FlvPlayer.supported()) {
      const player = new M4K.FlvPlayer();
      app.bgFile = bgFile || null;
      app.media = { image: null, video: null, url: null, flv: player };
      // 解码是异步的，失败不会走 load() 的 catch，必须单独挂
      player.onError = function () {
        console.warn('FLV 解码失败，退回背景图');
        if (app.media.flv === player) fallbackToImage();
      };
      player.load(vidFile).then(function () {
        if (app.media.flv === player) app.media.image = player.canvas;
      }).catch(function (err) {
        console.warn('FLV 播放失败，退回背景图', err);
        if (app.media.flv === player) fallbackToImage();
      });
      return;
    }

    if (vidFile && /\.(mp4|webm|m4v|mov|mkv|ogv|avi)$/i.test(vidFile.name)) {
      try {
        const url = URL.createObjectURL(vidFile);
        const v = document.createElement('video');
        v.muted = true;
        v.loop = false;
        v.playsInline = true;
        v.preload = 'auto';
        v.src = url;
        // 编码不支持（比如 .avi 转码失败）时退回背景图
        v.addEventListener('error', function () {
          if (app.media.video !== v) return;
          teardownMedia();
          loadImageBackdrop(bgFile);
        });
        app.media = { image: null, video: v, url: url };
        return;
      } catch (e) {
        console.warn('视频背景失败，改用图片', e);
      }
    }
    loadImageBackdrop(bgFile);
  }

  /** 让视频跟着歌曲时间走（偏差超过 250ms 才纠正，避免频繁 seek 卡顿） */
  function syncVideo(songMs) {
    const v = app.media.video;
    if (!v || app.state !== 'playing') return;
    const d = v.duration;
    if (!d || !isFinite(d)) return;

    if (songMs < 0) {
      if (!v.paused) v.pause();
      return;
    }
    const target = Math.min(songMs / 1000, Math.max(0, d - 0.05));
    if (Math.abs(v.currentTime - target) > 0.25) {
      try { v.currentTime = target; } catch (e) { /* ignore */ }
    }
    if (v.paused) {
      const p = v.play();
      if (p && p.catch) p.catch(function () {});
    }
  }

  /* ------------------------------------------------------------------ *
   * 从音频自动生成谱面
   * ------------------------------------------------------------------ */
  function toMono(buffer) {
    const ch = buffer.numberOfChannels || 1;
    const len = buffer.length;
    const out = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) out[i] += data[i];
    }
    if (ch > 1) {
      for (let i = 0; i < len; i++) out[i] /= ch;
    }
    return out;
  }

  function buildAutoChart(difficulty) {
    const a = app.autoAnalysis;
    if (!a) return null;
    return M4K.autochart.generate(a, {
      difficulty: difficulty,
      keyCount: 4,
      title: app.autoName || '自动生成',
      artist: '自动生成',
    });
  }

  async function loadAutoChart(file, difficulty) {
    setLoading('解码音频…');
    await nextTick();

    let buffer;
    try {
      buffer = await app.audio.decode(await file.arrayBuffer());
    } catch (e) {
      show('menu');
      msg('音频解码失败：' + e.message);
      return;
    }

    setLoading('分析节拍…');
    await nextTick();
    await new Promise(function (r) { setTimeout(r, 40); });

    let analysis;
    try {
      analysis = M4K.autochart.analyze(toMono(buffer), buffer.sampleRate, {});
    } catch (e) {
      show('menu');
      msg('分析失败：' + e.message);
      return;
    }

    app.autoAnalysis = analysis;
    app.autoName = file.name.replace(/\.[^.]+$/, '');
    app.audioBuffer = buffer;

    const chart = buildAutoChart(difficulty);
    if (!chart || !chart.notes.length) {
      show('menu');
      msg('这段音频里没找到能用的节拍 —— 换一首鼓点更清楚的试试');
      return;
    }
    app.chart = chart;
    enterReady();
  }

  function exportOsu() {
    const chart = app.chart;
    if (!chart || !chart.auto || !M4K.autochart) return;
    try {
      const name = app.autoName || 'autochart';
      const text = M4K.autochart.toOsu(chart, { audioFilename: name + '.mp3' });
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name + ' [' + (chart.meta && chart.meta.version ? chart.meta.version : 'Auto') + '].osu';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    } catch (e) {
      msg('导出失败：' + e.message);
    }
  }

  function exportReport() {
    if (!app.autoAnalysis || !M4K.autochart || !M4K.autochart.report) return;
    try {
      const name = app.autoName || 'autochart';
      const text = M4K.autochart.report(app.autoAnalysis, app.chart, { name: name + '.mp3' });
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name + '-分析报告.txt';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    } catch (e) {
      msg('导出失败：' + e.message);
    }
  }

  function regenerateAuto(difficulty) {
    if (!app.autoAnalysis) return;
    const chart = buildAutoChart(difficulty);
    if (!chart || !chart.notes.length) return;
    app.chart = chart;
    enterReady();
  }

  function enterReady() {
    const chart = app.chart;
    const meta = chart.meta;
    const holdCount = chart.notes.filter(function (n) { return n.isHold; }).length;
    const dur = app.audioBuffer ? app.audioBuffer.duration : 0;

    $('readyTitle').textContent = meta.title || '未命名';
    $('readyMeta').textContent = (meta.artist ? meta.artist + ' · ' : '') + (meta.version || '') +
      (meta.creator ? ' · by ' + meta.creator : '') +
      (app.demoFallback ? '　（内置音频没读到，用的是合成曲）' : '');

    const stats = $('readyStats');
    stats.innerHTML = '';
    const rows = [
      ['键数', chart.keyCount + 'K'],
      ['音符', String(chart.notes.length)],
      ['长条', String(holdCount)],
      ['时长', formatTime(dur)],
    ];
    if (chart.auto) {
      rows.push(['BPM', String(chart.auto.bpm)]);
      rows.push(['节拍偏移', chart.auto.offset + ' ms']);
    } else {
      rows.push(['难度 OD', (chart.difficulty.OverallDifficulty || '—')]);
    }
    rows.push(['键位', keyLabelsFor(keyCodesFor(chart.keyCount)).join(' ')]);

    rows.forEach(function (row) {
      const d = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = row[0];
      const dd = document.createElement('dd');
      dd.textContent = row[1];
      d.appendChild(dt);
      d.appendChild(dd);
      stats.appendChild(d);
    });

    app.keyCodes = keyCodesFor(chart.keyCount);
    const autoRow = $('autoRow');
    if (autoRow) autoRow.classList.toggle('hidden', !chart.auto);
    if (chart.auto) $('autoDiffReady').value = chart.auto.difficulty;
    setupMedia();
    app.renderer.setChart(chart);
    app.state = 'ready';
    show('ready');
    $('btnStart').focus();
  }

  /* ------------------------------------------------------------------ *
   * 播放
   * ------------------------------------------------------------------ */
  async function start() {
    if (!app.chart || !app.audioBuffer) return;
    try {
      await app.audio.ensure();
    } catch (e) {
      show('menu');
      msg('音频启动失败：' + e.message);
      return;
    }

    app.keyCodes = keyCodesFor(app.chart.keyCount);
    app.engine = new M4K.Engine(app.chart);
    app.keysDown = new Array(app.chart.keyCount).fill(false);
    app.lastFrame = null;
    app.finishingAt = 0;
    app.frozenSong = null;
    app.renderer.setChart(app.chart);
    app.renderer.reset();

    const v = app.media.video;
    if (v) {
      try { v.currentTime = 0; } catch (e) { /* ignore */ }
    }

    show(null);
    app.state = 'playing';
    app.audio.play(app.audioBuffer, 0);
  }

  async function pause() {
    if (app.state !== 'playing') return;
    await app.audio.pause();
    if (app.media.video) {
      try { app.media.video.pause(); } catch (e) { /* ignore */ }
    }
    app.state = 'pause';
    show('pause');
  }

  async function resume() {
    if (app.state !== 'pause') return;
    await app.audio.resume();
    app.lastFrame = null;
    app.state = 'playing';
    show(null);
    syncVideo(currentSong());
  }

  function finish() {
    app.state = 'results';
    // 结算页背后保留最后一帧画面，不要跳回开头
    app.frozenSong = app.lastFrame ? app.lastFrame.song : app.audio.now() + app.settings.offset;
    app.audio.stop();
    if (app.media.video) {
      try { app.media.video.pause(); } catch (e) { /* ignore */ }
    }
    app.lastFrame = null;

    const s = app.engine.stats;
    const grade = M4K.gradeFor(s.accuracy, s.miss);

    const g = $('grade');
    g.textContent = grade;
    g.className = 'grade g-' + grade;

    $('resultTitle').textContent = (app.chart.meta.title || '') + (app.chart.meta.version ? ' [' + app.chart.meta.version + ']' : '');
    $('resultMeta').textContent = app.chart.meta.artist || '';
    $('resultScore').textContent = M4K.formatScore(s.score);
    $('resultAcc').textContent = (s.accuracy * 100).toFixed(2) + '%';
    $('resultCombo').textContent = String(s.maxCombo);

    const counts = $('resultCounts');
    counts.innerHTML = '';
    [
      ['PERFECT', s.perfect, '#8fe3ff'],
      ['GREAT', s.great, '#7ef0a8'],
      ['GOOD', s.good, '#ffd166'],
      ['BAD', s.bad, '#ff9b52'],
      ['MISS', s.miss, '#ff5f74'],
      ['音符总数', s.total, '#93a2ba'],
    ].forEach(function (row) {
      const d = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = row[0];
      const dd = document.createElement('dd');
      dd.textContent = String(row[1]);
      dd.style.color = row[2];
      d.appendChild(dt);
      d.appendChild(dd);
      counts.appendChild(d);
    });

    show('results');
  }

  function quit() {
    app.audio.stop();
    if (app.media.video) {
      try { app.media.video.pause(); } catch (e) { /* ignore */ }
    }
    app.state = 'menu';
    app.engine = null;
    app.lastFrame = null;
    show('menu');
  }

  function currentSong() {
    if (app.state === 'debug') return app.debugSong;
    if (app.state === 'results' && typeof app.frozenSong === 'number') return app.frozenSong;
    if (app.state === 'playing' && app.lastFrame) return app.lastFrame.song;
    if (app.audio && app.audio.source) return app.audio.now() + app.settings.offset;
    return 0;
  }

  /* ------------------------------------------------------------------ *
   * 主循环
   * ------------------------------------------------------------------ */
  function loop(now) {
    requestAnimationFrame(loop);

    if (app.state === 'playing') {
      const song = app.audio.now() + app.settings.offset;
      app.lastFrame = { perf: now, song: song };

      const events = app.engine.update(song);
      for (let i = 0; i < events.length; i++) {
        if (events[i].type === 'miss') app.renderer.flash(M4K.JUDGEMENTS.miss);
        else if (events[i].type === 'holdbreak') app.renderer.flash(M4K.JUDGEMENTS.miss);
      }

      syncVideo(song);
      if (app.media.flv) {
        const p = app.media.flv;
        p.update(song - (app.chart.videoStart || 0));
        if (p.failed) {
          fallbackToImage();
        } else if (!p.canvas || p.canvas.width === 0) {
          if (!p._watch) p._watch = now;
          else if (now - p._watch > 2500) {
            console.warn('FLV 2.5 秒内没解出画面，退回背景图');
            fallbackToImage();
          }
        }
      }

      if (app.engine.finished && !app.finishingAt) {
        const last = app.chart.notes[app.chart.notes.length - 1];
        const endAt = last ? Math.max(last.time, last.end || 0) : song;
        app.finishingAt = endAt + 1200;
      }
      if (app.finishingAt && (song > app.finishingAt || app.audio.ended())) {
        finish();
      }
    }

    if (app.state === 'calib' && calib && app.audio.ctx) {
      const ctx = app.audio.ctx;
      const since = Math.max(0, ctx.currentTime - calib.t0);
      // 圆点只在「高音那一拍」闪，跟敲击目标一致
      const beatIdx = Math.floor(since / calib.beat);
      const inBar = ((beatIdx % calib.perBar) + calib.perBar) % calib.perBar;
      const phase = (since % calib.beat) / calib.beat;
      const k = inBar === calib.perBar - 1 ? Math.max(0, 1 - phase * 7) : 0;
      const el = $('calibCircle');
      if (el) {
        el.style.transform = 'scale(' + (1 + 0.3 * k).toFixed(3) + ')';
        el.style.opacity = (0.25 + 0.75 * k).toFixed(3);
      }
      if (!calib.done && since > CALIB.bars * calib.barSec) finishCalibration();
    }

    render();
  }

  function render() {
    const showField = app.state === 'playing' || app.state === 'pause' || app.state === 'results' || app.state === 'debug';
    app.renderer.draw({
      engine: showField && app.engine ? app.engine : null,
      songTime: currentSong(),
      keysDown: app.keysDown,
      scrollMs: app.settings.scroll,
      chart: app.chart,
      media: app.media.video || app.media.image || null,
      bgDim: Math.max(0, Math.min(0.95, (app.settings.dim || 0) / 100)),
      keyLabels: keyLabelsFor(app.keyCodes),
      duration: app.audioBuffer ? app.audioBuffer.duration * 1000 : 0,
    });
  }

  /* ------------------------------------------------------------------ *
   * 延迟校准：跟着节拍敲，测出你平时的偏差
   * ------------------------------------------------------------------ */
  // 每小节 4 拍，只有第 4 拍是高音；玩家只在高音上敲。
  // 这样即使延迟接近一拍，也不会吸附到隔壁拍上去。
  const CALIB = { beat: 0.5, perBar: 4, bars: 14, warmupBars: 2, need: 8 };
  let calib = null;

  function scheduleClick(ctx, at, high) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = high ? 1650 : 620;
    const peak = high ? 0.30 : 0.20;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + (high ? 0.10 : 0.07));
    osc.connect(gain);
    gain.connect(app.audio.gain || ctx.destination);
    osc.start(at);
    osc.stop(at + 0.12);
  }

  async function startCalibration() {
    try {
      await app.audio.ensure();
    } catch (e) {
      msg('音频启动失败：' + e.message);
      return;
    }
    app.audio.stop();

    const ctx = app.audio.ctx;
    const t0 = ctx.currentTime + 1.6;
    const barSec = CALIB.beat * CALIB.perBar;

    calib = {
      t0: t0,
      beat: CALIB.beat,
      perBar: CALIB.perBar,
      barSec: barSec,
      taps: [],
      done: false,
      result: null,
    };

    // 每小节 4 拍：前 3 拍是低音（只做参考），第 4 拍高音（要敲的就是它）
    for (let bar = 0; bar < CALIB.bars; bar++) {
      for (let k = 0; k < CALIB.perBar; k++) {
        scheduleClick(ctx, t0 + (bar * CALIB.perBar + k) * CALIB.beat, k === CALIB.perBar - 1);
      }
    }

    app.state = 'calib';
    show('calib');
    $('btnCalibApply').disabled = true;
    $('calibCount').textContent = '0 / ' + CALIB.need;
    $('calibInfo').textContent = '每小节第 4 拍会响一个高音，只在高音时敲';
  }

  function finishCalibration() {
    if (!calib || calib.done) return;
    // 高音出现在每小节最后一拍，所以吸附周期是「一小节」而不是一拍
    const firstHigh = calib.t0 + (CALIB.perBar - 1) * calib.beat;
    const r = M4K.calibrationOffset(calib.taps, firstHigh, calib.barSec);
    calib.done = true;
    calib.result = r;
    $('btnCalibApply').disabled = false;

    const sign = r.offset >= 0 ? '+' : '';
    let text = '平均偏差 ' + sign + Math.round(r.offset) + ' ms（波动 ' + Math.round(r.spread) + ' ms）';
    if (r.spread > 70) text += '　波动偏大，建议重来一次';
    if (Math.abs(r.offset) > 200) text += '　偏差过大，检查一下耳机/音箱延迟';
    $('calibInfo').textContent = text;
  }

  function applyCalibration() {
    if (!calib || !calib.result) return;
    const next = Math.max(-300, Math.min(300, Math.round(app.settings.offset - calib.result.offset)));
    app.settings.offset = next;
    saveSettings();
    $('setOffset').value = next;
    endCalibration();
  }

  function endCalibration() {
    calib = null;
    if (app.chart) {
      app.state = 'ready';
      show('ready');
    } else {
      app.state = 'menu';
      show('menu');
    }
  }

  /* ------------------------------------------------------------------ *
   * 输入
   * ------------------------------------------------------------------ */
  function judgeTimeForEvent(timeStamp) {
    const lf = app.lastFrame;
    if (!lf) return app.audio.now() + app.settings.offset;
    return lf.song + (timeStamp - lf.perf);
  }

  function onKeyDown(e) {
    if (e.repeat) return;

    if (app.state === 'calib') {
      e.preventDefault();
      if (!calib || calib.done) return;
      const t = app.audio.ctx.currentTime;
      // 前两小节是适应期，不计
      if (t < calib.t0 + CALIB.warmupBars * calib.barSec - 0.3) return;
      calib.taps.push(t);
      $('calibCount').textContent = calib.taps.length + ' / ' + CALIB.need;
      if (calib.taps.length >= CALIB.need) finishCalibration();
      return;
    }

    if (e.code === 'Escape') {
      if (app.state === 'playing') { pause(); return; }
      if (app.state === 'pause') { resume(); return; }
    }

    if (e.code === 'Space' && app.state === 'ready') {
      e.preventDefault();
      start();
      return;
    }

    if (app.state === 'results' && (e.code === 'Space' || e.code === 'Enter')) {
      e.preventDefault();
      start();
      return;
    }

    if (app.state !== 'playing') return;

    const idx = app.keyCodes.indexOf(e.code);
    if (idx < 0) return;
    e.preventDefault();
    if (app.keysDown[idx]) return;

    app.keysDown[idx] = true;
    const res = app.engine.press(idx, judgeTimeForEvent(e.timeStamp));
    if (res) {
      app.renderer.flash(res.judgement);
      app.renderer.addHit(res.delta, res.judgement);
    }
  }

  function onKeyUp(e) {
    if (app.state !== 'playing') return;
    const idx = app.keyCodes.indexOf(e.code);
    if (idx < 0) return;
    e.preventDefault();
    app.keysDown[idx] = false;
    const res = app.engine.release(idx, judgeTimeForEvent(e.timeStamp));
    if (res && res.type === 'holdbreak') app.renderer.flash(M4K.JUDGEMENTS.miss);
  }

  /* ------------------------------------------------------------------ *
   * zip / 工具
   * ------------------------------------------------------------------ */
  function nextTick() {
    return new Promise(function (r) { setTimeout(r, 20); });
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    let eocd = -1;
    const stop = Math.max(0, u8.length - 22 - 65535);
    for (let i = u8.length - 22; i >= stop; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    const out = [];

    for (let i = 0; i < count; i++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      if (name.charAt(name.length - 1) === '/') continue;
      if (localOff + 30 > u8.length) continue;

      const lhNameLen = dv.getUint16(localOff + 26, true);
      const lhExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
      if (dataStart + compSize > u8.length) continue;
      const raw = u8.subarray(dataStart, dataStart + compSize);

      let bytes;
      if (method === 0) bytes = raw;
      else if (method === 8) bytes = await inflateRaw(raw);
      else continue;

      out.push([name, bytes]);
    }
    return out;
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function readEntry(entry, depth) {
    return new Promise(function (resolve) {
      if (!entry || (depth || 0) > 4) return resolve();
      if (entry.isFile) {
        entry.file(function (f) { collectFiles([f]); resolve(); }, function () { resolve(); });
        return;
      }
      if (!entry.isDirectory) return resolve();

      const reader = entry.createReader();
      const all = [];
      const readBatch = function () {
        reader.readEntries(function (batch) {
          if (!batch || !batch.length) {
            Promise.all(all.map(function (en) { return readEntry(en, (depth || 0) + 1); })).then(function () { resolve(); });
            return;
          }
          for (let i = 0; i < batch.length; i++) all.push(batch[i]);
          readBatch();
        }, function () { resolve(); });
      };
      readBatch();
    });
  }

  /* ------------------------------------------------------------------ *
   * 绑定
   * ------------------------------------------------------------------ */
  function bindUi() {
    $('btnFile').addEventListener('click', function () { $('fileInput').click(); });
    $('btnDir').addEventListener('click', function () { $('dirInput').click(); });
    $('btnDemo').addEventListener('click', function () { loadDemo(); });
    $('btnStart').addEventListener('click', start);
    $('btnBack').addEventListener('click', function () { show('menu'); });
    $('btnResume').addEventListener('click', resume);
    $('btnRetry').addEventListener('click', start);
    $('btnRetry2').addEventListener('click', start);
    $('btnQuit').addEventListener('click', quit);
    $('btnResultsBack').addEventListener('click', quit);

    $('fileInput').addEventListener('change', function (e) {
      if (!e.target.files || !e.target.files.length) return;
      collectFiles(e.target.files);
      e.target.value = '';
      onFilesReady();
    });

    $('dirInput').addEventListener('change', function (e) {
      if (!e.target.files || !e.target.files.length) return;
      collectFiles(e.target.files);
      e.target.value = '';
      onFilesReady();
    });

    $('btnAuto').addEventListener('click', function () { $('autoInput').click(); });
    $('autoInput').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      loadAutoChart(f, $('autoDiffMenu').value);
    });
    $('autoDiffReady').addEventListener('change', function (e) {
      regenerateAuto(e.target.value);
    });
    $('btnExport').addEventListener('click', exportOsu);
    $('btnReport').addEventListener('click', exportReport);
    $('btnCalib').addEventListener('click', startCalibration);
    $('btnCalibApply').addEventListener('click', applyCalibration);
    $('btnCalibAgain').addEventListener('click', startCalibration);
    $('btnCalibCancel').addEventListener('click', endCalibration);

    $('setOffset').addEventListener('change', function (e) {
      app.settings.offset = Math.max(-300, Math.min(300, Math.round(Number(e.target.value) || 0)));
      e.target.value = app.settings.offset;
      saveSettings();
    });
    $('setScroll').addEventListener('change', function (e) {
      app.settings.scroll = Math.max(300, Math.min(1600, Math.round(Number(e.target.value) || 700)));
      e.target.value = app.settings.scroll;
      saveSettings();
    });
    $('setVolume').addEventListener('input', function (e) {
      app.settings.volume = Math.round(Number(e.target.value) || 0);
      app.audio.setVolume(app.settings.volume / 100);
      saveSettings();
    });
    $('setDim').addEventListener('input', function (e) {
      app.settings.dim = Math.round(Number(e.target.value) || 0);
      saveSettings();
    });

    window.addEventListener('resize', function () { app.renderer.resize(); });
    window.addEventListener('blur', function () { if (app.state === 'playing') pause(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && app.state === 'playing') pause();
    });
    window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function bindInput() {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
  }

  function bindDrop() {
    const dz = $('drop');
    let depth = 0;

    window.addEventListener('dragenter', function (e) {
      e.preventDefault();
      depth++;
      dz.classList.add('over');
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function (e) {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (!depth) dz.classList.remove('over');
    });
    window.addEventListener('drop', async function (e) {
      e.preventDefault();
      depth = 0;
      dz.classList.remove('over');
      if (app.state === 'playing') return;

      const dt = e.dataTransfer;
      if (!dt) return;

      if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
        const entries = [];
        for (let i = 0; i < dt.items.length; i++) {
          const en = dt.items[i].webkitGetAsEntry && dt.items[i].webkitGetAsEntry();
          if (en) entries.push(en);
        }
        for (let i = 0; i < entries.length; i++) await readEntry(entries[i], 0);
      } else if (dt.files) {
        collectFiles(dt.files);
      }
      onFilesReady();
    });
  }

  function applySettingsToUi() {
    $('setOffset').value = app.settings.offset;
    $('setScroll').value = app.settings.scroll;
    $('setVolume').value = app.settings.volume;
    $('setDim').value = app.settings.dim;
    app.audio.setVolume(app.settings.volume / 100);
  }

  /* ------------------------------------------------------------------ *
   * 调试：?debug=field 直接画一帧游戏画面（用于无头截图验证）
   *       ?bg=1 造一张假背景图，用来看背景压暗效果
   *       ?shot=http://127.0.0.1:PORT/shot 把这一帧 PNG POST 出去
   * ------------------------------------------------------------------ */
  function fakeBackdrop() {
    const c = document.createElement('canvas');
    c.width = 1920;
    c.height = 1080;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 1920, 1080);
    grad.addColorStop(0, '#2b1d4e');
    grad.addColorStop(0.45, '#7a2f5a');
    grad.addColorStop(1, '#1b2a55');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1920, 1080);
    g.fillStyle = 'rgba(255,215,150,0.55)';
    g.beginPath();
    g.arc(1450, 260, 220, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(120,220,255,0.35)';
    for (let i = 0; i < 9; i++) {
      const h = 120 + (i % 4) * 90;
      g.fillRect(120 + i * 180, 1080 - h, 90, h);
    }
    return c;
  }

  function debugField() {
    const demo = M4K.demo.build();
    const chart = M4K.parseOsu(demo.text);
    app.chart = chart;
    app.engine = new M4K.Engine(chart);
    app.keyCodes = keyCodesFor(chart.keyCount);
    app.keysDown = new Array(chart.keyCount).fill(false);
    app.renderer.setChart(chart);

    const t = 1600 + 400 * 10.4;
    for (let i = 0; i < 14; i++) {
      const n = chart.notes[i];
      if (!n) continue;
      const off = i % 4 === 0 ? 4 : i % 4 === 1 ? 22 : i % 4 === 2 ? 60 : 95;
      app.engine.press(n.col, n.time + off);
      app.renderer.addHit(off, M4K.JUDGEMENTS[off < 25 ? 'perfect' : off < 45 ? 'great' : off < 80 ? 'good' : 'bad']);
    }
    app.engine.update(t);

    app.keysDown[1] = true;
    app.debugSong = t;
    app.renderer.flash(M4K.JUDGEMENTS.perfect);
    app.state = 'debug';
    show(null);
    render();
    document.body.dataset.debug = 'field';
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  /** 把当前 canvas 编码成 PNG，POST 到一个本地服务（只用于开发时截图） */
  function sendShot(url) {
    function post(text) {
      try {
        fetch(url, { method: 'POST', mode: 'no-cors', body: text }).catch(function () {});
      } catch (e) { /* ignore */ }
    }

    function grab(tag) {
      try {
        const canvas = $('scene');
        post('STEP ' + tag + ' ' + canvas.width + 'x' + canvas.height);
        const data = canvas.toDataURL('image/png');
        const b64 = data.split(',')[1] || '';
        post('LEN ' + tag + ' ' + b64.length);
        post('PNG ' + b64);
      } catch (e) {
        post('ERR ' + tag + ' ' + (e && e.message ? e.message : e));
      }
    }

    post('BOOT state=' + app.state + ' w=' + $('scene').clientWidth + ' h=' + $('scene').clientHeight);
    grab('now');
    setTimeout(function () {
      if (app.renderer) app.renderer.flash(M4K.JUDGEMENTS.perfect);
      grab('later');
    }, 700);
  }

  function init() {
    app.audio = new M4K.AudioClock();
    app.renderer = new M4K.Renderer($('scene'));
    app.renderer.resize();

    bindUi();
    bindInput();
    bindDrop();
    applySettingsToUi();

    const params = new URLSearchParams(location.search);
    if (params.get('debug') === 'field') {
      debugField();
    } else {
      show('menu');
    }

    if (params.get('bg') === '1') {
      app.media = { image: fakeBackdrop(), video: null, url: null };
    }

    const shotUrl = params.get('shot');
    if (shotUrl) sendShot(shotUrl);

    requestAnimationFrame(loop);
    document.body.dataset.boot = 'ok';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 给调试/自动化留个把手
  window.__rhythm4k = app;
  window.__rhythm4kDebug = {
    calib: function () { return calib; },
    setupMedia: setupMedia,
    teardownMedia: teardownMedia,
    syncVideo: function () { syncVideo(currentSong()); },
  };
})();
