# Shot Clock

A camera espresso shot timer that runs in the browser. Point a phone at the spouts and cup, and it:

1. **Finds and follows the streams on its own.** There's no box to draw, hand-held is fine, and it handles two spouts.
2. **Starts the clock at the first liquid** (not when the pump turns on). A grey provisional time shows as soon as coffee is spotted. Once a stream has been present for 2 s, the time turns white with a beep, backdated to the first drop.
3. **Counts down to your target time** (default 25 s from first liquid) with 3-2-1 pips and a tone on the target.
4. **Tracks each stream's colour** and plots it live.
5. **Flags blonding**, and marks it **early** if it happens before your target. That usually means fast flow or channeling (light tamp, coarse grind). *This alert is experimental and not yet calibrated.*
6. Ends the shot when the streams stop (or when you press **Stop**) and keeps a local history.

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
| Shot start | A stream seen in about two-thirds of frames for 2 s confirms the shot. The clock is backdated to its first appearance. Thresholds are time-based, so slower phones behave the same. |
| Colour | Median Lab of each stream's core pixels. **Paleness = L\* − chroma.** |
| Blonding | A stream's paleness (1 s median) rising *Blonde sensitivity* points above its own baseline, held for 1 s. Compares each stream with itself, because absolute colour varies a lot between setups. |
| End | No flowing stream for 2 s, or **Stop**. |

Speed: about 27 ms/frame in Node and 31–35 ms/frame in headless Chromium on a server CPU. Phones vary.

## Headless runs and tests

```bash
node tools/track.mjs shot.mp4 --arm 1.0      # run the browser tracker on a video file, print events + colour table
npm test                                     # unit tests (geometry, colour)
python3 tests/make_test_video.py /tmp/shot.webm             # synthetic shot (needs numpy + ffmpeg)
python3 tests/make_test_video.py /tmp/shot.mjpeg --lead 5   # same, as a fake webcam feed
node tests/e2e.mjs --file /tmp/shot.webm --camera /tmp/shot.mjpeg   # real Chromium: load OpenCV, arm, start, pips, target, blonde, end
```

## Research and real footage

`research/` holds the Python/OpenCV prototype this tracker was ported from, and findings from two real hand-held clips. Both times the start was correct to within about 0.2 s and both spouts were tracked with the same settings, but the colour curves of a poor and a better shot differ a lot. See [research/README.md](research/README.md).

## Not done yet

- **Blonding calibration needs much more data.** The alert threshold has only been seen on two shots. The plan is in-app recording plus labels (tap when you'd cut), and an evaluation script over many shots.
- On some setups drips after pump-off keep a stream "alive"; use **Stop**.
- Offline/PWA install, and running the vision in a Web Worker to keep the UI smoother on slow phones.
