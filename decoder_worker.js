// /**
//  * decoder_worker.js
//  * * Features:
//  * 1. SSE Connection handling in background thread.
//  * 2. Batching: Collects packets to reduce CPU context-switching overhead.
//  * 3. Safety Flush: Ensures small batches are processed if no new data arrives.
//  * 4. Zero-copy transfer: Uses Transferable objects for maximum speed.
//  */

// let leftoverByte = null;
// let packetQueue = [];
// let flushTimeout = null;

// // CONFIGURATION
// const BATCH_SIZE = 10;      // Number of packets to group together
// const FLUSH_INTERVAL = 10; // Milliseconds to wait before forcing a process of partial batches

// self.onmessage = function(e) {
//     if (e.data.command === 'connect') {
//         const url = e.data.url;
//         const ev = new EventSource(url);

//         ev.addEventListener("audio", (event) => {
//             // Add raw base64 to queue
//             packetQueue.push(event.data);

//             // Reset the safety flush timer
//             clearTimeout(flushTimeout);

//             if (packetQueue.length >= BATCH_SIZE) {
//                 // Batch is full, process immediately
//                 processBatch();
//             } else {
//                 // Batch not full yet, set a timer to flush it anyway if no more come
//                 flushTimeout = setTimeout(() => {
//                     if (packetQueue.length > 0) {
//                         processBatch();
//                     }
//                 }, FLUSH_INTERVAL);
//             }
//         });

//         ev.onopen = () => self.postMessage({ type: 'log', msg: "🔌 Worker: SSE Connected (Batching + Auto-Flush Active)" });
//         ev.onerror = () => self.postMessage({ type: 'log', msg: "📡 Worker: SSE Connection Lost. Retrying..." });
//     }
// };

// /**
//  * Converts a batch of Base64 packets into a single Float32Array 
//  * and transfers it to the main thread.
//  */
// function processBatch() {
//     try {
//         if (packetQueue.length === 0) return;

//         // 1. Decode all base64 strings in the queue into a single byte array
//         let totalLength = 0;
//         const decodedPackets = packetQueue.map(b64 => {
//             const binary = atob(b64);
//             totalLength += binary.length;
//             return binary;
//         });

//         let bytes = new Uint8Array(totalLength);
//         let offset = 0;
//         for (const binary of decodedPackets) {
//             for (let i = 0; i < binary.length; i++) {
//                 bytes[offset++] = binary.charCodeAt(i);
//             }
//         }

//         // Clear the queue for the next batch
//         packetQueue = [];

//         // 2. PCM Stitching (16-bit / 2-byte alignment)
//         let finalBytes = bytes;
//         if (leftoverByte !== null) {
//             let stitched = new Uint8Array(bytes.length + 1);
//             stitched[0] = leftoverByte;
//             stitched.set(bytes, 1);
//             finalBytes = stitched;
//             leftoverByte = null;
//         }

//         if (finalBytes.length % 2 !== 0) {
//             leftoverByte = finalBytes[finalBytes.length - 1];
//             finalBytes = finalBytes.slice(0, -1);
//         }

//         // 3. Float32 Conversion
//         const float32 = new Float32Array(finalBytes.length / 2);
//         const view = new DataView(finalBytes.buffer);
//         for (let i = 0; i < float32.length; i++) {
//             // Int16 to Float32 [-1.0, 1.0]
//             float32[i] = view.getInt16(i * 2, true) / 32768.0;
//         }

//         // 4. Zero-copy transfer to Main Thread
//         // The second argument [float32.buffer] "transfers" ownership of the memory 
//         // so the worker doesn't have to copy the data.
//         self.postMessage({ 
//             type: 'data', 
//             buffer: float32.buffer 
//         }, [float32.buffer]);

//     } catch (err) {
//         self.postMessage({ type: 'log', msg: "❌ Worker Error: " + err.message });
//     }
// }





