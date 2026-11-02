# Phase 1c exposure exploration

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).

This document records the physical-pipeline exploration that supersedes the Phase 1b
post-simulation tone curve. All measurements below use the real spektrafilm runtime with
spatial and stochastic effects disabled. No project-owned tone, levels, or neutralization
transform is applied.

## Input contract and auto-exposure measurement

Phone JPEG code values are interpreted as display-referred **sRGB**, CCTF-decoded to linear
light at the LUT/reference boundary. The runtime receives linear sRGB primaries, matching the
LUT creator's boundary contract and filmroom's linear native ABI. The encoded sRGB domain is
also the sampling/shaper domain.

`camera.auto_exposure` cannot be baked into a static LUT: its center-weighted Gaussian meter
normalizes weighted mean luminance by 0.184, so its gain depends on the whole image. I measured
`measure_autoexposure_ev(..., color_space="sRGB", apply_cctf_decoding=True,
method="center_weighted")` on the six supplied, normally exposed 1600×1067 phone JPEGs:

| Photo | Subject | Auto-exposure EV |
|---|---|---:|
| p1015.jpg | landscape / sky | -0.783957 |
| p1025.jpg | forest / pug | -0.551359 |
| p1043.jpg | Yosemite | +0.068451 |
| p1062.jpg | indoors / high-key | -0.905641 |
| p237.jpg | black dog / wood | +0.806308 |
| p433.jpg | bear | -0.753141 |
| **Median** | fixed LUT-compatible compensation candidate | **-0.652250** |

The upstream LUT creator's `stops_above_midgray="auto"` convention for encoded SDR is +4.0
stops, equivalent to linear gain 2.88 for sRGB (native sRGB white is +2.473931 stops above
0.18). It deliberately moves display midgray up by about 1.526 stops to engage the film
shoulder. The exploration compares that convention with native gain 1.0 and the measured
median camera compensation; it is not assumed to be correct for already tone-mapped phone
JPEGs.

## Defaults and mechanisms under test

The global candidates keep spektrafilm's stock/database behavior rather than fitting stocks
individually:

- TH-KG3 enlarger illuminant, zero creative Y/M shifts, and database neutral filters enabled.
- `normalize_print_exposure=True`; candidates compare camera-exposure print compensation on/off.
- `enlarger.print_exposure=2**EV`, including a small global EV sweep around 0 EV.
- Scanner white/black correction on/off with spektrafilm defaults `white_level=0.98` and
  `black_level=0.01`. These are linear-light physical scan normalizations derived from the
  virtual paper/film endpoints, not per-image operations. Upstream `lut_mode` forcibly resets
  them, so the shared parameter builder restores the selected values after digesting and before
  constructing the pipeline in both bake and reference paths.
- Positive stocks use `io.scan_film=True`; their print profile is an inactive runtime-required
  placeholder.
- Input gamut compression and output CAM16-UCS gamut/lightness compression retain spektrafilm
  defaults and are identical in bake and reference. The encoded cube is clipped only at its
  file-format boundary, like the LUT creator.

The spektrafilm GUI and filmroom defaults leave scanner white/black correction off, auto
exposure off in filmroom (the runtime schema itself defaults on), print compensation and print
normalization on, and database neutral filters on. Thus scanner normalization is being evaluated
as an explicit physical scan choice, not misrepresented as either application's default.

## Sweep results

The exploration uses 4×4 neutral-ramp images and all six phone photos downscaled to at
most 240,000 pixels. Photo luminance preservation is mean linear Rec.709 Y after the
physical pipeline divided by input mean Y; encoded-luma delta is included to make bright-
ness changes easier to read. Both are exposure diagnostics, not LUT-versus-reference errors.

### Candidates

| ID | Stops above gray | Camera EV | Scanner W/B | Print comp/norm | Print EV | Purpose |
|---|---:|---:|:---:|:---:|---:|---|
| `native_baseline` | 2.473931 | +0.000000 | off/off | off/on | +0.00 | Native gain; old LUT-mode print/scanner resets; no post curve. |
| `native_scan_zero` | 2.473931 | +0.000000 | on/on | on/on | +0.00 | Native gain; 0 camera EV; normalized print; scanner W+B. |
| `native_scan_median` | 2.473931 | -0.652250 | on/on | on/on | +0.00 | Native gain; measured median camera EV; normalized print; scanner W+B. |
| `plus4_scan_zero` | 4.000000 | +0.000000 | on/on | on/on | +0.00 | Upstream +4-stop SDR convention; 0 camera EV; scanner W+B. |
| `plus4_scan_median` | 4.000000 | -0.652250 | on/on | on/on | +0.00 | Upstream +4-stop SDR convention plus measured median camera EV. |
| `native_white_only` | 2.473931 | -0.652250 | on/off | on/on | +0.00 | Isolate scanner white normalization (black correction off). |
| `native_black_only` | 2.473931 | -0.652250 | off/on | on/on | +0.00 | Isolate scanner black normalization (white correction off). |
| `native_no_print_comp` | 2.473931 | -0.652250 | on/on | off/on | +0.00 | Scanner W+B; print normalized but camera compensation off. |
| `native_no_print_norm` | 2.473931 | -0.652250 | on/on | on/off | +0.00 | Scanner W+B; print midgray normalization off. |
| `native_print_minus_0_5` | 2.473931 | -0.652250 | on/on | on/on | -0.50 | Median-EV diagnostic with -0.5 EV enlarger exposure. |
| `native_print_plus_0_5` | 2.473931 | -0.652250 | on/on | on/on | +0.50 | Median-EV diagnostic with +0.5 EV enlarger exposure. |

