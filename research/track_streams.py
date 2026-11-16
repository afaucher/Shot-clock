#!/usr/bin/env python3
"""Find and follow espresso streams in (possibly handheld) footage, and
measure each stream's colour over the shot.

This is the research prototype behind the next version of the app. It only
uses OpenCV calls that also exist in OpenCV.js, so it can be ported 1:1.

    pip install opencv-python-headless numpy matplotlib
    python3 research/track_streams.py shot.mp4 --out out/ [--arm 6.0]

Writes to --out:
    overlay.mp4    detections drawn on the ORIGINAL (moving) frames
    streams.csv    per frame, per stream: L*, a*, b*, chroma, hue, paleness
    timeline.png   colour curves per stream against shot time
    events.txt     shot start (first liquid), plus pump on/off from the audio
                   for reference

The shot clock starts at the FIRST LIQUID, not the pump. A stream counts as
present while it is seen densely (10 of the last 15 frames); once one has
stayed present for CONFIRM_S seconds, the clock is backdated to that
stream's first appearance. Parallax slivers and focus artefacts never stay
dense that long (<= 1.5 s on the first real clip, vs 15-30 s for the real
streams). The decision is causal, i.e. what the live app can do: the
display is exact, the start beep just comes CONFIRM_S late.

Pipeline per frame (working resolution 270 px wide):
  1. Registration: KLT points frame-to-frame for a prediction, then refined
     against a fixed reference frame (taken at --arm) so there is no drift.
  2. Line map: thin vertical line response (either polarity) in L*, a*, b*.
  3. New lines: line map minus the reference line map dilated by a few px,
     so edges that were already there (chrome, cup rims) cancel even with
     small misregistration or parallax. Streams are the lines that appear.
  4. Persistence + connected components (tall, thin) -> detections.
  5. Flow score: frame-to-frame change inside the detection vs a ring around
     it. Only tracks that keep "flowing" become streams - this is what rejects
     reflections on stainless and parallax edges, independent of colour.
  6. Tracks keep stable ids; neighbouring tracks are merged into streams.
  7. Colour = median Lab of the component's core (strongest line pixels).
"""
import argparse
import csv
import os
import subprocess

import cv2
import numpy as np

W = 270                 # working width
NEW_T = 3.0             # persistence threshold for "new line" evidence
CONFIRM_S = 2.0         # a stream must stay dense this long to start the clock
LOOKBACK_S = 3.0        # how far before the dense run the first sighting may be
TARGETS = (20, 25)      # target shot times marked on the timeline (from first liquid)
FLOW_MIN = 1.4          # median flow score a track needs to count as a stream:
                        # falling coffee keeps changing frame to frame, while
                        # reflections/edges only move with the camera (real
                        # streams 1.7-2.2, artefacts 0.6-1.1 on two clips)


def to_lab(bgr):
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab[..., 0] *= 100 / 255
    lab[..., 1:] -= 128
    return lab


def line_map(lab, sigma=1.3):
    """Thin vertical line response, bright or dark, in any Lab channel."""
    acc = np.zeros(lab.shape[:2], np.float32)
    for c, wgt in ((0, 1.0), (1, 1.4), (2, 1.4)):
        g = cv2.GaussianBlur(lab[..., c], (0, 0), sigma)
        dxx = cv2.Sobel(g, cv2.CV_32F, 2, 0, ksize=3)
        dyy = cv2.Sobel(g, cv2.CV_32F, 0, 2, ksize=3)
        acc = np.maximum(acc, np.maximum(np.abs(dxx) - 0.8 * np.abs(dyy), 0) * wgt)
    return cv2.GaussianBlur(acc, (0, 0), sigmaX=0.6, sigmaY=3)


