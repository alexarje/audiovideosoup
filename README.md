# AudioVideoSoup

This is a browser app that turns an audio–video recording into a drifting "soup" by averaging video frames visually and smoothing the audio spectrum in real time.

Load a video file, hit play, and watch the image smear into a running average while the sound blurs into an ambient wash.

## Features

- **Visual soup** — exponentially smoothed running average of video frames, blended with the live source
- **Spectral soup** — real-time magnitude averaging with slowly evolving phase, resynthesized via an AudioWorklet
- **Live spectrum** — log-scaled frequency display of the processed audio
- **Tunable controls** — adjust decay, blend, smoothing, phase drift, mix, and output gain while playing

## Getting started

The app is static HTML/CSS/JS. Serve the `app/` directory over HTTP (required for ES modules and the audio worklet):

```bash
cd app
python3 -m http.server 8080
```

Then open [http://localhost:8080](http://localhost:8080) in a modern browser.

1. Click **Load media** and choose a video or audio file
2. Click **Play** to start visual and audio processing
3. Use **Reset soup** to clear accumulated visual and spectral state

## GitHub Pages

The site deploys automatically from the `app/` folder when changes are pushed to `main`.

**One-time repo setup:**

1. Open **Settings → Pages** in the GitHub repo
2. Under **Build and deployment**, set **Source** to **GitHub Actions**

After the first successful workflow run, the site is live at:

**https://alexarje.github.io/audiovideosoup/**

To deploy manually, run the **Deploy to GitHub Pages** workflow from the **Actions** tab.

## Controls

| Control | What it does |
| --- | --- |
| Frame memory | How long visual frames linger in the average (higher = slower fade) |
| Soup blend | Mix between the averaged image and the current frame |
| Spectral smooth | How quickly the magnitude spectrum adapts |
| Phase smooth | How quickly phase information changes |
| Phase drift | Random phase wander for a more ambient texture |
| Soup mix | Blend between dry source audio and spectral soup |
| Output gain | Final output level |

## How it works

**Video** — each frame's RGB values are blended into a floating-point accumulator. The canvas shows a mix of that accumulator and the current frame.

**Audio** — an `AudioWorkletProcessor` performs STFT analysis, exponentially smooths magnitude bins, applies smoothed and drifting phase, and overlap-add resynthesizes the signal back to the output.

## Project structure

```
.github/workflows/deploy.yml   GitHub Pages deployment
app/
  .nojekyll                    Skip Jekyll processing on Pages
  index.html                   UI
  css/style.css                Layout and theme
  js/app.js                    Video averaging, UI, audio graph
  js/spectral-soup-processor.js   AudioWorklet spectral processor
```

## Browser support

Requires a browser with Web Audio API, AudioWorklet, Canvas 2D, and ES modules (Chrome, Firefox, Safari, Edge — recent versions).

## License

[GNU General Public License v3.0](LICENSE)
