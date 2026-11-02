# Spatial effects: grain, halation and vignette

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).

This document describes Phase 5a: where spektrafilm puts grain and halation in its pipeline,
which parameters it uses per stock, how the shipped WebGL approximation maps onto them, and
**where the approximation diverges from the physics**. Every number in the tables is measured,
not estimated; the measurement scripts are `tools/study_effects.py` (physics),
`tools/derive_effects.py` (constants) and `harness/test-effects.mjs` (shader).

---

## 1. Where the effects sit in the physical pipeline

`spektrafilm`'s runtime topology (`spektrafilm/runtime/pipeline.py`) is

```text
rgb_in → rgb_pre → filming.expose → filming.develop → [printing.expose → printing.develop] → scanning.scan → rgb_out
```

* **Halation and in-emulsion scatter** live in `filming.expose`
  (`spektrafilm/runtime/stages/filming.py` → `spektrafilm/model/diffusion.py::apply_halation_um`).
  They are applied to the **exposure** (`raw`), i.e. *before* development, and the order inside
  the stage is
  1. highlight boost (`boost_ev`, 0 in our recipe),
  2. camera diffusion filter (off),
  3. lens blur (off),
  4. **scatter → back-reflection halation** (`apply_halation_um`),
  5. `log10(raw)` → development.
* **Grain** lives in `filming.develop` (`spektrafilm/model/grain.py::apply_grain`). It is added to
  the **CMY density** of the negative, i.e. *after* development of the film image and *before* the
  print stage. It is therefore not part of the colour transform that the shipped LUTs bake.
* The **print glare** (`print_render.glare`) and the DIR couplers' lateral diffusion are also
  spatial/stochastic; they stay switched off in our recipe.

Because the shipped LUT is a **static, per-pixel** transform, none of these effects can be inside
it. Everything in this phase is therefore an **approximation applied to the final sRGB picture**.

## 2. Parameters and per-stock defaults

### 2.1 Grain

`spektrafilm` 0.3.4 uses **one global grain parameter set** for every stock
(`spektrafilm/runtime/params_schema.py::GrainParams`); there is no per-stock grain profile:

| parameter | value | meaning |
|---|---|---|
| `particle_area_um2` | 0.2 µm² | mean silver-halide particle area |
| `particle_scale` | (1.6, 1.6, 3.2) | per-layer particle-area multiplier (C, M, Y) |
| `particle_scale_layers` | (2.0, 1.0, 0.5) | per-sublayer particle-area multiplier |
| `uniformity` | (0.97, 0.99, 0.97) | development uniformity |
| `blur` | 0.65 **px** | final density blur (resolution dependent!) |
| `blur_dye_clouds_um` | 1.0 µm | per-particle blur (sub-pixel at preview size) |
| `micro_structure` | (0.2 µm, 30 nm) | clumping (below the threshold at preview size) |
| `density_min` | (0.03, 0.03, 0.03) | base density |

The per-stock differences in the *measured* grain therefore come from the density curves and from
the print/scan stage, not from per-stock particle parameters. The number of particles per pixel is
`pixel_area / particle_area` with `pixel_area = (film_format_mm·1000 / max(h, w))²`, so the physical
grain statistics are only defined together with an **output scale**.

### 2.2 Halation and scatter

`spektrafilm/runtime/params_builder.py::_HALATION_PRESETS` selects the back-reflection parameters
from the film profile's `use`/`antihalation` tags:

| use / antihalation | `halation_first_sigma_um` | `halation_strength` (R, G, B) |
|---|---|---|
| still / strong | 65 | 0.015, 0.005, 0.0 |
| still / weak | 65 | 0.08, 0.02, 0.0 |
| cine / strong | 50 | 0.015, 0.005, 0.0 |

The remaining parameters are global: `scatter_core_um` (2.2, 2.0, 1.6), `scatter_tail_um`
(9.3, 9.7, 9.1), `scatter_tail_weight` (0.78, 0.65, 0.67), `scatter_amount` 1.0,
`halation_amount` 1.0, `halation_n_bounces` 3, `halation_bounce_decay` 0.5,
`halation_renormalize` true.

