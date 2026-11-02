# wx-spektrafilm — Plan

A WeChat Mini Program (native, JS/WXML/WXSS) for film-emulation of phone photos, using
pre-baked 3D LUTs generated from [spektrafilm](https://github.com/andreavolpato/spektrafilm)
and applied on-device via WebGL. No backend. License: GPLv3.

## Phase 0 — Scaffold & compliance
Tasks:
1. Native Mini Program scaffold at repo root: `app.js`, `app.json`, `app.wxss`,
   `project.config.json` (appid `"touristappid"`, `miniprogramRoot` = "./", compileType "miniprogram",
   `libVersion` "latest", `setting.urlCheck` false), `project.private.config.json` NOT needed,
   `sitemap.json`, `pages/index/index.{js,json,wxml,wxss}` (simple placeholder page: title,
   "choose photo" button stub).
2. `LICENSE`: full, unmodified GPLv3 text (fetch from https://www.gnu.org/licenses/gpl-3.0.txt with curl).
3. `README.md`: project description; attribution line exactly "Film modeling powered by spektrafilm"
   with link https://github.com/andreavolpato/spektrafilm; note that LUT/profile data derived from
   spektrafilm are CC BY-SA 4.0 (Andrea Volpato) — see https://github.com/andreavolpato/spektrafilm/blob/main/SPEKTRAFILM_LICENSE.txt ;
   GPLv3 for this project's code; dev instructions (open in WeChat DevTools, touristappid).
4. `AGENTS.md`: project conventions (see below).
5. `.gitignore` (node_modules, .venv, build/, *.pyc, __pycache__, project.private.config.json, .DS_Store).
6. Directory placeholders: `tools/` (Python scripts), `docs/`, `assets/` (with `.gitkeep` where empty).

Acceptance criteria:
- Every `*.json` parses with `python3 -c "import json,sys;json.load(open(f))"`.
- `app.json` `pages` lists `pages/index/index` and each listed page has js/json/wxml/wxss files.
- project.config.json has `"appid": "touristappid"`.
- LICENSE is GPLv3 (starts with "GNU GENERAL PUBLIC LICENSE", Version 3, ~674 lines).
- README contains attribution line, spektrafilm link, CC BY-SA 4.0 note.
- No file larger than 100 KB in the repo.

## Phase 1 — LUT baking (tools/)
Environment: `source /workspace/venv-sf/bin/activate` (Python 3.13; spektrafilm 0.3.4 editable from
/workspace/spektrafilm, which has the `spektrafilm-lut` CLI and `spektrafilm.runtime.api`
`create_params/simulate`; read /workspace/spektrafilm/README.md and src/spektrafilm_lut_creator/README.md first).
Machine has 8 cores but only ~3 GB free RAM: use small test images (<= ~1.5 MP), avoid parallel heavy jobs.
Pillow and numpy are installed; add nothing heavy.

Goal: bake LUTs for 11 stocks for sRGB JPEG photos from phones, convert to compact 2D strip PNGs
for a WebGL shader, validate against the full spektrafilm pipeline, make a contact sheet.

Stocks (id -> film profile -> print profile; choose the print profile sensibly from what the repo
documents/uses by default for that stock; prefer kodak_portra_endura for Portra, kodak_endura_premier or
kodak_supra_endura for Gold/Ultramax, kodak_ultra_endura for Ektar, fujifilm_crystal_archive_typeii for
Fuji, kodak_2383 for Vision3; document the choice and why in tools/stocks.json):
 portra400, portra160, gold200, ultramax400, ektar100, velvia100, provia100f, kodachrome64,
 pro400h, vision3_250d, vision3_500t.
Slide films (velvia/provia/kodachrome) may need a slide/positive-appropriate path — look at how the
repo handles positive stocks and do the right thing; if a slide stock cannot be baked sensibly, say so
and drop/replace it (e.g. fujifilm_xtra_400 / kodak_portra_800) while keeping >= 8 stocks.

Deliverables:
1. `tools/stocks.json`: list of {id, name (display), film, print, iso, category, notes}.
2. `tools/bake_luts.py`: bakes every stock with the spektrafilm-lut API/CLI: input sRGB, output sRGB,
   topology 1lut, resolution 33 (fallback 17 if size/quality demands), into build/ (gitignored).
   Choose `--stops-above-gray`/exposure so a normal display-referred phone JPEG (sRGB 0..1) maps to a
   well-exposed, neutral-midtone-preserving result (mid gray ~ stays mid gray); document the choice.
   Must be re-runnable and print per-stock timing.
3. `tools/convert_luts.py`: reads the baked cubes and writes `subpackages/luts/<id>.png`: an 8-bit RGB
   PNG strip, width = N*N, height = N, no alpha, no gamma/ICC chunk (strip with Pillow `optimize=True`).
   Layout (document it in docs/LUT_FORMAT.md): blue slice b occupies x in [b*N,(b+1)*N); within a slice,
   x = red index, y = green index; pixel value = output RGB (sRGB-encoded, clipped to 0..1, round to 8 bit).
   Write `subpackages/luts/luts.json` manifest: [{id,name,iso,category,file,size:N,film,print}].
   Total size of subpackages/luts must be < 1.5 MB (report actual).
   Also write `tools/lut_apply.py` with `apply_strip_lut(img_uint8, png_path)`: pure numpy trilinear
   interpolation that mirrors exactly what a WebGL shader would do (incl. half-texel handling note).
4. `tools/validate_luts.py`: for each stock, take >= 3 test images (convert from
   /workspace/spektrafilm/img/test/portrait_leaves_32bit_linear_prophoto_rgb.tif to an sRGB 8-bit JPEG
   downscaled to ~1.2 MP, plus /workspace/spektrafilm/img/targets/it87_test_chart_2.jpg (downscale), plus a
   synthetic image: 24-patch-like colour ramp/gradients). Compute the reference by running the full spektrafilm
   pipeline (simulate) with the SAME film/print/exposure settings and sRGB in/out, grain/halation/diffusion
   OFF (the LUT can't encode them) and the same input/output encoding, then apply the strip LUT and compare:
   mean and 95th-percentile CIEDE2000 (skimage.color.deltaE_ciede2000 on sRGB->Lab), plus mean abs 8-bit error.
   Save results to docs/validation.json and docs/validation.md (table). Target: mean dE2000 < 2 on natural
   images; if worse, investigate (resolution 33->65 internally, shaper, clipping) and report honestly.
   Keep test images out of git except tiny downsized samples (<= 200 KB total) under tools/testdata/.
5. `tools/make_contact_sheet.py`: writes docs/lut-preview.jpg: original + each stock applied (using the strip
   PNG LUT) on the portrait test image, labelled with stock names, grid layout, total JPEG < 600 KB.
6. `tools/README.md`: how to run bake -> convert -> validate -> contact sheet; `tools/run_all.sh`.

Acceptance criteria:
- `bash tools/run_all.sh` runs from a clean build/ and completes without error.
- >= 8 stocks (target 11) PNG strips exist in subpackages/luts, each N*N x N, total < 1.5 MB, manifest valid JSON.
- docs/validation.md has a per-stock per-image deltaE table; mean dE2000 reported.
- docs/lut-preview.jpg exists and looks sane (non-black, distinct looks between stocks).
- No file in git > 600 KB. Do not commit large build artefacts.

## Phase 1b — phone-JPEG neutral tone calibration

The native-exposure Phase-1 LUTs kept mid gray but were unusable as a phone-photo look: print
Dmin left white near code 205–213, negative shadows were heavily crushed, and some stocks had a
large channel spread on neutral input. Phase 1b adds `tools/calibrate_tones.py`, run before the
bake. A per-stock camera-EV search first selects the physical exposure whose code-118 neutral
stays closest to 118 (all current stocks select 0 EV); print exposure remains normalized at 1.0.
Because physical exposure and scanner white/black calibration cannot reach the requested white
level and neutral spread, an explicit per-channel post-simulation tone/levels transform is also
calibrated from each stock's full 0..255 neutral response. Its 256x3 8-bit sRGB tables and
selected exposure parameters are recorded in `tools/stocks.json`, baked into each cube, and
applied identically to validation references.

Targets on the strip-LUT neutral ramp: input 255 -> output 242..252 (ideally 245–250), input 118
-> 118±8, input 60 -> >=45 for negative/print stocks and >=30 for direct-scan slides, neutral
channel spread <=3, and no highlight flat-top (outputs strictly increase at inputs 230, 250,
255; input 250 outputs below 250). `tools/validate_luts.py` writes a per-stock ramp table to
`docs/validation.md` and exits nonzero if any target fails. `docs/lut-preview.jpg` uses a
+1.5-stop linear-light, normally exposed derivative of the portrait (labelled), with original
plus 11 stock tiles. All Phase-1 size and mean-dE2000 < 2 criteria remain in force.

## Phase 2 — Pick & preview

Native WeChat Mini Program only (no framework, no npm build step for the app itself). ES2015+,
2-space indent. Main package must stay under 2 MB; LUTs stay in a subpackage.

### Goals
Replace the Phase-0 placeholder index page with a working photo picker and WebGL canvas preview
(the actual film look lands in Phase 3; Phase 2 must already put the chosen photo on a WebGL canvas
so Phase 3 only adds the LUT shader).

### UI / UX
- Full-screen dark UI consistent with `app.json` window colours.
- Primary actions: "从相册选择" and "拍照" (or one button that opens `wx.chooseMedia` with both).
- After pick: show the photo filling the preview area (contain, letterbox if needed), a loading
  indicator while decoding/resizing, and a clear error toast/banner on failure (permission denied,
  cancel, decode failure, unsupported type).
- Empty state: short attribution line "Film modeling powered by spektrafilm".

### Behaviour
1. `wx.chooseMedia({ count:1, mediaType:['image'], sourceType:['album','camera'], sizeType:['compressed','original'] })`.
2. Read the temp file; decode with `wx.getImageInfo` (and/or canvas Image) to get width/height/orientation.
3. Handle EXIF orientation so the preview is upright. Prefer `wx.getImageInfo` orientation / drawing
   with the correct transform; document the approach and any WeChat quirks in `docs/ORIENTATION.md`.
4. Downscale for preview: long edge target **1280 CSS px**, capped by `Math.min(devicePixelRatio*longEdge, maxTextureSize, 2048)`.
   Keep aspect ratio. Prefer `wx.canvasToTempFilePath` / offscreen 2d canvas or `createImage` + drawImage
   for the resize; do **not** keep a multi-megapixel texture in GPU memory for preview.
5. Draw the (oriented, downscaled) RGB image as a WebGL texture onto `<canvas type="webgl">` with a
   passthrough fragment shader (Phase 2). Keep a clearly marked stub for the Phase-3 LUT shader so the
   swap is a one-line change of the fragment source / program.
6. Plan (do not implement yet) a Canvas 2D fallback path: leave a `renderer/fallback2d.js` stub that
   throws "not implemented" and is selected only if WebGL context creation fails; document it.

### Acceptance (Phase 2)
- Choosing a photo (album or camera) shows it upright on the WebGL canvas within ~1 s on a mid phone
  for a typical 12 MP JPEG (document how this was estimated; the headless harness must at least prove
  the downscale+draw path works on the box).
- Cancel / permission deny produces a user-visible message, no crash.
- Main package size (excluding `subpackages/`) < 2 MB; report `du` numbers.
- All JSON still parse; page files exist for every `app.json` / subpackage page entry.

## Phase 3 — WebGL LUT renderer + verification harness

### Mini Program renderer
1. **Subpackage**: register `subpackages/luts` in `app.json` (`root: "subpackages/luts"`, name `"luts"`,
   no pages needed — asset-only subpackage is fine; if WeChat requires a page, add a no-op
   `pages/empty`). Load LUTs lazily via `wx.loadSubpackage({ name: 'luts' })` before first use; show
   a loading state while the package downloads.
2. **Shared GLSL + JS core** under `shaders/` and `utils/` that both the Mini Program and the
   headless harness import (or copy — prefer a single source of truth: put the GLSL strings in
   `shaders/lut.vert.glsl` / `shaders/lut.frag.glsl` and a thin loader; the harness reads the same
   files). Do **not** duplicate the math.
3. **WebGL1 / GLSL ES 1.0** only (WeChat baseline). Vertex: full-screen quad. Fragment:
   - Sample the photo texture (LINEAR, clamp).
   - Compute cube coords `q = color * (N-1)`, `q0=floor(q)`, `q1=min(q0+1,N-1)`, `f=q-q0` for RGB.
   - For blue slices `b0` and `b1`, compute tile positions with `cols=8` as in `docs/LUT_FORMAT.md`
     and sample each slice with **hardware bilinear** (texture filter LINEAR) at half-texel centres
     for red/green. Mix the two samples by `fb`. Never let a bilinear footprint cross a tile boundary
     into another blue slice (address red within the tile; clamp u to the slice's interior).
   - LUT texture: upload the PNG as RGB888, **LINEAR** min/mag, CLAMP_TO_EDGE, no mipmaps.
   - Uniforms: `uImage`, `uLut`, `uN`, `uCols`, `uRows`, `uIntensity` (0..1; `mix(original, graded, intensity)`).
   - Output is encoded sRGB already (shaper domain = encoded sRGB). No extra gamma.
4. **UI**: simple horizontal/vertical stock list from `subpackages/luts/luts.json` (name + category);
   selecting a stock loads its PNG into the LUT texture (cache previously loaded ones in memory).
   Intensity slider (default 1.0). Press-and-hold on the preview shows the original (intensity→0 while
   held; restore on release). Reset / clear photo control.
5. Match `tools/lut_apply.py` exactly at intensity=1.0.

### Headless verification harness (required; WeChat DevTools is unavailable)
Under `harness/` (Node, not shipped in the Mini Program package):
1. Use Puppeteer against the box's Google Chrome with `--use-gl=swiftshader` (or ANGLE/SwiftShader)
   so WebGL1 works headlessly. Install deps into `harness/package.json` (gitignored `node_modules`).
2. A page that loads the **same** `shaders/lut.*.glsl` + a JS port of the Mini Program's texture
   upload / draw path, renders each of the 6 phone photos in `/workspace/testphotos/*.jpg` (downscaled
   the same way as the app, long edge 1280) through all 11 stocks at intensity 1.0, and writes:
   - `harness/out/<stock>/<photo>-shader.png`
   - `harness/out/<stock>/<photo>-python.png` (from `tools/lut_apply.py`)
   - `harness/out/<stock>/<photo>-diff.png` (amplified abs diff)
   - `harness/out/report.json` and `harness/out/report.md` with per-pair mean/p95/max ΔE2000 and
     mean abs 8-bit error, plus median shader render time in ms.
3. Acceptance: for every stock × photo, **mean ΔE2000 < 0.3** and **max ΔE2000 < 2.0** vs the Python
   LUT apply on the same downscaled input. Fail the harness with nonzero exit if any pair fails.
4. Also produce `harness/out/contact-shader.jpg`: a contact sheet of original | shader for a few
   stocks on one photo (for the human report).
5. Document how to re-run: `cd harness && npm i && npm test`.

### Static checks (no AppID)
- Script `tools/check_miniprogram.py` (or `harness/check_static.mjs`): every `app.json` /
  `project.config.json` / page / subpackage JSON parses; every page listed has js/json/wxml/wxss;
  no `require` of Node builtins in app code; main package file-size sum < 2 MB; subpackage luts
  size reported. Note that `miniprogram-ci` needs an AppID/private key — skip and document.

### Acceptance (Phase 3)
- Harness report all-green against the thresholds above.
- Main package < 2 MB; LUT subpackage size reported.
- Intensity slider and press-and-hold compare work (unit-test the mix math in the harness at
  intensity 0 and 0.5 as well: intensity 0 == original within 1 code; 0.5 ≈ midpoint).
- `docs/RENDERER.md` explains the shader, uniforms, half-texel rule, and how it mirrors
  `lut_apply.py`.
- `docs/LIMITATIONS.md` updated: DevTools/real-device unverified; Canvas2D fallback stub only;
  grain/halation etc. still later.

## Phase 4 — Presets UI + basic adjustments

Rules unchanged: native Mini Program, GLSL single source of truth in `shaders/` (embedded via
`tools/embed_shaders.py`), no duplicated lookup math, main package < 2 MB, LUT subpackage budget
total < ~1.2 MB (currently 0.29 MB), local commits only, GPLv3 + spektrafilm credit.

### 4a. Faithful exposure (EV) and white balance — study first, then implement
Principle: LUTs are baked from spektrafilm's physical pipeline at camera EV 0; any control that
touches the *input side* must be a camera-side operation in LINEAR light before the LUT, and must be
validated against the real `simulate()` with the same setting.

1. **Exposure EV** (slider about -2 .. +2 EV, step 0.1, default 0). Semantics: real camera exposure
   compensation with the print exposure FIXED (like printing at a fixed enlarger time) = what a
   photographer sees as over/under-exposing film. In spektrafilm terms:
   `camera.exposure_compensation_ev = EV` with `enlarger.print_exposure_compensation = False`
   (all other params identical to the baked recipe; confirm EV=0 reproduces the shipped LUT).
   Also report, for information, the behaviour with `print_exposure_compensation = True`
   (auto-printing, which nearly cancels EV for negatives; slides unaffected by the flag).
   Candidate implementations — measure, then pick the most faithful within the subpackage budget:
   (A) shader multiplies linear RGB by 2^EV before the LUT (input then clipped to 0..1 sRGB range);
   (B) extended-range LUTs (input shaper covering e.g. up to +2 stops of linear headroom, so
       gained highlights are not clipped) via the LUT creator's input shaper/`stops_above_gray`
       machinery or an equivalent that stays within spektrafilm's own parameters;
   (C) a small set of baked EV LUTs (e.g. -1/0/+1) interpolated in the shader;
   (D) combinations. Do not invent ad-hoc curves: the reference is always full `simulate()`.
   Evaluate EV in {-2,-1,-0.5,+0.5,+1,+2} on the 6 test photos x 11 stocks (use a representative
   subset if too slow; at least 4 stocks incl. 1 slide and 1 cinema, 3 photos): report mean/p95/p99/max
   dE2000 of (shader/LUT path) vs (full simulate with same EV). Targets: mean dE < 1.0 and p95 < 2.5 for
   |EV| <= 1; for |EV| <= 2 report honestly and, if worse, limit the slider range to what is faithful.
   Document in `docs/EXPOSURE_EV.md` with tables and the decision.
2. **White balance** (temperature -100..+100 and tint -100..+100, default 0): camera-side gains in
   linear sRGB RGB before the LUT: derive from a documented, simple model (e.g. Bradford chromatic
   adaptation between D65 and a CCT in [~3000K, ~12000K] mapped from the slider, plus a green/magenta
   tint axis), applied as a 3-vector gain uniform (`uWbGain`) combined with EV into one linear gain
   uniform `uLinearGain` (vec3). Reference for validation: apply the SAME gains to the linear input in
   Python, run the full `simulate()` on that, compare with the shader path (dE as above, for several
   settings, e.g. temp +-50, tint +-50). Slider mapping function lives in a pure JS module shared with the
   harness (`utils/adjust.js`), unit-tested (monotonic, identity at 0, gains normalised to preserve
   luminance Y of white).
3. Pre-LUT path in the shader: sRGB->linear (exact piecewise sRGB), multiply by `uLinearGain`, clamp to
   [0,1] (or extended-range handling per decision above), linear->sRGB, then LUT. At defaults (gain=1) the
   output must equal Phase-3 output within 1 code (regression check against `tools/lut_apply.py`).
4. Optional **post-LUT** tweaks, clearly labelled "后期微调（非胶片物理）" in UI and docs:
   contrast (-1..1 pivot at 0.5 in sRGB-encoded domain; default 0) and saturation (0..2; default 1; use
   Rec.709 luma). Identity at defaults. Applied after the intensity mix? Decide and document (prefer: after
   LUT, before intensity mix is wrong; apply after the mix on the final colour). Harness vs Python reference.
5. Intensity (existing) stays; before/after (press & hold) shows the untouched original.

### 4b. Presets UI
- Stock picker grouped by category with section headers: 彩色负片 / 反转片（幻灯片）/ 电影胶片.
  Each card: name, ISO, a short Chinese description (1 line, factual & tasteful; written by the agent from
  the stocks' known character and our measurements, avoid false claims), and a **thumbnail** rendered from the
  current photo.
- **Thumbnails**: generated lazily (visible/near first, others idle), size ~96x(aspect) px, rendered via the shared renderer
  into a small framebuffer / offscreen target, read back (or equivalent) into an image the `<image>` tag can
  show (data URL or temp file; document the WeChat-specific path and what the harness can verify), cached per
  (photo id, stock). Invalidate on new photo; thumbnails show the stock at intensity 1 with default
  adjustments (do not regenerate on every slider move). Switching stock in the harness must take < 300 ms
  median (setLut + render + readback), measured and reported.
- Adjustments panel (collapsible, below the picker): 曝光 EV, 色温, 色调, 强度, and a collapsed
  「后期微调」 group (对比度, 饱和度). Numeric readouts. A single 「重置」 button resets all adjustments
  (not the photo/stock); long-press compare remains.
- 「关于」 section (collapsible/modal): "胶片模拟基于 spektrafilm（Andrea Volpato）"; link text to
  github.com/andreavolpato/spektrafilm; licence notes (GPLv3 code; LUT data CC BY-SA 4.0); version; "当前未包含颗粒、光晕等空间效果".
- Dark, clean, polished Chinese UI (WXSS): consistent spacing, touch targets >= 44rpx height,
  safe-area padding, disabled/loading states, no layout jumps. Respect low-end devices: no heavy per-frame
  setData; slider `bindchanging` updates the renderer directly and throttles `setData` for readouts.

### 4c. Verification
- Extend the harness (`npm test`) with: (i) identity regression vs Phase-3 outputs, (ii) EV/WB/contrast/
  saturation shader paths vs Python references (`tools/` or `harness/compare.py`), thresholds mean dE2000 < 0.3
  and max < 2.0 for the *shader vs Python implementation of the same math*, (iii) the separate faithfulness study
  numbers vs full `simulate()` (heavy; run via `npm run study:ev`, results committed as docs, not in the default
  `npm test`), (iv) thumbnail generation + stock switch timing, (v) pure-JS unit tests for slider mappings.
- Static checks: extend `tools/check_miniprogram.py`: every `bind*/catch*` handler named in WXML exists on the page;
  WXML tags balanced; every `{{data}}` root identifier used in WXML exists in `data` or is a wx:for item
  (best effort); WXSS has no `@import` of missing files and no unsupported selectors (`*`, `:hover` on
  non-hover-class is OK to flag as warning); sizes < limits.
- Produce `harness/out/contact-adjust.jpg`: one photo, one stock, rows for EV -2..+2, WB cool/warm, and
  contrast/saturation extremes (labelled), plus `harness/out/contact-thumbs.jpg` showing the 11 generated
  thumbnails.

### Acceptance (Phase 4)
- 4a decision documented with numbers; mismatch vs full physics reported honestly; slider range chosen accordingly.
- Harness all-green on defaults regression + new paths; stock switch median < 300 ms; thumbnails generated for all
  11 stocks.
- Main package < 2 MB; LUT subpackage < ~1.2 MB total; report sizes.
- Static checks pass; docs: `docs/EXPOSURE_EV.md`, `docs/ADJUSTMENTS.md`, `docs/RENDERER.md` updated, `docs/LIMITATIONS.md`,
  README feature list updated.

## Later phases
5 effects (grain/halation shaders) & export (`wx.canvasToTempFilePath` + `wx.saveImageToPhotosAlbum`);
6 release (privacy policy, review). Server mode remains dropped.
