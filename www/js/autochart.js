/*
 * autochart.js — 从音频自动生成 4K 谱面
 *
 * 纯计算，不碰 DOM / WebAudio，可以在 Node 里用合成信号测试。
 *
 * 流程：
 *   1. 降采样到 ~22kHz，三频段滤波（低频=底鼓 / 中频=军鼓人声 / 高频=踩镲）
 *   2. 每段做短时包络 → 谱流（只取上升沿）→ 自适应峰值挑出打击点
 *   3. 用谱流的自相关估 BPM，再用梳状打分找节拍相位
 *   4. 把打击点吸附到节拍网格，按难度筛密度
 *   5. 按音域和「最近用过哪一列」分配轨道，生成长条
 *
 * 输出对象和 core.js 的 parseOsu() 结构一致，可以直接喂给 Engine。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.M4K = Object.assign(root.M4K || {}, { autochart: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FRAME = 128; // 包络分帧的采样数（22kHz 下约 5.8ms）

  /* ---------------- 工具 ---------------- */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 整数倍降采样到目标采样率附近（简单的滑动平均，够用） */
  function decimate(samples, sampleRate, targetRate) {
    const factor = Math.max(1, Math.round(sampleRate / targetRate));
    if (factor === 1) return { data: samples, sampleRate: sampleRate };
    const n = Math.floor(samples.length / factor);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const base = i * factor;
      for (let k = 0; k < factor; k++) s += samples[base + k];
      out[i] = s / factor;
    }
    return { data: out, sampleRate: sampleRate / factor };
  }

  /** RBJ biquad */
  function biquadCoeffs(type, freq, q, sr) {
    const w0 = (2 * Math.PI * freq) / sr;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * q);
    let b0;
    let b1;
    let b2;
    let a0;
    let a1;
    let a2;

    if (type === 'lowpass') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  function applyBiquad(x, c) {
    const y = new Float32Array(x.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = yi;
      y[i] = yi;
    }
    return y;
  }

  /** 分帧 RMS 包络 */
  function envelope(x) {
    const n = Math.floor(x.length / FRAME);
    const env = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let s = 0;
      const base = f * FRAME;
      for (let i = 0; i < FRAME; i++) {
        const v = x[base + i];
        s += v * v;
      }
      env[f] = Math.sqrt(s / FRAME);
    }
    return env;
  }

  /** 上升沿（谱流） */
  function fluxOf(env) {
    const f = new Float32Array(env.length);
    for (let i = 1; i < env.length; i++) {
      const d = env[i] - env[i - 1];
      if (d > 0) f[i] = d;
    }
    return f;
  }

  function normalize(arr) {
    let max = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    if (max <= 0) return arr;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i] / max;
    return out;
  }

  /** 峰值挑选：局部极大 + 自适应阈值 + 最小间隔 */
  function pickPeaks(flux, minGapFrames) {
    const peaks = [];
    let lastFrame = -1e9;
    const n = flux.length;

    for (let i = 1; i < n - 1; i++) {
      if (flux[i] <= flux[i - 1] || flux[i] < flux[i + 1]) continue;
      if (flux[i] < 0.04) continue;

      let sum = 0;
      let count = 0;
      const lo = Math.max(0, i - 8);
      const hi = Math.min(n - 1, i + 8);
      for (let k = lo; k <= hi; k++) {
        sum += flux[k];
        count++;
      }
      const mean = sum / count;
      if (flux[i] < mean * 1.15) continue;

      if (i - lastFrame < minGapFrames) {
        const prev = peaks[peaks.length - 1];
        if (prev && flux[i] > prev.strength) {
          prev.frame = i;
          prev.strength = flux[i];
          lastFrame = i;
        }
        continue;
      }
      peaks.push({ frame: i, strength: flux[i] });
      lastFrame = i;
    }
    return peaks;
  }

  /* ---------------- 速度估计 ---------------- */

  function autocorrelation(flux, minLag, maxLag) {
    const scores = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      const n = flux.length - lag;
      if (n <= 0) break;
      for (let i = lag; i < flux.length; i++) s += flux[i] * flux[i - lag];
      scores[lag] = s / n;
    }
    return scores;
  }

  function parabolicPeak(scores, lag) {
    const y0 = scores[lag - 1] || 0;
    const y1 = scores[lag] || 0;
    const y2 = scores[lag + 1] || 0;
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) < 1e-9) return lag;
    return lag + (0.5 * (y0 - y2)) / denom;
  }

  function estimateTempo(flux, frameRate) {
    const minBpm = 70;
    const maxBpm = 200;
    const minLag = Math.max(2, Math.round((60 * frameRate) / maxBpm));
    const maxLag = Math.min(flux.length - 1, Math.round((60 * frameRate) / minBpm));
    if (maxLag <= minLag) return { bpm: 120, periodFrames: (60 * frameRate) / 120, phase: 0 };

    const scores = autocorrelation(flux, minLag, maxLag);

    // 速度先验：4/4 里底鼓和军鼓交替，两拍周期的自相关天然比一拍强，
    // 光看峰值会稳定地估成半速。用一个以 145 BPM 为中心的先验压一下，
    // 宁可估快（网格更细）也不要估慢（整张谱子变粗）。
    const prior = function (bpm) {
      const x = Math.log2(bpm / 145) / 0.5;
      return Math.exp(-0.5 * x * x);
    };

    let bestLag = minLag;
    let bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const weighted = scores[lag] * prior((60 * frameRate) / lag);
      if (weighted > bestScore) {
        bestScore = weighted;
        bestLag = lag;
      }
    }

    // 半速 / 双速的竞争。
    // 关键：半速的周期一定也能对上所有正拍，所以自相关天然偏向「慢」。
    // 策略是「只要快的那个不明显更差，就取快的」——人耳也是这么听的。
    const candidates = [bestLag];
    if (bestLag * 2 <= maxLag) candidates.push(bestLag * 2);
    if (bestLag / 2 >= minLag) candidates.push(Math.round(bestLag / 2));
    candidates.sort(function (a, b) { return a - b; }); // lag 小的 = BPM 高的

    let chosen = bestLag;
    for (let i = 0; i < candidates.length; i++) {
      const lag = candidates[i];
      const w = (scores[lag] || 0) * prior((60 * frameRate) / lag);
      if (w >= bestScore * 0.85) {
        chosen = lag;
        break;
      }
    }

    const refined = parabolicPeak(scores, chosen);
    const periodFrames = refined;

    // 节拍相位：用梳状打分
    let bestPhase = 0;
    let bestPhaseScore = -1;
    const step = Math.max(0.5, periodFrames / 32);
    for (let phase = 0; phase < periodFrames; phase += step) {
      let s = 0;
      for (let k = 0; ; k++) {
        const idx = Math.round(phase + k * periodFrames);
        if (idx >= flux.length) break;
        s += flux[idx];
      }
      if (s > bestPhaseScore) {
        bestPhaseScore = s;
        bestPhase = phase;
      }
    }

    return {
      bpm: (60 * frameRate) / periodFrames,
      periodFrames: periodFrames,
      phase: bestPhase,
    };
  }

  /* ---------------- 主分析 ---------------- */

  function analyze(samples, sampleRate, options) {
    const opts = options || {};
    const dec = decimate(samples, sampleRate, 22050);
    const sr = dec.sampleRate;
    const x = dec.data;

    const bands = [
      { name: 'low', data: applyBiquad(x, biquadCoeffs('lowpass', 130, 0.7, sr)) },
      { name: 'mid', data: applyBiquad(x, biquadCoeffs('bandpass', 1000, 0.7, sr)) },
      { name: 'high', data: applyBiquad(x, biquadCoeffs('highpass', 5000, 0.7, sr)) },
    ];

    const frameRate = sr / FRAME;
    const minGapFrames = Math.max(2, Math.round(0.055 * frameRate));

    const fluxes = {};
    const envs = {};
    const bandPeak = {};
    const combined = new Float32Array(Math.floor(x.length / FRAME));
    const onsets = [];

    for (let b = 0; b < bands.length; b++) {
      const band = bands[b];
      const env = envelope(band.data);
      envs[band.name] = env;
      let peak = 0;
      for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
      bandPeak[band.name] = peak;

      const flux = normalize(fluxOf(env));
      fluxes[band.name] = flux;
      for (let i = 0; i < flux.length && i < combined.length; i++) combined[i] += flux[i];

      const peaks = pickPeaks(flux, minGapFrames);
      for (let p = 0; p < peaks.length; p++) {
        onsets.push({
          time: (peaks[p].frame / frameRate) * 1000,
          strength: peaks[p].strength,
          band: band.name,
        });
      }
    }

    onsets.sort(function (a, b) { return a.time - b.time; });

    const curve = energyCurve(envs, frameRate);

    const tempo = estimateTempo(normalize(combined), frameRate);
    const beatMs = 60000 / tempo.bpm;
    const offsetMs = (tempo.phase / frameRate) * 1000;

    // 小节相位：grid 的哪一拍是小节第一拍。
    // 不找出这个，和弦规则会落在错拍的弱音上（踩镲）而不是下拍（底鼓）。
    const comb = normalize(combined);
    let downbeat = 0;
    let bestDown = -1;
    for (let p = 0; p < 4; p++) {
      let s = 0;
      for (let k = 0; ; k++) {
        const idx = Math.round(tempo.phase + (k * 4 + p) * tempo.periodFrames);
        if (idx >= comb.length) break;
        s += comb[idx];
      }
      if (s > bestDown) { bestDown = s; downbeat = p; }
    }

    return {
      bpm: tempo.bpm,
      beatMs: beatMs,
      offset: offsetMs,
      downbeat: downbeat,
      onsets: onsets,
      duration: (samples.length / sampleRate) * 1000,
      frameRate: frameRate,
      bands: fluxes,
      envs: envs,
      energy: curve.curve,
      // 段落起伏够不够明显：不够就别硬套高潮/间奏的密度曲线
      sections: { contrast: curve.contrast, hasSections: curve.contrast >= 0.7 },

      bandPeak: bandPeak,
      analyzed: true,
    };
  }

  /* ---------------- 谱面生成 ---------------- */

  // 音型模板：楼梯 / 折返 / 三连 / 跳进（4K 的列号，会按旋转适配其它键数）
  const TEMPLATES = {
    2: [[0, 1], [1, 2], [2, 3], [0, 2], [1, 3], [0, 3], [3, 2], [2, 1], [1, 0], [3, 1]],
    3: [[0, 1, 2], [1, 2, 3], [3, 2, 1], [2, 1, 0], [0, 2, 1], [3, 1, 2],
      [0, 1, 0], [3, 2, 3], [1, 0, 2], [2, 3, 1]],
    4: [[0, 1, 2, 3], [3, 2, 1, 0], [0, 2, 1, 3], [3, 1, 2, 0],
      [0, 1, 2, 1], [3, 2, 1, 2], [1, 2, 3, 2], [2, 1, 0, 1],
      [0, 3, 1, 2], [3, 0, 2, 1]],
  };

  // 高潮段用的「整齐」模板下标：纯楼梯 / 楼梯折返 / 相邻对
  const ORDERLY = { 2: [0, 1, 2, 6, 7, 8], 3: [0, 1, 2, 3], 4: [0, 1, 4, 5] };

  const DIFFICULTIES = {
    // 简单/普通比初版更密：允许多到 8 分 / 16 分，长条概率也提高
    // maxChord = 同一时刻最多几个键；chordEveryBeats = 每隔几拍才允许和弦
    easy: { stepsPerBeat: 2, minGapBeats: 0.5, minStrength: 0.32, runGapBeats: 0.58, maxChord: 2, chordOnBeats: [0], chordFactor: 0.5, targetPerBeat: 1.4 },
    normal: { stepsPerBeat: 4, minGapBeats: 0.24, minStrength: 0.09, runGapBeats: 0.62, maxChord: 2, chordOnBeats: [0], chordFactor: 1.2, targetPerBeat: 2.4 },
    hard: { stepsPerBeat: 4, minGapBeats: 0.22, minStrength: 0.10, runGapBeats: 0.7, maxChord: 3, chordOnBeats: [0], chordFactor: 1.2, targetPerBeat: 3.4 },
  };

  /**
   * 整曲能量曲线（0..1，约 1 秒平滑）。
   * 用来区分「高潮 / 间奏」：高潮段和声厚、压缩重，能量上升沿反而少，
   * 光靠起音检测会让高潮比间奏还空，所以要按段落强度反过来调密度。
   */
  function energyCurve(envs, frameRate) {
    const n = envs.low ? envs.low.length : 0;
    if (!n) return new Float32Array(0);

    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      raw[i] = (envs.low[i] + envs.mid[i] + envs.high[i]) / 3;
    }

    const w = Math.max(2, Math.round(frameRate * 0.8));
    const sm = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += raw[i];
      if (i >= w) sum -= raw[i - w];
      sm[i] = sum / Math.min(i + 1, w);
    }

    const sorted = Array.from(sm).sort(function (a, b) { return a - b; });
    const p10 = sorted[Math.floor(n * 0.1)] || 0;
    const p90 = sorted[Math.min(n - 1, Math.floor(n * 0.9))] || 1;
    const span = Math.max(1e-6, p90 - p10);

    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = Math.max(0, Math.min(1, (sm[i] - p10) / span));
    }

    // 对比度必须用「更长的时间尺度」算：
    //   1) 归一化会把任何曲子拉满 0..1，不能看归一化后的曲线
    //   2) 小节级的起伏（每小节的鼓/和弦）不是段落，得先抹平
    const wl = Math.max(2, Math.round(frameRate * 4));
    const smLong = new Float32Array(n);
    let sumL = 0;
    for (let i = 0; i < n; i++) {
      sumL += raw[i];
      if (i >= wl) sumL -= raw[i - wl];
      smLong[i] = sumL / Math.min(i + 1, wl);
    }
    const sortedLong = Array.from(smLong).sort(function (a, b) { return a - b; });
    const l10 = sortedLong[Math.floor(n * 0.1)] || 0;
    const l50 = sortedLong[Math.floor(n * 0.5)] || 0;
    const l90 = sortedLong[Math.min(n - 1, Math.floor(n * 0.9))] || 0;
    const contrast = (l90 - l10) / Math.max(1e-6, l50);

    return { curve: out, contrast: contrast };
  }

  /**
   * 某个打击点在对应频段上「拖了多久」（毫秒）。
   * 只在这个值足够长的地方才生成长条 —— 这样长条跟着真实的延音走，
   * 而不是随机撒。
   */
  function sustainMsOfBand(analysis, timeMs, band) {
    const env = analysis.envs && analysis.envs[band];
    if (!env || !env.length) return 0;
    const fr = analysis.frameRate || 172;
    const f0 = Math.max(0, Math.round((timeMs / 1000) * fr));
    if (f0 >= env.length) return 0;

    let peak = 0;
    const hi = Math.min(env.length, f0 + 5);
    for (let f = f0; f < hi; f++) if (env[f] > peak) peak = env[f];
    if (peak <= 0) return 0;

    const bandMax = (analysis.bandPeak && analysis.bandPeak[band]) || peak;
    const thr = Math.max(peak * 0.45, bandMax * 0.12);

    let f = f0;
    while (f < env.length && env[f] > thr) f++;
    return ((f - f0) / fr) * 1000;
  }

  /** 这一段里有没有东西在拖长音（任一频段算数） */
  function sustainMs(analysis, timeMs) {
    if (!analysis.envs) return 0;
    let best = 0;
    const names = ['low', 'mid', 'high'];
    for (let i = 0; i < names.length; i++) {
      const v = sustainMsOfBand(analysis, timeMs, names[i]);
      if (v > best) best = v;
    }
    return best;
  }

  /** 要不要按段落调密度：起伏不明显就一律中性 */
  function hasSections(analysis) {
    return !(analysis.sections && analysis.sections.hasSections === false);
  }

  /** 某个时刻的段落强度（0=间奏，1=高潮） */
  function intensityAt(analysis, timeMs) {
    const e = analysis.energy;
    if (!e || !e.length) return 0.5;
    const fr = analysis.frameRate || 172;
    const i = Math.round((timeMs / 1000) * fr);
    if (i < 0) return e[0];
    if (i >= e.length) return e[e.length - 1];
    return e[i];
  }

  /** 段落级强度：在时间轴上取 ±2 秒平均，避免瞬时抖动导致网格忽松忽紧 */
  function sectionLevel(analysis, timeMs) {
    const e = analysis.energy;
    if (!e || !e.length) return 0.5;
    const fr = analysis.frameRate || 172;
    const half = Math.round(fr * 2);
    const c = Math.max(0, Math.min(e.length - 1, Math.round((timeMs / 1000) * fr)));
    let sum = 0;
    let n = 0;
    const lo = Math.max(0, c - half);
    const hi = Math.min(e.length - 1, c + half);
    for (let i = lo; i <= hi; i++) { sum += e[i]; n++; }
    return n ? sum / n : 0.5;
  }

  function bandBias(band, keyCount) {
    // 低频偏外侧，中频偏中间，高频随便
    if (band === 'low') return keyCount === 4 ? [0.5, 0.0, 0.0, 0.5] : null;
    if (band === 'mid') return keyCount === 4 ? [0.0, 0.5, 0.5, 0.0] : null;
    return null;
  }

  function generate(analysis, options) {
    const opts = options || {};
    const keyCount = opts.keyCount || 4;
    const level = DIFFICULTIES[opts.difficulty] || DIFFICULTIES.normal;
    const rng = mulberry32(Math.round((analysis.duration || 1) * 1000) + keyCount * 7919);

    const beatMs = analysis.beatMs;
    const offset = analysis.offset;
    const stepMs = beatMs / level.stepsPerBeat;

    // 1) 吸附到网格：同一个格子可能同时有多个来源（底鼓 / 军鼓 / 镲 / 人声）
    const slotMap = new Map();

    // 人声倾向：中频上「拖得住」的起音更像人声/旋律，给它加权，
    // 这样有人声的段落里音符会跟着人声走，而不是跟着底鼓走
    const vocalBoost = function (o) {
      if (o.band !== 'mid') return 1;
      return sustainMs(analysis, o.time) >= beatMs * 0.4 ? 1.5 : 1;
    };

    for (let i = 0; i < analysis.onsets.length; i++) {
      const o = analysis.onsets[i];
      const weight = o.strength * vocalBoost(o);
      if (weight < level.minStrength * 0.6) continue;
      const rel = o.time - offset;
      if (rel < 0) continue;
      const slot = Math.round(rel / stepMs);
      const target = offset + slot * stepMs;
      // 容差收紧到 ±30ms 以内。
      // 原来用 stepMs*0.45，简单难度下等于允许 90ms 的偏差 ——
      // 那会把音挪到离真实发声很远的地方，听起来就是"对不上拍"。
      const snapTol = Math.min(stepMs * 0.25, 30);
      if (Math.abs(o.time - target) > snapTol) continue;

      // 收集时门槛放宽一点：弱音可以当「和弦的第二个音」，
      // 但决定它是不是一个音的主音时，仍然要求过 minStrength
      // 段落强度：高潮段门槛更低（音符更多），间奏门槛更高
      const intensity = hasSections(analysis) ? intensityAt(analysis, target) : 0.5;
      const strengthFloor = level.minStrength * (1.12 - 0.4 * intensity);
      if (weight < strengthFloor * 0.6) continue;

      const item = { time: target, strength: weight, band: o.band, intensity: intensity };
      const list = slotMap.get(slot);
      if (list) list.push(item);
      else slotMap.set(slot, [item]);
    }

    // 2) 每个格子收集所有音源，按不同频段去重 → 决定这一刻要几个键
    const rawEvents = [];
    const chordOn = level.chordOnBeats || [0];
    const maxChord = level.maxChord || 1;

    Array.from(slotMap.keys()).sort(function (a, b) { return a - b; }).forEach(function (slot) {
      const list = slotMap.get(slot).sort(function (a, b) { return b.strength - a.strength; });
      const bands = [];
      const picked = [];
      for (let i = 0; i < list.length; i++) {
        if (bands.indexOf(list[i].band) >= 0) continue; // 同频段视为同一个音源
        bands.push(list[i].band);
        picked.push(list[i]);
      }
      if (!picked.length) return;
      const evIntensity = picked[0].intensity || 0.5;
      const evFloor = level.minStrength * (1.12 - 0.4 * evIntensity);
      if (picked[0].strength < evFloor) return; // 主音不够强，这一格不要

      const time = offset + slot * stepMs;
      // 小节内的第几拍（0 = 小节第一拍）。
      // 用整数槽位算，不要用 (time-offset)/beat —— 那在十六分的正中间会
      // 正好落在 x.5 上，四舍五入的方向会让前后判定漂移一拍。
      const beatIdx = Math.floor(slot / level.stepsPerBeat) - (analysis.downbeat || 0);
      const barBeat = ((beatIdx % 4) + 4) % 4;
      const onChordBeat = chordOn.indexOf(barBeat) >= 0;

      let chord = 1;
      if (onChordBeat && picked.length >= 2) {
        chord = Math.min(maxChord, picked.length);
        // 第二个音也得够强，不然就是硬凑
        const chordFloor = level.minStrength * (level.chordFactor || 1.2);
        while (chord > 1 && picked[chord - 1].strength < chordFloor) chord--;
      }

      rawEvents.push({
        time: time,
        strength: picked[0].strength,
        band: picked[0].band,
        chord: chord,
        intensity: evIntensity,
        barBeat: barBeat,
        onBeat: (slot % level.stepsPerBeat) === 0,
        sub: slot % level.stepsPerBeat,
      });
    });

    // 3) 密度控制
    const minGapMs = beatMs * level.minGapBeats;
    const events = [];
    for (let i = 0; i < rawEvents.length; i++) {
      const ev = rawEvents[i];
      const last = events[events.length - 1];
      if (last) {
        const midIntensity = ((ev.intensity || 0.5) + (last.intensity || 0.5)) / 2;
        const effGap = minGapMs / (0.78 + 0.5 * midIntensity); // 高潮 1.28 倍密，间奏 0.78 倍
        if (ev.time - last.time < effGap - 1) {
          if (ev.strength > last.strength) events[events.length - 1] = ev;
          continue;
        }
      }
      events.push(ev);
    }

    // 3.5) 段落密度整形：每 2 拍一个窗口，按该处能量决定保留几个音。
    //      「弱化门槛」对密度几乎无影响（起音数量是固定的），
    //      真正能拉开高潮/间奏差距的是这一步。
    {
      const winMs = beatMs * 2;
      const base = level.targetPerBeat || 2.4;
      const buckets = new Map();
      for (let i = 0; i < events.length; i++) {
        const w = Math.floor((events[i].time - offset) / winMs);
        if (!buckets.has(w)) buckets.set(w, []);
        buckets.get(w).push(events[i]);
      }

      const kept = [];
      buckets.forEach(function (list, w0) {
        let sum = 0;
        for (let i = 0; i < list.length; i++) sum += (list[i].intensity || 0.5);
        const avgIntensity = sum / list.length;
        // 段落起伏不明显时用中性强度，不要凭空压低或抬高密度
        const intensity = hasSections(analysis)
          ? sectionLevel(analysis, offset + (w0 + 0.5) * winMs)
          : 0.5;
        // 高潮(1.0) 约 1.3 倍，间奏(0.0) 约 0.55 倍
        const cap = Math.max(1, Math.round(base * 2 * (0.55 + 0.75 * Math.max(intensity, avgIntensity))));

        // 密度上限按段落走，但**不筛网格**：切分的鼓点必须留下来。
        // 排序只给正拍一点点加权（同强度时优先正拍），不能盖过起音本身的强弱——
        // 否则谱面会变成「整整齐齐全在正拍上」，跟音乐脱节。
        const downWeight = 1.30 + 0.30 * intensity;  // 小节第一拍：1.30 ~ 1.60
        const beatWeight = 1.12 + 0.18 * intensity;  // 其它正拍：1.12 ~ 1.30
        const rank = function (ev) {
          if (!ev.onBeat) return ev.strength;
          return ev.strength * (ev.barBeat === 0 ? downWeight : beatWeight);
        };

        list.sort(function (a, b) { return rank(b) - rank(a); });

        const take = list.slice(0, cap);

        // 小节第一拍保底：这一窗口里拍了第一拍（起音足够强）但被挤掉了，
        // 就用它换掉窗口里最弱的那个音。加权解决不了这个问题——
        // 下拍本来就是最强的，被挤掉的往往是弱拍；能拉开差距的是「保证有」。
        const downCand = list.filter(function (e) { return e.onBeat && e.barBeat === 0; });
        if (downCand.length) {
          let hasDown = false;
          for (let i = 0; i < take.length; i++) {
            if (take[i].onBeat && take[i].barBeat === 0) { hasDown = true; break; }
          }
          if (!hasDown) {
            downCand.sort(function (a, b) { return b.strength - a.strength; });
            let weakIdx = -1;
            let weakVal = Infinity;
            for (let i = 0; i < take.length; i++) {
              if (take[i].onBeat && take[i].barBeat === 0) continue;
              const v = take[i].strength * (take[i].onBeat ? 1.15 : 1);
              if (v < weakVal) { weakVal = v; weakIdx = i; }
            }
            if (weakIdx >= 0) take[weakIdx] = downCand[0];
          }
        }

        take.sort(function (a, b) { return a.time - b.time; });
        for (let i = 0; i < take.length; i++) kept.push(take[i]);
      });

      kept.sort(function (a, b) { return a.time - b.time; });
      events.length = 0;
      for (let i = 0; i < kept.length; i++) events.push(kept[i]);
    }

    // 4) 分配轨道：连续音走「音型模板」，孤立音按均衡挑选
    const notes = [];
    const lastUse = new Float64Array(keyCount).fill(-1e9);
    const usage = new Float64Array(keyCount);
    let assigned = 0;
    let lastCol = -1;

    const runGapMs = beatMs * (level.runGapBeats || 0.62);
    const usageShare = function (c) { return assigned > 0 ? usage[c] / assigned : 0; };

    // 一个事件可能落成 2~3 个键：主音按音型走，副音镜像到另一侧
    const pushNote = function (ev, primaryCol) {
      const cols = [primaryCol];
      for (let k = 1; k < (ev.chord || 1); k++) {
        const mirror = keyCount - 1 - cols[cols.length - 1];
        const order = [mirror, (mirror + 1) % keyCount, (mirror + keyCount - 1) % keyCount];
        for (let m = 0; m < order.length; m++) {
          const c = order[m];
          if (cols.indexOf(c) >= 0) continue;
          if (ev.time - lastUse[c] < 90) continue;
          cols.push(c);
          break;
        }
      }

      for (let k = 0; k < cols.length; k++) {
        const c = cols[k];
        lastUse[c] = ev.time;
        usage[c] += 1;
        assigned++;
        notes.push({
          col: c,
          time: Math.round(ev.time),
          end: null,
          isHold: false,
          strength: ev.strength,
          band: ev.band,
        });
      }
      lastCol = primaryCol;
    };

    const pickSingle = function (ev, orderly) {
      const bias = bandBias(ev.band, keyCount);
      let bestCol = 0;
      let bestScore = -1e9;
      for (let c = 0; c < keyCount; c++) {
        let score = rng() * (orderly ? 0.05 : 0.3);
        if (bias) score += bias[c];
        score -= usageShare(c) * 2.2;
        const gap = ev.time - lastUse[c];
        if (gap < 95) score -= 3.5;
        else if (gap < 180) score -= 1.2;
        if (c === lastCol) score -= 1.5;
        if (c === 0 || c === keyCount - 1) score += 0.12;
        if (score > bestScore) { bestScore = score; bestCol = c; }
      }
      return bestCol;
    };


    /** 挑一组音型：优先用还没怎么用过的列 */
    const pickPattern = function (len, orderly) {
      const full = TEMPLATES[len] || TEMPLATES[3];
      const allow = orderly ? (ORDERLY[len] || [0]) : null;
      const bank = allow ? allow.map(function (i) { return full[i]; }) : full;
      let best = null;
      let bestScore = -1e9;
      for (let t = 0; t < bank.length; t++) {
        for (let rot = 0; rot < keyCount; rot++) {
          const cols = bank[t].map(function (c) { return (c + rot) % keyCount; });
          let score = rng() * (orderly ? 0.1 : 0.5);
          for (let k = 0; k < cols.length; k++) score -= usageShare(cols[k]) * 1.6;
          if (cols[0] === lastCol) score -= 2.0;
          if (score > bestScore) { bestScore = score; best = cols; }
        }
      }
      return best;
    };

    let ev = 0;
    while (ev < events.length) {
      let j = ev;
      while (j + 1 < events.length && events[j + 1].time - events[j].time <= runGapMs) j++;
      const len = j - ev + 1;

      // 这一段有多「满」：高潮段让音型更规整，少一点随机
      let iSum = 0;
      for (let k = ev; k <= j; k++) iSum += (events[k].intensity || 0.5);
      const orderly = (iSum / len) >= 0.55;

      if (len === 1) {
        pushNote(events[ev], pickSingle(events[ev], orderly));
      } else if (len <= 4 && TEMPLATES[len]) {
        const cols = pickPattern(len, orderly);
        for (let k = 0; k < len; k++) pushNote(events[ev + k], cols[k]);
      } else {
        // 长串：挑一个音型，按「上行 / 下行」交替铺，
        // 每轮把起点挪一列，听起来像刻意的楼梯而不是随机走位
        const bank = TEMPLATES[4];
        const pick = orderly ? [0, 1] : null; // 高潮段只在两条纯楼梯之间换
        const tpl = pick ? bank[pick[Math.floor(rng() * pick.length)]] : bank[Math.floor(rng() * bank.length)];
        let rot = Math.floor(rng() * keyCount);
        let ascending = rng() < 0.5;
        let k = 0;
        while (k < len) {
          const chunk = Math.min(4, len - k);
          let seq;
          if (chunk === 4) {
            seq = tpl.map(function (c) { return (c + rot) % keyCount; });
            if (!ascending) seq = seq.slice().reverse();
          } else {
            seq = tpl.slice(0, chunk).map(function (c) { return (c + rot) % keyCount; });
          }
          for (let m = 0; m < chunk; m++) pushNote(events[ev + k + m], seq[m]);
          k += chunk;
          ascending = !ascending;
          if (ascending) rot = (rot + 1) % keyCount;
        }
      }
      ev = j + 1;
    }

    // 安全网：同列两个音不能挤在 90ms 内（手按不过来）
    for (let n = 1; n < notes.length; n++) {
      let guard = 0;
      while (notes[n].col === notes[n - 1].col &&
             notes[n].time - notes[n - 1].time < 90 && guard < keyCount) {
        notes[n].col = (notes[n].col + 1) % keyCount;
        guard++;
      }
    }

    // 4) 长条：只在「这个音真的拖了足够久」的地方放，长度跟着延音走
    //    如果它所在的列马上还有音，就换一条空着的列 —— 别让延音白白浪费
    const timesByCol = [];
    for (let c = 0; c < keyCount; c++) timesByCol.push([]);
    for (let n = 0; n < notes.length; n++) timesByCol[notes[n].col].push(notes[n].time);

    const roomInColumn = function (c, t) {
      const arr = timesByCol[c];
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= t + 1) lo = mid + 1;
        else hi = mid;
      }
      return lo < arr.length ? arr[lo] - t : Infinity;
    };

    const columnBusyNear = function (c, t, windowMs) {
      const arr = timesByCol[c];
      const w = windowMs || 120;
      for (let i = 0; i < arr.length; i++) {
        if (Math.abs(arr[i] - t) < w) return true;
      }
      return false;
    };

    const moveNote = function (note, from, to) {
      const arr = timesByCol[from];
      const idx = arr.indexOf(note.time);
      if (idx >= 0) arr.splice(idx, 1);
      const dst = timesByCol[to];
      let at = 0;
      while (at < dst.length && dst[at] < note.time) at++;
      dst.splice(at, 0, note.time);
      note.col = to;
    };

    // 每条列上「已经有长条按到什么时候」——挪位置时必须避开
    const holdEndByCol = new Float64Array(keyCount).fill(-1e9);

    // 长条密度上限：
    //   - 总量不超过 12%（人声吟唱那种整段长音，否则会变成一片长条）
    //   - 两条长条之间至少隔 1.5 拍
    let holdCount = 0;
    const holdCap = Math.max(1, Math.floor(notes.length * 0.12));
    const holdGapMs = beatMs * 1.5;
    let lastHoldEnd = -1e9;

    for (let n = 0; n < notes.length && holdCount < holdCap; n++) {
      const note = notes[n];
      if (note.time - lastHoldEnd < holdGapMs) continue;

      const sustain = sustainMs(analysis, note.time);
      if (sustain < beatMs * 0.85) continue;

      const wanted = Math.min(beatMs * 2, sustain * 0.9);
      if (wanted < beatMs * 0.7) continue;

      let col = note.col;
      let room = roomInColumn(col, note.time) - beatMs * 0.4;
      if (note.time < holdEndByCol[col] + beatMs * 0.15) room = 0;
      if (Math.min(wanted, room) < beatMs * 0.7) {
        // 换一条能放下这条长条的列
        let bestCol = -1;
        let bestRoom = -1;
        for (let c = 0; c < keyCount; c++) {
          if (c === col) continue;
          if (note.time < holdEndByCol[c] + beatMs * 0.15) continue;
          if (columnBusyNear(c, note.time, 150)) continue;
          const r = roomInColumn(c, note.time) - beatMs * 0.4;
          if (r > bestRoom) { bestRoom = r; bestCol = c; }
        }
        if (bestCol < 0 || Math.min(wanted, bestRoom) < beatMs * 0.7) continue;
        moveNote(note, col, bestCol);
        col = bestCol;
        room = bestRoom;
      }

      const len = Math.min(wanted, room);
      note.isHold = true;
      note.end = Math.round(note.time + len);
      holdEndByCol[col] = note.end;
      lastHoldEnd = note.end;
      holdCount++;
    }

    for (let n = 0; n < notes.length; n++) {
      delete notes[n].nextCol;
      delete notes[n].band;
      notes[n].id = n;
    }

    const chart = {
      keyCount: keyCount,
      notes: notes,
      meta: {
        title: opts.title || '自动生成',
        artist: opts.artist || '',
        version: (opts.difficulty || 'normal').toUpperCase() + ' (Auto)',
        creator: 'Rhythm4K 自动生成',
      },
      difficulty: { OverallDifficulty: '8' },
      timing: [{ time: offset, beatLength: beatMs, meter: 4, uninherited: true }],
      audioFilename: opts.audioFilename || '',
      background: '',
      video: '',
      videoStart: 0,
      events: [],
      mode: 3,
      auto: {
        bpm: Math.round(analysis.bpm * 10) / 10,
        offset: Math.round(offset),
        difficulty: opts.difficulty || 'normal',
      },
    };
    return chart;
  }

  /**
   * 谱面对象 → .osu 文本，方便拿去 osu! 编辑器里继续手改
   */
  function toOsu(chart, options) {
    const opts = options || {};
    const keyCount = chart.keyCount || 4;
    const beatMs = chart.timing && chart.timing[0] ? chart.timing[0].beatLength : 500;
    const offset = chart.timing && chart.timing[0] ? chart.timing[0].time : 0;
    const meta = chart.meta || {};
    const L = [];

    L.push('osu file format v14', '');
    L.push('[General]');
    L.push('AudioFilename: ' + (opts.audioFilename || 'audio.mp3'));
    L.push('AudioLeadIn: 0');
    L.push('PreviewTime: -1');
    L.push('Countdown: 0');
    L.push('Mode: 3');
    L.push('');
    L.push('[Metadata]');
    L.push('Title:' + (meta.title || 'Auto'));
    L.push('TitleUnicode:' + (meta.title || 'Auto'));
    L.push('Artist:' + (meta.artist || 'Auto'));
    L.push('ArtistUnicode:' + (meta.artist || 'Auto'));
    L.push('Creator:' + (meta.creator || 'Rhythm4K'));
    L.push('Version:' + (meta.version || 'Auto'));
    L.push('Source:');
    L.push('Tags:auto');
    L.push('');
    L.push('[Difficulty]');
    L.push('HPDrainRate:7');
    L.push('CircleSize:' + keyCount);
    L.push('OverallDifficulty:8');
    L.push('ApproachRate:5');
    L.push('SliderMultiplier:1.4');
    L.push('SliderTickRate:1');
    L.push('');
    L.push('[Events]');
    L.push('//Background and Video events');
    L.push('//Break Periods');
    L.push('//Storyboard Layer 0 (Background)');
    L.push('');
    L.push('[TimingPoints]');
    L.push(Math.round(offset) + ',' + (Math.round(beatMs * 1000) / 1000) + ',4,2,0,100,1,0');
    L.push('');
    L.push('[HitObjects]');

    const notes = chart.notes.slice().sort(function (a, b) { return a.time - b.time; });
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const x = Math.round((n.col + 0.5) * (512 / keyCount));
      if (n.isHold && n.end) {
        L.push(x + ',192,' + Math.round(n.time) + ',128,0,' + Math.round(n.end) + ':0:0:0:0:');
      } else {
        L.push(x + ',192,' + Math.round(n.time) + ',1,0,0:0:0:0:');
      }
    }
    return L.join('\n') + '\n';
  }

  /**
   * 生成一份可读的分析报告（文本），
   * 用来在没法直接听到/看到结果时把数据带出来。
   */
  function report(analysis, chart, options) {
    const opts = options || {};
    const L = [];
    const dur = analysis.duration || 0;
    const pad = function (s, n) { return String(s).padStart(n, ' '); };

    L.push('Rhythm4K 自动生成分析报告');
    L.push('文件: ' + (opts.name || '(未知)'));
    L.push('时长: ' + Math.floor(dur / 60000) + ':' + String(Math.round((dur % 60000) / 1000)).padStart(2, '0'));
    L.push('BPM: ' + (Math.round(analysis.bpm * 10) / 10));
    L.push('节拍偏移: ' + Math.round(analysis.offset) + ' ms');
    L.push('小节下拍: ' + (analysis.downbeat || 0));
    L.push('打击点: ' + analysis.onsets.length);
    L.push('');

    if (chart && chart.notes) {
      const notes = chart.notes;
      const holds = notes.filter(function (n) { return n.isHold; }).length;
      const byTime = new Map();
      notes.forEach(function (n) { byTime.set(n.time, (byTime.get(n.time) || 0) + 1); });
      let chordTimes = 0;
      byTime.forEach(function (v) { if (v > 1) chordTimes++; });

      L.push('难度: ' + ((chart.auto && chart.auto.difficulty) || '?'));
      L.push('音符: ' + notes.length + '  (' + (notes.length / (dur / 1000)).toFixed(2) + '/s)');
      L.push('长条: ' + holds + '  (' + (100 * holds / Math.max(1, notes.length)).toFixed(1) + '%)');
      L.push('和弦时刻: ' + chordTimes);
      L.push('');
      L.push('  时刻    能量   音符   长条');
      for (let t = 0; t < dur; t += 10000) {
        const seg = notes.filter(function (n) { return n.time >= t && n.time < t + 10000; });
        const sh = seg.filter(function (n) { return n.isHold; }).length;
        const fr = analysis.frameRate || 172;
        const idx = Math.min((analysis.energy ? analysis.energy.length - 1 : 0), Math.round((t / 1000) * fr));
        const e = analysis.energy && analysis.energy.length ? analysis.energy[idx] : 0;
        L.push('  ' + pad(Math.round(t / 1000) + 's', 6) + pad(e.toFixed(2), 8) +
          pad(seg.length, 6) + pad(sh, 6));
      }
    }
    return L.join('\n');
  }

  return {
    analyze: analyze,
    report: report,
    generate: generate,
    toOsu: toOsu,
    sustainMs: sustainMs,
    TEMPLATES: TEMPLATES,
    DIFFICULTIES: DIFFICULTIES,
  };
});
