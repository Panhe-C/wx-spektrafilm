# Photo orientation and preview geometry

## App approach

The Mini Program calls `wx.getImageInfo({src})` and normalizes its `orientation` value to one of the
eight EXIF/WeChat names. A canvas image is then decoded with the preview canvas's `createImage()`.
`utils/photo.js` applies orientation and downscaling in **one Canvas2D draw** into an offscreen
canvas; it does not allocate a full-resolution oriented intermediate.

The exported `EXIF_ORIENTATION_MODE` constant is `'auto'` by default. The pure, synchronous
`decideExifOrientation()` helper implements the three policies:

- `'manual'`: always apply the matrix from `wx.getImageInfo().orientation`;
- `'engine'`: assume `canvas.createImage()` already applied EXIF and use the identity matrix;
- `'auto'`: for EXIF **5–8**, compare decoded dimensions with `getImageInfo` dimensions. If decoded
  width/height are exactly swapped, select `'engine'`; otherwise select `'manual'`. EXIF **2, 3,
  and 4 cannot be detected by dimensions**, so auto deliberately follows `'manual'` for them.

The decision returns both the effective transform and final output dimensions. Thus an
engine-oriented 5–8 decode is not swapped a second time. A square image cannot reveal a swap and
falls back to manual. `preparePhoto` accepts an optional `orientationMode` override for diagnosis;
normal app operation uses the exported constant.

For raw source width `W` and height `H`, the transforms passed to `setTransform(a,b,c,d,e,f)` are:

| EXIF | WeChat name | Output size | Transform |
|---:|---|---|---|
| 1 | `up` | W×H | `[1,0,0,1,0,0]` |
| 2 | `up-mirrored` | W×H | `[-1,0,0,1,W,0]` |
| 3 | `down` | W×H | `[-1,0,0,-1,W,H]` |
| 4 | `down-mirrored` | W×H | `[1,0,0,-1,0,H]` |
| 5 | `left-mirrored` (transpose) | H×W | `[0,1,1,0,0,0]` |
| 6 | `right` (90° clockwise) | H×W | `[0,1,-1,0,H,0]` |
| 7 | `right-mirrored` (transverse) | H×W | `[0,-1,-1,0,H,W]` |
| 8 | `left` (90° counter-clockwise) | H×W | `[0,-1,1,0,0,W]` |

When a manual 5–8 transform is selected, width and height swap **before** the shared
1280-long-edge calculation. When auto detects an engine-applied transform, decoded dimensions are
already final and the identity matrix is used. Image smoothing is enabled and high quality is
requested. The resulting canvas is already upright when uploaded as the WebGL photo texture.

WebGL texture uploads use `UNPACK_FLIP_Y_WEBGL=false`. Because canvas/PNG sources place their top row
at V=0, the vertex shader maps the top of the displayed quad to V=0. This flip applies only to photo
coordinates. LUT coordinates directly use green as the top-to-bottom row within each blue tile.

The canvas backing store uses the oriented, downscaled dimensions. CSS separately scales that canvas
to fit the preview stage without cropping, preserving aspect ratio and leaving black letterbox bars.
This avoids both GPU upscaling of the original 12 MP texture and CSS stretching.

## WeChat quirks and remaining verification

- `wx.getImageInfo` can omit orientation or return `up` for an already-normalized camera/album asset.
  Missing and unknown values are treated as `up`, avoiding an arbitrary extra rotation.
- Auto mode prevents double rotation/resize for dimension-swapping EXIF 5–8 when the decoded size
  is exactly swapped relative to `getImageInfo`. It falls back to manual when dimensions match or
  metadata is inconsistent.
- **EXIF 2/3/4 still require manual transforms in auto mode.** Mirroring or 180° rotation does not
  change dimensions, so an engine that already applied those orientations would still be
  double-transformed. This must be confirmed with the real-device checklist below; use the
  `'engine'` override only if the target host is shown to apply EXIF itself.
- Some iPhone HEIC selections are transcoded by WeChat to JPEG. If `getImageInfo` reports a type
  other than JPEG/JPG/PNG, the app shows an unsupported-format error rather than uploading a
  partially decoded image.
- Mirrored orientations 2/4/5/7 are handled explicitly, not collapsed into rotation-only cases.
  Cancellation, denied permission, unsupported type, and decode failure leave a visible banner.

The six supplied phone fixtures are all EXIF orientation 1. The browser harness therefore verifies
their upright resize/draw path, not visual EXIF coverage in WeChat. `harness/test-orientation.mjs`
runs under plain Node before the browser tests and covers all eight orientations with emulated
engine-applied/raw decodes, manual/engine overrides, and rectangle-corner matrix mappings.

## Real-device EXIF checklist

Run this checklist on each target iOS/Android WeChat base library; desktop Chrome cannot confirm
the canvas decoder policy.

- [ ] Create album copies of one **asymmetric, non-square** JPEG with visible labels in all four
  original corners (`TL`, `TR`, `BR`, `BL`). Set only its EXIF orientation tag to 2, 3, and 4 in
  successive copies; do not rotate the underlying pixels or let the editor normalize the tag.
- [ ] With `EXIF_ORIENTATION_MODE = 'auto'`, open the Mini Program, choose the EXIF 2 copy, and
  inspect the preview. The original `TL` corner must appear at **top-right**. Repeat for EXIF 3
  (`TL` → **bottom-right**) and EXIF 4 (`TL` → **bottom-left`). Also verify that the image is not
  stretched and that stock changes do not alter geometry.
- [ ] If any EXIF 2/3/4 result leaves original `TL` at top-left, that is the signature of an
  engine-applied transform followed by the same manual transform. Temporarily set
  `EXIF_ORIENTATION_MODE = 'engine'`, restart the Mini Program, and repeat all three picks. Record
  the device, WeChat/base-library versions, and result before changing the default policy.
- [ ] Repeat the picks with EXIF 5–8 copies. In auto mode, compare the observed result with the
  corner mappings in the table above and confirm there is no double 90° rotation. Include one
  mirrored portrait and one square image to exercise the detection limits.
- [ ] Repeat after a cold start and after choosing a normal EXIF 1 photo, confirming that lazy LUT
  loading and clear/reselect do not change orientation.
