const fs = require('fs'), path = require('path');
const auto = require(process.argv[2] + '/www/js/autochart.js');
const WORK = 'D:\\AI4K';
const gt = JSON.parse(fs.readFileSync(path.join(WORK, 'bpm_gt.json'), 'utf8'));
const dir = path.join(WORK, 'pcm44');
let exact = 0, octave = 0, bad = 0, total = 0;
const bads = [];
for (const pkg of Object.keys(gt)) {
  const info = gt[pkg];
  const mp = path.join(dir, info.audio + '.json');
  if (!fs.existsSync(mp)) continue;
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const raw = fs.readFileSync(path.join(dir, info.audio + '.f32'));
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const an = auto.analyze(pcm, meta.sr, {});
  const got = an.bpm, want = info.bpm;
  total++;
  const err = Math.abs(got - want) / want;
  if (err <= 0.03) exact++;
  else if (Math.abs(got - want * 2) / (want * 2) <= 0.03 || Math.abs(got - want / 2) / (want / 2) <= 0.03) octave++;
  else { bad++; if (bads.length < 12) bads.push([pkg.slice(0, 34), want, got]); }
}
console.log('样本 ' + total);
console.log('  准确(±3%)   ' + exact + '  (' + (exact / total * 100).toFixed(0) + '%)');
console.log('  倍速错误    ' + octave + '  (' + (octave / total * 100).toFixed(0) + '%)');
console.log('  完全错      ' + bad + '  (' + (bad / total * 100).toFixed(0) + '%)');
console.log('');
console.log('错误样例（真值 vs 检测）:');
for (const b of bads) console.log('  ' + b[0].padEnd(36) + String(b[1]).padStart(7) + ' → ' + String(b[2]).padStart(7));