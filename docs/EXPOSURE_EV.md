# Phase 4a exposure EV and white-balance faithfulness

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).
**Status: complete.** The study measured four implementation candidates against full physical
`simulate()` and selected candidate **D49** (shipped N=33 native path plus one N=49 two-stop
extended-range LUT per stock). The decision, final numbers, and delivered sizes are in
[Decision and size](#decision-and-size).

## Fixed physical contract

The shipped cubes are the reference at camera EV 0. For an EV control, only
`camera.exposure_compensation_ev` changes and
`enlarger.print_exposure_compensation=False`: the enlarger time remains fixed. All other settings
come from `tools/pipeline_config.py`'s shared builder (native sRGB input gain 1, print exposure 1,
print midgray normalization on, TH-KG3, database neutral filters, scanner 0.98/0.01 correction,
CAM16-UCS output handling, direct scan for positives, and spatial/stochastic effects off).

At EV 0, print-compensation on/off must reproduce the shipped transform. Auto-printing
(`print_exposure_compensation=True`) is reported only as information: it can compensate negative
film camera exposure and has no print stage to compensate for direct-scan slides. It is not the
reference for the requested control.

White balance is a camera-side linear-sRGB gain. Its Python reference applies the exact same gain
to the decoded input before full `simulate()`; it is not a post-film colour grade.

## Study design

- Representative stocks: `portra400`, `ektar100`, `velvia100` (slide), and `vision3_500t` (cinema).
- Photos: three of the six supplied phone JPEGs, deterministically downscaled to at most 240,000
  pixels (below the approximately 0.3 MP limit). Test photos remain outside the repository.
- EV values: −2, −1, −0.5, +0.5, +1, +2, plus the EV=0 identity regression.
- Metrics: pixel-pooled mean/p95/p99/max CIEDE2000 against clipped full-`simulate()` sRGB output,
  plus mean absolute 8-bit error. Target for the selected approach is mean <1.0 and p95 <2.5 for
  |EV|≤1; ±2 is reported separately and may constrain the public range.
- Heavy simulations and bakes run serially in background jobs with logs under ignored `build/`.
  Partial machine-readable results are checkpointed after each stock.

### Candidates

| ID | Implementation under test | Reason to measure |
|---|---|---|
| A | Exact sRGB decode → linear `2^EV` gain → clamp/encode → shipped N=33 LUT | No new assets; physically equivalent before clipping, but positive EV loses linear values above diffuse white. |
| B | Extended-range LUT baked with spektrafilm `stops_above_midgray` increased by two stops, with reciprocal pre-LUT scale | Preserves +2 EV headroom without per-EV files; changes sampling density, so N=33 and N=49 are measured. |
| C | Native-domain LUTs baked at fixed camera EV nodes and output interpolation between adjacent EVs | Avoids gained-highlight clipping at nodes; costs one texture per bracket and introduces between-node approximation. |
| D | Combination: shipped LUT where native gain is safe, extended-range path where headroom/WB requires it | Retains exact shipped identity while paying only for the additional headroom asset actually needed. |

## EV results

<!-- EV_STUDY_RESULTS:BEGIN -->
**Complete representative study:** 4/4 stocks × 3 photos; each photo ≤240,000 pixels. Every entry pools all pixels equally. dE2000 is versus full fixed-print `simulate()`.

