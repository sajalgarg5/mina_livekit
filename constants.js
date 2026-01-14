const octave8Frequencies = [4186.01, 4434.92, 4698.63, 4978.03, 5274.04, 5587.65, 5919.91, 6271.93, 6644.88, 7040.0, 7458.62, 7902.13];
const octave8Labels = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const noteFrequencies = [];
export const noteFrequencyLabels = [];
for (let i = 1; i <= 8; i++) {
  for (let f = 0; f < octave8Frequencies.length; f++) {
    noteFrequencies.push(octave8Frequencies[f] / Math.pow(2, 8 - i));
    noteFrequencyLabels.push(octave8Labels[f] + i);
  }
}

export const voiceFrequencies = noteFrequencies.filter(f => f > 32.0 && f < 2000.0);
export const voiceFrequencyLabels = noteFrequencyLabels.filter((_, i) => noteFrequencies[i] > 32.0 && noteFrequencies[i] < 2000.0);