class Registrar:
    """Aligns each frame to a fixed reference frame without drift."""

    def __init__(self, ref_gray):
        self.ref = ref_gray
        self.ref_pts = cv2.goodFeaturesToTrack(ref_gray, 400, 0.01, 5, blockSize=5)
        self.T = np.eye(3)
        self.prev = ref_gray

    def update(self, gray):
        h, w = gray.shape
        step = np.eye(3)
        pts = cv2.goodFeaturesToTrack(self.prev, 300, 0.01, 6)
        if pts is not None and len(pts) >= 10:
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(self.prev, gray, pts, None, winSize=(21, 21), maxLevel=3)
            ok = st.ravel() == 1
            if ok.sum() >= 10:
                M, _ = cv2.estimateAffinePartial2D(nxt[ok], pts[ok], method=cv2.RANSAC, ransacReprojThreshold=2.0)
                if M is not None:
                    step = np.vstack([M, [0, 0, 1]])
        pred = self.T @ step
        warped = cv2.warpAffine(gray, pred[:2], (w, h), flags=cv2.INTER_LINEAR, borderValue=0)
        nxt, st, err = cv2.calcOpticalFlowPyrLK(self.ref, warped, self.ref_pts, None, winSize=(15, 15), maxLevel=2)
        ok = (st.ravel() == 1) & (err.ravel() < 20)
        if ok.sum() >= 15:
            M, _ = cv2.estimateAffinePartial2D(nxt[ok], self.ref_pts[ok], method=cv2.RANSAC, ransacReprojThreshold=1.5)
            if M is not None:
                pred = np.vstack([M, [0, 0, 1]]) @ pred
        self.T = pred
        self.prev = gray
        return self.T


class Track:
    _next = 1

    def __init__(self, cx, t):
        self.id = Track._next
        Track._next += 1
        self.cx, self.hits, self.first, self.last = cx, 1, t, t
        self.stream = None
        self.recent = [t]           # hit times, for the density test
        self.run_start = None       # start of the current dense run
        self.flows = []             # recent flow scores
        self.pending = []           # colour rows held until the track qualifies

    def flowing(self, n=30, need=10):
        f = self.flows[-n:]
        return len(f) >= need and float(np.median(f)) >= FLOW_MIN

    def dense(self, t, window=0.5, need=10):
        self.recent = [x for x in self.recent if t - x <= window]
        return len(self.recent) >= need

    @property
    def confirmed(self):
        return self.hits >= 8


