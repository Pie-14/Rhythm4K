/*
 * demo.js — 内置示例曲
 * 音频用程序合成（不需要任何素材文件），谱面用一段真实 .osu 文本，
 * 这样第一次运行也能立刻验证解析 / 判定 / 播放整条链路。
 */
(function (root) {
  'use strict';
  const M4K = (root.M4K = root.M4K || {});

  const BPM = 150;
  const BEAT = 60000 / BPM; // 400ms
  const LEAD_IN = 1600; // 4 拍前奏
  const X = [64, 192, 320, 448];

  /** 生成谱面对象列表（同时用于绘制和合成音频） */
  function buildObjects() {
    const objs = []; // {time, col, end}
    const push = (beat, col, holdBeats) => {
      const time = LEAD_IN + beat * BEAT;
      const end = holdBeats ? time + holdBeats * BEAT : null;
      objs.push({ time: time, col: col % 4, end: end });
    };

    // A：16 拍，四分音符滚动
    const A = [0, 2, 1, 3, 0, 1, 2, 3];
    for (let i = 0; i < 16; i++) push(i, A[i % 8]);

    // B：16 拍，八分音符
    for (let i = 0; i < 16; i++) {
      const c1 = A[i % 8];
      push(16 + i, c1);
      push(16 + i + 0.5, (c1 + 2) % 4);
    }

    // C：16 拍，长条 + 补充音
    for (let i = 0; i < 16; i += 4) {
      push(32 + i, (i / 4) % 4, 2);
      push(32 + i + 1, ((i / 4) % 4) + 1);
      push(32 + i + 2, ((i / 4) % 4) + 2);
      push(32 + i + 3, ((i / 4) % 4) + 3);
    }

    // D：16 拍，带 jack 的结尾
    const D = [0, 0, 2, 3, 1, 1, 3, 2];
    for (let i = 0; i < 16; i++) push(48 + i, D[i % 8]);
    push(63, 3, 1); // 收尾长条

    objs.sort((a, b) => a.time - b.time);
    return objs;
  }

  /** 用对象列表拼出一段合法的 .osu v14 mania 谱面文本 */
  function buildOsuText(objs) {
    const L = [];
    L.push('osu file format v14', '');
    L.push('[General]');
    L.push('AudioFilename: demo.wav');
    L.push('AudioLeadIn: 0');
    L.push('PreviewTime: 8000');
    L.push('Countdown: 0');
    L.push('SampleSet: Soft');
    L.push('Mode: 3');
    L.push('');
    L.push('[Metadata]');
    L.push('Title:Neon Tutorial');
    L.push('TitleUnicode:Neon Tutorial');
    L.push('Artist:Rhythm4K');
    L.push('ArtistUnicode:Rhythm4K');
    L.push('Creator:built-in');
    L.push('Version:4K Demo');
    L.push('');
    L.push('[Difficulty]');
    L.push('HPDrainRate:8');
    L.push('CircleSize:4');
    L.push('OverallDifficulty:8');
    L.push('ApproachRate:5');
    L.push('SliderMultiplier:1.4');
    L.push('SliderTickRate:1');
    L.push('');
    L.push('[TimingPoints]');
    L.push('0,400,4,2,0,100,1,0');
    L.push('');
    L.push('[HitObjects]');
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      const x = X[o.col];
      if (o.end) L.push(x + ',192,' + Math.round(o.time) + ',128,0,' + Math.round(o.end) + ':0:0:0:0:');
      else L.push(x + ',192,' + Math.round(o.time) + ',1,0,0:0:0:0:');
    }
    return L.join('\n') + '\n';
  }

  /* ------------------------------------------------------------------ *
   * 音频合成
   * ------------------------------------------------------------------ */
  const TAU = Math.PI * 2;
  const SCALE = [110, 130.81, 146.83, 164.81]; // A2 C3 D3 E3
  const PLUCK = [523.25, 587.33, 659.25, 783.99]; // C5 D5 E5 G5（四列的落点音）

  function buildAudio(ctx, objs) {
    const sr = ctx.sampleRate;
    const last = objs.length ? objs[objs.length - 1].time + 1500 : 6000;
    const len = Math.ceil((last / 1000) * sr);
    const buf = ctx.createBuffer(2, len, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);

    let seed = 987654321;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };

    function kick(t, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.24 * sr);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const sec = i / sr;
        const env = Math.exp(-sec / 0.055);
        const f = 42 + 112 * Math.exp(-sec / 0.012);
        phase += (TAU * f) / sr;
        const s = Math.sin(phase) * env * gain;
        L[idx] += s;
        R[idx] += s;
      }
    }

    function snare(t, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.18 * sr);
      let prev = 0;
      let tone = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const sec = i / sr;
        const env = Math.exp(-sec / 0.04);
        const noise = rnd();
        const hp = noise - prev;
        prev = noise;
        tone += (TAU * 185) / sr;
        const s = (hp * 0.6 + Math.sin(tone) * 0.25) * env * gain;
        L[idx] += s;
        R[idx] += s * 0.85;
      }
    }

    function hat(t, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.05 * sr);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const env = Math.exp(-(i / sr) / 0.012);
        const noise = rnd();
        const s = (noise - prev) * 0.5 * env * gain;
        prev = noise;
        L[idx] += s * 0.9;
        R[idx] += s;
      }
    }

    function bass(t, freq, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.3 * sr);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const sec = i / sr;
        const env = Math.min(1, sec / 0.008) * Math.exp(-sec / 0.12);
        phase += (TAU * freq) / sr;
        const s = (Math.sin(phase) + 0.35 * Math.sin(phase * 2)) * env * gain;
        L[idx] += s;
        R[idx] += s;
      }
    }

    function pluck(t, freq, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.16 * sr);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const sec = i / sr;
        const env = Math.exp(-sec / 0.035);
        phase += (TAU * freq) / sr;
        const s = (Math.sin(phase) + 0.3 * Math.sin(phase * 3)) * env * gain;
        L[idx] += s * 0.8;
        R[idx] += s;
      }
    }

    // 鼓组：每拍底鼓，2/4 拍军鼓，八分音符 hi-hat
    const beats = Math.ceil((last - LEAD_IN) / BEAT);
    for (let b = 0; b < beats; b++) {
      const t = (LEAD_IN + b * BEAT) / 1000;
      kick(t, 0.5);
      if (b % 4 === 2 || b % 4 === 3) snare(t, 0.2);
      hat(t, 0.085);
      hat((LEAD_IN + b * BEAT + BEAT / 2) / 1000, 0.055);
      bass(t, SCALE[b % SCALE.length], 0.2);
    }

    // 每个音符一个落点音，方便确认判定与听觉对得上
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      pluck(o.time / 1000, PLUCK[o.col], 0.15);
      if (o.end) pluck(o.end / 1000, PLUCK[o.col] * 1.5, 0.1);
    }

    // 防削波
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const a = Math.abs(L[i]);
      if (a > peak) peak = a;
      const b2 = Math.abs(R[i]);
      if (b2 > peak) peak = b2;
    }
    if (peak > 0.9) {
      const k = 0.9 / peak;
      for (let i = 0; i < len; i++) {
        L[i] *= k;
        R[i] *= k;
      }
    }

    return buf;
  }

  M4K.demo = {
    build: function () {
      const objs = buildObjects();
      const text = buildOsuText(objs);
      return { text: text, objects: objs };
    },
    buildAudio: buildAudio,
    bpm: BPM,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
