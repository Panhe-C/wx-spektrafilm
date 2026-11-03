import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  EXIF_ORIENTATION_MODE,
  decideExifOrientation,
  drawOriented,
  orientationTransform,
  swapsDimensions,
} = require('../utils/photo.js');

const NAMES = [
  'up',
  'up-mirrored',
  'down',
  'down-mirrored',
  'left-mirrored',
  'right',
  'right-mirrored',
  'left',
];
const WIDTH = 40;
const HEIGHT = 20;
const CORNERS = [[0, 0], [WIDTH, 0], [WIDTH, HEIGHT], [0, HEIGHT]];
const EXPECTED_CORNERS = {
  up: [[0, 0], [40, 0], [40, 20], [0, 20]],
  'up-mirrored': [[40, 0], [0, 0], [0, 20], [40, 20]],
  down: [[40, 20], [0, 20], [0, 0], [40, 0]],
  'down-mirrored': [[0, 20], [40, 20], [40, 0], [0, 0]],
  'left-mirrored': [[0, 0], [0, 40], [20, 40], [20, 0]],
  right: [[20, 0], [20, 40], [0, 40], [0, 0]],
  'right-mirrored': [[20, 40], [20, 0], [0, 0], [0, 40]],
  left: [[0, 40], [0, 0], [20, 0], [20, 40]],
};

function decide(index, engineApplied, mode = 'auto') {
  const orientation = NAMES[index - 1];
  const swapped = swapsDimensions(orientation) && engineApplied;
  return decideExifOrientation({
    orientation,
    infoWidth: WIDTH,
    infoHeight: HEIGHT,
    decodedWidth: swapped ? HEIGHT : WIDTH,
    decodedHeight: swapped ? WIDTH : HEIGHT,
    mode,
  });
}

assert.equal(EXIF_ORIENTATION_MODE, 'auto');

// Every EXIF value, with an emulated raw decode and an engine-oriented decode.
// Auto detection is intentionally possible only for dimension-swapping 5-8.
for (let index = 1; index <= 8; index += 1) {
  const orientation = NAMES[index - 1];
  for (const engineApplied of [false, true]) {
    const decision = decide(index, engineApplied);
    const detected = engineApplied && swapsDimensions(orientation);
    assert.equal(decision.orientation, orientation);
    assert.equal(decision.sizeSwapDetected, detected, `size detection ${index}/${engineApplied}`);
    assert.equal(decision.engineApplied, detected, `engine decision ${index}/${engineApplied}`);
    assert.equal(
      decision.transformOrientation,
      detected ? 'up' : orientation,
      `effective transform ${index}/${engineApplied}`
    );
    assert.equal(
      decision.outputWidth,
      swapsDimensions(orientation) ? HEIGHT : WIDTH,
      `output width ${index}/${engineApplied}`
    );
    assert.equal(
      decision.outputHeight,
      swapsDimensions(orientation) ? WIDTH : HEIGHT,
      `output height ${index}/${engineApplied}`
    );
  }
}

// Explicit overrides ignore the heuristic in both directions.
for (let index = 1; index <= 8; index += 1) {
  const orientation = NAMES[index - 1];
  const manual = decide(index, true, 'manual');
  assert.equal(manual.engineApplied, false);
  assert.equal(manual.transformOrientation, orientation);
  const engine = decide(index, false, 'engine');
  assert.equal(engine.engineApplied, true);
  assert.equal(engine.transformOrientation, 'up');
  assert.equal(engine.outputWidth, WIDTH);
  assert.equal(engine.outputHeight, HEIGHT);
}

function applyMatrix(matrix, point) {
  const [a, b, c, d, e, f] = matrix;
  const [x, y] = point;
  return [a * x + c * y + e, b * x + d * y + f];
}

// Transform rectangle boundary corners in TL, TR, BR, BL order. This checks
// translation as well as rotation/mirroring, including the 5/7 transposes.
for (const orientation of NAMES) {
  const matrix = orientationTransform(orientation, WIDTH, HEIGHT);
  const actual = CORNERS.map((point) => applyMatrix(matrix, point));
  assert.deepEqual(actual, EXPECTED_CORNERS[orientation], `corner mapping ${orientation}`);
}

// A square cannot reveal an engine transform through its dimensions.
const square = decideExifOrientation({
  orientation: 'right',
  infoWidth: 20,
  infoHeight: 20,
  decodedWidth: 20,
  decodedHeight: 20,
  mode: 'auto',
});
assert.equal(square.sizeSwapDetected, false);
assert.equal(square.engineApplied, false);
assert.equal(square.transformOrientation, 'right');
assert.throws(() => decide(1, false, 'unknown'), /Unknown EXIF orientation mode/);

// --- the documented decision table ------------------------------------------
//
// The decoded Image is the geometry authority. getImageInfo only informs the
// EXIF decision, and the decision row is reported in the diagnostics.
function row(input) {
  return decideExifOrientation(Object.assign({ mode: 'auto' }, input));
}