/**
 * decoder_worker.js
 * Features:
 * 1. SSE Connection handling in background thread with automatic reconnection.
 * 2. Batching: Collects packets to reduce CPU context-switching overhead.
 * 3. Safety Flush: Ensures small batches are processed if no new data arrives.
 * 4. Zero-copy transfer: Uses Transferable objects for maximum speed.
 * 5. Production-ready: Error handling, connection recovery, graceful shutdown.
 */

// let leftoverByte = null;
// let packetQueue = [];
// let flushTimeout = null;
// let eventSource = null;
// let reconnectAttempts = 0;
// let isShuttingDown = false;

// // CONFIGURATION
// const BATCH_SIZE = 40;           // Number of packets to group together
// const FLUSH_INTERVAL = 40;       // Milliseconds to wait before forcing a process of partial batches
// const MAX_RECONNECT_ATTEMPTS = 5; // Maximum reconnection attempts before giving up
// const RECONNECT_DELAY = 2000;    // Base delay between reconnection attempts (ms)
// const MAX_QUEUE_SIZE = 10000;     // Prevent memory overflow

// self.onmessage = function(e) {
//     if (e.data.command === 'connect') {
//         const url = e.data.url;
//         connectToSSE(url);
//     } else if (e.data.command === 'disconnect') {
//         gracefulShutdown();
//     }
// };

// function connectToSSE(url) {
//     try {
//         if (eventSource) {
//             eventSource.close();
//         }

//         eventSource = new EventSource(url);

//         eventSource.addEventListener("audio", (event) => {
//             try {
//                 // Queue size protection
//                 if (packetQueue.length >= MAX_QUEUE_SIZE) {
//                     self.postMessage({ 
//                         type: 'log', 
//                         msg: `⚠️ Worker: Queue overflow, dropping packet. Queue size: ${packetQueue.length}` 
//                     });
//                     return;
//                 }

//                 // Add raw base64 to queue
//                 packetQueue.push(event.data);

//                 // Reset reconnect counter on successful data
//                 reconnectAttempts = 0;

//                 // Reset the safety flush timer
//                 clearTimeout(flushTimeout);

//                 if (packetQueue.length >= BATCH_SIZE) {
//                     // Batch is full, process immediately
//                     processBatch();
//                 } else {
//                     // Batch not full yet, set a timer to flush it anyway if no more come
//                     flushTimeout = setTimeout(() => {
//                         if (packetQueue.length > 0) {
//                             processBatch();
//                         }
//                     }, FLUSH_INTERVAL);
//                 }
//             } catch (err) {
//                 self.postMessage({ 
//                     type: 'log', 
//                     msg: `❌ Worker: Audio event handler error: ${err.message}` 
//                 });
//             }
//         });

//         eventSource.onopen = () => {
//             reconnectAttempts = 0;
//             self.postMessage({ 
//                 type: 'log', 
//                 msg: "🔌 Worker: SSE Connected (Batching + Auto-Flush Active)" 
//             });
//         };

//         eventSource.onerror = (error) => {
//             self.postMessage({ 
//                 type: 'log', 
//                 msg: "📡 Worker: SSE Connection Lost. Retrying..." 
//             });

//             if (!isShuttingDown) {
//                 handleReconnection(url);
//             }
//         };

//     } catch (err) {
//         self.postMessage({ 
//             type: 'log', 
//             msg: `❌ Worker: Connection error: ${err.message}` 
//         });
//     }
// }

// function handleReconnection(url) {
//     if (eventSource) {
//         eventSource.close();
//         eventSource = null;
//     }

//     if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
//         self.postMessage({ 
//             type: 'error', 
//             msg: `❌ Worker: Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.` 
//         });
//         return;
//     }

//     reconnectAttempts++;
//     const delay = RECONNECT_DELAY * reconnectAttempts; // Exponential backoff

//     self.postMessage({ 
//         type: 'log', 
//         msg: `🔄 Worker: Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...` 
//     });

