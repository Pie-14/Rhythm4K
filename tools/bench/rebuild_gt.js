/*
 * rebuild_gt.js — 从 .verify/lib3 里解压好的 .osu 重建 BPM 真值表
 * node rebuild_gt.js <项目根>
 */
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const lib = path.join(root, '.verify', 'lib3');
const pcm4 = path.join(root, '.verify', 'pcm4');

const norm = s => s.replace(/_+/g, '_');

/** 解析 .osu 的 TimingPoints，返回未继承时间点的 BPM 众数 */
function parseBpm(text) {
  const m = text.match(/\[TimingPoints\]([\s\S]*?)(\n\[|$)/);
  if (!m) return null;
  const counts = new Map();
  for (const line of m[1].split(/\r?\n/)) {
    const p = line.trim().split(',');
    if (p.length < 2) continue;
    const bl = Number(p[1]);
    if (!(bl > 0)) continue;
    const uninherited = p.length < 7 || p[6].trim() === '1';
    if (!uninherited) continue;
    const bpm = Math.round((60000 / bl) * 100) / 100;
    if (bpm < 30 || bpm > 400) continue;
    counts.set(bpm, (counts.get(bpm) || 0) + 1);
  }
  if (!counts.size) return null;
  let best = null, bestN = -1;
  for (const [bpm, n] of counts) if (n > bestN) { bestN = n; best = bpm; }
  return best;
}

/** 每个 pkg 目录里的 BPM（取该包所有 4K 谱的众数） */
const pkgBpm = new Map();
for (const dir of fs.readdirSync(lib, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  if (dir.name === 'charts' || dir.name === 'analysis') continue;
  const d = path.join(lib, dir.name);
  let osus = [];
  try { osus = fs.readdirSync(d).filter(f => f.toLowerCase().endsWith('.osu')); } catch (e) { continue; }
  const bpms = [];
  for (const f of osus) {
    try {
      const bpm = parseBpm(fs.readFileSync(path.join(d, f), 'utf8'));
      if (bpm) bpms.push(bpm);
    } catch (e) { /* ignore */ }
  }
  if (!bpms.length) continue;
  const c = new Map();
  for (const b of bpms) c.set(b, (c.get(b) || 0) + 1);
  let best = null, bestN = -1;
  for (const [b, n] of c) if (n > bestN) { bestN = n; best = b; }
  pkgBpm.set(dir.name, best);
}
console.log('有 BPM 真值的包:', pkgBpm.size);

const charts = fs.readdirSync(path.join(lib, 'charts'))
  .map(f => JSON.parse(fs.readFileSync(path.join(lib, 'charts', f), 'utf8')));

const pcmNames = new Set(fs.readdirSync(pcm4).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)));
const pcmByNorm = new Map();
for (const n of pcmNames) pcmByNorm.set(norm(n), n);

const gt = {};
let matched = 0, noAudio = 0, noBpm = 0;
for (const c of charts) {
  // 用 pkg 编号前缀找对应目录
  const pkgId = (c.pkg || '').split(' ')[0];
  let bpm = null;
  if (pkgBpm.has(c.pkg)) bpm = pkgBpm.get(c.pkg);
  if (!bpm) {
    for (const [pkg, b] of pkgBpm) {
      if (pkg === c.pkg || pkg.startsWith(pkgId + '_')) { bpm = b; break; }
    }
  }
  if (!bpm) { noBpm++; continue; }
  const audioName = pcmByNorm.get(norm(c.audio));
  if (!audioName) { noAudio++; continue; }
  gt[audioName] = { bpm: bpm };
  matched++;
}
console.log('匹配到音频的条目:', matched, '| 缺 BPM:', noBpm, '| 缺音频:', noAudio);

const out = path.join(root, '.verify', 'bpm_gt.json');
fs.writeFileSync(out, JSON.stringify(gt, null, 1));
console.log('已写 ' + out);
