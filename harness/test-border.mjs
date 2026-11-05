// Unit tests of the film border: layout math, the painter's geometry (with a
// recording 2D context), the export plan and the preview rectangles. The real
// pixels are checked in harness/test-border-browser.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Border = require('../utils/border.js');
const Export = require('../utils/export.js');
const Renderer = require('../utils/lut-renderer.js');

// --- the catalogue ----------------------------------------------------------

assert.deepEqual(Border.STYLE_IDS, ['none', 'thin-white', 'polaroid', 'black', 'film35', 'film120']);
assert.equal(Border.STYLES[0].name, '无边框', 'the default is "no border"');
assert.equal(Border.normalizeStyle('film35'), 'film35');
assert.equal(Border.normalizeStyle('bogus'), 'none');
assert.equal(Border.normalizeStyle(undefined), 'none');
assert.equal(Border.styleName('polaroid'), '拍立得');

// --- the layout --------------------------------------------------------------

const ASPECTS = [[4032, 3024], [3024, 4032], [3000, 2000], [2000, 3000], [3000, 3000], [4000, 1200], [1200, 4000], [64, 48]];
for (const id of Border.STYLE_IDS) {
  for (const [w, h] of ASPECTS) {
    const layout = Border.computeLayout(id, w, h);
    assert.equal(layout.outerW, w + layout.left + layout.right, `${id} ${w}x${h} outer width`);
    assert.equal(layout.outerH, h + layout.top + layout.bottom, `${id} ${w}x${h} outer height`);
    assert.ok([layout.left, layout.right, layout.top, layout.bottom].every(Number.isInteger));
    assert.ok([layout.left, layout.right, layout.top, layout.bottom].every((m) => m >= 0));
    if (id === 'none') {
      assert.equal(layout.outerW, w);
      assert.equal(layout.outerH, h);
    } else {
      assert.ok(layout.left > 0 && layout.top > 0 && layout.right > 0 && layout.bottom > 0);
    }
  }
}
assert.throws(() => Border.computeLayout('black', 0, 100));
assert.throws(() => Border.computeLayout('black', 100, NaN));

// Symmetry and character of each style.
{
  const thin = Border.computeLayout('thin-white', 4032, 3024);
  assert.equal(thin.color, '#ffffff');
  assert.ok(thin.left === thin.right && thin.top === thin.bottom && thin.left === thin.top);
  const polaroid = Border.computeLayout('polaroid', 4032, 3024);
  assert.ok(polaroid.bottom > polaroid.top * 2.5, 'the Polaroid bottom margin is the larger one');
  assert.equal(polaroid.left, polaroid.right);
  // The Polaroid margin follows the SHORT edge, so portrait and landscape agree.
  const portrait = Border.computeLayout('polaroid', 3024, 4032);
  assert.equal(portrait.bottom, polaroid.bottom);
  assert.equal(portrait.left, polaroid.left);
  const black = Border.computeLayout('black', 3000, 2000);
  assert.equal(black.color, '#000000');
}

// The film strip runs along the long edge: a landscape picture gets bands on
// top and bottom, a portrait one on the left and right.
{
  const landscape = Border.computeLayout('film35', 3000, 2000);
  assert.equal(landscape.orientation, 'horizontal');
  assert.equal(landscape.top, landscape.band);
  assert.equal(landscape.bottom, landscape.band);
  assert.equal(landscape.left, landscape.side);
  assert.ok(landscape.band > landscape.side * 4);
  // A 3:2 picture gets the real 135 proportions: a 5.5 mm band on a 36 mm frame.
  assert.ok(Math.abs(landscape.band / landscape.photoW - 5.5 / 36) < 0.002);
  const portrait = Border.computeLayout('film35', 2000, 3000);
  assert.equal(portrait.orientation, 'vertical');
  assert.equal(portrait.left, portrait.band);
  assert.equal(portrait.right, portrait.band);
  assert.equal(portrait.top, portrait.side);
  assert.equal(portrait.band, landscape.band, 'the band does not depend on the orientation');
  // A panorama does not get an absurdly thick band.
  const panorama = Border.computeLayout('film35', 6000, 1000);
  assert.ok(panorama.band <= 1000 * 0.153 * 1.5 + 1);
}

