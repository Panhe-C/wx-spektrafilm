# Phase 5 implementation progress

This log covers **Phase 5a** (spatial effects as approximate shaders: study, shaders, renderer
wiring, UI panel, harness). Phase 5b (export/share) and 5c (fixes and basics) are not part of this
log. No git commit was made by the agent. Film modeling powered by
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
  (4.6 % of the physical energy) and shows 0.78 code RMS against the physical 6.10 code RMS on the
  harness photograph. This is documented as divergence #5 in `docs/EFFECTS.md`.

## Milestone 7 — documentation and sizes

- `docs/EFFECTS.md` documents the pipeline order, the per-stock parameters, the shader model, the
  physics-versus-shader tables and eight explicit divergences.
- `docs/RENDERER.md`, `docs/UI.md`, `docs/LIMITATIONS.md` and `README.md` were updated.
- Main package 127,466 bytes (124.5 KiB); LUT subpackage 1,063,412 bytes (1038.5 KiB).

## Residual risks

- The halation is much weaker than the physical model on sharp, high-contrast edges, because the
  physical in-emulsion scatter term cannot be represented by a bilinear multi-tap kernel at the
  preview scale. The UI strength (0…2) compensates partially, but the *shape* differs.
- The physical grain statistics are only defined together with an output scale; the shader's
  frame-relative lattice is anchored at the 1280 px preview, so a 4096 px export shows a grain that
  is ~3.2× finer relative to the frame than a physical 4096 px simulation would.
- The effects have not been seen on a real device; only the headless SwiftShader path is verified.
- The Phase-5b tiled export still has to consume the frame-space uniforms and the halo margin
  (`Effects.halationMarginPixels`); the design is in place but the tiled path is not implemented.
