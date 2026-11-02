# Phase 4a implementation progress

This log covers **Phase 4 step 4a only**. The presets/adjustments UI (4b) is deliberately not
implemented. No git commits are made. Film modeling powered by
[spektrafilm](https://github.com/andreavolpato/spektrafilm).

## Milestone 0 — scope and baseline inspected

- Read `AGENTS.md`, Phase 4 of `PLAN.md`, renderer/LUT/exposure documentation, the shared physical
  parameter builder, bake/convert/validation tools, shared JS/GLSL, and all authored harness code.
- Baseline is clean: 11 N=33 stock LUTs, 297,046-byte LUT subpackage, and a previously green 66-pair
  Phase-3 harness.
- Study scope: representative Portra 400, Ektar 100, Velvia 100 (slide), and Vision3 500T (cinema),
  three supplied phone photos, each at no more than 240,000 pixels; EV −2, −1, −0.5, +0.5, +1, +2.
- Every physical reference will use public full `simulate()` through `simulate_srgb()` and the
  shared builder. Nonzero EV references use fixed print exposure
  (`print_exposure_compensation=False`); EV=0 is checked against the shipped LUT. Auto-printing is
  measured separately as a diagnostic, never substituted for the fixed-print reference.
- Candidates to measure: A native-domain linear gain; B extended-range LUTs; C per-EV LUTs and EV
  interpolation; D combinations. No fitted/ad-hoc tone curve is permitted.

## Milestone 1 — study tooling and candidate assets

- Extended `tools/bake_luts.py` with reproducible `--camera-ev` / `--fixed-print-exposure`
  variants and threaded the selected recipe through the custom pipeline factory.
- Added float-sRGB LUT application and shared NumPy adjustment math; existing uint8 LUT output
  remains bit-identical under a synthetic-fixture regression check.
- Baked representative B (N=33/N=49, +2-stop headroom) and C (N=17/N=25, EV −2/−1/+1/+2) assets
  serially. Added resumable full-`simulate()` candidate evaluation and automatic incremental docs.
- Caught and corrected an initial C-only pipeline-forwarding bug after the first checkpoint;
  invalidated all partial checkpoints before the clean rerun. The final report must not use the
  invalidated numbers.
- Added pure `utils/adjust.js`: EV/WB/post ranges, Bradford D65↔Planckian CCT adaptation, tint,
  white-Y normalization, and combined linear gain. Its initial unit tests caught and fixed a
  negative-temperature reciprocal-CCT sign error; mapping tests now pass.

## Milestone 1 — resume, candidate assets, and EV-bake correction

- Resumed from `git status`, both Phase-4 documents, process state, and `build/p4a/`; no heavy job is
  still running. Completed B33/B49 bakes and the all-stock auto-print neutral diagnostic are valid
  and will not be repeated.
- Three stock checkpoints existed when interrupted. Their A/B/D measurements exposed native-highlight
  clipping and good extended-range fidelity, but C was invalid: `StockBundleBuilder._make_pipeline()`
  had not forwarded the new recipe even though the manifest recorded it.
- Fixed the builder to pass the selected recipe into `make_runtime_params()`. Invalid C bakes and all
  image-study checkpoints must be regenerated; the valid auto-print diagnostic remains intact.
- Added and passed pure-JS mapping tests for identity, clamping, partial merge, monotonic CCT/RGB
  response, tint, and Rec.709 white-luminance normalization.

## Milestone 2 — shared adjustment math and WB reference boundary

- Added float-sRGB LUT lookup plus `tools/adjust.py`: exact piecewise sRGB decode/encode, linear RGB
  gain and boundary clamp, intensity-first mixing, then encoded-domain contrast/saturation.
- Added `utils/adjust.js` and `tools/wb.py`: reciprocal 6504 K→3000/12000 K temperature mapping,
  Kim Planckian-locus approximation, Bradford adaptation, ±0.5-stop green/magenta tint, and white-Y
  normalization. Twenty-five JS/Python gain pairs agree within 8.9e−16; mapping unit tests pass.
- Added `simulate_linear_srgb()` so WB references can apply gains without clipping before the real
  full pipeline. The original `simulate_srgb()` delegates to the same builder/route.
- The first corrected EV checkpoint is saved. A report-marker interruption was repaired without
  recomputing that checkpoint; the study resumed with the remaining stocks.

## Milestone 3 — complete EV candidate study

- Regenerated the invalid C assets and verified the fixed builder directly: representative two-colour
  ±1 EV probes differ from full simulation by less than 0.43 code before the image study.
- Completed all four stocks × three photos × seven EV values, with 240,000-pixel fixtures and exact
  pixel-pooled mean/p95/p99/max dE2000 in `docs/EXPOSURE_EV.md`.
- EV=0 print-compensation on/off differs by at most 0.0000076 code, confirming the shipped baseline.
- A fails the +1 EV p95 target (3.5361) because of native-domain clipping. C17/C25 pass the ±0.5
  targets but are substantially worse than extended-range D; B49 is consistently accurate through ±2.
- Provisional choice is **D49**: exact shipped N=33 path at identity/nonpositive EV without WB, plus
  an N=49 two-stop extended LUT for positive EV or nonidentity WB. Projected package 1,033,396 bytes.
  Final selection waits for the now-running WB faithfulness table and actual all-stock asset sizes.

## Milestone 4 — WB study and shared renderer implementation

- Completed the four-stock/three-photo WB study for six settings. B49 mean dE2000 is 0.1410–0.1670,
  p95 0.2966–0.3763, and worst max 1.6621; all are far inside the physical-faithfulness targets.
- Selected D49, pending only actual delivery size: native N=33 for identity and nonpositive EV without
  WB; N=49 +2-stop extended range for positive EV or any WB. The full −2…+2 EV range is retained.
- Implemented the canonical shader's exact piecewise sRGB camera path, combined `uLinearGain`, LUT
  selection, intensity-first mix, and last-stage contrast/saturation. Identity and intensity-zero
  branches preserve Phase-3/original behaviour rather than relying on floating-point round trips.
- Implemented renderer partial `setAdjustments()`, state readback, dual LUT upload, and cached
  offscreen RGBA `renderToPixels()` with top-down readback, temporary adjustments, viewport restore,
  and timing hooks. Added browser mapping-module loading and regenerated `utils/shaders.js`.
- Shader/browser numerical verification is not run yet; it follows delivery-asset conversion.

## Milestone 5 — delivery assets and identity smoke

- Baked all 11 N=49 extended LUTs from the shared physical recipe at camera EV0 and +2 stops input
  headroom. Atomic conversion preserved every base N=33 PNG and added one `*.ev2.png` per stock.
- Actual LUT subpackage size is **1,063,412 bytes (1038.5 KiB)**; static geometry/byte/JSON/package
  checks pass, including the new 1,200,000-byte Phase-4 limit.
- Harness loads both variants. Initial smoke caught a `render(0)`-before-LUT null dereference; fixed
  the guard and reran. Default Portra/p1015 matches Phase 3 (mean 0.0002941753, max 1.1840966940
  dE2000), with intensity 0/0.5 green.

## Milestone 6 — full harness green with adjustment coverage

- Consolidated the harness into one flow and fixed the duplicated-block/key mismatch it had
  inherited. The full run passes **66/66 default pairs**, **11/11 intensity checks**, **61/61
  EV/WB/post adjustment pairs**, and **11/11 thumbnails**.
- Worst default mean ΔE2000 **0.0005203500** / max **1.2104642391** (identical to the Phase-3
  baseline); worst adjustment mean **0.0004473071** / max **1.2241792679**; every adjustment pair
  is within one 8-bit code of the NumPy reference.
- Median render/readback **19.65 ms**, median thumbnail setLut+render+readback **1.80 ms**, median
  full-preview stock switch **15.10 ms** — both far below the 300 ms budget.
- `harness/out/contact-adjust.jpg` and `harness/out/contact-thumbs.jpg` were generated and
  visually checked (distinct looks, correct orientation, and the intensity-0 row identical to the
  original as required).
- Added the PLAN 4c static checks: WXML handler existence, tag balance, data-identifier
  resolution against the page `data` and `wx:for` aliases, WXSS `@import` targets, and warnings for
  `*`/`:hover` selectors. A negative test confirms each check actually fires.

## Milestone 7 — documentation and reproducibility

- `docs/EXPOSURE_EV.md` carries the complete candidate tables plus the final decision, EV/WB
  tables, and delivered sizes. `docs/ADJUSTMENTS.md` documents the model, ranges, operation order,
  and the renderer API. `docs/RENDERER.md`, `docs/LIMITATIONS.md`, `docs/LUT_FORMAT.md`,
  `tools/README.md`, and `README.md` describe the extended cube and the new checks.
- `npm run study:ev` is wired, documented, and verified re-runnable (it resumes from the stock
  checkpoints and rewrites the study tables idempotently).
- The documented bake/convert flow reproduces the 22 shipped PNGs **byte-for-byte** from
  `build/bake_manifest.json` plus `build/p4a/bake-b49-all.json`.

## Milestone 8 — final state

- The Mini Program page now loads both LUT variants (`<id>.png` and `<id>.ev2.png`) and passes them
  to `renderer.setLut(base, stock, extended)`. A harness contract check asserts that omitting the
  extended source raises a clear error and that supplying it succeeds, so the page wiring cannot
  regress silently.
- Final full harness run: **PASS** — 66/66 default pairs, 11/11 intensity checks, 61/61 adjustment
  pairs, 11/11 thumbnails, LUT-upload contract green. Median render/readback **19.65 ms**, median
  thumbnail switch **1.80 ms**, median full-preview stock switch **15.10 ms**.
- Final static checks: **PASS**. Main package **50,381 bytes (49.2 KiB)**; LUT subpackage
  **1,063,412 bytes (1038.5 KiB)** against the 1,200,000-byte budget.
- The documented bake/convert commands reproduce the 22 shipped PNGs byte-for-byte.
- No git commit was made; the 4b presets UI remains intentionally unimplemented.

## Next milestones

- [x] Candidate bakes and full-physics EV study; write results incrementally to `docs/EXPOSURE_EV.md`.
- [x] Choose the faithful implementation within the approximately 1.2 MB LUT-subpackage budget.
- [x] Implement shared adjustment mapping, canonical shader path, renderer adjustments/readback API.
- [x] Add NumPy references and default/EV/WB/post-adjustment/thumbnail/timing harness checks.
- [x] Final full harness, static checks, sizes, documentation, and residual-risk report.
