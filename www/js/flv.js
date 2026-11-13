/*
 * flv.js — FLV 容器解复用 + WebCodecs 解码
 *
 * 背景：osu 谱面里的视频大量是 .flv（Flash 时代留下的），浏览器内核没有 FLV 解复用器，
 * 所以 <video> 完全放不了。但里面的编码通常是 AVC/H.264，Chromium 是能解的。
 * 于是这里自己做两件事：
 *   1. 解析 FLV tag，把 H.264 码流（AVCC 格式）和 AVCDecoderConfigurationRecord 拿出来
 *   2. 喂给 WebCodecs 的 VideoDecoder，解码结果画进一张离屏 canvas
 * 渲染层就直接把这张 canvas 当背景图用，不需要知道视频的存在。
 *
 * 只处理 AVC，其它编码（VP6 / Sorenson H.263）直接返回失败，由上层退回背景图。
 */
(function (root) {
  'use strict';
  const M4K = (root.M4K = root.M4K || {});

  /**
   * @param {ArrayBuffer} buffer 整个 .flv
   * @returns {{codec:string, description:Uint8Array, samples:Array, audioCodec:number}}
   */
  function demuxFlv(buffer) {
    const u8 = new Uint8Array(buffer);
    if (u8.length < 13 || u8[0] !== 0x46 || u8[1] !== 0x4c || u8[2] !== 0x56) {
      throw new Error('不是 FLV 文件');
    }

    let p = 9;
    p += 4; // PreviousTagSize0

    const samples = [];
    let description = null;
    let videoCodec = -1;
    let audioCodec = -1;
    let codecString = '';

    while (p + 11 <= u8.length) {
      const type = u8[p] & 0x1f;
      const size = (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
      const ts = ((u8[p + 4] << 16) | (u8[p + 5] << 8) | u8[p + 6]) + u8[p + 7] * 0x1000000;
      const body = p + 11;

      if (body + size > u8.length) break;

      if (type === 9 && size > 1) {
        const b0 = u8[body];
        const frameType = b0 >> 4;
        const cid = b0 & 0x0f;
        videoCodec = cid;

        if (cid === 7 && size > 5) {
          const packetType = u8[body + 1];
          const rawCts = (u8[body + 2] << 16) | (u8[body + 3] << 8) | u8[body + 4];
          const cts = rawCts & 0x800000 ? rawCts - 0x1000000 : rawCts;

          if (packetType === 0) {
            description = u8.subarray(body + 5, body + size);
          } else if (packetType === 1) {
            samples.push({
              dts: ts,
              pts: ts + cts,
              key: frameType === 1,
              data: u8.subarray(body + 5, body + size),
            });
          }
        }
      } else if (type === 8 && size > 1) {
        audioCodec = (u8[body] >> 4) & 0x0f;
      }

      p = body + size + 4;
    }

    if (videoCodec !== 7) {
      throw new Error('FLV 里的视频不是 H.264（codecId=' + videoCodec + '），浏览器解不了');
    }
    if (!description) throw new Error('FLV 缺少 AVC 配置段');
    if (!samples.length) throw new Error('FLV 里没有视频帧');

    // avcC: [version][profile][compat][level]...
    if (description.length >= 4) {
      const hex = function (n) { return ('0' + n.toString(16)).slice(-2); };
      codecString = 'avc1.' + hex(description[1]) + hex(description[2]) + hex(description[3]);
    }

    // 注意：绝不能按 pts 排序。FLV 存的是解码顺序，H.264 有 B 帧时
    // pts 是乱序的，按 pts 喂给解码器会直接报 EncodingError。

    return {
      codecString: codecString,
      description: description,
      samples: samples,
      audioCodec: audioCodec,
      durationMs: samples.reduce(function (m, s) { return s.pts > m ? s.pts : m; }, 0),
    };
  }

  class FlvPlayer {
    static supported() {
      return typeof root.VideoDecoder === 'function' && typeof root.VideoFrame === 'function';
    }

    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.decoder = null;
      this.samples = [];
      this.cursor = 0;
      this.frames = [];
      this.failed = false;
      this.ready = false;
      this.currentTs = -1;
      this.onError = null;
    }

    async load(file) {
      if (!FlvPlayer.supported()) throw new Error('这个浏览器不支持 WebCodecs');
      const buffer = await file.arrayBuffer();
      const info = demuxFlv(buffer);

      const support = await root.VideoDecoder.isConfigSupported({
        codec: info.codecString,
        description: info.description.slice(),
      });
      if (!support || !support.supported) throw new Error('解码器不支持 ' + info.codecString);

      this.canvas = root.document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');

      const self = this;
      this.decoder = new root.VideoDecoder({
        output: function (frame) { self._onFrame(frame); },
        error: function (e) {
          self.failed = true;
          if (root.console) console.warn('FLV 解码失败', e);
          if (self.onError) self.onError(e);
        },
      });

      this.decoder.configure({
        codec: info.codecString,
        description: info.description.slice(),
      });

      this.samples = info.samples; // 保持文件里的解码顺序
      this.cursor = 0;
      this.ready = true;
      return info;
    }

    _onFrame(frame) {
      this.frames.push(frame);
      // 队列太长就丢掉最老的，避免内存膨胀
      while (this.frames.length > 24) {
        const old = this.frames.shift();
        try { old.close(); } catch (e) { /* ignore */ }
      }
    }

    /**
     * 跟随歌曲时间推进：按需解码，然后把该显示的那一帧画到 canvas 上
     * @param {number} videoMs 视频时间（毫秒）
     */
    update(videoMs) {
      if (!this.ready || this.failed) return;
      const t = Math.max(0, videoMs);

      // 解码跑到前面 600ms
      const ahead = t + 600;
      while (this.cursor < this.samples.length && this.samples[this.cursor].dts <= ahead) {
        if (this.decoder.decodeQueueSize > 24) break;
        this.feed(this.samples[this.cursor]);
        this.cursor++;
      }

      // 找 ts <= t 的最新一帧
      let pick = null;
      for (let i = 0; i < this.frames.length; i++) {
        if (this.frames[i].timestamp / 1000 <= t) pick = this.frames[i];
        else break;
      }
      if (!pick) return;

      // 丢掉比选中帧更老的
      while (this.frames.length && this.frames[0] !== pick) {
        const old = this.frames.shift();
        try { old.close(); } catch (e) { /* ignore */ }
      }

      if (pick.timestamp === this.currentTs) return;
      this.currentTs = pick.timestamp;

      const w = pick.displayWidth || pick.codedWidth;
      const h = pick.displayHeight || pick.codedHeight;
      if (!w || !h) return;
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      try {
        this.ctx.drawImage(pick, 0, 0, w, h);
      } catch (e) {
        this.failed = true;
      }
    }

    feed(sample) {
      try {
        this.decoder.decode(new root.EncodedVideoChunk({
          type: sample.key ? 'key' : 'delta',
          timestamp: sample.pts * 1000,
          duration: undefined,
          data: sample.data,
        }));
      } catch (e) {
        this.failed = true;
      }
    }

    dispose() {
      this.ready = false;
      this.frames.forEach(function (f) { try { f.close(); } catch (e) { /* ignore */ } });
      this.frames = [];
      if (this.decoder) {
        try { this.decoder.close(); } catch (e) { /* ignore */ }
        this.decoder = null;
      }
    }
  }

  M4K.demuxFlv = demuxFlv;
  M4K.FlvPlayer = FlvPlayer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
