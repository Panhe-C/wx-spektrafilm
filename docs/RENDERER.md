# WebGL LUT renderer

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).
The renderer applies the derived CC BY-SA 4.0 LUT/profile data without adding another colour transform.

## One implementation, two hosts

The canonical shader sources are:

- `shaders/lut.vert.glsl` — full-screen WebGL1 quad and image texture coordinates;
- `shaders/lut.frag.glsl` — tiled-grid trilinear LUT lookup, camera-side gain, intensity mix, the
  optional post-LUT contrast/saturation stage, and the spatial effects (grain, halation, vignette);
- `shaders/halo.frag.glsl` — the helper pass of the halation effect: the linear exposure pass and
  the separable nine-tap Gaussian blur.

WeChat cannot portably fetch a `.glsl` asset as source text, so `tools/embed_shaders.py` writes the
committed `utils/shaders.js` CommonJS module. After changing GLSL, run:

```sh
python3 tools/embed_shaders.py
python3 tools/embed_shaders.py --check
```

The static checker rejects a stale embedding. The Mini Program and headless browser both execute
`utils/lut-renderer.js`; the browser reads the raw `.glsl` files, while the Mini Program uses their
generated string embedding. The adjustment mapping lives in `utils/adjust.js`, which both hosts
load; the NumPy mirror used by the physical reference is `tools/wb.py`. There is no second copy of
the lookup equations or of the slider mapping in the harness.

The LUT PNGs and both manifest forms ship in the **main package** under `subpackages/luts/`; that
directory name is retained only to keep image paths stable. `pages/index/index.js::ensureLuts()` uses a
local synchronous `require('../../subpackages/luts/luts.js')` and does not call `wx.loadSubpackage`.
`tools/convert_luts.py` generates `luts.js` for the Mini Program and the equivalent `luts.json` for the
Python/browser harness from one manifest, and the static checker rejects stale or divergent output.

## Resize, upload, and draw

`utils/photo.js` decodes the selected image, applies EXIF orientation, and draws directly into an
offscreen 2D canvas at the preview size. For source long edge `S`, device pixel ratio `D`, and WebGL
`MAX_TEXTURE_SIZE` `M`, the shared sizing function uses:

```text
cap        = min(D*S, M, 2048)
targetLong = min(1280, S, cap)
scale      = targetLong / S
```

Width and height are rounded independently and remain at least one pixel. Small images are not
upscaled. The oriented image, not the original EXIF orientation, determines the photo texture's aspect
ratio. The native canvas always fills the preview stage; its drawing buffer is stage CSS size × DPR,
clamped by `MAX_RENDERBUFFER_SIZE` and `MAX_VIEWPORT_DIMS`. The renderer aspect-fits the photo with a
centred GL viewport and clears the remaining default framebuffer to #080808. A 1280×854 photo texture
is about 4.17 MiB as RGBA in a typical GPU implementation, rather than a multi-megapixel 12 MP texture.
Decoding the source JPEG still requires temporary source memory.

All input and target textures use WebGL1 `UNSIGNED_BYTE`, `LINEAR`
minification/magnification, `CLAMP_TO_EDGE`, and no mipmaps. Every texture is created by one helper
and starts as a complete opaque 1×1 RGBA placeholder, including unused sampler units and the halo
ping-pong targets. Reallocating a texture does not reset its filters or wrap modes. Dithering, depth
testing, and blending are disabled. Unpack Y-flip and premultiply are disabled; direct-source
colour-space conversion is disabled where the host exposes that control. The vertex shader flips V
for the top-row-first photo bytes; LUT V remains in native PNG row order because green increases
down each tile.

### Robust source upload ladder

The renderer never assumes that a host Canvas2D/Image accepted by six-argument `texImage2D` actually
produced nonzero texels. **Strategy P is preferred**: an existing 2D canvas is read 1:1 with
`getImageData`; an Image/ImageBitmap is drawn 1:1, without smoothing or scaling, into a scratch 2D
canvas and read back. The resulting `Uint8Array` is uploaded with the nine-argument RGBA/
`UNSIGNED_BYTE` overload. **Strategy D** is the direct RGBA host-source fallback.

