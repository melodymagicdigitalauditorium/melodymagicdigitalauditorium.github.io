
const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10]
};

function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

function midiToHz(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function nearestScaleNote(note, root, scale) {
  const intervals = SCALE_INTERVALS[scale] || SCALE_INTERVALS.major;
  let best = Math.round(note);
  let distance = Infinity;

  for (let octave = Math.floor(note / 12) - 1;
       octave <= Math.floor(note / 12) + 1;
       octave++) {
    for (const interval of intervals) {
      const candidate = octave * 12 + root + interval;
      const d = Math.abs(candidate - note);
      if (d < distance) {
        distance = d;
        best = candidate;
      }
    }
  }
  return best;
}

class MelodyPitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.key = 0;
    this.scale = "major";
    this.enabled = true;
    this.strength = 1;
    this.speed = 0.035;

    this.buffer = new Float32Array(4096);
    this.writePosition = 0;
    this.phaseA = 0;
    this.phaseB = 0.5;
    this.grainSize = 256;

    this.analysis = new Float32Array(1024);
    this.analysisPosition = 0;
    this.currentRatio = 1;
    this.targetRatio = 1;
    this.lastNote = -1;

    this.port.onmessage = event => {
      const data = event.data || {};
      if (Number.isInteger(data.key)) this.key = data.key;
      if (data.scale) this.scale = data.scale;
      if (typeof data.enabled === "boolean") this.enabled = data.enabled;
      if (typeof data.strength === "number") {
        this.strength = Math.max(0, Math.min(1, data.strength));
      }
      if (typeof data.speed === "number") {
        this.speed = Math.max(0.001, data.speed);
      }
    };
  }

  detectPitch() {
    const size = this.analysis.length;
    const half = size >> 1;
    const data = this.analysis;

    let bestLag = -1;
    let bestDifference = Infinity;

    for (let lag = 20; lag < half; lag++) {
      let difference = 0;
      for (let i = 0; i < half; i += 2) {
        const delta = data[i] - data[i + lag];
        difference += delta * delta;
      }
      if (difference < bestDifference) {
        bestDifference = difference;
        bestLag = lag;
      }
    }

    if (bestLag < 1) return null;

    const hz = sampleRate / bestLag;
    if (hz < 75 || hz > 1000) return null;

    return hzToMidi(hz);
  }

  readDelayed(delay) {
    const length = this.buffer.length;
    let position = (this.writePosition - delay + length) % length;
    const a = Math.floor(position);
    const b = (a + 1) % length;
    const fraction = position - a;
    return this.buffer[a] * (1 - fraction) +
           this.buffer[b] * fraction;
  }

  grain(phase) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
    return this.readDelayed(2 + phase * this.grainSize) * window;
  }

  shift(sample, ratio) {
    this.buffer[this.writePosition] = sample;
    this.writePosition = (this.writePosition + 1) % this.buffer.length;

    const increment = (1 - ratio) / this.grainSize;
    this.phaseA = (this.phaseA + increment + 1) % 1;
    this.phaseB = (this.phaseB + increment + 1) % 1;

    return this.grain(this.phaseA) + this.grain(this.phaseB);
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (!input || !output) return true;

    for (let i = 0; i < input.length; i++) {
      const sample = input[i];

      this.analysis[this.analysisPosition++] = sample;

      if (this.analysisPosition >= this.analysis.length) {
        this.analysisPosition = 0;

        const detected = this.detectPitch();

        if (detected !== null) {
          const target = nearestScaleNote(
            detected,
            this.key,
            this.scale
          );

          const corrected = detected +
            (target - detected) * this.strength;

          this.targetRatio = midiToHz(corrected) /
                             midiToHz(detected);

          this.lastNote = Math.round(detected);
        } else {
          this.targetRatio = 1;
        }
      }

      this.currentRatio +=
        (this.targetRatio - this.currentRatio) * this.speed;

      output[i] = this.enabled
        ? this.shift(sample, this.currentRatio)
        : sample;
    }

    return true;
  }
}

registerProcessor("melody-pitch-processor", MelodyPitchProcessor);