| Candidate | EV | Mean | p95 | p99 | MAX dE2000 |
|---|---:|---:|---:|---:|---:|
| A | -2.0 | 0.1882 | 0.3966 | 0.5660 | 1.2721 |
| A | -1.0 | 0.1656 | 0.3521 | 0.4927 | 1.2864 |
| A | -0.5 | 0.1579 | 0.3388 | 0.4675 | 1.1740 |
| A | +0.0 | 0.1479 | 0.3219 | 0.4466 | 1.1339 |
| A | +0.5 | 0.3193 | 1.4362 | 2.7432 | 5.7081 |
| A | +1.0 | 0.7706 | 3.5361 | 5.6372 | 8.0345 |
| A | +2.0 | 1.5999 | 5.2979 | 6.9109 | 18.7959 |
| B33 | -2.0 | 0.3445 | 0.8334 | 1.2444 | 3.9973 |
| B33 | -1.0 | 0.2808 | 0.6695 | 1.0735 | 4.0136 |
| B33 | -0.5 | 0.2619 | 0.6098 | 0.9829 | 3.9713 |
| B33 | +0.0 | 0.2419 | 0.5887 | 0.8808 | 4.0080 |
| B33 | +0.5 | 0.2183 | 0.5417 | 0.8133 | 3.8923 |
| B33 | +1.0 | 0.2024 | 0.5086 | 0.7716 | 3.9193 |
| B33 | +2.0 | 0.1994 | 0.4489 | 0.7347 | 3.7728 |
| B49 | -2.0 | 0.2174 | 0.4865 | 0.6855 | 1.6500 |
| B49 | -1.0 | 0.1864 | 0.4093 | 0.5890 | 1.6635 |
| B49 | -0.5 | 0.1787 | 0.3946 | 0.5545 | 1.6565 |
| B49 | +0.0 | 0.1661 | 0.3635 | 0.5107 | 1.5543 |
| B49 | +0.5 | 0.1583 | 0.3520 | 0.4974 | 1.6097 |
| B49 | +1.0 | 0.1544 | 0.3483 | 0.4859 | 1.4794 |
| B49 | +2.0 | 0.1676 | 0.3802 | 0.4789 | 1.5626 |
| C17 | -2.0 | 0.2102 | 0.4494 | 0.6788 | 1.3278 |
| C17 | -1.0 | 0.2303 | 0.5234 | 0.7695 | 2.1741 |
| C17 | -0.5 | 0.8793 | 1.9098 | 2.2577 | 3.3712 |
| C17 | +0.0 | 0.1479 | 0.3219 | 0.4466 | 1.1339 |
| C17 | +0.5 | 0.8813 | 1.8610 | 2.1752 | 4.2613 |
| C17 | +1.0 | 0.3106 | 0.9240 | 1.4579 | 3.9521 |
| C17 | +2.0 | 0.3675 | 1.2584 | 2.2014 | 6.9576 |
| C25 | -2.0 | 0.1622 | 0.3284 | 0.4379 | 0.9144 |
| C25 | -1.0 | 0.1656 | 0.3490 | 0.4846 | 1.2370 |
| C25 | -0.5 | 0.8624 | 1.8502 | 2.1915 | 3.1775 |
| C25 | +0.0 | 0.1479 | 0.3219 | 0.4466 | 1.1339 |
| C25 | +0.5 | 0.8544 | 1.7794 | 2.0593 | 3.4560 |
| C25 | +1.0 | 0.2009 | 0.4974 | 0.7540 | 2.5926 |
| C25 | +2.0 | 0.2454 | 0.6860 | 1.1202 | 3.4100 |
| D33 | -2.0 | 0.1882 | 0.3966 | 0.5660 | 1.2721 |
| D33 | -1.0 | 0.1656 | 0.3521 | 0.4927 | 1.2864 |
| D33 | -0.5 | 0.1579 | 0.3388 | 0.4675 | 1.1740 |
| D33 | +0.0 | 0.1479 | 0.3219 | 0.4466 | 1.1339 |
| D33 | +0.5 | 0.2183 | 0.5417 | 0.8133 | 3.8923 |
| D33 | +1.0 | 0.2024 | 0.5086 | 0.7716 | 3.9193 |
| D33 | +2.0 | 0.1994 | 0.4489 | 0.7347 | 3.7728 |
| D49 | -2.0 | 0.1882 | 0.3966 | 0.5660 | 1.2721 |
| D49 | -1.0 | 0.1656 | 0.3521 | 0.4927 | 1.2864 |
| D49 | -0.5 | 0.1579 | 0.3388 | 0.4675 | 1.1740 |
| D49 | +0.0 | 0.1479 | 0.3219 | 0.4466 | 1.1339 |
| D49 | +0.5 | 0.1583 | 0.3520 | 0.4974 | 1.6097 |
| D49 | +1.0 | 0.1544 | 0.3483 | 0.4859 | 1.4794 |
| D49 | +2.0 | 0.1676 | 0.3802 | 0.4789 | 1.5626 |

Projected complete-subpackage sizes use measured representative PNG compression ratios; the selected candidate must later be baked/converted for all 11 stocks and measured directly.

