import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  EXIF_ORIENTATION_MODE,
  decideExifOrientation,
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

console.log('EXIF orientation tests: PASS (16 auto cases, 16 overrides, 8 corner matrices, square edge case)');
