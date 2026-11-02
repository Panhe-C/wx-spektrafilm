# wx-spektrafilm

A WeChat Mini Program (native JS/WXML/WXSS, no framework, no backend) that applies
film-emulation looks to phone photos using pre-baked 3D LUTs rendered on-device via WebGL.

Film modeling powered by spektrafilm
(https://github.com/andreavolpato/spektrafilm).

LUT/profile data derived from spektrafilm is licensed
CC BY-SA 4.0 (Andrea Volpato) — see
<https://github.com/andreavolpato/spektrafilm/blob/main/SPEKTRAFILM_LICENSE.txt>.
The code in this repository is licensed under GPLv3 (see LICENSE).

## Development

- Open the repo root in WeChat DevTools (微信开发者工具).
- Use the built-in tourist appid (`touristappid`, already set in `project.config.json`),
  or import your own appid.
- No npm build step is required for the Mini Program; it runs directly from source. If a canonical
  `shaders/*.glsl` file changes, regenerate the committed WeChat module with
  `python3 tools/embed_shaders.py`.

## Pick and preview

The index page supports album/camera selection, EXIF-upright bounded resizing, a contain/letterbox
WebGL preview, all 11 stocks, intensity 0–100%, press-and-hold original comparison, and clear.
The LUT asset subpackage is loaded lazily after the first pick and decoded LUTs are cached in
memory. See `docs/RENDERER.md` and `docs/ORIENTATION.md` for implementation details and
`docs/LIMITATIONS.md` for the real-device verification boundary.

## Verification

```sh
# JSON/page/runtime-import/shader/package-size checks (no AppID required)
python3 tools/check_miniprogram.py

# EXIF unit tests, then full 6-photo × 11-stock Chrome/SwiftShader versus NumPy comparison
cd harness
npm i
npm test
```

The harness expects `/workspace/testphotos/p*.jpg`, Chrome at `/usr/bin/google-chrome`, and the
Python scientific environment described in `docs/RENDERER.md`. It runs the orientation policy and
matrix unit tests before launching Chrome. It writes `harness/out/report.{json,md}`, per-pair
shader/Python/diff PNGs, and `harness/out/contact-shader.jpg`. Outputs and test photos are not
committed. A real AppID/private key would be needed for `miniprogram-ci`; static and headless
checks do not replace WeChat DevTools or physical-device testing.

The final on-box full run passed **66/66 pairs** and **11/11 intensity checks**. Worst pair mean
ΔE2000 was **0.00052035**, worst max ΔE2000 was **1.21046424**, and median shader
render/readback time was **9.90 ms** under SwiftShader. The generated `harness/out/report.md`
contains the per-stock and per-photo tables. These are headless measurements, not phone timings.

## Layout

- `app.js`, `app.json`, `app.wxss` — Mini Program entry
- `pages/` — native picker and preview page
- `utils/`, `renderer/` — shared WebGL renderer, generated GLSL module, photo preparation, fallback stub
- `shaders/` — canonical WebGL1 GLSL sources shared with the headless harness
- `subpackages/luts/` — lazily loaded LUTs/manifest plus the required no-op subpackage page
- `harness/` — Puppeteer/Chrome and NumPy numerical verification (not shipped in the app)
- `tools/` — Python LUT tooling and static Mini Program checks (uses `/workspace/venv-sf`)
- `assets/` — other static assets
- `docs/` — format, renderer, orientation, exposure, limitations, validation, and previews

## Film LUT scope

The LUTs reproduce spektrafilm's deterministic physical colour pipeline for display-referred
sRGB phone photos. Baking and validation use one shared parameter builder and one global recipe;
there is no ad-hoc post-simulation tone or levels curve. See `docs/EXPOSURE.md` for the measured
exposure choice and `docs/validation.md` for LUT-versus-full-`simulate()` fidelity.

A static LUT excludes grain, halation/scatter, diffusion filters, lens/scan blur, glare, scanner
unsharp masking, DIR-coupler spatial diffusion, and all other spatial or stochastic effects.
Those effects are planned as separate later WebGL shaders (including grain, halation bloom, and
vignette-like diffusion), not hidden inside the colour tables. `docs/LIMITATIONS.md` details this
boundary and the exposure/tonality trade-offs.

The tiled-grid PNG layout and shader half-texel/trilinear contract are in `docs/LUT_FORMAT.md`.
The final Phase 1c assets use **N=33** in **290.1 KiB** across 11 stocks. Exact pixel-pooled
natural-image error versus full `simulate()` is **0.2829 mean / 0.6140 p95 / 0.8296 p99 /
1.6896 maximum dE2000**; every stock passes the mean<1.0 and p95<3.0 criteria.
Python regeneration instructions are in `tools/README.md`.
