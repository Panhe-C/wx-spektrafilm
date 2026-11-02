# WebGL LUT renderer

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).
The renderer applies the derived CC BY-SA 4.0 LUT/profile data without adding another colour transform.

## One implementation, two hosts

The canonical shader sources are:

- `shaders/lut.vert.glsl` — full-screen WebGL1 quad and image texture coordinates;
- `shaders/lut.frag.glsl` — tiled-grid trilinear LUT lookup, camera-side gain, intensity mix, and
  the optional post-LUT contrast/saturation stage.

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

The asset subpackage also declares the required no-op page `pages/empty/empty`; it is never
navigated to and does not change the LUT manifest or PNG paths.

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
upscaled. The oriented image, not the original EXIF orientation, determines the output aspect ratio.
The CSS canvas is then fitted inside the preview stage with `contain` semantics; the dark stage is
the letterbox. A 1280×854 photo texture is about 4.17 MiB as RGBA in a typical GPU implementation,
rather than a multi-megapixel 12 MP texture. Decoding the source JPEG still requires temporary
source memory.

All three input textures use WebGL1 `UNSIGNED_BYTE`, `LINEAR` minification/magnification,
`CLAMP_TO_EDGE`, and no mipmaps. The LUT upload internal format is `RGB` (RGB888). Dithering, depth
testing, and blending are disabled. DOM/canvas colour-space conversion and unpack Y-flip are
disabled where the host exposes those controls. The vertex shader flips V for the top-row-first
photo canvas; LUT V remains in native PNG row order because green increases down each tile.

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
| `uContrast` | Contrast slope about encoded 0.5 (`1 + contrast`) |
| `uSaturation` | Rec.709 encoded-luma saturation multiplier |
| `uPostIdentity` | 1 skips the non-physical contrast/saturation stage |

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

## Offscreen rendering and thumbnails

`renderer.renderToPixels({ width, height, intensity, adjustments, onTiming })` renders into a
cached RGBA framebuffer, reads it back with `readPixels`, and returns top-down `RGBA8` pixels
together with `{ submitMs, renderMs, readPixelsMs, totalMs }`. The preview framebuffer and
viewport are restored afterwards, and a temporary `adjustments` object lets thumbnails be rendered
at default settings while the live preview keeps its own state. This is the path the Phase-4b
preset cards use; `docs/UI.md` describes the full thumbnail pipeline, including the WeChat export
order and the placeholder fallback.

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
override those two paths. `npm test` first runs the plain-Node EXIF policy/matrix suite and the
adjustment-mapping unit suite, then starts Chrome. `npm run test:smoke` runs only one browser pair
and is not a substitute for `npm test`. `npm run study:ev` re-runs the separate physical
faithfulness study against full `simulate()`; it is resumable and is not part of `npm test`.

Chrome is launched with `--use-gl=swiftshader`, `--enable-webgl`, `--ignore-gpu-blocklist`, and
`--headless=new`. The browser downscales each photo to a long edge of 1280 with the shared sizing
function, exports that exact input PNG, and uses the same file for Python LUT application. Thus the
comparison does not hide errors behind two different resizers.

`harness/out/` contains `<stock>/<photo>-shader.png`, `-python.png`, and `-diff.png` for every pair,
`adjustments/<stock>/…` for every EV/WB/post case, `thumbs/` for the generated thumbnails, plus
`report.json`, `report.md`, `inputs/`, `contact-shader.jpg`, `contact-adjust.jpg`, and
`contact-thumbs.jpg`. Diff images show absolute 8-bit channel differences amplified 16×. The harness
fails unless every pair has mean ΔE2000 < 0.3 and max ΔE2000 < 2.0. It also checks intensity 0 and
0.5 for every stock on the first photo; zero must match the original within one code even with
extreme EV/WB/post settings applied, and half intensity must match the unrounded-Python-LUT
midpoint within one code and the same ΔE limits. Adjustment cases compare the shader against
NumPy implementations of the same math, thumbnails are checked against a pixel-centre bilinear
sample of the exported input, and the median stock-switch and thumbnail timings must stay below
300 ms.

Reported shader time includes draw, `gl.finish()`, and a one-pixel synchronous readback, but excludes
photo/LUT upload and PNG encoding. This is a repeatable headless comparison timing, not a real-phone
performance measurement.

The final on-box full run passed **66/66 default pairs**, **11/11 intensity checks**, **61/61
adjustment pairs**, and **11/11 thumbnails**. The worst default mean ΔE2000 was **0.0005203500**
(`velvia100/p237`) and the worst default maximum was **1.2104642391** (`portra160/p1015`); the worst
adjustment mean was **0.0004473071** and the worst adjustment maximum **1.2241792679**. Median
render/readback time was **18.55 ms**, median thumbnail `setLut`+render+readback **1.20 ms**, and
median full-preview stock switch **18.20 ms**. Intensity 0 was code-exact; intensity 0.5 stayed
within one code. See `harness/out/report.md` for the full per-stock and per-pair tables.

## Performance expectation and fallback boundary

For a typical 12 MP JPEG on a mid-range phone, the approximately one-second Phase-2 target is an
**engineering estimate**, not a device measurement: JPEG decode/orientation inspection roughly
150–400 ms, one-pass downscale roughly 80–250 ms, bounded texture upload roughly 20–80 ms, and a
LUT draw roughly 10–30 ms, leaving margin within 1 s after warm-up. The first LUT use additionally
depends on subpackage network latency. The harness proves the downscale/upload/draw and numerical
path on the build box; only a physical-device profile can confirm this budget.

If WebGL context creation fails, the page deliberately selects `renderer/fallback2d.js`, which throws
`not implemented`. Shader compile/link failures are reported rather than mislabeled as context
failure. There is no silent CPU or Canvas2D LUT approximation.
