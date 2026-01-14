// stream_processor.js
class StreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.MAX_BUFFER_SIZE = 640000; // 10 seconds of safety
    this.buffer = new Float32Array(this.MAX_BUFFER_SIZE);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.count = 0;
    
    // INCREASED MIN COUNT: 
    // This waits for 1.5 seconds of audio before playing. 
    // This is the ONLY way to stop breaks on a slow bot connection.
    this.minCount = 2000;             // changed from 24000
    this.isPlaying = false;

    this.port.onmessage = (e) => {
      if (e.data.event === 'write') {
        const input = e.data.buffer;
        for (let i = 0; i < input.length; i++) {
          this.buffer[this.writeIndex] = input[i];
          this.writeIndex = (this.writeIndex + 1) % this.MAX_BUFFER_SIZE;
          this.count++;
        }
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channel = output[0];

    // If we haven't started yet, wait until the guard buffer is full
    if (!this.isPlaying && this.count >= this.minCount) {
      this.isPlaying = true;
    }

    if (this.isPlaying) {
      if (this.count >= channel.length) {
        for (let i = 0; i < channel.length; i++) {
          channel[i] = this.buffer[this.readIndex];
          this.readIndex = (this.readIndex + 1) % this.MAX_BUFFER_SIZE;
          this.count--;
        }
      } else {
        // UNDERFLOW: The bot/network was too slow. 
        // We MUST stop and re-buffer to prevent "stuttering static"
        this.isPlaying = false;
        for (let i = 0; i < channel.length; i++) channel[i] = 0;
      }
    } else {
      for (let i = 0; i < channel.length; i++) channel[i] = 0;
    }
    return true;
  }
}
registerProcessor('stream_processor', StreamProcessor);