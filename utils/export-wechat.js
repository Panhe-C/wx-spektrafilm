// The WeChat Mini Program host adapters of the full-resolution export.
//
// utils/export.js owns the pipeline and the geometry; this module only
// binds the pipeline to the Mini Program APIs (pick the picture, decode it
// into a 2D canvas, create an offscreen WebGL renderer, blit the tiles into
// an assembly canvas, encode a JPEG and save it to the album).
(function registerExportHost(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./lut-renderer.js'),
      require('./photo.js'),
      require('./shaders.js')
    );
  } else {
    root.SpektrafilmExportHost = factory(
      root.SpektrafilmRenderer,
      root.SpektrafilmPhoto,
      root.SpektrafilmShaders
    );
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function exportHostFactory(
  RendererModule,
  PhotoModule,
  ShaderModule
) {
  function getWx() {
    return typeof wx !== 'undefined' ? wx : null;
  }

  function callWx(name, options) {
    return new Promise((resolve, reject) => {
      const api = getWx();
      if (!api || typeof api[name] !== 'function') {
        reject(new Error(`The Mini Program host does not provide ${name}()`));
        return;
      }
      try {
        api[name](Object.assign({}, options || {}, { success: resolve, fail: reject }));
      } catch (error) {
        reject(error);
      }
    });
  }

  function createOffscreen2D(width, height) {
    const api = getWx();
    if (!api || typeof api.createOffscreenCanvas !== 'function') {
      throw new Error('This device does not provide offscreen canvases');
    }
    let canvas;
    try {
      canvas = api.createOffscreenCanvas({ type: '2d', width, height });
    } catch (error) {
      canvas = api.createOffscreenCanvas(width, height);
    }
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function writeBase64File(base64, fileName) {
    const api = getWx();
    if (!api) {
      return Promise.resolve(null);
    }
    try {
      const manager = api.getFileSystemManager && api.getFileSystemManager();
      const base = api.env && api.env.USER_DATA_PATH;
      if (!manager || !base) {
        return Promise.resolve(null);
      }
      const filePath = `${base}/wx-spektrafilm-${fileName}`;
      return new Promise((resolve) => {
        manager.writeFile({
          filePath,
          data: base64,
          encoding: 'base64',
          success: () => resolve(filePath),
          fail: () => resolve(null),
        });
      });
    } catch (error) {
      return Promise.resolve(null);
    }
  }

  /**
   * The host adapters.
   *
   * options.getStockLut(stockId, needExtended) must resolve with
   * { base, extended, stock } and is supplied by the page, which owns the
   * LUT cache.
   */
  function createExportHost(options) {
    const settings = options || {};
    const api = getWx();
    if (!api) {
      throw new Error('The Mini Program host is not available');
    }
    return {
      // --- permissions -----------------------------------------------------
      permission: {
        getSetting: (payload) => callWx('getSetting', payload),
        authorize: (payload) => callWx('authorize', payload),
        openSetting: (payload) => callWx('openSetting', payload),
        showModal: (payload) => callWx('showModal', payload),
        saveImageToPhotosAlbum: (payload) => callWx('saveImageToPhotosAlbum', payload),
      },

      // --- picture ---------------------------------------------------------
      getImageInfo: (src) => callWx('getImageInfo', { src }),
      decodeImage: (request) => PhotoModule.prepareExportImage({
        canvas: settings.canvas,
        src: request.src,
        width: request.width,
        height: request.height,
      }).then((prepared) => ({
        canvas: prepared.canvas,
        width: prepared.width,
        height: prepared.height,
      })),

      // --- renderer --------------------------------------------------------
      createRenderer: (context) => {
        let canvas;
        try {
          canvas = api.createOffscreenCanvas({ type: 'webgl', width: 16, height: 16 });
        } catch (error) {
          canvas = null;
        }
        if (!canvas || typeof canvas.getContext !== 'function') {
          throw new Error('This device does not provide an offscreen WebGL canvas');
        }
        const renderer = RendererModule.createRenderer(canvas, {
          vertexSource: ShaderModule.lutVertex,
          fragmentSource: ShaderModule.lutFragment,
          haloFragmentSource: ShaderModule.haloFragment,
        });
        renderer.setPhoto(context.photo.canvas);
        return settings.getStockLut(context.stockId).then((images) => {
          renderer.setLut(images.base, images.stock, images.extended);
          renderer.setAdjustments(context.adjustments);
          renderer.setEffects(context.effects);
          return {
            renderRegionToPixels: (request) => renderer.renderRegionToPixels(request),
            release: () => {
              renderer.destroy();
              renderer.clearPhoto();
            },
          };
        });
      },

      // --- assembly --------------------------------------------------------
      createAssemblyCanvas: (width, height) => createOffscreen2D(width, height),
      drawTile: (canvas, tile, pixels) => {
        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('The assembly canvas has no 2D context');
        }
        const imageData = context.createImageData(tile.width, tile.height);
        imageData.data.set(pixels);
        context.putImageData(imageData, tile.x, tile.y);
      },

      // --- encoding and saving --------------------------------------------
      encode: (canvas, encodeOptions) => {
        const quality = encodeOptions && encodeOptions.quality
          ? encodeOptions.quality
          : 0.92;
        const steps = [];
        if (typeof api.canvasToTempFilePath === 'function') {
          steps.push(() => new Promise((resolve) => {
            try {
              api.canvasToTempFilePath({
                canvas,
                fileType: 'jpg',
                quality,
                success: (result) => resolve(
                  result && result.tempFilePath ? result.tempFilePath : null
                ),
                fail: () => resolve(null),
              });
            } catch (error) {
              resolve(null);
            }
          }));
        }
        if (typeof canvas.toDataURL === 'function') {
          steps.push(() => {
            try {
              const dataUrl = canvas.toDataURL('image/jpeg', quality);
              if (!dataUrl || dataUrl.indexOf('data:image/jpeg') !== 0) {
                return Promise.resolve(null);
              }
              const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
              return writeBase64File(base64, 'export.jpg');
            } catch (error) {
              return Promise.resolve(null);
            }
          });
        }
        return steps.reduce(
          (chain, step) => chain.then((result) => (result ? result : step())),
          Promise.resolve(null)
        ).then((filePath) => {
          if (!filePath) {
            throw new Error('无法编码导出的图片');
          }
          return filePath;
        });
      },

      save: (filePath) => callWx('saveImageToPhotosAlbum', { filePath })
        .then(() => ({ ok: true, message: '' }))
        .catch((error) => {
          const message = String((error && (error.errMsg || error.message)) || '');
          if (/cancel/i.test(message)) {
            return { ok: false, cancelled: true, message: '已取消保存。' };
          }
          if (/auth|deny|permission/i.test(message)) {
            return { ok: false, message: '没有相册权限，请在设置中允许保存到相册。' };
          }
          return { ok: false, message: '保存失败，请稍后重试。' };
        }),

      // --- scheduling ------------------------------------------------------
      yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
    };
  }

  return {
    createExportHost,
    callWx,
    createOffscreen2D,
    writeBase64File,
  };
}));
