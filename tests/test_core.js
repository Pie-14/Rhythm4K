/*
 * 纯逻辑测试：node tests/test_core.js
 */
const path = require('path');
const core = require(path.join(__dirname, '..', 'www', 'js', 'core.js'));
require(path.join(__dirname, '..', 'www', 'js', 'demo.js'));

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const HEAD = [
  'osu file format v14',
  '',
  '[General]',
  'AudioFilename: song.mp3',
  'Mode: 3',
  '',
  '[Metadata]',
  'Title:Test Song',
  'Artist:Nobody',
  'Version:4K Insane',
  'Creator:me',
  '',
  '[Difficulty]',
  'CircleSize:4',
  'OverallDifficulty:8',
  '',
  '[TimingPoints]',
  '0,500,4,2,0,100,1,0',
  '',
  '[HitObjects]',
].join('\r\n');

const CHART_TEXT =
  HEAD +
  '\r\n' +
  [
    '64,192,1000,1,0,0:0:0:0:',
    '192,192,1500,128,0,1800:0:0:0:0:',
    '320,192,2000,1,0,0:0:0:0:',
    '448,192,2500,1,0,0:0:0:0:',
    '512,192,3000,1,0,0:0:0:0:',
  ].join('\r\n');

/* ---------------- 解析 ---------------- */
const chart = core.parseOsu(CHART_TEXT);
eq('keyCount', chart.keyCount, 4);
eq('audioFilename', chart.audioFilename, 'song.mp3');
eq('note count', chart.notes.length, 5);
eq('title', chart.meta.title, 'Test Song');
eq('columns', chart.notes.map(n => n.col), [0, 1, 2, 3, 3]);

const hold = chart.notes[1];
check('hold detected', hold.isHold === true, hold);
eq('hold end', hold.end, 1800);
check('normal note is not hold', chart.notes[0].isHold === false);
eq('note times', chart.notes.map(n => n.time), [1000, 1500, 2000, 2500, 3000]);

/* 键数写在 HitObjects 之后也要认出来 */
const reordered = CHART_TEXT.replace('[Difficulty]\r\nCircleSize:4\r\n', '');
const chart2 = core.parseOsu(reordered + '\r\n\r\n[Difficulty]\r\nCircleSize:4\r\n');
eq('keyCount (difficulty 在末尾)', chart2.keyCount, 4);

/* 7K */
const sevenK = CHART_TEXT.replace('CircleSize:4', 'CircleSize:7').replace(/64,192,1000/, '36,192,1000');
eq('7K keyCount', core.parseOsu(sevenK).keyCount, 7);

/* 空谱面应抛错 */
let threw = false;
try {
  core.parseOsu('osu file format v14\n[HitObjects]\n');
} catch (e) {
  threw = true;
}
check('空谱面抛错', threw);

/* ---------------- [Events]：背景图 / 视频 ---------------- */
const withEvents = CHART_TEXT.replace(
  '[TimingPoints]',
  '[Events]\r\n//Background and Video events\r\n0,0,"bg.jpg",0,0\r\nVideo,0,"vid.mp4"\r\n\r\n[TimingPoints]'
);
const evChart = core.parseOsu(withEvents);
eq('background 解析', evChart.background, 'bg.jpg');
eq('video 解析', evChart.video, 'vid.mp4');
eq('events 条数', evChart.events.length, 2);
eq('没有 Events 时背景为空', chart.background, '');
eq('没有 Events 时视频为空', chart.video, '');

const legacyVideo = core.parseOsu(
  CHART_TEXT.replace('[TimingPoints]', '[Events]\r\n1,0,"old.avi"\r\n\r\n[TimingPoints]')
);
eq('旧式视频行(1,0,...)', legacyVideo.video, 'old.avi');

const noQuotes = core.parseOsu(
  CHART_TEXT.replace('[TimingPoints]', '[Events]\r\n2,1000,5000\r\n\r\n[TimingPoints]')
);
eq('休息段不产生背景', noQuotes.background, '');

