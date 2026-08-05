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

    // consumed 跟踪输入域（设备采样率）的已消费位置；
    // 每个输出帧 frameSize(320)@16kHz 对应输入域 inputStep = frameSize/ratio 个采样。
    // 之前 consumed 按输出域步进却用输入域 merged 比较/切片，采样率≠16kHz 时会越界读 NaN。
    const inputStep = this.frameSize / this.ratio;
    let consumed = 0;
    while (consumed + inputStep <= merged.length) {
      const frame = new Float32Array(this.frameSize);
      for (let i = 0; i < this.frameSize; i++) {
        const srcPos = consumed + i / this.ratio;
        const i0 = Math.floor(srcPos);
        const i1 = Math.min(i0 + 1, merged.length - 1);
        const frac = srcPos - i0;
        frame[i] = merged[i0] * (1 - frac) + merged[i1] * frac;
      }
      this.port.postMessage(frame);
      consumed += inputStep;
    }
    if (consumed > 0) this.buffer = merged.slice(Math.floor(consumed));
    return true;
  }
}

registerProcessor('mic-resampler', MicResampler);
