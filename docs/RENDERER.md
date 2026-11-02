# WebGL LUT renderer

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).
The renderer applies the derived CC BY-SA 4.0 LUT/profile data without adding another colour transform.

## One implementation, two hosts

The canonical shader sources are:

- `shaders/lut.vert.glsl` — full-screen WebGL1 quad and image texture coordinates;
- `shaders/lut.frag.glsl` — tiled-grid trilinear LUT lookup and intensity mix.

WeChat cannot portably fetch a `.glsl` asset as source text, so `tools/embed_shaders.py` writes the
committed `utils/shaders.js` CommonJS module. After changing GLSL, run:

```sh
python3 tools/embed_shaders.py
python3 tools/embed_shaders.py --check
```

The static checker rejects a stale embedding. The Mini Program and headless browser both execute
`utils/lut-renderer.js`; the browser reads the raw `.glsl` files, while the Mini Program uses their
generated string embedding. There is no second copy of the lookup equations in the harness.

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

Both textures use WebGL1 `UNSIGNED_BYTE`, `LINEAR` minification/magnification, `CLAMP_TO_EDGE`, and
no mipmaps. The LUT upload internal format is `RGB` (RGB888). Dithering, depth testing, and blending
are disabled. DOM/canvas colour-space conversion and unpack Y-flip are disabled where the host
exposes those controls. The vertex shader flips V for the top-row-first photo canvas; LUT V remains
in native PNG row order because green increases down each tile.

The LUT uniforms are:

| Uniform | Meaning |
|---|---|
| `uImage` | Downscaled, upright, encoded-sRGB photo on texture unit 0 |
| `uLut` | Tiled RGB LUT on texture unit 1 |
| `uN` | Cube edge length, 33 for the shipped assets |
| `uCols` | Tile columns, 8 |
| `uRows` | Tile rows, 5 |
| `uIntensity` | Blend amount in `[0,1]`; 1 is the full film transform |

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
override those two paths. `npm run test:smoke` runs only one pair and is not a substitute for `npm test`.

Chrome is launched with `--use-gl=swiftshader`, `--enable-webgl`, `--ignore-gpu-blocklist`, and
`--headless=new`. The browser downscales each photo to a long edge of 1280 with the shared sizing
function, exports that exact input PNG, and uses the same file for Python LUT application. Thus the
comparison does not hide errors behind two different resizers.

`harness/out/` contains `<stock>/<photo>-shader.png`, `-python.png`, and `-diff.png` for every pair,
plus `report.json`, `report.md`, `inputs/`, and `contact-shader.jpg`. Diff images show absolute
8-bit channel differences amplified 16×. The harness fails unless every pair has mean ΔE2000 < 0.3
and max ΔE2000 < 2.0. It also checks intensity 0 and 0.5 for every stock on the first photo; zero
must match the original within one code, and half intensity must match the unrounded-Python-LUT
midpoint within one code and the same ΔE limits.

Reported shader time includes draw, `gl.finish()`, and a one-pixel synchronous readback, but excludes
photo/LUT upload and PNG encoding. This is a repeatable headless comparison timing, not a real-phone
performance measurement.

The final on-box full run passed all **66/66 pairs** and **11/11 intensity checks**. Across all
stocks/photos, the worst mean ΔE2000 was **0.0005203500** (`velvia100/p237`), the worst maximum was
**1.2104642391** (`portra160/p1015`), and median render/readback time was **9.90 ms**. Intensity 0
was code-exact; intensity 0.5 stayed within one code. See `harness/out/report.md` for the full
per-stock and per-pair tables.

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