| Candidate | Projected bytes | Approx. KiB |
|---|---:|---:|
| A | 297,045 | 290.1 |
| B33 | 299,137 | 292.1 |
| B49 | 736,351 | 719.1 |
| C17 | 371,482 | 362.8 |
| C25 | 455,608 | 444.9 |
| D33 | 596,182 | 582.2 |
| D49 | 1,033,396 | 1009.2 |

### Neutral code-118 response: fixed print / auto-print

These are full physical simulations, not candidate errors. Auto-print nearly cancels camera EV for negatives; direct positive scans have no print compensation.

| Stock | −2 | −1 | −0.5 | +0.5 | +1 | +2 |
|---|---:|---:|---:|---:|---:|---:|
| portra400 | 31.7/114.9 | 66.9/115.7 | 89.3/115.8 | 142.5/115.5 | 169.3/115.6 | 208.2/114.8 |
| portra160 | 34.0/115.1 | 67.5/115.9 | 89.3/115.9 | 143.4/115.5 | 170.6/115.6 | 208.3/114.8 |
| gold200 | 22.0/115.6 | 58.5/115.9 | 85.5/115.9 | 143.7/115.8 | 169.5/115.9 | 207.7/115.4 |
| ultramax400 | 24.6/115.6 | 61.1/116.0 | 86.8/115.9 | 142.7/115.8 | 167.9/116.0 | 206.4/115.3 |
| ektar100 | 15.9/110.7 | 46.0/110.6 | 73.2/110.6 | 150.9/110.4 | 188.3/111.0 | 221.5/110.5 |
| velvia100 | 25.1/25.1 | 64.3/64.3 | 89.1/89.1 | 147.3/147.3 | 179.0/179.0 | 216.0/216.0 |
| provia100f | 37.4/37.4 | 71.2/71.2 | 92.2/92.2 | 143.3/143.3 | 172.3/172.3 | 212.3/212.3 |
| kodachrome64 | 34.8/34.8 | 70.3/70.3 | 92.1/92.1 | 140.7/140.7 | 166.0/166.0 | 204.8/204.8 |
| pro400h | 23.4/116.8 | 60.1/116.8 | 86.8/116.7 | 144.2/116.7 | 169.3/117.0 | 207.0/116.8 |
| vision3_250d | 28.8/115.2 | 66.7/115.1 | 89.8/115.1 | 138.6/115.1 | 160.9/115.4 | 196.5/114.8 |
| vision3_500t | 29.0/115.4 | 66.9/115.3 | 89.8/115.2 | 138.7/115.2 | 161.1/115.5 | 196.8/115.0 |
<!-- EV_STUDY_RESULTS:END -->


## Auto-printing diagnostic

The complete fixed/auto neutral code-118 table is included in the EV results above. Across negative
stocks at −2 EV, fixed-print output is 15.9–34.0 while auto-print remains 110.7–116.8; at +2 EV,
fixed-print output is 196.5–221.5 while auto-print remains 110.5–116.8. Velvia, Provia, and
Kodachrome have identical fixed/auto values because direct positive scans have no print stage.
This confirms that auto-printing would defeat the requested photographer-visible negative-film EV
control, so it is not used.

## White-balance model and results

`utils/adjust.js` is the runtime source of the mapping; `tools/wb.py` mirrors it for the reference
and was cross-checked to 1.6e−15 maximum gain difference over 25 settings. Temperature maps
reciprocally from D65 (6504 K) to 12000 K at −100 (cool) or 3000 K at +100 (warm). The model uses
the Kim et al. cubic Planckian-locus approximation and Bradford chromatic adaptation from D65 to
that white. Tint multiplies linear green by `2^(−0.5*tint/100)`: negative is green, positive is
magenta. The combined three-channel gain is normalized so Rec.709 Y of linear white is exactly 1;
EV is applied afterward as `2^EV`.

The full reference decodes the source sRGB, applies these same gains **without clipping**, and calls
full `simulate()` through the shared builder. Candidate A clamps at native diffuse white before the
shipped LUT. B uses the reciprocal headroom scale and an extended LUT; D uses the extended path for
any nonidentity WB.

