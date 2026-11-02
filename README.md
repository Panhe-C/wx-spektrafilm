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

## Presets and adjustments

- **Preset picker** grouped into 彩色负片 / 反转片（幻灯片）/ 电影胶片. Every card shows the
  stock name, its ISO speed, one Chinese line about the stock, and a thumbnail rendered from the
  current photo at a 96 px long edge.
- **Thumbnails** are generated lazily — the selected stock first, then the cards that scroll into
  view, then the rest — cached per photo and stock, invalidated on a new photo, and never
  regenerated while a slider moves. If every export route fails, the card shows a coloured
  placeholder instead of a broken image.
- **Adjustments panel**: 曝光 EV (−2…+2), 色温, 色调, 强度, and a collapsed 「后期微调（非胶片物理）」
  group with 对比度 and 饱和度. One 「重置」 button restores all of them.
- **Effects panel (「效果」)**: 颗粒 (grain), 光晕 (halation) and 暗角 (vignette). The grain and the
  halation are approximations whose constants are measured from spektrafilm's full `simulate()`
  pipeline; the vignette is explicitly non-physical. The panel has its own 「重置效果」 button, and
  the global 「重置」 restores the adjustments and the effects together. The preset thumbnails never
  include the effects.
- **About section**: the spektrafilm credit (Andrea Volpato), the project URL, the licence split
  (GPLv3 code, CC BY-SA 4.0 LUT data), the version, and the note that the grain and the halation
  are approximations and that diffusion filters, glare and sharpening are still missing.
- The page structure, the phase state machine, the thumbnail path and the real-device checklist
  are documented in `docs/UI.md`.

## Adjustments (physics and model)

The renderer exposes a verified adjustment path: camera-side exposure EV (−2…+2), white balance
(temperature and tint, −100…+100 each), and clearly non-physical post-LUT contrast/saturation.
Exposure and white balance are physically faithful: they are camera-side operations applied in
linear light before the film LUT, and they are validated against full spektrafilm `simulate()`
references. See `docs/ADJUSTMENTS.md` for the model and `docs/EXPOSURE_EV.md` for the measurements
and the candidate decision.

The base cube `<id>.png` and the extended two-stop cube `<id>.ev2.png` are both cached, but the
extended cube is only fetched when a positive EV or a nonidentity white balance actually needs
it.

## Spatial effects (grain, halation, vignette)

Phase 5a adds approximate spatial effects on top of the LUT. The constants are not hand tuned:
`tools/study_effects.py` measures the grain statistics and the halation profile of the full
spektrafilm `simulate()` pipeline, and `tools/derive_effects.py` turns those measurements into the
shared model in `utils/effects.js`.

- **Grain** is a deterministic hash-based value-noise field on a lattice in the normalised frame
  space, so the preview (1280 px) and a full-resolution export show the same grain relative to the
  picture. Its amplitude follows the measured grain-versus-level curve of the stock, and its
  red/green/blue correlation follows the measured mid-tone covariance.
- **Halation** is a red-weighted highlight bloom: the linear exposure is blurred with the
  frame-relative physical sigma (65 µm for a still film, 50 µm for a cinema film) and added back
  with the stock's physical `halation_strength`, before the LUT, exactly where the physical
  pipeline applies it.
- **Vignette** is a simple radial falloff on the linear exposure and is labelled non-physical.
- With every effect at strength 0 the output is bit-identical to the Phase-4 path.

`docs/EFFECTS.md` documents the pipeline order, the per-stock parameters, the physics-versus-shader
tables and the eight explicit divergences (the largest one: the physical in-emulsion scatter term
is sub-pixel at the preview scale and cannot be reproduced by a multi-tap WebGL kernel).

## Verification

```sh
# JSON/page/runtime-import/shader/WXML/WXSS/package-size checks (no AppID required)
python3 tools/check_miniprogram.py

# EXIF, adjustment, UI-state and page-wiring unit tests, then the full Chrome/SwiftShader versus NumPy comparison
cd harness
npm i
npm test

# Optional: re-run the physical EV/WB faithfulness study against full simulate()
npm run study:ev

# Optional: re-run the physical grain/halation study and regenerate the effect constants
npm run study:effects
```

