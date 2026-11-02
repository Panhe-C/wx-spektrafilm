// Unit tests for the shared spatial-effect model (utils/effects.js).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Effects = require('../utils/effects.js');

assert.deepEqual(Object.keys(Effects.EFFECT_DEFAULTS).sort(), ['grain', 'halation', 'vignette']);
assert.deepEqual(Effects.normalize(), { grain: 0, halation: 0, vignette: 0 });
assert.deepEqual(Effects.normalize({ grain: 1, halation: 0.5, vignette: 0.26 }),
  { grain: 1, halation: 0.5, vignette: 0.26 });

// Out-of-range values are clamped to the documented limits.
assert.deepEqual(Effects.normalize({ grain: 5, halation: -1, vignette: 3 }),
  { grain: 2, halation: 0, vignette: 1 });

// The steps are respected.
assert.equal(Effects.normalize({ grain: 0.37 }).grain, 0.35);
assert.equal(Effects.normalize({ halation: 0.44 }).halation, 0.45);
assert.equal(Effects.normalize({ vignette: 0.31 }).vignette, 0.32);

// A partial merge keeps the other values.
const merged = Effects.merge({ grain: 1, halation: 1, vignette: 0 }, { grain: 0.5 });
assert.deepEqual(merged, { grain: 0.5, halation: 1, vignette: 0 });
assert.throws(() => Effects.merge({}, { unknown: 1 }), /Unknown effect/);

assert.deepEqual(Effects.readouts({ grain: 1, halation: 0.5, vignette: 0 }),
  { grain: '100%', halation: '50%', vignette: '0%' });
assert.equal(Effects.isDefault({ grain: 0, halation: 0, vignette: 0 }), true);
assert.equal(Effects.isDefault({ grain: 0.01, halation: 0, vignette: 0 }), false);

// The frame constants: 35 mm of film for the long edge of the picture.
assert.equal(Effects.FRAME_WIDTH_UM, 35000);
assert.equal(Effects.REFERENCE_LONG_EDGE, 1280);
assert.ok(Math.abs(Effects.GRAIN_LATTICE_PX - 1.6) < 0.02,
  `unexpected grain lattice spacing ${Effects.GRAIN_LATTICE_PX}`);
assert.ok(Math.abs(Effects.GRAIN_LATTICE_FRAME * 1280 - Effects.GRAIN_LATTICE_PX) < 1e-6);

// The halation kernel: sigma_h * sqrt(11/7) scaled to the output resolution.
const sigma = Effects.halationSigmaPixels(65, 1280);
assert.ok(Math.abs(sigma - 65 * (1280 / 35000) * Math.sqrt(11 / 7)) < 1e-9);
assert.ok(sigma > 2.5 && sigma < 3.5, `unexpected halation sigma ${sigma}`);
// The cinema film has a smaller sigma_h.
assert.ok(Effects.halationSigmaPixels(50, 1280) < sigma);
// The margin covers three sigma.
assert.ok(Effects.halationMarginPixels(65, 1280) >= 3 * sigma);
assert.ok(Effects.halationMarginPixels(65, 4096) > Effects.halationMarginPixels(65, 1280));

// Every shipped stock has a complete entry.
const manifest = require('../subpackages/luts/luts.json');
for (const stock of manifest) {
  const entry = Effects.forStock(stock.id);
  assert.ok(entry, `missing effect entry for ${stock.id}`);
  assert.equal(entry.grain.curve.length, 17, `${stock.id}: grain curve length`);
  assert.equal(entry.grain.matrix.length, 9, `${stock.id}: grain matrix length`);
  assert.ok(entry.grain.curve.every((value) => Number.isFinite(value) && value >= 0));
  assert.ok(entry.grain.matrix.every((value) => Number.isFinite(value)));
  assert.ok(entry.halation.sigmaUm > 0);
  assert.equal(entry.halation.strength.length, 3);
  // The halation is red-dominant, like the physical presets.
  assert.ok(entry.halation.strength[0] > entry.halation.strength[1]);
  assert.ok(entry.halation.strength[1] >= entry.halation.strength[2]);
}

// The two anti-halation groups of the film profiles.
assert.deepEqual(Effects.forStock('portra400').halation.strength, [0.015, 0.005, 0]);
assert.deepEqual(Effects.forStock('gold200').halation.strength, [0.08, 0.02, 0]);
assert.equal(Effects.forStock('vision3_500t').halation.sigmaUm, 50);
assert.equal(Effects.forStock('portra400').halation.sigmaUm, 65);

console.log(
  'Effect model tests: PASS (defaults, ranges, steps, merge, readouts, frame constants, ' +
  'halation kernel, per-stock data)'
);