### Neutral ramp — `native_baseline`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 14.3 | 15.1 | 23.1 | 36.3 | 62.9 | 116.3 | 172.0 | 192.2 | 203.7 | 209.0 | 4.4 |
| Kodak Portra 160 | 14.5 | 15.3 | 24.7 | 38.6 | 64.1 | 116.5 | 173.1 | 192.6 | 203.6 | 208.6 | 6.5 |
| Kodak Gold 200 | 11.7 | 12.0 | 16.5 | 26.7 | 54.0 | 116.3 | 172.0 | 192.3 | 204.4 | 210.0 | 7.4 |
| Kodak Ultramax 400 | 11.6 | 12.0 | 17.6 | 29.1 | 56.8 | 116.3 | 170.4 | 190.7 | 203.3 | 209.2 | 6.5 |
| Kodak Ektar 100 | 8.6 | 8.7 | 11.7 | 19.8 | 44.2 | 114.2 | 180.1 | 194.7 | 200.5 | 202.5 | 12.0 |
| Fujifilm Velvia 100 | 1.2 | 1.4 | 9.1 | 28.4 | 60.1 | 117.8 | 181.4 | 199.3 | 207.2 | 210.2 | 4.3 |
| Fujifilm Provia 100F | 2.2 | 3.5 | 20.8 | 39.8 | 66.9 | 117.8 | 178.8 | 199.0 | 208.9 | 213.1 | 2.6 |
| Kodak Kodachrome 64 | 3.0 | 4.3 | 21.2 | 40.5 | 68.6 | 117.0 | 165.4 | 182.4 | 192.2 | 197.1 | 9.2 |
| Fujifilm Pro 400H | 12.4 | 12.7 | 17.5 | 28.4 | 55.8 | 117.0 | 171.6 | 191.4 | 203.6 | 209.5 | 10.0 |
| Kodak Vision3 250D | 0.9 | 1.7 | 11.7 | 29.6 | 60.5 | 115.5 | 164.7 | 183.1 | 195.4 | 201.9 | 14.6 |
| Kodak Vision3 500T | 0.8 | 1.6 | 11.7 | 29.8 | 60.7 | 115.5 | 165.0 | 183.4 | 195.7 | 202.2 | 15.2 |

### Neutral ramp — `native_scan_zero`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 3.0 | 4.2 | 16.4 | 31.7 | 59.5 | 115.7 | 177.1 | 199.0 | 211.0 | 216.3 | 5.2 |
| Kodak Portra 160 | 3.0 | 4.4 | 18.1 | 33.9 | 60.6 | 115.9 | 178.4 | 199.5 | 210.8 | 216.0 | 7.6 |
| Kodak Gold 200 | 2.7 | 3.2 | 9.8 | 22.0 | 50.1 | 116.0 | 177.0 | 198.3 | 210.5 | 216.1 | 7.9 |
| Kodak Ultramax 400 | 2.7 | 3.3 | 11.2 | 24.5 | 53.0 | 116.0 | 175.3 | 196.7 | 209.4 | 215.4 | 6.9 |
| Kodak Ektar 100 | 3.6 | 3.8 | 7.1 | 15.8 | 38.5 | 110.3 | 197.0 | 216.0 | 222.9 | 225.3 | 15.3 |
| Fujifilm Velvia 100 | 3.3 | 3.4 | 9.0 | 25.0 | 56.3 | 116.6 | 187.6 | 208.6 | 217.9 | 221.5 | 4.5 |
| Fujifilm Provia 100F | 2.8 | 3.9 | 19.2 | 37.3 | 64.6 | 116.0 | 180.7 | 203.3 | 214.8 | 219.5 | 2.9 |
| Kodak Kodachrome 64 | 2.3 | 3.2 | 17.0 | 34.7 | 63.1 | 116.0 | 173.3 | 195.2 | 207.7 | 213.5 | 9.3 |
| Fujifilm Pro 400H | 2.7 | 3.2 | 10.6 | 23.3 | 51.8 | 116.8 | 176.6 | 197.5 | 209.8 | 215.7 | 9.5 |
| Kodak Vision3 250D | 2.4 | 3.1 | 12.2 | 28.7 | 58.9 | 115.2 | 167.3 | 186.8 | 199.6 | 206.2 | 14.9 |
| Kodak Vision3 500T | 2.4 | 3.2 | 12.2 | 28.9 | 59.1 | 115.2 | 167.6 | 187.1 | 199.9 | 206.4 | 15.6 |

