/*
 * FLV 解复用测试：拿真实谱面里的 optc.flv 跑一遍
 *   node tests/test_flv.js <optc.flv 路径>
 * 没给路径或文件不存在就跳过（这份素材不进仓库）。
 */
const path = require('path');
const fs = require('fs');

require(path.join(__dirname, '..', 'www', 'js', 'flv.js'));
const demuxFlv = globalThis.M4K.demuxFlv;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

const file = process.argv[2] || '';
if (!file || !fs.existsSync(file)) {
  console.log('SKIP  没有提供 .flv 样片，跳过（' + (file || '(未给路径)') + '）');
  process.exit(0);
}

const buf = fs.readFileSync(file);
const info = demuxFlv(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

check('识别出 codecString', info.codecString === 'avc1.640029', info.codecString);
check('拿到 AVC 配置段', info.description && info.description.length >= 4, info.description && info.description.length);
check('配置段首字节是 version=1', info.description[0] === 1, info.description[0]);
check('取到足够多的帧', info.samples.length > 200, info.samples.length);
check('第一帧是关键帧', info.samples[0] && info.samples[0].key === true, info.samples[0] && info.samples[0].key);

let dtsMonotonic = true;
let keyframes = 0;
let ptsInversions = 0;
for (let i = 0; i < info.samples.length; i++) {
  if (i && info.samples[i].dts < info.samples[i - 1].dts) dtsMonotonic = false;
  if (i && info.samples[i].pts < info.samples[i - 1].pts) ptsInversions++;
  if (info.samples[i].key) keyframes++;
}
check('dts 单调递增（解码顺序）', dtsMonotonic);
check('有关键帧可定位', keyframes > 1, keyframes);
console.log('  pts 逆序次数 = ' + ptsInversions + (ptsInversions > 0 ? '（有 B 帧，必须按解码顺序喂）' : '（无 B 帧）'));

check('时长 > 60 秒', info.durationMs > 60000, info.durationMs);
check('每帧都有数据', info.samples.every(s => s.data && s.data.length > 0));

const sizes = info.samples.map(s => s.data.length);
const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
check('平均帧大小合理(<200KB)', avg > 100 && avg < 200000, Math.round(avg));

console.log('  帧数=' + info.samples.length + '  关键帧=' + keyframes +
  '  时长=' + (info.durationMs / 1000).toFixed(1) + 's  平均帧=' + Math.round(avg) + 'B');
console.log('');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
