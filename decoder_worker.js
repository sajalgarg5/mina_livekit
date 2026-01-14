// decoder_worker.js
let leftoverByte = null;

self.onmessage = function(e) {
    if (e.data.command === 'connect') {
        const url = e.data.url;
        const ev = new EventSource(url);

        ev.addEventListener("audio", (event) => {
            processAudio(event.data);
        });

        ev.onopen = () => self.postMessage({ type: 'log', msg: "🔌 Worker: SSE Connected" });
        ev.onerror = () => self.postMessage({ type: 'log', msg: "📡 Worker: SSE Error, Retrying..." });
    }
};

function processAudio(base64) {
    try {
        // 1. Decode Base64
        const binary = atob(base64);
        let bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        // 2. PCM Stitching for 16-bit alignment
        if (leftoverByte !== null) {
            let stitched = new Uint8Array(bytes.length + 1);
            stitched[0] = leftoverByte;
            stitched.set(bytes, 1);
            bytes = stitched;
            leftoverByte = null;
        }
        if (bytes.length % 2 !== 0) {
            leftoverByte = bytes[bytes.length - 1];
            bytes = bytes.slice(0, -1);
        }

        // 3. Float32 Conversion
        const float32 = new Float32Array(bytes.length / 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < float32.length; i++) {
            float32[i] = view.getInt16(i * 2, true) / 32768;
        }

        // 4. Send to Main Thread using Transferable (No-copy)
        self.postMessage({ type: 'data', buffer: float32.buffer }, [float32.buffer]);
        
    } catch (err) {
        self.postMessage({ type: 'log', msg: "❌ Worker Process Error: " + err.message });
    }
}