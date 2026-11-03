// Full-resolution export: a pure planner and an orchestrator with injected
// host adapters.
//
// The planner decides the export size and the tile geometry. It is pure, so
// the Node unit suite (harness/test-export.mjs) can check the coverage, the
// margins and the size caps without a browser.
//
// The orchestrator drives the decode -> render -> encode -> save pipeline
// through the host adapters and never touches a global. The Mini Program
// page injects the WeChat adapters (utils/export-wechat.js); the unit suite
// injects a mock host, which is how the permission flow (authorized,
// not asked, denied, cancel, save failure) is verified.
(function registerExport(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./effects.js'));
  } else {
    root.SpektrafilmExport = factory(root.SpektrafilmEffects);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function exportFactory(Effects) {
  // The export never exceeds 4096 px on the long edge, and never exceeds the
  // GPU limits of the device.
  const EXPORT_MAX_LONG_EDGE = 4096;
  // Tiles are rendered in rectangles of at most this size, plus the halation
  // margin, so that the framebuffer stays small enough for a phone GPU.
  const EXPORT_TILE_SIZE = 2048;
  const EXPORT_JPEG_QUALITY = 0.92;
  const ALBUM_SCOPE = 'scope.writePhotosAlbum';
  const EXPORT_STAGES = Object.freeze(['permission', 'decode', 'render', 'encode', 'save']);

  function positiveInteger(value, fallback) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number < 1) {
      return fallback;
    }
    return number;
  }

  /**
   * The export size: the long edge of the original, capped by the 4096 px
   * budget and by the GPU limits. The aspect ratio is kept.
   */
  function computeExportSize(sourceWidth, sourceHeight, limits) {
    const width = Math.round(Number(sourceWidth));
    const height = Math.round(Number(sourceHeight));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new Error('Invalid source dimensions');
    }
    const options = limits || {};
    const longEdge = Math.max(width, height);
    const cap = Math.min(
      positiveInteger(options.maxLongEdge, EXPORT_MAX_LONG_EDGE),
      positiveInteger(options.maxTextureSize, EXPORT_MAX_LONG_EDGE),
      longEdge
    );
    const target = Math.max(1, Math.floor(cap));
    const scale = target / longEdge;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      longEdge: target,
      scale,
      sourceWidth: width,
      sourceHeight: height,
    };
  }

  /**
   * The margin a tile needs so that the halation kernel never reaches
   * outside the rendered rectangle. It is zero when the halation is off.
   */
  function exportMargin(stockId, longEdgePx, halationStrength) {
    if (!halationStrength) {
      return 0;
    }
    const stock = Effects.forStock(stockId);
    return Effects.halationMarginPixels(stock.halation.sigmaUm, longEdgePx);
  }

  /**
   * The tile rectangles. They cover the picture exactly: no gap, no overlap.
   */
  function planTiles(options) {
    const width = Math.round(Number(options.width));
    const height = Math.round(Number(options.height));
    const tileSize = positiveInteger(options.tileSize, EXPORT_TILE_SIZE);
    const margin = Math.max(0, Math.round(Number(options.margin) || 0));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new Error('Invalid export dimensions');
    }
    const tiles = [];
    for (let y = 0; y < height; y += tileSize) {
      for (let x = 0; x < width; x += tileSize) {
        tiles.push({
          index: tiles.length,
          x,
          y,
          width: Math.min(tileSize, width - x),
          height: Math.min(tileSize, height - y),
          margin,
        });
      }
    }
    return tiles;
  }

  /**
   * The renderer target of one tile.
   *
   * The frame space is normalised to the long edge of the exported picture,
   * so the grain and the vignette are continuous with a single-pass render.
   * The uv mappings place the tile and its padded halo rectangle on the
   * full-resolution picture.
   */
  function buildTileTarget(plan, tile) {
    const margin = tile.margin || 0;
    const paddedWidth = tile.width + 2 * margin;
    const paddedHeight = tile.height + 2 * margin;
    const longEdge = plan.longEdgePx;
    return {
      width: tile.width,
      height: tile.height,
      haloWidth: paddedWidth,
      haloHeight: paddedHeight,
      regionOrigin: [tile.x / longEdge, tile.y / longEdge],
      regionSize: [tile.width / longEdge, tile.height / longEdge],
      imageFrameOrigin: [0, 0],
      imageFrameSize: [plan.width / longEdge, plan.height / longEdge],
      imageUvOffset: [tile.x / plan.width, tile.y / plan.height],
      imageUvScale: [tile.width / plan.width, tile.height / plan.height],
      haloImageUvOffset: [
        (tile.x - margin) / plan.width,
        (tile.y - margin) / plan.height,
      ],
      haloImageUvScale: [
        paddedWidth / plan.width,
        paddedHeight / plan.height,
      ],
      haloUvScale: [tile.width / paddedWidth, tile.height / paddedHeight],
      haloUvOffset: [margin / paddedWidth, margin / paddedHeight],
      longEdgePx: longEdge,
    };
  }

  /**
   * The whole export plan: the size, the margin, the tile size and the
   * tiles with their renderer targets.
   */
  function planExport(options) {
    const settings = options || {};
    const size = computeExportSize(settings.sourceWidth, settings.sourceHeight, {
      maxLongEdge: settings.maxLongEdge,
      maxTextureSize: settings.maxTextureSize,
    });
    const longEdgePx = Math.max(size.width, size.height);
    const margin = exportMargin(
      settings.stockId,
      longEdgePx,
      settings.halationStrength
    );
    const maxTextureSize = positiveInteger(settings.maxTextureSize, EXPORT_MAX_LONG_EDGE);
    // The padded halo buffer must still fit into a texture.
    const usable = Math.max(64, maxTextureSize - 2 * margin);
    const tileSize = Math.max(
      64,
      Math.min(positiveInteger(settings.tileSize, EXPORT_TILE_SIZE), usable)
    );
    const plan = {
      width: size.width,
      height: size.height,
      longEdgePx,
      scale: size.scale,
      sourceWidth: size.sourceWidth,
      sourceHeight: size.sourceHeight,
      margin,
      tileSize,
      tiles: [],
    };
    plan.tiles = planTiles({
      width: plan.width,
      height: plan.height,
      tileSize,
      margin,
    }).map((tile) => Object.assign({}, tile, { target: buildTileTarget(plan, tile) }));
    return plan;
  }

  // --- permissions ---------------------------------------------------------

  function callHost(host, name, options) {
    return new Promise((resolve, reject) => {
      if (!host || typeof host[name] !== 'function') {
        reject(new Error(`The host does not provide ${name}()`));
        return;
      }
      try {
        host[name](Object.assign({}, options || {}, { success: resolve, fail: reject }));
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * The album permission flow.
   *
   *   authorized  -> nothing to do;
   *   not asked   -> wx.authorize;
   *   denied      -> a modal, then wx.openSetting;
   *   cancelled   -> the user aborted at any step.
   */
  async function ensureAlbumPermission(host, options) {
    const settings = options || {};
    let state;
    try {
      const result = await callHost(host, 'getSetting', {});
      state = result && result.authSetting ? result.authSetting[ALBUM_SCOPE] : undefined;
    } catch (error) {
      return {
        granted: false,
        state: 'unknown',
        message: '无法读取相册权限设置，请稍后重试。',
      };
    }
    if (state === true) {
      return { granted: true, state: 'authorized', message: '' };
    }
    if (state === undefined) {
      try {
        await callHost(host, 'authorize', { scope: ALBUM_SCOPE });
        return { granted: true, state: 'authorized', message: '' };
      } catch (error) {
        return {
          granted: false,
          state: 'cancelled',
          message: '未获得相册权限，无法保存。请在设置中允许保存到相册。',
        };
      }
    }
    // The permission was denied before: explain it and offer the settings.
    let confirmed = false;
    try {
      const modal = await callHost(host, 'showModal', {
        title: '需要相册权限',
        content: '保存到相册需要「保存到相册」权限。是否前往设置开启？',
        confirmText: '去设置',
        cancelText: '取消',
        showCancel: true,
      });
      confirmed = !!(modal && modal.confirm);
    } catch (error) {
      confirmed = false;
    }
    if (!confirmed) {
      return { granted: false, state: 'cancelled', message: '已取消保存。' };
    }
    let after;
    try {
      const opened = await callHost(host, 'openSetting', {});
      after = opened && opened.authSetting ? opened.authSetting[ALBUM_SCOPE] : undefined;
    } catch (error) {
      after = undefined;
    }
    if (after === true) {
      return { granted: true, state: 'authorized', message: '' };
    }
    return {
      granted: false,
      state: 'denied',
      message: '请在设置中开启「保存到相册」权限后再试。',
    };
  }

  async function saveToAlbum(host, filePath) {
    try {
      await callHost(host, 'saveImageToPhotosAlbum', { filePath });
      return { ok: true, message: '' };
    } catch (error) {
      const message = String((error && (error.errMsg || error.message)) || '');
      if (/cancel/i.test(message)) {
        return { ok: false, cancelled: true, message: '已取消保存。' };
      }
      if (/auth|deny|permission/i.test(message)) {
        return { ok: false, message: '没有相册权限，请在设置中允许保存到相册。' };
      }
      return { ok: false, message: '保存失败，请稍后重试。' };
    }
  }

  // --- progress ------------------------------------------------------------

  function stageText(stage, detail) {
    const info = detail || {};
    switch (stage) {
      case 'permission':
        return '检查相册权限…';
      case 'decode':
        return `解码原图 ${info.width}×${info.height}…`;
      case 'render':
        return `渲染 ${info.index}/${info.total}…`;
      case 'encode':
        return '编码 JPEG…';
      case 'save':
        return '保存到相册…';
      default:
        return '';
    }
  }

  function progressFraction(stage, detail) {
    const info = detail || {};
    switch (stage) {
      case 'permission':
        return 2;
      case 'decode':
        return 10;
      case 'render':
        return 10 + Math.round((info.index / Math.max(1, info.total)) * 70);
      case 'encode':
        return 88;
      case 'save':
        return 96;
      default:
        return 0;
    }
  }

  // --- the orchestrator -----------------------------------------------------

  /**
   * The export pipeline.
   *
   * The host adapters are:
   *   getImageInfo(src)                       -> { width, height, orientation }
   *        (the host must report the ORIENTED size of the decoded Image, so
   *         the plan matches the pixels that will be rendered)
   *   decodeImage({src, width, height})       -> { canvas }
   *   createRenderer({...})                   -> renderer
   *   createAssemblyCanvas(width, height)     -> 2D canvas
   *   drawTile(canvas, tile, pixels)          -> void
   *   encode(canvas, {quality})               -> file path
   *   save(filePath)                          -> void
   *   yield()                                 -> a macrotask
   *   permission                              -> the wx-like permission host
   */
  async function exportImage(options) {
    const settings = options || {};
    const host = settings.host;
    if (!host) {
      throw new Error('An export host is required');
    }
    const isCancelled = typeof settings.isCancelled === 'function'
      ? settings.isCancelled
      : () => false;
    const report = (stage, detail) => {
      if (typeof settings.onProgress !== 'function') {
        return;
      }
      const info = detail || {};
      settings.onProgress({
        stage,
        text: stageText(stage, info),
        progress: progressFraction(stage, info),
        detail: info,
      });
    };
    const cleanup = async (state) => {
      if (state && typeof state.release === 'function') {
        try {
          await state.release();
        } catch (error) {
          // Releasing the buffers must never mask the real result.
        }
      }
    };

    report('permission', {});
    const permission = await ensureAlbumPermission(host.permission, {});
    if (!permission.granted) {
      return {
        ok: false,
        cancelled: permission.state === 'cancelled',
        message: permission.message,
        stage: 'permission',
      };
    }

    const info = await host.getImageInfo(settings.src);
    const plan = planExport({
      sourceWidth: info.width,
      sourceHeight: info.height,
      maxTextureSize: settings.maxTextureSize,
      maxLongEdge: settings.maxLongEdge,
      tileSize: settings.tileSize,
      stockId: settings.stockId,
      halationStrength: settings.halationStrength,
    });

    report('decode', { width: plan.width, height: plan.height });
    const decoded = await host.decodeImage({
      src: settings.src,
      width: plan.width,
      height: plan.height,
      orientation: info.orientation,
    });

    const renderer = await host.createRenderer({
      photo: decoded,
      stockId: settings.stockId,
      adjustments: settings.adjustments,
      effects: settings.effects,
    });
    const assembly = host.createAssemblyCanvas(plan.width, plan.height);
    try {
      for (let index = 0; index < plan.tiles.length; index += 1) {
        if (isCancelled()) {
          await cleanup(renderer);
          return { ok: false, cancelled: true, message: '已取消保存。', stage: 'render' };
        }
        const tile = plan.tiles[index];
        const result = renderer.renderRegionToPixels({
          width: tile.width,
          height: tile.height,
          target: tile.target,
          intensity: settings.intensity,
          adjustments: settings.adjustments,
          effects: settings.effects,
        });
        host.drawTile(assembly, tile, result.pixels);
        report('render', { index: index + 1, total: plan.tiles.length });
        if (typeof host.yield === 'function') {
          await host.yield();
        }
      }

      if (isCancelled()) {
        await cleanup(renderer);
        return { ok: false, cancelled: true, message: '已取消保存。', stage: 'render' };
      }

      report('encode', {});
      const filePath = await host.encode(assembly, {
        quality: settings.quality || EXPORT_JPEG_QUALITY,
      });

      report('save', {});
      const saved = await host.save(filePath);
      await cleanup(renderer);
      if (!saved || saved.ok === false) {
        return {
          ok: false,
          cancelled: !!(saved && saved.cancelled),
          message: (saved && saved.message) || '保存失败，请稍后重试。',
          stage: 'save',
          filePath,
        };
      }
      return { ok: true, filePath, plan, message: '' };
    } catch (error) {
      await cleanup(renderer);
      throw error;
    }
  }

  return {
    EXPORT_MAX_LONG_EDGE,
    EXPORT_TILE_SIZE,
    EXPORT_JPEG_QUALITY,
    ALBUM_SCOPE,
    EXPORT_STAGES,
    computeExportSize,
    exportMargin,
    planTiles,
    buildTileTarget,
    planExport,
    ensureAlbumPermission,
    saveToAlbum,
    stageText,
    progressFraction,
    exportImage,
  };
}));
