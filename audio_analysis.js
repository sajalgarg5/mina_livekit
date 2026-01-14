import { voiceFrequencies, voiceFrequencyLabels, noteFrequencies, noteFrequencyLabels } from './constants.js';

export class AudioAnalysis {
  static getFrequencies(analyser, sampleRate, fftResult, analysisType = 'frequency', minDecibels = -100, maxDecibels = -30) {
    if (!fftResult) {
      fftResult = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(fftResult);
    }
    const nyquist = sampleRate / 2;
    const step = (1 / fftResult.length) * nyquist;
    let outputValues, frequencies, labels;

    if (analysisType === 'voice') {
      const useFreqs = voiceFrequencies;
      const aggregate = Array(useFreqs.length).fill(minDecibels);
      for (let i = 0; i < fftResult.length; i++) {
        const freq = i * step;
        for (let n = useFreqs.length - 1; n >= 0; n--) {
          if (freq > useFreqs[n]) {
            aggregate[n] = Math.max(aggregate[n], fftResult[i]);
            break;
          }
        }
      }
      outputValues = aggregate;
      frequencies = voiceFrequencies;
      labels = voiceFrequencyLabels;
    } else {
      outputValues = Array.from(fftResult);
      frequencies = outputValues.map((_, i) => step * i);
      labels = frequencies.map(f => `${f.toFixed(2)} Hz`);
    }

    const values = new Float32Array(outputValues.map(v => Math.max(0, Math.min((v - minDecibels) / (maxDecibels - minDecibels), 1))));
    return { values, frequencies, labels };
  }
}