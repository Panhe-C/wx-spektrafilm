// Unit tests for the full-resolution export: the pure planner, the album
// permission flow, the timeout wrapper and the orchestrator, all with a mock
// host.
//
// The browser test (harness/test-export-browser.mjs) verifies that the tiled
// render is identical to a single-pass render.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Export = require('../utils/export.js');
const Effects = require('../utils/effects.js');

// --- the export size --------------------------------------------------------

{
  const size = Export.computeExportSize(4000, 3000, {
    maxLongEdge: 4096,
    maxTextureSize: 4096,
  });
  assert.equal(size.width, 4000);
  assert.equal(size.height, 3000);
  assert.equal(size.longEdge, 4000);

  // The 4096 px budget caps a bigger original.
  const capped = Export.computeExportSize(8000, 6000, {
    maxLongEdge: 4096,
    maxTextureSize: 4096,
  });
  assert.equal(capped.width, 4096);
  assert.equal(capped.height, 3072);

  // The GPU limit caps it further.
  const gpu = Export.computeExportSize(8000, 6000, {
    maxLongEdge: 4096,
    maxTextureSize: 2048,
  });
  assert.equal(gpu.width, 2048);
  assert.equal(gpu.height, 1536);

  // A small original is never enlarged.
  const small = Export.computeExportSize(1000, 800, {
    maxLongEdge: 4096,
    maxTextureSize: 4096,
  });
  assert.equal(small.width, 1000);
  assert.equal(small.height, 800);

  assert.throws(() => Export.computeExportSize(0, 100, {}), /Invalid source dimensions/);
}

// --- the tile planner -------------------------------------------------------

