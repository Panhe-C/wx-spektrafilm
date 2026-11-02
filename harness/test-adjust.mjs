import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adjust = require('../utils/adjust.js');

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

assert.deepEqual(adjust.normalize(), adjust.DEFAULTS);
assert.deepEqual(adjust.whiteBalance(0, 0).gain, [1, 1, 1]);
assert.deepEqual(adjust.linearGain({}), [1, 1, 1]);
assert.deepEqual(adjust.linearGain({ ev: 1 }), [2, 2, 2]);
assert.deepEqual(adjust.linearGain({ ev: 2 }, 2), [1, 1, 1]);
assert.deepEqual(adjust.normalize({ ev: 9, temperature: -200, tint: 200, contrast: 4, saturation: -1 }), {
  ev: 2, temperature: -100, tint: 100, contrast: 1, saturation: 0,
});
assert.throws(() => adjust.normalize({ ev: NaN }), /Non-finite/);
assert.deepEqual(adjust.merge({ ev: 1, contrast: 0.2 }, { tint: 20 }), {
  ev: 1, temperature: 0, tint: 20, contrast: 0.2, saturation: 1,
});
close(adjust.temperatureToCct(0), 6504);
close(adjust.temperatureToCct(100), 3000);
close(adjust.temperatureToCct(-100), 12000);

let previousCct = Infinity;
let previousRed = -Infinity;
let previousBlue = Infinity;
for (let temperature = -100; temperature <= 100; temperature += 1) {
  const cct = adjust.temperatureToCct(temperature);
  assert.ok(cct < previousCct, `CCT not monotonic at ${temperature}`);
  previousCct = cct;
  const { gain } = adjust.whiteBalance(temperature, 0);
  close(gain[0] * adjust.LUMA[0] + gain[1] * adjust.LUMA[1] + gain[2] * adjust.LUMA[2], 1);
  assert.ok(gain.every((value) => Number.isFinite(value) && value > 0));
  assert.ok(gain[0] >= previousRed - 1e-9, `red not monotonic at ${temperature}`);
  assert.ok(gain[2] <= previousBlue + 1e-9, `blue not monotonic at ${temperature}`);
  previousRed = gain[0];
  previousBlue = gain[2];
}

let previousGreen = Infinity;
for (let tint = -100; tint <= 100; tint += 1) {
  const { gain } = adjust.whiteBalance(0, tint);
  close(gain[0], gain[2]);
  close(gain[0] * adjust.LUMA[0] + gain[1] * adjust.LUMA[1] + gain[2] * adjust.LUMA[2], 1);
  assert.ok(gain[1] <= previousGreen + 1e-12);
  previousGreen = gain[1];
}
assert.ok(adjust.whiteBalance(0, 100).tintGreenGain < 1);
assert.ok(adjust.whiteBalance(0, -100).tintGreenGain > 1);

for (const temperature of [-100, -50, 0, 50, 100]) {
  for (const tint of [-100, -50, 0, 50, 100]) {
    const { gain } = adjust.whiteBalance(temperature, tint);
    close(gain[0] * adjust.LUMA[0] + gain[1] * adjust.LUMA[1] + gain[2] * adjust.LUMA[2], 1);
    const withExposure = adjust.linearGain({ ev: -2, temperature, tint });
    withExposure.forEach((value, index) => close(value, gain[index] * 0.25));
  }
}

console.log('Adjustment mapping tests: PASS (identity, ranges, merge, CCT, Bradford, tint, Y normalization)');
