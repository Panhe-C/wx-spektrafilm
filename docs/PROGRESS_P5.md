# Phase 5 implementation progress

This log covers **Phase 5a** (spatial effects as approximate shaders: study, shaders, renderer
wiring, UI panel, harness), **Phase 5b** (full-resolution export: planner, renderer support, page
wiring, permission flow, harness) and **Phase 5c** (the contrast range, the share entries, the
release checklist). No git commit was made by the agent. Film modeling powered by
[spektrafilm](https://github.com/andreavolpato/spektrafilm).

## Milestone 0 — scope, baseline and the physics study first

- Read `AGENTS.md`, Phase 5 of `PLAN.md`, `docs/RENDERER.md`, `docs/ADJUSTMENTS.md`, `docs/UI.md`,
  the shared GLSL/JS, the page, the harness and `tools/pipeline_config.py`.
- Read spektrafilm's own implementation: `model/grain.py`, `model/glare.py`, `model/diffusion.py`
  (`apply_halation_um`), `runtime/params_schema.py` (`GrainParams`, `HalationParams`,
  `GlareParams`, `DiffusionFilterParams`), `runtime/params_builder.py` (`_HALATION_PRESETS`,
  `digest_params`), `runtime/stages/{filming,printing,scanning}.py`, `runtime/pipeline.py`,
  `runtime/services/resize.py` and the eleven film profiles.
- Established the pipeline order: halation + scatter act on the **exposure** before development,
  grain acts on the **CMY density** after development and before the print stage.
- Established that spektrafilm 0.3.4 uses **one global grain parameter set** for every stock, so
  the per-stock differences are a property of the density curves, not of per-stock particle
  parameters. The halation parameters *are* per stock, selected from the profile's
  `use`/`antihalation` tags.
- Baseline: 11 stock LUTs, LUT subpackage 1,063,412 bytes, main package 92,006 bytes, previously
  green Phase-4 harness.

## Milestone 1 — the physics study (`tools/study_effects.py`)

- Built a runtime parameter object that is identical to the shipped bake **except** that
  `lut_mode` is off, so the spatial and stochastic effects are active.
- Grain study: flat fields at 14 input levels, at the **reference output scale of 1280 px** on the
  long edge (spektrafilm derives the film-plane pixel size from the image size, so the grain
  statistics are only defined together with a scale). Grain on minus grain off gives the grain
  perturbation directly, because the physical RNG is reseeded per layer and is therefore identical
  in both runs.
- Measured per stock: the output level, the per-channel standard deviation in 8-bit codes, the
  spatial autocorrelation at lags (1,0), (2,0), (1,1) and the cross-channel correlation.
- Halation study: a bright disc (radius 40 px) on a dark background, halation on minus off, giving
  the radial profile per channel.
- All eleven stocks measured; the raw results are in `build/p5a/`, the committed summary in
  `docs/effects-physics.json`.

## Milestone 2 — the derived constants (`tools/derive_effects.py`)

- The grain amplitude curve per stock is the measured standard deviation versus the output level,
  normalised at the mid-tone and resampled on 17 evenly spaced levels.
- The grain colour mixing is the Cholesky factor of the measured mid-tone covariance matrix, so the
  shader reproduces the physical red/green/blue correlation.
- The halation constants are spektrafilm's own presets (`halation_first_sigma_um`,
  `halation_strength`), read from the film profiles.
- The **grain lattice spacing** could not be read off a formula: the sampled autocorrelation of a
  bilinear value-noise field is parabolic with a two-lattice-unit support, so the spacing is
  *fitted numerically* against the measured physical autocorrelation. The fit gives 1.60 px at the
  1280 px reference (`rho(1 px)` 0.5223 measured vs 0.5180 physical, `rho(1,1 px)` 0.2708 vs
  0.2693).
- The generated `utils/effects.js` is the single source of truth for the app, the harness and the
  NumPy mirror.