### Neutral ramp — `native_scan_median`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 3.0 | 3.8 | 13.9 | 28.1 | 56.5 | 115.8 | 175.3 | 196.9 | 209.6 | 215.5 | 3.6 |
| Kodak Portra 160 | 3.0 | 3.8 | 15.5 | 31.1 | 59.8 | 116.0 | 176.0 | 197.7 | 210.1 | 215.6 | 6.2 |
| Kodak Gold 200 | 2.8 | 3.3 | 9.2 | 20.4 | 47.8 | 115.9 | 176.7 | 197.7 | 210.2 | 216.0 | 7.0 |
| Kodak Ultramax 400 | 2.8 | 3.4 | 10.4 | 22.9 | 51.3 | 115.9 | 174.7 | 195.7 | 208.7 | 215.0 | 6.8 |
| Kodak Ektar 100 | 3.2 | 3.4 | 6.5 | 14.6 | 37.0 | 110.6 | 197.0 | 215.6 | 222.9 | 225.3 | 13.0 |
| Fujifilm Velvia 100 | 3.3 | 3.3 | 4.8 | 10.7 | 30.5 | 81.3 | 147.1 | 180.2 | 202.2 | 212.3 | 4.5 |
| Fujifilm Provia 100F | 2.8 | 3.2 | 9.9 | 21.7 | 42.5 | 85.5 | 143.1 | 173.5 | 195.9 | 207.7 | 3.2 |
| Kodak Kodachrome 64 | 2.3 | 2.6 | 8.5 | 19.3 | 39.9 | 85.1 | 140.6 | 167.1 | 188.0 | 199.5 | 7.8 |
| Fujifilm Pro 400H | 2.8 | 3.3 | 9.8 | 21.6 | 49.9 | 116.8 | 176.7 | 197.3 | 209.8 | 215.6 | 8.8 |
| Kodak Vision3 250D | 2.5 | 3.3 | 12.3 | 28.1 | 57.8 | 115.1 | 168.2 | 187.1 | 199.6 | 206.2 | 14.6 |
| Kodak Vision3 500T | 2.5 | 3.3 | 12.3 | 28.2 | 58.2 | 115.2 | 168.3 | 187.4 | 199.9 | 206.4 | 14.9 |

### Neutral ramp — `plus4_scan_zero`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 3.0 | 11.9 | 55.9 | 90.5 | 134.3 | 193.8 | 218.7 | 222.3 | 223.9 | 224.6 | 5.1 |
| Kodak Portra 160 | 3.0 | 13.1 | 57.2 | 90.4 | 135.0 | 194.7 | 218.2 | 221.9 | 223.6 | 224.3 | 7.2 |
| Kodak Gold 200 | 2.7 | 6.9 | 46.2 | 86.9 | 135.6 | 193.2 | 218.6 | 222.4 | 224.0 | 224.7 | 6.1 |
| Kodak Ultramax 400 | 2.7 | 7.8 | 49.1 | 88.1 | 134.8 | 191.5 | 218.1 | 222.4 | 224.1 | 224.8 | 5.3 |
| Kodak Ektar 100 | 3.6 | 5.5 | 35.1 | 74.6 | 138.6 | 212.3 | 226.2 | 227.3 | 227.7 | 227.8 | 14.7 |
| Fujifilm Velvia 100 | 3.3 | 5.9 | 52.5 | 90.3 | 137.7 | 204.0 | 222.9 | 224.5 | 225.2 | 225.3 | 4.2 |
| Fujifilm Provia 100F | 2.8 | 13.2 | 61.5 | 93.2 | 134.8 | 198.0 | 221.5 | 224.1 | 225.2 | 225.4 | 2.9 |
| Kodak Kodachrome 64 | 2.3 | 11.4 | 59.7 | 93.2 | 133.3 | 190.0 | 216.1 | 219.9 | 221.4 | 222.1 | 12.2 |
| Fujifilm Pro 400H | 2.7 | 7.4 | 47.9 | 88.1 | 136.2 | 192.6 | 218.3 | 222.4 | 224.2 | 224.9 | 7.3 |
| Kodak Vision3 250D | 2.4 | 8.0 | 55.1 | 90.9 | 131.6 | 182.0 | 209.4 | 215.2 | 218.2 | 219.8 | 15.4 |
| Kodak Vision3 500T | 2.4 | 8.0 | 55.3 | 90.9 | 131.7 | 182.4 | 209.7 | 215.4 | 218.3 | 219.9 | 15.8 |

