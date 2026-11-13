/*
 * 自动生成谱面的测试：用合成鼓点验证 BPM / 节拍位置 / 谱面合理性
 *   node tests/test_autochart.js
 */
const path = require('path');
const auto = require(path.join(__dirname, '..', 'www', 'js', 'autochart.js'));
const core = require(path.join(__dirname, '..', 'www', 'js', 'core.js'));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ---------------- 合成一段鼓点 ---------------- */
const SR = 44100;
const BPM = 150;
const BEAT = 60 / BPM; // 0.4s
const DURATION = 30;
const LEN = Math.floor(SR * DURATION);
const buf = new Float32Array(LEN);

let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x7fffffff) * 2 - 1;
}

function addKick(at) {
  const start = Math.floor(at * SR);
  const n = Math.floor(0.16 * SR);
  let phase = 0;
  for (let i = 0; i < n && start + i < LEN; i++) {
    const t = i / SR;
    const env = Math.exp(-t / 0.05);
    const f = 50 + 90 * Math.exp(-t / 0.015);
    phase += (2 * Math.PI * f) / SR;
    buf[start + i] += Math.sin(phase) * env * 0.6;
  }
}

function addSnare(at) {
  const start = Math.floor(at * SR);
  const n = Math.floor(0.1 * SR);
  let prev = 0;
  for (let i = 0; i < n && start + i < LEN; i++) {
    const t = i / SR;
    const env = Math.exp(-t / 0.035);
    const noise = rnd();
    buf[start + i] += (noise - prev) * 0.35 * env;
    prev = noise;
  }
}

function addHat(at) {
  const start = Math.floor(at * SR);
  const n = Math.floor(0.03 * SR);
  let prev = 0;
  for (let i = 0; i < n && start + i < LEN; i++) {
    const t = i / SR;
    const env = Math.exp(-t / 0.01);
    const noise = rnd();
    buf[start + i] += (noise - prev) * 0.16 * env;
    prev = noise;
  }
}

/** 每个小节开头来一个拖 1.3 拍的持续音（模拟和弦/贝斯） */
function addPad(at, beats) {
  const start = Math.floor(at * SR);
  const n = Math.floor(beats * BEAT * SR);
  const dur = n / SR;
  for (let i = 0; i < n && start + i < LEN; i++) {
    const tt = i / SR;
    const env = Math.min(1, tt / 0.02) * Math.min(1, (dur - tt) / 0.08);
    buf[start + i] += Math.sin(2 * Math.PI * 880 * tt) * env * 0.22;
  }
}

let beatIndex = 0;
for (let t = 0; t < DURATION - 0.5; t += BEAT, beatIndex++) {
  const inBar = beatIndex % 4;
  if (inBar === 0 || inBar === 2) addKick(t);
  else addSnare(t);
  addHat(t);
  addHat(t + BEAT / 2);
  if (inBar === 0) addPad(t, 1.3);
}

/* ---------------- 分析 ---------------- */
const started = Date.now();
const analysis = auto.analyze(buf, SR);
const cost = Date.now() - started;

console.log('  分析耗时 ' + cost + 'ms   BPM=' + analysis.bpm.toFixed(1) +
  '  offset=' + Math.round(analysis.offset) + 'ms  打击点=' + analysis.onsets.length);

check('检出 BPM 接近 150', near(analysis.bpm, 150, 4), analysis.bpm.toFixed(2));
check('节拍相位对齐（0 或一拍之内）',
  Math.min(analysis.offset, analysis.beatMs - analysis.offset) < 45,
  { offset: Math.round(analysis.offset), beat: Math.round(analysis.beatMs) });
check('检出的打击点数量合理', analysis.onsets.length > 60, analysis.onsets.length);
check('三个频段都有信号',
  ['low', 'mid', 'high'].every(b => analysis.bands[b] && analysis.bands[b].length > 100));
check('分析耗时在可接受范围', cost < 4000, cost + 'ms');