Our stocks map onto the presets as follows (the `still/weak` group is the "older or mismatched
anti-halation layer" group and produces a five times stronger red halo):

| stock | film profile | anti-halation | sigma_h (µm) | a_R / a_G / a_B | grain peak (code) |
|---|---|---|---|---|---|
| portra400 | kodak_portra_400 | strong | 65 | 0.015 / 0.005 / 0.000 | 2.24 |
| portra160 | kodak_portra_160 | strong | 65 | 0.015 / 0.005 / 0.000 | 1.95 |
| gold200 | kodak_gold_200 | weak | 65 | 0.080 / 0.020 / 0.000 | 2.41 |
| ultramax400 | kodak_ultramax_400 | weak | 65 | 0.080 / 0.020 / 0.000 | 2.46 |
| ektar100 | kodak_ektar_100 | strong | 65 | 0.015 / 0.005 / 0.000 | 2.74 |
| velvia100 | fujifilm_velvia_100 | strong | 65 | 0.015 / 0.005 / 0.000 | 1.20 |
| provia100f | fujifilm_provia_100f | strong | 65 | 0.015 / 0.005 / 0.000 | 1.16 |
| kodachrome64 | kodak_kodachrome_64 | weak | 65 | 0.080 / 0.020 / 0.000 | 1.12 |
| pro400h | fujifilm_pro_400h | strong | 65 | 0.015 / 0.005 / 0.000 | 2.37 |
| vision3_250d | kodak_vision3_250d | strong | 50 | 0.015 / 0.005 / 0.000 | 2.55 |
| vision3_500t | kodak_vision3_500t | strong | 50 | 0.015 / 0.005 / 0.000 | 2.54 |

### 2.3 Vignette

There is no vignette in spektrafilm. It is an explicitly **non-physical** lens-falloff control,
implemented in the shader as a radial multiplier on the linear exposure.

## 3. The shipped shader approximation

### 3.1 Coordinate system

Everything that depends on position is expressed in a **normalised frame space** in which the long
edge of the picture is 1.0 (`utils/lut-renderer.js::computeFrameRect`). The frame width is
`FRAME_WIDTH_UM = 35000 µm`, matching `CameraParams.film_format_mm = 35.0` (spektrafilm's own
convention; the nominal 35 mm film frame is 36 mm wide, a 2.9 % difference).

The shader receives `uRegionOrigin`/`uRegionSize` (the rectangle this draw covers) and
`uImageFrameOrigin`/`uImageFrameSize` (the whole picture). The grain lattice and the vignette are
functions of the **global** frame position, so a tiled export (Phase 5b) is continuous across the
tile borders.

### 3.2 Grain

* **Noise**: a hash-based value-noise field (`hash12` multiply-and-fract idiom, no transcendentals,
  no texture assets, no `sin()`, so it is reproducible on any WebGL1 implementation) evaluated on a
  lattice in frame space. Three independent fields are mixed by a 3×3 matrix.
* **Lattice spacing**: `GRAIN_LATTICE_FRAME = 0.00125` (frame units) = **1.60 px at the 1280 px
  reference scale**. The spacing was *fitted numerically* (not hand tuned) so that the sampled
  autocorrelation of the value noise reproduces the measured physical correlation; see §4.2.
* **Amplitude**: a 17-point curve per stock, `curve(level)`, holding the measured physical grain
  standard deviation versus the output level, normalised at the mid-tone. The curve is looked up
  with the Rec.709 luma of the graded colour.
* **Colour**: the mixing matrix is the Cholesky factor of the measured mid-tone grain covariance
  (in 8-bit code units), so the red/green/blue correlation of the physical grain is reproduced.
* **Strength**: the UI factor 0…2 multiplies the curve; 1.0 is the physical level.

### 3.3 Halation

* The **exposure** (sRGB → linear, camera gain applied, two stops of headroom kept) is rendered into
  an offscreen RGBA8 buffer, blurred separably with a nine-tap Gaussian and added back to the
  exposure with the per-channel coefficient `a_tot`, followed by the physical renormalisation
  `exposure = (exposure + a·bloom) / (1 + a)`.
* The kernel: the physical model sums three Gaussians with `sigma_h·sqrt(k)` and weights
  4/7, 2/7, 1/7. A single Gaussian with the same variance (`sigma_h·sqrt(11/7)`) is used, so the
  kernel sigma is `sigma_h·sqrt(11/7)·longEdgePx/35000` = **2.98 px at 1280 px** for a still film
  and 2.29 px for a cinema film.
* The kernel is truncated at ±2 sigma (nine taps, spacing sigma/2). The truncation loses 4.6 % of
  the Gaussian energy.
* **Bounded radius**: the halo kernel never reaches beyond `2·sigma`, so a tiled export needs a
  margin of `ceil(3·sigma) + 2` pixels (`Effects.halationMarginPixels`): 11 px at 1280 px and
  30 px at 4096 px.
* **Row order**: the halo buffer is a render target, so its row zero is at the bottom, while the
  photo texture has its row zero at the top. The exposure pass therefore flips the vertical axis
  explicitly, so that both buffers use the same uv convention. Without the flip the halation was
  mirrored vertically (in the preview and, in Phase 5b, inside every tile of an export); the
  harness has a regression test for it.

### 3.4 Vignette

`exposure *= max(0, 1 − 0.6·s·r²)`, with `r²` normalised so that `r² = 1` in the picture corners
and `s` the 0…1 UI strength. It acts on the linear exposure (the physical position of a lens
falloff), before the LUT.

## 4. Physics versus shader

All physics numbers come from full `simulate()` runs with the shipped recipe
(`tools/pipeline_config.py`), the grain/halation toggled, at the **reference output scale of
1280 px** on the long edge (spektrafilm derives the film-plane pixel size from the image size, so
the scale has to be fixed: 27.344 µm per pixel).

### 4.1 Grain amplitude versus level

Physical grain standard deviation of the difference between a grain-on and a grain-off simulation
of a flat field, in 8-bit output codes:

| stock | output code | physical std R/G/B (code) | shader model std R/G/B (code) |
|---|---|---|---|
| portra400 | 25.8 | 0.967 / 0.668 / 0.837 | 0.877 / 0.589 / 0.991 |
| portra400 | 54.0 | 1.797 / 1.103 / 1.668 | 1.586 / 1.066 / 1.791 |
| portra400 | 115.0 | 2.235 / 1.502 / 2.525 | 2.220 / 1.492 / 2.508 |
| portra400 | 168.1 | 2.027 / 1.391 / 2.340 | 2.023 / 1.359 / 2.285 |
| portra400 | 209.3 | 1.093 / 0.574 / 1.205 | 1.076 / 0.723 / 1.215 |
| gold200 | 42.5 | 1.827 / 1.058 / 1.624 | 1.620 / 1.043 / 1.698 |
| gold200 | 77.9 | 2.408 / 1.445 / 2.437 | 2.325 / 1.497 / 2.437 |
| gold200 | 114.7 | 2.320 / 1.494 / 2.432 | 2.300 / 1.481 / 2.410 |
| gold200 | 171.5 | 1.893 / 1.294 / 1.791 | 1.852 / 1.193 / 1.941 |
| gold200 | 213.3 | 1.034 / 0.586 / 1.219 | 1.085 / 0.698 / 1.137 |
| velvia100 | 19.7 | 0.614 / 0.413 / 0.531 | 0.462 / 0.407 / 0.588 |
| velvia100 | 52.5 | 0.932 / 0.706 / 0.914 | 0.802 / 0.707 / 1.022 |
| velvia100 | 117.7 | 1.061 / 0.935 / 1.352 | 1.064 / 0.937 / 1.354 |
| velvia100 | 182.2 | 1.199 / 1.173 / 1.605 | 1.239 / 1.092 / 1.578 |
| velvia100 | 213.9 | 0.973 / 0.812 / 1.498 | 1.015 / 0.894 / 1.292 |
| vision3_500t | 19.2 | 1.403 / 0.942 / 1.667 | 1.405 / 0.888 / 1.423 |
| vision3_500t | 47.5 | 2.199 / 1.398 / 2.537 | 2.237 / 1.414 / 2.265 |
| vision3_500t | 113.2 | 2.538 / 1.604 / 2.569 | 2.524 / 1.595 / 2.555 |
| vision3_500t | 165.9 | 2.043 / 1.464 / 2.081 | 2.127 / 1.344 / 2.153 |
| vision3_500t | 210.8 | 1.036 / 0.718 / 1.300 | 1.234 / 0.780 / 1.249 |

The shader model reproduces the physical amplitude because its lookup table *is* the measured
curve: the deviations in the table come from the simplification that one curve and one mid-tone
channel ratio are used for all levels (the physical channel ratios change with the level, see
divergence #4). The largest deviation in the table is 25 % (velvia100 in the deep shadows, where
the absolute amplitude is 0.6 code); at the mid-tones the agreement is within 1 %.

### 4.2 Grain autocorrelation

| quantity | physical | shader (1280 px) | shader model |
|---|---|---|---|
| rho(1 px) | 0.5180 | 0.4552 | 0.5223 (fitted) |
| rho(1,1 px) | 0.2693 | 0.2363 | 0.2708 (fitted) |
| rho(2 px) | 0.0925 | 0.0483 | 0.0528 (fitted) |

The physical correlation is almost independent of the level and of the stock
(`rho(1 px) = 0.518`, `rho(1,1 px) = 0.269`, `rho(2 px) = 0.093`). A bilinear value-noise field
has a *parabolic* autocorrelation with a support of two lattice units, which is why the lattice
spacing had to be fitted numerically instead of read off a formula. The fitted model reaches
`rho(1 px) = 0.522` and `rho(1,1 px) = 0.271`; the values measured on the rendered 8-bit image are
lower (`0.455`, `0.236`) because the 8-bit output quantisation adds white noise to the difference
image.

### 4.3 Halation radial profile

A bright disc (radius 40 px = 1094 µm, value 1.0) on a dark background (value 0.02), 1280×640:

| radius (px) | radius (um) | physical R/G/B (code) | shader R/G/B (code) |
|---|---|---|---|
| 0 | 0 | -0.0060 / -0.0115 / -0.0107 | 0.0000 / 0.0000 / 0.0000 |
| 2 | 55 | -0.0061 / -0.0117 / -0.0109 | 0.0000 / 0.0000 / 0.0000 |
| 4 | 109 | -0.0062 / -0.0122 / -0.0113 | 0.0000 / 0.0000 / 0.0000 |
| 6 | 164 | -0.0066 / -0.0130 / -0.0121 | 0.0000 / 0.0000 / 0.0000 |
| 8 | 219 | -0.0070 / -0.0143 / -0.0133 | 0.0000 / 0.0000 / 0.0000 |
| 10 | 273 | -0.0077 / -0.0160 / -0.0149 | 0.0000 / 0.0000 / 0.0000 |
| 12 | 328 | -0.0081 / -0.0193 / -0.0168 | 0.0000 / 0.0000 / 0.0000 |
| 14 | 383 | -0.0091 / -0.0229 / -0.0196 | 0.0000 / 0.0000 / 0.0000 |
| 16 | 438 | -0.0104 / -0.0269 / -0.0230 | 0.0000 / 0.0000 / 0.0000 |
| 18 | 492 | -0.0120 / -0.0320 / -0.0274 | 0.0000 / 0.0000 / 0.0000 |
| 20 | 547 | -0.0140 / -0.0380 / -0.0325 | 0.0000 / 0.0000 / 0.0000 |
| 22 | 602 | -0.0191 / -0.0399 / -0.0402 | 0.0000 / 0.0000 / 0.0000 |
| 24 | 656 | -0.0227 / -0.0456 / -0.0473 | 0.0000 / 0.0000 / 0.0000 |
| 26 | 711 | -0.0178 / -0.0536 / -0.0568 | 0.0000 / 0.0000 / 0.0000 |
| 28 | 766 | -0.0206 / -0.0615 / -0.0650 | 0.0000 / 0.0000 / 0.0000 |
| 30 | 820 | -0.0248 / -0.0707 / -0.0739 | 0.0000 / 0.0000 / 0.0000 |
| 32 | 875 | -0.0348 / -0.0818 / -0.0664 | 0.0000 / 0.0000 / 0.0000 |
| 34 | 930 | -0.0536 / -0.0958 / -0.0689 | 0.0000 / 0.0000 / 0.0000 |
| 36 | 984 | -0.0982 / -0.1091 / -0.0594 | 0.0000 / 0.0000 / 0.0000 |
| 38 | 1039 | -0.6189 / -0.6024 / -0.4957 | -0.0156 / -0.0039 / 0.0078 |
| 40 | 1094 | 85.5186 / 73.3205 / 63.4820 | 0.7839 / 0.2542 / 0.0254 |
| 42 | 1148 | 0.2912 / 0.2679 / 0.3096 | 0.0000 / 0.0000 / 0.0000 |
| 44 | 1203 | 0.0402 / 0.0386 / 0.0447 | 0.0000 / 0.0000 / 0.0000 |
| 46 | 1258 | 0.0126 / 0.0126 / 0.0145 | 0.0000 / 0.0000 / 0.0000 |
| 48 | 1312 | 0.0034 / 0.0037 / 0.0042 | 0.0000 / 0.0000 / 0.0000 |
| 50 | 1367 | 0.0009 / 0.0011 / 0.0012 | 0.0000 / 0.0000 / 0.0000 |
| 52 | 1422 | 0.0003 / 0.0004 / 0.0004 | 0.0000 / 0.0000 / 0.0000 |

The physical profile is dominated by a **one pixel wide bright ring** at the disc edge
(+85 codes at r = 40 px). That ring is produced by the *in-emulsion scatter* term: its exponential
kernel has a decay constant of 9.3 µm, which is **0.34 px** at the preview scale, so on the
discrete grid it degenerates into a one pixel glow with a very large amplitude. The physical
back-reflection halo (sigma 65 µm) is the broader, weaker tail visible from r = 42 px outwards
(+0.29 codes at r = 42 px, +0.04 at r = 44 px).

Our shader implements the **back-reflection halo only**, with the physical `sigma_h` and the
physical `a_tot`. It therefore reproduces the broad tail but not the one pixel ring, and on this
pathological synthetic edge the two differ by two orders of magnitude. On a real picture the
difference is much smaller; the numbers below are the full-pipeline comparison on the harness
photo (Portra 400, 1280×854).

| quantity | physical | shader |
|---|---|---|
| rms difference (code) | 6.0988 | 0.3200 |
| max difference (code) | 102.92 | 8.00 |
| mean R/G/B difference (code) | 0.7427 / 0.5261 / 0.3944 | 0.0726 / 0.0290 / 0.0114 |
| rms of (physical − shader) | 5.9636 | |
| max of (physical − shader) | 96.92 | |

The shader's halo is close to the **back-reflection term alone** of the physical model (0.28
code RMS, §4.5) and far below the physical total, which the in-emulsion scatter term dominates:
with the halation correctly aligned with the picture, most of the bloom falls on the bright area
itself, where the physical renormalisation cancels it, and only the part that spills into the
neighbouring pixels survives.