### Neutral ramp — `plus4_scan_median`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 3.0 | 9.9 | 52.9 | 91.0 | 134.5 | 191.6 | 218.1 | 222.0 | 223.7 | 224.4 | 3.9 |
| Kodak Portra 160 | 3.0 | 10.9 | 56.3 | 92.3 | 134.4 | 192.5 | 218.1 | 221.8 | 223.5 | 224.2 | 6.3 |
| Kodak Gold 200 | 2.8 | 6.7 | 44.0 | 87.3 | 136.1 | 192.6 | 218.6 | 222.5 | 224.2 | 224.7 | 6.4 |
| Kodak Ultramax 400 | 2.8 | 7.5 | 47.5 | 89.2 | 135.2 | 190.5 | 217.8 | 222.2 | 224.1 | 224.8 | 6.2 |
| Kodak Ektar 100 | 3.2 | 5.0 | 33.7 | 75.3 | 139.4 | 211.9 | 226.2 | 227.2 | 227.5 | 227.6 | 11.8 |
| Fujifilm Velvia 100 | 3.3 | 4.0 | 27.7 | 58.4 | 99.7 | 171.2 | 216.4 | 222.1 | 224.2 | 224.8 | 4.5 |
| Fujifilm Provia 100F | 2.8 | 6.8 | 39.9 | 66.3 | 101.4 | 164.9 | 212.8 | 220.4 | 223.4 | 224.5 | 3.5 |
| Kodak Kodachrome 64 | 2.3 | 5.8 | 37.2 | 65.0 | 101.5 | 159.8 | 205.4 | 214.6 | 218.8 | 220.4 | 11.9 |
| Fujifilm Pro 400H | 2.8 | 7.0 | 46.0 | 88.8 | 136.5 | 192.2 | 218.3 | 222.5 | 224.3 | 224.9 | 7.7 |
| Kodak Vision3 250D | 2.5 | 8.3 | 54.2 | 91.6 | 132.5 | 182.4 | 209.4 | 215.1 | 218.3 | 219.8 | 15.6 |
| Kodak Vision3 500T | 2.5 | 8.3 | 54.5 | 91.8 | 132.4 | 182.6 | 209.6 | 215.3 | 218.4 | 219.9 | 16.1 |

### Neutral ramp — `native_white_only`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 15.6 | 16.1 | 22.2 | 32.9 | 58.4 | 115.8 | 174.8 | 196.5 | 209.3 | 215.3 | 3.6 |
| Kodak Portra 160 | 15.7 | 16.3 | 23.6 | 35.8 | 61.7 | 115.9 | 175.5 | 197.3 | 209.8 | 215.4 | 6.4 |
| Kodak Gold 200 | 12.1 | 12.4 | 16.4 | 24.7 | 49.5 | 115.9 | 176.5 | 197.4 | 210.0 | 215.8 | 7.0 |
| Kodak Ultramax 400 | 11.9 | 12.3 | 17.1 | 26.8 | 52.8 | 116.0 | 174.4 | 195.4 | 208.5 | 214.8 | 7.0 |
| Kodak Ektar 100 | 8.9 | 9.0 | 11.5 | 18.0 | 38.2 | 110.6 | 196.9 | 215.6 | 222.8 | 225.3 | 13.0 |
| Fujifilm Velvia 100 | 1.2 | 1.2 | 2.9 | 9.0 | 29.8 | 81.2 | 147.2 | 180.3 | 202.3 | 212.3 | 4.5 |
| Fujifilm Provia 100F | 2.2 | 2.6 | 9.4 | 21.4 | 42.4 | 85.4 | 143.2 | 173.5 | 196.0 | 207.7 | 3.2 |
| Kodak Kodachrome 64 | 3.0 | 3.3 | 9.2 | 19.8 | 40.1 | 85.2 | 140.6 | 167.0 | 188.0 | 199.5 | 7.8 |
| Fujifilm Pro 400H | 12.7 | 13.0 | 17.1 | 26.2 | 51.7 | 116.8 | 176.4 | 197.0 | 209.6 | 215.4 | 10.1 |
| Kodak Vision3 250D | 1.3 | 2.2 | 11.4 | 27.6 | 57.7 | 115.1 | 168.3 | 187.2 | 199.7 | 206.2 | 14.6 |
| Kodak Vision3 500T | 1.2 | 2.0 | 11.2 | 27.6 | 58.0 | 115.2 | 168.4 | 187.4 | 199.9 | 206.4 | 14.9 |

### Neutral ramp — `native_black_only`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 3.8 | 4.6 | 14.6 | 29.2 | 58.6 | 116.4 | 170.8 | 190.6 | 202.6 | 208.4 | 3.3 |
| Kodak Portra 160 | 3.8 | 4.7 | 16.3 | 32.5 | 62.0 | 116.5 | 171.5 | 191.3 | 203.1 | 208.5 | 6.4 |
| Kodak Gold 200 | 3.0 | 3.5 | 9.6 | 21.3 | 50.2 | 116.2 | 172.1 | 192.0 | 204.2 | 210.0 | 6.7 |
| Kodak Ultramax 400 | 3.0 | 3.6 | 10.9 | 24.0 | 53.9 | 116.3 | 170.1 | 190.0 | 202.7 | 208.9 | 6.9 |
| Kodak Ektar 100 | 4.3 | 4.4 | 7.8 | 16.7 | 41.9 | 114.5 | 180.4 | 194.7 | 200.6 | 202.6 | 10.4 |
| Fujifilm Velvia 100 | 3.3 | 3.4 | 5.2 | 12.9 | 34.9 | 84.2 | 146.4 | 175.3 | 193.6 | 202.3 | 3.7 |
| Fujifilm Provia 100F | 2.8 | 3.3 | 11.1 | 23.7 | 45.2 | 87.8 | 144.3 | 172.5 | 192.3 | 202.7 | 3.5 |
| Kodak Kodachrome 64 | 2.3 | 2.8 | 10.6 | 23.5 | 45.6 | 89.4 | 138.7 | 160.6 | 176.5 | 186.0 | 8.1 |
| Fujifilm Pro 400H | 3.0 | 3.5 | 10.1 | 22.6 | 52.3 | 116.9 | 172.0 | 191.5 | 203.7 | 209.5 | 8.3 |
| Kodak Vision3 250D | 2.6 | 3.5 | 13.2 | 29.5 | 59.6 | 115.4 | 165.6 | 183.4 | 195.5 | 201.9 | 14.3 |
| Kodak Vision3 500T | 2.6 | 3.5 | 13.1 | 29.6 | 60.0 | 115.5 | 165.7 | 183.6 | 195.7 | 202.1 | 14.6 |

