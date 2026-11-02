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

## Later phases
2 pick & preview; 3 WebGL LUT renderer; 4 presets UI; 5 effects & export; 6 release.
(Server mode dropped: route A only.)