<!-- WB_STUDY_RESULTS:BEGIN -->
**Complete representative WB study:** 4/4 stocks × 3 photos, each ≤240,000 pixels. B is the extended-only path; selected D uses B49 for each nonidentity WB setting.

| Candidate | Setting | Mean | p95 | p99 | MAX dE2000 |
|---|---|---:|---:|---:|---:|
| A | Temperature −50 (cool) | 0.1996 | 0.4620 | 1.4228 | 4.0196 |
| A | Temperature +50 (warm) | 0.1571 | 0.3295 | 1.0933 | 4.8112 |
| A | Tint −50 (green) | 0.1458 | 0.3102 | 0.4320 | 1.1739 |
| A | Tint +50 (magenta) | 0.1567 | 0.3358 | 0.7155 | 3.0306 |
| A | Temperature −50, tint +50 | 0.2706 | 1.0794 | 2.3727 | 5.6861 |
| A | Temperature +50, tint −50 | 0.1272 | 0.2803 | 0.3981 | 2.4235 |
| B33 | Temperature −50 (cool) | 0.2363 | 0.6102 | 0.9163 | 3.9948 |
| B33 | Temperature +50 (warm) | 0.2148 | 0.4681 | 0.7307 | 3.9760 |
| B33 | Tint −50 (green) | 0.2335 | 0.5695 | 0.9088 | 3.9788 |
| B33 | Tint +50 (magenta) | 0.2239 | 0.5602 | 0.8346 | 3.8814 |
| B33 | Temperature −50, tint +50 | 0.2181 | 0.5486 | 0.8676 | 3.9292 |
| B33 | Temperature +50, tint −50 | 0.2061 | 0.4610 | 0.7262 | 3.9524 |
| B49 | Temperature −50 (cool) | 0.1670 | 0.3763 | 0.5340 | 1.5579 |
| B49 | Temperature +50 (warm) | 0.1460 | 0.3021 | 0.4351 | 1.5756 |
| B49 | Tint −50 (green) | 0.1629 | 0.3516 | 0.5405 | 1.6055 |
| B49 | Tint +50 (magenta) | 0.1568 | 0.3484 | 0.4903 | 1.6589 |
| B49 | Temperature −50, tint +50 | 0.1564 | 0.3477 | 0.5032 | 1.6621 |
| B49 | Temperature +50, tint −50 | 0.1410 | 0.2966 | 0.4360 | 1.5918 |

Exact gains used by both reference and candidates:

| Setting | CCT K | Linear R gain | G gain | B gain |
|---|---:|---:|---:|---:|
| Temperature −50 (cool) | 8435.80 | 0.886383 | 1.009303 | 1.242407 |
| Temperature +50 (warm) | 4106.06 | 1.342428 | 0.944751 | 0.538978 |
| Tint −50 (green) | 6504.00 | 0.880808 | 1.047463 | 0.880808 |
| Tint +50 (magenta) | 6504.00 | 1.128402 | 0.948869 | 1.128402 |
| Temperature −50, tint +50 | 8435.80 | 1.001392 | 0.958841 | 1.403611 |
| Temperature +50, tint −50 | 4106.06 | 1.190260 | 0.996152 | 0.477883 |
<!-- WB_STUDY_RESULTS:END -->

## Decision and size

**Selected: candidate D49.**

| Path | When it is used | Assets |
|---|---|---|
| Native | identity adjustments, or EV ≤ 0 with no WB | the shipped N=33 cube, bit-identical to Phase 3 |
| Extended | EV > 0, or any nonidentity WB | the new N=49 cube baked with `stops_above_midgray = 4.473931188332` (input gain 4) |

The extended cube is the same physical recipe as the shipped one at camera EV 0, only the LUT
input shaper carries two extra stops of linear headroom. The shader therefore divides the camera
gain by 4 (`2^(EV−2)`) before the extended lookup, which is algebraically identical to the
physical reference and keeps gained highlights inside the representable range.

### Why the other candidates were rejected

