/*
 * 极简 DOM / WebAudio stub，用来在 Node 里端到端跑界面层（app.js）。
 * 元素 id 直接从 index.html 里抓，所以 app.js 要是引用了不存在的 id，
 * getElementById 会返回 null，测试立刻炸——正好当交叉校验。
 */
const fs = require('fs');
const path = require('path');

function makeElement(id, tag) {
  const el = {
    id: id || '',
    tagName: (tag || 'div').toUpperCase(),
    _listeners: {},
    _html: '',
    _classes: [],
    children: [],
    style: {},
    dataset: {},
    value: '',
    textContent: '',
    clientWidth: 0,
    clientHeight: 0,
    focused: false,

    classList: {
      add(c) { if (!el._classes.includes(c)) el._classes.push(c); },
      remove(c) { el._classes = el._classes.filter(x => x !== c); },
      contains(c) { return el._classes.includes(c); },
      toggle(c, force) {
        const has = el._classes.includes(c);
        const want = force === undefined ? !has : !!force;
        if (want && !has) el._classes.push(c);
        if (!want && has) el._classes = el._classes.filter(x => x !== c);
        return want;
      },
    },

    appendChild(c) { el.children.push(c); return c; },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() {
      return {
        left: 0, top: 0, right: el.clientWidth, bottom: el.clientHeight,
        width: el.clientWidth, height: el.clientHeight,
      };
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    removeAttribute() {},
    load() {},
    play() { el.paused = false; return { catch() {} }; },
    pause() { el.paused = true; },
    focus() { el.focused = true; },
    click() {
      const fns = el._listeners.click || [];
      fns.forEach(fn => fn({ preventDefault() {}, target: el }));
    },
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = String(v); if (v === '') el.children = []; },
  };
  return el;
}

