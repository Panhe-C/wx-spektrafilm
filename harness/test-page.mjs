import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// --- minimal WeChat host ----------------------------------------------------

let registered = null;
globalThis.Page = (definition) => {
  registered = definition;
};
globalThis.wx = {
  getSystemInfoSync: () => ({ pixelRatio: 2 }),
  getImageInfo: () => {},
  showToast: () => {},
  setClipboardData: () => {},
  createSelectorQuery: () => ({
    select: () => ({
      fields: () => ({ exec: (callback) => callback([]) }),
      boundingClientRect: () => ({ exec: (callback) => callback([]) }),
    }),
  }),
  loadSubpackage: () => {},
  // The offscreen canvas stub cannot export pixels, so the thumbnail path
  // exercises its documented placeholder fallback.
  createOffscreenCanvas: () => ({}),
  createIntersectionObserver: () => ({}),
};

require('../pages/index/index.js');
assert.ok(registered, 'pages/index/index.js must register a Page');
const definition = registered;

// --- a tiny setData host ----------------------------------------------------

function applyPath(target, pathExpression, value) {
  const keys = [];
  pathExpression.replace(/[^.[\]]+/g, (key) => {
    keys.push(key);
    return key;
  });
  let node = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (node[key] === undefined || node[key] === null) {
      node[key] = {};
    }
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function createInstance() {
  const instance = Object.assign({}, definition);
  instance.data = JSON.parse(JSON.stringify(definition.data));
  instance.setData = (patch, callback) => {
    Object.keys(patch).forEach((key) => applyPath(instance.data, key, patch[key]));
    if (callback) {
      callback();
    }
  };
  instance.onLoad.call(instance);
  instance.renderer = {
    setAdjustments(state) {
      instance.renderer.adjustments = state;
    },
    getAdjustments() {
      return instance.renderer.adjustments || {};
    },
    setEffects(state) {
      instance.renderer.effects = state;
    },
    getEffects() {
      return instance.renderer.effects || {};
    },
    setLut() {},
    setExtendedLut() {
      instance.renderer.extendedReady = true;
    },
    hasExtendedLut() {
      return instance.renderer.extendedReady === true;
    },
    render(intensity) {
      instance.renderer.lastIntensity = intensity;
    },
    renderToPixels(options) {
      const pixels = new Uint8Array(options.width * options.height * 4).fill(128);
      return { pixels, width: options.width, height: options.height };
    },
    clearPhoto() {},
    resize() {},
  };
  return instance;
}

// --- the page boots ---------------------------------------------------------

const instance = createInstance();
assert.equal(instance.devicePixelRatio, 2);
assert.equal(instance.data.phase, 'empty');

// The phase machine drives the busy mask.
instance.transition('pick');
assert.equal(instance.data.phase, 'decoding');
assert.equal(instance.data.busy, true);
assert.ok(instance.data.busyText.length > 0);
instance.transition('decoded');
assert.equal(instance.data.phase, 'loading-luts');
instance.transition('luts-ready');
assert.equal(instance.data.phase, 'ready');
assert.equal(instance.data.busy, false);
instance.transition('failed');
assert.equal(instance.data.phase, 'error');
instance.transition('clear');
assert.equal(instance.data.phase, 'empty');

// --- sliders drive the renderer directly ------------------------------------

instance.setData({ hasPhoto: true });
instance.applyAdjustment('ev', 1.24, false);
assert.equal(instance.adjustments.ev, 1.2);
assert.equal(instance.renderer.getAdjustments().ev, 1.2);
instance.applyAdjustment('ev', 1.24, true);
assert.equal(instance.data.readouts.ev, '+1.2 EV');
assert.equal(instance.data.adjustments.ev, 1.2);
assert.equal(instance.data.resetEnabled, true);

// While a slider is being dragged the readouts are throttled: the renderer is
// updated at once, but the view is not written on every event.
instance.applyAdjustment('ev', 0.5, false);
assert.equal(instance.renderer.getAdjustments().ev, 0.5);
assert.equal(instance.data.readouts.ev, '+1.2 EV');
instance.applyAdjustment('ev', 1.24, true);
assert.equal(instance.data.readouts.ev, '+1.2 EV');

instance.applyAdjustment('temperature', -40, true);
assert.equal(instance.data.readouts.temperature, '-40');
instance.applyAdjustment('intensity', 0.5, true);
assert.equal(instance.data.readouts.intensity, '50%');
assert.equal(instance.renderer.lastIntensity, 0.5);

// A positive EV needs the extended cube, which is fetched lazily.
assert.equal(instance.renderer.hasExtendedLut(), false);
instance.activeStock = {
  id: 'portra400',
  name: 'Kodak Portra 400',
  extended: { file: 'portra400.ev2.png', headroomEv: 2, size: 49, cols: 8, rows: 7 },
};
instance.getLutImage = async () => ({ base: {}, extended: {} });
instance.applyAdjustment('ev', 1, true);
assert.equal(instance.data.extendedLoading, true);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(instance.data.extendedLoading, false);
assert.equal(instance.renderer.hasExtendedLut(), true);

// Reset restores every adjustment but keeps the photo and the stock.
instance.onResetAdjustments();
assert.deepEqual(instance.adjustments, {
  ev: 0, temperature: 0, tint: 0, intensity: 1, contrast: 0, saturation: 1,
});
assert.equal(instance.data.resetEnabled, false);
assert.equal(instance.data.readouts.intensity, '100%');
assert.equal(instance.data.hasPhoto, true);

// --- spatial effects ------------------------------------------------------

assert.deepEqual(instance.effects, { grain: 1, halation: 1, vignette: 0 });
instance.applyEffect('grain', 0.5, true);
assert.equal(instance.effects.grain, 0.5);
assert.equal(instance.renderer.getEffects().grain, 0.5);
assert.equal(instance.data.effectReadouts.grain, '50%');
assert.equal(instance.data.resetEnabled, true);

instance.applyEffect('halation', 2, true);
assert.equal(instance.effects.halation, 2);
instance.applyEffect('vignette', 0.4, true);
assert.equal(instance.effects.vignette, 0.4);
assert.equal(instance.data.effectReadouts.vignette, '40%');

// The effects are clamped to their limits.
instance.applyEffect('grain', 5, true);
assert.equal(instance.effects.grain, 2);
instance.applyEffect('vignette', -1, true);
assert.equal(instance.effects.vignette, 0);

// The effect reset restores the shipped defaults only.
instance.onResetEffects();
assert.deepEqual(instance.effects, { grain: 1, halation: 1, vignette: 0 });
assert.equal(instance.adjustments.ev, 0);

// The global reset restores the adjustments and the effects together.
instance.applyEffect('grain', 0.25, true);
instance.applyAdjustment('ev', 1, true);
instance.onResetAdjustments();
assert.deepEqual(instance.effects, { grain: 1, halation: 1, vignette: 0 });
assert.equal(instance.adjustments.ev, 0);
assert.equal(instance.data.resetEnabled, false);

// --- press and hold compare -------------------------------------------------

instance.onPreviewTouchStart();
assert.equal(instance.data.comparing, true);
assert.equal(instance.renderer.lastIntensity, 0);
instance.onPreviewTouchEnd();
assert.equal(instance.data.comparing, false);
assert.equal(instance.renderer.lastIntensity, 1);

// --- preset cards and thumbnails -------------------------------------------

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'subpackages', 'luts', 'luts.json'), 'utf8')
);
const ui = require('../utils/ui-state.js');
instance.setData({ categories: ui.groupStocks(manifest) });
instance.setData({ selectedStock: 'portra400', selectedStockName: 'Kodak Portra 400' });
assert.equal(instance.data.categories.length, 3);
assert.equal(instance.data.categories[0].stocks[0].id, 'portra400');
assert.equal(instance.data.categories[0].stocks[0].thumb.status, 'idle');

