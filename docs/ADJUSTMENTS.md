# Camera adjustments and post-LUT tweaks

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).

This document describes the Phase-4a adjustment model, the shared JavaScript API, the exact
operation order, and the limits of each control. The Phase-4b UI that exposes these controls is
described in `docs/UI.md`.

## Control summary

| Control | Range | Default | Domain | Physical? |
|---|---|---|---|---|
| Exposure EV | −2 … +2 | 0 | camera side, linear light, before the LUT | yes — `camera.exposure_compensation_ev` with fixed enlarger time |
| Temperature | −100 … +100 | 0 | camera side, linear light, before the LUT | camera white balance (Bradford adaptation), not film chemistry |
| Tint | −100 … +100 | 0 | camera side, linear light, before the LUT | camera white balance green/magenta axis |
| Contrast | −1 … +1 | 0 | after the LUT, encoded sRGB | **no** — display look only |
| Saturation | 0 … 2 | 1 | after the LUT, encoded sRGB | **no** — display look only |
| Intensity | 0 … 1 | 1 | mix of original and LUT output | blend amount |

## Order of operations

```text
encoded sRGB input
  → (if intensity == 0) return the untouched original
  → camera side: sRGB→linear, multiply by uLinearGain, clamp to [0,1], linear→sRGB
  → film LUT lookup (native N=33 or extended N=49 cube)
  → mix(original, graded, intensity)
  → contrast about encoded 0.5
  → Rec.709 encoded-luma saturation
  → clamp to [0,1] and write the 8-bit target
```

Contrast and saturation are applied **after** the intensity mix, so they affect the final colour
that the user sees, and they are explicitly **not** part of the physical film emulation. The UI
must label them 「后期微调（非胶片物理）」.

Press-and-hold comparison (intensity 0) returns the untouched original even when EV, WB, contrast,
and saturation are all nonidentity; the shader short-circuits before any adjustment is applied.

## Exposure EV

The EV control is a camera-side exposure compensation with the **enlarger time fixed**
(`enlarger.print_exposure_compensation=False`), which is what a photographer experiences as
over/under-exposing film. The reference is always full `simulate()` with that single setting
changed; the physical measurements and the candidate comparison are in `docs/EXPOSURE_EV.md`.

Auto-printing (`print_exposure_compensation=True`) is deliberately **not** used: it compensates
negative-film camera exposure and would cancel most of the control. For direct positive scans it
makes no difference at all, because there is no print stage.

The shipped N=33 cube covers the native input range only. At +2 EV, highlights above diffuse
white would be clipped before the lookup, which measured a p95 of 5.30 dE2000 against the physical
reference. Each stock therefore also ships an **extended N=49 cube** baked from the same physical
recipe with two extra stops of linear input headroom
(`stops_above_midgray = 4.473931188332`, input gain 4). The extended lookup divides the camera gain
by four first (`2^(EV−2)`), which is algebraically identical to the reference and keeps the gained
highlights representable.

Path selection:

| Condition | Cube used |
|---|---|
| identity adjustments | native N=33 (bit-identical to the Phase-3 output) |
| EV ≤ 0 and no WB | native N=33 |
| EV > 0, or any nonidentity WB | extended N=49 |

## White balance

Temperature and tint are camera-side linear-sRGB gains, applied **before** the film LUT, so the
film sees the same light a camera would have recorded.

- **Temperature**: the slider maps reciprocally from D65 (6504 K) to 12000 K at −100 (cool) and
  3000 K at +100 (warm). The target white is placed on the Planckian locus with the Kim et al.
  cubic approximation, and the gain is the Bradford chromatic adaptation matrix from D65 to that
  white.
- **Tint**: a green/magenta axis multiplying linear green by `2^(−0.5 × tint/100)`, so −100 is
  green and +100 is magenta.
- The combined three-channel gain is normalized so the Rec.709 luminance of linear white is
  exactly 1, and EV is applied afterwards as `2^EV`.

The mapping lives in `utils/adjust.js` (runtime source of truth) and is mirrored in `tools/wb.py`
for the physical reference; the two agree within 8.9e−16 over 25 sampled settings.

## Shared API

`utils/adjust.js` exports the pure mapping used by both the Mini Program and the harness:

| Export | Purpose |
|---|---|
| `DEFAULTS` | `{ ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1 }` |
| `LIMITS` | allowed range per control |
| `normalize(adjustments)` | clamp and fill a partial object |
| `merge(previous, patch)` | merge a partial patch onto the current state |
| `temperatureToCct(temperature)` | slider → CCT |
| `whiteBalance(temperature, tint)` | `{ gain: [r, g, b], cct, tintGreenGain }` |
| `linearGain(adjustments, headroomEv)` | combined camera gain, optionally pre-divided by the headroom |
| `isCameraIdentity(adjustments)` | true when no camera-side change is requested |

`utils/lut-renderer.js` exposes the runtime API:

```js
renderer.setAdjustments({ ev, temperature, tint, contrast, saturation }); // partial merge
renderer.getAdjustments();                 // current state
renderer.render(intensity);                // preview framebuffer
renderer.renderToPixels({                  // offscreen render + readback
  width, height,
  intensity,                               // default 1
  adjustments,                             // optional temporary state
  onTiming,                                // optional timing hook
});
renderer.setLut(base, metadata, extended); // extended is optional
renderer.setExtendedLut(extended, metadata);
renderer.hasExtendedLut();
```

`renderToPixels` renders into a cached RGBA framebuffer, reads it back with `readPixels`, returns
top-down `RGBA8` pixels, restores the preview framebuffer and viewport, and reports
`{ submitMs, renderMs, readPixelsMs, totalMs }`. The renderer has no dependency on the adjustment
UI, so Phase 4b can drive it directly.

The page drives the renderer directly from the slider events: `bindchanging` applies the new
state and redraws the preview without any `setData`, and only the numeric readouts are written to
the view, throttled to one update per 120 ms. The pure part of that policy — ranges, step
rounding, readout formatting, the "needs the extended cube" decision and the throttle — lives in
`utils/ui-state.js` and is unit-tested by `harness/test-ui-state.mjs`.

## Verification

`cd harness && npm test` checks, in the headless browser:

- the 66 stock × photo default pairs against `tools/lut_apply.py` (Phase-3 regression);
- EV, WB, contrast, saturation, and combined cases against NumPy implementations of the same math,
  with mean ΔE2000 < 0.3 and max < 2.0 required;
- intensity 0 (with extreme adjustments) against the untouched original and intensity 0.5 against
  the midpoint;
- thumbnail generation through `renderToPixels`, including framebuffer restoration and
  independence from live adjustments;
- the lazy extended-cube contract (select without the extended cube, expect a clear failure,
  upload it, expect the draw to succeed);
- stock-switch and thumbnail timing.

It also runs the plain-Node unit suites: the EXIF policy/matrix tests, the adjustment-mapping
tests, and the UI-state tests (ranges, steps, readouts, grouping, thumbnail policy, throttle,
phase machine, PNG fallback encoder).

`cd harness && npm run study:ev` re-runs the physical faithfulness study against full
`simulate()`; it is resumable and is not part of `npm test`.
