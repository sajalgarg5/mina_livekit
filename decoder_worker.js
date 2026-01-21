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

let leftoverByte = null;
let packetQueue = [];
let flushTimeout = null;
let eventSource = null;
let reconnectAttempts = 0;
let isShuttingDown = false;

// CONFIGURATION
const BATCH_SIZE = 2;           // Number of packets to group together
const FLUSH_INTERVAL = 30;       // Milliseconds to wait before forcing a process of partial batches
const MAX_RECONNECT_ATTEMPTS = 5; // Maximum reconnection attempts before giving up
const RECONNECT_DELAY = 2000;    // Base delay between reconnection attempts (ms)
const MAX_QUEUE_SIZE = 10000;     // Prevent memory overflow

self.onmessage = function(e) {
    if (e.data.command === 'connect') {
        const url = e.data.url;
        connectToSSE(url);
    } else if (e.data.command === 'disconnect') {
        gracefulShutdown();
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
                // Queue size protection
                if (packetQueue.length >= MAX_QUEUE_SIZE) {
                    self.postMessage({ 
                        type: 'log', 
                        msg: `⚠️ Worker: Queue overflow, dropping packet. Queue size: ${packetQueue.length}` 
                    });
                    return;
                }

                // Add raw base64 to queue
                packetQueue.push(event.data);

                // Reset reconnect counter on successful data
                reconnectAttempts = 0;

                // Reset the safety flush timer
                clearTimeout(flushTimeout);

                if (packetQueue.length >= BATCH_SIZE) {
                    // Batch is full, process immediately
                    processBatch();
                } else {
                    // Batch not full yet, set a timer to flush it anyway if no more come
                    flushTimeout = setTimeout(() => {
                        if (packetQueue.length > 0) {
                            processBatch();
                        }
                    }, FLUSH_INTERVAL);
                }
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
                msg: "🔌 Worker: SSE Connected (Batching + Auto-Flush Active)" 
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
    const delay = RECONNECT_DELAY * reconnectAttempts; // Exponential backoff

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

    // Process remaining packets
    if (packetQueue.length > 0) {
        self.postMessage({ 
            type: 'log', 
            msg: `🛑 Worker: Processing ${packetQueue.length} remaining packets before shutdown...` 
        });
        processBatch();
    }

    // Clear timers
    if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
    }

    // Close connection
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }

    // Reset state
    leftoverByte = null;
    packetQueue = [];
    reconnectAttempts = 0;

    self.postMessage({ type: 'log', msg: "✅ Worker: Graceful shutdown complete" });
}

/**
 * Converts a batch of Base64 packets into a single Float32Array 
 * and transfers it to the main thread.
 */
function processBatch() {
    try {
        if (packetQueue.length === 0) return;

        // 1. Decode all base64 strings in the queue into a single byte array
        let totalLength = 0;
        const decodedPackets = packetQueue.map(b64 => {
            if (!b64 || typeof b64 !== 'string') {
                throw new Error('Invalid base64 data received');
            }
            const binary = atob(b64);
            totalLength += binary.length;
            return binary;
        });

        let bytes = new Uint8Array(totalLength);
        let offset = 0;
        for (const binary of decodedPackets) {
            for (let i = 0; i < binary.length; i++) {
                bytes[offset++] = binary.charCodeAt(i);
            }
        }

        // Clear the queue for the next batch
        const processedCount = packetQueue.length;
        packetQueue = [];

        // 2. PCM Stitching (16-bit / 2-byte alignment)
        let finalBytes = bytes;
        if (leftoverByte !== null) {
            let stitched = new Uint8Array(bytes.length + 1);
            stitched[0] = leftoverByte;
            stitched.set(bytes, 1);
            finalBytes = stitched;
            leftoverByte = null;
        }

        if (finalBytes.length % 2 !== 0) {
            leftoverByte = finalBytes[finalBytes.length - 1];
            finalBytes = finalBytes.slice(0, -1);
        }

        // 3. Float32 Conversion
        const float32 = new Float32Array(finalBytes.length / 2);
        const view = new DataView(finalBytes.buffer);
        for (let i = 0; i < float32.length; i++) {
            // Int16 to Float32 [-1.0, 1.0]
            float32[i] = view.getInt16(i * 2, true) / 32768.0;
        }

        // 4. Zero-copy transfer to Main Thread
        self.postMessage({ 
            type: 'data', 
            buffer: float32.buffer,
            packetCount: processedCount,
            sampleCount: float32.length
        }, [float32.buffer]);

    } catch (err) {
        self.postMessage({ 
            type: 'error', 
            msg: `❌ Worker Error in processBatch: ${err.message}` 
        });
        
        // Clear queue on error to prevent corruption propagation
        packetQueue = [];
        leftoverByte = null;
    }
}