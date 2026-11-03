# Full-resolution export

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).

This document describes Phase 5b: how the app saves a picture with the current
look at the original resolution, how the picture is tiled so that the grain,
the halation and the vignette stay seamless, how the album permission is
handled, and what the headless harness verifies.

## 1. What is exported

The export reproduces exactly what the preview shows — the same stock, the
same adjustments, the same intensity and the same spatial effects — but at
the resolution of the original photograph:

| property | value |
|---|---|
| export size | `min(original long side, 4096 px, GPU limits)` |
| aspect ratio | unchanged |
| colour | the same LUT, the same camera gains, the same effects |
| format | JPEG, quality 0.92 |
| destination | the system photo album (`wx.saveImageToPhotosAlbum`) |

The original file is never modified: it is decoded, drawn into an offscreen
2D canvas at the export size and rendered from there.

The export size is the *long* edge; the short edge follows from the aspect
ratio. A 12 MP phone photo (4032×3024) is therefore exported at 4032×3024
when the GPU allows it, and at 2048×1536 on a device whose maximum texture
size is 2048.

## 2. The pipeline

```text
wx.getPrivacySetting + the in-app privacy popup           (privacy consent)
  → wx.getSetting (a hint only, it never blocks)           (permission)
  → wx.showModal / wx.openSetting (only if the scope was refused before)
  → decode Image (natural size) + wx.getImageInfo                  (oriented size)
  → utils/export.js planExport()                                  (size + tiles)
  → utils/photo.js prepareExportImage()                           (decode + EXIF)
  → renderer.renderRegionToPixels() per tile                      (WebGL)
  → 2D assembly canvas                                            (putImageData)
  → wx.canvasToTempFilePath({fileType:'jpg', quality:0.92})       (encode)
  → wx.saveImageToPhotosAlbum()                                   (save)
  → on an auth-deny error: wx.showModal → wx.openSetting → one retry
```

`utils/export.js` owns the plan and the orchestration; every WeChat call is
an injected host adapter (`utils/export-wechat.js` builds them). The unit
suite (`harness/test-export.mjs`) injects a mock host, so the whole flow —
including the permission handling, the privacy consent, the timeouts and the
cancellation — is tested in Node without a browser.

The privacy part of the flow is described in `docs/PRIVACY.md`.

### Stages and progress

| stage | what happens | progress |
|---|---|---|
| `permission` | the privacy guide is confirmed and the album scope is read (a hint) | 2 % |
| `decode` | the original is decoded and drawn into a 2D canvas at the export size | 10 % |
| `render` | one tile per step, `渲染 n/m` | 10 … 80 % |
| `encode` | the assembly canvas is written as a JPEG | 88 % |
| `save` | the file is written into the album | 96 % |

The page yields to the event loop between the tiles (`setTimeout(…, 0)`), so
the interface stays responsive and the 「取消」 button can be pressed.

## 3. The tile plan

`planExport()` is pure and returns the size, the margin, the tile size and
the tiles:

```js
const plan = Export.planExport({
  sourceWidth: 4032, sourceHeight: 3024,
  maxTextureSize: 4096, maxLongEdge: 4096, tileSize: 2048,
  stockId: 'portra400', halationStrength: 1,
});
```

* the tiles cover the picture exactly — no gap, no overlap;
* the tile size is reduced when the GPU limit is small, so that the padded
  halo buffer still fits into a texture;
* the **margin** is `ceil(3·sigma) + 2` pixels
  (`Effects.halationMarginPixels`), where `sigma` is the frame-relative
  halation sigma at the export size (30 px at 4096 px for a still film,
  23 px at 3000 px). The margin is zero when the halation is switched off.

Each tile carries a renderer target that describes, in the normalised frame
space (the long edge of the picture is 1.0):

| target field | meaning |
|---|---|
| `regionOrigin`, `regionSize` | the rectangle of the picture this tile covers — the grain and the vignette are functions of this global position, so they are continuous across the tile borders |
| `imageUvOffset`, `imageUvScale` | where the tile sits on the full-resolution photo |
| `haloImageUvOffset`, `haloImageUvScale` | where the *padded* rectangle sits on the photo (the halation chain renders it) |
| `haloUvScale`, `haloUvOffset` | how the main pass samples the padded halo buffer |
| `imageFrameOrigin`, `imageFrameSize` | the whole picture in frame space (the vignette) |

## 4. Why the tiled render equals the single-pass render

The renderer gained `renderRegionToPixels()`: it renders a sub-rectangle of
the picture into an offscreen framebuffer. The shader samples the photo
through the tile's uv mapping (`uImageUvOffset` + `uImageUvScale`) instead of
the identity mapping, and the frame position (`uRegionOrigin` +
`uRegionSize`) is the global one. The grain lattice and the vignette are
therefore evaluated at the same global coordinates in a tile and in a
single-pass render.

