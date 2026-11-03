# Real-device black-preview investigation

Scope: iPhone WeChat report for AppID `wxa4be938db07a4bb4`, reported build `01144db`: LUT cards were
listed, but after picking a photo both the main canvas and every rendered stock thumbnail were black.
The three dark thumbnail bands matched the canvas/letterbox geometry, and framebuffer readback itself
still produced images. This file records code evidence, not a claim that the physical phone was
attached to a debugger.

## Root cause and fix

**The failing operation was the direct host-source `texImage2D` upload (H1).** Before this fix,
`utils/photo.js::preparePhoto()` returned an offscreen Canvas2D from
`wx.createOffscreenCanvas({type:'2d'})`, and both the page and export called
`renderer.setPhoto(prepared.canvas)`. The shared renderer then used the six-argument host-source
overload with `gl.RGB`. LUTs similarly used direct `canvas.createImage()` sources. That overload is
not a portable WeChat/iOS bridge for every offscreen Canvas2D/Image implementation: a host can accept
the call without throwing while supplying zero texels. Once the photo texture is zero, intensity 0,
the normal main pass, halation exposure, and every thumbnail all read black; the later 2D/readback
export faithfully encodes that black. This explains why cards and the readback/export path remain
alive while all rendered content is black.

The phone was not available for direct instrumentation, so the original build's zero texels remain a
**device-only confirmation**, rather than a falsely claimed observation. The source-level defect is
nevertheless concrete: rendering depended on the non-portable overload with no content validation.
The shared renderer now uses this ladder for photo, base LUT, and extended LUT alike:

1. **P (preferred): RGBA bytes.** Read an existing Canvas2D 1:1 with `getImageData`; for an
   Image/ImageBitmap, draw it 1:1 with smoothing disabled into a scratch 2D canvas and read it. Upload
   a `Uint8Array` using the nine-argument `texImage2D(..., RGBA, width, height, 0, RGBA,
   UNSIGNED_BYTE, pixels)` overload. This bypasses the direct host-source bridge and host colour-space
   conversion.
2. **Self-check.** A photo is drawn through a trivial passthrough shader into a 4×4 framebuffer and
   read back; its GPU mean and centre texel are compared with CPU-known source values. A LUT is probed
   at the white corner of **blue slice N−1**, computed from `size`/`cols` (the PNG's bottom-right may be
   an unused zero-filled padding tile). A non-black CPU source producing a near-zero GPU result is a
   failure; a LUT probe differing by more than one code is also a failure. **Zero CPU bytes are not a
   valid success reference:** photo mean ≤1 or LUT white-node mean ≤2 marks `cpuDecodeSuspect` and
   requires both P and D. See the follow-up section below.
3. **D (fallback): direct source.** Retry the six-argument RGBA source upload, read back the same
   probes, and record both attempts. Failure switches the preferred strategy for later uploads;
   failure of both strategies throws instead of displaying an unexplained black image.

Every nonzero `gl.getError()` is logged with `[wx-spektrafilm][diag]` and retained in the report.
The page, thumbnails, and export all use this one renderer implementation. The harness forces P and D
for the photo/base/extended LUT, compares full renders, and injects zero-filled direct photo and LUT
uploads to prove that both fall back to P.

### Zero Canvas2D readback follow-up

The first self-check still had a zero-equals-zero hole: if `getImageData()` returned an all-zero array,
P could faithfully upload those bytes and pass. The decoder now classifies that input as suspect before
accepting either strategy:

- For a page/export photo, `utils/photo.js` keeps the original fully loaded Image alive until the upload
  decision. On an initial all-zero CPU decode, the renderer invokes one `retryDecode()` callback, which
  clears and redraws the same oriented output canvas directly from that original Image with the same
  EXIF transform and downsampling. The Image is then released. There is no unoriented original-Image
  upload and no repeated retry loop.
- P is never accepted solely from a suspect CPU array. P and D are both attempted. If D's 4×4 photo
  mean is >2, or its LUT white node is non-black, D is accepted and becomes the sticky preferred
  strategy. The texture, attempts, and text report carry `cpuDecodeSuspect:true`; recovery logs
  `console.error`.
- If photo P and D both read black, P is accepted without throwing because a genuinely black photo is
  legal. `photoAllBlack:true` is recorded, and only this photo case shows the page banner
  「照片读取为全黑，可在 关于 → 诊断 查看」. A LUT with a black native white node is not a valid LUT and
  does not use that acceptance/warning path.
- Browser tests independently fake zero `getImageData()` while direct upload remains valid (photo and
  LUT must choose sticky D), then fake both CPU and direct output as zero (photo returns normally with
  `photoAllBlack`). A Node test proves the original-Image redraw and idempotent release policy.

## Ranked hypothesis checks

### H1 — host-source upload: root-cause match, fixed

- **Found:** the oriented preview and export textures were direct offscreen Canvas2D uploads; LUTs were
  direct Image uploads. No upload content check existed.
- **LUT readiness:** `loadCanvasImage()` resolves only in `image.onload`; the page creates LUT Images
  from the preview canvas. Extended LUTs go through the same awaited loader. There is no early
  `texImage2D` before `onload` in the reviewed paths.
- **Canvas ownership:** export LUT Images can originate from the page canvas while the GL context
  belongs to an offscreen export canvas. P removes any same-node dependency by uploading bytes. D
  remains only as a tested fallback, not the preferred dependency.
