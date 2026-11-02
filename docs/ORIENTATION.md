# Photo orientation and preview geometry

## App approach

The Mini Program calls `wx.getImageInfo({src})` and normalizes its `orientation` value to one of the
eight EXIF/WeChat names. A canvas image is then decoded with the preview canvas's `createImage()`.
`utils/photo.js` applies orientation and downscaling in **one Canvas2D draw** into an offscreen
canvas; it does not allocate a full-resolution oriented intermediate.

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

Orientations 5–8 swap width and height **before** the shared 1280-long-edge calculation. Image
smoothing is enabled and high quality is requested. The resulting canvas is already upright when
uploaded as the WebGL photo texture.

WebGL texture uploads use `UNPACK_FLIP_Y_WEBGL=false`. Because canvas/PNG sources place their top row
at V=0, the vertex shader maps the top of the displayed quad to V=0. This flip applies only to photo
coordinates. LUT coordinates directly use green as the top-to-bottom row within each blue tile.

The canvas backing store uses the oriented, downscaled dimensions. CSS separately scales that canvas
to fit the preview stage without cropping, preserving aspect ratio and leaving black letterbox bars.
This avoids both GPU upscaling of the original 12 MP texture and CSS stretching.

## WeChat quirks and remaining verification

- `wx.getImageInfo` can omit orientation or return `up` for an already-normalized camera/album asset.
  Missing and unknown values are treated as `up`, avoiding an arbitrary extra rotation.
- The implementation assumes the reported orientation describes the source seen by canvas
  `createImage()`. Decoder auto-rotation behaviour has varied across base-library/DevTools versions;
  a host that both auto-rotates pixels and still reports a non-`up` transform could double-rotate.
  This must be checked with real EXIF 2–8 photos on the target WeChat base library.
- Some iPhone HEIC selections are transcoded by WeChat to JPEG. If `getImageInfo` reports a type
  other than JPEG/JPG/PNG, the app shows an unsupported-format error rather than uploading a
  partially decoded image.
- Mirrored orientations 2/4/5/7 are handled explicitly, not collapsed into rotation-only cases.
  Cancellation, denied permission, unsupported type, and decode failure leave a visible banner.

The six supplied phone fixtures are all EXIF orientation 1. The harness therefore verifies their
upright browser resize/draw path, while the eight matrix mappings have JavaScript smoke tests only.
It does **not** constitute visual EXIF coverage in WeChat. DevTools and physical-device checks with
rotated and mirrored JPEGs remain necessary.
