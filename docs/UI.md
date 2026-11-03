# Presets and adjustments UI

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).

This document describes the Phase-4b page: its structure, the phase state machine, the preset
thumbnail path, the slider/`setData` policy, and the real-device checklist that still has to be
executed by hand. The renderer and the adjustment model are documented in `docs/RENDERER.md` and
`docs/ADJUSTMENTS.md`; the physical EV/WB measurements are in `docs/EXPOSURE_EV.md`.

## Page structure

The single page `pages/index/index` is a fixed dark layout: a header, the WebGL preview, a
scrollable body with five sections, and a pinned action bar.

```text
.page  (flex column, 100vh)
├── .header                 SPEKTRAFILM / 胶片色彩 · 本机 WebGL 预览
├── .error-banner           friendly failure + truncated raw errMsg diagnostics (conditional)
├── .preview-stage          <canvas type="webgl"> + empty state + loading mask + compare badge
├── .body-scroll            <scroll-view scroll-y>
│   ├── 胶片预设             three category sections, cards with name / ISO / description / thumbnail
│   ├── 调整                 曝光 EV, 色温, 色调, 强度, 后期微调（对比度, 饱和度）, 重置
│   ├── 效果                 颗粒, 光晕, 暗角, 重置效果
│   ├── 导出                 说明, 进度条 + 取消, 保存到相册
│   └── 关于                 attribution, licence, version, effect-scope note, 诊断
├── .diagnostics-modal      copyable monospaced device report (conditional)
└── .actions                从相册选择 / 拍照 / 清除  (+ safe-area padding)
```

Design rules that the stylesheet keeps:

- one spacing scale (8 rpx steps), one accent colour (`#d6b98a`), one card radius (14 rpx);
- every interactive row is at least 72 rpx tall, the action buttons are 84 rpx (`line-height`);
- the action bar and the about row use `env(safe-area-inset-bottom)` padding;
- the preview canvas always fills the stage (`100% × 100%`), including the empty state; the stage has
  a fixed height (`42vh`, `min-height: 400rpx`), so the first photo does not re-layout the native
  surface or jump the page;
- the thumbnail box has a fixed **16:9** ratio (`padding-bottom:56.25%`) and the placeholder occupies
  exactly the same box as the finished image, so a thumbnail appearing causes no reflow;
- the slider readouts sit in fixed-width columns, so a changing number never moves the layout;
- loading and disabled states are explicit: the pick buttons are disabled while busy, the reset
  button is disabled while every adjustment is at its default, and the preview shows a spinner
  mask during decode/LUT work.

### Preset cards

The cards are grouped by the manifest `category` field, in the order 彩色负片 → 反转片（幻灯片）→
电影胶片. Each card shows the display name, the ISO speed, one Chinese line describing the
stock, and a thumbnail rendered from the current photo.

The descriptions in `utils/ui-state.js` summarise the published character of each film stock. They
are not measurements of the shipped cube and make no claim beyond that.

### Adjustments panel

| Control | Range | Step | Physical? |
|---|---|---|---|
| 曝光 EV | −2 … +2 | 0.1 | yes — camera-side exposure, fixed print time |
| 色温 | −100 … +100 | 1 | camera white balance (Bradford adaptation) |
| 色调 | −100 … +100 | 1 | camera white balance green/magenta axis |
| 强度 | 0 … 1 | 0.01 | blend amount between original and LUT output |
| 对比度 | −1 … +1 | 0.01 | **no** — display look only (multiplier 0.7 … 1.4) |
| 饱和度 | 0 … 2 | 0.05 | **no** — display look only |

对比度 and 饱和度 live in a collapsed group titled 「后期微调（非胶片物理）」 so that the
non-physical controls are never confused with the physical ones. A single 「重置」 button restores
all six values (including 强度) to their defaults; it does not touch the photo or the selected
stock, and it is disabled while everything is already at the default.

Press-and-hold on the preview still shows the untouched original; the shader short-circuits at
intensity 0, so the comparison is unaffected by any adjustment.

The contrast slider maps `-1 … 1` onto a multiplier of **0.7 … 1.4** around the encoded 0.5 pivot
(identity at 0). The slider minimum used to be a multiplier of 0, which flattened the whole
picture to grey; the new minimum keeps the structure (black → 0.15, white → 0.85). The mapping
lives in `utils/adjust.js::contrastMultiplier` and is documented in `docs/ADJUSTMENTS.md`.

### Effects panel (「效果」)

| Control | Range | Step | Physical? |
|---|---|---|---|
| 颗粒 (grain) | 0 … 2 | 0.05 | approximate — measured from the physical pipeline |
| 光晕 (halation) | 0 … 2 | 0.05 | approximate — physical back-reflection parameters |
| 暗角 (vignette) | 0 … 1 | 0.02 | **no** — a lens falloff, not part of the film model |

