/*
 * bpm_features.js — 为每个 BPM 候选提取选择特征（离线训练用）
 * node bpm_features.js <项目根>
 */
const fs = require('fs');
const path = require('path');
const auto = require(process.argv[2] + '/www/js/autochart.js');
const WORK = 'D:\\AI4K';
const gt = JSON.parse(fs.readFileSync(path.join(WORK, 'bpm_gt.json'), 'utf8'));
const dir = path.join(WORK, 'pcm44');

/** 对某个 bpm 找最佳相位，返回覆盖率特征 */
function measure(onsets, bpm, tolMs) {
  const beatMs = 60000 / bpm;
  let best = null;
  for (let k = 0; k < 24; k++) {
    const ph = (beatMs * k) / 24;
    let onBeat = 0, nBeat = 0;
    let onHalf = 0, nHalf = 0;
    for (let i = 0; i < onsets.length; i++) {
      const t = onsets[i].time - ph;
      const rel = t / beatMs;
      const frac = rel - Math.floor(rel);
      const dBeat = Math.min(frac, 1 - frac) * beatMs;
      if (dBeat <= tolMs) onBeat++;
      const dHalf = Math.abs(frac - 0.5) * beatMs;
      if (dHalf <= tolMs) onHalf++;
    }
    nBeat = onsets.length;
    const cov = onBeat / nBeat;
    if (!best || cov > best.cov) best = { cov: cov, ph: ph, half: onHalf / nBeat };
  }
  // 用最佳相位再算：拍网格被起音覆盖的比例（按拍数），以及 16 分精度
  const ph = best.ph;
  let beats = 0, beatsHit = 0, gridHit = 0, gridTot = 0;
  const step = beatMs / 4;
  for (let i = 0; i < onsets.length; i++) {
    const rel = (onsets[i].time - ph) / beatMs;
    const idx = Math.round(rel);
    beats = Math.max(beats, idx);
    const d = Math.abs(rel - idx) * beatMs;
    if (d <= 45) beatsHit++;
    gridTot++;
    const g = (onsets[i].time - ph) / step;
    const gd = Math.abs(g - Math.round(g)) * step;
    if (gd <= 20) gridHit++;
  }
  // 分段稳定性：把曲子切成 8 段，每段单独算对齐率，取最小值
  const segN = 8;
  const t0 = onsets.length ? onsets[0].time : 0;
  const t1 = onsets.length ? onsets[onsets.length - 1].time : 1;
  const segHit = new Array(segN).fill(0);
  const segTot = new Array(segN).fill(0);
  for (let i = 0; i < onsets.length; i++) {
    const seg = Math.min(segN - 1, Math.floor((onsets[i].time - t0) / Math.max(1, t1 - t0) * segN));
    segTot[seg]++;
    const g = (onsets[i].time - ph) / step;
    const gd = Math.abs(g - Math.round(g)) * step;
    if (gd <= 25) segHit[seg]++;
  }
  const segRates = [];
  for (let s = 0; s < segN; s++) if (segTot[s] > 5) segRates.push(segHit[s] / segTot[s]);
  segRates.sort((a, b) => a - b);
  const segMin = segRates.length ? segRates[0] : 0;
  const segMed = segRates.length ? segRates[Math.floor(segRates.length / 2)] : 0;

  return {
    segMin: segMin,
    segMed: segMed,
    cov: best.cov,          // 起音落在拍上的比例
    half: best.half,        // 起音落在半拍上的比例
    halfRatio: best.half / Math.max(1e-6, best.cov),
    grid: gridHit / Math.max(1, gridTot),   // 起音落在 16 分网格上的比例
    phase: ph,
  };
}

const rows = [];
for (const pkg of Object.keys(gt)) {
  const info = gt[pkg];
  const mp = path.join(dir, info.audio + '.json');
  if (!fs.existsSync(mp)) continue;
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const raw = fs.readFileSync(path.join(dir, info.audio + '.f32'));
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const an = auto.analyze(pcm, meta.sr, {});
  const want = info.bpm;
  const cands = (an.tempoCandidates || []).map(c => ({ bpm: c.bpm, score: c.score, contrast: c.contrast }));
  if (!cands.length) continue;
  // 去重（同一 bpm 附近只留一个）
  const uniq = [];
  for (const c of cands) {
    if (uniq.some(u => Math.abs(u.bpm - c.bpm) < 1.5)) continue;
    uniq.push(c);
  }
  for (const c of uniq) {
    const m = measure(an.onsets, c.bpm, 45);
    const label = Math.abs(c.bpm - want) / want <= 0.03 ? 1 : 0;
    rows.push({
      song: pkg, bpm: c.bpm, want: want, label: label,
      f: [c.score, c.contrast, m.cov, m.half, m.halfRatio, m.grid,
          Math.log2(c.bpm / 145), Math.log2(c.bpm / 120), 1, m.segMin, m.segMed],
    });
  }
}
fs.writeFileSync(path.join(WORK, 'bpm_rows.json'), JSON.stringify(rows));
console.log('候选行数', rows.length, '| 歌', new Set(rows.map(r => r.song)).size);
const songsWithPos = new Set(rows.filter(r => r.label).map(r => r.song));
console.log('有正例的歌', songsWithPos.size);
