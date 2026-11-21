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

  // 分析器版本：改了测速 / 密度 / 配比逻辑就 +1，准备页会显示出来
  const ANALYZER_VERSION = 5;
  let CURRENT_ABL = {};   // 消融开关（只在评测时用）

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
  /**
   * 重采样到固定目标采样率。
   *
   * 注意：这里必须做**抗混叠滤波 + 非整数比重采样**。
   * 早期版本用整数倍抽取（factor = round(sr/22050)），48kHz 时算出 2 倍，
   * 输出变成 24kHz 且没有低通——高频折返进 5kHz 以上的频段，
   * 测速会直接错（实测 200 BPM 的歌被判成 149.8）。
   */
  function decimate(samples, sampleRate, targetRate) {
    if (sampleRate <= targetRate) return { data: samples, sampleRate: sampleRate };

    // 抗混叠：两级低通，截止到目标奈奎斯特的 84%
    const cutoff = targetRate * 0.42;
    const c = biquadCoeffs('lowpass', cutoff, 0.707, sampleRate);
    let src = applyBiquad(samples, c);
    src = applyBiquad(src, c);

    const ratio = sampleRate / targetRate;
    const n = Math.floor(samples.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const i0 = pos | 0;
      const frac = pos - i0;
      const a = src[i0] || 0;
      const b = src[i0 + 1] !== undefined ? src[i0 + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return { data: out, sampleRate: targetRate };
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

  /**
   * 拍长候选的「正拍 / 半拍」对比度。
   * 正确的拍长：正拍上是底鼓（重），半拍上是反拍（轻）→ 对比度高。
   * 拍长取成 1.5 倍或 2 倍时，正拍会混进反拍，对比度掉下来。
   */
  /** 取 ±1 帧内的最大值（周期常不是整数帧，直接取整会错过起音） */
  function sampleMax(flux, idx) {
    let m = 0;
    for (let d = -1; d <= 1; d++) {
      const j = idx + d;
      if (j >= 0 && j < flux.length && flux[j] > m) m = flux[j];
    }
    return m;
  }

  function beatContrast(flux, period) {
    const step = Math.max(0.5, period / 32);
    let bestPhase = 0;
    let bestOn = -1;
    for (let ph = 0; ph < period; ph += step) {
      let sum = 0;
      let n = 0;
      for (let k = 0; ; k++) {
        const i = Math.round(ph + k * period);
        if (i >= flux.length) break;
        sum += flux[i];
        n++;
      }
      const avg = n ? sum / n : 0;
      if (avg > bestOn) { bestOn = avg; bestPhase = ph; }
    }

    // 取 ±1 帧的最大值：周期常常不是整数帧，四舍五入会「正好错过」起音，
    // 让错误的周期反而拿到满对比度（这就是之前 150 被估成 100 的原因）。
    const at = function (idx) { return sampleMax(flux, idx); };

    let onSum = 0, offSum = 0, nOn = 0, nOff = 0;
    for (let k = 0; ; k++) {
      const iOn = Math.round(bestPhase + k * period);
      if (iOn >= flux.length) break;
      onSum += at(iOn);
      nOn++;
      const iOff = Math.round(bestPhase + (k + 0.5) * period);
      if (iOff < flux.length) { offSum += at(iOff); nOff++; }
    }
    const on = onSum / Math.max(1, nOn);
    const off = offSum / Math.max(1, nOff);
    return {
      phase: bestPhase,
      contrast: (on - off) / Math.max(1e-6, on + off),
      onAvg: on,
    };
  }

  /**
   * 网格对齐度：这个周期下，多少比例的起音能量落在 16 分网格线上。
   * 正确的节拍会把起音对齐得很好；差半拍或倍速的候选对不上。
   */
  function gridFit(flux, period, phase, frameRate, onsetList) {
    const step = period / 4;
    if (step < 2) return 0;
    // 固定 18ms 容差（而不是按格长缩放），再除以随机命中基线 —— 否则格子越细分数越高
    const tol = Math.max(0.5, (18 / 1000) * frameRate);
    let on = 0, off = 0;
    for (let i = 0; i < flux.length; i++) {
      const v = flux[i];
      if (v <= 1e-6) continue;
      const rel = (i - phase) / step;
      const d = Math.abs(rel - Math.round(rel)) * step;
      if (d <= tol) on += v; else off += v;
    }
    const sum = on + off;
    if (sum <= 1e-6) return 0;
    const chance = Math.min(0.95, (2 * tol) / step);
    const fitFlux = (on / sum) / Math.max(0.08, chance);
    // 有起音列表时优先用起音算：起音对网格的响应比频谱能量锐利得多
    if (onsetList && onsetList.length > 20) {
      const periodMs = period * 1000 / frameRate;
      const phaseMs = phase * 1000 / frameRate;
      const stepMs = periodMs / 4;
      if (stepMs > 4) {
        const tolMs = 18;
        let hit = 0;
        for (let i = 0; i < onsetList.length; i++) {
          const rel = (onsetList[i].time - phaseMs) / stepMs;
          const d = Math.abs(rel - Math.round(rel)) * stepMs;
          if (d <= tolMs) hit++;
        }
        const chanceMs = Math.min(0.95, (2 * tolMs) / stepMs);
        return (hit / onsetList.length) / Math.max(0.08, chanceMs);
      }
    }
    return fitFlux;
  }

  /**
   * 用「起音对 16 分网格的对齐度」精调周期与相位。
   * 对齐度要除以随机基线，否则格子越细分数越高（会偏向快歌）。
   */
  function refinePeriodByOnsets(onsets, periodMs, frameRate) {
    if (!onsets || onsets.length < 30) return null;
    let best = null;
    for (let k = -0.08; k <= 0.0801; k += 0.004) {
      const p = periodMs * (1 + k);
      const step = p / 4;
      if (step < 20) continue;
      const phaseN = 12;
      for (let pi = 0; pi < phaseN; pi++) {
        const ph = (step * pi) / phaseN;
        let hit = 0;
        for (let i = 0; i < onsets.length; i++) {
          const rel = (onsets[i].time - ph) / step;
          const d = Math.abs(rel - Math.round(rel)) * step;
          if (d <= 15) hit++;
        }
        const chance = Math.min(0.95, 30 / step);
        const gain = (hit / onsets.length) / Math.max(0.08, chance);
        if (!best || gain > best.gain) best = { gain: gain, periodMs: p, phaseMs: ph };
      }
    }
    return best;
  }


  /* ------------------------------------------------------------------ *
   * BPM 候选选择器
   *
   * 实测：真 BPM 有 88% 的概率已经出现在候选里，但按 score 选只有 50% 选对。
   * 关键判别特征是「分段对齐稳定性」——正确的周期在全曲都不会漂移，
   * 错误的周期会越走越偏。
   * ------------------------------------------------------------------ */
  var BPM_SEL = {"w": [-2.330107790961026, 1.0370431614166655, -0.8437217494204038, -0.6101965039041752, -0.8776347222478182, 0.076392724116899, -0.5179061065937395, 2.212902717293538, 2.2129027172935394, 0.0, -2.358328758428658, 1.5765652399359988], "mu": [0.02132448672537473, 0.032890456549865714, 0.2095899241126505, 0.1969582227084953, 0.9398332743735761, 0.34349091900135015, -0.2554672128055472, 0.017551281600869106, 1.0, 0.39009866672516386, 0.43347687153384745], "sd": [0.03296015397681084, 0.04969151283002497, 0.07621062274220737, 0.07244365735953584, 0.045771369840465904, 0.12901278919240355, 0.5536317593286519, 0.5536317593286519, 1.0, 0.16022712399611394, 0.16280236013136734]};

  function beatGridFeatures(onsets, bpm, tolMs) {
    const beatMs = 60000 / bpm;
    let bestPh = 0, bestCov = -1, bestHalf = 0;
    for (let k = 0; k < 24; k++) {
      const ph = (beatMs * k) / 24;
      let onBeat = 0, onHalf = 0;
      for (let i = 0; i < onsets.length; i++) {
        const rel = (onsets[i].time - ph) / beatMs;
        const frac = rel - Math.floor(rel);
        const dB = Math.min(frac, 1 - frac) * beatMs;
        if (dB <= tolMs) onBeat++;
        const dH = Math.abs(frac - 0.5) * beatMs;
        if (dH <= tolMs) onHalf++;
      }
      const cov = onBeat / onsets.length;
      if (cov > bestCov) { bestCov = cov; bestPh = ph; bestHalf = onHalf / onsets.length; }
    }
    const step = beatMs / 4;
    let gridHit = 0;
    const segN = 8;
    const t0 = onsets.length ? onsets[0].time : 0;
    const t1 = onsets.length ? onsets[onsets.length - 1].time : 1;
    const segHit = new Array(segN).fill(0);
    const segTot = new Array(segN).fill(0);
    for (let i = 0; i < onsets.length; i++) {
      const g = (onsets[i].time - bestPh) / step;
      if (Math.abs(g - Math.round(g)) * step <= 20) gridHit++;
      const seg = Math.min(segN - 1, Math.floor((onsets[i].time - t0) / Math.max(1, t1 - t0) * segN));
      segTot[seg]++;
      if (Math.abs(g - Math.round(g)) * step <= 25) segHit[seg]++;
    }
    const rates = [];
    for (let s = 0; s < segN; s++) if (segTot[s] > 5) rates.push(segHit[s] / segTot[s]);
    rates.sort(function (a, b) { return a - b; });
    return {
      cov: bestCov,
      half: bestHalf,
      halfRatio: bestHalf / Math.max(1e-6, bestCov),
      grid: gridHit / Math.max(1, onsets.length),
      segMin: rates.length ? rates[0] : 0,
      segMed: rates.length ? rates[Math.floor(rates.length / 2)] : 0,
      phaseMs: bestPh,
    };
  }

  function scoreCandidateRow(row, onsets) {
    const m = beatGridFeatures(onsets, row.bpm, 45);
    const f = [row.score, row.contrast, m.cov, m.half, m.halfRatio, m.grid,
               Math.log2(row.bpm / 145), Math.log2(row.bpm / 120), 1, m.segMin, m.segMed];
    let z = BPM_SEL.w[0];
    for (let i = 0; i < f.length; i++) {
      z += BPM_SEL.w[i + 1] * ((f[i] - BPM_SEL.mu[i]) / BPM_SEL.sd[i]);
    }
    row.sel = z;
    row.phaseMs = m.phaseMs;
    return z;
  }
  /** 给定周期和相位，返回起音落在 16 分网格上的平均质量 + 分段质量 */
  function gridQuality(onsets, bpm, phaseMs, tolMs) {
    const step = (60000 / bpm) / 4;
    let sum = 0;
    for (let i = 0; i < onsets.length; i++) {
      const g = (onsets[i].time - phaseMs) / step;
      const d = Math.abs(g - Math.round(g)) * step;
      if (d <= tolMs) sum += 1 - d / tolMs;
    }
    return sum / Math.max(1, onsets.length);
  }

  /** 最优相位 */
  function bestPhaseFor(onsets, bpm, tolMs) {
    const step = (60000 / bpm) / 4;
    let bestPh = 0, bestQ = -1;
    for (let k = 0; k < 32; k++) {
      const ph = (step * k) / 32;
      const q = gridQuality(onsets, bpm, ph, tolMs);
      if (q > bestQ) { bestQ = q; bestPh = ph; }
    }
    return { phase: bestPh, q: bestQ };
  }

  /**
   * 在 bpm0 附近细搜周期 + 相位，再吸附到有理数（整数/半/四分之一）。
   * 人写谱的 BPM 几乎都是这些值；精确周期在全曲的残差显著更低。
   */
  function fitTempoGrid(onsets, bpm0, tolMs, rangeFrac) {
    if (!onsets || onsets.length < 40) return null;
    const tol = tolMs || 28;
    let best = null;
    for (let k = -30; k <= 30; k++) {
      const bpm = bpm0 * (1 + k * 0.0005);
      const bp = bestPhaseFor(onsets, bpm, tol);
      if (!best || bp.q > best.q) best = { bpm: bpm, phaseMs: bp.phase, q: bp.q, snapped: false };
    }
    if (!best) return null;
    const cands = [];
    for (const div of [1, 2, 4]) {
      const v = Math.round(best.bpm * div) / div;
      if (v > 30 && v < 400) cands.push(v);
    }
    for (const v of cands) {
      const bp = bestPhaseFor(onsets, v, tol);
      if (bp.q >= best.q * 0.985) {
        return { bpm: v, phaseMs: bp.phase, q: bp.q, snapped: true };
      }
    }
    return best;
  }


  function estimateTempo(flux, frameRate, onsetList) {
    const minBpm = 60;
    const maxBpm = 240;
    const minLag = Math.max(2, Math.round((60 * frameRate) / maxBpm));
    const maxLag = Math.min(flux.length - 1, Math.round((60 * frameRate) / minBpm));
    if (maxLag <= minLag) return { bpm: 120, periodFrames: (60 * frameRate) / 120, phase: 0 };

    const scores = autocorrelation(flux, minLag, maxLag);

    // 速度先验：放宽到 sigma 0.8，中心还是 145（硬核/电子大多落在 120~200）
    const prior = function (bpm) {
      const x = Math.log2(bpm / 145) / 0.8;
      return Math.exp(-0.5 * x * x);
    };

    // ① 自相关的前几个峰当种子
    const peaks = [];
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (scores[lag] > scores[lag - 1] && scores[lag] >= scores[lag + 1]) peaks.push(lag);
    }
    peaks.sort(function (a, b) { return scores[b] - scores[a]; });
    const seeds = peaks.slice(0, 6);
    if (!seeds.length) seeds.push(minLag);

    // ② 每个种子扩展出倍速候选（三连音比例会污染结果，已移除）
    // 只保留八度/倍速关系。三连音比例（2/3、3/2…）在实测中大量赢过真值：
    // 188.5→138.1(×3/4)、215→143.8(×2/3)、128→191.4(×3/2) 都是这类误判
    const ratios = [1, 0.5, 2];
    const cands = {};
    for (let s = 0; s < seeds.length; s++) {
      for (let r = 0; r < ratios.length; r++) {
        const lag = Math.round(seeds[s] * ratios[r]);
        if (lag < minLag || lag > maxLag) continue;
        const bpm = (60 * frameRate) / lag;
        if (bpm < minBpm || bpm > maxBpm) continue;
        cands[lag] = true;
      }
    }

    // ③ 每个候选算「正拍/半拍对比度 × 先验」，取最高
    let bestLag = minLag;
    let bestScore = -1e9;
    let bestPhase = 0;
    const keys = Object.keys(cands);
    const rows = [];
    let maxOn = 1e-6;
    for (let i = 0; i < keys.length; i++) {
      const lag = Number(keys[i]);
      const bc = beatContrast(flux, lag);
      const bpm = (60 * frameRate) / lag;
      if (bc.onAvg > maxOn) maxOn = bc.onAvg;
      rows.push({ lag: lag, bpm: bpm, contrast: bc.contrast, onAvg: bc.onAvg, phase: bc.phase, score: 0 });
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // 正拍要够强（能量项）+ 正拍比半拍明显（对比度项）× 速度先验
      const energy = Math.min(1, r.onAvg / maxOn);
      // 低于 80 BPM 的候选要打折：三拍子/一小节一次的周期很容易靠「正拍全中」赢，
      // 但那不是人跳舞的速度
      const slowFloor = r.bpm < 80 ? Math.max(0.12, (r.bpm - 45) / 35) : 1;
      const score = r.contrast * (0.35 + 0.65 * energy) * prior(r.bpm) * slowFloor;
      r.score = score;
      if (score > bestScore) {
        bestScore = score;
        bestLag = r.lag;
        bestPhase = r.phase;
      }
    }

    // 用选择器重选（候选里含倍速，选择器负责挑对的那个）
    let selPeriod = null, selPhase = null;
    if (onsetList && onsetList.length > 30) {
      let selBest = null, selBestV = -1e9;
      for (let i = 0; i < rows.length; i++) {
        const v = scoreCandidateRow(rows[i], onsetList);
        if (v > selBestV) { selBestV = v; selBest = rows[i]; }
      }
      if (selBest) {
        selPeriod = parabolicPeak(scores, selBest.lag) || selBest.lag;
        selPhase = (selBest.phaseMs * frameRate) / 1000;
      }
    }

    let periodFrames = selPeriod != null ? selPeriod : (parabolicPeak(scores, bestLag) || bestLag);
    let bc2 = selPhase != null ? { phase: selPhase } : beatContrast(flux, periodFrames);

    // 半速陷阱：4/4 里底鼓在 1、3 拍，军鼓在 2、4 拍，
    // 自相关会稳定地偏爱「两拍」的周期。判据是——
    // 如果正拍之间「那一半」也有很强的起音，真实拍长就是它的一半。
    (function tryDouble() {
      if (periodFrames < 4) return;
      let onSum = 0, midSum = 0, n = 0;
      for (let k = 0; ; k++) {
        const iOn = Math.round(bc2.phase + k * periodFrames);
        if (iOn >= flux.length) break;
        onSum += sampleMax(flux, iOn);
        const iMid = Math.round(bc2.phase + (k + 0.5) * periodFrames);
        if (iMid < flux.length) midSum += sampleMax(flux, iMid);
        n++;
      }
      if (!n) return;
      const on = onSum / n;
      const mid = midSum / n;
      if (on <= 1e-6) return;
      const half = periodFrames / 2;
      const halfBpm = (60 * frameRate) / half;
      if (mid / on < 0.62) return;                  // 中间是空的，说明半速才是对的
      if (halfBpm > maxBpm) return;                 // 加倍后超出范围
      if (prior(halfBpm) < 0.45) return;            // 先验太不认
      periodFrames = half;
      bc2 = beatContrast(flux, periodFrames);
    })();

    rows.sort(function (a, b) { return b.score - a.score; });
    // 精细拟合 + 吸附到有理数（120.2 → 120.0），治「后半段漂移」
    let outBpm = (60 * frameRate) / periodFrames;
    let outPhase = bc2.phase;
    if (onsetList && onsetList.length > 40) {
      const fit = fitTempoGrid(onsetList, outBpm, 28);
      if (fit && fit.q >= 0.15) {
        outBpm = fit.bpm;
        outPhase = (fit.phaseMs * frameRate) / 1000;
        periodFrames = (60 * frameRate) / outBpm;
      }
    }

    return {
      bpm: outBpm,
      periodFrames: periodFrames,
      phase: outPhase,
      candidates: rows.slice(0, 12),
    };
  }

  /* ================================================================== *
   * 生成管线 V2
   *
   * 老管线的毛病：选点 → 和弦 → 间隔过滤 → 轨道分配，每一步都可能悄悄丢音，
   * 最后在某些段落留下 10 秒空洞。V2 把顺序改成：
   *   1) 选点（模型或规则）
   *   2) 分配轨道——**保证每个点都有音符，一个都不丢**
   *   3) 装饰（和弦 / 长条）——只在「不冲突」时加
   *   4) 兜底——每 4 小节检查密度，不够就补
   * ================================================================== */

  /** 选点：按难度网格 + 模型概率，全局取前 N，再给稀段落补保底 */

  /**
   * 分配轨道：一个点都不丢，但必须守住「同列最小间隔」。
   * 长条会占住整段，后续不能在同列插音。
   */
  // 连续音的音型池。之前只会「相邻 +1」，所以谱面到处是楼梯。
  const MOTIFS_EASY = ['up', 'down', 'jump', 'up', 'down', 'jump'];
  const MOTIFS_HARD = ['up', 'down', 'jump', 'trill', 'up', 'down', 'trill'];



  /** 装饰：和弦与长条。加之前必须确认不冲突，冲突就不加（宁可没有） */

  /**
   * 同列间隔修正：和弦的镜像音是在轨道分配之后加的，会绕过间隔检查，
   * 造成同一列 70~100ms 内连响（手按不过来）。这里做一次后处理：
   * 谁撞了就换到空闲的列，换不动就删掉（和弦少一个音比按不过来好）。
   */

  /** 同一列连续 3 个以上音（间隔很近）会把第 3 个起搬走；搬不动就删 */


  /* ================================================================== *
   * 实验版生成器：纯序列模型，无任何规则
   *
   * 不做段落密度控制、不做同列间隔、不做最长空档、不做和弦规则——
   * 每个 16 分格放不放音符、放哪几列，全部由网络输出决定。
   * ================================================================== */


  /* ================================================================== *
   * 间隔模型生成器
   *
   * 每一步：看「当前格 + 往后 16 格的起音强度 + 前 4 个事件」，
   *        预测「下一个音在第几个 16 分格」。
   *
   * 关键：间隔是整数个 16 分格 → 音符永远在拍点上；
   *       输入含往后的起音强度 → 它是在「看着谱面选址」，不是数拍子。
   * ================================================================== */


  /* ================================================================== *
   * 检索式生成器
   *
   * ① 每小节在「人排片段库」里检索起音形状最像的若干片段
   * ② 只迁移「哪些起音上放音符」这个选择模式：
   *    用 DTW 把源小节的起音位置对齐到目标小节的起音位置，
   *    再把音符按映射放过去 —— **不照搬源小节的时刻**
   * ③ 用学到的衔接偏好重排，挑总分最高的
   * ================================================================== */
  let PHRASES = null;

  function loadPhrases() {
    if (PHRASES) return PHRASES;
    var M = (typeof window !== 'undefined') && window.M4K;
    if (!M || !M.PHRASE_B64) return null;
    var b64 = M.PHRASE_B64;
    var bin;
    if (typeof atob === 'function') {
      var s = atob(b64);
      bin = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i);
    } else {
      bin = new Uint8Array(Buffer.from(b64, 'base64'));
    }
    var dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    if (bin[0] !== 80 || bin[1] !== 72 || bin[2] !== 82 || bin[3] !== 49) return null;
    var n = dv.getUint32(4, true);
    var REC = 50;                     // 16 + 1 + 1 + 32
    var out = [];
    for (var r = 0; r < n; r++) {
      var off = 8 + r * REC;
      var prof = new Float32Array(16);
      for (var j = 0; j < 16; j++) prof[j] = bin[off + j] / 255;
      var tier = bin[off + 16];
      var cnt = bin[off + 17];
      var notes = [];
      for (var k = 0; k < cnt; k++) {
        var v = dv.getUint16(off + 18 + k * 2, true);
        if (v === 0xFFFF) continue;
        notes.push([v >> 2, v & 3]);
      }
      out.push({ prof: prof, tier: tier, notes: notes });
    }
    PHRASES = out;
    return PHRASES;
  }

  /** DTW：把 src(16) 的每个位置映射到 dst(16) */
  function dtwMap(src, dst) {
    var N = 16, INF = 1e9;
    var D = new Float32Array((N + 1) * (N + 1));
    for (var i = 0; i <= N; i++) for (var j = 0; j <= N; j++) D[i * (N + 1) + j] = INF;
    D[0] = 0;
    for (var a = 1; a <= N; a++) {
      for (var b = 1; b <= N; b++) {
        var c = Math.abs(src[a - 1] - dst[b - 1]);
        var m = Math.min(D[(a - 1) * (N + 1) + (b - 1)], D[(a - 1) * (N + 1) + b], D[a * (N + 1) + (b - 1)]);
        D[a * (N + 1) + b] = c + m;
      }
    }
    var mp = {};
    var i2 = N, j2 = N;
    while (i2 > 0 && j2 > 0) {
      if (mp[i2 - 1] === undefined) mp[i2 - 1] = j2 - 1;
      var c2 = Math.abs(src[i2 - 1] - dst[j2 - 1]);
      var cur = D[i2 * (N + 1) + j2];
      if (Math.abs(cur - c2 - D[(i2 - 1) * (N + 1) + (j2 - 1)]) < 1e-7) { i2--; j2--; }
      else if (Math.abs(cur - c2 - D[(i2 - 1) * (N + 1) + j2]) < 1e-7) { i2--; }
      else { j2--; }
    }
    return mp;
  }



  /* ================================================================== *
   * 按拍生成器
   *
   * 人排 87% 的拍子有音符（normal），而逐格生成只有 75%——因为它按「起音」思考。
   * 这里按「拍」生成：先判断这一拍要不要有音，再选这一拍的细分掩码。
   * ================================================================== */
  var BEAT = null;

  function loadBeatModel() {
    if (BEAT) return BEAT;
    var M = (typeof window !== 'undefined') && window.M4K;
    if (!M || !M.BEAT_WEIGHTS) return null;
    var d = M.BEAT_WEIGHTS;
    function f32(s) {
      if (typeof atob === 'function') {
        var bin = atob(s);
        var out = new Float32Array(bin.length / 4);
        for (var i = 0; i < out.length; i++) {
          var v = (bin.charCodeAt(i*4) | (bin.charCodeAt(i*4+1) << 8) | (bin.charCodeAt(i*4+2) << 16) | (bin.charCodeAt(i*4+3) << 24)) >>> 0;
          out[i] = new Float32Array(new Uint32Array([v]).buffer)[0];
        }
        return out;
      }
      var buf = Buffer.from(s, 'base64');
      return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    }
    BEAT = { inDim: d.inDim, hid: d.hid };
    for (var k in d) {
      if (k === 'inDim' || k === 'hid') continue;
      BEAT[k] = f32(d[k]);
    }
    return BEAT;
  }

  function lin(x, w, b, outN, inN) {
    var o = new Float32Array(outN);
    for (var i = 0; i < outN; i++) {
      var s = b[i], base = i * inN;
      for (var j = 0; j < inN; j++) s += w[base + j] * x[j];
      o[i] = s;
    }
    return o;
  }

  function generateBeat(analysis, opts) {
    if (!analysis._mel && analysis._pcm) {
      analysis._mel = computeMel(analysis._pcm, analysis._pcmSr || 22050);
    }
    var mel = analysis._mel;
    if (!mel) return null;

    var beat = analysis.beatMs;
    var offset = analysis.offset;
    var step = beat / 4;
    var nSlot = Math.floor((analysis.duration - offset) / step);
    var nBeat = Math.floor(nSlot / 4);
    if (nBeat < 32) return null;

    // 真实拍点（本地节拍服务返回）；没有就用均匀网格
    var beatTimes = (analysis.beatsMs && analysis.beatsMs.length > 8) ? analysis.beatsMs : null;
    if (beatTimes) nBeat = Math.min(nBeat, beatTimes.length - 1);
    function beatTimeOf(b) {
      if (!beatTimes) return offset + b * beat;
      return beatTimes[Math.max(0, Math.min(beatTimes.length - 1, b))];
    }

    var srcAll = (analysis.onsets || []).filter(function (o) { return o.strength > 0.14; });
    var energy = analysis.energy || [];
    var tierId = opts.difficulty === 'easy' ? 0 : (opts.difficulty === 'hard' ? 2 : 1);

    // ---- 每拍能量 + 长窗口平滑（人排密度是「一段一段」的）----
    var beatEnergy = new Array(nBeat).fill(0);
    var beatOf = function (tms) {
      var lo = 0, hi = nBeat - 1, best = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (beatTimeOf(mid) <= tms) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return best;
    };
    for (var ei = 0; ei < srcAll.length; ei++) {
      var oo = srcAll[ei];
      if (oo.time < offset) continue;
      var bi = beatOf(oo.time);
      if (bi < 0 || bi >= nBeat) continue;
      var wgt = oo.band === 'low' ? 1.25 : (oo.band === 'mid' ? 1.1 : 0.75);
      beatEnergy[bi] += oo.strength * wgt;
    }
    var R = 6;
    var smoothed = new Array(nBeat).fill(0);
    for (var sb = 0; sb < nBeat; sb++) {
      var acc = 0, cnt = 0;
      for (var off2 = -R; off2 <= R; off2++) {
        var idx2 = sb + off2;
        if (idx2 < 0 || idx2 >= nBeat) continue;
        var w2 = 1 - Math.abs(off2) / (R + 1);
        acc += beatEnergy[idx2] * w2;
        cnt += w2;
      }
      smoothed[sb] = cnt > 0 ? acc / cnt : 0;
    }
    var sortedE = smoothed.slice().sort(function (x, y) { return x - y; });
    var q10 = sortedE[Math.floor(nBeat * 0.10)] || 0;
    var q40 = sortedE[Math.floor(nBeat * 0.40)] || 0;
    var q70 = sortedE[Math.floor(nBeat * 0.70)] || 0;
    var q97 = sortedE[Math.floor(nBeat * 0.97)] || 0;

    // ---- 起音时间表（吸附用）----
    var onsetTimes = srcAll.map(function (o) { return o.time; }).sort(function (x, y) { return x - y; });
    function snapNear(tms, tol) {
      if (!onsetTimes.length) return null;
      var lo = 0, hi = onsetTimes.length - 1, best = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (onsetTimes[mid] <= tms) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      var pickT = -1, pd = tol + 1;
      for (var k = Math.max(0, best - 1); k <= Math.min(onsetTimes.length - 1, best + 2); k++) {
        var d = Math.abs(onsetTimes[k] - tms);
        if (d < pd) { pd = d; pickT = onsetTimes[k]; }
      }
      return pd <= tol ? Math.round(pickT) : null;
    }

    // ---- 铺格：先按「每秒音符数」定密度，再落点 ----
    var tierRate = tierId === 0 ? 3.0 : (tierId === 2 ? 8.5 : 5.0);
    var wantPerBeat = tierRate * (beat / 1000);
    var pickedRaw = [];
    var levelAcc = 0;
    var prevLevel = 1;
    for (var pb = 0; pb < nBeat; pb++) {
      var e = smoothed[pb];
      var level = 0;
      if (e >= q10) {
        // 活跃的拍先保证 1 个音（四分填充率），多的用累积器加
        var extra = wantPerBeat - 1;
        levelAcc += extra;
        level = 1;
        if (levelAcc >= 1.4) { level = 3; levelAcc -= 2.4; }
        else if (levelAcc >= 0.4) { level = 2; levelAcc -= 1.0; }
        // 安静段落降级（保留起伏），但至少保留 1 个音
        if (e < q40 && level > 1) { levelAcc += (level - 1); level = 1; }
        // 限制跳变：相邻拍最多升一级，避免高潮段突然暴增
        if (level > prevLevel + 1) { levelAcc += (level - (prevLevel + 1)); level = prevLevel + 1; }
        if (tierId === 0 && level > 2) { levelAcc += (level - 2); level = 2; }
        prevLevel = level;
      }
      var t0d = beatTimeOf(pb), t1d = beatTimeOf(pb + 1);
      if (t1d <= t0d) continue;
      var nSub = level === 1 ? 1 : (level === 2 ? 2 : 4);
      for (var sub = 0; sub < nSub; sub++) {
        var tt = t0d + (t1d - t0d) * (sub / nSub);
        // easy 收紧吸附：避免把正拍位置拉到反拍的起音上
            var sn = snapNear(tt, tierId === 0 ? 40 : 55);
            if (sn !== null) pickedRaw.push(sn);
            else if (tierId === 0 && e >= q40) pickedRaw.push(Math.round(tt));   // easy：只在高潮段补「拍上有音」
            else if (e >= q97) pickedRaw.push(Math.round(tt));
      }
    }

    // ---- 收尾：合并近点（和弦同时）→ 吸附 1/12 拍 → 去重 ----
    pickedRaw.sort(function (x, y) { return x - y; });
    var merged = [];
    for (var mi = 0; mi < pickedRaw.length; mi++) {
      if (merged.length && pickedRaw[mi] - merged[merged.length - 1] <= 25) continue;
      merged.push(pickedRaw[mi]);
    }
    var fine = beat / 12;
    for (var fi = 0; fi < merged.length; fi++) {
      var g2 = Math.round((merged[fi] - offset) / fine);
      var sn2 = offset + g2 * fine;
      if (Math.abs(sn2 - merged[fi]) <= 12) merged[fi] = Math.round(sn2);
    }
    var pickedTimes = [];
    for (var di = 0; di < merged.length; di++) {
      if (pickedTimes.length && Math.abs(merged[di] - pickedTimes[pickedTimes.length - 1]) <= 25) continue;
      pickedTimes.push(merged[di]);
    }

    // ---- 列：阶段 B（GRU，带历史）+ 和弦预算 ----
    var notes = [];
    var SEQm = (typeof window !== 'undefined') && window.M4K && window.M4K.SEQ;
    if (SEQm && SEQm.stage2Columns) {
      var sets = SEQm.stage2Columns(mel, pickedTimes, mel.rate, beat, 8);
      var cf = tierId === 0 ? 1.05 : (tierId === 2 ? 1.25 : 1.15);
      var budget = Math.round(pickedTimes.length * cf);
      var all = [];
      for (var pi2 = 0; pi2 < pickedTimes.length; pi2++) {
        var pr = sets && sets[pi2] ? sets[pi2] : [1, 0, 0, 0];
        for (var c = 0; c < 4; c++) all.push([pr[c], pi2, c]);
      }
      all.sort(function (a, b) { return b[0] - a[0]; });
      var perT = {}, cnt2 = 0;
      for (var ai = 0; ai < all.length && cnt2 < budget; ai++) {
        var ti = all[ai][1];
        if ((perT[ti] || 0) >= 2) continue;
        perT[ti] = (perT[ti] || 0) + 1;
        cnt2++;
        notes.push({ col: all[ai][2], time: pickedTimes[ti], end: null, isHold: false });
      }
    } else {
      for (var p3 = 0; p3 < pickedTimes.length; p3++) {
        notes.push({ col: p3 % 4, time: pickedTimes[p3], end: null, isHold: false });
      }
    }

    // ---- 键型模式（人排的交错式排键）----
    (function humanPatterns() {
      notes.sort(function (a, b) { return a.time - b.time || a.col - b.col; });
      var PAT = [
        [0,1,2,3], [3,2,1,0],
        [0,1,2,3,2,1], [3,2,1,0,1,2],
        [0,1,3,2], [3,2,0,1],
        [0,3,1,2], [3,0,2,1],
        [0,2,1,3], [3,1,2,0],
        [0,2,3,1], [3,1,0,2],
        [1,2,3,0], [2,1,0,3]
      ];
      var seed = 918273645;
      function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
      var groups = [];
      for (var i = 0; i < notes.length; i++) {
        var last = groups[groups.length - 1];
        if (last && Math.abs(last[0].time - notes[i].time) < 1) last.push(notes[i]);
        else groups.push([notes[i]]);
      }
      var k = 0;
      while (k < groups.length) {
        if (groups[k].length !== 1) { k++; continue; }
        var e2 = k;
        while (e2 + 1 < groups.length && groups[e2 + 1].length === 1) e2++;
        var len = e2 - k + 1;
        if (len < 4) { k = e2 + 1; continue; }
        var pat = PAT[Math.floor(rnd() * PAT.length)];
        var startCol = groups[k][0].col, off = 0, bestD = 9;
        for (var q = 0; q < pat.length; q++) {
          var d = Math.abs(pat[q] - startCol);
          if (d < bestD) { bestD = d; off = q; }
        }
        for (var g = 0; g < len; g++) groups[k + g][0].col = pat[(off + g) % pat.length];
        k = e2 + 1;
      }
    })();

    // ---- 乐句重复（复制列序，保留时间与密度）----
    (function phraseRepeat() {
      var PHRASE = 8;
      var nPh = Math.floor(nBeat / PHRASE);
      if (nPh < 2) return;
      var vec = [];
      for (var p = 0; p < nPh; p++) {
        var v = [];
        for (var bb = p * PHRASE; bb < (p + 1) * PHRASE && bb < nBeat; bb++) v.push(beatEnergy[bb] || 0);
        var nrm = Math.sqrt(v.reduce(function (a, x) { return a + x * x; }, 0)) || 1;
        vec.push(v.map(function (x) { return x / nrm; }));
      }
      var byPhrase = [];
      for (var p2 = 0; p2 < nPh; p2++) byPhrase.push([]);
      for (var ni = 0; ni < notes.length; ni++) {
        var ph = Math.floor(beatOf(notes[ni].time) / PHRASE);
        if (ph >= 0 && ph < nPh) byPhrase[ph].push(notes[ni]);
      }
      var seed = 20241111;
      function rnd2() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
      for (var p3 = 1; p3 < nPh; p3++) {
        var prev = byPhrase[p3 - 1], cur = byPhrase[p3];
        if (!prev.length || cur.length < 4) continue;
        var sim = 0;
        for (var k2 = 0; k2 < Math.min(vec[p3 - 1].length, vec[p3].length); k2++) sim += vec[p3 - 1][k2] * vec[p3][k2];
        if (sim < 0.80) continue;
        var mirror = rnd2() < 0.5;
        var lim = Math.min(cur.length, prev.length);
        for (var q2 = 0; q2 < lim; q2++) {
          cur[q2].col = mirror ? (3 - prev[q2].col) : prev[q2].col;
        }
      }
    })();

    // ---- 同列连打修复（90ms）----
    (function fixJacks() {
      notes.sort(function (a, b) { return a.time - b.time || a.col - b.col; });
      var lastPerCol = [-1e9, -1e9, -1e9, -1e9];
      for (var qi = 0; qi < notes.length; qi++) {
        var nt = notes[qi];
        if (nt.time - lastPerCol[nt.col] < 90) {
          var cand = -1, bestGap = -1;
          for (var c2 = 0; c2 < 4; c2++) {
            if (c2 === nt.col) continue;
            var gap = nt.time - lastPerCol[c2];
            if (gap >= 90 && gap > bestGap) { bestGap = gap; cand = c2; }
          }
          if (cand >= 0) nt.col = cand;
          else { notes.splice(qi, 1); qi--; continue; }
        }
        lastPerCol[nt.col] = nt.time;
      }
    })();

    // ---- 消同列兜底（放在所有列操作之后）----
    (function noRepeat() {
      notes.sort(function (a, b) { return a.time - b.time || a.col - b.col; });
      var groups2 = [];
      for (var i2 = 0; i2 < notes.length; i2++) {
        var last = groups2[groups2.length - 1];
        if (last && Math.abs(last[0].time - notes[i2].time) < 1) last.push(notes[i2]);
        else groups2.push([notes[i2]]);
      }
      var lastByCol = [-1e9, -1e9, -1e9, -1e9];
      var prevCol = -1, prevT = -1e9;
      for (var g2 = 0; g2 < groups2.length; g2++) {
        var grp = groups2[g2];
        var gT = grp[0].time;
        if (grp.length === 1) {
          var n0 = grp[0];
          if (prevCol >= 0 && n0.col === prevCol) {   // 无条件避开上一个音（人手不打连按）
            var order2 = [];
            if (prevCol > 0) order2.push(prevCol - 1);
            if (prevCol < 3) order2.push(prevCol + 1);
            order2.push(prevCol === 0 ? 2 : 0, prevCol === 3 ? 1 : 3);
            var pick = -1, pickScore = -1e18;
            for (var ci = 0; ci < order2.length; ci++) {
              var cc = order2[ci];
              var age = gT - lastByCol[cc];
              if (age <= 0.15 * beat) continue;
              var sc = age + (ci < 2 ? 0 : -1e6);
              if (sc > pickScore) { pickScore = sc; pick = cc; }
            }
            if (pick >= 0) n0.col = pick;
          }
          lastByCol[n0.col] = gT;
          prevCol = n0.col;
          prevT = gT;
        } else {
          for (var gi = 0; gi < grp.length; gi++) lastByCol[grp[gi].col] = gT;
          prevCol = -1;
          prevT = gT;
        }
      }
    })();

    // ---- 长条（最后做，基于最终位置）----
    // 小节密度上限：任何一个小节都不该超过目标密度的 1.35 倍
    (function capPerBar() {
      var barMs2 = beat * 4;
      var cap = Math.max(2, Math.round(tierRate * (barMs2 / 1000) * 1.35));
      var byBar = {};
      for (var i = 0; i < notes.length; i++) {
        var b = Math.floor((notes[i].time - offset) / barMs2);
        (byBar[b] = byBar[b] || []).push(notes[i]);
      }
      var keep = [];
      for (var k in byBar) {
        var arr = byBar[k];
        if (arr.length <= cap) { keep = keep.concat(arr); continue; }
        arr.sort(function (x, y) { return x.time - y.time || x.col - y.col; });
        var seenT = {}, singles = [];
        for (var j = 0; j < arr.length; j++) {
          var key = Math.round(arr[j].time / 8);
          if (seenT[key]) continue;
          seenT[key] = true;
          singles.push(arr[j]);
        }
        if (singles.length > cap) singles = singles.slice(0, cap);
        keep = keep.concat(singles);
      }
      notes = keep;
    })();

    // 列最小间隔：同一列 0.45 拍内不出现两次（含和弦成员）
    (function columnGap() {
      globalThis.__cg = (globalThis.__cg || 0) + 1;
      notes.sort(function (a, b) { return a.time - b.time || a.col - b.col; });
      var minGap = Math.max(120, beat * 0.6);
      var lastCol = [-1e9, -1e9, -1e9, -1e9];
      var prevNoteCol = -1;
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        if (n.time - lastCol[n.col] >= minGap) {
          lastCol[n.col] = n.time; prevNoteCol = n.col; continue;
        }
        var bestC = -1, bestAge = -1;
        for (var c = 0; c < 4; c++) {
          if (c === n.col || c === prevNoteCol) continue;   // 也避开上一个音
          var age = n.time - lastCol[c];
          if (age > bestAge) { bestAge = age; bestC = c; }
        }
        globalThis.__cgMove = (globalThis.__cgMove || 0) + 1;
        if (bestC >= 0 && bestAge >= minGap) {
          n.col = bestC; lastCol[bestC] = n.time; prevNoteCol = bestC;
        }
        else { notes.splice(i, 1); i--; }
      }
    })();

    (function makeHolds() {
      notes.sort(function (a, b) { return a.time - b.time || a.col - b.col; });
      var wantHolds = Math.round(notes.length * 0.10);
      var minGap = (tierId === 2) ? beat * 0.45 : beat * 0.9;
      var minLen = beat * (tierId === 2 ? 0.3 : 0.45);
      var seedH = 776655;
      function rndH() { seedH = (seedH * 1103515245 + 12345) & 0x7fffffff; return seedH / 0x7fffffff; }
      var cands = [];
      for (var i3 = 0; i3 < notes.length; i3++) {
        var nt3 = notes[i3];
        var nextT = Infinity;
        for (var j3 = i3 + 1; j3 < notes.length; j3++) {
          if (notes[j3].col !== nt3.col) continue;
          if (notes[j3].time > nt3.time + 1) { nextT = notes[j3].time; break; }
        }
        if (!isFinite(nextT) || nextT - nt3.time < minGap) continue;
        var smax = 0;
        for (var hk = 0; hk < srcAll.length; hk++) {
          if (srcAll[hk].time >= nt3.time + beat * 2 + 40) break;
          if (srcAll[hk].time >= nt3.time - 20 && srcAll[hk].strength > smax) smax = srcAll[hk].strength;
        }
        cands.push([Math.min(nextT - nt3.time, beat * 3) + smax * 200, i3]);
      }
      cands.sort(function (x, y) { return y[0] - x[0]; });
      var made = 0, holdTimes = [];
      for (var hc = 0; hc < cands.length && made < wantHolds; hc++) {
        var idH = cands[hc][1];
        var ntH = notes[idH];
        if (ntH.isHold) continue;
        var next2 = Infinity;
        for (var j4 = 0; j4 < notes.length; j4++) {
          if (j4 === idH) continue;
          var nx = notes[j4];
          if (nx.col !== ntH.col || nx.time <= ntH.time + 1) continue;
          next2 = nx.time; break;
        }
        var tooClose = false;
        for (var ht = 0; ht < holdTimes.length; ht++) {
          if (Math.abs(holdTimes[ht] - ntH.time) < beat * 0.9) { tooClose = true; break; }
        }
        if (tooClose) continue;
        var lenBeats = 0.5 + rndH() * 1.0;
        var endT = Math.min(ntH.time + beat * lenBeats, next2 - beat * 0.15);
        if (endT - ntH.time < minLen) continue;
        holdTimes.push(ntH.time);
        ntH.isHold = true;
        ntH.end = Math.round(endT);
        made++;
      }
    })();

    notes.sort(function (a, b) { return a.time - b.time || a.col - b.col; });
    for (var ni2 = 0; ni2 < notes.length; ni2++) notes[ni2].id = ni2;

    return {
      keyCount: 4,
      notes: notes,
      meta: {
        title: opts.title || '按拍生成',
        artist: opts.artist || '',
        version: 'BEAT',
        creator: 'Rhythm4K',
        source: '', tags: '', background: '', video: '', videoStart: 0,
        events: [], mode: 3,
      },
      auto: {
        bpm: Math.round(analysis.bpm * 10) / 10,
        offset: Math.round(offset),
        difficulty: opts.difficulty || 'normal',
        version: ANALYZER_VERSION,
      },
      audioFilename: '',
      difficulty: { OverallDifficulty: 8, HPDrainRate: 7 },
    };
  }


  function generate(analysis, options) {
    const opts = options || {};
    return generateBeat(analysis, opts);
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
    const combinedTempo = new Float32Array(Math.floor(x.length / FRAME));
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

      // 测速用的合成流：低频（底鼓）主导。三个频段等权的话，
      // 电子乐里密集的踩镲会把节拍彻底淹掉（实测对比度掉到 0.05 以下）。
      const w = band.name === 'low' ? 1.0 : band.name === 'mid' ? 0.55 : 0.15;
      for (let i = 0; i < flux.length && i < combinedTempo.length; i++) {
        combinedTempo[i] += flux[i] * w;
      }

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

    const tempo = estimateTempo(normalize(combinedTempo), frameRate, onsets);
    // 测速候选（排查用）
    const beatMs = 60000 / tempo.bpm;

    // 相位精修：tempo.phase 只有能量帧的精度（约 5.8ms），
    // 而吸附容差只有 stepMs 的 25%（190 BPM 时 25ms）。
    // 相位偏 30ms 就会让整片起音被判成「不在网格上」全部丢掉。
    // 这里用毫秒级的起音时刻再做一次 ±半拍、1ms 步进的搜索。
    let offsetMs = (tempo.phase / frameRate) * 1000;
    (function refinePhase() {
      const strong = onsets.filter(function (o) { return o.strength >= 0.25; });
      if (strong.length < 20) return;
      const base = offsetMs;
      let best = base;
      let bestScore = -1;
      for (let off = base - beatMs / 2; off <= base + beatMs / 2; off += 1) {
        let s = 0;
        for (let i = 0; i < strong.length; i++) {
          const rel = (strong[i].time - off) / beatMs;
          const d = Math.abs(rel - Math.round(rel)) * beatMs;
          if (d < 10) s += strong[i].strength * (1 - d / 10);
        }
        if (s > bestScore) { bestScore = s; best = off; }
      }
      offsetMs = best;
    })();

    // 小节相位：grid 的哪一拍是小节第一拍。
    // 注意必须用「精修后的 offsetMs」来算——早期用的是 tempo.phase（能量帧精度），
    // 相位精修之后就差了将近一拍，和弦会整片落到第二拍上。
    let downbeat = 0;
    let bestDown = -1;
    for (let p = 0; p < 4; p++) {
      let s = 0;
      for (let i = 0; i < onsets.length; i++) {
        const o = onsets[i];
        const rel = (o.time - offsetMs - p * beatMs) / (beatMs * 4);
        const d = Math.abs(rel - Math.round(rel)) * beatMs * 4;
        if (d < 25) s += o.strength * (1 - d / 25);
      }
      if (s > bestDown) { bestDown = s; downbeat = p; }
    }

    return {
      _pcm: samples, _pcmSr: sampleRate,
      bpm: tempo.bpm,
      tempoCandidates: tempo.candidates || null,
      beatMs: beatMs,
      offset: offsetMs,
      downbeat: downbeat,
      onsets: onsets,
      duration: (samples.length / sampleRate) * 1000,
      frameRate: frameRate,
      bands: fluxes,
      envs: envs,
      energy: curve.curve,
      bars: analyzeBars({
        frameRate: frameRate, beatMs: beatMs, offset: offsetMs,
        duration: (samples.length / sampleRate) * 1000,
        envs: envs, onsets: onsets,
      }),
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
    easy: { stepsPerBeat: 2, minGapBeats: 0.5, minStrength: 0.32, runGapBeats: 0.58, maxChord: 2, chordOnBeats: [0], chordFactor: 0.7, targetPerBeat: 0.7 },
    normal: { stepsPerBeat: 4, minGapBeats: 0.24, minStrength: 0.09, runGapBeats: 0.62, maxChord: 2, chordOnBeats: [0, 2], chordFactor: 1.9, targetPerBeat: 1.25 },
    hard: { stepsPerBeat: 4, minGapBeats: 0.22, minStrength: 0.10, runGapBeats: 0.7, maxChord: 3, chordOnBeats: [0, 1, 2, 3], chordFactor: 2.4, targetPerBeat: 2.0 },
  };

  /**
   * 整曲能量曲线（0..1，约 1 秒平滑）。
   * 用来区分「高潮 / 间奏」：高潮段和声厚、压缩重，能量上升沿反而少，
   * 光靠起音检测会让高潮比间奏还空，所以要按段落强度反过来调密度。
   */
  /**
   * 小节级特征 + 重复分组。
   *
   * 人排谱的核心习惯：乐句重复的地方，谱面也重复；只有变奏段才改写法。
   * 要复现这个，先得知道「哪几小节是同一段音乐」。
   * 做法：每小节取三个频段的平均能量 + 起音密度构成特征向量，
   * 余弦相似度超过阈值的归到同一个组（组号 = 首次出现的小节）。
   */
  function analyzeBars(analysis) {
    const beatMs = analysis.beatMs;
    const barMs = beatMs * 4;
    const offset = analysis.offset;
    const total = analysis.duration;
    const count = Math.max(0, Math.floor((total - offset) / barMs));
    if (count < 4) return null;

    const onsets = analysis.onsets || [];
    const stepMs = beatMs / 4;

    // 每小节只取「重音」（≥ 本小节最强的 60%），做成 16 位二值掩码。
    // 用强度值算余弦没用——电子乐里几乎每个十六分都有踩镲，任意两小节的
    // 余弦都在 0.88 以上，分不出「这段是哪段」。二值掩码 + Jaccard 才行。
    const masks = [];
    for (let b = 0; b < count; b++) {
      const t0 = offset + b * barMs;
      const t1 = t0 + barMs;
      let mx = 0;
      for (let i = 0; i < onsets.length; i++) {
        const o = onsets[i];
        if (o.time >= t0 && o.time < t1 && o.strength > mx) mx = o.strength;
      }
      const m = new Uint8Array(16);
      for (let i = 0; i < onsets.length; i++) {
        const o = onsets[i];
        if (o.time < t0 || o.time >= t1) continue;
        if (o.strength < mx * 0.6) continue;
        let s = Math.round((o.time - t0) / stepMs) % 16;
        if (s < 0) s += 16;
        m[s] = 1;
      }
      masks.push(m);
    }

    const jac = function (a, c) {
      let inter = 0;
      let uni = 0;
      for (let i = 0; i < 16; i++) {
        if (a[i] || c[i]) uni++;
        if (a[i] && c[i]) inter++;
      }
      return uni ? inter / uni : 0;
    };

    // 找最像自己的另一小节（距离 ≥ 2），要求相似度够高
    const SIM = 0.65;
    const groups = new Array(count);
    for (let b = 0; b < count; b++) groups[b] = b;
    for (let b = 2; b < count; b++) {
      let best = -1;
      let bestScore = SIM;
      for (let j = Math.max(0, b - 32); j <= b - 2; j++) {
        const s = jac(masks[b], masks[j]);
        if (s > bestScore) { bestScore = s; best = j; }
      }
      if (best >= 0) groups[b] = groups[best];
    }

    const distCount = {};
    for (let b = 0; b < count; b++) {
      if (groups[b] === b) continue;
      const d = b - groups[b];
      if (d > 0 && d <= 32) distCount[d] = (distCount[d] || 0) + 1;
    }
    let phraseLen = 0;
    let bestD = 0;
    for (const d in distCount) {
      if (distCount[d] > bestD) { bestD = distCount[d]; phraseLen = Number(d); }
    }
    let repeated = 0;
    for (let b = 0; b < count; b++) if (groups[b] !== b) repeated++;

    return {
      count: count,
      groups: groups,
      phraseLength: phraseLen,
      repeated: repeated,
      masks: masks,
    };
  }
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
    const half = Math.round(fr * 2.5);
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

  /**
   * 乐句重复：在音乐重复的小节里，沿用「第一次出现」那个小节的节奏型。
   *
   * 人排谱在重复段会复用同一套音型，机械生成每小节独立决定就会显得散。
   * 做法是取交集：只保留「源小节也有」的十六分位置——
   * 时间用本小节自己的起音时刻（精度不丢），不一致的音符丢掉。
   */
  function applyBarRepeats(events, analysis, offset, beatMs) {
    const bars = analysis.bars;
    if (!bars || !bars.groups) return events;
    const barMs = beatMs * 4;
    const step = beatMs / 4;

    const byBar = new Map();
    for (let i = 0; i < events.length; i++) {
      const b = Math.floor((events[i].time - offset) / barMs + 1e-6);
      if (!byBar.has(b)) byBar.set(b, []);
      byBar.get(b).push(events[i]);
    }

    const out = [];
    // 注意要遍历**所有**小节（不是只遍历有事件的那些）：
    // 声部选择可能把某个重复小节的音全筛掉，那样它就拿不到源小节的节奏，
    // 同一段音乐两次出现的写法就不一样了。
    for (let b = 0; b < bars.count; b++) {
      const list = byBar.get(b) || [];
      const src = bars.groups[b];
      const srcList = (src !== b && src >= 0) ? byBar.get(src) : null;

      if (!srcList || !srcList.length) {
        for (let i = 0; i < list.length; i++) out.push(list[i]);
        continue;
      }

      const srcStart = offset + src * barMs;
      const barStart = offset + b * barMs;

      // ① 先铺源小节的节奏（平移过来）——这是「重复段听起来一样」的来源
      const usedCls = {};
      for (let i = 0; i < srcList.length; i++) {
        const e = srcList[i];
        const t = barStart + (e.time - srcStart);
        usedCls[Math.round((e.time - srcStart) / step)] = true;
        out.push({
          time: t,
          strength: e.strength,
          band: e.band,
          chord: e.chord,
          intensity: e.intensity,
          barBeat: e.barBeat,
          onBeat: e.onBeat,
          sub: e.sub,
          copied: true,
        });
      }

      // ② 再补上本小节自己独有的重音。
      //    只复制源节奏会削掉密度（实测 -10%），补重音既保住密度又不破坏一致性。
      let localMax = 0;
      for (let i = 0; i < list.length; i++) if (list[i].strength > localMax) localMax = list[i].strength;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const c = Math.round((e.time - barStart) / step);
        if (usedCls[c]) continue;
        if (e.strength < localMax * 0.72) continue;
        usedCls[c] = true;
        out.push(e);
      }
    }

    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  /* ---------------- 梅尔频谱（给采音时机模型用） ---------------- */
  const MEL_NFFT = 1024;
  const MEL_HOP = 256;
  const MEL_BINS = 24;

  function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  /** 原地基-2 FFT（长度必须是 2 的幂） */
  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  function melFilterbankJs(sr) {
    const nBins = MEL_NFFT / 2 + 1;
    const hz2m = function (h) { return 2595 * Math.log10(1 + h / 700); };
    const m2hz = function (m) { return 700 * (Math.pow(10, m / 2595) - 1); };
    const lo = hz2m(20), hi = hz2m(sr / 2);
    const hz = [];
    for (let i = 0; i < MEL_BINS + 2; i++) hz.push(m2hz(lo + (hi - lo) * i / (MEL_BINS + 1)));
    const fb = [];
    for (let i = 0; i < MEL_BINS; i++) {
      const row = new Float32Array(nBins);
      const l = hz[i], c = hz[i + 1], r = hz[i + 2];
      for (let b = 0; b < nBins; b++) {
        const fq = b * (sr / 2) / (nBins - 1);
        const up = (fq - l) / Math.max(1e-9, c - l);
        const dn = (r - fq) / Math.max(1e-9, r - c);
        row[b] = Math.max(0, Math.min(up, dn));
      }
      fb.push(row);
    }
    return fb;
  }

  /** 返回 { data: Float32Array(frames*24), frames, rate } */
  function computeMel(pcm, sr) {
    const fb = melFilterbankJs(sr);
    const win = hannWindow(MEL_NFFT);
    const frames = Math.max(1, Math.floor((pcm.length - MEL_NFFT) / MEL_HOP) + 1);
    const data = new Float32Array(frames * MEL_BINS);
    const re = new Float32Array(MEL_NFFT);
    const im = new Float32Array(MEL_NFFT);
    const nBins = MEL_NFFT / 2 + 1;
    const mag = new Float32Array(nBins);
    for (let i = 0; i < frames; i++) {
      const base = i * MEL_HOP;
      for (let k = 0; k < MEL_NFFT; k++) {
        const idx = base + k;
        re[k] = (idx < pcm.length ? pcm[idx] : 0) * win[k];
        im[k] = 0;
      }
      fftInPlace(re, im);
      for (let b = 0; b < nBins; b++) mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      for (let m = 0; m < MEL_BINS; m++) {
        const row = fb[m];
        let s = 0;
        for (let b = 0; b < nBins; b++) s += row[b] * mag[b];
        data[i * MEL_BINS + m] = Math.log1p(100 * s);
      }
    }
    return { data: data, frames: frames, rate: sr / MEL_HOP };
  }

  /** 用 238 维模型给候选打分（返回按概率排序的数组） */

  /* 训练好的选点模型（逻辑回归，22 个权重）。
   * 用 31 个人排 NM/HD 谱面训练，留一法验证：同密度下精确率 48.7%（规则生成器是 35.7%）。
   * 权重由 .verify/tools/train.py 产出，改动特征时两边必须同步。 */
  const MODEL = {
    w: [-0.848597, -0.113622, 0.198645, 0.645167, -0.066534, -0.124255, -0.073294, 0.019568, -0.018239, 0.004994, -0.00631, 0.004829, -0.009846, 0.025229, -0.020189, 0.110473, -0.022996, 0.019755, -0.009354, 0.006147, -0.062701, -0.106791],
    mu: [0.26561, 0.210547, 0.16222, 0.489262, 0.33728, 0.175643, 0.249686, 0.250378, 0.250305, 0.249631, 0.250141, 0.250414, 0.249431, 0.250014, 0.61162, -0.001532, 1.058123, 1.058123, 0.960438, 2.352999, 0.314311],
    sd: [0.221484, 0.172748, 0.184531, 0.499885, 0.472781, 0.380517, 0.432831, 0.433231, 0.433189, 0.4328, 0.433094, 0.433252, 0.432684, 0.433021, 0.338963, 0.220818, 0.404244, 0.404244, 0.105735, 0.733089, 0.464241],
    thresholds: { easy: 0.40, normal: 0.30, hard: 0.22 },
  };

  /**
   * 给每个候选位置打分（模型预测「人会不会在这里放音符」）。
   * 返回按概率排序的候选，调用方取前 N 个即可精确控制密度。
   */
  function modelCandidates(analysis, targetDensity) {
    const beat = analysis.beatMs;
    const offset = analysis.offset;
    const step = beat / 4;
    const bars = analysis.bars || {};
    const groups = bars.groups || [];
    const energy = analysis.energy || [];
    const erate = analysis.frameRate || 172;
    const onsets = analysis.onsets || [];
    if (!onsets.length) return [];

    const slotMap = new Map();
    let modelCands = [];
    for (let i = 0; i < onsets.length; i++) {
      const o = onsets[i];
      const k = Math.round((o.time - offset) / step);
      if (k < 0) continue;
      let e = slotMap.get(k);
      if (!e) { e = { low: 0, mid: 0, high: 0, time: offset + k * step, onsetTime: o.time }; slotMap.set(k, e); }
      else if (o.strength > Math.max(e.low, e.mid, e.high)) e.onsetTime = o.time;
      if (o.strength > e[o.band]) e[o.band] = o.strength;
    }
    const slots = Array.from(slotMap.keys()).sort(function (a, b) { return a - b; });
    if (!slots.length) return [];
    const slotSet = new Set(slots);

    const prevGap = new Map();
    const nextGap = new Map();
    let last = -1;
    for (let i = 0; i < slots.length; i++) { prevGap.set(slots[i], last < 0 ? 8 : slots[i] - last); last = slots[i]; }
    last = -1;
    for (let i = slots.length - 1; i >= 0; i--) { nextGap.set(slots[i], last < 0 ? 8 : last - slots[i]); last = slots[i]; }

    const barSlots = new Map();
    const byBar = new Map();
    for (let i = 0; i < slots.length; i++) {
      const k = slots[i];
      const b = Math.floor(k / 16);
      barSlots.set(b, (barSlots.get(b) || 0) + 1);
      if (!byBar.has(b)) byBar.set(b, []);
      byBar.get(b).push(k);
    }
    const barMax = new Map();
    const barRank = new Map();
    byBar.forEach(function (ks, b) {
      const vals = ks.map(function (k) {
        const e = slotMap.get(k);
        return { k: k, v: Math.max(e.low, e.mid, e.high) };
      }).sort(function (x, y) { return y.v - x.v; });
      barMax.set(b, vals.length ? vals[0].v : 1);
      for (let i = 0; i < vals.length; i++) barRank.set(vals[i].k, i);
    });

    const out = [];
    for (let i = 0; i < slots.length; i++) {
      const k = slots[i];
      const e = slotMap.get(k);
      const low = e.low, mid = e.mid, high = e.high;
      const mx = Math.max(low, mid, high);
      if (mx <= 0) continue;
      const cnt = (low > 0 ? 1 : 0) + (mid > 0 ? 1 : 0) + (high > 0 ? 1 : 0);
      const sub = ((k % 4) + 4) % 4;
      const barBeat = Math.floor(k / 4) % 4;
      const bar = Math.floor(k / 16);
      const t = e.time;
      const ei = Math.max(0, Math.min(energy.length - 1, Math.round(t / 1000 * erate)));
      const e0 = energy.length ? energy[ei] : 0.5;
      const ei2 = Math.max(0, Math.min(energy.length - 1, Math.round((t - beat * 4) / 1000 * erate)));
      const e1 = energy.length ? energy[ei2] : 0.5;
      let dense = 0;
      for (let j = Math.max(0, k - 8); j < k; j++) if (slotSet.has(j)) dense++;

      const f = [
        low, mid, high,
        mx === low ? 1 : 0, mx === mid ? 1 : 0, mx === high ? 1 : 0,
        sub === 0 ? 1 : 0, sub === 1 ? 1 : 0, sub === 2 ? 1 : 0, sub === 3 ? 1 : 0,
        barBeat === 0 ? 1 : 0, barBeat === 1 ? 1 : 0, barBeat === 2 ? 1 : 0, barBeat === 3 ? 1 : 0,
        e0, e0 - e1,
        Math.min(prevGap.get(k), 8), Math.min(nextGap.get(k), 8),
        dense / 8, cnt,
        (bar < groups.length && groups[bar] === bar) ? 0 : 1,
        mx / Math.max(1e-6, barMax.get(bar) || 1),
        (barSlots.get(bar) || 0) / 16,
        (barRank.get(k) || 0) / 16,
        targetDensity,
      ];
      // 只循环模型真正用到的特征数（f 里的后几项是给以后扩展的，权重里没有）
      let z = MODEL.w[0];
      const nf = MODEL.mu.length;
      for (let d = 0; d < nf; d++) z += MODEL.w[d + 1] * ((f[d] - MODEL.mu[d]) / MODEL.sd[d]);
      out.push({ k: k, time: t, onsetTime: e.onsetTime, prob: 1 / (1 + Math.exp(-z)), low: low, mid: mid, high: high });
    }
    out.sort(function (a, b) { return b.prob - a.prob; });
    return out;
  }

  /**
   * 分段选声部。
   *
   * 实测 31 个人排 NM/HD 谱面：音符有 97% 落在真实起音上，
   * 但**只用掉了 15% 的起音**；而且 96% 的 4 小节段落存在明确的主导频段。
   * 也就是说人排谱不是「谁响采谁」，而是每段挑一两个声部来写。
   *
   * 这里给每个段落算出允许的频段集合，后面的收集阶段只采这些频段。
   */
  function pickVoices(onsetList, analysis, offset, beatMs) {
    const secMs = beatMs * 4 * 4;            // 4 小节一段
    const secOf = function (t) {
      return Math.floor((t - offset) / secMs + 1e-6);
    };

    // 每段的频段强度合计
    const secs = new Map();
    for (let i = 0; i < onsetList.length; i++) {
      const o = onsetList[i];
      const s = secOf(o.time);
      if (!secs.has(s)) secs.set(s, { low: 0, mid: 0, high: 0, n: 0 });
      const v = secs.get(s);
      v[o.band] = (v[o.band] || 0) + o.strength;
      v.n++;
    }

    const allow = new Map();
    const groups = analysis.bars && analysis.bars.groups;
    secs.forEach(function (v, s) {
      const arr = [['low', v.low], ['mid', v.mid], ['high', v.high]].sort(function (a, b) { return b[1] - a[1]; });
      const top = arr[0];
      const second = arr[1];
      const list = [top[0]];
      // 第二声部接近的话一起允许（人排谱也常写两层）
      if (top[1] > 0 && second[1] >= top[1] * 0.55) list.push(second[0]);
      // 该段起音太少时放宽，避免整段没音符
      if (v.n < 12) list.push('low', 'mid', 'high');
      // 这一段是重复段的话，直接沿用「首次出现」那一段的选择，
      // 否则同样的音乐在两次出现时会挑不同声部，重复感就没了
      let key = s;
      if (groups) {
        const bar = s * 4;
        const rep = groups[bar];
        if (rep !== undefined && rep >= 0 && rep !== bar) key = Math.floor(rep / 4);
      }
      allow.set(s, { list: list, key: key });
    });

    // 先按 key 归一：同一个 key 的段落合并成一个选择（取第一个出现的那段的列表）
    const byKey = new Map();
    allow.forEach(function (v, s) {
      if (!byKey.has(v.key)) byKey.set(v.key, v.list);
      else v.list = byKey.get(v.key);
    });

    return {
      secOf: secOf,
      allows: function (t) {
        const s = secOf(t);
        const v = allow.get(s);
        return v ? v.list : ['low', 'mid', 'high'];
      },
    };
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

  /**
   * 以 bpmHint 为起点做精细拟合 + 吸附。
   * 用于「本地服务定层级、浏览器定精度」的组合。
   */
  function refineBpm(analysis, bpmHint) {
    const onsets = (analysis && analysis.onsets) || [];
    if (!onsets.length || !(bpmHint > 0)) return null;
    // 本地服务擅长「拍子层级」，精度差；浏览器候选里 88% 含正确值。
    // 所以不重新搜，而是「从候选里挑最接近服务值的那一个」，再做整数吸附。
    const cands = (analysis.tempoCandidates || []).map(function (c) { return c.bpm; });
    let pick = bpmHint;
    if (cands.length) {
      let bestD = Infinity;
      for (let i = 0; i < cands.length; i++) {
        const v = cands[i];
        const d = Math.abs(Math.log(v / bpmHint));
        if (d < bestD) { bestD = d; pick = v; }
      }
      if (bestD > 0.08) pick = bpmHint;   // 候选都不像，就用服务值
    }
    const fit = fitTempoGrid(onsets, pick, 28, 0.02);
    if (!fit || !(fit.q > 0.15)) return null;
    return { bpm: fit.bpm, offsetMs: fit.phaseMs, q: fit.q, snapped: fit.snapped, fromCand: pick };
  }

  return {
    analyze: analyze,
    refineBpm: refineBpm,
    report: report,
    generate: generate,
    toOsu: toOsu,
    sustainMs: sustainMs,
    TEMPLATES: TEMPLATES,
    DIFFICULTIES: DIFFICULTIES,
  };
});