instance.setThumbnail('portra400', 'wxfile://tmp_thumb.png');
assert.equal(instance.data.categories[0].stocks[0].thumb.status, 'ready');
assert.equal(instance.data.categories[0].stocks[0].thumb.src, 'wxfile://tmp_thumb.png');
assert.equal(instance.data.categories[1].stocks[0].thumb.status, 'idle');

// A failed export must degrade to a placeholder instead of a broken image.
instance.lutManifest = manifest;
instance.photoSize = { width: 1280, height: 854 };
instance.activeStock = manifest[0];
instance.getLutImage = async () => ({ base: {}, extended: null });
await instance.generateThumbnail('gold200', instance.operationId);
assert.equal(instance.data.categories[0].stocks[2].id, 'gold200');
assert.equal(instance.data.categories[0].stocks[2].thumb.status, 'failed');
assert.equal(instance.data.categories[0].stocks[2].thumb.src, '');
assert.ok(instance.data.categories[0].stocks[2].thumb.color.startsWith('hsl('));

// --- every WXML handler exists on the page ---------------------------------

const wxml = fs.readFileSync(path.join(ROOT, 'pages', 'index', 'index.wxml'), 'utf8');
const handlers = new Set();
for (const match of wxml.matchAll(/\b(?:bind|catch|mut-bind)[a-zA-Z:-]*\s*=\s*"([^"]+)"/g)) {
  handlers.add(match[1]);
}
assert.ok(handlers.size > 0);
for (const handler of handlers) {
  assert.equal(
    typeof definition[handler], 'function',
    `the WXML handler '${handler}' is missing from the page`
  );
}

console.log(
  `Page wiring tests: PASS (${handlers.size} WXML handlers, phases, sliders, reset, ` +
  'compare, thumbnails, placeholder fallback)'
);
