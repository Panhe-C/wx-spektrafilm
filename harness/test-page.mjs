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
  getSystemInfoSync: () => ({ pixelRatio: 2, SDKVersion: '3.0.0' }),
  getImageInfo: () => {},
  showToast: () => {},
  setClipboardData: () => {},
  createSelectorQuery: () => ({
    select: () => ({
      fields: () => ({ exec: (callback) => callback([]) }),
      boundingClientRect: () => ({ exec: (callback) => callback([]) }),
    }),
  }),
  // The offscreen canvas stub cannot export pixels, so the thumbnail path
  // exercises its documented placeholder fallback.
  createOffscreenCanvas: () => ({}),
  createIntersectionObserver: () => ({}),
  // The privacy interfaces of the platform.
  getPrivacySetting: (payload) => payload.success({
    needAuthorization: false,
    privacyContractName: '《测试隐私保护指引》',
  }),
  onNeedPrivacyAuthorization: (listener) => {
    globalThis.__privacyListener = listener;
  },
  openPrivacyContract: (payload) => payload.success({}),
  openSetting: (payload) => payload.success({ authSetting: {} }),
  showModal: (payload) => payload.success({ confirm: true }),
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
  // Page logic tests can stay synchronous while production uses the native
  // node's real asynchronous rAF for compositing.
  instance.canvas = { requestAnimationFrame: (callback) => callback() };
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
    setFrame(style) {
      instance.renderer.frameStyle = style;
    },
    getFrame() {
      return instance.renderer.frameStyle || 'none';
    },
    resize() {},
    resizeToCssSize(width, height) {
      return { width, height, cssWidth: width, cssHeight: height };
    },
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

// LUTs are local main-package assets: no wx.loadSubpackage host API is needed.
const lutInstance = createInstance();
const loadedManifest = await lutInstance.ensureLuts();
assert.deepEqual(loadedManifest, manifest);
assert.strictEqual(await lutInstance.ensureLuts(), loadedManifest);
assert.strictEqual(loadedManifest, require('../subpackages/luts/luts.js'));

// Device failures retain their friendly message and expose raw WeChat diagnostics.
const loggedErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => loggedErrors.push(args);
let describedError;
try {
  describedError = instance.describeError({
    errMsg: 'require:fail ../../subpackages/luts/luts.js not found',
  });
} finally {
  console.error = originalConsoleError;
}
assert.equal(loggedErrors.length, 1);
assert.equal(loggedErrors[0][0], '[wx-spektrafilm]');
assert.ok(describedError.startsWith('胶片资源加载失败'));
assert.ok(describedError.endsWith(
  '（调试：require:fail ../../subpackages/luts/luts.js not found）'
));

const ui = require('../utils/ui-state.js');
const Export = require('../utils/export.js');

// --- the privacy popup -------------------------------------------------------

// The platform asks for the consent: the page shows its own popup and the
// 「同意」 button resolves the pending interface.
const privacyInstance = createInstance();
assert.equal(privacyInstance.data.privacyVisible, false);
let privacyResult = null;
const privacyPending = new Promise((resolve) => { privacyResult = resolve; });
globalThis.__privacyListener(privacyResult, { referrer: 'saveImageToPhotosAlbum' });
assert.equal(privacyInstance.data.privacyVisible, true);
assert.ok(privacyInstance.data.privacyBody.length > 0);
// The name of the guide is read asynchronously.
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(privacyInstance.data.privacyName, '《测试隐私保护指引》');
privacyInstance.onPrivacyAgree();
assert.deepEqual(await privacyPending, { buttonId: 'agree-btn', event: 'agree' });
assert.equal(privacyInstance.data.privacyVisible, false);

// The refusal resolves the pending interface with "disagree".
let refused = null;
const refusePending = new Promise((resolve) => { refused = resolve; });
globalThis.__privacyListener(refused, { referrer: 'chooseMedia' });
assert.equal(privacyInstance.data.privacyVisible, true);
privacyInstance.onPrivacyRefuse();
assert.deepEqual(await refusePending, { event: 'disagree' });
assert.equal(privacyInstance.data.privacyVisible, false);

// The privacy contract is opened with the platform interface.
let contractOpened = false;
wx.openPrivacyContract = (payload) => { contractOpened = true; payload.success({}); };
privacyInstance.onOpenPrivacyContract();
assert.equal(contractOpened, true);

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