//     setTimeout(() => {
//         if (!isShuttingDown) {
//             connectToSSE(url);
//         }
//     }, delay);
// }

// function gracefulShutdown() {
//     isShuttingDown = true;

//     // Process remaining packets
//     if (packetQueue.length > 0) {
//         self.postMessage({ 
//             type: 'log', 
//             msg: `🛑 Worker: Processing ${packetQueue.length} remaining packets before shutdown...` 
//         });
//         processBatch();
//     }

//     // Clear timers
//     if (flushTimeout) {
//         clearTimeout(flushTimeout);
//         flushTimeout = null;
//     }

//     // Close connection
//     if (eventSource) {
//         eventSource.close();
//         eventSource = null;
//     }

//     // Reset state
//     leftoverByte = null;
//     packetQueue = [];
//     reconnectAttempts = 0;

//     self.postMessage({ type: 'log', msg: "✅ Worker: Graceful shutdown complete" });
// }

// /**
//  * Converts a batch of Base64 packets into a single Float32Array 
//  * and transfers it to the main thread.
//  */
// function processBatch() {
//     try {
//         if (packetQueue.length === 0) return;

//         // 1. Decode all base64 strings in the queue into a single byte array
//         let totalLength = 0;
//         const decodedPackets = packetQueue.map(b64 => {
//             if (!b64 || typeof b64 !== 'string') {
//                 throw new Error('Invalid base64 data received');
//             }
//             const binary = atob(b64);
//             totalLength += binary.length;
//             return binary;
//         });

//         let bytes = new Uint8Array(totalLength);
//         let offset = 0;
//         for (const binary of decodedPackets) {
//             for (let i = 0; i < binary.length; i++) {
//                 bytes[offset++] = binary.charCodeAt(i);
//             }
//         }

//         // Clear the queue for the next batch
//         const processedCount = packetQueue.length;
//         packetQueue = [];

//         // 2. PCM Stitching (16-bit / 2-byte alignment)
//         let finalBytes = bytes;
//         if (leftoverByte !== null) {
//             let stitched = new Uint8Array(bytes.length + 1);
//             stitched[0] = leftoverByte;
//             stitched.set(bytes, 1);
//             finalBytes = stitched;
//             leftoverByte = null;
//         }

//         if (finalBytes.length % 2 !== 0) {
//             leftoverByte = finalBytes[finalBytes.length - 1];
//             finalBytes = finalBytes.slice(0, -1);
//         }

//         // 3. Float32 Conversion
//         const float32 = new Float32Array(finalBytes.length / 2);
//         const view = new DataView(finalBytes.buffer);
//         for (let i = 0; i < float32.length; i++) {
//             // Int16 to Float32 [-1.0, 1.0]
//             float32[i] = view.getInt16(i * 2, true) / 32768.0;
//         }

//         // 4. Zero-copy transfer to Main Thread
//         self.postMessage({ 
//             type: 'data', 
//             buffer: float32.buffer,
//             packetCount: processedCount,
//             sampleCount: float32.length
//         }, [float32.buffer]);

//     } catch (err) {
//         self.postMessage({ 
//             type: 'error', 
//             msg: `❌ Worker Error in processBatch: ${err.message}` 
//         });
        
//         // Clear queue on error to prevent corruption propagation
//         packetQueue = [];
//         leftoverByte = null;
//     }
// }













/**
 * decoder_worker.js - Continuous Streaming with Smart Buffering
 * Sends small chunks frequently while maintaining a minimum buffer on first start
 */

let leftoverByte = null;
let audioBuffer = new Uint8Array(0);
let eventSource = null;
let reconnectAttempts = 0;
let isShuttingDown = false;
let hasStartedPlaying = false;      // Track if we've ever started playing
let sendTimeout = null;

