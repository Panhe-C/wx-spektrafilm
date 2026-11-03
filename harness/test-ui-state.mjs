import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const ui = require('../utils/ui-state.js');
const thumbnail = require('../utils/thumbnail.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

// --- adjustment ranges, steps and defaults ---------------------------------

assert.deepEqual({ ...ui.ADJUSTMENT_DEFAULTS }, {
  ev: 0, temperature: 0, tint: 0, intensity: 1, contrast: 0, saturation: 1,
});
assert.deepEqual(ui.resetAdjustments(), { ...ui.ADJUSTMENT_DEFAULTS });
assert.equal(ui.isDefaultState(ui.ADJUSTMENT_DEFAULTS), true);

let state = ui.resetAdjustments();
state = ui.applyAdjustment(state, 'ev', 1.24);
close(state.ev, 1.2);
state = ui.applyAdjustment(state, 'ev', 9);
close(state.ev, 2);
state = ui.applyAdjustment(state, 'ev', -9);
close(state.ev, -2);
state = ui.applyAdjustment(state, 'temperature', 37.6);
close(state.temperature, 38);
state = ui.applyAdjustment(state, 'tint', -12.4);
close(state.tint, -12);
state = ui.applyAdjustment(state, 'intensity', 0.456);
close(state.intensity, 0.46);
state = ui.applyAdjustment(state, 'contrast', 0.333);
close(state.contrast, 0.33);
state = ui.applyAdjustment(state, 'saturation', 1.234);
close(state.saturation, 1.25);
state = ui.applyAdjustment(state, 'saturation', 5);
close(state.saturation, 2);
assert.equal(ui.isDefaultState(state), false);

const untouched = ui.resetAdjustments();
ui.applyAdjustment(untouched, 'ev', 1);
assert.equal(untouched.ev, 0, 'applyAdjustment must not mutate its input');

assert.throws(() => ui.applyAdjustment(state, 'unknown', 1), /Unknown adjustment/);
assert.throws(() => ui.applyAdjustment(state, 'ev', NaN), /Non-finite/);
assert.throws(() => ui.applyAdjustment(state, 'ev', 'abc'), /Non-finite/);

// Every slider value stays inside its documented range.
for (const key of ui.ADJUSTMENT_KEYS) {
  const limits = ui.ADJUSTMENT_LIMITS[key];
  for (const probe of [-1000, -3.7, -1, 0, 1, 3.7, 1000]) {
    const value = ui.applyAdjustment(ui.resetAdjustments(), key, probe)[key];
    assert.ok(value >= limits[0] && value <= limits[1], `${key}=${value} out of range`);
    const steps = Math.round((value - limits[0]) / ui.ADJUSTMENT_STEPS[key]);
    close(value, limits[0] + steps * ui.ADJUSTMENT_STEPS[key], 1e-6);
  }
}

// --- readouts --------------------------------------------------------------

const readoutState = {
  ev: 1.2, temperature: -38, tint: 0, intensity: 0.5, contrast: -0.25, saturation: 1.25,
};
assert.deepEqual(ui.readouts(readoutState), {
  ev: '+1.2 EV',
  temperature: '-38',
  tint: '0',
  intensity: '50%',
  contrast: '-0.25',
  saturation: '125%',
});
assert.deepEqual(ui.readouts(ui.ADJUSTMENT_DEFAULTS), {
  ev: '0.0 EV',
  temperature: '0',
  tint: '0',
  intensity: '100%',
  contrast: '0.00',
  saturation: '100%',
});

// --- extended-range LUT policy ---------------------------------------------

assert.equal(ui.needsExtendedLut({ ev: 0, temperature: 0, tint: 0 }), false);
assert.equal(ui.needsExtendedLut({ ev: -1, temperature: 0, tint: 0 }), false);
assert.equal(ui.needsExtendedLut({ ev: 0.1, temperature: 0, tint: 0 }), true);
assert.equal(ui.needsExtendedLut({ ev: 0, temperature: 1, tint: 0 }), true);
assert.equal(ui.needsExtendedLut({ ev: 0, temperature: 0, tint: -1 }), true);

// --- stock grouping --------------------------------------------------------

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'subpackages', 'luts', 'luts.json'), 'utf8')
);
const categories = ui.groupStocks(manifest);
assert.equal(categories.length, 3);
assert.deepEqual(categories.map((group) => group.title), [
  '彩色负片', '反转片（幻灯片）', '电影胶片',
]);
const grouped = categories.flatMap((group) => group.stocks);
assert.equal(grouped.length, manifest.length);
assert.equal(grouped.length, 11);
for (const stock of grouped) {
  assert.ok(stock.description && stock.description.length > 0, `${stock.id} has no description`);
  assert.ok(!stock.description.includes('\n'), `${stock.id} description is not one line`);
  assert.ok(stock.name && stock.iso, `${stock.id} is missing a name or ISO`);
  assert.equal(stock.thumb.status, 'idle');
  assert.equal(stock.thumb.src, '');
  assert.ok(/^hsl\(/.test(stock.thumb.color), `${stock.id} placeholder colour is invalid`);
}
const negative = categories[0].stocks.map((stock) => stock.id);
assert.deepEqual(negative, ['portra400', 'portra160', 'gold200', 'ultramax400', 'ektar100', 'pro400h']);
assert.deepEqual(
  categories[1].stocks.map((stock) => stock.id),
  ['velvia100', 'provia100f', 'kodachrome64']
);
assert.deepEqual(
  categories[2].stocks.map((stock) => stock.id),
  ['vision3_250d', 'vision3_500t']
);
assert.equal(ui.stockDescription({ id: 'unknown-stock' }).length > 0, true);
assert.equal(ui.placeholderColor('portra400'), ui.placeholderColor('portra400'));
assert.notEqual(ui.placeholderColor('portra400'), ui.placeholderColor('portra160'));

// --- thumbnail geometry and ordering ---------------------------------------

const landscape = thumbnail.thumbnailGeometry(1280, 854);
assert.equal(landscape.width, 96);
assert.equal(landscape.height, 54);
assert.equal(landscape.boxAspect, 16 / 9);
assert.equal(landscape.imageMode, 'aspectFill');
assert.deepEqual(landscape.imageUvOffset, [0, 67 / 854]);
assert.deepEqual(landscape.imageUvScale, [1, 720 / 854]);
assert.deepEqual(landscape.cropRect, { x: 0, y: 67, width: 1280, height: 720 });
const portrait = thumbnail.thumbnailGeometry(800, 1200);
assert.equal(portrait.width, 96);
assert.equal(portrait.height, 54);
assert.deepEqual(portrait.cropRect, { x: 0, y: 375, width: 800, height: 450 });
assert.deepEqual(portrait.imageUvOffset, [0, 375 / 1200]);
assert.deepEqual(portrait.imageUvScale, [1, 450 / 1200]);
const wide = thumbnail.thumbnailGeometry(2000, 500);
assert.ok(Math.abs(wide.cropRect.x - (2000 - 500 * 16 / 9) / 2) < 1e-9);
assert.ok(Math.abs(wide.cropRect.width - 500 * 16 / 9) < 1e-9);
assert.equal(wide.cropRect.y, 0);
assert.equal(wide.cropRect.height, 500);
const tiny = thumbnail.thumbnailGeometry(1, 1);
assert.equal(tiny.width, 96);
assert.equal(tiny.height, 54);
assert.throws(() => thumbnail.thumbnailGeometry(0, 100), /Invalid photo dimensions/);

const ids = manifest.map((stock) => stock.id);
const order = ui.thumbnailOrder(ids, 'ektar100', ['kodachrome64', 'ektar100']);
assert.equal(order[0], 'ektar100');
assert.equal(order[1], 'kodachrome64');
assert.equal(order.length, ids.length);
assert.equal(new Set(order).size, ids.length);
assert.deepEqual(order.slice().sort(), ids.slice().sort());
assert.deepEqual(ui.thumbnailOrder(ids, 'nope', []), ids);
assert.equal(ui.thumbnailOrder(ids, 'ektar100', ['ektar100', 'ektar100'])[0], 'ektar100');

// --- setData throttle policy -----------------------------------------------

assert.equal(ui.shouldEmit(1000, 0, 120), true);
assert.equal(ui.shouldEmit(1000, 900, 120), false);
assert.equal(ui.shouldEmit(1020, 900, 120), true);
assert.equal(ui.shouldEmit(1000, NaN, 120), true);
assert.ok(ui.READOUT_INTERVAL_MS >= 60, 'the readout throttle must not be chatty');

// --- phase machine ---------------------------------------------------------

assert.equal(ui.nextPhase('empty', 'pick'), 'decoding');
assert.equal(ui.nextPhase('decoding', 'decoded'), 'loading-luts');
assert.equal(ui.nextPhase('loading-luts', 'luts-ready'), 'ready');
assert.equal(ui.nextPhase('ready', 'pick'), 'decoding');
assert.equal(ui.nextPhase('decoding', 'failed'), 'error');
assert.equal(ui.nextPhase('error', 'pick'), 'decoding');
assert.equal(ui.nextPhase('ready', 'clear'), 'empty');
assert.throws(() => ui.nextPhase('empty', 'decoded'), /Invalid transition/);
assert.throws(() => ui.nextPhase('nope', 'pick'), /Unknown phase/);
assert.equal(ui.phaseText('decoding').length > 0, true);
assert.equal(ui.phaseText('ready'), '');
assert.equal(ui.isBusyPhase('decoding'), true);
assert.equal(ui.isBusyPhase('loading-luts'), true);
assert.equal(ui.isBusyPhase('ready'), false);

// --- the privacy popup ------------------------------------------------------

assert.deepEqual({ ...ui.PRIVACY_STATES }, {
  HIDDEN: 'hidden',
  NEED_CONSENT: 'need-consent',
  AGREED: 'agreed',
  REFUSED: 'refused',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
});
const hiddenPopup = ui.privacyPopupView({});
assert.equal(hiddenPopup.visible, false);
assert.equal(hiddenPopup.state, ui.PRIVACY_STATES.HIDDEN);
assert.equal(hiddenPopup.agreeText, '同意');
assert.equal(hiddenPopup.refuseText, '拒绝');
assert.ok(hiddenPopup.body.length > 0);
assert.ok(hiddenPopup.title.length > 0);
const shownPopup = ui.privacyPopupView({
  visible: true,
  state: ui.PRIVACY_STATES.NEED_CONSENT,
  name: '《测试隐私保护指引》',
  note: '隐私状态读取失败',
});
assert.equal(shownPopup.visible, true);
assert.equal(shownPopup.state, ui.PRIVACY_STATES.NEED_CONSENT);
assert.equal(shownPopup.name, '《测试隐私保护指引》');
assert.equal(shownPopup.note, '隐私状态读取失败');
// The state alone is enough to show the popup.
assert.equal(ui.privacyPopupView({ state: ui.PRIVACY_STATES.NEED_CONSENT }).visible, true);

// --- the export status ------------------------------------------------------

assert.equal(ui.exportStatusText(ui.EXPORT_STATUS.RUNNING, { text: '渲染 1/2…' }), '渲染 1/2…');
assert.equal(ui.exportStatusText(ui.EXPORT_STATUS.RUNNING), '导出中…');
assert.equal(ui.exportStatusText(ui.EXPORT_STATUS.DONE), '已保存到相册');
assert.equal(ui.exportStatusText(ui.EXPORT_STATUS.CANCELLED), '已取消保存。');
assert.equal(ui.exportStatusText(ui.EXPORT_STATUS.TIMEOUT, { message: '保存超时' }), '保存超时');
assert.equal(ui.exportStatusText(ui.EXPORT_STATUS.TIMEOUT), '导出超时，请重试。');
assert.equal(ui.exportStatusText(ui.EXPORT_STATUS.FAILED, { message: '没有相册权限' }), '没有相册权限');
assert.equal(ui.exportStatusText(ui.EXPORT_STATUS.FAILED), '保存失败，请重试。');
assert.equal(ui.exportStatusText(ui.EXPORT_STATUS.IDLE), '');
assert.deepEqual(ui.exportActions(ui.EXPORT_STATUS.RUNNING), {
  retry: false,
  openSetting: false,
  cancel: true,
});
assert.deepEqual(ui.exportActions(ui.EXPORT_STATUS.TIMEOUT), {
  retry: true,
  openSetting: true,
  cancel: false,
});
assert.deepEqual(ui.exportActions(ui.EXPORT_STATUS.DONE), {
  retry: false,
  openSetting: false,
  cancel: false,
});

// --- PNG fallback encoder --------------------------------------------------

const pixels = new Uint8Array(4 * 3 * 4);
for (let index = 0; index < pixels.length; index += 1) {
  pixels[index] = (index * 7) % 256;
}
const png = Buffer.from(thumbnail.encodePng(pixels, 4, 3));
assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
const idat = [];
let cursor = 8;
let width = 0;
let height = 0;
while (cursor < png.length) {
  const length = png.readUInt32BE(cursor);
  const type = png.toString('ascii', cursor + 4, cursor + 8);
  const data = png.subarray(cursor + 8, cursor + 8 + length);
  if (type === 'IHDR') {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    assert.equal(data[8], 8);
    assert.equal(data[9], 6);
  }
  if (type === 'IDAT') {
    idat.push(Buffer.from(data));
  }
  cursor += 12 + length;
}
assert.equal(width, 4);
assert.equal(height, 3);
const raw = zlib.inflateSync(Buffer.concat(idat));
assert.equal(raw.length, height * (1 + width * 4));
for (let row = 0; row < height; row += 1) {
  assert.equal(raw[row * (1 + width * 4)], 0, 'every scanline uses filter 0');
  const expected = pixels.subarray(row * width * 4, (row + 1) * width * 4);
  const actual = raw.subarray(row * (1 + width * 4) + 1, row * (1 + width * 4) + 1 + width * 4);
  assert.deepEqual(Array.from(actual), Array.from(expected));
}

// --- base64 ----------------------------------------------------------------

for (const sample of [[], [0], [1, 2], [1, 2, 3], [255, 254, 253, 0]]) {
  const encoded = thumbnail.toBase64(new Uint8Array(sample));
  assert.equal(encoded, Buffer.from(sample).toString('base64'), `base64 mismatch for ${sample}`);
}
assert.equal(thumbnail.toBase64(new Uint8Array([77, 97, 110])), 'TWFu');

console.log(
  'UI state tests: PASS (adjustment ranges/steps, readouts, grouping, thumbnail policy, ' +
  'throttle, phase machine, privacy popup, export status, PNG fallback)'
);
