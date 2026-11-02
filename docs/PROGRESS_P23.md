# Phase 2 / Phase 3 implementation progress

This log records each milestone so an interrupted run can resume safely. No git commits were made.

## Milestone 1 — recovery and shared renderer

- Re-read `AGENTS.md` and `PLAN.md` Phases 2/3; inspected `git status`, renderer, shaders, utils,
  pages, and harness after interruption.
- Confirmed 11 LUTs: N=33, cols=8, rows=5, 264×165 RGB tiled PNGs.
- Added canonical WebGL1 / GLSL ES 1.0 sources in `shaders/lut.vert.glsl` and
  `shaders/lut.frag.glsl`.
- Added shared `utils/lut-renderer.js`: RGB888 uploads, LINEAR/CLAMP, no mipmaps, disabled
  dithering, full-screen draw, intensity mix, and common 1280/2048/max-texture sizing.
- Added the intentionally unimplemented `renderer/fallback2d.js` and `tools/embed_shaders.py`.

## Milestone 2 — shader embedding verified

- Generated committed `utils/shaders.js` directly from canonical GLSL.
- `tools/embed_shaders.py --check` and JS syntax checks pass.
- Common sizing returns 1280×854 for the 1600×1067 phone fixtures.
- Confirmed the Canvas2D fallback explicitly throws `not implemented`.

## Milestone 3 — Mini Program picker, preview, and LUT UI

- Added `utils/photo.js`: `wx.getImageInfo`, canvas decoding, all eight EXIF transforms,
  high-quality offscreen downscale, and JPEG/PNG validation.
- Replaced the placeholder with album/camera picking, visible cancellation/permission/decode
  errors, contain/letterboxed WebGL preview, loading states, lazy `wx.loadSubpackage`, stock list,
  LUT image cache, intensity slider, hold-to-compare, and clear/reset.
- Registered asset-only `subpackages/luts` in `app.json` and added the dark full-screen UI.
- Relevant JSON parsing, JS syntax, and orientation-matrix smoke tests passed. WeChat/real-device
  behaviour remained unverified.

## Milestone 4 — headless smoke and static checks

- Added Puppeteer/SwiftShader harness files and `npm test` / `test:smoke` scripts. The harness
  exports exact browser-downscaled inputs, reuses the shared renderer and raw GLSL, writes
  shader/Python/16× diff images, and generates JSON/Markdown reports and a contact sheet.
- Smoke `portra400/p1015`: mean ΔE2000 0.000294, max 1.184097; intensity 0 exact and 0.5 within
  one code. Timing with draw, `gl.finish()`, and one-pixel readback was 10.7 ms.
- `tools/check_miniprogram.py` passed JSON/page/runtime-import/shader/geometry/package checks;
  `miniprogram-ci` is intentionally skipped because it needs an AppID/private key.

## Milestone 5 — documentation

- Added `docs/RENDERER.md` (source workflow, sizing, textures, uniforms, exact trilinear and
  half-texel derivation, sRGB contract, harness, timing, estimated performance, fallback).
- Added `docs/ORIENTATION.md` (eight transforms, one-pass resize, V handling, contain geometry,
  WeChat decoder quirks).
- Updated `docs/LIMITATIONS.md` and `README.md` for usage, verification, excluded effects, and the
  DevTools/physical-device verification boundary.

## Milestone 6 — initial full 11 × 6 matrix green

- Full `npm test`: 66/66 pairs and 11/11 intensity checks passed under ANGLE/SwiftShader.
- Worst mean ΔE2000 0.0005203500 (`velvia100/p237`); worst max 1.2104642391
  (`portra160/p1015`); worst mean absolute error 0.0003509831 code.
- Median render/readback 9.85 ms. Intensity 0 was exact; intensity 0.5 stayed within one code.
- Contact sheet `harness/out/contact-shader.jpg` visually checked as upright, non-black, and
  distinct across Portra 400, Gold 200, and Velvia 100.

## Milestone 7 — final-source robustness review

- Fixed preview layout sequencing: controls are rendered before stage measurement, with generation
  checks after asynchronous steps, preventing a fit to the larger empty-state stage.
- Made UV varying precision follow the host default so the mediump fragment fallback is valid.
- Regenerated `utils/shaders.js`; embedding and page syntax checks passed.
- No LUT/profile files or test photos were modified. Started a final full run on these sources.

## Milestone 8 — final verification complete

- Final-source full harness: **PASS, 66/66 pairs and 11/11 intensity checks**.
- Worst mean ΔE2000 **0.0005203500**; worst max **1.2104642391**; worst mean absolute 8-bit error
  **0.0003509831 code**; median render/readback **9.90 ms**.
- Intensity 0 maximum code error **0**; intensity 0.5 maximum code error **1**, worst max ΔE2000
  **1.2306481600**.
- Verified 66 shader PNGs, 66 Python PNGs, 66 amplified diff PNGs, full-scope reports, and
  `contact-shader.jpg` (349,179 bytes).
- Post-harness static checks: **PASS**. Main package **32,245 bytes / 31.5 KiB**; LUT subpackage
  **297,046 bytes / 290.1 KiB**. Nine source JSON files parse, page/LUT geometry pass, shader
  embedding is current, and runtime code has no Node-builtin imports.
- Runtime/harness JavaScript passed `node --check`; Python tooling passed `py_compile`.
- Final artifacts: `harness/out/report.md`, `harness/out/report.json`, and
  `harness/out/contact-shader.jpg` (all gitignored). Test photos remain outside the repository.