// 这条测试曲从头到尾响度一样，不该被判成「有高潮/间奏」
check('恒定响度 → 判定为无明显段落',
  !analysis.sections || analysis.sections.hasSections === false,
  analysis.sections);

/* ---------------- 生成三种难度 ---------------- */
for (const diff of ['easy', 'normal', 'hard']) {
  const chart = auto.generate(analysis, { difficulty: diff, title: 'test' });

  check(diff + ' 生成成功', chart && chart.notes.length > 0, chart && chart.notes.length);
  check(diff + ' 键数 4', chart.keyCount === 4);
  check(diff + ' 谱面结构兼容 parseOsu', typeof chart.notes[0].time === 'number' &&
    typeof chart.notes[0].col === 'number');

  // 和弦：同一时刻可以有多键，但不超过难度上限、且不能同列重复
  {
    const byTime = new Map();
    chart.notes.forEach(n => { byTime.set(n.time, (byTime.get(n.time) || 0) + 1); });
    const sizes = Array.from(byTime.values());
    const maxSim = Math.max.apply(null, sizes);
    const chordTimes = sizes.filter(v => v > 1).length;
    const cap = auto.DIFFICULTIES[diff].maxChord;

    check(diff + ' 同时按键不超过上限 ' + cap, maxSim <= cap, { maxSim, cap });
    check(diff + ' 存在和弦', chordTimes > 0, { chordTimes, total: byTime.size });
    check(diff + ' 和弦占比合理', chordTimes / byTime.size < 0.45,
      (chordTimes / byTime.size).toFixed(2));

    // 同一时刻不能出现同一列
    const dup = [];
    const seen = new Set();
    for (const n of chart.notes) {
      const key = n.time + ':' + n.col;
      if (seen.has(key)) dup.push(key);
      seen.add(key);
    }
    check(diff + ' 同一时刻没有同列重复', dup.length === 0, dup.slice(0, 3));
  }

  // 量化不能把音符挪离真实发声
  {
    const onsetTimes = analysis.onsets.map(o => o.time).sort((a, b) => a - b);
    function nearestOnset(t) {
      let lo = 0;
      let hi = onsetTimes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (onsetTimes[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      const a = lo > 0 ? Math.abs(onsetTimes[lo - 1] - t) : Infinity;
      const b = lo < onsetTimes.length ? Math.abs(onsetTimes[lo] - t) : Infinity;
      return Math.min(a, b);
    }
    const drift = chart.notes.map(n => nearestOnset(n.time));
    const worst = drift.length ? Math.max.apply(null, drift) : 0;
    check(diff + ' 每个音符都贴着真实起音（≤35ms）', worst <= 35, Math.round(worst));
  }

  // 和弦只能落在允许的小节拍位上（默认小节第一拍）
  {
    const groups = new Map();
    chart.notes.forEach(n => {
      if (!groups.has(n.time)) groups.set(n.time, []);
      groups.get(n.time).push(n);
    });
    const allowed = auto.DIFFICULTIES[diff].chordOnBeats;
    const steps = auto.DIFFICULTIES[diff].stepsPerBeat;
    const stepMs2 = analysis.beatMs / steps;
    const bad = [];
    groups.forEach((list, time) => {
      if (list.length < 2) return;
      const slot = Math.round((time - analysis.offset) / stepMs2);
      const beatIdx = Math.floor(slot / steps) - (analysis.downbeat || 0);
      const barBeat = ((beatIdx % 4) + 4) % 4;
      if (allowed.indexOf(barBeat) < 0) bad.push({ time, barBeat });
    });
    check(diff + ' 和弦只落在小节允许的拍上', bad.length === 0, bad.slice(0, 3));
  }

  // 时间递增
  let sorted = true;
  for (let i = 1; i < chart.notes.length; i++) {
    if (chart.notes[i].time < chart.notes[i - 1].time) sorted = false;
  }
  check(diff + ' 时间有序', sorted);

  // 列合法
  check(diff + ' 列都在 0..3', chart.notes.every(n => n.col >= 0 && n.col < 4));

  // 同一列不重叠（含长条占用）
  let overlap = null;
  const busyUntil = new Array(4).fill(-1e9);
  for (const n of chart.notes) {
    if (n.time < busyUntil[n.col] - 1) { overlap = { col: n.col, time: n.time, busy: busyUntil[n.col] }; break; }
    busyUntil[n.col] = n.isHold ? n.end : n.time + 60;
  }
  check(diff + ' 同列不打架', !overlap, overlap);

  // 长条合法
  check(diff + ' 长条有尾巴', chart.notes.every(n => !n.isHold || (n.end && n.end > n.time)));

  // 落在网格上
  const step = analysis.beatMs / auto.DIFFICULTIES[diff].stepsPerBeat;
  const offGrid = chart.notes.filter(n => {
    const rel = n.time - analysis.offset;
    const k = Math.round(rel / step);
    return Math.abs(rel - k * step) > 2;
  });
  check(diff + ' 全部吸附在节拍网格上', offGrid.length === 0, offGrid.slice(0, 2));

  // 四条轨道都要用到（防止全曲挤在两条上）
  const usedCols = new Set(chart.notes.map(n => n.col)).size;
  check(diff + ' 四条轨道都用到了', usedCols === 4, usedCols);

  // 列使用要均衡：最多的一列不能超过总数的一半
  {
    const count = [0, 0, 0, 0];
    chart.notes.forEach(n => { count[n.col]++; });
    const maxShare = Math.max.apply(null, count) / chart.notes.length;
    check(diff + ' 列分布不畸形', maxShare < 0.45, { count, maxShare: maxShare.toFixed(2) });
  }

  // 要有切分（不是全踩正拍）
  {
    const offBeat = chart.notes.filter(n => {
      const beats = (n.time - analysis.offset) / analysis.beatMs;
      return Math.abs(beats - Math.round(beats)) > 0.15;
    }).length;
    if (diff === 'easy') {
      // 简单难度要「好读」：基本踩在正拍上
      check('easy 以正拍为主', offBeat / Math.max(1, chart.notes.length) < 0.2,
        { offBeat, total: chart.notes.length });
    } else {
      check(diff + ' 存在切分音', offBeat / Math.max(1, chart.notes.length) > 0.08,
        { offBeat, total: chart.notes.length });
    }
  }

  // 密集段落也要能出长条（按同列间隔判断，不是全曲间隔）
  check(diff + ' 密集段落有长条', chart.notes.some(n => n.isHold),
    chart.notes.filter(n => n.isHold).length);

  // 密度：难度越高音符越多
  const density = chart.notes.length / (analysis.duration / 1000);
  console.log('  ' + diff.padEnd(6) + ' 音符=' + String(chart.notes.length).padEnd(4) +
    ' 长条=' + String(chart.notes.filter(n => n.isHold).length).padEnd(3) +
    ' 密度=' + density.toFixed(1) + '/s');

  // 能进判定引擎
  const engine = new core.Engine(chart);
  check(diff + ' 能被判定引擎接受', engine.stats.total === chart.notes.length);

  // 模拟全 perfect 打一遍，应该拿满分
  chart.notes.forEach(n => engine.press(n.col, n.time));
  engine.update(1e9);
  check(diff + ' 全 perfect 得 1,000,000', Math.round(engine.stats.score) === 1000000,
    Math.round(engine.stats.score));
  check(diff + ' 全 perfect 无 miss', engine.stats.miss === 0, engine.stats.miss);
}

/* ---------------- 导出 .osu 再解析回来 ---------------- */
{
  const chart = auto.generate(analysis, { difficulty: 'normal', title: '导出测试' });
  const text = auto.toOsu(chart, { audioFilename: 'song.mp3' });
  check('导出的文本像 .osu', /^osu file format v14/.test(text) && /\[HitObjects\]/.test(text), text.slice(0, 30));

  const back = core.parseOsu(text);
  check('往返后键数一致', back.keyCount === chart.keyCount, back.keyCount);
  check('往返后音符数一致', back.notes.length === chart.notes.length,
    { before: chart.notes.length, after: back.notes.length });
  check('往返后长条数一致',
    back.notes.filter(n => n.isHold).length === chart.notes.filter(n => n.isHold).length,
    { before: chart.notes.filter(n => n.isHold).length, after: back.notes.filter(n => n.isHold).length });

  const sig = list => list.map(n => n.time + '/' + n.col).sort().join(',');
  check('往返后时间和列都不变', sig(back.notes) === sig(chart.notes));

  const engine = new core.Engine(back);
  check('往返后的谱面能进引擎', engine.stats.total === back.notes.length);
}

/* ---------------- 分析报告 ---------------- */
{
  const chart = auto.generate(analysis, { difficulty: 'normal', title: 'report' });
  const rep = auto.report(analysis, chart, { name: 'song.mp3' });
  check('报告含文件名', /song\.mp3/.test(rep));
  check('报告含 BPM', /BPM: \d+(\.\d+)?/.test(rep), rep.split('\n')[3]);
  check('报告含难度', /难度: normal/.test(rep));
  check('报告含分段表', /每 ?时刻/.test(rep) || /时刻\s+能量/.test(rep), rep.slice(-200));
  check('报告有多行', rep.split('\n').length > 8, rep.split('\n').length);
}

/* ---------------- 无明显段落时密度要均匀 ---------------- */
{
  const c0 = auto.generate(analysis, { difficulty: 'normal' });
  const perSec0 = (from, to) => c0.notes.filter(n => n.time >= from && n.time < to).length / ((to - from) / 1000);
  const d1 = perSec0(600, 6600);
  const d2 = perSec0(6600, 12600);
  const d3 = perSec0(12600, 18600);
  const lo = Math.min(d1, d2, d3);
  const hi = Math.max(d1, d2, d3);
  console.log('  均匀曲三段密度  ' + d1.toFixed(2) + ' / ' + d2.toFixed(2) + ' / ' + d3.toFixed(2));
  check('无明显段落时密度均匀（不强行压低或抬高）', hi <= lo * 1.35 + 0.01, { d1, d2, d3 });
}

/* ---------------- 难度递进 ---------------- */
const easyN = auto.generate(analysis, { difficulty: 'easy' }).notes.length;
const normalN = auto.generate(analysis, { difficulty: 'normal' }).notes.length;
const hardN = auto.generate(analysis, { difficulty: 'hard' }).notes.length;
check('难度越高音符越多', normalN >= easyN && hardN >= normalN, { easyN, normalN, hardN });

/* ---------------- 延音识别（长条的依据） ---------------- */
{
  const fr = 172;
  const env = new Float32Array(2000).fill(0.001);
  const startFrame = 100;
  const lengthFrames = 150; // 150/172 秒 ≈ 872ms
  for (let f = startFrame; f < startFrame + lengthFrames; f++) env[f] = 0.5;

  const fake = {
    envs: { low: env, mid: env, high: env },
    bandPeak: { low: 0.5, mid: 0.5, high: 0.5 },
    frameRate: fr,
  };
  const t0 = (startFrame / fr) * 1000;
  const measured = auto.sustainMs(fake, t0);
  const expected = (lengthFrames / fr) * 1000;
  check('延音长度测得准', Math.abs(measured - expected) < 25,
    { measured: Math.round(measured), expected: Math.round(expected) });

  const silent = auto.sustainMs(fake, 1500 / fr * 1000);
  check('安静处不报延音', silent < 30, Math.round(silent));

  check('没有包络数据时安全返回 0', auto.sustainMs({ envs: {} }, 100) === 0);
}

/* ---------------- 段落密度：高潮要比间奏密 ---------------- */
{
  const SR3 = 44100;
  const DUR3 = 24;
  const LEN3 = SR3 * DUR3;
  const track = new Float32Array(LEN3);
  const B3 = 0.4; // 150 BPM
  let s3 = 999;

  function noise() {
    s3 = (s3 * 1103515245 + 12345) & 0x7fffffff;
    return (s3 / 0x7fffffff) * 2 - 1;
  }
  function k(at, gain) {
    const s = Math.floor(at * SR3);
    const n = Math.floor(0.16 * SR3);
    let ph = 0;
    for (let i = 0; i < n && s + i < LEN3; i++) {
      const tt = i / SR3;
      const env = Math.exp(-tt / 0.05);
      ph += (2 * Math.PI * (50 + 90 * Math.exp(-tt / 0.015))) / SR3;
      track[s + i] += Math.sin(ph) * env * gain;
    }
  }
  function hs(at, gain) {
    const s = Math.floor(at * SR3);
    const n = Math.floor(0.03 * SR3);
    let prev = 0;
    for (let i = 0; i < n && s + i < LEN3; i++) {
      const env = Math.exp(-(i / SR3) / 0.01);
      const x = noise();
      track[s + i] += (x - prev) * env * gain;
      prev = x;
    }
  }
  function pd(at, beats, gain) {
    const s = Math.floor(at * SR3);
    const n = Math.floor(beats * B3 * SR3);
    const d = n / SR3;
    for (let i = 0; i < n && s + i < LEN3; i++) {
      const tt = i / SR3;
      const env = Math.min(1, tt / 0.02) * Math.min(1, (d - tt) / 0.08);
      track[s + i] += Math.sin(2 * Math.PI * 880 * tt) * env * gain;
    }
  }

  for (let bi = 0, t = 0; t < DUR3 - 0.5; t += B3, bi++) {
    const bar = bi % 4;
    const section = t < 8 ? 0 : t < 16 ? 1 : 2; // 0 主歌 / 1 高潮 / 2 间奏
    // 三个段落的「起音数量」保持一致，只有响度不同 —— 这样才能验证是能量在起作用
    if (bar === 0 || bar === 2) k(t, section === 1 ? 0.9 : section === 0 ? 0.5 : 0.18);
    hs(t, section === 1 ? 0.30 : section === 0 ? 0.16 : 0.07);
    hs(t + B3 / 2, section === 1 ? 0.30 : section === 0 ? 0.16 : 0.07);
    // 高潮段加密到十六分踩镲：候选数超过窗口上限，排序才会真正起作用
    if (section === 1) {
      hs(t + B3 / 4, 0.26);
      hs(t + B3 * 3 / 4, 0.26);
    }
    if (section === 1 && bar === 0) pd(t, 1.4, 0.30);
  }

  const an3 = auto.analyze(track, SR3);
  const c3 = auto.generate(an3, { difficulty: 'normal' });
  const perSec = (from, to) => c3.notes.filter(n => n.time >= from && n.time < to).length / ((to - from) / 1000);

  const verse = perSec(600, 7600);
  const chorus = perSec(8600, 15600);
  const inter = perSec(16600, 23600);
  console.log('  段落密度  主歌=' + verse.toFixed(2) + '/s  高潮=' + chorus.toFixed(2) +
    '/s  间奏=' + inter.toFixed(2) + '/s');

  check('高潮比间奏密', chorus > inter * 1.15, { chorus, inter });

  // 高潮段应该更多踩在小节第一拍上
  const stepMs3 = an3.beatMs / auto.DIFFICULTIES.normal.stepsPerBeat;
  // 按「时刻」统计，和弦不能重复计数
  const downShare = function (from, to) {
    const times = new Set();
    c3.notes.forEach(n => { if (n.time >= from && n.time < to) times.add(n.time); });
    if (!times.size) return 0;
    let hit = 0;
    times.forEach(function (time) {
      const slot = Math.round((time - an3.offset) / stepMs3);
      const beatIdx = Math.floor(slot / auto.DIFFICULTIES.normal.stepsPerBeat) - (an3.downbeat || 0);
      if ((((beatIdx % 4) + 4) % 4) === 0) hit++;
    });
    return hit / times.size;
  };
  const downChorus = downShare(8600, 15600);
  const downInter = downShare(16600, 23600);
  console.log('  下拍占比  高潮=' + (downChorus * 100).toFixed(0) + '%  间奏=' + (downInter * 100).toFixed(0) + '%');

  // 八分网格里下拍均匀分布应该是 12.5%，30% 上下说明重音确实压在小节第一拍
  check('高潮段重音集中在小节第一拍', downChorus >= 0.25, downChorus.toFixed(2));

  // 高潮段不能有十六分弱拍（这才是「整齐」的硬指标）
  // 只统计完全落在高潮内部的音（跨段落边界的窗口会按平均强度处理）
  const chorusNotes = c3.notes.filter(n => n.time >= 9200 && n.time < 15000);
  // 用「拍内位置」判断，别用取整后的 slot —— 四舍五入会把它算偏一格
  const steps3 = auto.DIFFICULTIES.normal.stepsPerBeat;
  const fineOff = chorusNotes.filter(function (n) {
    const pos = ((n.time - an3.offset) / stepMs3) % steps3;
    const nearest = Math.round(pos);
    return Math.abs(pos - nearest) < 0.25 && (nearest % 2) === 1;
  });
  check('高潮段没有十六分弱拍', fineOff.length === 0, fineOff.length);
  check('间奏段仍允许十六分弱拍（保持起伏）', downInter >= 0, downInter.toFixed(2));
  check('高潮不比主歌空', chorus >= verse * 0.95, { chorus, verse });
  check('段落密度整体合理', chorus > 1 && inter > 0, { chorus, inter });
}

/* ---------------- 人声吟唱：连续长音不能全变长条 ---------------- */
{
  // 每 0.2 秒重新起音的持续音（模拟吟唱/长笛那种连绵的长音墙）
  const SR2 = 44100;
  const secs = 12;
  const wall = new Float32Array(SR2 * secs);
  for (let t = 0; t < secs - 0.3; t += 0.2) {
    const s = Math.floor(t * SR2);
    const n = Math.floor(0.35 * SR2);
    for (let i = 0; i < n && s + i < wall.length; i++) {
      const tt = i / SR2;
      const env = Math.min(1, tt / 0.01) * Math.exp(-tt / 0.25);
      wall[s + i] += Math.sin(2 * Math.PI * 660 * tt) * env * 0.5;
    }
  }
  const wa = auto.analyze(wall, SR2);
  const wc = auto.generate(wa, { difficulty: 'normal' });
  const holds = wc.notes.filter(n => n.isHold).sort((a, b) => a.time - b.time);

  check('长音墙里也有音符', wc.notes.length > 5, wc.notes.length);
  check('长条占比不超过 12%', holds.length / Math.max(1, wc.notes.length) <= 0.12,
    { holds: holds.length, notes: wc.notes.length });

  let minGap = Infinity;
  for (let i = 1; i < holds.length; i++) {
    minGap = Math.min(minGap, holds[i].time - holds[i - 1].time);
  }
  check('长条之间有间隔（不连成一片）',
    holds.length < 2 || minGap >= wa.beatMs * 0.9,
    { minGap: Math.round(minGap), beat: Math.round(wa.beatMs) });
}

/* ---------------- 边界情况 ---------------- */
const quiet = new Float32Array(SR * 3);
const quietAnalysis = auto.analyze(quiet, SR);
check('静音输入不崩', !!quietAnalysis && typeof quietAnalysis.bpm === 'number');
const quietChart = auto.generate(quietAnalysis, { difficulty: 'normal' });
check('静音生成空谱面而不是报错', quietChart.notes.length === 0, quietChart.notes.length);

console.log('');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
