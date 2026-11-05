# Film borders (胶片边框)

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).

The 「边框」 tab of the editor adds a frame around the graded picture, in the live preview and in
the saved file. Everything is drawn on-device; there are no images, fonts, permissions or network
calls.

## Styles

| id | label | look |
|---|---|---|
| `none` (default) | 无边框 | no frame |
| `thin-white` | 细白边 | even white margin, 3.5 % of the short edge |
| `polaroid` | 拍立得 | off-white paper, 6 % margins and a 22 % bottom margin, hairline at the print edge |
| `black` | 黑边 | even black margin, 4 % of the short edge |
| `film35` | 35mm 胶片 | black film base with sprocket holes along both long edges (135 perforation proportions), an orange-yellow edge print with the **current preset's name** (capitals, plain text), the frame number (`12` / `12A`) and small frame arrows; the strip is vertical for a portrait photo |
| `film120` | 120 胶片 | a 120 roll film scanned with its rebate ("带片边扫描"): a thin, slightly irregular black film edge around the **uncropped** photo (any aspect ratio), inside a thin white scan margin; amber edge print with the preset name on the wide side, no sprocket holes |

### 120 胶片

Modelled on real full-rebate scans of 120 film (6×6 / 6×7 Portra and B&W scans from film labs):

* The photo is **never cropped**; the frame wraps it at its own aspect ratio. All widths are
  fractions of the photo's *short* side, so a 16:9 or 1:1 photo gets the same proportions.
* The black rebate is thin (about 0.7–1.4 % per side) and wider (3.4 %) on the side that carries
  the edge print: the long side of the film strip, i.e. **top for a landscape photo, left for a
  portrait or square one**. Around it is a white scan margin of about 1–3 %.
* The frame is slightly irregular: the four sides differ in width and the four outer corners are
  nudged by a fraction of a percent and rounded (so the strip is not quite parallel to the
  picture), with a faint orange light bleed along part of the outer edge. The irregularity is a
  **fixed pattern** (`mulberry32`, seed 9, in units of the photo), so the preview, the export and
  every device draw exactly the same frame; there is no randomness at draw time.
* Edge print: `STOCK NAME  ▸ 7  7A` in amber with the **current preset's name**. A stock whose
  name looks black-and-white (Tri-X, HP5, T-Max, Acros, … or `options.monochrome`) prints in light
  grey and gets a pale fringe. The Mini Program canvas has no condensed font, so a bold
  `sans-serif` is squeezed horizontally (×0.8); the name shrinks to fit 42 % of the strip. It
  reads left to right above a landscape photo and bottom to top on the left of a portrait one.
* The black strip is first painted as the four margin rectangles (the frame colour `#050505`,
  which is also what the preview's GL clear uses) and the white scan margin is then painted as the
  frame rectangle with the strip cut out. Nothing is painted inside the photo rectangle, so the
  graded pixels stay bit-identical.
* Not done on purpose: a soft feather on the inside edge of the black (that would paint on photo
  pixels and would need a post-tile pass in the export) and neighbouring frames of a strip.

The film styles use the real 135 geometry for a 3:2 picture (a 5.5 mm band on a 36 mm frame is
15.3 % of the long edge). The edge print contains the stock name as plain text and draws the
arrows as shapes; there are no logos or brand marks.

## Design

* **The border is composited after the film look.** The graded picture keeps its pixels (the
  browser test compares the photo region bit for bit with and without a border); the frame is not
  graded, grained, haloed or vignetted. The grain and vignette stay relative to the *photo*.
* **One layout, three consumers** — `utils/border.js`:
  * `computeLayout(style, photoW, photoH)` returns the margins, the outer size and the strip
    geometry. All margins are linear in the picture size, so a preview layout equals the export
    layout up to 1 px.
  * `drawBorder(ctx, layout, { stockName, frameNumber })` paints the frame with the Canvas 2D
    subset (`fillRect`, paths, `arcTo`, `fillText`, transforms) into a context whose unit is one
    picture pixel. It never paints inside the photo rectangle.
* **Preview.**
  * The renderer (`renderer.setFrame(style)`) fits the *framed* picture into the stage (and into
    the area above the bottom sheet), clears the margins with the frame colour using a scissored
    `gl.clear`, and renders the photo into the sub-rectangle left by the margins. There are no
    new shaders, textures or uploads, so the iOS black-texture history is not touched.
  * A transparent `<canvas type="2d">` above the preview (`#frameCanvas`, stage-sized,
    `pointer-events: none`) paints the decoration (sprocket holes, edge print, hairline) with
    the same `drawBorder`. It repaints only when the frame rectangle, the style or the preset
    name changes. If the overlay cannot be created the flat frame still shows.
* **Export.** `planExport({ border })` shrinks the photo just enough that the *framed* file fits
  the 4096 px long-edge budget (a photo smaller than that is never upscaled and keeps its size).
  The assembly 2D canvas has the framed size; the frame is painted first, then the tiles are
  blitted at `(left, top)`. `plan.width/height` remain the photo size, `plan.outerWidth/outerHeight`
  the file size and `plan.frame` the layout. Without a border nothing changes.
* **State.** The style is page state like the adjustments: it survives preset changes and new
  photos, 「重置」 in the 边框 sheet returns to 无边框, and it is passed to the export together
  with the stock name. It is not stored between launches (neither are the other edits).

## UI

The toolbar is 胶片 · 调整 · 效果 · 边框. 边框 opens a short bottom sheet with one horizontal row
of cards: a CSS miniature of each frame around the current photo (the selected preset's thumbnail),
laid out by the same `thumbnailGeometry()` math. The photo is re-fitted above the sheet exactly as
for the other sheets.

## Tests

```sh
cd harness
node test-border.mjs          # layout, export plan, preview rectangles, painter geometry
node test-border-browser.mjs  # real renderer + Canvas 2D in Chrome; writes harness/out/border/*.png
```

`BORDER_SAMPLES_DIR=/some/dir node test-border-browser.mjs` additionally copies the sample images
(`export-*` = the saved file, `preview-*` = the simulated live preview with the overlay) there.

## Real-device checks

1. The border preview aligns with the photo on iPhone and Android (no hairline gap, the sprocket
   holes touch the photo band edges), including with the bottom sheet open and after rotating.
2. The transparent 2D overlay does not block the press-and-hold compare gesture, the sheet taps
   or the scroll of the strip, and it does not flicker while a slider moves.
3. The saved file (JPEG, long edge ≤ 4096 px) has the frame on every side, correct for portrait and
   landscape, and the picture inside is identical to the one saved without a border. Check a
   12 MP photo for the export time and memory (the framed 2D canvas is up to 4096 px long).
4. Fonts: the edge print uses the system `sans-serif` bold; confirm it is legible and not clipped.
5. 120 胶片: the thin black edge hugs the photo with no white hairline between them (preview and
   saved file), the edge print stays inside the black band for landscape, portrait, square and a
   16:9 photo, and the white margin looks the same in the preview and in the saved file.
