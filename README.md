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
The picker requests `sizeType: ['original']`, and the decoded Image's natural dimensions are the
geometry authority: the offscreen decode canvas receives the **whole** picture through an explicit
source-rectangle → destination-rectangle mapping, never a magnified top-left crop.
Photo and LUT sources prefer validated RGBA-byte uploads, with an automatic direct-source fallback;
this avoids the silent black offscreen-canvas upload seen in the iPhone report. The native preview
canvas always fills a stable stage, uses a stage-CSS×DPR drawing buffer, renders the photo through a
centred aspect-fit GL viewport, and schedules presentation in the canvas node's rAF.
The LUT PNGs and manifests ship in the **main package** under `subpackages/luts/` (the directory name is
kept only for path stability). After the first pick, `ensureLuts()` loads the local CommonJS manifest
synchronously; there is no `wx.loadSubpackage` step or LUT-package network dependency. Decoded LUTs
are cached in memory. See `docs/RENDERER.md` and `docs/ORIENTATION.md` for implementation details and
`docs/LIMITATIONS.md` for the real-device verification boundary.

## Presets and adjustments

- **Preset picker** grouped into 彩色负片 / 反转片（幻灯片）/ 电影胶片. Every card shows the
  stock name, its ISO speed, one Chinese line about the stock, and a fixed **16:9 centre-cropped**
  thumbnail (96×54 FBO render, `<image mode="aspectFill">`, no letterbox bars or squeezing).
- **Thumbnails** are generated lazily — the selected stock first, then the cards that scroll into
  view, then the rest — cached per photo and stock, invalidated on a new photo, and never
  regenerated while a slider moves. If every export route fails, the card shows a coloured
  placeholder instead of a broken image.
- **Adjustments panel**: 曝光 EV (−2…+2), 色温, 色调, 强度, and a collapsed 「后期微调（非胶片物理）」
  group with 对比度 (a multiplier of 0.7…1.4, identity at 0) and 饱和度. One 「重置」 button
  restores all of them.
- **Effects panel (「效果」)**: 颗粒 (grain), 光晕 (halation) and 暗角 (vignette). The grain and the
  halation are approximations whose constants are measured from spektrafilm's full `simulate()`
  pipeline; the vignette is explicitly non-physical. The panel has its own 「重置效果」 button, and
  the global 「重置」 restores the adjustments and the effects together. The preset thumbnails never
  include the effects.
- **About section**: the spektrafilm credit (Andrea Volpato), the project URL, the licence split
  (GPLv3 code, CC BY-SA 4.0 LUT data), the version, and the note that the grain and the halation
  are approximations and that diffusion filters, glare and sharpening are still missing. Its hidden
  **诊断** entry (also available by long-pressing the title) runs and copies on-device GL/upload
  diagnostics; see `docs/DEVICE_DEBUG.md`.
- The page structure, the phase state machine, the thumbnail path and the real-device checklist
  are documented in `docs/UI.md`.

## Full-resolution export

The 「导出」 panel saves the picture with the current look at the original resolution:

- the export size is `min(original long side, 4096 px, the GPU limits)`; the original file is
  never modified;
- the picture is rendered in tiles, so the grain, the halation and the vignette are continuous
  across the tile borders — the tiled render is verified against a single-pass render in the
  harness (maximum difference: 1 code);
- the stages (解码 / 渲染 n/m / 编码 / 保存) are shown with a progress bar and a cancel button;
- every platform call runs inside a timeout wrapper (8 s by default): a WeChat call that never
  answers can no longer freeze the export — the panel reports the step, the elapsed time and the
  last raw answer, and offers a retry and 「打开设置」;
- the privacy guide is confirmed in an in-app popup whose 「同意」 button is a real
  `<button open-type="agreePrivacyAuthorization">`; the album scope is not asked for in advance
  any more (the export calls `wx.saveImageToPhotosAlbum` directly and recovers from an auth-deny
  error with the settings);
- the result is a JPEG (quality 0.92) in the system photo album.

`docs/EXPORT.md` documents the pipeline, the tile planner, the permission flow and the memory
budget. `docs/PRIVACY.md` documents the privacy authorisation, the console configuration and the
diagnostics of a failed export. `docs/RELEASE_TODO.md` lists what a release still needs (real
AppID, privacy authorisation, review materials, device tests).

## Film borders (胶片边框)