/* 视频起始偏移：Video,-45,"xxx.flv" 里的 -45 */
const offChart = core.parseOsu(
  CHART_TEXT.replace('[TimingPoints]', '[Events]\r\n0,0,"BG.jpg",0,0\r\nVideo,-45,"optc.flv"\r\n\r\n[TimingPoints]')
);
eq('视频文件名', offChart.video, 'optc.flv');
eq('视频起始偏移', offChart.videoStart, -45);
eq('背景图文件名', offChart.background, 'BG.jpg');

/* ---------------- 判定窗口 ---------------- */
eq('judge 0', core.judgeForDelta(0), 'perfect');
eq('judge 30', core.judgeForDelta(30), 'perfect');
eq('judge 31', core.judgeForDelta(31), 'great');
eq('judge 55', core.judgeForDelta(55), 'great');
eq('judge 56', core.judgeForDelta(56), 'good');
eq('judge 95', core.judgeForDelta(95), 'good');
eq('judge 96', core.judgeForDelta(96), 'bad');
eq('judge 130', core.judgeForDelta(130), 'bad');
eq('judge 131', core.judgeForDelta(131), 'miss');

/* ---------------- 引擎：基本判定 ---------------- */
function fresh() {
  return new core.Engine(core.parseOsu(CHART_TEXT));
}

let e = fresh();
let r = e.press(0, 1000);
eq('perfect judgement', r.judgement.key, 'perfect');
eq('combo 1', e.stats.combo, 1);
eq('满分 1e6 分摊到 5 个音符', e.stats.score, 200000);
eq('acc 1.0', Math.round(e.stats.accuracy * 1000) / 1000, 1);

e = fresh();
r = e.press(0, 1040);
eq('40ms → great', r.judgement.key, 'great');
e = fresh();
eq('120ms → bad', e.press(0, 1120).judgement.key, 'bad');
e = fresh();
eq('140ms 太晚 → miss', e.press(0, 1140).judgement.key, 'miss');

/* 太早按不吃判定，也不该消耗音符 */
e = fresh();
eq('太早按下返回 null', e.press(0, 700), null);
eq('太早未消耗音符', e.stats.judged, 0);

/* 按错列 */
e = fresh();
eq('空列按下返回 null', e.press(3, 1000), null);

/* ---------------- 漏掉的自动 MISS ---------------- */
e = fresh();
const events = e.update(1000 + core.WINDOWS.miss + 1);
check('超时产生 miss 事件', events.some(ev => ev.type === 'miss' && ev.note.time === 1000), events);
eq('miss 计数', e.stats.miss, 1);
eq('miss 后连击归零', e.stats.combo, 0);

/* ---------------- 长条 ---------------- */
e = fresh();
r = e.press(1, 1500);
eq('长条头 perfect', r.judgement.key, 'perfect');
eq('长条进入 holding', e.notes[1].state, 'holding');
eq('activeHolds 1', e.activeHolds.length, 1);

r = e.release(1, 1600);
eq('提前松手 → holdbreak', r.type, 'holdbreak');
eq('断条状态', e.notes[1].state, 'broken');
eq('断条重置连击', e.stats.combo, 0);

e = fresh();
e.press(1, 1500);
r = e.release(1, 1600);
eq('断掉后进入 brokenHolds', e.brokenHolds.length, 1);
eq('断掉的长条记下断开时刻', e.notes[1].brokenAt, 1600);
e.update(1800 + 300);
eq('尾巴过后从 brokenHolds 移除', e.brokenHolds.length, 0);
eq('断掉的长条仍然是 broken 状态', e.notes[1].state, 'broken');

e = fresh();
e.press(1, 1500);
r = e.release(1, 1700); // 距 1800 只差 100ms，在容差内
eq('贴尾松手 → holdend', r.type, 'holdend');
eq('贴尾状态', e.notes[1].state, 'hit');

e = fresh();
e.press(1, 1500);
const evs2 = e.update(1810); // 一直按着，到尾自动收
check('按满自动收尾', evs2.some(ev => ev.type === 'holdend' && ev.note.time === 1500), evs2);
eq('按满后 activeHolds 空', e.activeHolds.length, 0);

