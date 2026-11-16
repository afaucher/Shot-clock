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
5. **Flow score.** Measure frame-to-frame change inside each detection relative to a ring of pixels just around it. Falling coffee keeps changing; reflections on stainless and parallax edges only move with the camera. On both clips, real streams score 1.7–2.3 and every artefact scores 0.6–1.1. Only tracks with a median score of at least 1.4 count as streams. This works regardless of colour or lighting, which matters because under warm light the reflections are "coffee-coloured" too.
6. **Shot start = first liquid.** A stream counts as present while it is seen in at least 10 of the last 15 frames. Once one has stayed present for **2 s**, the clock is backdated to that stream's first appearance. On the first clip, parallax slivers on the portafilter handle and focus artefacts never stayed present longer than 1.5 s; the real streams lasted 15–30 s. The decision is causal (what the live app can do): the displayed time is exact and only the start beep is 2 s late.
7. **Colour.** Take the median Lab of each stream's core pixels (the strongest line response, avoiding edges that blend into the background).
   Samples are held until a track qualifies as a stream, then written back, so the early dark phase isn't lost.
8. **Pump on/off from the soundtrack, for reference only.** The clock does not use it.

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

Your read of this shot: **under-tamped**, so it went light early. Your usual target is 25 s from first liquid, maybe 20 s. The data agrees: the dark phase lasted only about 2 s of shot time, the right stream reached full caramel lightness by about 6 s in, and the left spout sprayed (channeling). By the 20 s and 25 s marks the stream had been light for a long time. On this shot a blonding alert is a diagnosis ("blonded early"), not a cue to cut on time.

Lessons:
- **The clock starts at first liquid, not at the pump.** On this machine the pump ran 9 s before any coffee appeared, which is why first liquid needs reliable detection: a single false sliver must not start the clock.
- **Absolute colour numbers depend on the setup.** The left stream reads about 15 paleness points higher than the right one throughout, because it is thin, sprays, and blends with the grey wall and black cup behind it. Same shot, different backdrop.
- **Target time is the primary cue; colour is the check.** The app now counts down to a target (default 25 s from first liquid) and flags blonding that happens before it as early.
- **Blonding here is gradual, not a step.** The fixed threshold in the current app (paleness +25 from idealised reference colours) would never fire on the clean stream. The trigger has to be relative to each stream's own caramel-phase level and trend, and calibrated on real shots, ideally against when the user would have cut.

## Second real clip (handheld, two spouts into one red-lined mug, stainless backsplash)

A deliberately different setup: looking down into the cup, a saturated red cup interior behind the streams, and reflective stainless around them.

| | |
|---|---|
| **Shot start (first liquid)** | **10.13 s** (confirmed at 12.43 s). A first drop at about 9.9 s, the dark stream running at 10.13 s |
| Streams tracked | both spouts, from first liquid to the end |
| False streams | reflections on the stainless and the spout-handle edge appeared with the original pipeline; the flow score removed them |
| Shot length (first liquid → pump off, reference) | ≈ 28 s |

Colour of the clean stream: dark for about 2.5 s, then lightness climbs **steadily for the whole shot** (35 → 65) with chroma staying high (50–60). Paleness goes from about −15 to +8. Compare clip 1 (under-tamped), where it was light within about 6 s and then flat.

Takeaways across the two clips:
- The **same pipeline and settings** found the start (within about 0.2 s) and both streams in two quite different setups.
- **Absolute colour values differ a lot between setups** (clip 2 paleness sits about 15 points lower throughout). Anything we alert on has to be relative to the shot itself.
- The **shape over time differs between a poor and a better shot** (early jump, then flat, vs a steady climb). That is the signal worth learning, and it needs many labelled shots.

## Known gaps

- During the 11–16 s refocus, the left stream is sometimes missed and a short false detection appears on the "INSERT" label. Persistence filtering keeps these out of the results and out of the shot start.
- Clip 2's left stream sometimes samples the stainless behind it (chroma drops from 18 s on). Sampling should use only the stream's core along its fitted centre line.
- **Two clips is nowhere near enough.** Every threshold here (2 s confirmation, flow ≥ 1.4, line filter scale) was checked on two shots. Accurate detection needs a dataset of many labelled shots and an evaluation harness that scores every change against all of them.
