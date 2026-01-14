// stream_processor.js
// class StreamProcessor extends AudioWorkletProcessor {
//   constructor() {
//     super();
//     this.MAX_BUFFER_SIZE = 640000; // 10 seconds of safety
//     this.buffer = new Float32Array(this.MAX_BUFFER_SIZE);
//     this.writeIndex = 0;
//     this.readIndex = 0;
//     this.count = 0;
    
//     // INCREASED MIN COUNT: 
//     // This waits for 1.5 seconds of audio before playing. 
//     // This is the ONLY way to stop breaks on a slow bot connection.
//     this.minCount = 2000;             // changed from 24000
//     this.isPlaying = false;

//     this.port.onmessage = (e) => {
//       if (e.data.event === 'write') {
//         const input = e.data.buffer;
//         for (let i = 0; i < input.length; i++) {
//           this.buffer[this.writeIndex] = input[i];
//           this.writeIndex = (this.writeIndex + 1) % this.MAX_BUFFER_SIZE;
//           this.count++;
//         }
//       }
//     };
//   }

//   process(inputs, outputs, parameters) {
//     const output = outputs[0];
//     const channel = output[0];

//     // If we haven't started yet, wait until the guard buffer is full
//     if (!this.isPlaying && this.count >= this.minCount) {
//       this.isPlaying = true;
//     }

//     if (this.isPlaying) {
//       if (this.count >= channel.length) {
//         for (let i = 0; i < channel.length; i++) {
//           channel[i] = this.buffer[this.readIndex];
//           this.readIndex = (this.readIndex + 1) % this.MAX_BUFFER_SIZE;
//           this.count--;
//         }
//       } else {
//         // UNDERFLOW: The bot/network was too slow. 
//         // We MUST stop and re-buffer to prevent "stuttering static"
//         this.isPlaying = false;
//         for (let i = 0; i < channel.length; i++) channel[i] = 0;
//       }
//     } else {
//       for (let i = 0; i < channel.length; i++) channel[i] = 0;
//     }
//     return true;
//   }
// }
// registerProcessor('stream_processor', StreamProcessor);


// stream_processor.js - FIXED VERSION
class StreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.MAX_BUFFER_SIZE = 640000; // 10 seconds
    this.buffer = new Float32Array(this.MAX_BUFFER_SIZE);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.count = 0;
    
    // ADAPTIVE BUFFERING STRATEGY
    this.MIN_STARTUP_BUFFER = 6400;   // 400ms initial buffer (6400 samples @ 16kHz)
    this.MIN_RESUME_BUFFER = 8000;   // 500ms buffer when resuming after silence
    this.MIN_PLAYING_BUFFER = 1600;   // 100ms minimum during playback
    
    this.isPlaying = false;
    this.wasUnderflow = false;        // Track if we just had an underflow
    this.consecutiveGoodFrames = 0;   // Track stability
    
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
    
    // Determine required buffer threshold based on state
    let requiredBuffer;
    if (!this.isPlaying) {
      // If we just had an underflow, require MORE buffer before resuming
      requiredBuffer = this.wasUnderflow ? this.MIN_RESUME_BUFFER : this.MIN_STARTUP_BUFFER;
    } else {
      // During playback, allow shorter buffer (but still safe)
      requiredBuffer = this.MIN_PLAYING_BUFFER;
    }

    // Start/resume playback when we have enough buffer
    if (!this.isPlaying && this.count >= requiredBuffer) {
      this.isPlaying = true;
      this.wasUnderflow = false;
      this.consecutiveGoodFrames = 0;
      this.port.postMessage({ event: 'status', playing: true });
    }

    if (this.isPlaying) {
      if (this.count >= channel.length) {
        // We have enough samples - play them
        for (let i = 0; i < channel.length; i++) {
          channel[i] = this.buffer[this.readIndex];
          this.readIndex = (this.readIndex + 1) % this.MAX_BUFFER_SIZE;
          this.count--;
        }
        this.consecutiveGoodFrames++;
      } else {
        // UNDERFLOW - stop playback and re-buffer
        this.isPlaying = false;
        this.wasUnderflow = true;
        this.consecutiveGoodFrames = 0;
        
        // Output silence
        for (let i = 0; i < channel.length; i++) {
          channel[i] = 0;
        }
        
        this.port.postMessage({ 
          event: 'status', 
          playing: false, 
          reason: 'underflow',
          bufferLevel: this.count 
        });
      }
    } else {
      // Not playing - output silence
      for (let i = 0; i < channel.length; i++) {
        channel[i] = 0;
      }
    }
    
    return true;
  }
}

registerProcessor('stream_processor', StreamProcessor);