The panel carries its own 「重置效果」 button; the global 「重置」 in the adjustments panel restores
the adjustments **and** the effects to the shipped defaults (grain 100 %, halation 100 %,
vignette 0 %). The panel states that the grain and the halation are approximations and that the
preset thumbnails do not include them.

The effects are applied by the renderer, not by the page: the page owns the state, calls
`renderer.setEffects()` and redraws, exactly like the adjustment sliders. The preset thumbnails are
rendered with the effects switched off (`renderToPixels({ effects: … })`).

## Export panel (「导出」)

The export panel sits between the 「效果」 and the 「关于」 sections. It explains that the export
uses the original resolution (long edge 4096 px, JPEG 92 %) and that the original photo is never
modified, and it owns the 「保存到相册」 button.

| state | what the panel shows |
|---|---|
| idle | the 「保存到相册」 button (disabled without a photo) |
| running | the stage text (`解码原图 …`, `渲染 2/6…`, `编码 JPEG…`, `保存到相册…`), a progress bar and a 「取消」 button |
| done | a toast: 「已保存到相册」, 「已取消保存」 or the reason of the failure |

The button is disabled while an export runs, so a second export cannot start. The cancel button
only sets the cancel flag; the export stops at the next tile boundary and releases its buffers.
The pipeline, the permission flow and the tiling are documented in `docs/EXPORT.md`.

## Share entries

The page implements `onShareAppMessage()` (a title and the path `/pages/index/index`) and
`onShareTimeline()` (a title), and `wx.showShareMenu({ menus: ['shareAppMessage',
'shareTimeline'] })` is called in `onLoad`, so both entries appear in the platform menus. The
share does not carry any user data.

## Hidden device diagnostics

**关于 → 诊断** and a long-press on the **SPEKTRAFILM** title open the same modal. Opening or tapping
**重新运行** executes the shared GL suite; **复制** sends the monospaced report to
`wx.setClipboardData`, and **关闭** dismisses it. The report contains GL capabilities, canvas and
source sizes, P/D upload attempts and fallbacks, per-texture completeness parameters/status/GL
errors, a solid-colour FBO test, CPU-versus-GPU photo/LUT probes, full-shader intensity 1/0
centre pixels, canvas/stage CSS rects, actual/clamped buffer geometry, the last on-screen photo
viewport, and default-framebuffer centre + four inset corners compared with an identical FBO render.
Orientation/decode dimensions and thumbnail crop geometry are included. It contains only tiny probe values, not the photo itself.

The latest report is cached in memory by `utils/diagnostics.js` and logged with
`[wx-spektrafilm][diag]`. When another page operation raises the error banner, the page generates a
report and appends 「已生成诊断，可在 关于 → 诊断 查看」. If both pixel and direct photo uploads read
black, the legal all-black-photo path instead shows 「照片读取为全黑，可在 关于 → 诊断 查看」; this warning
is never used for LUTs. The report is not persisted or uploaded. Probe
interpretation and the original iPhone investigation are in `docs/DEVICE_DEBUG.md`.

## Phase state machine

`utils/ui-state.js` owns the phase table; the page calls `transition(event)` and never mutates
`data.phase` directly.

| Phase | Meaning | Busy mask |
|---|---|---|
| `empty` | no photo | no |
| `decoding` | decoding, EXIF correction and downscaling | yes |
| `loading-luts` | reading the local LUT manifest and loading the first stock | yes |
| `ready` | preview and presets are usable | no |
| `error` | the last operation failed; the message is in the banner | no |

| From | Event | To |
|---|---|---|
| `empty` | `pick` | `decoding` |
| `decoding` | `decoded` | `loading-luts` |
| `loading-luts` | `luts-ready` | `ready` |
| `ready` | `pick` | `decoding` |
| `error` | `pick` | `decoding` |
| any | `failed` | `error` |
| any | `clear` | `empty` |

Any other combination throws inside `nextPhase`, and the page keeps the current phase instead of
silently jumping. Cancelling the photo picker is not an error: it only shows 「已取消选择。」 in the
banner and leaves the phase untouched.

## Preset thumbnail path

Thumbnails are rendered from the **current photo**, at the stock's default look (identity
adjustments, intensity 1). They are never regenerated while a slider moves, and they are discarded
when a new photo is chosen.

```text
photo texture (already on the GPU)
  → thumbnailGeometry(photo) = fixed 16:9 output + centre-crop UV rect
  → renderer.setLut(base cube of the stock)      (base only; no extended cube is needed)
  → renderer.renderToPixels({ width, height, intensity: 1, adjustments: DEFAULTS })
        └─ offscreen RGBA framebuffer, readPixels, top-down rows
  → utils/thumbnail.js exportPixels()
        1. wx.canvasToTempFilePath({ canvas })   → temp file path
        2. canvas.toDataURL('image/png')         → data URL
        3. built-in PNG encoder → USER_DATA_PATH file
        4. failure                               → coloured placeholder
  → setData on that single card
```

