# Shot Clock

A camera-based espresso shot timer. Point a phone or webcam at the stream and it:

1. **Starts the timer on its own** when the shot starts, i.e. at the first liquid (not when the pump turns on).
2. **Counts down to your target time** (default 25 s, measured from the first liquid) with 3-2-1 pips and a tone on the target.
3. **Tracks the stream colour** through the shot (dark red-brown → caramel/orange → blonde) and plots it live.
4. **Sounds an alert when the stream blondes**: three beeps, a spoken "cut the shot", and vibration on phones.
   If it blondes *before* your target, the alert and the history flag it as **early**. That usually points to fast flow or channeling (light tamp, coarse grind).
5. Stops when the flow stops and saves the shot (time, blonde point, colour ribbon) to a local history.

Everything runs in the browser. There is no build step, no server-side processing, and nothing is uploaded.

## Run it locally

```bash
python3 serve.py              # http://localhost:8000 (camera works on this computer)
python3 serve.py --https      # https://<LAN-IP>:8443 for a phone on the same Wi-Fi
```

Browsers only allow camera access on `localhost` or over HTTPS. `--https` creates a self-signed certificate in `.cert/`, so accept the warning on the phone once.

### Using it

1. Press **Camera** (or **Video file** to replay a recording).
2. **Drag a box** over the gap between the spout and the cup, covering the stream only (not the cup or the portafilter). Narrow and tall works best.
3. Press **Arm** while nothing is flowing. It takes about 0.3 s to learn the background, then shows *Ready*.
4. Pull the shot. The timer starts on its own, and you hear the alert when the stream blondes.
5. Press **Re-arm** before the next shot.

Tips for the camera setup:
- **Steady, even light.** Keep the phone fixed (a small tripod or prop). On Android Chrome the app locks exposure, white balance and focus when you press Arm. Elsewhere, avoid changing light such as a window with passing clouds.
- **A plain backdrop behind the stream helps** a lot. A blue or green card is ideal, because coffee is never that colour.
- Turn on **Show detected stream** to see in green which pixels it treats as coffee. If the green misses the stream, lower *Stream detection threshold*. If it lights up background noise, raise it.

## How the detection works

All the logic is in `js/detector.js`, a pure module with no DOM code, so it runs the same in Node and in the browser.

| Step | Method |
|---|---|
| Stream pixels | Background subtraction inside your box. The background is the average of a few frames taken at Arm and slowly follows lighting drift while waiting. |
| Start | Stream covers ≥ 4% of the box for 250 ms. The timer is then backdated to the first faint drip (up to 4 s earlier). |
| Colour | Mean colour of stream pixels only, averaged in linear RGB, converted to CIELAB, then smoothed with a 0.4 s time constant. |
| **Blonde** | **Paleness = L\* − chroma.** Dark, caramel and orange are all *saturated*, so paleness stays flat through them while lightness climbs by ~40 points. Blonde is the only phase that is both light and washed out. The alert fires when paleness rises *Blonde sensitivity* points (default 25) above the shot's own minimum and stays there for 0.4 s. Because it compares the shot to itself, absolute camera colour accuracy doesn't matter. |
| End | No real flow for 1.5 s. Trailing drips count toward the shot time. |

Measured on reference colours:

| Phase | L\* | Chroma | Paleness |
|---|---|---|---|
| dark red-brown | 19–25 | 25–31 | ≈ −6 |
| caramel / orange | 49–57 | 46–58 | ≈ −1 to +3 |
| tan (blonding) | 70 | 35 | +35 |
| pale blonde | 80–87 | 25–32 | +48 to +62 |

## Tuning on real shots

Record a shot on your phone (keep it still and frame it the same way you would for live use), then either:

- open it in the app with **Video file** and press **Arm**, or
- run it headless and print the timeline:

```bash
node tools/analyze.mjs myshot.mp4 --roi 0.42,0.35,0.16,0.35 --table
#   --roi x,y,w,h is normalised 0..1 (top-left x, y, width, height)
#   --delta N  blonde sensitivity   --pix N  stream threshold   --cov F  flow coverage
```

The `--table` output shows L\*, chroma, paleness and progress every 0.5 s, so you can see where *you* would have cut the shot and set `--delta` to match.

## Tests

```bash
npm test                                   # detector unit tests (node:test)
python3 tests/make_test_video.py /tmp/shot.webm             # synthetic shot video (needs numpy + ffmpeg)
python3 tests/make_test_video.py /tmp/shot.mjpeg --lead 5   # same, as a fake webcam feed
node tests/e2e.mjs --file /tmp/shot.webm --camera /tmp/shot.mjpeg   # real Chromium via Playwright
```

The synthetic clip has its first drip at 1.5 s, starts blonding about 18 s into the shot, and stops at 24 s. Both browser paths (file and fake webcam) detect the start within 0.05 s, alert at 18.2–18.5 s, and report a 23.97 s shot.

## Real footage

`research/` holds the OpenCV prototype that finds and follows streams in handheld footage on its own (no box, no still camera), plus findings from the first real clip. In short: the clock starts at the first liquid, confirmed by a stream that persists for 2 s and backdated so the time is exact. Blonding has to be calibrated against each stream's own caramel-phase colour, not fixed numbers. See [research/README.md](research/README.md).

## Not done yet / ideas

- Real-world thresholds are untested. The defaults come from reference colours and a synthetic clip, so expect to tune *Blonde sensitivity* on your first few shots.
- Bluetooth scale (Acaia, Decent, etc.) via Web Bluetooth to cut by weight with colour as a cross-check.
- Two spouts: track both streams, or alert when either one blondes.
- Package as an installable PWA (manifest + service worker) or wrap in Capacitor for a native app.
