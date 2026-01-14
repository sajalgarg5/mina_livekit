/**
 * decoder_worker.js
 * * Features:
 * 1. SSE Connection handling in background thread.
 * 2. Batching: Collects packets to reduce CPU context-switching overhead.
 * 3. Safety Flush: Ensures small batches are processed if no new data arrives.
 * 4. Zero-copy transfer: Uses Transferable objects for maximum speed.
 */

let leftoverByte = null;
let packetQueue = [];
let flushTimeout = null;

// CONFIGURATION
const BATCH_SIZE = 15;      // Number of packets to group together
const FLUSH_INTERVAL = 20; // Milliseconds to wait before forcing a process of partial batches

self.onmessage = function(e) {
    if (e.data.command === 'connect') {
        const url = e.data.url;
        const ev = new EventSource(url);

        ev.addEventListener("audio", (event) => {
            // Add raw base64 to queue
            packetQueue.push(event.data);

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
        });

        ev.onopen = () => self.postMessage({ type: 'log', msg: "🔌 Worker: SSE Connected (Batching + Auto-Flush Active)" });
        ev.onerror = () => self.postMessage({ type: 'log', msg: "📡 Worker: SSE Connection Lost. Retrying..." });
    }
};

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
        // The second argument [float32.buffer] "transfers" ownership of the memory 
        // so the worker doesn't have to copy the data.
        self.postMessage({ 
            type: 'data', 
            buffer: float32.buffer 
        }, [float32.buffer]);

    } catch (err) {
        self.postMessage({ type: 'log', msg: "❌ Worker Error: " + err.message });
    }
}