/**
 * AudioVideoSoup — visual frame averaging + spectral audio soup.
 */

import {
  assertCanvasAccess,
  fetchMediaBlob,
  resolveMediaUrl,
} from "./media-url.js";

const state = {
  video: null,
  audioContext: null,
  sourceNode: null,
  soupNode: null,
  analyser: null,
  fileUrl: null,
  loading: false,
  playing: false,
  rafId: null,
  accum: null,
  accumWidth: 0,
  accumHeight: 0,
  frameBuffer: null,
  frameCanvas: null,
  visualDecay: 0.985,
  visualMix: 0.75,
  spectralSmooth: 0.965,
  phaseSmooth: 0.92,
  phaseDrift: 0.0008,
  audioMix: 0.55,
  audioGain: 1.1,
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function bindElements() {
  els.fileInput = $("file-input");
  els.loadBtn = $("load-btn");
  els.urlInput = $("url-input");
  els.urlLoadBtn = $("url-load-btn");
  els.playBtn = $("play-btn");
  els.resetBtn = $("reset-btn");
  els.video = $("source-video");
  els.soupCanvas = $("soup-canvas");
  els.spectrumCanvas = $("spectrum-canvas");
  els.timeLabel = $("time-label");
  els.statusLabel = $("status-label");
  els.visualDecay = $("visual-decay");
  els.visualMix = $("visual-mix");
  els.spectralSmooth = $("spectral-smooth");
  els.phaseSmooth = $("phase-smooth");
  els.phaseDrift = $("phase-drift");
  els.audioMix = $("audio-mix");
  els.audioGain = $("audio-gain");
  els.visualDecayVal = $("visual-decay-val");
  els.visualMixVal = $("visual-mix-val");
  els.spectralSmoothVal = $("spectral-smooth-val");
  els.phaseSmoothVal = $("phase-smooth-val");
  els.phaseDriftVal = $("phase-drift-val");
  els.audioMixVal = $("audio-mix-val");
  els.audioGainVal = $("audio-gain-val");
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function setStatus(text) {
  els.statusLabel.textContent = text;
}

function updateSliderLabels() {
  els.visualDecayVal.textContent = `${Math.round(state.visualDecay * 1000) / 10}%`;
  els.visualMixVal.textContent = `${Math.round(state.visualMix * 100)}%`;
  els.spectralSmoothVal.textContent = `${Math.round(state.spectralSmooth * 1000) / 10}%`;
  els.phaseSmoothVal.textContent = `${Math.round(state.phaseSmooth * 1000) / 10}%`;
  els.phaseDriftVal.textContent = state.phaseDrift.toFixed(4);
  els.audioMixVal.textContent = `${Math.round(state.audioMix * 100)}%`;
  els.audioGainVal.textContent = state.audioGain.toFixed(2);
}

function postSoupParam(type, value) {
  if (state.soupNode) {
    state.soupNode.port.postMessage({ type, value });
  }
}

function resetVisualSoup() {
  state.accum = null;
  state.frameBuffer = null;
  const ctx = els.soupCanvas.getContext("2d");
  ctx.fillStyle = "#0d0d0d";
  ctx.fillRect(0, 0, els.soupCanvas.width, els.soupCanvas.height);
}

function resetAudioSoup() {
  postSoupParam("reset");
  drawSpectrum(new Float32Array(128));
}

function resizeSoupCanvas(width, height) {
  els.soupCanvas.width = width;
  els.soupCanvas.height = height;
  if (!state.frameCanvas) {
    state.frameCanvas = document.createElement("canvas");
  }
  state.frameCanvas.width = width;
  state.frameCanvas.height = height;
  resetVisualSoup();
}

function ensureAccum(width, height) {
  if (state.accum && state.accumWidth === width && state.accumHeight === height) {
    return;
  }
  state.accumWidth = width;
  state.accumHeight = height;
  state.accum = new Float32Array(width * height * 3);
  state.frameBuffer = new Uint8ClampedArray(width * height * 4);
}

function blendFrame(sourceCtx, width, height) {
  ensureAccum(width, height);
  const image = sourceCtx.getImageData(0, 0, width, height);
  const data = image.data;
  const decay = state.visualDecay;
  const blend = 1 - decay;
  const accum = state.accum;
  const out = state.frameBuffer;

  for (let i = 0, px = 0; i < data.length; i += 4, px += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    accum[px] = accum[px] * decay + r * blend;
    accum[px + 1] = accum[px + 1] * decay + g * blend;
    accum[px + 2] = accum[px + 2] * decay + b * blend;
  }

  const mix = state.visualMix;
  const invMix = 1 - mix;
  for (let i = 0, px = 0; i < data.length; i += 4, px += 3) {
    out[i] = accum[px] * mix + data[i] * invMix;
    out[i + 1] = accum[px + 1] * mix + data[i + 1] * invMix;
    out[i + 2] = accum[px + 2] * mix + data[i + 2] * invMix;
    out[i + 3] = 255;
  }

  const soupCtx = els.soupCanvas.getContext("2d");
  soupCtx.putImageData(new ImageData(out, width, height), 0, 0);
}

function drawSoupFrame() {
  const video = els.video;
  if (!video.videoWidth) return;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (
    els.soupCanvas.width !== width
    || els.soupCanvas.height !== height
    || !state.frameCanvas
  ) {
    resizeSoupCanvas(width, height);
  }
  const frameCtx = state.frameCanvas.getContext("2d");
  frameCtx.drawImage(video, 0, 0, width, height);
  blendFrame(frameCtx, width, height);
}

function drawSpectrum(magnitudes) {
  const canvas = els.spectrumCanvas;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, w, h);

  const bins = magnitudes.length;
  const logBins = 96;
  const barW = w / logBins;

  for (let i = 0; i < logBins; i += 1) {
    const t0 = i / logBins;
    const t1 = (i + 1) / logBins;
    const b0 = Math.floor(Math.pow(t0, 2) * (bins - 1));
    const b1 = Math.max(b0 + 1, Math.floor(Math.pow(t1, 2) * (bins - 1)));
    let sum = 0;
    for (let b = b0; b < b1; b += 1) sum += magnitudes[b];
    const avg = sum / (b1 - b0);
    const db = 20 * Math.log10(avg + 1e-8);
    const norm = Math.max(0, Math.min(1, (db + 70) / 70));
    const barH = norm * (h - 8);
    const x = i * barW;
    ctx.fillStyle = `rgba(255, 106, 42, ${0.35 + norm * 0.65})`;
    ctx.fillRect(x + 1, h - barH - 4, barW - 2, barH);
  }
}

function animationLoop() {
  if (!state.playing) return;
  drawSoupFrame();
  els.timeLabel.textContent = `${formatTime(els.video.currentTime)} / ${formatTime(els.video.duration)}`;
  state.rafId = requestAnimationFrame(animationLoop);
}

async function ensureAudioGraph() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
    await state.audioContext.audioWorklet.addModule("js/spectral-soup-processor.js");
    state.soupNode = new AudioWorkletNode(state.audioContext, "spectral-soup-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    state.soupNode.port.onmessage = (event) => {
      if (event.data.type === "spectrum") {
        drawSpectrum(Float32Array.from(event.data.magnitudes));
      }
    };
    state.soupNode.connect(state.audioContext.destination);
  }

  if (state.sourceNode) {
    state.sourceNode.disconnect();
    state.sourceNode = null;
  }

  state.sourceNode = state.audioContext.createMediaElementSource(els.video);
  state.sourceNode.connect(state.soupNode);
}