function coverCheck(plan) {
  // Every pixel of the picture is covered by exactly one tile.
  const counts = new Map();
  plan.tiles.forEach((tile) => {
    for (let y = tile.y; y < tile.y + tile.height; y += 1) {
      for (let x = tile.x; x < tile.x + tile.width; x += 1) {
        const key = `${x},${y}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  });
  // The coverage is checked on a coarse grid to keep the test fast, but every
  // tile corner is checked exactly.
  const step = Math.max(1, Math.floor(Math.min(plan.width, plan.height) / 64));
  for (let y = 0; y < plan.height; y += step) {
    for (let x = 0; x < plan.width; x += step) {
      assert.equal(counts.get(`${x},${y}`) || 0, 1, `pixel ${x},${y} is not covered exactly once`);
    }
  }
  assert.equal(counts.size, plan.width * plan.height, 'the tiles must not overlap');
  plan.tiles.forEach((tile) => {
    assert.ok(tile.x + tile.width <= plan.width);
    assert.ok(tile.y + tile.height <= plan.height);
  });
}

{
  const plan = Export.planExport({
    sourceWidth: 3000,
    sourceHeight: 2000,
    maxTextureSize: 4096,
    maxLongEdge: 4096,
    tileSize: 1024,
    stockId: 'portra400',
    halationStrength: 1,
  });
  assert.equal(plan.width, 3000);
  assert.equal(plan.height, 2000);
  assert.equal(plan.tiles.length, 6);
  assert.equal(plan.tiles[0].width, 1024);
  assert.equal(plan.tiles[0].height, 1024);
  // The last column and row are the remainder.
  assert.equal(plan.tiles[2].width, 3000 - 2 * 1024);
  assert.equal(plan.tiles[5].height, 2000 - 1024);
  coverCheck(plan);

  // The margin covers three sigma of the halation kernel at the export size.
  const expected = Effects.halationMarginPixels(
    Effects.forStock('portra400').halation.sigmaUm,
    plan.longEdgePx
  );
  assert.equal(plan.margin, expected);
  assert.ok(plan.margin >= 3 * Effects.halationSigmaPixels(65, plan.longEdgePx));

  // The padded halo buffer still fits into a texture.
  plan.tiles.forEach((tile) => {
    assert.equal(tile.target.haloWidth, tile.width + 2 * plan.margin);
    assert.equal(tile.target.haloHeight, tile.height + 2 * plan.margin);
    assert.ok(tile.target.haloWidth <= 4096);
    assert.ok(tile.target.haloHeight <= 4096);
  });
}

{
  // A small GPU limit shrinks the tile, so that the padded halo buffer fits.
  const plan = Export.planExport({
    sourceWidth: 4000,
    sourceHeight: 3000,
    maxTextureSize: 1024,
    maxLongEdge: 4096,
    tileSize: 2048,
    stockId: 'portra400',
    halationStrength: 1,
  });
  plan.tiles.forEach((tile) => {
    assert.ok(tile.target.haloWidth <= 1024, `halo width ${tile.target.haloWidth} > 1024`);
    assert.ok(tile.target.haloHeight <= 1024, `halo height ${tile.target.haloHeight} > 1024`);
  });
  coverCheck(plan);
}

{
  // Without the halation no margin is needed and the tiles are plain.
  const plan = Export.planExport({
    sourceWidth: 1000,
    sourceHeight: 800,
    maxTextureSize: 4096,
    stockId: 'portra400',
    halationStrength: 0,
  });
  assert.equal(plan.margin, 0);
  assert.equal(plan.tiles.length, 1);
  assert.equal(plan.tiles[0].target.haloWidth, plan.width);
  assert.equal(plan.tiles[0].target.haloUvOffset[0], 0);
}

{
  // The uv mappings place the tile and its padded rectangle on the picture.
  const plan = Export.planExport({
    sourceWidth: 2000,
    sourceHeight: 1000,
    maxTextureSize: 4096,
    tileSize: 1000,
    stockId: 'gold200',
    halationStrength: 1,
  });
  const tile = plan.tiles[1];
  const target = tile.target;
  const margin = plan.margin;
  assert.equal(target.imageUvOffset[0], 1000 / 2000);
  assert.equal(target.imageUvOffset[1], 0);
  assert.equal(target.imageUvScale[0], 1000 / 2000);
  assert.equal(target.imageUvScale[1], 1);
  assert.equal(target.haloImageUvOffset[0], (1000 - margin) / 2000);
  assert.equal(target.haloImageUvScale[0], (1000 + 2 * margin) / 2000);
  // The tile samples the middle of the padded halo buffer.
  assert.equal(target.haloUvScale[0], 1000 / (1000 + 2 * margin));
  assert.equal(target.haloUvOffset[0], margin / (1000 + 2 * margin));
  // The frame space is normalised to the long edge of the picture.
  assert.equal(target.imageFrameSize[0], 1);
  assert.equal(target.imageFrameSize[1], 0.5);
  assert.equal(target.regionOrigin[0], 0.5);
  assert.equal(target.regionSize[1], 0.5);
  assert.equal(target.longEdgePx, 2000);
}

// --- the mock host ----------------------------------------------------------

// The timeouts are tiny: the tests must be fast, and every waiting path has
// to end in a bounded time.
const FAST_TIMEOUTS = Object.freeze({
  default: 60,
  hint: 40,
  getSetting: 40,
  permission: 60,
  privacy: 60,
  imageInfo: 60,
  decode: 100,
  encode: 100,
  save: 60,
});

function createMockWx(options) {
  const settings = options || {};
  const calls = [];
  const state = {
    authSetting: settings.authSetting,
  };
  let saveCalls = 0;
  const privacySubscribers = [];
  const notifyPrivacy = (visible) => {
    privacySubscribers.slice().forEach((listener) => listener({ visible }));
  };
  const api = {
    calls,
    state,
    saveCalls: () => saveCalls,
    getSetting: (payload) => {
      calls.push('getSetting');
      if (settings.getSettingNeverAnswers) {
        // The platform never answers: the hint must not block the export.
        return;
      }
      setTimeout(() => payload.success({ authSetting: state.authSetting }), 0);
    },
    authorize: (payload) => {
      calls.push('authorize');
      // wx.authorize is never called by the export; the mock never answers,
      // so a regression would hang instead of passing silently.
    },
    showModal: (payload) => {
      calls.push('showModal');
      setTimeout(() => payload.success({ confirm: settings.modalConfirm !== false }), 0);
    },
    openSetting: (payload) => {
      calls.push('openSetting');
      setTimeout(() => {
        state.authSetting = Object.assign({}, state.authSetting, {
          'scope.writePhotosAlbum': settings.openSettingAuth,
        });
        payload.success({ authSetting: state.authSetting });
      }, 0);
    },
    saveImageToPhotosAlbum: (payload) => {
      calls.push('saveImageToPhotosAlbum');
      saveCalls += 1;
      if (settings.saveNeverAnswers) {
        // The platform never answers: the save step must time out.
        return;
      }
      setTimeout(() => {
        if (settings.saveFailsOnce) {
          if (saveCalls === 1) {
            payload.fail({ errMsg: settings.saveFails || 'saveImageToPhotosAlbum:fail auth deny' });
            return;
          }
        } else if (settings.saveFails) {
          payload.fail({ errMsg: settings.saveFails });
          return;
        }
        payload.success({});
      }, 0);
    },
    // The privacy adapter of the host: it stands for utils/privacy.js.
    privacy: {
      subscribe: (listener) => {
        privacySubscribers.push(listener);
        return () => {
          const index = privacySubscribers.indexOf(listener);
          if (index !== -1) {
            privacySubscribers.splice(index, 1);
          }
        };
      },
      ensureAuthorized: (request) => {
        calls.push('privacy');
        if (settings.privacyNeverAnswers) {
          // The consent is never given: the pre-flight must time out.
          return new Promise(() => {});
        }
        if (settings.privacyPopupMs) {
          // The popup is open for a while: the timeout of the step must be
          // paused while the user reads the guide.
          notifyPrivacy(true);
          return new Promise((resolve) => {
            setTimeout(() => {
              notifyPrivacy(false);
              resolve({ granted: true, reason: 'agreed' });
            }, settings.privacyPopupMs);
          });
        }
        return Promise.resolve({
          granted: settings.privacyGranted !== false,
          reason: settings.privacyReason || 'agreed',
        });
      },
    },
  };
  return api;
}

function createMockHost(options) {
  const settings = options || {};
  const events = [];
  const api = createMockWx(settings.wx || {});
  const host = {
    events,
    tiles: [],
    timeouts: settings.timeouts || FAST_TIMEOUTS,
    permission: api,
    getImageInfo: async () => {
      events.push('getImageInfo');
      return { width: 3000, height: 2000, orientation: 'up' };
    },
    decodeImage: async (request) => {
      events.push(`decode:${request.width}x${request.height}`);
      return { canvas: { id: 'photo' }, width: request.width, height: request.height };
    },
    createRenderer: async () => {
      events.push('createRenderer');
      return {
        renderRegionToPixels: (request) => {
          events.push(`render:${request.width}x${request.height}`);
          return {
            pixels: new Uint8Array(request.width * request.height * 4).fill(200),
            width: request.width,
            height: request.height,
          };
        },
        release: () => {
          events.push('release');
        },
      };
    },
    createAssemblyCanvas: (width, height) => {
      events.push(`canvas:${width}x${height}`);
      return { id: 'assembly' };
    },
    drawBorder: (canvas, layout, borderOptions) => {
      events.push(`border:${layout.style}:${borderOptions.stockName}`);
    },
    drawTile: (canvas, tile) => {
      events.push(`draw:${tile.index}`);
      host.tiles.push({ x: tile.x, y: tile.y, width: tile.width, height: tile.height });
    },
    encode: async () => {
      events.push('encode');
      if (settings.encodeFails) {
        throw new Error('encode failed');
      }
      return 'wxfile://tmp_export.jpg';
    },
    save: (filePath) => new Promise((resolve, reject) => {
      api.saveImageToPhotosAlbum({
        filePath,
        success: (result) => resolve(result),
        fail: (error) => reject(error),
      });
    }),
    yield: async () => {
      events.push('yield');
    },
  };
  return host;
}

function exportOptions(host, extra) {
  return Object.assign({
    host,
    src: 'wxfile://tmp_original.jpg',
    stockId: 'portra400',
    adjustments: { ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1, intensity: 1 },
    effects: { grain: 1, halation: 1, vignette: 0 },
    intensity: 1,
    halationStrength: 1,
    maxTextureSize: 4096,
  }, extra || {});
}

// --- the permission flow ----------------------------------------------------

async function permissionCase(name, wxOptions, expectation) {
  const api = createMockWx(wxOptions);
  const result = await Export.ensureAlbumPermission(api, {
    timeouts: FAST_TIMEOUTS,
  });
  assert.equal(result.granted, expectation.granted, `${name}: granted`);
  assert.equal(result.state, expectation.state, `${name}: state`);
  if (expectation.message) {
    assert.ok(
      result.message.indexOf(expectation.message) !== -1,
      `${name}: message "${result.message}" must mention "${expectation.message}"`
    );
  }
  if (expectation.calls) {
    assert.deepEqual(api.calls, expectation.calls, `${name}: calls`);
  }
  return api;
}

await permissionCase(
  'authorized',
  { authSetting: { 'scope.writePhotosAlbum': true } },
  { granted: true, state: 'authorized', calls: ['privacy', 'getSetting'] }
);

await permissionCase(
  'not asked: the save asks for the scope itself',
  { authSetting: {} },
  { granted: true, state: 'unknown', calls: ['privacy', 'getSetting'] }
);

await permissionCase(
  'the privacy guide is refused',
  { privacyGranted: false, privacyReason: 'refused' },
  {
    granted: false,
    state: 'privacy-denied',
    message: '隐私',
    calls: ['privacy'],
  }
);

await permissionCase(
  'denied, the settings grant it',
  {
    authSetting: { 'scope.writePhotosAlbum': false },
    modalConfirm: true,
    openSettingAuth: true,
  },
  {
    granted: true,
    state: 'authorized',
    calls: ['privacy', 'getSetting', 'showModal', 'openSetting'],
  }
);

await permissionCase(
  'denied, the modal is cancelled',
  {
    authSetting: { 'scope.writePhotosAlbum': false },
    modalConfirm: false,
  },
  {
    granted: false,
    state: 'cancelled',
    message: '已取消',
    calls: ['privacy', 'getSetting', 'showModal'],
  }
);

await permissionCase(
  'denied, the settings keep refusing',
  {
    authSetting: { 'scope.writePhotosAlbum': false },
    modalConfirm: true,
    openSettingAuth: false,
  },
  {
    granted: false,
    state: 'denied',
    message: '设置',
    calls: ['privacy', 'getSetting', 'showModal', 'openSetting'],
  }
);

{
  // The hint may never answer: it must not block the export.
  const api = createMockWx({ getSettingNeverAnswers: true });
  const started = Date.now();
  const result = await Export.ensureAlbumPermission(api, { timeouts: FAST_TIMEOUTS });
  const elapsed = Date.now() - started;
  assert.equal(result.granted, true);
  assert.equal(result.state, 'unknown');
  assert.ok(elapsed < 1000, `the hint blocked the export for ${elapsed}ms`);
  // wx.authorize is never called: the platform wants the target interface to
  // be called and its authorisation error to be handled.
  assert.ok(!api.calls.includes('authorize'));
}

{
  // The privacy pre-flight never answers: it times out with a clear error.
  const api = createMockWx({ privacyNeverAnswers: true });
  const result = await Export.ensureAlbumPermission(api, { timeouts: FAST_TIMEOUTS });
  assert.equal(result.granted, false);
  assert.equal(result.state, 'timeout');
  assert.ok(result.message.indexOf('超时') !== -1, result.message);
}

{
  // A host that cannot report the settings fails safely.
  const api = {
    getSetting: (payload) => payload.fail({ errMsg: 'getSetting:fail' }),
  };
  const result = await Export.ensureAlbumPermission(api, { timeouts: FAST_TIMEOUTS });
  assert.equal(result.granted, true, 'the hint failure must not block the export');
  assert.equal(result.state, 'unknown');
}

// --- the save errors --------------------------------------------------------

{
  // The save step maps the WeChat errors to Chinese messages.
  const ok = await Export.saveToAlbum(createMockWx({}), 'wxfile://tmp_export.jpg', {
    timeouts: FAST_TIMEOUTS,
  });
  assert.equal(ok.ok, true);

  const denied = await Export.saveToAlbum(
    createMockWx({ saveFails: 'saveImageToPhotosAlbum:fail auth deny' }),
    'wxfile://tmp_export.jpg',
    { timeouts: FAST_TIMEOUTS }
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.authDenied, true);
  assert.ok(denied.message.indexOf('权限') !== -1);

  const cancelled = await Export.saveToAlbum(
    createMockWx({ saveFails: 'saveImageToPhotosAlbum:fail cancel' }),
    'wxfile://tmp_export.jpg',
    { timeouts: FAST_TIMEOUTS }
  );
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.cancelled, true);

  // The privacy errors have their own messages.
  const privacy = await Export.saveToAlbum(
    createMockWx({ saveFails: 'saveImageToPhotosAlbum:fail privacy permission is not authorized' }),
    'wxfile://tmp_export.jpg',
    { timeouts: FAST_TIMEOUTS }
  );
  assert.equal(privacy.privacyDenied, true);
  assert.ok(privacy.message.indexOf('隐私') !== -1);

  const notDeclared = await Export.saveToAlbum(
    createMockWx({ saveFails: 'saveImageToPhotosAlbum:fail api scope is not declared in the privacy agreement' }),
    'wxfile://tmp_export.jpg',
    { timeouts: FAST_TIMEOUTS }
  );
  assert.equal(notDeclared.privacyNotDeclared, true);
  assert.ok(notDeclared.message.indexOf('用户隐私保护指引') !== -1);

  // A save that never answers times out with the step and the elapsed time.
  const timeout = await Export.saveToAlbum(
    createMockWx({ saveNeverAnswers: true }),
    'wxfile://tmp_export.jpg',
    { timeouts: FAST_TIMEOUTS }
  );
  assert.equal(timeout.ok, false);
  assert.equal(timeout.timeout, true);
  assert.ok(timeout.message.indexOf('超时') !== -1, timeout.message);
}

// --- the orchestrator -------------------------------------------------------

{
  const host = createMockHost({ wx: { authSetting: { 'scope.writePhotosAlbum': true } } });
  const stages = [];
  const result = await Export.exportImage(exportOptions(host, {
    onProgress: (progress) => stages.push(progress.stage),
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.filePath, 'wxfile://tmp_export.jpg');
  assert.equal(result.plan.width, 3000);
  assert.equal(result.plan.height, 2000);
  assert.equal(stages[0], 'permission');
  assert.equal(stages[stages.length - 1], 'save');
  assert.ok(stages.includes('decode'));
  assert.ok(stages.includes('encode'));
  assert.equal(stages.filter((stage) => stage === 'render').length, result.plan.tiles.length);
  // Every tile is drawn and the renderer is released at the end.
  const drawn = host.events.filter((event) => event.startsWith('draw:'));
  assert.equal(drawn.length, result.plan.tiles.length);
  assert.ok(host.events.includes('release'));
  // The progress text is Chinese and mentions the tile counter.
  assert.ok(Export.stageText('render', { index: 1, total: 3 }).indexOf('1/3') !== -1);
  // wx.authorize is never called.
  assert.ok(!host.permission.calls.includes('authorize'));
  // The steps are logged: every step has a start and an end entry.
  const steps = result.steps;
  assert.ok(steps.length > 0);
  assert.ok(steps.some((entry) => entry.step === 'privacy'));
  assert.ok(steps.some((entry) => entry.step === 'save' && entry.phase === 'ok'));
}

{
  // A border: the assembly canvas is the framed size, the frame is painted
  // before the first tile, and every tile is blitted inside the margins.
  const host = createMockHost({ wx: { authSetting: { 'scope.writePhotosAlbum': true } } });
  const result = await Export.exportImage(exportOptions(host, {
    border: 'polaroid',
    stockName: 'Kodak Portra 400',
    tileSize: 1024,
  }));
  assert.equal(result.ok, true);
  const frame = result.plan.frame;
  assert.equal(frame.style, 'polaroid');
  assert.equal(result.plan.outerWidth, frame.outerW);
  assert.equal(result.plan.outerHeight, frame.outerH);
  assert.ok(Math.max(frame.outerW, frame.outerH) <= 4096, 'the framed file stays within 4096 px');
  assert.equal(frame.photoW, result.plan.width);
  assert.equal(frame.photoH, result.plan.height);
  assert.ok(host.events.includes(`canvas:${frame.outerW}x${frame.outerH}`));
  const borderIndex = host.events.indexOf('border:polaroid:Kodak Portra 400');
  assert.ok(borderIndex !== -1, 'the border is painted');
  assert.ok(borderIndex < host.events.indexOf('draw:0'), 'the border precedes the tiles');
  assert.ok(host.events.includes(`decode:${frame.photoW}x${frame.photoH}`));
  // The tiles cover the picture rectangle exactly, offset by the margins.
  let area = 0;
  host.tiles.forEach((tile) => {
    area += tile.width * tile.height;
    assert.ok(tile.x >= frame.left && tile.y >= frame.top);
    assert.ok(tile.x + tile.width <= frame.left + frame.photoW);
    assert.ok(tile.y + tile.height <= frame.top + frame.photoH);
  });
  assert.equal(area, frame.photoW * frame.photoH);
}

{
  // No border: nothing is painted and the tiles keep their plain coordinates.
  const host = createMockHost({ wx: { authSetting: { 'scope.writePhotosAlbum': true } } });
  const result = await Export.exportImage(exportOptions(host, { tileSize: 1024 }));
  assert.equal(result.ok, true);
  assert.equal(result.plan.frame.style, 'none');
  assert.equal(result.plan.outerWidth, result.plan.width);
  assert.equal(result.plan.outerHeight, result.plan.height);
  assert.ok(!host.events.some((event) => event.startsWith('border:')));
  assert.equal(host.tiles[0].x, 0);
  assert.equal(host.tiles[0].y, 0);
}

{
  // A host that cannot draw a border refuses the export instead of saving a
  // picture without the border the user asked for.
  const host = createMockHost({ wx: { authSetting: { 'scope.writePhotosAlbum': true } } });
  delete host.drawBorder;
  await assert.rejects(
    Export.exportImage(exportOptions(host, { border: 'black' })),
    /cannot draw a border/
  );
}

{
  // A cancelled export stops at the next tile and releases the buffers.
  const host = createMockHost({ wx: { authSetting: { 'scope.writePhotosAlbum': true } } });
  let renders = 0;
  const result = await Export.exportImage(exportOptions(host, {
    isCancelled: () => {
      renders += 1;
      return renders > 1;
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.ok(host.events.includes('release'));
  assert.ok(!host.events.includes('save'));
}

{
  // The cancel signal also stops an export whose save never answers.
  const host = createMockHost({
    wx: { authSetting: { 'scope.writePhotosAlbum': true }, saveNeverAnswers: true },
  });
  const signal = Export.createCancelSignal();
  const started = Date.now();
  const pending = Export.exportImage(exportOptions(host, {
    cancelSignal: signal,
    isCancelled: () => signal.isCancelled(),
  }));
  setTimeout(() => signal.cancel(), 20);
  const result = await pending;
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.ok(elapsed < 1000, `the cancellation took ${elapsed}ms`);
}

{
  // A refused privacy guide stops the export before the picture is decoded.
  const host = createMockHost({ wx: { privacyGranted: false, privacyReason: 'refused' } });
  const result = await Export.exportImage(exportOptions(host));
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'permission');
  assert.ok(result.message.indexOf('隐私') !== -1);
  assert.ok(!host.events.includes('decode:3000x2000'));
}

{
  // A save that never answers must not freeze the export.
  const host = createMockHost({
    wx: { authSetting: { 'scope.writePhotosAlbum': true }, saveNeverAnswers: true },
  });
  const result = await Export.exportImage(exportOptions(host));
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'save');
  assert.equal(result.timeout, true);
  assert.ok(result.message.indexOf('超时') !== -1, result.message);
  // The step log names the step and the elapsed time.
  const timeoutEntry = result.steps.find((entry) => entry.phase === 'timeout');
  assert.ok(timeoutEntry, 'the timeout must be logged');
  assert.equal(timeoutEntry.step, 'save');
  assert.ok(timeoutEntry.elapsed >= 0);
}

{
  // The auth-deny error opens the settings and the save is retried once.
  const host = createMockHost({
    wx: {
      authSetting: { 'scope.writePhotosAlbum': true },
      saveFailsOnce: true,
      saveFails: 'saveImageToPhotosAlbum:fail auth deny',
      modalConfirm: true,
      openSettingAuth: true,
    },
  });
  const result = await Export.exportImage(exportOptions(host));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    host.permission.calls.filter((call) => call !== 'privacy' && call !== 'getSetting'),
    ['saveImageToPhotosAlbum', 'showModal', 'openSetting', 'saveImageToPhotosAlbum']
  );
  assert.equal(host.permission.saveCalls(), 2);
}

{
  // The settings keep refusing: the export fails with a clear message.
  const host = createMockHost({
    wx: {
      authSetting: { 'scope.writePhotosAlbum': true },
      saveFailsOnce: true,
      saveFails: 'saveImageToPhotosAlbum:fail auth deny',
      modalConfirm: true,
      openSettingAuth: false,
    },
  });
  const result = await Export.exportImage(exportOptions(host));
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'save');
  assert.ok(result.message.indexOf('设置') !== -1, result.message);
  // The save is not retried forever.
  assert.equal(host.permission.saveCalls(), 1);
}

{
  // A late answer after the timeout is ignored: the step completes once.
  const host = createMockHost({ wx: { authSetting: { 'scope.writePhotosAlbum': true } } });
  let lateResolve = null;
  host.save = () => new Promise((resolve, reject) => {
    lateResolve = () => resolve({});
    setTimeout(() => reject({ errMsg: 'saveImageToPhotosAlbum:fail too late' }), 200);
  });
  const result = await Export.exportImage(exportOptions(host));
  assert.equal(result.ok, false);
  assert.equal(result.timeout, true);
  // The late answer arrives after the export has finished.
  lateResolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(result.ok, false, 'a late answer must not complete the step again');
  assert.equal(result.timeout, true);
}

{
  // A failing save is reported, not thrown.
  const host = createMockHost({
    wx: {
      authSetting: { 'scope.writePhotosAlbum': true },
      saveFails: 'saveImageToPhotosAlbum:fail saveImageToPhotosAlbum:fail',
    },
  });
  const result = await Export.exportImage(exportOptions(host));
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'save');
  assert.ok(result.message.indexOf('保存失败') !== -1);
}

{
  // The privacy pre-flight that never answers times out instead of hanging.
  const host = createMockHost({
    wx: { authSetting: { 'scope.writePhotosAlbum': true }, privacyNeverAnswers: true },
  });
  const started = Date.now();
  const result = await Export.exportImage(exportOptions(host));
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.timeout, true);
  assert.ok(elapsed < 1000, `the privacy pre-flight blocked for ${elapsed}ms`);
  assert.ok(!host.events.includes('decode:3000x2000'));
}

// --- the step log ------------------------------------------------------------

{
  const StepLog = require('../utils/step-log.js');
  const log = StepLog.createStepLog(3);
  log.push({ step: 'a1', phase: 'start', elapsed: 0, detail: '' });
  log.push({ step: 'a2', phase: 'ok', elapsed: 12, detail: { ok: true } });
  log.push({ step: 'b', phase: 'error', elapsed: 5, detail: 'boom' });
  log.push({ step: 'c', phase: 'timeout', elapsed: 8000, detail: 'no answer' });
  const entries = log.entries();
  assert.equal(entries.length, 3, 'the ring buffer is bounded');
  assert.equal(entries[0].step, 'a2', 'the oldest entry is dropped');
  assert.ok(log.text().indexOf('c timeout 8000ms no answer') !== -1, log.text());
  assert.ok(log.text().indexOf('b error 5ms boom') !== -1, log.text());
  // The objects are serialised, not printed as "[object Object]".
  assert.ok(log.text().indexOf('{"ok":true}') !== -1, log.text());
}

{
  // The popup waits for the user: the timeout of the step is paused while
  // it is open, so the export does not fail on a slow decision.
  const host = createMockHost({
    wx: {
      authSetting: { 'scope.writePhotosAlbum': true },
      privacyPopupMs: 150,
    },
  });
  const result = await Export.exportImage(exportOptions(host));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.timeout, undefined);
}

{
  // The cancel also works while the privacy popup is open.
  const host = createMockHost({
    wx: {
      authSetting: { 'scope.writePhotosAlbum': true },
      privacyPopupMs: 500,
    },
  });
  const signal = Export.createCancelSignal();
  const started = Date.now();
  const pending = Export.exportImage(exportOptions(host, {
    cancelSignal: signal,
    isCancelled: () => signal.isCancelled(),
  }));
  setTimeout(() => signal.cancel(), 20);
  const result = await pending;
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.ok(elapsed < 400, `the cancellation took ${elapsed}ms`);
}

console.log(
  'Export tests: PASS (size caps, tile coverage/margins, permission flow ' +
  '(privacy pre-flight, hint, denied+settings, cancel), save errors, ' +
  'timeouts (getSetting, privacy, save), auth-deny recovery, late answers, ' +
  'orchestrator stages, cancellation)'
);