After every photo/base-LUT/extended-LUT upload, a state-restoring probe pass checks GPU content
against retained CPU bytes. Photos use a 4×4 passthrough mean and a centre texel. LUTs use the white
corner of blue slice N−1 (computed from metadata, not an unused PNG padding tile). A non-black source
that reads back near zero, a LUT mismatch over one code, or a GL error switches to the other strategy
and retries. Zero CPU readback is itself suspect: photo mean ≤1 or LUT white mean ≤2 forces both P and
D; a non-black D result becomes sticky. For photos, `photo.js` first redraws once from the original
Image, and both-black P/D is accepted with `photoAllBlack` plus a page warning. LUTs never use that
black-photo exception. Attempts, `cpuDecodeSuspect`, fallbacks, source type/size, alpha range, texture
parameters, and GL errors are retained for `utils/diagnostics.js`. CPU RGBA is retained for later probes;
this adds about
4.17 MiB for a 1280×854 photo, in addition to its GPU texture.

The drawing-buffer policy is explicit and independent of photo dimensions: the canvas CSS layout is
always `width:100%; height:100%` (never an initial 1×1 or a photo-sized CSS box), and the drawing
buffer follows the stage CSS geometry × DPR. `resizeToCssSize()` records requested/actual/clamped
sizes. On-screen drawing binds the default framebuffer, disables scissor/blending, enables all colour
writes, clears with alpha 1, reads actual `gl.drawingBufferWidth/Height`, and uses a centred photo
sub-viewport. The target passed to the shader still describes the photo rect, so grain, halation and
vignette are pixel-equivalent to an FBO render of that rect. Page draws run in the canvas node's rAF,
with an extra frame after initial layout and resize. FBO thumbnail/export targets are unchanged.
See `docs/DEVICE_DEBUG.md` for both iPhone investigations.

The LUT uniforms are:

| Uniform | Meaning |
|---|---|
| `uImage` | Downscaled, upright, encoded-sRGB photo on texture unit 0 |
| `uLut` | Tiled RGB LUT on texture unit 1 |
| `uLutExtended` | Tiled RGB extended-range LUT on texture unit 2 |
| `uN` / `uCols` / `uRows` | Cube edge length, tile columns, tile rows of `uLut` |
| `uExtendedN` / `uExtendedCols` / `uExtendedRows` | the same for `uLutExtended` |
| `uUseExtended` | 1 selects the extended cube, 0 the native cube |
| `uCameraIdentity` | 1 skips the sRGB↔linear round trip, keeping the Phase-3 output bit-identical |
| `uLinearGain` | combined camera-side linear RGB gain (EV × white balance) |
| `uIntensity` | Blend amount in `[0,1]`; 1 is the full film transform |
| `uContrast` | Contrast slope about encoded 0.5 (`1 + 0.35·c + 0.05·c²`, see `docs/ADJUSTMENTS.md`) |
| `uSaturation` | Rec.709 encoded-luma saturation multiplier |
| `uPostIdentity` | 1 skips the non-physical contrast/saturation stage |
| `uImageFrameOrigin` / `uImageFrameSize` | the picture's rectangle in the normalised frame space |
| `uRegionOrigin` / `uRegionSize` | the rectangle this draw covers, in the same frame space |
| `uImageUvOffset` / `uImageUvScale` | where the drawn rectangle sits on the photo texture |
| `uGrainStrength` | grain strength 0…2 |
| `uGrainGrid` | the grain lattice spacing in frame units |
| `uGrainCurve` | 17-point grain amplitude versus output level (per stock) |
| `uGrainMatrix` | the grain colour mixing matrix (Cholesky of the measured covariance) |
| `uHaloEnabled` / `uHaloStrength` | the halation switch and the per-channel coefficient |
| `uHaloUvScale` / `uHaloUvOffset` | the mapping from the drawn rectangle to the halo buffer |
| `uVignetteStrength` | vignette strength 0…1 |

## Exact tiled lookup and half-texel rule

For normalized encoded-sRGB input `c`, the fragment shader calculates:

```text
q  = clamp(c, 0, 1) * (N-1)
q0 = floor(q)
q1 = min(q0+1, N-1)
f  = q-q0
```

It fetches blue slices `q0.b` and `q1.b`. Slice `b` starts at tile coordinate
`(mod(b,cols)*N, floor(b/cols)*N)`. Within a slice, continuous red/green coordinates are `q.r/q.g`.
A sample is addressed at:

