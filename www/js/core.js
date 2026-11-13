/*
 * core.js — .osu 解析 + 判定引擎（纯逻辑，不碰 DOM / 音频，可在 Node 里测）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.M4K = Object.assign(root.M4K || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 判定窗口（毫秒，绝对偏差）
   * ------------------------------------------------------------------ */
  // 略微放宽：原来 25/45/80/110/150，现在整体 +5~20ms
  const WINDOWS = { perfect: 30, great: 55, good: 95, bad: 130, miss: 170 };
  /** 长条尾巴：松开时距离尾巴超过这个容差就算断 */
  const HOLD_GRACE = 110;

  const JUDGEMENTS = {
    perfect: { key: 'perfect', name: 'PERFECT', value: 300, color: '#8fe3ff' },
    great: { key: 'great', name: 'GREAT', value: 200, color: '#7ef0a8' },
    good: { key: 'good', name: 'GOOD', value: 100, color: '#ffd166' },
    bad: { key: 'bad', name: 'BAD', value: 50, color: '#ff9b52' },
    miss: { key: 'miss', name: 'MISS', value: 0, color: '#ff5f74' },
  };

  function judgeForDelta(absDelta) {
    if (absDelta <= WINDOWS.perfect) return 'perfect';
    if (absDelta <= WINDOWS.great) return 'great';
    if (absDelta <= WINDOWS.good) return 'good';
    if (absDelta <= WINDOWS.bad) return 'bad';
    return 'miss';
  }

  /**
   * 评级门槛（都放宽了一点，配合判定窗口放宽）
   *   SS: 满准确率且 0 miss
   *   S : 93%   A: 85%   B: 75%   C: 65%   D: 以下
   */
  function gradeFor(accuracy, misses) {
    if (accuracy >= 0.999 && misses === 0) return 'SS';
    if (accuracy >= 0.93) return 'S';
    if (accuracy >= 0.85) return 'A';
    if (accuracy >= 0.75) return 'B';
    if (accuracy >= 0.65) return 'C';
    return 'D';
  }

  /* ------------------------------------------------------------------ *
   * .osu 解析
   * ------------------------------------------------------------------ */

  /**
   * @param {string} text .osu 文件全文
   * @returns {{keyCount:number, notes:Array, meta:Object, timing:Array, audioFilename:string}}
   */
  function parseOsu(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('谱面内容为空');

    const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const lines = src.split('\n');

    const meta = { title: '', artist: '', creator: '', version: '', source: '', tags: '' };
    const general = {};
    const difficulty = {};
    const timing = [];
    const notes = [];
    const events = [];
    let section = '';
    let keyCount = 0;

    // 先全局扫一次键数：HitObjects 段可能出现在 [Difficulty] 之前
    const csMatch = /^\s*CircleSize\s*:\s*([0-9]+(?:\.[0-9]+)?)/mi.exec(src);
    if (csMatch) {
      const cs = parseFloat(csMatch[1]);
      if (isFinite(cs) && cs > 0) keyCount = Math.round(cs);
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;

      if (line.charAt(0) === '[' && line.charAt(line.length - 1) === ']') {
        section = line.slice(1, -1).toLowerCase();
        continue;
      }

      if (section === 'hitobjects') {
        const note = parseHitObject(line, keyCount || 4);
        if (note) notes.push(note);
        continue;
      }

      if (section === 'events') {
        const ev = parseEventLine(line);
        if (ev) events.push(ev);
        continue;
      }

      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();

      if (section === 'general') {
        general[key] = value;
      } else if (section === 'metadata') {
        const k = key.toLowerCase();
        if (k === 'title') meta.title = value;
        else if (k === 'titleunicode') meta.titleUnicode = value;
        else if (k === 'artist') meta.artist = value;
        else if (k === 'artistunicode') meta.artistUnicode = value;
        else if (k === 'creator') meta.creator = value;
        else if (k === 'version') meta.version = value;
        else if (k === 'source') meta.source = value;
        else if (k === 'tags') meta.tags = value;
      } else if (section === 'difficulty') {
        const k = key.toLowerCase();
        if (k === 'circlesize') {
          const cs = parseFloat(value);
          if (isFinite(cs) && cs > 0) keyCount = Math.round(cs);
        }
        difficulty[key] = value;
        difficulty[key.toLowerCase()] = value;
      } else if (section === 'timingpoints') {
        const parts = line.split(',');
        if (parts.length >= 2) {
          const time = parseFloat(parts[0]);
          const beatLength = parseFloat(parts[1]);
          if (isFinite(time) && isFinite(beatLength)) {
            timing.push({
              time: time,
              beatLength: beatLength,
              meter: parseInt(parts[2], 10) || 4,
              uninherited: beatLength > 0,
            });
          }
        }
      }
    }

    if (!keyCount) keyCount = 4;
    if (keyCount < 1 || keyCount > 18) throw new Error('无法识别的键数：CircleSize=' + keyCount);
    if (!notes.length) throw new Error('谱面里没有任何音符（是不是没选到 mania 谱面？）');

    // 时间排序后重新编号，列内顺序天然有序
    notes.sort((a, b) => a.time - b.time || a.col - b.col);
    for (let i = 0; i < notes.length; i++) notes[i].id = i;

    const title = meta.titleUnicode || meta.title || '未知曲目';

    // [Events] 里第一条背景图 / 视频
    let background = '';
    let video = '';
    let videoStart = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === 'background' && !background) background = events[i].filename;
      if (events[i].type === 'video' && !video) {
        video = events[i].filename;
        videoStart = events[i].time || 0;
      }
    }

    return {
      keyCount: keyCount,
      notes: notes,
      meta: Object.assign({}, meta, { title: title }),
      difficulty: difficulty,
      timing: timing.sort((a, b) => a.time - b.time),
      audioFilename: general.AudioFilename || general.audiofilename || '',
      background: background,
      video: video,
      videoStart: videoStart,
      events: events,
      mode: parseInt(general.Mode, 10) || 0,
      raw: src,
    };
  }

  /**
   * [Events] 行 → {type, filename, time}
   *   0,0,"bg.jpg",0,0        背景图
   *   1,0,"video.avi"         旧版视频
   *   Video,0,"video.mp4"     新版视频
   *   2,1000,5000             休息段（忽略）
   */
  function parseEventLine(line) {
    const parts = line.split(',');
    const head = (parts[0] || '').trim();
    const m = /"([^"]+)"/.exec(line);
    const filename = m ? m[1] : '';
    const off = parseFloat(parts[1]);
    const time = isFinite(off) ? off : 0;

    if (/^video$/i.test(head)) return { type: 'video', filename: filename, time: time };
    if (head === '1') return { type: 'video', filename: filename, time: time };
    if (head === '0') return { type: 'background', filename: filename, time: time };
    if (head === '2') return { type: 'break', filename: '', time: time };
    return null;
  }

  /** "x,y,time,type,hitSound,endTime:hitSample,..." → note */
  function parseHitObject(line, keyCount) {
    const parts = line.split(',');
    if (parts.length < 4) return null;

    const x = parseFloat(parts[0]);
    const time = parseFloat(parts[2]);
    const type = parseInt(parts[3], 10) || 0;
    if (!isFinite(x) || !isFinite(time)) return null;

    // osu!mania 列映射：x ∈ [0,512] → 列
    let col = Math.floor((x * keyCount) / 512);
    if (!isFinite(col)) col = 0;
    col = Math.max(0, Math.min(keyCount - 1, col));

    let end = null;
    if (type & 128) {
      const seg = (parts[5] || '').split(':')[0];
      const e = parseFloat(seg);
      if (isFinite(e) && e > time) end = e;
    }

    return {
      id: 0,
      col: col,
      time: time,
      end: end,
      isHold: end !== null,
    };
  }

  /* ------------------------------------------------------------------ *
   * 延迟校准
   * ------------------------------------------------------------------ */

  /**
   * 把一串敲击时刻吸附到最近的节拍，取偏差中位数。
   * @param {number[]} taps 敲击时刻（秒，音频时钟）
   * @param {number} t0 第一拍的时刻（秒）
   * @param {number} interval 拍间隔（秒）
   * @returns {{offset:number, count:number, spread:number}}
   *   offset: 平均偏差（毫秒，正=敲晚了）；spread: 10%~90% 分位差，衡量稳定性
   */
  function calibrationOffset(taps, t0, interval) {
    if (!taps || !taps.length || !interval) return { offset: 0, count: 0, spread: 0 };

    const deltas = [];
    for (let i = 0; i < taps.length; i++) {
      const k = Math.round((taps[i] - t0) / interval);
      if (k < 0) continue;
      deltas.push((taps[i] - (t0 + k * interval)) * 1000);
    }
    if (!deltas.length) return { offset: 0, count: 0, spread: 0 };

    deltas.sort(function (a, b) { return a - b; });
    const mid = Math.floor(deltas.length / 2);
    const offset = deltas.length % 2
      ? deltas[mid]
      : (deltas[mid - 1] + deltas[mid]) / 2;
    const p10 = deltas[Math.floor(deltas.length * 0.1)];
    const p90 = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.9))];

    return { offset: offset, count: deltas.length, spread: p90 - p10 };
  }

  /* ------------------------------------------------------------------ *
   * 判定引擎
   * ------------------------------------------------------------------ */
  class Engine {
    /**
     * @param {Object} chart parseOsu() 的结果
     */
    constructor(chart) {
      this.chart = chart;
      this.keyCount = chart.keyCount;

      this.columns = [];
      for (let c = 0; c < this.keyCount; c++) this.columns.push([]);

      this.notes = chart.notes.map(function (n) {
        return {
          id: n.id,
          col: n.col,
          time: n.time,
          end: n.end,
          isHold: n.isHold,
          state: 'pending', // pending | holding | hit | missed | broken
          judgement: null,
          holdStart: null,
        };
      });

      const self = this;
      this.notes.forEach(function (n) {
        self.columns[n.col].push(n);
      });

      this.cursors = new Array(this.keyCount).fill(0);
      this.activeHolds = [];
      this.brokenHolds = []; // 提前松开的长条：变暗显示到尾巴
      this.finished = false;

      this.stats = {
        perfect: 0,
        great: 0,
        good: 0,
        bad: 0,
        miss: 0,
        combo: 0,
        maxCombo: 0,
        score: 0,
        judged: 0,
        total: this.notes.length,
        accuracy: 0,
      };
    }

    /** 该列下一个还没判定的音符（游标会跳过已判定的） */
    nextNote(col) {
      const list = this.columns[col];
      if (!list) return null;
      let i = this.cursors[col];
      while (i < list.length && list[i].state !== 'pending') i++;
      this.cursors[col] = i;
      return i < list.length ? list[i] : null;
    }

    _award(note, key) {
      const j = JUDGEMENTS[key];
      const s = this.stats;

      note.judgement = j;
      s[key] += 1;
      s.judged += 1;

      if (key === 'miss') {
        s.combo = 0;
      } else {
        s.combo += 1;
        if (s.combo > s.maxCombo) s.maxCombo = s.combo;
      }

      // 满分 1,000,000：每个音符等分，按判定值（300 为满）加权
      if (s.total > 0) s.score += (1000000 / s.total) * (j.value / 300);

      const weighted = 300 * s.perfect + 200 * s.great + 100 * s.good + 50 * s.bad;
      s.accuracy = s.judged ? weighted / (300 * s.judged) : 0;

      if (s.judged >= s.total) this.finished = true;
      return j;
    }

    /**
     * 按键按下
     * @returns {null | {type:'hit', note:Object, judgement:Object, delta:number}}
     */
    press(col, time) {
      if (this.finished) return null;
      this.update(time);

      const note = this.nextNote(col);
      if (!note) return null;

      const delta = time - note.time;
      if (delta < -WINDOWS.miss) return null; // 太早，忽略（不惩罚）

      const key = judgeForDelta(Math.abs(delta));
      const judgement = this._award(note, key);

      if (key !== 'miss' && note.isHold) {
        note.state = 'holding';
        note.holdStart = time;
        this.activeHolds.push(note);
      } else {
        note.state = key === 'miss' ? 'missed' : 'hit';
      }

      return { type: 'hit', note: note, judgement: judgement, delta: delta };
    }

    /**
     * 按键松开（只对长条有意义）
     * @returns {null | {type:'holdend'|'holdbreak', note:Object}}
     */
    release(col, time) {
      if (!this.activeHolds.length) return null;

      let result = null;
      for (let i = this.activeHolds.length - 1; i >= 0; i--) {
        const note = this.activeHolds[i];
        if (note.col !== col) continue;

        this.activeHolds.splice(i, 1);

        if (note.end !== null && time < note.end - HOLD_GRACE) {
          note.state = 'broken';
          note.brokenAt = time;
          this.stats.combo = 0;
          this.brokenHolds.push(note);
          result = { type: 'holdbreak', note: note };
        } else {
          note.state = 'hit';
          result = { type: 'holdend', note: note };
        }
      }
      return result;
    }

    /**
     * 推进时间：漏掉的音符判 MISS，按满的长条自动收尾
     * @returns {Array} 事件列表
     */
    update(time) {
      const events = [];

      for (let c = 0; c < this.keyCount; c++) {
        let note = this.nextNote(c);
        while (note && time - note.time > WINDOWS.miss) {
          this._award(note, 'miss');
          note.state = 'missed';
          events.push({ type: 'miss', note: note });
          note = this.nextNote(c);
        }
      }

      // 断掉的长条：尾巴过去之后就不再需要画了
      for (let i = this.brokenHolds.length - 1; i >= 0; i--) {
        if (time > this.brokenHolds[i].end + 150) this.brokenHolds.splice(i, 1);
      }

      for (let i = this.activeHolds.length - 1; i >= 0; i--) {
        const note = this.activeHolds[i];
        if (time >= note.end) {
          this.activeHolds.splice(i, 1);
          note.state = 'hit';
          events.push({ type: 'holdend', note: note });
        }
      }

      return events;
    }

    /** 已判定 / 总数 */
    progress() {
      return this.stats.total ? this.stats.judged / this.stats.total : 0;
    }

    get accuracy() {
      return this.stats.accuracy;
    }

    get grade() {
      return gradeFor(this.stats.accuracy, this.stats.miss);
    }
  }

  return {
    WINDOWS: WINDOWS,
    HOLD_GRACE: HOLD_GRACE,
    JUDGEMENTS: JUDGEMENTS,
    judgeForDelta: judgeForDelta,
    gradeFor: gradeFor,
    parseOsu: parseOsu,
    calibrationOffset: calibrationOffset,
    parseHitObject: parseHitObject,
    Engine: Engine,
  };
});