The harness expects `/workspace/testphotos/p*.jpg`, Chrome at `/usr/bin/google-chrome`, and the
Python scientific environment described in `docs/RENDERER.md`. It runs the orientation policy and
matrix unit tests, the adjustment-mapping unit tests, the UI-state unit tests, the effect-model unit
tests, and the page-wiring tests before launching Chrome. It writes `harness/out/report.{json,md}`, per-pair shader/Python/diff PNGs, per-adjustment
PNGs, thumbnails, `harness/out/contact-{shader,adjust,thumbs}.jpg`, and — from the spatial-effect
suite — `harness/out/contact-effects.jpg`, `harness/out/grain-compare.jpg` and
`harness/out/effects-report.{json,md}`. Outputs and test photos
are not committed. A real AppID/private key would be needed for `miniprogram-ci`; static and
headless checks do not replace WeChat DevTools or physical-device testing.

The final on-box full run passed **66/66 default pairs**, **11/11 intensity checks**, **61/61
adjustment pairs**, and **11/11 thumbnails**. Worst default mean ΔE2000 was **0.00052035**, worst
default maximum **1.21046424**, worst adjustment mean **0.00044731**, and worst adjustment maximum
**1.22417927**. Median render/readback was **18.55 ms**, median thumbnail setLut+render+readback
**1.20 ms**, and median full-preview stock switch **18.20 ms**. The generated `harness/out/report.md`
contains the per-stock and per-photo tables. These are headless measurements, not phone timings.

## Layout

- `app.js`, `app.json`, `app.wxss` — Mini Program entry
- `pages/` — native picker, preset picker, adjustments panel and about page
- `utils/`, `renderer/` — shared WebGL renderer, adjustment mapping, spatial-effect model, UI state policy, thumbnail export, generated GLSL module, photo preparation, fallback stub
- `shaders/` — canonical WebGL1 GLSL sources shared with the headless harness
- `subpackages/luts/` — lazily loaded LUTs/manifest plus the required no-op subpackage page
- `harness/` — Puppeteer/Chrome and NumPy numerical verification (not shipped in the app)
- `tools/` — Python LUT tooling and static Mini Program checks (uses `/workspace/venv-sf`)
- `assets/` — other static assets
- `docs/` — format, renderer, adjustments, effects, UI, orientation, exposure, limitations, validation, and previews

## Film LUT scope

The LUTs reproduce spektrafilm's deterministic physical colour pipeline for display-referred
sRGB phone photos. Baking and validation use one shared parameter builder and one global recipe;
there is no ad-hoc post-simulation tone or levels curve. See `docs/EXPOSURE.md` for the measured
exposure choice and `docs/validation.md` for LUT-versus-full-`simulate()` fidelity.

A static LUT excludes grain, halation/scatter, diffusion filters, lens/scan blur, glare, scanner
unsharp masking, DIR-coupler spatial diffusion, and all other spatial or stochastic effects.
Phase 5a implements the grain, the halation and the vignette as **separate** WebGL effects on top
of the LUT, not hidden inside the colour tables; diffusion filters, glare and sharpening remain
unimplemented. `docs/LIMITATIONS.md` details this boundary and the exposure/tonality trade-offs.

The tiled-grid PNG layout and shader half-texel/trilinear contract are in `docs/LUT_FORMAT.md`.
The shipped assets use **N=33** for the native look plus an **N=49** two-stop extended-range cube
per stock, in **1038.5 KiB** total across 11 stocks (budget 1,200,000 bytes). Exact pixel-pooled
natural-image error versus full `simulate()` is **0.2829 mean / 0.6140 p95 / 0.8296 p99 /
1.6896 maximum dE2000**; every stock passes the mean<1.0 and p95<3.0 criteria. The camera-side
EV and white-balance paths measure **0.1479–0.1882 mean / 0.3219–0.3966 p95 dE2000** over the
whole −2…+2 EV range and **0.1410–0.1670 mean** over the measured white-balance settings.
Python regeneration instructions are in `tools/README.md`.