### Neutral ramp — `native_no_print_comp`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 3.0 | 3.5 | 9.4 | 18.4 | 36.4 | 82.1 | 142.3 | 170.4 | 191.9 | 203.3 | 4.7 |
| Kodak Portra 160 | 3.0 | 3.5 | 10.3 | 20.1 | 38.6 | 82.3 | 143.2 | 171.6 | 192.9 | 203.6 | 7.1 |
| Kodak Gold 200 | 2.7 | 2.9 | 5.6 | 11.2 | 26.2 | 76.9 | 143.6 | 170.5 | 191.3 | 202.7 | 6.8 |
| Kodak Ultramax 400 | 2.7 | 3.0 | 6.2 | 12.8 | 29.0 | 78.5 | 142.6 | 168.9 | 189.6 | 201.2 | 6.3 |
| Kodak Ektar 100 | 3.6 | 3.7 | 4.8 | 8.0 | 19.1 | 63.8 | 150.7 | 189.5 | 210.8 | 218.7 | 14.8 |
| Fujifilm Velvia 100 | 3.3 | 3.3 | 4.8 | 10.7 | 30.5 | 81.3 | 147.1 | 180.2 | 202.2 | 212.3 | 4.5 |
| Fujifilm Provia 100F | 2.8 | 3.2 | 9.9 | 21.7 | 42.5 | 85.5 | 143.1 | 173.5 | 195.9 | 207.7 | 3.2 |
| Kodak Kodachrome 64 | 2.3 | 2.6 | 8.5 | 19.3 | 39.9 | 85.1 | 140.6 | 167.1 | 188.0 | 199.5 | 7.8 |
| Fujifilm Pro 400H | 2.7 | 2.9 | 5.9 | 12.0 | 27.8 | 78.3 | 144.1 | 170.3 | 190.7 | 201.9 | 8.6 |
| Kodak Vision3 250D | 2.4 | 2.7 | 6.1 | 14.2 | 33.9 | 82.5 | 138.5 | 161.7 | 180.3 | 191.2 | 12.3 |
| Kodak Vision3 500T | 2.4 | 2.8 | 6.1 | 14.3 | 34.2 | 82.6 | 138.6 | 162.0 | 180.6 | 191.5 | 12.8 |

### Neutral ramp — `native_no_print_norm`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 3.0 | 3.6 | 10.5 | 20.6 | 41.2 | 91.2 | 152.0 | 178.9 | 198.0 | 207.6 | 4.4 |
| Kodak Portra 160 | 3.0 | 3.7 | 13.9 | 27.8 | 53.7 | 107.2 | 168.3 | 192.3 | 206.8 | 213.4 | 5.6 |
| Kodak Gold 200 | 2.8 | 3.3 | 9.8 | 21.9 | 51.3 | 120.7 | 180.5 | 200.2 | 211.7 | 217.0 | 6.9 |
| Kodak Ultramax 400 | 2.8 | 3.4 | 11.1 | 24.4 | 54.6 | 120.2 | 178.0 | 198.1 | 210.2 | 216.0 | 7.1 |
| Kodak Ektar 100 | 3.0 | 3.2 | 7.5 | 17.9 | 45.0 | 126.8 | 205.8 | 219.4 | 224.5 | 226.2 | 12.6 |
| Fujifilm Velvia 100 | 3.3 | 3.3 | 4.8 | 10.7 | 30.5 | 81.3 | 147.1 | 180.2 | 202.2 | 212.3 | 4.5 |
| Fujifilm Provia 100F | 2.8 | 3.2 | 9.9 | 21.7 | 42.5 | 85.5 | 143.1 | 173.5 | 195.9 | 207.7 | 3.2 |
| Kodak Kodachrome 64 | 2.3 | 2.6 | 8.5 | 19.3 | 39.9 | 85.1 | 140.6 | 167.1 | 188.0 | 199.5 | 7.8 |
| Fujifilm Pro 400H | 2.8 | 3.5 | 11.9 | 26.8 | 60.9 | 130.4 | 187.0 | 204.3 | 214.1 | 218.6 | 9.0 |
| Kodak Vision3 250D | 3.7 | 13.9 | 56.6 | 92.4 | 135.2 | 186.1 | 210.8 | 215.9 | 218.7 | 220.2 | 15.8 |
| Kodak Vision3 500T | 3.5 | 11.6 | 51.2 | 86.3 | 129.4 | 181.9 | 209.1 | 214.9 | 218.1 | 219.7 | 15.8 |