## Milestone 3 — the shaders

- `shaders/lut.frag.glsl` gained the frame-space uniforms, the grain, the halation and the
  vignette. The grain is a hash-based value noise (multiply-and-fract idiom, no transcendentals,
  no texture assets) on a lattice in normalised frame space, mixed by the measured covariance
  matrix and scaled by the measured amplitude curve.
- `shaders/halo.frag.glsl` is a new helper pass: an exposure pass (sRGB → linear, camera gain,
  two stops of headroom) and a nine-tap separable Gaussian blur. The kernel sigma is
  `sigma_h·sqrt(11/7)·longEdgePx/35000`, the equivalent of the physical three-bounce sum, and it is
  truncated at ±2 sigma.
- The halation is added to the **linear exposure before the LUT**, which is the physical position of
  the effect (before development), and the physical renormalisation
  `(exposure + a·bloom)/(1 + a)` is applied.
- The vignette acts on the linear exposure as well and is labelled non-physical.
- With every effect at strength 0 the shader keeps the exact Phase-4 path (the sRGB round trip is
  only taken when a camera adjustment, the halation or the vignette is active).

## Milestone 4 — renderer and UI

- `utils/lut-renderer.js` gained the halo program, two halo framebuffers, the effect state
  (`setEffects`/`getEffects`), the frame-space uniforms and the halo chain. `renderToPixels`
  accepts an `effects` override, which the preset thumbnails use to stay free of effects.
- The renderer now **fails loudly** when a required uniform is missing, which caught a real bug: a
  missing uniform would silently disable a feature.
- The page loads the halo shader, owns the effect state, and the 「效果」 panel exposes 颗粒,
  光晕 and 暗角 with their readouts. The 「重置」 button restores the adjustments **and** the
  effects; the effect panel has its own 「重置效果」.

## Milestone 5 — harness

- `harness/test-effects-unit.mjs` (pure model tests), `harness/test-effects.mjs` (browser) and
  `harness/effects_compare.py` (statistics, NumPy mirror, report) were added; `npm test` runs the
  effect suite after the Phase-3/4 suite.
- Checks: determinism (bit-identical repeats), identity at strength 0 against
  `tools/lut_apply.py`, scale invariance of the grain statistics, agreement with an independent
  NumPy implementation of the same grain maths, the halation radial profile against the physics
  study, the effect timing at 1280 px, and the physical halation reference on a real photograph.
- Two bugs were found by the harness itself: the grain matrix was uploaded with the `transpose`
  flag, which this WebGL1 implementation rejects with `INVALID_VALUE` (the matrix stayed zero and
  the grain silently disappeared), and the uniform-array lookup needed the `uGrainCurve[0]` name.

## Milestone 6 — measured results

- Grain: the shader's standard deviation matches the physical one by construction (the measured
  curve is the shader's lookup table). The measured autocorrelation of the rendered 8-bit image is
  0.455 / 0.236 / 0.048 at lags (1,0), (1,1), (2,0) against the physical 0.518 / 0.269 / 0.093;
  the difference is the 8-bit output quantisation, which adds white noise to the difference image.
- Scale invariance: the grain standard deviation is identical at 640×480 and 1280×960 (ratio
  1.0001 / 0.9993 / 1.0022) and the autocorrelation agrees at the common frame lags to 0.0016.
- NumPy mirror: the standard deviation ratio is 0.97 / 1.05 / 1.00 and the autocorrelation agrees
  to 0.0011, which confirms that the shader and the independent implementation compute the same
  field.
- Halation: the physical halation is dominated by the in-emulsion scatter (98 % of the energy),
  whose exponential kernel is 0.34 px wide at the preview scale and therefore degenerates into a
  one-pixel ring in the physical simulation. The shader implements the back-reflection halo only
  (4.6 % of the physical energy) and shows 0.32 code RMS against the physical 6.10 code RMS on the
  harness photograph. This is documented as divergence #5 in `docs/EFFECTS.md`.
