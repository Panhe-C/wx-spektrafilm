# Phase 1c physical LUT tooling

These scripts explore physical exposure settings, bake 11 phone-photo looks with
[spektrafilm](https://github.com/andreavolpato/spektrafilm) 0.3.4, convert them to tiled-grid
WebGL textures, and validate them against full `simulate()` references. Film modeling powered by
spektrafilm. LUT/profile data derived from spektrafilm are CC BY-SA 4.0 (Andrea Volpato); see
[SPEKTRAFILM_LICENSE.txt](https://github.com/andreavolpato/spektrafilm/blob/main/SPEKTRAFILM_LICENSE.txt).

**Phase 1c supersedes Phase 1b.** `calibrate_tones.py`, its stored tables, and every ad-hoc
post-simulation tone/levels operation have been removed. `tools/pipeline_config.py` is the single
source of truth for the physical recipe in exploration, cube baking, validation, and previews.

## Run everything

Use the prepared Python 3.13 environment from the repository root:

```bash
source /workspace/venv-sf/bin/activate
bash tools/run_all.sh
```

The script limits BLAS/OpenMP/Numba threads and runs heavy work serially. Its stages are:

```bash
python tools/explore_exposure.py                 # physical candidates; docs/EXPOSURE.md
for n in 33 49 65; do
  python tools/bake_luts.py --resolution "$n" \
    --output-dir "build/luts/$n" --manifest "build/bake-manifest-$n.json"
  python tools/convert_luts.py --manifest "build/bake-manifest-$n.json" \
    --output-dir "build/tiled/$n" --clean
done
python tools/validate_luts.py --resume --reuse-overall # selects N; docs/validation.{json,md}
python tools/convert_luts.py --manifest build/bake-manifest-<selected>.json \
  --output-dir subpackages/luts --clean          # final delivery assets
python tools/make_contact_sheet.py               # both docs/lut-*.jpg sheets
```

### Phase 4a extended-range assets

The EV/WB controls need two extra stops of linear input headroom, so each stock also ships an
N=49 extended cube baked from the same physical recipe at camera EV 0:

```bash
python tools/bake_luts.py --resolution 49 --stops-above-midgray 4.473931188332 \
  --output-dir build/p4a/cubes/b49-all --manifest build/p4a/bake-b49-all.json
python tools/convert_luts.py --manifest build/bake_manifest.json \
  --extended-manifest build/p4a/bake-b49-all.json \
  --output-dir subpackages/luts --clean --extended-headroom-ev 2
```

The conversion is atomic: it rewrites the base PNGs, writes `<id>.ev2.png`, and merges a nested
`extended` record into `luts.json` in one pass, then enforces the 1,200,000-byte Phase-4 subpackage
budget. `tools/bake_luts.py --camera-ev` and `--fixed-print-exposure` produce reproducible
camera-EV variants for the candidate study; they are not used for the shipped assets.

`run_all.sh` fills in the selected manifest automatically and copies it to `build/bake_manifest.json`.
For an interrupted rerun with a complete existing exploration, `SKIP_EXPOSURE=1 bash tools/run_all.sh`
avoids repeating that sweep. Do not use the skip flag after changing the physical recipe or fixtures.

For a long unattended run:

```bash
mkdir -p build
setsid nohup bash tools/run_all.sh > build/run_all.log 2>&1 < /dev/null &
echo $! > build/run_all.pid
# Poll: tail -f build/run_all.log
```

The tool harness times out foreground calls at about 10 minutes; use this background pattern for
validation and contact generation too. Keep jobs sequential: approximately 3 GB RAM is available.

## Selected global physical recipe

All 11 stocks use exactly the same parameter choices:

- sRGB input/output with CCTF decode/encode at the LUT/reference boundary; the encoded sRGB cube
  domain is the shaper. `stops_above_midgray=log2(1/0.18)=2.473931188332`, so input gain is 1.0.
- Fixed `camera.exposure_compensation_ev=0.0` globally. sRGB code 118 decodes to approximately
  0.18 linear metered mid-grey. The measured −0.652 EV median remains only an exploration
  diagnostic: print compensation cancels it for negatives but it underexposes direct-scan slides.
  Image-dependent auto exposure is off.
- `enlarger.print_exposure=1.0`, print exposure compensation and midgray normalization on,
  `illuminant="TH-KG3"`, database neutral filters on, and zero creative Y/M shifts.
- Scanner white and black correction on at levels 0.98 and 0.01. These deterministic physical
  endpoint corrections are restored after `lut_mode`, which otherwise resets them.
- Default input gamut compression and CAM16-UCS output gamut/lightness compression.
- Positive profiles alone use `io.scan_film=True`; their print profile is an inactive placeholder.

`lut_mode` disables spatial/stochastic/image-global effects. The static physical knobs above are
restored **after** `digest_params` and before pipeline construction in both bake and reference.
Scanner unsharp masking stays off. No per-stock exposure, shadow, white, or neutral fitting exists.

`tools/explore_exposure.py` compares native/zero/median, upstream +4-stop, scanner white/black,
print compensation/normalization, and ±0.5 print-EV candidates on neutral ramps and all six phone
photos. Measurements and selection reasoning are in `docs/EXPOSURE.md`; the soft white≥240 goal is
not met, and the zero-EV choice avoids the median candidate's direct-scan slide underexposure.

### Phase 4a EV/WB study

`tools/study_exposure_ev.py` and `tools/study_white_balance.py` measure the EV/WB candidates
(native gain, extended-range, per-EV LUTs, and the combination) against **full `simulate()`**
references with fixed print exposure, and rewrite `docs/EXPOSURE_EV.md` after every stock
checkpoint. They are resumable:

```bash
cd harness && npm run study:ev     # or: python tools/study_exposure_ev.py --resume
```

The study needs the representative candidate assets under `build/p4a/grids/`; re-bake them with
`tools/bake_luts.py --camera-ev`/`--stops-above-midgray` if the directory is empty. The results
are physical-faithfulness numbers and are deliberately **not** part of `npm test`.

## Stocks and print choices

`tools/stocks.json` is the authoritative list and records each rationale:

- Portra 400/160 → Kodak Portra Endura (declared target/family pairing).
- Gold 200/Ultramax 400 → Kodak Supra Endura (consumer Kodak/GUI default pairing).
- Ektar 100 → Kodak Ultra Endura (saturated Ektar pairing).
- Pro 400H → Fujifilm Crystal Archive Type II (declared target).
- Vision3 250D/500T → Kodak 2383 (declared cinema print target).
- Velvia 100/Provia 100F/Kodachrome 64 → direct positive-film scan, not paper print.

All 11 bake through an appropriate physical route. Effective per-stock parameters, including
database neutral C/M/Y values, are recorded in the bake and validation reports.

## Resolution study and tiled assets

The baker uses upstream `BundleBuilder` with a small override that records physical out-of-range
node statistics before its required `[0,1]` clamp. N=33, 49, and 65 are baked and converted.
`tools/convert_luts.py` writes optimized, RGB-only PNGs without alpha/ICC/gAMA chunks. Blue slices
are row-major in eight columns; `luts.json` stores `size`, `cols`, `rows`, `width`, `height`, and
`bytes`. See `docs/LUT_FORMAT.md` for exact addressing and shader half-texel rules.

Validation reuses each full physical reference for all three N values. Completed stocks are
checkpointed in `build/validation-stocks/`; `--resume` reuses those results, while
`--combine-only` only rebuilds combined reports. Exact overall/subset percentiles are pooled from
temporary per-stock delta arrays. After a report-only failure, `--combine-only --reuse-overall`
reuses those pools only when the selected N and complete physical recipe snapshot match.
Validation selects the smallest N
whose package is below 1.5 MiB, whose per-stock natural mean/p95 limits pass, and whose **every
stock's pooled natural p95 is within 0.1 dE2000 of the same stock at N=65**. The decision and raw
study are in `build/selected_resolution.json` and `build/resolution-study.json`; summaries and the
size/error table are in `docs/validation.md`. Only the selected grids are copied to
`subpackages/luts/`.

## Validation and contact sheets

Fixtures are six normally exposed phone JPEGs plus the ProPhoto-derived portrait, IT8 chart, and
synthetic 24-patch/gradient target, all ≤1.2 MP. Phone sources remain under `/workspace/testphotos`
and are never copied into git. Large generated fixtures/references stay in ignored `build/`.
Only the small portrait/chart/synthetic fixtures are mirrored to `tools/testdata/` (≤200 KiB total).

Each stock×image reports mean, p95, p99, and MAX CIEDE2000 and mean absolute 8-bit error, plus
reference-L* shadows/highlights and C*ab saturated-colour subsets. Neutral ramps include codes
230/250/255 and distinguish physical from LUT-introduced flat tops. Quantization-only error compares
float trilinear output from original and 8-bit-rounded cube nodes. Validation exits nonzero if any
stock's pooled natural mean is ≥1.0 or p95 ≥3.0 dE2000, if the LUT introduces a highlight flat top,
or if the selected package is too large.

`docs/lut-preview.jpg` contains original | full physical | LUT triplets for Portra 400, Ektar 100,
and Velvia 100 on two phone photos, with FULL↔LUT absolute-code and ΔE2000 statistics.
`docs/lut-all-stocks.jpg` contains the unmodified original and all 11 LUT looks on one normally
exposed phone photo. Both are limited to 800 KB. The final run selected **N=33** at **297,046
bytes (290.1 KiB)**; exact pooled natural-image mean/p95/p99/MAX are **0.2829/0.6140/0.8296/
1.6896 dE2000**. Ektar has one explicitly reported sub-one-code 8-bit highlight plateau; no
physical response was altered to remove it. Excluded spatial/stochastic effects and other
boundaries are documented in `docs/LIMITATIONS.md` and the root `README.md`.

## Static Mini Program checks

`python3 tools/check_miniprogram.py` needs no AppID and no network. It verifies that every JSON
file parses, that every page in `app.json` (including subpackage pages) has its four files, that
the WXML of each page has balanced tags, that every `bind*`/`catch*` handler exists on the page,
that every `{{…}}` identifier resolves to page data or a `wx:for` alias, that element ids are
unique inside a file, that `wx:for` lists declare a `wx:key` (warning), that no runtime file
requires a Node builtin, that every relative `require` resolves to an existing file, that the
embedded GLSL matches `shaders/*.glsl`, and that the main package stays below 2 MB and the LUT
subpackage below 1,200,000 bytes. It also validates the PNG geometry and byte counts of every
delivered LUT against `luts.json`.

`miniprogram-ci` is intentionally skipped: it needs a real AppID and a private key.
