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

## Later phases
2 pick & preview; 3 WebGL LUT renderer; 4 presets UI; 5 effects & export; 6 release.
(Server mode dropped: route A only.)

## Phase 1c — Physically faithful bake (SUPERSEDES Phase 1b)

**Rule: the LUT must equal spektrafilm's real pipeline.** No ad-hoc per-channel post-simulation
tone/levels/curve step of our own. `tools/calibrate_tones.py`'s tone-curve table and
`apply_tone_curve` are to be REMOVED (delete the `tone_curve` data from tools/stocks.json too).
Brightness/tonality are fixed only via spektrafilm's own parameters, and every setting is applied
identically in (a) the LUT bake and (b) the reference full `simulate()` run used for validation.

Parameters to study and choose (document the reasoning + measurements in `docs/EXPOSURE.md`):
- Input: phone sRGB JPEG -> input colour space "sRGB" with CCTF decoding (linear), as filmroom
  (/workspace/filmroom, Rust port: app/src/main/java/dev/filmroom/model/EditorState.kt and
  native/crates/film-engine/src/mobile.rs `MobileParams::default()/runtime()`) and the spektrafilm GUI
  (src/spektrafilm_gui/param_manifest.py / state.py defaults) do. Use the LUT creator's
  `stops_above_gray` / `input_exposure_gain` mechanism (src/spektrafilm_lut_creator/builders.py) and the
  runtime's `camera.exposure_compensation_ev`, and understand `camera.auto_exposure` (center-weighted
  mean Y/0.184: image dependent, so cannot be in a LUT — instead derive the fixed gain that auto-exposure
  would choose on typical normally exposed phone photos: measure measure_autoexposure_ev over the
  test photos and use the median as the fixed exposure compensation, and compare with upstream LUT-creator
  default "+4 stops" convention).
- Print: `enlarger.print_exposure` (2**EV), `print_exposure_compensation`, `normalize_print_exposure`,
  `neutral_print_filters_from_database`, y/m filter neutral values, `illuminant`.
- Scanner: `scanner.white_correction/black_correction`, `white_level` (default 0.98), `black_level`
  (default 0.01) — the physical scan normalisation that maps paper white / paper black. Evaluate whether
  enabling them is how the GUI/filmroom get a usable white point (check filmroom's defaults + docs, and
  the spektrafilm GUI defaults); positive stocks use `io.scan_film=True`.
- Also check `runtime`'s gamut compression / `output_gamut` handling and use the same in both paths.
Method: write `tools/explore_exposure.py` that, for each stock, sweeps candidate settings on a neutral
sRGB ramp (and the natural test photos) with the real `simulate()`, and reports: ramp (codes
0,20,45,60,80,118,170,200,230,255 -> output), channel spread, white reach, mean luminance preservation on
the photos. Pick ONE principled global recipe (same parameter choices for all stocks, only per-stock
what spektrafilm itself defines per stock, e.g. database neutral filters, scan_film for slides) — not a
per-stock fit to targets. Soft goals (report, don't force via hacks): normal photos look normally exposed;
white reaches ≥ ~240 if achieved by scanner/print normalisation; neutrals stay neutral. If a stock
legitimately is dark/punchy (e.g. Ektar), accept and report it.

Test photos (normally exposed natural images, 1600x1067 JPEG, on the box only, do NOT commit them):
/workspace/testphotos/p1015.jpg (landscape/sky), p1025.jpg (forest/pug), p1043.jpg (Yosemite),
p1062.jpg (indoors/high-key), p237.jpg (black dog, wood), p433.jpg (bear). Downscale to <= 1.2 MP for
simulate to save RAM (machine has ~3 GB free; run sequentially, thread limits as in run_all.sh).
Keep the ProPhoto portrait + IT8 chart + synthetic image too, as additional validation images.

LUT resolution & layout: try N = 33, 49, 65 (and report error vs size). Because N*N could exceed
mini-program/GPU max texture width, change the strip layout to a TILED GRID: the N blue slices (each N x N,
x=red, y=green) arranged row-major in a grid with `cols = 8` (rows = ceil(N/8)); store `cols`, `rows`, `size`
in luts.json; max PNG side must be <= 2048. Update tools/lut_apply.py (numpy trilinear that mirrors the
shader: two bilinear fetches blended along blue, half-texel centres) and docs/LUT_FORMAT.md. Pick the
smallest N whose validation error is not materially worse than 65 (e.g. p95 dE2000 within ~0.1 of N=65),
with total subpackages/luts < 1.5 MB (8-bit PNG; consider whether 8-bit quantisation is a significant part
of the error and report it).

Edge handling: input is display-referred sRGB 0..1 so the encoded (gamma) domain is the shaper; verify
the corners/edges: report % of cube nodes whose physical output is outside [0,1] before clipping and how
the full pipeline handles them (gamut compression / clip) — use the same in the reference. Highlight
region: ensure near-white input (250..255) is monotonic and not flat-topped by the LUT stage itself.

Validation (validate_luts.py -> docs/validation.md/json): for each stock x image: mean, p95, p99 and MAX
dE2000 (LUT vs full simulate with identical settings, grain/halation/diffusion/stochastic effects OFF);
subset stats: shadows (reference L* < 20), highlights (L* > 85), saturated colours (chroma C*ab > 50);
plus the neutral ramp table and 8-bit quantisation-only error. Fail loudly (nonzero exit) if natural-image
mean dE2000 >= 1.0 or p95 >= 3.0 for any stock (adjust N if needed).

Contact sheet `docs/lut-preview.jpg` (< 800 KB): (1) a grid for at least 3 stocks (Portra 400, Ektar 100,
Velvia 100 or similar) x 2 natural photos where each row/triplet shows ORIGINAL | FULL PHYSICAL PIPELINE
(simulate) | LUT, labelled, so a human can compare; (2) a second image `docs/lut-all-stocks.jpg` with original + all
stocks (LUT) on one normally exposed natural photo. Also write per-pair absolute-difference stats under each triplet.

Excluded from the LUT (document in README + docs/LIMITATIONS.md): grain, halation/scatter, diffusion
filters, lens/scan blur, glare, DIR-coupler spatial diffusion, any other spatial/stochastic effects;
these are to be re-created later as WebGL shaders (grain, halation bloom, vignette-like diffusion).