### Neutral ramp — `native_print_minus_0_5`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 10.2 | 11.8 | 29.1 | 53.8 | 98.0 | 163.7 | 206.4 | 215.8 | 220.5 | 222.5 | 3.1 |
| Kodak Portra 160 | 10.5 | 12.3 | 32.6 | 59.7 | 102.7 | 163.9 | 206.8 | 216.2 | 220.7 | 222.5 | 10.6 |
| Kodak Gold 200 | 6.1 | 7.4 | 22.2 | 46.4 | 94.5 | 163.9 | 207.5 | 216.7 | 221.2 | 223.1 | 6.9 |
| Kodak Ultramax 400 | 5.4 | 7.3 | 24.8 | 51.6 | 99.4 | 164.0 | 206.5 | 216.0 | 220.8 | 222.9 | 7.3 |
| Kodak Ektar 100 | 7.7 | 8.2 | 17.6 | 36.1 | 81.6 | 177.4 | 220.9 | 225.4 | 226.9 | 227.3 | 11.7 |
| Fujifilm Velvia 100 | 3.3 | 3.3 | 4.8 | 10.7 | 30.5 | 81.3 | 147.1 | 180.2 | 202.2 | 212.3 | 4.5 |
| Fujifilm Provia 100F | 2.8 | 3.2 | 9.9 | 21.7 | 42.5 | 85.5 | 143.1 | 173.5 | 195.9 | 207.7 | 3.2 |
| Kodak Kodachrome 64 | 2.3 | 2.6 | 8.5 | 19.3 | 39.9 | 85.1 | 140.6 | 167.1 | 188.0 | 199.5 | 7.8 |
| Fujifilm Pro 400H | 5.5 | 7.0 | 22.9 | 48.7 | 97.1 | 164.5 | 207.5 | 216.6 | 221.2 | 223.2 | 8.3 |
| Kodak Vision3 250D | 4.6 | 8.1 | 33.2 | 61.2 | 101.9 | 159.7 | 199.0 | 208.5 | 213.9 | 216.7 | 15.5 |
| Kodak Vision3 500T | 4.3 | 7.7 | 32.9 | 61.3 | 102.2 | 159.8 | 199.1 | 208.6 | 214.1 | 216.8 | 15.7 |

### Neutral ramp — `native_print_plus_0_5`

Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.
Spread is the maximum neutral R/G/B channel spread over those inputs.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 0.0 | 0.0 | 4.9 | 13.3 | 29.6 | 70.3 | 128.8 | 157.9 | 181.9 | 196.0 | 5.1 |
| Kodak Portra 160 | 0.0 | 0.0 | 5.3 | 14.7 | 31.3 | 70.3 | 129.6 | 159.1 | 183.0 | 196.2 | 8.1 |
| Kodak Gold 200 | 1.7 | 1.9 | 3.9 | 8.4 | 21.0 | 64.7 | 131.3 | 159.4 | 182.3 | 195.7 | 5.9 |
| Kodak Ultramax 400 | 2.0 | 2.2 | 4.6 | 9.7 | 22.7 | 64.8 | 128.8 | 156.4 | 179.1 | 193.0 | 6.1 |
| Kodak Ektar 100 | 1.8 | 1.8 | 2.8 | 5.3 | 15.0 | 54.3 | 136.7 | 178.3 | 204.6 | 215.1 | 15.3 |
| Fujifilm Velvia 100 | 3.3 | 3.3 | 4.8 | 10.7 | 30.5 | 81.3 | 147.1 | 180.2 | 202.2 | 212.3 | 4.5 |
| Fujifilm Provia 100F | 2.8 | 3.2 | 9.9 | 21.7 | 42.5 | 85.5 | 143.1 | 173.5 | 195.9 | 207.7 | 3.2 |
| Kodak Kodachrome 64 | 2.3 | 2.6 | 8.5 | 19.3 | 39.9 | 85.1 | 140.6 | 167.1 | 188.0 | 199.5 | 7.8 |
| Fujifilm Pro 400H | 1.9 | 2.0 | 4.3 | 9.2 | 22.2 | 65.6 | 131.4 | 159.0 | 181.3 | 194.5 | 8.8 |
| Kodak Vision3 250D | 1.8 | 2.1 | 4.3 | 9.9 | 26.0 | 69.4 | 125.0 | 149.3 | 169.3 | 182.1 | 10.7 |
| Kodak Vision3 500T | 2.0 | 2.2 | 4.4 | 10.1 | 26.2 | 69.5 | 125.1 | 149.6 | 169.8 | 182.6 | 11.3 |

### Phone-photo exposure — `native_baseline`