function setLoading(loading) {
  state.loading = loading;
  els.loadBtn.disabled = loading;
  els.urlLoadBtn.disabled = loading;
  els.urlInput.disabled = loading;
}

function waitForVideoEvent(video, eventName) {
  return new Promise((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not load media"));
    };
    const cleanup = () => {
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(eventName, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function clearMediaSource() {
  if (state.playing) {
    els.video.pause();
    state.playing = false;
    cancelAnimationFrame(state.rafId);
    els.playBtn.textContent = "Play";
  }

  if (state.sourceNode) {
    state.sourceNode.disconnect();
    state.sourceNode = null;
  }

  if (state.fileUrl) {
    URL.revokeObjectURL(state.fileUrl);
    state.fileUrl = null;
  }

  els.video.removeAttribute("src");
  els.video.load();
}

async function prepareLoadedMedia(label) {
  const { videoWidth, videoHeight } = els.video;
  if (videoWidth && videoHeight) {
    resizeSoupCanvas(videoWidth, videoHeight);
  } else {
    resetVisualSoup();
  }

  resetAudioSoup();
  els.playBtn.disabled = false;
  els.resetBtn.disabled = false;
  setStatus(`Loaded ${label}`);
}

async function loadVideoSource(src, label, { ownsBlobUrl = false } = {}) {
  clearMediaSource();

  if (ownsBlobUrl) state.fileUrl = src;
  els.video.src = src;
  els.video.load();

  await waitForVideoEvent(els.video, "loadedmetadata");
  await prepareLoadedMedia(label);
}

async function loadFile(file) {
  if (!file) return;

  setLoading(true);
  try {
    const blobUrl = URL.createObjectURL(file);
    await loadVideoSource(blobUrl, file.name, { ownsBlobUrl: true });
  } catch (error) {
    setStatus(`Load error: ${error.message}`);
  } finally {
    setLoading(false);
  }
}

async function loadFromUrl(input) {
  setLoading(true);
  try {
    setStatus("Resolving URL…");
    const resolved = await resolveMediaUrl(input);
    const { streamUrl, title, isAudioOnly } = resolved;

    setStatus(`Loading ${title}…`);
    els.video.src = streamUrl;
    els.video.load();

    try {
      await waitForVideoEvent(els.video, "loadeddata");
      if (!isAudioOnly) assertCanvasAccess(els.video);
      await prepareLoadedMedia(title);
      return;
    } catch {
      // Stream may play but block canvas reads, or direct load may fail.
    }

    const blob = await fetchMediaBlob(streamUrl, setStatus);
    const blobUrl = URL.createObjectURL(blob);
    await loadVideoSource(blobUrl, title, { ownsBlobUrl: true });
  } catch (error) {
    setStatus(`URL error: ${error.message}`);
  } finally {
    setLoading(false);
  }
}

async function togglePlay() {
  if (!els.video.src) return;

  if (state.audioContext?.state === "suspended") {
    await state.audioContext.resume();
  }

  if (!state.sourceNode) {
    try {
      await ensureAudioGraph();
      syncAudioParams();
    } catch (error) {
      setStatus(`Audio error: ${error.message}`);
      return;
    }
  }

  if (state.playing) {
    els.video.pause();
    state.playing = false;
    cancelAnimationFrame(state.rafId);
    els.playBtn.textContent = "Play";
    setStatus("Paused");
    return;
  }

  try {
    await els.video.play();
    state.playing = true;
    els.playBtn.textContent = "Pause";
    setStatus("Simmering…");
    animationLoop();
  } catch (error) {
    setStatus(`Playback error: ${error.message}`);
  }
}

function syncAudioParams() {
  postSoupParam("spectralSmooth", state.spectralSmooth);
  postSoupParam("phaseSmooth", state.phaseSmooth);
  postSoupParam("phaseDrift", state.phaseDrift);
  postSoupParam("mix", state.audioMix);
  postSoupParam("gain", state.audioGain);
}

function bindControls() {
  els.loadBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files?.[0];
    if (file) loadFile(file);
    els.fileInput.value = "";
  });

  els.urlLoadBtn.addEventListener("click", () => {
    const url = els.urlInput.value.trim();
    if (url) loadFromUrl(url);
  });

  els.urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const url = els.urlInput.value.trim();
      if (url) loadFromUrl(url);
    }
  });

  els.playBtn.addEventListener("click", togglePlay);
  els.resetBtn.addEventListener("click", () => {
    resetVisualSoup();
    resetAudioSoup();
    setStatus("Soup reset");
  });

  const sliders = [
    ["visualDecay", "visual-decay", (v) => { state.visualDecay = v; }],
    ["visualMix", "visual-mix", (v) => { state.visualMix = v; }],
    ["spectralSmooth", "spectral-smooth", (v) => { state.spectralSmooth = v; postSoupParam("spectralSmooth", v); }],
    ["phaseSmooth", "phase-smooth", (v) => { state.phaseSmooth = v; postSoupParam("phaseSmooth", v); }],
    ["phaseDrift", "phase-drift", (v) => { state.phaseDrift = v; postSoupParam("phaseDrift", v); }],
    ["audioMix", "audio-mix", (v) => { state.audioMix = v; postSoupParam("mix", v); }],
    ["audioGain", "audio-gain", (v) => { state.audioGain = v; postSoupParam("gain", v); }],
  ];

  for (const [key, id, setter] of sliders) {
    const input = $(id);
    input.addEventListener("input", () => {
      const value = Number(input.value);
      setter(value);
      updateSliderLabels();
    });
  }

  els.video.addEventListener("loadeddata", () => {
    drawSoupFrame();
  });

  els.video.addEventListener("ended", () => {
    state.playing = false;
    cancelAnimationFrame(state.rafId);
    els.playBtn.textContent = "Play";
    setStatus("Finished");
  });

  els.video.addEventListener("seeked", () => {
    if (!state.playing) drawSoupFrame();
  });
}

function initSpectrumCanvas() {
  const canvas = els.spectrumCanvas;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  drawSpectrum(new Float32Array(128));
}

function init() {
  bindElements();
  bindControls();
  updateSliderLabels();
  initSpectrumCanvas();
  setStatus("Load a video file or paste a URL to begin");
}

init();
