// The WeChat Mini Program host adapters of the full-resolution export.
//
// utils/export.js owns the pipeline and the geometry; this module only
// binds the pipeline to the Mini Program APIs (pick the picture, decode it
// into a 2D canvas, create an offscreen WebGL renderer, blit the tiles into
// an assembly canvas, encode a JPEG and save it to the album).
//
// Every call to the platform runs inside a timeout: a WeChat call that never
// calls back must not freeze the export. The late answer of a timed out
// call is ignored.
(function registerExportHost(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./lut-renderer.js'),
      require('./photo.js'),
      require('./shaders.js'),
      require('./border.js')
    );
  } else {
    root.SpektrafilmExportHost = factory(
      root.SpektrafilmRenderer,
      root.SpektrafilmPhoto,
      root.SpektrafilmShaders,
      root.SpektrafilmBorder
    );
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function exportHostFactory(
  RendererModule,
  PhotoModule,
  ShaderModule,
  BorderModule
) {
  const DEFAULT_TIMEOUTS = Object.freeze({
    default: 8000,
    hint: 2500,
    getSetting: 2500,
    permission: 8000,
    privacy: 8000,
    imageInfo: 8000,
    decode: 20000,
    encode: 30000,
    save: 15000,
  });

  function getWx() {
    return typeof wx !== 'undefined' ? wx : null;
  }

  function resolveTimeouts(settings) {
    const map = Object.assign({}, DEFAULT_TIMEOUTS);
    const source = settings && settings.timeouts;
    if (source && typeof source === 'object') {
      Object.keys(source).forEach((key) => {
        const value = Number(source[key]);
        if (Number.isFinite(value) && value > 0) {
          map[key] = value;
        }
      });
    }
    return map;
  }

  function timeoutFor(map, step, override) {
    const explicit = Number(override);
    if (Number.isFinite(explicit) && explicit > 0) {
      return explicit;
    }
    if (map[step] !== undefined) {
      return map[step];
    }
    return map.default;
  }

  /**
   * A WeChat call with a timeout.
   *
   * The promise is rejected with an EXPORT_TIMEOUT error when the platform
   * does not answer in time; the error carries the step name, the elapsed
   * time and the last raw answer.
   */
  function callWx(name, options, timeoutOptions) {
    const settings = timeoutOptions || {};
    return new Promise((resolve, reject) => {
      const api = getWx();
      if (!api || typeof api[name] !== 'function') {
        reject(new Error(`The Mini Program host does not provide ${name}()`));
        return;
      }
      let settled = false;
      let lastPayload = null;
      const limit = timeoutFor(settings.timeouts || DEFAULT_TIMEOUTS, name, settings.timeoutMs);
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        const error = new Error(
          `wx.${name} 没有在 ${(limit / 1000).toFixed(1)} 秒内回调`
        );
        error.code = 'EXPORT_TIMEOUT';
        error.step = name;
        error.elapsed = limit;
        error.timeoutMs = limit;
        error.raw = lastPayload === null ? 'no callback' : lastPayload;
        reject(error);
      }, limit);
      const finish = (kind, payload) => {
        if (settled) {
          if (typeof console !== 'undefined') {
            console.warn(
              `[wx-spektrafilm][export] the late answer of wx.${name} was ignored`,
              payload
            );
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (kind === 'ok') {
          resolve(payload);
        } else {
          reject(payload);
        }
      };
      try {
        api[name](Object.assign({}, options || {}, {
          success: (result) => {
            lastPayload = result;
            finish('ok', result);
          },
          fail: (error) => {
            lastPayload = error;
            finish('fail', error);
          },
        }));
      } catch (error) {
        finish('fail', error);
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

  function writeBase64File(base64, fileName, timeoutMs) {
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
        let settled = false;
        const limit = timeoutFor(DEFAULT_TIMEOUTS, 'default', timeoutMs);
        const timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(null);
        }, limit);
        const finish = (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        try {
          manager.writeFile({
            filePath,
            data: base64,
            encoding: 'base64',
            success: () => finish(filePath),
            fail: () => finish(null),
          });
        } catch (error) {
          finish(null);
        }
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
   * options.privacy is the privacy guard (utils/privacy.js): it is asked
   * for the consent before the first privacy scoped call.
   * options.timeouts overrides the timeout of every platform call.
   */
  function createExportHost(options) {
    const settings = options || {};
    const api = getWx();
    const timeouts = resolveTimeouts(settings);
    // The decoded Image is the geometry authority, so it is decoded once and
    // reused for the export canvas.
    const images = Object.create(null);
    function hostImage(src) {
      if (!images[src]) {
        images[src] = PhotoModule.loadCanvasImage(settings.canvas, src);
      }
      return images[src];
    }
    if (!api) {
      throw new Error('The Mini Program host is not available');
    }
    const privacy = settings.privacy || null;
    return {
      // The timeouts are shared with utils/export.js, so that the inner and
      // the outer wrapper of a call use the same budget.
      timeouts,

      // --- permissions -----------------------------------------------------
      permission: {
        // The hint: it never blocks the export (see utils/export.js).
        getSetting: (payload) => callWx('getSetting', payload, {
          timeoutMs: timeouts.getSetting,
          timeouts,
        }),
        // wx.authorize is a privacy scoped interface itself; the export
        // never calls it, the platform wants the target interface to be
        // called and its authorisation error to be handled.
        authorize: (payload) => callWx('authorize', payload, {
          timeoutMs: timeouts.permission,
          timeouts,
        }),
        openSetting: (payload) => callWx('openSetting', payload, {
          timeoutMs: timeouts.permission,
          timeouts,
        }),
        showModal: (payload) => callWx('showModal', payload, {
          timeoutMs: timeouts.permission,
          timeouts,
        }),
        saveImageToPhotosAlbum: (payload) => callWx('saveImageToPhotosAlbum', payload, {
          timeoutMs: timeouts.save,
          timeouts,
        }),
        privacy: privacy ? {
          ensureAuthorized: (request) => privacy.requestConsent(request),
          getSetting: () => privacy.getSetting(),
          state: () => privacy.state(),
          // The export pauses its timeouts while the popup is open.
          subscribe: (listener) => (
            typeof privacy.subscribe === 'function'
              ? privacy.subscribe(listener)
              : () => {}
          ),
        } : null,
      },

      // --- picture ---------------------------------------------------------
      // The reported size is the ORIENTED size of the decoded Image, so the
      // export plan matches the pixels that will actually be rendered.
      getImageInfo: async (src) => {
        const info = await callWx('getImageInfo', { src }, {
          timeoutMs: timeouts.imageInfo,
          timeouts,
        });
        const image = await hostImage(src);
        const decision = PhotoModule.decideExifOrientation({
          orientation: info.orientation,
          infoWidth: info.width,
          infoHeight: info.height,
          decodedWidth: Number(image.naturalWidth || image.width),
          decodedHeight: Number(image.naturalHeight || image.height),
          mode: settings.orientationMode,
        });
        return {
          width: decision.outputWidth,
          height: decision.outputHeight,
          orientation: info.orientation,
          rawWidth: Number(info.width) || null,
          rawHeight: Number(info.height) || null,
          decisionRow: decision.decisionRow,
          type: info.type || '',
        };
      },
      decodeImage: (request) => hostImage(request.src).then((image) => (
        PhotoModule.prepareExportImage({
          canvas: settings.canvas,
          src: request.src,
          width: request.width,
          height: request.height,
          image,
        })
      )).then((prepared) => ({
        canvas: prepared.canvas,
        width: prepared.width,
        height: prepared.height,
        retryDecode: prepared.retryDecode,
        release: prepared.release,
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
        try {
          renderer.setPhoto(context.photo.canvas, {
            type: 'offscreen-2d-canvas',
            width: context.photo.width,
            height: context.photo.height,
            pipeline: 'export',
          }, context.photo.retryDecode);
        } finally {
          if (typeof context.photo.release === 'function') {
            context.photo.release();
          }
        }
        return settings.getStockLut(context.stockId).then((images) => {
          renderer.setLut(images.base, images.stock, images.extended);
          renderer.setAdjustments(context.adjustments);
          renderer.setEffects(context.effects);
          return {
            renderRegionToPixels: (request) => renderer.renderRegionToPixels(request),
            release: () => {
              renderer.clearPhoto();
              renderer.destroy();
              Object.keys(images).forEach((key) => {
                const entry = images[key];
                if (entry && typeof entry.then === 'function') {
                  entry.then((image) => {
                    if (image) {
                      image.src = '';
                    }
                  }).catch(() => null);
                }
                delete images[key];
              });
            },
          };
        });
      },

      // --- assembly --------------------------------------------------------
      createAssemblyCanvas: (width, height) => createOffscreen2D(width, height),
      // The border is plain Canvas 2D drawing into the assembly canvas; it is
      // painted before the tiles, so it is never graded or grained.
      drawBorder: (canvas, layout, borderOptions) => {
        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('The assembly canvas has no 2D context');
        }
        BorderModule.drawBorder(context, layout, borderOptions);
      },
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
            callWx('canvasToTempFilePath', {
              canvas,
              fileType: 'jpg',
              quality,
            }, { timeoutMs: timeouts.encode, timeouts }).then(
              (result) => resolve(
                result && result.tempFilePath ? result.tempFilePath : null
              ),
              (error) => {
                if (typeof console !== 'undefined') {
                  console.error(
                    '[wx-spektrafilm][export] canvasToTempFilePath failed',
                    error
                  );
                }
                resolve(null);
              }
            );
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
              return writeBase64File(base64, 'export.jpg', timeouts.encode);
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

      // The save rejects with the raw WeChat error: utils/export.js maps it
      // to a Chinese message and to the recovery (modal + openSetting).
      save: (filePath) => callWx('saveImageToPhotosAlbum', { filePath }, {
        timeoutMs: timeouts.save,
        timeouts,
      }),

      // --- scheduling ------------------------------------------------------
      yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
    };
  }

  return {
    DEFAULT_TIMEOUTS,
    createExportHost,
    callWx,
    createOffscreen2D,
    writeBase64File,
  };
}));