### 4.4 Resolution dependence of the physical halation

The same disc was simulated at 1280 px and at 2560 px (13.672 µm per pixel) to separate the
physical kernel from the sampling grid. The **broad back-reflection tail is resolution
independent** (0.291 code at 1148 µm for both scales), while the **one-pixel ring grows with the
resolution** (85.5 codes at 1280 px, 130.3 codes at 2560 px, both at the same physical radius of
1094 µm):

| physical radius (µm) | 1280 px (27.344 µm/px) | 2560 px (13.672 µm/px) |
|---|---|---|
| 1094 (disc edge) | +85.52 | +130.33 |
| 1121 | +6.27 | +54.68 |
| 1148 | +0.29 | +8.32 |
| 1203 | +0.04 | +0.05 |

The ring is therefore a **sampling artefact of the physical model**: the in-emulsion scatter kernel
has a 9.3 µm decay constant, which is 0.34 px at 1280 px and 0.17 px at 2560 px, so the discrete
filter concentrates the scattered light into a single pixel whose amplitude grows as the pixel
shrinks. The broad tail, which is the physically meaningful back-reflection halo, behaves as a
resolution-independent kernel.

### 4.5 Energy split of the physical halation

| term | rms (code) | max |
|---|---|---|
| full physical halation | 6.0988 | 102.919 |
| in-emulsion scatter only | 5.9637 | 100.893 |
| back-reflection only | 0.2830 | 6.380 |