// --- the full-resolution export --------------------------------------------

instance.setData({ hasPhoto: true });
instance.photoSrc = 'wxfile://tmp_original.jpg';
instance.activeStock = manifest[0];
instance.lutManifest = manifest;
instance.getLutImage = async () => ({ base: {}, extended: null });

const exportCalls = [];
instance.exportHostFactory = (options) => ({ options });
instance.exportRunner = async (options) => {
  exportCalls.push(options);
  options.onProgress({ stage: 'decode', text: '解码原图 3000×2000…', progress: 10 });
  options.onProgress({ stage: 'render', text: '渲染 1/2…', progress: 45 });
  return { ok: true, filePath: 'wxfile://tmp_export.jpg', plan: { width: 3000, height: 2000 } };
};
const toasts = [];
wx.showToast = (options) => toasts.push(options);

await instance.onSaveTap();
assert.equal(exportCalls.length, 1);
assert.equal(exportCalls[0].src, 'wxfile://tmp_original.jpg');
assert.equal(exportCalls[0].stockId, manifest[0].id);
assert.equal(exportCalls[0].intensity, instance.adjustments.intensity);
assert.deepEqual(exportCalls[0].effects, instance.effects);
assert.equal(exportCalls[0].maxTextureSize, undefined);
assert.equal(instance.data.exporting, false);
assert.equal(instance.data.exportProgress, 0);
assert.equal(toasts.length, 1);
assert.equal(toasts[0].title, '已保存到相册');

// The progress is written to the view while the export runs.
let seenProgress = [];
instance.exportRunner = async (options) => {
  options.onProgress({ stage: 'render', text: '渲染 1/2…', progress: 45 });
  seenProgress = instance.data.exportProgress;
  return { ok: false, cancelled: true, message: '已取消保存。' };
};
await instance.onSaveTap();
assert.equal(seenProgress, 45);
assert.equal(toasts[toasts.length - 1].title, '已取消保存');

// The cancel button stops the export.
instance.exportRunner = async (options) => {
  options.isCancelled();
  return { ok: false, cancelled: true, message: '已取消保存。' };
};
instance.exportCancel = Export.createCancelSignal();
instance.onCancelExport();
assert.equal(instance.exportCancel.isCancelled(), true);
assert.equal(instance.data.exportText, '正在取消…');

// A failed export reports the message of the pipeline.
instance.exportRunner = async () => ({ ok: false, message: '请在设置中开启「保存到相册」权限后再试。' });
await instance.onSaveTap();
assert.ok(toasts[toasts.length - 1].title.indexOf('相册') !== -1);
// A failed export offers a retry and the settings.
assert.equal(instance.data.exportStatus, 'failed');
assert.equal(instance.data.exportError, '请在设置中开启「保存到相册」权限后再试。');
assert.equal(instance.data.exportCanRetry, true);
assert.equal(instance.data.exportCanOpenSetting, true);

// A timed out export says so and never stays on one step.
instance.exportRunner = async () => ({
  ok: false,
  timeout: true,
  message: '保存到相册超时（8.0 秒未收到回调）。请重试。',
  stage: 'save',
});
await instance.onSaveTap();
assert.equal(instance.data.exportStatus, 'timeout');
assert.equal(instance.data.exportCanRetry, true);
assert.ok(instance.data.exportError.indexOf('超时') !== -1);

// The export steps are collected for the diagnostics panel.
instance.exportRunner = async (options) => {
  options.onStep({ step: 'save', phase: 'ok', elapsed: 12, detail: 'ok' });
  options.onStep({ step: 'encode', phase: 'timeout', elapsed: 8000, detail: 'no answer' });
  return { ok: true };
};
await instance.onSaveTap();
assert.equal(instance.exportSteps.entries().length, 2);
assert.equal(instance.data.exportStatus, 'done');
assert.ok(instance.privacyState().installed);
assert.ok(instance.privacyState().setting.available);

// The share entries.
const share = instance.onShareAppMessage();
assert.ok(share.title.length > 0);
assert.equal(share.path, '/pages/index/index');
const timeline = instance.onShareTimeline();
assert.ok(timeline.title.length > 0);

// --- the editor chrome: tabs, bottom sheet, about --------------------------

