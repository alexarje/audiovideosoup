/* eslint-disable no-undef */
/**
 * Real-time spectral averaging — smooths the magnitude spectrum over time and
 * resynthesizes with the source phase so timbre stays faithful to the input.
 */

const FFT_SIZE = 2048;
const HOP_SIZE = 512;
const BIN_COUNT = FFT_SIZE / 2 + 1;
const MAG_BLUR_RADIUS = 2;
const NOISE_GATE_FLOOR = 0.02;

class ComplexBuffer {
  constructor(size) {
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
  }
}

function createHannWindow(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

function fftInPlace(re, im) {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i += 1) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const evenRe = re[i + k];
        const evenIm = im[i + k];
        const oddRe = re[i + k + len / 2] * wRe - im[i + k + len / 2] * wIm;
        const oddIm = re[i + k + len / 2] * wIm + im[i + k + len / 2] * wRe;
        re[i + k] = evenRe + oddRe;
        im[i + k] = evenIm + oddIm;
        re[i + k + len / 2] = evenRe - oddRe;
        im[i + k + len / 2] = evenIm - oddIm;
        const nextWRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextWRe;
      }
    }
  }
}

function conjugate(im, size) {
  for (let i = 0; i < size; i += 1) im[i] = -im[i];
}

function blurMagnitudes(mags, scratch, radius) {
  for (let k = 0; k < mags.length; k += 1) {
    let sum = 0;
    let count = 0;
    for (let d = -radius; d <= radius; d += 1) {
      const idx = k + d;
      if (idx < 0 || idx >= mags.length) continue;
      sum += mags[idx];
      count += 1;
    }
    scratch[k] = sum / count;
  }
  mags.set(scratch);
}

class SpectralSoupProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.window = createHannWindow(FFT_SIZE);
    this.inputBuffer = new Float32Array(FFT_SIZE);
    this.writePos = 0;
    this.hopCounter = 0;
    this.outputQueue = new Float32Array(HOP_SIZE);
    this.outputReadPos = 0;
    this.outputWritePos = 0;
    this.olaBuffer = new Float32Array(FFT_SIZE);
    this.olaNorm = new Float32Array(FFT_SIZE);

    this.specRe = new Float32Array(BIN_COUNT);
    this.specIm = new Float32Array(BIN_COUNT);
    this.magAvg = new Float32Array(BIN_COUNT);
    this.magScratch = new Float32Array(BIN_COUNT);
    this.hasSpectrum = false;

    this.frame = new ComplexBuffer(FFT_SIZE);
    this.synth = new ComplexBuffer(FFT_SIZE);

    this.spectralSmooth = 0.992;
    this.mix = 0.78;
    this.gain = 0.92;

    this.port.onmessage = (event) => {
      const { type, value } = event.data;
      if (type === "spectralSmooth") this.spectralSmooth = value;
      if (type === "mix") this.mix = value;
      if (type === "gain") this.gain = value;
      if (type === "reset") this.resetSoup();
    };
  }

  resetSoup() {
    this.specRe.fill(0);
    this.specIm.fill(0);
    this.magAvg.fill(0);
    this.hasSpectrum = false;
    this.olaBuffer.fill(0);
    this.olaNorm.fill(0);
    this.outputQueue.fill(0);
    this.outputReadPos = 0;
    this.outputWritePos = 0;
  }

  pushSample(sample) {
    this.inputBuffer[this.writePos] = sample;
    this.writePos = (this.writePos + 1) % FFT_SIZE;
    this.hopCounter += 1;
    if (this.hopCounter < HOP_SIZE) return false;
    this.hopCounter = 0;
    return true;
  }

  analyzeFrame() {
    const { re, im } = this.frame;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const sample = this.inputBuffer[(this.writePos + i) % FFT_SIZE];
      re[i] = sample * this.window[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    const smooth = this.spectralSmooth;
    const invSmooth = 1 - smooth;

    for (let k = 0; k < BIN_COUNT; k += 1) {
      if (!this.hasSpectrum) {
        this.specRe[k] = re[k];
        this.specIm[k] = im[k];
      } else {
        this.specRe[k] = smooth * this.specRe[k] + invSmooth * re[k];
        this.specIm[k] = smooth * this.specIm[k] + invSmooth * im[k];
      }

      this.magAvg[k] = Math.hypot(this.specRe[k], this.specIm[k]);
    }

    blurMagnitudes(this.magAvg, this.magScratch, MAG_BLUR_RADIUS);
    this.hasSpectrum = true;
  }

  synthesizeHop() {
    const { re, im } = this.synth;
    re.fill(0);
    im.fill(0);

    let maxMag = 0;
    for (let k = 0; k < BIN_COUNT; k += 1) {
      if (this.magAvg[k] > maxMag) maxMag = this.magAvg[k];
    }
    const gate = maxMag * NOISE_GATE_FLOOR;

    for (let k = 0; k < BIN_COUNT; k += 1) {
      const mag = this.magAvg[k];
      if (mag < gate) continue;

      const prevMag = Math.hypot(this.specRe[k], this.specIm[k]) || 1e-12;
      const scale = mag / prevMag;
      re[k] = this.specRe[k] * scale;
      im[k] = this.specIm[k] * scale;
    }

    for (let k = 1; k < FFT_SIZE / 2; k += 1) {
      re[FFT_SIZE - k] = re[k];
      im[FFT_SIZE - k] = -im[k];
    }

    conjugate(im, FFT_SIZE);
    fftInPlace(re, im);
    conjugate(im, FFT_SIZE);

    const scale = 1 / FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const sample = re[i] * scale * this.window[i];
      this.olaBuffer[i] += sample;
      this.olaNorm[i] += this.window[i] * this.window[i];
    }

    for (let i = 0; i < HOP_SIZE; i += 1) {
      const norm = this.olaNorm[i] > 1e-6 ? this.olaNorm[i] : 1;
      const idx = (this.outputWritePos + i) % this.outputQueue.length;
      this.outputQueue[idx] = this.olaBuffer[i] / norm;
      this.olaBuffer[i] = this.olaBuffer[i + HOP_SIZE];
      this.olaNorm[i] = this.olaNorm[i + HOP_SIZE];
    }
    for (let i = HOP_SIZE; i < FFT_SIZE; i += 1) {
      this.olaBuffer[i] = 0;
      this.olaNorm[i] = 0;
    }
    this.outputWritePos = (this.outputWritePos + HOP_SIZE) % this.outputQueue.length;
  }

  readWetSample() {
    const sample = this.outputQueue[this.outputReadPos];
    this.outputQueue[this.outputReadPos] = 0;
    this.outputReadPos = (this.outputReadPos + 1) % this.outputQueue.length;
    return sample;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const inCh = input[0];
    const outCh = output[0];
    const wetMix = this.mix;
    const dryMix = 1 - wetMix;

    for (let i = 0; i < inCh.length; i += 1) {
      const dry = inCh[i];
      if (this.pushSample(dry)) {
        this.analyzeFrame();
        this.synthesizeHop();
      }

      const wet = this.readWetSample();
      outCh[i] = (dry * dryMix + wet * wetMix) * this.gain;
    }

    for (let ch = 1; ch < output.length; ch += 1) {
      output[ch].set(outCh);
    }

    if (this.hasSpectrum && currentFrame % 6 === 0) {
      this.port.postMessage({
        type: "spectrum",
        magnitudes: Array.from(this.magAvg),
      });
    }

    return true;
  }
}

registerProcessor("spectral-soup-processor", SpectralSoupProcessor);
