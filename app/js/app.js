/**
 * AudioVideoSoup — visual frame averaging + spectral audio soup.
 */

import {
  assertCanvasAccess,
  fetchMediaBlob,
  isDirectCdnUrl,
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
  visualStack: false,
  spectralSmooth: 0.992,
  audioMix: 0.78,
  audioGain: 0.92,
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
  els.visualStack = $("visual-stack");
  els.spectralSmooth = $("spectral-smooth");
  els.audioMix = $("audio-mix");
  els.audioGain = $("audio-gain");
  els.visualDecayVal = $("visual-decay-val");
  els.visualMixVal = $("visual-mix-val");
  els.visualStackVal = $("visual-stack-val");
  els.spectralSmoothVal = $("spectral-smooth-val");
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
  els.visualStackVal.textContent = state.visualStack ? "On" : "Off";
  els.spectralSmoothVal.textContent = `${Math.round(state.spectralSmooth * 1000) / 10}%`;
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

function normalizeStackAccum(accum) {
  let maxVal = 0;
  for (let i = 0; i < accum.length; i += 1) {
    if (accum[i] > maxVal) maxVal = accum[i];
  }
  if (maxVal <= 255) return;
  const scale = 255 / maxVal;
  for (let i = 0; i < accum.length; i += 1) {
    accum[i] *= scale;
  }
}

function blendFrame(sourceCtx, width, height) {
  ensureAccum(width, height);
  let image;
  try {
    image = sourceCtx.getImageData(0, 0, width, height);
  } catch {
    throw new Error("Cannot read video frames (cross-origin media)");
  }
  const data = image.data;
  const decay = state.visualDecay;
  const blend = 1 - decay;
  const accum = state.accum;
  const out = state.frameBuffer;

  for (let i = 0, px = 0; i < data.length; i += 4, px += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (state.visualStack) {
      accum[px] = accum[px] * decay + r;
      accum[px + 1] = accum[px + 1] * decay + g;
      accum[px + 2] = accum[px + 2] * decay + b;
    } else {
      accum[px] = accum[px] * decay + r * blend;
      accum[px + 1] = accum[px + 1] * decay + g * blend;
      accum[px + 2] = accum[px + 2] * decay + b * blend;
    }
  }

  if (state.visualStack) {
    normalizeStackAccum(accum);
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
  try {
    blendFrame(frameCtx, width, height);
  } catch (error) {
    setStatus(error.message);
  }
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

  if ("requestVideoFrameCallback" in els.video) {
    els.video.requestVideoFrameCallback(() => {
      if (!state.playing) return;
      drawSoupFrame();
      els.timeLabel.textContent = `${formatTime(els.video.currentTime)} / ${formatTime(els.video.duration)}`;
      animationLoop();
    });
    return;
  }

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

  if (!state.sourceNode) {
    state.sourceNode = state.audioContext.createMediaElementSource(els.video);
    state.sourceNode.connect(state.soupNode);
  }
}

function setLoading(loading) {
  state.loading = loading;
  els.loadBtn.disabled = loading;
  els.urlLoadBtn.disabled = loading;
  els.urlInput.disabled = loading;
}

const READY_STATE_FOR_EVENT = {
  loadedmetadata: HTMLMediaElement.HAVE_METADATA,
  loadeddata: HTMLMediaElement.HAVE_CURRENT_DATA,
  canplay: HTMLMediaElement.HAVE_FUTURE_DATA,
};

function waitForVideoEvent(video, eventName) {
  const needed = READY_STATE_FOR_EVENT[eventName] ?? 0;
  if (video.readyState >= needed) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      const code = video.error?.code;
      const message = code === 4
        ? "Media format not supported"
        : "Could not load media";
      reject(new Error(message));
    };
    const cleanup = () => {
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(eventName, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function replaceVideoElement() {
  const oldVideo = els.video;
  const video = document.createElement("video");
  video.id = oldVideo.id;
  video.playsInline = true;
  oldVideo.replaceWith(video);
  els.video = video;
  bindVideoEvents();
}

function resetAudioGraph() {
  if (state.sourceNode) {
    state.sourceNode.disconnect();
    state.sourceNode = null;
  }
}

function clearMediaSource() {
  if (state.playing) {
    els.video.pause();
    state.playing = false;
    cancelAnimationFrame(state.rafId);
    els.playBtn.textContent = "Play";
  }

  resetAudioGraph();

  if (state.fileUrl) {
    URL.revokeObjectURL(state.fileUrl);
    state.fileUrl = null;
  }

  els.video.removeAttribute("src");
  els.video.removeAttribute("crossorigin");
  els.video.load();
}

function configureVideoForSource({ remote = false } = {}) {
  if (remote) {
    els.video.crossOrigin = "anonymous";
  } else {
    els.video.removeAttribute("crossorigin");
  }
}

async function verifyVideoReady({ remote = false } = {}) {
  await waitForVideoEvent(els.video, "canplay");
  if (els.video.error) {
    throw new Error("Media format not supported");
  }
  if (remote && els.video.videoWidth) {
    assertCanvasAccess(els.video);
  }
}

async function prepareLoadedMedia(label) {
  const { videoWidth, videoHeight } = els.video;
  if (videoWidth && videoHeight) {
    resizeSoupCanvas(videoWidth, videoHeight);
    drawSoupFrame();
  } else {
    resetVisualSoup();
  }

  resetAudioSoup();
  els.playBtn.disabled = false;
  els.resetBtn.disabled = false;
  setStatus(`Loaded ${label}`);
}

async function assignVideoSource(src, { remote = false, ownsBlobUrl = false } = {}) {
  configureVideoForSource({ remote });
  if (ownsBlobUrl) state.fileUrl = src;
  els.video.src = src;
  els.video.load();
  await waitForVideoEvent(els.video, "loadedmetadata");
  await verifyVideoReady({ remote });
}

async function loadBlobMedia(blob, label, { resetVideo = false } = {}) {
  if (resetVideo) {
    clearMediaSource();
    replaceVideoElement();
  }
  const blobUrl = URL.createObjectURL(blob);
  await assignVideoSource(blobUrl, { remote: false, ownsBlobUrl: true });
  await prepareLoadedMedia(label);
}

async function loadFile(file) {
  if (!file) return;

  setLoading(true);
  try {
    clearMediaSource();
    replaceVideoElement();
    await loadBlobMedia(file, file.name);
  } catch (error) {
    setStatus(`Load error: ${error.message}`);
  } finally {
    setLoading(false);
  }
}

async function loadFromUrl(input) {
  setLoading(true);
  try {
    clearMediaSource();
    replaceVideoElement();
    setStatus("Resolving URL…");
    const resolved = await resolveMediaUrl(input);
    const { streamUrl, title, mimeType, isAudioOnly } = resolved;

    setStatus(`Loading ${title}…`);
    configureVideoForSource({ remote: true });

    if (!isDirectCdnUrl(streamUrl)) {
      els.video.src = streamUrl;
      els.video.load();

      try {
        await verifyVideoReady({ remote: true });
        await prepareLoadedMedia(title);
        if (isAudioOnly) setStatus(`Loaded ${title} (audio only — no video soup)`);
        return;
      } catch {
        // Direct stream failed — download and load as blob instead.
      }
    }

    replaceVideoElement();
    const blob = await fetchMediaBlob(streamUrl, mimeType, setStatus);
    await loadBlobMedia(blob, title);
  } catch (error) {
    setStatus(`URL error: ${error.message}`);
  } finally {
    setLoading(false);
  }
}

function bindVideoEvents() {
  els.video.addEventListener("loadeddata", () => {
    drawSoupFrame();
  });

  els.video.addEventListener("playing", () => {
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
    drawSoupFrame();
    animationLoop();
  } catch (error) {
    setStatus(`Playback error: ${error.message}`);
  }
}

function syncAudioParams() {
  postSoupParam("spectralSmooth", state.spectralSmooth);
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
  els.visualStack.addEventListener("change", () => {
    state.visualStack = els.visualStack.checked;
    updateSliderLabels();
    resetVisualSoup();
    drawSoupFrame();
  });
  els.resetBtn.addEventListener("click", () => {
    resetVisualSoup();
    resetAudioSoup();
    setStatus("Soup reset");
  });

  const sliders = [
    ["visualDecay", "visual-decay", (v) => { state.visualDecay = v; }],
    ["visualMix", "visual-mix", (v) => { state.visualMix = v; }],
    ["spectralSmooth", "spectral-smooth", (v) => { state.spectralSmooth = v; postSoupParam("spectralSmooth", v); }],
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
  bindVideoEvents();
  bindControls();
  updateSliderLabels();
  initSpectrumCanvas();
  setStatus("Load a video file or paste a URL to begin");
}

init();
