# LUT limitations and excluded effects

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).

## What the LUT represents

Each stock is a static, deterministic, per-pixel transform from display-referred 8-bit sRGB to
sRGB. It includes spektrafilm's spectral filming/development, the selected physical print route
(or direct positive-film scan), fixed camera/print exposure, database neutral filters, physical
scanner endpoint normalization, and input/output gamut handling. The cube bake and full validation
reference use exactly the same parameters. There is no project-owned tone, levels, per-channel
neutralization, or post-simulation curve.

## Spatial and stochastic effects excluded from the LUT

A three-dimensional colour LUT cannot represent effects that depend on neighbouring pixels,
image coordinates, film geometry, random samples, or whole-image statistics. The following are
**disabled in both bake and reference and are not present in the delivered PNGs**:

- film grain, sublayers, dye clouds, grain blur, and all stochastic grain structure;
- halation/back-reflection and in-emulsion scatter, including highlight boost;
- camera and enlarger diffusion filters and their halos/bloom;
- camera-lens, enlarger-lens, scanner-lens, and scan blur;
- scanner unsharp masking and any sharpening;
- print/scan glare and other spatial veil or flare;
- DIR-coupler **spatial** diffusion (the deterministic pointwise DIR-coupler colour chemistry
  remains in the physical model);
- cropping, rescaling, borders, and other geometric/presentation operations;
- any other spatial, convolutional, coordinate-dependent, or stochastic effect.

These are candidates for separate later WebGL passes: grain synthesis, halation/scatter bloom,
diffusion filters and vignette-like diffusion, blur/sharpening, and glare. Adding them after the
LUT will not make the current validation metrics apply to those future effects; each will need its
own full-pipeline comparison.

## Exposure, EV, and white balance

`camera.auto_exposure` is image-dependent and cannot be baked. The LUT instead uses **0.0 EV**
camera compensation globally: display sRGB code 118 decodes to approximately 0.18 linear metered
mid-grey, which is the auto-exposure-equivalent setting for a balanced phone photo. The exploratory
−0.652 EV median is not used: per-photo values scatter widely, print compensation cancels it for
negative/print stocks, and without a print stage it made direct positive scans too dark. Zero EV
keeps Velvia, Provia, and Kodachrome normally exposed without a slide-only exception. It is still
not a per-image exposure guarantee. Print compensation/normalization remains physical and
deterministic.

The Phase-4a EV control is a **camera-side** exposure compensation with a fixed enlarger time
(`print_exposure_compensation=False`). Auto-printing is not used: it cancels negative-film EV and
has no effect at all for direct positive scans. Measured against full `simulate()`, the shipped
implementation stays within mean 0.1479–0.1882 / p95 0.3219–0.3966 / max 1.6097 dE2000 over the
whole −2…+2 EV range; see `docs/EXPOSURE_EV.md` for the candidate comparison and the auto-printing
diagnostic.

Positive EV needs linear headroom above diffuse white, which the native N=33 cube does not
represent. Each stock therefore also ships an extended N=49 cube baked from the same physical
recipe with two extra stops of input headroom. Consequences to keep in mind:

- The extended cube is sampled over a wider input range, so its interpolation error is slightly
  larger in the deep shadows than the base cube's; the −2 EV row (max 1.2721 dE2000) shows this.
- The physical study covers four representative stocks (negative, saturated negative, slide,
  cinema) on three photos; the shader-versus-NumPy harness covers all 11 stocks.
- The white-balance study validates the ±50 slider region against full `simulate()`; the ±100
  endpoints are covered by the unit tests and the available headroom, not by a full physical sweep.
- White balance is a camera white balance (Bradford adaptation to a Planckian white), not a film
  or print filter, and it is applied to the image before the film LUT.
- Contrast and saturation are **not** physical. They are applied after the intensity mix and are
  labelled 「后期微调（非胶片物理）」 in the UI.

Physical scanner white/black normalization is enabled at spektrafilm's 0.98/0.01 levels. It does
not bring input white to the soft ~240 goal for these stocks (roughly 206–225 in the zero-EV
exploration),
and neutral casts remain where the measured film/paper profiles create them. Ektar and Vision3
can legitimately be dark or punchy. Those are properties of the selected physical recipe, not LUT
interpolation errors.

## Colour, precision, and interpolation

- Input is bounded, display-referred **sRGB**, not scene-linear RAW, HDR, Display P3, or log video.
  Out-of-range/HDR input needs a separate colour-management and exposure pipeline.
