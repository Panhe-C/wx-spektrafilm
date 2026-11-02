# Tiled-grid 2D LUT format

The PNGs in `subpackages/luts/` are derived from
[spektrafilm](https://github.com/andreavolpato/spektrafilm) physical simulations. LUT/profile
data are CC BY-SA 4.0 (Andrea Volpato); see
[SPEKTRAFILM_LICENSE.txt](https://github.com/andreavolpato/spektrafilm/blob/main/SPEKTRAFILM_LICENSE.txt).

## Geometry and code values

For cube size **N**, the N blue slices are arranged **row-major in an 8-column tiled grid**.
Each slice is N×N pixels; red varies horizontally and green vertically within a slice. With
`cols=8` and `rows=ceil(N/8)`, each RGB PNG is `(8*N) × (rows*N)`. Unused tiles in the final row
are zero-filled and are never sampled. Both PNG sides are below 2048 pixels for N=33, 49, and 65.

| N | cols | rows | PNG width × height |
|---:|---:|---:|---:|
| 33 | 8 | 5 | 264 × 165 |
| 49 | 8 | 7 | 392 × 343 |
| 65 | 8 | 9 | 520 × 585 |

`luts.json` records `size`, `cols`, `rows`, `width`, `height`, `file`, and `bytes` for every stock,
in addition to its film/print metadata. Use those values rather than inferring dimensions at runtime.
The selected shipping N and resolution study are in `docs/validation.md`.

Each file is an **8-bit, three-channel RGB PNG**, with no alpha, ICC profile, or `gAMA` chunk. Values
are sRGB-encoded output RGB, clipped to `[0,1]` and rounded to the nearest 8-bit code. Do not apply
another sRGB decode/encode merely because the values are stored in PNG: lookup and interpolation
operate in encoded sRGB code space, which is also the bake's shaper domain.

For integer cube coordinates `(r,g,b)`, each in `0..N-1`, define:

```text
tile_col = b mod 8
tile_row = floor(b / 8)
x = tile_col*N + r
y = tile_row*N + g
```

Then, for output channel `c`:

```text
grid[y, x, c] = round(255 * clip(cube[b, g, r, c], 0, 1))
```

The cube array order used by the Adobe reader and `tools/lut_apply.py` is
`[blue, green, red, output_channel]`.

## Trilinear lookup and half-texel rule

Normalize input sRGB code values to `[0,1]`. For each input channel `c`, calculate:

```text
q  = c * (N - 1)
q0 = floor(q)
q1 = min(q0 + 1, N - 1)
f  = q - q0
```

Fetch the eight vertices formed by `(r0/r1,g0/g1,b0/b1)` and interpolate red, green, then blue
(or any mathematically equivalent order). The mapping uses **N−1, not N**, so inputs 0 and 1 land
exactly on the first and last cube vertices.

A vertex's texel-center coordinates in the tiled texture are:

```text
u = (tile_col*N + r + 0.5) / (8*N)
v = (tile_row*N + g + 0.5) / (rows*N)
```

A fragment shader should take **two hardware-bilinear samples**, one in slice `b0` and one in `b1`,
then mix them by blue fraction `fb`. Red/green interpolation happens inside each slice. Compute the
red coordinate within the appropriate tile rather than allowing an unconstrained sample to cross
into an adjacent, unrelated blue slice. Clamp final output to `[0,1]` and round for an 8-bit target.
`tools/lut_apply.py` is the chunked NumPy reference for both this tiled lookup and float-cube lookup.

## Physical boundary and clipping

All stocks use sRGB input/output, topology `1lut`, native sRGB white headroom
`log2(1/0.18)=2.473931188332` stops (input gain 1.0), and fixed camera compensation **0.0 EV**.
Negative stocks include their selected paper print and normalized/compensated enlarger exposure.
Slides use spektrafilm's direct positive-film scan (`io.scan_film=True`); their manifest print is an
inactive runtime placeholder. Database neutral filters, TH-KG3, scanner white/black normalization
(0.98/0.01), and CAM16-UCS output gamut/lightness compression are identical in bake and reference.

There is **no Phase 1b per-channel tone/levels curve** and no other project-owned post-simulation
transform. Physical output is compressed inside spektrafilm before CCTF encoding; any residual
out-of-range floating-point values are clipped only at the same cube/display boundary. The bake
records pre-clip edge statistics in `build/bake-manifest-<N>.json` and summarizes the selected N in
`docs/validation.md`. Quantization-only error compares float trilinear interpolation of original
versus 8-bit-rounded nodes, separately from interpolation and final render-target rounding.