// --- 120 film: a thin, irregular black edge around the UNCROPPED photo -------

{
  assert.equal(Border.styleName('film120'), '120 胶片');
  for (const [w, h] of [[3000, 2000], [2000, 3000], [2000, 2000], [1600, 900], [900, 1600], [6000, 1000], [1000, 6000]]) {
    const layout = Border.computeLayout('film120', w, h);
    const short = Math.min(w, h);
    // No crop: the picture keeps its own size and aspect ratio.
    assert.equal(layout.photoW, w);
    assert.equal(layout.photoH, h);
    assert.equal(layout.outerW, w + layout.left + layout.right);
    assert.equal(layout.outerH, h + layout.top + layout.bottom);
    // Thin: even the print side plus the white scan margin stays below 7 % of the short side.
    for (const key of ['left', 'top', 'right', 'bottom']) {
      assert.ok(layout[key] / short < 0.07, `${w}x${h} ${key} is thin`);
      assert.ok(layout[key] >= 1);
    }
    // The print side is the long side of the strip: top for landscape, left for portrait and square.
    const side = w > h ? 'top' : 'left';
    assert.equal(layout.film.print, side);
    const others = ['left', 'top', 'right', 'bottom'].filter((key) => key !== side);
    others.forEach((key) => {
      assert.ok(layout.film.black[side] > layout.film.black[key] * 1.8, `${w}x${h}: the ${side} band is the wide one`);
    });
    // The rebate is irregular: no two sides share a width and the corners are nudged.
    const widths = ['left', 'top', 'right', 'bottom'].map((key) => layout.film.black[key]);
    assert.equal(new Set(widths.map((v) => v.toFixed(3))).size, 4);
    assert.ok(layout.film.corners.some(([x, y]) => x !== 0 || y !== 0));
    // The nudge never eats the thinnest rebate.
    const jitter = Math.max(...layout.film.corners.flat().map(Math.abs));
    assert.ok(jitter < Math.min(...widths), `${w}x${h}: the corner nudge stays inside the rebate`);
    // Deterministic: the same call, the same frame.
    assert.deepEqual(Border.computeLayout('film120', w, h), layout);
  }
  // The irregularity is a fixed pattern in units of the photo: the preview matches the export.
  const big = Border.computeLayout('film120', 4000, 3000);
  const small = Border.computeLayout('film120', 1000, 750);
  for (const key of ['left', 'top', 'right', 'bottom']) {
    assert.ok(Math.abs(big.film.black[key] / 4 - small.film.black[key]) < 1e-9);
    assert.ok(Math.abs(big.film.white[key] / 4 - small.film.white[key]) < 1e-9);
  }
  assert.ok(Border.isMonochrome('Ilford HP5 Plus'));
  assert.ok(Border.isMonochrome('Kodak Tri-X 400'));
  assert.ok(Border.isMonochrome('黑白'));
  assert.ok(!Border.isMonochrome('Kodak Portra 400'));
  assert.ok(!Border.isMonochrome(''));
}

// A layout scales linearly with the picture, so the preview layout is the
// export layout divided by one constant (up to rounding of 1 px per margin).
for (const id of Border.STYLE_IDS) {
  const big = Border.computeLayout(id, 4000, 3000);
  const small = Border.computeLayout(id, 1000, 750);
  for (const key of ['left', 'top', 'right', 'bottom']) {
    assert.ok(Math.abs(big[key] / 4 - small[key]) <= 1, `${id} ${key} scales linearly`);
  }
}

// --- the export frame fits the budget ---------------------------------------

