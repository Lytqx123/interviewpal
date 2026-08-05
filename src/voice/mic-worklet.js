// 麦克风重采样 AudioWorklet：把设备采样率（通常 48kHz）线性重采样到
// 16kHz 单声道，按 20ms（320 采样点）一包发给主线程。
class MicResampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    this.frameSize = 320; // 20ms @ 16kHz
    this.ratio = 0; // 16000 / 设备采样率
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || !input[0].length) return true;
    if (!this.ratio) this.ratio = 16000 / sampleRate;

    const channel = input[0];
    const merged = new Float32Array(this.buffer.length + channel.length);
    merged.set(this.buffer);
    merged.set(channel, this.buffer.length);

    let consumed = 0;
    while (consumed + this.frameSize <= merged.length) {
      const frame = new Float32Array(this.frameSize);
      for (let i = 0; i < this.frameSize; i++) {
        const srcPos = (consumed + i) / this.ratio;
        const i0 = Math.floor(srcPos);
        const i1 = Math.min(i0 + 1, merged.length - 1);
        const frac = srcPos - i0;
        frame[i] = merged[i0] * (1 - frac) + merged[i1] * frac;
      }
      this.port.postMessage(frame);
      consumed += this.frameSize;
    }
    if (consumed > 0) this.buffer = merged.slice(consumed);
    return true;
  }
}

registerProcessor('mic-resampler', MicResampler);