- **Geometry**: `utils/thumbnail.js::thumbnailGeometry()` returns a fixed **96×54** target and a
  centre-crop rect/UV mapping for the current photo. The FBO samples only that crop; `<image
  mode="aspectFill">` and the 16:9 WXSS box match it. There is no `aspectFit` letterbox and no
  `scaleToFill` squeeze, including for portrait photos.
- **Export order**: `wx.canvasToTempFilePath` is tried first because a file path keeps `setData`
  tiny; the data-URL route is the fallback for hosts without it; the built-in PNG encoder (an
  8-bit RGBA PNG with stored deflate blocks, verified by the Node unit test) is the last file-based
  fallback; if every route fails the card shows a deterministic coloured placeholder and the rest
  of the UI keeps working.
- **Scheduling**: the selected stock is generated first, then the cards that the
  `IntersectionObserver` reports as visible or near (`relativeToViewport({ bottom: 240 })`), then
  the remaining stocks in manifest order. One thumbnail is generated per animation-frame-sized
  timeout so the UI thread stays responsive.
- **Cache**: the cache key is the photo plus the stock. It is cleared on every new photo, on
  「清除」, and on unload.
- **Renderer interaction**: generating a thumbnail temporarily points the renderer at another
  stock's cube, so the active stock's cube is restored and the preview is redrawn immediately
  afterwards. The preview therefore never shows the wrong look.
- **LUT loading**: a thumbnail only needs the base cube `<id>.png`. The extended cube
  `<id>.ev2.png` is loaded lazily the first time a positive EV or a nonidentity white balance
  needs it, and it is then cached for that stock.

### Base versus extended cube

`utils/lut-renderer.js` accepts a stock without its extended cube:

- `setLut(base, metadata, extendedSource)` uploads the base cube and, when the extended source is
  present, the extended cube as well;
- `setExtendedLut(source, metadata)` uploads the extended cube later, without re-uploading the
  base cube;
- `hasExtendedLut()` reports whether the extended cube is resident;
- drawing with a positive EV or a nonidentity white balance **without** the extended cube throws
  `This stock has no extended-range LUT for positive EV/WB` instead of silently using the wrong
  cube.

The page keeps the extended cube unloaded until it is needed, shows 「正在载入扩展 LUT…」 while it
is being fetched, and redraws as soon as it is resident.

## Slider and `setData` policy

Slider handling is split into a pure part and an effectful part:

- `utils/ui-state.js` owns the ranges, the step rounding, the readout formatting, the
  "needs the extended cube" decision, and the `shouldEmit()` throttle policy. It has no side
  effects and is unit-tested by `harness/test-ui-state.mjs`.
- `pages/index/index.js` owns the effects: `renderer.setAdjustments()`, `renderer.render()`, and
  the throttled `setData`.

On `bindchanging` the page updates the renderer **immediately** and only schedules a readout
`setData`; the throttle (`READOUT_INTERVAL_MS = 120`) means at most one small `setData` per 120 ms
while a finger is moving. On `bindchange` (the finger lifted) the final value and the readouts are
written at once, and the slider's `value` binding is refreshed so the thumb and the stored state
agree. No per-frame `setData` of the preset list happens.

## Verification

`cd harness && npm test` runs the orientation unit tests, the adjustment-mapping unit tests, the
**UI-state unit tests** (`harness/test-ui-state.mjs`: ranges, step rounding, readout formats,
category grouping, thumbnail geometry and ordering, throttle policy, phase machine, PNG fallback
encoder, base64 encoder), the **page-wiring tests** (`harness/test-page.mjs`: the page module
boots under a mocked WeChat host, the phase machine drives the busy mask, the sliders update the
renderer while the readouts stay throttled, the reset restores every default, press-and-hold
compares, the thumbnail path degrades to a placeholder when the export fails, and every WXML
handler exists on the page), the **pure diagnostics formatter**
(`harness/test-diagnostics.mjs`), and then the headless Chrome/SwiftShader comparison against the NumPy
references, including the thumbnail path and the stock-switch timing. The upload/diagnostics browser
suite (`harness/test-upload-strategies.mjs`) proves P/D equivalence within one code,
zero-filled-source fallback, and exact/bounded GL probes. `harness/test-presentation.mjs` adds
portrait, EXIF-6/8-oriented, DPR-2 and clamped-buffer default-versus-FBO checks plus crop geometry.
It is followed by the
**spatial-effect suite** (`harness/test-effects.mjs`): determinism, the identity of the
strength-0 path against `tools/lut_apply.py`, the scale invariance of the grain statistics, the
agreement with the NumPy mirror of the grain maths, the halation radial profile against the
physical study, the orientation of the halation (a bright patch in the top left corner must grow
a halo around itself, not around its mirror image), the effect timing at 1280 px and the physical
halation reference on a real photograph, followed by the **export suite**
(`harness/test-export.mjs` and `harness/test-export-browser.mjs`): the export size caps, the
tile plan (coverage, margins, gaps), the album permission flow with a mock `wx`, the
orchestrator (stages, cancellation, release), and the comparison of a tiled render with a
single-pass render at 3000×2000 with every effect switched on.