- The encoded sRGB domain is the shaper. A 3D LUT samples a continuous physical transform at
  finite N nodes and uses trilinear interpolation; highly curved or discontinuous regions have
  larger error. See per-image, subset, and N=33/49/65 measurements in `docs/validation.md`.
- Nodes and final output are 8-bit. Quantization-only error is reported separately from physical
  interpolation error (final N=33: pixel-weighted mean **0.1319 dE2000**, worst-image p95
  **0.7472**, global maximum **0.8122**). Ektar's physical 250→255 neutral rise is only 0.3697
  code, so both correctly round to 225 at every tested N. This is a disclosed sub-one-code
  quantization plateau, not repaired by altering the physical transform. The WebGL implementation
  must use the tiled-grid half-texel rule and two bilinear blue-slice fetches to avoid
  slice-boundary bleeding.
- Spektrafilm's CAM16-UCS output gamut/lightness compression is part of both paths. Any residual
  floating-point excursion beyond `[0,1]` is clipped at the cube/display boundary; pre-clip node
  percentages are reported. Results are not a promise to reproduce an unclipped wide-gamut master.
- The fixed 8-bit sRGB validation boundary intentionally includes JPEG/code-value inputs. It does
  not test phone HDR pipelines, 16-bit masters, alternate illuminants, creative filter shifts, or
  per-user chemistry/exposure controls.

## Validation scope

Validation covers six on-box phone photos, the ProPhoto-derived portrait, an IT8 chart, and a
synthetic colour/gradient target at no more than 1.2 MP each. It measures LUT fidelity to the full
physical **non-spatial, non-stochastic** `simulate()` path, not perceptual equivalence to a real
film photograph and not accuracy against a laboratory film scan. The six phone JPEGs and large
references remain on the build box; they are not committed to the Mini Program package.

## Renderer and host limitations

- The final on-box full harness run passed 66/66 default pairs, 11/11 intensity checks, 61/61
  EV/WB/post adjustment pairs, and 11/11 thumbnails. It compares the shared GLSL and texture path
  with `tools/lut_apply.py` and the NumPy adjustment reference; it is **not** a WeChat DevTools or
  physical-device certification. WebGL context creation, `canvas.createImage`, offscreen Canvas2D,
  `wx.loadSubpackage`, touch/slider behaviour, and real GPU rounding still need target-device tests.
- The offscreen `renderToPixels()` path used for thumbnails has been verified headlessly only. On a
  real device the framebuffer readback path and the `putImageData`/temp-file conversion still need
  a device test; the WeChat-specific thumbnail plumbing is Phase 4b.
- The fragment shader requests high precision where available and has a mediump fallback for WebGL1
  compatibility. A mediump-only GPU can have different interpolation/rounding error and must not be
  assumed to inherit the headless highp measurements.
- The six headless phone fixtures are EXIF orientation 1. All eight orientation transforms and
  auto/manual/engine decisions are Node unit-tested, but rotated/mirrored WeChat images have not
  been visually verified. Auto detects engine-applied EXIF 5–8 by swapped dimensions; EXIF 2–4
  remain manual and require the real-device checklist in `docs/ORIENTATION.md`. Browser Canvas2D
  downsampling is shared conceptually with the app, but it is not the WeChat native decoder/resizer.
- The Canvas2D renderer fallback is intentionally only a stub that throws `not implemented`. It is
  selected solely when WebGL context creation fails; there is no CPU LUT fallback.
- Only bounded, display-referred 8-bit JPEG/PNG input is accepted by the preview. WeChat may
  transcode HEIC before the app sees it. HDR/wide-gamut/RAW input, colour-profile conversion, export,
  and saving to the photo album remain outside this phase.
- The first stock selection needs the network-loaded LUT subpackage. Previously decoded LUT images
  are cached in page memory, but there is no persistent offline cache or package-update manager.
- The roughly one-second mid-phone preview target is a documented engineering estimate. Headless
  render milliseconds exclude JPEG decode, native subpackage download, app layout, and PNG export,
  and cannot establish real-device latency.

## Still deferred to later phases

Grain, halation/scatter, diffusion, blur/sharpening, glare, export/save, the preset/adjustment UI,
privacy review, and release work remain unimplemented. The current product is a picker and
interactive LUT preview; the exposure, white-balance, and post-LUT controls exist as a verified
renderer API (`docs/ADJUSTMENTS.md`) but are not yet exposed in the UI.
