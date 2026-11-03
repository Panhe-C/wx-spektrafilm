import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Diagnostics = require('../utils/diagnostics.js');

const report = {
  generatedAt: '2026-11-03T00:00:00.000Z',
  app: { name: 'wx-spektrafilm', version: 'test' },
  summary: { ok: false, fallbackCount: 1 },
  gl: {
    available: true,
    version: 'WebGL 1.0',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0',
    vendor: 'vendor',
    renderer: 'renderer',
    unmaskedVendor: 'Apple',
    unmaskedRenderer: 'Apple GPU',
    attributes: { alpha: false, preserveDrawingBuffer: true },
    maxTextureSize: 4096,
    maxTextureImageUnits: 8,
    fragmentHighpFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
    extensions: ['EXT_a', 'EXT_b'],
  },
  canvas: {
    nodeWidth: 375.5,
    nodeHeight: 200,
    canvasRect: { x: 0, y: 80, width: 375.5, height: 200 },
    stageRect: { x: 0, y: 80, width: 375.5, height: 200 },
    bufferGeometry: { requestedWidth: 1127, requestedHeight: 600, clamped: false },
    presentation: { viewport: [170, 0, 300, 400], photoRect: { x: 170, y: 0, width: 300, height: 400 } },
    drawingBufferWidth: 1280,
    drawingBufferHeight: 854,
    width: 1280,
    height: 854,
    viewport: [0, 0, 1280, 854],
    pixelRatio: 3,
    sizingRule: 'photo pixels; CSS contain',
  },
  photo: { type: 'offscreen-2d-canvas', width: 1280, height: 854 },
  thumbnail: { width: 96, height: 54, boxAspect: 16 / 9, cropRect: { x: 0, y: 67, width: 1280, height: 720 } },
  upload: {
    preferredStrategy: 'direct',
    activeStrategy: 'direct',
    fallbacks: [{ texture: 'photo', from: 'pixels', to: 'direct' }],
  },
  textures: [{
    name: 'photo', unit: 0, width: 1280, height: 854, format: 'RGBA8',
    status: 'ready', strategy: 'direct', sourceType: 'offscreen-2d-canvas',
    filter: 'LINEAR', wrap: 'CLAMP_TO_EDGE', mipmaps: false,
    alphaMin: 255, alphaMax: 255,
    cpuDecodeSuspect: true, photoAllBlack: true, decodeRetried: true, decodeRetryError: '',
    selfChecks: [{
      strategy: 'pixels', ok: false, error: 'black', glErrors: [],
      selfCheck: { cpuMean: 100.25, readbackMean: 0, centreMaxDiff: 120 },
    }],
  }],
  tests: {
    solidColour: { expected: [255, 0, 128, 255], pixel: [255, 0, 128, 255], exact: true },
    defaultFramebuffer: {
      available: true, bufferWidth: 640, bufferHeight: 400,
      viewport: [170, 0, 300, 400], photoRect: { x: 170, y: 0, width: 300, height: 400 },
      maxDiff: 1,
      samples: [{ name: 'centre', x: 320, y: 200, defaultPixel: [1, 2, 3, 255], fbo: [1, 2, 4, 255], maxDiff: 1 }],
      letterbox: { x: 0, y: 200, defaultPixel: [8, 8, 8, 255], expected: [8, 8, 8, 255], exact: true },
    },
    photoTexture: {
      available: true, maxDiff: 1,
      samples: [{ name: 'centre', x: 640, y: 427, cpu: [10, 20, 30, 255], gpu: [10, 20, 31, 255], maxDiff: 1 }],
    },
    lutTexture: {
      available: true, maxDiff: 0,
      samples: [{ name: 'whiteCorner', x: 263, y: 164, cpu: [200, 201, 202, 255], gpu: [200, 201, 202, 255], maxDiff: 0 }],
    },
    fullShader: {
      available: true, intensity1: [100, 110, 120, 255], intensity0: [10, 20, 30, 255],
      cpuIntensity0: [10, 20, 30, 255], intensity0MaxDiff: 0,
    },
  },
  glErrors: [{ stage: 'upload-pixels:photo', texture: 'photo', name: 'INVALID_OPERATION', code: 1282 }],
  exportSteps: [
    { step: 'permission', phase: 'start', elapsed: 0, detail: '' },
    { step: 'save', phase: 'timeout', elapsed: 8000, detail: 'no answer after 15000ms' },
  ],
  privacy: {
    installed: true,
    needPrivacyFired: true,
    needPrivacyCount: 1,
    referrer: 'saveImageToPhotosAlbum',
    popupVisible: false,
    lastDecision: 'agree',
    lastError: '',
    setting: {
      available: true,
      needAuthorization: false,
      privacyContractName: '《测试隐私保护指引》',
      error: '',
    },
    authSetting: { 'scope.writePhotosAlbum': true },
  },
};

const before = JSON.stringify(report);
const text = Diagnostics.formatReport(report);
assert.equal(JSON.stringify(report), before, 'formatter must not mutate its input');
assert.ok(text.startsWith('WX-SPEKTRAFILM DIAGNOSTIC v1\n'));
assert.ok(text.includes('MAX_TEXTURE_SIZE: 4096'));
assert.ok(text.includes('MAX_TEXTURE_IMAGE_UNITS: 8'));
assert.ok(text.includes('fragment highp float: {"rangeMin":127,"rangeMax":127,"precision":23}'));
assert.ok(text.includes('drawingBuffer: 1280x854'));
assert.ok(text.includes('offscreen-2d-canvas'));
assert.ok(text.includes('cpuDecodeSuspect=true photoAllBlack=true retry=true'));
assert.ok(text.includes('photo self-check: cpuMean=100.25 gpuMean=0.00 centreMaxDiff=120'));
assert.ok(text.includes('centre (640,427) cpu=[10,20,30,255] gpu=[10,20,31,255] maxDiff=1'));
assert.ok(text.includes('[DEFAULT FRAMEBUFFER versus FBO]'));
assert.ok(text.includes('default=[1,2,3,255] fbo=[1,2,4,255] maxDiff=1'));
assert.ok(text.includes('letterbox (0,200)'));
assert.ok(text.includes('[THUMBNAIL GEOMETRY]'));
assert.ok(text.includes('canvasRect: {"x":0,"y":80,"width":375.5,"height":200}'));
assert.ok(text.includes('LUT TEXTURE: black + white corners'));
assert.ok(text.includes('intensity=1: [100,110,120,255]'));
assert.ok(text.includes('INVALID_OPERATION (1282)'));
// The export steps and the privacy state are part of the report.
assert.ok(text.includes('[EXPORT STEPS]'));
assert.ok(text.includes('save timeout 8000ms no answer after 15000ms'));
assert.ok(text.includes('[PRIVACY]'));
assert.ok(text.includes('needPrivacyFired: true'));
assert.ok(text.includes('referrer: saveImageToPhotosAlbum'));
assert.ok(text.includes('name=《测试隐私保护指引》'));
assert.ok(text.includes('authSetting: {"scope.writePhotosAlbum":true}'));
assert.ok(text.endsWith('\n'));
assert.equal(Diagnostics.formatReport(null).includes('[FATAL]'), false);

console.log('Diagnostics formatter tests: PASS (pure text, GL/canvas/upload/probe/error fields)');