The halation needs more: its kernel reaches `2·sigma` pixels, so the halo
chain renders the **padded** rectangle (the tile plus the margin) and the
main pass samples that buffer with `uHaloUvScale`/`uHaloUvOffset`. Every
pixel of the tile only sees real picture content inside the kernel support,
so the bloom of a tile equals the bloom of the single-pass render.

> **A vertical flip was found and fixed while writing this.** A render target
> has its row zero at the bottom, while the photo texture has its row zero at
> the top. The exposure pass of the halo chain therefore writes the picture
> upside down into the halo buffer, and the main pass read it mirrored: the
> halation was vertically flipped in the preview, and in a tiled export it
> would have been mirrored inside every tile. The exposure pass now flips the
> vertical axis explicitly, so both buffers use the same convention. The
> harness has a regression test for it (a bright patch in the top left
> corner: the halo has to grow around the patch, not around its mirror
> image).

## 5. The permission flow

`scope.writePhotosAlbum` is **not** asked for in advance any more:
`wx.authorize` is a privacy scoped interface itself, and the platform wants
the target interface to be called and its authorisation error to be handled.

| state | action | result |
|---|---|---|
| the privacy guide was not accepted yet | the in-app popup asks the user (a real `<button open-type="agreePrivacyAuthorization">`) | 「同意」 → the export starts; 「拒绝」 → 「未同意隐私协议，无法保存到相册。」 |
| the album scope is already granted | nothing | the export starts |
| the album scope was refused before | `wx.showModal` explains the need, then `wx.openSetting` | granted in the settings → the export starts; cancelled → 「已取消保存。」; still refused → 「请在设置中开启「保存到相册」权限后再试。」 |
| the save fails with an auth-deny error | `wx.showModal` → `wx.openSetting` → the save is retried **once** | granted → the picture is saved; otherwise the error message of the platform |

`wx.getSetting` is only a *hint*: it has its own short timeout and the export
continues when it does not answer. It never blocks the export.

Every platform call runs inside a **timeout wrapper** (8 s by default, 15 s
for the save, 30 s for the encode). A timeout produces a message that names
the step and the elapsed time, the export panel offers a retry and
「打开设置」, and a late callback is ignored. The 「取消」 button works at
every step, also while a platform call is pending.

The privacy consent, the popup and the console configuration are described in
`docs/PRIVACY.md`.

## 5b. The step log and the diagnostics

Every step of the export is written to the console with the prefix
`[wx-spektrafilm][export]` (`step phase elapsed detail`) and into a bounded
ring buffer. The buffer is shown in the 「关于 → 诊断」 panel under
**Export steps**, next to the state of the privacy guard (**Privacy**: the
result of `wx.getPrivacySetting`, whether `onNeedPrivacyAuthorization` fired,
the raw `authSetting` and the base library version). The panel is copyable,
so a failed export can be reported with its whole state.

## 6. Memory

The export is the most memory-hungry operation of the app. At the maximum
size (4096×2731) the picture needs

| buffer | size |
|---|---|
| the full-resolution photo texture | ~45 MB |
| the assembly canvas (2D) | ~45 MB |
| the two halo buffers | ~30 MB |
| the offscreen tile framebuffer | ~15 MB |

The renderer, the canvases and the textures are released as soon as the
export finishes (or is cancelled). The 4096 px budget and the GPU limits
keep the peak below what a mid-range phone can hold, but the real peak has
**not** been measured on a device — see `docs/LIMITATIONS.md`.

## 7. Verification

`harness/test-export.mjs` (pure, Node):

* the export size: the 4096 px budget, the GPU limit, no upscaling;
* the tile plan: exact coverage (every pixel covered once), no gaps, the
  margins, the halo buffer fitting into the texture limit;
* the permission flow: the privacy pre-flight, the hint, the scope that was
  refused before (modal + settings), the cancellation;
* the save errors (cancel, missing permission, privacy errors, other
  failures) and the auth-deny recovery (modal → settings → one retry);
* the timeouts: a `getSetting`, a privacy pre-flight and a save that never
  answer must end in a bounded time with a message that names the step;
* a late answer after the timeout (ignored) and the cancellation while a call
  is pending;
* the orchestrator: the stage order, the cancellation, the release of the
  buffers, the failure messages.

`harness/test-privacy.mjs` (pure, Node) verifies the privacy guard: the
listener is registered once, a privacy scoped interface stays pending until
the guard resolves it, the resolution carries the id of the 「同意」 button,
the refusal resolves it with `{event:'disagree'}`, and the pre-flight never
waits forever (`docs/PRIVACY.md`).

`harness/test-export-browser.mjs` (headless Chrome/SwiftShader):

* the same picture rendered in one pass and in tiles at 3000×2000 with the
  grain, the halation and the vignette switched on: the maximum absolute
  difference is **1 code** (the 8-bit rounding of the halo buffer), and the
  columns and rows on the tile borders do not differ more than the rest;
* the same test with 1024 px tiles (six tiles) and with 2048 px tiles (two
  tiles), for a still film and for a cinema film.

## 8. Reproducing the numbers

```sh
cd harness
npm test              # the whole suite, including the export checks
npm run test:export   # only the export checks
```
