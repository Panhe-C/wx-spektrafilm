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
| `film120` | 中画幅 | black medium-format frame with the same edge print (name, frame number, arrows) and no sprocket holes |

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
