# Research: following real streams

`track_streams.py` is the OpenCV prototype for the next version of the app. Instead of a fixed box and a still camera, it **finds and follows the streams on its own**, in handheld footage, with two spouts and changing focus and exposure. It only uses calls that also exist in OpenCV.js, so the pipeline can move into the browser as it is.

```bash
pip install opencv-python-headless numpy matplotlib
python3 research/track_streams.py shot.mp4 --out out/
# out/overlay.mp4   detections drawn on the original (moving) frames
# out/streams.csv   per-frame colour of every stream
# out/timeline.png  colour curves against shot time (0 = first liquid)
# out/events.txt    shot start, plus pump on/off for reference
```

## How it works

1. **Registration without drift.** Track KLT corners frame to frame to predict the motion, then refine against a fixed pre-shot reference frame, so every frame lands in reference coordinates.
2. **Thin-line map.** Use second derivatives across x, at stream width, in L\*, a\* and b\*. This catches dark streams against a light mug and orange streams against a dark cup.
3. **"New lines" only.** Subtract the reference frame's line map, dilated by a few pixels. Chrome stripes, cup rims and the mug edge were already lines before the shot, so they cancel even with parallax or slight misregistration. Streams are the lines that *appear*.
4. **Persistence, components and tracks.** Keep tall, thin components that persist. Give tracks stable ids and merge them into streams. Keep only streams that persist through the shot, which removes short-lived artefacts.
5. **Shot start = first liquid.** A stream counts as present while it is seen in at least 10 of the last 15 frames. Once one has stayed present for **2 s**, the clock is backdated to that stream's first appearance. On the first clip, parallax slivers on the portafilter handle and focus artefacts never stayed present longer than 1.5 s; the real streams lasted 15–30 s. The decision is causal (what the live app can do): the displayed time is exact and only the start beep is 2 s late.
6. **Colour.** Take the median Lab of each stream's core pixels (the strongest line response, avoiding edges that blend into the background).
7. **Pump on/off from the soundtrack, for reference only.** The clock does not use it.

## First real clip (handheld, two spouts, warm light)

| | |
|---|---|
| **Shot start (first liquid)** | **10.27 s** (confirmed at 12.57 s). The frames show nothing at 10.1 s and both dark streams running at 10.27 s |
| Pump on / off (audio, reference) | 1.25 s / 39.75 s |
| Streams tracked | both, from first liquid to pump-off |
| Shot length (first liquid → pump off) | ≈ 29.5 s |

Colour of the clean stream (right spout, in front of the mug):

| Time | L\* | Chroma | Paleness | Look |
|---|---|---|---|---|
| 10–12 s | 22–28 | 16–21 | ~5 | dark |
| 13–17 s | 27→45 | 26→42 | ~0 | turning to caramel |
| 17–36 s | 45→51 | ~43 | 2→8 | slow lightening |
| 37–40 s | 51–56 | 40–45 | 10→23 | sharp rise near the end |

Lessons:
- **The clock starts at first liquid, not at the pump.** On this machine the pump ran 9 s before any coffee appeared, which is why first liquid needs reliable detection: a single false sliver must not start the clock.
- **Absolute colour numbers depend on the setup.** The left stream reads about 15 paleness points higher than the right one throughout, because it is thin, sprays, and blends with the grey wall and black cup behind it. Same shot, different backdrop.
- **Blonding here is gradual, not a step.** The fixed threshold in the current app (paleness +25 from idealised reference colours) would never fire on the clean stream. The trigger has to be relative to each stream's own caramel-phase level and trend, and calibrated on real shots, ideally against when the user would have cut.

## Known gaps

- During the 11–16 s refocus, the left stream is sometimes missed and a short false detection appears on the "INSERT" label. Persistence filtering keeps these out of the results and out of the shot start.
- Only one clip so far. Before tuning any thresholds, we need clips from more angles, lights and backdrops, propped and handheld.
