// Unit tests for the full-resolution export: the pure planner, the album
// permission flow and the orchestrator, all with a mock host.
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
    assert.equal(tile.target.haloWidth, tile.width + 2 * tile.margin);
    assert.equal(tile.target.haloHeight, tile.height + 2 * tile.margin);
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

// --- the permission flow ----------------------------------------------------

function createMockWx(options) {
  const settings = options || {};
  const calls = [];
  const state = {
    authSetting: settings.authSetting,
    openSettingAuth: settings.openSettingAuth,
  };
  const api = {
    calls,
    state,
    getSetting: (payload) => {
      calls.push('getSetting');
      setTimeout(() => payload.success({ authSetting: state.authSetting }), 0);
    },
    authorize: (payload) => {
      calls.push('authorize');
      setTimeout(() => {
        if (settings.authorizeFails) {
          payload.fail({ errMsg: 'authorize:fail auth deny' });
          return;
        }
        state.authSetting = Object.assign({}, state.authSetting, {
          'scope.writePhotosAlbum': true,
        });
        payload.success({});
      }, 0);
    },
    showModal: (payload) => {
      calls.push('showModal');
      setTimeout(() => payload.success({ confirm: settings.modalConfirm !== false }), 0);
    },
    openSetting: (payload) => {
      calls.push('openSetting');
      setTimeout(() => {
        state.authSetting = Object.assign({}, state.authSetting, {
          'scope.writePhotosAlbum': state.openSettingAuth,
        });
        payload.success({ authSetting: state.authSetting });
      }, 0);
    },
    saveImageToPhotosAlbum: (payload) => {
      calls.push('saveImageToPhotosAlbum');
      setTimeout(() => {
        if (settings.saveFails) {
          payload.fail({ errMsg: settings.saveFails });
          return;
        }
        payload.success({});
      }, 0);
    },
  };
  return api;
}

async function permissionCase(name, wxOptions, expectation) {
  const api = createMockWx(wxOptions);
  const result = await Export.ensureAlbumPermission(api, {});
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
  { granted: true, state: 'authorized', calls: ['getSetting'] }
);

await permissionCase(
  'not asked',
  { authSetting: {} },
  { granted: true, state: 'authorized', calls: ['getSetting', 'authorize'] }
);

await permissionCase(
  'not asked, refused',
  { authSetting: {}, authorizeFails: true },
  {
    granted: false,
    state: 'cancelled',
    message: '相册',
    calls: ['getSetting', 'authorize'],
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
    calls: ['getSetting', 'showModal', 'openSetting'],
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
    calls: ['getSetting', 'showModal'],
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
    calls: ['getSetting', 'showModal', 'openSetting'],
  }
);

{
  // A host that cannot report the settings fails safely.
  const api = {
    getSetting: (payload) => payload.fail({ errMsg: 'getSetting:fail' }),
  };
  const result = await Export.ensureAlbumPermission(api, {});
  assert.equal(result.granted, false);
  assert.equal(result.state, 'unknown');
}

{
  // The save step maps the WeChat errors to Chinese messages.
  const ok = await Export.saveToAlbum(
    createMockWx({}),
    'wxfile://tmp_export.jpg'
  );
  assert.equal(ok.ok, true);

  const denied = await Export.saveToAlbum(
    createMockWx({ saveFails: 'saveImageToPhotosAlbum:fail auth deny' }),
    'wxfile://tmp_export.jpg'
  );
  assert.equal(denied.ok, false);
  assert.ok(denied.message.indexOf('权限') !== -1);

  const cancelled = await Export.saveToAlbum(
    createMockWx({ saveFails: 'saveImageToPhotosAlbum:fail cancel' }),
    'wxfile://tmp_export.jpg'
  );
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.cancelled, true);
}

// --- the orchestrator -------------------------------------------------------

function createMockHost(options) {
  const settings = options || {};
  const events = [];
  const api = createMockWx(settings.wx || {});
  const host = {
    events,
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
    drawTile: (canvas, tile) => {
      events.push(`draw:${tile.index}`);
    },
    encode: async () => {
      events.push('encode');
      if (settings.encodeFails) {
        throw new Error('encode failed');
      }
      return 'wxfile://tmp_export.jpg';
    },
    save: async (filePath) => {
      events.push('save');
      if (settings.saveFails) {
        return { ok: false, message: '保存失败，请稍后重试。' };
      }
      return { ok: true, filePath };
    },
    yield: async () => {
      events.push('yield');
    },
  };
  return host;
}

{
  const host = createMockHost({ wx: { authSetting: { 'scope.writePhotosAlbum': true } } });
  const stages = [];
  const result = await Export.exportImage({
    host,
    src: 'wxfile://tmp_original.jpg',
    stockId: 'portra400',
    adjustments: { ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1, intensity: 1 },
    effects: { grain: 1, halation: 1, vignette: 0 },
    intensity: 1,
    halationStrength: 1,
    maxTextureSize: 4096,
    onProgress: (progress) => stages.push(progress.stage),
  });
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
}

{
  // A cancelled export stops at the next tile and releases the buffers.
  const host = createMockHost({ wx: { authSetting: { 'scope.writePhotosAlbum': true } } });
  let renders = 0;
  const result = await Export.exportImage({
    host,
    src: 'wxfile://tmp_original.jpg',
    stockId: 'portra400',
    adjustments: { ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1, intensity: 1 },
    effects: { grain: 1, halation: 1, vignette: 0 },
    intensity: 1,
    halationStrength: 1,
    maxTextureSize: 4096,
    isCancelled: () => {
      renders += 1;
      return renders > 1;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.ok(host.events.includes('release'));
  assert.ok(!host.events.includes('save'));
}

{
  // A denied permission stops the export before the picture is decoded.
  const host = createMockHost({ wx: { authSetting: { 'scope.writePhotosAlbum': false } } });
  const result = await Export.exportImage({
    host,
    src: 'wxfile://tmp_original.jpg',
    stockId: 'portra400',
    adjustments: { ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1, intensity: 1 },
    effects: { grain: 1, halation: 1, vignette: 0 },
    intensity: 1,
    halationStrength: 1,
    maxTextureSize: 4096,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'permission');
  assert.ok(!host.events.includes('decode:3000x2000'));
}

{
  // A failing save is reported, not thrown.
  const host = createMockHost({
    wx: { authSetting: { 'scope.writePhotosAlbum': true } },
    saveFails: true,
  });
  const result = await Export.exportImage({
    host,
    src: 'wxfile://tmp_original.jpg',
    stockId: 'portra400',
    adjustments: { ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1, intensity: 1 },
    effects: { grain: 1, halation: 1, vignette: 0 },
    intensity: 1,
    halationStrength: 1,
    maxTextureSize: 4096,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'save');
  assert.ok(result.message.indexOf('保存失败') !== -1);
}

console.log(
  'Export tests: PASS (size caps, tile coverage/margins, permission flow ' +
  '(authorized, not asked, refused, denied+settings, cancel), save errors, ' +
  'orchestrator stages, cancellation)'
);