- The halo buffer is a render target, so its row order is the opposite of the picture's; the
  exposure pass therefore writes it upside down. Without that flip the halation was mirrored
  vertically (it landed on the mirror image of every bright area). The harness now checks the
  orientation explicitly: the halo around a bright patch in the top-left corner must be at least
  three times stronger than around its mirror image in the bottom-right corner.

## Milestone 7 — documentation and sizes

- `docs/EFFECTS.md` documents the pipeline order, the per-stock parameters, the shader model, the
  physics-versus-shader tables and eight explicit divergences.
- `docs/RENDERER.md`, `docs/UI.md`, `docs/LIMITATIONS.md` and `README.md` were updated.
- Final full harness run: **PASS** — 66/66 default pairs, 11/11 intensity checks, 61/61
  adjustment pairs, 11/11 thumbnails (unchanged from Phase 4), plus the new effect suite:
  identity, determinism, scale invariance and the NumPy mirror all green.
- Effect timing at the 1280 px preview on SwiftShader: 36.3 ms without effects, 58.2 ms with the
  grain, 127.7 ms with the halation, 156.2 ms with both. These are headless software-rendering
  numbers, not phone timings.
- Main package 163,116 bytes (159.3 KiB); LUT subpackage 1,063,412 bytes (1038.5 KiB).

## Residual risks

- The halation is much weaker than the physical model on sharp, high-contrast edges, because the
  physical in-emulsion scatter term cannot be represented by a bilinear multi-tap kernel at the
  preview scale. The UI strength (0…2) compensates partially, but the *shape* differs.
- The physical grain statistics are only defined together with an output scale; the shader's
  frame-relative lattice is anchored at the 1280 px preview, so a 4096 px export shows a grain that
  is ~3.2× finer relative to the frame than a physical 4096 px simulation would.
- The effects have not been seen on a real device; only the headless SwiftShader path is verified.

---

# Phase 5b — full-resolution export

## Milestone 8 — the pure planner (`utils/export.js`)

- `planExport()` decides the export size (`min(original long side, 4096 px, GPU limits)`), the
  halation margin (`ceil(3·sigma) + 2` px at the export size, zero when the halation is off), the
  tile size (reduced when the GPU limit is small, so that the padded halo buffer still fits into a
  texture) and the tiles themselves. The tiles cover the picture exactly: no gap, no overlap.
- Every tile carries a renderer target with the frame-space rectangle, the uv mapping of the
  photo and the uv mapping of the padded halo buffer, so the planner is the single source of the
  geometry for the app, the harness and the browser test.

## Milestone 9 — the renderer renders a sub-rectangle

- The main shader samples the photo through `uImageUvOffset` + `uImageUvScale` instead of the
  identity mapping, and the frame position (`uRegionOrigin`/`uRegionSize`) is the global one, so
  the grain and the vignette are continuous across the tile borders.
- The renderer gained `renderRegionToPixels()`, which renders a rectangle of the picture into the
  offscreen framebuffer. The preview is the special case "the whole picture".
- The halation chain renders the **padded** rectangle (the tile plus the margin) and the main
  pass samples that buffer with `uHaloUvScale`/`uHaloUvOffset`, so every pixel of a tile only
  sees real picture content inside the kernel support.

## Milestone 10 — a real bug: the halation was mirrored vertically

- The first tiled run differed from the single-pass render by up to 11 codes, everywhere and not
  only at the tile borders. The cause: a render target has its row zero at the **bottom**, while
  the photo texture has its row zero at the **top**. The exposure pass of the halo chain wrote the
  picture upside down into the halo buffer, and the main pass read it mirrored — the halation was
  vertically flipped in the preview, and a tiled export would have mirrored it inside every tile.
- The fix: the exposure pass flips the vertical axis explicitly, so both buffers use the same uv
  convention. The harness now has a regression test (a bright patch in the top left corner: the
  halo has to grow around the patch, not around its mirror image; the ratio has to be ≥ 3).
