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

## Clips 3 and 4, and what four shots show

| Clip | Setup | First liquid (browser tracker) | From the frames |
|---|---|---|---|
| 1 | warm light, black cup + mug, hand-held, under-tamped | 10.27 s | ✓ |
| 2 | red-lined mug, stainless, hand-held | 10.17 s | ✓ (~10.0–10.1 s) |
| 3 | **daylight with dappled sun moving over a white cup**, hand-held, camera re-framed after starting | 8.93 s | ✓ (nothing at 8.5 s, drops at 8.9 s) |
| 4 | patterned mug, further back, steadier, 360p | 9.57 s | ✓ (nothing at 9.3 s, streams at 9.57 s) |

Same settings on all four; start within about 0.2 s every time.

Problems clip 3 exposed, now fixed in `js/tracker.js`:
- **Re-referencing.** Hand-held through a whole shot, the view drifted up to 11% in scale and 18% in position. Parallax and newly visible areas then looked "new", and streams were lost. When the view drifts more than 4% in scale or 8% of the frame in position, the tracker re-references: re-learning the scene if nothing is flowing yet, or, mid-shot, taking the current view as the reference with the tracked streams masked out (so they aren't absorbed) and moving tracks into the new coordinates.
- **Hysteresis.** Late in a shot, streams thin out and run smooth, and moving sunlight around them lowers the flow score. Re-checking flow ≥ 1.4 every frame dropped them and ended the shot at 13 s. Now flow ≥ 1.4 (over 1 s) *establishes* a stream, and ≥ 1.1 keeps it live.
- **Colour sampling.** Each stream's colour comes from the core pixels that differ most from the background *in the same rows*. A sample is skipped when the stream barely stands out (ΔE < 6). The blonde check only considers the main streams, so chrome highlights can't trigger it.

What the colour shows: in all four shots paleness rises gradually through the shot, with levels that differ by setup and between the two spouts of the same shot. Clips 3 and 4 stop recording 21–23 s into the shot, so they don't reach a 25 s target. For calibration, recordings should run until after the pump stops.

## Stream recognition: research and the confidence/top-N tracker

Web research brief (multi-target tracking, moving-camera change detection, specular highlights, liquid detection; sources in the commit history of this file's discussion):
- The pipeline's structure (motion compensation → "new structure" with a tolerance window → persistence → tracking) is the standard one for moving cameras. The weak point was **fixed thresholds on a single cue**.
- The standard fix is a **running track score**, a log-likelihood ratio accumulated per frame and confirmed or deleted like a sequential probability ratio test (Blackman & Popoli; MATLAB `trackScoreLogic`). Miss penalties, and evidence weighted by registration confidence.
- ByteTrack's lesson: **weak detections may continue a confirmed track but never start one**.
- Scene priors: change that only happens while the camera moves is viewpoint-dependent (highlights, parallax, reflections). Streams are anchored at the spouts in scene coordinates. Two spouts give a **pair** of streams starting at about the same height.
- Highlights take the light's colour (low chroma, very bright, often clipped).
- No published espresso work was found. Robot-pouring work uses learned segmentation, often bootstrapped from classical labels, which is a route for later once there is data.

Implemented in `js/tracker.js`:
1. Per-track confidence (LLR). Each frame adds:
   - flow `±2.5·ln(flow/1.3)`, capped at ±2, with the positive part scaled by camera stillness;
   - anchoring (x spread over 1 s: +0.3 below 1.5 px, −0.8 above 4 px);
   - highlight share (−3 × fraction of bright, colourless pixels);
   - −0.4 per missed frame, but no penalty when a sibling track of the same stream was seen.

   The total is scaled by registration confidence. Streams confirm at 6 and drop below 0.
2. **Top N chosen jointly** (`maxStreams`, default 2): the sum of confidences, plus +3 for incumbents, minus 60 × top-end height mismatch as a fraction of frame height. A changed selection must hold 0.5 s. Stream tops are a 2 s median, so a stray detection can't move them.
3. **Weak continuation**: near a top-N stream, persistence down to 0.8× the threshold and a looser shape are accepted. Weak detections keep the stream alive but give no colour samples.
4. Re-reference masks use the union of each stream's boxes over the last 1.5 s, plus 10 px.

Measured with `tools/eval.mjs` on the four clips (all have two spouts):

| | Before | After |
|---|---|---|
| Frames showing more streams than spouts | clip 2: 73% | 0% on all clips |
| Distinct streams ever shown | 2 / 3 / 3 / 2 | 2 / 2 / 2 / 2 |
| Tracked share, weaker stream | clip 1: 29%, clip 4: 43% (see note) | clip 1: 59%, clip 4: 94% |
| Shot start error | 0.00 / +0.04 / 0.00 / 0.00 s | 0.00 / −0.13 / 0.00 / 0.00 s (clip 2: 10.00 s, first drop ~9.9 s) |

The "before" tracked figures were measured with the new scoring but without weak continuation. Clip 3's tracked share dropped (90/85% → 82/75%).

**These numbers move noticeably with small parameter changes, which is the clearest sign that four clips are not enough to tune on.**

Next, in the order the research ranked them:
1. Clipped/highlight pixels out of the line map and KLT corners.
2. Gravity alignment from the phone's motion sensors (`DeviceMotionEvent`), to require near-vertical streams and handle roll.
3. Several reference keyframes against parallax.
4. A column-integrated track-before-detect profile for faint streams.
5. Later, a small learned verifier on space-time patches, trained on labels the classical pipeline generates.

## Clips 5–7: first test on shots not used for tuning

The owner's shared album now holds every clip in order (item N = clip N; item 4 is now full resolution). Clips 5–7 were added after the confidence/top-N tracker was finished and **nothing was tuned on them**:

| Clip | Setup | Start (frames) | Start (tracker) | Streams shown | Tracked (two streams) |
|---|---|---|---|---|---|
| 4 (now full res) | patterned mug, further back | 9.57 s | exact | only the 2 real | 99% / 97% (95/94% at 360p) |
| 5 | warm light, plain white mug, hand-held | 9.03 s (nothing at 8.9 s) | exact | only the 2 real | 100% / 93% |
| 6 | daylight, sun stripes over a white mug | 9.37 s (nothing at 9.2 s) | exact | only the 2 real | 100% / 93% |
| 7 | recording starts mid-shot, camera re-framed | (none) | **no start**, correct | none | n/a |

Clip 7 also showed the tracker re-learning the scene repeatedly while the camera was re-framed. That is the intended behaviour, and the app now tells the user ("Camera moved, re-learning the scene, hold steady").

This is the first evidence that the settings are not just fitted to the first four clips.

**Checking for duplicates.** Every album item was compared with every earlier clip using frame fingerprints (2 frames/s, normalised grayscale) at any time offset. Items 1–4 are clips 1–4 (correlation 1.00). Items 5–8 match nothing earlier (best 0.58, a similar scene), so they are new recordings.

**Clip 8, a known hard case.** The recording starts only about 2 s before the first drop (1.8 s), and the camera moves right then. The scene gets re-learned while the first drops are falling, so the clock starts about 6 s late, although the streams are then tracked well (92% / 86%, only the two real ones shown). Two fixes were tried and reverted after the evaluation showed they hurt:
- leaving pixels that kept changing out of the learned scene: it also removed the flickering static edges (chrome, reflections) the reference exists to suppress, and caused early false starts on every clip;
- re-learning only when nothing at all is tracked: false starts on clips 1 and 7.

In practice this is the "press Arm, then hold steady for a second before starting the pump" instruction; the app now says when it re-learns.

## Known gaps

- During the 11–16 s refocus, the left stream is sometimes missed and a short false detection appears on the "INSERT" label. Persistence filtering keeps these out of the results and out of the shot start.
- Clip 2's left stream sometimes samples the stainless behind it (chroma drops from 18 s on). Sampling should use only the stream's core along its fitted centre line.
- Short colour blips remain (a second or two on clips 2 and 3), and a moving chrome highlight can still become a short-lived extra "stream".
- **Four clips is nowhere near enough.** Every threshold here (2 s confirmation, flow ≥ 1.4 / 1.1, re-reference limits, line filter scale) was checked on four shots. Accurate detection needs a dataset of many labelled shots and an evaluation harness that scores every change against all of them.
