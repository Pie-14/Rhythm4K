/*
 * demo.js — 内置示例曲「NEON OVERDRIVE」
 *
 * 音频完全由程序合成（不需要任何素材文件），风格是 175 BPM 的硬核 / 硬派电子。
 * 谱面是手排的，跟着同一份鼓点时间轴走 —— 音频和谱面共用一份 timeline，
 * 所以「听到什么就有什么音符」，不会错位。
 */
(function (root) {
  'use strict';
  const M4K = (root.M4K = root.M4K || {});

  const TAU = Math.PI * 2;

  const BPM = 175;
  const BEAT = 60000 / BPM;   // ≈342.86ms
  const BAR = BEAT * 4;       // ≈1371.4ms
  const LEAD_IN = BEAT * 2;   // 两拍前奏
  const BARS = 30;            // 30 小节 ≈ 41 秒

  // 四个音轨上常用的音型
  const PAT = {
    up: [0, 1, 2, 3],
    down: [3, 2, 1, 0],
    zig: [0, 2, 1, 3],
    trill: [1, 2, 1, 2],
    jack: [0, 0, 2, 2],
    stair: [0, 1, 2, 3, 2, 1, 0, 1],
  };

  /**
   * 整首曲子的时间轴：同时产出「谱面音符」和「鼓组事件」。
   * 两者用同一套 beat 坐标，保证音画一致。
   */
  function buildTimeline() {
    const notes = [];
    const drums = [];

    const at = (beat) => LEAD_IN + beat * BEAT;

    // 同一时刻同一轨只允许一个音：手排的插音偶尔会撞上连打循环，
    // 撞了就自动挪到最近的空轨，四轨全满则丢弃。
    const occupied = new Set();

    function note(beat, col, holdBeats) {
      const t = at(beat);
      let c = ((col % 4) + 4) % 4;
      const key = (x) => Math.round(t) + ':' + x;
      if (occupied.has(key(c))) {
        let found = -1;
        for (let k = 1; k <= 4; k++) {
          const nc = (c + k) % 4;
          if (!occupied.has(key(nc))) { found = nc; break; }
        }
        if (found < 0) return;
        c = found;
      }
      occupied.add(key(c));
      notes.push({ time: t, col: c, end: holdBeats ? t + holdBeats * BEAT : null });
    }
    function drum(kind, beat, gain) {
      drums.push({ kind: kind, time: at(beat), gain: gain });
    }

    /** 一小节的鼓组：4 拍底鼓 + 2/4 拍军鼓 + 踩镲 */
    function barDrums(b0, opts) {
      const o = opts || {};
      const kickGain = o.kickGain === undefined ? 1 : o.kickGain;
      for (let k = 0; k < 4; k++) {
        if (o.kick !== false) drum('kick', b0 + k, kickGain);
        if (o.hat !== false) drum('hat', b0 + k, o.hatGain || 0.10);
        if (o.hat16) drum('hat', b0 + k + 0.5, (o.hatGain || 0.10) * 0.7);
      }
      if (o.clap !== false) {
        drum('clap', b0 + 1, 0.30);
        drum('clap', b0 + 3, 0.30);
      }
      if (o.hat16) {
        for (let k = 0; k < 4; k++) {
          drum('hat', b0 + k + 0.25, (o.hatGain || 0.10) * 0.45);
          drum('hat', b0 + k + 0.75, (o.hatGain || 0.10) * 0.45);
        }
      }
    }

    /* ---------- 0~3 小节：前奏 ---------- */
    for (let bar = 0; bar < 4; bar++) {
      const b0 = bar * 4;
      if (bar < 2) {
        drum('kick', b0, 0.85);
        drum('kick', b0 + 2, 0.85);
        for (let k = 0; k < 4; k++) drum('hat', b0 + k, 0.09);
        note(b0, 1);
        note(b0 + 2, 2);
      } else {
        barDrums(b0, { kickGain: 0.95, hatGain: 0.10 });
        for (let k = 0; k < 4; k++) note(b0 + k, PAT.up[k]);
      }
    }

    /* ---------- 4~7 小节：build ---------- */
    for (let bar = 4; bar < 8; bar++) {
      const b0 = bar * 4;
      barDrums(b0, { kickGain: 1, hatGain: 0.10, hat16: true });
      if (bar === 4) drum('riser', b0, 0.55);

      if (bar === 7) {
        // 最后一小节：军鼓滚奏收尾，谱面用八分连打（十六分留给后面 32 分那下）
        for (let k = 0; k < 8; k++) {
          drum('snare', b0 + k * 0.5, 0.10 + k * 0.02);
          note(b0 + k * 0.5, k % 2 ? 3 : 0);
        }
      } else {
        // 八分音符，但留出空档，build 不该比 drop 还密
        const steps = [0, 0.5, 1, 2, 2.5, 3];
        for (let k = 0; k < steps.length; k++) note(b0 + steps[k], PAT.stair[k]);
      }
    }

    /* ---------- 8~15 小节：drop A ---------- */
    for (let bar = 8; bar < 16; bar++) {
      const b0 = bar * 4;
      barDrums(b0, { kickGain: 1, hatGain: 0.11, hat16: true });
      if (bar % 4 === 0) drum('crash', b0, 0.5);

      // 贝斯走反拍
      for (let k = 0; k < 4; k++) drum('bass', b0 + k + 0.5, 0.5);
      // 和弦铺底：让旋律有个和声背景
      drum('chord', b0, 0.12);
      // 和弦重音
      if (bar % 4 === 0 || bar % 4 === 2) drum('stab', b0, 0.4);

      // 谱面：密集小节 8 个音、留白小节 6 个音，交替着来；
      // 只有整段最后一小节用十六分收尾。
      let steps;
      if (bar % 4 === 3 && bar === 15) {
        steps = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75,
                 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75];
      } else if (bar % 2 === 0) {
        steps = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
      } else {
        steps = [0, 0.5, 1.5, 2.5, 3];
      }
      const shift = bar % 2 === 0 ? 0 : 2;
      for (let k = 0; k < steps.length; k++) {
        note(b0 + steps[k], (k % 4 + shift) % 4);
      }
      // 每 4 小节的第一拍加一个双押，重音更明确（不是每小节都加）
      if (bar % 4 === 0) note(b0, 3);

      if (bar === 9 || bar === 13) {
        // 长条：盖住两拍
        note(b0 + 2, (bar + 1) % 4, 2);
      }
      if (bar === 11) {
        // 半拍插音，做一点变化
        note(b0 + 1.5, 2);
        note(b0 + 2.5, 0);
      }
    }

    /* ---------- 16~19 小节：break ---------- */
    for (let bar = 16; bar < 20; bar++) {
      const b0 = bar * 4;
      drum('pad', b0, 0.22);
      for (let k = 0; k < 4; k++) drum('hat', b0 + k, 0.07);
      drum('clap', b0 + 3, 0.22);

      // 稀疏：四分音符 + 一条两拍长条
      note(b0, bar % 4);
      note(b0 + 1, (bar + 1) % 4);
      if (bar === 17) note(b0 + 2, 3, 1.5);
      else note(b0 + 2, (bar + 2) % 4);
    }

    /* ---------- 20~27 小节：drop B（更狠） ---------- */
    for (let bar = 20; bar < 28; bar++) {
      const b0 = bar * 4;
      barDrums(b0, { kickGain: 1.05, hatGain: 0.11, hat16: true });
      if (bar === 20) drum('crash', b0, 0.6);
      for (let k = 0; k < 4; k++) drum('bass', b0 + k + 0.5, 0.55);
      drum('chord', b0, 0.13);
      drum('stab', b0, 0.45);

      if (bar === 23) {
        // 底鼓滚奏：只做两拍，谱面八分连打
        for (let k = 0; k < 8; k++) {
          drum('kick', b0 + k * 0.25, 0.7);
          note(b0 + k * 0.25, k % 2 ? 1 : 3);
        }
      } else if (bar % 4 === 3) {
        // 每四小节末尾一个 trill，给手一点挑战
        for (let k = 0; k < 8; k++) note(b0 + k * 0.5, PAT.trill[k % 4]);
      } else {
        // 八分主音流，留白小节减少一点
        const steps = bar % 2 === 0
          ? [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
          : [0, 0.5, 1.5, 2.5, 3];
        const shift = bar % 2 === 0 ? 1 : 3;
        for (let k = 0; k < steps.length; k++) {
          note(b0 + steps[k], (k % 4 + shift) % 4);
        }
        if (bar % 4 === 1) note(b0 + 2, 0, 1.5);
      }
    }

    /* ---------- 28~29 小节：收尾 ---------- */
    for (let bar = 28; bar < BARS; bar++) {
      const b0 = bar * 4;
      barDrums(b0, { kickGain: 1.1, hatGain: 0.10 });
      drum('crash', b0, 0.6);
      if (bar === 29) {
        // 最后一小节：只有底鼓，谱面落到一条长条上
        drum('kick', b0 + 2, 1.1);
        note(b0 + 2, 1, 2);
      } else {
        for (let k = 0; k < 4; k++) note(b0 + k, PAT.down[k]);
      }
    }

    notes.sort((a, b) => a.time - b.time);

    // 长条占着的那条轨道，期间不能再有别的音 —— 否则玩家一按就把长条打断，
    // 手感和判定都会乱（机器人全自动跑的时候也会漏）。
    const clean = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      let blocked = false;
      for (let k = 0; k < clean.length; k++) {
        const o = clean[k];
        if (o.col !== n.col || o.end === null) continue;
        if (n.time > o.time && n.time < o.end) { blocked = true; break; }
      }
      if (!blocked) clean.push(n);
    }
    notes.length = 0;
    for (let i = 0; i < clean.length; i++) notes.push(clean[i]);

    drums.sort((a, b) => a.time - b.time);

    const end = at(BARS * 4) + 900;
    return { notes: notes, drums: drums, duration: end };
  }

  let cached = null;
  function timeline() {
    if (!cached) cached = buildTimeline();
    return cached;
  }

  /** 用时间轴拼出一段合法的 .osu v14 mania 谱面文本 */
  function buildOsuText(notes) {
    const L = [];
    L.push('osu file format v14', '');
    L.push('[General]');
    L.push('AudioFilename: demo.wav');
    L.push('AudioLeadIn: 0');
    L.push('PreviewTime: 12000');
    L.push('Countdown: 0');
    L.push('SampleSet: Soft');
    L.push('Mode: 3');
    L.push('');
    L.push('[Metadata]');
    L.push('Title:NEON OVERDRIVE');
    L.push('TitleUnicode:NEON OVERDRIVE');
    L.push('Artist:Rhythm4K');
    L.push('ArtistUnicode:Rhythm4K');
    L.push('Creator:built-in');
    L.push('Version:4K Hardcore');
    L.push('Source:');
    L.push('Tags:demo hardcore 4k');
    L.push('BeatmapID:0');
    L.push('BeatmapSetID:-1');
    L.push('');
    L.push('[Difficulty]');
    L.push('HPDrainRate:7');
    L.push('CircleSize:4');
    L.push('OverallDifficulty:8');
    L.push('ApproachRate:5');
    L.push('SliderMultiplier:1.4');
    L.push('SliderTickRate:1');
    L.push('');
    L.push('[Events]');
    L.push('');
    L.push('[TimingPoints]');
    L.push('0,' + (60000 / BPM).toFixed(3) + ',4,2,0,70,1,0');
    L.push('');
    L.push('[HitObjects]');

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const x = [64, 192, 320, 448][n.col] || 64;
      const t = Math.round(n.time);
      if (n.end === null) {
        L.push(x + ',192,' + t + ',1,0,0:0:0:0:');
      } else {
        L.push(x + ',192,' + t + ',128,0,' + Math.round(n.end) + ':0:0:0:0:');
      }
    }
    return L.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 音频合成
   * ------------------------------------------------------------------ */
  function buildAudio(ctx, unusedObjs) {
    const tl = timeline();
    const sr = ctx.sampleRate;
    const len = Math.ceil((tl.duration / 1000) * sr);
    const buf = ctx.createBuffer(2, len, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);

    let seed = 20240607;
    function noise() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    }
    const tanh = (x) => {
      const e = Math.exp(2 * x);
      return (e - 1) / (e + 1);
    };

    // 底鼓：音高急速下滑 + 软削波，硬核那种「砰」
    function kick(t, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.26 * sr);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const sec = i / sr;
        const env = Math.exp(-sec / 0.075);
        const f = 46 + 165 * Math.exp(-sec / 0.016);
        phase += (TAU * f) / sr;
        let s = Math.sin(phase) * env;
        s = tanh(s * 2.6) * 0.82;             // 失真，给出冲击感
        // 起音的那一下「咔」
        s += noise() * Math.exp(-sec / 0.004) * 0.35;
        L[idx] += s * gain * 0.55;
        R[idx] += s * gain * 0.55;
      }
    }

    function clap(t, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.16 * sr);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const sec = i / sr;
        // 三次快速的「啪」
        const env = Math.exp(-sec / 0.045) * (0.55 + 0.45 * Math.sin(sec * 380));
        const x = noise();
        const hp = x - prev;
        prev = x;
        const s = hp * env * gain;
        L[idx] += s * 0.9;
        R[idx] += s;
      }
    }

    function snare(t, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.11 * sr);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const sec = i / sr;
        const env = Math.exp(-sec / 0.032);
        const x = noise();
        const hp = x - prev;
        prev = x;
        const s = hp * env * gain;
        L[idx] += s * 0.85;
        R[idx] += s;
      }
    }

    function hat(t, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.045 * sr);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const env = Math.exp(-(i / sr) / 0.009);
        const x = noise();
        const s = (x - prev) * env * gain;
        prev = x;
        L[idx] += s * 0.95;
        R[idx] += s;
      }
    }

    function crash(t, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(1.1 * sr);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const sec = i / sr;
        const env = Math.exp(-sec / 0.35);
        const x = noise();
        const s = (x - prev) * env * gain * 0.5;
        prev = x;
        L[idx] += s;
        R[idx] += s * 0.92;
      }
    }

    // 反拍贝斯：方波 + 短衰减，带一点泵感
    function bass(t, freq, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.22 * sr);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const sec = i / sr;
        const env = Math.min(1, sec / 0.006) * Math.exp(-sec / 0.075);
        phase += (TAU * freq) / sr;
        // 方波的廉价近似：正弦 + 三次谐波
        let s = Math.sin(phase) + 0.45 * Math.sin(phase * 3) + 0.22 * Math.sin(phase * 5);
        s = tanh(s * 1.6) * env * gain;
        L[idx] += s * 0.55;
        R[idx] += s * 0.55;
      }
    }

    // 和弦重音：两个稍微失谐的锯齿
    function stab(t, freqs, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(0.28 * sr);
      for (let f = 0; f < freqs.length; f++) {
        const freq = freqs[f];
        let p1 = 0;
        let p2 = 0;
        for (let i = 0; i < n; i++) {
          const idx = start + i;
          if (idx < 0 || idx >= len) continue;
          const sec = i / sr;
          const env = Math.exp(-sec / 0.09) * Math.min(1, sec / 0.004);
          p1 += (TAU * freq) / sr;
          p2 += (TAU * freq * 1.006) / sr;
          const s = (Math.sin(p1) + Math.sin(p2)) * 0.5 * env * gain;
          L[idx] += s;
          R[idx] += s;
        }
      }
    }

    // break 段的垫底和弦
    function pad(t, freqs, durSec, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(durSec * sr);
      for (let f = 0; f < freqs.length; f++) {
        const freq = freqs[f];
        let p = 0;
        for (let i = 0; i < n; i++) {
          const idx = start + i;
          if (idx < 0 || idx >= len) continue;
          const sec = i / sr;
          const env = Math.min(1, sec / 0.25) * Math.min(1, (durSec - sec) / 0.4);
          p += (TAU * freq) / sr;
          const s = Math.sin(p) * env * gain;
          L[idx] += s * 0.8;
          R[idx] += s;
        }
      }
    }

    // 主旋律：几个谐波叠出来，带一点颤音
    function lead(t, freq, durSec, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(durSec * sr);
      let p = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const sec = i / sr;
        const env = Math.min(1, sec / 0.006) * Math.exp(-sec / (durSec * 0.62));
        const vib = 1 + 0.0035 * Math.sin(TAU * 5.5 * sec);
        p += (TAU * freq * vib) / sr;
        const s = (Math.sin(p) * 0.62 +
                   Math.sin(p * 2) * 0.24 +
                   Math.sin(p * 3) * 0.11) * env * gain;
        L[idx] += s * 0.85;
        R[idx] += s;
      }
    }

    // build 段的上升噪声
    function riser(t, durSec, gain) {
      const start = Math.floor(t * sr);
      const n = Math.floor(durSec * sr);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= len) continue;
        const p = i / n;
        const f = 180 + 900 * p * p;
        phase += (TAU * f) / sr;
        const env = p * p * (1 - p * 0.1);
        const s = (noise() * 0.5 + Math.sin(phase) * 0.5) * env * gain;
        L[idx] += s;
        R[idx] += s;
      }
    }

    // 音高表（A 小调，硬核常用）
    const BASS_NOTES = [55, 55, 82.4, 73.4];       // A1 A1 E2 D2
    const STAB_CHORDS = [[220, 261.6, 329.6], [220, 261.6, 329.6], [196, 246.9, 293.7], [233.1, 293.7, 349.2]];
    const PAD_CHORDS = [[220, 277.2, 329.6], [196, 246.9, 293.7]];

    const drums = tl.drums;
    for (let i = 0; i < drums.length; i++) {
      const d = drums[i];
      const t = d.time / 1000;
      if (d.kind === 'kick') kick(t, d.gain);
      else if (d.kind === 'clap') clap(t, d.gain);
      else if (d.kind === 'snare') snare(t, d.gain);
      else if (d.kind === 'hat') hat(t, d.gain);
      else if (d.kind === 'crash') crash(t, d.gain);
      else if (d.kind === 'bass') {
        const bar = Math.floor(i / 4) % 4;
        bass(t, BASS_NOTES[bar], d.gain * 0.6);
      } else if (d.kind === 'stab') {
        const bar = Math.floor(d.time / BAR + 0.01) % 4;
        stab(t, STAB_CHORDS[bar], d.gain * 0.5);
      } else if (d.kind === 'chord') {
        const bar = Math.floor(d.time / BAR + 0.01) % 4;
        pad(t, STAB_CHORDS[bar], (BAR / 1000) * 0.95, d.gain * 0.8);
      } else if (d.kind === 'pad') {
        const bar = Math.floor(d.time / BAR + 0.01) % 2;
        pad(t, PAD_CHORDS[bar], (BAR / 1000) * 1.6, d.gain * 0.5);
      } else if (d.kind === 'riser') {
        riser(t, (BAR * 3) / 1000, d.gain * 0.35);
      }
    }

    // ---------- 旋律 ----------
    // 4 小节一句，A 小调；下标是音级（SCALE 的索引）
    const SCALE = [440.00, 493.88, 523.25, 587.33, 659.25, 698.46, 783.99, 880.00];
    const MELODY = [
      [0, 2, 4, 3, 2, 4, 5, 4],
      [5, 4, 3, 2, 4, 2, 3, 0],
      [2, 3, 5, 4, 3, 5, 7, 5],
      [4, 5, 3, 2, 0, 2, 3, 0],
    ];

    for (let i = 0; i < tl.notes.length; i++) {
      const n = tl.notes[i];
      const beatAbs = (n.time - LEAD_IN) / BEAT;
      const bar = Math.floor(beatAbs / 4 + 0.001);
      const inBar = beatAbs - bar * 4;
      const step = Math.max(0, Math.min(7, Math.round(inBar * 2)));
      const phrase = MELODY[((bar % 4) + 4) % 4];
      const hz = SCALE[phrase[step]];

      if ((bar >= 8 && bar < 16) || (bar >= 20 && bar < 28)) {
        // drop：跟着八分位置，配一层低八度加厚
        lead(n.time / 1000, hz, 0.14, 0.21);
        lead(n.time / 1000, hz * 0.5, 0.16, 0.10);
      } else if (bar >= 16 && bar < 20) {
        // break：放慢一倍，降八度，长一点
        lead(n.time / 1000, hz * 0.5, 0.46, 0.19);
      } else if (bar < 4) {
        // 前奏：只在前半拍出琶音，留出空间
        if (step % 2 === 0) lead(n.time / 1000, hz * 0.5, 0.26, 0.11);
      }
    }

    // 母带：只在 0.7 以上做软削波。
    // 整段 tanh 会把段落起伏压平（break 和 drop 一样响），所以只用削顶。
    const soft = function (x) {
      const a = Math.abs(x);
      if (a <= 0.7) return x;
      const y = 0.7 + 0.3 * tanh((a - 0.7) / 0.3);
      return x < 0 ? -y : y;
    };
    let peak = 0;
    for (let i = 0; i < len; i++) {
      L[i] = soft(L[i]);
      R[i] = soft(R[i]);
      const a = Math.abs(L[i]);
      if (a > peak) peak = a;
      const b = Math.abs(R[i]);
      if (b > peak) peak = b;
    }
    if (peak > 0.92) {
      const k = 0.92 / peak;
      for (let i = 0; i < len; i++) {
        L[i] *= k;
        R[i] *= k;
      }
    }

    return buf;
  }

  M4K.demo = {
    build: function () {
      const tl = timeline();
      return { text: buildOsuText(tl.notes), objects: tl.notes, duration: tl.duration };
    },
    buildAudio: buildAudio,
    bpm: BPM,
    title: 'NEON OVERDRIVE',
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