for (const id of Border.STYLE_IDS) {
  for (const [w, h] of [[4096, 3072], [3072, 4096], [4096, 4096], [4096, 1024], [1024, 4096]]) {
    const plan = Export.planExport({
      sourceWidth: w,
      sourceHeight: h,
      maxTextureSize: 4096,
      tileSize: 1024,
      stockId: 'portra400',
      halationStrength: 1,
      border: id,
    });
    assert.ok(Math.max(plan.outerWidth, plan.outerHeight) <= 4096, `${id} ${w}x${h} fits 4096`);
    assert.equal(plan.outerWidth, plan.width + plan.frame.left + plan.frame.right);
    assert.equal(plan.outerHeight, plan.height + plan.frame.top + plan.frame.bottom);
    assert.equal(plan.frame.photoW, plan.width);
    assert.equal(plan.frame.photoH, plan.height);
    // The aspect of the picture is kept.
    assert.ok(Math.abs(plan.width / plan.height - w / h) / (w / h) < 0.002, `${id} keeps the aspect`);
    // The tiles still cover the picture exactly.
    const area = plan.tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0);
    assert.equal(area, plan.width * plan.height);
    if (id === 'none') {
      assert.equal(plan.width, Math.min(w, 4096));
      assert.equal(plan.outerWidth, plan.width);
    } else {
      // The picture is shrunk only as much as the budget demands.
      const ratio = Math.max(plan.outerWidth, plan.outerHeight) / Math.max(plan.width, plan.height);
      assert.ok(Math.max(plan.width, plan.height) >= Math.floor(4096 / ratio) - 4);
    }
  }
}
{
  // A small source is never upscaled: the frame goes AROUND the full picture.
  const plan = Export.planExport({
    sourceWidth: 1600, sourceHeight: 1067, maxTextureSize: 4096, stockId: 'portra400',
    halationStrength: 0, border: 'film35',
  });
  assert.equal(plan.width, 1600);
  assert.equal(plan.height, 1067);
  assert.ok(plan.outerWidth > 1600);
  // No border: planExport is what it always was.
  const plain = Export.planExport({
    sourceWidth: 3000, sourceHeight: 2000, maxTextureSize: 4096, stockId: 'portra400',
    halationStrength: 0,
  });
  assert.equal(plain.frame.style, 'none');
  assert.equal(plain.outerWidth, 3000);
  assert.equal(plain.outerHeight, 2000);
  // The GPU limit of the photo still applies.
  const limited = Export.planExport({
    sourceWidth: 6000, sourceHeight: 4000, maxTextureSize: 2048, stockId: 'portra400',
    halationStrength: 0, border: 'black',
  });
  assert.ok(Math.max(limited.width, limited.height) <= 2048);
}

// --- the preview rectangles ---------------------------------------------------

for (const id of Border.STYLE_IDS) {
  for (const [w, h] of [[1280, 853], [853, 1280], [1000, 1000]]) {
    for (const inset of [{ bottom: 0 }, { bottom: 300 }]) {
      const layout = Border.computeLayout(id, w, h);
      const { outer, photo } = Renderer.computeFramedRects(750, 1400, layout, inset);
      assert.ok(outer.x >= 0 && outer.y >= inset.bottom - 1);
      assert.ok(outer.x + outer.width <= 750 && outer.y + outer.height <= 1400);
      assert.ok(photo.x >= outer.x && photo.y >= outer.y);
      assert.ok(photo.x + photo.width <= outer.x + outer.width);
      assert.ok(photo.y + photo.height <= outer.y + outer.height);
      // The framed picture keeps its aspect and fills the visible area on one axis.
      assert.ok(
        Math.abs(outer.width / outer.height - layout.outerW / layout.outerH) < 0.01,
        `${id}: the framed aspect`
      );
      // The photo keeps its aspect inside the frame (rounding: 1.5 %).
      assert.ok(
        Math.abs(photo.width / photo.height - w / h) / (w / h) < 0.015,
        `${id} ${w}x${h}: the photo aspect inside the frame (${photo.width}x${photo.height})`
      );
      if (id === 'none') {
        assert.deepEqual(photo, outer);
      }
    }
  }
}

// --- the painter ----------------------------------------------------------------