| Stock | p1015 Y ratio | p1025 Y ratio | p1043 Y ratio | p1062 Y ratio | p237 Y ratio | p433 Y ratio | Median Y ratio | Mean luma delta (8-bit) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 0.963 | 0.835 | 0.863 | 0.901 | 0.900 | 0.832 | 0.882 | -9.22 |
| Kodak Portra 160 | 0.986 | 0.838 | 0.870 | 0.904 | 0.893 | 0.831 | 0.882 | -8.56 |
| Kodak Gold 200 | 0.968 | 0.816 | 0.852 | 0.914 | 0.903 | 0.841 | 0.878 | -11.21 |
| Kodak Ultramax 400 | 0.926 | 0.825 | 0.850 | 0.903 | 0.913 | 0.836 | 0.877 | -11.15 |
| Kodak Ektar 100 | 0.997 | 0.748 | 0.788 | 0.890 | 0.804 | 0.788 | 0.796 | -17.08 |
| Fujifilm Velvia 100 | 0.983 | 0.931 | 0.965 | 0.984 | 1.033 | 0.906 | 0.974 | -8.13 |
| Fujifilm Provia 100F | 0.938 | 0.935 | 0.963 | 0.983 | 1.035 | 0.911 | 0.950 | -6.17 |
| Kodak Kodachrome 64 | 0.878 | 0.855 | 0.863 | 0.840 | 0.884 | 0.778 | 0.859 | -10.53 |
| Fujifilm Pro 400H | 0.926 | 0.860 | 0.871 | 0.901 | 0.931 | 0.842 | 0.886 | -10.41 |
| Kodak Vision3 250D | 0.844 | 0.792 | 0.802 | 0.843 | 0.861 | 0.781 | 0.822 | -14.71 |
| Kodak Vision3 500T | 0.879 | 0.784 | 0.791 | 0.840 | 0.838 | 0.777 | 0.815 | -14.73 |

### Phone-photo exposure — `native_scan_zero`

| Stock | p1015 Y ratio | p1025 Y ratio | p1043 Y ratio | p1062 Y ratio | p237 Y ratio | p433 Y ratio | Median Y ratio | Mean luma delta (8-bit) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 1.028 | 0.856 | 0.885 | 0.953 | 0.928 | 0.884 | 0.906 | -9.25 |
| Kodak Portra 160 | 1.054 | 0.859 | 0.893 | 0.957 | 0.919 | 0.883 | 0.906 | -8.60 |
| Kodak Gold 200 | 1.026 | 0.837 | 0.875 | 0.963 | 0.933 | 0.889 | 0.911 | -11.32 |
| Kodak Ultramax 400 | 0.979 | 0.846 | 0.871 | 0.951 | 0.942 | 0.883 | 0.913 | -11.24 |
| Kodak Ektar 100 | 1.248 | 0.844 | 0.908 | 1.062 | 0.909 | 0.956 | 0.932 | -12.14 |
| Fujifilm Velvia 100 | 1.063 | 0.972 | 1.006 | 1.058 | 1.088 | 0.987 | 1.032 | -6.22 |
| Fujifilm Provia 100F | 0.964 | 0.941 | 0.966 | 1.011 | 1.047 | 0.947 | 0.965 | -6.02 |
| Kodak Kodachrome 64 | 0.982 | 0.900 | 0.908 | 0.931 | 0.941 | 0.875 | 0.920 | -8.43 |
| Fujifilm Pro 400H | 0.980 | 0.883 | 0.893 | 0.949 | 0.962 | 0.891 | 0.921 | -10.61 |
| Kodak Vision3 250D | 0.873 | 0.805 | 0.816 | 0.870 | 0.881 | 0.809 | 0.843 | -13.73 |
| Kodak Vision3 500T | 0.909 | 0.797 | 0.806 | 0.867 | 0.857 | 0.805 | 0.832 | -13.75 |

### Phone-photo exposure — `native_scan_median`

| Stock | p1015 Y ratio | p1025 Y ratio | p1043 Y ratio | p1062 Y ratio | p237 Y ratio | p433 Y ratio | Median Y ratio | Mean luma delta (8-bit) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 1.007 | 0.840 | 0.870 | 0.938 | 0.912 | 0.868 | 0.891 | -10.58 |
| Kodak Portra 160 | 1.034 | 0.846 | 0.880 | 0.944 | 0.909 | 0.870 | 0.894 | -9.58 |
| Kodak Gold 200 | 1.018 | 0.834 | 0.875 | 0.961 | 0.931 | 0.884 | 0.908 | -11.71 |
| Kodak Ultramax 400 | 0.968 | 0.841 | 0.868 | 0.946 | 0.938 | 0.877 | 0.908 | -11.70 |
| Kodak Ektar 100 | 1.245 | 0.848 | 0.914 | 1.067 | 0.917 | 0.958 | 0.938 | -12.21 |
| Fujifilm Velvia 100 | 0.679 | 0.579 | 0.581 | 0.695 | 0.635 | 0.702 | 0.657 | -31.88 |
| Fujifilm Provia 100F | 0.617 | 0.575 | 0.573 | 0.668 | 0.632 | 0.667 | 0.624 | -30.13 |
| Kodak Kodachrome 64 | 0.653 | 0.553 | 0.553 | 0.620 | 0.575 | 0.613 | 0.594 | -31.65 |
| Fujifilm Pro 400H | 0.976 | 0.883 | 0.894 | 0.949 | 0.962 | 0.890 | 0.922 | -10.93 |
| Kodak Vision3 250D | 0.875 | 0.811 | 0.824 | 0.875 | 0.888 | 0.811 | 0.850 | -13.51 |
| Kodak Vision3 500T | 0.911 | 0.802 | 0.814 | 0.871 | 0.863 | 0.806 | 0.838 | -13.58 |