const chrome = createInstance();
const insets = [];
chrome.renderer.setPresentationInset = (inset) => insets.push(inset);
assert.equal(chrome.data.panel, '');
assert.equal(chrome.data.activeTab, 'film');
assert.deepEqual(chrome.data.tabs.map((tab) => tab.key), ['film', 'adjust', 'effects', 'border']);
assert.deepEqual(
  chrome.data.borderStyles.map((card) => card.id),
  ['none', 'thin-white', 'polaroid', 'black', 'film35', 'film120']
);
assert.equal(chrome.data.borderStyle, 'none');
assert.deepEqual(
  chrome.data.adjustSliders.map((slider) => slider.key),
  ['ev', 'temperature', 'tint', 'intensity', 'contrast', 'saturation']
);
assert.deepEqual(chrome.data.effectSliders.map((slider) => slider.key), ['grain', 'halation', 'vignette']);
assert.equal(chrome.data.adjustSliders[0].min, -2);
assert.equal(chrome.data.adjustSliders[0].max, 2);
assert.equal(chrome.data.adjustSliders[0].step, 0.1);
assert.ok(chrome.data.adjustSliders[4].groupTitle.indexOf('非胶片物理') !== -1);
assert.equal(chrome.data.effectSliders[1].max, 2);

// Without a photo the sheet cannot open.
await chrome.onTabTap({ currentTarget: { dataset: { tab: 'adjust' } } });
assert.equal(chrome.data.panel, '');

// With a photo the sheet opens, the canvas is not resized, the photo is
// re-fitted into the visible part and a frame is requested.
chrome.setData({ hasPhoto: true });
let resizes = 0;
const baseResize = chrome.renderer.resizeToCssSize;
chrome.renderer.resizeToCssSize = (...args) => { resizes += 1; return baseResize(...args); };
const rects = {
  '#previewStage': { top: 100, bottom: 900, height: 800, width: 375 },
  '#editSheet': { top: 560, bottom: 900, height: 340, width: 375 },
};
const baseQuery = wx.createSelectorQuery;
wx.createSelectorQuery = () => ({
  select: (selector) => ({
    boundingClientRect: () => ({ exec: (callback) => callback([rects[selector] || null]) }),
  }),
});
chrome.renderer.lastIntensity = undefined;
await chrome.onTabTap({ currentTarget: { dataset: { tab: 'adjust' } } });
assert.equal(chrome.data.panel, 'adjust');
assert.equal(chrome.data.activeTab, 'adjust');
assert.equal(chrome.data.sheetTitle, '调整');
assert.deepEqual(insets[insets.length - 1], { bottom: 340 });
assert.equal(resizes, 0, 'opening the sheet must not resize the canvas');
assert.equal(chrome.renderer.lastIntensity, 1, 'the preview is redrawn after the inset changed');

// Switching to the effects tab keeps the sheet open; the same tab collapses it.
await chrome.onTabTap({ currentTarget: { dataset: { tab: 'effects' } } });
assert.equal(chrome.data.panel, 'effects');
assert.equal(chrome.data.sheetTitle, '效果');
await chrome.onTabTap({ currentTarget: { dataset: { tab: 'effects' } } });
assert.equal(chrome.data.panel, '');
assert.equal(chrome.data.activeTab, 'film');
assert.deepEqual(insets[insets.length - 1], { bottom: 0 });
assert.equal(resizes, 0);

// 「完成」 closes the sheet as well.
await chrome.onTabTap({ currentTarget: { dataset: { tab: 'adjust' } } });
await chrome.onCloseSheet();
assert.equal(chrome.data.panel, '');
assert.deepEqual(insets[insets.length - 1], { bottom: 0 });

// The sheet reset only restores what the sheet shows.
await chrome.onTabTap({ currentTarget: { dataset: { tab: 'adjust' } } });
assert.equal(chrome.data.sheetResetEnabled, false);
chrome.applyAdjustment('ev', 1, true);
chrome.applyEffect('grain', 0.5, true);
assert.equal(chrome.data.sheetResetEnabled, true);
chrome.onSheetReset();
assert.equal(chrome.adjustments.ev, 0);
assert.equal(chrome.effects.grain, 0.5, 'the adjust sheet does not reset the effects');
assert.equal(chrome.data.sheetResetEnabled, false);
await chrome.onTabTap({ currentTarget: { dataset: { tab: 'effects' } } });
assert.equal(chrome.data.sheetResetEnabled, true);
chrome.onSheetReset();
assert.equal(chrome.effects.grain, 1);
assert.equal(chrome.data.sheetResetEnabled, false);

