# Photo orientation and preview geometry

## App approach

The Mini Program calls `wx.getImageInfo({src})` and normalizes its `orientation` value to one of the
eight EXIF/WeChat names. A canvas image is then decoded with the preview canvas's `createImage()`.
`utils/photo.js` applies orientation and downscaling in **one Canvas2D draw** into an offscreen
canvas; it does not allocate a full-resolution oriented intermediate.

**The decoded Image is the geometry authority.** `Image.naturalWidth/naturalHeight` (or `width`/
`height`) after `onload` decide the aspect, the output size and the texture size. `wx.getImageInfo`
dimensions never override the decoded pixels; they only feed the EXIF decision table below.
`wx.chooseMedia` dimensions are not used for geometry either (they are usually absent, and the
picker may report the size of a different variant than the file that is decoded).

The exported `EXIF_ORIENTATION_MODE` constant is `'auto'` by default. The pure, synchronous
`decideExifOrientation()` helper implements three policies:

- `'manual'`: always apply the matrix from `wx.getImageInfo().orientation`;
- `'engine'`: assume `canvas.createImage()` already applied EXIF and use the identity matrix;
- `'auto'`: apply the dimension-based decision table below.

`preparePhoto` accepts an optional `orientationMode` override for diagnosis and an optional
`longEdge` (default 1280) for bounded preview sizing; normal app operation uses the exported
constants.

## Decision table

`decisionRow` is reported in the on-device diagnostics together with `reason`, `mode` and
`ambiguous`. "Info" means `wx.getImageInfo`; "Image" means the decoded pixels.

| Row | Orientation | Info dims | Image dims | Decision | Why |
|---|---|---|---|---|---|
| `UP` | 1 (`up`) | any | any | no rotation | `up` never rotates; the decoded pixels are used as they are, even when the info dimensions disagree |
| `NON_SWAP` | 2–4 | any | any | manual transform | mirroring/180° rotation does not change dimensions, so no dimension test can detect engine application (flagged ambiguous) |
| `A` | 5–8 | raw landscape | upright portrait | engine applied (identity) | the Image is exactly the swapped version of a landscape raw frame |
| `B` | 5–8 | raw landscape | raw landscape | manual transform | the Image still has the raw landscape shape |
| `C` | 5–8 | upright portrait | raw landscape | manual transform | the metadata is already upright while the pixels are raw; the previous symmetric test wrongly chose "engine" here |
| `D` | 5–8 | portrait | portrait | engine applied (identity) | matching portrait dimensions are ambiguous: preserving the decoded pixels avoids inventing a landscape frame (flagged ambiguous) |
| `SQUARE` | 5–8 | square | square | manual transform | a square cannot reveal a swap (flagged ambiguous) |
| `UNMATCHED` | 5–8 | any other | any other | manual transform | neither raw nor swapped shape; there is no positive evidence of engine rotation (flagged ambiguous) |

### Documented risks of the dimension heuristic

- Rows `A`/`B` assume the phone camera's raw frame is **landscape** (true for iPhone stills).
  A raw *portrait* frame with EXIF 5–8 is indistinguishable from row `D` and is therefore left
  unrotated. Such files need the explicit `manual` mode; the diagnostics report `ambiguous:true`.
- Row `C` is the mirror image of that assumption: an upright-portrait metadata pair with a raw
  landscape Image is rotated. A raw portrait frame reported as portrait metadata is not detectable.
- Rows `NON_SWAP`, `SQUARE`, `UNMATCHED` and `D` are marked `ambiguous:true`, so a device report
  states that the pixel-level provenance could not be proven.
- The rows can be overridden explicitly (`EXIF_ORIENTATION_MODE = 'manual' | 'engine'`) when a
  target base library is known to apply EXIF itself.

The decision returns the effective transform and the final output dimensions. An engine-oriented
5–8 decode is not swapped a second time. When a manual 5–8 transform is selected, width and height
swap **before** the shared long-edge calculation. The resulting canvas is already upright when
uploaded as the WebGL photo texture.

## The source → destination mapping (and the crop bug it caused)

For raw source width `W` and height `H` and an oriented output of `outW × outH`:

```text
oriented source size (ow, oh) = (W, H) or (H, W) for EXIF 5-8
scale            = min(outW / ow, outH / oh)          # one uniform scale
destination rect = (W * scale) × (H * scale)         # in raw (unrotated) space
transform        = orientationTransform(orientation, destinationWidth, destinationHeight)
drawImage(source, 0, 0, W, H, 0, 0, destinationWidth, destinationHeight)
```

Two details are load-bearing:

1. The **nine-argument** `drawImage` maps the *complete* source rectangle into the destination
   rectangle. The previous five-argument call drew the full-resolution source into a smaller
   canvas, which produced a magnified **top-left crop** instead of a downscaled picture. On the
   device that turned a 3213×5712 photo into a 720×1280 crop of its top-left corner (a 4.5×
   magnification) — the picture looked "wrongly proportioned" although its aspect was correct.
2. The orientation matrix must be built in the **scaled destination space**
   (`destinationWidth/destinationHeight`), not in raw source space. With raw-space dimensions a 90°
   rotation at any downscale placed the content outside the canvas.

The context transform is reset to identity before the clear and after the draw, so no stray
scale/DPR transform can accumulate. The exact `drawImage` arguments, the transform matrix, the
effective composed matrix and both scale factors are reported in the diagnostics.