```text
u = (tileColumn*N + clamp(q.r, 0, N-1) + 0.5) / (cols*N)
v = (tileRow*N    + clamp(q.g, 0, N-1) + 0.5) / (rows*N)
```

The `+0.5` addresses texel centres. Hardware `LINEAR` sampling performs red/green bilinear
interpolation, and the shader mixes the two resulting RGB values by `f.b`. At red/green endpoints,
the neighbouring texel has exactly zero weight. Coordinates never proceed past the first/last texel
centre of a tile, so a bilinear footprint cannot blend a different blue slice. This is mathematically
the same eight-vertex trilinear interpolation as `tools/lut_apply.py`, with two hardware bilinear
fetches replacing the explicit red/green vertex operations.

The input and output are already **encoded sRGB**. No sRGB decode, gamma encode, or other gamma pass
is added. Full-intensity output is clipped to `[0,1]` and quantized by the 8-bit WebGL target. The
Python reference likewise clips and uses `numpy.rint(value*255)`. A final one-code difference can
occur at a floating-point rounding boundary; ΔE2000 and absolute-code errors are both reported.

Intensity uses `mix(original, graded, uIntensity)`. At zero the original texture is returned; at 0.5
the encoded-sRGB values are blended halfway. The page sets intensity to zero on preview touch start
and restores the slider value on touch end/cancel.

## Camera adjustments and the two LUT variants

Phase 4a adds camera-side exposure EV and white balance before the LUT, plus optional non-physical
contrast/saturation after it. `utils/adjust.js` is the shared mapping module; the exact semantics,
ranges, and measurement tables are in `docs/ADJUSTMENTS.md` and `docs/EXPOSURE_EV.md`.

The shader decodes encoded sRGB with the exact piecewise transfer function, multiplies by
`uLinearGain` in linear light, clamps at the LUT input boundary, and re-encodes. Two cubes are
resident:

- `uLut` — the shipped N=33 cube, used for identity adjustments and for EV ≤ 0 without WB;
- `uLutExtended` — an N=49 cube baked from the same physical recipe with two extra stops of linear
  input headroom, used for EV > 0 or any nonidentity WB. Its lookup divides the camera gain by
  four first (`2^(EV−2)`), which is algebraically identical to the physical reference.

`uCameraIdentity` and `uPostIdentity` are explicit identity fast paths, so the default output is
bit-identical to the Phase-3 result instead of depending on an sRGB↔linear round trip. Intensity 0
returns the untouched original before any adjustment is applied.

## Spatial effects

`renderer.setEffects({ grain, halation, vignette })` sets the effect state; `renderer.getEffects()`
reads it back, and `renderToPixels({ effects })` can override it for one render (the preset
thumbnails use that to stay free of effects). With every effect at strength 0 the shader keeps the
exact Phase-4 path: the sRGB round trip is only taken when a camera adjustment, the halation or
the vignette is active, so the output is bit-identical to the Phase-3/4 result.

The **halation** needs two extra offscreen buffers and three passes:

```text
photo texture → exposure pass (sRGB → linear, camera gain, /4 headroom) → halo A
halo A → horizontal nine-tap Gaussian → halo B
halo B → vertical nine-tap Gaussian → halo A
main pass: exposure + a·halo A → LUT → intensity mix → post → grain → vignette
```

The kernel sigma is `sigma_h·sqrt(11/7)·longEdgePx/35000`, the equivalent of the physical
three-bounce sum, and it is truncated at ±2 sigma. The kernel therefore never reaches beyond
`2·sigma` pixels, which bounds the tile margin a tiled export needs
(`Effects.halationMarginPixels`).

Everything that depends on position (the grain lattice, the vignette) is a function of the
**global** frame position, so a tiled export (Phase 5b) stays continuous across the tile borders.
The physical model, the measurements and the divergences are documented in `docs/EFFECTS.md`.

The halo buffer is a **render target**, so its row zero is at the bottom, while the photo texture
has its row zero at the top. The exposure pass therefore flips the vertical axis explicitly, so
that both buffers use the same uv convention. Without the flip the halation was mirrored
vertically in the preview and would have been mirrored inside every tile of an export.

