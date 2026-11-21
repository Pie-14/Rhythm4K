const fs = require('fs'), path = require('path');
const auto = require(process.argv[2] + '/www/js/autochart.js');
const WORK = 'D:\\AI4K';
const gt = JSON.parse(fs.readFileSync(path.join(WORK, 'bpm_gt.json'), 'utf8'));
const dir = path.join(WORK, 'pcm44');
let n = 0, exactInt = 0, errs = [], drift = [];
const rows = [];
for (const pkg of Object.keys(gt)) {
  const info = gt[pkg];
  const mp = path.join(dir, info.audio + '.json');
  if (!fs.existsSync(mp)) continue;
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const raw = fs.readFileSync(path.join(dir, info.audio + '.f32'));
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const an = auto.analyze(pcm, meta.sr, {});
  const want = info.bpm, got = an.bpm;
  if (Math.abs(got - want) / want > 0.03) continue;
  n++;
  const rel = Math.abs(got - want) / want;
  errs.push(rel);
  if (Math.abs(got - Math.round(got)) < 0.01) exactInt++;
  // 漂移：末段 20% 的相位残差
  const step = 60000 / got / 4;
  const dur = an.duration;
  let last = 0, cnt = 0;
  for (const o of an.onsets) {
    if (o.time < dur * 0.8) continue;
    const g = (o.time - an.offset) / step;
    const d = Math.abs(g - Math.round(g)) * step;
    if (d <= 60) { last += d; cnt++; }
  }
  drift.push(cnt ? last / cnt : 0);
  rows.push([pkg.slice(0, 26), want, got.toFixed(2), (rel * 100).toFixed(3) + '%']);
}
errs.sort((a, b) => a - b);
drift.sort((a, b) => a - b);
console.log('BPM 判定正确的 ' + n + ' 首里:');
console.log('  吸附到整数     ' + exactInt + '/' + n + ' (' + (exactInt / n * 100).toFixed(0) + '%)');
console.log('  相对误差 中位 ' + (errs[Math.floor(errs.length / 2)] * 100).toFixed(3) + '%   90分位 ' + (errs[Math.floor(errs.length * 0.9)] * 100).toFixed(3) + '%');
console.log('  末段残差 中位 ' + drift[Math.floor(drift.length / 2)].toFixed(1) + 'ms   90分位 ' + drift[Math.floor(drift.length * 0.9)].toFixed(1) + 'ms');
console.log('');
for (const r of rows.slice(0, 10)) console.log('  ' + r[0].padEnd(28) + String(r[1]).padStart(7) + ' → ' + String(r[2]).padStart(7) + '  ' + r[3]);