| EXIF | WeChat name | Output size | Transform (built in destination space) |
|---:|---|---|---|
| 1 | `up` | W×H | `[1,0,0,1,0,0]` |
| 2 | `up-mirrored` | W×H | `[-1,0,0,1,dw,0]` |
| 3 | `down` | W×H | `[-1,0,0,-1,dw,dh]` |
| 4 | `down-mirrored` | W×H | `[1,0,0,-1,0,dh]` |
| 5 | `left-mirrored` (transpose) | H×W | `[0,1,1,0,0,0]` |
| 6 | `right` (90° clockwise) | H×W | `[0,1,-1,0,dh,0]` |
| 7 | `right-mirrored` (transverse) | H×W | `[0,-1,-1,0,dh,dw]` |
| 8 | `left` (90° counter-clockwise) | H×W | `[0,-1,1,0,0,dw]` |

(`dw`/`dh` are the scaled destination rectangle; the composed matrix that actually scales the
source is reported as `effectiveTransform`.) Image smoothing is enabled and high quality is
requested. The output aspect must match the oriented decoded aspect within 1 %; a larger mismatch
throws `GEOMETRY_MISMATCH` instead of stretching.

## Sizing rules downstream

- The **preview letterbox** and the **preset thumbnails** are sized from the oriented, decoded
  dimensions only: the preview uses the photo texture's dimensions, the thumbnails use
  `prepared.width/height`. The page asserts that the texture dimensions, the decode-canvas
  dimensions and the prepared dimensions agree, and that the texture aspect matches the prepared
  aspect within 1 %. A mismatch is logged with `console.error` and appears in the diagnostics.
- WebGL texture uploads use `UNPACK_FLIP_Y_WEBGL=false`. Because canvas/PNG sources place their top
  row at V=0, the vertex shader maps the top of the displayed quad to V=0. This flip applies only to
  photo coordinates. LUT coordinates directly use green as the top-to-bottom row within each blue
  tile.

## WeChat quirks and remaining verification

- `wx.getImageInfo` can omit orientation or return `up` for an already-normalized camera/album
  asset. Missing and unknown values are treated as `up`, and `up` never rotates.
- Some iPhone HEIC selections are transcoded by WeChat to JPEG. If `getImageInfo` reports a type
  other than JPEG/JPG/PNG, the app shows an unsupported-format error rather than uploading a
  partially decoded image.
- Mirrored orientations 2/4/5/7 are handled explicitly, not collapsed into rotation-only cases.
  Cancellation, denied permission, unsupported type, and decode failure leave a visible banner.
- The picker requests `sizeType: ['original']`, so the decoded file is the file the user picked and
  is not silently recompressed. The chosen file's name, extension, byte size, type and the
  requested `sizeType` are reported in the diagnostics, together with the byte size per decoded
  pixel as a re-compression hint.

## Verification

- `harness/test-orientation.mjs` (plain Node) covers the eight orientations, the explicit
  overrides, the rectangle-corner matrix mappings, every row of the decision table above, and the
  suspect-decode redraw/release policy.
- `harness/test-photo-real.mjs` (real Chrome Canvas2D) loads the production photo module and
  exercises `drawOriented()`, `preparePhoto()` and `prepareExportImage()` with genuine
  `Image`/`Canvas` objects: 8 orientations × 4 info/Image dimension combinations × 3 output sizes
  (downscale, 1:1, export) = 96 cases, each compared against an independently computed whole-image
  reference (corners, quadrant colours, mean and maximum difference). It also contains a regression
  case that fails on the old five-argument draw, and — when the fixture exists — the real
  3213×5712 user photo, which must decode to 720×1280 with the same content as a direct
  whole-image downscale.

## Real-device EXIF checklist

Run this checklist on each target iOS/Android WeChat base library; desktop Chrome cannot confirm
the canvas decoder policy.

- [ ] Create album copies of one **asymmetric, non-square** JPEG with visible labels in all four
  original corners (`TL`, `TR`, `BR`, `BL`). Set only its EXIF orientation tag to 2, 3, and 4 in
  successive copies; do not rotate the underlying pixels or let the editor normalize the tag.
- [ ] With `EXIF_ORIENTATION_MODE = 'auto'`, open the Mini Program, choose the EXIF 2 copy, and
  inspect the preview. The original `TL` corner must appear at **top-right**. Repeat for EXIF 3
  (`TL` → **bottom-right**) and EXIF 4 (`TL` → **bottom-left**). Also verify that the image is not
  stretched and that stock changes do not alter geometry.
- [ ] If any EXIF 2/3/4 result leaves original `TL` at top-left, that is the signature of an
  engine-applied transform followed by the same manual transform. Temporarily set
  `EXIF_ORIENTATION_MODE = 'engine'`, restart the Mini Program, and repeat all three picks. Record
  the device, WeChat/base-library versions, and result before changing the default policy.
- [ ] Repeat the picks with EXIF 5–8 copies. In auto mode, compare the observed result with the
  corner mappings in the table above and confirm there is no double 90° rotation. Include one
  mirrored portrait and one square image to exercise the detection limits.
- [ ] Check the 「诊断」 report: the `EXIF decision` row, the `whole-image check` (mean absolute
  difference against a direct whole-image downscale) and the `canvas2d self-test` must all be
  clean, and the decoded Image dimensions must equal the expected camera output.
- [ ] Repeat after a cold start and after choosing a normal EXIF 1 photo, confirming that lazy LUT
  loading and clear/reselect do not change orientation.