/* ---------------- 结算 ---------------- */
e = fresh();
e.press(0, 1000); // perfect
e.press(1, 1500); // perfect（长条头）
e.update(4000); // 其余全部 miss
eq('全部判定完毕', e.stats.judged, 5);
check('finished', e.finished === true);
eq('判定分布', { p: e.stats.perfect, m: e.stats.miss }, { p: 2, m: 3 });
const expectedAcc = (300 * 2) / (300 * 5);
eq('准确率', Math.round(e.stats.accuracy * 1000) / 1000, Math.round(expectedAcc * 1000) / 1000);
eq('grade D', core.gradeFor(e.stats.accuracy, e.stats.miss), 'D');

eq('全 perfect 为 SS', core.gradeFor(1, 0), 'SS');
eq('有 miss 不能 SS', core.gradeFor(1, 1), 'S');
eq('93% 为 S', core.gradeFor(0.93, 1), 'S');
eq('85% 为 A', core.gradeFor(0.85, 2), 'A');
eq('75% 为 B', core.gradeFor(0.75, 2), 'B');
eq('65% 为 C', core.gradeFor(0.65, 2), 'C');
eq('64% 为 D', core.gradeFor(0.64, 2), 'D');

/* ---------------- 延迟校准 ---------------- */
{
  const t0 = 1.0;
  const iv = 0.5;

  // 正好踩在拍上
  let taps = [];
  for (let i = 0; i < 8; i++) taps.push(t0 + i * iv);
  let r = core.calibrationOffset(taps, t0, iv);
  eq('准点敲击 offset=0', Math.round(r.offset), 0);
  eq('准点敲击 count=8', r.count, 8);
  check('准点敲击 spread 很小', r.spread < 1, r.spread);

  // 统一晚了 30ms
  taps = [];
  for (let i = 0; i < 8; i++) taps.push(t0 + i * iv + 0.03);
  r = core.calibrationOffset(taps, t0, iv);
  eq('晚 30ms 检出 +30', Math.round(r.offset), 30);

  // 统一早了 18ms
  taps = [];
  for (let i = 0; i < 8; i++) taps.push(t0 + i * iv - 0.018);
  r = core.calibrationOffset(taps, t0, iv);
  eq('早 18ms 检出 -18', Math.round(r.offset), -18);

  // 有一个离谱的离群点，中位数要稳
  taps = [];
  for (let i = 0; i < 9; i++) taps.push(t0 + i * iv + 0.02);
  taps.push(t0 + 3 * iv + 0.4);
  r = core.calibrationOffset(taps, t0, iv);
  eq('离群点不影响中位数', Math.round(r.offset), 20);

  // 空输入
  r = core.calibrationOffset([], t0, iv);
  eq('空输入 count=0', r.count, 0);
  eq('空输入 offset=0', r.offset, 0);
}

/* ---------------- 内置示例谱面 ---------------- */
const demo = globalThis.M4K.demo.build();
const demoChart = core.parseOsu(demo.text);
eq('示例谱面 4K', demoChart.keyCount, 4);
check('示例谱面音符 > 60', demoChart.notes.length > 60, demoChart.notes.length);
check('示例谱面含长条', demoChart.notes.some(n => n.isHold));
check('示例谱面所有列合法', demoChart.notes.every(n => n.col >= 0 && n.col < 4));
check('示例音符时间递增', demoChart.notes.every((n, i) => i === 0 || n.time >= demoChart.notes[i - 1].time));
check('示例对象与谱面数量一致', demo.objects.length === demoChart.notes.length, {
  objects: demo.objects.length,
  notes: demoChart.notes.length,
});

/* 演示曲全 perfect 应该 SS */
const de = new core.Engine(demoChart);
demoChart.notes.forEach(n => de.press(n.col, n.time));
de.update(1e9);
eq('演示曲全 perfect 的 miss 数', de.stats.miss, 0);
check('演示曲全 perfect 拿到满分', Math.round(de.stats.score) === 1000000, Math.round(de.stats.score));
eq('演示曲全 perfect 评级', de.grade, 'SS');

console.log('');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