## Rendering a sub-rectangle (the export path)

`renderer.renderRegionToPixels({ width, height, target, intensity, adjustments, effects })`
renders a rectangle of the picture into the offscreen framebuffer and reads it back, exactly like
`renderToPixels()`. The `target` describes the rectangle in the normalised frame space and the uv
mappings of the photo and of the halo buffer; `utils/export.js::planExport` builds it. The preview
still renders the whole photo, but into a centred sub-viewport of the stable stage-sized default
buffer; its shader target is the same full-picture frame as the FBO path. `docs/EXPORT.md` describes
the tiling, the margins and the verification.

## Offscreen rendering and thumbnails

`renderer.renderToPixels({ width, height, intensity, adjustments, onTiming })` renders into a
cached RGBA framebuffer, reads it back with `readPixels`, and returns top-down `RGBA8` pixels
together with `{ submitMs, renderMs, readPixelsMs, totalMs }`. The preview framebuffer and
viewport are restored afterwards, and a temporary `adjustments` object lets thumbnails be rendered
at default settings while the live preview keeps its own state. Preset cards use this FBO path with a
fixed **96×54 (16:9)** target. `utils/thumbnail.js::thumbnailGeometry()` computes a
centre crop in photo coordinates and matching `imageUvOffset`/`imageUvScale`; `renderToPixels`
applies those UVs without changing export geometry. The `<image>` uses `aspectFill` and the WXSS box
uses 56.25% padding, so the card is neither contain-letterboxed nor squeezed. `docs/UI.md` describes
the WeChat export order and placeholder fallback.

## Base and extended cubes

The two cubes of a stock are independent uploads:

- `setLut(source, metadata, extendedSource)` uploads the base cube and, when the extended source
  is supplied, the extended cube as well. The extended source is **optional**: the Mini Program
  page fetches `<id>.ev2.png` only when a positive EV or a nonidentity white balance needs it.
- `setExtendedLut(source, metadata)` uploads the extended cube later without re-uploading the base
  cube.
- `hasExtendedLut()` reports whether the extended cube is currently resident.
- Drawing with `ev > 0` or a nonidentity white balance while the extended cube is missing throws
  `This stock has no extended-range LUT for positive EV/WB` rather than silently using the native
  cube. The harness contract check exercises exactly this sequence: select without the extended
  cube, expect the clear failure, upload it, and expect the draw to succeed.

## On-device diagnostics

`utils/diagnostics.js` combines GL version/vendor/renderer (including unmasked values when exposed),
context attributes, texture limits, fragment-highp format, extensions, canvas/node/buffer/viewport
sizes, source/upload state, and per-texture records. Its GL probes are implemented by the shared
renderer: a code-exact `(255,0,128,255)` shader draw, photo centre + four corners against CPU bytes,
base-LUT black/white nodes against CPU bytes, full-shader centre pixels at intensity 1 and 0, and a
**default-framebuffer centre + four inset corners** read immediately after an on-screen draw and
compared with the same photo rect rendered to the FBO. The report also includes canvas/stage CSS
rects, requested/actual buffer sizes, last photo viewport, orientation/decode sizes, letterbox colour,
and thumbnail crop geometry.
Probe passes restore the previous program, framebuffer, viewport, and texture bindings. The pure text
formatter is unit-tested in Node, and the numeric GL suite is asserted in SwiftShader.

The Mini Program exposes the report through **关于 → 诊断** or a title long-press. It can be copied
with `wx.setClipboardData` and rerun. See `docs/DEVICE_DEBUG.md` for interpretation.

## Headless verification

From the repository root:

```sh
cd harness
npm i
npm test
```