- **Fix:** shared P→D ladder and diagnostics as above.

### H2 — WebGL1 completeness and sampler binding: no original mismatch found, hardened

- The original creation helper did set `LINEAR` min/mag and `CLAMP_TO_EDGE` on the same texture before
  its upload, with no mipmap generation. `texImage2D` reallocation does not reset those parameters on
  that texture object. NPOT photo, 264×165 base, and 392×343 extended textures therefore were not
  incomplete merely because of their dimensions.
- The original 1×1 placeholders were complete RGB textures. `uImage=0`, `uLut=1`, `uLutExtended=2`,
  and `uHalo=3` matched the draw bindings. The halo helper uses unit 0 and rebinds its actual source
  for each of its three passes. No wrong unit, missing rebind, or null/`-1` sampler location was found.
- **Hardening:** every texture (including target, halo A/B, probe, and unused samplers) now comes from
  one helper, starts as an opaque complete 1×1 RGBA texture, and uses LINEAR/CLAMP_TO_EDGE/no mipmaps.
  Per-texture status, size, unit, strategy, alpha range, self-checks, and GL errors are reported.

### H3 — pixelStore, drawing buffer, viewport, compositing: no standalone math defect found

- Y flip was already false and direct-source colour-space conversion was already `NONE` where exposed.
  Premultiply is now explicitly false; colour-space conversion is only set for direct sources because
  P bytes are already defined RGBA values. Errors from unsupported calls are captured rather than
  hidden.
- **Page rule:** after a pick, drawing-buffer width/height are exactly the oriented, bounded photo
  dimensions. The page calls `resize()` (which sets both dimensions and `gl.viewport`) **before**
  `setPhoto()` and the first draw. CSS only fits that buffer inside the stage. The empty state uses the
  canvas node's CSS size × device pixel ratio. `fitCanvas()` now waits for its `setData` callback.
- `alpha:false` and `preserveDrawingBuffer:true` are retained and included in the report. Because the
  offscreen framebuffer used for thumbnails was also black, canvas compositing alone cannot explain
  the original report. The solid-colour and full-shader probes separate FBO/readback failure from main
  canvas presentation.

### H4 — GLSL precision and identity/uniform logic: ruled out by source and probes

- Both fragment shaders already select `highp` under `GL_FRAGMENT_PRECISION_HIGH`, with a mediump
  fallback. The diagnostic report includes the actual fragment `HIGH_FLOAT` range/precision.
- The flag uniforms (`uCameraIdentity`, `uPostIdentity`, `uUseExtended`, halo switches) are all GLSL
  `float` and set with `uniform1f`; sampler uniforms use `uniform1i`. All main/halo uniform locations
  are required at renderer construction. Intensity 0 returns the sampled original before LUT,
  exposure, grain, or post processing.
- No GLSL change was needed. Canonical `shaders/*.glsl` and generated `utils/shaders.js` remain in
  sync. The final diagnostic probe runs the full shader at intensity 1 and 0; intensity 0 is compared
  with a CPU bilinear centre sample.

### H5 — LUT PNG decode: ruled out for the shipped assets, now observable

- `tools/check_miniprogram.py` verifies every shipped LUT is 8-bit RGB PNG colour type 2 with the
  manifest dimensions. The assets have no source alpha. P's 2D readback produces RGBA and the report
  records alpha min/max; SwiftShader reports 255…255 for base and extended LUTs.
- A host decode problem remains distinguishable on device: CPU probe values are printed next to GPU
  values. No colour-managed or premultiplied source bytes are silently treated as known-good.

## How to read the next on-device report

Open **关于 → 诊断**, or long-press **SPEKTRAFILM**, then use **复制**. **重新运行** repeats the suite.
Error banners generate the same in-memory report and add 「已生成诊断，可在 关于 → 诊断 查看」. The full
text is also logged with `[wx-spektrafilm][diag]`.

| Evidence | Decisive interpretation |
|---|---|
| Solid `(255,0,128,255)` is not exact | Basic FBO draw/readback or driver failure; not a LUT problem |
| Solid passes, CPU photo is non-black, GPU photo probes are black | Photo upload/source bridge failure; check P/D attempts and fallback |
| Photo probes pass, LUT white probe fails while CPU is non-black | LUT decode/upload failure; check the b=N−1 coordinate and alpha |
| Photo and LUT probes pass, full intensity 0 fails | Quad/UV/main-program/uniform path, not source upload alone |
| Intensity 0 passes but intensity 1 is black/wrong | LUT selection/lookup/uniform path; compare base/extended status |
| All FBO probes pass but only the visible canvas is black | Canvas drawing-buffer/viewport or iOS compositing; use the reported sizes/attributes |
| `direct` fails and `pixels` passes | Confirms H1 on that host; the app should nevertheless have recovered automatically |
| Any nonzero GL error | Its stage and texture name identify the failing operation |

The report intentionally contains only tiny probe values, not photo pixels or files. It is held in
memory for the current page process, not persisted or uploaded.

## Verification boundary

The formatter is Node-tested. The GL suite runs in Chrome/SwiftShader with exact solid-colour output,
photo/LUT probes within one code, and a full-shader intensity-0 comparison within one code. Those
tests and the zero-upload mocks make the recovery logic deterministic, but only the copied report
from the affected iPhone can certify that host's actual source-upload behaviour and compositing.