### Phone-photo exposure — `plus4_scan_median`

| Stock | p1015 Y ratio | p1025 Y ratio | p1043 Y ratio | p1062 Y ratio | p237 Y ratio | p433 Y ratio | Median Y ratio | Mean luma delta (8-bit) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | 1.673 | 1.965 | 1.957 | 1.602 | 1.927 | 1.399 | 1.800 | +38.26 |
| Kodak Portra 160 | 1.699 | 1.972 | 1.958 | 1.604 | 1.920 | 1.399 | 1.810 | +38.86 |
| Kodak Gold 200 | 1.715 | 1.984 | 1.991 | 1.632 | 1.967 | 1.418 | 1.841 | +38.85 |
| Kodak Ultramax 400 | 1.650 | 1.988 | 1.993 | 1.620 | 1.965 | 1.411 | 1.807 | +38.29 |
| Kodak Ektar 100 | 1.833 | 2.035 | 1.989 | 1.722 | 2.015 | 1.472 | 1.911 | +38.88 |
| Fujifilm Velvia 100 | 1.492 | 1.636 | 1.707 | 1.489 | 1.745 | 1.289 | 1.564 | +24.65 |
| Fujifilm Provia 100F | 1.402 | 1.563 | 1.634 | 1.439 | 1.681 | 1.258 | 1.501 | +23.76 |
| Kodak Kodachrome 64 | 1.412 | 1.503 | 1.525 | 1.344 | 1.533 | 1.196 | 1.457 | +21.00 |
| Fujifilm Pro 400H | 1.654 | 2.070 | 2.052 | 1.620 | 1.988 | 1.417 | 1.821 | +39.29 |
| Kodak Vision3 250D | 1.532 | 1.872 | 1.864 | 1.510 | 1.827 | 1.332 | 1.680 | +34.43 |
| Kodak Vision3 500T | 1.580 | 1.860 | 1.832 | 1.507 | 1.806 | 1.332 | 1.693 | +34.57 |

### Final global selection and reasoning

**Selected (`native_scan_zero`):** native sRGB headroom
`stops_above_midgray=log2(1/0.18)=2.473931188332` (input gain 1.0), fixed camera
compensation **0.0 EV globally**, print exposure **1.0** (0 EV), print exposure compensation
and midgray normalization **on**, TH-KG3 and database neutral filters, scanner white+black
correction **on** at 0.98/0.01, and default input/output gamut compression. Positive stocks
alone take `scan_film=True`. This is one recipe for all 11 stocks, with no per-stock exposure
or neutral fitting.

The measured −0.652250 EV median is retained above as an exploration diagnostic, not used in
production. Per-photo metering spans −0.906 to +0.806 EV, so a fixed non-zero offset is not a
principled representation of a balanced phone photo. Display sRGB code 118 decodes to
approximately 0.18 linear metered mid-grey, making **0 EV** the natural auto-exposure-equivalent
fixed setting. The tables show the physical consequence: print compensation/normalization makes
zero and median EV nearly identical for the eight negative/print stocks, while direct positive
scans have no print stage to cancel the offset. At zero EV their median photo Y ratios are
0.920–1.032 and code 118 is about 116; at median EV those fall to 0.594–0.657 and about 81–85.
Zero EV therefore fixes the slide underexposure globally without a slide-only exception or
fitted tone curve.

The +4-stop candidate is rejected for display-referred phone JPEGs. With the exploratory median
camera EV, its across-stock median photo Y ratio is **1.652**, mean encoded-luma change is
**+33.71/255**, and negative-stock code 118 becomes roughly 182–212. The comparison image shows
blown blankets/foliage, especially Ektar. Native gain at zero EV avoids manufacturing shoulder
headroom by overexposing every midtone.

Print compensation/normalization is retained from the physical GUI/filmroom defaults. Disabling
print camera compensation in the exploratory median-EV candidate drops negative code 118 to
roughly 77–85; a −0.5 EV print exposure instead raises it to about 160–164. These large
movements are not a neutral exposure trim and are not used to chase targets.

Scanner normalization raises white reach only modestly. The selected zero-EV recipe reaches
about 206.2 (Vision3) to 225.3 (Ektar), not the soft ~240 goal. Ektar remains legitimately
dark/punchy (code 60 ≈15.8; code 118 ≈110.3), and Vision3 retains a physical neutral channel
spread around 15 codes. No white-level, channel-alignment, or shadow-lift hack is added.

The spektrafilm GUI and filmroom both default scanner corrections off. Enabling them here is
therefore an explicit physical scan-normalization choice, not a claim about application defaults;
the bake and every reference restore exactly the same settings after `lut_mode`.