function recordingContext() {
  const calls = [];
  const stack = [];
  let matrix = [1, 0, 0, 1, 0, 0];
  const multiply = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const apply = (x, y) => [
    matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5],
  ];
  let path = [];
  const api = {
    calls,
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    lineWidth: 1,
    strokeStyle: '',
    save() { stack.push({
        matrix: matrix.slice(),
        state: {
          fillStyle: api.fillStyle, font: api.font, textAlign: api.textAlign,
          textBaseline: api.textBaseline, lineWidth: api.lineWidth, strokeStyle: api.strokeStyle,
        },
      }); },
    restore() {
      const entry = stack.pop();
      matrix = entry.matrix;
      Object.assign(api, entry.state);
    },
    translate(x, y) { matrix = multiply(matrix, [1, 0, 0, 1, x, y]); },
    scale(x, y) { matrix = multiply(matrix, [x, 0, 0, y, 0, 0]); },
    rotate(angle) {
      matrix = multiply(matrix, [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]);
    },
    fillRect(x, y, width, height) {
      calls.push({ op: 'fillRect', fill: api.fillStyle, corners: [apply(x, y), apply(x + width, y + height)] });
    },
    strokeRect(x, y, width, height) {
      calls.push({ op: 'strokeRect', corners: [apply(x, y), apply(x + width, y + height)] });
    },
    beginPath() { path = []; },
    moveTo(x, y) { path.push(apply(x, y)); },
    lineTo(x, y) { path.push(apply(x, y)); },
    arcTo(x1, y1, x2, y2) { path.push(apply(x1, y1), apply(x2, y2)); },
    closePath() {},
    fill() { calls.push({ op: 'fill', fill: api.fillStyle, points: path.slice() }); },
    measureText(text) { return { width: text.length * parseFloat(/(\d+(\.\d+)?)px/.exec(api.font)[1]) * 0.6 }; },
    fillText(text, x, y) {
      calls.push({
        op: 'fillText', text, point: apply(x, y), fill: api.fillStyle, font: api.font,
        align: api.textAlign,
      });
    },
  };
  return api;
}

function paint(id, w, h, options) {
  const layout = Border.computeLayout(id, w, h);
  const context = recordingContext();
  Border.drawBorder(context, layout, options || { stockName: 'Kodak Portra 400' });
  return { layout, context };
}

function insidePhoto(layout, point) {
  return point[0] > layout.left + 0.5 && point[0] < layout.left + layout.photoW - 0.5 &&
    point[1] > layout.top + 0.5 && point[1] < layout.top + layout.photoH - 0.5;
}

for (const id of Border.STYLE_IDS) {
  for (const [w, h] of [[3000, 2000], [2000, 3000], [2000, 2000], [900, 1600]]) {
    const { layout, context } = paint(id, w, h);
    if (id === 'none') {
      assert.equal(context.calls.length, 0, 'no border draws nothing');
      continue;
    }
    // No painted point may fall inside the photo, and everything stays inside
    // the outer rectangle.
    context.calls.forEach((call) => {
      const points = call.corners || call.points || [call.point];
      points.forEach((point) => {
        assert.ok(
          point[0] >= -0.5 && point[0] <= layout.outerW + 0.5 &&
          point[1] >= -0.5 && point[1] <= layout.outerH + 0.5,
          `${id} ${w}x${h}: ${call.op} leaves the frame at ${point}`
        );
      });
      if (call.op === 'fillRect') {
        // A rectangle may touch the photo only along its edge.
        const [a, b] = call.corners;
        const overlapW = Math.min(b[0], layout.left + layout.photoW) - Math.max(a[0], layout.left);
        const overlapH = Math.min(b[1], layout.top + layout.photoH) - Math.max(a[1], layout.top);
        assert.ok(!(overlapW > 0.5 && overlapH > 0.5), `${id} ${w}x${h}: a margin rectangle overlaps the photo`);
      }
      if (call.op === 'fill') {
        call.points.forEach((point) => {
          assert.ok(!insidePhoto(layout, point), `${id} ${w}x${h}: a shape reaches into the photo`);
        });
      }
      if (call.op === 'fillText') {
        assert.ok(!insidePhoto(layout, call.point), `${id}: text inside the photo`);
      }
    });
    // The four margin rectangles tile the frame: their area is outer - photo.
    const rects = context.calls.filter((call) => call.op === 'fillRect' && call.fill === layout.color);
    assert.equal(rects.length, 4);
    const area = rects.reduce((sum, call) => {
      const [a, b] = call.corners;
      return sum + Math.abs((b[0] - a[0]) * (b[1] - a[1]));
    }, 0);
    assert.equal(area, layout.outerW * layout.outerH - layout.photoW * layout.photoH, `${id}: margin area`);
  }
}

