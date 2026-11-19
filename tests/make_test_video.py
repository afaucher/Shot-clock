#!/usr/bin/env python3
"""Render a synthetic espresso shot video for testing Shot Clock.

Timeline (video seconds):
  0.0 - LEAD      nothing flowing (background only)
  +0.0 - +1.5     intermittent dark drips
  +1.5 - +7.5     dark red-brown stream
  +7.5 - +16.5    -> caramel -> vibrant orange
  +16.5 - +19.5   -> tan (blonding begins, ~+18 s)
  +19.5 - +22.5   -> pale blonde, thinning
  +22.5 / +24.0   stream breaks up, then stops

Usage: python3 make_test_video.py OUT.webm [--lead 1.5] [--fps 30]
Output format follows the extension (.webm, .mp4, .mjpeg, .y4m).
Requires numpy and ffmpeg.
"""
import argparse
import subprocess
import numpy as np

W, H = 640, 480
CX, SPOUT_Y, CUP_Y = 320, 90, 390

# (seconds after first drip, rgb, width px, opacity)
KEYS = [
    (1.5, (75, 35, 20), 10, 1.0),
    (7.5, (95, 45, 25), 12, 1.0),
    (12.5, (170, 100, 50), 12, 1.0),
    (16.5, (200, 115, 45), 11, 1.0),
    (19.5, (205, 165, 110), 9, 0.9),
    (22.5, (230, 205, 155), 6, 0.75),
]
DRIP_END = 1.5
STOP_AT = 24.0


def lerp_key(t):
    if t <= KEYS[0][0]:
        return KEYS[0][1:]
    for (t0, c0, w0, a0), (t1, c1, w1, a1) in zip(KEYS, KEYS[1:]):
        if t <= t1:
            u = (t - t0) / (t1 - t0)
            c = tuple(c0[i] + (c1[i] - c0[i]) * u for i in range(3))
            return c, w0 + (w1 - w0) * u, a0 + (a1 - a0) * u
    return KEYS[-1][1:]


def background(rng):
    y = np.linspace(0, 1, H)[:, None]
    x = np.linspace(0, 1, W)[None, :]
    base = 70 + 30 * y - 15 * np.abs(x - 0.5)  # dim machine body / drip tray
    img = np.stack([base * 0.95, base, base * 1.08], axis=-1)
    img += rng.normal(0, 6, (H, W, 1))          # fine texture
    # coarse static structure (tiles, fittings) so registration has something
    # to lock onto, as in a real kitchen; kept away from the stream's column
    for gx in range(20, W, 70):
        if abs(gx - CX) > 40:
            img[:, gx:gx + 3] -= 25
    for gy in range(30, H, 60):
        img[gy:gy + 3, :] -= 25
    for _ in range(14):
        bx, by = int(rng.integers(0, W - 40)), int(rng.integers(0, H - 30))
        if abs(bx + 20 - CX) < 60:
            continue
        img[by:by + int(rng.integers(10, 30)), bx:bx + int(rng.integers(10, 40))] += rng.normal(0, 30)
    img[:SPOUT_Y, CX - 70:CX + 70] = (40, 40, 44)   # portafilter
    img[SPOUT_Y - 10:SPOUT_Y, CX - 8:CX + 8] = (90, 90, 95)  # spout
    img[CUP_Y:, CX - 90:CX + 90] = (225, 225, 220)  # cup
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--lead', type=float, default=1.5, help='seconds of empty frames first')
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--tail', type=float, default=6.0, help='seconds of empty frames after the stream stops (the end needs 3 s without a stream)')
    args = ap.parse_args()

    rng = np.random.default_rng(1)
    bg = background(rng)
    total = args.lead + STOP_AT + args.tail
    n = int(total * args.fps)
    ys = np.arange(H)[:, None]
    xs = np.arange(W)[None, :]

    ext = args.out.rsplit('.', 1)[-1].lower()
    codec = {
        'webm': ['-c:v', 'libvpx-vp9', '-b:v', '2M', '-deadline', 'realtime', '-cpu-used', '8'],
        'mp4': ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18'],
        'mjpeg': ['-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-q:v', '3', '-f', 'mjpeg'],
        'y4m': ['-pix_fmt', 'yuv420p'],
    }[ext]
    ff = subprocess.Popen(
        ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
         '-s', f'{W}x{H}', '-r', str(args.fps), '-i', '-', *codec, args.out],
        stdin=subprocess.PIPE)

    for i in range(n):
        t = i / args.fps - args.lead
        frame = bg.copy()
        if 0 <= t < STOP_AT:
            color, width, alpha = lerp_key(t)
            if t < DRIP_END:
                # a few falling drops
                m = np.zeros((H, W), bool)
                for k in range(3):
                    phase = (t * 2.2 + k / 3) % 1
                    dy = SPOUT_Y + phase * (CUP_Y - SPOUT_Y)
                    m |= ((xs - CX) ** 2 + ((ys - dy) / 1.6) ** 2) < 25
            else:
                wobble = 1.5 * np.sin(ys / 17 + t * 9) + 0.8 * np.sin(ys / 5 - t * 23)
                half = width / 2 + 0.6 * np.sin(ys / 9 + t * 13)
                m = (np.abs(xs - (CX + wobble)) < half) & (ys > SPOUT_Y) & (ys < CUP_Y)
                if t > STOP_AT - 1.5:   # breaking up into drips
                    m &= ((ys + int(t * 400)) % 60) < 25
            col = np.array(color, float)
            # slight vertical shading so the stream isn't a flat fill
            shade = (0.9 + 0.2 * (ys - SPOUT_Y) / (CUP_Y - SPOUT_Y))[..., None]
            stream = np.clip(col * shade, 0, 255)
            mm = m[..., None]
            frame = np.where(mm, frame * (1 - alpha) + stream * alpha, frame)
        frame += rng.normal(0, 2.5, (H, W, 1))  # sensor noise
        ff.stdin.write(np.clip(frame, 0, 255).astype(np.uint8).tobytes())

    ff.stdin.close()
    ff.wait()
    print(f'wrote {args.out}: {total:.1f}s, first drip at {args.lead:.2f}s, stops at {args.lead + STOP_AT:.2f}s')


if __name__ == '__main__':
    main()