// CONFIGURATION - OPTIMIZED FOR CONTINUOUS STREAMING
const MIN_INITIAL_BUFFER = 48000;   // Wait for 1.5 seconds before FIRST play (smooth start)
const CONTINUOUS_SEND_SIZE = 8192;  // After started, send every ~256ms (one packet worth)
const SAFETY_FLUSH_INTERVAL = 50;   // Send buffer if no new data for 50ms
const MAX_BUFFER_SIZE = 320000;     // 10 seconds maximum
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000;

self.onmessage = function(e) {
    if (e.data.command === 'connect') {
        const url = e.data.url;
        connectToSSE(url);
    } else if (e.data.command === 'disconnect') {
        gracefulShutdown();
    } else if (e.data.command === 'reset_playback') {
        // Allow resetting the "first play" flag if needed
        hasStartedPlaying = false;
        self.postMessage({ 
            type: 'log', 
            msg: '🔄 Worker: Playback state reset' 
        });
    }
};

function connectToSSE(url) {
    try {
        if (eventSource) {
            eventSource.close();
        }

        eventSource = new EventSource(url);

        eventSource.addEventListener("audio", (event) => {
            try {
                queueAudioChunk(event.data);
            } catch (err) {
                self.postMessage({ 
                    type: 'log', 
                    msg: `❌ Worker: Audio event handler error: ${err.message}` 
                });
            }
        });

        eventSource.onopen = () => {
            reconnectAttempts = 0;
            self.postMessage({ 
                type: 'log', 
                msg: "🔌 Worker: SSE Connected (Continuous Streaming Mode)" 
            });
        };

        eventSource.onerror = (error) => {
            self.postMessage({ 
                type: 'log', 
                msg: "📡 Worker: SSE Connection Lost. Retrying..." 
            });

            if (!isShuttingDown) {
                handleReconnection(url);
            }
        };

    } catch (err) {
        self.postMessage({ 
            type: 'log', 
            msg: `❌ Worker: Connection error: ${err.message}` 
        });
    }
}

/**
 * Queue incoming audio chunk with smart sending logic
 */
function queueAudioChunk(base64Audio) {
    try {
        // 1. Decode base64 to bytes
        const binaryString = atob(base64Audio);
        const chunk = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            chunk[i] = binaryString.charCodeAt(i);
        }

        // 2. Append to continuous buffer
        const newBuffer = new Uint8Array(audioBuffer.length + chunk.length);
        newBuffer.set(audioBuffer);
        newBuffer.set(chunk, audioBuffer.length);
        audioBuffer = newBuffer;

        // Reset reconnect counter on successful data
        reconnectAttempts = 0;

        // 3. Buffer overflow protection
        if (audioBuffer.length > MAX_BUFFER_SIZE) {
            self.postMessage({ 
                type: 'log', 
                msg: `⚠️ Buffer overflow! Trimming buffer from ${audioBuffer.length} to ${MAX_BUFFER_SIZE/2}` 
            });
            audioBuffer = audioBuffer.slice(audioBuffer.length - (MAX_BUFFER_SIZE / 2));
        }

        // 4. Clear any pending safety flush
        clearTimeout(sendTimeout);

        // 5. Smart sending logic
        if (!hasStartedPlaying) {
            // FIRST-TIME PLAYBACK: Wait for larger buffer to ensure smooth start
            if (audioBuffer.length >= MIN_INITIAL_BUFFER) {
                self.postMessage({ 
                    type: 'log', 
                    msg: `🚀 Initial buffer ready! Sending ${audioBuffer.length} bytes` 
                });
                sendBufferedAudio();
                hasStartedPlaying = true;
            } else {
                self.postMessage({ 
                    type: 'log', 
                    msg: `⏳ Initial buffering: ${audioBuffer.length}/${MIN_INITIAL_BUFFER} bytes` 
                });
                setSafetyFlush();
            }
        } else {
            // CONTINUOUS STREAMING: Send frequently in small chunks
            if (audioBuffer.length >= CONTINUOUS_SEND_SIZE) {
                sendBufferedAudio();
            } else {
                setSafetyFlush();
            }
        }

    } catch (error) {
        self.postMessage({ 
            type: 'error', 
            msg: `❌ Error queueing audio chunk: ${error.message}` 
        });
    }
}

