const fs = require('fs'), path = require('path');
global.window = global.window || {};
for (const f of ['seqmodel.js','stage2.js']) eval(fs.readFileSync(process.argv[2] + '/www/js/' + f, 'utf8'));
window.M4K.SEQ.load(); window.M4K.SEQ.loadStage2();
const auto = require(process.argv[2] + '/www/js/autochart.js');
const w = path.join(process.argv[2], '.verify/pcm');
for (const song of ['circles','Avantgarde','endlike']) {
  const mp = path.join(w, song + '.json');
  if (!fs.existsSync(mp)) continue;
  const meta = JSON.parse(fs.readFileSync(mp,'utf8'));
  const raw = fs.readFileSync(path.join(w, song + '.f32'));
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength/4);
  const an = auto.analyze(pcm, meta.sr, {});
  const dur = an.duration/1000;
  for (const d of ['easy','normal','hard']) {
    const c = auto.generate(an, { difficulty: d });
    const tm = new Map();
    for (const n of c.notes) { if(!tm.has(n.time)) tm.set(n.time,[]); tm.get(n.time).push(n); }
    const ts=[...tm.keys()].sort((a,b)=>a-b);
    let same=0,pairs=0;
    for (let i=1;i<ts.length;i++){
      if (ts[i]-ts[i-1] > an.beatMs*0.62) continue;
      const A=tm.get(ts[i-1]), B=tm.get(ts[i]);
      if (A.length!==1||B.length!==1) continue;
      pairs++; if (Math.abs(B[0].col-A[0].col)===0) same++;
    }
    const holds = c.notes.filter(n=>n.isHold);
    const lens = holds.map(n => n.end - n.time);
    const uniqLens = [...new Set(lens.map(x=>Math.round(x/50)*50))].length;
    console.log((song+'/'+d).padEnd(18) + ' BPM ' + an.bpm.toFixed(0).padStart(3) +
      ' | 密度 ' + (c.notes.length/dur).toFixed(2) + '/s' +
      ' | 同列 ' + (pairs? (same/pairs*100).toFixed(1):'0.0') + '%' +
      ' | 长条 ' + holds.length + ' 长度种类 ' + uniqLens);
  }
}