def detect_pump(path):
    """Pump on/off from the soundtrack: low-band energy steps (40-700 Hz)."""
    try:
        raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000',
                              '-f', 's16le', '-'], capture_output=True, check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    a = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    if len(a) < 16000:
        return None
    sr, hop = 16000, 4000
    lv = []
    for i in range(0, len(a) - hop, hop):
        sp = np.abs(np.fft.rfft(a[i:i + hop] * np.hanning(hop))) ** 2
        f = np.fft.rfftfreq(hop, 1 / sr)
        lv.append(10 * np.log10(sp[(f > 40) & (f < 700)].sum() + 1e-12))
    lv = np.array(lv)
    floor = np.percentile(lv, 10)
    on = lv > floor + 12
    if not on.any():
        return None
    idx = np.nonzero(on)[0]
    return idx[0] * hop / sr, (idx[-1] + 1) * hop / sr, lv


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video')
    ap.add_argument('--out', default='out')
    ap.add_argument('--arm', type=float, default=None,
                    help='time (s) of a frame with no coffee flowing; default: 1 s after pump-on, else 1 s')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    pump = detect_pump(args.video)
    if pump:
        print(f'pump on {pump[0]:.2f}s, off {pump[1]:.2f}s (reference only)')
    arm = args.arm if args.arm is not None else ((pump[0] + 1.0) if pump else 1.0)

    cap = cv2.VideoCapture(args.video)
    fps = cap.get(cv2.CAP_PROP_FPS)
    raw = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        raw.append(f)
    h0, w0 = raw[0].shape[:2]
    H = int(round(W * h0 / w0))
    VW = 540
    VH = int(round(VW * h0 / w0))
    sx = VW / W
    ri = min(len(raw) - 1, int(arm * fps))
    small = lambda i: cv2.resize(raw[i], (W, H), interpolation=cv2.INTER_AREA)  # noqa: E731

    reg = Registrar(cv2.cvtColor(small(ri), cv2.COLOR_BGR2GRAY))
    ref_lines = None
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 5))
    persist = np.zeros((H, W), np.float32)
    ones = np.full((H, W), 255, np.uint8)
    tracks, streams = [], []        # streams: list of dicts {id, cx}
    shot_start = None
    writer = cv2.VideoWriter(os.path.join(args.out, 'overlay_raw.mp4'), cv2.VideoWriter_fourcc(*'mp4v'), fps, (VW, VH))
    out_csv = open(os.path.join(args.out, 'streams.csv'), 'w', newline='')
    cw = csv.writer(out_csv)
    cw.writerow(['t', 'stream', 'track', 'cx', 'L', 'a', 'b', 'C', 'h', 'P', 'n', 'flow'])
    prev_lab = None

    for i in range(ri + 1, len(raw)):
        t = i / fps
        f = small(i)
        T = reg.update(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY))
        stab = cv2.warpAffine(f, T[:2], (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        # pixels that came from inside the camera frame, minus a margin (the
        # image edge counts as outside, so edge artefacts can't become streams)
        valid = cv2.erode(cv2.warpAffine(ones, T[:2], (W, H), flags=cv2.INTER_NEAREST, borderValue=0),
                          np.ones((9, 9), np.uint8), borderType=cv2.BORDER_CONSTANT, borderValue=0) > 0
        lab = to_lab(stab)
        # frame-to-frame change (registered): falling coffee keeps changing,
        # reflections and edges only move with registration error
        change = np.zeros((H, W), np.float32) if prev_lab is None else np.abs(lab - prev_lab).sum(axis=2)
        prev_lab = lab
        lm = line_map(lab)
        lm[~valid] = 0
        if i < ri + int(fps):
            ref_lines = lm.copy() if ref_lines is None else np.maximum(ref_lines * 0.98, lm)
            continue
        new = np.maximum(lm - 1.2 * cv2.dilate(ref_lines, kernel), 0)
        persist = persist * 0.85 + new * 0.15
        n, cc, stats, _ = cv2.connectedComponentsWithStats((persist > NEW_T).astype(np.uint8), connectivity=8)
        dets = []
        for k in range(1, n):
            x, y, w, h, area = stats[k]
            if h < 10 or h < 2.0 * w or area < 15:
                continue
            comp = cc == k
            core = comp & (lm >= np.percentile(lm[comp], 50))
            if core.sum() < 5:
                continue
            c = lab[core]
            # flow score: change inside the stream vs a ring just around it
            x0, y0 = max(0, x - 8), max(0, y - 4)
            x1, y1 = min(W, x + w + 8), min(H, y + h + 4)
            ring = np.zeros((H, W), bool)
            ring[y0:y1, x0:x1] = True
            ring &= ~cv2.dilate(comp.astype(np.uint8), np.ones((3, 5), np.uint8)).astype(bool)
            ring &= valid
            inside = float(np.mean(change[core]))
            around = float(np.mean(change[ring])) if ring.any() else inside
            flow = inside / (around + 1.0)
            dets.append(dict(cx=x + w / 2, box=(x, y, w, h), core=core, n=int(core.sum()), flow=flow,
                             L=float(np.median(c[:, 0])), a=float(np.median(c[:, 1])), b=float(np.median(c[:, 2]))))
        for d in sorted(dets, key=lambda d: -d['n']):
            best = min((tr for tr in tracks if abs(tr.cx - d['cx']) < 12 and tr.last < t),
                       key=lambda tr: abs(tr.cx - d['cx']), default=None)
            if best is None:
                best = Track(d['cx'], t)
                tracks.append(best)
            else:
                best.cx = best.cx * 0.8 + d['cx'] * 0.2
                best.hits += 1
                best.last = t
                best.recent.append(t)
            d['track'] = best
            best.flows.append(d['flow'])

            # merge confirmed, flowing tracks into streams: one per ~20 px column
            if best.confirmed and best.stream is None and best.flowing():
                s = min((s for s in streams if abs(s['cx'] - best.cx) < 20), key=lambda s: abs(s['cx'] - best.cx), default=None)
                if s is None:
                    s = dict(id=len(streams) + 1, cx=best.cx, flows=[])
                    streams.append(s)
                best.stream = s
            if best.stream is not None:
                best.stream['flows'].append(d['flow'])
        # shot clock: a stream that stays dense for CONFIRM_S starts it
        for tr in tracks:
            if tr.dense(t):
                tr.run_start = t if tr.run_start is None else tr.run_start
                if shot_start is None and t - tr.run_start >= CONFIRM_S and tr.flowing():
                    shot_start = max(tr.first, tr.run_start - LOOKBACK_S)
                    print(f'shot start (first liquid) {shot_start:.2f}s, confirmed at {t:.2f}s')
            else:
                tr.run_start = None
        tracks = [tr for tr in tracks if tr.confirmed or t - tr.last < 1.0]

        vis = cv2.resize(raw[i], (VW, VH), interpolation=cv2.INTER_AREA)
        Tinv = cv2.invertAffineTransform(T[:2]).astype(np.float32)
        for d in dets:
            tr = d['track']
            # a stream counts only while its overall flow score says "liquid"
            C = float(np.hypot(d['a'], d['b']))
            hue = float((np.degrees(np.arctan2(d['b'], d['a'])) + 360) % 360)
            P = d['L'] - C
            row = [f'{t:.3f}', tr.id, f"{d['cx']:.1f}", f"{d['L']:.1f}", f"{d['a']:.1f}",
                   f"{d['b']:.1f}", f'{C:.1f}', f'{hue:.0f}', f'{P:.1f}', d['n'], f"{d['flow']:.2f}"]
            qualified = tr.stream is not None and len(tr.stream['flows']) >= 15 and np.median(tr.stream['flows']) >= FLOW_MIN
            if not qualified:
                # hold the samples: a stream is only recognised once its flow
                # score has built up, but its early (dark) colour matters
                tr.pending = (tr.pending + [row])[-300:]
                continue
            for pr in tr.pending:
                cw.writerow([pr[0], tr.stream['id']] + pr[1:])
            tr.pending = []
            cw.writerow([row[0], tr.stream['id']] + row[1:])
            ys, xs = np.nonzero(d['core'])
            pts = (np.stack([xs, ys, np.ones_like(xs)], 1).astype(np.float32) @ Tinv.T * sx).astype(int)
            keep = (pts[:, 0] >= 0) & (pts[:, 0] < VW) & (pts[:, 1] >= 0) & (pts[:, 1] < VH)
            vis[pts[keep, 1], pts[keep, 0]] = (0, 255, 0)
            x, y, w, h = d['box']
            corners = np.array([[x, y, 1], [x + w, y, 1], [x + w, y + h, 1], [x, y + h, 1]], np.float32) @ Tinv.T * sx
            cv2.polylines(vis, [corners.astype(np.int32)], True, (0, 255, 255), 1)
            lx, ly = corners[0].astype(int)
            rgb = cv2.cvtColor(np.uint8([[[d['L'] * 2.55, d['a'] + 128, d['b'] + 128]]]), cv2.COLOR_LAB2BGR)[0, 0]
            cv2.rectangle(vis, (lx - 2, ly - 34), (lx + 74, ly - 2), (0, 0, 0), -1)
            cv2.rectangle(vis, (lx, ly - 32), (lx + 14, ly - 18), tuple(int(v) for v in rgb), -1)
            cv2.putText(vis, f"stream {tr.stream['id']}", (lx + 18, ly - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (255, 255, 255), 1)
            cv2.putText(vis, f'pale {P:4.1f}', (lx, ly - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
        status = f'video {t:5.1f}s   SHOT ' + (f'{t - shot_start:5.1f}s' if shot_start is not None else '  --  ')
        cv2.rectangle(vis, (0, 0), (VW, 26), (0, 0, 0), -1)
        cv2.putText(vis, status, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 1)
        writer.write(vis)
    writer.release()
    out_csv.close()
    # browser-friendly encode
    src = os.path.join(args.out, 'overlay_raw.mp4')
    dst = os.path.join(args.out, 'overlay.mp4')
    if subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', src, '-c:v', 'libx264', '-crf', '26',
                       '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dst]).returncode == 0:
        os.remove(src)
    with open(os.path.join(args.out, 'events.txt'), 'w') as fh:
        fh.write(f'shot start (first liquid): {shot_start:.2f} s\n' if shot_start is not None else 'no shot detected\n')
        if pump:
            fh.write(f'pump on: {pump[0]:.2f} s (reference only)\npump off: {pump[1]:.2f} s (reference only)\n')
    plot(args.out, pump, shot_start or 0.0)


def plot(out, pump, t0):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        print('matplotlib not installed; skipping timeline.png')
        return
    rows = list(csv.DictReader(open(os.path.join(out, 'streams.csv'))))
    if not rows:
        print('no streams found')
        return
    by = {}
    for r in rows:
        by.setdefault(int(r['stream']), []).append({k: float(v) for k, v in r.items()})
    # real streams persist from first flow to the end; keep those with at least
    # 3 s of samples and >= 30% of the best stream's evidence
    top = max(len(v) for v in by.values())
    by = {k: v for k, v in by.items()
          if len(v) >= max(90, 0.3 * top) and np.median([r['flow'] for r in v]) >= FLOW_MIN}
    fig, axes = plt.subplots(4, 1, figsize=(10, 10), sharex=True)
    for sid, rr in sorted(by.items()):
        rr.sort(key=lambda r: r['t'])
        t = np.array([r['t'] for r in rr]) - t0

        def sm(key, win=0.7):
            v = np.array([r[key] for r in rr])
            return np.array([np.median(v[np.abs(t - ti) <= win / 2]) for ti in t])
        L, a, b = sm('L'), sm('a'), sm('b')
        C = np.hypot(a, b)
        series = [L, C, (np.degrees(np.arctan2(b, a)) + 360) % 360, L - C]
        for ax, v, lab in zip(axes, series, ['Lightness L*', 'Chroma', 'Hue (°)', 'Paleness (L* − chroma)']):
            ax.plot(t, v, lw=1.8, label=f'stream {sid} (x≈{np.median([r["cx"] for r in rr]):.0f})')
            ax.set_ylabel(lab)
        rgb = cv2.cvtColor(np.stack([L * 2.55, a + 128, b + 128], 1).astype(np.uint8)[None], cv2.COLOR_LAB2RGB)[0] / 255
        axes[3].scatter(t, np.full_like(t, -10 - 6 * sid), c=rgb, s=30, marker='s')
    for ax in axes:
        ax.axvline(0, color='black', lw=1)
        for tgt in TARGETS:
            ax.axvline(tgt, color='green', ls='--', lw=0.9)
        if pump:
            for x in pump[:2]:
                ax.axvline(x - t0, color='grey', ls=':', lw=0.8)
    axes[0].legend(loc='lower right')
    for tgt in TARGETS:
        axes[0].text(tgt + 0.3, axes[0].get_ylim()[0] + 2, f'{tgt} s', color='green', fontsize=8)
    axes[3].set_xlabel('shot time (s) from first liquid  —  green: target times, dotted: pump on/off (reference)')
    fig.suptitle('Stream colour over the shot')
    fig.tight_layout()
    fig.savefig(os.path.join(out, 'timeline.png'), dpi=110)
    print('wrote', os.path.join(out, 'timeline.png'))


if __name__ == '__main__':
    main()
