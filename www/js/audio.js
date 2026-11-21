/*
 * audio.js — WebAudio 主时钟
 * 音游的时钟必须以音频为准，不能用 rAF / setInterval 累加，否则会漂。
 */
(function (root) {
  'use strict';
  const M4K = (root.M4K = root.M4K || {});

  const PREROLL = 0.7; // 按下开始到真正出声的预留（秒）

  class AudioClock {
    constructor() {
      this.ctx = null;
      this.buffer = null;
      this.source = null;
      this.gain = null;
      this.startedAt = 0;
      this.baseOffset = 0;
      this.latencyMs = 0;
      this.volume = 0.9;
      this.playing = false;
    }

    async ensure() {
      if (!this.ctx) {
        const Ctor = root.AudioContext || root.webkitAudioContext;
        if (!Ctor) throw new Error('这个浏览器不支持 WebAudio');
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.volume;
        this.gain.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }

    async decode(arrayBuffer) {
      const ctx = await this.ensure();
      // decodeAudioData 会把 buffer 拿走（detach），所以先拷一份
      const copy = arrayBuffer.slice(0);
      return await new Promise(function (resolve, reject) {
        ctx.decodeAudioData(copy, resolve, reject);
      });
    }

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      if (this.gain) this.gain.gain.value = this.volume;
    }

    /** 从 buffer 的 offsetSec 处开始播放 */
    play(buffer, offsetSec) {
      const ctx = this.ctx;
      this.stop();
      this.buffer = buffer;
      this.baseOffset = offsetSec || 0;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);

      this._refreshLatency();

      const t0 = ctx.currentTime + PREROLL;
      src.start(t0, this.baseOffset);
      this.source = src;
      this.startedAt = t0;
      this.playing = true;
    }

    _refreshLatency() {
      const ctx = this.ctx;
      const out = typeof ctx.outputLatency === 'number' ? ctx.outputLatency : 0;
      const base = typeof ctx.baseLatency === 'number' ? ctx.baseLatency : 0;
      this.latencyMs = (out || base || 0) * 1000;
    }

    /**
     * 当前歌曲位置（毫秒）。已经把输出延迟扣掉，等于"耳朵听到的位置"。
     */
    /** 某个「歌曲时刻(ms)」对应的 AudioContext 时刻(秒)。
     *  用于提前调度音效，避免输出延迟导致的错位。 */
    ctxTimeForSong(songMs) {
      if (!this.ctx || !this.startedAt) return 0;
      return this.startedAt + (songMs - this.baseOffset * 1000) / 1000;
    }

    /** 输出延迟（毫秒）：音效要被听到，必须比 ctx 时刻再提前这么多 */
    latency() { return this.latencyMs || 0; }

    now() {
      if (!this.ctx || !this.source) return 0;
      const elapsed = this.ctx.currentTime - this.startedAt;
      return this.baseOffset * 1000 + elapsed * 1000 - this.latencyMs;
    }

    duration() {
      return this.buffer ? this.buffer.duration * 1000 : 0;
    }

    ended() {
      if (!this.buffer) return true;
      return this.now() > this.duration() + 60;
    }

    async pause() {
      if (!this.ctx || this.ctx.state !== 'running') return;
      await this.ctx.suspend(); // suspend 会冻结 currentTime，所以 now() 自然停住
    }

    async resume() {
      if (!this.ctx) return;
      await this.ctx.resume();
    }

    stop() {
      if (this.source) {
        try {
          this.source.stop();
        } catch (e) {
          /* 已经停了 */
        }
        try {
          this.source.disconnect();
        } catch (e) {
          /* ignore */
        }
        this.source = null;
      }
      this.playing = false;
    }
  }

  M4K.AudioClock = AudioClock;
  M4K.PREROLL = PREROLL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