The 「边框」 tab frames the picture with a thin white border, a Polaroid-style white border, a black
border, a 35mm film strip (sprocket holes, orange edge print with the current preset's name, frame
number and arrows) or a 120 film frame (a thin irregular black film edge around the uncropped photo with the preset name in amber). The border is composited **after** the film look and is
never graded or grained; it is visible in the live preview and baked into the saved file (the framed
file stays within the 4096 px long edge). It is plain Canvas 2D drawing on-device. Details and the
real-device checklist: `docs/BORDER.md`.

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
tests, the export unit tests (the planner and the permission flow with a mock `wx`) and the
page-wiring and pure diagnostics-formatter tests before launching Chrome. The browser upload suite
forces both RGBA-byte (P) and direct-source (D) paths, compares full output within one code, injects
GPU-zero and zero-`getImageData()` photo/LUT cases to verify suspect-decode fallback and the
photo-only all-black outcome, and asserts the same solid/photo/LUT/full-shader probes exposed on
device. The presentation suite checks portrait/EXIF-oriented inputs, DPR-2 and clamped buffers,
default-framebuffer-versus-FBO samples with all effects, exact letterbox colour, and fixed-aspect
thumbnail crops. Reports go to `harness/out/diagnostics/report.{json,txt}` and
`harness/out/presentation/report.json`. The main harness writes `harness/out/report.{json,md}`, per-pair shader/Python/diff PNGs, per-adjustment
PNGs, thumbnails, `harness/out/contact-{shader,adjust,thumbs}.jpg`, and — from the spatial-effect
suite — `harness/out/contact-effects.jpg`, `harness/out/grain-compare.jpg` and
`harness/out/effects-report.{json,md}`, and — from the export suite —
`harness/out/export/*.png`. Outputs and test photos
are not committed. A real AppID/private key would be needed for `miniprogram-ci`; static and
headless checks do not replace WeChat DevTools or physical-device testing.

The final on-box full run passed **66/66 default pairs**, **11/11 intensity checks**, **61/61
adjustment pairs**, and **11/11 thumbnails**. Worst default mean ΔE2000 was **0.00052035**, worst
default maximum **1.21046424**, worst adjustment mean **0.00044731**, and worst adjustment maximum
**1.20630550**. Median render/readback was **33.05 ms**, median thumbnail setLut+render+readback
**1.90 ms**, and median full-preview stock switch **24.40 ms**. The upload/diagnostic suite also
passed: P versus D differed by **0 codes over 6,144 pixels**, injected zero photo/LUT uploads fell
back to P, solid colour was exact, and photo/LUT probes were **0-code** maxima. All three
portrait/DPR/clamped presentation cases had **0-code default-versus-FBO maxima** and exact #080808
letterboxes. The generated `harness/out/report.md`
contains the per-stock and per-photo tables. These are headless measurements, not phone timings.

The border suites (`harness/test-border.mjs`, `harness/test-border-browser.mjs`) check the layout
for portrait/landscape/square/panorama pictures, the export plan within 4096 px, the preview
rectangles, the painter geometry, and — in Chrome with the real renderer — that the framed export
leaves the graded picture bit-identical and covers every other pixel of the file.

The effect suite (identity at strength 0, determinism, scale invariance, the NumPy mirror, the
halation profile, the halation orientation) and the export suite (the tile planner, the album
permission flow with a mock `wx`, and the tiled render versus the single-pass render at
3000×2000 with every effect on — at most **1 code** of difference) are green as well.

## Layout

- `app.js`, `app.json`, `app.wxss` — Mini Program entry
- `pages/` — native picker, preset picker, adjustments panel and about page
- `utils/`, `renderer/` — shared WebGL renderer, film-border layout and painter (`utils/border.js`), robust P/D uploads, diagnostics, adjustment mapping, spatial-effect model, UI state policy, thumbnail export, generated GLSL module, photo preparation, export planner and WeChat export host, fallback stub
- `shaders/` — canonical WebGL1 GLSL sources shared with the headless harness
- `subpackages/luts/` — main-package LUT PNGs plus generated, synchronized `luts.js` / `luts.json` manifests
- `harness/` — Puppeteer/Chrome and NumPy numerical verification (not shipped in the app)
- `tools/` — Python LUT tooling and static Mini Program checks (uses `/workspace/venv-sf`)
- `assets/` — other static assets
- `docs/` — format, renderer, adjustments, effects, export, privacy, UI, orientation, exposure, limitations, release checklist, validation, and previews

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
per stock, in **1,069,130 bytes (1044.1 KiB)** for the complete LUT folder including both generated
manifests (asset budget 1,200,000 bytes). These assets are included in the **1,325,424-byte
(1294.4 KiB) main package**, below the 2 MiB limit. Exact pixel-pooled
natural-image error versus full `simulate()` is **0.2829 mean / 0.6140 p95 / 0.8296 p99 /
1.6896 maximum dE2000**; every stock passes the mean<1.0 and p95<3.0 criteria. The camera-side
EV and white-balance paths measure **0.1479–0.1882 mean / 0.3219–0.3966 p95 dE2000** over the
whole −2…+2 EV range and **0.1410–0.1670 mean** over the measured white-balance settings.
Python regeneration instructions are in `tools/README.md`.
