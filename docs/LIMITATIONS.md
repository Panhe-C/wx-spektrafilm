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

## Exposure and tonality constraints

`camera.auto_exposure` is image-dependent and cannot be baked. The LUT instead uses **0.0 EV**
camera compensation globally: display sRGB code 118 decodes to approximately 0.18 linear metered
mid-grey, which is the auto-exposure-equivalent setting for a balanced phone photo. The exploratory
−0.652 EV median is not used: per-photo values scatter widely, print compensation cancels it for
negative/print stocks, and without a print stage it made direct positive scans too dark. Zero EV
keeps Velvia, Provia, and Kodachrome normally exposed without a slide-only exception. It is still
not a per-image exposure guarantee. Print compensation/normalization remains physical and
deterministic.

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

- Phase 2/3 rendering is verified in headless Google Chrome using ANGLE/SwiftShader. That compares
  the shared GLSL and texture path with `tools/lut_apply.py`; it is **not** a WeChat DevTools or
  physical-device certification. WebGL context creation, `canvas.createImage`, offscreen Canvas2D,
  `wx.loadSubpackage`, touch/slider behaviour, and real GPU rounding still need target-device tests.
- The fragment shader requests high precision where available and has a mediump fallback for WebGL1
  compatibility. A mediump-only GPU can have different interpolation/rounding error and must not be
  assumed to inherit the headless highp measurements.
- The six headless phone fixtures are EXIF orientation 1. All eight orientation transforms are
  implemented and matrix-tested, but rotated/mirrored WeChat images have not been visually verified.
  Browser Canvas2D downsampling is shared conceptually with the app, but it is not the WeChat native
  decoder/resizer. See `docs/ORIENTATION.md`.
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

Grain, halation/scatter, diffusion, blur/sharpening, glare, export/save, preset UI polish, privacy
review, and release work remain unimplemented. The current product is a picker and interactive LUT
preview only.