// The film edge: stock name, frame numbers and the arrows are plain text.
{
  const { layout, context } = paint('film35', 3000, 2000, { stockName: 'Kodak Portra 400', frameNumber: 7 });
  const texts = context.calls.filter((call) => call.op === 'fillText');
  assert.ok(texts.some((call) => call.text === 'KODAK PORTRA 400'), 'the stock name is printed in capitals');
  assert.ok(texts.some((call) => call.text === '7'));
  assert.ok(texts.some((call) => call.text === '7A'));
  assert.ok(texts.every((call) => call.fill === Border.EDGE_PRINT_COLOR), 'orange-yellow edge print');
  // Landscape: the print sits in the bands (above and below the photo).
  texts.forEach((call) => {
    assert.ok(call.point[1] < layout.top || call.point[1] > layout.top + layout.photoH);
  });
  const holes = context.calls.filter((call) => call.op === 'fill' && call.fill === Border.SPROCKET_COLOR);
  assert.ok(holes.length >= 14 && holes.length % 2 === 0, `sprocket holes on both edges (${holes.length})`);
  // Holes are inside the bands and clear of the photo.
  holes.forEach((hole) => {
    const ys = hole.points.map((point) => point[1]);
    assert.ok(Math.max(...ys) < layout.top || Math.min(...ys) > layout.top + layout.photoH);
  });
  // The arrows are filled triangles in the edge print colour, not glyphs.
  const arrows = context.calls.filter((call) => call.op === 'fill' && call.fill === Border.EDGE_PRINT_COLOR);
  assert.ok(arrows.length >= 2);
  // The holes keep the 135 pitch: 8 holes for every 36 mm frame, about.
  const perEdge = holes.length / 2;
  assert.ok(Math.abs(perEdge - layout.outerW / (layout.band * 0.864)) < 2);
}
{
  // A portrait picture rotates the strip: the print runs vertically, in the
  // bands left and right of the photo.
  const { layout, context } = paint('film35', 2000, 3000);
  const texts = context.calls.filter((call) => call.op === 'fillText');
  assert.ok(texts.length >= 3);
  texts.forEach((call) => {
    assert.ok(call.point[0] < layout.left || call.point[0] > layout.left + layout.photoW);
  });
  // Stock name missing: only numbers and arrows.
  const bare = paint('film35', 3000, 2000, {});
  assert.ok(!bare.context.calls.some((call) => call.op === 'fillText' && /[A-Z]{3}/.test(call.text)));
  // A long name is shrunk to fit and never overflows the photo width.
  const long = paint('film35', 3000, 2000, { stockName: 'A very long film stock name that cannot fit the band at all, really' });
  const name = long.context.calls.find((call) => call.op === 'fillText' && call.text.length > 20);
  const size = parseFloat(/(\d+(\.\d+)?)px/.exec(name.font)[1]);
  assert.ok(name.text.length * size * 0.6 <= long.layout.photoW * 0.62 + 1);
}
{
  const landscape = paint('film120', 3000, 2000, { stockName: 'Kodak Portra 400' });
  const { layout, context } = landscape;
  assert.ok(!context.calls.some((call) => call.op === 'fill' && call.fill === Border.SPROCKET_COLOR),
    'medium format has no sprocket holes');
  // The white scan margin: the frame rectangle with the black strip cut out.
  const margin = context.calls.filter((call) => call.op === 'fill' && call.fill === Border.SCAN_MARGIN_COLOR);
  assert.equal(margin.length, 1);
  assert.ok(margin[0].points.length >= 8, 'the margin path has an outer rectangle and a hole');
  const black = context.calls.filter((call) => call.op === 'fillRect' && call.fill === layout.color);
  assert.equal(black.length, 4, 'the rebate is first painted as four rectangles around the photo');
  // The edge print: capitals, in the band above a landscape photo, left to right.
  const texts = context.calls.filter((call) => call.op === 'fillText');
  assert.deepEqual(texts.map((call) => call.text), ['KODAK PORTRA 400', '7', '7A']);
  assert.ok(texts.every((call) => call.fill === Border.EDGE_PRINT_COLOR));
  texts.forEach((call) => {
    assert.ok(call.point[1] < layout.top, 'the print sits in the top band');
    assert.ok(call.point[1] > layout.top - layout.film.black.top, 'and inside the black');
  });
  assert.ok(texts[0].point[0] < texts[1].point[0] && texts[1].point[0] < texts[2].point[0]);
  // The slight orange light bleed is plain filled slivers in the band.
  const fringe = context.calls.filter((call) => call.op === 'fill' && /255, 140, 50/.test(call.fill));
  assert.ok(fringe.length >= 3);
  // A black-and-white stock prints light grey, not amber.
  const mono = paint('film120', 3000, 2000, { stockName: 'Kodak Tri-X 400' });
  const monoTexts = mono.context.calls.filter((call) => call.op === 'fillText');
  assert.ok(monoTexts.length === 3 && monoTexts.every((call) => call.fill === Border.MONO_PRINT_COLOR));
  assert.ok(mono.context.calls.some((call) => call.op === 'fill' && call.fill === 'rgba(255, 255, 255, 0.2)'));
  // The explicit flag wins over the guess.
  const forced = paint('film120', 3000, 2000, { stockName: 'Kodak Portra 400', monochrome: true });
  assert.ok(forced.context.calls.filter((call) => call.op === 'fillText').every((call) => call.fill === Border.MONO_PRINT_COLOR));
  // The print is squeezed horizontally: the baseline is rotated for portrait, the glyphs never leave the band.
  const portrait = paint('film120', 2000, 3000, { stockName: 'Kodak Portra 400' });
  const portraitTexts = portrait.context.calls.filter((call) => call.op === 'fillText');
  assert.equal(portraitTexts.length, 3);
  portraitTexts.forEach((call) => {
    assert.ok(call.point[0] < portrait.layout.left && call.point[0] > portrait.layout.left - portrait.layout.film.black.left);
  });
  // It reads bottom to top: the name starts below the numbers.
  assert.ok(portraitTexts[0].point[1] > portraitTexts[1].point[1] && portraitTexts[1].point[1] > portraitTexts[2].point[1]);
  // A square picture prints on the left like a portrait one.
  const square = paint('film120', 2000, 2000, { stockName: 'Kodak Portra 400' });
  assert.ok(square.context.calls.filter((call) => call.op === 'fillText').every((call) => call.point[0] < square.layout.left));
  // An overlong name is shrunk, not cut.
  const long = paint('film120', 3000, 2000, { stockName: 'An extremely long film stock name that would never fit the strip' });
  const longName = long.context.calls.find((call) => call.op === 'fillText' && call.text.length > 20);
  const size = parseFloat(/(\d+(\.\d+)?)px/.exec(longName.font)[1]);
  assert.ok(longName.text.length * size * 0.6 * 0.8 <= long.layout.photoW * 0.42 + 1);
  // Without a name only the numbers are printed.
  assert.deepEqual(paint('film120', 3000, 2000, {}).context.calls.filter((call) => call.op === 'fillText').map((call) => call.text), ['7', '7A']);
  const polaroid = paint('polaroid', 3000, 2000);
  assert.ok(polaroid.context.calls.some((call) => call.op === 'strokeRect'));
}

// --- the picker miniatures -------------------------------------------------

for (const id of Border.STYLE_IDS) {
  const geometry = Border.thumbnailGeometry(id, 300, 200);
  assert.ok(geometry.left >= 0 && geometry.left + geometry.right < 1);
  assert.ok(geometry.top >= 0 && geometry.top + geometry.bottom < 1);
  assert.ok(geometry.aspect > 0.5 && geometry.aspect < 2);
}

console.log(
  'Border tests: PASS (catalogue, layout for portrait/landscape/square/panorama, linear scaling, ' +
  'export plan within 4096 px, preview rectangles, painter geometry, film edge print, miniatures)'
);