- After the fix the tiled render matches the single-pass render within **1 code**.

## Milestone 11 — the page wiring and the permission flow

- The 「导出」 panel: an explanation, the 「保存到相册」 button, the stage text, a progress bar and
  a 「取消」 button. The stages are 解码 / 渲染 n/m / 编码 / 保存; the export yields to the event
  loop between the tiles.
- `utils/export-wechat.js` provides the WeChat host adapters (the offscreen 2D canvas, the
  offscreen WebGL canvas, the tile blit, the JPEG encoding with a fallback chain, the album save).
- The permission flow (`wx.getSetting` → `wx.authorize` → modal → `wx.openSetting`) is implemented
  in the pure module and is unit-tested with a mock `wx` in all five states (authorized, not
  asked, refused, denied + settings, cancelled), plus the save errors.

## Milestone 12 — the export harness

- `harness/test-export.mjs` (pure, Node): the size caps, the tile coverage and the margins, the
  permission flow, the orchestrator (the stage order, the cancellation, the release of the
  buffers, the failure messages).
- `harness/test-export-browser.mjs` (headless Chrome): the same picture rendered in one pass and
  in tiles at 3000×2000 with the grain, the halation and the vignette switched on, for a still
  film with 1024 px tiles (six tiles) and for a cinema film with 2048 px tiles (two tiles).

## Milestone 13 — the 5c fixes

- The post-LUT contrast now maps −1…1 onto a multiplier of **0.7 … 1.4** (identity at 0) instead
  of 0 … 2, which flattened the picture to grey at the slider minimum. The mapping lives in
  `utils/adjust.js::contrastMultiplier` and is used by the renderer and the unit tests.
- The page implements `onShareAppMessage()` and `onShareTimeline()` and calls
  `wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })`.
- `docs/RELEASE_TODO.md` lists what a release still needs (real AppID, privacy authorisation,
  service category, review materials, device tests).

# Phase 5 summary

- The harness is green: the Phase-3/4 suites (66/66 default pairs, 11/11 intensity checks, 61/61
  adjustment pairs, 11/11 thumbnails), the effect suite (identity, determinism, scale invariance,
  the NumPy mirror, the halation profile, the halation orientation) and the export suite (the
  planner, the permission flow, the tiled render versus the single-pass render).
- The final full run: worst default mean ΔE2000 **0.00052035**, worst default maximum
  **1.21046424**, worst adjustment mean **0.00044731**, worst adjustment maximum **1.20630550**;
  the median render/readback **30.9 ms**, the median thumbnail setLut+render+readback **1.2 ms**
  and the median full-preview stock switch **23.9 ms** (headless SwiftShader numbers).
- The export suite: the tiled render at 3000×2000 with the grain, the halation and the vignette
  switched on differs from the single-pass render by at most **1 code** (the 8-bit rounding of the
  halo buffer), with 1024 px tiles (six tiles) and with 2048 px tiles (two tiles), for a still and
  for a cinema film.
- The artifacts required by the plan exist: `harness/out/contact-effects.jpg`,
  `harness/out/grain-compare.jpg` (the 1:1 comparison of the physical `simulate()` grain with the
  shader grain on the same flat field and the same stock), `harness/out/contact-adjust.jpg` and
  the export renders in `harness/out/export/`.
- The main package is **164,582 bytes (160.7 KiB)** — far below the 2 MB budget — and the LUT
  subpackage is unchanged at **1,063,412 bytes (1038.5 KiB)**.
- The open risks are the real-device ones: the export memory peak, the offscreen WebGL canvas,
  `wx.canvasToTempFilePath` with an offscreen canvas, the album permission dialogs, the share
  menu, and the effect timing on a real GPU. They are listed in `docs/LIMITATIONS.md` and in the
  device checklist of `docs/UI.md`.
