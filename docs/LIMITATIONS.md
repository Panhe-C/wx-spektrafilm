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

Phase 5a adds **approximate** grain, halation and vignette on top of the LUT. They are *not* part
of the LUT and they are *not* a faithful reproduction of the physical effects; `docs/EFFECTS.md`
documents the model, the measurements and the divergences. The list below stays the description of
what the **LUT itself** contains.

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

## The Phase-5a spatial effects are approximations

- The **grain** is a value-noise field whose standard deviation, spatial autocorrelation and
  red/green/blue correlation are fitted to the measured physical grain, but the fine structure is
  not the physical particle sum. The physical correlation is level dependent (0.95 in the deep
  shadows, 0.2 in the mid-tones); the shader uses one mid-tone mixing matrix. The measured
  amplitude of the rendered 8-bit image is 0.455 / 0.236 / 0.048 at the lags (1,0), (1,1), (2,0)
  against the physical 0.518 / 0.269 / 0.093.
- The physical grain statistics only exist together with an **output scale** (spektrafilm derives
  the film-plane pixel size from the image size). The shader's lattice is anchored at the 1280 px
  preview, so a 4096 px export shows a grain that is about 3.2× finer relative to the frame than a
  physical 4096 px simulation would.
- The **halation** implements the physical back-reflection halo only (65 µm for a still film, 50 µm
  for a cinema film, with the stock's `halation_strength`). The physical in-emulsion scatter term
  has a 9.3 µm decay constant — 0.34 px at the preview scale — and degenerates into a one-pixel
  ring whose amplitude depends on the sampling grid (85 codes at 1280 px, 130 codes at 2560 px).
  It cannot be represented by a bilinear multi-tap kernel, so the shader shows about nineteen times
  less halation energy (RMS) than the physical pipeline on a real photograph (0.32 against 6.10 code
  RMS for Portra 400 on the harness photograph).
- The **vignette** has no physical counterpart and is labelled non-physical in the UI.
- The preset thumbnails never include the effects, so a thumbnail shows the stock's colour look
  only.
- The effects have only been verified in the headless SwiftShader harness; the framebuffer
  ping-pong used by the halation chain and the effect timing on a real device still need the
  device checklist in `docs/UI.md`.
- The halation was **vertically mirrored** until Phase 5b: a render target has its row zero at
  the bottom, while the photo texture has its row zero at the top. The exposure pass of the halo
  chain now flips the vertical axis explicitly, and the harness has a regression test (a bright
  patch in the top left corner must grow a halo around itself). The pre-5b renders in
  `harness/out/` are therefore not comparable with the current ones.

## The export

The full-resolution export (`docs/EXPORT.md`) reproduces the preview look at the original
resolution, but it is new code with a new risk profile:

- The export size is `min(original long side, 4096 px, GPU limits)`. A 12 MP photo is therefore
  **not** exported at 12 MP on most devices; the result is a 4096 px JPEG.
- The export is the most memory-hungry operation of the app: at 4096×2731 the photo texture, the
  assembly canvas and the two halo buffers need roughly 135 MB. The buffers are released
  afterwards, but the **peak on a real device has not been measured**.
- The picture is decoded and drawn into a 2D canvas before it is rendered. On a device whose
  `wx.createOffscreenCanvas({ type: 'webgl' })` is missing or broken the export cannot run at
  all; the app reports this instead of failing silently.
- `wx.canvasToTempFilePath` with an offscreen canvas depends on the base library version. The
  export therefore has a fallback chain (`canvasToTempFilePath` → `toDataURL` → a base64 file in
  `USER_DATA_PATH`); on an old base library the export may fail with 「无法编码导出的图片」.
- The tiled render is verified against a single-pass render in the headless harness (maximum
  difference 1 code, the 8-bit rounding of the halo buffer). The framebuffer sizes, the tile
  boundaries and the memory behaviour on a **real GPU** have not been checked.
- The album permission flow is unit-tested with a mock `wx`; the real modal, the real
  `wx.openSetting` and the iOS/Android differences are untested.
- The export uses the picture that was picked; the picker may have returned a compressed copy
  (`sizeType`), so the exported resolution can be lower than the resolution of the file in the
  album.
- The saved JPEG is 8-bit and quality 0.92; the file size is typically 2…5 MB for a 4096 px
  export.

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
  touch/slider behaviour, and real GPU rounding still need target-device tests.
- The pure UI policy (slider ranges and steps, readouts, category grouping, thumbnail geometry and
  ordering, the setData throttle, and the phase machine) is unit-tested in Node, and the phase
  machine is the only place that decides the busy mask. The *visual* result of that policy —
  spacing, touch targets, safe-area padding, thumbnail scheduling, and the press-and-hold
  comparison — is only as good as the device rendering of it; see the checklist in `docs/UI.md`.
- The preset thumbnails are rendered from the current photo at the stock's default look. They are
  not a per-stock preview of the user's own adjustment state, and they are regenerated for every
  new photo.
- The offscreen `renderToPixels()` path used for thumbnails has been verified headlessly only. On a
  real device the framebuffer readback path and the `putImageData`/temp-file conversion still need
  a device test. The WeChat export order is `wx.canvasToTempFilePath({ canvas })` → `toDataURL` →
  a built-in PNG encoder written to `USER_DATA_PATH` → a coloured placeholder, and the last step
  guarantees that a failed export degrades to a placeholder instead of a broken image. Whether
  `wx.canvasToTempFilePath` accepts an offscreen canvas depends on the base library version, so
  the fallback chain matters on older devices; `docs/UI.md` lists the device checks.
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
  transcode HEIC before the app sees it. HDR/wide-gamut/RAW input and colour-profile conversion
  remain outside this phase. The export (Phase 5b) writes an 8-bit JPEG into the album; it does
  not write HEIC, RAW or a colour profile.
- LUT PNGs and the generated JS manifest ship in the main package; selecting the first stock does not
  require a subpackage download. Previously decoded LUT images are cached in page memory, but there is
  no persistent decoded-image cache or package-update manager.
- The roughly one-second mid-phone preview target is a documented engineering estimate. Headless
  render milliseconds exclude JPEG decode, local PNG decode, app layout, and PNG export, and cannot
  establish real-device latency.

## Still deferred to later phases

Diffusion filters, blur/sharpening, glare, privacy review, and release work remain unimplemented.
The presets picker, the adjustments panel, the spatial-effect panel, the export panel and the
about section are implemented (Phase 4b, 5a and 5b, `docs/UI.md`); the exposure, white-balance,
and post-LUT controls are exposed in the UI and remain backed by the verified renderer API
(`docs/ADJUSTMENTS.md`), the grain, halation and vignette are exposed through
`renderer.setEffects()` and documented in `docs/EFFECTS.md`, and the full-resolution export is
documented in `docs/EXPORT.md`. The release checklist (real AppID, privacy authorisation, review
materials, device testing) is in `docs/RELEASE_TODO.md`.
