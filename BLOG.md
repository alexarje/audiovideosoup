# Simmering Media Into Soup: A Browser Instrument for Visual and Spectral Drift

There is a particular pleasure in watching something familiar dissolve. Long-exposure photography turns motion into ghostly trails. Reverb smears a dry sound into space. **AudioVideoSoup** does something similar, but in real time, in the browser, and on both image and sound at once.

Load a video. Press play. The picture begins to smear into a running average of everything it has seen. The audio blurs into an ambient wash built from its own spectrum. You are not editing a file. You are playing an instrument whose input is whatever media you feed it.

Try it here: [alexarje.github.io/audiovideosoup](https://alexarje.github.io/audiovideosoup/)

---

## The idea

Most video players show you the present moment and discard the past. Most audio players aim for transparency — faithful reproduction, minimal coloration.

This instrument takes the opposite approach. It *remembers*.

Visually, each new frame is folded into an accumulator — a kind of rolling memory of every pixel that has passed through. Aurally, the signal is analyzed into frequency bins, and those magnitudes are smoothed over time while the phase is allowed to wander. The result is resynthesized and mixed back with the dry source.

The metaphor is soup: ingredients (frames, spectral snapshots) simmer together until the original sharpness softens into something new.

---

## What you see

The main canvas shows a single blended image — not a side-by-side comparison of source and effect, but the soup itself.

Under the hood, every frame's RGB values are written into a floating-point buffer using exponential smoothing:

```
accum = accum × decay + frame × (1 − decay)
```

Higher **frame memory** means a slower fade. The image holds onto the past longer. Motion becomes trails. Faces blur into impressions. A busy scene turns painterly.

**Soup blend** controls how much of that accumulated image you see versus the current live frame. At 0%, you get the raw video. At 100%, pure average — which starts dark and slowly builds, since the accumulator begins empty. The default sits in between, so you always see something immediate *and* something accumulated.

Hit **Reset soup** and the visual memory clears. The image snaps back toward the present.

---

## What you hear

The audio path runs in an `AudioWorklet` — a separate real-time thread in the Web Audio API, isolated from the main UI so processing stays smooth.

The processor performs a short-time Fourier transform (STFT) on incoming audio:

- **FFT size:** 2048 samples
- **Hop size:** 512 samples
- **Window:** Hann

Each frequency bin's magnitude is exponentially smoothed, similar in spirit to the visual accumulator. Phase is smoothed too, with a small random drift added — enough to keep the resynthesis from sounding frozen or metallic.

The smoothed spectrum is converted back to the time domain via inverse FFT and overlap-add reconstruction. That "spectral soup" is mixed with the dry signal. A live spectrum display at the bottom of the interface shows what the processor is doing, log-scaled so you can read the frequency content at a glance.

The controls map cleanly to texture:

| Control | Effect |
| --- | --- |
| **Spectral smooth** | How quickly the frequency content adapts |
| **Phase smooth** | How stable the phase information feels |
| **Phase drift** | Random wander — more ambient, less static |
| **Soup mix** | Dry source vs. processed wash |
| **Output gain** | Final level |

Push spectral smooth high and phase drift low for a warm, blurred pad. Lower the soup mix to keep rhythmic material recognizable underneath the haze.

---

## Playing it

There is no timeline editor and no export button — at least not yet. The workflow is deliberately simple:

1. **Load media** — any video or audio file from your machine
2. **Play** — processing begins immediately
3. **Tweak** — all sliders are live; changes apply while the file runs
4. **Reset** — clear accumulated state and start simmering again

Because everything runs client-side, your files never leave the browser. The whole app is static HTML, CSS, and JavaScript — no server, no build step, no dependencies. Clone the repo, serve the `app/` folder over HTTP, and it works locally too.

---

## Why build it this way?

A few constraints shaped the design:

**Browser-native.** No plugins, no native app. If you have a modern browser with Web Audio and Canvas, you have the instrument.

**Real-time.** The visual averaging runs on `requestAnimationFrame`, synced to playback. The audio worklet runs on its own clock. Both respond to slider changes instantly.

**Dual soup.** Image and sound are processed with parallel logic — exponential memory on pixels, exponential memory on magnitudes — but they are independent. You can smear the picture heavily while keeping the audio relatively dry, or vice versa.

**One frame, one mix.** Early versions showed source and soup side by side. The current design puts everything into a single canvas with a blend control. You perform the mix rather than compare it.

---

## What it is good for

AudioVideoSoup is not a production tool in the conventional sense. It is closer to:

- A **visual instrument** for performance and installation work
- A **listening tool** for hearing familiar material as texture
- A **sketchpad** for thinking about memory, decay, and accumulation in media

Feed it footage of water, traffic, a conversation, a music video, a field recording. Each source behaves differently because the instrument is reactive — it does not apply a preset effect so much as *continue* whatever you give it.

The interesting moments tend to arrive after thirty seconds or a minute, when the accumulator has had time to build something the original footage could not show on its own.

---

## Under the hood

The project is small and readable:

```
app/
  index.html
  css/style.css
  js/app.js                      — video averaging, UI, audio graph
  js/spectral-soup-processor.js  — AudioWorklet STFT processor
```

Video frames are captured on an offscreen canvas so the source never needs its own panel. The hidden `<video>` element handles playback and feeds both the visual and audio paths.

The spectral processor implements its own in-place FFT — no external audio library. Spectrum data is posted back to the main thread for visualization.

It is open source under GPL-3.0: [github.com/alexarje/audiovideosoup](https://github.com/alexarje/audiovideosoup)

---

## Try it

Open [alexarje.github.io/audiovideosoup](https://alexarje.github.io/audiovideosoup/), load something you have lying around, and let it simmer.

Start with the defaults. Then push frame memory up and soup blend toward the average. Listen while you watch — the image and the sound are remembering different things about the same moment, and that gap is where the instrument lives.
