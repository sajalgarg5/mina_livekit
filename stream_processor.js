class StreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    this.port.onmessage = (e) => {
      if (e.data.event === 'write') {
        const newChunk = e.data.buffer;
        const combined = new Float32Array(this.buffer.length + newChunk.length);
        combined.set(this.buffer);
        combined.set(newChunk, this.buffer.length);
        this.buffer = combined;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channel = output[0];

    if (this.buffer.length < channel.length) {
      return true; // Wait for more data
    }

    const toPlay = this.buffer.slice(0, channel.length);
    channel.set(toPlay);
    this.buffer = this.buffer.slice(channel.length);

    return true;
  }
}
registerProcessor('stream_processor', StreamProcessor);