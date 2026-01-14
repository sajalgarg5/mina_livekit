// decoder_worker.js
self.onmessage = function(e) {
    const base64 = e.data;
    try {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        // Send the raw bytes back to the main thread
        // We use "Transferables" to move this data with ZERO copy overhead
        self.postMessage(bytes.buffer, [bytes.buffer]);
    } catch (err) {
        // Silent catch for malformed packets
    }
};