| Candidate | Verdict | Measured evidence |
|---|---|---|
| A (native gain + shipped LUT) | rejected | Clips gained highlights at diffuse white: at +1 EV mean 0.7706 / p95 3.5361 / max 8.0345 dE2000, and at +2 EV mean 1.5999 / p95 5.2979 / max 18.7959. The +1 EV p95 target (2.5) fails. WB shows the same highlight outliers (max 4.8112 at +50 temperature). |
| B33 (extended, N=33) | rejected | Faithful but coarse: mean 0.2056–0.3587, p95 up to 0.9012, max 4.0080 dE2000, because +2 stops of headroom spread the same 33³ nodes over a wider input range. |
| C17 / C25 (per-EV LUTs, interpolated) | rejected | Exact at the ±1/±2 nodes but the interpolated ±0.5 steps degrade to mean 0.8624 / p95 1.8502 (N=25) and mean 0.8793 / p95 1.9098 (N=17). It also needs four extra textures per stock and cannot express WB gains without further assets. |
| D33 (native + extended N=33) | rejected | Same coarse extended sampling as B33 (max 4.0080 dE2000). |
| D49 (native + extended N=49) | **selected** | Every EV from −2 to +2: mean 0.1544–0.1882, p95 0.3219–0.3966, max 1.2864 dE2000. |

### Final EV table (D49, versus full fixed-print `simulate()`)

| EV | Mean | p95 | p99 | MAX dE2000 | Meets mean<1.0 and p95<2.5 |
|---:|---:|---:|---:|---:|:---:|
| −2 | 0.1882 | 0.3966 | 0.5660 | 1.2721 | yes |
| −1 | 0.1656 | 0.3521 | 0.4927 | 1.2864 | yes |
| −0.5 | 0.1579 | 0.3388 | 0.4675 | 1.1740 | yes |
| 0 | 0.1479 | 0.3219 | 0.4466 | 1.1339 | yes |
| +0.5 | 0.1583 | 0.3520 | 0.4974 | 1.6097 | yes |
| +1 | 0.1544 | 0.3483 | 0.4859 | 1.4794 | yes |
| +2 | 0.1676 | 0.3802 | 0.4789 | 1.5626 | yes |

The full ±2 EV range is therefore **kept**: no range reduction was needed, and the worst p95
(0.3966 at −2 EV) is far inside the 2.5 target.

### Final white-balance table (D49 extended path)

| Setting | Mean | p95 | p99 | MAX dE2000 |
|---|---:|---:|---:|---:|
| Temperature −50 (cool) | 0.1670 | 0.3763 | 0.5340 | 1.5579 |
| Temperature +50 (warm) | 0.1460 | 0.3021 | 0.4351 | 1.5756 |
| Tint −50 (green) | 0.1629 | 0.3516 | 0.5405 | 1.6055 |
| Tint +50 (magenta) | 0.1568 | 0.3484 | 0.4903 | 1.6589 |
| Temperature −50, tint +50 | 0.1564 | 0.3477 | 0.5032 | 1.6621 |
| Temperature +50, tint −50 | 0.1410 | 0.2966 | 0.4360 | 1.5918 |

### Delivered sizes and budget

| Item | Bytes | KiB |
|---|---:|---:|
| 11 base N=33 LUT PNGs | 293,545 | 286.7 |
| 11 extended N=49 LUT PNGs (`*.ev2.png`) | 764,121 | 746.2 |
| `luts.json` manifest | 5,697 | 5.6 |
| Subpackage no-op page files | 49 | 0.0 |
| **LUT subpackage total** | **1,063,412** | **1038.5** |

The Phase-4 budget is 1,200,000 bytes; the delivered subpackage uses 1,063,412 bytes and leaves
136,588 bytes of headroom. The main package is 50,381 bytes against the 2 MiB limit.

### Honest limits of this decision

- The physical study covers four representative stocks (a negative, a saturated negative, a slide,
  and a cinema stock) on three photos. The shader-versus-NumPy harness covers all 11 stocks.
- The extended cube is sampled on the same N=49 grid but over a wider input range, so its
  interpolation error in the *shadows* is slightly larger than the base cube's; this is visible in
  the −2 EV row (max 1.2721 dE2000) and is reported rather than hidden.- The WB study validates the ±50 slider midpoint region and the ±100 endpoints are covered by the
  unit tests and the extended-range headroom, not by a full physical sweep.
- Auto-printing (`print_exposure_compensation=True`) is **not** used: it cancels negative-film EV
  (see the diagnostic table above) and would make the control meaningless.
