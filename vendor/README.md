# Vendored libraries

| File | What | Version | License |
|---|---|---|---|
| `opencv-4.10.0.js` | OpenCV.js (WebAssembly build of OpenCV, single file with embedded wasm), from the [`@techstark/opencv-js`](https://www.npmjs.com/package/@techstark/opencv-js) npm package `4.10.0-release.1` | 4.10.0 | Apache-2.0 ([OpenCV license](https://opencv.org/license/)) |

The file is vendored, not loaded from a CDN, so the app works the same on GitHub Pages, on localhost, and later offline. The same file is loaded by `tools/track.mjs` in Node, so headless tests run exactly the code the browser runs.