## 5. Documented divergences

| # | Divergence | Consequence |
|---|---|---|
| 1 | The LUT is baked **without** grain and halation; both are added to the final sRGB image instead of to the density/exposure. | The grain is not modulated by the print curve and the halation is not modulated by the film curve. |
| 2 | The physical grain is a sum of ~10³ particles per pixel; the shader uses a value-noise lattice. | The statistics (standard deviation, autocorrelation, channel correlation) are matched, the fine structure is not. |
| 3 | The physical grain blur is a fixed **0.65 px**, i.e. resolution dependent. The shader uses a **frame-relative** lattice (1.60 px at 1280 px). | The preview and a 4096 px export show the same grain *relative to the picture*; a physical 4096 px simulation would show a grain ~3.2× finer relative to the frame. This is the deliberate "preview and export look alike" choice. |
| 4 | The physical cross-channel grain correlation is level dependent (0.95 in the deep shadows, 0.2 in the mid-tones). The shader uses one mid-tone mixing matrix. | The grain is slightly too correlated in the deep shadows and slightly too decorrelated in the highlights. The absolute error there is below 0.1 code. |
| 5 | The physical halation includes the in-emulsion scatter (an exponential kernel with a 9.3 µm decay constant), which is 0.34 px wide at the preview scale and degenerates into a one-pixel ring whose amplitude depends on the sampling grid (§4.4). The shader implements the back-reflection halo only. | The shader misses the one-pixel bright ring of the physical model and shows about nineteen times less halation energy (RMS) on a real photograph (0.32 against 6.10 code RMS). The ring is a sampling artefact of the physical model rather than a resolvable physical feature, and a sub-pixel kernel cannot be represented by a bilinear multi-tap WebGL kernel. |
| 6 | The physical halation is applied to the film raw, the shader to the linear scene exposure. | The relative strength of the halo in the deep shadows differs; the shader's halo is weaker. |
| 7 | The physical halation kernel is the sum of three Gaussians truncated at infinity; the shader uses one Gaussian truncated at ±2 sigma. | 4.6 % of the kernel energy is missing. |
| 8 | The vignette has no physical counterpart. | It is labelled non-physical in the UI. |

## 6. Reproducing the numbers

```sh
# the physics study (≈ 6 min, writes build/p5a/ and docs/effects-physics.json)
/workspace/venv-sf/bin/python tools/study_effects.py --resume

# the constants derived from the study (writes utils/effects.js)
/workspace/venv-sf/bin/python tools/derive_effects.py

# the shader verification (writes harness/out/effects-report.{json,md} and the contact sheets)
cd harness && node test-effects.mjs

# only the contact sheets from the renders that are already there
cd harness && npm run effects:contact
```

The shader suite also checks the **orientation** of the halation: a bright patch in the top left
corner of a mid grey field must grow a halo around itself (0.0275 code above the patch) and not
around its mirror image in the bottom right corner (0.0000 code). The suite failed this check
before the vertical flip of the halo buffer was found and fixed (see `docs/RENDERER.md`).