// Clearing the photo closes the sheet and restores the full-stage fit.
chrome.setData({ hasPhoto: true });
chrome.onClearPhoto();
assert.equal(chrome.data.panel, '');
assert.deepEqual(insets[insets.length - 1], { bottom: 0 });
wx.createSelectorQuery = baseQuery;

// --- the film border ---------------------------------------------------------

{
  const framed = createInstance();
  framed.setData({ hasPhoto: true });
  // Without a photo a card tap is ignored.
  const empty = createInstance();
  empty.onBorderTap({ currentTarget: { dataset: { id: 'black' } } });
  assert.equal(empty.border, 'none');

  const insetsSeen = [];
  framed.renderer.setPresentationInset = (inset) => insetsSeen.push(inset);
  const sheetRects = {
    '#previewStage': { top: 100, bottom: 900, height: 800, width: 375 },
    '#editSheet': { top: 700, bottom: 900, height: 200, width: 375 },
  };
  const savedQuery = wx.createSelectorQuery;
  wx.createSelectorQuery = () => ({
    select: (selector) => ({
      boundingClientRect: () => ({ exec: (callback) => callback([sheetRects[selector] || null]) }),
    }),
  });
  await framed.onTabTap({ currentTarget: { dataset: { tab: 'border' } } });
  wx.createSelectorQuery = savedQuery;
  assert.equal(framed.data.panel, 'border');
  assert.equal(framed.data.sheetTitle, '边框');
  assert.equal(framed.data.sheetResetEnabled, false, 'no border: nothing to reset');
  assert.deepEqual(insetsSeen[insetsSeen.length - 1], { bottom: 200 });

  framed.onBorderTap({ currentTarget: { dataset: { id: 'film35' } } });
  assert.equal(framed.border, 'film35');
  assert.equal(framed.data.borderStyle, 'film35');
  assert.equal(framed.renderer.getFrame(), 'film35');
  assert.equal(framed.data.sheetResetEnabled, true);
  // Unknown ids fall back to no border.
  framed.setBorderStyle('nope');
  assert.equal(framed.border, 'none');
  assert.equal(framed.renderer.getFrame(), 'none');
  framed.onBorderTap({ currentTarget: { dataset: { id: 'polaroid' } } });
  framed.onSheetReset();
  assert.equal(framed.border, 'none', 'the border sheet reset removes the border');
  assert.equal(framed.data.sheetResetEnabled, false);

  // The border is edit state: it survives a preset change and a cleared photo,
  // and is handed to the export together with the stock name.
  framed.onBorderTap({ currentTarget: { dataset: { id: 'black' } } });
  framed.onClearPhoto();
  assert.equal(framed.border, 'black');
  assert.equal(framed.data.borderStyle, 'black');
  framed.setData({ hasPhoto: true });
  framed.photoSrc = 'wxfile://photo.jpg';
  framed.activeStock = { id: 'portra400', name: 'Kodak Portra 400' };
  let exportArgs = null;
  framed.exportRunner = async (args) => {
    exportArgs = args;
    return { ok: true };
  };
  framed.exportHostFactory = () => ({});
  await framed.onSaveTap();
  assert.equal(exportArgs.border, 'black');
  assert.equal(exportArgs.stockName, 'Kodak Portra 400');

  // The overlay paints the frame only when something changed.
  const painted = [];
  const makeContext = () => new Proxy({}, {
    get: (target, name) => {
      if (name === 'measureText') return () => ({ width: 10 });
      return (...args) => { painted.push([String(name), ...args]); };
    },
    set: () => true,
  });
  framed.frameCanvas = { width: 750, height: 1600 };
  framed.frameContext = makeContext();
  framed.frameCanvasSize = { width: 375, height: 800 };
  framed.activeStock = { id: 'portra400', name: 'Kodak Portra 400' };
  const border = require('../utils/border.js');
  const presentation = {
    frame: {
      style: 'film35',
      layout: border.computeLayout('film35', 1200, 800),
      cssRect: { x: 10, y: 100, width: 355, height: 360 },
    },
  };
  framed.syncFrameOverlay(presentation);
  const firstPaint = painted.length;
  assert.ok(firstPaint > 0);
  assert.ok(painted.some((call) => call[0] === 'clearRect'));
  assert.ok(painted.some((call) => call[0] === 'fillText' && call[1] === 'KODAK PORTRA 400'));
  framed.syncFrameOverlay(presentation);
  assert.equal(painted.length, firstPaint, 'an unchanged frame is not repainted');
  framed.activeStock = { id: 'gold200', name: 'Kodak Gold 200' };
  framed.syncFrameOverlay(presentation);
  assert.ok(painted.length > firstPaint, 'a new stock name repaints the edge print');
  const afterName = painted.length;
  framed.syncFrameOverlay({ frame: null });
  assert.ok(painted.length > afterName, 'removing the border clears the overlay');
  assert.ok(painted.slice(afterName).every((call) => call[0] !== 'fillRect'));
}