`python3 tools/check_miniprogram.py` additionally checks that every WXML handler exists on the
page, that the tags balance, that every `{{…}}` identifier resolves to page data or a `wx:for`
alias, that element ids are unique, that `wx:for` lists declare a `wx:key`, that every relative
`require` resolves, that the generated JS/JSON LUT manifests match, and that the main package
(including all LUT assets) stays below 2 MB.

## Real-device checklist

The following can only be verified on a physical phone (or in WeChat DevTools with a real device
debug session). None of them is covered by the headless harness.

1. **Preview** — pick a photo from the album and from the camera; the preview appears upright,
   letterboxed, within about a second on a mid-range phone.
2. **EXIF** — a photo taken in portrait (EXIF 6) and one with EXIF 8 are shown upright; see
   `docs/ORIENTATION.md` for the auto/manual decision.
3. **Preset cards** — all three category headers appear, all 11 cards are listed, and the
   selected card is highlighted.
4. **Thumbnails** — every card shows a fixed 16:9 centre crop of the current photo in that stock's
   look, with no black side/top bars and no aspect-ratio squeeze (including portrait and rotated
   photos); scrolling reveals the remaining thumbnails; the first card is ready almost immediately
   and the rest arrive within a second or two.
5. **Thumbnail fallback** — on a device where `wx.canvasToTempFilePath` rejects the offscreen
   canvas, the data-URL or PNG-file fallback must still produce a visible thumbnail; if all three
   fail, the coloured placeholder must appear instead of a broken image.
6. **Thumbnail invalidation** — choosing a second photo replaces every thumbnail with the new
   photo's look; the old thumbnails must not linger.
7. **Stock switching** — tapping a card updates the preview immediately and the highlight moves.
8. **Sliders** — 曝光 EV, 色温, 色调 and 强度 move the preview while the finger is down and stop
   cleanly when it is lifted; the readouts never lag noticeably behind the thumb.
9. **Extended cube** — dragging 曝光 EV above 0 shows 「正在载入扩展 LUT…」 at most once per stock
   and then updates the preview; highlights must not clip while the gain is applied.
10. **Reset** — 「重置」 restores every slider to its default and is disabled afterwards; the
    selected stock and the photo stay untouched.
11. **Press and hold** — holding the preview shows the untouched original, even with EV, white
    balance, contrast and saturation set to extreme values.
12. **About and diagnostics** — the 「关于」 section shows the spektrafilm credit, the project URL (tap to copy),
    the licence split (GPLv3 code / CC BY-SA 4.0 data), the version, and the note that the grain
    and the halation are approximations.
13. **Layout** — no horizontal scrolling, no clipped text, no layout jump when a thumbnail
    appears, and the action bar clears the home indicator on notched phones.
14. **Performance** — dragging a slider stays smooth on a low-end phone; the page must not
    re-render the preset list while a slider moves.
15. **Package size** — the built package reports a main package below 2 MB, including the LUT folder;
    the checker also reports the LUT folder's separate contribution.
16. **Effects panel** — 颗粒, 光晕 and 暗角 move the preview while the finger is down; the readouts
    follow; 「重置效果」 restores the three defaults; the global 「重置」 clears the adjustments and
    the effects together.
17. **Effect performance** — dragging an effect slider stays smooth on a low-end phone. The
    halation needs three extra passes (exposure, horizontal blur, vertical blur) and the grain
    evaluates three noise fields per pixel; both are skipped entirely at strength 0.
18. **Export** — 「保存到相册」 asks for the album permission (or explains it and opens the
    settings), renders the picture with the current look and writes a JPEG into the album. The
    progress text and the progress bar advance, 「取消」 stops the export, and the toast reports
    the result. The saved file has the original resolution (long edge 4096 px or the GPU limit)
    and looks like the preview.
19. **Export memory** — a 12 MP photo must not crash the app on a low-end phone; watch the
    memory peak and the time of the export.
20. **Share** — the app message and the timeline entries appear in the platform menu and open the
    index page.
