# Shot Clock

A camera espresso **shot quality report** that runs in the browser. Point a phone at the spouts and cup, press Arm, pull the shot, and you get:

1. **The shot time from the first drop** (not the pump), detected on its own, and how it compares with your target.
2. **How each spout's stream developed**: how long it stayed dark, when it turned caramel, how much of its lightening happened in the first 6 s, and how steadily it got paler. Shown as a colour ribbon per spout.
3. **Left vs. right balance**: whether the two spouts developed alike, which can point to uneven extraction.
4. **Plain-language notes**, e.g. "went light early, then stayed flat, which often means fast flow". The thresholds are provisional, based on 8 real clips.
5. **Your own notes** per shot (dose, yield, grind, taste), saved with the report in a local history you can tap back through.

Live during the shot it finds and follows the streams on its own (hand-held is fine, two spouts by default), shows the running time and the stream colours. **Alerts** (countdown pips, target tone, blonde alert, voice, vibration) are available but **off by default**.

Everything runs on the device with [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html) (WebAssembly). Nothing is uploaded and there is no server, so it can be published as a static site on GitHub Pages.

## Publish on GitHub Pages

The repo includes `.github/workflows/pages.yml`, which publishes only the app files (`index.html`, `style.css`, `js/`, `vendor/`).

1. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`, or open the **Actions** tab, choose **Deploy to GitHub Pages** and press **Run workflow**.
3. The app is then at `https://<user>.github.io/<repo>/`. Pages serves over HTTPS, which phones require before they allow camera access.

The first load downloads about 10 MB (OpenCV.js); after that the browser caches it.

## Run it locally

```bash
python3 serve.py              # http://localhost:8000 (camera works on this computer)
python3 serve.py --https      # https://<LAN-IP>:8443 for a phone on the same Wi-Fi (self-signed; accept the warning once)
```

## Using it

1. Press **Camera** (or **Video file** to replay a recording).
2. Frame the spouts and the cup, with the streams' path in view.
3. Press **Arm** *before* starting the pump, and hold roughly still for about a second while it learns the scene ("Learning scene…" → "Ready").
4. Pull the shot. The clock starts at the first liquid, counts down to your target, and alerts on blonding.
5. **Re-arm** before the next shot. **Stop** ends a shot by hand (useful if drips keep it going).

Settings: target time, blonde sensitivity (experimental), sound, spoken alerts, and whether to draw the detected streams. The *Vision* line under Settings shows processing speed on your device.

## How it works

`js/tracker.js` takes OpenCV.js as a parameter, so the same code runs in the browser and in Node (`tools/track.mjs`).

| Step | Method |
|---|---|
| Camera motion | KLT corners and optical flow, fitted with a RANSAC similarity transform to a reference frame taken at Arm. Drift-free, so hand shake is cancelled. |
| Candidates | A thin vertical line map in Lab, minus the reference's line map dilated by a few px. Edges that were there before the shot (chrome, cup rims) cancel even with parallax. |
| Liquid or not | A **flow score**: frame-to-frame change inside a candidate vs a ring around it. Falling coffee keeps changing; reflections on stainless only move with the camera. On real clips, streams scored 1.7–2.3 and artefacts 0.6–1.1. |
| Confidence, top N | Each track has a running **confidence score** (log-likelihood ratio, as in radar track scoring), built from several cues: flow (counted fully only while the camera is still), anchoring in scene coordinates, highlight-like pixels, missed frames, and registration quality. Only the **N most confident streams** (setting, default 2) are shown and used. They're chosen together, so streams that start at very different heights (e.g. a reflection low in the cup) don't pair up, and a challenger must clearly win for 0.5 s to take a slot. Weaker evidence may continue a chosen stream but never start one. |
| Shot start | A stream seen in about two-thirds of frames for 2 s confirms the shot. The clock is backdated to its first appearance. Thresholds are time-based, so slower phones behave the same. |
| Colour | Median Lab of each stream's core pixels. **Paleness = L\* − chroma.** |
| Blonding | A stream's paleness (1 s median) rising *Blonde sensitivity* points above its own baseline, held for 1 s. Compares each stream with itself, because absolute colour varies a lot between setups. |
| Hand-held drift | When the view zooms more than 4% or shifts more than 8% from the reference, it re-references (re-learns the scene before the shot; mid-shot, it masks the tracked streams out of the new reference). |
| End | No live stream for 3 s, or **Stop**. Flow ≥ 1.4 establishes a stream; ≥ 1.1 keeps it live. |

Speed: about 27 ms/frame in Node and 31–35 ms/frame in headless Chromium on a server CPU. Phones vary.

## Headless runs and tests

```bash
node tools/track.mjs shot.mp4 --arm 1.0      # run the browser tracker on a video file, print events + colour table
node tools/eval.mjs --dir ~/shot-clips       # score the tracker on the real clips in data/clips.json (videos kept outside the repo)
npm test                                     # unit tests (geometry, colour)
python3 tests/make_test_video.py /tmp/shot.webm             # synthetic shot (needs numpy + ffmpeg)
python3 tests/make_test_video.py /tmp/shot.mjpeg --lead 5   # same, as a fake webcam feed
node tests/e2e.mjs --file /tmp/shot.webm --camera /tmp/shot.mjpeg   # real Chromium: load OpenCV, arm, start, pips, target, blonde, end
```

## Research and real footage

`research/` holds the Python/OpenCV prototype this tracker was ported from, and findings from four real clips (warm light, red mug + stainless, dappled daylight, further back at 360p). The start was correct to within about 0.2 s every time, with the same settings. Colour rises gradually in every shot, but its level depends on the setup. See [research/README.md](research/README.md).

## Not done yet

- **Blonding calibration needs much more data.** The alert threshold has only been seen on two shots. The plan is in-app recording plus labels (tap when you'd cut), and an evaluation script over many shots.
- On some setups drips after pump-off keep a stream "alive"; use **Stop**.
- Offline/PWA install, and running the vision in a Web Worker to keep the UI smoother on slow phones.