/**
 * Set a safety timer to flush the buffer if no new data arrives
 */
function setSafetyFlush() {
    clearTimeout(sendTimeout);
    sendTimeout = setTimeout(() => {
        if (audioBuffer.length > 0) {
            self.postMessage({ 
                type: 'log', 
                msg: `⏰ Safety flush: ${audioBuffer.length} bytes (${(audioBuffer.length / 2 / 16000 * 1000).toFixed(0)}ms)` 
            });
            sendBufferedAudio();
            if (!hasStartedPlaying) {
                hasStartedPlaying = true;
            }
        }
    }, SAFETY_FLUSH_INTERVAL);
}

/**
 * Process and send the accumulated buffer to main thread
 */
function sendBufferedAudio() {
    try {
        if (audioBuffer.length === 0) return;

        clearTimeout(sendTimeout);

        // 1. Handle PCM byte alignment (16-bit / 2-byte alignment)
        let finalBytes = audioBuffer;
        
        // Prepend leftover byte from previous batch if exists
        if (leftoverByte !== null) {
            let stitched = new Uint8Array(audioBuffer.length + 1);
            stitched[0] = leftoverByte;
            stitched.set(audioBuffer, 1);
            finalBytes = stitched;
            leftoverByte = null;
        }

        // Save odd byte for next batch
        if (finalBytes.length % 2 !== 0) {
            leftoverByte = finalBytes[finalBytes.length - 1];
            finalBytes = finalBytes.slice(0, -1);
        }

        // 2. Convert to Float32Array
        const float32 = new Float32Array(finalBytes.length / 2);
        const view = new DataView(finalBytes.buffer);
        for (let i = 0; i < float32.length; i++) {
            // Int16 to Float32 [-1.0, 1.0]
            float32[i] = view.getInt16(i * 2, true) / 32768.0;
        }

        // 3. Calculate audio duration
        const durationMs = (float32.length / 16000 * 1000).toFixed(0);

        // 4. Send to main thread with zero-copy transfer
        self.postMessage({ 
            type: 'data', 
            buffer: float32.buffer,
            sampleCount: float32.length,
            durationMs: parseFloat(durationMs)
        }, [float32.buffer]);

        // 5. Clear the buffer
        audioBuffer = new Uint8Array(0);

    } catch (err) {
        self.postMessage({ 
            type: 'error', 
            msg: `❌ Error in sendBufferedAudio: ${err.message}` 
        });
        
        // Clear buffer on error
        audioBuffer = new Uint8Array(0);
        leftoverByte = null;
    }
}

function handleReconnection(url) {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        self.postMessage({ 
            type: 'error', 
            msg: `❌ Worker: Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.` 
        });
        return;
    }

    reconnectAttempts++;
    const delay = RECONNECT_DELAY * reconnectAttempts;

    self.postMessage({ 
        type: 'log', 
        msg: `🔄 Worker: Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...` 
    });

    setTimeout(() => {
        if (!isShuttingDown) {
            connectToSSE(url);
        }
    }, delay);
}

function gracefulShutdown() {
    isShuttingDown = true;

    // Process remaining buffer
    if (audioBuffer.length > 0) {
        self.postMessage({ 
            type: 'log', 
            msg: `🛑 Worker: Sending ${audioBuffer.length} remaining bytes before shutdown...` 
        });
        sendBufferedAudio();
    }

    // Clear timers
    if (sendTimeout) {
        clearTimeout(sendTimeout);
        sendTimeout = null;
    }

    // Close connection
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }

    // Reset state
    leftoverByte = null;
    audioBuffer = new Uint8Array(0);
    reconnectAttempts = 0;
    hasStartedPlaying = false;

    self.postMessage({ type: 'log', msg: "✅ Worker: Graceful shutdown complete" });
}