// About, banners and the export card.
chrome.onOpenAbout();
assert.equal(chrome.data.aboutOpen, true);
chrome.onCloseAbout();
assert.equal(chrome.data.aboutOpen, false);
chrome.setData({ error: 'x', exportError: 'y', exportCanRetry: true, exportCanOpenSetting: true });
chrome.onDismissError();
assert.equal(chrome.data.error, '');
chrome.onDismissExportError();
assert.equal(chrome.data.exportError, '');
assert.equal(chrome.data.exportCanRetry, false);
chrome.onOpenDiagnostics();
assert.equal(chrome.data.diagnosticsOpen, true);
assert.equal(chrome.data.aboutOpen, false, 'a long press on the title opens only the diagnostics');

// --- the layout contract of the WXML/WXSS ----------------------------------

const layoutWxml = fs.readFileSync(path.join(ROOT, 'pages', 'index', 'index.wxml'), 'utf8');
const layoutWxss = fs.readFileSync(path.join(ROOT, 'pages', 'index', 'index.wxss'), 'utf8');
// The strip is one horizontally scrolling row.
assert.match(layoutWxml, /<scroll-view[^>]*class="strip-scroll"[^>]*\bscroll-x\b/);
assert.ok(!/class="strip-scroll"[^>]*scroll-y/.test(layoutWxml));
assert.match(layoutWxss, /\.strip-inner\s*{[^}]*display:\s*inline-flex/);
assert.match(layoutWxss, /\.strip-scroll\s*{[^}]*white-space:\s*nowrap/);
// The canvas sits directly in the stage, not in the sheet, and the stage is
// the only flexible area: neither the sheet nor the strip changes its size.
const stageStart = layoutWxml.indexOf('id="previewStage"');
const canvasAt = layoutWxml.indexOf('id="previewCanvas"');
const sheetAt = layoutWxml.indexOf('id="editSheet"');
const dockAt = layoutWxml.indexOf('class="dock"');
assert.ok(stageStart > -1 && canvasAt > stageStart && canvasAt < dockAt && dockAt < sheetAt);
assert.match(layoutWxss, /\.preview-stage\s*{[^}]*flex:\s*1 1 0%/);
assert.match(layoutWxss, /\.preview-canvas\s*{[^}]*position:\s*absolute[^}]*width:\s*100%[^}]*height:\s*100%/);
assert.match(layoutWxss, /\.sheet\s*{[^}]*position:\s*absolute/, 'the sheet overlays the stage');
assert.match(layoutWxss, /\.sheet\s*{[^}]*safe-area-inset-bottom/);
assert.match(layoutWxss, /\.toolbar\s*{[^}]*safe-area-inset-bottom/);
assert.ok(!/\.preview-stage\s*{[^}]*\bheight:\s*\d+(vh|rpx)/.test(layoutWxss), 'no fixed stage height');
// Import, export and the about entry stay reachable without scrolling.
for (const needle of ['bindtap="onChoosePhoto"', 'bindtap="onSaveTap"', 'bindtap="onOpenAbout"',
  'bindlongpress="onOpenDiagnostics"', 'bindtap="onOpenPrivacyContract"']) {
  assert.ok(layoutWxml.includes(needle), `missing ${needle}`);
}
assert.ok(!layoutWxml.includes('class="body-scroll"'), 'the page no longer scrolls');

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
  'compare, thumbnails, placeholder fallback, tabs/sheet/inset, layout contract)'
);