The command requires `/usr/bin/google-chrome`, the six non-repository phone photos in
`/workspace/testphotos/p*.jpg`, and the Python scientific environment (`numpy`, Pillow, and
scikit-image; `/workspace/venv-sf/bin/python` on the build box). `PYTHON` and `TEST_PHOTOS` can
override those two paths. `npm test` first runs the plain-Node EXIF policy/matrix suite, adjustment-mapping suite, and pure
diagnostics formatter, then starts Chrome. `test-upload-strategies.mjs` forces both P and D for the
photo/base/extended LUT, requires full-render agreement within one code, injects zero-filled direct
uploads and zero `getImageData()` results to verify GPU/CPU failure fallback (including sticky D and
photo-only `photoAllBlack`), and asserts the diagnostic solid/photo/LUT/full-shader/default probes.
`test-presentation.mjs` covers portrait 3:4, oriented EXIF-6/8-style 9:16 inputs, DPR 2, a clamped
buffer, centred default-viewport/FBO equivalence with all effects, exact #080808 letterboxing, and the
16:9 crop. `npm run test:smoke` runs only one browser pair and is not a substitute for `npm test`.
`npm run study:ev` re-runs the separate physical faithfulness study against full `simulate()`; it is
resumable and is not part of `npm test`.

Chrome is launched with `--use-gl=swiftshader`, `--enable-webgl`, `--ignore-gpu-blocklist`, and
`--headless=new`. The browser downscales each photo to a long edge of 1280 with the shared sizing
function, exports that exact input PNG, and uses the same file for Python LUT application. Thus the
comparison does not hide errors behind two different resizers.

`harness/out/` contains `<stock>/<photo>-shader.png`, `-python.png`, and `-diff.png` for every pair,
`adjustments/<stock>/…` for every EV/WB/post case, `thumbs/` for the generated thumbnails, plus
`report.json`, `report.md`, `inputs/`, `contact-shader.jpg`, `contact-adjust.jpg`, and
`contact-thumbs.jpg`. The spatial-effect suite adds `effects/` with the effect renders,
`effects-report.json`, `effects-report.md`, `contact-effects.jpg` and `grain-compare.jpg`. Diff images show absolute 8-bit channel differences amplified 16×. The harness
fails unless every pair has mean ΔE2000 < 0.3 and max ΔE2000 < 2.0. It also checks intensity 0 and
0.5 for every stock on the first photo; zero must match the original within one code even with
extreme EV/WB/post settings applied, and half intensity must match the unrounded-Python-LUT
midpoint within one code and the same ΔE limits. Adjustment cases compare the shader against
NumPy implementations of the same math, thumbnails are checked against a pixel-centre bilinear
sample of the **same cropped UV rectangle** of the exported input, and the median stock-switch and
thumbnail timings must stay below 300 ms.

Reported shader time includes draw, `gl.finish()`, and a one-pixel synchronous readback, but excludes
photo/LUT upload and PNG encoding. This is a repeatable headless comparison timing, not a real-phone
performance measurement.

The final on-box full run passed **66/66 default pairs**, **11/11 intensity checks**, **61/61
adjustment pairs**, and **11/11 thumbnails**. The worst default mean ΔE2000 was **0.0005203500**
(`velvia100/p237`) and the worst default maximum was **1.2104642391** (`portra160/p1015`); the worst
adjustment mean was **0.0004473071** and the worst adjustment maximum **1.2063055038**. Median
render/readback time was **31.80 ms**, median thumbnail `setLut`+render+readback **2.20 ms**, and
median full-preview stock switch **29.00 ms**. Intensity 0 was code-exact; intensity 0.5 stayed
within one code. The separate upload suite passed P/D with **0-code maximum difference over 6,144
pixels**, recovered both injected zero uploads through P, and measured solid/photo/LUT maxima of
**0/0/0 codes** (full-shader intensity 0: **1 code**). See `harness/out/report.md` and
`harness/out/diagnostics/report.txt` for the full tables and probe report.

## Performance expectation and fallback boundary

For a typical 12 MP JPEG on a mid-range phone, the approximately one-second Phase-2 target is an
**engineering estimate**, not a device measurement: JPEG decode/orientation inspection roughly
150–400 ms, one-pass downscale roughly 80–250 ms, bounded texture upload roughly 20–80 ms, and a
LUT draw roughly 10–30 ms, leaving margin within 1 s after warm-up. LUT assets are already bundled in
the main package, so first use has no subpackage download latency. The harness proves the
downscale/upload/draw and numerical path on the build box; only a physical-device profile can confirm
this budget.

If WebGL context creation fails, the page deliberately selects `renderer/fallback2d.js`, which throws
`not implemented`. Shader compile/link failures are reported rather than mislabeled as context
failure. There is no silent CPU or Canvas2D LUT approximation.
