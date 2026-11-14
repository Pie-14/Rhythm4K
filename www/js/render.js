/*
 * render.js — osu!lazer (Argon) 风格绘制
 *
 * 版式：
 *   背景   : .osz 里的背景图/视频，按 osu 的做法压暗
 *   轨道   : 每列一个色相（黄→橙→品红→紫），竖向渐变半透明叠在背景上
 *   音符   : 圆角彩色块 + 白色底条 + 向下箭头
 *   判定线 : 每列一条白色受体条
 *   按键区 : 底部彩色圆角块 + 三个圆点，按下时变亮
 *   左上   : 分数 + 连击面板
 *   右上   : 准确率
 *   底部   : 进度条 + 两侧时间
 *   中央   : 判定文字（字距拉开）
 */
(function (root) {
  'use strict';
  const M4K = (root.M4K = root.M4K || {});

  const W = 1920;
  const H = 1080;

  const JUDGE_Y = 900;
  const KEY_BAR_H = 96;
  const STAGE_BOTTOM = JUDGE_Y + KEY_BAR_H; // 996
  const NOTE_H = 48; // 仅作 4K 的参考值；实际尺寸在 layout() 里按轨道宽度算

  const MONO = 'Consolas, "Cascadia Mono", "Courier New", monospace';
  const UI = '"Segoe UI", "Microsoft YaHei", sans-serif';

  // 每列的色相（对应 lazer Argon 皮肤那种 黄→橙→品红→紫 的扫色）
  const HUES = {
    4: [46, 24, 344, 288],
    5: [52, 34, 8, 336, 300],
    6: [52, 34, 12, 344, 320, 292],
    7: [54, 38, 18, 352, 326, 300, 280],
  };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.keyCount = 4;
      this.orientation = 'landscape'; // landscape 1920×1080 / portrait 1080×1920
      this.W = W;
      this.H = H;
      this.songTime = 0;
      this.pxPerMs = 1.3;
      this.judgeFx = null;
      this.comboPunch = 0;
      this.hits = [];
      this.scale = 1;
      this.ox = 0;
      this.oy = 0;
      this.layout();
      this.resize();
    }

    /* ---------------- 布局 ---------------- */
    layout() {
      const k = this.keyCount;
      const portrait = this.orientation === 'portrait';

      // 竖屏（手机）：轨道宽一些好点，判定线上移到 78% 处，
      // 下面这段就是大拇指区域
      this.laneW = portrait ? 180 : (k <= 4 ? 100 : k <= 7 ? 84 : 70);
      this.gap = portrait ? 6 : 4;
      this.fieldW = k * this.laneW + (k - 1) * this.gap;
      this.fieldX = Math.round((this.W - this.fieldW) / 2);
      this.judgeY = portrait ? Math.round(this.H * 0.78) : JUDGE_Y;
      this.stageBottom = this.H; // 轨道一直延伸到底部
      this.keyBarTop = this.judgeY;
      this.padMaxH = portrait ? 300 : 0; // 竖屏按钮限高，贴底
      // 音符尺寸跟着轨道宽度算：更高、更窄（原来 30 高 / 全宽太扁太宽）
      this.noteH = Math.round(this.laneW * 0.36);
      this.noteInset = 3; // 音符几乎和轨道同宽
      this.hues = this._hues();

      const ctx = this.ctx;
      this.bgGrad = ctx.createLinearGradient(0, 0, 0, this.H);
      this.bgGrad.addColorStop(0, '#0c1424');
      this.bgGrad.addColorStop(0.55, '#121c31');
      this.bgGrad.addColorStop(1, '#1a2743');

      this.topFade = ctx.createLinearGradient(0, 0, 0, 220);
      this.topFade.addColorStop(0, 'rgba(4,6,10,0.8)');
      this.topFade.addColorStop(1, 'rgba(4,6,10,0)');

      // 默认背景的两团光：左上冷蓝 + 右下偏紫，给纯色背景一点纵深
      this.glowA = ctx.createRadialGradient(
        this.W * 0.16, this.H * 0.10, 0,
        this.W * 0.16, this.H * 0.10, Math.max(this.W, this.H) * 0.46);
      this.glowA.addColorStop(0, 'rgba(60,170,255,0.40)');
      this.glowA.addColorStop(0.55, 'rgba(78,140,255,0.11)');
      this.glowA.addColorStop(1, 'rgba(78,140,255,0)');

      this.glowB = ctx.createRadialGradient(
        this.W * 0.88, this.H * 0.86, 0,
        this.W * 0.88, this.H * 0.86, Math.max(this.W, this.H) * 0.44);
      this.glowB.addColorStop(0, 'rgba(160,90,255,0.34)');
      this.glowB.addColorStop(0.6, 'rgba(150,96,255,0.09)');
      this.glowB.addColorStop(1, 'rgba(150,96,255,0)');

      // 第三团暖色，和蓝紫拉开色相，背景才不会一片冷
      this.glowC = ctx.createRadialGradient(
        this.W * 0.52, this.H * 0.72, 0,
        this.W * 0.52, this.H * 0.72, Math.max(this.W, this.H) * 0.40);
      this.glowC.addColorStop(0, 'rgba(255,120,90,0.30)');
      this.glowC.addColorStop(0.6, 'rgba(255,120,90,0.09)');
      this.glowC.addColorStop(1, 'rgba(255,120,90,0)');

      // 缓慢上下浮动的一条光带，让背景「动」起来
      this.bandGrad = ctx.createLinearGradient(0, 0, 0, this.H * 0.55);
      this.bandGrad.addColorStop(0, 'rgba(90,150,255,0)');
      this.bandGrad.addColorStop(0.5, 'rgba(90,150,255,0.075)');
      this.bandGrad.addColorStop(1, 'rgba(90,150,255,0)');

      // 判定线下方的一抹底色，让按键区有「落地」的感觉
      this.floorGlow = ctx.createLinearGradient(0, this.judgeY - this.noteH * 2, 0, this.H);
      this.floorGlow.addColorStop(0, 'rgba(70,110,190,0)');
      this.floorGlow.addColorStop(1, 'rgba(70,110,190,0.10)');

      this.vignette = ctx.createRadialGradient(this.W / 2, this.H * 0.5, this.H * 0.3, this.W / 2, this.H * 0.5, this.H * 0.98);
      this.vignette.addColorStop(0, 'rgba(0,0,0,0)');
      this.vignette.addColorStop(1, 'rgba(0,0,0,0.5)');

      // 每列的竖向渐变（上淡下浓，像 lazer 那样越靠按键区越明显）
      this.laneGrads = [];
      for (let i = 0; i < k; i++) {
        const g = ctx.createLinearGradient(0, 0, 0, this.stageBottom);
        g.addColorStop(0, 'hsla(' + this.hues[i] + ', 72%, 48%, 0.22)');
        g.addColorStop(0.65, 'hsla(' + this.hues[i] + ', 72%, 48%, 0.34)');
        g.addColorStop(1, 'hsla(' + this.hues[i] + ', 76%, 50%, 0.50)');
        this.laneGrads.push(g);
      }
    }

    /** 切换横竖屏：重算布局并重新适配画布 */
    setOrientation(mode) {
      const next = mode === 'portrait' ? 'portrait' : 'landscape';
      if (this.orientation === next) return;
      this.orientation = next;
      if (next === 'portrait') {
        this.W = 1080;
        this.H = 1920;
      } else {
        this.W = W;
        this.H = H;
      }
      this.layout();
      this.resize();
    }

    /** 指针坐标（clientX/clientY）→ 逻辑坐标 */
    logicalPoint(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return { x: -1, y: -1 };
      const bx = (clientX - rect.left) * (this.canvas.width / rect.width);
      const by = (clientY - rect.top) * (this.canvas.height / rect.height);
      return { x: (bx - this.ox) / this.scale, y: (by - this.oy) / this.scale };
    }

    /** 逻辑坐标落在哪条轨道；整条竖条都算（不限底部按键区） */
    laneAt(x, y) {
      if (x < this.fieldX || x >= this.fieldX + this.fieldW) return -1;
      if (y < 0 || y > this.stageBottom) return -1;
      const i = Math.floor((x - this.fieldX) / (this.laneW + this.gap));
      if (i < 0 || i >= this.keyCount) return -1;
      return i;
    }

    _hues() {
      const k = this.keyCount;
      if (HUES[k]) return HUES[k].slice();
      const out = [];
      for (let i = 0; i < k; i++) out.push(Math.round(46 - (i * 250) / Math.max(1, k - 1)));
      return out;
    }

    setChart(chart) {
      this.keyCount = chart && chart.keyCount ? chart.keyCount : 4;
      this.layout();
    }

    resize() {
      const dpr = Math.min(root.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      this.scale = Math.min(w / this.W, h / this.H);
      this.ox = Math.round((w - this.W * this.scale) / 2);
      this.oy = Math.round((h - this.H * this.scale) / 2);
    }

    /* ---------------- 状态 ---------------- */
    reset() {
      this.judgeFx = null;
      this.comboPunch = 0;
      this.hits = [];
    }

    flash(judgement) {
      if (!judgement) return;
      this.judgeFx = { j: judgement, t0: performance.now() };
      if (judgement.key !== 'miss') this.comboPunch = 1;
    }

    addHit(delta, judgement) {
      this.hits.push({ delta: delta, color: judgement ? judgement.color : '#ffffff' });
      if (this.hits.length > 48) this.hits.shift();
    }

    /* ---------------- 主绘制 ---------------- */
    draw(state) {
      // 背景动画用的时间（暂停时也继续走，画面不至于完全静止）
      const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (this._lastNow) this.bgT = (this.bgT || 0) + Math.min(0.1, (nowMs - this._lastNow) / 1000);
      else this.bgT = 0;
      this._lastNow = nowMs;
      const ctx = this.ctx;
      const now = performance.now();
      this.songTime = state.songTime || 0;
      this.pxPerMs = (this.judgeY + 70) / Math.max(120, state.scrollMs || 700);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#04060a';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);

      this._drawBackground(ctx, state);
      this._drawLanes(ctx, state.keysDown || []);
      this._drawKeyPads(ctx, state.keysDown || []);
      this._drawReceptors(ctx, state.keysDown || []);

      const engine = state.engine;
      if (engine) this._drawNotes(ctx, engine);
      if (engine) this._drawHud(ctx, engine, state, now);
      this._drawHitError(ctx);
    }

    /* ---------------- 背景 ---------------- */

    /** 没有背景图时的默认底：渐变 + 两团缓慢漂移的光 + 浮动光带 + 横向网格 */
    _drawDefaultBg(ctx) {
      const t = this.bgT || 0;
      const W = this.W;
      const H = this.H;

      ctx.fillStyle = this.bgGrad;
      ctx.fillRect(0, 0, W, H);

      // 三团光沿李萨如轨迹漂移，速度大约 4~6 秒一个来回
      const ax = Math.sin(t * 1.15) * W * 0.13;
      const ay = Math.cos(t * 0.90) * H * 0.11;
      const bx = Math.cos(t * 0.72) * W * 0.15;
      const by = Math.sin(t * 1.00) * H * 0.12;
      const cx = Math.sin(t * 0.85 + 1.7) * W * 0.14;
      const cy = Math.cos(t * 0.68 + 0.6) * H * 0.13;

      ctx.save();
      ctx.translate(ax, ay);
      ctx.fillStyle = this.glowA;
      ctx.fillRect(-W * 0.35, -H * 0.35, W * 1.7, H * 1.7);
      ctx.restore();

      ctx.save();
      ctx.translate(bx, by);
      ctx.fillStyle = this.glowB;
      ctx.fillRect(-W * 0.35, -H * 0.35, W * 1.7, H * 1.7);
      ctx.restore();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = this.glowC;
      ctx.fillRect(-W * 0.35, -H * 0.35, W * 1.7, H * 1.7);
      ctx.restore();

      // 上下浮动的光带
      const bandY = (Math.sin(t * 1.05) * 0.5 + 0.5) * H * 0.9;
      ctx.save();
      ctx.translate(0, bandY - H * 0.14);
      ctx.fillStyle = this.bandGrad;
      ctx.fillRect(0, 0, W, H * 0.55);
      ctx.restore();

      ctx.fillStyle = this.floorGlow;
      ctx.fillRect(0, this.judgeY - this.noteH * 2, W, H - this.judgeY + this.noteH * 2);

      // 横向网格：越靠下越明显，像远处的踏板
      const step = Math.round(this.H / 14);
      ctx.lineWidth = 1;
      for (let y = step; y < this.H; y += step) {
        const p = y / this.H;
        ctx.strokeStyle = 'rgba(150,196,255,' + (0.022 + p * 0.045).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(this.W, y);
        ctx.stroke();
      }
    }

    _drawBackground(ctx, state) {
      const media = state.media;
      let drew = false;
      if (media) {
        const iw = media.videoWidth || media.naturalWidth || media.width || 0;
        const ih = media.videoHeight || media.naturalHeight || media.height || 0;
        if (iw > 0 && ih > 0) {
          const scale = Math.max(this.W / iw, this.H / ih);
          const dw = iw * scale;
          const dh = ih * scale;
          try {
            ctx.drawImage(media, (this.W - dw) / 2, (this.H - dh) / 2, dw, dh);
            drew = true;
          } catch (e) {
            drew = false;
          }
        }
      }

      if (drew) {
        const dim = state.bgDim === undefined ? 0.55 : state.bgDim;
        ctx.fillStyle = 'rgba(0,0,0,' + dim + ')';
        ctx.fillRect(0, 0, this.W, this.H);
        ctx.fillStyle = this.vignette;
        ctx.fillRect(0, 0, this.W, this.H);
      } else {
        // 没有背景图：用程序画的渐变底，比纯黑有层次
        this._drawDefaultBg(ctx);
      }

      ctx.fillStyle = this.topFade;
      ctx.fillRect(0, 0, this.W, 220);
    }

    /* ---------------- 轨道 ---------------- */
    xOf(col) {
      return this.fieldX + col * (this.laneW + this.gap);
    }

    yFor(time) {
      return this.judgeY - (time - this.songTime) * this.pxPerMs;
    }

    hueOf(col) {
      return this.hues[col % this.hues.length];
    }

    noteFill(col) {
      return 'hsl(' + this.hueOf(col) + ', 76%, 54%)';
    }

    _drawLanes(ctx, keys) {
      for (let i = 0; i < this.keyCount; i++) {
        const x = this.xOf(i);
        ctx.fillStyle = this.laneGrads[i];
        ctx.fillRect(x, 0, this.laneW, this.stageBottom);

        if (keys[i]) {
          ctx.fillStyle = 'hsla(' + this.hueOf(i) + ', 80%, 58%, 0.09)';
          ctx.fillRect(x, 0, this.laneW, this.stageBottom);
        }
      }

      // 列与列之间的细缝（露出背景）
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      for (let i = 1; i < this.keyCount; i++) {
        ctx.fillRect(this.xOf(i) - this.gap, 0, this.gap, this.stageBottom);
      }
    }

    _drawReceptors(ctx, keys) {
      // 判定区做成和音符一模一样的圆角块：音符覆盖上去的那一刻就是最佳打击点
      const inset = this.noteInset;
      const nw = this.laneW - inset * 2;
      const nh = this.noteH;
      const top = this.judgeY - nh / 2;

      for (let i = 0; i < this.keyCount; i++) {
        const x = this.xOf(i) + inset;
        const hue = this.hueOf(i);
        const pressed = !!keys[i];

        ctx.fillStyle = pressed
          ? 'hsla(' + hue + ', 82%, 58%, 0.42)'
          : 'hsla(' + hue + ', 70%, 48%, 0.16)';
        roundRect(ctx, x, top, nw, nh, 10);
        ctx.fill();

        ctx.strokeStyle = pressed
          ? 'rgba(255,255,255,0.95)'
          : 'hsla(' + hue + ', 85%, 72%, 0.8)';
        ctx.lineWidth = pressed ? 3 : 2;
        roundRect(ctx, x, top, nw, nh, 10);
        ctx.stroke();

        // 中心一条细横线，帮助对齐
        ctx.fillStyle = pressed ? 'rgba(255,255,255,0.9)' : 'hsla(' + hue + ', 85%, 78%, 0.55)';
        ctx.fillRect(x + 8, this.judgeY - 1, nw - 16, 2);
      }
    }

    _drawKeyPads(ctx, keys) {
      const inset = Math.round(this.laneW * 0.1);
      const padBottom = this.H - 74; // 底下留给进度条
      let padH = padBottom - (this.judgeY + this.noteH / 2 + 16);
      if (this.padMaxH) padH = Math.min(padH, this.padMaxH);
      const padTop = padBottom - padH; // 贴底对齐

      for (let i = 0; i < this.keyCount; i++) {
        const x = this.xOf(i) + inset;
        const w = this.laneW - inset * 2;
        const hue = this.hueOf(i);
        const pressed = !!keys[i];

        ctx.fillStyle = pressed
          ? 'hsla(' + hue + ', 78%, 58%, 0.42)'
          : 'hsla(' + hue + ', 60%, 38%, 0.24)';
        roundRect(ctx, x, padTop, w, padH, 10);
        ctx.fill();

        ctx.strokeStyle = 'hsla(' + hue + ', 80%, 68%, ' + (pressed ? 0.85 : 0.28) + ')';
        ctx.lineWidth = 1.5;
        roundRect(ctx, x, padTop, w, padH, 10);
        ctx.stroke();

        // 三个小圆点
        const cy = padTop + padH - 26;
        const spread = Math.min(16, w * 0.18);
        for (let d = -1; d <= 1; d++) {
          ctx.beginPath();
          ctx.arc(x + w / 2 + d * spread, cy, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = 'hsla(' + hue + ', 82%, 74%, ' + (pressed ? 0.95 : 0.5) + ')';
          ctx.fill();
        }
      }
    }

    /* ---------------- 音符 ---------------- */
    _drawNotes(ctx, engine) {
      const notes = engine.notes;
      if (!notes.length) return;

      const lo = this.songTime - 400;
      const hi = this.songTime + (this.judgeY + 90) / this.pxPerMs;
      const start = lowerBound(notes, lo);

      const drawn = new Set();
      for (let i = start; i < notes.length; i++) {
        const n = notes[i];
        if (n.time > hi) break;
        if (n.state !== 'pending' && n.state !== 'holding') continue;
        this._drawNote(ctx, n);
        drawn.add(n.id);
      }

      // 正在按住的长条：头部时间可能早就掉出上面的窗口了。
      // 按 id 去重，保证「主循环没画到的一定补上」，不会漏也不会重影。
      const holds = engine.activeHolds;
      for (let i = 0; i < holds.length; i++) {
        if (!drawn.has(holds[i].id)) {
          this._drawNote(ctx, holds[i]);
          drawn.add(holds[i].id);
        }
      }

      // 提前松开的：剩下那截变暗，但仍然画到尾巴
      const broken = engine.brokenHolds || [];
      for (let i = 0; i < broken.length; i++) {
        if (!drawn.has(broken[i].id)) {
          this._drawNote(ctx, broken[i]);
          drawn.add(broken[i].id);
        }
      }
    }

    _drawNote(ctx, n) {
      const x = this.xOf(n.col);
      const hue = this.hueOf(n.col);
      const holding = n.state === 'holding';
      const broken = n.state === 'broken';
      const headY = (holding || broken) ? this.judgeY : this.yFor(n.time);
      const nx = x + this.noteInset;
      const nw = this.laneW - this.noteInset * 2;
      const nh = this.noteH;

      // 长条身体
      if (n.isHold) {
        const tailY = this.yFor(n.end);
        const top = Math.min(tailY, headY);
        const bottom = Math.max(tailY, headY);
        if (bottom > -80 && top < this.H + 80 && bottom - top > 1) {
          const bodyAlpha = broken ? 0.30 : (holding ? 0.55 : 0.68);
          ctx.fillStyle = 'hsla(' + hue + ', 74%, 54%, ' + bodyAlpha + ')';
          roundRect(ctx, nx, top, nw, bottom - top, 7);
          ctx.fill();
          // 亮描边：和背景区分开，光靠填充透明度会糊成一片
          ctx.strokeStyle = 'hsla(' + hue + ', 90%, 78%, ' + (broken ? 0.5 : 0.62) + ')';
          ctx.lineWidth = 1.5;
          roundRect(ctx, nx, top, nw, bottom - top, 7);
          ctx.stroke();
          ctx.fillStyle = 'hsla(' + hue + ', 82%, 70%, ' + (broken ? 0.55 : 0.78) + ')';
          ctx.fillRect(nx + nw / 2 - 1, top, 2, bottom - top);
          // 尾端
          ctx.fillStyle = broken ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.9)';
          roundRect(ctx, nx + 6, tailY - 4, nw - 12, 5, 2.5);
          ctx.fill();
        }
      }

      // 断掉的：头已经不在了，只画剩下那截身体
      if (broken) return;

      // 头部
      if (headY < -nh || headY > this.H + nh) return;
      const top = headY - nh / 2;

      ctx.fillStyle = this.noteFill(n.col);
      roundRect(ctx, nx, top, nw, nh, 10);
      ctx.fill();

      // 白色底条
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      roundRect(ctx, nx + 8, top + nh - 12, nw - 16, 6, 3);
      ctx.fill();

      // 向下箭头
      chevron(ctx, nx + nw / 2, top + nh * 0.40, Math.max(8, Math.round(nw * 0.12)),
        'rgba(255,255,255,0.95)', 3.5);
    }

    /* ---------------- HUD ---------------- */
    _drawHud(ctx, engine, state, now) {
      const s = engine.stats;

      // 左上：只留分数，不要面板边框，也不标满分
      text(ctx, formatScorePadded(s.score), 48, 82, '700 46px ' + MONO, '#ffffff', 'left');

      // 右上：准确率
      text(ctx, '准确率', this.W - 44, 56, '500 15px ' + UI, 'rgba(255,255,255,0.55)', 'right');
      text(ctx, (s.accuracy * 100).toFixed(2) + '%', this.W - 44, 96, '700 36px ' + MONO, '#ffffff', 'right');

      if (this.comboPunch > 0.01) this.comboPunch *= 0.85;
      else this.comboPunch = 0;

      // 连击放左下角，避免挡住中间的下落音符
      if (s.combo >= 2) {
        const portrait = this.orientation === 'portrait';
        const punch = this.comboPunch > 0 ? 1 + this.comboPunch * 0.06 : 1;
        const size = Math.round((portrait ? 44 : 64) * punch);
        const cx0 = portrait ? 40 : 48;
        const cy0 = portrait ? this.judgeY - 120 : 930;
        ctx.save();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '800 ' + size + 'px ' + MONO;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillText(String(s.combo), cx0 + 3, cy0 + 3);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillText(String(s.combo), cx0, cy0);
        ctx.font = '700 14px ' + UI;
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText('COMBO', cx0, cy0 + 24);
        ctx.restore();
      }
      const cx = this.fieldX + this.fieldW / 2;

      // 中央：判定文字
      if (this.judgeFx) {
        const age = now - this.judgeFx.t0;
        if (age > 520) {
          this.judgeFx = null;
        } else {
          const alpha = 1 - age / 520;
          ctx.save();
          ctx.globalAlpha = Math.max(0, alpha);
          if ('letterSpacing' in ctx) ctx.letterSpacing = '10px';
          text(ctx, this.judgeFx.j.name, cx, 700 - age * 0.018, '800 40px ' + UI, this.judgeFx.j.color, 'center');
          if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
          ctx.restore();
        }
      }

      // 底部：进度条 + 时间
      const duration = state.duration || 0;
      const barX = 40;
      const barW = this.W - 80;
      const barY = this.orientation === 'portrait' ? this.H - 20 : 1036;
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      roundRect(ctx, barX, barY, barW, 6, 3);
      ctx.fill();
      const p = Math.max(0, Math.min(1, engine.progress()));
      if (p > 0) {
        ctx.fillStyle = 'rgba(120,215,255,0.95)';
        roundRect(ctx, barX, barY, Math.max(6, barW * p), 6, 3);
        ctx.fill();
      }

      text(ctx, formatTime(Math.max(0, this.songTime)), barX, barY - 12, '600 15px ' + MONO,
        'rgba(255,255,255,0.75)', 'left');
      if (duration > 0) {
        text(ctx, formatTime(duration), barX + barW, barY - 12, '600 15px ' + MONO,
          'rgba(255,255,255,0.55)', 'right');
      }
    }

    // hit error 条：竖在屏幕右侧，上 = 早，下 = 晚，中间那格是 0
    _drawHitError(ctx) {
      if (!this.hits.length) return;
      const x = this.W - 72;
      const top = 320;
      const bot = 780;
      const mid = (top + bot) / 2;

      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x - 1, top, 2, bot - top);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(x - 7, mid - 1, 14, 2);

      for (let i = 0; i < this.hits.length; i++) {
        const h = this.hits[i];
        const t = Math.max(-1, Math.min(1, h.delta / 150));
        const y = mid + t * ((bot - top) / 2);
        ctx.fillStyle = h.color;
        ctx.globalAlpha = 0.35 + (i / this.hits.length) * 0.6;
        ctx.fillRect(x - 5, y - 1.5, 10, 3);
      }
      ctx.globalAlpha = 1;
    }
  }

  /* ---------------- 工具 ---------------- */

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /** 向下箭头（lazer 音符中间那个 V） */
  function chevron(ctx, cx, cy, size, color, width) {
    ctx.beginPath();
    ctx.moveTo(cx - size, cy - size * 0.45);
    ctx.lineTo(cx, cy + size * 0.45);
    ctx.lineTo(cx + size, cy - size * 0.45);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function text(ctx, str, x, y, font, color, align) {
    ctx.font = font;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillText(str, x + 2, y + 2);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function lowerBound(notes, time) {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  /** 7 位补零，不加大写逗号：80779 → 0080779 */
  function formatScorePadded(n) {
    return String(Math.max(0, Math.round(n))).padStart(7, '0');
  }

  function formatScore(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatTime(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  M4K.Renderer = Renderer;
  M4K.LAYOUT = { W: W, H: H, JUDGE_Y: JUDGE_Y, STAGE_BOTTOM: STAGE_BOTTOM, NOTE_H: NOTE_H };
  M4K.formatScore = formatScore;
  M4K.formatScorePadded = formatScorePadded;
})(typeof globalThis !== 'undefined' ? globalThis : this);