function install(htmlRelPath) {
  const html = fs.readFileSync(path.join(__dirname, '..', htmlRelPath), 'utf8');
  const ids = [];
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) ids.push(m[1]);

  const elements = new Map();
  ids.forEach(id => elements.set(id, makeElement(id)));

  const scene = elements.get('scene');
  if (!scene) throw new Error('index.html 里没有 #scene');

  /* ---- 假 2D 上下文 ---- */
  class Gradient {
    constructor() { this.stops = []; }
    addColorStop(o, c) { this.stops.push([o, c]); }
  }
  const canvasCtx = {
    ops: [],
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    setTransform() {}, save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    translate() {}, rotate() {}, scale() {},
    quadraticCurveTo() {}, arc() {}, fill() {}, stroke() {}, clearRect() {}, fillRect() {}, fillText() {},
    createLinearGradient() { return new Gradient(); },
    createRadialGradient() { return new Gradient(); },
  };
  scene.clientWidth = 1920;
  scene.clientHeight = 1080;
  scene.getContext = () => canvasCtx;

  /* ---- document ---- */
  const docListeners = {};
  const document = {
    readyState: 'complete',
    hidden: false,
    body: makeElement('body'),
    documentElement: makeElement('html'),
    getElementById(id) { return elements.get(id) || null; },
    createElement(tag) { return makeElement('', tag); },
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
  };

  /* ---- window ---- */
  const winListeners = {};
  globalThis.window = globalThis;
  globalThis.document = document;
  globalThis.location = { search: '', href: 'file:///rhythm4k/www/index.html' };
  globalThis.devicePixelRatio = 1;
  globalThis.addEventListener = (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); };
  globalThis.removeEventListener = () => {};

  /* ---- 时钟 ---- */
  let perf = 0;
  globalThis.performance = { now: () => perf };
  let rafCb = null;
  globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  globalThis.cancelAnimationFrame = () => { rafCb = null; };

  function step(dtMs) {
    perf += dtMs;
    const cb = rafCb;
    rafCb = null;
    if (cb) cb(perf);
  }

  /* ---- localStorage ---- */
  const store = {};
  // 测试环境不要访问本地节拍服务（Node 自带 fetch，会把真服务请求进去）
  store['rhythm4k.settings.v2'] = JSON.stringify({ useLocalBeats: false });
  globalThis.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };

  /* ---- AudioContext ---- */
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.sampleRate = 22050;
      this.outputLatency = 0.015;
      this.baseLatency = 0.01;
      this.destination = { connect() {} };
      FakeAudioContext.last = this;
    }
    createGain() {
      const param = {
        value: 1,
        setValueAtTime() { return param; },
        linearRampToValueAtTime() { return param; },
        exponentialRampToValueAtTime() { return param; },
        setTargetAtTime() { return param; },
      };
      return { gain: param, connect() { return this; }, disconnect() {} };
    }
    createBufferSource() {
      return { buffer: null, connect() { return this; }, start() {}, stop() {} };
    }
    createBuffer(ch, len, sr) {
      const sampleRate = sr || 44100;
      const data = new Float32Array(len);
      return {
        numberOfChannels: ch,
        length: len,
        sampleRate: sampleRate,
        duration: len / sampleRate,
        getChannelData: () => data,
        copyToChannel(src) {
          if (!src) return;
          const n = Math.min(src.length || 0, len);
          for (let i = 0; i < n; i++) data[i] = src[i];
        },
      };
    }
    createBiquadFilter() {
      return { type: "lowpass", frequency: { value: 0 }, Q: { value: 1 },
               connect() { return this; } };
    }
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 440, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() { return this; },
        disconnect() {},
        start() {},
        stop() {},
      };
    }
    decodeAudioData(buf, ok) {
      // 造一段 150 BPM 的测试信号（每 0.4 秒一个脉冲），让自动生成流程能跑出 BPM=150
      const sr = 22050;
      const dur = 32;
      const out = this.createBuffer(1, dur * sr, sr);
      const d = out.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const tSec = i / sr;
        const ph = tSec % 0.4;
        if (ph < 0.012) {
          const env = 1 - ph / 0.012;
          d[i] = Math.sin(2 * Math.PI * 180 * ph) * env * 0.85
               + Math.sin(2 * Math.PI * 2400 * ph) * env * 0.25;
        }
      }
      if (typeof ok === 'function') ok(out);
      return Promise.resolve(out);
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
  }
  globalThis.AudioContext = FakeAudioContext;
  globalThis.webkitAudioContext = FakeAudioContext;

  /* ---- Image / object URL ---- */
  let urlSeq = 0;
  const liveUrls = new Set();
  globalThis.URL = globalThis.URL || {};
  globalThis.URL.createObjectURL = function () {
    const u = 'blob:stub/' + (++urlSeq);
    liveUrls.add(u);
    return u;
  };
  globalThis.URL.revokeObjectURL = function (u) { liveUrls.delete(u); };

  class FakeImage {
    constructor() {
      this.naturalWidth = 800;
      this.naturalHeight = 600;
      this.onload = null;
      this._src = '';
    }
    set src(v) {
      this._src = v;
      const self = this;
      setTimeout(function () { if (self.onload) self.onload(); }, 0);
    }
    get src() { return this._src; }
  }
  globalThis.Image = FakeImage;

  /* ---- 帮助函数 ---- */
  const api = {
    elements,
    ids,
    canvasCtx,
    docListeners,
    winListeners,
    liveUrls,
    step,
    now: () => perf,
    audioContext: () => FakeAudioContext.last,
    el: id => elements.get(id),
    isHidden(id) { return api.el(id).classList.contains('hidden'); },
    click(id) {
      const el = api.el(id);
      if (!el) throw new Error('没有这个元素：' + id);
      el.click();
    },
    key(type, code, timeStamp) {
      const list = winListeners[type] || [];
      const ev = {
        code, timeStamp: timeStamp === undefined ? perf : timeStamp,
        repeat: false, preventDefault() {}, target: globalThis.document.body,
      };
      for (const fn of list.slice()) fn(ev);
      return ev;
    },
    /** 触发某个元素上注册过的监听（change / input / click…） */
    fire(id, type, patch) {
      const el = api.el(id);
      if (!el) throw new Error('没有这个元素：' + id);
      const ev = Object.assign({ target: el, preventDefault() {}, stopPropagation() {} }, patch || {});
      (el._listeners[type] || []).slice().forEach(fn => fn(ev));
      return ev;
    },
    /** 让 currentTime 前进（暂停时会停住，跟真实 AudioContext 一致） */
    advanceAudio(ms) {
      const ctx = FakeAudioContext.last;
      if (!ctx) return;
      if (ctx.state === 'running') ctx.currentTime += ms / 1000;
    },
    async flush(ms) {
      await new Promise(r => setTimeout(r, ms === undefined ? 5 : ms));
    },
  };

  return api;
}

module.exports = { install, makeElement };