{
  // A: raw landscape info + upright portrait Image -> the engine applied EXIF.
  const a = row({
    orientation: 'right', infoWidth: 400, infoHeight: 300,
    decodedWidth: 300, decodedHeight: 400,
  });
  assert.equal(a.decisionRow, 'A');
  assert.equal(a.engineApplied, true);
  assert.equal(a.transformOrientation, 'up');
  assert.equal(a.outputWidth, 300);
  assert.equal(a.outputHeight, 400);
  assert.equal(a.ambiguous, false);
}
{
  // B: matching raw landscape dimensions -> manual transform.
  const b = row({
    orientation: 'right', infoWidth: 400, infoHeight: 300,
    decodedWidth: 400, decodedHeight: 300,
  });
  assert.equal(b.decisionRow, 'B');
  assert.equal(b.engineApplied, false);
  assert.equal(b.transformOrientation, 'right');
  assert.equal(b.outputWidth, 300);
  assert.equal(b.outputHeight, 400);
}
{
  // C: upright portrait info + raw landscape Image -> manual transform.
  const c = row({
    orientation: 'right', infoWidth: 300, infoHeight: 400,
    decodedWidth: 400, decodedHeight: 300,
  });
  assert.equal(c.decisionRow, 'C');
  assert.equal(c.engineApplied, false);
  assert.equal(c.transformOrientation, 'right');
  assert.equal(c.outputWidth, 300);
  assert.equal(c.outputHeight, 400);
}
{
  // D: matching portrait dimensions -> preserve the decoded pixels; the
  // raw-portrait case is indistinguishable and therefore flagged ambiguous.
  const d = row({
    orientation: 'right', infoWidth: 300, infoHeight: 400,
    decodedWidth: 300, decodedHeight: 400,
  });
  assert.equal(d.decisionRow, 'D');
  assert.equal(d.engineApplied, true);
  assert.equal(d.transformOrientation, 'up');
  assert.equal(d.ambiguous, true);
  assert.equal(d.outputWidth, 300);
  assert.equal(d.outputHeight, 400);
}
{
  // UP: 'up' never rotates, even when the info dimensions disagree.
  const up = row({
    orientation: 'up', infoWidth: 400, infoHeight: 300,
    decodedWidth: 300, decodedHeight: 400,
  });
  assert.equal(up.decisionRow, 'UP');
  assert.equal(up.engineApplied, false);
  assert.equal(up.transformOrientation, 'up');
  assert.equal(up.outputWidth, 300);
  assert.equal(up.outputHeight, 400);
}
{
  // NON_SWAP: EXIF 2-4 cannot be detected from dimensions.
  const nonSwap = row({
    orientation: 'down', infoWidth: 400, infoHeight: 300,
    decodedWidth: 400, decodedHeight: 300,
  });
  assert.equal(nonSwap.decisionRow, 'NON_SWAP');
  assert.equal(nonSwap.engineApplied, false);
  assert.equal(nonSwap.ambiguous, true);
}
{
  // SQUARE and UNMATCHED stay manual and are flagged.
  const squareRow = row({
    orientation: 'right', infoWidth: 20, infoHeight: 20,
    decodedWidth: 20, decodedHeight: 20,
  });
  assert.equal(squareRow.decisionRow, 'SQUARE');
  assert.equal(squareRow.engineApplied, false);
  assert.equal(squareRow.ambiguous, true);
  const unmatched = row({
    orientation: 'right', infoWidth: 400, infoHeight: 300,
    decodedWidth: 400, decodedHeight: 400,
  });
  assert.equal(unmatched.decisionRow, 'UNMATCHED');
  assert.equal(unmatched.engineApplied, false);
  assert.equal(unmatched.ambiguous, true);
}
{
  // Explicit overrides still win, and the reason is reported.
  const manual = decideExifOrientation({
    orientation: 'right', infoWidth: 400, infoHeight: 300,
    decodedWidth: 300, decodedHeight: 400, mode: 'manual',
  });
  assert.equal(manual.decisionRow, 'MANUAL');
  assert.equal(manual.engineApplied, false);
  const engine = decideExifOrientation({
    orientation: 'right', infoWidth: 400, infoHeight: 300,
    decodedWidth: 400, decodedHeight: 300, mode: 'engine',
  });
  assert.equal(engine.decisionRow, 'ENGINE');
  assert.equal(engine.engineApplied, true);
  assert.equal(engine.transformOrientation, 'up');
}

// The suspect-decode retry redraws from the original Image with the same
// transform, and the caller can release that Image after the upload decision.
{
  const previousWx = globalThis.wx;
  const drawCalls = [];
  const image = { src: 'wxfile://photo.jpg', width: WIDTH, height: HEIGHT };
  const context = {
    imageSmoothingEnabled: true,
    setTransform() {},
    clearRect() {},
    drawImage(...args) {
      drawCalls.push(args);
    },
  };
  const output = {
    width: 0,
    height: 0,
    getContext: (type) => type === '2d' ? context : null,
  };
  globalThis.wx = { createOffscreenCanvas: () => output };
  try {
    const prepared = drawOriented({
      source: image,
      sourceWidth: WIDTH,
      sourceHeight: HEIGHT,
      decision: { transformOrientation: 'up' },
    }, { width: WIDTH, height: HEIGHT });
    assert.equal(drawCalls.length, 1);
    assert.strictEqual(drawCalls[0][0], image);
    assert.strictEqual(prepared.retryDecode(), output);
    assert.equal(drawCalls.length, 2);
    assert.strictEqual(drawCalls[1][0], image);
    assert.equal(image.src, 'wxfile://photo.jpg', 'Image stays alive for the retry');
    prepared.release();
    prepared.release();
    assert.equal(image.src, '');
    assert.throws(() => prepared.retryDecode(), /already been released/);
  } finally {
    if (previousWx === undefined) {
      delete globalThis.wx;
    } else {
      globalThis.wx = previousWx;
    }
  }
}

console.log('EXIF orientation tests: PASS (16 auto cases, 16 overrides, 8 corner matrices, square edge case, suspect-decode redraw/release)');
